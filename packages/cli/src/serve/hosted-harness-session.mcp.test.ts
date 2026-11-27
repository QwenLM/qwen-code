/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BOOT_ID,
  PROMPT_ID,
  SESSION_ID,
  app,
  headers,
  mcpApp,
  settleTimeoutMs,
  state,
  store,
  useHostedTextSession,
} from './hosted-harness-session.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type { ManagedMcpOperationView } from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import * as stdio from '../utils/stdioHelpers.js';

describe('Hosted Harness no-tool session', () => {
  useHostedTextSession();

  it('refuses file history APIs on the MCP profile without blocking its session', async () => {
    const { server, authorize } = await mcpApp();
    const history = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    );
    expect(history.status).toBe(409);
    expect(history.body.code).toBe('hosted_file_history_unavailable');
    const undo = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    ).send({ promptId: PROMPT_ID, requestId: randomUUID() });
    expect(undo.status).toBe(409);
    expect(undo.body.code).toBe('hosted_file_history_unavailable');
    expect(HostedWorkspaceBroker.prototype.fileHistory).not.toHaveBeenCalled();
    const status = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    );
    expect(status.body.recoveryBlocked).toBe(false);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
  });

  it('admits ordinary Shell with MCP, keeps file history available and refuses Plan before MCP starts', async () => {
    const { server, authorize, requests } = await mcpApp(
      false,
      ['demo'],
      'hosted-workspace-shell/1',
    );
    const history = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    );
    expect(history.status).toBe(200);
    expect(history.body.history).toBeNull();
    const prompt = [{ type: 'text', text: 'plan without running tools' }];
    const refused = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({
      prompt,
      promptId: PROMPT_ID,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      approvalSelection: { mode: 'default', revision: 1, planMode: true },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('invalid_hosted_approval_selection');
    expect(requests).toEqual([]);
    const close = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(close.status).toBe(409);
    expect(close.body.code).toBe('hosted_lifecycle_required');
  });

  it.each(['hosted-workspace-files/1', 'hosted-workspace-shell/1'])(
    'refuses MCP configuration records without definition pins on %s',
    async (toolProfile) => {
      const sessionKey = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
      const resources = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey,
      });
      const managed = await openManagedSession({
        runtimeBaseDir: state.root,
        transcriptPath: '',
        sessionId: SESSION_ID,
        sessionKey,
        cwd: state.root,
        version: 'hosted-harness/1',
        workerId: BOOT_ID,
        activationLeaseDurationMs: 60_000,
        journalStore: new LocalJsonlManagedSessionJournalStore({
          runtimeBaseDir: state.root,
          sessionId: SESSION_ID,
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        }),
        resourceStore: resources,
        create: {
          definitionRef: await resources.publish(
            'managed-definition',
            Buffer.from(
              JSON.stringify({
                engine: 'managed',
                sessionId: SESSION_ID,
                toolProfile,
              }),
            ),
          ),
          rootSnapshotRef: await resources.publish(
            'managed-root',
            Buffer.from(JSON.stringify({ cwd: state.root })),
          ),
          createdBy: 'hosted-harness',
        },
      });
      try {
        const fixture = JSON.parse(
          await readFile(
            path.resolve(
              '../core/src/managed-runtime/contracts/managed-mcp-record-v1.fixtures.json',
            ),
            'utf8',
          ),
        ) as {
          templates: {
            mcp_configuration: import('@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js').ManagedSessionJsonValue;
          };
        };
        await managed.authority.commitExtensionRecord(
          {
            operation: 'commitExtensionRecord',
            commandId: 'configure-1',
            sessionKey,
            contentDigest: 'd'.repeat(64),
          },
          {
            domain: 'mcp_configuration',
            record: fixture.templates.mcp_configuration,
          },
          { class: 'trusted_entry' },
        );
      } finally {
        await managed.close();
      }
      const server = await app(true);
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile });
      expect(loaded.status).toBe(409);
      expect(loaded.body.reason).toBe('restore_verification_failed');
      expect(log.mock.calls.map(([line]) => line)).toContain(
        `qwen serve: Hosted Session ${SESSION_ID} load refused (workspace_verify): Error: Hosted MCP configuration is not pinned.`,
      );
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'unblocks MCP resource requests after the original unknown operation settles (Broker restarted: %s)',
    async (restartBroker) => {
      const { server, authorize, requests, replies, brokerOwners } =
        await mcpApp();
      const operationId = randomUUID();
      replies.set(operationId, { operationId, state: 'outcome_unknown' });
      const send = (id: string) =>
        authorize(
          supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
        ).send({
          operationId: id,
          serverId: 'demo',
          request: { kind: 'resource_read', uri: 'memory://note' },
        });
      expect((await send(operationId)).body.state).toBe('outcome_unknown');
      const status = () =>
        authorize(supertest(server).get(`/session/${SESSION_ID}/status`));
      expect((await status()).body.recoveryBlocked).toBe(true);
      expect((await send(randomUUID())).status).toBe(409);
      const prompt = [{ type: 'text', text: 'blocked by raw operation' }];
      expect(
        (
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/prompt`),
          ).send({
            prompt,
            promptId: PROMPT_ID,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          })
        ).status,
      ).toBe(409);
      expect(state.model).not.toHaveBeenCalled();

      const settled: ManagedMcpOperationView = {
        operationId,
        state: 'settled',
        response: { contents: [{ uri: 'memory://note', text: 'late result' }] },
      };
      replies.set(operationId, settled);
      const originalOwner = [...brokerOwners][0];
      if (restartBroker) brokerOwners.clear();
      const recovered = await authorize(
        supertest(server).get(
          `/session/${SESSION_ID}/mcp/operations/${operationId}`,
        ),
      );
      expect(recovered.status).toBe(200);
      expect(recovered.body).toEqual(settled);
      expect([...brokerOwners]).toEqual([originalOwner]);
      expect((await status()).body.recoveryBlocked).toBe(false);
      const next = await send(randomUUID());
      expect(next.status).toBe(202);
      expect(next.body.state).toBe('settled');
      expect(
        requests.filter((request) => request.kind === 'mcp-invoke'),
      ).toHaveLength(2);
      expect(
        requests.filter((request) => request.kind === 'mcp-configure'),
      ).toHaveLength(1);
      expect(
        (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
          .status,
      ).toBe(204);
    },
  );

  it.each(['cancel', 'deadline'] as const)(
    'stops first-prompt MCP initialization after %s without admitting input or configuring another server',
    async (ending) => {
      const { server, authorize, requests, replies } = await mcpApp(false, [
        'demo',
        'second',
      ]);
      const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
      const original = control.getMockImplementation()!;
      const admit = vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'submitInput',
      );
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let configurationId: string | undefined;
      let returned = false;
      control.mockImplementation(async function (
        this: HostedWorkspaceBroker,
        operation,
      ) {
        const response = await original.call(this, operation);
        if (
          operation.kind === 'mcp-configure' &&
          operation.serverId === 'demo'
        ) {
          configurationId = operation.operationId;
          replies.set(configurationId, {
            operationId: configurationId,
            state: 'outcome_unknown',
          });
          await pending;
          replies.set(configurationId, response);
          returned = true;
        }
        return response;
      });
      const prompt = [{ type: 'text', text: 'cancel initial discovery' }];
      const send = (id: string, deadlineMs?: number) =>
        authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`)).send(
          {
            prompt,
            promptId: id,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
            ...(deadlineMs === undefined ? {} : { deadlineMs }),
          },
        );
      let response: supertest.Response | undefined;
      const submitted = send(
        PROMPT_ID,
        ending === 'deadline' ? 1000 : undefined,
      ).then((value) => {
        response = value;
      });
      try {
        await vi.waitFor(() => expect(configurationId).toBeDefined(), {
          timeout: settleTimeoutMs(),
        });
        if (ending === 'cancel')
          expect(
            (
              await authorize(
                supertest(server).post(`/session/${SESSION_ID}/cancel`),
              )
            ).status,
          ).toBe(204);
        await vi.waitFor(() => expect(response).toBeDefined(), {
          timeout: 3000,
        });
        expect(response!.status).toBe(503);
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
        expect(admit).not.toHaveBeenCalled();
        expect(state.model).not.toHaveBeenCalled();
        expect((await send(randomUUID())).body.error).toBe(
          'hosted_mcp_recovery_required',
        );
        expect(
          (
            await authorize(
              supertest(server).post(`/session/${SESSION_ID}/detach`),
            )
          ).status,
        ).toBe(503);
        finish();
        await vi.waitFor(() => expect(returned).toBe(true));
        expect(
          requests
            .filter((request) => request.kind === 'mcp-configure')
            .map((request) => request.serverId),
        ).toEqual(['demo']);
        expect(admit).not.toHaveBeenCalled();
        expect((await send(randomUUID())).status).toBe(202);
        await vi.waitFor(
          async () =>
            expect(
              (
                await authorize(
                  supertest(server).get(`/session/${SESSION_ID}/status`),
                )
              ).body.hasActivePrompt,
            ).toBe(false),
          { timeout: settleTimeoutMs() },
        );
        expect(
          requests
            .filter((request) => request.kind === 'mcp-configure')
            .map((request) => request.serverId),
        ).toEqual(['demo', 'second']);
        expect(state.model).toHaveBeenCalledOnce();
        expect(
          (
            await authorize(
              supertest(server).post(`/session/${SESSION_ID}/detach`),
            )
          ).status,
        ).toBe(204);
      } finally {
        finish();
        await submitted;
        // Cleanup, not proof: a wedged turn must still report the try block's
        // assertion rather than this wait's timeout.
        await vi.waitFor(
          async () => {
            const status = await authorize(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            );
            expect(status.status === 404 || !status.body.hasActivePrompt).toBe(
              true,
            );
          },
          { timeout: 10_000 },
        );
        await authorize(supertest(server).delete(`/session/${SESSION_ID}`));
      }
    },
  );

  it('does not admit input when cancellation arrives during publication after MCP initialization', async () => {
    const { server, authorize } = await mcpApp();
    const original = LocalManagedSessionResourceStore.prototype.publish;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let publishing = false;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    ).mockImplementation(async function (
      this: LocalManagedSessionResourceStore,
      ...args
    ) {
      const result = await original.apply(this, args);
      if (args[0] === 'managed-input') {
        publishing = true;
        await pending;
      }
      return result;
    });
    const admit = vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'submitInput',
    );
    const prompt = [{ type: 'text', text: 'cancel before input admission' }];
    const submitted = authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .then((response) => response);
    try {
      await vi.waitFor(() => expect(publishing).toBe(true));
      expect(
        (
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/cancel`),
          )
        ).status,
      ).toBe(204);
      finish();
      expect((await submitted).status).toBe(503);
      expect(admit).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
      expect(
        (
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/detach`),
          )
        ).status,
      ).toBe(204);
    } finally {
      finish();
      await submitted;
    }
  });

  it.each(['status', 'cancel'] as const)(
    'serves MCP %s during dispatch and keeps admissions fenced until both finish',
    async (kind) => {
      const { server, authorize, requests, replies } = await mcpApp();
      const operationId = randomUUID();
      replies.set(operationId, { operationId, state: 'outcome_unknown' });
      const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
      const original = control.getMockImplementation()!;
      let finishInvoke!: () => void;
      let finishRecovery!: () => void;
      const invoking = new Promise<void>((resolve) => {
        finishInvoke = resolve;
      });
      const recovering = new Promise<void>((resolve) => {
        finishRecovery = resolve;
      });
      let invokeStarted = false;
      let recoveryStarted = false;
      control.mockImplementation(async function (
        this: HostedWorkspaceBroker,
        operation,
      ) {
        if (operation.kind === 'mcp-invoke') {
          invokeStarted = true;
          await invoking;
        }
        if (
          operation.kind === (kind === 'status' ? 'mcp-status' : 'mcp-cancel')
        ) {
          recoveryStarted = true;
          await recovering;
        }
        return original.call(this, operation);
      });
      const invoke = authorize(
        supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
      )
        .send({
          operationId,
          serverId: 'demo',
          request: { kind: 'resource_read', uri: 'memory://note' },
        })
        .then((response) => response);
      let recovery: Promise<supertest.Response> | undefined;
      try {
        await vi.waitFor(() => expect(invokeStarted).toBe(true), {
          timeout: 10_000,
        });
        const url = `/session/${SESSION_ID}/mcp/operations/${operationId}`;
        recovery = authorize(
          kind === 'status'
            ? supertest(server).get(url)
            : supertest(server).post(`${url}/cancel`),
        ).then((response) => response);
        await vi.waitFor(() => expect(recoveryStarted).toBe(true), {
          timeout: 10_000,
        });
        finishInvoke();
        expect((await invoke).status).toBe(202);
        expect(
          (
            await authorize(
              supertest(server).post(`/session/${SESSION_ID}/detach`),
            )
          ).status,
        ).toBe(409);
        const prompt = [{ type: 'text', text: 'still recovering' }];
        expect(
          (
            await authorize(
              supertest(server).post(`/session/${SESSION_ID}/prompt`),
            ).send({
              prompt,
              promptId: PROMPT_ID,
              payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
            })
          ).status,
        ).toBe(409);
        finishRecovery();
        expect((await recovery).status).toBe(kind === 'status' ? 200 : 202);
        expect(
          requests.filter((request) => request.kind === 'mcp-invoke'),
        ).toHaveLength(1);
        const settled: ManagedMcpOperationView = {
          operationId,
          state: 'settled',
          response: { contents: [] },
        };
        replies.set(operationId, settled);
        expect((await authorize(supertest(server).get(url))).body).toEqual(
          settled,
        );
        expect(
          (
            await authorize(
              supertest(server).post(`/session/${SESSION_ID}/detach`),
            )
          ).status,
        ).toBe(204);
      } finally {
        finishInvoke();
        finishRecovery();
        await invoke;
        await recovery;
      }
    },
  );

  it('refuses every MCP operation and prompt admission while close is pending', async () => {
    const { server, authorize } = await mcpApp();
    const resource = () =>
      authorize(
        supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
      ).send({
        operationId: randomUUID(),
        serverId: 'demo',
        request: { kind: 'resource_read', uri: 'memory://note' },
      });
    const operationId = (await resource()).body.operationId as string;
    const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
    const original = control.getMockImplementation()!;
    let released: () => void = () => undefined;
    const releasePending = new Promise<void>((resolve) => {
      released = resolve;
    });
    let releasing = false;
    control.mockImplementation(async function (
      this: HostedWorkspaceBroker,
      operation,
    ) {
      if (operation.kind === 'mcp-release') {
        releasing = true;
        await releasePending;
      }
      return original.call(this, operation);
    });
    const closed = headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).then((response) => response);
    const admit = vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'submitInput',
    );
    try {
      await vi.waitFor(() => expect(releasing).toBe(true));
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      const sendPrompt = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      ).send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest,
      });
      expect(sendPrompt.status).toBe(409);
      const configure = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/mcp/configurations`),
      ).send({
        operationId: randomUUID(),
        expectedRevision: 1,
        server: {
          serverId: 'demo',
          serverRevision: 2,
          definitionDigest: 'b'.repeat(64),
        },
      });
      expect(configure.status).toBe(409);
      expect((await resource()).status).toBe(409);
      expect(
        (
          await authorize(
            supertest(server).get(
              `/session/${SESSION_ID}/mcp/operations/${operationId}`,
            ),
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await authorize(
            supertest(server).post(
              `/session/${SESSION_ID}/mcp/operations/${operationId}/cancel`,
            ),
          )
        ).status,
      ).toBe(409);
      expect(admit).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
    } finally {
      released();
    }
    expect((await closed).status).toBe(204);
  });

  it.each([
    [
      'an MCP configuration',
      'mcp-configure',
      202,
      'hosted_mcp_operation_active',
    ],
    ['Session deletion', 'mcp-release', 204, 'hosted_session_closing'],
  ] as const)(
    'refuses a prompt while %s runs',
    async (trigger, parked, settled, code) => {
      const { server, authorize } = await mcpApp();
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
      )
        .send({
          operationId: randomUUID(),
          serverId: 'demo',
          request: { kind: 'resource_read', uri: 'memory://note' },
        })
        .expect(202);
      const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
      const original = control.getMockImplementation()!;
      let dispatched!: () => void;
      const started = new Promise<void>((resolve) => (dispatched = resolve));
      let finish!: () => void;
      const held = new Promise<void>((resolve) => (finish = resolve));
      control.mockImplementation(async function (
        this: HostedWorkspaceBroker,
        operation,
      ) {
        if (operation.kind === parked) {
          dispatched();
          await held;
        }
        return original.call(this, operation);
      });
      const running = (
        trigger === 'Session deletion'
          ? headers(supertest(server).delete(`/session/${SESSION_ID}`))
          : authorize(
              supertest(server).post(
                `/session/${SESSION_ID}/mcp/configurations`,
              ),
            ).send({
              operationId: randomUUID(),
              expectedRevision: 1,
              server: {
                serverId: 'demo',
                serverRevision: 1,
                definitionDigest: 'a'.repeat(64),
              },
            })
      ).then(
        (response) => response,
        () => undefined,
      );
      await started;
      try {
        const refused = await authorize(
          supertest(server).post(`/session/${SESSION_ID}/prompt`),
        ).send({});
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe(code);
      } finally {
        finish();
        expect((await running)?.status).toBe(settled);
      }
    },
  );

  it.each(['invoke', 'close'])(
    'restores the owner before %s after an idle Broker restart',
    async (next) => {
      const { server, authorize, brokerOwners } = await mcpApp();
      const invoke = () =>
        authorize(
          supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
        ).send({
          operationId: randomUUID(),
          serverId: 'demo',
          request: { kind: 'resource_read', uri: 'memory://note' },
        });
      expect((await invoke()).body.state).toBe('settled');
      brokerOwners.clear();
      if (next === 'invoke')
        expect((await invoke()).body.state).toBe('settled');
      expect(
        (
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/detach`),
          )
        ).status,
      ).toBe(204);
    },
  );

  it.each([
    { kind: 'resource_read', uri: '' },
    { kind: 'resource_read', uri: '   ' },
    { kind: 'prompt_get', name: '', arguments: {} },
    { kind: 'prompt_get', name: '   ', arguments: {} },
    { kind: 'resource_read', uri: 'memory://\ud800' },
    { kind: 'prompt_get', name: 'greet\udfff', arguments: {} },
    { kind: 'prompt_get', name: 'greet', arguments: { value: '\ud800' } },
    { kind: 'prompt_get', name: 'greet', arguments: { ['\udfff']: 'value' } },
  ])(
    'rejects invalid MCP strings before committing or dispatching: %j',
    async (request) => {
      const { server, authorize, requests } = await mcpApp();
      const commit = vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'commitExtensionRecord',
      );
      const rejected = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
      ).send({ operationId: randomUUID(), serverId: 'demo', request });
      expect(rejected.status).toBe(400);
      expect(commit).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      const status = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      );
      expect(status.body.recoveryBlocked).toBe(false);
      expect(
        (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
          .status,
      ).toBe(204);
    },
  );

  it.each(['unknown', 'failed'] as const)(
    'settles a turn after %s discovery and can retry and reload',
    async (failure) => {
      const { server, authorize } = await mcpApp();
      const physical = vi
        .mocked(HostedWorkspaceBroker.prototype.control)
        .getMockImplementation()!;
      let fail = true;
      vi.mocked(HostedWorkspaceBroker.prototype.control).mockImplementation(
        async function (this: HostedWorkspaceBroker, operation) {
          if (operation.kind === 'mcp-discover' && fail) {
            fail = false;
            if (failure === 'unknown') throw new Error('Broker 503');
            return {
              operationId: operation.operationId,
              state: 'settled',
              error: { code: 'managed_mcp_connection_failed' },
            };
          }
          return physical.call(this, operation);
        },
      );
      let modelRequests = 0;
      state.model.mockImplementation(async ({ toolTurn }) => {
        await toolTurn!.declarations(new AbortController().signal);
        modelRequests++;
        return { text: 'done', model: 'test-model' };
      });
      const send = (promptId: string) => {
        const prompt = [{ type: 'text', text: 'hello' }];
        return authorize(
          supertest(server).post(`/session/${SESSION_ID}/prompt`),
        ).send({
          prompt,
          promptId,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        });
      };
      expect((await send(PROMPT_ID)).status).toBe(202);
      await vi.waitFor(
        async () => {
          const transcript = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/transcript`),
          );
          expect(transcript.body.events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'turn_error',
                promptId: PROMPT_ID,
              }),
            ]),
          );
        },
        { timeout: settleTimeoutMs() },
      );
      expect(modelRequests).toBe(0);
      expect((await send(randomUUID())).status).toBe(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(modelRequests).toBe(1);
      expect(
        (
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/detach`),
          )
        ).status,
      ).toBe(204);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        toolProfile: 'hosted-workspace-mcp/1',
        mcpServers: [
          {
            serverId: 'demo',
            serverRevision: 1,
            definitionDigest: 'a'.repeat(64),
          },
        ],
        managedSessionStore: store(),
      });
      expect(loaded.status).toBe(200);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    },
  );

  it('keeps MCP load explicit and outside Workspace-only cold validation', async () => {
    const { server, authorize } = await mcpApp();
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
    )
      .send({
        operationId: randomUUID(),
        serverId: 'demo',
        request: { kind: 'resource_read', uri: 'memory://note' },
      })
      .expect(202);
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    ).expect(204);
    state.assertWritable.mockRejectedValue(
      new Error('Workspace-only validation must not run'),
    );
    const load = (body: Record<string, unknown>) =>
      headers(supertest(server).post(`/session/${SESSION_ID}/load`)).send({
        managedSessionStore: store(),
        ...body,
      });
    expect((await load({})).body.code).toBe('hosted_tool_profile_conflict');
    expect(
      (await load({ toolProfile: 'hosted-workspace-mcp/1' })).body.code,
    ).toBe('invalid_hosted_mcp_servers');
    const mcpServers = [
      { serverId: 'demo', serverRevision: 1, definitionDigest: 'a'.repeat(64) },
    ];
    expect(
      (
        await load({
          toolProfile: 'hosted-workspace-mcp/1',
          mcpServers: [{ ...mcpServers[0], serverRevision: 2 }],
        })
      ).body.code,
    ).toBe('hosted_tool_profile_conflict');
    const loaded = await load({
      toolProfile: 'hosted-workspace-mcp/1',
      mcpServers,
    });
    expect(loaded.status).toBe(200);
    expect(state.assertWritable).not.toHaveBeenCalled();
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .expect(204);
  });

  it('keeps valid Unicode arguments intact through raw MCP admission', async () => {
    const { server, authorize, requests } = await mcpApp();
    const request = {
      kind: 'prompt_get',
      name: 'greet',
      arguments: { ['名字😀']: '你好😀' },
    };
    const response = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
    ).send({ operationId: randomUUID(), serverId: 'demo', request });
    expect(response.status).toBe(202);
    expect(response.body.state).toBe('settled');
    expect(requests.find((entry) => entry.kind === 'mcp-invoke')).toMatchObject(
      { request },
    );
    expect(
      (await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`)))
        .status,
    ).toBe(204);
  });

  it('settles a turn overlapping explicit configuration without latching recovery', async () => {
    const { server, authorize, requests } = await mcpApp();
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
    ).send({
      operationId: randomUUID(),
      serverId: 'demo',
      request: { kind: 'resource_read', uri: 'memory://note' },
    });
    let resumeModel!: () => void;
    let resumeConfigure!: () => void;
    const modelBarrier = new Promise<void>((resolve) => {
      resumeModel = resolve;
    });
    const configurationBarrier = new Promise<void>((resolve) => {
      resumeConfigure = resolve;
    });
    let modelEntered = false;
    let configurationEntered = false;
    state.model.mockImplementation(async ({ signal, toolTurn }) => {
      modelEntered = true;
      await modelBarrier;
      await toolTurn!.declarations(signal);
      return { text: 'done', model: 'test-model' };
    });
    const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
    const physical = control.getMockImplementation()!;
    control.mockImplementation(async function (
      this: HostedWorkspaceBroker,
      operation,
    ) {
      if (
        operation.kind === 'mcp-configure' &&
        operation.configRevision === 2
      ) {
        configurationEntered = true;
        await configurationBarrier;
      }
      if (operation.kind === 'mcp-discover' && configurationEntered)
        return {
          operationId: operation.operationId,
          state: 'settled',
          error: { code: 'managed_mcp_binding_conflict' },
        };
      return physical.call(this, operation);
    });
    const send = (promptId: string) => {
      const prompt = [{ type: 'text', text: 'hello' }];
      return authorize(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      ).send({
        prompt,
        promptId,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    };
    expect((await send(PROMPT_ID)).status).toBe(202);
    await vi.waitFor(() => expect(modelEntered).toBe(true));
    const configuring = authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/configurations`),
    )
      .send({
        operationId: randomUUID(),
        expectedRevision: 1,
        server: {
          serverId: 'demo',
          serverRevision: 1,
          definitionDigest: 'a'.repeat(64),
        },
      })
      .then((response) => response);
    try {
      await vi.waitFor(() => expect(configurationEntered).toBe(true));
      resumeModel();
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      const transcript = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      );
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'turn_error', promptId: PROMPT_ID }),
        ]),
      );
      resumeConfigure();
      expect((await configuring).status).toBe(202);
      configurationEntered = false;
      expect((await send(randomUUID())).status).toBe(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: false,
          });
        },
        { timeout: settleTimeoutMs() },
      );
      expect(
        requests.filter((entry) => entry.kind === 'mcp-configure'),
      ).toHaveLength(2);
      expect(
        (
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/detach`),
          )
        ).status,
      ).toBe(204);
    } finally {
      resumeModel();
      resumeConfigure();
      await configuring;
    }
  });

  it.each([
    [16, 200],
    [17, 400],
    [32, 400],
  ])(
    'checks the MCP pin limit at creation (%i pins)',
    async (count, status) => {
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-mcp/1',
        mcpServers: Array.from({ length: count }, (_, index) => ({
          serverId: `server-${index}`,
          serverRevision: 1,
          definitionDigest: 'a'.repeat(64),
        })),
      });
      if (created.status === 200)
        await headers(supertest(server).delete(`/session/${SESSION_ID}`));
      expect(created.status).toBe(status);
      if (status === 400)
        expect(created.body.code).toBe('invalid_hosted_mcp_servers');
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it.each([17, 32])(
    'loads and detaches an existing %i-pin MCP Session',
    async (count) => {
      const mcpServers = Array.from({ length: count }, (_, index) => ({
        serverId: `server-${index}`,
        serverRevision: 1,
        definitionDigest: 'a'.repeat(64),
      }));
      const sessionKey = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
      const resources = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey,
      });
      const transcriptPath = path.join(state.root, `${SESSION_ID}.jsonl`);
      const previous = await openManagedSession({
        runtimeBaseDir: state.root,
        cwd: state.root,
        transcriptPath,
        sessionId: SESSION_ID,
        sessionKey,
        version: 'hosted-harness/1',
        workerId: BOOT_ID,
        activationLeaseDurationMs: 60_000,
        journalStore: new LocalJsonlManagedSessionJournalStore({
          runtimeBaseDir: state.root,
          sessionId: SESSION_ID,
          transcriptPath,
        }),
        resourceStore: resources,
        create: {
          definitionRef: await resources.publish(
            'managed-definition',
            Buffer.from(
              JSON.stringify({
                engine: 'managed',
                sessionId: SESSION_ID,
                toolProfile: 'hosted-workspace-mcp/1',
                mcpServers,
              }),
            ),
          ),
          rootSnapshotRef: await resources.publish(
            'managed-root',
            Buffer.from('{}'),
          ),
          createdBy: 'hosted-harness',
        },
      });
      await previous.close();
      const server = await app(true);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        toolProfile: 'hosted-workspace-mcp/1',
        mcpServers,
        managedSessionStore: store(),
      });
      expect(loaded.status).toBe(200);
      expect(
        (
          await headers(
            supertest(server).post(`/session/${SESSION_ID}/detach`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string)
        ).status,
      ).toBe(204);
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it.each(['prompt', 'configuration', 'resource'])(
    'reports exhausted Runtime capacity from the MCP %s entry point',
    async (entryPoint) => {
      const { server, authorize } = await mcpApp();
      const resource = () =>
        authorize(
          supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
        ).send({
          operationId: randomUUID(),
          serverId: 'demo',
          request: { kind: 'resource_read', uri: 'memory://note' },
        });
      if (entryPoint === 'configuration')
        expect((await resource()).status).toBe(202);
      const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
      const physical = control.getMockImplementation()!;
      control.mockImplementationOnce(async (operation) => {
        expect(operation.kind).toBe('mcp-configure');
        return {
          operationId: operation.operationId,
          state: 'settled',
          error: { code: 'managed_mcp_connection_quota' },
        };
      });
      const admit = vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'submitInput',
      );
      const prompt = [{ type: 'text', text: 'hello' }];
      const sendPrompt = () =>
        authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`)).send(
          {
            prompt,
            promptId: PROMPT_ID,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          },
        );
      const rejected =
        entryPoint === 'prompt'
          ? await sendPrompt()
          : entryPoint === 'resource'
            ? await resource()
            : await authorize(
                supertest(server).post(
                  `/session/${SESSION_ID}/mcp/configurations`,
                ),
              ).send({
                operationId: randomUUID(),
                expectedRevision: 1,
                server: {
                  serverId: 'demo',
                  serverRevision: 2,
                  definitionDigest: 'a'.repeat(64),
                },
              });
      expect(rejected.status).toBe(409);
      expect(rejected.body.code).toBe('managed_mcp_connection_quota');
      expect(admit).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
      control.mockImplementation(physical);
      if (entryPoint === 'prompt') {
        expect((await sendPrompt()).status).toBe(202);
        await vi.waitFor(
          async () => {
            const status = await authorize(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            );
            expect(status.body.hasActivePrompt).toBe(false);
            expect(status.body.recoveryBlocked).toBe(false);
          },
          { timeout: settleTimeoutMs() },
        );
        expect(state.model).toHaveBeenCalledOnce();
      }
      expect(
        (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
          .status,
      ).toBe(204);
    },
  );

  it('reconciles an unknown initial MCP configuration before admitting a retried prompt', async () => {
    const { server, authorize, requests } = await mcpApp(true);
    const admit = vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'submitInput',
    );
    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const send = () =>
      authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`)).send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest,
      });
    const rejected = await send();
    expect(rejected.status).toBe(503);
    expect(admit).not.toHaveBeenCalled();
    expect(state.model).not.toHaveBeenCalled();
    expect(requests.map((request) => request.kind)).toEqual(['mcp-configure']);

    const replacement = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/configurations`),
    ).send({
      operationId: randomUUID(),
      expectedRevision: 1,
      server: {
        serverId: 'demo',
        serverRevision: 1,
        definitionDigest: 'a'.repeat(64),
      },
    });
    expect(replacement.status).toBe(503);
    expect(replacement.body.error).toBe('hosted_mcp_recovery_required');
    expect(requests.map((request) => request.kind)).toEqual(['mcp-configure']);

    const admitted = await send();
    expect(admitted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(admit).toHaveBeenCalledOnce();
    expect(state.model).toHaveBeenCalledOnce();
    expect(requests.map((request) => request.kind)).toEqual([
      'mcp-configure',
      'mcp-status',
    ]);
    expect(requests[1]).toMatchObject({
      targetOperationId: requests[0].operationId,
    });
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });
});
