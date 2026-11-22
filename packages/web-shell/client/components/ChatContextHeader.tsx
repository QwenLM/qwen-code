import type { ReactNode } from 'react';
import {
  CalendarClockIcon,
  FolderClosedIcon,
  GaugeIcon,
  LayoutListIcon,
  LayersIcon,
  PackageIcon,
  PanelRightIcon,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { useSharedNow } from '../hooks/useSharedNow';
import { formatCountdown } from './dialogs/scheduledTasksSchedule';
import { LocalControlQrButton } from './LocalControlQrButton';
import styles from './ChatContextHeader.module.css';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';

interface ChatContextHeaderProps {
  content: ReactNode;
  /** Names where the chat runs, beside the actions; hidden when omitted. */
  location?: ReactNode;
  /**
   * Workspace shown as the header's leading icon. Omitting it means the shell
   * has no workspace: the icon stays the same folder and only its tooltip says
   * so. In a session this icon always reports the workspace; the empty-state
   * header can defer to a visible composer workspace selector.
   */
  workspaceName?: string;
  /** Full workspace path, shown as the leading icon's hover tooltip. */
  workspacePath?: string;
  /**
   * Hides the leading workspace icon when the new-task composer's workspace
   * selector is visible and already names the workspace.
   */
  hideWorkspaceIcon?: boolean;
  environmentOpen: boolean;
  environmentAvailable: boolean;
  /** Whether the panel holds an in-progress subagent or background task. */
  environmentRunning?: boolean;
  rightPanelOpen: boolean;
  rightPanelAvailable: boolean;
  onToggleEnvironment: () => void;
  onToggleRightPanel: () => void;
  /** Opens the current workspace file tree; informational when omitted. */
  onOpenFiles?: () => void;
  /** Opens the session token-usage panel; hidden when omitted. */
  onOpenTokenUsage?: () => void;
  /** Opens the session context panel; hidden when omitted. */
  onOpenContextUsage?: () => void;
  /** Session artifact count; the artifact entry shows when greater than 0. */
  artifactCount?: number;
  /** Toggles the right panel's artifacts list tab; hidden when omitted. */
  onOpenArtifacts?: () => void;
  /**
   * Whether the artifacts list tab is the active right-panel tab. With zero
   * artifacts the entry still renders as the close affordance only in that
   * case, not for unrelated open tabs.
   */
  artifactsTabActive?: boolean;
  /** Session scheduled task count (durable bound + session-scoped); shown when > 0. */
  scheduledTaskCount?: number;
  /** Count of enabled/active scheduled tasks in this session. */
  scheduledTaskActiveCount?: number;
  /** Earliest next fire timestamp (epoch ms) among active tasks. */
  scheduledTaskNextRunAt?: number | null;
  /** Opens the environment panel's scheduled-tasks section; hidden when omitted. */
  onOpenScheduledTasks?: () => void;
  /** Shows the Local Control QR entry; hidden when omitted. */
  onOpenLocalControlSettings?: () => void;
}

export function ChatContextHeader({
  content,
  location,
  workspaceName,
  workspacePath,
  hideWorkspaceIcon,
  environmentOpen,
  environmentAvailable,
  environmentRunning,
  rightPanelOpen,
  rightPanelAvailable,
  onToggleEnvironment,
  onToggleRightPanel,
  onOpenFiles,
  onOpenTokenUsage,
  onOpenContextUsage,
  artifactCount,
  onOpenArtifacts,
  artifactsTabActive,
  scheduledTaskCount,
  scheduledTaskActiveCount,
  scheduledTaskNextRunAt,
  onOpenScheduledTasks,
  onOpenLocalControlSettings,
}: ChatContextHeaderProps) {
  const { t } = useI18n();
  const hasActiveScheduledCountdown =
    Boolean(onOpenScheduledTasks) &&
    (scheduledTaskCount ?? 0) > 0 &&
    (scheduledTaskActiveCount ?? 0) > 0 &&
    scheduledTaskNextRunAt != null;
  const now = useSharedNow(hasActiveScheduledCountdown);
  const scheduledCountdown =
    hasActiveScheduledCountdown && scheduledTaskNextRunAt != null
      ? formatCountdown(scheduledTaskNextRunAt - now, t)
      : null;
  const scheduledPausedOnly =
    (scheduledTaskCount ?? 0) > 0 && (scheduledTaskActiveCount ?? 0) === 0;
  const scheduledEntryLabel =
    scheduledTaskCount != null && scheduledTaskCount > 0
      ? scheduledPausedOnly
        ? t('chatHeader.scheduledTasksPaused', { count: scheduledTaskCount })
        : scheduledCountdown
          ? `${t('chatHeader.openScheduledTasks', { count: scheduledTaskCount })} · ${t('environment.scheduledTasks.nextRun', { when: scheduledCountdown })}`
          : t('chatHeader.openScheduledTasks', { count: scheduledTaskCount })
      : undefined;
  const workspaceLabel = workspaceName ?? t('sidebar.noWorkspace');
  const WorkspaceIcon = onOpenFiles ? 'button' : 'span';
  const workspaceAriaLabel = workspaceName
    ? t('workspace.paneLabel', { name: workspaceName })
    : workspaceLabel;

  return (
    <header className={styles.header} data-testid="chat-context-header">
      {!hideWorkspaceIcon && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <WorkspaceIcon
                type={onOpenFiles ? 'button' : undefined}
                role={onOpenFiles ? undefined : 'img'}
                onClick={onOpenFiles}
                className={styles.workspaceIcon}
                data-testid="chat-header-workspace"
                aria-label={
                  onOpenFiles
                    ? `${t('files.description')}: ${workspaceAriaLabel}`
                    : workspaceAriaLabel
                }
              >
                <FolderClosedIcon />
              </WorkspaceIcon>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <span className={styles.workspaceTooltip}>
                <span className={styles.workspaceTooltipName}>
                  {workspaceLabel}
                </span>
                {workspaceName && workspacePath ? (
                  <span className={styles.workspaceTooltipPath}>
                    {workspacePath}
                  </span>
                ) : null}
              </span>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <div className={styles.content}>{content}</div>
      {location && (
        <div className="mr-2 flex min-w-0 max-w-[40%] shrink items-center">
          {location}
        </div>
      )}
      <div className={styles.actions}>
        {onOpenLocalControlSettings && (
          <LocalControlQrButton
            onOpenSettings={onOpenLocalControlSettings}
            className={styles.action}
          />
        )}
        {environmentAvailable && (
          <button
            type="button"
            className={styles.action}
            data-web-shell-environment-toggle
            aria-label={t('chatHeader.toggleEnvironment')}
            aria-pressed={environmentOpen}
            title={t('chatHeader.toggleEnvironment')}
            onClick={onToggleEnvironment}
          >
            <LayoutListIcon />
            {environmentRunning && (
              <span
                className={styles.activityDot}
                data-testid="chat-header-environment-activity"
                aria-hidden="true"
              />
            )}
          </button>
        )}
        {onOpenContextUsage && (
          <button
            type="button"
            className={styles.action}
            aria-label={t('contextUsage.title')}
            title={t('contextUsage.title')}
            onClick={onOpenContextUsage}
          >
            <LayersIcon />
          </button>
        )}
        {onOpenTokenUsage && (
          <button
            type="button"
            className={styles.action}
            aria-label={t('tokenUsage.open')}
            title={t('tokenUsage.open')}
            onClick={onOpenTokenUsage}
          >
            <GaugeIcon />
          </button>
        )}
        {rightPanelAvailable && (
          <button
            type="button"
            className={styles.action}
            aria-label={t('chatHeader.toggleRightPanel')}
            aria-pressed={rightPanelOpen}
            title={t('chatHeader.toggleRightPanel')}
            onClick={onToggleRightPanel}
          >
            <PanelRightIcon />
          </button>
        )}
        {onOpenScheduledTasks &&
          scheduledTaskCount != null &&
          scheduledTaskCount > 0 && (
            <button
              type="button"
              className={`${styles.action} ${styles.scheduledAction}${
                scheduledPausedOnly ? ` ${styles.scheduledActionPaused}` : ''
              }`}
              data-web-shell-scheduled-tasks-entry
              data-active={scheduledPausedOnly ? 'false' : 'true'}
              aria-label={scheduledEntryLabel}
              title={scheduledEntryLabel}
              onClick={onOpenScheduledTasks}
            >
              <CalendarClockIcon />
              <span className={styles.artifactCount} aria-hidden="true">
                {!scheduledPausedOnly &&
                scheduledTaskCount === 1 &&
                scheduledCountdown
                  ? scheduledCountdown
                  : scheduledTaskCount}
              </span>
            </button>
          )}
        {onOpenArtifacts &&
          artifactCount != null &&
          (artifactCount > 0 || (rightPanelOpen && artifactsTabActive)) && (
            <button
              type="button"
              className={`${styles.action} ${styles.artifactAction}`}
              data-web-shell-artifacts-entry
              aria-pressed={rightPanelOpen}
              aria-label={t('chatHeader.openArtifacts', {
                count: artifactCount,
              })}
              title={t('chatHeader.openArtifacts', { count: artifactCount })}
              onClick={onOpenArtifacts}
            >
              <PackageIcon />
              <span className={styles.artifactCount} aria-hidden="true">
                {artifactCount}
              </span>
            </button>
          )}
      </div>
    </header>
  );
}
