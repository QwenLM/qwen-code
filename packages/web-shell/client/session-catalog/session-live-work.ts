import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';

/**
 * Whether closing this session would end work it is still doing.
 *
 * Archive and delete both tear the live session down, so background tasks
 * count alongside a turn: a row that advertises background work must not also
 * offer the action that kills it. Every surface that gates such an action
 * reads this one predicate, so the sidebar row, its menus and the delete
 * dialog cannot disagree about what "still working" means.
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
