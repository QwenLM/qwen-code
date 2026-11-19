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
 * adapter still terminalizes the attempt but never certifies it. `attemptId`
 * is an optional attempt discriminator: the daemon decision event names only
 * the request, so without it the correlation is request-level (the request's
 * single active attempt).
 */
export interface DaemonDecisionSettlement {
  readonly requestId: string;
  readonly applied: boolean;
  readonly attemptId?: string;
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
  loadOlder?(): Promise<void>;

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
  subscribeApprovalCurrency(
    listener: (requestId: string, live: boolean) => void,
  ): () => void;

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
  // Prompts admitted (onAdmitted) whose submit has not bound yet.
  const inFlightPromptIds = new Set<string>();
  // Submit dispatches that have not bound or resolved yet; while any is
  // outstanding a terminal event may belong to it even though onAdmitted has
  // not run, so prompt witnesses are not pruned as orphans.
  let pendingSubmitBinds = 0;
  // Prompts with a cancel dispatched but not yet bound; their terminal witness
  // must survive row-retention churn until the cancel bind applies it.
  const pendingCancelBinds = new Set<string>();
  // Prompts whose submit was rejected: no turn ran, so a cancel targeting one
  // takes the failed terminal exit instead of binding a never-settling row.
  const rejectedPromptIds = new Set<string>();
  // Decision requests dispatched but not yet resolved; a second dispatch while
  // one is live (bound or in flight) is refused.
  const inFlightRequestIds = new Set<string>();
  let decisionAttemptSeq = 0;

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
    inFlightPromptIds.has(promptId) ||
    pendingCancelBinds.has(promptId) ||
    pendingSubmitBinds > 0;

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
      if (!pendingCancelBinds.has(promptId)) rejectedPromptIds.delete(promptId);
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
      intents.settleDecisionRequest(event.requestId, witness, event.attemptId);
      pruneCorrelation();
    },
  );

  const unsubscribeApprovalCurrency = deps.subscribeApprovalCurrency(
    (requestId, live) => intents.setApprovalRequestLive(requestId, live),
  );

  deps.signal?.addEventListener(
    'abort',
    () => {
      unsubscribePromptSettlement();
      unsubscribeDecisionSettlement();
      unsubscribeApprovalCurrency();
    },
    { once: true },
  );

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
    get operations(): readonly ChatOperation[] {
      return intents.operations;
    },
    get messages() {
      return deps.messages;
    },
    get transcriptState() {
      return deps.transcriptState;
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
            inFlightPromptIds.add(id);
            // A terminal event already arrived: the turn is over, so it is not
            // a live cancel target.
            if (!terminalPromptOutcome.has(id)) livePromptQueue.push(id);
          }),
      );
      pendingSubmitBinds--;
      if (result.admission === 'rejected') {
        if (promptId !== undefined) {
          removeFromQueue(promptId);
          inFlightPromptIds.delete(promptId);
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
        // A thrown transport leaves admission unknown: give it the engine's
        // exit and drop the prompt so a later cancel does not target it.
        if (promptId !== undefined) {
          removeFromQueue(promptId);
          inFlightPromptIds.delete(promptId);
        }
        intents.abandon(operationId);
        pruneCorrelation();
        return result;
      }
      let settled: IntentResult | undefined;
      if (promptId !== undefined) {
        settled = bindPromptOperation(promptId, operationId, 'submit');
        inFlightPromptIds.delete(promptId);
      }
      return settled ?? result;
    },
    async cancel(): Promise<IntentResult> {
      // Resolve the target at dispatch time: the active (FIFO-head) live turn.
      const cancelTarget = livePromptQueue[0];
      if (cancelTarget !== undefined) pendingCancelBinds.add(cancelTarget);
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
      if (cancelTarget !== undefined) pendingCancelBinds.delete(cancelTarget);
      pruneCorrelation();
      return out;
    },
    async respondApproval(id: string, optionId: string): Promise<IntentResult> {
      if (hasLiveDecision(id) || inFlightRequestIds.has(id)) {
        return { admission: 'rejected', target: target({ requestId: id }) };
      }
      inFlightRequestIds.add(id);
      const attemptId = `decision-${++decisionAttemptSeq}`;
      const { operationId, result } = await intents.dispatch(
        'approval',
        target({ requestId: id, attemptId }),
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
      const attemptId = `decision-${++decisionAttemptSeq}`;
      const { operationId, result } = await intents.dispatch(
        'question',
        target({ requestId: id, attemptId }),
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
