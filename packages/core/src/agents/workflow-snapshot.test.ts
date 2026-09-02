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
  writeWorkflowSnapshot,
  listWorkflowSnapshots,
  deleteWorkflowSnapshot,
  MAX_RETAINED_SNAPSHOTS,
} from './workflow-snapshot.js';
import type { WorkflowTask } from './workflow-run-registry.js';

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

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-snap-mod-'));
  });
  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('round-trips a snapshot through disk', async () => {
    const config = fakeConfig(projectDir);
    await writeWorkflowSnapshot(config, task({ runId: 'wf_rt' }));
    const list = await listWorkflowSnapshots(config);
    expect(list).toHaveLength(1);
    expect(list[0].runId).toBe('wf_rt');
    expect(list[0].perPhaseTokens).toEqual([
      ['Plan', 200],
      [null, 50],
    ]);
    expect(list[0].events).toEqual([
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
    ]);
  });

  it('loads a legacy snapshot without an event ledger', async () => {
    const config = fakeConfig(projectDir);
    await writeWorkflowSnapshot(config, task({ runId: 'wf_legacy' }));
    const snapshotPath = config.storage.getWorkflowRunSnapshotPath('wf_legacy');
    const parsed = JSON.parse(
      await fs.readFile(snapshotPath, 'utf8'),
    ) as Record<string, unknown>;
    delete parsed['events'];
    delete parsed['phaseVisits'];
    delete parsed['dispatches'];
    delete parsed['description'];
    await fs.writeFile(snapshotPath, JSON.stringify(parsed), 'utf8');

    const list = await listWorkflowSnapshots(config);

    expect(list).toHaveLength(1);
    expect(list[0].events).toBeUndefined();
  });

  it('freezes the snapshot projection before the first fs await', async () => {
    // R11-27: in-flight dispatches keep mutating the live entry across
    // the fs yields — a projection captured after the first await would
    // freeze the snapshot at an fs-timing-dependent point mid-drain
    // (agents_completed reading higher than the settlement value).
    const config = fakeConfig(projectDir);
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
    const list = await listWorkflowSnapshots(config);
    expect(list).toHaveLength(1);
    // The settlement value, not the post-await drained value.
    expect(list[0].agentsCompleted).toBe(1);
  });

  it('lists newest-first by startTime', async () => {
    const config = fakeConfig(projectDir);
    await writeWorkflowSnapshot(
      config,
      task({ runId: 'wf_old', startTime: 1_000 }),
    );
    await writeWorkflowSnapshot(
      config,
      task({ runId: 'wf_new', startTime: 9_000 }),
    );
    const list = await listWorkflowSnapshots(config);
    expect(list.map((s) => s.runId)).toEqual(['wf_new', 'wf_old']);
  });

  it('returns [] when the workflows dir does not exist', async () => {
    const list = await listWorkflowSnapshots(fakeConfig(projectDir));
    expect(list).toEqual([]);
  });

  it('skips unparseable snapshot files', async () => {
    const config = fakeConfig(projectDir);
    await writeWorkflowSnapshot(config, task({ runId: 'wf_good' }));
    const dir = config.storage.getWorkflowRunsDir();
    await fs.writeFile(path.join(dir, 'broken.json'), '{ not json', 'utf8');
    const list = await listWorkflowSnapshots(config);
    expect(list.map((s) => s.runId)).toEqual(['wf_good']);
  });

  it('skips parseable files that do not match the snapshot contract', async () => {
    const config = fakeConfig(projectDir);
    await writeWorkflowSnapshot(config, task({ runId: 'wf_good' }));
    const dir = config.storage.getWorkflowRunsDir();
    await fs.writeFile(
      path.join(dir, 'wf_invalid.json'),
      JSON.stringify({ runId: 'wf_invalid', status: 'completed' }),
      'utf8',
    );

    const list = await listWorkflowSnapshots(config);

    expect(list.map((s) => s.runId)).toEqual(['wf_good']);
  });

  it('deletes one saved run and its resume journal', async () => {
    const config = fakeConfig(projectDir);
    const runId = 'wf_abcd';
    await writeWorkflowSnapshot(config, task({ runId }));
    const journalPath = config.storage.getWorkflowRunJournalPath(runId);
    await fs.mkdir(path.dirname(journalPath), { recursive: true });
    await fs.writeFile(journalPath, '{}\n', 'utf8');

    await expect(deleteWorkflowSnapshot(config, runId)).resolves.toBe(true);

    await expect(
      fs.access(config.storage.getWorkflowRunSnapshotPath(runId)),
    ).rejects.toThrow();
    await expect(fs.access(path.dirname(journalPath))).rejects.toThrow();
    await expect(listWorkflowSnapshots(config)).resolves.toEqual([]);
  });

  it('keeps the snapshot and reports failure when journal deletion fails', async () => {
    const config = fakeConfig(projectDir);
    const runId = 'wf_dead';
    await writeWorkflowSnapshot(config, task({ runId }));
    const journalPath = config.storage.getWorkflowRunJournalPath(runId);
    await fs.mkdir(path.dirname(journalPath), { recursive: true });
    await fs.writeFile(journalPath, '{}\n', 'utf8');
    const rmSpy = vi
      .spyOn(fs, 'rm')
      .mockRejectedValueOnce(
        Object.assign(new Error('busy'), { code: 'EBUSY' }),
      );

    await expect(deleteWorkflowSnapshot(config, runId)).resolves.toBe(false);
    expect(rmSpy).toHaveBeenCalledTimes(1);

    rmSpy.mockRestore();
    await expect(
      fs.access(config.storage.getWorkflowRunSnapshotPath(runId)),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.dirname(journalPath))).resolves.toBeUndefined();
  });

  it('rejects traversal-shaped run ids without touching project files', async () => {
    const config = fakeConfig(projectDir);
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
    const config = fakeConfig(projectDir);
    const runId = 'wf_abcd';
    await writeWorkflowSnapshot(config, task({ runId }));
    const snapshotPath = config.storage.getWorkflowRunSnapshotPath(runId);

    await expect(deleteWorkflowSnapshot(config, `${runId}.json`)).resolves.toBe(
      false,
    );

    await expect(fs.access(snapshotPath)).resolves.toBeUndefined();
  });

  it('prunes the oldest beyond MAX_RETAINED_SNAPSHOTS, journal dirs too', async () => {
    const config = fakeConfig(projectDir);
    const dir = config.storage.getWorkflowRunsDir();
    const total = MAX_RETAINED_SNAPSHOTS + 4;
    for (let i = 0; i < total; i++) {
      const runId = `wf_${i}`;
      // Each run also has a sibling journal dir; prune must remove both.
      await fs.mkdir(`${dir}/${runId}`, { recursive: true });
      await fs.writeFile(`${dir}/${runId}/journal.jsonl`, '{}\n', 'utf8');
      // Distinct runId per write; startTime ascending. Each write prunes.
      await writeWorkflowSnapshot(
        config,
        task({ runId, startTime: 1_000 + i }),
      );
    }
    const entries = await fs.readdir(dir);
    const files = entries.filter((f) => f.endsWith('.json'));
    const journalDirs = entries.filter((f) => /^wf_\d+$/.test(f));
    expect(files.length).toBe(MAX_RETAINED_SNAPSHOTS);
    // The pruned runs' journal directories are gone too (no orphan leak).
    expect(journalDirs.length).toBe(MAX_RETAINED_SNAPSHOTS);
  });

  // Security: prune derives `runId` from the snapshot filename and feeds it to
  // a recursive `fs.rm`. A crafted `.json` name must NOT let that delete
  // anything but a well-formed `wf_<hex>` run dir — a file named `...json`
  // yields `runId = ".."` (parent dir), `notarun.json` yields a sibling dir.
  it('does not recursively delete via a crafted snapshot filename (path traversal)', async () => {
    const config = fakeConfig(projectDir);
    const dir = config.storage.getWorkflowRunsDir();
    await fs.mkdir(dir, { recursive: true });

    // Canary in the runs dir's PARENT — a `..` traversal would delete it.
    const canary = path.join(dir, '..', 'CANARY.txt');
    await fs.writeFile(canary, 'keep', 'utf8');
    // A non-run sibling dir INSIDE the runs dir — a `notarun.json` stem targets it.
    await fs.mkdir(path.join(dir, 'notarun'), { recursive: true });
    await fs.writeFile(path.join(dir, 'notarun', 'keep.txt'), 'keep', 'utf8');

    // Fill to the cap with legit run snapshots (no prune yet at == cap).
    for (let i = 0; i < MAX_RETAINED_SNAPSHOTS; i++) {
      await writeWorkflowSnapshot(
        config,
        task({ runId: `wf_${i.toString(16)}`, startTime: 10_000 + i }),
      );
    }
    // Plant two malicious snapshot files as the OLDEST (pruned first):
    //   `...json`      → stem `..`      → would rm the parent (project root)
    //   `notarun.json` → stem `notarun` → would rm the sibling dir
    for (const name of ['...json', 'notarun.json']) {
      const p = path.join(dir, name);
      await fs.writeFile(p, '{}', 'utf8');
      await fs.utimes(p, new Date(0), new Date(0)); // oldest → selected to prune
    }
    // One more legit write tips the count over the cap and triggers prune.
    await writeWorkflowSnapshot(
      config,
      task({ runId: 'wf_ff', startTime: 99_999 }),
    );

    // The guard spared both the parent canary and the non-run sibling dir.
    await expect(fs.access(canary)).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(dir, 'notarun', 'keep.txt')),
    ).resolves.toBeUndefined();
  });
});
