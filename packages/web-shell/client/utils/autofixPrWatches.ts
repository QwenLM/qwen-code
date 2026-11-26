/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonAutofixPrWatch } from '../daemon/workspace/types';

/** What the prompt of a watch's scheduled task names (`qwen autofix-pr
 * schedule` writes `Run /autofix-pr tick <owner>/<repo>#<n> [--task <id>]…`). */
export interface AutofixPrTick {
  /** `<owner>/<repo>`. */
  repo: string;
  pr: number;
  task?: string;
}

const TICK_RE =
  /^Run \/autofix-pr tick ([\w.-]+\/[\w.-]+)#([1-9]\d{0,9})(?: --task ([0-9a-f]{12}))?(?=\s|$)/;

export function parseAutofixPrTick(prompt: string): AutofixPrTick | null {
  const match = TICK_RE.exec(prompt);
  if (!match) return null;
  const pr = Number(match[2]);
  if (!Number.isSafeInteger(pr)) return null;
  return {
    repo: match[1]!,
    pr,
    ...(match[3] ? { task: match[3] } : {}),
  };
}

/**
 * The watch a scheduled task drives, among the watches of its workspace's
 * clone. `stale` as the task's gate judges it: the watch ended, records no
 * task where the task has an id, or records another task — one a later
 * `schedule` replaced. Such a task stops at its next fire.
 */
export function watchOfTask(
  prompt: string,
  watches: readonly DaemonAutofixPrWatch[] | undefined,
): { watch: DaemonAutofixPrWatch; stale: boolean } | null {
  const tick = parseAutofixPrTick(prompt);
  if (!tick || !watches) return null;
  const watch = watches.find(
    (candidate) =>
      candidate.pr === tick.pr &&
      candidate.repo.toLowerCase() === tick.repo.toLowerCase(),
  );
  if (!watch) return null;
  const recorded = watch.watch?.task;
  return {
    watch,
    stale:
      watch.ended !== null ||
      (tick.task !== undefined && watch.watch === null) ||
      // A task with no id predates task ids: once one is recorded, it is
      // not the one recorded either.
      (recorded !== undefined && recorded !== tick.task),
  };
}

/** Where a watch is, the first that holds in this order. */
export type AutofixPrWatchPhase =
  /** The gate saw the PR merged or closed: only a cleanup is left. */
  | 'merged'
  | 'closed'
  /** A `cleanup` that kept the worktree ended it. */
  | 'ended'
  /** No task drives it: a `--once` check's state, or a watch whose
   * scheduling did not finish. */
  | 'unscheduled'
  /** A fix agent works in the background, or its round has yet to claim it. */
  | 'fixing'
  /** A background fix its session left behind: the next round redoes it. */
  | 'abandonedFix'
  /** Its gate checked the PR within two intervals. */
  | 'watching'
  /** No check that recent: its session is gone or not running its task. */
  | 'idle';

export function watchPhase(watch: DaemonAutofixPrWatch): AutofixPrWatchPhase {
  if (watch.stopped) return watch.stopped;
  if (watch.ended) return 'ended';
  if (!watch.watch) return 'unscheduled';
  if (watch.fix?.fresh) return 'fixing';
  if (watch.fix) return 'abandonedFix';
  return watch.checkedRecently ? 'watching' : 'idle';
}

/** What stops a watch in the session that owns it, as a user types it. */
export function stopCommand(watch: DaemonAutofixPrWatch): string {
  return `/autofix-pr stop ${watch.pr}`;
}
