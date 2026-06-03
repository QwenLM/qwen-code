import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DaemonSessionTasksStatus,
  DaemonSessionTaskStatus,
} from '@qwen-code/sdk/daemon';
import { useActions } from '@qwen-code/webui/daemon-react-sdk';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';
import { createSentinelSerializer } from '../../utils/sentinelMessage';
import styles from './TasksStatusMessage.module.css';

const ACTIVE_EVENT = 'web-shell:tasks-panel-active';
const REFRESH_INTERVAL_MS = 2000;

interface SerializedTasksMessage {
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

function formatRuntime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) return `${seconds}s`;
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours === 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${minutes}m`;
}

function statusIcon(status: TaskStatus): string {
  switch (status) {
    case 'running':
      return '●';
    case 'paused':
      return '⏸';
    case 'completed':
      return '✓';
    case 'failed':
      return '✗';
    case 'cancelled':
      return '✗';
    default:
      return '?';
  }
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

export function TasksStatusMessage({
  message,
}: {
  message: SerializedTasksMessage;
}) {
  const { t } = useI18n();
  const actions = useActions();
  const [tasks, setTasks] = useState(() => sortTasks(message.snapshot.tasks));
  const [isOpen, setIsOpen] = useState(true);
  const [step, setStep] = useState<TasksPanelStep>('list');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pendingCancelId, setPendingCancelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const panelIdRef = useRef(`tasks-${Math.random().toString(36).slice(2)}`);

  const selectedTask = tasks[selectedIndex] ?? null;

  useEffect(() => {
    if (!isOpen) return;
    const refresh = () => {
      actions
        .getTasks()
        .then((snapshot) => {
          setTasks(sortTasks(snapshot.tasks));
        })
        .catch(() => {});
    };
    const id = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isOpen, actions]);

  useEffect(() => {
    if (selectedIndex >= tasks.length && tasks.length > 0) {
      setSelectedIndex(tasks.length - 1);
    }
  }, [tasks.length, selectedIndex]);

  useEffect(() => {
    const id = panelIdRef.current;
    dispatchActive(id, isOpen);
    return () => dispatchActive(id, false);
  }, [isOpen]);

  useEffect(() => {
    const onActiveChange = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; active?: boolean }>)
        .detail;
      if (detail?.active && detail.id && detail.id !== panelIdRef.current) {
        setIsOpen(false);
      }
    };
    window.addEventListener(ACTIVE_EVENT, onActiveChange);
    return () => window.removeEventListener(ACTIVE_EVENT, onActiveChange);
  }, []);

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
        await actions.cancelTask(task.id, task.kind);
        const snapshot = await actions.getTasks();
        setTasks(sortTasks(snapshot.tasks));
      } catch {
        // error handled by dispatchActionError
      } finally {
        setBusy(false);
      }
    },
    [actions, busy, pendingCancelId],
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
          <div className={styles.secondary}>{t('tasks.empty')}</div>
        </div>
        <div className={styles.shortcuts}>{t('tasks.shortcut.close')}</div>
      </div>
    );
  }

  return (
    <div className={styles.panel} data-keyboard-scope>
      <div className={styles.header}>
        <div className={styles.title}>{t('tasks.title')}</div>
        <div className={styles.secondary}>
          {t('tasks.count', { count: tasks.length })}
        </div>
      </div>

      {step === 'list' && (
        <div className={styles.list}>
          {tasks.map((task, index) => {
            const selected = index === selectedIndex;
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
                <span className={`${styles.statusBadge} ${stClass}`}>
                  {statusIcon(task.status)}
                </span>
                <span className={styles.nameCell}>{rowLabel(task)}</span>
                <span className={styles.separator}>·</span>
                <span className={styles.secondary}>
                  {formatRuntime(task.runtimeMs)}
                </span>
              </div>
            );
          })}
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

function detailTitle(task: DaemonSessionTaskStatus): string {
  switch (task.kind) {
    case 'agent':
      return `${task.subagentType ?? 'Agent'} › ${task.label}`;
    case 'shell':
      return `Shell › ${task.command}`;
    case 'monitor':
      return `Monitor › ${task.description}`;
  }
}

function TaskDetail({
  task,
  t,
}: {
  task: DaemonSessionTaskStatus;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const stClass = statusClassName(task.status);

  return (
    <div className={styles.detail}>
      <div className={styles.title}>{detailTitle(task)}</div>
      <div className={styles.statusBadge}>
        <span className={stClass}>
          {statusIcon(task.status)} {t(`tasks.${task.status}`)}
        </span>
        <span className={styles.separator}>·</span>
        <span className={styles.secondary}>
          {formatRuntime(task.runtimeMs)}
        </span>
        {task.kind !== 'agent' && task.pid !== undefined && (
          <>
            <span className={styles.separator}>·</span>
            <span className={styles.secondary}>pid {task.pid}</span>
          </>
        )}
      </div>

      {task.kind === 'shell' && (
        <>
          <DetailField label={t('tasks.detail.command')} value={task.command} />
          <DetailField label={t('tasks.detail.workingDir')} value={task.cwd} />
          {task.outputFile && (
            <DetailField
              label={t('tasks.detail.outputFile')}
              value={task.outputFile}
            />
          )}
          {task.exitCode !== undefined && (
            <DetailField label="Exit code" value={String(task.exitCode)} />
          )}
        </>
      )}

      {task.kind === 'monitor' && (
        <>
          <DetailField label={t('tasks.detail.command')} value={task.command} />
          <DetailField
            label={t('tasks.detail.events')}
            value={String(task.eventCount)}
          />
        </>
      )}

      {task.kind === 'agent' && task.subagentType && (
        <DetailField label="Type" value={task.subagentType} />
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
          <div className={`${styles.detailFieldLabel} ${styles.error}`}>
            {t('tasks.detail.error')}
          </div>
          <div className={styles.error}>{task.error}</div>
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
