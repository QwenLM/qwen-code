/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import type { TaskPriority, TaskStatus } from '../services/task-store.js';

export interface TaskUpdateParams {
  taskId: string;
  status?: string;
  title?: string;
  description?: string;
  priority?: string;
}

class TaskUpdateToolInvocation extends BaseToolInvocation<
  TaskUpdateParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: TaskUpdateParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const updates: string[] = [];
    if (this.params.status) updates.push(`status=${this.params.status}`);
    if (this.params.title) updates.push(`title="${this.params.title}"`);
    if (this.params.priority) updates.push(`priority=${this.params.priority}`);
    return `Update task ${this.params.taskId}: ${updates.join(', ') || 'no changes'}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const store = this.config.getTaskStore();
    const task = store.update(this.params.taskId, {
      status: this.params.status as TaskStatus | undefined,
      title: this.params.title,
      description: this.params.description,
      priority: this.params.priority as TaskPriority | undefined,
    });

    if (!task) {
      return {
        llmContent: `Task "${this.params.taskId}" not found.`,
        returnDisplay: `Task not found: ${this.params.taskId}`,
        error: {
          message: `Task "${this.params.taskId}" not found.`,
        },
      };
    }

    const taskJson = JSON.stringify(task, null, 2);
    return {
      llmContent: `Task updated successfully.\n\n<system-reminder>\nUpdated task: ${taskJson}\nContinue with your current work.\n</system-reminder>`,
      returnDisplay: {
        type: 'todo_list' as const,
        todos: store.list().map((t) => ({
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

export class TaskUpdateTool extends BaseDeclarativeTool<
  TaskUpdateParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.TASK_UPDATE;

  constructor(private readonly config: Config) {
    super(
      TaskUpdateTool.Name,
      ToolDisplayNames.TASK_UPDATE,
      'Updates an existing task. Use to change status (e.g., mark in_progress before starting, completed when done), update the title, description, or priority.',
      Kind.Think,
      {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The ID of the task to update.',
            minLength: 1,
          },
          status: {
            type: 'string',
            enum: [
              'pending',
              'in_progress',
              'completed',
              'blocked',
              'cancelled',
            ],
            description: 'New status for the task.',
          },
          title: {
            type: 'string',
            description: 'New title for the task.',
          },
          description: {
            type: 'string',
            description: 'New description for the task.',
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'critical'],
            description: 'New priority level.',
          },
        },
        required: ['taskId'],
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
    );
  }

  protected override validateToolParamValues(
    params: TaskUpdateParams,
  ): string | null {
    if (
      !params.status &&
      !params.title &&
      !params.description &&
      !params.priority
    ) {
      return 'At least one of status, title, description, or priority must be provided.';
    }
    return null;
  }

  protected createInvocation(
    params: TaskUpdateParams,
  ): ToolInvocation<TaskUpdateParams, ToolResult> {
    return new TaskUpdateToolInvocation(this.config, params);
  }
}
