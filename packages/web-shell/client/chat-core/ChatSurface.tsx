/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from 'react';
import type { CommandInfo } from '../adapters/types.js';
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
}

/**
 * The backend-neutral chat column (unified chat surface, slice 2). It renders
 * every chat column from a {@link SessionChatController} view model and never
 * branches on `controller.kind`: a region renders only when its facts are
 * present. Backend-specific panels and chrome arrive as slots. Admission is not
 * establishment — the composer clears its draft on admission, while turn and
 * decision outcomes are reflected through the controller's observable state.
 */
export function ChatSurface({
  controller,
  header,
  panels,
  composerStatus,
  transcriptError,
  commands = [],
  onError,
}: ChatSurfaceProps) {
  const activeApproval = controller.pendingApprovals.find(
    (approval) => approval.status === 'pending',
  );
  const activeQuestion = controller.pendingQuestions[0];
  const isRunning =
    controller.phase === 'running' || controller.phase === 'submitting';
  const reportError =
    onError ??
    (() => {
      /* default: errors surface through the controller's observable state */
    });

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
            loadingTranscript={controller.transcriptState === 'loading'}
            isResponding={isRunning}
            sessionKey={controller.sessionId}
          />
        )}
      </div>
      {activeApproval && (
        <div className={styles.approvalOverlay} data-testid="approval-overlay">
          <ToolApproval
            request={activeApproval.request}
            variant="floating"
            onConfirm={async (id, optionId) => {
              await controller.respondApproval(id, optionId);
            }}
          />
        </div>
      )}
      {activeQuestion && (
        <div className={styles.approvalOverlay} data-testid="approval-overlay">
          <AskUserQuestion
            request={activeQuestion.request}
            variant="floating"
            onError={reportError}
            onConfirm={async (id, _optionId, answers) => {
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
      <div className={styles.composer}>
        {composerStatus}
        <ChatEditor
          commands={[...commands]}
          sessionId={controller.sessionId}
          isRunning={isRunning}
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
          }}
        />
      </div>
    </div>
  );
}
