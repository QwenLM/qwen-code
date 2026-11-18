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
  // Evidence that arrived while the transport was still in flight; applied
  // once admission resolves so a settlement emitted before the POST response
  // is not discarded.
  witness?: OutcomeWitness;
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
   * `established`, so it stops holding the phase open. Unknown ids,
   * already-terminal attempts, and attempts with a confirmed admission are a
   * no-op — a live accepted turn must keep its chance to settle.
   */
  abandon(operationId: string): IntentResult | undefined;
  /**
   * Release a terminal row once the surface has consumed it. Non-terminal rows
   * are kept; terminal rows stay readable until acknowledged.
   */
  acknowledge(operationId: string): void;
  /**
   * Track whether an approval request is still valid (not superseded). The
   * daemon keeps several permission requests pending at once, so currency is a
   * set, not a single "newest" id. Mark a request live when it arrives and
   * not-live only when it is superseded or cancelled — not when it is answered;
   * the engine releases the identity itself once the decision settles, so a
   * decision establishes while its request has not been superseded.
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
  const applyEvidence = (
    intent: TrackedIntent,
    witness: OutcomeWitness,
  ): IntentResult => {
    const { kind, target } = intent.operation;
    // A superseded approval never establishes on positive evidence: the
    // decision must apply to a request that is still live. Negative evidence
    // is not rewritten, so a decision that genuinely failed terminalizes.
    const effective =
      kind === 'approval' &&
      witness === 'settled' &&
      (target.requestId === undefined ||
        !liveApprovalRequests.has(target.requestId))
        ? 'none'
        : witness;
    const result = resolveIntent(intent.admission, effective, target);
    intent.operation = {
      ...intent.operation,
      state: stateFor(kind, result.outcome),
    };
    return result;
  };

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
      // Snapshot the target so a caller that keeps and mutates its object
      // cannot retarget the recorded attempt after dispatch.
      const recordedTarget = Object.freeze({ ...target });
      // Record the attempt before the transport runs so the row exists while
      // the request is in flight and rows stay in dispatch order (retention
      // keeps the latest terminal row by position).
      const intent: TrackedIntent = {
        operation: {
          id: operationId,
          kind,
          state: 'pending',
          target: recordedTarget,
        },
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
          result: resolveIntent('rejected', 'none', recordedTarget),
        };
      }
      // Transport acceptance is admission only. Apply any evidence that
      // arrived while the POST was in flight; otherwise the witness is 'none'
      // and the outcome stays unsettled until evidence arrives.
      intent.admission = admission;
      const result = applyEvidence(intent, intent.witness ?? 'none');
      rebuild();
      return { operationId, result };
    },
    settle(operationId, witness) {
      const intent = find(operationId);
      if (!intent) return undefined;
      if (isTerminal(intent.operation.state)) return undefined;
      // Retain the evidence so a settlement delivered while the transport is
      // still in flight is applied once admission resolves, not discarded.
      intent.witness = witness;
      const result = applyEvidence(intent, witness);
      // A settled approval is no longer pending: release its request identity
      // so the live set does not grow with every answered request.
      const { kind, target } = intent.operation;
      if (
        kind === 'approval' &&
        target.requestId !== undefined &&
        isTerminal(intent.operation.state)
      ) {
        liveApprovalRequests.delete(target.requestId);
      }
      rebuild();
      return result;
    },
    abandon(operationId) {
      const intent = find(operationId);
      if (!intent) return undefined;
      if (isTerminal(intent.operation.state)) return undefined;
      // Only an unconfirmable admission may be abandoned; an accepted attempt
      // is a live turn whose real evidence must still be able to land.
      if (intent.admission !== 'unknown') return undefined;
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
