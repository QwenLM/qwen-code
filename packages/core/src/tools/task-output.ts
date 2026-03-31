/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';

export interface TaskOutputParams {
  taskId: string;
  output: string;
}

class TaskOutputToolInvocation extends BaseToolInvocation<
  TaskOutputParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: TaskOutputParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Record output for task: ${this.params.taskId}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const store = this.config.getTaskStore();
    const task = store.setOutput(this.params.taskId, this.params.output);

    if (!task) {
      return {
        llmContent: `Task "${this.params.taskId}" not found.`,
        returnDisplay: `Task not found: ${this.params.taskId}`,
        error: {
          message: `Task "${this.params.taskId}" not found.`,
        },
      };
    }

    return {
      llmContent: `Output recorded for task ${task.id}.\n\n<system-reminder>\nTask "${task.title}" output saved. Continue with remaining tasks.\n</system-reminder>`,
      returnDisplay: `Output recorded for task ${task.id}: ${task.title}`,
    };
  }
}

export class TaskOutputTool extends BaseDeclarativeTool<
  TaskOutputParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.TASK_OUTPUT;

  constructor(private readonly config: Config) {
    super(
      TaskOutputTool.Name,
      ToolDisplayNames.TASK_OUTPUT,
      'Records the output or result of a task. Use to attach findings, generated content, or execution results to a task for later reference.',
      Kind.Think,
      {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The ID of the task to attach output to.',
            minLength: 1,
          },
          output: {
            type: 'string',
            description:
              'The output content to record (findings, results, generated content, etc.).',
            minLength: 1,
          },
        },
        required: ['taskId', 'output'],
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
    );
  }

  protected createInvocation(
    params: TaskOutputParams,
  ): ToolInvocation<TaskOutputParams, ToolResult> {
    return new TaskOutputToolInvocation(this.config, params);
  }
}
