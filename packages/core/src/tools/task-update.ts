/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * task_update tool — update an existing task's fields.
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { getTeamName, getAgentName } from '../agents/team/identity.js';
import { updateTask, deleteTask } from '../agents/team/tasks.js';

export interface TaskUpdateParams {
  taskId: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'deleted';
  owner?: string;
  subject?: string;
  description?: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
  addBlocks?: string[];
  addBlockedBy?: string[];
}

class TaskUpdateInvocation extends BaseToolInvocation<
  TaskUpdateParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: TaskUpdateParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const parts: string[] = [`Task #${this.params.taskId}`];
    if (this.params.status) {
      parts.push(`→ ${this.params.status}`);
    }
    if (this.params.owner) {
      parts.push(`owner: ${this.params.owner}`);
    }
    return parts.join(' ');
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

    const { taskId } = this.params;

    // status: 'deleted' → delete the task file.
    if (this.params.status === 'deleted') {
      const ok = await deleteTask(teamName, taskId);
      if (!ok) {
        const msg = `Task #${taskId} not found.`;
        return {
          llmContent: msg,
          returnDisplay: msg,
          error: { message: msg },
        };
      }
      const msg = `Task #${taskId} deleted.`;
      return { llmContent: msg, returnDisplay: msg };
    }

    // Auto-assign owner on in_progress if caller doesn't
    // specify one. In the leader context getAgentName() is
    // undefined, so require an explicit owner to avoid
    // orphaning the task.
    const autoOwner =
      this.params.status === 'in_progress' && this.params.owner === undefined
        ? getAgentName()
        : undefined;

    if (
      this.params.status === 'in_progress' &&
      !this.params.owner &&
      !autoOwner
    ) {
      const msg =
        `Cannot move task #${taskId} to in_progress without ` +
        `an owner. Specify the "owner" parameter.`;
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg },
      };
    }

    const task = await updateTask(teamName, taskId, {
      status: this.params.status,
      owner: this.params.owner ?? autoOwner,
      subject: this.params.subject,
      description: this.params.description,
      activeForm: this.params.activeForm,
      metadata: this.params.metadata,
      addBlocks: this.params.addBlocks,
      addBlockedBy: this.params.addBlockedBy,
    });

    if (!task) {
      const msg = `Task #${taskId} not found.`;
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg },
      };
    }

    const llmContent =
      `Task #${taskId} updated (status: ${task.status}` +
      (task.owner ? `, owner: ${task.owner}` : '') +
      ').';
    return { llmContent, returnDisplay: llmContent };
  }
}

export class TaskUpdateTool extends BaseDeclarativeTool<
  TaskUpdateParams,
  ToolResult
> {
  static readonly Name = ToolNames.TASK_UPDATE;

  constructor(private config: Config) {
    super(
      TaskUpdateTool.Name,
      ToolDisplayNames.TASK_UPDATE,
      'Update an existing task. Can change status, owner, ' +
        'subject, description, and blocking relationships. ' +
        'Set status to "deleted" to remove a task. ' +
        'Setting status to "in_progress" auto-assigns you ' +
        'as owner if no owner is set.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'ID of the task to update.',
          },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'deleted'],
            description: 'New task status.',
          },
          owner: {
            type: 'string',
            description:
              'New owner agent name. ' + 'Set to empty string to unassign.',
          },
          subject: {
            type: 'string',
            description: 'Updated task title.',
          },
          description: {
            type: 'string',
            description: 'Updated task description.',
          },
          activeForm: {
            type: 'string',
            description: 'Present tense label for UI.',
          },
          metadata: {
            type: 'object',
            description:
              'Metadata to merge. Set a key to null ' + 'to delete it.',
          },
          addBlocks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Task IDs that this task blocks.',
          },
          addBlockedBy: {
            type: 'array',
            items: { type: 'string' },
            description: 'Task IDs that block this task.',
          },
        },
        required: ['taskId'],
        additionalProperties: false,
      },
    );
  }

  protected createInvocation(
    params: TaskUpdateParams,
  ): ToolInvocation<TaskUpdateParams, ToolResult> {
    return new TaskUpdateInvocation(this.config, params);
  }
}
