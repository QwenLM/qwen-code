import type { Message } from '../adapters/types.js';
import type {
  Admission,
  ApprovalSelectionController,
  ChatCapabilities,
  ChatOperation,
  ChatPhase,
  ChatStatusFacts,
  ComposerSubmit,
  ContextUsageController,
  IntentKind,
  IntentResult,
  IntentTarget,
  ModelSelectionController,
  PendingApproval,
  PendingQuestion,
  QuestionAnswer,
  SessionChatController,
  SessionOpsController,
} from '../chat-core/contract.js';
import {
  isTerminalOperation,
  type OutcomeWitness,
} from '../chat-core/intent.js';
import {
  createDaemonChatIntents,
  type DaemonChatIntents,
} from './chat-intents.js';

/**
 * A terminal prompt event from the daemon, reduced to the prompt it settles
 * and whether that turn completed, was cancelled, or failed. The adapter binds
 * it to the dispatched attempt by `promptId`, never by the visible
 * session/turn target.
 */
export interface DaemonPromptSettlement {
  readonly promptId: string;
  readonly outcome: 'completed' | 'cancelled' | 'failed';
}

/**
 * Evidence that an approval/question decision was applied to the request it
 * names. `applied` is false when the decision could not be applied; the
 * adapter still terminalizes the attempt but never certifies it. The daemon
 * decision event names only the request (no attempt/option discriminator), so
 * correlation is request-level: the request's single active attempt.
 */
export interface DaemonDecisionSettlement {
  readonly requestId: string;
  readonly applied: boolean;
}

/**
 * The provider facts and actions the controller assembles. Everything is
 * injected so the assembly is testable without mounting the session provider;
 * the binding hook backs the fact fields with live provider state. Fact fields
 * are read on each access, so a deps object with getter-backed fields stays
 * current across renders.
 */
export interface DaemonChatControllerDeps {
  readonly sessionId: string;
  readonly storageKey: string;

  // Pass-through transcript facts.
  readonly messages: readonly Message[];
  readonly transcriptState: 'loading' | 'ready' | 'error';
  readonly hasOlderHistory?: boolean;
  readonly loadingOlderHistory?: boolean;
  readonly historyCapacityReached?: boolean;
  readonly historyPaginationError?: boolean;
  loadOlder?(options?: { force?: boolean }): Promise<void>;

  // Pass-through status and capability facts.
  readonly statusFacts: ChatStatusFacts;
  readonly capabilities: ChatCapabilities;

  // Capability-gated sub-controllers assembled from the provider's existing
  // hooks; absent when the backend lacks support.
  readonly modelSelection?: ModelSelectionController;
  readonly approvalSelection?: ApprovalSelectionController;
  readonly contextUsage?: ContextUsageController;
  readonly sessionOps?: SessionOpsController;

  // Normalized pending items.
  readonly pendingApprovals: readonly PendingApproval[];
  readonly pendingQuestions: readonly PendingQuestion[];

  // Intent transports. Each resolves to an admission only; the resolution is
  // never evidence that the effect is established. `submitPrompt` reports the
  // daemon's prompt id at admission so settlement evidence can be bound to the
  // dispatched attempt.
  submitPrompt(
    input: ComposerSubmit,
    onAdmitted: (promptId: string) => void,
  ): Promise<Admission>;
  cancelPrompt(): Promise<Admission>;
  submitPermission(requestId: string, optionId: string): Promise<Admission>;
  submitQuestionAnswers(
    requestId: string,
    answers: readonly QuestionAnswer[],
  ): Promise<Admission>;

  // Authoritative outcome evidence.
  subscribePromptSettlement(
    listener: (event: DaemonPromptSettlement) => void,
  ): () => void;
  subscribeDecisionSettlement(
    listener: (event: DaemonDecisionSettlement) => void,
  ): () => void;
  // Currency of approval requests: live when a request arrives, not-live only
  // when it is superseded or cancelled — never merely because it was answered.
  // The subscription must replay the current live set to a new listener at
  // subscribe time; alternatively (or additionally) the binding hook seeds the
  // requests already live at construction via liveApprovalRequestIds, so a
  // request that arrived before the controller mounted is not read as
  // superseded. Seed ids are the live (not-superseded) requests, not merely the
  // members of pendingApprovals (superseded approvals stay listed until
  // confirmed).
  subscribeApprovalCurrency(
    listener: (requestId: string, live: boolean) => void,
  ): () => void;
  readonly liveApprovalRequestIds?: readonly string[];

  // The phase to report when no operation holds it open. The binding hook
  // populates it from the session's settled state (e.g. a failed session).
  readonly settledPhase?: 'idle' | 'failed';

  // When aborted, the evidence subscriptions are released. The binding hook
  // ties this to the controller's mounted lifetime.
  readonly signal?: AbortSignal;
}

// A turn's terminal outcome projects differently per bound operation kind: a
// cancel is established only by a 'cancelled' turn (a turn that completed on
// its own proves the cancel did not take effect), while a submit is settled by
// any terminal outcome and failed only by a failed turn.
function witnessForKind(
  kind: IntentKind,
  outcome: DaemonPromptSettlement['outcome'],
): OutcomeWitness {
  if (kind === 'cancel') return outcome === 'cancelled' ? 'settled' : 'failed';
  return outcome === 'failed' ? 'failed' : 'settled';
}

/**
 * The daemon adapter's controller assembly (slice 2c). It wraps the injected
 * provider facts and actions into the backend-neutral {@link
 * SessionChatController}, wiring the slice-2b intent engine so admission stays
 * separate from establishment. Its new logic is the correlation between a
 * dispatched attempt and the backend identity its evidence names: settlement
 * elevates only the attempt bound to the event's `promptId`/`requestId`, so a
 * late event for a finished attempt cannot establish a retry on the same
 * visible target. Transcript and sub-controller facts are passed through from
 * the provider, not re-derived here.
 */
export function createDaemonChatController(
  deps: DaemonChatControllerDeps,
): SessionChatController {
  const intents: DaemonChatIntents = createDaemonChatIntents();

  // promptId -> the attempts it settles. A turn's terminal event closes both
  // the submit that started it and any cancel that targeted it.
  const operationsByPromptId = new Map<string, Set<string>>();
  // A prompt has exactly one terminal event; retain its raw outcome so an
  // attempt bound after the event arrived still settles, projected per kind.
  const terminalPromptOutcome = new Map<
    string,
    DaemonPromptSettlement['outcome']
  >();
  // The live turns in admission order (the daemon's FIFO). A cancel targets the
  // head — the active prompt — never the newest admitted id. A prompt leaves
  // the queue when its terminal event arrives or its submit is rejected.
  const livePromptQueue: string[] = [];
  // Submit dispatches that have not bound or resolved yet; while any is
  // outstanding a terminal event may belong to it even though onAdmitted has
  // not run, so prompt witnesses are not pruned as orphans. Prompt ids are
  // daemon-unique per turn, so a retained orphan cannot match a later attempt.
  let pendingSubmitBinds = 0;
  // Refcount of cancels dispatched but not yet bound per prompt; the terminal
  // witness (and a rejected-prompt tombstone) must survive until the last one
  // binds. A Set would let the first resolver release it while another waits.
  const pendingCancelBinds = new Map<string, number>();
  // Prompts whose submit was rejected: no turn ran, so a cancel targeting one
  // takes the failed terminal exit instead of binding a never-settling row.
  const rejectedPromptIds = new Set<string>();
  // Decision requests dispatched but not yet resolved; a second dispatch while
  // one is live (bound or in flight) is refused.
  const inFlightRequestIds = new Set<string>();

  const cancelBindsPending = (promptId: string): boolean =>
    (pendingCancelBinds.get(promptId) ?? 0) > 0;

  const removeFromQueue = (promptId: string): void => {
    const index = livePromptQueue.indexOf(promptId);
    if (index !== -1) livePromptQueue.splice(index, 1);
  };

  const kindOfOperation = (operationId: string): IntentKind | undefined =>
    intents.operations.find((op) => op.id === operationId)?.kind;

  const hasLiveDecision = (requestId: string): boolean =>
    intents.operations.some(
      (op) =>
        (op.kind === 'approval' || op.kind === 'question') &&
        op.target.requestId === requestId &&
        !isTerminalOperation(op.state),
    );

  // A prompt's witness is still needed while a dispatch that will apply it is
  // outstanding, independent of whether its rows survive presentation retention.
  const promptWitnessNeeded = (promptId: string): boolean =>
    cancelBindsPending(promptId) || pendingSubmitBinds > 0;

  const pruneCorrelation = (): void => {
    const retained = new Set(intents.operations.map((op) => op.id));
    for (const [promptId, ids] of operationsByPromptId) {
      for (const id of ids) if (!retained.has(id)) ids.delete(id);
      if (ids.size === 0) operationsByPromptId.delete(promptId);
    }
    for (const promptId of terminalPromptOutcome.keys()) {
      if (
        !operationsByPromptId.has(promptId) &&
        !promptWitnessNeeded(promptId)
      ) {
        terminalPromptOutcome.delete(promptId);
      }
    }
    for (const promptId of rejectedPromptIds) {
      if (!cancelBindsPending(promptId)) rejectedPromptIds.delete(promptId);
    }
  };

  const bindPromptOperation = (
    promptId: string,
    operationId: string,
    kind: IntentKind,
  ): IntentResult | undefined => {
    let ids = operationsByPromptId.get(promptId);
    if (!ids) {
      ids = new Set();
      operationsByPromptId.set(promptId, ids);
    }
    ids.add(operationId);
    const outcome = terminalPromptOutcome.get(promptId);
    // Evidence that arrived while the POST was in flight is applied here, once
    // the attempt can be named; return its result so the intent reports the
    // outcome it actually reached, not the pre-evidence dispatch snapshot.
    const settled =
      outcome !== undefined
        ? intents.settle(operationId, witnessForKind(kind, outcome))
        : undefined;
    pruneCorrelation();
    return settled;
  };

  const unsubscribePromptSettlement = deps.subscribePromptSettlement(
    (event) => {
      terminalPromptOutcome.set(event.promptId, event.outcome);
      // The turn ended; it is no longer a live cancel target.
      removeFromQueue(event.promptId);
      const ids = operationsByPromptId.get(event.promptId);
      if (ids) {
        for (const operationId of ids) {
          const kind = kindOfOperation(operationId);
          if (kind) {
            intents.settle(operationId, witnessForKind(kind, event.outcome));
          }
        }
      }
      pruneCorrelation();
    },
  );

  const unsubscribeDecisionSettlement = deps.subscribeDecisionSettlement(
    (event) => {
      const witness: OutcomeWitness = event.applied ? 'settled' : 'failed';
      // The engine routes to the request's active attempt and freezes currency
      // now, even while that attempt's POST is in flight; no raw witness is
      // buffered here, so a rejected or retried dispatch cannot inherit it.
      intents.settleDecisionRequest(event.requestId, witness);
      pruneCorrelation();
    },
  );

  const unsubscribeApprovalCurrency = deps.subscribeApprovalCurrency(
    (requestId, live) => intents.setApprovalRequestLive(requestId, live),
  );

  // Seed requests already live at construction (e.g. a permission outstanding
  // across a reload), so they are not read as superseded before any currency
  // event is delivered.
  for (const requestId of deps.liveApprovalRequestIds ?? []) {
    intents.setApprovalRequestLive(requestId, true);
  }

  const releaseSubscriptions = (): void => {
    unsubscribePromptSettlement();
    unsubscribeDecisionSettlement();
    unsubscribeApprovalCurrency();
  };
  if (deps.signal?.aborted) {
    // An already-aborted signal never fires its abort listener (e.g. a
    // StrictMode mount after a memoised controller's cleanup ran), so release
    // synchronously instead of leaking the listeners for the provider's life.
    releaseSubscriptions();
  } else {
    deps.signal?.addEventListener('abort', releaseSubscriptions, {
      once: true,
    });
  }

  const target = (extra?: Partial<IntentTarget>): IntentTarget => ({
    sessionId: deps.sessionId,
    ...extra,
  });

  return {
    kind: 'daemon',
    get sessionId() {
      return deps.sessionId;
    },
    get storageKey() {
      return deps.storageKey;
    },
    get activeTurnId(): string | undefined {
      return livePromptQueue[0];
    },
    get operations(): readonly ChatOperation[] {
      return intents.operations;
    },
    get messages() {
      return deps.messages;
    },
    get transcriptState() {
      return deps.transcriptState;
    },
    get hasOlderHistory() {
      return deps.hasOlderHistory;
    },
    get loadingOlderHistory() {
      return deps.loadingOlderHistory;
    },
    get historyCapacityReached() {
      return deps.historyCapacityReached;
    },
    get historyPaginationError() {
      return deps.historyPaginationError;
    },
    loadOlder: deps.loadOlder?.bind(deps),
    get phase(): ChatPhase {
      return intents.phase(deps.settledPhase ?? 'idle');
    },
    get pendingApprovals() {
      return deps.pendingApprovals;
    },
    get pendingQuestions() {
      return deps.pendingQuestions;
    },
    get modelSelection() {
      return deps.modelSelection;
    },
    get approvalSelection() {
      return deps.approvalSelection;
    },
    get contextUsage() {
      return deps.contextUsage;
    },
    get sessionOps() {
      return deps.sessionOps;
    },
    get statusFacts() {
      return deps.statusFacts;
    },
    get capabilities() {
      return deps.capabilities;
    },
    async submit(input: ComposerSubmit): Promise<IntentResult> {
      pendingSubmitBinds++;
      let promptId: string | undefined;
      const { operationId, result } = await intents.dispatch(
        'submit',
        target(),
        () =>
          deps.submitPrompt(input, (id) => {
            promptId = id;
            // A terminal event already arrived: the turn is over, so it is not
            // a live cancel target.
            if (!terminalPromptOutcome.has(id)) livePromptQueue.push(id);
          }),
      );
      pendingSubmitBinds--;
      if (result.admission === 'rejected') {
        if (promptId !== undefined) {
          removeFromQueue(promptId);
          rejectedPromptIds.add(promptId);
          // A cancel already bound to this prompt can never settle: no turn
          // ran. Terminalize it so the phase does not latch.
          const ids = operationsByPromptId.get(promptId);
          if (ids) for (const id of ids) intents.settle(id, 'failed');
        }
        pruneCorrelation();
        return result;
      }
      if (result.admission !== 'accepted') {
        // A thrown transport leaves the client's admission unknown. If
        // onAdmitted already reported a prompt id the daemon confirmed the
        // turn, so keep it as a live cancel target and let its terminal event
        // settle any bound cancel; only the submit row (whose admission the
        // client cannot confirm) takes the abandon exit. A prompt never
        // admitted has nothing to keep.
        intents.abandon(operationId);
        pruneCorrelation();
        return result;
      }
      let settled: IntentResult | undefined;
      if (promptId !== undefined) {
        settled = bindPromptOperation(promptId, operationId, 'submit');
      }
      return settled ?? result;
    },
    async cancel(): Promise<IntentResult> {
      // Resolve the target at dispatch time: the active (FIFO-head) live turn.
      const cancelTarget = livePromptQueue[0];
      if (cancelTarget !== undefined) {
        pendingCancelBinds.set(
          cancelTarget,
          (pendingCancelBinds.get(cancelTarget) ?? 0) + 1,
        );
      }
      const { operationId, result } = await intents.dispatch(
        'cancel',
        target(),
        () => deps.cancelPrompt(),
      );
      let out: IntentResult;
      if (result.admission === 'rejected') {
        out = result;
      } else if (result.admission !== 'accepted') {
        intents.abandon(operationId);
        out = result;
      } else if (
        cancelTarget === undefined ||
        rejectedPromptIds.has(cancelTarget)
      ) {
        // No live turn to cancel (empty queue, or the target's submit was
        // rejected): terminalize so the phase does not latch.
        out = intents.settle(operationId, 'failed') ?? result;
      } else {
        out =
          bindPromptOperation(cancelTarget, operationId, 'cancel') ?? result;
      }
      if (cancelTarget !== undefined) {
        const remaining = (pendingCancelBinds.get(cancelTarget) ?? 1) - 1;
        if (remaining > 0) pendingCancelBinds.set(cancelTarget, remaining);
        else pendingCancelBinds.delete(cancelTarget);
      }
      pruneCorrelation();
      // Attach the dispatch-time cancel subject to the returned IntentResult so
      // callers can attribute a delayed stop failure to the turn it targeted
      // without expanding the per-session operation retention key.
      return cancelTarget !== undefined
        ? { ...out, target: { ...out.target, turnId: cancelTarget } }
        : out;
    },
    async respondApproval(id: string, optionId: string): Promise<IntentResult> {
      if (hasLiveDecision(id) || inFlightRequestIds.has(id)) {
        return { admission: 'rejected', target: target({ requestId: id }) };
      }
      inFlightRequestIds.add(id);
      const { operationId, result } = await intents.dispatch(
        'approval',
        target({ requestId: id }),
        () => deps.submitPermission(id, optionId),
      );
      inFlightRequestIds.delete(id);
      if (result.admission !== 'accepted') {
        intents.abandon(operationId);
        return result;
      }
      return result;
    },
    async respondQuestion(
      id: string,
      answers: readonly QuestionAnswer[],
    ): Promise<IntentResult> {
      if (hasLiveDecision(id) || inFlightRequestIds.has(id)) {
        return { admission: 'rejected', target: target({ requestId: id }) };
      }
      inFlightRequestIds.add(id);
      const { operationId, result } = await intents.dispatch(
        'question',
        target({ requestId: id }),
        () => deps.submitQuestionAnswers(id, answers),
      );
      inFlightRequestIds.delete(id);
      if (result.admission !== 'accepted') {
        intents.abandon(operationId);
        return result;
      }
      return result;
    },
  };
}
