/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import type { TaskPriority } from '../services/task-store.js';

export interface TaskCreateParams {
  title: string;
  description?: string;
  parentTaskId?: string;
  priority?: string;
}

class TaskCreateToolInvocation extends BaseToolInvocation<
  TaskCreateParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: TaskCreateParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Create task: ${this.params.title}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const store = this.config.getTaskStore();
    const task = store.create({
      title: this.params.title,
      description: this.params.description,
      parentTaskId: this.params.parentTaskId,
      priority: this.params.priority as TaskPriority | undefined,
    });

    const taskJson = JSON.stringify(task, null, 2);
    return {
      llmContent: `Task created successfully.\n\n<system-reminder>\nNew task created: ${taskJson}\nContinue with your current work. Use task_update to mark progress.\n</system-reminder>`,
      returnDisplay: {
        type: 'todo_list',
        todos: store.list().map((t) => ({
          id: t.id,
          content: t.title,
          status:
            t.status === 'blocked' || t.status === 'cancelled'
              ? 'pending'
              : t.status,
        })),
      },
    };
  }
}

export class TaskCreateTool extends BaseDeclarativeTool<
  TaskCreateParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.TASK_CREATE;

  constructor(private readonly config: Config) {
    super(
      TaskCreateTool.Name,
      ToolDisplayNames.TASK_CREATE,
      'Creates a new task to track work. Use this to break complex work into trackable units before starting multi-step operations.',
      Kind.Think,
      {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short title describing the task.',
            minLength: 1,
          },
          description: {
            type: 'string',
            description:
              'Optional longer description with details, acceptance criteria, or context.',
          },
          parentTaskId: {
            type: 'string',
            description:
              'Optional ID of a parent task, creating a subtask hierarchy.',
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'critical'],
            description: 'Optional priority level. Defaults to medium.',
          },
        },
        required: ['title'],
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
    );
  }

  protected createInvocation(
    params: TaskCreateParams,
  ): ToolInvocation<TaskCreateParams, ToolResult> {
    return new TaskCreateToolInvocation(this.config, params);
  }
}
