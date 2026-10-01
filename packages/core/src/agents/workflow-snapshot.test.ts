/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import {
  toSnapshot,
  readWorkflowSnapshot,
  writeWorkflowSnapshot,
  listWorkflowSnapshots,
  deleteWorkflowSnapshot,
  snapshotArgs,
  snapshotArgsUnavailable,
  MAX_RETAINED_SNAPSHOTS,
  MAX_SNAPSHOT_ARGS_CHARS,
} from './workflow-snapshot.js';
import {
  markWorkflowRunPersistenceActive,
  type WorkflowTask,
} from './workflow-run-registry.js';

/**
 * `atomicFileWrite` imports `node:fs/promises` as a namespace, whose bindings
 * a spy cannot replace, so the only way to fail a commit is the `_testFs`
 * seam that module documents. The mock is a pass-through: every call runs the
 * real temp-and-rename, and only a test that sets the flag diverts its rename.
 */
const atomicWrite = vi.hoisted(() => ({ renameFails: false }));

vi.mock('../utils/atomicFileWrite.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/atomicFileWrite.js')>();
  return {
    ...actual,
    atomicWriteFile: (
      ...args: Parameters<typeof actual.atomicWriteFile>
    ): Promise<void> =>
      actual.atomicWriteFile(
        args[0],
        args[1],
        args[2],
        atomicWrite.renameFails
          ? {
              ...args[3],
              rename: () =>
                Promise.reject(
                  Object.assign(new Error('ENOSPC: no space left on device'), {
                    code: 'ENOSPC',
                  }),
                ),
            }
          : args[3],
      ),
  };
});

function fakeConfig(projectDir: string): Config {
  return { storage: new Storage(projectDir) } as unknown as Config;
}

function task(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    id: 'wf_a',
    kind: 'workflow',
    runId: 'wf_a',
    description: 'demo',
    meta: { name: 'demo', description: 'd' },
    status: 'completed',
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_005_000,
    outputFile: '',
    outputOffset: 0,
    notified: true,
    abortController: new AbortController(),
    currentPhase: null,
    phases: ['Plan', 'Build'],
    phaseVisits: [],
    currentPhaseVisitId: null,
    dispatches: [],
    agentsDispatched: 3,
    agentsCompleted: 3,
    recentLogs: ['log1'],
    events: [
      {
        id: 'event-1',
        type: 'log',
        at: 1_700_000_004_000,
        message: 'log1',
      },
      {
        id: 'event-2',
        type: 'workflow-completed',
        at: 1_700_000_005_000,
      },
    ],
    tokensSpent: 450,
    tokenBudgetTotal: 1000,
    perPhaseTokens: new Map<string | null, number>([
      ['Plan', 200],
      [null, 50],
    ]),
    pendingApprovals: [],
    script: 'return 1;',
    result: { answer: 42 },
    ...overrides,
  };
}

describe('toSnapshot', () => {
  it.each(['running', 'pausing', 'paused'] as const)(
    'rejects an active %s workflow',
    (status) => {
      expect(() => toSnapshot(task({ status }))).toThrow(
        'Cannot snapshot active workflow wf_a.',
      );
    },
  );

  it('flattens perPhaseTokens Map into [phaseOrNull, tokens] pairs', () => {
    const s = toSnapshot(
      task({
        description: 'Review and fix',
        toolUseId: 'workflow-call-1',
        workflowName: 'review-and-fix',
        sourceRunId: 'wf_source',
        startMode: 'rerun',
      }),
    );
    expect(s.perPhaseTokens).toEqual([
      ['Plan', 200],
      [null, 50],
    ]);
    expect(s.runId).toBe('wf_a');
    expect(s.script).toBe('return 1;');
    expect(s.result).toEqual({ answer: 42 });
    expect(s).toMatchObject({
      description: 'Review and fix',
      toolUseId: 'workflow-call-1',
      workflowName: 'review-and-fix',
      sourceRunId: 'wf_source',
      startMode: 'rerun',
    });
  });

  it('replaces a non-JSON-serializable result with a placeholder string', () => {
    const s = toSnapshot(task({ result: 10n }));
    expect(typeof s.result).toBe('string');
    expect(s.result).toMatch(/non-JSON-serializable/);
  });

  it('copies arrays defensively (snapshot is decoupled from the live entry)', () => {
    const t = task();
    const s = toSnapshot(t);
    t.phases.push('Mutated');
    t.events[0]!.at = 0;
    expect(s.phases).toEqual(['Plan', 'Build']);
    expect(s.events?.[0]?.at).toBe(1_700_000_004_000);
  });

  it('never projects live pending approval data', () => {
    const live = task({
      pendingApprovals: [
        {
          approvalId: 'APPROVAL_ID_SENTINEL',
          subagentId: 'agent-a',
          callId: 'call-1',
          name: 'Edit',
          description: 'PRIVATE_DESCRIPTION_SENTINEL',
          confirmationDetails: {
            type: 'edit',
            title: 'Edit?',
            fileName: 'secret.ts',
            filePath: '/private/secret.ts',
            fileDiff: 'PRIVATE_DIFF_SENTINEL',
            originalContent: null,
            newContent: '',
            hideAlwaysAllow: true,
            hideModify: true,
            skipIdeDiff: true,
          },
          at: 1,
        },
      ],
    });

    const serialized = JSON.stringify(toSnapshot(live));
    expect(serialized).not.toContain('APPROVAL_ID_SENTINEL');
    expect(serialized).not.toContain('PRIVATE_DESCRIPTION_SENTINEL');
    expect(serialized).not.toContain('PRIVATE_DIFF_SENTINEL');
    expect(toSnapshot(live)).not.toHaveProperty('pendingApprovals');
    expect(toSnapshot(live).events).toEqual(live.events);
  });
});

describe('writeWorkflowSnapshot + listWorkflowSnapshots', () => {
  let projectDir: string;
  let config: Config;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-snap-mod-'));
    config = fakeConfig(projectDir);
  });
  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  const write = (overrides: Partial<WorkflowTask>) =>
    writeWorkflowSnapshot(config, task(overrides));
  const read = (runId: string) => readWorkflowSnapshot(config, runId);
  const list = () => listWorkflowSnapshots(config);
  const snapshotPath = (runId: string) =>
    config.storage.getWorkflowRunSnapshotPath(runId);
  const runsDir = () => config.storage.getWorkflowRunsDir();
  const ebusy = () => Object.assign(new Error('busy'), { code: 'EBUSY' });

  /** Rewrites run `runId`'s snapshot JSON through `edit`, into `to`. */
  async function editSnapshot(
    runId: string,
    edit: (parsed: Record<string, unknown>) => void,
    to = snapshotPath(runId),
  ) {
    const parsed: Record<string, unknown> = JSON.parse(
      await fs.readFile(snapshotPath(runId), 'utf8'),
    );
    edit(parsed);
    await fs.writeFile(to, JSON.stringify(parsed), 'utf8');
  }

  /** Writes `content` at `file`, creating its directory. */
  async function writeFileAt(file: string, content: string) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
    return file;
  }
  const writeJournal = (runId: string) =>
    writeFileAt(config.storage.getWorkflowRunJournalPath(runId), '{}\n');
  const writeInlineScript = (runId: string) =>
    writeFileAt(config.storage.getInlineWorkflowScriptPath(runId), 'return 1');

  /** Writes a run with journal and inline script, its snapshot the oldest. */
  async function seedAgedRun(runId: string) {
    await write({ runId });
    const journalPath = await writeJournal(runId);
    const inlinePath = await writeInlineScript(runId);
    await fs.utimes(snapshotPath(runId), new Date(0), new Date(0));
    return { journalPath, inlinePath };
  }

  /** Writes a cap's worth of runs `wf_<prefix><hex i>`, newer than seeds. */
  async function writeCapOfRuns(prefix: string, t0: number, cfg = config) {
    for (let i = 0; i < MAX_RETAINED_SNAPSHOTS; i++) {
      const runId = `wf_${prefix}${i.toString(16)}`;
      await writeWorkflowSnapshot(cfg, task({ runId, startTime: t0 + i }));
    }
  }

  async function expectOnlySnapshotPruned(
    runId: string,
    kept: { journalPath: string; inlinePath: string },
  ) {
    await expect(fs.access(snapshotPath(runId))).rejects.toThrow();
    await expect(fs.access(kept.journalPath)).resolves.toBeUndefined();
    await expect(fs.access(kept.inlinePath)).resolves.toBeUndefined();
  }

  it('round-trips a snapshot through disk', async () => {
    await write({ runId: 'wf_rt', toolUseId: 'workflow-call-1' });
    const snapshots = await list();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].runId).toBe('wf_rt');
    expect(snapshots[0].toolUseId).toBe('workflow-call-1');
    expect(snapshots[0].perPhaseTokens).toEqual([
      ['Plan', 200],
      [null, 50],
    ]);
    expect(snapshots[0].events).toEqual(task().events);
  });

  // A resume after a restart has a run id and no registry entry, and the
  // snapshot is what still says what the run recorded about itself.
  it('reads one run back by id, its source reference included', async () => {
    await write({
      runId: 'wf_one',
      sourceRef: { id: 'definition-7', revision: 'rev-3' },
    });
    await write({ runId: 'wf_other' });

    const snapshot = await read('wf_one');
    expect(snapshot?.runId).toBe('wf_one');
    expect(snapshot?.sourceRef).toEqual({
      id: 'definition-7',
      revision: 'rev-3',
    });
    expect((await read('wf_other'))?.sourceRef).toBeUndefined();
  });

  it('reads nothing for a run with no snapshot, an unparseable one, or a file that is not one', async () => {
    await expect(read('wf_absent')).resolves.toBeUndefined();

    await writeFileAt(snapshotPath('wf_broken'), '{not json');
    await expect(read('wf_broken')).resolves.toBeUndefined();

    await fs.writeFile(
      snapshotPath('wf_other_shape'),
      JSON.stringify({ sourceRef: { id: 'a', revision: 'b' } }),
      'utf8',
    );
    await expect(read('wf_other_shape')).resolves.toBeUndefined();

    await expect(
      readWorkflowSnapshot({} as Config, 'wf_absent'),
    ).resolves.toBeUndefined();
  });

  // A retry keys its journal from a hash of the run's args, so "the run had
  // none" has to be a recorded fact rather than the absence of a field: a
  // snapshot from before args were kept looks the same and must be refused.
  // The daemon refuses a restart on this answer and the task projection
  // reports it, so the two must never disagree about one snapshot.
  it.each([
    [
      'args it kept',
      { args: { a: 1 }, argsRecorded: true } as const,
      undefined,
    ],
    ['no args, recorded as none', { argsRecorded: true } as const, undefined],
    ['args too large to keep', { argsOmitted: true } as const, 'omitted'],
    ['a snapshot from before args were kept', {}, 'unrecorded'],
  ])('says of %s why a restart has no args to use', (_case, fields, why) => {
    expect(snapshotArgsUnavailable(fields)).toBe(why);
  });

  it('records that a run had no args, and rejects a marker that is not true', async () => {
    expect(snapshotArgs(undefined)).toEqual({ argsRecorded: true });
    expect(snapshotArgs({ q: 1 })).toEqual({
      args: { q: 1 },
      argsRecorded: true,
    });
    expect(snapshotArgs('x'.repeat(MAX_SNAPSHOT_ARGS_CHARS + 1))).toEqual({
      argsOmitted: true,
    });

    await write({ runId: 'wf_none' });
    expect(await read('wf_none')).toMatchObject({ argsRecorded: true });
    expect((await read('wf_none'))?.args).toBeUndefined();

    await editSnapshot(
      'wf_none',
      (parsed) =>
        Object.assign(parsed, { runId: 'wf_bad_marker', argsRecorded: 'yes' }),
      snapshotPath('wf_bad_marker'),
    );
    await expect(read('wf_bad_marker')).resolves.toBeUndefined();
  });

  // What a snapshot holds is started as a run, not only displayed, so the
  // reader makes the two checks the checkpoint reader makes.
  it('reads nothing through a symlink, or from a file that names another run', async () => {
    await write({ runId: 'wf_real' });
    const real = snapshotPath('wf_real');

    // The shape that matters: the link points outside the runs directory at
    // a file that does name this run, so only refusing the link refuses it.
    const outside = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'wf-outside-')),
      'planted.json',
    );
    await editSnapshot(
      'wf_real',
      (parsed) => (parsed['runId'] = 'wf_planted'),
      outside,
    );
    const planted = snapshotPath('wf_planted');
    await fs.symlink(outside, planted);
    await expect(read('wf_planted')).resolves.toBeUndefined();
    // Reading it directly is what the link would have delivered.
    expect(JSON.parse(await fs.readFile(planted, 'utf8')).runId).toBe(
      'wf_planted',
    );

    // A file placed under one id that claims to be another run.
    await fs.writeFile(
      snapshotPath('wf_mismatch'),
      await fs.readFile(real, 'utf8'),
      'utf8',
    );
    await expect(read('wf_mismatch')).resolves.toBeUndefined();

    // The run's own snapshot still reads.
    expect((await read('wf_real'))?.runId).toBe('wf_real');
  });

  it('loads a legacy snapshot without an event ledger', async () => {
    await write({ runId: 'wf_legacy' });
    await editSnapshot('wf_legacy', (parsed) => {
      delete parsed['events'];
      delete parsed['phaseVisits'];
      delete parsed['dispatches'];
      delete parsed['description'];
    });

    const snapshots = await list();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].events).toBeUndefined();
  });

  // Snapshots written before resume respawns were counted have no field for
  // it. An old run's history is worth more than a uniform shape, so the
  // validator accepts its absence rather than discarding the run.
  it('loads a snapshot written before respawns were counted', async () => {
    await write({ runId: 'wf_prerespawn' });
    await editSnapshot('wf_prerespawn', (parsed) => {
      expect(parsed['agentsRespawned']).toBe(0);
      delete parsed['agentsRespawned'];
    });

    const snapshots = await list();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].agentsRespawned).toBeUndefined();
  });

  // The large-run flag is history worth keeping: a run's snapshot is what the
  // user reads after the fact to see why it was big. Older snapshots have no
  // flag and still load; a malformed one is not trusted.
  it('keeps the large-run flag, and loads snapshots without one', async () => {
    const sizeWarning = {
      axis: 'agents' as const,
      scheduledAgents: 16,
      totalTokens: 0,
      projectedTokens: 1_120_000,
      agentCap: 15,
      tokenCap: 1_500_000,
      capFromGuideline: true,
      at: 1_700_000_000_500,
    };
    await write({ runId: 'wf_sized', sizeWarning });
    await write({ runId: 'wf_unsized', startTime: 1_700_000_000_001 });

    const snapshots = await list();

    expect(snapshots.find((s) => s.runId === 'wf_sized')?.sizeWarning).toEqual(
      sizeWarning,
    );
    expect(
      snapshots.find((s) => s.runId === 'wf_unsized')?.sizeWarning,
    ).toBeUndefined();
  });

  it('discards a snapshot whose size warning is malformed', async () => {
    await write({ runId: 'wf_badsize' });
    await editSnapshot('wf_badsize', (parsed) => {
      parsed['sizeWarning'] = { axis: 'time' };
    });

    expect(await list()).toHaveLength(0);
  });

  it('records the respawn count it was given', async () => {
    await write({ runId: 'wf_respawned', agentsRespawned: 2 });

    const snapshots = await list();

    expect(snapshots[0].agentsRespawned).toBe(2);
  });

  it('freezes the snapshot projection before the first fs await', async () => {
    // R11-27: in-flight dispatches keep mutating the live entry across
    // the fs yields — a projection captured after the first await would
    // freeze the snapshot at an fs-timing-dependent point mid-drain
    // (agents_completed reading higher than the settlement value).
    const t = task({ runId: 'wf_freeze', agentsCompleted: 1 });
    const realMkdir = fs.mkdir.bind(fs);
    const mkdirSpy = vi
      .spyOn(fs, 'mkdir')
      .mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
        // Simulate an in-flight dispatch draining across the yield.
        t.agentsCompleted += 1;
        return realMkdir(...args);
      });
    try {
      await writeWorkflowSnapshot(config, t);
    } finally {
      mkdirSpy.mockRestore();
    }
    const snapshots = await list();
    expect(snapshots).toHaveLength(1);
    // The settlement value, not the post-await drained value.
    expect(snapshots[0].agentsCompleted).toBe(1);
  });

  // A snapshot carries the run's script and up to 256 KiB of args, so the
  // write is long enough to be interrupted -- and a torn file fails
  // validation on read, dropping the run from the history it is there to
  // preserve.
  it('keeps the previous snapshot whole when the write cannot be committed', async () => {
    await write({ runId: 'wf_torn', agentsCompleted: 3 });
    const file = snapshotPath('wf_torn');
    const before = await fs.readFile(file, 'utf8');

    atomicWrite.renameFails = true;
    try {
      await expect(
        write({ runId: 'wf_torn', agentsCompleted: 99 }),
      ).resolves.toBe(false);
    } finally {
      atomicWrite.renameFails = false;
    }

    // Not half of the new snapshot, and not the new one either: the run is
    // still in history, exactly as it was.
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect((await read('wf_torn'))?.agentsCompleted).toBe(3);
    // And the failure leaves nothing behind for the sweep to find.
    expect(
      (await fs.readdir(runsDir())).filter((f) => f.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('writes a snapshot the project owner alone can read', async () => {
    await write({ runId: 'wf_mode' });
    const stat = await fs.stat(snapshotPath('wf_mode'));
    // Matches the run's journal, checkpoint and persisted script: it holds
    // the same script and args they do.
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('neither lists nor prunes a temp file from an unfinished write', async () => {
    await write({ runId: 'wf_keep' });
    // Named exactly as an interrupted write would leave it, and young
    // enough that the sweep must leave it alone.
    const temp = path.join(runsDir(), 'wf_bee9.json.0123456789ab.tmp');
    await fs.writeFile(temp, 'half a snapshot', 'utf8');

    expect((await list()).map((s) => s.runId)).toEqual(['wf_keep']);

    await write({ runId: 'wf_keep' });
    await expect(fs.readFile(temp, 'utf8')).resolves.toBe('half a snapshot');
  });

  it('sweeps a snapshot temp file once it is too old to be in flight', async () => {
    await write({ runId: 'wf_sweep' });
    const dir = runsDir();
    const stale = path.join(dir, 'wf_dead1.json.abcdef012345.tmp');
    const inFlight = path.join(dir, 'wf_beef2.json.abcdef012345.tmp');
    const notOurs = path.join(dir, 'editor-scratch.tmp');
    for (const file of [stale, inFlight, notOurs]) {
      await fs.writeFile(file, 'x', 'utf8');
    }
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(stale, longAgo, longAgo);
    await fs.utimes(notOurs, longAgo, longAgo);

    await write({ runId: 'wf_sweep' });

    await expect(fs.access(stale)).rejects.toThrow();
    // A write in another process may still be holding this one.
    await expect(fs.access(inFlight)).resolves.toBeUndefined();
    // Only this module's own temp naming is swept, however old.
    await expect(fs.access(notOurs)).resolves.toBeUndefined();
  });

  it('lists newest-first by startTime', async () => {
    await write({ runId: 'wf_old', startTime: 1_000 });
    await write({ runId: 'wf_new', startTime: 9_000 });
    expect((await list()).map((s) => s.runId)).toEqual(['wf_new', 'wf_old']);
  });

  it('returns [] when the workflows dir does not exist', async () => {
    expect(await list()).toEqual([]);
  });

  it('skips unparseable snapshot files', async () => {
    await write({ runId: 'wf_good' });
    await fs.writeFile(
      path.join(runsDir(), 'broken.json'),
      '{ not json',
      'utf8',
    );
    expect((await list()).map((s) => s.runId)).toEqual(['wf_good']);
  });

  it('skips parseable files that do not match the snapshot contract', async () => {
    await write({ runId: 'wf_good' });
    await fs.writeFile(
      path.join(runsDir(), 'wf_invalid.json'),
      JSON.stringify({ runId: 'wf_invalid', status: 'completed' }),
      'utf8',
    );

    expect((await list()).map((s) => s.runId)).toEqual(['wf_good']);
  });

  it('deletes one saved run and its resume journal', async () => {
    const runId = 'wf_abcd';
    await write({ runId });
    const journalPath = await writeJournal(runId);
    const inlinePath = await writeInlineScript(runId);

    await expect(deleteWorkflowSnapshot(config, runId)).resolves.toBe(true);

    await expect(fs.access(snapshotPath(runId))).rejects.toThrow();
    await expect(fs.access(path.dirname(journalPath))).rejects.toThrow();
    await expect(fs.access(inlinePath)).rejects.toThrow();
    await expect(list()).resolves.toEqual([]);
  });

  it('keeps the snapshot and reports failure when journal deletion fails', async () => {
    const runId = 'wf_dead';
    await write({ runId });
    const journalPath = await writeJournal(runId);
    const rmSpy = vi.spyOn(fs, 'rm').mockRejectedValueOnce(ebusy());

    await expect(deleteWorkflowSnapshot(config, runId)).resolves.toBe(false);
    expect(rmSpy).toHaveBeenCalledTimes(1);

    rmSpy.mockRestore();
    await expect(fs.access(snapshotPath(runId))).resolves.toBeUndefined();
    await expect(fs.access(path.dirname(journalPath))).resolves.toBeUndefined();
  });

  it('keeps the snapshot when inline script deletion fails', async () => {
    const runId = 'wf_dead';
    await write({ runId });
    const inlinePath = await writeInlineScript(runId);
    const rmSpy = vi
      .spyOn(fs, 'rm')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(ebusy());

    await expect(deleteWorkflowSnapshot(config, runId)).resolves.toBe(false);

    rmSpy.mockRestore();
    await expect(fs.access(snapshotPath(runId))).resolves.toBeUndefined();
    await expect(fs.access(inlinePath)).resolves.toBeUndefined();
  });

  it('rejects traversal-shaped run ids without touching project files', async () => {
    // Extensionless on purpose: for input '../CANARY' an unguarded recursive
    // rm targets <projectDir>/CANARY exactly, so bypassing the guard makes
    // the read-back below fail instead of only the boolean assertion.
    const canary = path.join(projectDir, 'CANARY');
    await fs.writeFile(canary, 'keep', 'utf8');

    await expect(deleteWorkflowSnapshot(config, '../CANARY')).resolves.toBe(
      false,
    );
    await expect(deleteWorkflowSnapshot(config, 'wf_bad/path')).resolves.toBe(
      false,
    );

    await expect(fs.readFile(canary, 'utf8')).resolves.toBe('keep');
  });

  it('rejects malformed run ids without deleting another snapshot', async () => {
    const runId = 'wf_abcd';
    await write({ runId });

    await expect(deleteWorkflowSnapshot(config, `${runId}.json`)).resolves.toBe(
      false,
    );

    await expect(fs.access(snapshotPath(runId))).resolves.toBeUndefined();
  });

  it('prunes the oldest beyond MAX_RETAINED_SNAPSHOTS, journal dirs too', async () => {
    const dir = runsDir();
    const total = MAX_RETAINED_SNAPSHOTS + 4;
    for (let i = 0; i < total; i++) {
      const runId = `wf_${i}`;
      // Each run also has a sibling journal dir; prune must remove both.
      await fs.mkdir(`${dir}/${runId}`, { recursive: true });
      await fs.writeFile(`${dir}/${runId}/journal.jsonl`, '{}\n', 'utf8');
      // Distinct runId per write; startTime ascending. Each write prunes.
      await write({ runId, startTime: 1_000 + i });
    }
    const entries = await fs.readdir(dir);
    const files = entries.filter((f) => f.endsWith('.json'));
    const journalDirs = entries.filter((f) => /^wf_\d+$/.test(f));
    expect(files.length).toBe(MAX_RETAINED_SNAPSHOTS);
    // The pruned runs' journal directories are gone too (no orphan leak).
    expect(journalDirs.length).toBe(MAX_RETAINED_SNAPSHOTS);
  });

  // An inline run leaves a third artifact — its persisted source. Retiring
  // the snapshot and the journal while the script stays would let those
  // accumulate for runs nothing can name any more.
  it('prunes the persisted inline script alongside the snapshot', async () => {
    const inlineDir = path.dirname(
      config.storage.getInlineWorkflowScriptPath('wf_0'),
    );
    await fs.mkdir(inlineDir, { recursive: true });
    // A file whose stem is not a well-formed run id must survive: prune only
    // removes what the `wf_<hex>` gate admits.
    const stranger = path.join(inlineDir, 'notarun.js');
    await fs.writeFile(stranger, 'keep', 'utf8');

    const total = MAX_RETAINED_SNAPSHOTS + 2;
    for (let i = 0; i < total; i++) {
      const runId = `wf_${i.toString(16)}`;
      await fs.writeFile(
        path.join(inlineDir, `${runId}.js`),
        'return 1',
        'utf8',
      );
      await write({ runId, startTime: 1_000 + i });
    }

    const scripts = (await fs.readdir(inlineDir)).filter((f) =>
      f.startsWith('wf_'),
    );
    expect(scripts.length).toBe(MAX_RETAINED_SNAPSHOTS);
    // The oldest two runs lost their scripts with their snapshots.
    expect(scripts).not.toContain('wf_0.js');
    expect(scripts).not.toContain('wf_1.js');
    await expect(fs.readFile(stranger, 'utf8')).resolves.toBe('keep');
  });

  it('keeps live run artifacts while pruning its stale snapshot', async () => {
    const liveRunId = 'wf_a0';
    const kept = await seedAgedRun(liveRunId);
    Object.assign(config, {
      getWorkflowRunRegistry: () => ({
        list: () => [task({ runId: liveRunId, status: 'running' })],
        listStartingRunIds: () => [],
      }),
    });

    await writeCapOfRuns('b', 2_000);

    await expectOnlySnapshotPruned(liveRunId, kept);
  });

  it('keeps starting run artifacts while pruning its stale snapshot', async () => {
    const runId = 'wf_a1';
    const kept = await seedAgedRun(runId);
    Object.assign(config, {
      getWorkflowRunRegistry: () => ({
        list: () => [],
        listStartingRunIds: () => [runId],
      }),
    });

    await writeCapOfRuns('c', 3_000);

    await expectOnlySnapshotPruned(runId, kept);
  });

  it('keeps sibling-session live artifacts while pruning', async () => {
    const ownerConfig = config;
    const pruningConfig = fakeConfig(projectDir);
    const runId = 'wf_a2';
    const kept = await seedAgedRun(runId);
    const release = markWorkflowRunPersistenceActive(ownerConfig, runId);

    try {
      await writeCapOfRuns('d', 4_000, pruningConfig);
    } finally {
      release();
    }

    await expectOnlySnapshotPruned(runId, kept);
  });

  // Security: prune derives `runId` from the snapshot filename and feeds it to
  // a recursive `fs.rm`. A crafted `.json` name must NOT let that delete
  // anything but a well-formed `wf_<hex>` run dir — a file named `...json`
  // yields `runId = ".."` (parent dir), `notarun.json` yields a sibling dir.
  it('does not recursively delete via a crafted snapshot filename (path traversal)', async () => {
    const dir = runsDir();
    await fs.mkdir(dir, { recursive: true });

    // Canary in the runs dir's PARENT — a `..` traversal would delete it.
    const canary = path.join(dir, '..', 'CANARY.txt');
    await fs.writeFile(canary, 'keep', 'utf8');
    // A non-run sibling dir INSIDE the runs dir — a `notarun.json` stem targets it.
    await fs.mkdir(path.join(dir, 'notarun'), { recursive: true });
    await fs.writeFile(path.join(dir, 'notarun', 'keep.txt'), 'keep', 'utf8');

    // Fill to the cap with legit run snapshots (no prune yet at == cap).
    await writeCapOfRuns('', 10_000);
    // Plant two malicious snapshot files as the OLDEST (pruned first):
    //   `...json`      → stem `..`      → would rm the parent (project root)
    //   `notarun.json` → stem `notarun` → would rm the sibling dir
    for (const name of ['...json', 'notarun.json']) {
      const p = path.join(dir, name);
      await fs.writeFile(p, '{}', 'utf8');
      await fs.utimes(p, new Date(0), new Date(0)); // oldest → selected to prune
    }
    // One more legit write tips the count over the cap and triggers prune.
    await write({ runId: 'wf_ff', startTime: 99_999 });

    // The guard spared both the parent canary and the non-run sibling dir.
    await expect(fs.access(canary)).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(dir, 'notarun', 'keep.txt')),
    ).resolves.toBeUndefined();
  });
});
