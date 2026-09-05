/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Typed errors for the Channel worktree ownership-transfer protocol
 * (Part 4B): the reset route and the restore route's superseded / marker
 * classifications. Each maps to a bounded 409 body in `sendBridgeError` —
 * no paths, no stack traces, only the session ids a caller needs to
 * redirect or retry.
 */

/** Restore of a session whose worktree ownership moved to a replacement. */
export class WorktreeSessionSupersededError extends Error {
  readonly sessionId: string;
  readonly replacementSessionId: string;
  constructor(sessionId: string, replacementSessionId: string) {
    super(
      `Session ${sessionId} was superseded by a worktree reset; restore the replacement session instead`,
    );
    this.name = 'WorktreeSessionSupersededError';
    this.sessionId = sessionId;
    this.replacementSessionId = replacementSessionId;
  }
}

/**
 * Channel restore reached the ownership check and the marker is absent.
 * Distinct from corruption: the checkout may have been cleaned, and the
 * caller can retry the restore or reset the task.
 */
export class WorktreeMarkerMissingError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(
      `Worktree ownership marker for session ${sessionId} is missing; retry the restore or reset the task`,
    );
    this.name = 'WorktreeMarkerMissingError';
    this.sessionId = sessionId;
  }
}

/**
 * A worktree reset crashed mid-transfer; the sidecar pair and marker
 * describe an unfinished handoff. Retrying the reset is the repair for the
 * pre-commit shapes; the post-commit shape resumes as a no-op.
 */
export class WorktreeResetInterruptedError extends Error {
  readonly sessionId: string;
  readonly replacementSessionId?: string;
  constructor(sessionId: string, replacementSessionId?: string) {
    super(
      'A previous worktree reset was interrupted; retry the reset to finish or roll it back',
    );
    this.name = 'WorktreeResetInterruptedError';
    this.sessionId = sessionId;
    this.replacementSessionId = replacementSessionId;
  }
}

/** Reset refused because a session involved in the transfer is busy. */
export class WorktreeResetActiveError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(
      `Session ${sessionId} has a prompt in progress; wait for it to finish before resetting`,
    );
    this.name = 'WorktreeResetActiveError';
    this.sessionId = sessionId;
  }
}

/** Reset target is not a persisted worktree session. */
export class WorktreeResetUnsupportedError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`Session ${sessionId} is not a worktree session`);
    this.name = 'WorktreeResetUnsupportedError';
    this.sessionId = sessionId;
  }
}

/**
 * Reset refused on stale, foreign, tampered, containment-failing, or
 * ambiguous ownership state. Always non-destructive: the route rolls any
 * partial transfer back before this reaches the caller. The message is
 * deliberately generic — the specific reason goes to the daemon log, never
 * to the wire (no paths, no underlying I/O error text).
 */
export class WorktreeResetInvalidStateError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(
      `Session ${sessionId}'s worktree ownership state is invalid; the reset made no destructive change`,
    );
    this.name = 'WorktreeResetInvalidStateError';
    this.sessionId = sessionId;
  }
}
