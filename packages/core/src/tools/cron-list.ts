/**
 * cron_list tool — lists all active in-session cron jobs.
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { nextFireTime } from '../utils/cronParser.js';

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
    return 'List all active cron jobs';
  }

  async execute(): Promise<ToolResult> {
    const scheduler = this.config.getCronScheduler();
    const jobs = scheduler.list();

    if (jobs.length === 0) {
      const result = 'No active cron jobs.';
      return { llmContent: result, returnDisplay: result };
    }

    const now = new Date();
    const lines = jobs.map((job) => {
      let nextFire: string;
      try {
        nextFire = nextFireTime(job.cronExpr, now).toISOString();
      } catch {
        nextFire = 'unknown';
      }
      const type = job.recurring ? 'recurring' : 'one-shot';
      const created = new Date(job.createdAt).toISOString();
      return [
        `- [${job.id}] ${type}`,
        `  Expression: ${job.cronExpr}`,
        `  Prompt: ${job.prompt}`,
        `  Created: ${created}`,
        `  Next fire: ${nextFire}`,
      ].join('\n');
    });

    const result = `Active cron jobs (${jobs.length}):\n${lines.join('\n')}`;
    return { llmContent: result, returnDisplay: result };
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
      'List all cron jobs scheduled via CronCreate in this session.',
      Kind.Other,
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    );
  }

  protected createInvocation(
    params: CronListParams,
  ): ToolInvocation<CronListParams, ToolResult> {
    return new CronListInvocation(this.config, params);
  }
}
