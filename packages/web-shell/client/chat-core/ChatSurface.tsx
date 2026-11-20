/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from 'react';
import type { CommandInfo, TodoItem } from '../adapters/types.js';
import { TranscriptViewport } from '../components/TranscriptViewport.js';
import { ToolApproval } from '../components/messages/ToolApproval.js';
import { AskUserQuestion } from '../components/messages/AskUserQuestion.js';
import { ChatEditor } from '../components/ChatEditor.js';
import type { QuestionAnswer, SessionChatController } from './contract.js';
import styles from './ChatSurface.module.css';

export interface ChatSurfaceProps {
  readonly controller: SessionChatController;
  // Shell chrome and backend-specific panels stay with the owning page; the
  // surface owns only the chat column. Slots keep the kernel backend-neutral.
  readonly header?: ReactNode;
  readonly panels?: ReactNode;
  // The composer status stack / usage stats need richer facts than the current
  // conservative statusFacts; the owning page supplies them until parity lands.
  readonly composerStatus?: ReactNode;
  // Localized transcript-unavailable UI (recovery actions are page-specific).
  readonly transcriptError?: ReactNode;
  readonly commands?: readonly CommandInfo[];
  readonly onError?: (error: unknown, fallback: string) => void;
  // History pagination: the loader defaults to the controller's capability, but
  // whether older history exists is a page fact the contract does not carry yet.
  readonly hasOlderHistory?: boolean;
  readonly onLoadOlderHistory?: (options?: {
    force?: boolean;
  }) => Promise<void>;
  // Approval facts and focus/notification gating are computed by the owning
  // page (plan state, pane focus, background-tab policy), not derivable here.
  readonly planTodos?: readonly TodoItem[];
  readonly planExecutionMode?: string;
  readonly approvalDisabled?: boolean;
  readonly approvalKeyboardActive?: boolean;
  readonly showBrowserNotifications?: boolean;
}

/**
 * The backend-neutral chat column (unified chat surface, slice 2). It renders
 * every chat column from a {@link SessionChatController} view model and never
 * branches on `controller.kind`: a region renders only when its facts are
 * present. Backend-specific panels and chrome arrive as slots. Admission is not
 * establishment — the composer defers its draft commit to admission, while turn
 * and decision outcomes are reflected through the controller's observable state.
 */
export function ChatSurface({
  controller,
  header,
  panels,
  composerStatus,
  transcriptError,
  commands = [],
  onError,
  hasOlderHistory,
  onLoadOlderHistory,
  planTodos,
  planExecutionMode,
  approvalDisabled,
  approvalKeyboardActive,
  showBrowserNotifications,
}: ChatSurfaceProps) {
  const activeApproval = controller.pendingApprovals.find(
    (approval) => approval.status === 'pending',
  );
  const activeQuestion = controller.pendingQuestions[0];
  const cardActive = Boolean(activeApproval || activeQuestion);
  // A cancel in flight keeps the turn live until settlement evidence arrives.
  const isRunning =
    controller.phase === 'running' ||
    controller.phase === 'submitting' ||
    controller.phase === 'cancelling';
  const reportError =
    onError ??
    ((error: unknown, fallback: string) => {
      console.error(fallback, error);
    });
  const loadOlder = onLoadOlderHistory ?? controller.loadOlder;

  return (
    <div className={styles.root} data-testid="chat-surface">
      {header}
      <div className={styles.transcript}>
        {controller.transcriptState === 'error' ? (
          transcriptError
        ) : (
          <TranscriptViewport
            messages={[...controller.messages]}
            pendingApproval={activeApproval?.request ?? null}
            approvalOverlayActive={cardActive}
            loadingTranscript={controller.transcriptState === 'loading'}
            isResponding={isRunning}
            sessionKey={controller.sessionId}
            hasOlderHistory={hasOlderHistory}
            onLoadOlderHistory={loadOlder}
          />
        )}
      </div>
      {/* In-flow bottom sheets: a decision card replaces the hidden composer so
          the transcript shrinks above it instead of being covered by a floating
          overlay, and each card keeps its own container so an approval and a
          question pending together both stay operable. */}
      {activeApproval && (
        <div className={styles.decisionCard} data-testid="approval-overlay">
          <ToolApproval
            request={activeApproval.request}
            variant="floating"
            disabled={approvalDisabled}
            keyboardActive={approvalKeyboardActive}
            showBrowserNotifications={showBrowserNotifications}
            planExecutionMode={planExecutionMode}
            planTodos={planTodos}
            onConfirm={async (id, optionId) => {
              const result = await controller.respondApproval(id, optionId);
              if (result.admission !== 'accepted') {
                // ToolApproval re-arms only through rejection; a non-accepted
                // admission must surface as an error, not a silent success.
                const error = new Error('Approval was not accepted');
                reportError(error, error.message);
                throw error;
              }
            }}
          />
        </div>
      )}
      {activeQuestion && (
        <div className={styles.decisionCard} data-testid="question-overlay">
          <AskUserQuestion
            request={activeQuestion.request}
            variant="floating"
            keyboardActive={approvalKeyboardActive}
            onError={reportError}
            onConfirm={async (id, optionId, answers) => {
              const option = activeQuestion.request.options.find(
                (candidate) => candidate.id === optionId,
              );
              // Only the submit (allow_once) option carries answers; the reject
              // option is a decision vote and must travel through respondApproval
              // (respondQuestion always votes the submit option).
              if (!option || option.kind !== 'allow_once') {
                const result = await controller.respondApproval(id, optionId);
                return result.admission === 'accepted';
              }
              const normalized: QuestionAnswer[] = Object.entries(
                answers ?? {},
              ).map(([questionId, value]) => ({ questionId, value }));
              const result = await controller.respondQuestion(id, normalized);
              return result.admission === 'accepted';
            }}
          />
        </div>
      )}
      {panels}
      <div
        className={
          cardActive
            ? `${styles.composer} ${styles.composerHidden}`
            : styles.composer
        }
      >
        {composerStatus}
        <ChatEditor
          commands={[...commands]}
          sessionId={controller.sessionId}
          isRunning={isRunning}
          dialogOpen={cardActive}
          onCancel={() => {
            void controller.cancel();
          }}
          onSubmit={(text, images, files, commitAccepted, metadata) => {
            void controller
              .submit({ text, images, files, metadata })
              .then((result) => {
                // Clear the draft on admission, not on establishment.
                if (result.admission === 'accepted') commitAccepted?.();
              });
            // Defer the composer's synchronous commit to admission; only the
            // literal false does that (useComposerCore commits on any other
            // return, wiping the draft before the transport resolves).
            return false;
          }}
        />
      </div>
    </div>
  );
}
