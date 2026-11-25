/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Config,
  TaskRegistry,
  WorkflowRunSnapshot,
  WorkflowUnifiedTask,
} from '@qwen-code/core';
import {
  listWorkflowRunSnapshots,
  getSessionArtifactProjectRoots,
  makeFakeConfig,
} from '@qwen-code/core';
import { renderHook } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import {
  mergeWorkflowHistoryTasks,
  useWorkflowHistory,
} from './useWorkflowHistory.js';

vi.mock('@qwen-code/core', async () => {
  const actual = await vi.importActual<
    typeof import('@qwen-code/core')
  >('@qwen-code/core');
  return {
    ...actual,
    listWorkflowRunSnapshots: vi.fn(),
    getSessionArtifactProjectRoots: vi.fn(async (root: string) => [root]),
  };
});

const mockListWorkflowRunSnapshots = vi.mocked(listWorkflowRunSnapshots);

beforeEach(() => {
  vi.mocked(getSessionArtifactProjectRoots).mockClear();
  mockListWorkflowRunSnapshots.mockReset();
  mockListWorkflowRunSnapshots.mockResolvedValue([]);
});

function makeSnapshot(runId: string, startTime: number): WorkflowRunSnapshot {
  return {
    version: 1,
    sessionId: 'session-1',
    runId,
    taskId: `task-${runId}`,
    workflowName: `history-${runId}`,
    summary: `history ${runId}`,
    status: 'completed',
    startTime,
    endTime: startTime + 100,
    scriptPath: `/tmp/${runId}.js`,
    transcriptDir: `/tmp/${runId}/transcripts`,
    progress: [],
    agentCount: 1,
    totalTokens: 10,
    totalToolCalls: 2,
    logs: [],
  };
}

function makeLiveTask(runId: string, startTime: number): WorkflowUnifiedTask {
  return {
    id: `live-${runId}`,
    type: 'local_workflow',
    status: 'running',
    description: `live ${runId}`,
    startTime,
    notified: false,
    executionId: 1,
    completionBehavior: 'notify',
    workflowRunId: runId,
    workflowName: `live-${runId}`,
    scriptPath: `/tmp/${runId}.js`,
    transcriptDir: `/tmp/${runId}/transcripts`,
    progress: [],
    logs: [],
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
  };
}

describe('mergeWorkflowHistoryTasks', () => {
  it('reuses historical roots across task refreshes and invalidates them on a worktree commit', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'workflow-roots-'));
    const config = makeFakeConfig({
      targetDir: projectRoot,
      cwd: projectRoot,
      sessionId: 'session-1',
    });
    const registry = new EventEmitter() as TaskRegistry;
    let roots = [projectRoot];
    const loadRoots = vi.mocked(getSessionArtifactProjectRoots);
    loadRoots.mockImplementation(async () => roots);
    mockListWorkflowRunSnapshots.mockImplementation(
      async (_root, _session, _path, historicalRoots) => [
        makeSnapshot(
          historicalRoots?.includes(path.join(projectRoot, 'legacy'))
            ? 'legacy'
            : 'original',
          100,
        ),
      ],
    );
    const hook = await renderHook(() =>
      useWorkflowHistory(config, registry, [], true),
    );
    try {
      await waitFor(() =>
        expect(hook.result.current.map((task) => task.workflowRunId)).toEqual([
          'original',
        ]),
      );
      await act(async () => {
        registry.emit('task_removed', 'removed');
      });
      await waitFor(() =>
        expect(mockListWorkflowRunSnapshots).toHaveBeenCalledTimes(2),
      );
      expect(loadRoots).toHaveBeenCalledTimes(1);
      roots = [projectRoot, path.join(projectRoot, 'legacy')];
      await act(async () => {
        await config
          .getTranscriptStore()
          .publishCommittedEntries(config.getActiveSessionTranscriptPath(), [
            {
              type: 'worktree-state',
              sessionId: 'session-1',
              worktreeSession: null,
            },
          ]);
      });
      await waitFor(() =>
        expect(hook.result.current.map((task) => task.workflowRunId)).toEqual([
          'legacy',
        ]),
      );
      expect(loadRoots).toHaveBeenCalledTimes(2);
    } finally {
      hook.unmount();
      loadRoots.mockImplementation(async (root) => [root]);
      await config.getTranscriptStore().close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
  it('coalesces in-flight refreshes and publishes the latest history', async () => {
    const registry = new EventEmitter() as TaskRegistry;
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'workflow-refresh-'));
    const config = makeFakeConfig({
      targetDir: projectRoot,
      cwd: projectRoot,
      sessionId: 'session-1',
    });
    let finishFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let started = false;
    let active = 0;
    let peakActive = 0;
    let latest = makeSnapshot('old', 100);
    mockListWorkflowRunSnapshots.mockImplementation(async () => {
      const captured = latest;
      active++;
      peakActive = Math.max(peakActive, active);
      if (!started) {
        started = true;
        await firstRead;
      }
      active--;
      return [captured];
    });
    const hook = await renderHook(() =>
      useWorkflowHistory(config, registry, [], true),
    );
    try {
      await waitFor(() => expect(started).toBe(true));
      latest = makeSnapshot('latest', 200);
      for (let i = 0; i < 10; i++) registry.emit('task_removed', 'removed');
      finishFirst();
      await waitFor(() =>
        expect(hook.result.current.map((task) => task.workflowRunId)).toEqual([
          'latest',
        ]),
      );
      expect(peakActive).toBe(1);
    } finally {
      finishFirst();
      hook.unmount();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('uses the live task for duplicate runs and keeps completed history', () => {
    const duplicateSnapshot = makeSnapshot('same', 100);
    const historicalSnapshot = makeSnapshot('history', 200);
    const liveTask = makeLiveTask('same', 300);

    const result = mergeWorkflowHistoryTasks(
      [liveTask],
      [duplicateSnapshot, historicalSnapshot],
    );

    expect(result.map((task) => task.workflowRunId)).toEqual([
      'same',
      'history',
    ]);
    expect(result[0]).toBe(liveTask);
    expect(result[1]).toMatchObject({
      id: 'task-history',
      status: 'completed',
      executionId: -1,
      notified: true,
    });
  });

  it('loads workflow history from the stable artifact root in a worktree session', async () => {
    const originalCwd = mkdtempSync(path.join(tmpdir(), 'workflow-history-'));
    const worktreeCwd = path.join(originalCwd, 'worktree');
    mkdirSync(worktreeCwd);
    const config = makeFakeConfig({
      targetDir: worktreeCwd,
      cwd: worktreeCwd,
      sessionId: 'session-1',
    });
    config.setWorktreeSettings({
      name: 'workflow-history',
      path: worktreeCwd,
      worktreeCwd,
      baseSha: 'base-sha',
      originalCwd,
      lifecycle: 'attached',
    });
    const registry = {
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as TaskRegistry;

    try {
      const { unmount } = await renderHook(() =>
        useWorkflowHistory(config as Config, registry, [], true),
      );
      await waitFor(() => {
        expect(mockListWorkflowRunSnapshots).toHaveBeenCalledWith(
          originalCwd,
          'session-1',
          config.getActiveSessionTranscriptPath(),
          [originalCwd],
        );
      });
      unmount();
    } finally {
      rmSync(originalCwd, { recursive: true, force: true });
    }
  });
});
