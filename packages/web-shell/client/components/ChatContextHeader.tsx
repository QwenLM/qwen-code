import type { ReactNode } from 'react';
import {
  FolderClosedIcon,
  GaugeIcon,
  LayoutListIcon,
  LayersIcon,
  PanelRightIcon,
} from 'lucide-react';
import { useI18n } from '../i18n';
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
  onOpenLocalControlSettings,
}: ChatContextHeaderProps) {
  const { t } = useI18n();
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
      </div>
    </header>
  );
}
