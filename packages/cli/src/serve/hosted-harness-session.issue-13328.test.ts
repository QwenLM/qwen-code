/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Reproduction for https://github.com/QwenLM/qwen-code/issues/13328
// Two Workspace-bound Sessions share one mount (one Runtime execution lease).
// The first Session's Turn acquires the lease; the second Session's Turn is
// admitted (HTTP 202) but its acquisition is refused by the Runtime Broker
// with HTTP 409 workspace_busy (WorkspaceExecutionStore.busy()).
//
// Expected per the issue: the second Turn either queues until the mount
// frees (admission stays 202, the Turn completes after the first) or settles
// with a classified, retryable workspace_busy code the client can act on.
// Observed at the reproduction commit: the second Turn settles terminally as
// turn_error with code hosted_turn_failed, and the serve log line reads
// "Hosted Harness turn <promptId> failed: Error: Runtime Broker returned
// HTTP 409 (workspace_busy)." — indistinguishable from a genuine execution
// failure. This test asserts the expected shape and therefore FAILS at the
// buggy revision, which is the reproduction evidence.

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { resetManagedRuntimeDispatchGatesForTest } from '@qwen-code/qwen-code-core/managed-runtime/managed-runtime-dispatch-gate.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import {
  createHostedHarnessContract,
  installHostedHarnessContractMiddleware,
} from './hosted-harness-contract.js';
import { registerHostedHarnessSessionRoutes } from './hosted-harness-session.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import type { HostedWorkspaceToolTurn } from './hosted-workspace-tool-turn.js';
import * as stdio from '../utils/stdioHelpers.js';

const state = vi.hoisted(() => ({
  root: '',
  assertWritable: vi.fn(async () => undefined),
  publicationRequest: vi.fn(),
  model: vi.fn(
    async (_input: {
      signal: AbortSignal;
      toolTurn?: HostedWorkspaceToolTurn;
      promptId?: string;
    }) => ({
      text: 'hello back',
      model: 'test-model',
    }),
  ),
}));

vi.mock(
  '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js',
  () => ({
    HTTP_MANAGED_SESSION_STORE_CONTRACT: { maxInlineResourceBytes: 64 * 1024 },
    createHttpManagedSessionStores: (options: {
      sessionKey: { tenantId: string; workspaceId: string; sessionId: string };
    }) => {
      const resourceStore = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: options.sessionKey,
      });
      return {
        journalStore: new LocalJsonlManagedSessionJournalStore({
          runtimeBaseDir: state.root,
          sessionId: options.sessionKey.sessionId,
          transcriptPath: path.join(
            state.root,
            `${options.sessionKey.sessionId}.jsonl`,
          ),
        }),
        resourceStore,
        toolResultResources: resourceStore,
        assertWritable: state.assertWritable,
        publication: {
          owner: async () => ({ writerId: BOOT_ID, writerGeneration: 1 }),
          request: (route: string, body: unknown, token?: string) =>
            state.publicationRequest(resourceStore, route, body, token),
          rememberAdmission: () => undefined,
        },
        close: async () => undefined,
      };
    },
  }),
);
vi.mock('./hosted-harness-model.js', () => ({
  runHostedHarnessTextTurn: state.model,
}));

const BOOT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_A = '22222222-2222-4222-8222-222222222222';
const SESSION_B = '55555555-5555-4555-8555-555555555555';
const PROMPT_A = '33333333-3333-4333-8333-333333333333';
const PROMPT_B = '66666666-6666-4666-8666-666666666666';

const listeners = new Set<Server>();

afterEach(async () => {
  await Promise.all(
    [...listeners].map(
      (listener) =>
        new Promise<void>((resolve) => {
          listener.close(() => resolve());
          listener.closeAllConnections();
        }),
    ),
  );
  listeners.clear();
});

async function app() {
  const result = express();
  result.use(express.json());
  const contract = createHostedHarnessContract(
    `sha256:${'a'.repeat(64)}`,
    BOOT_ID,
  );
  installHostedHarnessContractMiddleware(result, contract);
  registerHostedHarnessSessionRoutes(result, contract, state.root, {
    baseUrl: 'http://127.0.0.1:1',
    token: 'test',
  });
  const listener = createServer(result);
  listeners.add(listener);
  await new Promise<void>((resolve) =>
    listener.listen(0, '127.0.0.1', resolve),
  );
  return listener;
}

function headers<T extends supertest.Test>(request: T): T {
  return request
    .set('X-Qwen-Harness-Protocol-Version', '1')
    .set('X-Qwen-Harness-Boot-Id', BOOT_ID);
}

function store() {
  return {
    baseUrl: 'http://store.test',
    tenantId: 'tenant',
    workspaceId: 'workspace',
    writerId: BOOT_ID,
    leaseDurationMs: 60_000,
  };
}

describe('issue #13328: a second concurrent Session on the same Workspace mount', () => {
  beforeEach(async () => {
    resetManagedRuntimeDispatchGatesForTest();
    state.root = await mkdtemp(path.join(tmpdir(), 'issue-13328-'));
    state.assertWritable.mockReset();
    state.assertWritable.mockResolvedValue(undefined);
    state.model.mockReset();
    state.publicationRequest.mockReset();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(state.root, { recursive: true, force: true });
  });

  it(
    'queues or settles with a classified retryable workspace_busy, not terminal hosted_turn_failed',
    { timeout: 30_000 },
    async () => {
      // One Runtime execution lease, exactly as the Runtime Broker's
      // managed_workspace_execution_lease row serializes it: the first
      // acquire wins, a different holder is refused with HTTP 409
      // workspace_busy until the holder releases.
      let holder: string | undefined;
      let announceBusy!: () => void;
      const busy = new Promise<void>((resolve) => (announceBusy = resolve));
      const busyRejections: unknown[] = [];
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          if (holder !== undefined) {
            // The Broker's workspace_busy refusal is emitted with
            // retryable=true on the Java side
            // (WorkspaceExecutionStore.busy(), RuntimeBrokerException 409).
            const rejection = new HostedWorkspaceBrokerRejection(
              409,
              'workspace_busy',
            );
            busyRejections.push(rejection);
            announceBusy();
            throw rejection;
          }
          holder = this.runtimeSessionId;
          this.runtime = {
            bindingId: 'binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        },
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          if (holder === this.runtimeSessionId) holder = undefined;
        },
      );
      // Pin the first Turn inside its execution lease until the second
      // Turn's acquisition has been refused — the two Turns genuinely run
      // concurrently on the one mount.
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'fileHistory',
      ).mockImplementation(async () => {
        await busy;
        return { ownerSessionId: SESSION_A, snapshots: [], files: {} };
      });
      await writeFile(path.join(state.root, 'a.txt'), 'mount content a\n');
      const executed: string[] = [];
      state.model.mockImplementation(async ({ toolTurn, signal, promptId }) => {
        const call = {
          name: 'read_file',
          callId: `call-${promptId}`,
          args: { file_path: 'a.txt' },
          isClientInitiated: false,
          prompt_id: promptId ?? '',
        };
        await toolTurn!.execute(
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
          signal,
        );
        executed.push(promptId ?? '');
        return {
          text: promptId === PROMPT_A ? 'A done' : 'B done',
          model: 'test-model',
        };
      });
      // The winner's tool executes in the Broker-held Runtime exactly once:
      // prepare reserves an execution, execute returns its result.
      const prepare = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'prepare')
        .mockResolvedValue('77777777-7777-4777-8777-777777777777');
      vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'mount content a' }],
      });
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'acknowledge',
      ).mockResolvedValue();
      const server = await app();
      const create = async (sessionId: string) => {
        const created = await headers(supertest(server).post('/session')).send({
          sessionId,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
        });
        expect(created.status).toBe(200);
        return created.body.clientId as string;
      };
      const clientA = await create(SESSION_A);
      const clientB = await create(SESSION_B);
      const prompt = [{ type: 'text', text: 'read the mount file' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      const submit = async (
        sessionId: string,
        clientId: string,
        promptId: string,
      ) => {
        const response = await headers(
          supertest(server).post(`/session/${sessionId}/prompt`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({ prompt, promptId, payloadDigest });
        return response;
      };
      const status = async (sessionId: string, clientId: string) =>
        (
          await headers(
            supertest(server).get(`/session/${sessionId}/status`),
          ).set('X-Qwen-Client-Id', clientId)
        ).body;
      const transcript = async (sessionId: string, clientId: string) =>
        (
          await headers(
            supertest(server).get(`/session/${sessionId}/transcript`),
          ).set('X-Qwen-Client-Id', clientId)
        ).body.events as Array<Record<string, unknown>>;
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});

      // First Turn: admitted and holds the mount.
      expect((await submit(SESSION_A, clientA, PROMPT_A)).status).toBe(202);
      await vi.waitFor(() => expect(holder).toBeDefined());
      // Second Turn: also admitted (202) while the mount is busy.
      expect((await submit(SESSION_B, clientB, PROMPT_B)).status).toBe(202);
      // The second Turn settles — observe, don't yet judge.
      await vi.waitFor(
        async () => {
          const view = await status(SESSION_B, clientB);
          expect(view.hasActivePrompt).toBe(false);
        },
        { timeout: 10_000 },
      );
      const eventsB = await transcript(SESSION_B, clientB);
      const settledB = eventsB.find(
        (event) =>
          event['type'] === 'turn_error' || event['type'] === 'turn_complete',
      ) as
        | {
            type: string;
            promptId?: string;
            data?: { code?: string; message?: string };
          }
        | undefined;
      const failureLog = log.mock.calls
        .map(([line]) => String(line))
        .find((line) => line.includes(PROMPT_B));
      const statusB = await status(SESSION_B, clientB);
      const crossTalk = JSON.stringify(eventsB).includes('A done');
      // Let the winner finish once the lease is free, then verify the
      // issue's positive pins: the winner completes, its tool ran exactly
      // once, and no text leaked across the Sessions.
      await vi.waitFor(
        async () => {
          const view = await status(SESSION_A, clientA);
          expect(view.hasActivePrompt).toBe(false);
        },
        { timeout: 10_000 },
      );
      const eventsA = await transcript(SESSION_A, clientA);
      const settledEventsA = eventsA.filter(
        (event) =>
          event['type'] === 'turn_error' || event['type'] === 'turn_complete',
      );
      const failureLogA = log.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes(PROMPT_A));
      console.log(
        'issue-13328 winner settlement:',
        JSON.stringify(
          {
            settledEventsA,
            failureLogA,
            prepareCalls: prepare.mock.calls.length,
          },
          null,
          2,
        ),
      );
      const settledA = eventsA.find(
        (event) =>
          event['promptId'] === PROMPT_A && event['type'] === 'turn_complete',
      );
      const observed = {
        completedTurns: settledA ? 1 : 0,
        failedTurns: settledB?.type === 'turn_error' ? 1 : 0,
        winnerToolExecutions: executed.filter((id) => id === PROMPT_A).length,
        loserToolExecutions: executed.filter((id) => id === PROMPT_B).length,
        loserAdmission: 202,
        loserSettlement: settledB
          ? { type: settledB.type, code: settledB.data?.code }
          : undefined,
        loserRecoveryBlocked: statusB.recoveryBlocked,
        busyEvidence:
          busyRejections.length === 1 &&
          failureLog !== undefined &&
          failureLog.includes(
            'Runtime Broker returned HTTP 409 (workspace_busy)',
          ),
        crossTalk,
        failureLog,
      };
      console.log(
        'issue-13328 observed summary:',
        JSON.stringify(observed, null, 2),
      );
      // Positive pins from the issue that must hold in every outcome — at
      // the buggy revision and under either accepted fix (queueing or a
      // classified retryable refusal): the winner's Turn completes, its
      // tool executes exactly once, the loser is admitted with 202 and is
      // not recovery-blocked, and no text leaks across the Sessions. The
      // current-shape evidence (loser tool executions, the exact serve log
      // line, the busy contention) lives in the observed summary above.
      expect(settledA).toBeDefined();
      expect(executed.filter((id) => id === PROMPT_A)).toHaveLength(1);
      expect(statusB.recoveryBlocked).toBe(false);
      expect(crossTalk).toBe(false);
      expect(settledB).toBeDefined();
      // The issue: the second Turn must not be lost to a terminal,
      // unclassified failure. Either it queues and completes after the
      // first (turn_complete), or it settles with the classified, retryable
      // workspace_busy code the Broker emitted — not hosted_turn_failed.
      if (
        settledB!.type !== 'turn_complete' &&
        settledB!.data?.code !== 'workspace_busy'
      )
        throw new Error(
          `second turn settled as ${settledB!.type} ` +
            `(code=${settledB!.data?.code}): a retryable Broker ` +
            'workspace_busy reached the client as a terminal, unclassified ' +
            'turn failure instead of queueing or a classified retryable ' +
            'rejection',
        );
    },
  );
});
