/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PROMPT_ID,
  SESSION_ID,
  app,
  headers,
  settleTimeoutMs,
  state,
  store,
  useHostedTextSession,
} from './hosted-harness-session.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Part } from '@google/genai';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import {
  ManagedSessionStoreHttpError,
  ManagedSessionStoreTransportError,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { type LlmPreparedRequest } from '@qwen-code/qwen-code-core/core/llm-chat.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { HostedToolRecoveryRequiredError } from './hosted-workspace-tool-turn.js';

describe('Hosted Harness no-tool session', () => {
  useHostedTextSession();

  it.each(['create', 'resident-load', 'cold-load'])(
    'refuses an omitted Session model configuration digest on %s',
    async (operation) => {
      let server = await app();
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        modelConfigDigest: `sha256:${'a'.repeat(64)}`,
      });
      expect(created.status).toBe(200);
      if (operation === 'cold-load') {
        await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
          .set('X-Qwen-Client-Id', created.body.clientId as string)
          .expect(204);
        server = await app();
      }
      const result = await headers(
        supertest(server).post(
          operation === 'create' ? '/session' : `/session/${SESSION_ID}/load`,
        ),
      ).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
      });
      expect(result.status).toBe(409);
      expect(result.body.code).toBe('hosted_agent_definition_conflict');
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it.each(['create', 'resident-load', 'cold-load'])(
    'refuses an omitted personal memory binding on %s',
    async (operation) => {
      let server = await app();
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        memoryStoreId: 'memstore_personal',
      });
      expect(created.status).toBe(200);
      expect(state.memory).not.toHaveBeenCalled();
      if (operation === 'cold-load') {
        await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
          .set('X-Qwen-Client-Id', created.body.clientId as string)
          .expect(204);
        server = await app();
      }
      const result = await headers(
        supertest(server).post(
          operation === 'create' ? '/session' : `/session/${SESSION_ID}/load`,
        ),
      ).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
      });
      expect(result.status).toBe(409);
      expect(result.body.code).toBe('hosted_agent_definition_conflict');
      expect(state.memory).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'enables personal memory without a Workspace only when bound: %s',
    async (bound) => {
      const server = await app();
      state.memory.mockImplementation(async (query: { operation: string }) =>
        query.operation === 'binding'
          ? { enabled: true, memoryStoreId: 'memstore_personal' }
          : { status: 'ok', items: [{ memoryId: 'entry', content: 'saved' }] },
      );
      const warm = vi.spyOn(HostedWorkspaceBroker.prototype, 'warm');
      state.model.mockImplementationOnce(async (input) => {
        expect(input.userPrompt).toBe(true);
        if (bound) {
          expect(input.memory).toBeDefined();
          const tools = await input.toolTurn!.declarations(input.signal);
          expect(tools.map((tool) => tool.name)).toEqual([
            'context_search',
            'context_remember',
            'context_get',
            'context_forget',
          ]);
          await input.memory!.recall(PROMPT_ID, 'preferences', input.signal);
          const call = {
            name: 'context_search',
            callId: 'call-memory',
            args: { query: 'preferences' },
            isClientInitiated: false,
            prompt_id: PROMPT_ID,
          };
          await input.toolTurn!.execute(
            [call],
            [
              {
                functionCall: {
                  id: call.callId,
                  name: call.name,
                  args: call.args,
                },
              },
            ],
            'test-model',
            input.signal,
          );
        } else {
          expect(input.memory).toBeUndefined();
          expect(input.toolTurn).toBeUndefined();
        }
        return { text: 'memory checked', model: 'test-model' };
      });
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        ...(bound ? { memoryStoreId: 'memstore_personal' } : {}),
      });
      expect(created.status).toBe(200);
      expect(state.memory).not.toHaveBeenCalled();
      const prompt = [{ type: 'text', text: 'preferences' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', created.body.clientId as string);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      expect(
        journal.events.find((event) => event.kind === 'turn.settled')?.payload[
          'outcome'
        ],
      ).toBe('completed');
      expect(state.memory.mock.calls.map(([query]) => query.operation)).toEqual(
        bound ? ['binding', 'recall', 'search'] : [],
      );
      expect(warm).not.toHaveBeenCalled();
    },
  );

  it.each(['resident-load', 'cold-load'])(
    'resumes committed personal memory results without a Runtime on %s',
    async (operation) => {
      let server = await app();
      state.memory.mockImplementation(async (query: { operation: string }) =>
        query.operation === 'binding'
          ? { enabled: true, memoryStoreId: 'memstore_personal' }
          : { status: 'ok', items: [{ memoryId: 'entry', content: 'saved' }] },
      );
      const warm = vi.spyOn(HostedWorkspaceBroker.prototype, 'warm');
      let committed: Part[] = [];
      state.model.mockImplementationOnce(async (input) => {
        await input.toolTurn!.declarations(input.signal);
        const call = {
          name: 'context_search',
          callId: 'call-memory',
          args: { query: 'preferences' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        // Durable journal parts omit in-memory provenance symbols.
        committed = structuredClone(
          await input.toolTurn!.execute(
            [call],
            [
              {
                functionCall: {
                  id: call.callId,
                  name: call.name,
                  args: call.args,
                },
              },
            ],
            'test-model',
            input.signal,
          ),
        );
        throw new HostedToolRecoveryRequiredError(
          'Crash after committed memory result',
        );
      });
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        memoryStoreId: 'memstore_personal',
      });
      expect(created.status).toBe(200);
      const clientId = created.body.clientId as string;
      const prompt = [{ type: 'text', text: 'preferences' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.recoveryBlocked).toBe(true);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(committed).toEqual([
        expect.objectContaining({
          functionResponse: expect.objectContaining({ id: 'call-memory' }),
        }),
      ]);
      if (operation === 'cold-load') {
        await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
          .set('X-Qwen-Client-Id', clientId)
          .expect(204);
        server = await app();
      }
      state.model.mockResolvedValueOnce({
        text: 'recovered memory result',
        model: 'test-model',
      });
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        sessionScope: 'thread',
        managedSessionStore: store(),
        memoryStoreId: 'memstore_personal',
        driveRuntimeRecovery: true,
      });
      expect(loaded.status).toBe(200);
      await vi.waitFor(
        async () => {
          expect(state.model).toHaveBeenCalledTimes(2);
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.model.mock.calls[1][0].resumeFromToolResults).toEqual(
        committed,
      );
      expect(
        state.memory.mock.calls.filter(
          ([request]) => request.operation === 'search',
        ),
      ).toHaveLength(1);
      expect(warm).not.toHaveBeenCalled();
    },
  );

  it.each([
    new ManagedSessionStoreHttpError(
      503,
      'store_unavailable',
      'store is unavailable',
    ),
    new ManagedSessionStoreTransportError('store connection failed'),
  ])(
    'preserves a private model configuration Store outage as a Store failure: %s',
    async (cause) => {
      const server = await app();
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        modelConfigDigest: `sha256:${'a'.repeat(64)}`,
      });
      expect(created.status).toBe(200);
      state.modelConfig.mockRejectedValueOnce(cause);
      state.model.mockImplementationOnce(async (input) => {
        await input.modelConfig!();
        return { text: 'unreachable', model: 'test-model' };
      });
      const prompt = [{ type: 'text', text: 'read configuration' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      await vi.waitFor(
        async () => {
          const journal = await LocalJsonlManagedSessionJournalStore.read({
            transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
            runtimeBaseDir: state.root,
            sessionKey: {
              tenantId: 'tenant',
              workspaceId: 'workspace',
              sessionId: SESSION_ID,
            },
          });
          const settled = journal.events.find(
            (event) => event.kind === 'turn.settled',
          );
          expect(settled?.payload['stopReason']).toBe(
            'managed_session_store_unavailable',
          );
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.modelConfig).toHaveBeenCalledOnce();
    },
  );

  it('persists model selection and refuses changed resident and cold prompt replays', async () => {
    let server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    let clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'model selection' }];
    const request = {
      prompt,
      promptId: PROMPT_ID,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      modelSelection: { modelId: 'model-a', revision: 1 },
    };
    const send = (body = request) =>
      headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send(body);
    const idle = () =>
      vi.waitFor(
        async () => {
          const result = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(result.body.hasActivePrompt).toBe(false);
        },
        // The turn's settle crosses fsync-backed journal commits before the
        // active flag clears; the default 1s waitFor window flaked on a loaded
        // CI runner (#14101, #13219).
        { timeout: settleTimeoutMs() },
      );
    await send().expect(202);
    await idle();
    expect(state.model.mock.calls[0][0].modelSelection).toEqual(
      request.modelSelection,
    );
    await send({
      ...request,
      modelSelection: { modelId: 'model-b', revision: 2 },
    }).expect(409);
    await send().expect(202);
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    server = await app();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    clientId = loaded.body.clientId as string;
    await send({
      ...request,
      modelSelection: { modelId: 'model-b', revision: 2 },
    }).expect(409);
    await send().expect(202);
    await send({
      ...request,
      promptId: randomUUID(),
      modelSelection: { modelId: 'model-b', revision: 2 },
    }).expect(202);
    await idle();
    expect(
      state.model.mock.calls.map(([input]) => input.modelSelection),
    ).toEqual([request.modelSelection, { modelId: 'model-b', revision: 2 }]);
  });

  it.each(
    [
      { toolProfile: 'hosted-workspace-files/1', custom: false },
      { toolProfile: 'hosted-workspace-files/1', custom: true },
      { toolProfile: 'hosted-workspace-shell/1', custom: true },
      { toolProfile: 'hosted-workspace-shell/3', custom: true },
      { toolProfile: 'hosted-workspace-shell/3', custom: false },
      { toolProfile: 'hosted-workspace-files/3', custom: true },
      { toolProfile: 'hosted-workspace-files/3', custom: false },
    ].flatMap((profile) =>
      [undefined, { mode: 'yolo', revision: 1 }].map((approvalSelection) => ({
        ...profile,
        approvalSelection,
      })),
    ),
  )(
    'preserves approval selection $approvalSelection for $toolProfile custom=$custom across resident and cold replays',
    async ({ approvalSelection, toolProfile, custom }) => {
      const agentDefinition = custom
        ? {
            agentId: `agent_${'a'.repeat(32)}`,
            revision: '1',
            digest: 'b'.repeat(64),
          }
        : undefined;
      let server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile,
        approvalMode: 'default',
        agentDefinition: agentDefinition && {
          ...agentDefinition,
          model: { id: 'configured' },
        },
      });
      expect(created.status).toBe(200);
      let clientId = created.body.clientId as string;
      const prompt = [{ type: 'text', text: 'approval selection' }];
      const request = {
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        approvalSelection,
      };
      const send = (body = request) =>
        headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .set('X-Qwen-Client-Id', clientId)
          .send(body);
      const idle = () =>
        vi.waitFor(
          async () => {
            const result = await headers(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', clientId);
            expect(result.body.hasActivePrompt).toBe(false);
          },
          { timeout: settleTimeoutMs() },
        );
      await send().expect(202);
      await idle();
      expect(state.model).toHaveBeenCalledTimes(1);
      await send({
        ...request,
        approvalSelection: { mode: 'auto-edit', revision: 2 },
      }).expect(409);
      await send().expect(202);
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
      server = await app(true);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: store(),
        toolProfile,
        agentDefinition,
      });
      expect(loaded.status).toBe(200);
      clientId = loaded.body.clientId as string;
      await send({
        ...request,
        approvalSelection: { mode: 'auto-edit', revision: 2 },
      }).expect(409);
      await send().expect(202);
      await send({
        ...request,
        promptId: randomUUID(),
        approvalSelection: { mode: 'auto-edit', revision: 2 },
      }).expect(202);
      await idle();
      expect(state.model).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    undefined,
    'hosted-workspace-files/2',
    'hosted-workspace-read/1',
    'hosted-workspace-team-lead/1',
  ])(
    'refuses custom approval selection outside the supported profiles (%s)',
    async (toolProfile) => {
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile,
        approvalMode: 'default',
        agentDefinition: {
          agentId: `agent_${'a'.repeat(32)}`,
          revision: '1',
          digest: 'b'.repeat(64),
          model: { id: 'configured' },
        },
      });
      expect(created.status).toBe(200);
      const prompt = [{ type: 'text', text: 'unsupported selection' }];
      const refused = await headers(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', created.body.clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          approvalSelection: { mode: 'yolo', revision: 1 },
        });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('invalid_hosted_approval_selection');
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it('restores the accepted model selection before re-running an interrupted model', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    state.model.mockImplementationOnce(async (input) => {
      const prepare = (
        input as unknown as {
          prepareModel(
            prepared: LlmPreparedRequest,
            round: number,
            pending: boolean,
          ): Promise<
            | import('@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js').ManagedSessionDurableRef
            | undefined
          >;
        }
      ).prepareModel;
      const ref = await prepare(
        {
          request: {
            model: 'model-b',
            contents: [
              { role: 'user', parts: [{ text: 'restore model selection' }] },
            ],
            config: {},
          },
          history: [],
          completedToolCallIds: [],
          routeSelector: 'openai:model-b',
          providerPin: 'a'.repeat(64),
          promptTokensForClamp: 0,
        },
        0,
        false,
      );
      await input.modelScope!.beginMainAttempt('model-b', ref);
      throw new HostedToolRecoveryRequiredError('interrupted');
    });
    const prompt = [{ type: 'text', text: 'restore model selection' }];
    const modelSelection = { modelId: 'model-b', revision: 2 };
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        modelSelection,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    // The slow-host settle budget, not vitest's 1 s default: at load ~90 with
    // ~100 concurrent vitest processes the recovery-blocked state had not
    // settled before the default expired (#15528's post-merge run).
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .expect(204);
    const replacement = await app();
    const loaded = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    )
      .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
      .expect(200);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(2), {
      timeout: settleTimeoutMs(),
    });
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(replacement).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(
      state.model.mock.calls.map(([input]) => input.modelSelection),
    ).toEqual([modelSelection, modelSelection]);
  });
});
