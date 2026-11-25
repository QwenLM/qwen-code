/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo, useEffect, useRef, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import {
  isAgentTask,
  isActiveStatus,
  isWorkflowTask,
  isTerminalStatus,
  type AgentUnifiedTask,
  type InternalAgentUnifiedTask,
  type UnifiedTask,
  type WorkflowUnifiedTask,
} from '@qwen-code/core';
import { theme } from '../semantic-colors.js';
import { figures } from '../utils/figures.js';
import {
  useRegisterActionHandlers,
  useRegisterFallbackHandler,
  type ActionHandler,
} from '../contexts/ActionHandlerRegistry.js';
import { useTaskRegistry } from '../contexts/TaskRegistryContext.js';
import { dismissTask } from '../utils/taskActions.js';
import {
  type AgentRailMode,
  useAgentSessionView,
} from '../hooks/useAgentSessionView.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import {
  agentTaskDisplayName,
  isInProcessTeammateTask,
} from '../utils/agentTaskDisplay.js';
import {
  useUIState,
  type SessionRailSelectionMode,
} from '../contexts/UIStateContext.js';
import { useRegisterKeyboardContext } from '../contexts/KeyboardContextRegistry.js';
import { FEED_MARKER } from '../constants/feedGrammar.js';
import { getWorkflowRailSummary } from '../workflows/workflowPanelSelectors.js';
import { getCachedStringWidth } from '../utils/textUtils.js';
import { isAgentSessionRailInternalTask } from '../utils/backgroundTaskStatus.js';

const MAX_VISIBLE_ROWS = 4;
const MAIN_SESSION_MARKER = FEED_MARKER.subagentRunning;
const AUTO_MEMORY_DREAM_EXECUTION_ID = -3;

interface RailItem {
  kind: 'main' | 'agent' | 'workflow' | 'internal';
  taskId?: string;
  task?: AgentUnifiedTask | WorkflowUnifiedTask | InternalAgentUnifiedTask;
}

function combineAutoMemoryDreamTasks(
  tasks: InternalAgentUnifiedTask[],
): InternalAgentUnifiedTask[] {
  const memoryIndex = tasks.findIndex(
    (task) => task.agentType === 'memory' && !isTerminalStatus(task.status),
  );
  const dreamIndex = tasks.findIndex(
    (task) => task.agentType === 'dream' && !isTerminalStatus(task.status),
  );
  if (memoryIndex === -1 || dreamIndex === -1) {
    return tasks;
  }

  const memory = tasks[memoryIndex];
  const dream = tasks[dreamIndex];
  const insertAt = Math.min(memoryIndex, dreamIndex);
  const combined: InternalAgentUnifiedTask = {
    ...dream,
    id: 'internal-auto-memory-dream',
    executionId: AUTO_MEMORY_DREAM_EXECUTION_ID,
    agentName: 'Memory · Dreaming',
    agentType: 'memory-dream',
    description: 'Memory · Dreaming',
    prompt: 'Memory · Dreaming',
    phase: 'running',
    startTime: Math.min(memory.startTime, dream.startTime),
  };

  return [
    ...tasks.slice(0, insertAt),
    combined,
    ...tasks.filter(
      (_, index) => index > insertAt && index !== memoryIndex && index !== dreamIndex,
    ),
  ];
}

function computeWindow(
  selectedIndex: number,
  totalItems: number,
  maxRows: number,
): { from: number; to: number } {
  if (totalItems <= maxRows) return { from: 0, to: totalItems };
  const half = Math.floor(maxRows / 2);
  const from = Math.max(
    0,
    Math.min(selectedIndex - half, totalItems - maxRows),
  );
  return { from, to: from + maxRows };
}

function agentElapsed(task: AgentUnifiedTask): string {
  const elapsedMs = isTerminalStatus(task.status)
    ? (task.endTime ?? task.startTime) - task.startTime
    : Date.now() - task.startTime;
  return `${Math.max(0, Math.floor(elapsedMs / 1000))}s`;
}

function internalAgentElapsed(task: InternalAgentUnifiedTask): string {
  const elapsedMs = isTerminalStatus(task.status)
    ? (task.endTime ?? task.startTime) - task.startTime
    : Date.now() - task.startTime;
  return `${Math.max(0, Math.floor(elapsedMs / 1000))}s`;
}

function agentStatusText(task: AgentUnifiedTask): string {
  const status = task.isIdle
    ? 'idle'
    : isTerminalStatus(task.status)
      ? task.status
      : agentElapsed(task);
  return task.isBackgrounded && !isInProcessTeammateTask(task)
    ? `bg · ${status}`
    : status;
}

function internalAgentStatusText(task: InternalAgentUnifiedTask): string {
  const status = isTerminalStatus(task.status)
    ? task.status
    : internalAgentElapsed(task);
  return `bg · ${status}`;
}

function taskStatusMarker(status: UnifiedTask['status']): {
  marker: string;
  color: string;
} {
  switch (status) {
    case 'completed':
      return {
        marker: FEED_MARKER.subagentCompleted,
        color: theme.status.success,
      };
    case 'failed':
      return { marker: FEED_MARKER.subagentError, color: theme.status.error };
    case 'killed':
      return {
        marker: FEED_MARKER.subagentCanceled,
        color: theme.text.secondary,
      };
    case 'paused':
      return {
        marker: FEED_MARKER.subagentCanceled,
        color: theme.text.secondary,
      };
    case 'pending':
    case 'running':
    default:
      return {
        marker: FEED_MARKER.subagentRunning,
        color: theme.text.primary,
      };
  }
}

function agentDisplayName(task: AgentUnifiedTask): string {
  return agentTaskDisplayName(task);
}

function aggregateTaskMarker(tasks: UnifiedTask[]): string {
  const priority = tasks.find((task) => isActiveStatus(task.status));
  if (priority) return taskStatusMarker(priority.status).marker;

  const paused = tasks.find((task) => task.status === 'paused');
  if (paused) return taskStatusMarker(paused.status).marker;

  const failed = tasks.find((task) => task.status === 'failed');
  if (failed) return taskStatusMarker(failed.status).marker;

  const killed = tasks.find((task) => task.status === 'killed');
  if (killed) return taskStatusMarker(killed.status).marker;

  return taskStatusMarker(tasks[0].status).marker;
}

function compactStatusSummary(tasks: UnifiedTask[]): string[] {
  const counts = {
    running: 0,
    idle: 0,
    done: 0,
    failed: 0,
    stopped: 0,
    paused: 0,
  };

  for (const task of tasks) {
    if (isAgentTask(task) && isInProcessTeammateTask(task) && task.isIdle) {
      counts.idle += 1;
      continue;
    }
    switch (task.status) {
      case 'completed':
        counts.done += 1;
        break;
      case 'failed':
        counts.failed += 1;
        break;
      case 'killed':
        counts.stopped += 1;
        break;
      case 'paused':
        counts.paused += 1;
        break;
      case 'pending':
      case 'running':
      default:
        counts.running += 1;
        break;
    }
  }

  const parts: string[] = [];
  if (counts.running > 0) parts.push(`${counts.running} running`);
  if (counts.idle > 0) parts.push(`${counts.idle} idle`);
  if (counts.done > 0) parts.push(`${counts.done} done`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.stopped > 0) parts.push(`${counts.stopped} stopped`);
  if (counts.paused > 0) parts.push(`${counts.paused} paused`);
  return parts;
}

function truncateRailText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (getCachedStringWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return '…';

  const suffix = '…';
  const targetWidth = maxWidth - getCachedStringWidth(suffix);
  let result = '';
  let width = 0;

  for (const char of text) {
    const nextWidth = getCachedStringWidth(char);
    if (width + nextWidth > targetWidth) break;
    result += char;
    width += nextWidth;
  }

  return `${result}${suffix}`;
}

// ── Row components ──

function LeaderRow({
  isSelected,
  isViewed,
  hint,
  onClick,
}: {
  isSelected: boolean;
  isViewed: boolean;
  hint?: string;
  onClick?: () => void;
}) {
  const icon = MAIN_SESSION_MARKER;
  const dimmed = !isSelected && !isViewed;
  return (
    <Box onClick={onClick}>
      <Box width={2} flexShrink={0}>
        <Text color={isSelected ? theme.ui.focus : undefined}>
          {isSelected ? figures.pointer : ' '}
        </Text>
      </Box>
      <Text dimColor={dimmed}>{icon} </Text>
      <Text
        dimColor={dimmed}
        bold={isViewed}
        color={isViewed || isSelected ? theme.ui.focus : undefined}
      >
        main
      </Text>
      {hint ? (
        <>
          <Box flexGrow={1} />
          <Text dimColor>{hint}</Text>
        </>
      ) : null}
    </Box>
  );
}

function AgentRow({
  task,
  isSelected,
  isViewed,
  onClick,
}: {
  task: AgentUnifiedTask;
  isSelected: boolean;
  isViewed: boolean;
  onClick?: () => void;
}) {
  const dimmed = !isSelected && !isViewed;

  const marker = taskStatusMarker(task.status);
  const statusColor = isTerminalStatus(task.status) ? marker.color : undefined;
  const nameColor = isViewed ? theme.ui.focus : undefined;

  const name = agentDisplayName(task);

  return (
    <Box onClick={onClick}>
      <Box width={2} flexShrink={0}>
        <Text color={isSelected ? theme.ui.focus : undefined}>
          {isSelected ? figures.pointer : ' '}
        </Text>
      </Box>
      <Text color={marker.color} dimColor={dimmed}>
        {marker.marker}{' '}
      </Text>
      <Text color={nameColor} dimColor={dimmed} bold={isViewed}>
        {name}
      </Text>
      <Box flexGrow={1} flexShrink={1} overflow="hidden" marginLeft={2}>
        <Text dimColor wrap="truncate">
          {task.description}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={1}>
        <Text color={statusColor} dimColor={!statusColor}>
          {agentStatusText(task)}
        </Text>
      </Box>
    </Box>
  );
}

function InternalAgentRow({
  task,
  isSelected,
  onClick,
}: {
  task: InternalAgentUnifiedTask;
  isSelected: boolean;
  onClick?: () => void;
}) {
  const dimmed = !isSelected;
  const marker = taskStatusMarker(task.status);
  const statusColor = isTerminalStatus(task.status) ? marker.color : undefined;

  return (
    <Box onClick={onClick}>
      <Box width={2} flexShrink={0}>
        <Text color={isSelected ? theme.ui.focus : undefined}>
          {isSelected ? figures.pointer : ' '}
        </Text>
      </Box>
      <Text color={marker.color} dimColor={dimmed}>
        {marker.marker}{' '}
      </Text>
      <Text dimColor={dimmed}>{task.agentName}</Text>
      <Box flexGrow={1} flexShrink={1} overflow="hidden" marginLeft={2}>
        <Text dimColor wrap="truncate">
          {task.description}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={1}>
        <Text color={statusColor} dimColor={!statusColor}>
          {internalAgentStatusText(task)}
        </Text>
      </Box>
    </Box>
  );
}

function WorkflowRow({
  task,
  isSelected,
  isViewed,
  onClick,
}: {
  task: WorkflowUnifiedTask;
  isSelected: boolean;
  isViewed: boolean;
  onClick?: () => void;
}) {
  const { stdout } = useStdout();
  const dimmed = !isSelected && !isViewed;
  const marker = taskStatusMarker(task.status);
  const summary = getWorkflowRailSummary(task);
  const statusColor = isTerminalStatus(task.status) ? marker.color : undefined;
  const nameColor = isViewed ? theme.ui.focus : undefined;
  const statusText = `${summary.doneAgents}/${summary.agentCount} agents · ${summary.elapsed}${
    summary.status === 'paused' ? ' · paused' : ''
  }`;
  const rowWidth = Math.max(20, (stdout.columns ?? 80) - 2);
  const pointerWidth = 2;
  const markerBoxWidth = Math.max(2, getCachedStringWidth(marker.marker) + 1);
  const statusWidth = getCachedStringWidth(statusText);
  const statusGapWidth = 1;
  const nameReservedWidth = getCachedStringWidth(summary.label);
  const baseWidth =
    pointerWidth + markerBoxWidth + statusGapWidth + statusWidth;
  const availableForNameAndDescription = Math.max(1, rowWidth - baseWidth);
  const name = truncateRailText(summary.label, availableForNameAndDescription);
  const nameWidth = getCachedStringWidth(name);
  const descriptionGapWidth =
    summary.description && availableForNameAndDescription > nameWidth ? 2 : 0;
  const descriptionWidth =
    nameWidth < nameReservedWidth
      ? 0
      : Math.max(
          0,
          availableForNameAndDescription - nameWidth - descriptionGapWidth,
        );
  const description =
    descriptionWidth > 0
      ? truncateRailText(summary.description, descriptionWidth)
      : '';
  const effectiveDescriptionGapWidth = description ? descriptionGapWidth : 0;
  const renderedWidth =
    pointerWidth +
    markerBoxWidth +
    nameWidth +
    effectiveDescriptionGapWidth +
    getCachedStringWidth(description) +
    statusGapWidth +
    statusWidth;
  const spacerWidth = Math.max(
    0,
    rowWidth - renderedWidth,
  );

  return (
    <Box onClick={onClick} width={rowWidth} overflow="hidden">
      <Box width={2} flexShrink={0}>
        <Text color={isSelected ? theme.ui.focus : undefined}>
          {isSelected ? figures.pointer : ' '}
        </Text>
      </Box>
      <Box width={markerBoxWidth} flexShrink={0}>
        <Text color={marker.color} dimColor={dimmed}>
          {marker.marker}{' '}
        </Text>
      </Box>
      <Box width={nameWidth} flexShrink={0} overflow="hidden">
        <Text
          color={nameColor}
          dimColor={dimmed}
          bold={isViewed}
          wrap="truncate"
        >
          {name}
        </Text>
      </Box>
      {description ? (
        <Box width={descriptionWidth} flexShrink={0} marginLeft={2}>
          <Text dimColor wrap="truncate">
            {description}
          </Text>
        </Box>
      ) : null}
      <Box width={spacerWidth} flexShrink={0} />
      <Box flexShrink={0} marginLeft={1} width={statusWidth}>
        <Text color={statusColor} dimColor={!statusColor}>
          {statusText}
        </Text>
      </Box>
    </Box>
  );
}

// ── Compact single-line ──

function CompactRail({
  items,
  hint,
}: {
  items: RailItem[];
  hint?: string;
}) {
  const agents = items.filter(
    (i): i is RailItem & { task: AgentUnifiedTask } =>
      i.kind === 'agent' && i.task !== undefined,
  );
  const workflows = items.filter(
    (i): i is RailItem & { task: WorkflowUnifiedTask } =>
      i.kind === 'workflow' && i.task !== undefined,
  );
  const internalAgents = items.filter(
    (i): i is RailItem & { task: InternalAgentUnifiedTask } =>
      i.kind === 'internal' && i.task !== undefined,
  );

  const summary = (() => {
    if (
      agents.length === 0 &&
      workflows.length === 0 &&
      internalAgents.length === 0
    ) {
      return `${MAIN_SESSION_MARKER} main`;
    }

    if (
      agents.length === 0 &&
      internalAgents.length === 0 &&
      workflows.length === 1
    ) {
      const task = workflows[0].task;
      const marker = taskStatusMarker(task.status).marker;
      const wf = getWorkflowRailSummary(task);
      const status = wf.status === 'paused' ? ' · paused' : '';
      return `${MAIN_SESSION_MARKER} main · ${marker} ${wf.label} ${wf.doneAgents}/${wf.agentCount} agents · ${wf.elapsed}${status}`;
    }

    if (
      agents.length === 1 &&
      workflows.length === 0 &&
      internalAgents.length === 0
    ) {
      const task = agents[0].task;
      const marker = taskStatusMarker(task.status).marker;
      const name = agentDisplayName(task);
      return `${MAIN_SESSION_MARKER} main · ${marker} ${name} ${agentStatusText(task)}`;
    }

    if (
      agents.length === 0 &&
      workflows.length === 0 &&
      internalAgents.length === 1
    ) {
      const task = internalAgents[0].task;
      const marker = taskStatusMarker(task.status).marker;
      return `${MAIN_SESSION_MARKER} main · ${marker} ${task.agentName} ${internalAgentStatusText(task)}`;
    }

    const agentTasks = agents.map((agent) => agent.task);
    const teammateCount = agentTasks.filter(isInProcessTeammateTask).length;
    const ordinaryAgentCount = agentTasks.length - teammateCount;
    const internalAgentTasks = internalAgents.map((agent) => agent.task);
    const statusParts = compactStatusSummary([
      ...agentTasks,
      ...internalAgentTasks,
    ]);
    const statusSummary =
      statusParts.length > 0 ? ` | ${statusParts.join(' · ')}` : '';
    const internalSummary =
      internalAgents.length > 0
        ? ` · ${internalAgents.length} background agent${
            internalAgents.length === 1 ? '' : 's'
          }`
        : '';

    if (agents.length === 0) {
      if (workflows.length === 0) {
        return `${MAIN_SESSION_MARKER} main · ${aggregateTaskMarker(
          internalAgentTasks,
        )} ${internalAgents.length} background agents${statusSummary}`;
      }
      return `${MAIN_SESSION_MARKER} main · ${workflows.length} workflows${internalSummary}${statusSummary}`;
    }

    const workflowSummary =
      workflows.length > 0 ? ` · ${workflows.length} workflows` : '';
    const agentSummary = [
      ordinaryAgentCount > 0
        ? `${ordinaryAgentCount} agent${ordinaryAgentCount === 1 ? '' : 's'}`
        : '',
      teammateCount > 0
        ? `${teammateCount} teammate${teammateCount === 1 ? '' : 's'}`
        : '',
    ]
      .filter(Boolean)
      .join(' · ');

    return `${MAIN_SESSION_MARKER} main · ${aggregateTaskMarker(agentTasks)} ${agentSummary}${workflowSummary}${internalSummary}${statusSummary}`;
  })();
  const compactText = hint ? `${summary} · ${hint}` : summary;

  return (
    <Box overflow="hidden">
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text dimColor wrap="truncate">
          {compactText}
        </Text>
      </Box>
    </Box>
  );
}

// ── Main component ──

export type AgentSessionRailSelectionMode =
  | 'sessions'
  | SessionRailSelectionMode;

export interface AgentSessionRailProps {
  onFocusRef?: React.MutableRefObject<(() => boolean) | null>;
  selectionMode?: AgentSessionRailSelectionMode;
}

export const AgentSessionRail: React.FC<AgentSessionRailProps> = ({
  onFocusRef,
  selectionMode = 'sessions',
}) => {
  const registry = useTaskRegistry();
  const [tasks, setTasks] = useState<UnifiedTask[]>([]);
  const { state, moveSelection, focusAt, expand, focus, blur, clamp } =
    useAgentSessionView();
  const uiActions = useUIActions();
  const uiState = useUIState();

  useEffect(() => {
    if (!registry) {
      setTasks([]);
      return undefined;
    }
    const refresh = () => {
      setTasks(registry.all().sort((a, b) => b.startTime - a.startTime));
    };

    registry.on('task_registered', refresh);
    registry.on('task_updated', refresh);
    registry.on('task_removed', refresh);
    refresh();

    return () => {
      registry.off('task_registered', refresh);
      registry.off('task_updated', refresh);
      registry.off('task_removed', refresh);
    };
  }, [registry]);

  const agentTasks = useMemo(
    () => tasks.filter((t): t is AgentUnifiedTask => isAgentTask(t)),
    [tasks],
  );
  const workflowTasks = useMemo(
    () => tasks.filter((t): t is WorkflowUnifiedTask => isWorkflowTask(t)),
    [tasks],
  );
  const selectionWorkflowTasks =
    selectionMode === 'workflows'
      ? (uiState.workflowHistoryTasks ?? workflowTasks)
      : workflowTasks;
  const internalAgentTasks = useMemo(
    () => tasks.filter(isAgentSessionRailInternalTask),
    [tasks],
  );

  const items: RailItem[] = useMemo(() => {
    if (selectionMode === 'workflows') {
      return selectionWorkflowTasks.map((task) => ({
        kind: 'workflow' as const,
        taskId: task.id,
        task,
      }));
    }

    const result: RailItem[] = [{ kind: 'main' }];
    for (const task of agentTasks) {
      result.push({ kind: 'agent', taskId: task.id, task });
    }
    for (const task of workflowTasks) {
      result.push({ kind: 'workflow', taskId: task.id, task });
    }
    for (const task of combineAutoMemoryDreamTasks(internalAgentTasks)) {
      result.push({ kind: 'internal', taskId: task.id, task });
    }
    return result;
  }, [
    agentTasks,
    workflowTasks,
    selectionWorkflowTasks,
    internalAgentTasks,
    selectionMode,
  ]);

  const viewedAgent = uiState.viewedAgentTaskId
    ? items.find(
        (item) =>
          item.kind === 'agent' && item.taskId === uiState.viewedAgentTaskId,
      )
    : undefined;
  const viewedWorkflow = uiState.viewedWorkflowTaskId
    ? items.find(
        (item) =>
          item.kind === 'workflow' &&
          item.taskId === uiState.viewedWorkflowTaskId,
      )
    : undefined;
  const effectiveRailMode: AgentRailMode = viewedAgent || viewedWorkflow
    ? 'expanded'
    : state.railMode;
  const workflowSelectionAppliedRef = useRef(false);

  useEffect(() => {
    clamp(items.length);
  }, [items.length, clamp]);

  useEffect(() => {
    if (selectionMode !== 'workflows') {
      workflowSelectionAppliedRef.current = false;
      return;
    }
    if (workflowSelectionAppliedRef.current || items.length === 0) return;

    focusAt(0, items.length);
    workflowSelectionAppliedRef.current = true;
  }, [focusAt, items.length, selectionMode]);

  const isRailActive =
    selectionMode === 'workflows'
      ? selectionWorkflowTasks.length > 0
      : agentTasks.length > 0 ||
        workflowTasks.length > 0 ||
        internalAgentTasks.length > 0;
  const visibleTasks =
    selectionMode === 'workflows'
      ? selectionWorkflowTasks
      : [...agentTasks, ...workflowTasks, ...internalAgentTasks];
  const hasRunning = visibleTasks.some((task) => isActiveStatus(task.status));

  useEffect(() => {
    if (!onFocusRef) return undefined;

    if (!isRailActive) {
      onFocusRef.current = null;
      return undefined;
    }

    onFocusRef.current = () => {
      focus();
      return true;
    };

    return () => {
      onFocusRef.current = null;
    };
  }, [focus, isRailActive, onFocusRef]);

  useRegisterKeyboardContext('AgentRail', isRailActive && state.focused);

  const [, tick] = useState(0);
  useEffect(() => {
    if (!hasRunning) return;
    const interval = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [hasRunning]);

  /**
   * Leave the rail. Blurring alone is not enough: `viewAgentSession` /
   * `viewWorkflowSession` mark the opened task with `retainReason`, which
   * blocks `TaskRegistry.evictTerminal`. If we only blur, a terminal task keeps
   * its retain forever — the `bg · completed` row stays on the rail long past
   * the 30s grace period and the main area keeps rendering the subagent
   * transcript while the user types into the composer. So every exit path
   * (esc, up past the first row, typing a printable character) closes the
   * session view first.
   */
  const leaveRail = useCallback(() => {
    if (
      uiState.viewedAgentTaskId ||
      uiState.viewedWorkflowTaskId ||
      selectionMode === 'workflows'
    ) {
      uiActions.viewMainSession();
    }
    blur();
  }, [
    blur,
    selectionMode,
    uiActions,
    uiState.viewedAgentTaskId,
    uiState.viewedWorkflowTaskId,
  ]);

  const actionHandlers = useMemo(
    (): Record<string, ActionHandler> => ({
      'agentRail:up': () => {
        if (effectiveRailMode === 'compact') {
          expand();
        } else if (
          state.selectedIndex === 0 &&
          selectionMode === 'sessions'
        ) {
          leaveRail();
        } else {
          moveSelection(-1, items.length);
        }
        return true;
      },
      'agentRail:down': () => {
        if (effectiveRailMode === 'compact') {
          expand();
        } else {
          moveSelection(1, items.length);
        }
        return true;
      },
      'agentRail:select': () => {
        const item = items[state.selectedIndex];
        if (item?.kind === 'main') {
          uiActions.viewMainSession();
        } else if (item?.kind === 'agent' && item.taskId) {
          uiActions.viewAgentSession(item.taskId);
        } else if (item?.kind === 'workflow' && item.taskId) {
          uiActions.viewWorkflowSession(item.taskId);
        } else if (item?.kind === 'internal') {
          uiActions.openBackgroundTaskList();
        }
        return true;
      },
      'agentRail:escape': () => {
        leaveRail();
        return true;
      },
    }),
    [moveSelection, items, effectiveRailMode, state.selectedIndex, expand, leaveRail, uiActions, selectionMode],
  );
  useRegisterActionHandlers('AgentRail', actionHandlers, isRailActive && state.focused);

  const fallbackHandler = useMemo(
    (): ActionHandler =>
      (key) => {
        if (key.sequence === 'k' || key.sequence === 'K') {
          const item = items[state.selectedIndex];
          if (
            (item?.kind === 'agent' ||
              item?.kind === 'workflow' ||
              item?.kind === 'internal') &&
            item.task
          ) {
            dismissTask(registry, item.task);
          }
          return true;
        }
        if (key.insertable && !key.ctrl && !key.alt && !key.cmd) {
          leaveRail();
          return false;
        }
        return false;
      },
    [items, leaveRail, registry, state.selectedIndex],
  );
  useRegisterFallbackHandler(
    'AgentRail',
    fallbackHandler,
    isRailActive && state.focused,
  );

  if (!isRailActive) return null;

  const railHint = state.focused
    ? 'enter view · k stop · esc back'
    : `${figures.arrowDown} to manage`;

  if (effectiveRailMode === 'compact') {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <CompactRail items={items} hint={railHint} />
      </Box>
    );
  }

  const selectedIndex = Math.min(state.selectedIndex, items.length - 1);
  const { from, to } = computeWindow(
    selectedIndex,
    items.length,
    MAX_VISIBLE_ROWS,
  );
  const visibleItems = items.slice(from, to);
  const moreAbove = from;
  const moreBelow = items.length - to;

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={1}>
      {moreAbove > 0 && (
        <Text dimColor>
          {'   '}
          {figures.arrowUp} {moreAbove} previous
        </Text>
      )}
      {visibleItems.map((item, i) => {
        const globalIndex = from + i;
        const isSelected = state.focused && globalIndex === selectedIndex;
        const isViewed =
          item.kind === 'main'
            ? !uiState.viewedAgentTaskId && !uiState.viewedWorkflowTaskId
            : item.kind === 'agent'
              ? item.taskId === uiState.viewedAgentTaskId
              : item.kind === 'workflow'
                ? item.taskId === uiState.viewedWorkflowTaskId
                : false;

        if (item.kind === 'main') {
          return (
            <LeaderRow
              key="main"
              isSelected={isSelected}
              isViewed={isViewed}
              hint={railHint}
              onClick={() => uiActions.viewMainSession()}
            />
          );
        }
        if (item.kind === 'agent') {
          return (
            <AgentRow
              key={item.taskId}
              task={item.task as AgentUnifiedTask}
              isSelected={isSelected}
              isViewed={isViewed}
              onClick={() =>
                item.taskId && uiActions.viewAgentSession(item.taskId)
              }
            />
          );
        }
        if (item.kind === 'internal') {
          return (
            <InternalAgentRow
              key={item.taskId}
              task={item.task as InternalAgentUnifiedTask}
              isSelected={isSelected}
              onClick={() => uiActions.openBackgroundTaskList()}
            />
          );
        }
        return (
          <WorkflowRow
            key={item.taskId}
            task={item.task as WorkflowUnifiedTask}
            isSelected={isSelected}
            isViewed={isViewed}
            onClick={() =>
              item.taskId && uiActions.viewWorkflowSession(item.taskId)
            }
          />
        );
      })}
      {moreBelow > 0 && (
        <Text dimColor>
          {'   '}
          {figures.arrowDown} {moreBelow} more
        </Text>
      )}
      {selectionMode === 'workflows' ? (
        <Text dimColor>
          {'   '}↑↓ select · {railHint}
        </Text>
      ) : null}
    </Box>
  );
};
