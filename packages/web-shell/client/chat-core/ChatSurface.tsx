/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from 'react';
import type { CommandInfo, TodoItem } from '../adapters/types.js';
import {
  TranscriptViewport,
  type TranscriptViewportProps,
} from '../components/TranscriptViewport.js';
import { ToolApproval } from '../components/messages/ToolApproval.js';
import type { SessionContentGenerator } from '../components/messages/AssistantMessage.js';
import {
  AskUserQuestion,
  type AskUserQuestionDraft,
} from '../components/messages/AskUserQuestion.js';
import {
  ChatEditor,
  type ComposerToolbarAction,
} from '../components/ChatEditor.js';
import type { EditorHandle } from '../hooks/useComposerCore.js';
import { useI18n } from '../i18n.js';
import type { QuestionAnswer, SessionChatController } from './contract.js';
import styles from './ChatSurface.module.css';

const EMPTY_TOOLBAR_ACTIONS: readonly ComposerToolbarAction[] = [];

type SurfaceOwnedTranscriptKeys =
  | 'messages'
  | 'pendingApproval'
  | 'approvalOverlayActive'
  | 'sessionViewportEnabled'
  | 'loadingTranscript'
  | 'isResponding'
  | 'sessionKey'
  | 'hasOlderHistory'
  | 'onLoadOlderHistory'
  | 'historyPaginationError'
  | 'loadingOlderHistory'
  | 'historyCapacityReached';

export type ChatSurfaceTranscriptProps = Omit<
  TranscriptViewportProps,
  SurfaceOwnedTranscriptKeys
>;

type ChatEditorComponentProps = ComponentProps<typeof ChatEditor>;

type SurfaceOwnedComposerKeys =
  | 'commands'
  | 'atWorkspaceCwd'
  | 'composerScopeKey'
  | 'workspaceFeaturesEnabled'
  | 'visibleToolbarActions'
  | 'submitDisabled'
  | 'onCancel'
  | 'onSubmit';

export type ChatSurfaceComposerProps = Omit<
  ChatEditorComponentProps,
  SurfaceOwnedComposerKeys
>;

export interface ChatSurfaceProps {
  readonly controller: SessionChatController;
  readonly className?: string;
  // Shell chrome and backend-specific panels stay with the owning page; the
  // surface owns only the chat column. Slots keep the kernel backend-neutral.
  readonly header?: ReactNode;
  readonly panels?: ReactNode;
  readonly transcriptClassName?: string;
  readonly transcriptProps?: ChatSurfaceTranscriptProps;
  // The composer status stack / usage stats need richer facts than the current
  // conservative statusFacts; the owning page supplies them until parity lands.
  readonly composerStatus?: ReactNode;
  readonly composerFooter?: ReactNode;
  // Localized transcript-unavailable UI (recovery actions are page-specific).
  readonly transcriptError?: ReactNode;
  readonly commands?: readonly CommandInfo[];
  readonly onError?: (error: unknown, fallback: string) => void;
  // History pagination: all five members default to the controller's bound
  // facts and loader capability, while optional props let an owning page
  // override them when needed.
  readonly hasOlderHistory?: boolean;
  readonly onLoadOlderHistory?: (options?: {
    force?: boolean;
  }) => Promise<void>;
  readonly historyPaginationError?: boolean;
  readonly loadingOlderHistory?: boolean;
  readonly historyCapacityReached?: boolean;
  // Approval facts and focus/notification gating are computed by the owning
  // page (plan state, pane focus, background-tab policy), not derivable here.
  readonly decisionClassName?: string;
  readonly decisionTestId?: string;
  readonly decisionHeader?: ReactNode;
  readonly decisionFooter?: ReactNode;
  readonly approvalKey?: string;
  readonly approvalExtraDescriptionId?: string;
  readonly planTodos?: readonly TodoItem[];
  readonly planExecutionMode?: string;
  readonly approvalDisabled?: boolean;
  readonly approvalKeyboardActive?: boolean;
  readonly showBrowserNotifications?: boolean;
  // Page-supplied generator for the exec-command explain action; the contract
  // has no generator field, so each column's page supplies it (as App/ChatPane
  // do today, gated on the session_generation feature).
  readonly generateContent?: SessionContentGenerator;
  // Question-card host customisation: the free-text label, draft persistence,
  // submit-only blocking, and the details escape hatch.
  readonly questionKey?: string;
  readonly askUserFreeTextLabel?: string;
  readonly askUserDetails?: () => void;
  readonly askUserInitialDraft?: AskUserQuestionDraft;
  readonly askUserOnDraftChange?: (draft: AskUserQuestionDraft) => void;
  readonly askUserSubmitDisabled?: boolean;
  // Whether an open decision card hides the composer (default true). Hosts
  // that allow queueing or inspecting the composer alongside pending actions
  // pass false.
  readonly hideComposerWhenCardActive?: boolean;
  // Composer draft scope for a new chat (no session id yet): the workspace cwd
  // and/or an explicit scope key, so the draft persists before a session exists.
  readonly atWorkspaceCwd?: string;
  readonly composerScopeKey?: string;
  // Page-supplied write block (e.g. rewind sync) folded into submitDisabled,
  // alongside the transcript-loading and in-flight-submit guards.
  readonly composerSubmitBlocked?: boolean;
  readonly composerClassName?: string;
  readonly composerVisible?: boolean;
  readonly composerKey?: string;
  readonly composerRef?: Ref<EditorHandle>;
  readonly composerContainerRef?: Ref<HTMLDivElement>;
  readonly composerCancelEnabled?: boolean;
  readonly onComposerSubmit?: ChatEditorComponentProps['onSubmit'];
  readonly composerProps?: ChatSurfaceComposerProps;
  // Opt-in flags for host-context integrations (historical turn-navigation /
  // message-deletion viewport, workspace-backed composer features, and explicit
  // composer toolbar actions). All default closed/empty so a non-daemon surface
  // never crashes outside daemon providers or leaks an ancestor daemon
  // provider's session, workspace, or voice state when co-mounted.
  readonly sessionViewportEnabled?: boolean;
  readonly workspaceFeaturesEnabled?: boolean;
  readonly visibleToolbarActions?: readonly ComposerToolbarAction[];
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
  className,
  header,
  panels,
  transcriptClassName,
  transcriptProps,
  composerStatus,
  composerFooter,
  transcriptError,
  commands = [],
  onError,
  hasOlderHistory,
  onLoadOlderHistory,
  historyPaginationError,
  loadingOlderHistory,
  historyCapacityReached,
  decisionClassName,
  decisionTestId,
  decisionHeader,
  decisionFooter,
  approvalKey,
  approvalExtraDescriptionId,
  planTodos,
  planExecutionMode,
  approvalDisabled,
  approvalKeyboardActive,
  showBrowserNotifications,
  generateContent,
  questionKey,
  askUserFreeTextLabel,
  askUserDetails,
  askUserInitialDraft,
  askUserOnDraftChange,
  askUserSubmitDisabled,
  hideComposerWhenCardActive = true,
  atWorkspaceCwd,
  composerScopeKey,
  composerSubmitBlocked,
  composerClassName,
  composerVisible = true,
  composerKey,
  composerRef,
  composerContainerRef,
  composerCancelEnabled = true,
  onComposerSubmit,
  composerProps,
  sessionViewportEnabled = false,
  workspaceFeaturesEnabled = false,
  visibleToolbarActions = EMPTY_TOOLBAR_ACTIONS,
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
  // Commit-time snapshot for async cancel settlement checks: refOwnerRef must
  // keep updating during render for latch idempotency across discarded renders,
  // whereas a cancel settling while an incoming switch render is suspended /
  // discarded must still evaluate against the committed, on-screen session and
  // controller (and stay silent once this surface has unmounted).
  const committedSessionIdRef = useRef(controller.sessionId);
  const committedTokenRef = useRef(ownerTokenRef.current);
  const committedControllerRef = useRef(controller);
  const mountedRef = useRef(true);
  useLayoutEffect(() => {
    mountedRef.current = true;
    committedSessionIdRef.current = controller.sessionId;
    committedTokenRef.current = ownerTokenRef.current;
    committedControllerRef.current = controller;
  });
  useLayoutEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
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

  const hasDecisionWrapper =
    decisionClassName !== undefined ||
    decisionTestId !== undefined ||
    decisionHeader !== undefined ||
    decisionFooter !== undefined;
  const decisionCards = (
    <>
      {activeApproval && (
        <div
          className={hasDecisionWrapper ? undefined : styles.decisionCard}
          data-testid="approval-overlay"
        >
          <ToolApproval
            key={approvalKey}
            request={activeApproval.request}
            variant="floating"
            disabled={approvalDisabled}
            keyboardActive={approvalKeyboardActive}
            showBrowserNotifications={showBrowserNotifications}
            planExecutionMode={planExecutionMode}
            planTodos={planTodos}
            generateContent={generateContent}
            extraDescriptionId={approvalExtraDescriptionId}
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
        <div
          className={hasDecisionWrapper ? undefined : styles.decisionCard}
          data-testid="question-overlay"
        >
          <AskUserQuestion
            key={questionKey}
            request={activeQuestion.request}
            variant="floating"
            disabled={approvalDisabled}
            submitDisabled={askUserSubmitDisabled}
            keyboardActive={approvalKeyboardActive}
            customInputLabel={askUserFreeTextLabel}
            initialDraft={askUserInitialDraft}
            onDraftChange={askUserOnDraftChange}
            onAskDetails={askUserDetails}
            onError={reportError}
            onConfirm={async (id, optionId, answers, structuredAnswers) => {
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
              const normalized: QuestionAnswer[] = structuredAnswers
                ? [...structuredAnswers]
                : Object.entries(answers ?? {}).map(([questionId, value]) => ({
                    questionId,
                    value,
                  }));
              const result = await controller.respondQuestion(id, normalized);
              return result.admission === 'accepted';
            }}
          />
        </div>
      )}
    </>
  );

  const handleCancel = () => {
    const cancelSessionId = controller.sessionId;
    const cancelTurnId = controller.activeTurnId;
    const token = committedTokenRef.current;
    const isOwnerActive = (resultTurnId?: string) => {
      if (!mountedRef.current) return false;
      const sameSession =
        cancelSessionId !== ''
          ? committedSessionIdRef.current === cancelSessionId
          : committedTokenRef.current === token;
      if (!sameSession) return false;
      const targetTurnId = resultTurnId ?? cancelTurnId;
      return (
        targetTurnId === undefined ||
        committedControllerRef.current.activeTurnId === targetTurnId
      );
    };
    // A refused or unknown stop admission must not be silent on the
    // session and turn that requested it, while a late settlement after
    // a session switch, turn advance, or unmount must not misattribute
    // an older stop failure to another session or a newer turn.
    void controller
      .cancel()
      .then((result) => {
        if (!isOwnerActive(result.target?.turnId)) return;
        if (result.admission !== 'accepted') {
          const message = t('chat.stopNotConfirmed');
          reportError(new Error(message), message);
        }
      })
      .catch((cause: unknown) => {
        if (!isOwnerActive()) return;
        const message = t('chat.stopNotConfirmed');
        reportError(new Error(message, { cause }), message);
      });
  };

  const handleSurfaceSubmit: ChatEditorComponentProps['onSubmit'] = (
    text,
    images,
    files,
    commitAccepted,
    metadata,
  ) => {
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
  };

  const hideComposer = hideComposerWhenCardActive && cardActive;

  return (
    <div
      className={className ? `${styles.root} ${className}` : styles.root}
      data-testid="chat-surface"
    >
      {header}
      <div
        className={
          transcriptClassName
            ? `${styles.transcript} ${transcriptClassName}`
            : styles.transcript
        }
      >
        {controller.transcriptState === 'error' ? (
          transcriptError
        ) : (
          <TranscriptViewport
            {...transcriptProps}
            messages={[...controller.messages]}
            pendingApproval={
              activeApproval?.request ?? activeQuestion?.request ?? null
            }
            approvalOverlayActive={cardActive}
            sessionViewportEnabled={sessionViewportEnabled}
            loadingTranscript={controller.transcriptState === 'loading'}
            isResponding={isRunning}
            sessionKey={controller.sessionId}
            hasOlderHistory={hasOlderHistory ?? controller.hasOlderHistory}
            onLoadOlderHistory={loadOlder}
            historyPaginationError={
              historyPaginationError ?? controller.historyPaginationError
            }
            loadingOlderHistory={
              loadingOlderHistory ?? controller.loadingOlderHistory
            }
            historyCapacityReached={
              historyCapacityReached ?? controller.historyCapacityReached
            }
          />
        )}
      </div>
      {/* In-flow bottom sheets: a decision card replaces the hidden composer so
          the transcript shrinks above it instead of being covered by a floating
          overlay, and each card keeps its own container so an approval and a
          question pending together both stay operable. */}
      {cardActive &&
        (hasDecisionWrapper ? (
          <div className={decisionClassName} data-testid={decisionTestId}>
            {decisionHeader}
            {decisionCards}
            {decisionFooter}
          </div>
        ) : (
          decisionCards
        ))}
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
      {composerVisible && (
        <div
          ref={composerContainerRef}
          className={
            hideComposer
              ? `${composerClassName ?? styles.composer} ${styles.composerHidden}`
              : (composerClassName ?? styles.composer)
          }
        >
          {composerStatus}
          <ChatEditor
            {...composerProps}
            key={composerKey}
            ref={composerRef}
            commands={[...commands]}
            sessionId={
              composerProps && 'sessionId' in composerProps
                ? composerProps.sessionId
                : controller.sessionId
            }
            atWorkspaceCwd={atWorkspaceCwd}
            composerScopeKey={composerScopeKey}
            workspaceFeaturesEnabled={workspaceFeaturesEnabled}
            visibleToolbarActions={visibleToolbarActions}
            isRunning={
              composerCancelEnabled
                ? composerProps && 'isRunning' in composerProps
                  ? Boolean(composerProps.isRunning)
                  : isRunning
                : false
            }
            dialogOpen={
              hideComposerWhenCardActive
                ? cardActive
                : Boolean(composerProps?.dialogOpen)
            }
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
            onCancel={composerCancelEnabled ? handleCancel : undefined}
            onSubmit={onComposerSubmit ?? handleSurfaceSubmit}
          />
          {composerFooter}
        </div>
      )}
    </div>
  );
}
