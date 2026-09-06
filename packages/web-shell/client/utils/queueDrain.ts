// Pure gate for the queued-prompt auto-drain, extracted from App's drain effect
// so the "may I drain the next prompt right now?" conditions are a named,
// tested contract. This covers the boolean gate only — the effect still owns
// the timing (arming the turn-start gate, the setTimeout submit). The race that
// gate guards against is inherently effect-level and is verified separately.

export interface QueueDrainGate {
  /** A drain is already in flight this tick. */
  draining: boolean;
  /** Waiting for the previously drained prompt's turn to start. */
  awaitingTurnStart: boolean;
  /** The daemon connection is live. */
  connected: boolean;
  /** A turn is in flight (streamingState !== 'idle'). */
  streaming: boolean;
  /** Some interaction (dialog, catch-up) is blocking input. */
  interactionBlocked: boolean;
  /** A tool approval is pending. */
  pendingApproval: boolean;
  /** Number of prompts currently queued. */
  queueLength: number;
}

/**
 * Whether the next queued prompt may be auto-drained into a new turn right now.
 * Every condition must hold; any one being unmet holds the queue.
 */
export function canDrainQueue(gate: QueueDrainGate): boolean {
  return (
    !gate.draining &&
    !gate.awaitingTurnStart &&
    gate.connected &&
    !gate.streaming &&
    !gate.interactionBlocked &&
    !gate.pendingApproval &&
    gate.queueLength > 0
  );
}
