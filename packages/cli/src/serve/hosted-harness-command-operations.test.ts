/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LocalJsonlManagedSessionJournalHandle,
  LocalJsonlManagedSessionJournalStore,
} from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import {
  assertManagedSessionDurableRef,
  ManagedSessionRecordError,
  ManagedSessionWritesStoppedError,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  ManagedSessionStoreHttpError,
  ManagedSessionStoreTransportError,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { resetManagedRuntimeDispatchGatesForTest } from '@qwen-code/qwen-code-core/managed-runtime/managed-runtime-dispatch-gate.js';
import {
  MANAGED_SESSION_COMMAND_LIMITS,
  parseSessionCommand,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-command-record.js';
import { sessionCommandId } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-command-operations.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import { HostedSessionCommandSession } from './hosted-session-command-session.js';
import {
  createHostedHarnessContract,
  installHostedHarnessContractMiddleware,
} from './hosted-harness-contract.js';
import { registerHostedHarnessSessionRoutes } from './hosted-harness-session.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';
import * as stdio from '../utils/stdioHelpers.js';

const state = vi.hoisted(() => ({
  root: '',
  resources: undefined as LocalManagedSessionResourceStore | undefined,
}));

vi.mock(
  '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js')
      >();
    return {
      ...actual,
      createHttpManagedSessionStores: (
        options: Parameters<typeof actual.createHttpManagedSessionStores>[0],
      ): ReturnType<typeof actual.createHttpManagedSessionStores> => {
        const resources = LocalManagedSessionResourceStore.create({
          runtimeBaseDir: state.root,
          sessionKey: options.sessionKey,
        });
        state.resources = resources;
        return {
          journalStore: new LocalJsonlManagedSessionJournalStore({
            runtimeBaseDir: state.root,
            sessionId: options.sessionKey.sessionId,
            transcriptPath: path.join(state.root, 'transcript.jsonl'),
          }),
          resourceStore: resources,
          toolResultResources: resources,
          assertWritable: async () => undefined,
          stopLocal: async () => undefined,
          close: async () => undefined,
          setLifecycleAuthority: () => undefined,
          authorizeLifecycle: async () => undefined,
          authorizeOrdinary: async () => undefined,
          publication: {
            owner: async () => ({
              writerId: options.writerId,
              writerGeneration: 1,
            }),
            request: async () => {
              throw new Error(
                'Unexpected publication request in command operation test',
              );
            },
            rememberAdmission: () => undefined,
          },
        };
      },
    };
  },
);

const BOOT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_ID = '33333333-3333-4333-8333-333333333333';
const key = {
  tenantId: 'tenant',
  workspaceId: 'workspace',
  sessionId: SESSION_ID,
};
const commandId = sessionCommandId({
  senderSessionId: SESSION_ID,
  promptKey: 'prompt-1',
  callId: 'call-1',
});
const reply = { outcome: 'answered', text: 'the leader replied' };
let app: express.Express | undefined;
let clientId = '';
let expectCloseFailure = false;

function headers(request: supertest.Test): supertest.Test {
  return request
    .set('X-Qwen-Harness-Protocol-Version', '1')
    .set('X-Qwen-Harness-Boot-Id', BOOT_ID);
}

async function fixture(accepting = true): Promise<void> {
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: state.root,
    sessionKey: key,
  });
  const managed = await openManagedSession({
    runtimeBaseDir: state.root,
    cwd: state.root,
    transcriptPath: path.join(state.root, 'transcript.jsonl'),
    sessionId: SESSION_ID,
    sessionKey: key,
    version: 'hosted-harness/1',
    workerId: BOOT_ID,
    activationLeaseDurationMs: 60_000,
    resourceStore: resources,
    journalStore: new LocalJsonlManagedSessionJournalStore({
      runtimeBaseDir: state.root,
      sessionId: SESSION_ID,
      transcriptPath: path.join(state.root, 'transcript.jsonl'),
    }),
    create: {
      definitionRef: await resources.publish(
        'managed-definition',
        Buffer.from(
          JSON.stringify({
            engine: 'managed',
            sessionId: SESSION_ID,
            toolProfile: 'hosted-workspace-shell/1',
            lineage: {
              depth: 1,
              parentSessionId: PARENT_ID,
              parentChildRunId: 'run-1',
            },
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
    const store = {
      authority: managed.authority,
      resources: managed.resources,
    };
    const commands = new HostedSessionCommandSession(
      store,
      key,
      new HostedChildAgentSession(store, key),
      { parentSessionId: PARENT_ID, parentChildRunId: 'run-1' },
    );
    await commands.runCommand({
      commandId,
      kind: 'board_read',
      args: {},
      executionCallId: 'prompt-1:call-1',
      closing: false,
    });
    if (accepting) await commands.handover(commandId, PARENT_ID);
  } finally {
    await managed.close();
  }
  app = express();
  app.use(express.json());
  const contract = createHostedHarnessContract(
    `sha256:${'a'.repeat(64)}`,
    BOOT_ID,
  );
  installHostedHarnessContractMiddleware(app, contract);
  registerHostedHarnessSessionRoutes(app, contract, state.root, {
    baseUrl: 'http://127.0.0.1:1',
    token: 'offline',
  });
  const loaded = await headers(
    supertest(app).post(`/session/${SESSION_ID}/load`),
  ).send({
    toolProfile: 'hosted-workspace-shell/1',
    passiveManagedRuntimeRecovery: true,
    managedSessionStore: {
      baseUrl: 'https://offline.invalid',
      tenantId: key.tenantId,
      workspaceId: key.workspaceId,
      writerId: BOOT_ID,
      leaseDurationMs: 60_000,
    },
  });
  expect(loaded.status).toBe(200);
  clientId = loaded.body.clientId as string;
}

function answered(body: Record<string, unknown> = {}): supertest.Test {
  return headers(
    supertest(app!).post(`/session/${SESSION_ID}/messages/operations`),
  )
    .set('X-Qwen-Client-Id', clientId)
    .send({
      operationId: randomUUID(),
      commandId,
      kind: 'answered',
      reply,
      ...body,
    });
}

async function expectOperation(
  request: supertest.Test,
  expectedStatus: number,
  expectedCode?: string,
  failureLog?: 'store' | 'other',
): Promise<supertest.Response> {
  const stderr = vi
    .spyOn(stdio, 'writeStderrLineSafe')
    .mockImplementation(() => undefined);
  try {
    const response = await request;
    expect(response.status).toBe(expectedStatus);
    if (expectedCode !== undefined)
      expect(response.body.code).toBe(expectedCode);
    if (failureLog !== undefined) {
      expect(response.body.message).toEqual(expect.any(String));
      expect(stderr.mock.calls).toEqual([
        [
          `qwen serve: Hosted command operation answered of session ${SESSION_ID} failed${failureLog === 'store' ? ' in its store' : ''}: ${response.body.message}`,
        ],
      ]);
    } else expect(stderr).not.toHaveBeenCalled();
    return response;
  } finally {
    stderr.mockRestore();
  }
}

beforeEach(async () => {
  state.root = await mkdtemp(path.join(tmpdir(), 'hosted-command-operation-'));
  state.resources = undefined;
  app = undefined;
  clientId = '';
  expectCloseFailure = false;
  resetManagedRuntimeDispatchGatesForTest();
  vi.spyOn(
    HostedWorkspaceBroker.prototype,
    'capabilityDigest',
    'get',
  ).mockReturnValue(WORKSPACE_CAPABILITY_DIGEST);
  vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
  vi.spyOn(
    HostedWorkspaceBroker.prototype,
    'activeHoldRuntimeSessionIds',
  ).mockResolvedValue([]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected external fetch');
    }),
  );
});

afterEach(async () => {
  try {
    if (app && clientId) {
      const detached = await headers(
        supertest(app).post(`/session/${SESSION_ID}/detach`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(detached.status).toBe(expectCloseFailure ? 503 : 204);
      if (expectCloseFailure)
        expect(detached.body.code).toBe('managed_session_close_failed');
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(state.root, { recursive: true, force: true });
  }
});

describe('Hosted Harness answered command operations', () => {
  it.each([
    undefined,
    null,
    {},
    { outcome: 'answered', text: 42 },
    { outcome: 'unknown', text: 'bad' },
    { outcome: 'answered', text: 'bad', extra: true },
  ])(
    'rejects malformed reply %j before command writes',
    async (invalidReply) => {
      await fixture();
      const publish = vi.spyOn(state.resources!, 'publish');
      const called = vi.spyOn(
        HostedSessionCommandSession.prototype,
        'answered',
      );
      const commit = vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'commitExtensionRecord',
      );
      await expectOperation(
        answered({ reply: invalidReply }),
        400,
        'invalid_command_operation',
      );
      expect(publish).not.toHaveBeenCalled();
      expect(called).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
    },
  );

  it('classifies a missing command record as a record conflict', async () => {
    await fixture();
    await expectOperation(
      answered({ commandId: 'missing-command' }),
      409,
      'session_command_record',
    );
  });

  it('classifies an invalid persisted command through the real parser', async () => {
    await fixture();
    const read = LocalManagedSessionAuthority.prototype.extensionRecord;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'extensionRecord',
    ).mockImplementation(function (
      this: LocalManagedSessionAuthority,
      ...args
    ) {
      const stored = read.apply(this, args);
      return args[0] === 'session_command' && stored !== undefined
        ? { ...stored, record: {} }
        : stored;
    });
    await expectOperation(answered(), 409, 'session_command_record');
  });

  it('classifies an answer before handover as a command conflict', async () => {
    await fixture(false);
    await expectOperation(answered(), 409, 'session_command_conflict');
  });

  it.each([
    new ManagedSessionStoreHttpError(
      503,
      'store_unavailable',
      'HTTP store unavailable',
    ),
    new ManagedSessionStoreTransportError('store transport failed'),
  ])('reports a real $name from reply resource publication', async (cause) => {
    await fixture();
    expect(cause).toBeInstanceOf(ManagedSessionRecordError);
    const publish = vi
      .spyOn(state.resources!, 'publish')
      .mockRejectedValueOnce(cause);
    const response = await expectOperation(
      answered(),
      503,
      'session_command_failed',
      'store',
    );
    expect(response.body.message).toBe(cause.message);
    expect(publish).toHaveBeenCalledWith(
      'managed-command-reply',
      expect.any(Buffer),
    );
  });

  it('keeps unexpected failures on the existing generic error path', async () => {
    await fixture();
    const cause = new Error('unexpected resource failure');
    vi.spyOn(state.resources!, 'publish').mockRejectedValueOnce(cause);
    const response = await expectOperation(
      answered(),
      503,
      'session_command_failed',
      'other',
    );
    expect(response.body.message).toBe(cause.message);
  });

  it('reports the real writes-stopped latch after a refused journal append', async () => {
    await fixture();
    expectCloseFailure = true;
    const failures: unknown[] = [];
    const commit = LocalManagedSessionAuthority.prototype.commitExtensionRecord;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'commitExtensionRecord',
    ).mockImplementation(async function (
      this: LocalManagedSessionAuthority,
      ...args
    ) {
      try {
        return await commit.apply(this, args);
      } catch (cause) {
        failures.push(cause);
        throw cause;
      }
    });
    const cause = new ManagedSessionStoreHttpError(
      503,
      'store_unavailable',
      'accepted journal write refused',
    );
    const journal = vi
      .spyOn(
        LocalJsonlManagedSessionJournalHandle.prototype,
        'appendTransaction',
      )
      .mockRejectedValueOnce(cause);
    const first = await expectOperation(
      answered(),
      503,
      'session_command_failed',
      'store',
    );
    expect(first.body.message).toBe(cause.message);
    const stopped = await expectOperation(
      answered(),
      503,
      'session_command_failed',
      'store',
    );
    expect(journal).toHaveBeenCalledTimes(1);
    expect(failures[0]).toBe(cause);
    expect(failures[1]).toBeInstanceOf(ManagedSessionWritesStoppedError);
    expect(stopped.body.message).toBe((failures[1] as Error).message);
  });

  it('preserves oversized reply refusal without writing', async () => {
    await fixture();
    const publish = vi.spyOn(state.resources!, 'publish');
    const commit = vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'commitExtensionRecord',
    );
    const response = await expectOperation(
      answered({
        reply: {
          ...reply,
          text: 'x'.repeat(MANAGED_SESSION_COMMAND_LIMITS.maxReplyBytes),
        },
      }),
      409,
      'session_command_refused',
    );
    expect(response.body.message).toContain('byte_limit');
    expect(publish).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('commits the exact reply once and replays without more resources or revisions', async () => {
    await fixture();
    const resources = state.resources!;
    const publish = vi.spyOn(resources, 'publish');
    const successId = randomUUID();
    const success = await expectOperation(
      answered({ operationId: successId }),
      202,
    );
    expect(success.body).toEqual({ operationId: successId, state: 'settled' });
    expect(
      publish.mock.calls.filter(([kind]) => kind === 'managed-command-reply'),
    ).toHaveLength(1);
    const publications = publish.mock.calls.length;
    const first = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, 'transcript.jsonl'),
      key,
    );
    const commits = first.events.filter(
      (event) =>
        event.kind === 'domain.committed' &&
        event.payload['domain'] === 'session_command',
    );
    expect(commits).toHaveLength(3);
    const accepted = commits[2]!;
    expect(accepted.payload['operationId']).toBe(`${commandId}:3`);
    const record = parseSessionCommand(
      JSON.parse(
        (
          await resources.read(
            assertManagedSessionDurableRef(
              accepted.payload['recordRef'],
              'recordRef',
            ),
          )
        ).toString('utf8'),
      ),
    );
    expect(record.commandId).toBe(commandId);
    expect(record.direction).toBe('outbound');
    expect(record.run.delivery?.state).toBe('accepted');
    const replyRef = record.replyRef!;
    const bytes = Buffer.from(JSON.stringify(reply));
    expect(await resources.read(replyRef)).toEqual(bytes);
    expect(record.replyDigest).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    expect(record.replyDigest).toBe(replyRef.digest);
    const replayId = randomUUID();
    const replay = await expectOperation(
      answered({ operationId: replayId }),
      202,
    );
    expect(replay.body).toEqual({ operationId: replayId, state: 'settled' });
    expect(publish).toHaveBeenCalledTimes(publications);
    const afterReplay = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, 'transcript.jsonl'),
      key,
    );
    expect(afterReplay.events).toEqual(first.events);
  });

  it('classifies a different reply after acceptance as a copy-back conflict', async () => {
    await fixture();
    await answered().expect(202);
    await expectOperation(
      answered({ reply: { ...reply, text: 'different leader reply' } }),
      409,
      'session_command_conflict',
    );
  });
});
