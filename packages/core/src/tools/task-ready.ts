/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';

export interface TaskReadyParams {
  limit?: number;
  parentTaskId?: string;
  priority?: string;
}

class TaskReadyToolInvocation extends BaseToolInvocation<
  TaskReadyParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: TaskReadyParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return 'List actionable tasks (unblocked, not deferred)';
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const cwd = this.config.getWorkingDir?.() ?? process.cwd();

    const args = ['ready', '--json'];
    if (this.params.limit != null) {
      args.push('--limit', String(this.params.limit));
    }
    if (this.params.parentTaskId) {
      args.push('--parent', this.params.parentTaskId, '--recursive');
    }
    if (this.params.priority) {
      const priorityMap: Record<string, string> = {
        critical: '0',
        high: '1',
        medium: '2',
        low: '3',
      };
      const p = priorityMap[this.params.priority];
      if (p) args.push('--priority', p);
    }

    try {
      const output = execFileSync('br', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
        encoding: 'utf8',
        env: { ...process.env, RUST_LOG: 'error', NO_COLOR: '1' },
      });

      const issues = JSON.parse(output);
      if (!Array.isArray(issues) || issues.length === 0) {
        return {
          llmContent:
            'No actionable tasks found. All tasks are either blocked, deferred, or completed.',
          returnDisplay: 'No actionable tasks',
        };
      }

      const tasksJson = JSON.stringify(issues, null, 2);
      return {
        llmContent: `Actionable tasks (unblocked, ordered by priority):\n\n${tasksJson}\n\n<system-reminder>\n${issues.length} task(s) ready to work on. Pick the highest priority one and call task_update to set it in_progress.\n</system-reminder>`,
        returnDisplay: {
          type: 'todo_list' as const,
          todos: issues.map((t: { id: string; title: string }) => ({
            id: t.id,
            content: t.title,
            status: 'pending' as const,
          })),
        },
      };
    } catch {
      return {
        llmContent:
          'br ready is not available or failed. Use task_list to see pending tasks instead.',
        returnDisplay: 'task_ready unavailable',
        error: { message: 'br ready command failed' },
      };
    }
  }
}

export class TaskReadyTool extends BaseDeclarativeTool<
  TaskReadyParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.TASK_READY;

  constructor(private readonly config: Config) {
    super(
      TaskReadyTool.Name,
      ToolDisplayNames.TASK_READY,
      'Returns tasks that are ready to work on right now — unblocked, not deferred, ordered by priority. Use this at the start of a session or after completing a task to decide what to do next.',
      Kind.Think,
      {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of tasks to return (default 20).',
          },
          parentTaskId: {
            type: 'string',
            description:
              'If set, restrict results to subtasks of this parent (recursive).',
          },
          priority: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low'],
            description: 'Filter by exact priority level.',
          },
        },
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
    );
  }

  protected createInvocation(
    params: TaskReadyParams,
  ): ToolInvocation<TaskReadyParams, ToolResult> {
    return new TaskReadyToolInvocation(this.config, params);
  }
}
