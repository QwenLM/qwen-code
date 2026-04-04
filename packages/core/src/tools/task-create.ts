/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * task_create tool — create a new task in the team task list.
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { getTeamName } from '../agents/team/identity.js';
import { createTask } from '../agents/team/tasks.js';

export interface TaskCreateParams {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

class TaskCreateInvocation extends BaseToolInvocation<
  TaskCreateParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: TaskCreateParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Create task: ${this.params.subject}`;
  }

  async execute(): Promise<ToolResult> {
    const teamName = getTeamName() ?? this.config.getTeamContext()?.teamName;
    if (!teamName) {
      const msg = 'No active team. Create a team first.';
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg },
      };
    }

    const task = await createTask(teamName, {
      subject: this.params.subject,
      description: this.params.description,
      activeForm: this.params.activeForm,
      metadata: this.params.metadata,
    });

    const llmContent = `Task #${task.id} created: "${task.subject}"`;
    return { llmContent, returnDisplay: llmContent };
  }
}

export class TaskCreateTool extends BaseDeclarativeTool<
  TaskCreateParams,
  ToolResult
> {
  static readonly Name = ToolNames.TASK_CREATE;

  constructor(private config: Config) {
    super(
      TaskCreateTool.Name,
      ToolDisplayNames.TASK_CREATE,
      'Create a new task in the team task list. ' +
        'Tasks are automatically assigned to idle teammates.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          subject: {
            type: 'string',
            description: 'Short title for the task.',
          },
          description: {
            type: 'string',
            description: 'Detailed description of the task.',
          },
          activeForm: {
            type: 'string',
            description:
              'Present tense label for UI ' + '(e.g., "Running tests").',
          },
          metadata: {
            type: 'object',
            description: 'Optional arbitrary metadata.',
          },
        },
        required: ['subject', 'description'],
        additionalProperties: false,
      },
    );
  }

  protected createInvocation(
    params: TaskCreateParams,
  ): ToolInvocation<TaskCreateParams, ToolResult> {
    return new TaskCreateInvocation(this.config, params);
  }
}
