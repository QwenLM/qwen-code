/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';

export interface TaskStopParams {
  taskId: string;
  reason?: string;
}

class TaskStopToolInvocation extends BaseToolInvocation<
  TaskStopParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: TaskStopParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Stop task: ${this.params.taskId}${this.params.reason ? ` (${this.params.reason})` : ''}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const store = this.config.getTaskStore();
    const stopped = store.stop(this.params.taskId, this.params.reason);

    if (stopped.length === 0) {
      return {
        llmContent: `Task "${this.params.taskId}" not found.`,
        returnDisplay: `Task not found: ${this.params.taskId}`,
        error: {
          message: `Task "${this.params.taskId}" not found.`,
        },
      };
    }

    const stoppedIds = stopped.map((t) => t.id).join(', ');
    return {
      llmContent: `Cancelled ${stopped.length} task(s): ${stoppedIds}\n\n<system-reminder>\nTasks cancelled. Subtasks were also cancelled cascadingly.\n</system-reminder>`,
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

export class TaskStopTool extends BaseDeclarativeTool<
  TaskStopParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.TASK_STOP;

  constructor(private readonly config: Config) {
    super(
      TaskStopTool.Name,
      ToolDisplayNames.TASK_STOP,
      'Cancels a task and all its subtasks. Use when a task is no longer needed or the approach has changed.',
      Kind.Think,
      {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The ID of the task to cancel.',
            minLength: 1,
          },
          reason: {
            type: 'string',
            description: 'Optional reason for cancellation.',
          },
        },
        required: ['taskId'],
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
    );
  }

  protected createInvocation(
    params: TaskStopParams,
  ): ToolInvocation<TaskStopParams, ToolResult> {
    return new TaskStopToolInvocation(this.config, params);
  }
}
