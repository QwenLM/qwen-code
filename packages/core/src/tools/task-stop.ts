/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview TaskStop tool — lets the model cancel a running background agent.
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
  /** The ID of the background agent to stop. */
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
    return `Stop background agent ${this.params.task_id}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const registry = this.config.getBackgroundTaskRegistry();
    const entry = registry.get(this.params.task_id);

    if (!entry) {
      return {
        llmContent: `Error: No background agent found with ID "${this.params.task_id}".`,
        returnDisplay: 'Agent not found.',
        error: {
          message: `Agent not found: ${this.params.task_id}`,
          type: ToolErrorType.TASK_STOP_AGENT_NOT_FOUND,
        },
      };
    }

    if (entry.status !== 'running') {
      return {
        llmContent: `Error: Background agent "${this.params.task_id}" is not running (status: ${entry.status}).`,
        returnDisplay: `Agent not running (${entry.status}).`,
        error: {
          message: `Agent is ${entry.status}: ${this.params.task_id}`,
          type: ToolErrorType.TASK_STOP_AGENT_NOT_RUNNING,
        },
      };
    }

    registry.cancel(this.params.task_id);

    // The terminal task-notification is emitted by the agent's own handler
    // (via registry.complete/fail) rather than cancel(), so the parent model
    // still receives the agent's real partial/final result — not just a bare
    // "cancelled" message — once the reasoning loop unwinds.
    const desc = entry.description;
    return {
      llmContent: `Cancellation requested for background agent "${this.params.task_id}". A final task-notification carrying the agent's last result will follow.\nDescription: ${desc}`,
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
      'Cancel a running background agent by its ID. The agent ID is returned when you launch a background agent.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description:
              'The ID of the background agent to stop (from the launch response or notification).',
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
