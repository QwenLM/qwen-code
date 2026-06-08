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
  TaskOwnershipError,
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

    // Ownership guard for non-leader callers is now enforced inside
    // `updateTask` under the per-task lock. Doing it pre-lock used to
    // race: two teammates could both observe an unowned task and pass,
    // then the second writer would silently overwrite the first one's
    // claim. We compute the caller name here and pass it through so
    // the in-lock check has the identity it needs.
    const teammateCallerName = isTeammate() ? getAgentName() : undefined;

    // status: 'deleted' → delete the task file.
    if (this.params.status === 'deleted') {
      let ok: boolean;
      try {
        ok = await deleteTask(
          teamName,
          taskId,
          teammateCallerName !== undefined
            ? { callerName: teammateCallerName }
            : undefined,
        );
      } catch (err) {
        if (err instanceof TaskOwnershipError) {
          return {
            llmContent: err.message,
            returnDisplay: err.message,
            error: { message: err.message },
          };
        }
        throw err;
      }
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

    // Reject dependency edges that point at tasks which don't
    // exist yet. Without this the primary `updateTask` happily
    // persists the bad id into `blocks` / `blockedBy`, while the
    // reciprocal `updateTask` returns undefined silently — so
    // the tool reports success but the task is now permanently
    // blocked by a phantom id and auto-claim will never unblock
    // it.
    const referencedIds = new Set<string>();
    for (const id of this.params.addBlocks ?? []) {
      if (id !== taskId) referencedIds.add(id);
    }
    for (const id of this.params.addBlockedBy ?? []) {
      if (id !== taskId) referencedIds.add(id);
    }
    if (referencedIds.size > 0) {
      const missing: string[] = [];
      await Promise.all(
        Array.from(referencedIds).map(async (id) => {
          const t = await getTask(teamName, id);
          if (!t) missing.push(id);
        }),
      );
      if (missing.length > 0) {
        const ids = missing
          .sort()
          .map((id) => `#${id}`)
          .join(', ');
        const msg =
          `Cannot update task #${taskId}: ` +
          `referenced task${missing.length === 1 ? '' : 's'} ` +
          `${ids} not found.`;
        return {
          llmContent: msg,
          returnDisplay: msg,
          error: { message: msg },
        };
      }
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

    let task;
    try {
      task = await updateTask(
        teamName,
        taskId,
        {
          status: this.params.status,
          owner: this.params.owner ?? autoOwner,
          subject: this.params.subject,
          description: this.params.description,
          activeForm: this.params.activeForm,
          metadata: this.params.metadata,
          addBlocks: this.params.addBlocks,
          addBlockedBy: this.params.addBlockedBy,
        },
        teammateCallerName !== undefined
          ? { callerName: teammateCallerName }
          : undefined,
      );
    } catch (err) {
      if (err instanceof TaskOwnershipError) {
        return {
          llmContent: err.message,
          returnDisplay: err.message,
          error: { message: err.message },
        };
      }
      throw err;
    }

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
    //
    // Exception: when this same call also completes the task, do NOT
    // mirror addBlocks into the dependents' blockedBy. A completed task
    // can't block anything, and the primary updateTask's
    // completion-unblock already ran (before this reciprocal), so it
    // couldn't clear an edge that didn't exist yet — adding it here
    // would leave the dependent permanently blocked by an already-
    // completed task (verified repro: task_update({status:'completed',
    // addBlocks:['X']}) left X blockedBy the just-completed task).
    const reciprocalUpdates: Array<Promise<unknown>> = [];
    if (this.params.addBlocks?.length && this.params.status !== 'completed') {
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
