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
 * adapter still terminalizes the attempt but never certifies it.
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

function witnessForPromptOutcome(
  outcome: DaemonPromptSettlement['outcome'],
): OutcomeWitness {
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
  // A prompt has exactly one terminal event; retain it so an attempt bound
  // after the event arrived (a cancel dispatched while the turn was ending)
  // still settles. Prompts get a fresh id per turn, so retention cannot leak
  // one turn's verdict onto another.
  const terminalPromptWitness = new Map<string, OutcomeWitness>();
  // The live turns in admission order (the daemon's FIFO). A cancel targets the
  // head — the active prompt — never the newest admitted id, which may be a
  // queued prompt or a turn that already ended. A prompt leaves the queue when
  // its terminal event arrives or its submit is rejected.
  const livePromptQueue: string[] = [];
  // Identities this controller has dispatched but not yet bound (the POST is
  // in flight). They let prune keep an early terminal event for our own
  // attempt while dropping events for prompts/requests we never dispatched
  // (replayed history, another client's decision), which would otherwise
  // accumulate as orphan witnesses.
  const inFlightPromptIds = new Set<string>();
  const inFlightRequestIds = new Set<string>();
  // requestId -> the decision attempt it settles. A request has at most one
  // non-terminal decision attempt at a time (a second dispatch is refused), so
  // a single slot cannot orphan a live sibling.
  const operationByRequestId = new Map<string, string>();
  // A decision witness is retained only for the window between the event and
  // its attempt's bind, then consumed: requestId is stable across attempts, so
  // keeping it would let a retry inherit the previous attempt's verdict.
  const terminalDecisionWitness = new Map<string, OutcomeWitness>();

  const removeFromQueue = (promptId: string): void => {
    const index = livePromptQueue.indexOf(promptId);
    if (index !== -1) livePromptQueue.splice(index, 1);
  };

  // Correlation state is bounded by the engine's retention: once an attempt is
  // no longer among the retained operations (acknowledged or superseded), its
  // backend identity stops being tracked, so a long session does not grow the
  // maps without bound.
  const pruneCorrelation = (): void => {
    const retained = new Set(intents.operations.map((op) => op.id));
    for (const [promptId, ids] of operationsByPromptId) {
      for (const id of ids) if (!retained.has(id)) ids.delete(id);
      if (ids.size === 0) {
        operationsByPromptId.delete(promptId);
        terminalPromptWitness.delete(promptId);
      }
    }
    for (const [requestId, operationId] of operationByRequestId) {
      if (!retained.has(operationId)) {
        operationByRequestId.delete(requestId);
        terminalDecisionWitness.delete(requestId);
      }
    }
    // Drop orphan witnesses: terminal events for identities we never
    // dispatched and that are not an in-flight attempt awaiting its bind.
    for (const promptId of terminalPromptWitness.keys()) {
      if (
        !operationsByPromptId.has(promptId) &&
        !inFlightPromptIds.has(promptId)
      ) {
        terminalPromptWitness.delete(promptId);
      }
    }
    for (const requestId of terminalDecisionWitness.keys()) {
      if (
        !operationByRequestId.has(requestId) &&
        !inFlightRequestIds.has(requestId)
      ) {
        terminalDecisionWitness.delete(requestId);
      }
    }
  };

  const bindPromptOperation = (
    promptId: string,
    operationId: string,
  ): IntentResult | undefined => {
    let ids = operationsByPromptId.get(promptId);
    if (!ids) {
      ids = new Set();
      operationsByPromptId.set(promptId, ids);
    }
    ids.add(operationId);
    const terminal = terminalPromptWitness.get(promptId);
    // Evidence that arrived while the POST was in flight is applied here, once
    // the attempt can be named; return its result so the intent reports the
    // outcome it actually reached, not the pre-evidence dispatch snapshot.
    const settled =
      terminal !== undefined
        ? intents.settle(operationId, terminal)
        : undefined;
    pruneCorrelation();
    return settled;
  };

  const bindDecisionOperation = (
    requestId: string,
    operationId: string,
  ): IntentResult | undefined => {
    operationByRequestId.set(requestId, operationId);
    inFlightRequestIds.delete(requestId);
    const terminal = terminalDecisionWitness.get(requestId);
    let settled: IntentResult | undefined;
    if (terminal !== undefined) {
      settled = intents.settle(operationId, terminal);
      // Consume: a retry on the same request must earn its own evidence.
      terminalDecisionWitness.delete(requestId);
    }
    pruneCorrelation();
    return settled;
  };

  const unsubscribePromptSettlement = deps.subscribePromptSettlement(
    (event) => {
      const witness = witnessForPromptOutcome(event.outcome);
      terminalPromptWitness.set(event.promptId, witness);
      // The turn ended; it is no longer a live cancel target.
      removeFromQueue(event.promptId);
      const ids = operationsByPromptId.get(event.promptId);
      if (ids) {
        for (const operationId of ids) intents.settle(operationId, witness);
      }
      pruneCorrelation();
    },
  );

  const unsubscribeDecisionSettlement = deps.subscribeDecisionSettlement(
    (event) => {
      const witness: OutcomeWitness = event.applied ? 'settled' : 'failed';
      const operationId = operationByRequestId.get(event.requestId);
      if (operationId) {
        intents.settle(operationId, witness);
        // Applied to the bound attempt; do not leave it for a later retry.
        terminalDecisionWitness.delete(event.requestId);
      } else {
        // The attempt is still in flight; retain until its bind applies it.
        terminalDecisionWitness.set(event.requestId, witness);
      }
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

  // A second decision dispatch for a request that already has a non-terminal
  // attempt is refused: the decision event names the request, not the option,
  // so a sibling could never be settled distinctly and would leak a permanent
  // non-terminal row.
  const hasLiveDecision = (requestId: string): boolean => {
    const operationId = operationByRequestId.get(requestId);
    if (!operationId) return false;
    return intents.operations.some(
      (op) => op.id === operationId && !isTerminalOperation(op.state),
    );
  };

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
      let promptId: string | undefined;
      const { operationId, result } = await intents.dispatch(
        'submit',
        target(),
        () =>
          deps.submitPrompt(input, (id) => {
            promptId = id;
            livePromptQueue.push(id);
            inFlightPromptIds.add(id);
          }),
      );
      // A rejected submit never became a turn: do not bind it (its dropped id
      // would prune a retained witness) and drop it from the live queue.
      if (result.admission === 'rejected') {
        if (promptId !== undefined) {
          removeFromQueue(promptId);
          inFlightPromptIds.delete(promptId);
        }
        return result;
      }
      let settled: IntentResult | undefined;
      if (promptId !== undefined) {
        settled = bindPromptOperation(promptId, operationId);
        inFlightPromptIds.delete(promptId);
      }
      return settled ?? result;
    },
    async cancel(): Promise<IntentResult> {
      // Resolve the target at dispatch time: the active (FIFO-head) live turn,
      // never the newest admitted id. Captured before the transport so a turn
      // ending mid-cancel still binds the attempt the cancel was issued against.
      const cancelTarget = livePromptQueue[0];
      const { operationId, result } = await intents.dispatch(
        'cancel',
        target(),
        () => deps.cancelPrompt(),
      );
      if (result.admission === 'rejected') return result;
      if (cancelTarget === undefined) {
        // No live turn to cancel: terminalize so the phase does not latch.
        return intents.settle(operationId, 'failed') ?? result;
      }
      return bindPromptOperation(cancelTarget, operationId) ?? result;
    },
    async respondApproval(id: string, optionId: string): Promise<IntentResult> {
      if (hasLiveDecision(id)) {
        return { admission: 'rejected', target: target({ requestId: id }) };
      }
      inFlightRequestIds.add(id);
      const { operationId, result } = await intents.dispatch(
        'approval',
        target({ requestId: id }),
        () => deps.submitPermission(id, optionId),
      );
      if (result.admission === 'rejected') {
        inFlightRequestIds.delete(id);
        return result;
      }
      return bindDecisionOperation(id, operationId) ?? result;
    },
    async respondQuestion(
      id: string,
      answers: readonly QuestionAnswer[],
    ): Promise<IntentResult> {
      if (hasLiveDecision(id)) {
        return { admission: 'rejected', target: target({ requestId: id }) };
      }
      inFlightRequestIds.add(id);
      const { operationId, result } = await intents.dispatch(
        'question',
        target({ requestId: id }),
        () => deps.submitQuestionAnswers(id, answers),
      );
      if (result.admission === 'rejected') {
        inFlightRequestIds.delete(id);
        return result;
      }
      return bindDecisionOperation(id, operationId) ?? result;
    },
  };
}
