/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Couples a scheduled task's lifecycle to its dedicated session.
 *
 * A task created through the Web Shell management page is bound to a session
 * (`task.sessionId`) and fires only inside it. So the session's archive/delete
 * state must drive the task:
 *  - archiving the session → disable the task (stop firing, keep it recoverable)
 *  - unarchiving the session → re-enable the task (resume from now)
 *  - deleting the session → remove the task
 *
 * These run from the shared session archive/delete choke points, so both the
 * REST and ACP surfaces are covered. Every function is best-effort and a no-op
 * when no task is bound to the given sessions (returning the input array
 * unchanged skips the write), so it's side-effect-free for ordinary sessions.
 */

import {
  updateCronTasks,
  type DurableCronTask,
} from '@qwen-code/qwen-code-core';

/**
 * Disables every ENABLED task bound to one of `sessionIds` (archived sessions),
 * marking it `disabledByArchive` so unarchive only re-enables tasks the archive
 * itself paused — a task the user deliberately disabled (already `enabled:false`,
 * no flag) is left untouched and stays disabled across the cycle.
 */
export async function disableTasksForSessions(
  projectRoot: string,
  sessionIds: string[],
): Promise<void> {
  if (sessionIds.length === 0) return;
  const targets = new Set(sessionIds);
  await updateCronTasks(projectRoot, (tasks) => {
    let changed = false;
    const next = tasks.map((task) => {
      if (
        task.sessionId !== undefined &&
        targets.has(task.sessionId) &&
        task.enabled !== false
      ) {
        changed = true;
        return { ...task, enabled: false, disabledByArchive: true };
      }
      return task;
    });
    return changed ? next : tasks;
  });
}

/**
 * Re-enables tasks bound to one of `sessionIds` (unarchived sessions) that were
 * disabled BY the archive (`disabledByArchive`) — NOT tasks the user disabled
 * themselves. Clears the flag and resets a recurring task's anchor to `now` so
 * it resumes from now rather than catching up fires it "missed" while archived.
 * (The bound session becomes live again on the next session load / daemon
 * rehydration; until then the re-enabled task simply won't fire.)
 */
export async function enableTasksForSessions(
  projectRoot: string,
  sessionIds: string[],
  now: number = Date.now(),
): Promise<void> {
  if (sessionIds.length === 0) return;
  const targets = new Set(sessionIds);
  await updateCronTasks(projectRoot, (tasks) => {
    let changed = false;
    const next = tasks.map((task) => {
      if (
        task.sessionId !== undefined &&
        targets.has(task.sessionId) &&
        task.enabled === false &&
        task.disabledByArchive === true
      ) {
        changed = true;
        const resumed: DurableCronTask = { ...task, enabled: true };
        delete resumed.disabledByArchive;
        const minute = now - (now % 60_000);
        if (resumed.recurring) {
          // Recurring anchor is lastFiredAt: resume from now, not catching up
          // fires missed while archived.
          resumed.lastFiredAt = minute;
        } else {
          // A one-shot anchors on createdAt: without re-seating it, the
          // scheduler reads the original long-past slot as a MISSED one-shot on
          // reload and fires + permanently deletes the task. (Reachable: archive
          // a task, PATCH it to recurring:false while disabled — the route
          // re-seat only touches recurring anchors — then unarchive.)
          resumed.createdAt = now;
          resumed.lastFiredAt = minute;
        }
        return resumed;
      }
      return task;
    });
    return changed ? next : tasks;
  });
}

/** Removes every task bound to one of `sessionIds` (deleted sessions). */
export async function removeTasksForSessions(
  projectRoot: string,
  sessionIds: string[],
): Promise<void> {
  if (sessionIds.length === 0) return;
  const targets = new Set(sessionIds);
  await updateCronTasks(projectRoot, (tasks) => {
    const next = tasks.filter(
      (task) => task.sessionId === undefined || !targets.has(task.sessionId),
    );
    return next.length === tasks.length ? tasks : next;
  });
}
