// Force strict mode and setup for ESM
"use strict";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/task-stop.ts
init_esbuild_shims();
var TaskStopInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "TaskStopInvocation");
  }
  getDescription() {
    return `Stop background task ${this.params.task_id}`;
  }
  async execute(_signal) {
    const taskId = this.params.task_id;
    const agentRegistry = this.config.getBackgroundTaskRegistry();
    const agentEntry = agentRegistry.get(taskId);
    if (agentEntry) {
      if (agentEntry.status === "paused") {
        const abandoned = this.config.abandonBackgroundAgent(taskId);
        if (!abandoned) {
          return {
            llmContent: `Error: Background agent "${taskId}" could not be cancelled from paused state.`,
            returnDisplay: "Task could not be cancelled.",
            error: {
              message: `Task could not be cancelled: ${taskId}`,
              type: "task_stop_not_running" /* TASK_STOP_NOT_RUNNING */
            }
          };
        }
        const desc2 = agentEntry.description;
        return {
          llmContent: `Cancelled paused background agent "${taskId}".
Description: ${desc2}`,
          returnDisplay: `Cancelled: ${desc2}`
        };
      }
      if (agentEntry.status !== "running") {
        return notRunningError("agent", taskId, agentEntry.status);
      }
      agentRegistry.cancel(taskId);
      const desc = agentEntry.description;
      return {
        llmContent: `Cancellation requested for background agent "${taskId}". A final task-notification carrying the agent's last result will follow.
Description: ${desc}`,
        returnDisplay: `Cancelled: ${desc}`
      };
    }
    const shellRegistry = this.config.getBackgroundShellRegistry();
    const shellEntry = shellRegistry.get(taskId);
    if (shellEntry) {
      if (shellEntry.status !== "running") {
        return notRunningError("shell", taskId, shellEntry.status);
      }
      shellRegistry.requestCancel(taskId);
      return {
        llmContent: `Cancellation requested for background shell "${taskId}". Final status will be visible via /tasks (text) or the interactive Background tasks dialog (focus the footer Background tasks pill, then Enter) once the process drains; captured output remains at ${shellEntry.outputPath}.
Command: ${shellEntry.command}`,
        returnDisplay: `Cancelled shell: ${shellEntry.command}`
      };
    }
    const monitorRegistry = this.config.getMonitorRegistry();
    const monitorEntry = monitorRegistry.get(taskId);
    if (monitorEntry) {
      if (monitorEntry.status !== "running") {
        return notRunningError("monitor", taskId, monitorEntry.status);
      }
      monitorRegistry.cancel(taskId, { notify: false });
      return {
        llmContent: (
          // Unlike background shells (which settle asynchronously when the
          // child process exits), `monitorRegistry.cancel()` settles the
          // entry synchronously — the cancelled state is observable right
          // now, no drain phrasing.
          `Monitor "${taskId}" cancelled. Status is visible via /tasks (text) or the interactive Background tasks dialog (focus the footer Background tasks pill, then Enter).
Command: ${monitorEntry.command}`
        ),
        returnDisplay: `Cancelled monitor: ${monitorEntry.description}`
      };
    }
    const memoryManager = this.config.getMemoryManager();
    const memoryRecord = memoryManager.getTask(taskId);
    if (memoryRecord) {
      if (memoryRecord.taskType !== "dream") {
        return {
          llmContent: `Error: Memory task "${taskId}" (${memoryRecord.taskType}) is not cancellable. Only dream consolidation tasks support cancellation; extract tasks run on the request loop and complete in milliseconds.`,
          returnDisplay: `Task not cancellable (${memoryRecord.taskType}).`,
          error: {
            message: `task is not cancellable: ${taskId} (${memoryRecord.taskType})`,
            type: "task_stop_not_cancellable" /* TASK_STOP_NOT_CANCELLABLE */
          }
        };
      }
      if (memoryRecord.status !== "running") {
        return notRunningError("dream", taskId, memoryRecord.status);
      }
      const cancelled = memoryManager.cancelTask(taskId);
      if (!cancelled) {
        return {
          llmContent: `Error: Dream task "${taskId}" could not be cancelled (internal state inconsistency \u2014 abort controller missing).`,
          returnDisplay: "Dream cancellation failed (internal state).",
          error: {
            message: `dream cancel failed: ${taskId}`,
            type: "task_stop_internal_error" /* TASK_STOP_INTERNAL_ERROR */
          }
        };
      }
      return {
        llmContent: `Cancellation requested for dream task "${taskId}". The fork agent is being aborted; the consolidation lock will be released as the agent unwinds. Status is visible via the interactive Background tasks dialog (focus the footer Background tasks pill, then Enter).`,
        returnDisplay: `Cancelled dream: ${taskId}`
      };
    }
    return {
      llmContent: `Error: No background task found with ID "${taskId}".`,
      returnDisplay: "Task not found.",
      error: {
        message: `Task not found: ${taskId}`,
        type: "task_stop_not_found" /* TASK_STOP_NOT_FOUND */
      }
    };
  }
};
function notRunningError(kind, taskId, status) {
  return {
    llmContent: `Error: Background ${kind} "${taskId}" is not running (status: ${status}).`,
    returnDisplay: `Task not running (${status}).`,
    error: {
      message: `${kind} is ${status}: ${taskId}`,
      type: "task_stop_not_running" /* TASK_STOP_NOT_RUNNING */
    }
  };
}
__name(notRunningError, "notRunningError");
var TaskStopTool = class _TaskStopTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _TaskStopTool.Name,
      ToolDisplayNames.TASK_STOP,
      "Stop a background task by its ID. Running agents and shells are cancelled; paused recovered agents are abandoned without resuming them.",
      "other" /* Other */,
      {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The ID of the background task to stop (from the launch response or notification)."
          }
        },
        required: ["task_id"],
        additionalProperties: false
      },
      true,
      // isOutputMarkdown
      false,
      // canUpdateOutput
      true,
      // shouldDefer — stopping tasks is infrequent
      false,
      // alwaysLoad
      "task stop cancel kill background"
    );
    this.config = config;
  }
  static {
    __name(this, "TaskStopTool");
  }
  static Name = ToolNames.TASK_STOP;
  createInvocation(params) {
    return new TaskStopInvocation(this.config, params);
  }
};
export {
  TaskStopTool
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
