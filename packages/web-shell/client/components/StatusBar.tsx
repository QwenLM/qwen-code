import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  type KeyboardEvent,
} from 'react';
import type { DaemonSessionTaskWithWorkflowStatus } from '@qwen-code/sdk/daemon';
import { useConnection } from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../i18n';
import { isComposerTask } from '../utils/composerTasks';
import styles from './StatusBar.module.css';

export interface StatusBarHandle {
  focusTaskPill(): boolean;
}

function getModeIndicator(
  mode: string,
  t: ReturnType<typeof useI18n>['t'],
): { label: string; className: string } | null {
  switch (mode) {
    case 'default':
      return { label: t('mode.default'), className: styles.modeDefault };
    case 'plan':
      return { label: t('mode.plan'), className: styles.modePlan };
    case 'auto-edit':
      return { label: t('mode.auto-edit'), className: styles.modeAutoEdit };
    case 'auto':
      return { label: t('mode.auto'), className: styles.modeAuto };
    case 'yolo':
      return { label: t('mode.yolo'), className: styles.modeYolo };
    default:
      // Only reached before a mode is known (e.g. while disconnected).
      return null;
  }
}

interface StatusBarProps {
  onSelectMode: () => void;
  /** Open the model picker so the model can be chosen with the mouse. */
  onSelectModel: () => void;
  /** Show the context-usage breakdown, exactly like typing /context. */
  onShowContext: () => void;
  /** Open the settings dialog so settings are reachable with the mouse. */
  onOpenSettings: () => void;
  onOpenTasks?: () => void;
  onReturnToInput?: (text?: string) => void;
  tasks: readonly DaemonSessionTaskWithWorkflowStatus[];
  /** Hide the settings gear button (e.g. when /settings is in hiddenSlashCommands). */
  hideSettings?: boolean;
  /** Toggle the keyboard-shortcuts panel (same as typing `?` in the editor). */
  onToggleShortcuts?: () => void;
  /** Hide secondary footer hints/details for the chat composer layout. */
  compact?: boolean;
}

// Feather "settings" gear, stroke-based like PromptChevron so it inherits
// the button's currentColor.
function GearIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function formatCount(
  count: number,
  singularKey: string,
  pluralKey: string,
  t: ReturnType<typeof useI18n>['t'],
): string {
  return t(count === 1 ? singularKey : pluralKey, { count });
}

export function getTaskPillLabel(
  tasks: readonly DaemonSessionTaskWithWorkflowStatus[],
  t: ReturnType<typeof useI18n>['t'],
): string {
  const composerTasks = tasks.filter(isComposerTask);
  if (composerTasks.length === 0) return '';

  const running = composerTasks.filter(
    (task) =>
      task.status === 'running' ||
      task.status === 'pausing' ||
      task.status === 'paused',
  );
  if (running.length > 0) {
    const counts = { shell: 0, monitor: 0, workflow: 0 };
    for (const task of running) {
      if (task.kind === 'shell') counts.shell += 1;
      if (task.kind === 'monitor') counts.monitor += 1;
      if (task.kind === 'workflow') counts.workflow += 1;
    }
    const parts: string[] = [];
    if (counts.shell > 0) {
      parts.push(
        formatCount(counts.shell, 'tasks.pill.shell', 'tasks.pill.shells', t),
      );
    }
    if (counts.monitor > 0) {
      parts.push(
        formatCount(
          counts.monitor,
          'tasks.pill.monitor',
          'tasks.pill.monitors',
          t,
        ),
      );
    }
    if (counts.workflow > 0) {
      parts.push(
        formatCount(
          counts.workflow,
          'tasks.pill.workflow',
          'tasks.pill.workflows',
          t,
        ),
      );
    }
    return parts.join(', ');
  }

  return t(
    composerTasks.length === 1 ? 'tasks.pill.done' : 'tasks.pill.doneMany',
    {
      count: composerTasks.length,
    },
  );
}

export const StatusBar = forwardRef<StatusBarHandle, StatusBarProps>(
  function StatusBar(
    {
      onSelectMode,
      onSelectModel,
      onShowContext,
      onOpenSettings,
      onOpenTasks,
      onReturnToInput,
      tasks,
      hideSettings,
      onToggleShortcuts,
      compact = false,
    },
    ref,
  ) {
    const connection = useConnection();
    const connected = connection.status === 'connected';
    const currentModel = connection.currentModel ?? '';
    const currentMode = connection.currentMode ?? '';
    const tokenCount = connection.tokenCount ?? 0;
    const contextWindow = connection.contextWindow ?? 0;
    const { t } = useI18n();
    const pct = contextWindow > 0 ? (tokenCount / contextWindow) * 100 : 0;
    const pctDisplay = pct.toFixed(1);
    const modeIndicator = getModeIndicator(currentMode, t);
    const taskPillRef = useRef<HTMLButtonElement>(null);

    const taskPillLabel = useMemo(() => getTaskPillLabel(tasks, t), [tasks, t]);
    const hasLeftPrefix = !compact && (connected || !!modeIndicator);
    const hasLeftContent = !!taskPillLabel || !compact;
    const hasRightContent =
      (!compact && !!currentModel) ||
      (!compact && contextWindow > 0 && tokenCount > 0) ||
      false;

    useImperativeHandle(
      ref,
      () => ({
        focusTaskPill() {
          if (!taskPillLabel) return false;
          taskPillRef.current?.focus({ preventScroll: true });
          return true;
        },
      }),
      [taskPillLabel],
    );

    if (!hasLeftContent && !hasRightContent) {
      return null;
    }

    const handleTaskPillKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
      if (
        event.key === 'Enter' ||
        event.key === 'ArrowDown' ||
        (event.key === 'n' && event.ctrlKey)
      ) {
        event.preventDefault();
        event.stopPropagation();
        onOpenTasks?.();
        return;
      }
      if (
        event.key === 'ArrowUp' ||
        event.key === 'Escape' ||
        (event.key === 'p' && event.ctrlKey)
      ) {
        event.preventDefault();
        event.stopPropagation();
        onReturnToInput?.();
        return;
      }
      if (
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        onReturnToInput?.(event.key);
      }
    };

    return (
      <div className={styles.bar}>
        <div className={styles.left}>
          {connected && !hideSettings && !compact && (
            <button
              type="button"
              className={styles.settingsButton}
              onClick={onOpenSettings}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              title={t('settings.title')}
              aria-label={t('settings.title')}
              aria-haspopup="dialog"
            >
              <GearIcon />
            </button>
          )}
          {modeIndicator && !compact && (
            <button
              type="button"
              className={styles.modeButton}
              onClick={onSelectMode}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              title={t('mode.select')}
              aria-haspopup="listbox"
            >
              <span
                className={`${styles.modeLabel} ${modeIndicator.className}`}
              >
                {modeIndicator.label}
              </span>
              {!compact && (
                <span className={styles.modeHint}>{t('status.modeHint')}</span>
              )}
            </button>
          )}
          {!compact && (
            <>
              {onToggleShortcuts ? (
                <button
                  type="button"
                  className={styles.shortcutsButton}
                  onClick={onToggleShortcuts}
                  onMouseDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                  aria-haspopup="dialog"
                  aria-label={t('status.shortcuts')}
                >
                  {t('status.shortcuts')}
                </button>
              ) : (
                <span>{t('status.shortcuts')}</span>
              )}
            </>
          )}
          {taskPillLabel && (
            <>
              {hasLeftPrefix && <span className={styles.separator}>·</span>}
              <button
                ref={taskPillRef}
                type="button"
                className={styles.taskPill}
                onClick={onOpenTasks}
                onKeyDown={handleTaskPillKeyDown}
                disabled={!onOpenTasks}
              >
                {taskPillLabel}
              </button>
            </>
          )}
        </div>

        <div className={styles.right}>
          {!compact && currentModel && (
            <button
              type="button"
              className={styles.modelButton}
              onClick={onSelectModel}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              title={t('model.select')}
              aria-haspopup="listbox"
            >
              <span className={styles.model}>{currentModel}</span>
            </button>
          )}
          {!compact && contextWindow > 0 && tokenCount > 0 && (
            <button
              type="button"
              className={styles.contextButton}
              onClick={onShowContext}
              title={t('contextUsage.title')}
            >
              <span className={styles.context}>
                {t('status.contextUsed', { pct: pctDisplay })}
              </span>
            </button>
          )}
        </div>
      </div>
    );
  },
);
