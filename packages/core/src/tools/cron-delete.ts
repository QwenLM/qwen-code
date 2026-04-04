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
    return this.params.id;
  }

  async execute(): Promise<ToolResult> {
    const scheduler = this.config.getCronScheduler();
    const deleted = scheduler.delete(this.params.id);

    if (deleted) {
      const llmContent = `Cancelled job ${this.params.id}.`;
      const returnDisplay = `Cancelled ${this.params.id}`;
      return { llmContent, returnDisplay };
    } else {
      const result = `Job ${this.params.id} not found.`;
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
      'Cancel a cron job previously scheduled with CronCreate. Removes it from the in-memory session store.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Job ID returned by CronCreate.',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
    );
  }

  protected createInvocation(
    params: CronDeleteParams,
  ): ToolInvocation<CronDeleteParams, ToolResult> {
    return new CronDeleteInvocation(this.config, params);
  }
}
