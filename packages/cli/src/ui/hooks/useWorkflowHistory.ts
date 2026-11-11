/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useState } from 'react';
import {
  isWorkflowTask,
  getSessionArtifactProjectRoots,
  listWorkflowRunSnapshots,
  runLogger,
  type Config,
  type TaskRegistry,
  type UnifiedTask,
  type WorkflowRunSnapshot,
  type WorkflowUnifiedTask,
} from '@qwen-code/core';

function snapshotToWorkflowTask(
  snapshot: WorkflowRunSnapshot,
): WorkflowUnifiedTask {
  return {
    id: snapshot.taskId,
    publicId: snapshot.runId,
    sessionId: snapshot.sessionId,
    type: 'local_workflow',
    status: snapshot.status,
    description: snapshot.summary,
    startTime: snapshot.startTime,
    endTime: snapshot.endTime,
    notified: true,
    executionId: -1,
    outputPath: snapshot.outputPath,
    completionBehavior: 'silent',
    workflowRunId: snapshot.runId,
    workflowName: snapshot.workflowName,
    title: snapshot.title,
    scriptPath: snapshot.scriptPath,
    transcriptDir: snapshot.transcriptDir,
    args: snapshot.args,
    phases: snapshot.phases,
    progress: snapshot.progress,
    logs: snapshot.logs,
    agentCount: snapshot.agentCount,
    totalTokens: snapshot.totalTokens,
    totalToolCalls: snapshot.totalToolCalls,
    result: snapshot.result,
    error: snapshot.error,
  };
}

export function mergeWorkflowHistoryTasks(
  liveTasks: readonly WorkflowUnifiedTask[],
  snapshots: readonly WorkflowRunSnapshot[],
): WorkflowUnifiedTask[] {
  const tasksByRunId = new Map<string, WorkflowUnifiedTask>();

  for (const snapshot of snapshots) {
    tasksByRunId.set(snapshot.runId, snapshotToWorkflowTask(snapshot));
  }
  for (const task of liveTasks) {
    // The live task owns runtime controls and the freshest progress.
    tasksByRunId.set(task.workflowRunId, task);
  }

  return [...tasksByRunId.values()].sort(
    (left, right) => right.startTime - left.startTime,
  );
}

export function useWorkflowHistory(
  config: Config,
  registry: TaskRegistry,
  liveTasks: readonly WorkflowUnifiedTask[],
  enabled: boolean,
): WorkflowUnifiedTask[] {
  const [history, setHistory] = useState<{
    sessionId: string;
    snapshots: WorkflowRunSnapshot[];
  }>({ sessionId: '', snapshots: [] });
  const projectRoot = config.getSessionArtifactProjectRoot();
  const sessionId = config.getSessionId();
  const sessionTranscriptPath = config.getActiveSessionTranscriptPath();

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let disposed = false;
    let running = false;
    let requested = false;
    // 仅缓存本次会话上下文的小型目录列表，不保留完整 Transcript。
    let rootsPromise: Promise<string[]> | undefined;
    const loadRoots = () =>
      (rootsPromise ??= getSessionArtifactProjectRoots(
        projectRoot,
        sessionId,
        sessionTranscriptPath,
      ).catch((error) => {
        rootsPromise = undefined;
        throw error;
      }));
    const refresh = async () => {
      requested = true;
      if (running) return;
      running = true;
      try {
        // 同一上下文只保留一轮在途读取；读取期间的新请求合并为后续一轮。
        while (requested && !disposed) {
          requested = false;
          try {
            const snapshots = await listWorkflowRunSnapshots(
              projectRoot,
              sessionId,
              sessionTranscriptPath,
              await loadRoots(),
            );
            if (!disposed && !requested) setHistory({ sessionId, snapshots });
          } catch (error) {
            runLogger.warn('Failed to list workflow history', error);
          }
        }
      } finally {
        running = false;
      }
    };
    const refreshTerminalWorkflow = (_taskId: string, task?: UnifiedTask) => {
      if (!task || (isWorkflowTask(task) && task.notified)) {
        void refresh();
      }
    };

    registry.on('task_updated', refreshTerminalWorkflow);
    registry.on('task_removed', refreshTerminalWorkflow);
    const removeCommitObserver = config
      .getTranscriptStore()
      .addCommitObserver((_filePath, entries) => {
        if (
          entries.some(
            (entry) =>
              entry.type === 'worktree-state' && entry.sessionId === sessionId,
          )
        ) {
          rootsPromise = undefined;
          void refresh();
        }
      });
    void refresh();
    return () => {
      disposed = true;
      removeCommitObserver();
      registry.off('task_updated', refreshTerminalWorkflow);
      registry.off('task_removed', refreshTerminalWorkflow);
    };
  }, [
    enabled,
    config,
    projectRoot,
    sessionId,
    sessionTranscriptPath,
    registry,
  ]);

  return useMemo(
    () =>
      mergeWorkflowHistoryTasks(
        liveTasks,
        history.sessionId === sessionId ? history.snapshots : [],
      ),
    [history, liveTasks, sessionId],
  );
}
