/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useCallback, useMemo, useEffect } from 'react';
import { Box, Text } from 'ink';
import * as fsp from 'node:fs/promises';
import {
  type UnifiedTask,
  type BashUnifiedTask,
  type InternalAgentUnifiedTask,
  type WorkflowUnifiedTask,
  type WorkflowProgressItem,
  isBashTask,
  isAgentTask,
  isInternalAgentTask,
  isWorkflowTask,
  isVideoGenTask,
  isTerminalStatus,
  VIDEO_GEN_TOOL_NAME,
  ShellExecutionService,
  tildeifyPath,
} from '@qwen-code/core';
import { theme } from '../semantic-colors.js';
import { figures } from '../utils/figures.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import { HorizontalLine } from './shared/HorizontalLine.js';
import {
  useRegisterActionHandlers,
  useRegisterFallbackHandler,
  type ActionHandler,
} from '../contexts/ActionHandlerRegistry.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';
import { AgentTaskDetailView } from './AgentTaskDetailView.js';
import { agentTaskSectionLabel } from '../utils/agentTaskDisplay.js';
import { useTaskRegistry } from '../contexts/TaskRegistryContext.js';
import { WorkflowPanel } from './WorkflowPanel.js';

// ── Helpers ──

function extractOriginalCommand(command: string): string {
  const match = command.match(/^\(\n([\s\S]*?)\n\); __code=\$\?;/);
  return match ? match[1] : command;
}

function formatCommandFirstLine(command: string): string {
  return extractOriginalCommand(command).split('\n')[0];
}

function formatRuntime(task: BashUnifiedTask): string {
  const end = task.endTime ?? Date.now();
  const elapsed = Math.max(0, Math.floor((end - task.startTime) / 1000));
  if (elapsed < 60) return `${elapsed}s`;
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${m}m ${s}s`;
}

function useElapsedTime(task: BashUnifiedTask): string {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (task.status !== 'running') return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [task.status]);

  return formatRuntime(task);
}

function taskLabel(task: UnifiedTask): string {
  if (isBashTask(task)) {
    return formatCommandFirstLine(task.command);
  }
  if (isWorkflowTask(task)) {
    return task.title ?? task.workflowName;
  }
  if (isInternalAgentTask(task)) {
    return task.description || task.agentName;
  }
  return task.description;
}

function taskStatusColor(task: UnifiedTask): string {
  if (isAgentTask(task) && task.isIdle) {
    return theme.text.secondary;
  }
  switch (task.status) {
    case 'running':
      return theme.status.warning;
    case 'paused':
      return theme.text.secondary;
    case 'completed':
      return theme.status.success;
    case 'failed':
    case 'killed':
      return theme.status.error;
    default:
      return theme.text.secondary;
  }
}

function taskStatusLabel(task: UnifiedTask): string {
  if (isBashTask(task)) {
    return task.status === 'running'
      ? 'running'
      : `exited (${task.exitCode ?? '?'})`;
  }
  if (isVideoGenTask(task) && task.serverStatus) {
    return task.serverStatus === 'in_progress'
      ? 'in progress'
      : task.serverStatus;
  }
  if (isAgentTask(task) && task.isIdle) {
    return 'idle';
  }
  return task.status;
}

function taskInfo(task: UnifiedTask): string {
  if (isBashTask(task)) {
    return `PID ${task.executionId}`;
  }
  if (isAgentTask(task)) {
    const parts: string[] = [task.agentType];
    const progress = task.progress;
    if (progress?.recentActivity) {
      const running = progress.recentActivity.filter(
        (a) => a.status === 'running',
      );
      if (running.length > 0) {
        const last = running[running.length - 1];
        parts.push(last.displayName ?? last.content);
      }
    }
    return parts.join(' · ');
  }
  if (isInternalAgentTask(task)) {
    return [task.agentName, task.detail ?? task.phase]
      .filter(Boolean)
      .join(' · ');
  }
  if (isWorkflowTask(task)) {
    const currentAgent = [...task.progress]
      .reverse()
      .find(
        (
          item,
        ): item is Extract<WorkflowProgressItem, { type: 'workflow_agent' }> =>
          isWorkflowAgentProgress(item) &&
          (item.state === 'start' || item.state === 'progress'),
      );
    const phase = [...task.progress]
      .reverse()
      .find(isWorkflowPhaseProgress);
    const parts = [`${task.agentCount} agents`];
    if (phase?.title) parts.push(phase.title);
    if (currentAgent?.label) parts.push(currentAgent.label);
    if (currentAgent?.lastToolName) parts.push(currentAgent.lastToolName);
    return parts.join(' · ');
  }
  if (isVideoGenTask(task)) {
    const parts = [VIDEO_GEN_TOOL_NAME];
    if (task.filePath) parts.push(task.filePath);
    return parts.join(' · ');
  }
  return '';
}

function isKillableTask(task: UnifiedTask): boolean {
  return !(isInternalAgentTask(task) && task.killable === false);
}

function isWorkflowAgentProgress(
  item: WorkflowProgressItem,
): item is Extract<WorkflowProgressItem, { type: 'workflow_agent' }> {
  return item.type === 'workflow_agent';
}

function isWorkflowPhaseProgress(
  item: WorkflowProgressItem,
): item is Extract<WorkflowProgressItem, { type: 'workflow_phase' }> {
  return item.type === 'workflow_phase';
}

// ── TaskRow ──

function UnifiedTaskRow({
  task,
  index,
  isActive,
}: {
  task: UnifiedTask;
  index: number;
  isActive: boolean;
}) {
  const textColor = isActive ? theme.ui.focus : theme.text.primary;
  const bg = isActive ? theme.background.focus : undefined;

  return (
    <Box flexDirection="row" backgroundColor={bg}>
      {/* Indicator: 3 chars */}
      <Box width={3} flexShrink={0}>
        <Text color={isActive ? theme.ui.focus : theme.text.secondary}>
          {isActive ? `${figures.pointer} ` : `${index + 1}.`}
        </Text>
      </Box>
      {/* Label: fills remaining space */}
      <Box flexGrow={1} flexShrink={1} overflow="hidden" marginRight={1}>
        <Text color={textColor} wrap="truncate">
          {taskLabel(task)}
        </Text>
      </Box>
      {/* Status */}
      <Box flexShrink={0} width={14}>
        <Text color={taskStatusColor(task)}>{taskStatusLabel(task)}</Text>
      </Box>
      {/* Info */}
      <Box flexShrink={0} width={20}>
        <Text
          color={isActive ? theme.ui.focus : theme.text.secondary}
          wrap="truncate"
        >
          {taskInfo(task)}
        </Text>
      </Box>
    </Box>
  );
}

// ── Shell Output View (reused from TasksPanel pattern) ──

const OUTPUT_TAIL_LINES = 9;
const COMMAND_PREVIEW_LINES = 3;

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Box flexDirection="row">
      <Box width={10} flexShrink={0}>
        <Text color={theme.text.secondary}>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

function ShellStatusBadge({ task }: { task: BashUnifiedTask }) {
  const exitSuffix =
    task.exitCode === undefined ? '' : ` (exit ${task.exitCode})`;

  switch (task.status) {
    case 'running':
      return <Text color={theme.status.warning}>Running</Text>;
    case 'completed':
      return (
        <Text color={theme.status.success}>Completed{exitSuffix}</Text>
      );
    case 'failed':
      return <Text color={theme.status.error}>Failed{exitSuffix}</Text>;
    case 'killed':
      return <Text color={theme.text.secondary}>Killed{exitSuffix}</Text>;
    default:
      return <Text color={theme.text.secondary}>{task.status}</Text>;
  }
}

function GenericStatusBadge({ task }: { task: UnifiedTask }) {
  if (isAgentTask(task) && task.isIdle) {
    return <Text color={theme.text.secondary}>Idle</Text>;
  }
  switch (task.status) {
    case 'running':
      return <Text color={theme.status.warning}>Running</Text>;
    case 'completed':
      return <Text color={theme.status.success}>Completed</Text>;
    case 'paused':
      return <Text color={theme.text.secondary}>Paused</Text>;
    case 'failed':
      return <Text color={theme.status.error}>Failed</Text>;
    case 'killed':
      return <Text color={theme.text.secondary}>Killed</Text>;
    default:
      return <Text color={theme.text.secondary}>{task.status}</Text>;
  }
}

function ShellOutputView({
  task,
  onBack,
}: {
  task: BashUnifiedTask;
  onBack: () => void;
}) {
  const [output, setOutput] = useState<string>(task.output || '');
  const [hasFileOutput, setHasFileOutput] = useState(false);
  const logPath = ShellExecutionService.getOutputFilePath(task.executionId);

  useEffect(() => {
    if (!logPath) return;

    let cancelled = false;
    let inFlight = false;

    const readOnce = () => {
      if (inFlight) return;
      inFlight = true;
      void fsp.readFile(logPath, 'utf-8').then(
        (content) => {
          inFlight = false;
          if (cancelled) return;
          setOutput(content);
          setHasFileOutput(true);
        },
        () => {
          inFlight = false;
        },
      );
    };

    readOnce();
    const interval = setInterval(readOnce, 500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [task.executionId, logPath]);

  useEffect(() => {
    if (!hasFileOutput) {
      setOutput(task.output || '');
    }
  }, [hasFileOutput, task.output]);

  const runtime = useElapsedTime(task);
  const displayPath = logPath ? tildeifyPath(logPath) : undefined;
  const { lines, lineCount } = useMemo(() => {
    const split = output.split('\n');
    const count = split[split.length - 1] === '' ? split.length - 1 : split.length;
    return { lines: split, lineCount: !output || (count === 1 && split[0] === '') ? 0 : count };
  }, [output]);
  const commandLines = useMemo(() => {
    const rawLines = extractOriginalCommand(task.command).split('\n');
    const preview = rawLines.slice(0, COMMAND_PREVIEW_LINES);
    if (rawLines.length > COMMAND_PREVIEW_LINES) {
      preview[COMMAND_PREVIEW_LINES - 1] =
        `${preview[COMMAND_PREVIEW_LINES - 1]} ${figures.ellipsis}`;
    }
    return preview;
  }, [task.command]);

  const outputInfoParts = [
    lineCount === 0
      ? 'No output'
      : lineCount > OUTPUT_TAIL_LINES
        ? `Last ${OUTPUT_TAIL_LINES} of ${lineCount} lines`
        : `${lineCount} line${lineCount === 1 ? '' : 's'}`,
  ];
  if (displayPath) {
    outputInfoParts.push(`Log: ${displayPath}`);
  }

  return (
    <BaseTabDialog
      title="Shell details"
      tabs={[]}
      activeKey=""
      onTabChange={() => {}}
      onClose={onBack}
    >
      <Box flexDirection="column" marginTop={1}>
        <DetailRow label="Status">
          <ShellStatusBadge task={task} />
        </DetailRow>
        <DetailRow label="Runtime">
          <Text>{runtime}</Text>
        </DetailRow>
        <DetailRow label="Command">
          <Box flexDirection="column">
            {commandLines.map((line, index) => (
              <Text key={index} wrap="truncate">
                {line}
              </Text>
            ))}
          </Box>
        </DetailRow>

        <Box marginTop={1} marginBottom={1}>
          <HorizontalLine />
        </Box>

        <Box flexDirection="column" height={OUTPUT_TAIL_LINES}>
          {lines.slice(-OUTPUT_TAIL_LINES).map((line, i) => (
            <Text key={i} wrap="truncate">
              {line}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.secondary} dimColor>
            {outputInfoParts.join(' · ')}
          </Text>
        </Box>
      </Box>
    </BaseTabDialog>
  );
}

export function WorkflowTaskDetailView({
  task,
  onBack,
}: {
  task: WorkflowUnifiedTask;
  onBack: () => void;
}) {
  return <WorkflowPanel task={task} onBack={onBack} />;
}

function InternalAgentDetailView({
  task,
  onBack,
}: {
  task: InternalAgentUnifiedTask;
  onBack: () => void;
}) {
  return (
    <BaseTabDialog
      title="Background agent details"
      tabs={[]}
      activeKey=""
      onTabChange={() => {}}
      onClose={onBack}
    >
      <Box flexDirection="column" marginTop={1}>
        <DetailRow label="Status">
          <GenericStatusBadge task={task} />
        </DetailRow>
        <DetailRow label="Agent">
          <Text>{task.agentName}</Text>
        </DetailRow>
        <DetailRow label="Type">
          <Text>{task.agentType}</Text>
        </DetailRow>
        {task.phase && (
          <DetailRow label="Phase">
            <Text>{task.phase}</Text>
          </DetailRow>
        )}
        {task.detail && (
          <DetailRow label="Detail">
            <Text wrap="truncate">{task.detail}</Text>
          </DetailRow>
        )}
        {task.result && (
          <DetailRow label="Result">
            <Text wrap="truncate">{task.result}</Text>
          </DetailRow>
        )}
        {task.error && (
          <DetailRow label="Error">
            <Text color={theme.status.error} wrap="truncate">
              {task.error}
            </Text>
          </DetailRow>
        )}
        <Box marginTop={1}>
          <Text color={theme.text.secondary} dimColor>
            Managed by the background service.
          </Text>
        </Box>
      </Box>
    </BaseTabDialog>
  );
}

// ── UnifiedTaskPanel ──

export interface UnifiedTaskPanelProps {
  tasks: UnifiedTask[];
  onClose?: () => void;
  onDismissTask?: (task: UnifiedTask) => void;
  filterTask?: (task: UnifiedTask) => boolean;
  title?: string;
  emptyMessage?: string;
}

export const UnifiedTaskPanel: React.FC<UnifiedTaskPanelProps> = ({
  tasks,
  onClose,
  onDismissTask,
  filterTask,
  title = 'Background tasks',
  emptyMessage = 'No background tasks.',
}) => {
  const registry = useTaskRegistry();
  // Display order: shell tasks first, then workflows, internal agents, then agent tasks.
  // Memo stabilizes the reference for downstream hook deps.
  const {
    displayTasks,
    shellCount,
    workflowCount,
    internalAgentCount,
    agentCount,
    teammateCount,
    videoCount,
  } = useMemo(() => {
    const visibleTasks = filterTask ? tasks.filter(filterTask) : tasks;
    const shells = visibleTasks.filter(isBashTask);
    const workflows = visibleTasks.filter(isWorkflowTask);
    const internalAgents = visibleTasks.filter(isInternalAgentTask);
    const agents = visibleTasks.filter(isAgentTask);
    const videos = visibleTasks.filter(isVideoGenTask);
    const ordinaryAgents = agents.filter(
      (task) => task.type === 'local_agent',
    );
    const teammates = agents.filter(
      (task) => task.type === 'in_process_teammate',
    );
    return {
      displayTasks: [
        ...shells,
        ...workflows,
        ...internalAgents,
        ...ordinaryAgents,
        ...teammates,
        ...videos,
      ],
      shellCount: shells.length,
      workflowCount: workflows.length,
      internalAgentCount: internalAgents.length,
      agentCount: ordinaryAgents.length,
      teammateCount: teammates.length,
      videoCount: videos.length,
    };
  }, [tasks, filterTask]);

  const [activeIndex, setActiveIndex] = useState(0);
  const [detailView, setDetailView] = useState<
    | 'list'
    | 'shell-output'
    | 'agent-detail'
    | 'workflow-detail'
    | 'internal-agent-detail'
  >('list');
  const [detailTaskId, setDetailTaskId] = useState<string | undefined>(
    undefined,
  );

  const clampedIndex = Math.min(activeIndex, Math.max(0, displayTasks.length - 1));
  const selectedTask = displayTasks[clampedIndex];
  const detailTask = detailTaskId
    ? displayTasks.find((task) => task.id === detailTaskId)
    : undefined;
  const shellDetailTask =
    detailView === 'shell-output' && detailTask && isBashTask(detailTask)
      ? detailTask
      : undefined;
  const agentDetailTask =
    detailView === 'agent-detail' && detailTask && isAgentTask(detailTask)
      ? detailTask
      : undefined;
  const workflowDetailTask =
    detailView === 'workflow-detail' && detailTask && isWorkflowTask(detailTask)
      ? detailTask
      : undefined;
  const internalAgentDetailTask =
    detailView === 'internal-agent-detail' &&
    detailTask &&
    isInternalAgentTask(detailTask)
      ? detailTask
      : undefined;
  const isListView =
    detailView === 'list' ||
    (!shellDetailTask &&
      !agentDetailTask &&
      !workflowDetailTask &&
      !internalAgentDetailTask);

  useEffect(() => {
    if (displayTasks.length === 0 && detailView !== 'list') {
      setDetailView('list');
      setDetailTaskId(undefined);
    }
  }, [displayTasks.length, detailView]);

  useEffect(() => {
    if (activeIndex !== clampedIndex) {
      setActiveIndex(clampedIndex);
    }
  }, [activeIndex, clampedIndex]);

  useEffect(() => {
    if (
      detailView === 'list' ||
      shellDetailTask ||
      agentDetailTask ||
      workflowDetailTask ||
      internalAgentDetailTask
    ) {
      return;
    }
    setDetailView('list');
    setDetailTaskId(undefined);
  }, [
    detailView,
    shellDetailTask,
    agentDetailTask,
    workflowDetailTask,
    internalAgentDetailTask,
  ]);

  useEffect(
    () => () => {
      if (detailTaskId) {
        registry?.update(detailTaskId, { retainReason: undefined });
      }
    },
    [detailTaskId, registry],
  );

  const openDetail = useCallback(
    (
      task: UnifiedTask,
      nextView:
        | 'shell-output'
        | 'agent-detail'
        | 'workflow-detail'
        | 'internal-agent-detail',
    ) => {
      registry?.update(task.id, { retainReason: 'task-detail-view' });
      setDetailTaskId(task.id);
      setDetailView(nextView);
    },
    [registry],
  );

  const closeDetail = useCallback(() => {
    if (detailTaskId) {
      registry?.update(detailTaskId, { retainReason: undefined });
    }
    setDetailTaskId(undefined);
    setDetailView('list');
  }, [detailTaskId, registry]);

  const moveSelection = useCallback(
    (delta: number) => {
      setActiveIndex((prev) =>
        Math.max(0, Math.min(displayTasks.length - 1, prev + delta)),
      );
    },
    [displayTasks.length],
  );

  const isListActive = displayTasks.length > 0 && isListView;

  const actionHandlers = useMemo(
    (): Record<string, ActionHandler> => ({
      'dialog:navigate:up': () => {
        moveSelection(-1);
        return true;
      },
      'dialog:navigate:down': () => {
        moveSelection(1);
        return true;
      },
      'dialog:confirm': () => {
        const task = selectedTask;
        if (!task) return false;
        if (isBashTask(task)) {
          openDetail(task, 'shell-output');
        } else if (isAgentTask(task)) {
          openDetail(task, 'agent-detail');
        } else if (isWorkflowTask(task)) {
          openDetail(task, 'workflow-detail');
        } else if (isInternalAgentTask(task)) {
          openDetail(task, 'internal-agent-detail');
        }
        return true;
      },
    }),
    [moveSelection, selectedTask, openDetail],
  );
  useRegisterActionHandlers('Dialog', actionHandlers, isListActive);

  const fallbackHandler = useCallback<ActionHandler>(
    (key) => {
      if (key.sequence === 'k' || key.sequence === 'K') {
        const task = selectedTask;
        if (task) {
          onDismissTask?.(task);
          if (isTerminalStatus(task.status)) {
            setActiveIndex((prev) => Math.max(0, prev - 1));
          }
        }
        return true;
      }
      return false;
    },
    [selectedTask, onDismissTask],
  );
  useRegisterFallbackHandler('Dialog', fallbackHandler, isListActive);

  // Detail views
  if (shellDetailTask) {
    return (
      <Box marginTop={1}>
        <ShellOutputView task={shellDetailTask} onBack={closeDetail} />
      </Box>
    );
  }

  if (agentDetailTask) {
    return (
      <Box marginTop={1}>
        <AgentTaskDetailView task={agentDetailTask} onBack={closeDetail} />
      </Box>
    );
  }

  if (workflowDetailTask) {
    return (
      <Box marginTop={1}>
        <WorkflowTaskDetailView
          task={workflowDetailTask}
          onBack={closeDetail}
        />
      </Box>
    );
  }

  if (internalAgentDetailTask) {
    return (
      <Box marginTop={1}>
        <InternalAgentDetailView
          task={internalAgentDetailTask}
          onBack={closeDetail}
        />
      </Box>
    );
  }

  // Summary counts (single pass)
  let runningCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let pausedCount = 0;
  for (const t of displayTasks) {
    if (t.status === 'running') runningCount++;
    else if (t.status === 'paused') pausedCount++;
    else if (t.status === 'completed') completedCount++;
    else if (t.status === 'failed' || t.status === 'killed') failedCount++;
  }

  const summaryParts: string[] = [];
  if (runningCount > 0) summaryParts.push(`${runningCount} running`);
  if (completedCount > 0) summaryParts.push(`${completedCount} completed`);
  if (failedCount > 0) summaryParts.push(`${failedCount} failed`);
  if (pausedCount > 0) summaryParts.push(`${pausedCount} paused`);
  const taskDetailHint =
    selectedTask && isBashTask(selectedTask)
      ? SHORTCUT_HINTS.ENTER_OUTPUT
      : 'Enter details';
  const taskDismissHint =
    selectedTask && isTerminalStatus(selectedTask.status)
      ? 'k clear'
      : selectedTask && isKillableTask(selectedTask)
        ? SHORTCUT_HINTS.K_KILL
        : undefined;

  return (
    <BaseTabDialog
      title=""
      tabs={[]}
      activeKey=""
      onTabChange={() => {}}
      onClose={onClose}
      isActive={isListView}
      extraHints={
        displayTasks.length > 0
          ? [
              { label: SHORTCUT_HINTS.NAVIGATE, order: 20 },
              { label: taskDetailHint, order: 30 },
              ...(taskDismissHint
                ? [{ label: taskDismissHint, order: 50 }]
                : []),
            ]
          : undefined
      }
    >
      {displayTasks.length === 0 ? (
        <Box marginTop={1}>
          <Text color={theme.text.secondary} dimColor>
            {emptyMessage}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {/* Title + summary */}
          <Text bold color={theme.ui.focus}>
            {title}
          </Text>
          <Text color={theme.text.secondary}>
            {summaryParts.length > 0
              ? summaryParts.join(', ')
              : `${displayTasks.length} task${displayTasks.length > 1 ? 's' : ''}`}
          </Text>

          {/* Rows — grouped by type with separators */}
          {displayTasks.map((task, index) => {
            const prevTask = index > 0 ? displayTasks[index - 1] : null;
            const showSeparator = !prevTask || prevTask.type !== task.type;
            const sectionLabel =
              task.type === 'local_bash'
                ? `Commands (${shellCount})`
                : task.type === 'local_workflow'
                  ? `Workflows (${workflowCount})`
                  : task.type === 'local_video_gen'
                    ? `Videos (${videoCount})`
                    : task.type === 'internal_agent'
                      ? `Background agents (${internalAgentCount})`
                      : isAgentTask(task)
                        ? agentTaskSectionLabel(
                            task,
                            teammateCount,
                            agentCount,
                          )
                        : `Agents (${agentCount})`;
            return (
              <Box key={task.id} flexDirection="column">
                {showSeparator && (
                  <Box flexDirection="row" marginTop={index > 0 ? 1 : 0}>
                    <Box width={3} flexShrink={0} />
                    <Text color={theme.text.secondary} dimColor>
                      {sectionLabel}
                    </Text>
                  </Box>
                )}
                <UnifiedTaskRow
                  task={task}
                  index={index}
                  isActive={index === clampedIndex}
                />
              </Box>
            );
          })}
        </Box>
      )}
    </BaseTabDialog>
  );
};
