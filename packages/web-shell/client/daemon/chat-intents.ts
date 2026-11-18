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

interface TrackedIntent {
  readonly operation: ChatOperation;
  readonly admission: Admission;
}

export interface DaemonChatIntents {
  /** In-flight and recently settled intents, bounded by the contract retention. */
  readonly operations: readonly ChatOperation[];
  /** `cancelling` is derived from an unestablished cancel operation. */
  phase(settled: 'idle' | 'failed'): ChatPhase;
  /**
   * Dispatch an intent's transport and report admission. The outcome is
   * `unsettled` until authoritative evidence arrives via {@link settle}; a
   * resolved transport alone never produces `established`.
   */
  dispatch(
    kind: IntentKind,
    target: IntentTarget,
    transport: IntentTransport,
  ): Promise<IntentResult>;
  /**
   * Apply authoritative outcome evidence to the matching in-flight intent.
   * For approvals the decision establishes only while it still applies to the
   * current request; a superseded request never establishes.
   */
  settle(
    kind: IntentKind,
    target: IntentTarget,
    witness: OutcomeWitness,
  ): IntentResult | undefined;
  /** Track which approval request is still current (supersede detection). */
  setCurrentApprovalRequest(requestId: string | undefined): void;
  readonly currentApprovalRequestId: string | undefined;
}

function sameTarget(a: IntentTarget, b: IntentTarget): boolean {
  return (
    a.sessionId === b.sessionId &&
    (a.turnId ?? null) === (b.turnId ?? null) &&
    (a.attemptId ?? null) === (b.attemptId ?? null) &&
    (a.requestId ?? null) === (b.requestId ?? null)
  );
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

/**
 * The daemon adapter's intent lifecycle core. It keeps admission (transport)
 * and outcome (evidence) separate so the shared contract's
 * admission-is-not-establishment invariant holds for daemon chat intents.
 */
export function createDaemonChatIntents(): DaemonChatIntents {
  let tracked: TrackedIntent[] = [];
  let currentApprovalRequestId: string | undefined;
  let nextId = 0;

  const operations = (): ChatOperation[] =>
    retainOperations(tracked.map((intent) => intent.operation));

  const replace = (id: string, operation: ChatOperation): void => {
    tracked = tracked.map((intent) =>
      intent.operation.id === id ? { ...intent, operation } : intent,
    );
  };

  return {
    get operations() {
      return operations();
    },
    get currentApprovalRequestId() {
      return currentApprovalRequestId;
    },
    setCurrentApprovalRequest(requestId) {
      currentApprovalRequestId = requestId;
    },
    phase(settled) {
      return deriveChatPhase(operations(), settled);
    },
    async dispatch(kind, target, transport) {
      let admission: Admission;
      try {
        admission = await transport();
      } catch {
        admission = 'unknown';
      }
      if (admission === 'rejected') {
        // Rejected requests carry no outcome and are not tracked.
        return resolveIntent('rejected', 'none', target);
      }
      // Transport acceptance is admission only; no outcome evidence exists at
      // dispatch, so the witness is 'none' and the outcome stays unsettled.
      const result = resolveIntent(admission, 'none', target);
      const operation: ChatOperation = {
        id: `daemon-intent-${++nextId}`,
        kind,
        state: stateFor(kind, result.outcome),
        target,
      };
      tracked = [...tracked, { operation, admission }];
      const keep = new Set(operations().map((op) => op.id));
      tracked = tracked.filter((intent) => keep.has(intent.operation.id));
      return result;
    },
    settle(kind, target, witness) {
      const intent = tracked.find(
        (candidate) =>
          candidate.operation.kind === kind &&
          sameTarget(candidate.operation.target, target) &&
          candidate.operation.state !== 'established' &&
          candidate.operation.state !== 'failed',
      );
      if (!intent) return undefined;
      // A superseded approval never establishes: the decision must apply to
      // the still-current request, not merely to the request it was sent for.
      const effectiveWitness =
        kind === 'approval' &&
        target.requestId !== undefined &&
        target.requestId !== currentApprovalRequestId
          ? 'none'
          : witness;
      const result = resolveIntent(intent.admission, effectiveWitness, target);
      replace(intent.operation.id, {
        ...intent.operation,
        state: stateFor(kind, result.outcome),
      });
      return result;
    },
  };
}
