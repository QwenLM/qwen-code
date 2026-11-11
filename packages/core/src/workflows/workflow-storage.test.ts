/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getWorkflowOutputPath,
  getWorkflowRunManifestPath,
  getWorkflowRunSnapshotPath,
  listWorkflowRunSnapshots,
  readWorkflowRunManifest,
  readWorkflowRunSnapshot,
  resolveWorkflowRunProjectRoot,
  writeWorkflowOutput,
  writeWorkflowRunManifest,
  writeWorkflowRunSnapshot,
} from './workflow-storage.js';
import type { WorkflowRunSnapshot } from './workflow-types.js';

describe('workflow-storage', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-storage-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('persists and reads run manifests', async () => {
    await writeWorkflowRunManifest(tmpDir, 'session-1', {
      runId: 'wf_123456',
      resumedFromRunId: 'wf_parent',
      workflowName: 'audit',
      scriptPath: '/tmp/audit.js',
      source: 'project',
      args: { level: 'quick' },
      meta: { name: 'audit', description: 'Audit' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
    });

    const manifest = await readWorkflowRunManifest(
      tmpDir,
      'session-1',
      'wf_123456',
    );

    expect(manifest.workflowName).toBe('audit');
    expect(manifest.source).toBe('project');
    expect(manifest.resumedFromRunId).toBe('wf_parent');
    expect(manifest.args).toEqual({ level: 'quick' });
  });

  it('resumes an original-project run without opening the historical transcript', async () => {
    await writeWorkflowRunManifest(tmpDir, 'session-1', {
      runId: 'wf_original',
      workflowName: 'audit',
      scriptPath: '/workspace/audit.js',
      source: 'project',
      args: {},
      meta: { name: 'audit', description: 'Audit' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      status: 'running',
    });
    // 目录不是可读 JSONL；命中原项目 run 时不应依赖兼容扫描。
    await expect(
      resolveWorkflowRunProjectRoot(tmpDir, 'session-1', 'wf_original', tmpDir),
    ).resolves.toBe(tmpDir);
  });

  it('persists, reads, and lists terminal workflow snapshots', async () => {
    const older = createSnapshot({
      runId: 'wf_older',
      taskId: 'wf-task-older',
      startTime: 100,
      endTime: 200,
    });
    const newer = createSnapshot({
      runId: 'wf_newer',
      taskId: 'wf-task-newer',
      startTime: 300,
      endTime: 400,
      status: 'failed',
      error: 'boom',
    });

    await writeWorkflowRunSnapshot(tmpDir, 'session-1', older);
    await writeWorkflowRunSnapshot(tmpDir, 'session-1', newer);

    await expect(
      readWorkflowRunSnapshot(tmpDir, 'session-1', 'wf_newer'),
    ).resolves.toEqual(newer);
    await expect(
      listWorkflowRunSnapshots(tmpDir, 'session-1'),
    ).resolves.toEqual([newer, older]);
  });

  it('rejects malformed optional snapshot fields', async () => {
    const snapshotPath = getWorkflowRunSnapshotPath(
      tmpDir,
      'session-1',
      'wf_malformed',
    );
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.writeFile(
      snapshotPath,
      JSON.stringify(
        {
          ...createSnapshot({
            runId: 'wf_malformed',
            taskId: 'wf-task-malformed',
          }),
          title: 42,
        },
      ),
    );

    await expect(
      readWorkflowRunSnapshot(tmpDir, 'session-1', 'wf_malformed'),
    ).rejects.toThrow('Malformed workflow snapshot');
  });

  it('finds legacy workflow artifacts through the selected transcript even after leaving the worktree', async () => {
    const worktreeRoot = path.join(tmpDir, 'old-worktree');
    const sessionTranscriptPath = path.join(tmpDir, 'selected-session.jsonl');
    await fs.writeFile(
      sessionTranscriptPath,
      [
        JSON.stringify({
          type: 'worktree-state',
          sessionId: 'session-1',
          worktreeSession: {
            sessionId: 'session-1',
            originalCwd: tmpDir,
            worktreePath: worktreeRoot,
            worktreeName: 'legacy',
          },
        }),
        JSON.stringify({
          type: 'worktree-state',
          sessionId: 'session-1',
          worktreeSession: null,
        }),
      ].join('\n') + '\n',
    );
    const legacy = createSnapshot({ runId: 'wf_legacy' });
    const current = createSnapshot({ runId: 'wf_current' });
    await writeWorkflowRunSnapshot(worktreeRoot, 'session-1', legacy);
    await writeWorkflowRunSnapshot(tmpDir, 'session-1', current);

    expect(
      await listWorkflowRunSnapshots(tmpDir, 'session-1', sessionTranscriptPath),
    ).toEqual(expect.arrayContaining([legacy, current]));
    expect(
      await resolveWorkflowRunProjectRoot(
        tmpDir,
        'session-1',
        legacy.runId,
        sessionTranscriptPath,
      ),
    ).toBe(worktreeRoot);

    // 原项目已存在同 ID 产物时，不混合另一个 checkout 的副本。
    const authoritative = { ...legacy, result: { source: 'original' } };
    await writeWorkflowRunSnapshot(tmpDir, 'session-1', authoritative);
    const snapshots = await listWorkflowRunSnapshots(
      tmpDir,
      'session-1',
      sessionTranscriptPath,
    );
    expect(snapshots.filter(({ runId }) => runId === legacy.runId)).toEqual([
      authoritative,
    ]);
    expect(
      await resolveWorkflowRunProjectRoot(
        tmpDir,
        'session-1',
        legacy.runId,
        sessionTranscriptPath,
      ),
    ).toBe(tmpDir);
  });

  it('projects legacy terminal manifests and outputs into history', async () => {
    await writeWorkflowRunManifest(tmpDir, 'session-1', {
      runId: 'wf_legacy',
      workflowName: 'legacy-audit',
      scriptPath: '/tmp/legacy-audit.js',
      source: 'project',
      meta: {
        name: 'legacy-audit',
        description: 'Legacy audit',
        phases: [{ title: 'Review' }],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      status: 'completed',
      agents: [
        {
          index: 1,
          label: 'reviewer',
          state: 'done',
          transcriptPath: '/tmp/reviewer.jsonl',
          updatedAt: '2026-01-01T00:01:00.000Z',
        },
      ],
    });
    await writeWorkflowOutput({
      projectRoot: tmpDir,
      sessionId: 'session-1',
      runId: 'wf_legacy',
      value: {
        taskId: 'wf-task-legacy',
        result: { passed: true },
        logs: ['done'],
        agentCount: 1,
        totalToolCalls: 7,
        usage: { agents: 1, toolCalls: 7, durationMs: 60_000 },
      },
    });

    const snapshots = await listWorkflowRunSnapshots(tmpDir, 'session-1');

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      runId: 'wf_legacy',
      taskId: 'wf-task-legacy',
      workflowName: 'legacy-audit',
      status: 'completed',
      result: { passed: true },
      logs: ['done'],
      agentCount: 1,
      totalToolCalls: 7,
      progress: [
        {
          type: 'workflow_agent',
          index: 1,
          label: 'reviewer',
          state: 'done',
          transcriptPath: '/tmp/reviewer.jsonl',
        },
      ],
    });
  });

  it('ignores legacy running manifests without a live task', async () => {
    await writeWorkflowRunManifest(tmpDir, 'session-1', {
      runId: 'wf_stale',
      workflowName: 'stale',
      scriptPath: '/tmp/stale.js',
      source: 'project',
      meta: { name: 'stale', description: 'Stale run' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      status: 'running',
    });

    await expect(
      listWorkflowRunSnapshots(tmpDir, 'session-1'),
    ).resolves.toEqual([]);
  });

  it('isolates a corrupt run while listing valid history', async () => {
    await writeWorkflowRunSnapshot(
      tmpDir,
      'session-1',
      createSnapshot({ runId: 'wf_valid', taskId: 'wf-task-valid' }),
    );
    await fs.mkdir(
      path.dirname(
        getWorkflowRunManifestPath(tmpDir, 'session-1', 'wf_corrupt'),
      ),
      { recursive: true },
    );
    await fs.writeFile(
      getWorkflowRunManifestPath(tmpDir, 'session-1', 'wf_corrupt'),
      '{bad json',
    );
    await fs.writeFile(
      getWorkflowOutputPath(tmpDir, 'session-1', 'wf_corrupt'),
      '{}',
    );

    const snapshots = await listWorkflowRunSnapshots(tmpDir, 'session-1');

    expect(snapshots.map((snapshot) => snapshot.runId)).toEqual(['wf_valid']);
  });
});

function createSnapshot(
  overrides: Partial<WorkflowRunSnapshot> = {},
): WorkflowRunSnapshot {
  return {
    version: 1,
    sessionId: 'session-1',
    runId: 'wf_snapshot',
    taskId: 'wf-task-snapshot',
    workflowName: 'audit',
    summary: 'Audit repository',
    status: 'completed',
    startTime: 100,
    endTime: 200,
    scriptPath: '/tmp/audit.js',
    transcriptDir: '/tmp/workflows/wf_snapshot',
    progress: [],
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    logs: [],
    result: { ok: true },
    ...overrides,
  };
}
