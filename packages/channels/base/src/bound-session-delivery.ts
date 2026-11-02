/**
 * Delivery failures for prompts injected into PR-bound sessions the channel
 * does not own. The two cases drive different adapter behavior: a gone
 * session falls back to the normal channel path, a full queue retries on a
 * later poll.
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
