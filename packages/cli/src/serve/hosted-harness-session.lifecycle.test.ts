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
  expectFullStreamedAnswer,
  headers,
  hookApp,
  hookPin,
  mcpApp,
  neverStartedReconcile,
  settleTimeoutMs,
  state,
  store,
  useHostedTextSession,
} from './hosted-harness-session.test-helper.js';
import {
  AUTOMATION_ID,
  automationDefinition,
  fireBody,
} from './hosted-harness-session-wake.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  LocalJsonlManagedSessionJournalHandle,
  LocalJsonlManagedSessionJournalStore,
} from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { ManagedSessionStoreHttpError } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { type ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { HostedHookSession } from './hosted-hook-session.js';
import { HostedMcpSession } from './hosted-mcp-session.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import type {
  ManagedHookCatalog,
  ManagedHookControl,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import { HostedChildRunSession } from './hosted-child-run-session.js';

describe('Hosted Harness no-tool session', () => {
  useHostedTextSession();

  it('re-answers a drive takeover while the resident model turn is active', async () => {
    let releaseModel!: () => void;
    let markFirstChunk!: () => void;
    const modelHeld = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const firstChunk = new Promise<void>((resolve) => {
      markFirstChunk = resolve;
    });
    const text = 'COORDINATOR_RECOVERED';
    state.model.mockImplementationOnce(async ({ textDeltas }) => {
      await textDeltas!.delta('COORDINATOR_');
      markFirstChunk();
      await modelHeld;
      await textDeltas!.delta('RECOVERED');
      return { text, model: 'test-model' };
    });

    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'COORDINATOR_ONLY' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await firstChunk;

    const load = () =>
      headers(supertest(server).post(`/session/${SESSION_ID}/load`)).send({
        managedSessionStore: store(),
        driveRuntimeRecovery: true,
      });
    const takeover = await load();
    expect(takeover.status).toBe(200);
    expect(takeover.body.clientId).toBe(created.body.clientId);
    const redriven = await load();
    expect(redriven.status).toBe(200);
    expect(redriven.body).toMatchObject({
      clientId: takeover.body.clientId,
      eventEpoch: takeover.body.eventEpoch,
      lastEventId: takeover.body.lastEventId,
    });
    expect(state.model).toHaveBeenCalledTimes(1);

    releaseModel();
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript?limit=256`),
    ).set('X-Qwen-Client-Id', created.body.clientId as string);
    expectFullStreamedAnswer(transcript.body, text);
    expect(
      transcript.body.events.filter((event: { type: string }) =>
        ['turn_complete', 'turn_error'].includes(event.type),
      ),
    ).toHaveLength(1);
    expect(state.model).toHaveBeenCalledTimes(1);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
  });

  it.each(['close', 'delete'] as const)(
    'settles %s lifecycle Hooks once and retains the attachment until detach',
    async (kind) => {
      const { server, authorize, requests, release } = await hookApp();
      const operation = {
        kind,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
        authority: { operationId: 'op-l3', claimGeneration: 1 },
      };
      const first = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
      ).send(operation);
      expect(first.status).toBe(200);
      expect(
        first.body.effects.map((effect: { event: string }) => effect.event),
      ).toEqual(
        kind === 'close' ? ['SessionEnd'] : ['SessionEnd', 'SessionDelete'],
      );
      expect(release).not.toHaveBeenCalled();
      const retry = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
      ).send({
        ...operation,
        authority: { ...operation.authority, claimGeneration: 2 },
      });
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(first.body);
      expect(
        requests
          .filter((request) => request.kind === 'hook-execute')
          .map((request) => request.input.hook_event_name),
      ).toEqual(
        kind === 'close' ? ['SessionEnd'] : ['SessionEnd', 'SessionDelete'],
      );
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({})
        .expect(409);
      await authorize(supertest(server).post(`/session/${SESSION_ID}/cancel`))
        .send({})
        .expect(409);
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({ authority: { operationId: 'op-l3', claimGeneration: 2 } })
        .expect(204);
      expect(release).toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'authorizes detach after the coordinator recovers effects without a Harness lifecycle request (clientId=%s)',
    async (withClientId) => {
      const { server, authorize, requests } = await hookApp();
      const transcriptPath = path.join(state.root, `${SESSION_ID}.jsonl`);
      const transcript = await readFile(transcriptPath, 'utf8');
      const releaseActivation = vi
        .spyOn(LocalManagedSessionAuthority.prototype, 'releaseActivation')
        .mockRejectedValue(new Error('journal appends are fenced'));
      state.authorizeOrdinary.mockRejectedValue(
        new ManagedSessionStoreHttpError(
          409,
          'managed_session_lifecycle_active',
          'DRAINING',
        ),
      );
      const authority = {
        operationId: 'recovered-effects',
        claimGeneration: 2,
      };
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({})
        .expect(404);
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', 'wrong-client')
        .send({ authority })
        .expect(404);
      expect(state.authorizeLifecycle).not.toHaveBeenCalled();
      await (withClientId ? authorize : headers)(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      )
        .send({ authority })
        .expect(204);
      expect(state.setLifecycleAuthority).toHaveBeenLastCalledWith(authority);
      expect(state.authorizeLifecycle).toHaveBeenCalledExactlyOnceWith();
      expect(state.authorizeOrdinary).not.toHaveBeenCalled();
      expect(releaseActivation).not.toHaveBeenCalled();
      expect(await readFile(transcriptPath, 'utf8')).toBe(transcript);
      expect(requests).toEqual([]);
      expect(state.model).not.toHaveBeenCalled();
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({})
        .expect(404);
    },
  );

  it.each(['close', 'delete'] as const)(
    'adopts the original idle attachment for %s without reopening or replaying Hooks',
    async (kind) => {
      const { server, authorize, definition, requests, clientId } =
        await hookApp();
      const descriptorCount = state.storeOptions.length;
      const transcriptPath = path.join(state.root, `${SESSION_ID}.jsonl`);
      const transcript = await readFile(transcriptPath, 'utf8');
      state.assertWritable.mockClear();
      const authority = { operationId: 'adopt-original', claimGeneration: 1 };
      const load = () =>
        headers(supertest(server).post(`/session/${SESSION_ID}/load`)).send({
          ...definition,
          lifecycleAuthority: authority,
        });
      const adopted = await load();
      expect(adopted.status).toBe(200);
      expect(adopted.body.clientId).toBe(clientId);
      expect(state.storeOptions).toHaveLength(descriptorCount);
      expect(state.assertWritable).toHaveBeenCalledTimes(1);
      expect(await readFile(transcriptPath, 'utf8')).toBe(transcript);
      expect(requests).toEqual([]);
      const operation = {
        kind,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
        authority,
      };
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
      )
        .send(operation)
        .expect(200);
      expect((await load()).body.clientId).toBe(adopted.body.clientId);
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
      )
        .send(operation)
        .expect(200);
      expect(
        requests
          .filter((request) => request.kind === 'hook-execute')
          .map((request) => request.input.hook_event_name),
      ).toEqual(
        kind === 'close' ? ['SessionEnd'] : ['SessionEnd', 'SessionDelete'],
      );
      for (const route of ['prompt', 'cancel']) {
        await headers(
          supertest(server).post(`/session/${SESSION_ID}/${route}`),
        ).expect(404);
        await headers(supertest(server).post(`/session/${SESSION_ID}/${route}`))
          .set('X-Qwen-Client-Id', randomUUID())
          .expect(404);
        await authorize(
          supertest(server).post(`/session/${SESSION_ID}/${route}`),
        ).expect(409);
      }
      await headers(supertest(server).delete(`/session/${SESSION_ID}`))
        .set('X-Qwen-Client-Id', randomUUID())
        .expect(404);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
        409,
      );
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({ authority })
        .expect(204);
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it('runs the never-started reconcile for a fresh Session open', async () => {
    neverStartedReconcile.fn.mockClear();
    await hookApp();
    expect(neverStartedReconcile.fn).toHaveBeenCalledTimes(1);
    expect(neverStartedReconcile.fn).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: expect.anything(),
        resources: expect.anything(),
        childRuns: expect.any(HostedChildRunSession),
        brokerOptions: expect.anything(),
      }),
    );
  });

  it('holds the fresh Session open until the never-started reconcile completes', async () => {
    neverStartedReconcile.fn.mockClear();
    let release!: () => void;
    neverStartedReconcile.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened = false;
    const pending = hookApp().then((app) => {
      opened = true;
      return app;
    });
    try {
      await vi.waitFor(
        () => expect(neverStartedReconcile.fn).toHaveBeenCalledTimes(1),
        { timeout: settleTimeoutMs() },
      );
      expect(opened).toBe(false);
    } finally {
      release();
    }
    await pending;
    expect(opened).toBe(true);
  });

  it.each([
    { tenantId: 'foreign' },
    { workspaceId: 'foreign' },
    { writerToken: 'f'.repeat(40) },
    { baseUrl: 'https://foreign-store.test' },
    { writerId: randomUUID() },
  ])(
    'refuses lifecycle adoption with a different original grant: %s',
    async (changed) => {
      const { server, authorize, definition, requests } = await hookApp();
      state.assertWritable.mockClear();
      await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
        .send({
          ...definition,
          managedSessionStore: { ...store(), ...changed },
          lifecycleAuthority: { operationId: 'adopt', claimGeneration: 1 },
        })
        .expect(409);
      expect(state.assertWritable).not.toHaveBeenCalled();
      expect(state.setLifecycleAuthority).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({})
        .expect(204);
    },
  );

  it('restores original authority after refused adoption and guards concurrent claims', async () => {
    const { server, authorize, definition, requests } = await hookApp();
    const load = (operationId: string) =>
      headers(supertest(server).post(`/session/${SESSION_ID}/load`)).send({
        ...definition,
        lifecycleAuthority: { operationId, claimGeneration: 1 },
      });
    state.assertWritable.mockRejectedValueOnce(new Error('claim refused'));
    expect((await load('stale')).status).toBe(503);
    expect(state.setLifecycleAuthority).toHaveBeenLastCalledWith(undefined);
    let release!: () => void;
    state.assertWritable.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    const pending = load('current').then((response) => response);
    await vi.waitFor(() => expect(release).toBeDefined());
    try {
      expect((await load('competing')).status).toBe(409);
      expect(requests).toEqual([]);
    } finally {
      release();
    }
    expect((await pending).status).toBe(200);
    expect((await load('other-operation')).status).toBe(409);
    await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
      .send(definition)
      .expect(409);
    await headers(supertest(server).post('/session'))
      .send({
        ...definition,
        lifecycleAuthority: { operationId: 'create', claimGeneration: 1 },
      })
      .expect(400);
    await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({ authority: { operationId: 'current', claimGeneration: 1 } })
      .expect(204);
  });

  it.each(['prompt', 'title', 'hooks/operations'])(
    'refuses a late ordinary %s preflight after lifecycle adoption',
    async (route) => {
      const { server, authorize, definition, requests } = await hookApp();
      const transcriptPath = path.join(state.root, `${SESSION_ID}.jsonl`);
      const before = await readFile(transcriptPath, 'utf8');
      let release!: () => void;
      state.authorizeOrdinary.mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            release = () => resolve(undefined);
          }),
      );
      const prompt = [{ type: 'text', text: 'late request' }];
      const pending = authorize(
        supertest(server).post(`/session/${SESSION_ID}/${route}`),
      )
        .send(
          route === 'title'
            ? { title: 'late title' }
            : route === 'hooks/operations'
              ? {
                  operationId: 'ea17a7bc-b8d6-4f42-9e82-3859309fe92a',
                  event: 'Notification',
                  input: { message: 'late', notification_type: 'test' },
                }
              : {
                  prompt,
                  promptId: PROMPT_ID,
                  payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
                },
        )
        .then((response) => response);
      await vi.waitFor(() => expect(release).toBeDefined());
      try {
        await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
          .send({
            ...definition,
            lifecycleAuthority: { operationId: 'adopt', claimGeneration: 1 },
          })
          .expect(200);
      } finally {
        release();
      }
      const refused = await pending;
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_lifecycle_operation_active');
      expect(requests).toEqual([]);
      expect(state.model).not.toHaveBeenCalled();
      expect(await readFile(transcriptPath, 'utf8')).toBe(before);
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({ authority: { operationId: 'adopt', claimGeneration: 1 } })
        .expect(204);
    },
  );

  it.each([true, false])(
    'retains the attachment and restores authority when a recovered detach claim is rejected (clientId=%s)',
    async (withClientId) => {
      const { server, authorize, requests } = await hookApp();
      state.authorizeOrdinary.mockRejectedValue(
        new ManagedSessionStoreHttpError(
          409,
          'managed_session_lifecycle_active',
          'DRAINING',
        ),
      );
      state.authorizeLifecycle.mockRejectedValueOnce(new Error('stale claim'));
      await (withClientId ? authorize : headers)(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      )
        .send({ authority: { operationId: 'stale', claimGeneration: 1 } })
        .expect(503);
      expect(state.setLifecycleAuthority).toHaveBeenLastCalledWith(undefined);
      expect(requests).toEqual([]);
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({})
        .expect(409);
      await (withClientId ? authorize : headers)(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      )
        .send({ authority: { operationId: 'valid', claimGeneration: 2 } })
        .expect(204);
      expect(state.authorizeLifecycle).toHaveBeenCalledTimes(2);
      expect(requests).toEqual([]);
    },
  );

  it.each([true, false])(
    'rejects malformed detach authority without bypassing a persistent fence (clientId=%s)',
    async (withClientId) => {
      const { server, authorize, requests } = await hookApp();
      state.authorizeOrdinary.mockRejectedValue(
        new ManagedSessionStoreHttpError(
          409,
          'managed_session_lifecycle_active',
          'DRAINING',
        ),
      );
      await (withClientId ? authorize : headers)(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      )
        .send({ authority: { operationId: 'malformed', claimGeneration: 0 } })
        .expect(400);
      expect(state.authorizeLifecycle).not.toHaveBeenCalled();
      expect(state.setLifecycleAuthority).not.toHaveBeenCalled();
      await (withClientId ? authorize : headers)(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      )
        .send({ authority: { operationId: 'valid', claimGeneration: 2 } })
        .expect(204);
      expect(requests).toEqual([]);
    },
  );

  it.each(['title', 'prompt'] as const)(
    'checks attachment identity before ordinary Store authorization for %s',
    async (route) => {
      const { server, authorize } = await hookApp();
      state.authorizeOrdinary.mockClear();
      for (const clientId of [undefined, 'wrong-client']) {
        const request = headers(
          supertest(server).post(`/session/${SESSION_ID}/${route}`),
        );
        if (clientId) request.set('X-Qwen-Client-Id', clientId);
        const rejected = await request.send({ title: 'renamed' });
        expect(rejected.status).toBe(404);
        expect(rejected.body.code).toBe('hosted_session_not_found');
        expect(state.authorizeOrdinary).not.toHaveBeenCalled();
      }
      await authorize(supertest(server).post(`/session/${SESSION_ID}/title`))
        .send({ title: 'renamed' })
        .expect(200);
      expect(state.authorizeOrdinary).toHaveBeenCalledOnce();
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({})
        .expect(204);
    },
  );

  it('uses the legacy close admission for an attached protocol zero Session with Hooks', async () => {
    const { server, authorize, requests } = await hookApp();
    state.authorizeOrdinary.mockImplementation(async (kind) => {
      if (kind !== 'legacy-close')
        throw new ManagedSessionStoreHttpError(
          409,
          'managed_session_lifecycle_active',
          'Ordinary admission closed',
        );
    });
    await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .send({})
      .expect(409);
    await authorize(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
    expect(state.authorizeOrdinary).toHaveBeenLastCalledWith('legacy-close');
    expect(
      requests
        .filter((request) => request.kind === 'hook-execute')
        .map((request) => request.input.hook_event_name),
    ).toEqual(['SessionEnd', 'SessionDelete']);
  });

  it.each([
    ['prompt', new TypeError('network timeout')],
    ['detach', new TypeError('network timeout')],
    [
      'prompt',
      new ManagedSessionStoreHttpError(
        503,
        'internal_error',
        'Store unavailable',
      ),
    ],
    [
      'detach',
      new ManagedSessionStoreHttpError(
        503,
        'internal_error',
        'Store unavailable',
      ),
    ],
    [
      'prompt',
      new ManagedSessionStoreHttpError(
        409,
        'managed_session_writer_conflict',
        'Writer fenced',
      ),
    ],
    [
      'detach',
      new ManagedSessionStoreHttpError(
        409,
        'managed_session_writer_conflict',
        'Writer fenced',
      ),
    ],
  ])(
    'reports an ordinary %s authorization failure as unavailable: %s',
    async (route, cause) => {
      const { server, authorize, requests } = await hookApp();
      state.authorizeOrdinary.mockRejectedValueOnce(cause);
      const rejected = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/${route}`),
      ).send({});
      expect(rejected.status).toBe(503);
      expect(rejected.body.code).toBe(
        'hosted_execution_authorization_unavailable',
      );
      expect(state.model).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({})
        .expect(204);
    },
  );

  it.each(['prompt', 'detach'])(
    'maps a fenced v2 claim to the lifecycle conflict for ordinary %s',
    async (route) => {
      const { server, authorize, requests } = await hookApp();
      state.authorizeOrdinary.mockRejectedValueOnce(
        new ManagedSessionStoreHttpError(
          409,
          'workspace_lifecycle_claim_fenced',
          'Close in flight',
        ),
      );
      const refused = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/${route}`),
      ).send({});
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_lifecycle_operation_active');
      expect(state.model).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({})
        .expect(204);
    },
  );

  it('aborts an active Turn and returns 503 when durable cancellation fails', async () => {
    const { server, authorize } = await hookApp();
    let signal!: AbortSignal;
    let finish!: () => void;
    state.model.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          signal = input.signal;
          finish = () => resolve({ text: '', model: 'test-model' });
        }),
    );
    const prompt = [
      { type: 'text', text: 'cancel while Store is unavailable' },
    ];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .send({ prompt, promptId: PROMPT_ID, payloadDigest })
      .expect(202);
    await vi.waitFor(
      () => expect(state.model).toHaveBeenCalledOnce(),
      // #14101: the admission crosses fsync-backed journal commits before
      // the model call; the default 1s waitFor window flaked on a loaded
      // CI runner (#13219).
      { timeout: settleTimeoutMs() },
    );
    const original =
      LocalManagedSessionAuthority.prototype.appendExecutionEvent;
    const append = vi
      .spyOn(LocalManagedSessionAuthority.prototype, 'appendExecutionEvent')
      .mockImplementation(function (
        this: LocalManagedSessionAuthority,
        ...args
      ) {
        if (args[0].operation === 'requestCancel')
          return Promise.reject(new Error('Store unavailable'));
        return Reflect.apply(original, this, args);
      });
    try {
      const response = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/cancel`),
      );
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('hosted_cancel_commit_failed');
      expect(signal.aborted).toBe(true);
    } finally {
      append.mockRestore();
      finish();
    }
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
      },
      // #14101: the cancelled turn's settle crosses fsync-backed journal
      // commits before the active flag clears; the default 1s waitFor
      // window flaked on a loaded CI runner (#13219).
      { timeout: settleTimeoutMs() },
    );
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    ).expect(204);
  });

  it.each([
    new TypeError('network timeout'),
    new ManagedSessionStoreHttpError(
      503,
      'internal_error',
      'Store unavailable',
    ),
    new ManagedSessionStoreHttpError(
      409,
      'managed_session_writer_conflict',
      'Writer fenced',
    ),
  ])(
    'cancels an active Turn despite ordinary authorization failure: %s',
    async (cause) => {
      const { server, authorize } = await hookApp();
      let signal!: AbortSignal;
      let finish!: () => void;
      state.model.mockImplementationOnce(
        (input) =>
          new Promise((resolve) => {
            signal = input.signal;
            finish = () => resolve({ text: '', model: 'test-model' });
            signal.addEventListener('abort', finish, { once: true });
          }),
      );
      const prompt = [{ type: 'text', text: 'wait for cancellation' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await vi.waitFor(
        () => expect(state.model).toHaveBeenCalledTimes(1),
        // #14101: the admission crosses fsync-backed journal commits before
        // the model call; the default 1s waitFor window flaked on a loaded
        // CI runner (#13219).
        { timeout: settleTimeoutMs() },
      );
      state.authorizeOrdinary.mockClear();
      state.authorizeOrdinary.mockRejectedValue(cause);
      try {
        await headers(
          supertest(server).post(`/session/${SESSION_ID}/cancel`),
        ).expect(404);
        expect(signal.aborted).toBe(false);
        await authorize(
          supertest(server).post(`/session/${SESSION_ID}/cancel`),
        ).expect(204);
        expect(signal.aborted).toBe(true);
        expect(state.authorizeOrdinary).not.toHaveBeenCalled();
      } finally {
        finish();
      }
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
        },
        // #14101: the cancelled turn's settle crosses fsync-backed journal
        // commits before the active flag clears; the default 1s waitFor
        // window flaked on a loaded CI runner (#13219).
        { timeout: settleTimeoutMs() },
      );
      state.authorizeOrdinary.mockResolvedValue(undefined);
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it.each(['close', 'delete'] as const)(
    'v2 Shell %s settles Hooks once before resource phases',
    async (kind) => {
      const { server, authorize, requests, release } = await hookApp(
        'hosted-workspace-shell/1',
      );
      const initialHook = randomUUID();
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
      )
        .send({
          operationId: initialHook,
          event: 'Notification',
          input: { message: 'ready', notification_type: 'test' },
        })
        .expect(200);
      await vi.waitFor(async () => {
        const result = await authorize(
          supertest(server).get(
            `/session/${SESSION_ID}/hooks/operations/${initialHook}`,
          ),
        );
        expect(result.body.state).toBe('settled');
      });
      requests.length = 0;
      const operation = {
        protocolVersion: 2,
        phase: 'effects',
        kind,
        toolProfile: 'hosted-workspace-shell/1',
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
        authority: { operationId: `v2-${kind}`, claimGeneration: 1 },
      };
      for (const claimGeneration of [1, 2]) {
        await authorize(
          supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
        )
          .send({
            ...operation,
            authority: { ...operation.authority, claimGeneration },
          })
          .expect(200);
      }
      expect(
        requests
          .filter((request) => request.kind === 'hook-execute')
          .map((request) => request.input.hook_event_name),
      ).toEqual(
        kind === 'close' ? ['SessionEnd'] : ['SessionEnd', 'SessionDelete'],
      );
      expect(release).not.toHaveBeenCalled();
      for (const phase of ['prepare_resources', 'settle_resources']) {
        await authorize(
          supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
        )
          .send({
            ...operation,
            phase,
            authority: { ...operation.authority, claimGeneration: 2 },
          })
          .expect(200);
      }
      expect(release).toHaveBeenCalledExactlyOnceWith({ drain: true });
      expect(state.model).not.toHaveBeenCalled();
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({ authority: { ...operation.authority, claimGeneration: 2 } })
        .expect(204);
    },
  );

  it.each([
    'workspace_lifecycle_claim_fenced',
    'workspace_close_identity_unverified',
  ])('preserves %s during v2 resource preparation', async (code) => {
    const { server, authorize } = await hookApp('hosted-workspace-shell/1');
    state.assertWritable.mockRejectedValueOnce(
      new ManagedSessionStoreHttpError(409, code, 'Cleanup rejected'),
    );
    const refused = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
    ).send({
      protocolVersion: 2,
      phase: 'prepare_resources',
      kind: 'close',
      toolProfile: 'hosted-workspace-shell/1',
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
      authority: { operationId: 'fenced-v2-shell', claimGeneration: 1 },
    });
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe(code);
    expect(state.model).not.toHaveBeenCalled();
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    ).expect(204);
  });

  it('cold-loads a v2 Shell cleanup claim without SessionStart or new execution', async () => {
    const { server, authorize, definition, requests } = await hookApp(
      'hosted-workspace-shell/1',
    );
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
    )
      .send({
        operationId: randomUUID(),
        event: 'Notification',
        input: { message: 'ready', notification_type: 'test' },
      })
      .expect(200);
    const operation = {
      protocolVersion: 2,
      phase: 'effects',
      kind: 'close',
      toolProfile: 'hosted-workspace-shell/1',
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
      authority: { operationId: 'cold-v2-shell', claimGeneration: 1 },
    };
    await authorize(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
      .send(operation)
      .expect(200);
    await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({ authority: operation.authority })
      .expect(204);
    requests.length = 0;
    vi.mocked(HostedWorkspaceBroker.prototype.warm).mockClear();
    const authority = { ...operation.authority, claimGeneration: 2 };
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        ...definition,
        lifecycleProtocolVersion: 2,
        lifecycleAuthority: authority,
      })
      .expect(200);
    const cleanup = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId);
    for (const phase of ['prepare_resources', 'settle_resources']) {
      await cleanup(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
        .send({ ...operation, phase, authority })
        .expect(200);
    }
    expect(requests).toHaveLength(0);
    expect(HostedWorkspaceBroker.prototype.warm).not.toHaveBeenCalled();
    expect(state.model).not.toHaveBeenCalled();
    await cleanup(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({ authority })
      .expect(204);
  });

  it('v2 MCP effects retain the owner until resources settle', async () => {
    const closeResources = vi.spyOn(
      HostedMcpSession.prototype,
      'closeResources',
    );
    const { server, authorize, requests } = await mcpApp();
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
    )
      .send({
        operationId: randomUUID(),
        serverId: 'demo',
        request: { kind: 'resource_read', uri: 'memory://note' },
      })
      .expect(202);
    const operation = {
      protocolVersion: 2,
      phase: 'effects',
      kind: 'close',
      toolProfile: 'hosted-workspace-mcp/1',
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
      authority: { operationId: 'v2-mcp', claimGeneration: 1 },
    };
    await authorize(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
      .send(operation)
      .expect(200);
    expect(
      requests.filter((request) => request.kind === 'mcp-release'),
    ).toHaveLength(0);
    // The terminal release happens in settle_resources, the last phase; a
    // reload of a closing Session carries a lifecycle authority, which sets
    // mcpClosing, so no acquire follows it.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockReturnValue(
      'v2-close-claim',
    );
    const releaseMount = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'releaseMount')
      .mockResolvedValue();
    for (const phase of ['prepare_resources', 'settle_resources']) {
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
      )
        .send({ ...operation, phase })
        .expect(200);
    }
    expect(
      requests.filter((request) => request.kind === 'mcp-release'),
    ).toHaveLength(1);
    // The MCP session's own owner is the one released, and every row it
    // configured ends released, as the release fault gates require.
    const mcp = closeResources.mock.contexts[0] as HostedMcpSession;
    expect(
      vi.mocked(HostedWorkspaceBroker.prototype.release).mock.contexts,
    ).toContain(mcp.broker);
    expect(releaseMount).not.toHaveBeenCalled();
    const releaseStates = () =>
      (Reflect.get(mcp, 'session') as ManagedSession).authority
        .extensionRecordsInDomain('mcp_configuration')
        .map(
          (entry) => (entry.record as { releaseState?: string }).releaseState,
        );
    expect(releaseStates()).not.toHaveLength(0);
    expect(releaseStates()).toEqual(releaseStates().map(() => 'released'));
    // A retried settle_resources, as after a lost answer, finds every row
    // released: it dispatches no second release and acquires nothing.
    const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
    acquire.mockClear();
    await authorize(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
      .send({ ...operation, phase: 'settle_resources' })
      .expect(200);
    expect(
      requests.filter((request) => request.kind === 'mcp-release'),
    ).toHaveLength(1);
    expect(acquire).not.toHaveBeenCalled();
    expect(releaseStates()).toEqual(releaseStates().map(() => 'released'));
    expect(state.model).not.toHaveBeenCalled();
    await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({ authority: operation.authority })
      .expect(204);
  });

  it('releases the Hook owner it shares with MCP on a v2 close', async () => {
    // With both an MCP server and a Hook catalog the Hook session borrows the
    // MCP broker, so the MCP release on a close releases the owner the
    // SessionEnd Hook ran on as well.
    const catalog: ManagedHookCatalog = {
      ...hookPin,
      hooks: [HookEventName.SessionEnd, HookEventName.SessionDelete].map(
        (eventName) => ({
          hookId: eventName,
          eventName,
          sequential: false,
          async: false,
          failClosed: true,
          onceKey: null,
          config: { type: 'command' as const },
        }),
      ),
    };
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'authorizeLifecycle',
    ).mockResolvedValue();
    const hookRequests: ManagedHookControl[] = [];
    vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl').mockImplementation(
      async (operation) => {
        hookRequests.push(operation);
        if (operation.kind === 'hook-catalog')
          return {
            operationId: operation.operationId,
            state: 'settled',
            catalog: { ...catalog, ...operation.pin },
          };
        return {
          operationId: operation.operationId,
          state: 'settled',
          result: { success: true, outcome: 'success', duration: 0 },
        };
      },
    );
    const closeResources = vi.spyOn(
      HostedMcpSession.prototype,
      'closeResources',
    );
    const hookClose = vi.spyOn(HostedHookSession.prototype, 'close');
    const { server, authorize, requests } = await mcpApp(
      false,
      ['demo'],
      'hosted-workspace-mcp/1',
      { hookCatalog: hookPin, approvalMode: 'yolo' },
    );
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
    )
      .send({
        operationId: randomUUID(),
        serverId: 'demo',
        request: { kind: 'resource_read', uri: 'memory://note' },
      })
      .expect(202);
    const operation = {
      protocolVersion: 2,
      kind: 'close',
      toolProfile: 'hosted-workspace-mcp/1',
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
      authority: { operationId: 'v2-shared', claimGeneration: 1 },
    };
    vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockReturnValue(
      'v2-close-claim',
    );
    const releaseMount = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'releaseMount')
      .mockResolvedValue();
    for (const phase of ['effects', 'prepare_resources', 'settle_resources']) {
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
      )
        .send({ ...operation, phase })
        .expect(200);
    }
    expect(
      hookRequests.filter((request) => request.kind === 'hook-execute'),
    ).not.toHaveLength(0);
    const mcp = closeResources.mock.contexts[0] as HostedMcpSession;
    const hooks = hookClose.mock.contexts[0] as HostedHookSession;
    expect(hooks.broker).toBe(mcp.broker);
    expect(
      requests.filter((request) => request.kind === 'mcp-release'),
    ).toHaveLength(1);
    expect(
      vi.mocked(HostedWorkspaceBroker.prototype.release).mock.contexts,
    ).toContain(mcp.broker);
    expect(releaseMount).not.toHaveBeenCalled();
    const releaseStates = (
      Reflect.get(mcp, 'session') as ManagedSession
    ).authority
      .extensionRecordsInDomain('mcp_configuration')
      .map((entry) => (entry.record as { releaseState?: string }).releaseState);
    expect(releaseStates).not.toHaveLength(0);
    expect(releaseStates).toEqual(releaseStates.map(() => 'released'));
    await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({ authority: operation.authority })
      .expect(204);
  });

  it('resumes the undispatched Delete Hook after revocation without cancelling or repeating End', async () => {
    const { server, authorize, requests } = await hookApp();
    let permitted = true;
    const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
    const original = control.getMockImplementation()!;
    control.mockImplementation(async (request) => {
      const result = await original(request);
      if (request.kind === 'hook-execute') permitted = false;
      return result;
    });
    vi.mocked(
      HostedWorkspaceBroker.prototype.authorizeLifecycle,
    ).mockImplementation(async () => {
      if (!permitted) throw new Error('ACL revoked');
    });
    const operation = {
      kind: 'delete',
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
      authority: { operationId: 'op-revoked', claimGeneration: 1 },
    };
    const first = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
    ).send(operation);
    expect(first.status).toBe(503);
    expect(
      requests
        .filter((request) => request.kind === 'hook-execute')
        .map((request) => request.input.hook_event_name),
    ).toEqual(['SessionEnd']);
    vi.mocked(
      HostedWorkspaceBroker.prototype.authorizeLifecycle,
    ).mockResolvedValue();
    const retry = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
    ).send({
      ...operation,
      authority: { ...operation.authority, claimGeneration: 2 },
    });
    expect(retry.status).toBe(200);
    expect(
      requests
        .filter((request) => request.kind === 'hook-execute')
        .map((request) => request.input.hook_event_name),
    ).toEqual(['SessionEnd', 'SessionDelete']);
    expect(
      requests.filter((request) => request.kind === 'hook-cancel'),
    ).toHaveLength(0);
    await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({ authority: { operationId: 'op-revoked', claimGeneration: 2 } })
      .expect(204);
  });

  it('waits for an async End child to settle before dispatching Delete', async () => {
    const { server, authorize, requests } = await hookApp(
      'hosted-workspace-files/1',
      true,
    );
    const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
    const original = control.getMockImplementation()!;
    let endSettled = false;
    control.mockImplementation(async (request) => {
      if (
        !endSettled &&
        (request.kind === 'hook-status' ||
          (request.kind === 'hook-execute' &&
            request.input.hook_event_name === HookEventName.SessionEnd))
      ) {
        requests.push(request);
        return { operationId: request.operationId, state: 'running' };
      }
      return original(request);
    });
    const operation = {
      kind: 'delete',
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
      authority: { operationId: 'async-end', claimGeneration: 1 },
    };
    try {
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
      )
        .send(operation)
        .expect(503);
      expect(
        requests
          .filter((request) => request.kind === 'hook-execute')
          .map((request) => request.input.hook_event_name),
      ).toEqual(['SessionEnd']);
    } finally {
      endSettled = true;
    }
    await authorize(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
      .send({
        ...operation,
        authority: { operationId: 'async-end', claimGeneration: 2 },
      })
      .expect(200);
    expect(
      requests
        .filter((request) => request.kind === 'hook-execute')
        .map((request) => request.input.hook_event_name),
    ).toEqual(['SessionEnd', 'SessionDelete']);
    expect(
      requests.filter((request) => request.kind === 'hook-cancel'),
    ).toEqual([]);
    await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({ authority: { operationId: 'async-end', claimGeneration: 2 } })
      .expect(204);
  });

  it('allows the valid operation after an invalid lifecycle claim is rejected', async () => {
    const { server, authorize, requests } = await hookApp();
    state.authorizeLifecycle.mockRejectedValueOnce(new Error('stale claim'));
    const operation = {
      kind: 'close',
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
      authority: { operationId: 'invalid', claimGeneration: 1 },
    };
    await authorize(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
      .send(operation)
      .expect(503);
    expect(requests).toHaveLength(0);
    await authorize(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
      .send({
        ...operation,
        kind: 'delete',
        authority: { operationId: 'valid', claimGeneration: 2 },
      })
      .expect(200);
    expect(
      requests
        .filter((request) => request.kind === 'hook-execute')
        .map((request) => request.input.hook_event_name),
    ).toEqual(['SessionEnd', 'SessionDelete']);
    await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({ authority: { operationId: 'valid', claimGeneration: 2 } })
      .expect(204);
  });

  it('keeps an unknown End blocked without cancelling or redispatching it on takeover', async () => {
    const { server, authorize, requests } = await hookApp();
    const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
    const original = control.getMockImplementation()!;
    control.mockImplementation(async (request) => {
      if (request.kind === 'hook-catalog') return original(request);
      requests.push(request);
      return { operationId: request.operationId, state: 'outcome_unknown' };
    });
    const operation = {
      kind: 'delete',
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
      authority: { operationId: 'unknown-delete', claimGeneration: 1 },
    };
    await authorize(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
      .send(operation)
      .expect(503);
    await authorize(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
      .send({
        ...operation,
        authority: { ...operation.authority, claimGeneration: 2 },
      })
      .expect(503);
    expect(
      requests
        .filter((request) => request.kind === 'hook-execute')
        .map((request) => request.input.hook_event_name),
    ).toEqual(['SessionEnd']);
    expect(
      requests.filter((request) => request.kind === 'hook-cancel'),
    ).toHaveLength(0);
    expect(state.model).not.toHaveBeenCalled();
    control.mockImplementation(original);
    await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({
        authority: { operationId: 'unknown-delete', claimGeneration: 2 },
      })
      .expect(204);
  });

  it('refuses a new prompt while the journal close is still sealing', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = LocalJsonlManagedSessionJournalHandle.prototype.seal;
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'seal',
    ).mockImplementation(async function (
      this: LocalJsonlManagedSessionJournalHandle,
      commit,
    ) {
      entered();
      await gate;
      await original.call(this, commit);
    });
    const closing = headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).then((response) => response);
    await started;
    try {
      const prompt = [{ type: 'text', text: 'late input' }];
      const rejected = await headers(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        });
      expect(rejected.status).toBe(409);
      expect(rejected.body.code).toBe('hosted_session_closing');
      expect(state.model).not.toHaveBeenCalled();
    } finally {
      release();
    }
    expect((await closing).status).toBe(204);
  });

  it.each([false, true])(
    'retains a completed gate release failure while the pool drains (retry: %s)',
    async (retry) => {
      const server = await app(true, 'pod-gate');
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      const acquire = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
        .mockResolvedValue();
      const prepare = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'prepareReplayable')
        .mockResolvedValue({
          executionCallId: 'gate-execution',
          settled: {
            executionStatus: 'success',
            responseParts: [{ text: '{"kind":"quiet","durationMs":3}' }],
          },
        });
      const release = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'release')
        .mockRejectedValue(
          new HostedWorkspaceBrokerRejection(503, 'runtime_unavailable', {
            message: 'fixture release refused',
          }),
        );
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        toolProfile: 'hosted-workspace-shell/1',
        managedSessionStore: { ...store(), writerToken: 'a'.repeat(32) },
        harnessPlacement: {
          instanceId: 'pod-gate',
          bootId: BOOT_ID,
          placementEpoch: 1,
        },
      });
      expect(created.status).toBe(200);
      const authorized = (request: supertest.Test) =>
        headers(request).set(
          'X-Qwen-Client-Id',
          created.body.clientId as string,
        );
      const operations = (body: Record<string, unknown>) =>
        authorized(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...body });
      const snapshot = () =>
        headers(supertest(server).get('/internal/hosted-harness/v1/instance'));
      try {
        expect(
          (
            await operations({
              kind: 'define_schedule',
              scheduleId: AUTOMATION_ID,
              definition: { ...automationDefinition, gate: 'printf gate' },
            })
          ).status,
        ).toBe(202);
        const before = await snapshot();
        const fired = await operations(fireBody());
        expect(fired.status).toBe(503);
        expect(fired.body.code).toBe('automation_operation_failed');
        expect(release).toHaveBeenCalledTimes(1);
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(acquire).not.toHaveBeenCalled();
        expect(state.model).not.toHaveBeenCalled();
        if (retry) {
          release.mockResolvedValue();
          const retried = await operations(fireBody());
          expect(retried.status).toBe(202);
          expect(retried.body.gate.outcome).toBe('quiet');
        }
        await vi.waitFor(
          async () => {
            const ended = await snapshot();
            expect(ended.body.counters.inFlightMutations).toBe(0);
            expect(ended.body.counters.openingSessions).toBe(0);
          },
          { timeout: settleTimeoutMs() },
        );
        const drained = await headers(
          supertest(server).post('/internal/hosted-harness/v1/instance:drain'),
        ).send({ operationId: randomUUID(), expectedBootId: BOOT_ID });
        expect(drained.status).toBe(202);
        await vi.waitFor(
          async () => {
            const after = await snapshot();
            const observation = {
              before: before.body,
              fire: { status: fired.status, body: fired.body },
              drain: { status: drained.status, body: drained.body },
              after: after.body,
              ownershipReleases: state.ownershipReleases,
            };
            expect(observation).toMatchObject({
              after: {
                state: retry ? 'DRAINED' : 'QUIESCING',
                counters: {
                  inFlightMutations: 0,
                  attachedSessions: retry ? 0 : 1,
                  heldResources: retry ? 0 : 1,
                },
              },
              ownershipReleases: retry ? [{ placementEpoch: 1 }] : [],
            });
          },
          { timeout: settleTimeoutMs() },
        );
      } finally {
        release.mockResolvedValue();
        await authorized(supertest(server).delete(`/session/${SESSION_ID}`));
      }
    },
  );

  it('keeps interrupted initialization unresolved after quiesce instead of claiming DRAINED', async () => {
    const server = await app(false, 'pod-a');
    let entered!: () => void;
    let unblock!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const original = LocalManagedSessionResourceStore.prototype.read;
    let held = false;
    const read = vi
      .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
      .mockImplementation(async function (
        this: LocalManagedSessionResourceStore,
        ref,
      ) {
        if (ref.kind === 'managed-definition' && !held) {
          held = true;
          entered();
          await gate;
        }
        return original.call(this, ref);
      });
    const opening = headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: { ...store(), writerToken: 'a'.repeat(32) },
        harnessPlacement: {
          instanceId: 'pod-a',
          bootId: BOOT_ID,
          placementEpoch: 1,
        },
      })
      .then((response) => response);
    try {
      await started;
      const draining = await headers(
        supertest(server).post('/internal/hosted-harness/v1/instance:drain'),
      ).send({ operationId: randomUUID(), expectedBootId: BOOT_ID });
      expect(draining.body.state).toBe('QUIESCING');
      expect(draining.body.counters.openingSessions).toBeGreaterThan(0);
      unblock();
      expect((await opening).body.code).toBe('hosted_harness_quiescing');
      const unresolved = await headers(
        supertest(server).get('/internal/hosted-harness/v1/instance'),
      );
      expect(unresolved.body.state).toBe('QUIESCING');
      expect(unresolved.body.counters.openingSessions).toBe(1);
      expect(state.ownershipReleases).toHaveLength(0);
      expect(state.model).not.toHaveBeenCalled();
    } finally {
      unblock();
      await opening;
      read.mockRestore();
    }
  });

  it('quiesces after the running Turn and releases without starting or cancelling queued wake input', async () => {
    const server = await app(false, 'pod-a');
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: { ...store(), writerToken: 'a'.repeat(32) },
      harnessPlacement: {
        instanceId: 'pod-a',
        bootId: BOOT_ID,
        placementEpoch: 1,
      },
    });
    expect(created.status).toBe(200);
    const authorized = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', created.body.clientId as string);
    const operations = (body: Record<string, unknown>) =>
      authorized(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      ).send({ operationId: randomUUID(), ...body });
    expect(
      (
        await operations({
          kind: 'define_schedule',
          scheduleId: AUTOMATION_ID,
          definition: automationDefinition,
        })
      ).status,
    ).toBe(202);
    let finish!: () => void;
    state.model.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { text: 'finished original Turn', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'foreground before drain' }];
    const body = {
      promptId: PROMPT_ID,
      prompt,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
    };
    const submit = (payload: Record<string, unknown>) =>
      authorized(supertest(server).post(`/session/${SESSION_ID}/prompt`)).send(
        payload,
      );
    expect((await submit(body)).status).toBe(202);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const fired = await operations(fireBody());
    expect(fired.status).toBe(202);
    try {
      const drained = await headers(
        supertest(server).post('/internal/hosted-harness/v1/instance:drain'),
      ).send({ operationId: randomUUID(), expectedBootId: BOOT_ID });
      expect(drained.body.state).toBe('QUIESCING');
      expect((await submit(body)).status).toBe(202);
      expect(
        (await submit({ ...body, promptId: randomUUID() })).body.code,
      ).toBe('hosted_harness_quiescing');
      expect(state.ownershipReleases).toHaveLength(0);
      finish();
      await vi.waitFor(
        async () => {
          const instance = await headers(
            supertest(server).get('/internal/hosted-harness/v1/instance'),
          );
          expect(instance.body.state).toBe('DRAINED');
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.model).toHaveBeenCalledTimes(1);
      expect(state.ownershipReleases).toHaveLength(1);
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
        journal.events.filter(
          (event) =>
            event.kind === 'input.accepted' &&
            event.payload['turnId'] === fired.body.inputId,
        ),
      ).toHaveLength(1);
      expect(
        journal.events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === fired.body.inputId,
        ),
      ).toHaveLength(0);
      expect(
        journal.events.filter((event) => event.kind === 'lifecycle.changed'),
      ).toHaveLength(0);
    } finally {
      finish?.();
    }
  });
});
