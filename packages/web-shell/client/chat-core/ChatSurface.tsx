/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useRef, useState, type ReactNode } from 'react';
import type { CommandInfo, TodoItem } from '../adapters/types.js';
import { TranscriptViewport } from '../components/TranscriptViewport.js';
import { ToolApproval } from '../components/messages/ToolApproval.js';
import type { SessionContentGenerator } from '../components/messages/AssistantMessage.js';
import { AskUserQuestion } from '../components/messages/AskUserQuestion.js';
import { ChatEditor } from '../components/ChatEditor.js';
import { useI18n } from '../i18n.js';
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
  // Paired with the pagination props: without it a failed older-history page is
  // invisible and every top-scroll re-issues the failing request.
  readonly historyPaginationError?: boolean;
  // Older-history spinner and capacity notice, forwarded to the transcript so
  // the switch does not drop them (the contract does not carry these facts yet).
  readonly loadingOlderHistory?: boolean;
  readonly historyCapacityReached?: boolean;
  // Approval facts and focus/notification gating are computed by the owning
  // page (plan state, pane focus, background-tab policy), not derivable here.
  readonly planTodos?: readonly TodoItem[];
  readonly planExecutionMode?: string;
  readonly approvalDisabled?: boolean;
  readonly approvalKeyboardActive?: boolean;
  readonly showBrowserNotifications?: boolean;
  // Page-supplied generator for the exec-command explain action; the contract
  // has no generator field, so each column's page supplies it (as App/ChatPane
  // do today, gated on the session_generation feature).
  readonly generateContent?: SessionContentGenerator;
  // Question-card host customisation: the free-text label and the details escape
  // hatch (the composer is hidden while a card is active).
  readonly askUserFreeTextLabel?: string;
  readonly askUserDetails?: () => void;
  // Composer draft scope for a new chat (no session id yet): the workspace cwd
  // and/or an explicit scope key, so the draft persists before a session exists.
  readonly atWorkspaceCwd?: string;
  readonly composerScopeKey?: string;
  // Page-supplied write block (e.g. rewind sync) folded into submitDisabled,
  // alongside the transcript-loading and in-flight-submit guards.
  readonly composerSubmitBlocked?: boolean;
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
  historyPaginationError,
  loadingOlderHistory,
  historyCapacityReached,
  planTodos,
  planExecutionMode,
  approvalDisabled,
  approvalKeyboardActive,
  showBrowserNotifications,
  generateContent,
  askUserFreeTextLabel,
  askUserDetails,
  atWorkspaceCwd,
  composerScopeKey,
  composerSubmitBlocked,
}: ChatSurfaceProps) {
  const { t } = useI18n();
  const activeApproval = controller.pendingApprovals.find(
    (approval) => approval.status === 'pending',
  );
  const activeQuestion = controller.pendingQuestions[0];
  const cardActive = Boolean(activeApproval || activeQuestion);
  // The controller's phase is a getter over a snapshot with no reactive source
  // here, so an attachment-bearing submit (no optimistic user echo) would not
  // re-render this surface until admission. Hold the in-flight latch locally so
  // the repeat-send guard arms synchronously on the first submit.
  const submitInFlightRef = useRef(false);
  const [submitInFlight, setSubmitInFlight] = useState(false);
  // An `unknown` admission means delivery is uncertain — the daemon may already
  // be running the prompt. Lock the payload (keep the draft, reject every submit
  // path) until the user explicitly acknowledges, mirroring the sibling surfaces.
  const admissionLockedRef = useRef(false);
  const [admissionLocked, setAdmissionLocked] = useState(false);
  // Both latches belong to the session that armed them: on a session switch,
  // park the outgoing session's latches under its durable sessionId and restore
  // the incoming session's parked latches (defaulting to fresh) so a stale lock
  // never blocks another session while a round-trip switch back (A -> B -> A)
  // preserves A's in-flight guard, owner token, and unknown-admission lock.
  // An unallocated '' new chat has no durable session to return to and abandons
  // its latches on a switch. Track the live refs' owner in a ref (refOwnerRef)
  // separate from the React state (lockOwner): if React discards an uncommitted
  // render after the ref park/restore has run, the retry re-enters with
  // lockOwner rolled back while refOwnerRef already matches controller.sessionId,
  // so gating the ref mutation on refOwnerRef makes the transition idempotent
  // instead of overwriting or deleting the entry it just parked.
  const ownerTokenRef = useRef({});
  const parkedLatchesRef = useRef<
    Map<string, { token: object; inFlight: boolean; admissionLocked: boolean }>
  >(new Map());
  const refOwnerRef = useRef(controller.sessionId);
  const [lockOwner, setLockOwner] = useState(controller.sessionId);
  if (
    refOwnerRef.current !== controller.sessionId ||
    lockOwner !== controller.sessionId
  ) {
    if (refOwnerRef.current !== controller.sessionId) {
      const prevOwner = refOwnerRef.current;
      if (prevOwner !== '') {
        if (submitInFlightRef.current || admissionLockedRef.current) {
          parkedLatchesRef.current.set(prevOwner, {
            token: ownerTokenRef.current,
            inFlight: submitInFlightRef.current,
            admissionLocked: admissionLockedRef.current,
          });
        } else {
          parkedLatchesRef.current.delete(prevOwner);
        }
      }
      const restored = parkedLatchesRef.current.get(controller.sessionId);
      ownerTokenRef.current = restored?.token ?? {};
      submitInFlightRef.current = restored?.inFlight ?? false;
      admissionLockedRef.current = restored?.admissionLocked ?? false;
      refOwnerRef.current = controller.sessionId;
    }
    setLockOwner(controller.sessionId);
    setSubmitInFlight(submitInFlightRef.current);
    setAdmissionLocked(admissionLockedRef.current);
  }
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
            historyPaginationError={historyPaginationError}
            loadingOlderHistory={loadingOlderHistory}
            historyCapacityReached={historyCapacityReached}
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
            generateContent={generateContent}
            onConfirm={async (id, optionId) => {
              const result = await controller.respondApproval(id, optionId);
              if (result.admission !== 'accepted') {
                // ToolApproval re-arms only through rejection; a non-accepted
                // admission must surface as an error, not a silent success.
                // Build the Error from the localized string: the host sink
                // displays error.message, so the fallback alone never shows.
                const message = t('chat.approvalNotAccepted');
                const error = new Error(message);
                reportError(error, message);
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
            customInputLabel={askUserFreeTextLabel}
            onAskDetails={askUserDetails}
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
      {admissionLocked && (
        <div
          className={styles.admissionBanner}
          role="alert"
          data-testid="admission-locked-banner"
        >
          <span>{t('queue.admissionUnknown')}</span>
          <button
            type="button"
            onClick={() => {
              admissionLockedRef.current = false;
              setAdmissionLocked(false);
              parkedLatchesRef.current.delete(controller.sessionId);
            }}
          >
            {t('chat.acknowledgeUnknown')}
          </button>
        </div>
      )}
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
          atWorkspaceCwd={atWorkspaceCwd}
          composerScopeKey={composerScopeKey}
          isRunning={isRunning}
          dialogOpen={cardActive}
          // The deferred commit keeps the draft, so the send button would stay
          // enabled over it; reject every submit path while a submit is in
          // flight, while the transcript is still loading, or while the page
          // blocks writes (the editor stays editable).
          submitDisabled={
            composerSubmitBlocked ||
            controller.transcriptState === 'loading' ||
            submitInFlight ||
            admissionLocked ||
            controller.phase === 'submitting'
          }
          onCancel={() => {
            // A refused or unknown stop admission must not be silent: the turn
            // keeps running and the user needs to know the stop did not land.
            void controller
              .cancel()
              .then((result) => {
                if (result.admission !== 'accepted') {
                  const message = t('chat.stopNotConfirmed');
                  reportError(new Error(message), message);
                }
              })
              .catch((cause: unknown) => {
                const message = t('chat.stopNotConfirmed');
                reportError(new Error(message, { cause }), message);
              });
          }}
          onSubmit={(text, images, files, commitAccepted, metadata) => {
            // Block a repeat dispatch while a submit is in flight or the payload
            // is admission-locked; keep the literal false so the still-unsent
            // draft is not wiped.
            if (submitInFlightRef.current || admissionLockedRef.current) {
              return false;
            }
            const token = ownerTokenRef.current;
            submitInFlightRef.current = true;
            setSubmitInFlight(true);
            void controller
              .submit({ text, images, files, metadata })
              .then((result) => {
                // Clear the submitting session's own draft on accepted admission
                // even if the user has since switched sessions: useComposerCore
                // scopes commitAccepted to the submitting draft key and history
                // key, so it never touches the new session's draft.
                if (result.admission === 'accepted') {
                  commitAccepted?.();
                }
                // A submit whose session is no longer active must not lock the
                // new session's composer or report errors on it; if the owning
                // session was parked, record an unknown admission on its parked
                // entry so returning to that session restores the lock.
                if (ownerTokenRef.current !== token) {
                  if (result.admission === 'unknown') {
                    for (const parked of parkedLatchesRef.current.values()) {
                      if (parked.token === token) {
                        parked.admissionLocked = true;
                      }
                    }
                  }
                  return;
                }
                if (result.admission === 'unknown') {
                  // Delivery is uncertain: lock the payload until acknowledged so
                  // a resend cannot duplicate a turn the daemon may be running.
                  admissionLockedRef.current = true;
                  setAdmissionLocked(true);
                  const message = t('chat.promptNotConfirmed');
                  reportError(new Error(message), message);
                } else if (result.admission !== 'accepted') {
                  const message = t('chat.promptNotAdmitted');
                  reportError(new Error(message), message);
                }
              })
              .catch((cause: unknown) => {
                if (ownerTokenRef.current !== token) return;
                // The host sink displays error.message, so the localized text
                // must be the Error's own message, not just the fallback.
                const message = t('chat.failedToSend');
                reportError(new Error(message, { cause }), message);
              })
              .finally(() => {
                for (const [key, parked] of parkedLatchesRef.current) {
                  if (parked.token === token) {
                    parked.inFlight = false;
                    if (!parked.admissionLocked) {
                      parkedLatchesRef.current.delete(key);
                    }
                  }
                }
                if (ownerTokenRef.current !== token) return;
                submitInFlightRef.current = false;
                setSubmitInFlight(false);
              });
            // Defer only when there is a commit to defer: the commit-less
            // entrances (submitSearchMatch, retryLast) read the literal false
            // as "refused, keep the text", so they must get undefined to keep
            // their synchronous clear. Only submitComposerText passes a commit.
            return commitAccepted ? false : undefined;
          }}
        />
      </div>
    </div>
  );
}
