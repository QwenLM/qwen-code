/**
 * Next-session delivery of scheduled-run results. On interactive startup we
 * report the runs the daemon completed while the user was away (once each),
 * reusing the delivery cursor in core's run-delivery module.
 *
 * MUST only run for a real interactive session — a headless `qwen -p` run
 * (including the ones the daemon itself spawns) would otherwise consume the
 * cursor and steal the notice from the user's TUI.
 */

import * as fs from 'node:fs/promises';

import {
  Storage,
  collectUnsurfacedRuns,
  formatRunNotification,
  markRunsSurfaced,
} from '@qwen-code/qwen-code-core';

/**
 * Returns a one-element array with the "N scheduled runs completed" notice, or
 * an empty array when there is nothing new (or scheduling was never used).
 * Best-effort: never throws, so it can't block startup.
 */
export async function getScheduledRunsStartupNotice(): Promise<string[]> {
  // Skip entirely if scheduling was never used — don't create the store dir or
  // seed a cursor for users who have never run /schedule.
  try {
    await fs.access(Storage.getScheduledTasksDir());
  } catch {
    return [];
  }

  try {
    const runs = await collectUnsurfacedRuns();
    if (runs.length === 0) return [];
    const notice = formatRunNotification(runs);
    await markRunsSurfaced(Math.max(...runs.map((r) => r.finishedAt)));
    return notice ? [notice] : [];
  } catch {
    return [];
  }
}
