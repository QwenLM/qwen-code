/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import { isInternalTask, type TaskListItem } from '../../tasks/task-list-types.js';

export function buildClaimedTaskPrompt(task: TaskListItem): string {
  const description = task.description ? `\n\n${task.description}` : '';
  return `Complete all open tasks. Start with task #${task.id}:\n\n${task.subject}${description}`;
}

export async function claimNextAvailableTask(
  config: Config,
  owner: string,
): Promise<TaskListItem | null> {
  const taskStore = config.getTaskStore();
  const snapshot = await taskStore.listTasks();
  const openTaskIds = new Set(
    snapshot
      .filter((task) => task.status !== 'completed')
      .map((task) => task.id),
  );
  const candidates = snapshot.filter(
    (task) =>
      !isInternalTask(task) &&
      task.status === 'pending' &&
      !task.owner &&
      task.blockedBy.every((taskId) => !openTaskIds.has(taskId)),
  );

  for (const candidate of candidates) {
    const claimed = await taskStore.withTaskMutation(
      candidate.id,
      async (mutation) => {
        const current = await mutation.getTask();
        if (
          !current ||
          current.status !== 'pending' ||
          current.owner ||
          current.blockedBy.some((taskId) => openTaskIds.has(taskId))
        ) {
          return null;
        }
        return mutation.updateTask({
          owner,
          status: 'in_progress',
        });
      },
    );
    if (claimed) return claimed;
  }

  return null;
}

export async function releaseClaimedTask(
  config: Config,
  taskId: string,
  owner: string,
): Promise<boolean> {
  const released = await config
    .getTaskStore()
    .withTaskMutation(taskId, async (mutation) => {
      const current = await mutation.getTask();
      if (
        !current ||
        current.status !== 'in_progress' ||
        current.owner !== owner
      ) {
        return null;
      }
      return mutation.updateTask({
        owner: null,
        status: 'pending',
      });
    });
  return released !== null;
}
