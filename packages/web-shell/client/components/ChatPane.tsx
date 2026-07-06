/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo } from 'react';
import {
  useActions,
  useConnection,
  useStreamingState,
  useTranscriptBlocks,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../i18n';
import { useMessages } from '../hooks/useMessages';
import { extractPendingPermission } from '../adapters/transcriptAdapter';
import type { PromptImage } from '../adapters/promptTypes';
import type { ComposerSubmitCommit } from '../hooks/useComposerCore';
import { isAskUserQuestionToolName } from './messages/toolFormatting';
import { MessageList } from './MessageList';
import { StreamingStatus } from './StreamingStatus';
import { ChatEditor } from './ChatEditor';
import { ToolApproval } from './messages/ToolApproval';
import { AskUserQuestion } from './messages/AskUserQuestion';
import type { PermissionRequest } from '../adapters/types';
import styles from './ChatPane.module.css';

// Matches the daemon default (ui.shellOutputMaxLines). A split pane does not
// wire the workspace settings, so use the built-in default; the setting still
// applies in the full single-session view.
const DEFAULT_SHELL_OUTPUT_MAX_LINES = 5;
const EMPTY_COMMANDS: never[] = [];
const EMPTY_TOOLBAR: never[] = [];

// Mirror of App's local helper: an AskUserQuestion approval carries a
// `questions` array (and either no toolName or the AskUserQuestion tool name);
// everything else is a normal tool-call approval.
function isAskUserPermission(request: PermissionRequest | null): boolean {
  if (
    !request?.rawInput?.questions ||
    !Array.isArray(request.rawInput.questions)
  ) {
    return false;
  }
  if (!request.toolName) return true;
  return isAskUserQuestionToolName(request.toolName);
}

export interface ChatPaneProps {
  /** Header label; falls back to the session's own display name / id. */
  title?: string;
  /** Marks the pane bound to the window's primary (sidebar-selected) session. */
  isCurrent?: boolean;
  onClose?: () => void;
  onError?: (error: unknown, fallback: string) => void;
}

/**
 * A self-contained interactive chat, scoped to whichever `DaemonSessionProvider`
 * it is nested under. Rendering N of these (each under its own provider) inside
 * one window is the split view: every pane has its own transcript, streaming
 * state, approvals, and composer, and the browser scopes keyboard focus to the
 * pane the user clicks into — so there is no cross-pane approval arbitration.
 */
export function ChatPane({ title, isCurrent, onClose, onError }: ChatPaneProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const actions = useActions();
  const messages = useMessages(t);
  const blocks = useTranscriptBlocks();
  const streamingState = useStreamingState();

  const reportError = useCallback(
    (error: unknown, fallback: string) => {
      if (onError) onError(error, fallback);
      else console.error(fallback, error);
    },
    [onError],
  );

  const pendingApproval = useMemo(
    () => extractPendingPermission(blocks),
    [blocks],
  );
  const isAskUser = isAskUserPermission(pendingApproval);
  const pendingToolApproval =
    pendingApproval && !isAskUser ? pendingApproval : null;
  const pendingAskUserApproval =
    pendingApproval && isAskUser ? pendingApproval : null;
  const approvalActive =
    pendingToolApproval !== null || pendingAskUserApproval !== null;
  const isResponding = streamingState !== 'idle';

  const handleSubmit = useCallback(
    (
      text: string,
      images?: PromptImage[],
      commitAccepted?: ComposerSubmitCommit,
    ): boolean => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      actions
        .sendPrompt(
          trimmed,
          images && images.length ? { images } : undefined,
        )
        .catch((error: unknown) => reportError(error, 'Failed to send prompt'));
      commitAccepted?.();
      return true;
    },
    [actions, reportError],
  );

  const handleConfirm = useCallback(
    (id: string, selectedOption: string, answers?: Record<string, string>) => {
      actions
        .submitPermission(id, selectedOption, answers)
        .catch((error: unknown) =>
          reportError(error, 'Failed to submit permission choice'),
        );
    },
    [actions, reportError],
  );

  const handleCancel = useCallback(() => {
    actions
      .cancel()
      .catch((error: unknown) => reportError(error, 'Failed to cancel request'));
  }, [actions, reportError]);

  const headerLabel =
    title || connection.displayName || connection.sessionId?.slice(0, 8) || '';

  return (
    <section
      className={[styles.pane, isCurrent ? styles.paneCurrent : '']
        .filter(Boolean)
        .join(' ')}
      data-testid="chat-pane"
      aria-label={headerLabel}
    >
      <header className={styles.header}>
        <span className={styles.title} title={headerLabel}>
          {headerLabel}
        </span>
        {isCurrent && (
          <span className={styles.currentBadge}>
            {t('sessionsOverview.current')}
          </span>
        )}
        {onClose && (
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label={t('splitView.closePane')}
            title={t('splitView.closePane')}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </header>

      <div className={styles.body}>
        <MessageList
          messages={messages}
          pendingApproval={pendingToolApproval}
          loadingTranscript={connection.loadingTranscript}
          catchingUp={connection.catchingUp}
          isResponding={isResponding}
          workspaceCwd={connection.workspaceCwd || ''}
          shellOutputMaxLines={DEFAULT_SHELL_OUTPUT_MAX_LINES}
          hideSessionTimeline
        />
      </div>

      <div className={styles.footer}>
        {pendingToolApproval && (
          <div className={styles.approval} data-testid="pane-approval">
            <ToolApproval
              request={pendingToolApproval}
              onConfirm={handleConfirm}
              variant="floating"
            />
          </div>
        )}
        {pendingAskUserApproval && (
          <div className={styles.approval} data-testid="pane-approval">
            <AskUserQuestion
              request={pendingAskUserApproval}
              onConfirm={handleConfirm}
              variant="floating"
            />
          </div>
        )}
        <StreamingStatus startedAt={undefined} />
        <ChatEditor
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          isRunning={isResponding}
          commands={EMPTY_COMMANDS}
          visibleToolbarActions={EMPTY_TOOLBAR}
          dialogOpen={approvalActive}
          placeholderText={t('splitView.composerPlaceholder')}
        />
      </div>
    </section>
  );
}
