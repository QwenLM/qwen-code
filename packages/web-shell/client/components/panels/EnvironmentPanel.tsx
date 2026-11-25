import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DaemonSessionAgentTaskStatus,
  DaemonSessionAttachmentReference,
  DaemonSessionArtifact,
  DaemonSessionTaskWithWorkflowStatus,
  DaemonWorkspaceGitStatus,
} from '@qwen-code/sdk/daemon';
import {
  BotIcon,
  CalendarClockIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CirclePauseIcon,
  CircleStopIcon,
  CircleXIcon,
  FileDiffIcon,
  FolderClosedIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareActivityIcon,
  SquareTerminalIcon,
  NetworkIcon,
  Trash2Icon,
  WorkflowIcon,
} from 'lucide-react';
import type { WebShellEnvironmentPanelItem } from '../../customization';
import { useI18n } from '../../i18n';
import { useSharedNow } from '../../hooks/useSharedNow';
import {
  scheduledTaskRuntimeKey as scheduledTaskKey,
  type SessionDurableScheduledTask,
  type SessionScheduledTask,
  type SessionScopedScheduledTask,
} from '../../hooks/useSessionScheduledTasks';
import {
  describeCron,
  formatCountdown,
} from '../dialogs/scheduledTasksSchedule';
import type { AttachmentPreviewRequest } from '../../adapters/messageTypes';
import type { ImageTabSource } from '../artifacts/ArtifactPanel';
import { isComposerTask } from '../../utils/composerTasks';
import { BranchPickerPopover } from '../BranchPickerPopover';
import { artifactDisplayName } from '../artifacts/artifactUtils';
import { FileTypeIcon } from '../FileTypeIcon';
import { Skeleton } from '../ui/skeleton';
import styles from './EnvironmentPanel.module.css';
import { SourcesSection, type SourcesState } from './SourcesSection';
import type { SessionSource } from '@qwen-code/sdk/daemon';

interface EnvironmentPanelProps {
  sources?: SourcesState;
  onOpenSource?: (source: SessionSource) => void;
  retrySourceRegistration?: () => Promise<void>;
  floating?: boolean;
  hidden?: boolean;
  workspaceCwd?: string;
  gitWorkspaceCwd?: string;
  gitCwd?: string;
  gitSessionId?: string;
  branch?: string;
  gitStatus?: DaemonWorkspaceGitStatus;
  tasks: readonly DaemonSessionTaskWithWorkflowStatus[];
  agentTasks?: readonly EnvironmentAgentTask[];
  scheduledTasks?: readonly SessionScheduledTask[];
  scheduledTaskBusyIds?: ReadonlySet<string>;
  manualRunActive?: boolean;
  focusScheduledTasksNonce?: number;
  scheduledTasksOwnerSessionId?: string;
  attachments?: readonly DaemonSessionAttachmentReference[];
  attachmentsLoading?: boolean;
  attachmentsError?: string;
  onRetryAttachments?: () => void;
  artifacts?: readonly DaemonSessionArtifact[];
  artifactsLoading?: boolean;
  items?: readonly WebShellEnvironmentPanelItem[];
  onOpenGitDiff?: () => void;
  onOpenGitCommit?: () => void;
  onOpenGitWorktrees?: () => void;
  onOpenGitLog?: () => void;
  onOpenAgent?: (task: DaemonSessionAgentTaskStatus) => void;
  onOpenAgentWorkflow?: () => void;
  onOpenTask: (task: DaemonSessionTaskWithWorkflowStatus) => void;
  onOpenScheduledTask?: (task: SessionScheduledTask) => void;
  onToggleScheduledTask?: (task: SessionDurableScheduledTask) => void;
  onRunScheduledTask?: (task: SessionDurableScheduledTask) => void;
  onDeleteScheduledTask?: (
    task: SessionDurableScheduledTask,
  ) => Promise<boolean | void>;
  onCancelSessionScheduledTask?: (
    task: SessionScopedScheduledTask,
  ) => Promise<boolean | void>;
  onManageAllScheduledTasks?: () => void;
  /** Resolve an attachment to a displayable `data:` URL. */
  onReadImage?: (attachmentId: string) => Promise<string>;
  onImagePreview?: (src: string, alt?: string, source?: ImageTabSource) => void;
  onAttachmentPreview?: (file: AttachmentPreviewRequest) => void;
  onAttachmentPreviewError?: (error: unknown) => void;
  onOpenArtifact?: (artifactId: string) => void;
  onDismiss?: () => void;
}

export type EnvironmentAgentTask = DaemonSessionAgentTaskStatus & {
  color?: string;
  lineageState?: 'complete' | 'orphaned' | 'cycle';
};

const DEFAULT_ENVIRONMENT_PANEL_ITEMS: readonly WebShellEnvironmentPanelItem[] =
  [
    'environment',
    'sources',
    'subagents',
    'backgroundTasks',
    'scheduledTasks',
    'artifacts',
  ];

// Runtime task keys include both the scheduler scope and the wakeup/cron source.
const AGENT_COLORS: Readonly<Record<string, string>> = {
  red: '#e5484d',
  blue: 'var(--agent-blue-500)',
  green: 'var(--success-color)',
  yellow: '#d6a900',
  purple: 'var(--agent-purple-600)',
  orange: 'var(--accent-orange)',
  pink: '#d6409f',
  cyan: '#0e9888',
};

function taskLabel(task: DaemonSessionTaskWithWorkflowStatus): string {
  switch (task.kind) {
    case 'agent':
      return task.label;
    case 'shell':
      return task.command;
    case 'monitor':
      return task.description;
    case 'workflow':
      return task.label;
  }
}

function taskIcon(task: DaemonSessionTaskWithWorkflowStatus) {
  switch (task.kind) {
    case 'agent':
      return <BotIcon />;
    case 'shell':
      return <SquareTerminalIcon />;
    case 'monitor':
      return <SquareActivityIcon />;
    case 'workflow':
      return <WorkflowIcon />;
  }
}

function taskStatusKey(status: DaemonSessionTaskWithWorkflowStatus['status']) {
  return `tasks.${status}` as const;
}

/**
 * Statuses this panel renders with a spinner. The header's activity dot keys
 * off the same set, so the dot cannot promise a row the panel shows settled.
 */
export function isTaskInProgress(
  status: DaemonSessionTaskWithWorkflowStatus['status'],
): boolean {
  return status === 'running' || status === 'pausing';
}

function taskStatusIcon(status: DaemonSessionTaskWithWorkflowStatus['status']) {
  if (status === 'completed') return <CircleCheckIcon />;
  if (isTaskInProgress(status)) {
    return <LoaderCircleIcon className={styles.statusRunning} />;
  }
  if (status === 'failed') return <CircleXIcon />;
  if (status === 'cancelled') return <CircleStopIcon />;
  if (status === 'paused') return <CirclePauseIcon />;
  return null;
}

function isForkAgent(task: EnvironmentAgentTask): boolean {
  return task.subagentType?.toLowerCase() === 'fork';
}

function agentDisplayName(task: EnvironmentAgentTask): string {
  if (!isForkAgent(task)) return task.label;
  return task.label.replace(/^fork:\s*/i, '').trim();
}

function agentColorValue(color: string | undefined): string {
  return (color && AGENT_COLORS[color]) || 'var(--muted-foreground)';
}

export function EnvironmentPanel({
  sources,
  onOpenSource,
  retrySourceRegistration,
  floating = false,
  hidden = false,
  workspaceCwd,
  gitWorkspaceCwd,
  gitCwd,
  gitSessionId,
  branch,
  gitStatus,
  tasks,
  agentTasks,
  scheduledTasks,
  scheduledTaskBusyIds,
  manualRunActive = false,
  focusScheduledTasksNonce,
  scheduledTasksOwnerSessionId,
  attachments,
  attachmentsLoading = false,
  attachmentsError,
  onRetryAttachments,
  artifacts,
  artifactsLoading = false,
  items = DEFAULT_ENVIRONMENT_PANEL_ITEMS,
  onOpenGitDiff,
  onOpenGitCommit,
  onOpenGitWorktrees,
  onOpenGitLog,
  onOpenAgent,
  onOpenAgentWorkflow,
  onOpenTask,
  onOpenScheduledTask,
  onToggleScheduledTask,
  onRunScheduledTask,
  onDeleteScheduledTask,
  onCancelSessionScheduledTask,
  onManageAllScheduledTasks,
  onReadImage,
  onImagePreview,
  onAttachmentPreview,
  onAttachmentPreviewError,
  onOpenArtifact,
  onDismiss,
}: EnvironmentPanelProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLElement | null>(null);
  const agents: readonly EnvironmentAgentTask[] =
    agentTasks ??
    tasks.filter(
      (task): task is DaemonSessionAgentTaskStatus => task.kind === 'agent',
    );
  // Live background state only — retained workflow runs belong to history,
  // not to this session's Tasks section.
  const backgroundTasks = tasks.filter(isComposerTask);
  const [environmentExpanded, setEnvironmentExpanded] = useState(true);
  const [agentsExpanded, setAgentsExpanded] = useState(true);
  const [tasksExpanded, setTasksExpanded] = useState(true);
  const [scheduledTasksExpanded, setScheduledTasksExpanded] = useState(true);
  const [artifactsExpanded, setArtifactsExpanded] = useState(true);
  const scheduledSectionRef = useRef<HTMLElement | null>(null);
  const scheduledSectionHeaderRef = useRef<HTMLButtonElement>(null);
  const scheduledTaskOpenerRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingScheduledTaskFocusRef = useRef<{
    removedKey: string;
    nextKey?: string;
    request: number;
    confirmed: boolean;
  } | null>(null);
  const scheduledTaskFocusRequestRef = useRef(0);
  const [
    confirmedScheduledTaskFocusRequest,
    setConfirmedScheduledTaskFocusRequest,
  ] = useState<number | null>(null);
  const lastFocusScheduledTasksNonceRef = useRef(focusScheduledTasksNonce);
  useEffect(() => {
    pendingScheduledTaskFocusRef.current = null;
    scheduledTaskOpenerRefs.current.clear();
  }, [scheduledTasksOwnerSessionId, workspaceCwd]);
  const hasVisibleScheduledCountdown =
    !hidden &&
    scheduledTasksExpanded &&
    Boolean(
      scheduledTasks?.some((task) => task.enabled && task.nextRunAt !== null),
    );
  const now = useSharedNow(hasVisibleScheduledCountdown);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const activeBranch = branch ?? gitStatus?.branch;

  useEffect(() => {
    if (!focusScheduledTasksNonce) return;
    if (focusScheduledTasksNonce === lastFocusScheduledTasksNonceRef.current) {
      return;
    }
    lastFocusScheduledTasksNonceRef.current = focusScheduledTasksNonce;
    setScheduledTasksExpanded(true);
    const sectionEl = scheduledSectionRef.current;
    if (sectionEl && typeof sectionEl.scrollIntoView === 'function') {
      sectionEl.scrollIntoView({ block: 'nearest' });
    }
  }, [focusScheduledTasksNonce]);

  const restoreScheduledTaskFocus = useCallback(
    (request: number): void => {
      const pending = pendingScheduledTaskFocusRef.current;
      if (
        !pending?.confirmed ||
        pending.request !== request ||
        scheduledTasks?.some(
          (entry) => scheduledTaskKey(entry) === pending.removedKey,
        )
      ) {
        return;
      }
      const nextOpener = pending.nextKey
        ? scheduledTaskOpenerRefs.current.get(pending.nextKey)
        : undefined;
      pendingScheduledTaskFocusRef.current = null;
      if (scheduledTasksExpanded && nextOpener) {
        nextOpener.focus();
      } else if (scheduledSectionHeaderRef.current) {
        scheduledSectionHeaderRef.current.focus();
      } else {
        panelRef.current?.focus();
      }
    },
    [scheduledTasks, scheduledTasksExpanded],
  );

  useEffect(() => {
    const request = pendingScheduledTaskFocusRef.current?.request;
    if (request !== undefined) restoreScheduledTaskFocus(request);
  }, [confirmedScheduledTaskFocusRequest, restoreScheduledTaskFocus]);

  const rememberScheduledTaskFocus = (entry: SessionScheduledTask): number => {
    const removedKey = scheduledTaskKey(entry);
    const removedIndex = scheduledTasks?.findIndex(
      (candidate) => scheduledTaskKey(candidate) === removedKey,
    );
    const nextEntry =
      removedIndex === undefined || removedIndex < 0
        ? undefined
        : scheduledTasks?.[removedIndex + 1];
    const request = ++scheduledTaskFocusRequestRef.current;
    pendingScheduledTaskFocusRef.current = {
      removedKey,
      nextKey: nextEntry ? scheduledTaskKey(nextEntry) : undefined,
      request,
      confirmed: false,
    };
    return request;
  };

  const trackScheduledTaskFocus = (
    entry: SessionScheduledTask,
    action: () => Promise<boolean | void> | boolean | void,
  ): void => {
    const request = rememberScheduledTaskFocus(entry);
    const clearFailedIntent = () => {
      if (pendingScheduledTaskFocusRef.current?.request === request) {
        pendingScheduledTaskFocusRef.current = null;
      }
    };
    try {
      void Promise.resolve(action()).then((succeeded) => {
        if (succeeded === false) {
          clearFailedIntent();
          return;
        }
        const pending = pendingScheduledTaskFocusRef.current;
        // Void resolve-only handlers retain their established semantics;
        // explicit false and rejected promises remain unconfirmed.
        if (
          (succeeded === true || succeeded === undefined) &&
          pending?.request === request &&
          !pending.confirmed
        ) {
          pending.confirmed = true;
          setConfirmedScheduledTaskFocusRequest(request);
          restoreScheduledTaskFocus(request);
        }
      }, clearFailedIntent);
    } catch {
      clearFailedIntent();
    }
  };

  useEffect(() => {
    if (hidden || !environmentExpanded || !gitWorkspaceCwd || !activeBranch) {
      setBranchPickerOpen(false);
    }
  }, [activeBranch, environmentExpanded, gitWorkspaceCwd, hidden]);

  useEffect(() => {
    if (
      !floating ||
      hidden ||
      !onDismiss ||
      branchPickerOpen ||
      sourceDialogOpen
    )
      return;
    const dismissOnOutsidePointerDown = (event: PointerEvent) => {
      if (
        event
          .composedPath()
          .some(
            (target) =>
              target instanceof Element &&
              target.hasAttribute('data-web-shell-environment-toggle'),
          )
      ) {
        return;
      }
      if (
        event.target instanceof Node &&
        !panelRef.current?.contains(event.target)
      ) {
        onDismiss();
      }
    };
    document.addEventListener('pointerdown', dismissOnOutsidePointerDown);
    return () =>
      document.removeEventListener('pointerdown', dismissOnOutsidePointerDown);
  }, [branchPickerOpen, sourceDialogOpen, floating, hidden, onDismiss]);

  const gitDetails = [
    gitStatus?.operation
      ? t(`git.operation.${gitStatus.operation}`)
      : undefined,
    gitStatus?.detached ? t('git.detached') : undefined,
    gitStatus?.staged
      ? t('git.staged', { count: gitStatus.staged })
      : undefined,
    gitStatus?.unstaged
      ? t('git.unstaged', { count: gitStatus.unstaged })
      : undefined,
    gitStatus?.untracked
      ? t('git.untracked', { count: gitStatus.untracked })
      : undefined,
    gitStatus?.conflicted
      ? t('git.conflicted', { count: gitStatus.conflicted })
      : undefined,
    gitStatus?.ahead ? t('git.ahead', { count: gitStatus.ahead }) : undefined,
    gitStatus?.behind
      ? t('git.behind', { count: gitStatus.behind })
      : undefined,
    gitStatus?.stashCount
      ? t('git.stash', { count: gitStatus.stashCount })
      : undefined,
  ].filter((detail): detail is string => Boolean(detail));

  return (
    <aside
      ref={panelRef}
      className={`${styles.panel} ${floating ? styles.floating : ''}`}
      aria-label={t('environment.title')}
      data-testid="environment-panel"
      data-floating={floating}
      tabIndex={-1}
      hidden={hidden}
    >
      {items.includes('environment') && (
        <section className={styles.section}>
          <button
            type="button"
            className={styles.sectionHeader}
            aria-expanded={environmentExpanded}
            onClick={() => setEnvironmentExpanded((expanded) => !expanded)}
          >
            <span>{t('environment.title')}</span>
            {!environmentExpanded && <ChevronRightIcon />}
          </button>
          {environmentExpanded && (
            <div className={styles.sectionContent}>
              <button
                type="button"
                className={styles.row}
                disabled={!onOpenGitDiff}
                onClick={onOpenGitDiff}
              >
                <FileDiffIcon />
                <span className={styles.label}>{t('environment.changes')}</span>
                <span className={styles.value}>
                  {gitStatus === undefined
                    ? t('environment.unavailable')
                    : gitDetails.length > 0
                      ? gitDetails.join(' · ')
                      : t('environment.clean')}
                </span>
              </button>
              <div className={styles.row} title={workspaceCwd}>
                <FolderClosedIcon className={styles.workspaceIcon} />
                <span className={styles.label}>
                  {t('environment.workspace')}
                </span>
                <span className={styles.value}>
                  {workspaceCwd?.split(/[/\\]/).filter(Boolean).at(-1) ??
                    t('environment.unavailable')}
                </span>
              </div>
              {gitWorkspaceCwd && activeBranch ? (
                <BranchPickerPopover
                  open={branchPickerOpen}
                  onOpenChange={setBranchPickerOpen}
                  workspaceCwd={gitWorkspaceCwd}
                  gitCwd={gitCwd}
                  gitSessionId={gitSessionId}
                  side="left"
                  status={gitStatus}
                  onOpenDiff={onOpenGitDiff}
                  onOpenCommit={onOpenGitCommit}
                  onOpenWorktrees={onOpenGitWorktrees}
                  onOpenLog={onOpenGitLog}
                >
                  <button
                    type="button"
                    className={styles.row}
                    title={activeBranch}
                  >
                    <GitBranchIcon />
                    <span className={styles.branchName}>{activeBranch}</span>
                    <ChevronRightIcon className={styles.rowActionIcon} />
                  </button>
                </BranchPickerPopover>
              ) : (
                <div className={styles.row} title={activeBranch ?? undefined}>
                  <GitBranchIcon />
                  <span className={styles.branchName}>
                    {activeBranch ?? t('environment.unavailable')}
                  </span>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {(items.includes('sources') || items.includes('attachments')) && (
        <SourcesSection
          hidden={hidden}
          state={items.includes('sources') ? sources : undefined}
          attachments={attachments}
          attachmentsLoading={attachmentsLoading}
          attachmentsError={attachmentsError}
          onRetryAttachments={onRetryAttachments}
          onReadImage={onReadImage}
          onImagePreview={onImagePreview}
          onAttachmentPreview={onAttachmentPreview}
          onAttachmentPreviewError={onAttachmentPreviewError}
          onDialogOpenChange={setSourceDialogOpen}
          onOpen={onOpenSource}
          retryRegistration={
            items.includes('sources') ? retrySourceRegistration : undefined
          }
        />
      )}
      {items.includes('subagents') && agents.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeaderRow}>
            <button
              type="button"
              className={styles.sectionHeader}
              aria-expanded={agentsExpanded}
              onClick={() => setAgentsExpanded((expanded) => !expanded)}
            >
              <span>{t('environment.agents')}</span>
              {!agentsExpanded && <ChevronRightIcon />}
            </button>
            {onOpenAgentWorkflow && (
              <button
                type="button"
                className={styles.sectionAction}
                aria-label={t('workflow.open')}
                title={t('workflow.open')}
                onClick={onOpenAgentWorkflow}
              >
                <NetworkIcon />
              </button>
            )}
          </div>
          {agentsExpanded && (
            <ul className={styles.tasks}>
              {agents.map((task, index) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className={styles.task}
                    disabled={!onOpenAgent}
                    onClick={() => onOpenAgent?.(task)}
                  >
                    <span className={styles.taskLabel}>
                      {!isForkAgent(task) && (
                        <span
                          className={styles.agentColor}
                          data-agent-color={task.color ?? 'default'}
                          style={{
                            backgroundColor: agentColorValue(task.color),
                          }}
                          aria-hidden="true"
                        />
                      )}
                      {isForkAgent(task) && (
                        <span className={styles.agentTag}>fork</span>
                      )}
                      <span className={styles.agentName}>
                        {(() => {
                          const name = agentDisplayName(task).trim();
                          return name && name.toLowerCase() !== 'agent'
                            ? name
                            : t('environment.unnamedAgent', {
                                index: index + 1,
                              });
                        })()}
                      </span>
                    </span>
                    <span
                      className={styles.taskStatus}
                      data-status={task.status}
                    >
                      {taskStatusIcon(task.status)}
                      {t(taskStatusKey(task.status))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {items.includes('backgroundTasks') && backgroundTasks.length > 0 && (
        <section className={styles.section}>
          <button
            type="button"
            className={styles.sectionHeader}
            aria-expanded={tasksExpanded}
            onClick={() => setTasksExpanded((expanded) => !expanded)}
          >
            <span>{t('tasks.title')}</span>
            {!tasksExpanded && <ChevronRightIcon />}
          </button>
          {tasksExpanded && (
            <ul className={styles.tasks}>
              {backgroundTasks.map((task) => (
                <li key={`${task.kind}:${task.id}`}>
                  <button
                    type="button"
                    className={styles.task}
                    onClick={() => onOpenTask(task)}
                  >
                    <span className={styles.taskIcon}>{taskIcon(task)}</span>
                    <span className={styles.taskLabel}>
                      <span className={styles.taskName} title={taskLabel(task)}>
                        {taskLabel(task)}
                      </span>
                    </span>
                    <span
                      className={styles.taskStatus}
                      data-status={task.status}
                    >
                      {taskStatusIcon(task.status)}
                      {t(taskStatusKey(task.status))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {items.includes('scheduledTasks') &&
        scheduledTasks &&
        scheduledTasks.length > 0 && (
          <section
            ref={scheduledSectionRef}
            className={styles.section}
            data-testid="environment-scheduled-tasks-section"
          >
            <div
              className={`${styles.sectionHeaderRow} ${styles.scheduledTaskHeaderRow}`}
            >
              <button
                ref={scheduledSectionHeaderRef}
                type="button"
                className={styles.sectionHeader}
                aria-expanded={scheduledTasksExpanded}
                onClick={() =>
                  setScheduledTasksExpanded((expanded) => !expanded)
                }
              >
                <span>{t('environment.scheduledTasks')}</span>
                {!scheduledTasksExpanded && <ChevronRightIcon />}
              </button>
              {onManageAllScheduledTasks && (
                <button
                  type="button"
                  className={styles.sectionHeaderAction}
                  onClick={onManageAllScheduledTasks}
                >
                  {t('environment.scheduledTasks.viewAll')}
                </button>
              )}
            </div>
            {scheduledTasksExpanded && (
              <ul className={styles.scheduledList}>
                {scheduledTasks.map((entry) => {
                  const busy =
                    scheduledTaskBusyIds?.has(scheduledTaskKey(entry)) === true;
                  const scopeLabel =
                    entry.scope === 'durable'
                      ? t('environment.scheduledTasks.scopeDurable')
                      : entry.source === 'wakeup'
                        ? t('environment.scheduledTasks.scopeWakeup')
                        : t('environment.scheduledTasks.scopeSession');
                  const isWakeup =
                    entry.scope === 'session' && entry.source === 'wakeup';
                  const scheduleText = isWakeup
                    ? t('scheduledTasks.runsOnce')
                    : describeCron(entry.cronExpr, t);
                  const countdown =
                    entry.enabled && entry.nextRunAt !== null
                      ? formatCountdown(entry.nextRunAt - now, t)
                      : null;
                  const metaText = [
                    scheduleText,
                    !entry.enabled
                      ? t('environment.scheduledTasks.statusPaused')
                      : countdown
                        ? countdown === t('scheduledTasks.dueNow')
                          ? countdown
                          : t('environment.scheduledTasks.nextRun', {
                              when: countdown,
                            })
                        : null,
                  ]
                    .filter(Boolean)
                    .join(' · ');

                  return (
                    <li
                      key={scheduledTaskKey(entry)}
                      className={styles.scheduledItem}
                      data-testid="environment-scheduled-task"
                      data-scope={entry.scope}
                      data-enabled={entry.enabled ? 'true' : 'false'}
                    >
                      <button
                        ref={(node) => {
                          const key = scheduledTaskKey(entry);
                          if (node)
                            scheduledTaskOpenerRefs.current.set(key, node);
                          else scheduledTaskOpenerRefs.current.delete(key);
                        }}
                        type="button"
                        className={styles.scheduledItemMain}
                        onClick={() => onOpenScheduledTask?.(entry)}
                        disabled={!onOpenScheduledTask}
                      >
                        <span className={styles.taskIcon} aria-hidden="true">
                          {entry.scope === 'session' &&
                          entry.source === 'wakeup' ? (
                            <RefreshCwIcon />
                          ) : (
                            <CalendarClockIcon />
                          )}
                        </span>
                        <span className={styles.scheduledItemBody}>
                          <span className={styles.scheduledItemTitleRow}>
                            <span
                              className={styles.taskName}
                              title={entry.title}
                            >
                              {entry.title}
                            </span>
                            <span className={styles.agentTag}>
                              {scopeLabel}
                            </span>
                          </span>
                          <span
                            className={styles.scheduledItemMeta}
                            title={isWakeup ? undefined : entry.cronExpr}
                          >
                            {metaText}
                          </span>
                        </span>
                      </button>
                      <div className={styles.scheduledItemActions}>
                        {entry.scope === 'durable' ? (
                          <>
                            {onToggleScheduledTask && (
                              <button
                                type="button"
                                className={styles.scheduledIconButton}
                                aria-label={
                                  entry.enabled
                                    ? t('scheduledTasks.disable')
                                    : t('scheduledTasks.enable')
                                }
                                title={
                                  entry.enabled
                                    ? t('scheduledTasks.disable')
                                    : t('scheduledTasks.enable')
                                }
                                disabled={busy}
                                onClick={() => onToggleScheduledTask(entry)}
                              >
                                {entry.enabled ? <PauseIcon /> : <PlayIcon />}
                              </button>
                            )}
                            {onRunScheduledTask && entry.enabled && (
                              <button
                                type="button"
                                className={styles.scheduledIconButton}
                                aria-label={t('scheduledTasks.runNow')}
                                title={t('scheduledTasks.runNow')}
                                disabled={busy || manualRunActive}
                                onClick={() => onRunScheduledTask(entry)}
                              >
                                <RefreshCwIcon />
                              </button>
                            )}
                            {onDeleteScheduledTask && (
                              <button
                                type="button"
                                className={styles.scheduledIconButton}
                                aria-label={t('scheduledTasks.delete')}
                                title={t('scheduledTasks.delete')}
                                disabled={busy}
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      t('scheduledTasks.deleteConfirm', {
                                        name: entry.title,
                                      }),
                                    )
                                  ) {
                                    trackScheduledTaskFocus(entry, () =>
                                      onDeleteScheduledTask(entry),
                                    );
                                  }
                                }}
                              >
                                <Trash2Icon />
                              </button>
                            )}
                          </>
                        ) : (
                          onCancelSessionScheduledTask && (
                            <button
                              type="button"
                              className={styles.scheduledIconButton}
                              aria-label={t('environment.scheduledTasks.stop')}
                              title={t('environment.scheduledTasks.stop')}
                              disabled={busy}
                              onClick={() => {
                                trackScheduledTaskFocus(entry, () =>
                                  onCancelSessionScheduledTask(entry),
                                );
                              }}
                            >
                              <CircleStopIcon />
                            </button>
                          )
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

      {items.includes('artifacts') && (
        <section className={styles.section}>
          <button
            type="button"
            className={styles.sectionHeader}
            aria-expanded={artifactsExpanded}
            onClick={() => setArtifactsExpanded((expanded) => !expanded)}
          >
            <span>{t('environment.artifacts')}</span>
            {!artifactsExpanded && <ChevronRightIcon />}
          </button>
          {artifactsExpanded && (
            <>
              {artifactsLoading ? (
                <FileListSkeleton label={t('common.loading')} />
              ) : artifacts?.length ? (
                <ul className={styles.attachmentFiles}>
                  {artifacts.map((artifact) => {
                    const displayName = artifactDisplayName(artifact);
                    return (
                      <li key={artifact.id}>
                        <button
                          type="button"
                          className={styles.attachmentFile}
                          title={displayName}
                          onClick={() => onOpenArtifact?.(artifact.id)}
                        >
                          <FileTypeIcon
                            name={artifact.workspacePath ?? artifact.title}
                            mimeType={artifact.mimeType}
                            size={16}
                            strokeWidth={1.7}
                            className={styles.attachmentFileIcon}
                            aria-hidden="true"
                          />
                          <span className={styles.attachmentFileName}>
                            {displayName}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className={styles.emptyDescription}>
                  {t('environment.artifactsEmpty')}
                </p>
              )}
            </>
          )}
        </section>
      )}
    </aside>
  );
}

function FileListSkeleton({ label }: { label: string }) {
  return (
    <ul
      className={styles.attachmentFiles}
      data-testid="environment-file-list-skeleton"
      role="status"
      aria-label={label}
    >
      {[72, 88, 64].map((width) => (
        <li key={width} className={styles.attachmentFile}>
          <Skeleton className="size-4 shrink-0 rounded-sm" />
          <Skeleton className="h-4" style={{ width: `${width}%` }} />
        </li>
      ))}
    </ul>
  );
}
