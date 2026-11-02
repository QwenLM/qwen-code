/**
 * Delivery failures for prompts injected into PR-bound sessions the channel
 * does not own. The cases drive different adapter behavior: a gone session
 * falls back to the normal channel path; a full queue or a temporarily
 * unavailable session/workspace is backpressure that defers the event
 * without consuming the failure budget.
 */

export class BoundSessionGoneError extends Error {
  constructor(readonly sessionId: string) {
    super(`Bound session ${sessionId} no longer exists`);
    this.name = 'BoundSessionGoneError';
  }
}

export class BoundSessionQueueFullError extends Error {
  constructor(readonly sessionId: string) {
    super(`Prompt queue of bound session ${sessionId} is full`);
    this.name = 'BoundSessionQueueFullError';
  }
}

/**
 * The session or its owning workspace is temporarily unavailable (workspace
 * draining/restarting, session limit reached, restore in progress). Like a
 * full queue this is retry-later backpressure, not a delivery failure: the
 * daemon even sends Retry-After for it. Burning the attempt budget on these
 * steady-state conditions would silently lose the event after three polls.
 */
export class BoundSessionUnavailableError extends Error {
  constructor(
    readonly sessionId: string,
    detail?: string,
  ) {
    super(
      `Bound session ${sessionId} is temporarily unavailable${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'BoundSessionUnavailableError';
  }
}
