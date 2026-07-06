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
import { isAskUserPermission } from '../utils/askUserPermission';
import { MessageList } from './MessageList';
import { StreamingStatus } from './StreamingStatus';
import { ChatEditor } from './ChatEditor';
import { ToolApproval } from './messages/ToolApproval';
import { AskUserQuestion } from './messages/AskUserQuestion';
import styles from './ChatPane.module.css';

const EMPTY_COMMANDS: never[] = [];
const EMPTY_TOOLBAR: never[] = [];

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
      // Keep the draft (return false) until the prompt is actually accepted:
      // sendPrompt can reject (transcript still loading, session disconnected,
      // or a turn already active), and committing first would silently drop the
      // user's text. Commit only once it resolves.
      actions
        .sendPrompt(trimmed, images && images.length ? { images } : undefined)
        .then(() => commitAccepted?.())
        .catch((error: unknown) => reportError(error, 'Failed to send prompt'));
      return false;
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
              // Several panes can show approvals at once; global Enter/Escape
              // shortcuts aren't focus-scoped, so keep pane approvals
              // click-only to avoid confirming the wrong session's request.
              keyboardActive={false}
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
