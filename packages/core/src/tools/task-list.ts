/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import type { TaskStatus } from '../services/task-store.js';

export interface TaskListParams {
  status?: string;
  parentTaskId?: string;
}

class TaskListToolInvocation extends BaseToolInvocation<
  TaskListParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: TaskListParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const filters: string[] = [];
    if (this.params.status) filters.push(`status=${this.params.status}`);
    if (this.params.parentTaskId)
      filters.push(`parent=${this.params.parentTaskId}`);
    return filters.length > 0
      ? `List tasks (${filters.join(', ')})`
      : 'List all tasks';
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const store = this.config.getTaskStore();
    const tasks = store.list({
      status: this.params.status as TaskStatus | undefined,
      parentTaskId: this.params.parentTaskId,
    });

    if (tasks.length === 0) {
      return {
        llmContent:
          'No tasks found matching the filter.\n\n<system-reminder>\nTask list is empty. Create tasks with task_create before starting multi-step work.\n</system-reminder>',
        returnDisplay: {
          type: 'todo_list' as const,
          todos: [],
        },
      };
    }

    const tasksJson = JSON.stringify(tasks, null, 2);
    return {
      llmContent: `Current tasks:\n\n${tasksJson}\n\n<system-reminder>\nYou have ${tasks.length} task(s). Continue working through them systematically.\n</system-reminder>`,
      returnDisplay: {
        type: 'todo_list' as const,
        todos: tasks.map((t) => ({
          id: t.id,
          content: t.title,
          status:
            t.status === 'blocked' || t.status === 'cancelled'
              ? ('pending' as const)
              : t.status,
        })),
      },
    };
  }
}

export class TaskListTool extends BaseDeclarativeTool<
  TaskListParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.TASK_LIST;

  constructor(private readonly config: Config) {
    super(
      TaskListTool.Name,
      ToolDisplayNames.TASK_LIST,
      'Lists tasks with optional filtering by status or parent task. Returns all tasks when called with no parameters.',
      Kind.Think,
      {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: [
              'pending',
              'in_progress',
              'completed',
              'blocked',
              'cancelled',
            ],
            description: 'Optional: filter tasks by status.',
          },
          parentTaskId: {
            type: 'string',
            description:
              'Optional: filter to subtasks of a specific parent task ID.',
          },
        },
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
    );
  }

  protected createInvocation(
    params: TaskListParams,
  ): ToolInvocation<TaskListParams, ToolResult> {
    return new TaskListToolInvocation(this.config, params);
  }
}
