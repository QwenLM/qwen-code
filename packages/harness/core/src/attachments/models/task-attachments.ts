/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseAttachment } from './base-attachment.js';
import type { AttachmentData } from '../types.js';
import type { ModelStreamUserMessage } from '../../provider/modelStreamRequest.js';
import { TASK_CREATE_TOOL_NAME } from '../../tools/tool-names.js';
import { TASK_UPDATE_TOOL_NAME } from '../../tools/tool-names.js';
import { WRITE_TODOS_TOOL_NAME } from '../../tools/tool-names.js';
import { systemReminder } from '../message-helpers.js';

/**
 * Periodic reminder of current task list (TodoV2 mode).
 * Throttle: every 10 turns after 10 consecutive turns without TaskCreate or TaskUpdate.
 */
export class TaskReminderAttachment extends BaseAttachment {
  readonly type = 'task_reminder' as const;
  declare content: Array<import('../../tasks/task-list-types.js').TaskListItem>;
  declare itemCount: number;

  constructor(data: AttachmentData<TaskReminderAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    const taskItems = this.content
      .map((task) => `#${task.id}. [${task.status}] ${task.subject}`)
      .join('\n');
    let reminder =
      `The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, ` +
      `consider using ${TASK_CREATE_TOOL_NAME} to add new tasks and ${TASK_UPDATE_TOOL_NAME} to update task status ` +
      `(set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. ` +
      `Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.\n`;
    if (taskItems.length > 0) {
      reminder += `\n\nHere are the existing tasks:\n\n${taskItems}`;
    }
    return [systemReminder(reminder)];
  }
}

/**
 * Periodic reminder of current todo list.
 * Throttle: same as task_reminder.
 */
export class TodoReminderAttachment extends BaseAttachment {
  readonly type = 'todo_reminder' as const;
  declare content: Array<import('../../tools/tools.js').Todo>;
  declare itemCount: number;

  constructor(data: AttachmentData<TodoReminderAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    const todos = this.content;
    const todoItems = todos
      .map(
        (todo, i) =>
          `${i + 1}. [${todo.status ?? 'pending'}] ${todo.description ?? ''}`,
      )
      .join('\n');

    let message =
      `The ${WRITE_TODOS_TOOL_NAME} tool hasn't been used recently. ` +
      `If you're working on tasks that would benefit from todo tracking, ` +
      `consider using the ${WRITE_TODOS_TOOL_NAME} tool. ` +
      `Also consider cleaning up the todo list if it has become stale and no ` +
      `longer matches what you are working on. Only use it if it's relevant to ` +
      `the current work. This is just a gentle reminder - ignore if not ` +
      `applicable. Make sure that you NEVER mention this reminder to the user`;

    if (todoItems) {
      message += `\n\nHere are the existing contents of your todo list:\n\n[${todoItems}]`;
    }

    return [systemReminder(message)];
  }
}
