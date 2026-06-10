import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DaemonSessionTasksStatus,
  DaemonSessionTaskStatus,
} from '@qwen-code/sdk/daemon';
import { useActions } from '@qwen-code/webui/daemon-react-sdk';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';
import { formatRuntime } from '../../utils/formatRuntime';
import { createSentinelSerializer } from '../../utils/sentinelMessage';
import { formatToolDisplayName } from './toolFormatting';
import styles from './TasksStatusMessage.module.css';

const ACTIVE_EVENT = 'web-shell:tasks-panel-active';
const REFRESH_INTERVAL_MS = 3000;
const LIST_MAX_ROWS = 8;

export interface SerializedTasksMessage {
  snapshot: DaemonSessionTasksStatus;
}

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

function dispatchActive(id: string, active: boolean): void {
  window.dispatchEvent(
    new CustomEvent(ACTIVE_EVENT, { detail: { id, active } }),
  );
}

function isActive(task: DaemonSessionTaskStatus): boolean {
  return task.status === 'running' || task.status === 'paused';
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

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function statusClassName(status: TaskStatus): string {
  switch (status) {
    case 'running':
      return styles.success;
    case 'paused':
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

function terminalStatusIcon(status: TaskStatus): string | null {
  switch (status) {
    case 'paused':
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

function rowLabel(task: DaemonSessionTaskStatus): string {
  switch (task.kind) {
    case 'agent':
      return task.isBackgrounded ? task.label : `[blocking] ${task.label}`;
    case 'shell':
      return `[shell] ${task.command}`;
    case 'monitor':
      return `[monitor] ${task.description}`;
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

function formatActivityLabel(name: string, description: string | undefined) {
  const display = formatToolDisplayName(name);
  const singleLineDescription = description
    ? description.replace(/\s*\n\s*/g, ' ').trim()
    : '';
  return singleLineDescription
    ? `${display}(${singleLineDescription})`
    : display;
}

export function TasksStatusMessage({
  message,
  manageActiveEvent = true,
  onClose,
}: {
  message: SerializedTasksMessage;
  manageActiveEvent?: boolean;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const actions = useActions();
  const [tasks, setTasks] = useState(() => sortTasks(message.snapshot.tasks));
  const [isOpen, setIsOpen] = useState(true);
  const [step, setStep] = useState<TasksPanelStep>('list');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pendingCancelId, setPendingCancelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const panelIdRef = useRef(`tasks-${Math.random().toString(36).slice(2)}`);
  const refreshInFlightRef = useRef(false);
  const initialDetailStatusRef = useRef<{
    taskId: string;
    status: TaskStatus;
  } | null>(null);

  const clampedSelectedIndex =
    tasks.length === 0 ? 0 : Math.min(selectedIndex, tasks.length - 1);
  const selectedTask = tasks[clampedSelectedIndex] ?? null;

  useEffect(() => {
    if (!isOpen) return;
    const refresh = () => {
      if (refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;
      actions
        .getTasks()
        .then((snapshot) => {
          setTasks(sortTasks(snapshot.tasks));
          setRefreshError(false);
        })
        .catch((error: unknown) => {
          console.warn('[web-shell] failed to refresh tasks:', error);
          setRefreshError(true);
        })
        .finally(() => {
          refreshInFlightRef.current = false;
        });
    };
    const id = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isOpen, actions]);

  useEffect(() => {
    if (tasks.length === 0 && selectedIndex !== 0) {
      setSelectedIndex(0);
    }
    if (selectedIndex >= tasks.length && tasks.length > 0) {
      setSelectedIndex(tasks.length - 1);
    }
  }, [tasks.length, selectedIndex]);

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

    if (initial.status === 'running' && selectedTask.status !== 'running') {
      setPendingCancelId(null);
      setStep('list');
    }
  }, [isOpen, step, selectedTask]);

  useEffect(() => {
    if (!manageActiveEvent) return undefined;
    const id = panelIdRef.current;
    dispatchActive(id, isOpen);
    return () => dispatchActive(id, false);
  }, [isOpen, manageActiveEvent]);

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
      const isRunning = task.status === 'running';
      const isAbandonable = task.kind === 'agent' && task.status === 'paused';
      if (!isRunning && !isAbandonable) return;
      const isForegroundAgent = task.kind === 'agent' && !task.isBackgrounded;
      if (isForegroundAgent && pendingCancelId !== task.id) {
        setPendingCancelId(task.id);
        return;
      }
      setPendingCancelId(null);
      setBusy(true);
      try {
        const result = await actions.cancelTask(task.id, task.kind);
        if (!result.cancelled) {
          setActionError(t('tasks.alreadyStopped'));
          return;
        }
        const snapshot = await actions.getTasks();
        setTasks(sortTasks(snapshot.tasks));
        setActionError(null);
      } catch (error: unknown) {
        console.warn('[web-shell] failed to cancel task:', error);
        setActionError(t('tasks.cancelFailed'));
      } finally {
        setBusy(false);
      }
    },
    [actions, busy, pendingCancelId, t],
  );

  useDelayedGlobalKeyDown(
    (event: KeyboardEvent) => {
      if (!isOpen) return;

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
        setSelectedIndex((current) =>
          Math.min(Math.max(current + delta, 0), tasks.length - 1),
        );
        setPendingCancelId(null);
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (step === 'list' && selectedTask) {
          setStep('detail');
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
    [isOpen, step, tasks.length, selectedTask, handleCancel, pendingCancelId],
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
    if (selectedTask?.status === 'running') {
      listHints.push(t('tasks.shortcut.stop'));
    } else if (
      selectedTask?.kind === 'agent' &&
      selectedTask?.status === 'paused'
    ) {
      listHints.push(t('tasks.shortcut.abandon'));
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
    if (selectedTask?.status === 'running') {
      detailHints.push(t('tasks.shortcut.stop'));
    } else if (
      selectedTask?.kind === 'agent' &&
      selectedTask?.status === 'paused'
    ) {
      detailHints.push(t('tasks.shortcut.abandon'));
    }
  }

  if (tasks.length === 0) {
    return (
      <div className={styles.panel} data-keyboard-scope>
        <div className={styles.header}>
          <div className={styles.title}>{t('tasks.title')}</div>
          {refreshError && (
            <div className={styles.warning}>{t('tasks.refreshStale')}</div>
          )}
          {actionError && <div className={styles.error}>{actionError}</div>}
        </div>
        <div>
          <div className={styles.sectionTitle}>
            {t('tasks.title')} <span className={styles.secondary}>(0)</span>
          </div>
          <div className={styles.secondary}>{t('tasks.empty')}</div>
        </div>
        <div className={styles.shortcuts}>{t('tasks.shortcut.close')}</div>
      </div>
    );
  }

  const { visible, windowStart, hiddenAbove, hiddenBelow } = windowTasks(
    tasks,
    clampedSelectedIndex,
  );

  return (
    <div className={styles.panel} data-keyboard-scope>
      {step === 'list' && (
        <div className={styles.header}>
          <div className={styles.title}>{t('tasks.title')}</div>
          {refreshError && (
            <div className={styles.warning}>{t('tasks.refreshStale')}</div>
          )}
          {actionError && <div className={styles.error}>{actionError}</div>}
        </div>
      )}

      {step === 'list' && (
        <div className={styles.list}>
          <div className={styles.sectionTitle}>
            {t('tasks.title')}{' '}
            <span className={styles.secondary}>({tasks.length})</span>
          </div>
          {hiddenAbove > 0 && (
            <div className={styles.overflowHint}>
              {t('tasks.moreAbove', { count: hiddenAbove })}
            </div>
          )}
          {visible.map((task, visibleIndex) => {
            const index = windowStart + visibleIndex;
            const selected = index === clampedSelectedIndex;
            const stClass = statusClassName(task.status);
            return (
              <div
                key={task.id}
                className={
                  selected ? `${styles.row} ${styles.selected}` : styles.row
                }
                onClick={() => {
                  setSelectedIndex(index);
                  setStep('detail');
                }}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className={styles.pointer}>{selected ? '❯' : ''}</span>
                <span
                  className={
                    task.status === 'running'
                      ? styles.nameCell
                      : `${styles.nameCell} ${stClass}`
                  }
                >
                  {rowLabel(task)}
                </span>
              </div>
            );
          })}
          {hiddenBelow > 0 && (
            <div className={styles.overflowHint}>
              {t('tasks.moreBelow', { count: hiddenBelow })}
            </div>
          )}
        </div>
      )}

      {step === 'detail' && selectedTask && (
        <TaskDetail task={selectedTask} t={t} />
      )}

      <div
        className={
          showCancelConfirm
            ? `${styles.shortcuts} ${styles.confirmHint}`
            : styles.shortcuts
        }
      >
        {(step === 'list' ? listHints : detailHints).join(' · ')}
      </div>
    </div>
  );
}

function detailTitle(
  task: DaemonSessionTaskStatus,
  t: ReturnType<typeof useI18n>['t'],
): string {
  switch (task.kind) {
    case 'agent':
      return `${task.subagentType ?? 'Agent'} › ${task.label}`;
    case 'shell':
      return `${t('tasks.kind.shell')} › ${task.command}`;
    case 'monitor':
      return `${t('tasks.kind.monitor')} › ${task.description}`;
  }
}

function TaskDetail({
  task,
  t,
}: {
  task: DaemonSessionTaskStatus;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const terminalIcon = terminalStatusIcon(task.status);
  const stClass = statusClassName(task.status);
  const subtitleParts = [formatRuntime(task.runtimeMs)];

  if (task.kind === 'agent' && task.stats?.totalTokens) {
    subtitleParts.push(
      t('tasks.detail.tokens', {
        count: formatTokenCount(task.stats.totalTokens),
      }),
    );
  }

  if (task.kind === 'agent' && task.stats?.toolUses !== undefined) {
    subtitleParts.push(
      t('tasks.detail.toolCalls', {
        count: task.stats.toolUses,
      }),
    );
  }

  if (task.kind !== 'agent' && task.pid !== undefined) {
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

  return (
    <div className={styles.detail}>
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
        <DetailField label={t('tasks.detail.type')} value={task.subagentType} />
      )}

      {task.kind === 'agent' &&
        task.recentActivities &&
        task.recentActivities.length > 0 && (
          <div>
            <div className={styles.detailFieldLabel}>
              {t('tasks.detail.progress')}
            </div>
            {task.recentActivities.slice(-5).map((a, i, arr) => {
              const isLast = i === arr.length - 1;
              const desc = formatActivityLabel(a.name, a.description);
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
        )}

      {task.kind === 'agent' && task.prompt && (
        <div>
          <div className={styles.detailFieldLabel}>
            {t('tasks.detail.prompt')}
          </div>
          <div className={styles.promptContent}>
            {promptLines.slice(0, 5).map((line, i, arr) => (
              <div key={i} className={styles.truncate}>
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
          <div>
            <div className={`${styles.detailFieldLabel} ${styles.error}`}>
              {t('tasks.detail.resumeBlocked')}
            </div>
            <div className={styles.error}>{task.resumeBlockedReason}</div>
          </div>
        )}

      {task.error && (
        <div>
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
      <span className={styles.detailFieldLabel}>{label}</span>
      <span className={styles.truncate}>{value}</span>
    </div>
  );
}

export { ACTIVE_EVENT as TASKS_STATUS_ACTIVE_EVENT };
