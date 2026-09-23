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
  /**
   * Workspace shown as the header's leading icon. Omitting it means the shell
   * has no workspace: the icon stays the same folder and only its tooltip says
   * so, because the icon is the one place that always answers "which workspace
   * is this session in?".
   */
  workspaceName?: string;
  /** Full workspace path, shown as the leading icon's hover tooltip. */
  workspacePath?: string;
  environmentOpen: boolean;
  environmentAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelAvailable: boolean;
  onToggleEnvironment: () => void;
  onToggleRightPanel: () => void;
  /** Opens the session token-usage panel; hidden when omitted. */
  onOpenTokenUsage?: () => void;
  /** Opens the session context panel; hidden when omitted. */
  onOpenContextUsage?: () => void;
  /** Shows the Local Control QR entry; hidden when omitted. */
  onOpenLocalControlSettings?: () => void;
}

export function ChatContextHeader({
  content,
  workspaceName,
  workspacePath,
  environmentOpen,
  environmentAvailable,
  rightPanelOpen,
  rightPanelAvailable,
  onToggleEnvironment,
  onToggleRightPanel,
  onOpenTokenUsage,
  onOpenContextUsage,
  onOpenLocalControlSettings,
}: ChatContextHeaderProps) {
  const { t } = useI18n();
  const workspaceLabel = workspaceName ?? t('sidebar.noWorkspace');

  return (
    <header className={styles.header} data-testid="chat-context-header">
      {/* role="img" so the icon is announced as its aria-label; a bare span
          (generic role) does not surface one reliably. The same folder glyph
          serves both states — the icon cannot name the workspace, or say that
          there is none, so hovering it does. */}
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              className={styles.workspaceIcon}
              data-testid="chat-header-workspace"
              aria-label={
                workspaceName
                  ? t('workspace.paneLabel', { name: workspaceName })
                  : workspaceLabel
              }
            >
              <FolderClosedIcon />
            </span>
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
      <div className={styles.content}>{content}</div>
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
