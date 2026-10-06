/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const atomicWriteFault = vi.hoisted(() => ({
  filePath: undefined as string | undefined,
  mode: undefined as 'corruptAfter' | 'throwBefore' | undefined,
}));

vi.mock('../../utils/atomicFileWrite.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/atomicFileWrite.js')>();
  return {
    ...actual,
    atomicWriteJSON: async (
      ...args: Parameters<typeof actual.atomicWriteJSON>
    ) => {
      if (
        atomicWriteFault.filePath === args[0] &&
        atomicWriteFault.mode === 'throwBefore'
      ) {
        atomicWriteFault.filePath = undefined;
        atomicWriteFault.mode = undefined;
        throw new Error('injected crash before atomic write');
      }
      await actual.atomicWriteJSON(...args);
      if (
        atomicWriteFault.filePath === args[0] &&
        atomicWriteFault.mode === 'corruptAfter'
      ) {
        atomicWriteFault.filePath = undefined;
        atomicWriteFault.mode = undefined;
        const fileSystem = await import('node:fs/promises');
        await fileSystem.writeFile(args[0], '{}');
      }
    },
  };
});

import { Storage } from '../../config/storage.js';
import { mockCompromisedLock } from '../../test-utils/mock-compromised-lock.js';
import {
  allocateRunSequence,
  claimAgentHostSession,
  releaseAgentHostSession,
  getAgentsFilePath,
  getThreadPath,
  getWorkspaceFilePath,
  AgentSchemaVersionError,
  listThreads,
  readWorkspaceAgents,
  readAgentWorkspace,
  readThread,
  reconcileThreadOutbox,
  retireWorkspaceAgent,
  setWorkspaceAgentEnabled,
  updateWorkspaceAgent,
  issueAgentHostEnrollment,
  enrollAgentHost,
  heartbeatAgentHost,
  isAgentAddressable,
  updateWorkspaceAgents,
  withAgentStoreTransaction,
  writeThread,
} from './store.js';
import { postMessage, postMessageInTransaction } from './thread-actions.js';
import { issueA2AGrant } from './a2a-grants.js';
import { resolveThreadStatus } from './thread-status.js';
import {
  HUMAN_AUTHOR_ID,
  AGENTS_SCHEMA_VERSION,
  DEFAULT_THREAD_TOKEN_BUDGET,
  MAX_THREAD_RUNS,
  type WorkspaceAgent,
  type Thread,
  type ThreadEvent,
  type ThreadRun,
} from './types.js';

const PROJECT_ROOT = '/agent-store-test-project';
const ALICE: WorkspaceAgent = { id: 'ag_alice', name: 'alice', createdAt: 1 };
const BOB: WorkspaceAgent = { id: 'ag_bob', name: 'bob', createdAt: 1 };

function run(
  queueSequence: number,
  tokens: number,
  overrides: Partial<ThreadRun> = {},
): ThreadRun {
  return {
    id: `rn_${queueSequence}`,
    agentId: ALICE.id,
    status: 'completed',
    triggerMessageIds: [],
    acceptedMessageIds: [],
    consumedMessageIds: [],
    usageByRound: tokens ? [{ attempt: 1, round: 1, tokens }] : [],
    queueSequence,
    attempts: 1,
    queuedAt: queueSequence,
    endedAt: queueSequence + 1,
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    schemaVersion: AGENTS_SCHEMA_VERSION,
    id: 'th_root',
    title: 'Root',
    body: '',
    status: 'open',
    createdAt: 1,
    createdBy: HUMAN_AUTHOR_ID,
    rootThreadId: 'th_root',
    messages: [],
    runs: [],
    nextMessageSequence: 1,
    deliveryByAgent: {},
    outbox: [],
    autoTurnsUsed: 0,
    tokensUsed: 0,
    ...overrides,
  };
}

async function writeRaw(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value));
}

function v0Thread(): Record<string, unknown> {
  return {
    id: 'th_root',
    title: 'Legacy',
    body: '',
    status: 'open',
    createdAt: 1,
    createdBy: HUMAN_AUTHOR_ID,
    rootThreadId: 'th_root',
    messages: [
      {
        id: 'ms_1',
        from: HUMAN_AUTHOR_ID,
        text: 'one',
        mentions: [],
        at: 2,
      },
      {
        id: 'ms_2',
        from: ALICE.id,
        text: 'two',
        mentions: [],
        at: 3,
      },
    ],
    runs: [
      {
        id: 'rn_1',
        agentId: ALICE.id,
        status: 'completed',
        triggerMessageIds: ['ms_1'],
        attempts: 1,
        queuedAt: 4,
        endedAt: 5,
      },
      {
        id: 'rn_2',
        agentId: ALICE.id,
        status: 'failed',
        triggerMessageIds: ['ms_2'],
        attempts: 1,
        queuedAt: 6,
        endedAt: 7,
      },
    ],
    autoTurnsUsed: 0,
    tokensUsed: 9,
  };
}

describe('agent versioned store', () => {
  let runtimeDir: string;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-store-test-'));
    Storage.setRuntimeBaseDir(runtimeDir);
    atomicWriteFault.filePath = undefined;
    atomicWriteFault.mode = undefined;
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  it('fails closed on a newer workspace schema', async () => {
    await readAgentWorkspace(PROJECT_ROOT);
    await writeRaw(getWorkspaceFilePath(PROJECT_ROOT), {
      schemaVersion: AGENTS_SCHEMA_VERSION + 1,
      workspaceId: 'ws_newer',
      nextRunSequence: 1,
    });

    await expect(readAgentWorkspace(PROJECT_ROOT)).rejects.toBeInstanceOf(
      AgentSchemaVersionError,
    );
  });

  it('fails closed on a malformed current workspace schema', async () => {
    await writeRaw(getWorkspaceFilePath(PROJECT_ROOT), {
      schemaVersion: AGENTS_SCHEMA_VERSION,
      workspaceId: 'ws_malformed',
    });

    await expect(readAgentWorkspace(PROJECT_ROOT)).rejects.toThrow(
      /Malformed agent workspace record/,
    );
  });

  it('fails closed on a newer agents schema', async () => {
    await readAgentWorkspace(PROJECT_ROOT);
    await writeRaw(getAgentsFilePath(PROJECT_ROOT), {
      schemaVersion: AGENTS_SCHEMA_VERSION + 1,
      agents: [],
    });

    await expect(readWorkspaceAgents(PROJECT_ROOT)).rejects.toBeInstanceOf(
      AgentSchemaVersionError,
    );
  });

  it('fails closed on a newer thread schema', async () => {
    await writeThread(PROJECT_ROOT, thread());
    await writeRaw(getThreadPath(PROJECT_ROOT, 'th_root'), {
      ...thread(),
      schemaVersion: AGENTS_SCHEMA_VERSION + 1,
    });

    await expect(readThread(PROJECT_ROOT, 'th_root')).rejects.toBeInstanceOf(
      AgentSchemaVersionError,
    );
    await expect(listThreads(PROJECT_ROOT)).rejects.toBeInstanceOf(
      AgentSchemaVersionError,
    );
  });

  it('migrates v0 agents and thread records in order', async () => {
    await writeRaw(getAgentsFilePath(PROJECT_ROOT), [
      { ...ALICE, hostSessionId: 'host_legacy' },
    ]);
    await writeRaw(getThreadPath(PROJECT_ROOT, 'th_root'), v0Thread());

    const migrated = await readThread(PROJECT_ROOT, 'th_root');
    const workspace = await readAgentWorkspace(PROJECT_ROOT);
    const agentsFile = JSON.parse(
      await fs.readFile(getAgentsFilePath(PROJECT_ROOT), 'utf8'),
    ) as Record<string, unknown>;

    expect(migrated?.messages.map((message) => message.sequence)).toEqual([
      1, 2,
    ]);
    expect(migrated?.runs.map((entry) => entry.queueSequence)).toEqual([1, 2]);
    expect(migrated?.runs[1]?.usageByRound).toEqual([
      { attempt: 1, round: 0, tokens: 9 },
    ]);
    expect(migrated?.nextMessageSequence).toBe(3);
    expect(workspace).toMatchObject({
      schemaVersion: AGENTS_SCHEMA_VERSION,
      hostSessionId: 'host_legacy',
      nextRunSequence: 3,
    });
    expect(agentsFile).toEqual({
      schemaVersion: AGENTS_SCHEMA_VERSION,
      agents: [ALICE],
    });
    await expect(
      fs.access(getAgentsFilePath(PROJECT_ROOT).replace(/\.json$/, '.v0.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.access(
        getThreadPath(PROJECT_ROOT, 'th_root').replace(/\.json$/, '.v0.json'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not silently drop a malformed v0 agent', async () => {
    const legacy = [ALICE, { id: 'ag_invalid' }];
    await writeRaw(getAgentsFilePath(PROJECT_ROOT), legacy);

    await expect(readWorkspaceAgents(PROJECT_ROOT)).rejects.toThrow(
      /malformed v0 agent/,
    );
    expect(
      JSON.parse(await fs.readFile(getAgentsFilePath(PROJECT_ROOT), 'utf8')),
    ).toEqual(legacy);
  });

  it('keeps the v0 backup until the migrated file validates', async () => {
    const agentsPath = getAgentsFilePath(PROJECT_ROOT);
    const backup = agentsPath.replace(/\.json$/, '.v0.json');
    await writeRaw(agentsPath, [ALICE]);
    atomicWriteFault.filePath = agentsPath;
    atomicWriteFault.mode = 'corruptAfter';

    await expect(readWorkspaceAgents(PROJECT_ROOT)).rejects.toThrow(
      /failed validation/,
    );
    await expect(fs.access(backup)).resolves.toBeUndefined();
    expect(JSON.parse(await fs.readFile(backup, 'utf8'))).toEqual([ALICE]);

    await expect(readWorkspaceAgents(PROJECT_ROOT)).resolves.toEqual([ALICE]);
    await expect(fs.access(backup)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reads a hand-written complete v1 fixture', async () => {
    await writeRaw(getWorkspaceFilePath(PROJECT_ROOT), {
      schemaVersion: AGENTS_SCHEMA_VERSION,
      workspaceId: 'ws_fixture',
      nextRunSequence: 2,
    });
    await writeRaw(getAgentsFilePath(PROJECT_ROOT), {
      schemaVersion: AGENTS_SCHEMA_VERSION,
      agents: [
        { ...ALICE, description: 'Reviews builds', maxConcurrentRuns: 2 },
      ],
    });
    await writeRaw(
      getThreadPath(PROJECT_ROOT, 'th_root'),
      thread({ runs: [run(1, 3)] }),
    );

    await expect(readWorkspaceAgents(PROJECT_ROOT)).resolves.toMatchObject([
      { id: ALICE.id, description: 'Reviews builds', maxConcurrentRuns: 2 },
    ]);
    await expect(readThread(PROJECT_ROOT, 'th_root')).resolves.toMatchObject({
      schemaVersion: AGENTS_SCHEMA_VERSION,
      tokensUsed: 0,
      runs: [{ usageByRound: [{ attempt: 1, round: 1, tokens: 3 }] }],
    });
  });

  it('reads the thread directory once per transaction and keeps it current', async () => {
    await writeThread(PROJECT_ROOT, thread());
    await withAgentStoreTransaction(PROJECT_ROOT, async (transaction) => {
      const first = await transaction.listThreads();
      expect(first.threads.map((entry) => entry.title)).toEqual(['Root']);

      // A change on disk mid-transaction is not re-read: nothing else may
      // write while the lock is held, so the listing is taken once.
      await writeRaw(getThreadPath(PROJECT_ROOT, 'th_root'), {
        ...thread(),
        title: 'Changed outside',
      });
      // An in-place edit that is never written does not leak into the cache.
      first.threads[0]!.title = 'Edited, not written';
      const second = await transaction.listThreads();
      expect(second.threads.map((entry) => entry.title)).toEqual(['Root']);

      // The transaction's own write is what the next read sees.
      const [root] = second.threads;
      await transaction.writeThread({ ...root!, title: 'Written' });
      const third = await transaction.listThreads();
      expect(third.threads.map((entry) => entry.title)).toEqual(['Written']);
      await expect(transaction.readThread('th_root')).resolves.toMatchObject({
        title: 'Written',
      });
    });
  });

  it('rejects nested workspace transactions instead of deadlocking', async () => {
    await expect(
      withAgentStoreTransaction(PROJECT_ROOT, () =>
        readWorkspaceAgents(PROJECT_ROOT),
      ),
    ).rejects.toThrow(/Nested agent workspace transactions/);
  });

  it('keeps a transaction result when its workspace lock is compromised', async () => {
    const { lockSpy, getOnCompromised } = mockCompromisedLock();
    try {
      await expect(allocateRunSequence(PROJECT_ROOT)).resolves.toBe(1);
      expect(getOnCompromised()).toBeTypeOf('function');
    } finally {
      lockSpy.mockRestore();
    }
    await expect(allocateRunSequence(PROJECT_ROOT)).resolves.toBe(2);
  });

  it('rejects a thread whose progress snapshot is malformed', async () => {
    await writeThread(
      PROJECT_ROOT,
      thread({
        runs: [
          run(1, 0, {
            progress: {
              attempt: 1,
              sequence: 2,
              receivedAt: 3,
              activityAt: 3,
              stage: 'tool',
              detail: '',
              outputText: 'done',
              steps: [{ id: 'st_1', title: 'Read', status: 'done' }],
            },
          }),
        ],
      }),
    );
    await expect(readThread(PROJECT_ROOT, 'th_root')).resolves.toMatchObject({
      runs: [{ progress: { outputText: 'done' } }],
    });

    await writeRaw(
      getThreadPath(PROJECT_ROOT, 'th_root'),
      thread({
        runs: [{ ...run(1, 0), progress: 'x' } as unknown as ThreadRun],
      }),
    );
    await expect(readThread(PROJECT_ROOT, 'th_root')).rejects.toThrow(
      /Malformed/,
    );
  });

  // Each receipt breaks exactly one term of `isValidHostResultReceipt`, so the
  // attempt and leaseId cases carry a well-formed digest and cannot be refused
  // by the digest term instead. The non-record case is `null` rather than a
  // string: `null['attempt']` throws instead of validating, which is what tells
  // that term apart from the ones after it.
  const malformedReceipts: Array<[string, unknown]> = [
    [
      'digest is not sha256 hex',
      { attempt: 1, leaseId: 'lease', digest: 'invalid' },
    ],
    [
      'attempt is not a positive integer',
      { attempt: 0, leaseId: 'lease', digest: 'a'.repeat(64) },
    ],
    ['leaseId is empty', { attempt: 1, leaseId: '', digest: 'a'.repeat(64) }],
    ['digest is missing', { attempt: 1, leaseId: 'lease' }],
    ['receipt is not a record', null],
  ];

  it.each(malformedReceipts)(
    'rejects a persisted Host result receipt whose %s',
    async (_term, receipt) => {
      await writeRaw(
        getThreadPath(PROJECT_ROOT, 'th_root'),
        thread({
          runs: [
            run(1, 0, {
              hostResultReceipt: receipt as ThreadRun['hostResultReceipt'],
            }),
          ],
        }),
      );
      await expect(readThread(PROJECT_ROOT, 'th_root')).rejects.toThrow(
        /Malformed/,
      );
    },
  );

  it('persists a run counter allocation before any thread write', async () => {
    await expect(allocateRunSequence(PROJECT_ROOT)).resolves.toBe(1);
    await expect(allocateRunSequence(PROJECT_ROOT)).resolves.toBe(2);
    await expect(readAgentWorkspace(PROJECT_ROOT)).resolves.toMatchObject({
      nextRunSequence: 3,
    });
  });

  it('leaves a sequence gap when a thread write crashes after allocation', async () => {
    await writeThread(PROJECT_ROOT, thread({ assigneeAgentId: ALICE.id }));
    await writeThread(
      PROJECT_ROOT,
      thread({
        id: 'th_other',
        rootThreadId: 'th_other',
        assigneeAgentId: ALICE.id,
      }),
    );
    atomicWriteFault.filePath = getThreadPath(PROJECT_ROOT, 'th_root');
    atomicWriteFault.mode = 'throwBefore';

    await expect(
      postMessage(
        PROJECT_ROOT,
        'th_root',
        { from: HUMAN_AUTHOR_ID, text: 'first' },
        { agents: [ALICE], now: 2 },
      ),
    ).rejects.toThrow(/injected crash/);

    const second = await postMessage(
      PROJECT_ROOT,
      'th_other',
      { from: HUMAN_AUTHOR_ID, text: 'second' },
      { agents: [ALICE], now: 3 },
    );
    expect(second.dispatched[0]?.queueSequence).toBe(2);
    await expect(readAgentWorkspace(PROJECT_ROOT)).resolves.toMatchObject({
      nextRunSequence: 3,
    });
  });

  it('replays an outbox apply exactly once at the target', async () => {
    await writeThread(PROJECT_ROOT, thread({ assigneeAgentId: BOB.id }));
    const event: ThreadEvent = {
      id: 'ev_report',
      kind: 'parent_report',
      payload: { targetThreadId: 'th_root' },
      status: 'pending',
      attempts: 0,
      createdAt: 3,
    };
    await writeThread(
      PROJECT_ROOT,
      thread({
        id: 'th_child',
        title: 'Child',
        rootThreadId: 'th_root',
        parentThreadId: 'th_root',
        outbox: [event],
      }),
    );

    await expect(
      reconcileThreadOutbox(
        PROJECT_ROOT,
        'th_child',
        async (transaction, pending) => {
          await postMessageInTransaction(
            transaction,
            'th_root',
            {
              from: ALICE.id,
              text: 'child complete',
              originEventId: pending.id,
            },
            { agents: [ALICE, BOB], now: 4 },
          );
          throw new Error('crash after target apply');
        },
      ),
    ).rejects.toThrow(/crash after target apply/);

    await reconcileThreadOutbox(
      PROJECT_ROOT,
      'th_child',
      async (transaction, pending) => {
        await postMessageInTransaction(
          transaction,
          'th_root',
          {
            from: ALICE.id,
            text: 'child complete',
            originEventId: pending.id,
          },
          { agents: [ALICE, BOB], now: 5 },
        );
      },
    );

    const source = await readThread(PROJECT_ROOT, 'th_child');
    const target = await readThread(PROJECT_ROOT, 'th_root');
    expect(source?.outbox).toContainEqual({
      ...event,
      status: 'acknowledged',
      attempts: 2,
    });
    expect(
      target?.messages.filter((message) => message.originEventId === event.id),
    ).toHaveLength(1);
    expect(target?.runs).toHaveLength(1);
  });

  it('gates a depth-3 tree on run usage instead of a stale root cache', async () => {
    // Each thread is under the tree budget alone; only their sum is over it.
    await writeThread(PROJECT_ROOT, thread({ runs: [run(1, 400_000)] }));
    await writeThread(
      PROJECT_ROOT,
      thread({
        id: 'th_child',
        rootThreadId: 'th_root',
        parentThreadId: 'th_root',
        runs: [run(2, 350_000, { id: 'rn_2' })],
      }),
    );
    await writeThread(
      PROJECT_ROOT,
      thread({
        id: 'th_grandchild',
        rootThreadId: 'th_root',
        parentThreadId: 'th_child',
        assigneeAgentId: ALICE.id,
        runs: [run(3, 300_000, { id: 'rn_3' })],
      }),
    );
    const rootPath = getThreadPath(PROJECT_ROOT, 'th_root');
    const root = JSON.parse(await fs.readFile(rootPath, 'utf8')) as Thread;
    await writeRaw(rootPath, { ...root, tokensUsed: 0 });

    // An agent's post is held by the cap; a person's post still gets through.
    const fromAgent = await postMessage(
      PROJECT_ROOT,
      'th_grandchild',
      { from: BOB.id, text: 'continue' },
      { agents: [ALICE, BOB] },
    );
    expect(fromAgent.outcomes[0]?.decision).toEqual({
      kind: 'skip',
      reason: 'token_budget_exhausted',
    });
    expect(fromAgent.dispatched).toEqual([]);

    const fromPerson = await postMessage(
      PROJECT_ROOT,
      'th_grandchild',
      { from: HUMAN_AUTHOR_ID, text: 'continue' },
      { agents: [ALICE, BOB] },
    );
    expect(fromPerson.outcomes[0]?.decision).toEqual({ kind: 'dispatch' });
  });

  it("charges only a thread's own tree against the token budget", async () => {
    // Another tree far over the budget must not hold this one's agents.
    await writeThread(
      PROJECT_ROOT,
      thread({
        id: 'th_other',
        rootThreadId: 'th_other',
        runs: [run(1, DEFAULT_THREAD_TOKEN_BUDGET + 1)],
      }),
    );
    await writeThread(
      PROJECT_ROOT,
      thread({ assigneeAgentId: ALICE.id, runs: [run(2, 10, { id: 'rn_2' })] }),
    );

    const fromAgent = await postMessage(
      PROJECT_ROOT,
      'th_root',
      { from: BOB.id, text: 'continue' },
      { agents: [ALICE, BOB] },
    );
    expect(fromAgent.outcomes[0]?.decision).toEqual({ kind: 'dispatch' });
  });
  it('consumes a fresh enrollment token without replacing a valid host', async () => {
    const first = await issueAgentHostEnrollment(PROJECT_ROOT);
    const enrolled = await enrollAgentHost(PROJECT_ROOT, {
      token: first.token,
      name: 'worker',
      workspaceCwd: '/worker',
      providers: ['Qwen Code ACP'],
    });
    const fresh = await issueAgentHostEnrollment(PROJECT_ROOT);

    await expect(
      heartbeatAgentHost(PROJECT_ROOT, enrolled.host.id, enrolled.secret, {
        workspaceCwd: '/worker',
        providers: ['Qwen Code ACP'],
        enrollmentToken: fresh.token,
      }),
    ).resolves.toMatchObject({ id: enrolled.host.id });
    await expect(
      enrollAgentHost(PROJECT_ROOT, {
        token: fresh.token,
        name: 'other',
        workspaceCwd: '/other',
        providers: ['Qwen Code ACP'],
      }),
    ).rejects.toThrow('Invalid or expired Agent Host enrollment token.');
  });

  it('keeps a fresh enrollment token when the saved credential is invalid', async () => {
    const first = await issueAgentHostEnrollment(PROJECT_ROOT);
    const enrolled = await enrollAgentHost(PROJECT_ROOT, {
      token: first.token,
      name: 'worker',
      workspaceCwd: '/worker',
      providers: ['Qwen Code ACP'],
    });
    const fresh = await issueAgentHostEnrollment(PROJECT_ROOT);

    await expect(
      heartbeatAgentHost(PROJECT_ROOT, enrolled.host.id, 'invalid', {
        workspaceCwd: '/worker',
        providers: ['Qwen Code ACP'],
        enrollmentToken: fresh.token,
      }),
    ).resolves.toBeUndefined();
    await expect(
      enrollAgentHost(PROJECT_ROOT, {
        token: fresh.token,
        name: 'replacement',
        workspaceCwd: '/worker',
        providers: ['Qwen Code ACP'],
      }),
    ).resolves.toMatchObject({ host: { name: 'replacement' } });
  });
});

describe('retiring an agent', () => {
  let runtimeDir: string;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-retire-test-'));
    Storage.setRuntimeBaseDir(runtimeDir);
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  const seed = (agents: WorkspaceAgent[]) =>
    updateWorkspaceAgents(PROJECT_ROOT, () => agents);

  it('keeps the entry so every post it made still names its author', async () => {
    // The whole point: a thread is read long after an agent stops working,
    // and removing the row would turn its side of the conversation into an
    // author nobody can look up.
    await seed([ALICE, BOB]);

    await expect(retireWorkspaceAgent(PROJECT_ROOT, ALICE.id)).resolves.toBe(
      'updated',
    );

    const roster = await readWorkspaceAgents(PROJECT_ROOT);
    expect(roster.map((agent) => agent.id)).toEqual([ALICE.id, BOB.id]);
    const alice = roster.find((agent) => agent.id === ALICE.id);
    expect(alice?.name).toBe('alice');
    expect(alice?.retiredAt).toEqual(expect.any(Number));
  });

  it('stops the identity taking new work without disabling it', async () => {
    // Retired and disabled are different refusals. `enabled` is untouched, so
    // a reader can tell which one happened.
    await seed([ALICE]);
    await retireWorkspaceAgent(PROJECT_ROOT, ALICE.id);

    const [alice] = await readWorkspaceAgents(PROJECT_ROOT);
    expect(isAgentAddressable(alice)).toBe(false);
    expect(alice.enabled).toBeUndefined();
  });

  it('is idempotent and does not restamp the first retirement', async () => {
    await seed([ALICE]);
    await retireWorkspaceAgent(PROJECT_ROOT, ALICE.id);
    const first = (await readWorkspaceAgents(PROJECT_ROOT))[0].retiredAt;

    await expect(retireWorkspaceAgent(PROJECT_ROOT, ALICE.id)).resolves.toBe(
      'updated',
    );

    expect((await readWorkspaceAgents(PROJECT_ROOT))[0].retiredAt).toBe(first);
  });

  it('refuses while a run of its own is still live', async () => {
    // An agent cannot be retired out from under a turn in flight.
    await seed([ALICE]);
    await writeThread(
      PROJECT_ROOT,
      thread({ runs: [run(1, 0, { status: 'running' })] }),
    );

    await expect(retireWorkspaceAgent(PROJECT_ROOT, ALICE.id)).resolves.toBe(
      'has_live_work',
    );
    expect(
      (await readWorkspaceAgents(PROJECT_ROOT))[0].retiredAt,
    ).toBeUndefined();
  });

  it("ignores another agent's live run", async () => {
    await seed([ALICE, BOB]);
    await writeThread(
      PROJECT_ROOT,
      thread({ runs: [run(1, 0, { status: 'running' })] }),
    );

    await expect(retireWorkspaceAgent(PROJECT_ROOT, BOB.id)).resolves.toBe(
      'updated',
    );
  });

  it('refuses to enable a retired identity instead of reporting success', async () => {
    // Enabling one would change nothing a caller can observe, since
    // `isAgentAddressable` still refuses it. Saying so beats a hollow 200.
    await seed([ALICE]);
    await retireWorkspaceAgent(PROJECT_ROOT, ALICE.id);

    await expect(
      setWorkspaceAgentEnabled(PROJECT_ROOT, ALICE.id, true),
    ).resolves.toBe('retired');

    const [alice] = await readWorkspaceAgents(PROJECT_ROOT);
    expect(isAgentAddressable(alice)).toBe(false);
  });

  it('makes a disabled agent addressable again when re-enabled', async () => {
    await seed([ALICE]);
    await setWorkspaceAgentEnabled(PROJECT_ROOT, ALICE.id, false);

    await expect(
      setWorkspaceAgentEnabled(PROJECT_ROOT, ALICE.id, true),
    ).resolves.toBe('updated');
    const [alice] = await readWorkspaceAgents(PROJECT_ROOT);
    expect(isAgentAddressable(alice)).toBe(true);
  });

  it('leaves every roster field unchanged when a combined placement update is refused', async () => {
    await seed([ALICE]);
    await writeThread(
      PROJECT_ROOT,
      thread({ runs: [run(1, 0, { status: 'running' })] }),
    );
    await expect(
      updateWorkspaceAgent(PROJECT_ROOT, ALICE.id, {
        applyConfig: (agent) => ({ ...agent, description: 'changed' }),
        execution: { mode: 'local' },
        enabled: false,
      }),
    ).resolves.toBe('has_live_work');
    expect(await readWorkspaceAgents(PROJECT_ROOT)).toEqual([ALICE]);
  });

  it('does not apply config when disabling is refused by unreadable threads', async () => {
    await seed([ALICE]);
    await writeRaw(getThreadPath(PROJECT_ROOT, 'th_broken'), {
      schemaVersion: AGENTS_SCHEMA_VERSION,
    });
    await expect(
      updateWorkspaceAgent(PROJECT_ROOT, ALICE.id, {
        applyConfig: (agent) => ({ ...agent, description: 'changed' }),
        enabled: false,
      }),
    ).rejects.toThrow('thread records are unreadable');
    expect(await readWorkspaceAgents(PROJECT_ROOT)).toEqual([ALICE]);
  });

  it('checks concurrent persona and placement patches against the locked roster', async () => {
    await seed([ALICE]);
    const enrollment = await issueAgentHostEnrollment(PROJECT_ROOT);
    const { host } = await enrollAgentHost(PROJECT_ROOT, {
      token: enrollment.token,
      name: 'worker',
      workspaceCwd: '/worker',
      providers: ['Qwen Code ACP'],
    });
    const results = await Promise.all([
      updateWorkspaceAgent(PROJECT_ROOT, ALICE.id, {
        execution: {
          mode: 'managed-host',
          hostIds: [host.id],
          provider: 'qwen',
        },
      }),
      updateWorkspaceAgent(PROJECT_ROOT, ALICE.id, {
        applyConfig: (agent) => ({ ...agent, model: 'custom-model' }),
      }),
    ]);
    expect(results.sort()).toEqual([
      'managed_host_persona_unsupported',
      'updated',
    ]);
    const [agent] = await readWorkspaceAgents(PROJECT_ROOT);
    expect(
      agent.execution?.mode === 'managed-host' && Boolean(agent.model),
    ).toBe(false);
  });

  it('combines a config change with disable and settles queued work', async () => {
    await seed([ALICE]);
    await writeThread(
      PROJECT_ROOT,
      thread({ runs: [run(1, 0, { status: 'queued', endedAt: undefined })] }),
    );
    await expect(
      updateWorkspaceAgent(PROJECT_ROOT, ALICE.id, {
        applyConfig: (agent) => ({ ...agent, description: 'paused' }),
        enabled: false,
      }),
    ).resolves.toBe('updated');
    expect(await readWorkspaceAgents(PROJECT_ROOT)).toEqual([
      { ...ALICE, description: 'paused', enabled: false },
    ]);
    expect((await readThread(PROJECT_ROOT, 'th_root'))?.runs[0]?.status).toBe(
      'cancelled',
    );
  });

  it('cancels queued runs on disable so they cannot wedge their thread', async () => {
    // A disabled agent can never start a queued run, but `queued` counts as
    // live for thread status and retirement — a leftover queued run pinned
    // the thread in `in_progress` and blocked retiring the agent.
    await seed([ALICE]);
    await writeThread(
      PROJECT_ROOT,
      thread({ runs: [run(1, 0, { status: 'queued', endedAt: undefined })] }),
    );

    await expect(
      setWorkspaceAgentEnabled(PROJECT_ROOT, ALICE.id, false),
    ).resolves.toBe('updated');

    const stored = await readThread(PROJECT_ROOT, 'th_root');
    expect(stored?.runs[0]?.status).toBe('cancelled');
    expect(stored?.runs[0]?.endedAt).toEqual(expect.any(Number));
    expect(stored?.status).toBe('blocked');
    // With the dead run settled the agent holds no live work, so retiring
    // it — previously refused — now succeeds.
    await expect(retireWorkspaceAgent(PROJECT_ROOT, ALICE.id)).resolves.toBe(
      'updated',
    );
  });

  it('finishes disabling after the roster committed but thread cleanup failed', async () => {
    await seed([ALICE]);
    await writeThread(
      PROJECT_ROOT,
      thread({ runs: [run(1, 0, { status: 'queued', endedAt: undefined })] }),
    );
    atomicWriteFault.filePath = getThreadPath(PROJECT_ROOT, 'th_root');
    atomicWriteFault.mode = 'throwBefore';
    await expect(
      setWorkspaceAgentEnabled(PROJECT_ROOT, ALICE.id, false),
    ).rejects.toThrow('injected crash');
    expect((await readWorkspaceAgents(PROJECT_ROOT))[0].enabled).toBe(false);
    expect((await readThread(PROJECT_ROOT, 'th_root'))?.runs[0].status).toBe(
      'queued',
    );

    await setWorkspaceAgentEnabled(PROJECT_ROOT, ALICE.id, false);
    const stored = await readThread(PROJECT_ROOT, 'th_root');
    expect(stored?.runs[0].status).toBe('cancelled');
    expect(stored?.status).toBe('blocked');
    await setWorkspaceAgentEnabled(PROJECT_ROOT, ALICE.id, false);
    expect(await readThread(PROJECT_ROOT, 'th_root')).toEqual(stored);
  });

  it('refuses disabling before writing the roster when a thread is unreadable', async () => {
    await seed([ALICE]);
    // Versioned but unparseable is what "unreadable" means here. A record with
    // no schema version at all is a schema failure, which listThreads rethrows
    // rather than deferring — that path is covered by the version tests above.
    await writeRaw(getThreadPath(PROJECT_ROOT, 'th_broken'), {
      schemaVersion: AGENTS_SCHEMA_VERSION,
    });
    await expect(
      setWorkspaceAgentEnabled(PROJECT_ROOT, ALICE.id, false),
    ).rejects.toThrow('thread records are unreadable');
    expect((await readWorkspaceAgents(PROJECT_ROOT))[0].enabled).not.toBe(
      false,
    );
  });

  it('retains an unresolved close through trimming and releases it after acknowledgement', async () => {
    await seed([ALICE]);
    const blocker = run(1, 0, { closeKind: 'blocked' });
    await writeThread(
      PROJECT_ROOT,
      thread({
        status: 'blocked',
        runs: [
          blocker,
          ...Array.from({ length: MAX_THREAD_RUNS }, (_, index) =>
            run(index + 2, 0),
          ),
        ],
      }),
    );
    const stored = (await readThread(PROJECT_ROOT, 'th_root'))!;
    expect(stored.runs.some((entry) => entry.id === blocker.id)).toBe(true);
    expect(
      resolveThreadStatus({ thread: stored, hasLiveChildDependency: false })
        .status,
    ).toBe('blocked');

    await writeThread(PROJECT_ROOT, {
      ...stored,
      runs: stored.runs.map((entry) =>
        entry.id === blocker.id
          ? { ...entry, closeAcknowledgedAtSequence: 0 }
          : entry,
      ),
    });
    expect(
      (await readThread(PROJECT_ROOT, 'th_root'))?.runs.some(
        (entry) => entry.id === blocker.id,
      ),
    ).toBe(false);
  });

  it('reports cancellation when disabling the last queued run of a child', async () => {
    await seed([ALICE]);
    await writeThread(
      PROJECT_ROOT,
      thread({
        id: 'th_child',
        rootThreadId: 'th_root',
        parentThreadId: 'th_root',
        status: 'in_progress',
        runs: [run(1, 0, { status: 'queued', endedAt: undefined })],
      }),
    );

    await setWorkspaceAgentEnabled(PROJECT_ROOT, ALICE.id, false);

    const stored = await readThread(PROJECT_ROOT, 'th_child');
    expect(stored?.outbox).toEqual([
      expect.objectContaining({
        kind: 'parent_report',
        causedByRunId: 'rn_1',
        payload: expect.objectContaining({ event: 'child_cancelled' }),
      }),
    ]);
  });

  it('leaves running work alone on disable', async () => {
    await seed([ALICE]);
    await writeThread(
      PROJECT_ROOT,
      thread({ runs: [run(1, 0, { status: 'running', endedAt: undefined })] }),
    );

    await expect(
      setWorkspaceAgentEnabled(PROJECT_ROOT, ALICE.id, false),
    ).resolves.toBe('updated');

    expect((await readThread(PROJECT_ROOT, 'th_root'))?.runs[0]?.status).toBe(
      'running',
    );
    // A mid-turn run still blocks retirement, exactly as before.
    await expect(retireWorkspaceAgent(PROJECT_ROOT, ALICE.id)).resolves.toBe(
      'has_live_work',
    );
  });

  it('reports an unknown id rather than inventing an entry', async () => {
    await seed([ALICE]);

    await expect(retireWorkspaceAgent(PROJECT_ROOT, 'ag_nobody')).resolves.toBe(
      'not_found',
    );
    expect(await readWorkspaceAgents(PROJECT_ROOT)).toHaveLength(1);
  });
});

describe('releasing the agent host session', () => {
  let runtimeDir: string;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'agent-release-test-'),
    );
    Storage.setRuntimeBaseDir(runtimeDir);
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  it('drops only the claim and keeps the A2A grants', async () => {
    await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: ALICE.id,
    });
    await claimAgentHostSession(PROJECT_ROOT, 'session-1');

    await expect(
      releaseAgentHostSession(PROJECT_ROOT, 'session-1'),
    ).resolves.toBe(true);

    const workspace = await readAgentWorkspace(PROJECT_ROOT);
    expect(workspace.hostSessionId).toBeUndefined();
    expect(workspace.callerGrants?.map((grant) => grant.callerId)).toEqual([
      'share_1',
    ]);
  });
});
