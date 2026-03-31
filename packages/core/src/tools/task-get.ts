/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';

export interface TaskGetParams {
  taskId: string;
}

class TaskGetToolInvocation extends BaseToolInvocation<
  TaskGetParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: TaskGetParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Get task: ${this.params.taskId}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const store = this.config.getTaskStore();
    const task = store.get(this.params.taskId);

    if (!task) {
      return {
        llmContent: `Task "${this.params.taskId}" not found.`,
        returnDisplay: `Task not found: ${this.params.taskId}`,
        error: {
          message: `Task "${this.params.taskId}" not found.`,
        },
      };
    }

    const subtaskCount = store.getSubtaskCount(task.id);
    const subtasks = store.list({ parentTaskId: task.id });
    const taskJson = JSON.stringify(
      { ...task, subtaskCount, subtasks },
      null,
      2,
    );

    return {
      llmContent: `Task details:\n\n${taskJson}`,
      returnDisplay: `Task ${task.id}: ${task.title} [${task.status}]`,
    };
  }
}

export class TaskGetTool extends BaseDeclarativeTool<
  TaskGetParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.TASK_GET;

  constructor(private readonly config: Config) {
    super(
      TaskGetTool.Name,
      ToolDisplayNames.TASK_GET,
      'Retrieves a single task by ID, including its subtasks and current status.',
      Kind.Think,
      {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The ID of the task to retrieve.',
            minLength: 1,
          },
        },
        required: ['taskId'],
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
    );
  }

  protected createInvocation(
    params: TaskGetParams,
  ): ToolInvocation<TaskGetParams, ToolResult> {
    return new TaskGetToolInvocation(this.config, params);
  }
}
