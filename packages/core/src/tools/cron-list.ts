/**
 * cron_list tool — lists active cron jobs and loop wakeups.
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { humanReadableCron } from '../utils/cronDisplay.js';
import type { DurableCronTask } from '../services/cronTasksFile.js';
import {
  CRON_TASKS_DISPLAY_PATH,
  readCronTasks,
} from '../services/cronTasksFile.js';

export type CronListParams = Record<string, never>;

class CronListInvocation extends BaseToolInvocation<
  CronListParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: CronListParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return '';
  }

  async execute(): Promise<ToolResult> {
    // File-first: durable jobs come straight from the durable tasks file
    // so management works in every mode — headless included — regardless
    // of what the scheduler has loaded.
    // The scheduler contributes only this process's session-only jobs.
    const scheduler = this.config.getCronScheduler();
    // readCronTasks maps a missing file to [] internally, so anything
    // thrown here is a real failure (corrupted file, permissions).
    // Surface it instead of presenting durable jobs as absent.
    let fileTasks: DurableCronTask[];
    try {
      fileTasks = await readCronTasks(this.config.getProjectRoot());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error listing cron jobs: ${message}`,
        returnDisplay: message,
        error: { message },
      };
    }
    const jobs = [
      ...fileTasks.map((task) => ({
        id: task.id,
        cron: task.cron,
        prompt: task.prompt,
        recurring: task.recurring,
        durable: true,
      })),
      ...scheduler
        .list()
        .filter((job) => !job.durable)
        .map((job) => ({
          id: job.id,
          cron: job.cronExpr,
          prompt: job.prompt,
          recurring: job.recurring,
          durable: false,
        })),
    ];

    if (jobs.length === 0) {
      const result = 'No active cron jobs or loop wakeups.';
      return { llmContent: result, returnDisplay: result };
    }

    const llmLines = jobs.map((job) => {
      const type = job.recurring ? 'recurring' : 'one-shot';
      const durability = job.durable ? 'durable' : 'session-only';
      return `${job.id} — ${job.cron} (${type}) [${durability}]: ${job.prompt}`;
    });
    const llmContent = llmLines.join('\n');

    const displayLines = jobs.map(
      (job) =>
        `${job.id} ${humanReadableCron(job.cron)} [${job.durable ? 'durable' : 'session-only'}]`,
    );
    const returnDisplay = displayLines.join('\n');

    return { llmContent, returnDisplay };
  }
}

export class CronListTool extends BaseDeclarativeTool<
  CronListParams,
  ToolResult
> {
  static readonly Name = ToolNames.CRON_LIST;

  constructor(private config: Config) {
    super(
      CronListTool.Name,
      ToolDisplayNames.CRON_LIST,
      `List all cron jobs scheduled via CronCreate and loop wakeups scheduled via LoopWakeup, including session-only jobs and durable jobs in ${CRON_TASKS_DISPLAY_PATH}.`,
      Kind.Other,
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer — low-frequency inspection tool
      false, // alwaysLoad
      'cron list scheduled jobs',
    );
  }

  protected createInvocation(
    params: CronListParams,
  ): ToolInvocation<CronListParams, ToolResult> {
    return new CronListInvocation(this.config, params);
  }
}
