/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import {
  checkpointFromTask,
  claimInterruptedWorkflowRuns,
  INTERRUPTED_WORKFLOW_ERROR,
  readWorkflowCheckpoint,
  removeWorkflowCheckpoint,
  writeWorkflowCheckpoint,
  type WorkflowCheckpoint,
} from './workflow-checkpoint.js';
import {
  getWorkflowTaskMutationKey,
  markWorkflowRunPersistenceActive,
  tryWithWorkflowTaskMutation,
  type WorkflowTask,
} from './workflow-run-registry.js';
import {
  listWorkflowSnapshots,
  MAX_SNAPSHOT_ARGS_CHARS,
  persistWorkflowSnapshot,
  readWorkflowSnapshot,
  type WorkflowSnapshot,
} from './workflow-snapshot.js';

const RUN_ID = 'wf_0123abcd';
// A pid no test process has: the claim is told whether it is running.
const DEAD_PID = 999_999;

let root: string;
let config: Config;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-checkpoint-'));
  config = {
    storage: {
      getWorkflowRunsDir: () => root,
      getWorkflowRunJournalPath: (runId: string) =>
        path.join(root, runId, 'journal.jsonl'),
      getWorkflowRunSnapshotPath: (runId: string) =>
        path.join(root, `${runId}.json`),
      getInlineWorkflowScriptPath: (runId: string) =>
        path.join(root, 'generated', 'inline', `${runId}.js`),
      getGeneratedWorkflowsDir: () => path.join(root, 'generated'),
    },
  } as unknown as Config;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function checkpoint(
  overrides: Partial<WorkflowCheckpoint> = {},
): WorkflowCheckpoint {
  return {
    v: 1,
    runId: RUN_ID,
    sessionId: 'session-1',
    pid: DEAD_PID,
    hostname: os.hostname(),
    startTime: 1_700_000_000_000,
    script: 'return await agent("work")',
    scriptPath: path.join(root, 'generated', 'inline', `${RUN_ID}.js`),
    meta: { name: 'audit', description: 'Audit the repo' },
    description: 'audit',
    tokenBudgetTotal: null,
    ...overrides,
  };
}

/** A run dir as a run leaves it: journal lines, then its checkpoint. */
async function leaveRun(
  cp: WorkflowCheckpoint,
  journalLines: object[] = [{ type: 'launched', version: 1 }],
): Promise<void> {
  const dir = path.join(root, cp.runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'journal.jsonl'),
    journalLines.map((line) => JSON.stringify(line) + '\n').join(''),
  );
  expect(await writeWorkflowCheckpoint(config, cp)).toBe(true);
}

const stopped = { isProcessRunning: () => false };

function task(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    id: RUN_ID,
    kind: 'workflow',
    runId: RUN_ID,
    description: RUN_ID,
    meta: null,
    status: 'running',
    startTime: 1_700_000_000_000,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    abortController: new AbortController(),
    currentPhase: null,
    phases: [],
    phaseVisits: [],
    currentPhaseVisitId: null,
    dispatches: [],
    agentsDispatched: 0,
    agentsCompleted: 0,
    recentLogs: [],
    events: [],
    tokensSpent: 0,
    tokenBudgetTotal: 5000,
    perPhaseTokens: new Map(),
    pendingApprovals: [],
    script: 'return 1',
    ...overrides,
  };
}

describe('checkpointFromTask', () => {
  it('records the run, its process, and the name its script declares', () => {
    const cp = checkpointFromTask(
      task({
        scriptPath: '/scripts/audit.js',
        workflowName: 'audit',
        resumeName: 'audit',
        sourceRef: { id: 'definition-7', revision: 'rev-3' },
        toolUseId: 'call-1',
        sourceRunId: RUN_ID,
        startMode: 'retry',
        args: { files: ['a.csv'] },
      }),
      {
        sessionId: 'session-1',
        meta: { name: 'Audit', description: 'Audit the repo' },
      },
    );

    expect(cp).toEqual({
      v: 1,
      runId: RUN_ID,
      sessionId: 'session-1',
      pid: process.pid,
      hostname: os.hostname(),
      startTime: 1_700_000_000_000,
      script: 'return 1',
      scriptPath: '/scripts/audit.js',
      meta: { name: 'Audit', description: 'Audit the repo' },
      description: 'Audit',
      workflowName: 'audit',
      resumeName: 'audit',
      sourceRef: { id: 'definition-7', revision: 'rev-3' },
      toolUseId: 'call-1',
      sourceRunId: RUN_ID,
      startMode: 'retry',
      tokenBudgetTotal: 5000,
      args: { files: ['a.csv'] },
    });
  });

  it('records that there were args it could not keep', () => {
    const big = 'x'.repeat(MAX_SNAPSHOT_ARGS_CHARS);
    const cp = checkpointFromTask(task({ args: big }), {
      sessionId: 's',
      meta: null,
    });
    expect(cp.argsOmitted).toBe(true);
    expect('args' in cp).toBe(false);
    expect(cp.description).toBe(RUN_ID);
  });
});

describe('writing and reading a checkpoint', () => {
  it('round-trips, and is gone once removed', async () => {
    await fs.mkdir(path.join(root, RUN_ID));
    const cp = checkpoint({ args: [1, 2] });
    expect(await writeWorkflowCheckpoint(config, cp)).toBe(true);
    expect(await readWorkflowCheckpoint(config, RUN_ID)).toEqual(cp);
    const mode = (await fs.stat(path.join(root, RUN_ID, 'checkpoint.json')))
      .mode;
    if (process.platform !== 'win32') expect(mode & 0o777).toBe(0o600);

    await removeWorkflowCheckpoint(config, RUN_ID);
    expect(await readWorkflowCheckpoint(config, RUN_ID)).toBeUndefined();
  });

  it('ignores a checkpoint that names another run', async () => {
    await fs.mkdir(path.join(root, RUN_ID));
    await fs.writeFile(
      path.join(root, RUN_ID, 'checkpoint.json'),
      JSON.stringify(checkpoint({ runId: 'wf_ffff0000' })),
    );
    expect(await readWorkflowCheckpoint(config, RUN_ID)).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'does not write through a symlinked run directory',
    async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-outside-'));
      try {
        await fs.symlink(outside, path.join(root, RUN_ID));
        expect(await writeWorkflowCheckpoint(config, checkpoint())).toBe(false);
        await expect(fs.readdir(outside)).resolves.toEqual([]);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );
});

describe('claimInterruptedWorkflowRuns', () => {
  it('turns a run whose process is gone into failed history', async () => {
    await leaveRun(
      checkpoint({ args: { files: ['a.csv'] }, resumeName: 'audit' }),
      [
        { type: 'launched', version: 1 },
        { type: 'started', key: 'k1', agentId: 'a1' },
        { type: 'result', key: 'k1', agentId: 'a1', result: 'ok' },
        { type: 'started', key: 'k2', agentId: 'a2' },
      ],
    );
    const journalWrittenAt = (
      await fs.stat(path.join(root, RUN_ID, 'journal.jsonl'))
    ).mtimeMs;

    const claimed = await claimInterruptedWorkflowRuns(config, stopped);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.hasJournal).toBe(true);
    expect(claimed[0]!.resumeName).toBe('audit');
    const snapshot = await readWorkflowSnapshot(config, RUN_ID);
    expect(snapshot).toEqual(claimed[0]!.snapshot);
    expect(snapshot).toMatchObject({
      runId: RUN_ID,
      status: 'failed',
      error: INTERRUPTED_WORKFLOW_ERROR,
      meta: { name: 'audit', description: 'Audit the repo' },
      script: 'return await agent("work")',
      args: { files: ['a.csv'] },
      agentsDispatched: 2,
      agentsCompleted: 1,
      startTime: 1_700_000_000_000,
      endTime: journalWrittenAt,
    });
    // Claimed once: the checkpoint is gone, and the run is ordinary history.
    expect(await readWorkflowCheckpoint(config, RUN_ID)).toBeUndefined();
    expect(await claimInterruptedWorkflowRuns(config, stopped)).toEqual([]);
    expect((await listWorkflowSnapshots(config)).map((s) => s.runId)).toEqual([
      RUN_ID,
    ]);
    // The journal stays: it is what a resume replays.
    await expect(
      fs.access(path.join(root, RUN_ID, 'journal.jsonl')),
    ).resolves.toBeUndefined();
  });

  it('leaves a run alone while the process that wrote it is running', async () => {
    await leaveRun(checkpoint());

    const claimed = await claimInterruptedWorkflowRuns(config, {
      isProcessRunning: (pid) => pid === DEAD_PID,
    });

    expect(claimed).toEqual([]);
    expect(await readWorkflowSnapshot(config, RUN_ID)).toBeUndefined();
    expect(await readWorkflowCheckpoint(config, RUN_ID)).toBeDefined();
  });

  it('leaves a run alone when it was written on another machine', async () => {
    await leaveRun(checkpoint({ hostname: `${os.hostname()}-other` }));

    expect(await claimInterruptedWorkflowRuns(config, stopped)).toEqual([]);
    expect(await readWorkflowCheckpoint(config, RUN_ID)).toBeDefined();
  });

  it('asks this process, not the pid, about a run this process wrote', async () => {
    await leaveRun(checkpoint({ pid: process.pid }));
    const release = markWorkflowRunPersistenceActive(config, RUN_ID);
    try {
      // Some session here still has it: not interrupted.
      expect(await claimInterruptedWorkflowRuns(config, stopped)).toEqual([]);
    } finally {
      release();
    }
    // An earlier process that happened to have our pid left it.
    const claimed = await claimInterruptedWorkflowRuns(config, {
      isProcessRunning: () => true,
    });
    expect(claimed.map((run) => run.snapshot.runId)).toEqual([RUN_ID]);
  });

  it('claims a run once when sessions of one process claim at the same time', async () => {
    await leaveRun(checkpoint());

    const [first, second] = await Promise.all([
      claimInterruptedWorkflowRuns(config, stopped),
      claimInterruptedWorkflowRuns(config, stopped),
    ]);

    expect(first.length + second.length).toBe(1);
  });

  it('does not claim a run a resume is starting', async () => {
    await leaveRun(checkpoint());
    const key = getWorkflowTaskMutationKey(config, RUN_ID);

    // A resume holds the run's lock while it starts, and is active once it has.
    await tryWithWorkflowTaskMutation(key, async () => {
      expect(await claimInterruptedWorkflowRuns(config, stopped)).toEqual([]);
    });
    expect(await readWorkflowCheckpoint(config, RUN_ID)).toBeDefined();
  });

  it('does not claim a run whose checkpoint was rewritten since it was read', async () => {
    await leaveRun(checkpoint());
    const resumed = checkpoint({ startTime: 1_800_000_000_000 });

    const claimed = await claimInterruptedWorkflowRuns(config, {
      // Between the scan and the claim, a resume in another process starts.
      isProcessRunning: () => {
        writeFileSync(
          path.join(root, RUN_ID, 'checkpoint.json'),
          JSON.stringify(resumed),
        );
        return false;
      },
    });

    expect(claimed).toEqual([]);
    expect(await readWorkflowSnapshot(config, RUN_ID)).toBeUndefined();
    expect(await readWorkflowCheckpoint(config, RUN_ID)).toEqual(resumed);
  });

  it('only removes a checkpoint the run outlived by settling', async () => {
    await leaveRun(checkpoint());
    const settled: WorkflowSnapshot = {
      runId: RUN_ID,
      meta: null,
      status: 'completed',
      script: 'return 1',
      phases: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: [],
      recentLogs: [],
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_001_000,
      result: 'done',
    };
    expect(await persistWorkflowSnapshot(config, settled)).toBe(true);

    expect(await claimInterruptedWorkflowRuns(config, stopped)).toEqual([]);
    expect(await readWorkflowSnapshot(config, RUN_ID)).toEqual(settled);
    expect(await readWorkflowCheckpoint(config, RUN_ID)).toBeUndefined();
  });

  it('replaces the snapshot of an earlier attempt when a resume of it was interrupted', async () => {
    await persistWorkflowSnapshot(config, {
      runId: RUN_ID,
      meta: null,
      status: 'failed',
      script: 'return 1',
      phases: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: [],
      recentLogs: [],
      startTime: 1_600_000_000_000,
      endTime: 1_600_000_001_000,
      error: 'first attempt',
    });
    await leaveRun(checkpoint({ sourceRunId: RUN_ID, startMode: 'retry' }), []);

    const claimed = await claimInterruptedWorkflowRuns(config, stopped);

    expect(claimed).toHaveLength(1);
    expect(await readWorkflowSnapshot(config, RUN_ID)).toMatchObject({
      error: INTERRUPTED_WORKFLOW_ERROR,
      startTime: 1_700_000_000_000,
      sourceRunId: RUN_ID,
      startMode: 'retry',
    });
  });

  it('says so when the run has no journal left to resume from', async () => {
    await leaveRun(checkpoint({ argsOmitted: true }));
    await fs.rm(path.join(root, RUN_ID, 'journal.jsonl'));

    const [run] = await claimInterruptedWorkflowRuns(config, stopped);

    expect(run!.hasJournal).toBe(false);
    expect(run!.snapshot).toMatchObject({
      argsOmitted: true,
      agentsDispatched: 0,
      endTime: 1_700_000_000_000,
    });
  });

  it('skips run directories without a checkpoint and names that are not runs', async () => {
    await fs.mkdir(path.join(root, 'wf_00000000'));
    await fs.mkdir(path.join(root, 'generated'));
    await fs.mkdir(path.join(root, 'not-a-run'));
    await fs.writeFile(
      path.join(root, 'not-a-run', 'checkpoint.json'),
      JSON.stringify(checkpoint({ runId: 'not-a-run' })),
    );

    expect(await claimInterruptedWorkflowRuns(config, stopped)).toEqual([]);
  });

  it('returns nothing without storage or a runs directory', async () => {
    expect(
      await claimInterruptedWorkflowRuns({} as unknown as Config, stopped),
    ).toEqual([]);
    await fs.rm(root, { recursive: true, force: true });
    expect(await claimInterruptedWorkflowRuns(config, stopped)).toEqual([]);
  });
});
