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
 * Distinct from corruption: the checkout may have been cleaned. A restore
 * retry cannot repair it — no restore path writes a marker — so the caller
 * must reset the task, whose transfer recreates the marker. An absent marker
 * whose `supersedes`/`supersededBy` links agree classifies as
 * {@link WorktreeResetInterruptedError} instead, before this one.
 */
export class WorktreeMarkerMissingError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(
      `Worktree ownership marker for session ${sessionId} is missing; reset the task to recreate it`,
    );
    this.name = 'WorktreeMarkerMissingError';
    this.sessionId = sessionId;
  }
}

/**
 * A restore reached an unfinished handoff: the sidecar pair links the two
 * sessions but the checkout marker never moved onto the replacement. The
 * repair depends on which session the caller restored — retrying the reset
 * against the *superseded* session rolls the pre-commit shape back or
 * finishes it, while this shape, reported for the replacement, is not
 * repairable that way (the reset route resumes a committed transfer as a
 * no-op) and needs operator repair. Carries no replacement id: this is
 * thrown for the replacement, so the id it would name is already the
 * caller's own.
 */
export class WorktreeResetInterruptedError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(
      'A previous worktree reset was interrupted; retry the reset against the superseded session to finish or roll it back',
    );
    this.name = 'WorktreeResetInterruptedError';
    this.sessionId = sessionId;
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
 * ambiguous ownership state. Non-destructive for what this request started:
 * the route rolls a partial transfer this request began back before this
 * reaches the caller, while the resume path's fail-closed branches — an
 * invalid marker, an inconsistent supersede link pair, an ambiguous marker
 * owner — leave the pre-existing interrupted state untouched for operator
 * repair. The message is deliberately generic — the specific reason goes to
 * the daemon log, never to the wire (no paths, no underlying I/O error text).
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
