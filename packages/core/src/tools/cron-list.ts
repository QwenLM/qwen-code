/**
 * cron_list tool — lists all active in-session cron jobs.
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { humanReadableCron } from '../utils/cronDisplay.js';

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
    const scheduler = this.config.getCronScheduler();
    const jobs = scheduler.list();

    if (jobs.length === 0) {
      const result = 'No active cron jobs.';
      return { llmContent: result, returnDisplay: result };
    }

    const llmLines = jobs.map((job) => {
      const type = job.recurring ? 'recurring' : 'one-shot';
      return `${job.id} — ${job.cronExpr} (${type}) [session-only]: ${job.prompt}`;
    });
    const llmContent = llmLines.join('\n');

    const displayLines = jobs.map(
      (job) => `${job.id} ${humanReadableCron(job.cronExpr)}`,
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
