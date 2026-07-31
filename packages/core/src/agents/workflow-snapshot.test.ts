/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import {
  toSnapshot,
  writeWorkflowSnapshot,
  listWorkflowSnapshots,
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
    agentsDispatched: 3,
    agentsCompleted: 3,
    recentLogs: ['log1'],
    tokensSpent: 450,
    tokenBudgetTotal: 1000,
    perPhaseTokens: new Map<string | null, number>([
      ['Plan', 200],
      [null, 50],
    ]),
    script: 'return 1;',
    result: { answer: 42 },
    ...overrides,
  };
}

describe('toSnapshot', () => {
  it('flattens perPhaseTokens Map into [phaseOrNull, tokens] pairs', () => {
    const s = toSnapshot(task());
    expect(s.perPhaseTokens).toEqual([
      ['Plan', 200],
      [null, 50],
    ]);
    expect(s.runId).toBe('wf_a');
    expect(s.script).toBe('return 1;');
    expect(s.result).toEqual({ answer: 42 });
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
    expect(s.phases).toEqual(['Plan', 'Build']);
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
