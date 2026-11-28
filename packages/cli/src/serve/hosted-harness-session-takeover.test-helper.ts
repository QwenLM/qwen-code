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
  listeners,
  settleTimeoutMs,
  state,
  store,
} from './hosted-harness-session.test-helper.js';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, expect, vi, type MockInstance } from 'vitest';
import { resetManagedRuntimeDispatchGatesForTest } from '@qwen-code/qwen-code-core/managed-runtime/managed-runtime-dispatch-gate.js';
import {
  createHostedHarnessContract,
  installHostedHarnessContractMiddleware,
} from './hosted-harness-contract.js';
import { registerHostedHarnessSessionRoutes } from './hosted-harness-session.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';

function useRuntimeTakeover() {
  beforeEach(async () => {
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'workspaceContext',
    ).mockResolvedValue([]);
    resetManagedRuntimeDispatchGatesForTest();
    state.root = await mkdtemp(path.join(tmpdir(), 'hosted-harness-test-'));
    state.model.mockReset();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'fileHistory').mockResolvedValue({
      ownerSessionId: SESSION_ID,
      snapshots: [],
      files: {},
    });
    state.model.mockImplementation(async () => ({
      text: 'hello back',
      model: 'test-model',
    }));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(state.root, {
      recursive: true,
      force: true,
      // A wake pump's final writes can still be in flight at teardown.
      maxRetries: 5,
      retryDelay: 100,
    });
  });
}

const BOOT_ID_2 = '77777777-7777-4777-8777-777777777777';

/** Captured per parked turn so tests can assert which loads acquire the
 * Runtime lease: a cold load never does, a passive takeover adopts it. */
let acquireSpy: MockInstance<HostedWorkspaceBroker['acquire']>;

async function replacementApp(
  instanceId?: string,
  suspensionOptions?: {
    idleSuspendMs?: number;
    suspendRetryBaseMs?: number;
    suspendRetryCap?: number;
    coldOpenLimit?: number;
  },
) {
  const result = express();
  result.use(express.json());
  const contract = createHostedHarnessContract(
    `sha256:${'a'.repeat(64)}`,
    BOOT_ID_2,
    undefined,
    instanceId,
  );
  installHostedHarnessContractMiddleware(result, contract);
  const registration = registerHostedHarnessSessionRoutes(
    result,
    contract,
    state.root,
    {
      baseUrl: 'http://127.0.0.1:1',
      token: 'test',
    },
    suspensionOptions,
  );
  const listener = createServer(result);
  (
    listener as Server & { harnessRegistration?: typeof registration }
  ).harnessRegistration = registration;
  listeners.add(listener);
  await new Promise<void>((resolve) =>
    listener.listen(0, '127.0.0.1', resolve),
  );
  return listener;
}

function replacementHeaders<T extends supertest.Test>(request: T): T {
  return request
    .set('X-Qwen-Harness-Protocol-Version', '1')
    .set('X-Qwen-Harness-Boot-Id', BOOT_ID_2);
}

function storeFor(writerId: string) {
  return { ...store(), writerId };
}

const FILE_PROFILE = 'hosted-workspace-files/1';

const CALL = {
  name: 'write_file',
  callId: 'call-1',
  args: { file_path: 'a.txt', content: 'x' },
  isClientInitiated: false,
  prompt_id: PROMPT_ID,
};

/**
 * Drives a Workspace turn to its parked await_runtime checkpoint: the Broker
 * execute hangs until the owner is "crashed" via cancel, leaving the turn
 * unsettled in the journal. With `runtimeBinding`, warm() returns the
 * Runtime binding production supplies, so the parked owner commits a real
 * hosted.cleanup obligation.
 */
async function parkToolTurn(
  retainOwnerOrCalls: boolean | Array<typeof CALL> = false,
  toolProfile = FILE_PROFILE,
  runtimeBinding = false,
  brokerFailure?: Error,
) {
  // Callers pass either a retainOwner flag or the parked call list.
  const retainOwner = retainOwnerOrCalls === true;
  const calls = Array.isArray(retainOwnerOrCalls) ? retainOwnerOrCalls : [CALL];
  vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockImplementation(
    async function (this: HostedWorkspaceBroker) {
      if (runtimeBinding)
        this.runtime = {
          bindingId: 'binding',
          generation: '1',
          workspaceGeneration: '1',
        };
    },
  );
  spyOnAcquire().mockImplementation(async function (
    this: HostedWorkspaceBroker,
  ) {
    if (toolProfile === 'hosted-workspace-mcp/1')
      this.runtime = {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      };
  });
  if (calls.length === 1) {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '66666666-6666-4666-8666-666666666666',
    );
  } else {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare')
      .mockResolvedValueOnce('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      .mockResolvedValue('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  }
  vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
  const execute = vi
    .spyOn(HostedWorkspaceBroker.prototype, 'execute')
    .mockImplementation((_id, _payload, signal) =>
      signal?.aborted
        ? Promise.reject(new Error('aborted'))
        : new Promise((_, reject) =>
            signal?.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            ),
          ),
    );
  if (brokerFailure) execute.mockRejectedValueOnce(brokerFailure);
  const server = await app(true);
  const created = await headers(supertest(server).post('/session')).send({
    sessionId: SESSION_ID,
    sessionScope: 'thread',
    managedSessionStore: store(),
    toolProfile,
    ...(toolProfile === 'hosted-workspace-mcp/1'
      ? {
          mcpServers: [
            {
              serverId: 'demo',
              serverRevision: 1,
              definitionDigest: 'a'.repeat(64),
            },
          ],
        }
      : {}),
  });
  expect(created.status).toBe(200);
  state.model.mockImplementationOnce(
    async ({ toolTurn, signal }) =>
      toolTurn!.execute(
        calls,
        calls.map((call) => ({
          functionCall: {
            id: call.callId,
            name: call.name,
            args: call.args,
          },
        })),
        'test-model',
        signal,
      ) as never,
  );
  const prompt = [{ type: 'text', text: 'write a.txt' }];
  const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
  const admitted = await headers(
    supertest(server).post(`/session/${SESSION_ID}/prompt`),
  )
    .set('X-Qwen-Client-Id', created.body.clientId as string)
    .send({ prompt, promptId: PROMPT_ID, payloadDigest });
  expect(admitted.status).toBe(202);
  await vi.waitFor(() => expect(execute).toHaveBeenCalled(), {
    timeout: settleTimeoutMs(),
  });
  if (!brokerFailure)
    await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
  await vi.waitFor(
    async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(status.body.hasActivePrompt).toBe(false);
      expect(status.body.recoveryBlocked).toBe(true);
    },
    { timeout: settleTimeoutMs() },
  );
  if (!retainOwner) {
    const closed = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
  }
  // Only the parked owner's own acquires are behind us; a takeover's
  // acquire must be visible to the asserting test.
  acquireSpy.mockClear();
  return { server, clientId: created.body.clientId as string };
}

async function loadReplacement(passive = false, toolProfile = FILE_PROFILE) {
  const server = await replacementApp();
  const loaded = await replacementHeaders(
    supertest(server).post(`/session/${SESSION_ID}/load`),
  ).send({
    managedSessionStore: storeFor(BOOT_ID_2),
    toolProfile,
    // Only the coordinator's takeover may drive or report a parked Turn.
    [passive ? 'passiveManagedRuntimeRecovery' : 'driveRuntimeRecovery']: true,
  });
  return { server, loaded };
}

function spyOnAcquire() {
  acquireSpy = vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire');
  return acquireSpy;
}

export {
  BOOT_ID_2,
  CALL,
  FILE_PROFILE,
  acquireSpy,
  loadReplacement,
  parkToolTurn,
  replacementApp,
  replacementHeaders,
  storeFor,
  useRuntimeTakeover,
  spyOnAcquire,
};
