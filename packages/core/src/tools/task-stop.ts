/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview TaskStop tool — lets the model cancel a running background task.
 */

import type { Config } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';

export interface TaskStopParams {
  /** The ID of the background task to stop. */
  task_id: string;
}

class TaskStopInvocation extends BaseToolInvocation<
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
    return `Stop background task ${this.params.task_id}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const registry = this.config.getBackgroundTaskRegistry();
    const entry = registry.get(this.params.task_id);

    if (!entry) {
      return {
        llmContent: `Error: No background task found with ID "${this.params.task_id}".`,
        returnDisplay: 'Task not found.',
        error: {
          message: `Task not found: ${this.params.task_id}`,
          type: ToolErrorType.TASK_STOP_NOT_FOUND,
        },
      };
    }

    if (entry.status !== 'running') {
      return {
        llmContent: `Error: Background task "${this.params.task_id}" is not running (status: ${entry.status}).`,
        returnDisplay: `Task not running (${entry.status}).`,
        error: {
          message: `Task is ${entry.status}: ${this.params.task_id}`,
          type: ToolErrorType.TASK_STOP_NOT_RUNNING,
        },
      };
    }

    registry.cancel(this.params.task_id);

    // The terminal task-notification is emitted by the task's own handler
    // (via registry.complete/fail) rather than cancel(), so the parent model
    // still receives the task's real partial/final result — not just a bare
    // "cancelled" message — once the reasoning loop unwinds.
    const desc = entry.description;
    return {
      llmContent: `Cancellation requested for background task "${this.params.task_id}". A final task-notification carrying the task's last result will follow.\nDescription: ${desc}`,
      returnDisplay: `Cancelled: ${desc}`,
    };
  }
}

export class TaskStopTool extends BaseDeclarativeTool<
  TaskStopParams,
  ToolResult
> {
  static readonly Name = ToolNames.TASK_STOP;

  constructor(private readonly config: Config) {
    super(
      TaskStopTool.Name,
      ToolDisplayNames.TASK_STOP,
      'Cancel a running background task by its ID. The task ID is returned when the task is launched.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description:
              'The ID of the background task to stop (from the launch response or notification).',
          },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
    );
  }

  protected createInvocation(
    params: TaskStopParams,
  ): ToolInvocation<TaskStopParams, ToolResult> {
    return new TaskStopInvocation(this.config, params);
  }
}
