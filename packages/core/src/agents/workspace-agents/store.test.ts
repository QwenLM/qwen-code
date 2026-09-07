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
import {
  allocateRunSequence,
  deleteThread,
  enqueueThreadEvent,
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
  isAgentAddressable,
  updateWorkspaceAgents,
  updateThread,
  withAgentStoreTransaction,
  writeThread,
} from './store.js';
import { postMessage, postMessageInTransaction } from './thread-actions.js';
import {
  HUMAN_AUTHOR_ID,
  AGENTS_SCHEMA_VERSION,
  type WorkspaceAgent,
  type Thread,
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
      agents: [{ ...ALICE, runtimeId: 'runtime_local' }],
    });
    await writeRaw(
      getThreadPath(PROJECT_ROOT, 'th_root'),
      thread({ runs: [run(1, 3)] }),
    );

    await expect(readWorkspaceAgents(PROJECT_ROOT)).resolves.toMatchObject([
      { id: ALICE.id, runtimeId: 'runtime_local' },
    ]);
    await expect(readThread(PROJECT_ROOT, 'th_root')).resolves.toMatchObject({
      schemaVersion: AGENTS_SCHEMA_VERSION,
      tokensUsed: 0,
      runs: [{ usageByRound: [{ attempt: 1, round: 1, tokens: 3 }] }],
    });
  });

  it('rejects nested workspace transactions instead of deadlocking', async () => {
    await expect(
      withAgentStoreTransaction(PROJECT_ROOT, () =>
        readWorkspaceAgents(PROJECT_ROOT),
      ),
    ).rejects.toThrow(/Nested agent workspace transactions/);
  });

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

  it('refuses to change a thread id through updateThread', async () => {
    await writeThread(PROJECT_ROOT, thread());

    await expect(
      updateThread(PROJECT_ROOT, 'th_root', (current) => ({
        ...current,
        id: 'th_other',
      })),
    ).rejects.toThrow(/cannot change its id/);
  });

  it('refuses deletion while an outbox event is pending', async () => {
    await writeThread(
      PROJECT_ROOT,
      thread({
        outbox: [
          {
            id: 'ev_pending',
            kind: 'notification',
            payload: { text: 'blocked' },
            status: 'pending',
            attempts: 0,
            createdAt: 2,
          },
        ],
      }),
    );

    await expect(deleteThread(PROJECT_ROOT, 'th_root')).rejects.toThrow(
      /pending events/,
    );
  });

  it('refuses deletion while a run is non-terminal', async () => {
    await writeThread(
      PROJECT_ROOT,
      thread({ runs: [run(1, 0, { status: 'finishing' })] }),
    );

    await expect(deleteThread(PROJECT_ROOT, 'th_root')).rejects.toThrow(
      /active runs/,
    );
  });

  it('replays an outbox apply exactly once at the target', async () => {
    await writeThread(PROJECT_ROOT, thread({ assigneeAgentId: BOB.id }));
    await writeThread(
      PROJECT_ROOT,
      thread({
        id: 'th_child',
        title: 'Child',
        rootThreadId: 'th_root',
        parentThreadId: 'th_root',
      }),
    );
    const event = await enqueueThreadEvent(PROJECT_ROOT, 'th_child', {
      id: 'ev_report',
      kind: 'parent_report',
      payload: { targetThreadId: 'th_root' },
      createdAt: 3,
    });

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
    await writeThread(PROJECT_ROOT, thread({ runs: [run(1, 40)] }));
    await writeThread(
      PROJECT_ROOT,
      thread({
        id: 'th_child',
        rootThreadId: 'th_root',
        parentThreadId: 'th_root',
        runs: [run(2, 35, { id: 'rn_2' })],
      }),
    );
    await writeThread(
      PROJECT_ROOT,
      thread({
        id: 'th_grandchild',
        rootThreadId: 'th_root',
        parentThreadId: 'th_child',
        assigneeAgentId: ALICE.id,
        runs: [run(3, 30, { id: 'rn_3' })],
      }),
    );
    const rootPath = getThreadPath(PROJECT_ROOT, 'th_root');
    const root = JSON.parse(await fs.readFile(rootPath, 'utf8')) as Thread;
    await writeRaw(rootPath, { ...root, tokensUsed: 0 });

    const result = await postMessage(
      PROJECT_ROOT,
      'th_grandchild',
      { from: HUMAN_AUTHOR_ID, text: 'continue' },
      { agents: [ALICE], limits: { tokens: 100 } },
    );

    expect(result.outcomes[0]?.decision).toEqual({
      kind: 'skip',
      reason: 'token_budget_exhausted',
    });
    expect(result.dispatched).toEqual([]);
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

  it('reports an unknown id rather than inventing an entry', async () => {
    await seed([ALICE]);

    await expect(retireWorkspaceAgent(PROJECT_ROOT, 'ag_nobody')).resolves.toBe(
      'not_found',
    );
    expect(await readWorkspaceAgents(PROJECT_ROOT)).toHaveLength(1);
  });
});
