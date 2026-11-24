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
  domainEnablement,
  enforceInlineResourceLimit,
  expectFullStreamedAnswer,
  headers,
  settleTimeoutMs,
  state,
  store,
  useHostedTextSession,
} from './hosted-harness-session.test-helper.js';
import { mockBrokerBroker } from './hosted-harness-session-wake.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import { ServerResponse } from 'node:http';
import path from 'node:path';
import { resolveSseAdmissionCaps } from './daemon-status.js';
import { getSseOccupancy } from './sse-occupancy.js';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  ManagedSessionStoreHttpError,
  ManagedSessionStoreTransportError,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { LlmRequestPreparationError } from '@qwen-code/qwen-code-core/core/llm-chat.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import {
  HostedToolRecoveryRequiredError,
  HostedWorkspaceToolTurn,
} from './hosted-workspace-tool-turn.js';
import * as stdio from '../utils/stdioHelpers.js';
import { isSlowTestHost } from '../test-utils/slow-test-host.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import { HostedContextCompression } from './hosted-context-compression.js';

// R1-2: the finished-before-commit hold reads its switch once at module scope,
// so a vi.stubEnv inside a case cannot arm it. Set the env before the static
// import evaluates that read, under a dedicated Session id. The hold only fires
// for the matching id, so every other Session in the file is unaffected.
const crashBeforeCommitArm = vi.hoisted(() => {
  const sessionId = '880e8400-e29b-41d4-a716-446655440004';
  process.env['QWEN_E2E_CRASH_BEFORE_ASSISTANT_COMMIT'] = sessionId;
  return { sessionId };
});

describe('Hosted Harness no-tool session', () => {
  useHostedTextSession();

  // Runs before the abort case below: the hold latch (crashBeforeCommitFired)
  // is module scope and never reset, so this case must execute while it is
  // still unset. Otherwise the spent latch, not the session-id comparison,
  // would suppress the hold and this case could not fail for its property.
  it('does not fire the finished-before-commit hold for a non-matching session', async () => {
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'no hold' }];
    const promptId = randomUUID();
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({ prompt, promptId, payloadDigest: digest })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    const events = (
      await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      })
    ).events;
    expect(
      events
        .filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === promptId,
        )
        .map((event) => event.payload['outcome']),
    ).toEqual(['completed']);
    expect(
      events.some(
        (event) =>
          event.kind === 'message.committed' &&
          event.payload['role'] === 'assistant',
      ),
    ).toBe(true);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  }, 60_000);

  // R1-2: the finished-before-commit hold must observe the Turn's abort signal.
  // Without the release/addEventListener wiring a leaked flag would park the
  // Session uncancellably; these cases drive a real turn into the hold and prove
  // the abort settles it cancelled with no assistant commit, and that a
  // non-matching Session never holds at all.
  it('settles the finished-before-commit hold cancelled on abort without an assistant commit', async () => {
    const sessionId = crashBeforeCommitArm.sessionId;
    const key = { tenantId: 'tenant', workspaceId: 'workspace', sessionId };
    const readJournal = () =>
      LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${sessionId}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'hold then cancel' }];
    const promptId = randomUUID();
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    try {
      await headers(supertest(server).post(`/session/${sessionId}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({ prompt, promptId, payloadDigest: digest })
        .expect(202);
      // The model resolves and the turn parks in the pre-assistant-commit hold.
      await vi.waitFor(
        () =>
          expect(
            stderr.mock.calls.some(([line]) =>
              String(line).includes(
                'E2E holding finished turn before assistant commit',
              ),
            ),
          ).toBe(true),
        { timeout: settleTimeoutMs() },
      );
      await headers(supertest(server).post(`/session/${sessionId}/cancel`))
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
      // The abort-driven release must settle the turn; if the hold never
      // releases this wait times out rather than passing trivially.
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${sessionId}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      const events = (await readJournal()).events;
      expect(
        events
          .filter(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === promptId,
          )
          .map((event) => event.payload['outcome']),
      ).toEqual(['cancelled']);
      expect(
        events.some(
          (event) =>
            event.kind === 'message.committed' &&
            event.payload['role'] === 'assistant',
        ),
      ).toBe(false);
    } finally {
      stderr.mockRestore();
      await Promise.race([
        headers(supertest(server).delete(`/session/${sessionId}`)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }, 60_000);

  it('refuses legacy teardown during compression even without a client id', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const busy = vi
      .spyOn(HostedContextCompression.prototype, 'busy', 'get')
      .mockReturnValue(true);
    try {
      const closed = await headers(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
      expect(closed.status).toBe(409);
      expect(closed.body.code).toBe('session_context_busy');
      const detached = await headers(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(detached.status).toBe(409);
      expect(detached.body.code).toBe('session_context_busy');
    } finally {
      busy.mockRestore();
    }
  });

  it('parks an admitted prompt when model request preparation fails', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
      })
      .expect(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', created.body.clientId as string);
    state.model.mockRejectedValueOnce(
      new LlmRequestPreparationError('snapshot durability failed'),
    );
    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .send({ prompt, promptId: PROMPT_ID, payloadDigest })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).expect(200);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: true,
        });
      },
      // #14101: the parked chain crosses fsync-backed journal commits; the
      // default 1s waitFor window flaked on a loaded ubuntu-latest runner.
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
      journal.events.filter((event) => event.kind === 'input.accepted'),
    ).toHaveLength(1);
    expect(journal.events.some((event) => event.kind === 'turn.settled')).toBe(
      false,
    );
    expect(state.model).toHaveBeenCalledTimes(1);
    await authorize(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
  });

  // R1-4: a rejected consume commit is isolated behind the turn's durable
  // settlement — the turn still completes, the Session never blocks, and
  // the refusal only logs; the owed id survives for a later flush.
  it('settles a completed turn even when its consume flush rejects', async () => {
    domainEnablement.childRun = true;
    mockBrokerBroker();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    const childRunId = `${PROMPT_ID}:call-1`;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const callRequest = {
        name: 'agent',
        callId: 'call-1',
        args: {
          description: 'audit the diff',
          prompt: 'review the change',
          run_in_background: false,
        },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await toolTurn!.execute(
        [callRequest],
        [
          {
            functionCall: {
              id: callRequest.callId,
              name: callRequest.name,
              args: callRequest.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      return { text: 'done', model: 'test-model' };
    });
    const consumptionFails = vi
      .spyOn(HostedChildAgentSession.prototype, 'markConsumed')
      .mockRejectedValueOnce(new Error('store lost the consume commit'));
    const operation = (body: Record<string, unknown>) =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/children/operations`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ operationId: randomUUID(), childRunId, ...body });
    const prompt = [{ type: 'text', text: 'run the audit' }];
    const posted = (async () =>
      headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        }))();
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
        expect(
          journal.events.some(
            (event) =>
              event.kind === 'domain.committed' &&
              event.payload['domain'] === 'child_run',
          ),
        ).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    await operation({
      kind: 'dispatch_started',
      dispatchId: 'dispatch-1',
      runtimeBindingId: 'binding-1',
      generation: '1',
    }).expect(202);
    await operation({
      kind: 'attach',
      childSessionId: '550e8400-e29b-41d4-a716-446655440001',
    }).expect(202);
    await operation({
      kind: 'commit_result',
      result: '审阅通过',
      receipt: '{}',
    }).expect(202);
    await operation({ kind: 'accept' }).expect(202);
    await posted;
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
        expect(consumptionFails).toHaveBeenCalled();
      },
      { timeout: 15_000, interval: 100 },
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
      journal.events.some(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === PROMPT_ID,
      ),
    ).toBe(true);
    expect(consumptionFails).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).toContain('consumption faltered');
    log.mockRestore();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
  }, 60_000);

  it('distinguishes strict create and load outcomes', async () => {
    const server = await app();
    const missing = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(missing.status).toBe(404);

    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const closed = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
    const exists = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(exists.status).toBe(409);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('passes the broker-provisioned writer credential and insecure opt-in to the store', async () => {
    const server = await app();
    state.storeOptions.length = 0;
    const writerToken = `qwt1_${'a'.repeat(43)}`;
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: { ...store(), writerToken, allowInsecureHttp: true },
    });
    expect(created.status).toBe(200);
    expect(state.storeOptions.at(-1)).toMatchObject({
      baseUrl: store().baseUrl,
      writerId: BOOT_ID,
      leaseDurationMs: 60_000,
      writerToken,
      allowInsecureHttp: true,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('answers 400 when the store factory refuses the descriptor', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: {
        ...store(),
        baseUrl: 'http://rejected-store.test',
        // The bridge parser refuses cleartext off-loopback unless the
        // descriptor carries the opt-in; the factory refusal is what this
        // test drives to a 400.
        allowInsecureHttp: true,
      },
    });
    expect(created.status).toBe(400);
    expect(created.body.error).toBe('invalid_managed_session_store');
    expect(created.body.message).toContain('store factory refused');
  });

  it('answers 400 when the bridge parser refuses a cleartext off-loopback store', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: {
        ...store(),
        baseUrl: 'http://rejected-store.test',
      },
    });
    // The bridge parser's own refusal fires before the store factory runs.
    expect(created.status).toBe(400);
    expect(created.body.error).toBe('invalid_managed_session_store');
    expect(created.body.message).toContain(
      'must use HTTPS outside the loopback interface',
    );
  });

  it('answers 400 with the reason when the descriptor itself is rejected', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: { ...store(), writerToken: 'short' },
    });
    expect(created.status).toBe(400);
    expect(created.body.error).toBe('invalid_managed_session_store');
    expect(created.body.message).toContain('writerToken is invalid');
  });

  it('allows only one concurrent attachment for a session ID', async () => {
    const server = await app();
    const create = () =>
      headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
      });
    const results = await Promise.all([create(), create()]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('keeps the caller session ID, commits a text turn, and refuses duplicate inference', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    expect(created.body.sessionId).toBe(SESSION_ID);
    expect(created.body.lastEventId).toBeGreaterThan(0);

    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const send = () =>
      headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    const admitted = await send();
    expect(admitted.status).toBe(202);
    expect(admitted.body.promptId).toBe(PROMPT_ID);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(state.model).toHaveBeenCalledTimes(1);

    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', created.body.clientId as string);
    expect(transcript.status).toBe(200);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'session_update',
          promptId: PROMPT_ID,
        }),
        expect.objectContaining({ type: 'turn_complete', promptId: PROMPT_ID }),
      ]),
    );
    expect(
      (transcript.body.events as Array<{ id: number }>).map(
        (event) => event.id,
      ),
    ).toEqual(
      (transcript.body.events as Array<{ id: number }>).map(
        (_, index) => index + 1,
      ),
    );
    const listener = server;
    const address = listener.address();
    expect(address && typeof address !== 'string').toBe(true);
    const controller = new AbortController();
    try {
      const stream = await fetch(
        `http://127.0.0.1:${(address as { port: number }).port}/session/${SESSION_ID}/events`,
        {
          headers: {
            'X-Qwen-Harness-Protocol-Version': '1',
            'X-Qwen-Harness-Boot-Id': BOOT_ID,
            'X-Qwen-Client-Id': created.body.clientId as string,
            'X-Qwen-Event-Epoch': admitted.body.eventEpoch as string,
            'Last-Event-ID': String(admitted.body.lastEventId),
          },
          signal: controller.signal,
        },
      );
      expect(stream.status).toBe(200);
      expect(stream.headers.get('x-qwen-event-epoch')).toBe(
        admitted.body.eventEpoch,
      );
      const reader = stream.body!.getReader();
      let frames = '';
      while (!frames.includes('event: turn_complete')) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        frames += new TextDecoder().decode(chunk.value);
      }
      const ids = [...frames.matchAll(/^id: (\d+)$/gm)].map((match) =>
        Number(match[1]),
      );
      expect(ids).toEqual(
        ids.map((_, index) => Number(admitted.body.lastEventId) + index + 1),
      );
      expect(frames).toContain('event: session_update');
      expect(frames).toContain(`"promptId":"${PROMPT_ID}"`);
    } finally {
      controller.abort();
      listener.closeAllConnections();
    }
    const repeated = await send();
    expect(repeated.status).toBe(202);
    expect(repeated.body.lastEventId).toBe(admitted.body.lastEventId);
    expect(state.model).toHaveBeenCalledTimes(1);

    const title = await headers(
      supertest(server).post(`/session/${SESSION_ID}/title`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ title: 'Hosted test' });
    expect(title.status).toBe(200);
    expect(title.body.persisted).toBe(true);

    const closed = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
    const gone = await headers(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', created.body.clientId as string);
    expect(gone.status).toBe(404);
  });

  it.each([false, true])(
    'completes a long answer (streamed: %s) under the real inline bound',
    async (streamed) => {
      // Past the limit the durable message record commits as chunks; the turn
      // used to fail after the whole answer had already streamed (#13326).
      const text = '长😀'.repeat(25_000);
      state.model.mockImplementationOnce(async ({ textDeltas }) => {
        if (streamed) {
          expect(textDeltas).toBeDefined();
          await textDeltas!.delta(text);
        }
        return { text, model: 'test-model' };
      });
      await enforceInlineResourceLimit();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      const server = await app(streamed);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        ...(streamed ? { toolProfile: 'hosted-workspace-files/1' } : {}),
      });
      expect(created.status).toBe(200);
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      const admitted = await headers(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({ prompt, promptId: PROMPT_ID, payloadDigest });
      expect(admitted.status).toBe(202);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', created.body.clientId as string);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: isSlowTestHost() ? 30_000 : 10_000 },
      );
      const transcript = await headers(
        supertest(server).get(`/session/${SESSION_ID}/transcript?limit=256`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'turn_complete',
            promptId: PROMPT_ID,
          }),
        ]),
      );
      expect(
        (transcript.body.events as Array<Record<string, unknown>>).filter(
          (event) => event['type'] === 'turn_error',
        ),
      ).toEqual([]);
      if (streamed) {
        expectFullStreamedAnswer(transcript.body, text);
        await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
          .set('X-Qwen-Client-Id', created.body.clientId as string)
          .expect(204);
        const reloaded = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
        });
        expect(reloaded.status).toBe(200);
        const cold = await headers(
          supertest(server).get(`/session/${SESSION_ID}/transcript?limit=256`),
        ).set('X-Qwen-Client-Id', reloaded.body.clientId as string);
        expectFullStreamedAnswer(cold.body, text);
      } else {
        const answer = transcript.body.events.find(
          (event: {
            type: string;
            data?: { update?: { content?: { text?: string } } };
          }) => event.type === 'session_update',
        );
        expect(answer?.data?.update?.content?.text).toBe(text);
      }
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    },
  );

  it('replays a settled prompt admission from the journal after a reload', async () => {
    // After a load, session.admissions is empty, so the idempotent retry is
    // answered from the journal's input.accepted watermark. That watermark
    // is the accepted sequence N — the first admission answered N+1 because
    // the in-memory path replies after committing wake.requested — and the
    // replay must answer exactly N: answering the live committedSequence
    // would skip past events the destination has not seen, and refusing
    // would loop the coordinator forever (D4's withdraw-and-resubmit).
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(admitted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      // Settlement includes fsync-backed writes and can exceed 1s on busy CI.
      { timeout: settleTimeoutMs() },
    );
    expect(state.model).toHaveBeenCalledTimes(1);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);

    const replayed = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(replayed.status).toBe(202);
    expect(replayed.body.lastEventId).toBe(admitted.body.lastEventId - 1);

    // A replay is only one replays: a different body under the accepted
    // Id is a conflict, not a watermark (R9-1) — the model gets called
    // for nothing, and the destination cannot silently stream the
    // previous Turn's events as this request's answer.
    const offered = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        prompt: [{ type: 'text', text: 'different' }],
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256')
          .update(JSON.stringify([{ type: 'text', text: 'different' }]))
          .digest('hex')}`,
      });
    expect(offered.status).toBe(409);
    expect(offered.body.code).toBe('hosted_prompt_conflict');
    const status = await headers(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(status.body.hasActivePrompt).toBe(false);
    expect(state.model).toHaveBeenCalledTimes(1);
  });

  it('refuses the replay retriably when the admission identity cannot be read', async () => {
    // The replay's async writer runs detached: a failed admission read
    // must still answer — retriably, since the replay can never be
    // certified — or the request hangs on an unhandled rejection (R9-1's
    // deferred aftermath).
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      // Settlement includes fsync-backed writes and can exceed 1s on busy CI.
      { timeout: settleTimeoutMs() },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const read = LocalManagedSessionResourceStore.prototype.read;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'read',
    ).mockImplementation(async function (
      this: LocalManagedSessionResourceStore,
      reference,
    ) {
      if (reference.kind === 'managed-admission')
        throw new Error('admission read unavailable');
      return read.call(this, reference);
    });
    const replayed = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(replayed.status).toBe(409);
    expect(replayed.body.code).toBe('hosted_prompt_recovery_required');
    expect(state.model).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported prompt content before model or tool execution', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'image', data: 'forbidden' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const rejected = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(rejected.status).toBe(400);
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
  });

  it('rejects prompts whose durable user record would exceed the store limit', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const prompt = [{ type: 'text', text: 'x'.repeat(65_300) }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const rejected = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(rejected.status).toBe(413);
    expect(state.model).not.toHaveBeenCalled();
    const status = await headers(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', created.body.clientId as string);
    expect(status.body.recoveryBlocked).toBe(false);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
  });

  it('ends an event stream when its attachment closes', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const listener = server;
    try {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const stream = await fetch(
        `http://127.0.0.1:${address.port}/session/${SESSION_ID}/events`,
        {
          headers: {
            'X-Qwen-Harness-Protocol-Version': '1',
            'X-Qwen-Harness-Boot-Id': BOOT_ID,
            'X-Qwen-Client-Id': created.body.clientId as string,
          },
          signal: AbortSignal.timeout(3_000),
        },
      );
      expect(stream.status).toBe(200);
      const closed = await headers(
        supertest(server).delete(`/session/${SESSION_ID}`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(closed.status).toBe(204);
      const reader = stream.body!.getReader();
      let done = false;
      while (!done) ({ done } = await reader.read());
      expect(done).toBe(true);
    } finally {
      listener.closeAllConnections();
    }
  });

  it('counts hosted event streams in the shared occupancy and refuses at the cap', async () => {
    const server = await app(
      false,
      undefined,
      true,
      undefined,
      resolveSseAdmissionCaps({ maxConnections: 10, maxSseConnections: 1 }),
    );
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const url = `http://127.0.0.1:${address.port}/session/${SESSION_ID}/events`;
    const streamHeaders = {
      'X-Qwen-Harness-Protocol-Version': '1',
      'X-Qwen-Harness-Boot-Id': BOOT_ID,
      'X-Qwen-Client-Id': created.body.clientId as string,
    };
    const before = getSseOccupancy();
    const controller = new AbortController();
    try {
      const first = await fetch(url, {
        headers: streamHeaders,
        signal: controller.signal,
      });
      expect(first.status).toBe(200);
      await vi.waitFor(
        () => {
          expect(getSseOccupancy().bySurface.hostedEvents).toBe(
            before.bySurface.hostedEvents + 1,
          );
        },
        { timeout: 5_000 },
      );
      const second = await fetch(url, {
        headers: streamHeaders,
        signal: controller.signal,
      });
      expect(second.status).toBe(503);
      expect(second.headers.get('retry-after')).toBe('5');
      expect(await second.json()).toEqual({
        error:
          'Daemon SSE connection limit reached (1/1). ' +
          'Retry after the Retry-After interval.',
        code: 'sse_connection_limit_exceeded',
        limit: 1,
        active: 1,
        scope: 'daemon',
      });
    } finally {
      controller.abort();
      server.closeAllConnections();
    }
    await vi.waitFor(
      () => {
        expect(getSseOccupancy().total).toBe(before.total);
      },
      { timeout: 5_000 },
    );
  });

  it('stops writing an event stream after backpressure ends it', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    await vi.waitFor(
      async () => {
        const transcript = await headers(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events.length).toBeGreaterThan(2);
      },
      { timeout: settleTimeoutMs() },
    );

    const originalWrite = ServerResponse.prototype.write;
    let frames = 0;
    let ends = 0;
    const write = vi
      .spyOn(ServerResponse.prototype, 'write')
      .mockImplementation(function (
        this: ServerResponse,
        ...args: Parameters<ServerResponse['write']>
      ) {
        if (typeof args[0] === 'string' && args[0].startsWith('id: ')) {
          frames++;
          originalWrite.apply(this, args);
          return false;
        }
        return originalWrite.apply(this, args);
      });
    const end = vi
      .spyOn(ServerResponse.prototype, 'end')
      .mockImplementation(function (this: ServerResponse) {
        ends++;
        return this;
      });
    const listener = server;
    const abort = new AbortController();
    try {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const stream = await fetch(
        `http://127.0.0.1:${address.port}/session/${SESSION_ID}/events`,
        {
          headers: {
            'X-Qwen-Harness-Protocol-Version': '1',
            'X-Qwen-Harness-Boot-Id': BOOT_ID,
            'X-Qwen-Client-Id': clientId,
          },
          signal: abort.signal,
        },
      );
      expect(stream.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(frames).toBe(1);
      expect(ends).toBe(1);
    } finally {
      write.mockRestore();
      end.mockRestore();
      abort.abort();
      listener.closeAllConnections();
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
    }
  });

  it('clears the keepalive timer when backpressure stops the stream', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    await vi.waitFor(async () => {
      const transcript = await headers(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(transcript.body.events.length).toBeGreaterThan(2);
    });

    // Record every interval the route arms so the assertion can name the
    // keepalive one (15s) rather than the pump one (250ms). The end() spy
    // is a no-op so the response stays open and no 'close' event fires —
    // the leak shape from the finding: stop() is the only teardown that
    // runs, so it must clear both timers.
    const armed: Array<{ handle: unknown; timeout: number | undefined }> = [];
    const originalSetInterval = globalThis.setInterval;
    const intervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(function (
        this: unknown,
        ...args: Parameters<typeof setInterval>
      ) {
        const handle = originalSetInterval.apply(this, args);
        armed.push({ handle, timeout: args[1] });
        return handle;
      } as typeof setInterval);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const originalWrite = ServerResponse.prototype.write;
    const write = vi
      .spyOn(ServerResponse.prototype, 'write')
      .mockImplementation(function (
        this: ServerResponse,
        ...args: Parameters<ServerResponse['write']>
      ) {
        if (typeof args[0] === 'string' && args[0].startsWith('id: ')) {
          originalWrite.apply(this, args);
          return false;
        }
        return originalWrite.apply(this, args);
      });
    const end = vi
      .spyOn(ServerResponse.prototype, 'end')
      .mockImplementation(function (this: ServerResponse) {
        return this;
      });
    const listener = server;
    const abort = new AbortController();
    try {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const stream = await fetch(
        `http://127.0.0.1:${address.port}/session/${SESSION_ID}/events`,
        {
          headers: {
            'X-Qwen-Harness-Protocol-Version': '1',
            'X-Qwen-Harness-Boot-Id': BOOT_ID,
            'X-Qwen-Client-Id': clientId,
          },
          signal: abort.signal,
        },
      );
      expect(stream.status).toBe(200);
      expect(stream.headers.get('x-accel-buffering')).toBe('no');
      await vi.waitFor(() => {
        expect(end).toHaveBeenCalledTimes(1);
      });
      const keepalive = armed.filter((entry) => entry.timeout === 15_000);
      expect(keepalive).toHaveLength(1);
      expect(clearSpy.mock.calls.flat()).toContain(keepalive[0]!.handle);
    } finally {
      write.mockRestore();
      end.mockRestore();
      intervalSpy.mockRestore();
      clearSpy.mockRestore();
      abort.abort();
      listener.closeAllConnections();
      // Settle the turn this test started before tearing down: while
      // session.active is set the DELETE below answers 409
      // hosted_turn_active and cannot close the session, so a late
      // resource write from the still-draining turn would race
      // afterEach's recursive rm of the scratch tree. The poll runs only
      // after end() is restored — while the spy swallows it, a status
      // response could never complete.
      const settleDeadline = Date.now() + 10_000;
      for (;;) {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        if (status.body.hasActivePrompt === false) break;
        if (Date.now() > settleDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
    }
  });

  it('persists a safe model API failure across cold transcript replay', async () => {
    const { HostedModelApiError } = await import('./hosted-harness-model.js');
    state.model.mockRejectedValueOnce(
      new HostedModelApiError({
        status: 402,
        message: 'Insufficient Balance token=private-provider-secret',
      }),
    );
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    const expectFailure = async (
      target: Awaited<ReturnType<typeof app>>,
      clientId: string,
    ) => {
      const transcript = await headers(
        supertest(target).get(`/session/${SESSION_ID}/transcript`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(transcript.status).toBe(200);
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'turn_error',
            data: expect.objectContaining({
              code: 'model_payment_required',
              message:
                'Model API payment required (HTTP 402). Check the provider account balance and billing before retrying.',
            }),
          }),
        ]),
      );
      expect(JSON.stringify(transcript.body)).not.toContain(
        'private-provider-secret',
      );
    };
    await vi.waitFor(
      () => expectFailure(server, created.body.clientId as string),
      {
        timeout: settleTimeoutMs(),
      },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
    const restarted = await app();
    const loaded = await headers(
      supertest(restarted).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    await expectFailure(restarted, loaded.body.clientId as string);
    expect(state.model).toHaveBeenCalledOnce();
    await headers(supertest(restarted).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
  });

  it('logs the failure cause while keeping the public turn error generic', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    state.model.mockRejectedValueOnce(new Error('model initialization failed'));
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'hello' }];
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const transcript = await headers(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_error',
              promptId: PROMPT_ID,
              data: {
                sessionId: SESSION_ID,
                promptId: PROMPT_ID,
                code: 'hosted_turn_failed',
                message: 'Hosted Harness turn failed.',
              },
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    expect(log).toHaveBeenCalledWith(
      `qwen serve: Hosted Harness turn ${PROMPT_ID} failed: Error: model initialization failed`,
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it.each([
    ['managed-message', 'turn_error', 0],
    ['managed-turn-result', 'turn_complete', 1],
    ['runnable-check', 'turn_error', 0],
  ])(
    'settles a turn after one %s failure',
    async (failedKind, terminalType, modelCalls) => {
      const server = await app();
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
      });
      expect(created.status).toBe(200);
      let failed = false;
      if (failedKind === 'runnable-check') {
        const restore = LocalManagedSessionAuthority.prototype.restoreBundle;
        vi.spyOn(
          LocalManagedSessionAuthority.prototype,
          'restoreBundle',
        ).mockImplementation(function (this: LocalManagedSessionAuthority) {
          if (!failed) {
            failed = true;
            return Promise.reject(new Error('transient restore failure'));
          }
          return restore.call(this);
        });
      } else {
        const publish = LocalManagedSessionResourceStore.prototype.publish;
        vi.spyOn(
          LocalManagedSessionResourceStore.prototype,
          'publish',
        ).mockImplementation(function (
          this: LocalManagedSessionResourceStore,
          kind,
          bytes,
        ) {
          if (kind === failedKind && !failed) {
            failed = true;
            return Promise.reject(new Error('transient store failure'));
          }
          return publish.call(this, kind, bytes);
        });
      }
      const clientId = created.body.clientId as string;
      const prompt = [{ type: 'text', text: 'hello' }];
      const send = () =>
        headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .set('X-Qwen-Client-Id', clientId)
          .send({
            prompt,
            promptId: PROMPT_ID,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          });
      const admitted = await send();
      expect(admitted.status).toBe(202);
      // The default 1s waitFor timeout races the settlement retry's durable
      // writes on contended CI runners; the assertions are unchanged.
      await vi.waitFor(
        async () => {
          const transcript = await headers(
            supertest(server).get(`/session/${SESSION_ID}/transcript`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(transcript.body.events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: terminalType,
                promptId: PROMPT_ID,
              }),
            ]),
          );
        },
        { timeout: settleTimeoutMs() },
      );
      expect(failed).toBe(true);
      expect(state.model).toHaveBeenCalledTimes(modelCalls);
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(status.body.hasActivePrompt).toBe(false);
      expect(status.body.recoveryBlocked).toBe(false);
      const retried = await send();
      expect(retried.status).toBe(202);
      expect(retried.body).toEqual(admitted.body);
      expect(state.model).toHaveBeenCalledTimes(modelCalls);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(loaded.status).toBe(200);
      const nextPrompt = [{ type: 'text', text: 'next' }];
      const nextPromptId = '44444444-4444-4444-8444-444444444444';
      const next = await headers(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          prompt: nextPrompt,
          promptId: nextPromptId,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
        });
      expect(next.status).toBe(202);
      await vi.waitFor(
        async () => {
          const transcript = await headers(
            supertest(server).get(`/session/${SESSION_ID}/transcript`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
          expect(transcript.body.events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'turn_complete',
                promptId: nextPromptId,
              }),
            ]),
          );
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.model).toHaveBeenCalledTimes(modelCalls + 1);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    },
  );

  it('preserves a recovery failure when Shell cleanup also fails', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceToolTurn.prototype, 'close').mockRejectedValue(
      new Error('cleanup failed'),
    );
    state.model.mockRejectedValueOnce(
      new HostedToolRecoveryRequiredError(new Error('original result unknown')),
    );
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'run Shell' }];
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
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      transcript.body.events.filter(
        (event: { type: string }) => event.type === 'turn_error',
      ),
    ).toEqual([]);
  });

  it('answers a user cancel on a recovery-blocked Session whose Turn settled', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    // The Turn settles terminally and only the publisher cleanup fails, so
    // the Session latches recovery-blocked *with* a durable terminal record.
    vi.spyOn(HostedWorkspaceToolTurn.prototype, 'close').mockRejectedValue(
      new Error('cleanup failed'),
    );
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'run Shell' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    // A contended gate runner stalls this settle past the 1 s default
    // waitFor budget; the wait is healthy, its budget was sized for idle.
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
        }),
      ]),
    );
    // The client's cancel flow hard-requires the 204 before it streams that
    // record — a definitive refusal is reported as an unknown mutation
    // outcome and retried forever, while nothing remains here to abort.
    await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
  });

  it('blocks new prompts when terminal settlement keeps failing', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const publish = LocalManagedSessionResourceStore.prototype.publish;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    ).mockImplementation(function (
      this: LocalManagedSessionResourceStore,
      kind,
      bytes,
    ) {
      if (kind === 'managed-turn-result') {
        return Promise.reject(new Error('store down'));
      }
      return publish.call(this, kind, bytes);
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'hello' }];
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      transcript.body.events.filter(
        (event: { type: string }) =>
          event.type === 'turn_complete' || event.type === 'turn_error',
      ),
    ).toEqual([]);
    const nextPrompt = [{ type: 'text', text: 'next' }];
    const rejected = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: nextPrompt,
        promptId: '44444444-4444-4444-8444-444444444444',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      });
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe('hosted_turn_recovery_required');
    expect(rejected.body.reason).toBe('turn_blocked');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('refuses a bare load of a recovery-blocked Turn after detach', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '66666666-6666-4666-8666-666666666666',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockRejectedValue(
      new Error('broker gone'),
    );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'write_file',
        callId: 'call-1',
        args: { file_path: 'a', content: 'x' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await toolTurn!.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'test-model',
        signal,
      );
      await toolTurn!.consumeResults();
      return { text: 'done', model: 'test-model' };
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'hello' }];
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
      },
      { timeout: settleTimeoutMs() },
    );
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('file_history_unsettled');
    // The pending turn parked at await_runtime, so the refusal names its
    // blocking conjunct under the published gate tag, not only the gate.
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (file_history_pending): {"pendingTurn":"${PROMPT_ID}","pendingUndo":null,"unsettled":"${PROMPT_ID}","takeover":false,"ground":"phase_await_runtime","groundDetail":null}`,
    );
    log.mockRestore();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('settles a cancelled turn when writing its user record fails once', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const publish = LocalManagedSessionResourceStore.prototype.publish;
    let rejectWrite: ((reason?: unknown) => void) | undefined;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    ).mockImplementation(function (
      this: LocalManagedSessionResourceStore,
      kind,
      bytes,
    ) {
      if (kind === 'managed-message') {
        return new Promise<Awaited<ReturnType<typeof publish>>>(
          (_resolve, reject) => {
            rejectWrite = reject;
          },
        );
      }
      return publish.call(this, kind, bytes);
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'wait' }];
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(rejectWrite).toBeDefined());
    const cancelled = await headers(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(cancelled.status).toBe(204);
    rejectWrite?.(new Error('transient store failure'));
    await vi.waitFor(
      async () => {
        const transcript = await headers(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: PROMPT_ID,
              data: expect.objectContaining({ stopReason: 'cancelled' }),
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('reports an aborted live turn as cancelled after a Java-style cold reattach', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    state.model.mockImplementationOnce(
      ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new Error('cancelled')),
          );
        }),
    );
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'wait' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(1));
    const reattached = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      passiveManagedRuntimeRecovery: true,
      driveRuntimeRecovery: false,
      cancellationTakeover: true,
    });
    expect(reattached.status).toBe(200);
    expect(reattached.body.clientId).toBe(created.body.clientId);
    const cancelled = await headers(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', reattached.body.clientId as string);
    expect(cancelled.status).toBe(204);
    await vi.waitFor(
      async () => {
        const transcript = await headers(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: PROMPT_ID,
              data: expect.objectContaining({ stopReason: 'cancelled' }),
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    // The owed mount-handback chain stays alive for up to ~1 min and logs
    // a line per failed attempt; chains owned by other tests' blocked
    // turns legitimately appear here between tests. The settled cancelled
    // turn itself remains the only thing in scope: nothing else may log.
    expect(
      log.mock.calls.filter(
        (args) =>
          !String(args[0]).includes(
            'could not release the Workspace mount after its recovery block',
          ),
      ),
    ).toEqual([]);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('reports a deadline-exceeded turn as a classified failure, not a cancellation', async () => {
    vi.spyOn(stdio, 'writeStderrLineSafe').mockImplementation(() => {});
    let modelStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      modelStarted = resolve;
    });
    state.model.mockImplementationOnce(
      ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
          modelStarted();
        }),
    );
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'wait' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const admitted = await headers(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({ prompt, promptId: PROMPT_ID, payloadDigest, deadlineMs: 2000 });
      expect(admitted.status).toBe(202);
      await started;
      expect(state.model).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(
      async () => {
        const transcript = await headers(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_error',
              promptId: PROMPT_ID,
              data: expect.objectContaining({
                code: 'hosted_turn_deadline_exceeded',
              }),
            }),
          ]),
        );
        expect(
          (transcript.body.events as Array<{ type: string }>).some(
            (event) => event.type === 'turn_complete',
          ),
        ).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    const saved = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const settled = saved.events.find(
      (event) => event.kind === 'turn.settled',
    )!;
    expect(settled.payload['outcome']).toBe('error');
    expect(settled.payload['stopReason']).toBe('deadline_exceeded');
    // The settled Turn frees the Session for the next prompt.
    const followUp = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: randomUUID(), payloadDigest });
    expect(followUp.status).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('classifies a deadline expiry on the retried settlement path', async () => {
    vi.spyOn(stdio, 'writeStderrLineSafe').mockImplementation(() => {});
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const publish = LocalManagedSessionResourceStore.prototype.publish;
    let rejectWrite: ((reason?: unknown) => void) | undefined;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    ).mockImplementation(function (
      this: LocalManagedSessionResourceStore,
      kind,
      bytes,
    ) {
      if (kind === 'managed-message' && !rejectWrite) {
        return new Promise<Awaited<ReturnType<typeof publish>>>(
          (_resolve, reject) => {
            rejectWrite = reject;
          },
        );
      }
      return publish.call(this, kind, bytes);
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'wait' }];
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        deadlineMs: 2000,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(rejectWrite).toBeDefined());
    // Let the deadline fire while the user-record write is still hung, so
    // the turn fails before the model ran and the settlement retry path
    // (not the runner's own catch) classifies the abort.
    await new Promise((resolve) => setTimeout(resolve, 2250));
    rejectWrite?.(new Error('transient store failure'));
    await vi.waitFor(
      async () => {
        const transcript = await headers(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_error',
              promptId: PROMPT_ID,
              data: expect.objectContaining({
                code: 'hosted_turn_deadline_exceeded',
              }),
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    const saved = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const settled = saved.events.find(
      (event) => event.kind === 'turn.settled',
    )!;
    expect(settled.payload['outcome']).toBe('error');
    expect(settled.payload['stopReason']).toBe('deadline_exceeded');
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  // Each row carries the transcript code and the journal stopReason as
  // separate columns: an unnamed failure keeps settledTurnOutcome's generic
  // stopReason under the generic turn-failure code, so the two coincide
  // only on the named row (#13800 R2-8).
  it.each([
    // A transport failure is the outage #13800 names: the transcript code
    // and the journal stopReason both carry the store's name.
    [
      'a Session store transport failure',
      () => new ManagedSessionStoreTransportError('store flap'),
      'managed_session_store_unavailable',
      'managed_session_store_unavailable',
    ],
    // A bounded tenant-guard wait: the store answered promptly with a
    // retryable contention refusal, so it was never unavailable.
    [
      'a contended tenant guard',
      () =>
        new ManagedSessionStoreHttpError(503, 'tenant_guard_contended', 'held'),
      'hosted_turn_failed',
      'error',
    ],
    // A per-Session refusal keeps its own name, never the outage's.
    [
      'a writer conflict',
      () =>
        new ManagedSessionStoreHttpError(
          409,
          'managed_session_writer_conflict',
          'another writer holds the lease',
        ),
      'hosted_turn_failed',
      'error',
    ],
  ])('classifies a store failure: %s', async (_, failure, code, stopReason) => {
    vi.spyOn(stdio, 'writeStderrLineSafe').mockImplementation(() => {});
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const publish = LocalManagedSessionResourceStore.prototype.publish;
    let rejectWrite: ((reason?: unknown) => void) | undefined;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    ).mockImplementation(function (
      this: LocalManagedSessionResourceStore,
      kind,
      bytes,
    ) {
      if (kind === 'managed-message' && !rejectWrite) {
        return new Promise<Awaited<ReturnType<typeof publish>>>(
          (_resolve, reject) => {
            rejectWrite = reject;
          },
        );
      }
      return publish.call(this, kind, bytes);
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'wait' }];
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(rejectWrite).toBeDefined());
    rejectWrite?.(failure());
    await vi.waitFor(
      async () => {
        const transcript = await headers(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_error',
              promptId: PROMPT_ID,
              data: expect.objectContaining({ code }),
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    const saved = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const settled = saved.events.find(
      (event) => event.kind === 'turn.settled',
    )!;
    expect(settled.payload['outcome']).toBe('error');
    expect(settled.payload['stopReason']).toBe(stopReason);
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });
});
