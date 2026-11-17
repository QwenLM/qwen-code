import type {
  Admission,
  ChatOperation,
  ChatPhase,
  IntentResult,
  IntentTarget,
  OperationState,
} from './contract.js';

export type OutcomeWitness = 'settled' | 'failed' | 'none';

// Admission is not establishment: a transport-level acceptance (witness
// 'none') never produces 'established', and 'established'/'failed' require
// an accepted admission. An unknown admission stays unsettled until
// reconciliation upgrades it.
export function resolveOutcome(
  admission: Admission,
  witness: OutcomeWitness,
): IntentResult['outcome'] {
  if (admission === 'rejected') return undefined;
  if (witness === 'none') return 'unsettled';
  if (admission !== 'accepted') return 'unsettled';
  return witness === 'settled' ? 'established' : 'failed';
}

export function resolveIntent(
  admission: Admission,
  witness: OutcomeWitness,
  target: IntentTarget,
): IntentResult {
  return { admission, outcome: resolveOutcome(admission, witness), target };
}

const TERMINAL_STATES: readonly OperationState[] = ['established', 'failed'];

export function isTerminalOperation(state: OperationState): boolean {
  return TERMINAL_STATES.includes(state);
}

function targetKey(target: IntentTarget): string {
  return JSON.stringify([
    target.sessionId,
    target.turnId ?? null,
    target.attemptId ?? null,
    target.requestId ?? null,
  ]);
}

// Keeps every non-terminal entry (unsettled included, so it survives a
// refresh) plus at most the latest terminal entry per kind and target.
export function retainOperations(
  operations: readonly ChatOperation[],
): ChatOperation[] {
  const active: ChatOperation[] = [];
  const latestTerminal = new Map<string, ChatOperation>();
  for (const operation of operations) {
    if (isTerminalOperation(operation.state)) {
      latestTerminal.set(
        `${operation.kind}|${targetKey(operation.target)}`,
        operation,
      );
    } else {
      active.push(operation);
    }
  }
  return [...active, ...latestTerminal.values()];
}

export function acknowledgeOperation(
  operations: readonly ChatOperation[],
  operationId: string,
): ChatOperation[] {
  return operations.filter(
    (operation) =>
      operation.id !== operationId || !isTerminalOperation(operation.state),
  );
}

export function deriveChatPhase(
  operations: readonly ChatOperation[],
  settled: 'idle' | 'failed',
): ChatPhase {
  const active = operations.filter(
    (operation) => !isTerminalOperation(operation.state),
  );
  if (active.some((operation) => operation.kind === 'cancel')) {
    return 'cancelling';
  }
  const submits = active.filter((operation) => operation.kind === 'submit');
  if (
    submits.some(
      (operation) =>
        operation.state === 'running' || operation.state === 'unsettled',
    )
  ) {
    return 'running';
  }
  if (submits.length > 0) return 'submitting';
  return settled;
}
