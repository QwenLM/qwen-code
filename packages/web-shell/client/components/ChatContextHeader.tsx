import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  FolderClosedIcon,
  GaugeIcon,
  LayoutListIcon,
  LayersIcon,
  PanelRightIcon,
} from 'lucide-react';
import {
  useActions,
  useConnection,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../i18n';
import { useSessionCatalogController } from '../session-catalog/session-catalog-hooks';
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
  const connection = useConnection();
  const actions = useActions();
  const workspace = useWorkspace();
  const sessionCatalogController = useSessionCatalogController(
    workspace.client,
  );
  const workspaceLabel = workspaceName ?? t('sidebar.noWorkspace');
  const WorkspaceIcon = onOpenFiles ? 'button' : 'span';
  const workspaceAriaLabel = workspaceName
    ? t('workspace.paneLabel', { name: workspaceName })
    : workspaceLabel;

  // Single-click inline rename of the session title: the input stands in for
  // the title text, Enter saves through the same session-scoped API the pane
  // title and the sidebar's double-click rename use, and Escape/blur cancel.
  // The title click is not stopped on its way to document: open Radix
  // surfaces rely on the native click for deferred outside-press dismissal.
  const titleText = typeof content === 'string' ? content : null;
  const [sessionRenaming, setSessionRenaming] = useState(false);
  const [sessionRenameValue, setSessionRenameValue] = useState('');
  const [sessionRenameSaving, setSessionRenameSaving] = useState(false);
  const cancelSessionRename = useCallback(() => {
    setSessionRenaming(false);
    setSessionRenameValue('');
    setSessionRenameSaving(false);
  }, []);
  useEffect(() => {
    // A session swap out from under the header must not keep a stale draft
    // (the pane title resets its rename state the same way).
    cancelSessionRename();
  }, [connection.sessionId, cancelSessionRename]);
  const beginSessionRename = useCallback(() => {
    if (
      !connection.sessionId ||
      !titleText ||
      sessionRenaming ||
      sessionRenameSaving
    ) {
      return;
    }
    // A drag that ends on the title leaves a live text selection; the same
    // guard the pane title click uses keeps that click out of rename.
    if (window.getSelection()?.isCollapsed === false) return;
    setSessionRenameValue(titleText);
    setSessionRenaming(true);
  }, [connection.sessionId, sessionRenaming, sessionRenameSaving, titleText]);
  const saveSessionRename = useCallback(() => {
    const nextName = sessionRenameValue.trim();
    const sessionId = connection.sessionId;
    if (!nextName || !sessionId || sessionRenameSaving) {
      cancelSessionRename();
      return;
    }
    // Enter without editing re-sends the current label: skip the daemon
    // write and close the form (the pane title bails the same way).
    if (nextName === titleText) {
      cancelSessionRename();
      return;
    }
    setSessionRenameSaving(true);
    const rename =
      connection.sessionContext?.kind === 'standalone'
        ? workspace.client.renameStandaloneSession(sessionId, nextName)
        : actions.renameSession(nextName);
    void rename
      .then((result: { displayName?: unknown } | undefined) => {
        // The daemon clamps displayName to 256 chars and reports the stored
        // value; propagate that instead of the locally typed string.
        const effectiveName =
          typeof result?.displayName === 'string' && result.displayName
            ? result.displayName
            : nextName;
        if (connection.workspaceCwd) {
          sessionCatalogController.renamed(
            connection.workspaceCwd,
            sessionId,
            effectiveName,
          );
          sessionCatalogController.refreshWorkspace(connection.workspaceCwd);
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to rename session', error);
      })
      .finally(() => {
        cancelSessionRename();
      });
  }, [
    actions,
    cancelSessionRename,
    connection.sessionContext?.kind,
    connection.sessionId,
    connection.workspaceCwd,
    sessionCatalogController,
    sessionRenameSaving,
    sessionRenameValue,
    titleText,
    workspace.client,
  ]);
  const sessionTitleRenameProps =
    titleText && connection.sessionId
      ? {
          role: 'button' as const,
          tabIndex: 0,
          'data-web-shell-pane-title': '',
          onClick: beginSessionRename,
          onKeyDown: (event: { key: string }) => {
            if (event.key === 'Enter') beginSessionRename();
          },
        }
      : {};

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
      <div className={styles.content}>
        {sessionRenaming ? (
          <input
            className={styles.titleRenameInput}
            aria-label={`${t('sessionTitle.rename')}: ${titleText ?? ''}`}
            data-web-shell-pane-title-input
            autoFocus
            value={sessionRenameValue}
            maxLength={256}
            onChange={(event) => setSessionRenameValue(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={cancelSessionRename}
            onKeyDown={(event) => {
              // The editor owns the keys: pane-level Escape (maximize) and
              // approval shortcuts must not see them, the same as the pane
              // title rename form.
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                saveSessionRename();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelSessionRename();
              }
            }}
          />
        ) : titleText && connection.sessionId ? (
          <span title={titleText} {...sessionTitleRenameProps}>
            {titleText}
          </span>
        ) : (
          content
        )}
      </div>
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
