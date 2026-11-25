/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import type { Config } from '../config/config.js';
import type { ToolUseContext } from './tool-types.js';
import { TASK_STOP_TOOL_NAME } from './tool-names.js';
import { stopTask, TaskControlError } from '../tasks/task-control.js';
import { ToolErrorType } from './tool-error.js';
import { createToolParameterDiagnosticData } from './tool-parameter-diagnostics.js';

export interface TaskStopToolParams {
  task_id: string;
}

export interface TaskStopResult {
  message: string;
  task_id: string;
  task_type: string;
  command?: string;
}

const TASK_STOP_DESCRIPTION = `- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- To stop an agent-team teammate, pass its agent ID ("name@team") or bare teammate name as task_id
- To stop a background agent spawned with a name, pass that name as task_id
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task`;

const TASK_STOP_PARAMETER_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    task_id: {
      type: 'string' as const,
      description:
        'The ID of the background task to stop. Agent-team teammates and named background agents are also accepted by agent ID or name.',
    },
  },
  required: ['task_id'] as const,
};

class TaskStopInvocation extends BaseToolInvocation<TaskStopToolParams, ToolResult> {
  constructor(
    private readonly config: Config,
    params: TaskStopToolParams,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, toolName, toolDisplayName);
  }

  getDescription(): string {
    return '';
  }

  override executeWithContext(ctx: ToolUseContext): Promise<ToolResult> {
    return this.stop(ctx);
  }

  execute(signal: AbortSignal): Promise<ToolResult> {
    return this.stop({
      signal,
      config: this.config,
      sessionId: this.config.getSessionId(),
    });
  }

  private async stop(ctx: ToolUseContext): Promise<ToolResult> {
    const taskId = this.params.task_id;
    const registry = this.config.taskRegistry;
    const sessionId = ctx.sessionId ?? this.config.getSessionId();

    if (!registry) {
      return taskReferenceNotFoundError(`No task found with ID: ${taskId}`);
    }
    let stopped;
    try {
      stopped = await stopTask({
        registry,
        sessionId,
        taskId,
        callerAgentId: ctx.agentId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return error instanceof TaskControlError && error.code === 'not_found'
        ? taskReferenceNotFoundError(message)
        : taskStopError(message);
    }
    const { command } = stopped;
    const result: TaskStopResult = {
      message: `Successfully stopped task: ${stopped.taskId} (${command})`,
      task_id: stopped.taskId,
      task_type: stopped.taskType,
      command,
    };
    return {
      llmContent: JSON.stringify(result),
      returnDisplay: `${command} · stopped`,
      toolUseResult: result,
      data: { ...result },
    };
  }
}

function taskReferenceNotFoundError(message: string): ToolResult {
  return {
    ...taskStopError(message),
    data: createToolParameterDiagnosticData('missing_reference', {
      validation_source: 'tool_execution',
      parameter_path: 'params.task_id',
      constraint_category: 'reference_not_found',
      quality: 'precise',
      validation_phase: 'execution',
    }),
  };
}

function taskStopError(message: string): ToolResult {
  return {
    llmContent: message,
    returnDisplay: message,
    error: {
      message,
      type: ToolErrorType.INVALID_TOOL_PARAMS,
    },
  };
}

export class TaskStopTool extends BaseDeclarativeTool<
  TaskStopToolParams,
  ToolResult
> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  static readonly Name = TASK_STOP_TOOL_NAME;

  constructor(private readonly config: Config) {
    super(
      TaskStopTool.Name,
      'Stop Task',
      TASK_STOP_DESCRIPTION,
      Kind.Other,
      TASK_STOP_PARAMETER_SCHEMA,
    );
  }

  override isConcurrencySafe(): boolean {
    return true;
  }

  override toClassifierInput(input: TaskStopToolParams): unknown {
    return input.task_id;
  }

  protected createInvocation(
    params: TaskStopToolParams,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<TaskStopToolParams, ToolResult> {
    return new TaskStopInvocation(
      this.config,
      params,
      toolName,
      toolDisplayName,
    );
  }
}
