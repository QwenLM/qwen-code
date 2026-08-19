/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GoalSnapshotV2 } from '@qwen-code/sdk/daemon';

/** The slice of the daemon connection the Goal gate reads. */
export interface GoalGateConnection {
  sessionId?: string | undefined;
  goalState?: GoalSnapshotV2 | undefined;
}

/**
 * Whether a local action must be held back because a Goal owns the session.
 *
 * Fails CLOSED while `goalState` is still hydrating: the session load clears
 * `loadingTranscript` (making the composer writable) before its `goal()` fetch
 * resolves, so an unknown Goal state on a real session has to read as "a Goal
 * may be active". The daemon has no server-side prompt gate for an active Goal,
 * so a submit inside that window would bypass the Goal queue outright.
 *
 * Every Goal gate in the client goes through here — the composer submit path,
 * the local queue hold, and the manual/bound run guards — so none of them can
 * drift into failing open on its own.
 */
export function isGoalGateBlocked(connection: GoalGateConnection): boolean {
  return (
    connection.sessionId !== undefined &&
    (connection.goalState === undefined ||
      connection.goalState.goal?.status === 'active')
  );
}
