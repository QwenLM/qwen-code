/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message } from '../../protocol/transcript/message.js';
import type { ModelToolUseBlock } from '../../provider/event/modelCompleteEvent.js';
import type { TaskStore } from '../../tasks/task-store.js';
import { TASK_MUTATION_TOOL_NAMES } from '../../tools/tool-names.js';
import { BRAND_FIXED_ENV_PREFIX } from '../../config/brand.js';
import { TaskReminderAttachment } from '../types.js';
import { isThinkingOnlyMessage } from './todo-generators.js';

export const TASK_REMINDER_CONFIG = {
  TURNS_SINCE_UPDATE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
} as const;

export async function getTaskReminderAttachments(
  messages: readonly Message[] | undefined,
  taskStore: Pick<TaskStore, 'listTasks'> | undefined,
  isTaskUpdateToolEnabled: boolean,
): Promise<TaskReminderAttachment[]> {
  if (
    !taskStore ||
    !isTaskUpdateToolEnabled ||
    !messages ||
    messages.length === 0 ||
    process.env[`${BRAND_FIXED_ENV_PREFIX}TASK_REMINDER_MODE`] === 'off'
  ) {
    return [];
  }

  const { turnsSinceLastUpdate, turnsSinceLastReminder } =
    deriveTaskReminderCounts(messages);
  if (
    turnsSinceLastUpdate < TASK_REMINDER_CONFIG.TURNS_SINCE_UPDATE ||
    turnsSinceLastReminder < TASK_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  ) {
    return [];
  }

  const tasks = await taskStore.listTasks();
  if (!tasks.some((task) => task.status !== 'completed')) return [];

  return [
    new TaskReminderAttachment({
      type: 'task_reminder',
      content: tasks,
      itemCount: tasks.length,
    }),
  ];
}

function deriveTaskReminderCounts(messages: readonly Message[]): {
  turnsSinceLastUpdate: number;
  turnsSinceLastReminder: number;
} {
  let turnsSinceLastUpdate = 0;
  let turnsSinceLastReminder = 0;
  let foundUpdate = false;
  let foundReminder = false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === 'assistant') {
      if (isThinkingOnlyMessage(message.message.content)) continue;
      if (!foundUpdate) {
        const mutation = message.message.content.find(
          (block): block is ModelToolUseBlock =>
            block.type === 'tool_use' &&
            TASK_MUTATION_TOOL_NAMES.has(block.name),
        );
        if (mutation) foundUpdate = true;
        else turnsSinceLastUpdate += 1;
      }
      if (!foundReminder) turnsSinceLastReminder += 1;
    } else if (
      message.type === 'attachment' &&
      message.attachment.type === 'task_reminder'
    ) {
      foundReminder = true;
    }
    if (foundUpdate && foundReminder) break;
  }

  return { turnsSinceLastUpdate, turnsSinceLastReminder };
}
