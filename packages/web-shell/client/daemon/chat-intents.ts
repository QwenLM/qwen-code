import type {
  Admission,
  ChatOperation,
  ChatPhase,
  IntentKind,
  IntentResult,
  IntentTarget,
  OperationState,
} from '../chat-core/contract.js';
import {
  acknowledgeOperation,
  deriveChatPhase,
  resolveIntent,
  retainOperations,
  type OutcomeWitness,
} from '../chat-core/intent.js';

/**
 * Transport dispatch for one intent. It resolves to an admission only; the
 * resolution of this promise is never evidence that the intended effect is
 * established. Outcome evidence arrives separately through {@link
 * DaemonChatIntents.settle}.
 */
export type IntentTransport = () => Promise<Admission>;

/**
 * One dispatched attempt and the identity that binds its settlement evidence.
 * The adapter must record the operation id next to the backend identity of the
 * request it just made, so an incoming event can name the attempt it belongs
 * to. Binding the id after the event arrives cannot authenticate it.
 */
export interface DaemonIntentDispatch {
  readonly operationId: string;
  readonly result: IntentResult;
}

interface TrackedIntent {
  operation: ChatOperation;
  admission: Admission;
}

export interface DaemonChatIntents {
  /**
   * In-flight and recently settled intents, bounded by the contract retention.
   * The snapshot identity is stable between state changes so it can back a
   * `useSyncExternalStore` cache.
   */
  readonly operations: readonly ChatOperation[];
  /** `cancelling` is derived from an unestablished cancel operation. */
  phase(settled: 'idle' | 'failed'): ChatPhase;
  /**
   * Dispatch an intent's transport and report admission. The attempt is
   * recorded as `pending` before the transport runs, so the row exists (and
   * evidence can bind to it) while the request is in flight, and rows stay in
   * dispatch order. The outcome is `unsettled` until authoritative evidence
   * arrives via {@link settle}; a resolved transport alone never produces
   * `established`.
   */
  dispatch(
    kind: IntentKind,
    target: IntentTarget,
    transport: IntentTransport,
  ): Promise<DaemonIntentDispatch>;
  /**
   * Apply authoritative outcome evidence to the attempt it belongs to. The
   * witness is bound to one dispatched operation, so a late witness for a
   * finished attempt cannot establish a later attempt that shares the same
   * visible target. Unknown or already-terminal operations are a no-op.
   * For approvals a *settled* decision establishes only while its request is
   * still live; a superseded or unidentified request never establishes, while
   * negative evidence still terminalizes the attempt.
   */
  settle(
    operationId: string,
    witness: OutcomeWitness,
  ): IntentResult | undefined;
  /**
   * Give an attempt whose admission can never be confirmed (a thrown transport
   * leaves it `unknown`) an exit: terminalize it as `failed`, never
   * `established`, so it stops holding the phase open. Already-terminal or
   * unknown operations are a no-op.
   */
  abandon(operationId: string): IntentResult | undefined;
  /**
   * Release a terminal row once the surface has consumed it. Non-terminal rows
   * are kept; terminal rows stay readable until acknowledged.
   */
  acknowledge(operationId: string): void;
  /**
   * Track whether an approval request is still awaiting a decision. The daemon
   * keeps several permission requests pending at once, so currency is a set,
   * not a single "newest" id; a decision applies while its request is live.
   */
  setApprovalRequestLive(requestId: string, live: boolean): void;
}

function stateFor(
  kind: IntentKind,
  outcome: IntentResult['outcome'],
): OperationState {
  if (outcome === 'established') return 'established';
  if (outcome === 'failed') return 'failed';
  // Admitted but no witness yet: a submit is a turn in flight, everything
  // else is awaiting settlement.
  return kind === 'submit' ? 'running' : 'unsettled';
}

function isTerminal(state: OperationState): boolean {
  return state === 'established' || state === 'failed';
}

/**
 * The daemon adapter's intent lifecycle core. It keeps admission (transport)
 * and outcome (evidence) separate so the shared contract's
 * admission-is-not-establishment invariant holds for daemon chat intents.
 */
export function createDaemonChatIntents(): DaemonChatIntents {
  let tracked: TrackedIntent[] = [];
  const liveApprovalRequests = new Set<string>();
  let snapshot: readonly ChatOperation[] = [];
  let nextId = 0;

  const rebuild = (): void => {
    snapshot = retainOperations(tracked.map((intent) => intent.operation));
  };
  const find = (operationId: string): TrackedIntent | undefined =>
    tracked.find((intent) => intent.operation.id === operationId);

  return {
    get operations() {
      return snapshot;
    },
    phase(settled) {
      return deriveChatPhase(snapshot, settled);
    },
    setApprovalRequestLive(requestId, live) {
      if (live) liveApprovalRequests.add(requestId);
      else liveApprovalRequests.delete(requestId);
    },
    async dispatch(kind, target, transport) {
      const operationId = `daemon-intent-${++nextId}`;
      // Record the attempt before the transport runs so the row exists while
      // the request is in flight and rows stay in dispatch order (retention
      // keeps the latest terminal row by position).
      const intent: TrackedIntent = {
        operation: { id: operationId, kind, state: 'pending', target },
        admission: 'unknown',
      };
      tracked = [...tracked, intent];
      rebuild();
      let admission: Admission;
      try {
        admission = await transport();
      } catch {
        admission = 'unknown';
      }
      if (admission === 'rejected') {
        // Rejected requests carry no outcome and are not tracked, so settling
        // this id is a no-op.
        tracked = tracked.filter((entry) => entry.operation.id !== operationId);
        rebuild();
        return {
          operationId,
          result: resolveIntent('rejected', 'none', target),
        };
      }
      // Transport acceptance is admission only; no outcome evidence exists at
      // dispatch, so the witness is 'none' and the outcome stays unsettled.
      intent.admission = admission;
      const result = resolveIntent(admission, 'none', target);
      intent.operation = {
        ...intent.operation,
        state: stateFor(kind, result.outcome),
      };
      rebuild();
      return { operationId, result };
    },
    settle(operationId, witness) {
      const intent = find(operationId);
      if (!intent) return undefined;
      const { kind, target, state } = intent.operation;
      if (isTerminal(state)) return undefined;
      // A superseded approval never establishes on positive evidence: the
      // decision must apply to a request that is still live. Negative evidence
      // is not rewritten, so a decision that genuinely failed terminalizes.
      const effectiveWitness =
        kind === 'approval' &&
        witness === 'settled' &&
        (target.requestId === undefined ||
          !liveApprovalRequests.has(target.requestId))
          ? 'none'
          : witness;
      const result = resolveIntent(intent.admission, effectiveWitness, target);
      intent.operation = {
        ...intent.operation,
        state: stateFor(kind, result.outcome),
      };
      rebuild();
      return result;
    },
    abandon(operationId) {
      const intent = find(operationId);
      if (!intent) return undefined;
      if (isTerminal(intent.operation.state)) return undefined;
      intent.operation = { ...intent.operation, state: 'failed' };
      rebuild();
      return resolveIntent(intent.admission, 'failed', intent.operation.target);
    },
    acknowledge(operationId) {
      const operations = tracked.map((intent) => intent.operation);
      const kept = acknowledgeOperation(operations, operationId);
      if (kept.length === operations.length) return;
      const keptIds = new Set(kept.map((operation) => operation.id));
      tracked = tracked.filter((intent) => keptIds.has(intent.operation.id));
      rebuild();
    },
  };
}
