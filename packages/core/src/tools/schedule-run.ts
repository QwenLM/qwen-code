/**
 * schedule_run tool — runs a durable scheduled task once immediately, as a
 * fresh headless child (same as a daemon fire), without waiting for its next
 * scheduled time.
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { readTask, sanitizeTaskId } from '../services/schedule/task-store.js';
import {
  generateRunId,
  runScheduledTask,
} from '../services/schedule/run-scheduled-task.js';

export interface ScheduleRunParams {
  id: string;
}

class ScheduleRunInvocation extends BaseToolInvocation<
  ScheduleRunParams,
  ToolResult
> {
  getDescription(): string {
    return this.params.id;
  }

  async execute(): Promise<ToolResult> {
    const id = sanitizeTaskId(this.params.id);
    const task = await readTask(id);
    if (!task) {
      const msg = `No scheduled task named "${id}".`;
      return { llmContent: msg, returnDisplay: msg, error: { message: msg } };
    }
    const runId = generateRunId();
    // Fire-and-forget: the child runs in the background and writes its own run
    // record; the user reviews it later with schedule_list or the run files.
    void runScheduledTask({ task, firedAtMs: Date.now(), runId }).catch(
      () => {},
    );
    const msg =
      `Started run ${runId} for "${id}" (cwd: ${task.cwd}). ` +
      'It runs in the background; check its result with schedule_list.';
    return { llmContent: msg, returnDisplay: `Started run ${runId} for ${id}` };
  }
}

export class ScheduleRunTool extends BaseDeclarativeTool<
  ScheduleRunParams,
  ToolResult
> {
  static readonly Name = ToolNames.SCHEDULE_RUN;

  constructor(_config: Config) {
    super(
      ScheduleRunTool.Name,
      ToolDisplayNames.SCHEDULE_RUN,
      'Run a durable scheduled task (routine) once now, without waiting for its ' +
        'next scheduled time. Spawns the same fresh headless run the daemon would; ' +
        'the run happens in the background and its result is recorded for schedule_list.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The task id (from schedule_list).',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer
      false, // alwaysLoad
      'schedule run now trigger routine task once',
    );
  }

  protected createInvocation(
    params: ScheduleRunParams,
  ): ToolInvocation<ScheduleRunParams, ToolResult> {
    return new ScheduleRunInvocation(params);
  }
}
