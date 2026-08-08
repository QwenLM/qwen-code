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
  MAX_WORKFLOW_ARGS_BYTES,
  WORKFLOW_MANIFEST_SCHEMA_VERSION,
  WORKFLOW_RUNTIME_VERSION,
  listWorkflowRunRecords,
  readWorkflowManifest,
  toSnapshot,
  writeWorkflowManifest,
  writeWorkflowSnapshot,
  listWorkflowSnapshots,
  MAX_RETAINED_SNAPSHOTS,
} from './workflow-snapshot.js';
import type { WorkflowTask } from './workflow-run-registry.js';
import {
  WorkflowJournal,
  type JournalCheckpoint,
} from './runtime/workflow-journal.js';

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
    pendingApprovals: [],
    script: 'return 1;',
    result: { answer: 42 },
    ...overrides,
  };
}

const EMPTY_JOURNAL: JournalCheckpoint = {
  version: 1,
  keyVersion: 'v2',
  byteLength: 0,
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  integrity: 'complete',
};

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

  it('freezes the snapshot projection before the first fs await', async () => {
    // R11-27: in-flight dispatches keep mutating the live entry across
    // the fs yields — a projection captured after the first await would
    // freeze the snapshot at an fs-timing-dependent point mid-drain
    // (agents_completed reading higher than the settlement value).
    const config = fakeConfig(projectDir);
    const t = task({
      runId: 'wf_freeze',
      agentsCompleted: 1,
      meta: { name: 'demo', description: 'before' },
      result: { nested: { value: 'before' } },
    });
    const realMkdir = fs.mkdir.bind(fs);
    const mkdirSpy = vi
      .spyOn(fs, 'mkdir')
      .mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
        // Simulate an in-flight dispatch draining across the yield.
        t.agentsCompleted += 1;
        t.meta!.description = 'after';
        (t.result as { nested: { value: string } }).nested.value = 'after';
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
    expect(list[0].meta?.description).toBe('before');
    expect(list[0].result).toEqual({ nested: { value: 'before' } });
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

  it.runIf(process.platform !== 'win32')(
    'does not follow a matching run-directory symlink while pruning',
    async () => {
      const config = fakeConfig(projectDir);
      const dir = config.storage.getWorkflowRunsDir();
      const outside = path.join(projectDir, 'outside-run');
      await fs.mkdir(dir, { recursive: true });
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, 'CANARY.txt'), 'keep', 'utf8');
      await fs.symlink(outside, path.join(dir, 'wf_dead'), 'dir');
      const oldest = path.join(dir, 'wf_dead.json');
      await fs.writeFile(oldest, '{}', 'utf8');
      await fs.utimes(oldest, new Date(0), new Date(0));

      for (let i = 0; i < MAX_RETAINED_SNAPSHOTS; i++) {
        await writeWorkflowSnapshot(
          config,
          task({ runId: `wf_${i.toString(16)}`, startTime: 10_000 + i }),
        );
      }

      await expect(
        fs.readFile(path.join(outside, 'CANARY.txt'), 'utf8'),
      ).resolves.toBe('keep');
    },
  );
});

describe('durable workflow manifests', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-manifest-'));
  });
  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('writes a current manifest atomically with exact replay inputs', async () => {
    const config = fakeConfig(projectDir);
    const t = task({
      runId: 'wf_a1b2',
      status: 'paused',
      script: 'export default async ({ value }) => value;',
      scriptPath: '/trusted/project/.qwen/workflows/demo.js',
    });
    const manifest = await writeWorkflowManifest(config, t, {
      args: { value: 'hello' },
      journal: EMPTY_JOURNAL,
      checkpointAt: 1_700_000_004_000,
    });

    expect(manifest).toMatchObject({
      schemaVersion: WORKFLOW_MANIFEST_SCHEMA_VERSION,
      runtimeVersion: WORKFLOW_RUNTIME_VERSION,
      runId: 'wf_a1b2',
      status: 'paused',
      script: 'export default async ({ value }) => value;',
      scriptPath: '/trusted/project/.qwen/workflows/demo.js',
      args: { value: 'hello' },
      checkpointAt: 1_700_000_004_000,
      journal: EMPTY_JOURNAL,
      canResume: true,
    });
    expect(manifest?.scriptHash).toMatch(/^[0-9a-f]{64}$/);

    const manifestPath = config.storage.getWorkflowRunManifestPath('wf_a1b2');
    const stat = await fs.stat(manifestPath);
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
    expect(
      (await fs.readdir(config.storage.getWorkflowRunDir('wf_a1b2'))).filter(
        (name) => name.endsWith('.tmp'),
      ),
    ).toEqual([]);
    await expect(readWorkflowManifest(config, 'wf_a1b2')).resolves.toEqual(
      manifest,
    );
  });

  it('atomically replaces an existing manifest inode', async () => {
    const config = fakeConfig(projectDir);
    const runId = 'wf_a70c';
    const t = task({ runId, status: 'running' });
    await writeWorkflowManifest(config, t, {
      args: null,
      journal: EMPTY_JOURNAL,
      checkpointAt: 1,
    });
    const manifestPath = config.storage.getWorkflowRunManifestPath(runId);
    const before = await fs.stat(manifestPath);

    await writeWorkflowManifest(config, t, {
      args: null,
      journal: EMPTY_JOURNAL,
      checkpointAt: 2,
    });
    const after = await fs.stat(manifestPath);

    if (process.platform !== 'win32') {
      expect(after.ino).not.toBe(before.ino);
    }
    expect((await readWorkflowManifest(config, runId)).checkpointAt).toBe(2);
  });

  it('freezes the manifest before the first filesystem await', async () => {
    const config = fakeConfig(projectDir);
    const t = task({
      runId: 'wf_a11ce',
      status: 'running',
      agentsCompleted: 1,
      meta: { name: 'demo', description: 'before' },
      result: { nested: { value: 'before' } },
    });
    const journal = { ...EMPTY_JOURNAL };
    const realMkdir = fs.mkdir.bind(fs);
    let mutated = false;
    const mkdirSpy = vi
      .spyOn(fs, 'mkdir')
      .mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
        if (!mutated) {
          mutated = true;
          t.agentsCompleted = 2;
          t.phases.push('Late');
          t.meta!.description = 'after';
          (t.result as { nested: { value: string } }).nested.value = 'after';
          journal.byteLength = 100;
        }
        return realMkdir(...args);
      });
    try {
      await writeWorkflowManifest(config, t, {
        args: null,
        journal,
        status: 'paused',
      });
    } finally {
      mkdirSpy.mockRestore();
    }

    const manifest = await readWorkflowManifest(config, t.runId);
    expect(manifest).toMatchObject({
      status: 'paused',
      agentsCompleted: 1,
      phases: ['Plan', 'Build'],
      meta: { name: 'demo', description: 'before' },
      result: { nested: { value: 'before' } },
      journal: EMPTY_JOURNAL,
    });
  });

  it('persists invalid args as non-resumable without persisting their values', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const sparse = Array.from({ length: 2 }) as unknown[];
    sparse[1] = 'value';
    const disguisedSparse = Array.from({ length: 2 }) as unknown[] & {
      extra?: string;
    };
    disguisedSparse[1] = 'value';
    disguisedSparse.extra = 'PRIVATE_ARRAY_SENTINEL';
    const hiddenProperty: Record<string, unknown> = { visible: true };
    Object.defineProperty(hiddenProperty, 'hidden', {
      value: 'PRIVATE_HIDDEN_SENTINEL',
      enumerable: false,
    });
    const deeplyNested: unknown[] = [];
    let nestedCursor = deeplyNested;
    for (let depth = 0; depth < 12_000; depth++) {
      const next: unknown[] = [];
      nestedCursor.push(next);
      nestedCursor = next;
    }
    const cases: Array<[string, unknown]> = [
      ['cyclic', cyclic],
      ['sparse-array', sparse],
      ['sparse-array-with-extra-key', disguisedSparse],
      ['non-enumerable-property', hiddenProperty],
      ['too-deep', deeplyNested],
      ['bigint', { secret: 10n }],
      ['function', { secret: () => 'PRIVATE_FUNCTION_SENTINEL' }],
      ['symbol', { secret: Symbol('PRIVATE_SYMBOL_SENTINEL') }],
      ['too-large', { secret: 'x'.repeat(MAX_WORKFLOW_ARGS_BYTES + 1) }],
    ];

    for (const [index, [name, args]] of cases.entries()) {
      const config = fakeConfig(projectDir);
      const runId = `wf_f${index}`;
      const manifest = await writeWorkflowManifest(
        config,
        task({ runId, status: 'running' }),
        { args, journal: EMPTY_JOURNAL },
      );
      expect({ name, canResume: manifest?.canResume }).toEqual({
        name,
        canResume: false,
      });
      expect(manifest?.resumeBlockedReason).toMatch(/args/i);
      expect(manifest).not.toHaveProperty('args');
      const serialized = await fs.readFile(
        config.storage.getWorkflowRunManifestPath(runId),
        'utf8',
      );
      expect({ name, leaked: serialized.includes('PRIVATE_') }).toEqual({
        name,
        leaked: false,
      });
    }
  });

  it('uses UTF-8 bytes, not character count, for the args limit', async () => {
    const config = fakeConfig(projectDir);
    const args = { value: '界'.repeat(Math.ceil(MAX_WORKFLOW_ARGS_BYTES / 3)) };
    const manifest = await writeWorkflowManifest(
      config,
      task({ runId: 'wf_beef', status: 'running' }),
      { args, journal: EMPTY_JOURNAL },
    );
    expect(manifest?.canResume).toBe(false);
    expect(manifest).not.toHaveProperty('args');
  });

  it('does not persist pending approval payloads or unrelated runtime state', async () => {
    const config = fakeConfig(projectDir);
    const t = task({
      runId: 'wf_cafe',
      status: 'running',
      pendingApprovals: [
        {
          approvalId: 'APPROVAL_ID_SENTINEL',
          subagentId: 'agent-a',
          callId: 'call-1',
          name: 'Tool',
          description: 'TOOL_PARAMS_SENTINEL',
          confirmationDetails: {
            type: 'info',
            title: 'PROMPT_SENTINEL',
            prompt: 'PROMPT_SENTINEL',
          },
          at: 1,
        },
      ],
    });
    await writeWorkflowManifest(config, t, {
      args: { public: true },
      journal: EMPTY_JOURNAL,
    });
    const serialized = await fs.readFile(
      config.storage.getWorkflowRunManifestPath(t.runId),
      'utf8',
    );
    expect(serialized).not.toContain('APPROVAL_ID_SENTINEL');
    expect(serialized).not.toContain('TOOL_PARAMS_SENTINEL');
    expect(serialized).not.toContain('PROMPT_SENTINEL');
  });

  it('fails closed for old, future, corrupt, truncated, and hash-mismatched manifests', async () => {
    const config = fakeConfig(projectDir);
    const dir = config.storage.getWorkflowRunsDir();
    await fs.mkdir(dir, { recursive: true });
    const cases: Array<[string, string]> = [
      [
        'wf_01',
        JSON.stringify({
          schemaVersion: 1,
          runId: 'wf_01',
          status: 'paused',
          startTime: 10,
        }),
      ],
      [
        'wf_02',
        JSON.stringify({
          schemaVersion: WORKFLOW_MANIFEST_SCHEMA_VERSION + 1,
          runId: 'wf_02',
          status: 'paused',
          startTime: 20,
        }),
      ],
      ['wf_03', '{ not json'],
      ['wf_04', '{"schemaVersion":2'],
    ];
    for (const [runId, raw] of cases) {
      const runDir = config.storage.getWorkflowRunDir(runId);
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(
        config.storage.getWorkflowRunManifestPath(runId),
        raw,
        'utf8',
      );
    }
    const valid = await writeWorkflowManifest(
      config,
      task({ runId: 'wf_05', status: 'paused', startTime: 50 }),
      { args: null, journal: EMPTY_JOURNAL },
    );
    await fs.writeFile(
      config.storage.getWorkflowRunManifestPath('wf_05'),
      JSON.stringify({ ...valid, scriptHash: '0'.repeat(64) }),
      'utf8',
    );
    await fs.mkdir(config.storage.getWorkflowRunDir('wf_06'));

    const records = await listWorkflowRunRecords(config);
    expect(records.map((record) => record.runId).sort()).toEqual([
      'wf_01',
      'wf_02',
      'wf_03',
      'wf_04',
      'wf_05',
      'wf_06',
    ]);
    expect(records.every((record) => record.canResume === false)).toBe(true);
    expect(records.every((record) => Boolean(record.resumeBlockedReason))).toBe(
      true,
    );
    for (const runId of cases.map(([id]) => id).concat('wf_05', 'wf_06')) {
      await expect(readWorkflowManifest(config, runId)).rejects.toThrow();
    }
  });

  it('converts structurally invalid v2 and legacy records into safe invalid records', async () => {
    const config = fakeConfig(projectDir);
    const malformedV2 = await writeWorkflowManifest(
      config,
      task({ runId: 'wf_bad1', status: 'paused' }),
      { args: null, journal: EMPTY_JOURNAL },
    );
    await fs.writeFile(
      config.storage.getWorkflowRunManifestPath('wf_bad1'),
      JSON.stringify({ ...malformedV2, perPhaseTokens: [1] }),
    );
    await fs.mkdir(config.storage.getWorkflowRunsDir(), { recursive: true });
    await fs.writeFile(
      config.storage.getWorkflowRunSnapshotPath('wf_bad2'),
      '{}',
    );

    const records = await listWorkflowRunRecords(config);
    for (const runId of ['wf_bad1', 'wf_bad2']) {
      expect(records.find((record) => record.runId === runId)).toMatchObject({
        status: 'interrupted',
        canResume: false,
        resumeBlockedReason: expect.stringMatching(/invalid/i),
      });
    }
    await expect(readWorkflowManifest(config, 'wf_bad1')).rejects.toThrow(
      /invalid/i,
    );
  });

  it.runIf(process.platform !== 'win32')(
    'ignores unsafe legacy filenames instead of exposing terminal controls',
    async () => {
      const config = fakeConfig(projectDir);
      const dir = config.storage.getWorkflowRunsDir();
      await fs.mkdir(dir, { recursive: true });
      for (const runId of [
        'wf_bad\nCONTROL_SENTINEL',
        'wf_bad\u001b[31mCONTROL_SENTINEL',
        `wf_${'x'.repeat(129)}`,
      ]) {
        await fs.writeFile(
          path.join(dir, `${runId}.json`),
          JSON.stringify(task({ runId, status: 'completed' })),
        );
      }

      const serialized = JSON.stringify(await listWorkflowRunRecords(config));
      expect(serialized).not.toContain('CONTROL_SENTINEL');
      expect(serialized).not.toContain(`wf_${'x'.repeat(129)}`);
    },
  );

  it('rejects a terminal manifest that claims it can be resumed', async () => {
    const config = fakeConfig(projectDir);
    const runId = 'wf_bad3';
    const manifest = await writeWorkflowManifest(
      config,
      task({ runId, status: 'completed' }),
      { args: null, journal: EMPTY_JOURNAL },
    );
    const contradictory = { ...manifest, canResume: true };
    delete contradictory.resumeBlockedReason;
    await fs.writeFile(
      config.storage.getWorkflowRunManifestPath(runId),
      JSON.stringify(contradictory),
    );

    await expect(readWorkflowManifest(config, runId)).rejects.toThrow(
      /resume metadata/i,
    );
    expect(
      (await listWorkflowRunRecords(config)).find(
        (record) => record.runId === runId,
      ),
    ).toMatchObject({ status: 'interrupted', canResume: false });
  });

  it('marks a manifest non-recoverable when its committed journal is truncated', async () => {
    const config = fakeConfig(projectDir);
    const runId = 'wf_fade';
    const journal = new WorkflowJournal(
      config.storage.getWorkflowRunJournalPath(runId),
    );
    await journal.append({ type: 'started', key: 'v2:key', agentId: '1' });
    const checkpoint = await journal.flush();
    await writeWorkflowManifest(config, task({ runId, status: 'paused' }), {
      args: null,
      journal: checkpoint,
    });
    const bytes = await fs.readFile(journal.path);
    await fs.writeFile(journal.path, bytes.subarray(0, bytes.byteLength - 1));

    await expect(readWorkflowManifest(config, runId)).rejects.toThrow(
      /truncated/i,
    );
    expect(
      (await listWorkflowRunRecords(config)).find(
        (record) => record.runId === runId,
      ),
    ).toMatchObject({
      status: 'interrupted',
      canResume: false,
      resumeBlockedReason: expect.stringMatching(/truncated/i),
    });
  });

  it('treats an orphaned active manifest as interrupted and keeps terminal status', async () => {
    const config = fakeConfig(projectDir);
    await writeWorkflowManifest(
      config,
      task({ runId: 'wf_10', status: 'running', startTime: 10 }),
      { args: null, journal: EMPTY_JOURNAL },
    );
    await writeWorkflowManifest(
      config,
      task({ runId: 'wf_20', status: 'completed', startTime: 20 }),
      { args: null, journal: EMPTY_JOURNAL },
    );
    const records = await listWorkflowRunRecords(config);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'wf_10',
          status: 'interrupted',
          originalStatus: 'running',
          canResume: true,
        }),
        expect.objectContaining({
          runId: 'wf_20',
          status: 'completed',
          canResume: false,
          resumeBlockedReason: expect.stringMatching(/rerun/i),
        }),
      ]),
    );
  });

  it('keeps legacy snapshots display-only and rejects only a stale active manifest', async () => {
    const config = fakeConfig(projectDir);
    await writeWorkflowSnapshot(
      config,
      task({ runId: 'wf_aa', status: 'completed', startTime: 1 }),
    );
    await fs.mkdir(config.storage.getWorkflowRunDir('wf_aa'));
    await fs.writeFile(
      config.storage.getWorkflowRunJournalPath('wf_aa'),
      '{}\n',
      'utf8',
    );
    await writeWorkflowSnapshot(
      config,
      task({ runId: 'wf_bb', status: 'failed', startTime: 2 }),
    );
    await writeWorkflowManifest(
      config,
      task({ runId: 'wf_bb', status: 'paused', startTime: 3 }),
      { args: null, journal: EMPTY_JOURNAL },
    );
    await writeWorkflowSnapshot(
      config,
      task({ runId: 'wf_cc', status: 'failed', startTime: 4 }),
    );
    await writeWorkflowManifest(
      config,
      task({ runId: 'wf_cc', status: 'failed', startTime: 5 }),
      { args: null, journal: EMPTY_JOURNAL },
    );
    await writeWorkflowSnapshot(
      config,
      task({ runId: 'wf_dd', status: 'completed', startTime: 6 }),
    );
    await writeWorkflowManifest(
      config,
      task({ runId: 'wf_dd', status: 'paused', startTime: 7 }),
      { args: null, journal: EMPTY_JOURNAL },
    );
    await fs.writeFile(
      config.storage.getWorkflowRunManifestPath('wf_dd'),
      '{broken',
    );
    await writeWorkflowSnapshot(
      config,
      task({ runId: 'wf_ee', status: 'cancelled', startTime: 8 }),
    );
    await writeWorkflowManifest(
      config,
      task({ runId: 'wf_ee', status: 'completed', startTime: 9 }),
      { args: null, journal: EMPTY_JOURNAL },
    );

    const records = await listWorkflowRunRecords(config);
    expect(records).toHaveLength(5);
    expect(records.find((record) => record.runId === 'wf_aa')).toMatchObject({
      status: 'completed',
      canResume: false,
      resumeBlockedReason: expect.stringMatching(/legacy/i),
    });
    expect(records.find((record) => record.runId === 'wf_bb')).toMatchObject({
      status: 'failed',
      schemaVersion: 1,
      canResume: false,
      resumeBlockedReason: expect.stringMatching(/legacy/i),
    });
    await expect(readWorkflowManifest(config, 'wf_bb')).rejects.toThrow(
      /terminal snapshot/i,
    );
    expect(records.find((record) => record.runId === 'wf_cc')).toMatchObject({
      status: 'failed',
      schemaVersion: WORKFLOW_MANIFEST_SCHEMA_VERSION,
      canResume: false,
      resumeBlockedReason: expect.stringMatching(/rerun/i),
    });
    expect(records.find((record) => record.runId === 'wf_dd')).toMatchObject({
      status: 'interrupted',
      schemaVersion: 0,
      canResume: false,
    });
    expect(records.find((record) => record.runId === 'wf_ee')).toMatchObject({
      status: 'cancelled',
      schemaVersion: 1,
      canResume: false,
    });
    await expect(readWorkflowManifest(config, 'wf_ee')).rejects.toThrow(
      /conflicts/i,
    );
  });

  it('rejects traversal ids and never follows run-directory or manifest symlinks', async () => {
    const config = fakeConfig(projectDir);
    await expect(
      writeWorkflowManifest(config, task({ runId: '../escape' }), {
        args: null,
        journal: EMPTY_JOURNAL,
      }),
    ).rejects.toThrow(/run id/i);
    await writeWorkflowSnapshot(
      config,
      task({ runId: '../escape', status: 'completed' }),
    );
    await expect(
      fs.stat(
        path.join(config.storage.getWorkflowRunsDir(), '..', 'escape.json'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const runsDir = config.storage.getWorkflowRunsDir();
    const outsideDir = path.join(projectDir, 'outside');
    await fs.mkdir(runsDir, { recursive: true });
    await fs.mkdir(outsideDir);
    await fs.symlink(outsideDir, path.join(runsDir, 'wf_dead'), 'dir');
    await expect(
      writeWorkflowManifest(config, task({ runId: 'wf_dead' }), {
        args: null,
        journal: EMPTY_JOURNAL,
      }),
    ).rejects.toThrow(/directory|symlink/i);
    await expect(fs.readdir(outsideDir)).resolves.toEqual([]);

    const manifest = await writeWorkflowManifest(
      config,
      task({ runId: 'wf_feed', status: 'paused' }),
      { args: null, journal: EMPTY_JOURNAL },
    );
    const canary = path.join(projectDir, 'CANARY.json');
    await fs.writeFile(canary, JSON.stringify(manifest), 'utf8');
    const manifestPath = config.storage.getWorkflowRunManifestPath('wf_feed');
    await fs.unlink(manifestPath);
    await fs.symlink(canary, manifestPath);
    await expect(readWorkflowManifest(config, 'wf_feed')).rejects.toThrow(
      /symlink/i,
    );
    const records = await listWorkflowRunRecords(config);
    expect(records.find((record) => record.runId === 'wf_feed')).toMatchObject({
      canResume: false,
    });
  });
});
