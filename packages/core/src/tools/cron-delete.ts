/**
 * cron_delete tool — deletes an in-session cron job by ID.
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';

export interface CronDeleteParams {
  id: string;
}

class CronDeleteInvocation extends BaseToolInvocation<
  CronDeleteParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: CronDeleteParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Delete cron job ${this.params.id}`;
  }

  async execute(): Promise<ToolResult> {
    const scheduler = this.config.getCronScheduler();
    const deleted = scheduler.delete(this.params.id);

    if (deleted) {
      const result = `Cron job ${this.params.id} deleted.`;
      return { llmContent: result, returnDisplay: result };
    } else {
      const result = `Cron job ${this.params.id} not found.`;
      return {
        llmContent: result,
        returnDisplay: result,
        error: { message: result },
      };
    }
  }
}

export class CronDeleteTool extends BaseDeclarativeTool<
  CronDeleteParams,
  ToolResult
> {
  static readonly Name = ToolNames.CRON_DELETE;

  constructor(private config: Config) {
    super(
      CronDeleteTool.Name,
      ToolDisplayNames.CRON_DELETE,
      'Delete an active in-session cron job by its ID. Use cron_list to find job IDs.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The 8-character ID of the cron job to delete.',
          },
        },
        required: ['id'],
      },
    );
  }

  protected createInvocation(
    params: CronDeleteParams,
  ): ToolInvocation<CronDeleteParams, ToolResult> {
    return new CronDeleteInvocation(this.config, params);
  }
}
