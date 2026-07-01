/**
 * schedule_list tool — lists durable scheduled tasks (routines) with their
 * schedule, enabled state, and most recent run result.
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { humanReadableCron } from '../utils/cronDisplay.js';
import {
  isTaskEnabled,
  listTasks,
  readState,
  type ScheduledTask,
} from '../services/schedule/task-store.js';
import { readTaskRunRecords } from '../services/schedule/run-delivery.js';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ScheduleListParams {}

function scheduleLabel(task: ScheduledTask): string {
  if (task.schedule.cron) return humanReadableCron(task.schedule.cron);
  if (task.schedule.fireAt) return `once at ${task.schedule.fireAt}`;
  return 'manual (run only)';
}

class ScheduleListInvocation extends BaseToolInvocation<
  ScheduleListParams,
  ToolResult
> {
  getDescription(): string {
    return 'List scheduled tasks';
  }

  async execute(): Promise<ToolResult> {
    const tasks = await listTasks();
    if (tasks.length === 0) {
      const msg = 'No scheduled tasks. Create one with schedule_create.';
      return { llmContent: msg, returnDisplay: msg };
    }
    const blocks: string[] = [];
    for (const task of tasks) {
      const state = await readState(task.id);
      const runs = await readTaskRunRecords(task.id);
      const last = runs[0];
      const status = isTaskEnabled(task, state) ? 'enabled' : 'paused';
      const lastRun = last
        ? `${last.ok ? 'ok' : 'failed'} (${new Date(last.finishedAt).toLocaleString()}) — ${last.summary}`
        : 'never run';
      blocks.push(
        `- ${task.id} [${status}] ${scheduleLabel(task)}\n` +
          `    ${task.description || '(no description)'}\n` +
          `    cwd: ${task.cwd} · approval: ${task.approvalMode} · last: ${lastRun}`,
      );
    }
    const content = `Scheduled tasks (${tasks.length}):\n${blocks.join('\n')}`;
    return { llmContent: content, returnDisplay: content };
  }
}

export class ScheduleListTool extends BaseDeclarativeTool<
  ScheduleListParams,
  ToolResult
> {
  static readonly Name = ToolNames.SCHEDULE_LIST;

  constructor(_config: Config) {
    super(
      ScheduleListTool.Name,
      ToolDisplayNames.SCHEDULE_LIST,
      'List durable scheduled tasks (routines) created with schedule_create, ' +
        'including each task’s schedule, enabled/paused state, working directory, ' +
        'approval mode, and most recent run result.',
      Kind.Other,
      { type: 'object', properties: {}, additionalProperties: false },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer — infrequent
      false, // alwaysLoad
      'schedule list routines tasks show',
    );
  }

  protected createInvocation(
    params: ScheduleListParams,
  ): ToolInvocation<ScheduleListParams, ToolResult> {
    return new ScheduleListInvocation(params);
  }
}
