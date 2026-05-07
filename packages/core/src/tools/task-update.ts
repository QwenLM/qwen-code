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
import {
  getAgentName,
  isTeammate,
  resolveActiveTeamName,
} from '../agents/team/identity.js';
import {
  updateTask,
  deleteTask,
  assertValidTaskId,
  getTask,
} from '../agents/team/tasks.js';

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
    const teamName = resolveActiveTeamName(
      this.config.getTeamContext()?.teamName,
    );
    if (!teamName) {
      const msg = 'No active team. Create a team first.';
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg },
      };
    }

    const { taskId } = this.params;

    // Validate every referenced ID up-front so an invalid id in
    // addBlocks / addBlockedBy rejects the whole call before we
    // mutate the primary task. Without this, a half-mirrored
    // dependency graph would be persisted (the primary update
    // succeeds, then the reciprocal updateTask throws on the bad
    // id) — exactly what the comment below the reciprocal block
    // says must not happen.
    try {
      assertValidTaskId(taskId);
      for (const id of this.params.addBlocks ?? []) {
        assertValidTaskId(id);
      }
      for (const id of this.params.addBlockedBy ?? []) {
        assertValidTaskId(id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg },
      };
    }

    // Ownership guard for non-leader callers.
    //
    // Mutations to status / owner / subject / description / blocks
    // are restricted: a teammate can only touch tasks it owns or
    // tasks that are still unowned. The leader (and the current
    // owner) keeps full authority — leader for override, owner for
    // its own work. Open mutations like `metadata` are still allowed
    // so any teammate can leave a note.
    if (isTeammate()) {
      const callerName = getAgentName();
      const restrictsOwnership =
        this.params.status !== undefined ||
        this.params.owner !== undefined ||
        this.params.subject !== undefined ||
        this.params.description !== undefined ||
        (this.params.addBlocks?.length ?? 0) > 0 ||
        (this.params.addBlockedBy?.length ?? 0) > 0;
      if (restrictsOwnership) {
        const existing = await getTask(teamName, taskId);
        if (existing?.owner && existing.owner !== callerName) {
          const msg =
            `Task #${taskId} is owned by "${existing.owner}". ` +
            `Only the leader or the owner can change ` +
            `status / owner / subject / description / blocks.`;
          return {
            llmContent: msg,
            returnDisplay: msg,
            error: { message: msg },
          };
        }
      }
    }

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

    // Mirror dependency edges so auto-claim and completion-unblock
    // see a consistent graph: A.blocks=[B] implies B.blockedBy=[A]
    // and vice versa. Updating only one side leaves dependents either
    // permanently blocked or runnable too early.
    const reciprocalUpdates: Array<Promise<unknown>> = [];
    if (this.params.addBlocks?.length) {
      for (const blockedId of this.params.addBlocks) {
        if (blockedId === taskId) continue;
        reciprocalUpdates.push(
          updateTask(teamName, blockedId, { addBlockedBy: [taskId] }),
        );
      }
    }
    if (this.params.addBlockedBy?.length) {
      for (const blockerId of this.params.addBlockedBy) {
        if (blockerId === taskId) continue;
        reciprocalUpdates.push(
          updateTask(teamName, blockerId, { addBlocks: [taskId] }),
        );
      }
    }
    if (reciprocalUpdates.length > 0) {
      await Promise.all(reciprocalUpdates);
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
            maxLength: 200,
            description: 'Updated task title.',
          },
          description: {
            type: 'string',
            maxLength: 10000,
            description: 'Updated task description.',
          },
          activeForm: {
            type: 'string',
            maxLength: 200,
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
