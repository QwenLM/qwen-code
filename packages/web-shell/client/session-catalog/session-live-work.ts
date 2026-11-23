import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';

/**
 * Whether this session is known to be doing work that closing it would end.
 *
 * Archive and delete both tear the live session down, so background tasks
 * count alongside a turn: a row that advertises background work must not also
 * offer the action that kills it. The sidebar row and its menus, both sidebar
 * eligibility checks, the standalone archive handler, the recent rows, the
 * delete dialog, the Session Overview card actions and the Activity archive
 * confirmation all read this predicate, so they cannot disagree about what
 * "still working" means.
 *
 * Deliberately narrower than the side-task archive gate, which also fails
 * closed on the `unknown` and `unsupported` grades: this predicate answers
 * "is work known to be running", and an unreported grade is not knowledge of
 * work. Folding that rule in here would block archive and delete on every
 * session whose child has gone quiet — a different policy decision.
 *
 * `hasRunningBackgroundTasks` is cleared to undefined for any row missing from
 * live-state, so it is read as `=== true`. A `!== false` test would block the
 * action on every not-live row.
 */
export function hasLiveWork(session: DaemonSessionSummary): boolean {
  return (
    session.hasActivePrompt === true ||
    session.activeWorkState === 'active' ||
    session.hasRunningBackgroundTasks === true
  );
}

/**
 * Whether Delete must be refused for this session.
 *
 * Background work blocks any row: the delete route has no idle guard, so
 * confirming would kill work the row advertises. Other live work blocks only
 * the session this client is attached to, whose runtime the delete tears down
 * (#12619); a turn running in some other session stays deletable, which is the
 * policy the sidebar row already applies.
 *
 * `isCurrent` is supplied by the caller rather than derived here, because each
 * surface has its own notion of it: the sidebar compares workspace-qualified
 * identity and lets the recent/standalone adapters override it, while the
 * delete dialog compares session ids. Deriving it from an id here would
 * silently narrow the sidebar's comparison.
 */
export function sessionBlocksDelete(
  session: DaemonSessionSummary,
  isCurrent: boolean,
): boolean {
  return (
    session.hasRunningBackgroundTasks === true ||
    (isCurrent && hasLiveWork(session))
  );
}
