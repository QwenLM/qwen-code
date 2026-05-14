/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview TaskStop tool — lets the model stop a background task.
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
      if (agentEntry.status === 'paused') {
        const abandoned = this.config.abandonBackgroundAgent(taskId);
        if (!abandoned) {
          return {
            llmContent:
              `Error: Background agent "${taskId}" could not be cancelled ` +
              `from paused state.`,
            returnDisplay: 'Task could not be cancelled.',
            error: {
              message: `Task could not be cancelled: ${taskId}`,
              type: ToolErrorType.TASK_STOP_NOT_RUNNING,
            },
          };
        }

        const desc = agentEntry.description;
        return {
          llmContent:
            `Cancelled paused background agent "${taskId}".\n` +
            `Description: ${desc}`,
          returnDisplay: `Cancelled: ${desc}`,
        };
      }
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
    // observable via `/tasks` (text), the interactive Background tasks
    // dialog (focus the footer Background tasks pill, then Enter), and
    // the on-disk output file.
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
          `Final status will be visible via /tasks (text) or the interactive Background tasks dialog (focus the footer Background tasks pill, then Enter) once the process drains; ` +
          `captured output remains at ${shellEntry.outputPath}.\n` +
          `Command: ${shellEntry.command}`,
        returnDisplay: `Cancelled shell: ${shellEntry.command}`,
      };
    }

    const monitorRegistry = this.config.getMonitorRegistry();
    const monitorEntry = monitorRegistry.get(taskId);
    if (monitorEntry) {
      if (monitorEntry.status !== 'running') {
        return notRunningError('monitor', taskId, monitorEntry.status);
      }
      monitorRegistry.cancel(taskId);
      return {
        llmContent:
          // Unlike background shells (which settle asynchronously when the
          // child process exits), `monitorRegistry.cancel()` settles the
          // entry synchronously — the cancelled state is observable right
          // now, no drain phrasing.
          `Monitor "${taskId}" cancelled. ` +
          `Status is visible via /tasks (text) or the interactive Background tasks dialog (focus the footer Background tasks pill, then Enter).\n` +
          `Command: ${monitorEntry.command}`,
        returnDisplay: `Cancelled monitor: ${monitorEntry.description}`,
      };
    }

    // MemoryManager memory tasks (dream + extract). Memory tasks live
    // outside the registry trio (MemoryManager owns its own task map).
    // Only `dream` is cancellable — extract is short-lived and runs on
    // the request loop, so cancelling it would interfere with the
    // user's own turn. Surface a distinct error for known-but-not-
    // cancellable records so the model doesn't conclude the id was
    // never valid (which would happen if we fell through to NOT_FOUND).
    const memoryManager = this.config.getMemoryManager();
    const memoryRecord = memoryManager.getTask(taskId);
    if (memoryRecord) {
      if (memoryRecord.taskType !== 'dream') {
        return {
          llmContent:
            `Error: Memory task "${taskId}" (${memoryRecord.taskType}) is ` +
            `not cancellable. Only dream consolidation tasks support ` +
            `cancellation; extract tasks run on the request loop and ` +
            `complete in milliseconds.`,
          returnDisplay: `Task not cancellable (${memoryRecord.taskType}).`,
          error: {
            message: `task is not cancellable: ${taskId} (${memoryRecord.taskType})`,
            type: ToolErrorType.TASK_STOP_NOT_CANCELLABLE,
          },
        };
      }
      if (memoryRecord.status !== 'running') {
        return notRunningError('dream', taskId, memoryRecord.status);
      }
      // cancelTask returns false if the AbortController is missing for
      // a running record (logic-level invariant violation; see
      // MemoryManager.cancelTask). Surface that explicitly so the model
      // sees the cancel didn't take and doesn't claim success.
      const cancelled = memoryManager.cancelTask(taskId);
      if (!cancelled) {
        // Distinct from TASK_STOP_NOT_RUNNING (the task IS running)
        // and TASK_STOP_NOT_CANCELLABLE (the kind supports cancel,
        // we just couldn't deliver it). INTERNAL_ERROR signals that
        // this is unexpected and worth filing — the abort controller
        // should have been registered alongside status='running' in
        // scheduleDream.
        return {
          llmContent:
            `Error: Dream task "${taskId}" could not be cancelled ` +
            `(internal state inconsistency — abort controller missing).`,
          returnDisplay: 'Dream cancellation failed (internal state).',
          error: {
            message: `dream cancel failed: ${taskId}`,
            type: ToolErrorType.TASK_STOP_INTERNAL_ERROR,
          },
        };
      }
      return {
        llmContent:
          `Cancellation requested for dream task "${taskId}". ` +
          `The fork agent is being aborted; the consolidation lock will ` +
          `be released as the agent unwinds. Status is visible via the ` +
          `interactive Background tasks dialog (focus the footer Background ` +
          `tasks pill, then Enter).`,
        returnDisplay: `Cancelled dream: ${taskId}`,
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
  kind: 'agent' | 'shell' | 'monitor' | 'dream',
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
      'Stop a background task by its ID. Running agents and shells are cancelled; paused recovered agents are abandoned without resuming them.',
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
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer — stopping tasks is infrequent
      false, // alwaysLoad
      'task stop cancel kill background',
    );
  }

  protected createInvocation(
    params: TaskStopParams,
  ): ToolInvocation<TaskStopParams, ToolResult> {
    return new TaskStopInvocation(this.config, params);
  }
}
