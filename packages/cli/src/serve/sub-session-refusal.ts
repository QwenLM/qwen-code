/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tells a refusal raised BEFORE a sub-session existed apart from a failure
 * raised after one may already have run.
 *
 * The clean-review handoff records its dedupe key ahead of the spawn, so a
 * daemon that dies in between never replays a round that may have published a
 * comment. That trade is only justified while the spawn might have happened.
 * A pre-spawn refusal — a concurrency cap, a bridge that is not up, a daemon
 * shutting down — proves nothing was spawned and nothing was published, so the
 * record can be undone and the handoff retried. Without the distinction, a
 * transient cap silently burns the head: the ledger claims a verification that
 * never ran, and every later handoff for it is declined as already-verified.
 *
 * Kept in its own module so a consumer can classify the error without importing
 * the launcher and its dependency chain.
 */

const PRE_SPAWN_REFUSAL = Symbol('subSessionPreSpawnRefusal');

/** An error that proves no session was created and no prompt was dispatched. */
export function preSpawnRefusal(message: string): Error {
  return Object.assign(new Error(message), { [PRE_SPAWN_REFUSAL]: true });
}

/**
 * Mark an error someone else raised — the bridge's `SessionNotFoundError`, for
 * instance — without replacing it, so callers that match on its type still do.
 */
export function markPreSpawnRefusal<T>(error: T): T {
  if (typeof error === 'object' && error !== null) {
    Object.assign(error, { [PRE_SPAWN_REFUSAL]: true });
  }
  return error;
}

export function isPreSpawnRefusal(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { [PRE_SPAWN_REFUSAL]?: unknown })[PRE_SPAWN_REFUSAL] === true
  );
}
