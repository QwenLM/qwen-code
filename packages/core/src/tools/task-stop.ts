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
    const taskId = this.params.task_id;

    // Subagent registry first (Phase A control plane). Agent IDs follow the
    // pattern `<subagentName>-<suffix>`, so they cannot collide with shell
    // IDs (which are `bg_<8 hex chars>` from the background shell pool).
    const agentRegistry = this.config.getBackgroundTaskRegistry();
    const agentEntry = agentRegistry.get(taskId);
    if (agentEntry) {
      if (agentEntry.status !== 'running') {
        return notRunningError('agent', taskId, agentEntry.status);
      }
      agentRegistry.cancel(taskId);
      // The terminal task-notification is emitted by the agent's own handler
      // (via registry.complete/fail) rather than cancel(), so the parent
      // model still receives the agent's real partial/final result — not just
      // a bare "cancelled" message — once the reasoning loop unwinds.
      const desc = agentEntry.description;
      return {
        llmContent:
          `Cancellation requested for background agent "${taskId}". ` +
          `A final task-notification carrying the agent's last result will ` +
          `follow.\nDescription: ${desc}`,
        returnDisplay: `Cancelled: ${desc}`,
      };
    }

    // Background shell registry (Phase B). Settles asynchronously when the
    // child process exits in response to the AbortController; the registry
    // entry's terminal state (`cancelled`) and final exit code/output stay
    // observable via `/tasks` and the on-disk output file.
    const shellRegistry = this.config.getBackgroundShellRegistry();
    const shellEntry = shellRegistry.get(taskId);
    if (shellEntry) {
      if (shellEntry.status !== 'running') {
        return notRunningError('shell', taskId, shellEntry.status);
      }
      // requestCancel triggers the AbortController only — the registry's
      // settle path records the real terminal status + endTime once the
      // process actually drains. Calling cancel(id, Date.now()) here would
      // mark the entry terminal immediately and lose the real exit info.
      shellRegistry.requestCancel(taskId);
      return {
        llmContent:
          `Cancellation requested for background shell "${taskId}". ` +
          `Final status will be visible via /tasks once the process drains; ` +
          `captured output remains at ${shellEntry.outputPath}.\n` +
          `Command: ${shellEntry.command}`,
        returnDisplay: `Cancelled shell: ${shellEntry.command}`,
      };
    }

    return {
      llmContent: `Error: No background task found with ID "${taskId}".`,
      returnDisplay: 'Task not found.',
      error: {
        message: `Task not found: ${taskId}`,
        type: ToolErrorType.TASK_STOP_NOT_FOUND,
      },
    };
  }
}

function notRunningError(
  kind: 'agent' | 'shell',
  taskId: string,
  status: string,
): ToolResult {
  return {
    llmContent: `Error: Background ${kind} "${taskId}" is not running (status: ${status}).`,
    returnDisplay: `Task not running (${status}).`,
    error: {
      message: `${kind} is ${status}: ${taskId}`,
      type: ToolErrorType.TASK_STOP_NOT_RUNNING,
    },
  };
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
