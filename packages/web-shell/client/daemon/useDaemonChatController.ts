import { useCallback, useEffect, useRef } from 'react';
import type {
  Admission,
  ChatCapabilities,
  ChatStatusFacts,
  PendingApproval,
  PendingQuestion,
  SessionChatController,
} from '../chat-core/contract.js';
import type {
  DaemonConnectionState,
  DaemonPromptSettledEvent,
  DaemonSessionActions,
} from './session/types.js';
import {
  regionsToCapabilities,
  type ChatRegion,
} from '../chat-core/capabilities.js';
import { useI18n } from '../i18n.js';
import { useMessagesFromBlocks } from '../hooks/useMessages.js';
import { getComposerDraftStorageKey } from '../hooks/useComposerCore.js';
import {
  extractPendingPermission,
  isAskUserPermissionBlock,
  pendingPermissionRevision,
} from '../adapters/transcriptAdapter.js';
import { isExitPlanApprovalRequest } from '../utils/todos.js';
import {
  useDaemonActions,
  useDaemonConnection,
  useDaemonPendingPermissions,
  useDaemonPromptSettled,
  useDaemonTranscriptBlocks,
  useDaemonTranscriptHistory,
  useOptionalDaemonPromptSettled,
} from './session/DaemonSessionProvider.js';
import {
  createDaemonChatController,
  type DaemonDecisionSettlement,
  type DaemonPromptSettlement,
} from './chat-controller.js';
import { DAEMON_CHAT_CAPABILITY_MAP } from './chat-capabilities.js';
import { derivePermissionSignals } from './permission-signals.js';

export interface DaemonChatControllerFromStateOptions {
  readonly connection: Pick<
    DaemonConnectionState,
    | 'sessionId'
    | 'workspaceCwd'
    | 'capabilities'
    | 'loadingTranscript'
    | 'missingSession'
    | 'planExecutionMode'
  >;
  readonly actions: Pick<
    DaemonSessionActions,
    'cancel' | 'submitPermission' | 'respondToPermission'
  > &
    Partial<Pick<DaemonSessionActions, 'submitPrompt'>>;
  readonly transcriptHistory: Pick<
    ReturnType<typeof useDaemonTranscriptHistory>,
    'hasMore' | 'loading' | 'capacityReached' | 'paginationError' | 'loadMore'
  >;
  readonly messages: SessionChatController['messages'];
  readonly pendingApprovals: readonly PendingApproval[];
  readonly pendingQuestions: readonly PendingQuestion[];
  readonly pendingSignature: string;
  readonly transcriptState?: SessionChatController['transcriptState'];
  readonly submitPermission?: (
    requestId: string,
    optionId: string,
  ) => Promise<Admission>;
}

const DEFAULT_STATUS_FACTS: ChatStatusFacts = {
  queueLength: 0,
  goalActive: false,
};

interface LiveFacts {
  messages: SessionChatController['messages'];
  transcriptState: SessionChatController['transcriptState'];
  hasOlderHistory: boolean;
  loadingOlderHistory: boolean;
  historyCapacityReached: boolean;
  historyPaginationError: boolean;
  pendingApprovals: readonly PendingApproval[];
  pendingQuestions: readonly PendingQuestion[];
  statusFacts: ChatStatusFacts;
  capabilities: ChatCapabilities;
  settledPhase: 'idle' | 'failed';
}

function capabilitiesFromFeatures(
  features: readonly string[],
): ChatCapabilities {
  const regions = new Set<ChatRegion>();
  const map = DAEMON_CHAT_CAPABILITY_MAP as Record<
    string,
    readonly ChatRegion[]
  >;
  for (const feature of features) {
    // features are unvalidated wire strings; guard against Object.prototype
    // members (e.g. "toString") resolving to a non-iterable inherited value.
    if (!Object.hasOwn(map, feature)) continue;
    for (const region of map[feature]) regions.add(region);
  }
  return regionsToCapabilities(regions);
}

function useDaemonChatControllerCore({
  connection,
  actions,
  transcriptHistory,
  messages,
  pendingApprovals,
  pendingQuestions,
  pendingSignature,
  transcriptState,
  submitPermission: submitPermissionOverride,
}: DaemonChatControllerFromStateOptions): {
  readonly controller: SessionChatController;
  readonly onPromptSettled: (event: DaemonPromptSettledEvent) => void;
} {
  const sessionId = connection.sessionId;
  const resolvedTranscriptState: SessionChatController['transcriptState'] =
    transcriptState ??
    (connection.missingSession
      ? 'error'
      : connection.loadingTranscript
        ? 'loading'
        : 'ready');

  const factsRef = useRef<LiveFacts>({
    messages,
    transcriptState: 'loading',
    hasOlderHistory: false,
    loadingOlderHistory: false,
    historyCapacityReached: false,
    historyPaginationError: false,
    pendingApprovals,
    pendingQuestions,
    statusFacts: DEFAULT_STATUS_FACTS,
    capabilities: regionsToCapabilities([]),
    settledPhase: 'idle',
  });
  factsRef.current = {
    messages,
    // Only a missing session makes the transcript unavailable; a plain
    // connection error keeps the transcript readable (the surfaces render a
    // banner over it), so it must not collapse the transcript to an error view.
    transcriptState: resolvedTranscriptState,
    hasOlderHistory: transcriptHistory.hasMore,
    loadingOlderHistory: transcriptHistory.loading,
    historyCapacityReached: transcriptHistory.capacityReached,
    historyPaginationError: transcriptHistory.paginationError,
    pendingApprovals,
    pendingQuestions,
    statusFacts: DEFAULT_STATUS_FACTS,
    capabilities: capabilitiesFromFeatures(
      connection.capabilities?.features ?? [],
    ),
    settledPhase: 'idle',
  };

  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const connectionRef = useRef(connection);
  connectionRef.current = connection;

  const transcriptHistoryRef = useRef(transcriptHistory);
  transcriptHistoryRef.current = transcriptHistory;

  const submitPermissionOverrideRef = useRef(submitPermissionOverride);
  submitPermissionOverrideRef.current = submitPermissionOverride;

  const promptListenerRef = useRef<
    ((e: DaemonPromptSettlement) => void) | undefined
  >(undefined);
  const decisionListenerRef = useRef<
    ((e: DaemonDecisionSettlement) => void) | undefined
  >(undefined);
  const currencyListenerRef = useRef<
    ((id: string, live: boolean) => void) | undefined
  >(undefined);
  const answeredRef = useRef<Set<string>>(new Set());
  const prevPendingRef = useRef<Set<string>>(new Set());
  // Tracks admitted prompts per durable session across controller rebuilds
  // (e.g. s1 -> s2 -> s1) so a re-created controller for s1 still knows its
  // active FIFO turn id until a terminal settlement removes it.
  const livePromptsBySessionRef = useRef<Map<string, string[]>>(new Map());
  const pendingSubmitSettledRef = useRef<Set<Set<string>>>(new Set());

  const controllerRef = useRef<{
    sessionId: string | undefined;
    controller: SessionChatController;
  } | null>(null);

  if (!controllerRef.current || controllerRef.current.sessionId !== sessionId) {
    answeredRef.current = new Set();
    prevPendingRef.current = new Set();
    const boundSessionId = sessionId ?? '';
    controllerRef.current = {
      sessionId,
      controller: createDaemonChatController({
        sessionId: boundSessionId,
        storageKey:
          getComposerDraftStorageKey(sessionId, connection.workspaceCwd) ?? '',
        get messages() {
          return factsRef.current.messages;
        },
        get transcriptState() {
          return factsRef.current.transcriptState;
        },
        get hasOlderHistory() {
          return factsRef.current.hasOlderHistory;
        },
        get loadingOlderHistory() {
          return factsRef.current.loadingOlderHistory;
        },
        get historyCapacityReached() {
          return factsRef.current.historyCapacityReached;
        },
        get historyPaginationError() {
          return factsRef.current.historyPaginationError;
        },
        get pendingApprovals() {
          return factsRef.current.pendingApprovals;
        },
        get pendingQuestions() {
          return factsRef.current.pendingQuestions;
        },
        get statusFacts() {
          return factsRef.current.statusFacts;
        },
        get capabilities() {
          return factsRef.current.capabilities;
        },
        get settledPhase() {
          return factsRef.current.settledPhase;
        },
        // History pagination is a provider capability, not an intent: read the
        // latest loader per call and forward options (including { force: true }
        // for pagination-error retries) so a session-stable controller never
        // pins a stale history handle or silently drops a retry.
        loadOlder: (options) => transcriptHistoryRef.current.loadMore(options),
        liveApprovalRequestIds: pendingApprovals.map((approval) => approval.id),
        livePromptIds: boundSessionId
          ? livePromptsBySessionRef.current.get(boundSessionId)
          : undefined,
        async submitPrompt(input, onAdmitted) {
          const submit = actionsRef.current.submitPrompt;
          if (!submit) return 'rejected';
          const settledDuringSubmit = new Set<string>();
          pendingSubmitSettledRef.current.add(settledDuringSubmit);
          try {
            // submitPrompt is non-blocking and resolves the prompt id; it does
            // not invoke an onAdmitted option (only sendPrompt does), so bind
            // the id from the resolved result.
            const accepted = await submit(input.text, {
              images: input.images ? [...input.images] : undefined,
              files: input.files ? [...input.files] : undefined,
              // The composer's @-file references reach the daemon only through
              // inputAnnotations; dropping them loses the reference chips.
              ...(input.metadata?.inputAnnotations?.length
                ? { inputAnnotations: [...input.metadata.inputAnnotations] }
                : {}),
            });
            if (
              boundSessionId !== '' &&
              accepted.promptId &&
              !settledDuringSubmit.has(accepted.promptId)
            ) {
              let queue = livePromptsBySessionRef.current.get(boundSessionId);
              if (!queue) {
                queue = [];
                livePromptsBySessionRef.current.set(boundSessionId, queue);
              }
              if (!queue.includes(accepted.promptId)) {
                queue.push(accepted.promptId);
              }
            }
            onAdmitted(accepted.promptId);
            return 'accepted';
          } catch {
            return 'unknown';
          } finally {
            pendingSubmitSettledRef.current.delete(settledDuringSubmit);
          }
        },
        async cancelPrompt() {
          try {
            await actionsRef.current.cancel();
            return 'accepted';
          } catch {
            return 'unknown';
          }
        },
        async submitPermission(requestId, optionId) {
          answeredRef.current.add(requestId);
          try {
            const override = submitPermissionOverrideRef.current;
            if (override) {
              const admission = await override(requestId, optionId);
              if (admission !== 'accepted') {
                answeredRef.current.delete(requestId);
              }
              return admission;
            }
            // A plan approval must carry the CURRENT expectedPlanExecutionMode;
            // the core denies an ExitPlanMode approve without it. submitPermission
            // cannot carry that field, so vote through respondToPermission with
            // the mode read per call, exactly like the existing surfaces.
            const permission =
              factsRef.current.pendingApprovals.find(
                (candidate) => candidate.id === requestId,
              )?.request ??
              factsRef.current.pendingQuestions.find(
                (candidate) => candidate.id === requestId,
              )?.request ??
              null;
            const option = permission?.options.find((o) => o.id === optionId);
            const planMode = connectionRef.current.planExecutionMode;
            const approvesPlan =
              isExitPlanApprovalRequest(permission) &&
              (option?.kind === 'allow_once' ||
                option?.kind === 'allow_always') &&
              planMode !== undefined;
            const applied = approvesPlan
              ? await actionsRef.current.respondToPermission(requestId, {
                  outcome: { outcome: 'selected', optionId },
                  expectedPlanExecutionMode: planMode,
                })
              : await actionsRef.current.submitPermission(requestId, optionId);
            if (!applied) answeredRef.current.delete(requestId);
            return applied ? 'accepted' : 'rejected';
          } catch {
            // Admission unknown: the controller abandons the attempt, so a
            // later permission-resolution signal could not settle it anyway;
            // drop the answer tracking instead of retaining a useless entry.
            answeredRef.current.delete(requestId);
            return 'unknown';
          }
        },
        async submitQuestionAnswers(requestId, answers) {
          // A question is answered by voting its submit (allow_once) option with
          // the answers attached — the same wire shape AskUserQuestion uses.
          // Voting with no optionId sends a 'cancelled' outcome, which discards
          // the answers and cancels the question, so require the submit option.
          const permission = factsRef.current.pendingQuestions.find(
            (candidate) => candidate.id === requestId,
          )?.request;
          const submitOptionId = permission?.options.find(
            (option) => option.kind === 'allow_once',
          )?.id;
          if (!submitOptionId) return 'rejected';
          // The daemon keys answers by the question's decimal index (the shape
          // AskUserQuestion.buildResult emits); an id-shaped key would be
          // silently discarded while the vote still succeeds, so validate each
          // questionId against the question count instead.
          const questions = permission?.rawInput?.questions;
          const questionCount = Array.isArray(questions) ? questions.length : 0;
          const record: Record<string, string> = {};
          for (const answer of answers) {
            const index = Number(answer.questionId);
            if (
              !Number.isInteger(index) ||
              index < 0 ||
              index >= questionCount
            ) {
              return 'rejected';
            }
            record[String(index)] = answer.value;
          }
          answeredRef.current.add(requestId);
          try {
            const applied = await actionsRef.current.submitPermission(
              requestId,
              submitOptionId,
              record,
            );
            if (!applied) answeredRef.current.delete(requestId);
            return applied ? 'accepted' : 'rejected';
          } catch {
            answeredRef.current.delete(requestId);
            return 'unknown';
          }
        },
        subscribePromptSettlement(listener) {
          promptListenerRef.current = listener;
          return () => {
            promptListenerRef.current = undefined;
          };
        },
        subscribeDecisionSettlement(listener) {
          decisionListenerRef.current = listener;
          return () => {
            decisionListenerRef.current = undefined;
          };
        },
        subscribeApprovalCurrency(listener) {
          currencyListenerRef.current = listener;
          return () => {
            currencyListenerRef.current = undefined;
          };
        },
      }),
    };
  }

  const onPromptSettled = useCallback((event: DaemonPromptSettledEvent) => {
    for (const settled of pendingSubmitSettledRef.current) {
      settled.add(event.promptId);
    }
    // Remove the settled prompt from its owning session's live queue
    // (matching event.sessionId when present, or scanning all queues when a
    // test fixture omits event.sessionId).
    const targetSessions = event.sessionId
      ? [event.sessionId]
      : [...livePromptsBySessionRef.current.keys()];
    for (const sid of targetSessions) {
      const queue = livePromptsBySessionRef.current.get(sid);
      if (!queue) continue;
      const index = queue.indexOf(event.promptId);
      if (index !== -1) queue.splice(index, 1);
      if (queue.length === 0) livePromptsBySessionRef.current.delete(sid);
    }
    if (
      !event.sessionId ||
      event.sessionId === controllerRef.current?.sessionId
    ) {
      promptListenerRef.current?.({
        promptId: event.promptId,
        outcome: event.outcome,
      });
    }
  }, []);

  useEffect(() => {
    const nextPending = new Set<string>([
      ...factsRef.current.pendingApprovals.map((approval) => approval.id),
      ...factsRef.current.pendingQuestions.map((question) => question.id),
    ]);
    const signals = derivePermissionSignals(
      prevPendingRef.current,
      nextPending,
      answeredRef.current,
    );
    prevPendingRef.current = nextPending;
    answeredRef.current = new Set(signals.answered);
    for (const [requestId, live] of signals.currency) {
      currencyListenerRef.current?.(requestId, live);
    }
    for (const decision of signals.decisions) {
      decisionListenerRef.current?.(decision);
    }
    // Keyed on both the content signature and sessionId: an unchanged pending
    // set within one session does not re-run the derivation, while a session
    // switch (which resets prevPendingRef) always seeds the new session's
    // pending set even if both sessions happen to share a signature.
  }, [pendingSignature, sessionId]);

  return {
    controller: controllerRef.current.controller,
    onPromptSettled,
  };
}

/**
 * Binds caller-owned daemon session state (already read from
 * `DaemonSessionProvider` / `daemon-react-sdk` and frame-throttled transcript
 * hooks) to {@link SessionChatController} without re-projecting messages or
 * requiring a second context subscription stack.
 */
export function useDaemonChatControllerFromState(
  options: DaemonChatControllerFromStateOptions,
): SessionChatController {
  const { controller, onPromptSettled } = useDaemonChatControllerCore(options);
  useOptionalDaemonPromptSettled(onPromptSettled);
  return controller;
}

/**
 * Binds the daemon session provider to the backend-neutral chat controller
 * (slice 2d). It constructs {@link createDaemonChatController} once per session
 * and feeds it live provider facts, wiring the intent transports to the session
 * actions and deriving the two evidence channels the provider does not expose
 * explicitly: prompt settlement comes from the terminal-event subscription, and
 * approval currency / decision settlement are derived from the pending-permission
 * set (see {@link derivePermissionSignals}).
 *
 * The optional capability-gated sub-controllers (model / approval-mode / context
 * usage / session ops) are not bound yet; their regions stay hidden until a later
 * increment wires them, so this binding is additive and renders nothing on its own.
 */
export function useDaemonChatController(): SessionChatController {
  const { t } = useI18n();
  const connection = useDaemonConnection();
  const actions = useDaemonActions();
  const blocks = useDaemonTranscriptBlocks();
  const pendingPermissions = useDaemonPendingPermissions();
  const transcriptHistory = useDaemonTranscriptHistory();
  const messages = useMessagesFromBlocks(t, blocks);

  const pendingSplitRef = useRef<{
    signature: string;
    pendingApprovals: readonly PendingApproval[];
    pendingQuestions: readonly PendingQuestion[];
  } | null>(null);
  // Questions are permission blocks too; split them from tool approvals the same
  // way the existing UI does, so a question is answered with answers rather than
  // routed through the approval lane as a bare vote. The provider re-runs its
  // uncached pending selector on every streaming delta, so `pendingPermissions`
  // arrives as a fresh array even when the pending content is unchanged. Key the
  // split on a content signature (request id + question/approval classification
  // + a cheap payload revision) cached in a ref, so the array identities — and
  // the derivation effect below — stay stable across those deltas. The signature
  // is content-derived, not id-derived: a re-emitted request under the same id
  // can change its classification or its title/options, and the revision term
  // (updatedAt + title + option ids) forces a re-extraction so the cached
  // render-ready request never goes stale. Classification and the revision use
  // cheap block-level reads rather than the full payload extraction, so a delta
  // does not re-serialize each payload.
  const classifiedPending = pendingPermissions.map((permission) => ({
    block: permission,
    id: permission.requestId,
    isQuestion: isAskUserPermissionBlock(permission),
  }));
  const pendingSignature = classifiedPending
    .map(
      ({ block, id, isQuestion }) =>
        `${id}:${isQuestion ? 'q' : 'a'}:${pendingPermissionRevision(block)}`,
    )
    .join('|');
  let pendingSplit = pendingSplitRef.current;
  if (!pendingSplit || pendingSplit.signature !== pendingSignature) {
    const approvals: PendingApproval[] = [];
    const questions: PendingQuestion[] = [];
    for (const { block, id, isQuestion } of classifiedPending) {
      // The render-ready request is extracted only on a content change (the
      // signature cache), not per streaming delta. Pending blocks are unresolved
      // by the selector, so the extraction yields a request.
      const request = extractPendingPermission([block]);
      if (!request) continue;
      if (isQuestion) questions.push({ id, request });
      else approvals.push({ id, status: 'pending', request });
    }
    pendingSplit = {
      signature: pendingSignature,
      pendingApprovals: approvals,
      pendingQuestions: questions,
    };
    pendingSplitRef.current = pendingSplit;
  }
  const { pendingApprovals, pendingQuestions } = pendingSplit;

  const { controller, onPromptSettled } = useDaemonChatControllerCore({
    connection,
    actions,
    transcriptHistory,
    messages,
    pendingApprovals,
    pendingQuestions,
    pendingSignature,
  });
  useDaemonPromptSettled(onPromptSettled);
  return controller;
}
