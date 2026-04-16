/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * task_list tool — list tasks with optional filters.
 */

import type {
  ToolInvocation,
  ToolResult,
  TaskListResultDisplay,
} from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { getTeamName } from '../agents/team/identity.js';
import { listTasks } from '../agents/team/tasks.js';

export interface TaskListParams {
  status?: 'pending' | 'in_progress' | 'completed';
  owner?: string;
  blockedBy?: string;
}

class TaskListInvocation extends BaseToolInvocation<
  TaskListParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: TaskListParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const filters: string[] = [];
    if (this.params.status) {
      filters.push(`status=${this.params.status}`);
    }
    if (this.params.owner) {
      filters.push(`owner=${this.params.owner}`);
    }
    if (this.params.blockedBy) {
      filters.push(`blockedBy=${this.params.blockedBy}`);
    }
    return filters.length > 0
      ? `List tasks (${filters.join(', ')})`
      : 'List all tasks';
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

    const tasks = await listTasks(teamName, {
      status: this.params.status,
      owner: this.params.owner,
      blockedBy: this.params.blockedBy,
    });

    if (tasks.length === 0) {
      const llmContent = 'No tasks found.';
      return { llmContent, returnDisplay: llmContent };
    }

    const lines = tasks.map(
      (t) =>
        `#${t.id} [${t.status}]` +
        (t.owner ? ` @${t.owner}` : '') +
        ` — ${t.subject}`,
    );

    // Include unread leader messages if called by the
    // leader (no teammate identity = leader context).
    const manager = this.config.getTeamManager?.();
    if (manager && !getTeamName()) {
      try {
        const msgs = await manager.getLeaderMessages();
        if (msgs.length > 0) {
          lines.push('');
          lines.push('--- Teammate messages ---');
          for (const m of msgs) {
            lines.push(`[${m.from}]: ${m.text}`);
          }
        }
      } catch {
        // Ignore — leader inbox may not exist.
      }

      // Hint to the leader: don't poll task_list repeatedly.
      if (manager.hasActiveTeammates()) {
        lines.push('');
        lines.push(
          'NOTE: Teammates are still working. Their results' +
            ' will be delivered as messages — do NOT call' +
            ' task_list again to check. End your turn and' +
            ' wait for teammate messages.',
        );
      }
    }

    const llmContent = lines.join('\n');

    const display: TaskListResultDisplay = {
      type: 'task_list',
      tasks: tasks.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        owner: t.owner,
      })),
    };

    return { llmContent, returnDisplay: display };
  }
}

export class TaskListTool extends BaseDeclarativeTool<
  TaskListParams,
  ToolResult
> {
  static readonly Name = ToolNames.TASK_LIST;

  constructor(private config: Config) {
    super(
      TaskListTool.Name,
      ToolDisplayNames.TASK_LIST,
      'List tasks in the team task list. ' +
        'All filter parameters are optional.',
      Kind.Read,
      {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed'],
            description: 'Filter by task status.',
          },
          owner: {
            type: 'string',
            description: 'Filter by owner agent name.',
          },
          blockedBy: {
            type: 'string',
            description: 'Filter for tasks blocked by this task ID.',
          },
        },
        additionalProperties: false,
      },
    );
  }

  protected createInvocation(
    params: TaskListParams,
  ): ToolInvocation<TaskListParams, ToolResult> {
    return new TaskListInvocation(this.config, params);
  }
}
