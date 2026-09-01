import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DaemonSessionMonitorTaskStatus,
  DaemonSessionShellTaskStatus,
  DaemonSessionTaskWithWorkflowStatus,
  DaemonSessionWorkflowTasksStatus,
} from '@qwen-code/sdk/daemon';
import { isSessionDisconnectedError } from '../../utils/sessionErrors';
import {
  computeAgentTreeInfo,
  computeUserBlockingIds,
  reorderChildrenUnderParents,
  TREE_INDENT_MAX_LEVELS,
  type AgentTreeInfo,
} from './agentForest';
import {
  useActions,
  type DaemonSessionActions,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';
import { formatRuntime } from '../../utils/formatRuntime';
import { formatContextTokens } from '../../utils/formatTokenCount';
import { createSentinelSerializer } from '../../utils/sentinelMessage';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
import { PlanExecutionView } from './PlanExecutionView';
import { WorkflowExecutionView } from './WorkflowExecutionView';
import {
  localizeAgentTypeName,
  localizeToolDisplayName,
  sanitizeControlChars,
} from './toolFormatting';
import { Badge } from '../ui/badge';
import styles from './TasksStatusMessage.module.css';

const ACTIVE_EVENT = 'web-shell:tasks-panel-active';
const REFRESH_INTERVAL_MS = 3000;
const LIST_MAX_ROWS = 8;
// Compact web panel budget — intentionally smaller than core's
// MAX_RECENT_ACTIVITIES (10) retention cap, which the CLI's full-height
// detail dialog renders in full.
const MAX_DISPLAYED_ACTIVITIES = 5;

type DaemonSessionTaskStatus = DaemonSessionTaskWithWorkflowStatus;
type DaemonSessionTasksStatus = DaemonSessionWorkflowTasksStatus;
type LegacyTaskStatus = Exclude<
  DaemonSessionTaskWithWorkflowStatus,
  { kind: 'workflow' }
>;

export interface SerializedTasksMessage {
  snapshot: DaemonSessionTasksStatus;
}

export type TasksStatusView = 'all' | 'workflow-active' | 'workflow-history';

const {
  serialize: serializeTasksStatusMessage,
  parse: parseRawTasksStatusMessage,
} = createSentinelSerializer<SerializedTasksMessage>(
  'web-shell:tasks-status:v1:',
);

function parseTasksStatusMessage(
  content: string,
): SerializedTasksMessage | null {
  const parsed = parseRawTasksStatusMessage(content);
  if (!parsed || !parsed.snapshot) return null;
  return parsed;
}

export { serializeTasksStatusMessage, parseTasksStatusMessage };

type TasksPanelStep = 'list' | 'detail';

type TaskStatus = DaemonSessionTaskStatus['status'];

function dispatchActive(id: string, sessionId: string, active: boolean): void {
  window.dispatchEvent(
    new CustomEvent(ACTIVE_EVENT, { detail: { id, sessionId, active } }),
  );
}

function isActive(task: DaemonSessionTaskStatus): boolean {
  return (
    task.status === 'running' ||
    task.status === 'pausing' ||
    task.status === 'paused'
  );
}

function sortTasks(
  tasks: DaemonSessionTaskStatus[],
): DaemonSessionTaskStatus[] {
  return [...tasks].sort((a, b) => {
    const aActive = isActive(a);
    const bActive = isActive(b);
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (aActive) return b.startTime - a.startTime;
    return (b.endTime ?? b.startTime) - (a.endTime ?? a.startTime);
  });
}

/**
 * Display order for the panel: active-first sort, then each nested agent
 * grouped under its parent as a tree. The reorder is a post-pass so a tree
 * spanning the active/terminal buckets stays contiguous at whichever
 * position its root earned. Every visible task list must use this (not bare
 * `sortTasks`) — selection is index-based, so list order IS the contract.
 */
function arrangeTasks(
  tasks: DaemonSessionTaskStatus[],
): DaemonSessionTaskStatus[] {
  return reorderChildrenUnderParents(sortTasks(tasks));
}

function tasksForView(
  tasks: DaemonSessionTaskStatus[],
  view: TasksStatusView,
): DaemonSessionTaskStatus[] {
  if (view === 'all') return arrangeTasks(tasks);
  return arrangeTasks(
    tasks.filter(
      (task) =>
        task.kind === 'workflow' &&
        (view === 'workflow-active' ? isActive(task) : !isActive(task)),
    ),
  );
}

function findWorkflowSourceTask(
  task: DaemonSessionTaskStatus,
  tasks: DaemonSessionTaskStatus[],
): Extract<DaemonSessionTaskStatus, { kind: 'workflow' }> | undefined {
  if (
    task.kind !== 'workflow' ||
    !task.sourceRunId ||
    task.sourceRunId === task.id
  ) {
    return undefined;
  }
  const source = tasks.find(
    (candidate) =>
      candidate.kind === 'workflow' && candidate.id === task.sourceRunId,
  );
  return source?.kind === 'workflow' ? source : undefined;
}

function findWorkflowHistoryTasks(
  task: DaemonSessionTaskStatus,
  tasks: DaemonSessionTaskStatus[],
): Array<Extract<DaemonSessionTaskStatus, { kind: 'workflow' }>> {
  if (task.kind !== 'workflow' || !task.workflowName) return [];
  return tasks
    .filter(
      (
        candidate,
      ): candidate is Extract<DaemonSessionTaskStatus, { kind: 'workflow' }> =>
        candidate.kind === 'workflow' &&
        candidate.id !== task.id &&
        candidate.workflowName === task.workflowName,
    )
    .sort((a, b) => b.startTime - a.startTime);
}

function statusClassName(status: TaskStatus): string {
  switch (status) {
    case 'running':
      return styles.success;
    case 'paused':
      return styles.warning;
    case 'pausing':
      return styles.warning;
    case 'completed':
      return styles.success;
    case 'failed':
      return styles.error;
    case 'cancelled':
      return styles.warning;
    default:
      return '';
  }
}

function statusLabel(
  status: TaskStatus,
  t: ReturnType<typeof useI18n>['t'],
): string {
  switch (status) {
    case 'running':
      return t('tasks.running');
    case 'completed':
      return t('tasks.completed');
    case 'failed':
      return t('tasks.failed');
    case 'cancelled':
      return t('tasks.cancelled');
    case 'paused':
      return t('tasks.paused');
    case 'pausing':
      return t('tasks.pausing');
    default:
      return status;
  }
}

function terminalStatusIcon(status: TaskStatus): string | null {
  switch (status) {
    case 'paused':
      return '⏸';
    case 'pausing':
      return '⏸';
    case 'completed':
      return '✓';
    case 'failed':
    case 'cancelled':
      return '✗';
    case 'running':
      return null;
    default:
      return null;
  }
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`${styles.chevron} ${expanded ? styles.chevronExpanded : ''}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        d="M6 4.5 9.5 8 6 11.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function rowLabel(
  task: DaemonSessionTaskStatus,
  blocking: boolean,
  workflowOnly = false,
): string {
  switch (task.kind) {
    case 'agent':
      // `blocking` comes from computeUserBlockingIds — an agent is tagged
      // only when its entire ancestor chain is foreground up to the
      // top-level session (cancelling it would end the user's turn), not
      // merely for being a foreground entry (a foreground child awaited by
      // a background parent blocks that parent, not the user).
      return blocking ? `[blocking] ${task.label}` : task.label;
    case 'shell':
      return `[shell] ${task.command}`;
    case 'monitor':
      return `[monitor] ${task.description}`;
    case 'workflow':
      return workflowOnly ? task.label : `[workflow] ${task.label}`;
  }
}

function windowTasks(
  tasks: DaemonSessionTaskStatus[],
  selectedIndex: number,
): {
  visible: DaemonSessionTaskStatus[];
  windowStart: number;
  hiddenAbove: number;
  hiddenBelow: number;
} {
  if (tasks.length <= LIST_MAX_ROWS) {
    return {
      visible: tasks,
      windowStart: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
    };
  }

  const effectiveRows = Math.max(1, LIST_MAX_ROWS - 2);
  const windowStart = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(effectiveRows / 2),
      tasks.length - effectiveRows,
    ),
  );
  const windowEnd = Math.min(tasks.length, windowStart + effectiveRows);
  return {
    visible: tasks.slice(windowStart, windowEnd),
    windowStart,
    hiddenAbove: windowStart,
    hiddenBelow: tasks.length - windowEnd,
  };
}

function formatActivityLabel(
  name: string,
  description: string | undefined,
  t: ReturnType<typeof useI18n>['t'],
) {
  const display = localizeToolDisplayName(name, t);
  const singleLineDescription = description
    ? description.replace(/\s*\n\s*/g, ' ').trim()
    : '';
  const label = singleLineDescription
    ? `${display}(${singleLineDescription})`
    : display;
  // The description is LLM-generated; strip bare control bytes so a stray
  // \r/BEL/ESC can't garble the panel (matches the CLI surfaces).
  return sanitizeControlChars(label);
}

export function TasksStatusMessage({
  message,
  embedded = false,
  manageActiveEvent = true,
  keyboardShortcuts = true,
  syncSnapshot = false,
  taskView = 'all',
  emptyLabel,
  onWorkflowRunStarted,
  onTasksChange,
  onClose,
  planTodos = [],
  agentTools = [],
  onOpenSubagent,
  onOpenMonitor,
}: {
  message: SerializedTasksMessage;
  embedded?: boolean;
  manageActiveEvent?: boolean;
  keyboardShortcuts?: boolean;
  syncSnapshot?: boolean;
  taskView?: TasksStatusView;
  emptyLabel?: string;
  onWorkflowRunStarted?: () => void;
  onTasksChange?: (snapshot: DaemonSessionTasksStatus) => void;
  onClose?: () => void;
  planTodos?: readonly TodoItem[];
  agentTools?: readonly ACPToolCall[];
  onOpenSubagent?: (tool: ACPToolCall) => void;
  onOpenMonitor?: (task: DaemonSessionMonitorTaskStatus) => void;
}) {
  const { t } = useI18n();
  const actions = useActions();
  const includeWorkflows =
    taskView !== 'all' ||
    message.snapshot.tasks.some((task) => task.kind === 'workflow');
  const loadTasks = useCallback(
    async (): Promise<DaemonSessionWorkflowTasksStatus> =>
      includeWorkflows ? actions.getWorkflowTasks() : actions.getTasks(),
    [actions, includeWorkflows],
  );
  const [allTasks, setAllTasks] = useState(message.snapshot.tasks);
  const tasks = useMemo(
    () => tasksForView(allTasks, taskView),
    [allTasks, taskView],
  );
  const [isOpen, setIsOpen] = useState(true);
  const [step, setStep] = useState<TasksPanelStep>('list');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    () => tasksForView(message.snapshot.tasks, taskView)[0]?.id ?? null,
  );
  const [pendingCancelId, setPendingCancelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const panelIdRef = useRef(`tasks-${Math.random().toString(36).slice(2)}`);
  const refreshInFlightRef = useRef(false);
  const expectedSessionIdRef = useRef(message.snapshot.sessionId);
  expectedSessionIdRef.current = message.snapshot.sessionId;
  const initialDetailStatusRef = useRef<{
    taskId: string;
    status: TaskStatus;
  } | null>(null);

  useEffect(() => {
    if (syncSnapshot) setAllTasks(message.snapshot.tasks);
  }, [message.snapshot, syncSnapshot]);

  useEffect(() => {
    setBusy(false);
    setActionError(null);
    setPendingCancelId(null);
    setStep('list');
  }, [message.snapshot.sessionId]);

  const selectedIndex = selectedTaskId
    ? tasks.findIndex((task) => task.id === selectedTaskId)
    : -1;
  const clampedSelectedIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const selectedTask = selectedIndex >= 0 ? tasks[selectedIndex] : null;

  // Tree metadata is computed on the full task list (not the windowed
  // slice) so a row's indent doesn't shift when the window scrolls past
  // its parent.
  const treeInfo = useMemo(() => computeAgentTreeInfo(tasks), [tasks]);
  const blockingIds = useMemo(() => computeUserBlockingIds(tasks), [tasks]);

  useEffect(() => {
    if (!isOpen) return;
    const refresh = () => {
      if (refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;
      const requestedSessionId = expectedSessionIdRef.current;
      loadTasks()
        .then((snapshot) => {
          if (
            expectedSessionIdRef.current !== requestedSessionId ||
            snapshot.sessionId !== requestedSessionId
          ) {
            return;
          }
          setAllTasks(snapshot.tasks);
          onTasksChange?.(snapshot);
          setRefreshError(false);
        })
        .catch((error: unknown) => {
          if (expectedSessionIdRef.current !== requestedSessionId) return;
          if (isSessionDisconnectedError(error)) {
            setRefreshError(false);
            return;
          }
          console.warn('[web-shell] failed to refresh tasks:', error);
          setRefreshError(true);
        })
        .finally(() => {
          refreshInFlightRef.current = false;
        });
    };
    const id = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isOpen, loadTasks, onTasksChange]);

  useEffect(() => {
    if (selectedIndex >= 0) return;
    setPendingCancelId(null);
    if (step === 'detail') setStep('list');
    setSelectedTaskId(tasks[0]?.id ?? null);
  }, [selectedIndex, step, tasks]);

  useEffect(() => {
    if (!isOpen || step !== 'detail') {
      initialDetailStatusRef.current = null;
      return;
    }

    if (!selectedTask) {
      initialDetailStatusRef.current = null;
      setStep('list');
      return;
    }

    const initial = initialDetailStatusRef.current;
    if (!initial || initial.taskId !== selectedTask.id) {
      initialDetailStatusRef.current = {
        taskId: selectedTask.id,
        status: selectedTask.status,
      };
      return;
    }

    if (
      (initial.status === 'running' ||
        initial.status === 'pausing' ||
        initial.status === 'paused') &&
      !isActive(selectedTask)
    ) {
      setPendingCancelId(null);
      setStep('list');
    }
  }, [isOpen, step, selectedTask]);

  useEffect(() => {
    if (!manageActiveEvent) return undefined;
    const id = panelIdRef.current;
    const sessionId = message.snapshot.sessionId;
    dispatchActive(id, sessionId, isOpen);
    return () => dispatchActive(id, sessionId, false);
  }, [isOpen, manageActiveEvent, message.snapshot.sessionId]);

  useEffect(() => {
    if (!manageActiveEvent) return undefined;
    const onActiveChange = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; active?: boolean }>)
        .detail;
      if (detail?.active && detail.id && detail.id !== panelIdRef.current) {
        setIsOpen(false);
      }
    };
    window.addEventListener(ACTIVE_EVENT, onActiveChange);
    return () => window.removeEventListener(ACTIVE_EVENT, onActiveChange);
  }, [manageActiveEvent]);

  useEffect(() => {
    if (!isOpen) onClose?.();
  }, [isOpen, onClose]);

  const handleCancel = useCallback(
    async (task: DaemonSessionTaskStatus) => {
      if (busy) return;
      const sessionId = expectedSessionIdRef.current;
      const isRunning = task.status === 'running';
      const isAbandonable = task.kind === 'agent' && task.status === 'paused';
      const isActiveWorkflow = task.kind === 'workflow' && isActive(task);
      if (!isRunning && !isAbandonable && !isActiveWorkflow) return;
      // Two-step confirm only when cancelling would end the USER's turn —
      // the same chain-aware verdict as the `[blocking]` row prefix. A
      // foreground child awaited by a *background* parent unblocks that
      // parent, not the user, so it cancels on the first press like any
      // background entry. Mirrors BackgroundTasksDialog's cancel gate.
      const isUserBlockingAgent =
        task.kind === 'agent' && blockingIds.has(task.id);
      if (isUserBlockingAgent && pendingCancelId !== task.id) {
        setPendingCancelId(task.id);
        return;
      }
      setPendingCancelId(null);
      setBusy(true);
      try {
        const result = await actions.cancelTask(task.id, task.kind);
        if (expectedSessionIdRef.current !== sessionId) return;
        if (!result.cancelled) {
          setActionError(t('tasks.alreadyStopped'));
          return;
        }
        const snapshot = await loadTasks();
        if (
          expectedSessionIdRef.current !== sessionId ||
          snapshot.sessionId !== sessionId
        ) {
          return;
        }
        setAllTasks(snapshot.tasks);
        onTasksChange?.(snapshot);
        if (taskView === 'workflow-active') setStep('list');
        setActionError(null);
      } catch (error: unknown) {
        if (expectedSessionIdRef.current !== sessionId) return;
        console.warn('[web-shell] failed to cancel task:', error);
        setActionError(t('tasks.cancelFailed'));
      } finally {
        if (expectedSessionIdRef.current === sessionId) setBusy(false);
      }
    },
    [
      actions,
      busy,
      blockingIds,
      loadTasks,
      onTasksChange,
      pendingCancelId,
      t,
      taskView,
    ],
  );

  const handleWorkflowAction = useCallback(
    async (
      task: Extract<DaemonSessionTaskStatus, { kind: 'workflow' }>,
      action: 'pause' | 'resume' | 'retry' | 'rerun',
    ) => {
      if (busy) return;
      const sessionId = expectedSessionIdRef.current;
      setBusy(true);
      try {
        const result = await actions.controlWorkflowTask(task.id, action);
        if (expectedSessionIdRef.current !== sessionId) return;
        if (!result.changed) {
          setActionError(t('workflow.action.unavailable'));
          return;
        }
        if (action === 'retry' || action === 'rerun') {
          onWorkflowRunStarted?.();
        }
        const snapshot = await loadTasks();
        if (
          expectedSessionIdRef.current !== sessionId ||
          snapshot.sessionId !== sessionId
        ) {
          return;
        }
        const nextTasks = tasksForView(snapshot.tasks, taskView);
        setAllTasks(snapshot.tasks);
        onTasksChange?.(snapshot);
        if (result.taskId) {
          if (nextTasks.some((candidate) => candidate.id === result.taskId)) {
            setSelectedTaskId(result.taskId);
          }
        }
        setActionError(null);
      } catch (error: unknown) {
        if (expectedSessionIdRef.current !== sessionId) return;
        console.warn('[web-shell] failed to control workflow:', error);
        setActionError(t('workflow.action.failed'));
      } finally {
        if (expectedSessionIdRef.current === sessionId) setBusy(false);
      }
    },
    [
      actions,
      busy,
      loadTasks,
      onTasksChange,
      onWorkflowRunStarted,
      t,
      taskView,
    ],
  );

  const handleWorkflowHistoryDelete = useCallback(
    async (runId: string) => {
      if (busy) return;
      const sessionId = expectedSessionIdRef.current;
      setBusy(true);
      try {
        const result = await actions.controlWorkflowTask(
          runId,
          'delete-history',
        );
        if (expectedSessionIdRef.current !== sessionId) return;
        if (!result.changed) {
          setActionError(t('workflow.history.deleteUnavailable'));
          return;
        }
        const snapshot = await loadTasks();
        if (
          expectedSessionIdRef.current !== sessionId ||
          snapshot.sessionId !== sessionId
        ) {
          return;
        }
        setAllTasks(snapshot.tasks);
        onTasksChange?.(snapshot);
        if (selectedTask?.id === runId) setStep('list');
        setActionError(null);
      } catch (error: unknown) {
        if (expectedSessionIdRef.current !== sessionId) return;
        console.warn('[web-shell] failed to delete workflow history:', error);
        setActionError(t('workflow.history.deleteFailed'));
      } finally {
        if (expectedSessionIdRef.current === sessionId) setBusy(false);
      }
    },
    [actions, busy, loadTasks, onTasksChange, selectedTask?.id, t],
  );

  useDelayedGlobalKeyDown(
    (event: KeyboardEvent) => {
      if (!keyboardShortcuts || !isOpen) return;

      if (
        event.key !== 'Escape' &&
        event.target instanceof Element &&
        event.target.closest('[data-plan-interactive]')
      ) {
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (pendingCancelId) {
          setPendingCancelId(null);
          return;
        }
        if (step === 'detail') {
          setStep('list');
        } else {
          setIsOpen(false);
        }
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        if (step === 'detail') {
          setPendingCancelId(null);
          setStep('list');
        } else {
          setIsOpen(false);
        }
        return;
      }

      if (
        (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
        step === 'list'
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (tasks.length === 0) return;
        const delta = event.key === 'ArrowUp' ? -1 : 1;
        const nextIndex = Math.min(
          Math.max(clampedSelectedIndex + delta, 0),
          tasks.length - 1,
        );
        setSelectedTaskId(tasks[nextIndex]?.id ?? null);
        setPendingCancelId(null);
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (step === 'list' && selectedTask) {
          if (embedded && selectedTask.kind === 'monitor' && onOpenMonitor) {
            onOpenMonitor(selectedTask);
          } else {
            setStep('detail');
          }
        } else if (step === 'detail') {
          setIsOpen(false);
        }
        return;
      }

      if (event.key === ' ' && step === 'detail') {
        event.preventDefault();
        event.stopPropagation();
        setIsOpen(false);
        return;
      }

      if (event.key === 'x' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        if (selectedTask) {
          void handleCancel(selectedTask);
        }
        return;
      }
    },
    [
      embedded,
      keyboardShortcuts,
      isOpen,
      step,
      tasks.length,
      clampedSelectedIndex,
      selectedTask,
      handleCancel,
      onOpenMonitor,
      pendingCancelId,
    ],
  );

  if (!isOpen) return null;

  const showCancelConfirm =
    pendingCancelId !== null &&
    selectedTask !== null &&
    pendingCancelId === selectedTask.id;

  const listHints: string[] = [];
  if (showCancelConfirm) {
    listHints.push(t('tasks.confirmStop'));
    listHints.push(t('tasks.shortcut.cancelConfirm'));
  } else {
    listHints.push(t('tasks.shortcut.select'));
    listHints.push(t('tasks.shortcut.view'));
    if (selectedTask?.kind === 'agent' && selectedTask?.status === 'paused') {
      listHints.push(t('tasks.shortcut.abandon'));
    } else if (selectedTask && isActive(selectedTask)) {
      listHints.push(t('tasks.shortcut.stop'));
    }
    listHints.push(t('tasks.shortcut.listClose'));
  }

  const detailHints: string[] = [];
  if (showCancelConfirm) {
    detailHints.push(t('tasks.confirmStop'));
    detailHints.push(t('tasks.shortcut.cancelConfirm'));
  } else {
    detailHints.push(t('tasks.shortcut.detailBack'));
    detailHints.push(t('tasks.shortcut.detailClose'));
    if (selectedTask?.kind === 'agent' && selectedTask?.status === 'paused') {
      detailHints.push(t('tasks.shortcut.abandon'));
    } else if (selectedTask && isActive(selectedTask)) {
      detailHints.push(t('tasks.shortcut.stop'));
    }
  }

  if (tasks.length === 0) {
    return (
      <div
        className={
          embedded ? `${styles.panel} ${styles.embeddedPanel}` : styles.panel
        }
        data-keyboard-scope
      >
        {(refreshError || actionError || !embedded) && (
          <div className={styles.header}>
            {!embedded && (
              <div className={styles.title}>{t('tasks.title')}</div>
            )}
            {refreshError && (
              <div className={styles.warning}>{t('tasks.refreshStale')}</div>
            )}
            {actionError && <div className={styles.error}>{actionError}</div>}
          </div>
        )}
        <PlanExecutionView
          todos={planTodos}
          tools={agentTools}
          tasks={tasks.filter(
            (task): task is LegacyTaskStatus => task.kind !== 'workflow',
          )}
          onOpenSubagent={onOpenSubagent}
        />
        <div>
          <div className={styles.secondary}>
            {emptyLabel ?? t('tasks.empty')}
          </div>
        </div>
        {!embedded && (
          <div className={styles.shortcuts}>{t('tasks.shortcut.close')}</div>
        )}
      </div>
    );
  }

  const { visible, windowStart, hiddenAbove, hiddenBelow } = windowTasks(
    tasks,
    clampedSelectedIndex,
  );
  const listTasks = embedded ? tasks : visible;
  const listOffset = embedded ? 0 : windowStart;

  return (
    <div
      className={
        embedded ? `${styles.panel} ${styles.embeddedPanel}` : styles.panel
      }
      data-keyboard-scope
    >
      {(embedded || step === 'list') &&
        (refreshError || actionError || !embedded) && (
          <div className={styles.header}>
            {!embedded && (
              <div className={styles.title}>{t('tasks.title')}</div>
            )}
            {refreshError && (
              <div className={styles.warning}>{t('tasks.refreshStale')}</div>
            )}
            {actionError && <div className={styles.error}>{actionError}</div>}
          </div>
        )}

      {(embedded || step === 'list') && (
        <PlanExecutionView
          todos={planTodos}
          tools={agentTools}
          tasks={tasks.filter(
            (task): task is LegacyTaskStatus => task.kind !== 'workflow',
          )}
          onOpenSubagent={onOpenSubagent}
        />
      )}
      {(embedded || step === 'list') && (
        <div className={styles.list}>
          {!embedded && (
            <div className={styles.sectionTitle}>
              {t('tasks.title')}{' '}
              <span className={styles.secondary}>({tasks.length})</span>
            </div>
          )}
          {!embedded && hiddenAbove > 0 && (
            <div className={styles.overflowHint}>
              {t('tasks.moreAbove', { count: hiddenAbove })}
            </div>
          )}
          {listTasks.map((task, visibleIndex) => {
            const index = listOffset + visibleIndex;
            const selected = index === clampedSelectedIndex;
            const stClass = statusClassName(task.status);
            const taskStatusLabel = statusLabel(task.status, t);
            const expanded = embedded && selected && step === 'detail';
            const showSelected = embedded ? expanded : selected;
            const tree: AgentTreeInfo | undefined =
              task.kind === 'agent' ? treeInfo.get(task.id) : undefined;
            // Indent clamps so deep trees don't starve the label column;
            // the detail view's nesting line carries the exact depth.
            const indentLevels = Math.min(
              tree?.visibleDepth ?? 0,
              TREE_INDENT_MAX_LEVELS,
            );
            // The ↳ marker is kept even for orphans (parent already gone,
            // depth back at 0) so "this was a nested agent" stays legible.
            const nestedMarker =
              task.kind === 'agent' && task.parentAgentId != null;
            const orphanNote = tree?.orphaned
              ? task.kind === 'agent' && task.parentName
                ? t('tasks.row.from', { parent: task.parentName })
                : t('tasks.row.nested')
              : null;
            const activateTask = () => {
              setSelectedTaskId(task.id);
              if (embedded && task.kind === 'monitor' && onOpenMonitor) {
                onOpenMonitor(task);
              } else {
                setStep(embedded && expanded ? 'list' : 'detail');
              }
            };
            return (
              <div
                key={task.id}
                className={`${styles.task} ${
                  expanded ? styles.taskExpanded : ''
                }`}
              >
                <div
                  className={
                    showSelected
                      ? `${styles.row} ${styles.selected}`
                      : styles.row
                  }
                  role="button"
                  tabIndex={0}
                  aria-expanded={
                    embedded && !(task.kind === 'monitor' && onOpenMonitor)
                      ? expanded
                      : undefined
                  }
                  onClick={activateTask}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    activateTask();
                  }}
                  onFocus={() => {
                    // Embedded rows are focusable too, and the global
                    // shortcuts (`x` to cancel) act on the SELECTION — so
                    // without this the user can Tab to one row and cancel
                    // another. Not while a row is expanded: focus moving
                    // into the detail must not re-target the selection
                    // (pinned by the "focus does not expand" case).
                    if (!embedded || step !== 'detail') {
                      setSelectedTaskId(task.id);
                    }
                  }}
                  onMouseEnter={() => {
                    if (!embedded) setSelectedTaskId(task.id);
                  }}
                >
                  <span className={styles.pointer}>
                    {showSelected ? '❯' : ''}
                  </span>
                  {embedded && (
                    <span className={styles.taskIcon} aria-hidden="true" />
                  )}
                  <span
                    className={styles.nameCell}
                    style={
                      indentLevels > 0
                        ? { paddingLeft: `${indentLevels * 16}px` }
                        : undefined
                    }
                  >
                    {nestedMarker && (
                      <span className={styles.treeMarker} aria-hidden="true">
                        {'↳ '}
                      </span>
                    )}
                    {rowLabel(
                      task,
                      blockingIds.has(task.id),
                      taskView !== 'all',
                    )}
                    {orphanNote && (
                      <span className={styles.orphanNote}>
                        {' · '}
                        {orphanNote}
                      </span>
                    )}
                  </span>
                  <span className={`${styles.status} ${stClass}`}>
                    {taskStatusLabel}
                  </span>
                  <span className={styles.chevronCell}>
                    <ChevronIcon expanded={expanded} />
                  </span>
                </div>
                {expanded && (
                  <div className={styles.inlineDetail} data-kind={task.kind}>
                    <TaskDetail
                      task={task}
                      t={t}
                      hideHeader
                      busy={busy}
                      showCancelConfirm={pendingCancelId === task.id}
                      onCancel={() => void handleCancel(task)}
                      sourceWorkflowTask={findWorkflowSourceTask(
                        task,
                        allTasks,
                      )}
                      workflowHistoryTasks={findWorkflowHistoryTasks(
                        task,
                        allTasks,
                      )}
                      onWorkflowAction={(action) =>
                        task.kind === 'workflow'
                          ? void handleWorkflowAction(task, action)
                          : undefined
                      }
                      onDeleteWorkflowHistory={(runId) =>
                        void handleWorkflowHistoryDelete(runId)
                      }
                      onCancelConfirmDismiss={() => setPendingCancelId(null)}
                    />
                  </div>
                )}
              </div>
            );
          })}
          {!embedded && hiddenBelow > 0 && (
            <div className={styles.overflowHint}>
              {t('tasks.moreBelow', { count: hiddenBelow })}
            </div>
          )}
        </div>
      )}

      {!embedded && step === 'detail' && selectedTask && (
        <>
          {actionError && <div className={styles.error}>{actionError}</div>}
          <TaskDetail
            task={selectedTask}
            t={t}
            busy={busy}
            showCancelConfirm={pendingCancelId === selectedTask.id}
            onCancel={() => void handleCancel(selectedTask)}
            sourceWorkflowTask={findWorkflowSourceTask(selectedTask, allTasks)}
            workflowHistoryTasks={findWorkflowHistoryTasks(
              selectedTask,
              allTasks,
            )}
            onWorkflowAction={(action) =>
              selectedTask.kind === 'workflow'
                ? void handleWorkflowAction(selectedTask, action)
                : undefined
            }
            onDeleteWorkflowHistory={(runId) =>
              void handleWorkflowHistoryDelete(runId)
            }
            onCancelConfirmDismiss={() => setPendingCancelId(null)}
          />
        </>
      )}

      {!embedded && (
        <div
          className={
            showCancelConfirm
              ? `${styles.shortcuts} ${styles.confirmHint}`
              : styles.shortcuts
          }
        >
          {(step === 'list' ? listHints : detailHints).join(' · ')}
        </div>
      )}
    </div>
  );
}

function detailTitle(
  task: DaemonSessionTaskStatus,
  t: ReturnType<typeof useI18n>['t'],
): string {
  switch (task.kind) {
    case 'agent':
      return `${task.subagentType ? localizeAgentTypeName(task.subagentType, t) : t('common.agent')} › ${task.label}`;
    case 'shell':
      return `${t('tasks.kind.shell')} › ${task.command}`;
    case 'monitor':
      return `${t('tasks.kind.monitor')} › ${task.description}`;
    case 'workflow':
      return `${t('tasks.kind.workflow')} › ${task.label}`;
  }
}

export function MonitorTaskDetail({
  task,
  actions: providedActions,
}: {
  task: DaemonSessionMonitorTaskStatus;
  actions?: DaemonSessionActions;
}) {
  const { t } = useI18n();
  const contextActions = useActions();
  const actions = providedActions ?? contextActions;
  const [currentTask, setCurrentTask] = useState(task);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setCurrentTask((current) =>
      current.id === task.id &&
      current.status !== 'running' &&
      task.status === 'running'
        ? current
        : task,
    );
  }, [task]);

  useEffect(() => {
    setActionError(null);
  }, [task.id, task.status]);

  const handleCancel = useCallback(async () => {
    if (busy || currentTask.status !== 'running') return;
    setActionError(null);
    setBusy(true);
    try {
      const result = await actions.cancelTask(currentTask.id, 'monitor');
      if (!result.cancelled) {
        setActionError(t('tasks.alreadyStopped'));
        return;
      }
      setCurrentTask({
        ...currentTask,
        status: 'cancelled',
        endTime: Date.now(),
      });
      setActionError(null);
      try {
        const snapshot = await actions.getTasks();
        const updatedTask = snapshot.tasks.find(
          (candidate): candidate is DaemonSessionMonitorTaskStatus =>
            candidate.kind === 'monitor' && candidate.id === currentTask.id,
        );
        if (updatedTask && updatedTask.status !== 'running') {
          setCurrentTask(updatedTask);
        }
      } catch (error: unknown) {
        console.warn('[web-shell] failed to refresh stopped monitor:', error);
      }
    } catch (error: unknown) {
      console.warn('[web-shell] failed to cancel monitor:', error);
      setActionError(t('tasks.cancelFailed'));
    } finally {
      setBusy(false);
    }
  }, [actions, busy, currentTask, t]);

  return (
    <div className={styles.monitorDetail}>
      <div className={styles.monitorOverview}>
        <div className={styles.monitorHeadingRow}>
          <div className={styles.monitorDescription}>
            {currentTask.description}
          </div>
          <div className={styles.monitorStatusActions}>
            <Badge
              variant="outline"
              className={styles.monitorStatusTag}
              data-status={currentTask.status}
            >
              {statusLabel(currentTask.status, t)}
            </Badge>
            {currentTask.status === 'running' && (
              <button
                type="button"
                className={styles.monitorStopButton}
                disabled={busy}
                onClick={() => void handleCancel()}
              >
                {busy ? t('common.loading') : t('tasks.action.stop')}
              </button>
            )}
          </div>
        </div>
        {actionError && (
          <div className={styles.monitorActionError}>{actionError}</div>
        )}
        <div className={styles.monitorMetrics}>
          <MonitorMetric
            label={t('tasks.detail.runtime')}
            value={formatRuntime(currentTask.runtimeMs)}
          />
          <MonitorMetric
            label={t('tasks.detail.eventCount')}
            value={String(currentTask.eventCount)}
          />
          {currentTask.pid !== undefined && (
            <MonitorMetric
              label={t('tasks.detail.pid')}
              value={String(currentTask.pid)}
            />
          )}
          {currentTask.eventCount > 0 && (
            <MonitorMetric
              label={t('tasks.detail.lastEvent')}
              value={new Date(currentTask.lastEventTime).toLocaleTimeString()}
            />
          )}
          {currentTask.droppedLines > 0 && (
            <MonitorMetric
              label={t('tasks.detail.droppedCount')}
              value={String(currentTask.droppedLines)}
            />
          )}
          {currentTask.exitCode !== undefined && (
            <MonitorMetric
              label={t('tasks.detail.exitCode')}
              value={String(currentTask.exitCode)}
            />
          )}
        </div>
      </div>
      <div className={styles.monitorCommandSection}>
        <div className={styles.monitorSectionLabel}>
          {t('tasks.detail.command')}
        </div>
        <pre className={styles.monitorCommand}>{currentTask.command}</pre>
      </div>
      {currentTask.error && (
        <div className={styles.monitorError}>
          <div className={styles.monitorSectionLabel}>
            {t('tasks.detail.error')}
          </div>
          <div>{currentTask.error}</div>
        </div>
      )}
    </div>
  );
}

export function ShellTaskDetail({
  task,
  actions: providedActions,
}: {
  task: DaemonSessionShellTaskStatus;
  actions?: DaemonSessionActions;
}) {
  const { t } = useI18n();
  const contextActions = useActions();
  const actions = providedActions ?? contextActions;
  const [currentTask, setCurrentTask] = useState(task);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setCurrentTask((current) =>
      current.id === task.id &&
      current.status !== 'running' &&
      task.status === 'running'
        ? current
        : task,
    );
  }, [task]);

  useEffect(() => {
    setActionError(null);
  }, [task.id, task.status]);

  const handleCancel = useCallback(async () => {
    if (busy || currentTask.status !== 'running') return;
    setActionError(null);
    setBusy(true);
    try {
      const result = await actions.cancelTask(currentTask.id, 'shell');
      if (!result.cancelled) {
        setActionError(t('tasks.alreadyStopped'));
        return;
      }
      setCurrentTask({
        ...currentTask,
        status: 'cancelled',
        endTime: Date.now(),
      });
      try {
        const snapshot = await actions.getTasks();
        const updatedTask = snapshot.tasks.find(
          (candidate): candidate is DaemonSessionShellTaskStatus =>
            candidate.kind === 'shell' && candidate.id === currentTask.id,
        );
        if (updatedTask && updatedTask.status !== 'running') {
          setCurrentTask(updatedTask);
        }
      } catch (error: unknown) {
        console.warn(
          '[web-shell] failed to refresh stopped shell task:',
          error,
        );
      }
    } catch (error: unknown) {
      console.warn('[web-shell] failed to cancel shell task:', error);
      setActionError(t('tasks.cancelFailed'));
    } finally {
      setBusy(false);
    }
  }, [actions, busy, currentTask, t]);

  return (
    <div className={styles.monitorDetail}>
      <div className={styles.monitorOverview}>
        <div className={styles.monitorHeadingRow}>
          <div className={styles.monitorDescription}>
            {t('tasks.kind.shell')}
          </div>
          <div className={styles.monitorStatusActions}>
            <Badge
              variant="outline"
              className={styles.monitorStatusTag}
              data-status={currentTask.status}
            >
              {statusLabel(currentTask.status, t)}
            </Badge>
            {currentTask.status === 'running' && (
              <button
                type="button"
                className={styles.monitorStopButton}
                disabled={busy}
                onClick={() => void handleCancel()}
              >
                {busy ? t('common.loading') : t('tasks.action.stop')}
              </button>
            )}
          </div>
        </div>
        <pre className={styles.monitorCommand}>{currentTask.command}</pre>
        {actionError && (
          <div className={styles.monitorActionError}>{actionError}</div>
        )}
        <div className={styles.monitorMetrics}>
          <MonitorMetric
            label={t('tasks.detail.runtime')}
            value={formatRuntime(currentTask.runtimeMs)}
          />
          {currentTask.pid !== undefined && (
            <MonitorMetric
              label={t('tasks.detail.pid')}
              value={String(currentTask.pid)}
            />
          )}
          {currentTask.exitCode !== undefined && (
            <MonitorMetric
              label={t('tasks.detail.exitCode')}
              value={String(currentTask.exitCode)}
            />
          )}
        </div>
      </div>
      <div className={styles.shellFields}>
        <div className={styles.monitorCommandSection}>
          <div className={styles.monitorSectionLabel}>
            {t('tasks.detail.workingDir')}
          </div>
          <div className={styles.shellFieldValue}>{currentTask.cwd}</div>
        </div>
        {currentTask.outputFile && (
          <div className={styles.monitorCommandSection}>
            <div className={styles.monitorSectionLabel}>
              {t('tasks.detail.outputFile')}
            </div>
            <div className={styles.shellFieldValue}>
              {currentTask.outputFile}
            </div>
          </div>
        )}
      </div>
      {currentTask.error && (
        <div className={`${styles.monitorError} ${styles.shellError}`}>
          <div className={styles.monitorSectionLabel}>
            {t('tasks.detail.error')}
          </div>
          <div>{currentTask.error}</div>
        </div>
      )}
    </div>
  );
}

function MonitorMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.monitorMetric}>
      <div className={styles.monitorMetricValue}>{value}</div>
      <div className={styles.monitorMetricLabel}>{label}</div>
    </div>
  );
}

function TaskDetail({
  task,
  t,
  hideHeader = false,
  busy = false,
  showCancelConfirm = false,
  onCancel,
  sourceWorkflowTask,
  workflowHistoryTasks,
  onWorkflowAction,
  onDeleteWorkflowHistory,
  onCancelConfirmDismiss,
}: {
  task: DaemonSessionTaskStatus;
  t: ReturnType<typeof useI18n>['t'];
  hideHeader?: boolean;
  busy?: boolean;
  showCancelConfirm?: boolean;
  onCancel?: () => void;
  sourceWorkflowTask?: Extract<DaemonSessionTaskStatus, { kind: 'workflow' }>;
  workflowHistoryTasks?: Array<
    Extract<DaemonSessionTaskStatus, { kind: 'workflow' }>
  >;
  onWorkflowAction?: (action: 'pause' | 'resume' | 'retry' | 'rerun') => void;
  onDeleteWorkflowHistory?: (runId: string) => void;
  onCancelConfirmDismiss?: () => void;
}) {
  const terminalIcon = terminalStatusIcon(task.status);
  const stClass = statusClassName(task.status);
  const isAbandonable = task.kind === 'agent' && task.status === 'paused';
  const canCancel =
    task.status === 'running' ||
    isAbandonable ||
    (task.kind === 'workflow' &&
      (task.status === 'pausing' || task.status === 'paused'));
  const canPause =
    task.kind === 'workflow' &&
    task.isBackgrounded &&
    task.status === 'running';
  const canResume = task.kind === 'workflow' && task.status === 'paused';
  const canRetry =
    task.kind === 'workflow' && !task.isHistorical && task.status === 'failed';
  const canRerun =
    task.kind === 'workflow' &&
    !task.isHistorical &&
    (task.status === 'completed' ||
      task.status === 'failed' ||
      task.status === 'cancelled');
  const cancelLabel = isAbandonable
    ? t('tasks.action.abandon')
    : t('tasks.action.stop');
  const confirmLabel = isAbandonable
    ? t('tasks.action.confirmAbandon')
    : t('tasks.action.confirmStop');
  const subtitleParts = [formatRuntime(task.runtimeMs)];
  const compactFields = [
    {
      label: t('tasks.detail.runtime'),
      value: formatRuntime(task.runtimeMs),
    },
  ];

  const agentOutputTokens =
    task.kind === 'agent'
      ? (((task.stats as Record<string, unknown> | undefined)?.[
          'outputTokens'
        ] as number | undefined) ?? task.stats?.totalTokens)
      : undefined;
  if (agentOutputTokens) {
    subtitleParts.push(
      t('tasks.detail.tokens', {
        count: formatContextTokens(agentOutputTokens),
      }),
    );
    compactFields.push({
      label: t('tasks.detail.tokenCount'),
      value: formatContextTokens(agentOutputTokens),
    });
  }

  if (task.kind === 'workflow' && task.tokensSpent > 0) {
    // Subtitle only: compactFields is read from `headerContent`, which
    // short-circuits to null for workflow tasks before it looks at the
    // array — a compact entry here renders in no state.
    subtitleParts.push(
      t('tasks.detail.tokens', {
        count: formatContextTokens(task.tokensSpent),
      }),
    );
  }

  if (task.kind === 'agent' && task.stats?.toolUses !== undefined) {
    subtitleParts.push(
      t('tasks.detail.toolCalls', {
        count: task.stats.toolUses,
      }),
    );
    compactFields.push({
      label: t('tasks.detail.toolCallCount'),
      value: String(task.stats.toolUses),
    });
  }

  if (
    (task.kind === 'shell' || task.kind === 'monitor') &&
    task.pid !== undefined
  ) {
    subtitleParts.push(`pid ${task.pid}`);
  }

  if (task.kind === 'shell' && task.exitCode !== undefined) {
    subtitleParts.push(t('tasks.detail.exit', { exitCode: task.exitCode }));
  }

  if (task.kind === 'monitor') {
    subtitleParts.push(t('tasks.detail.events', { count: task.eventCount }));
    if (task.droppedLines > 0) {
      subtitleParts.push(
        t('tasks.detail.dropped', { count: task.droppedLines }),
      );
    }
    if (task.exitCode !== undefined) {
      subtitleParts.push(t('tasks.detail.exit', { exitCode: task.exitCode }));
    }
  }

  const promptLines =
    task.kind === 'agent' && task.prompt ? task.prompt.split('\n') : [];
  const actionControls =
    (canCancel && onCancel) ||
    ((canPause || canResume || canRetry || canRerun) && onWorkflowAction) ? (
      <div className={styles.actionBar} data-plan-interactive>
        {showCancelConfirm ? (
          <>
            <span className={styles.actionHint}>
              {t('tasks.action.confirmHint')}
            </span>
            <button
              type="button"
              className={`${styles.actionButton} ${styles.dangerButton}`}
              disabled={busy}
              onClick={onCancel}
            >
              {confirmLabel}
            </button>
            <button
              type="button"
              className={styles.actionButton}
              onClick={onCancelConfirmDismiss}
            >
              {t('common.cancel')}
            </button>
          </>
        ) : (
          <>
            {(canPause || canResume) && onWorkflowAction && (
              <button
                type="button"
                className={styles.actionButton}
                disabled={busy}
                onClick={() => onWorkflowAction(canPause ? 'pause' : 'resume')}
              >
                {canPause
                  ? t('workflow.action.pause')
                  : t('workflow.action.resume')}
              </button>
            )}
            {canRetry && onWorkflowAction && (
              <button
                type="button"
                className={`${styles.actionButton} ${styles.primaryActionButton}`}
                data-tone="primary"
                disabled={busy}
                onClick={() => onWorkflowAction('retry')}
              >
                {t('workflow.action.retry')}
              </button>
            )}
            {canRerun && onWorkflowAction && (
              <button
                type="button"
                className={styles.actionButton}
                disabled={busy}
                onClick={() => onWorkflowAction('rerun')}
              >
                {t('workflow.action.rerun')}
              </button>
            )}
            {canCancel && onCancel && (
              <button
                type="button"
                className={`${styles.actionButton} ${styles.dangerButton}`}
                disabled={busy}
                onClick={onCancel}
              >
                {cancelLabel}
              </button>
            )}
          </>
        )}
      </div>
    ) : null;
  const headerContent = !hideHeader ? (
    <>
      <div className={styles.title}>{detailTitle(task, t)}</div>
      <div className={styles.statusBadge}>
        {terminalIcon && (
          <>
            <span className={stClass}>
              {terminalIcon} {t(`tasks.${task.status}`)}
            </span>
            <span className={styles.separator}>·</span>
          </>
        )}
        <span className={styles.secondary}>{subtitleParts.join(' · ')}</span>
      </div>
    </>
  ) : task.kind === 'workflow' ? null : compactFields.length > 0 ? (
    <div className={styles.compactSummary}>
      {compactFields
        .map((field) => `${field.label} ${field.value}`)
        .join(' · ')}
    </div>
  ) : null;

  // Workflow controls live in the execution graph's own toolbar, next to the
  // metrics they act on, instead of floating above the card.
  const topActions = task.kind === 'workflow' ? null : actionControls;

  return (
    <div className={styles.detail}>
      {(headerContent || topActions) && (
        <div className={styles.detailTop}>
          {headerContent && (
            <div className={styles.detailTopMain}>{headerContent}</div>
          )}
          {topActions}
        </div>
      )}

      {task.kind === 'shell' && (
        <>
          <DetailField label={t('tasks.detail.workingDir')} value={task.cwd} />
          {task.outputFile && (
            <DetailField
              label={t('tasks.detail.outputFile')}
              value={task.outputFile}
            />
          )}
        </>
      )}

      {task.kind === 'monitor' && (
        <DetailField label={t('tasks.detail.command')} value={task.command} />
      )}

      {task.kind === 'agent' && task.subagentType && (
        <DetailField
          label={t('tasks.detail.type')}
          value={localizeAgentTypeName(task.subagentType, t)}
        />
      )}

      {task.kind === 'agent' && (task.depth ?? 0) > 0 && (
        <DetailField
          label={t('tasks.detail.nesting')}
          value={
            // User-facing level = launch depth + 1 (depth 0 = spawned by
            // the top-level session). Unlike the row indent, this is the
            // absolute launch level, unaffected by departed ancestors.
            task.parentName
              ? t('tasks.detail.nestingValue', {
                  level: (task.depth ?? 0) + 1,
                  parent: task.parentName,
                })
              : t('tasks.detail.nestingLevel', {
                  level: (task.depth ?? 0) + 1,
                })
          }
        />
      )}

      {task.kind === 'agent' &&
        task.recentActivities &&
        task.recentActivities.length > 0 && (
          <div className={styles.detailField}>
            <div className={styles.detailFieldLabel}>
              {t('tasks.detail.progress')}
            </div>
            <div className={styles.detailContent}>
              {task.recentActivities
                .slice(-MAX_DISPLAYED_ACTIVITIES)
                .map((a, i, arr) => {
                  const isLast = i === arr.length - 1;
                  const desc = formatActivityLabel(a.name, a.description, t);
                  return (
                    <div
                      key={`${a.at}-${i}`}
                      className={
                        isLast ? styles.activityCurrent : styles.activityPast
                      }
                    >
                      {isLast ? '> ' : '  '}
                      {desc}
                    </div>
                  );
                })}
            </div>
          </div>
        )}

      {task.kind === 'agent' && task.prompt && (
        <div className={styles.detailField}>
          <div className={styles.detailFieldLabel}>
            {t('tasks.detail.prompt')}
          </div>
          <div className={styles.promptContent}>
            {promptLines.slice(0, 5).map((line, i, arr) => (
              <div key={i}>
                {i === arr.length - 1 && promptLines.length > 5
                  ? `${line}…`
                  : line || ' '}
              </div>
            ))}
          </div>
        </div>
      )}

      {task.kind === 'agent' && task.outputFile && (
        <DetailField
          label={t('tasks.detail.outputFile')}
          value={task.outputFile}
        />
      )}

      {task.kind === 'agent' &&
        task.status === 'paused' &&
        task.resumeBlockedReason && (
          <div className={styles.detailField}>
            <div className={`${styles.detailFieldLabel} ${styles.error}`}>
              {t('tasks.detail.resumeBlocked')}
            </div>
            <div className={styles.error}>{task.resumeBlockedReason}</div>
          </div>
        )}

      {task.kind === 'workflow' && (
        <WorkflowExecutionView
          task={task}
          sourceTask={sourceWorkflowTask}
          historyTasks={workflowHistoryTasks}
          historyActionBusy={busy}
          onDeleteHistory={onDeleteWorkflowHistory}
          actions={actionControls}
        />
      )}

      {task.error && (
        <div className={styles.detailField}>
          <div
            className={`${styles.detailFieldLabel} ${
              task.kind === 'monitor' && task.status !== 'failed'
                ? styles.warning
                : styles.error
            }`}
          >
            {task.kind === 'monitor' && task.status !== 'failed'
              ? t('tasks.detail.stoppedBecause')
              : t('tasks.detail.error')}
          </div>
          <div
            className={
              task.kind === 'monitor' && task.status !== 'failed'
                ? styles.warning
                : styles.error
            }
          >
            {task.error}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.detailField}>
      <div className={styles.detailFieldLabel}>{label}</div>
      <div className={styles.detailContent}>{value}</div>
    </div>
  );
}

export { ACTIVE_EVENT as TASKS_STATUS_ACTIVE_EVENT };
