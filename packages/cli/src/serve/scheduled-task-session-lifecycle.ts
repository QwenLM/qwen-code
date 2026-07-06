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

/** Disables every task bound to one of `sessionIds` (archived sessions). */
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
        return { ...task, enabled: false };
      }
      return task;
    });
    return changed ? next : tasks;
  });
}

/**
 * Re-enables every task bound to one of `sessionIds` (unarchived sessions),
 * resetting a recurring task's anchor to `now` so it resumes from now rather
 * than catching up fires it "missed" while archived — mirroring the management
 * route's re-enable. (The bound session becomes live again on the next session
 * load / daemon rehydration; until then the re-enabled task simply won't fire.)
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
        task.enabled === false
      ) {
        changed = true;
        const resumed: DurableCronTask = { ...task, enabled: true };
        if (resumed.recurring) resumed.lastFiredAt = now - (now % 60_000);
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
