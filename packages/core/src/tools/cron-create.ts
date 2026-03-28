/**
 * cron_create tool — creates a new in-session cron job.
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { nextFireTime } from '../utils/cronParser.js';

export interface CronCreateParams {
  cron_expression: string;
  prompt: string;
  recurring?: boolean;
}

class CronCreateInvocation extends BaseToolInvocation<
  CronCreateParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: CronCreateParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const recurrence =
      this.params.recurring !== false ? 'recurring' : 'one-shot';
    return `Create ${recurrence} cron job: ${this.params.cron_expression}`;
  }

  async execute(): Promise<ToolResult> {
    const scheduler = this.config.getCronScheduler();
    const recurring = this.params.recurring !== false;

    try {
      const job = scheduler.create(
        this.params.cron_expression,
        this.params.prompt,
        recurring,
      );

      const next = nextFireTime(this.params.cron_expression, new Date());
      const result = [
        `Created ${recurring ? 'recurring' : 'one-shot'} cron job.`,
        `  ID: ${job.id}`,
        `  Expression: ${job.cronExpr}`,
        `  Prompt: ${job.prompt}`,
        `  Next fire: ${next.toISOString()}`,
      ].join('\n');

      return {
        llmContent: result,
        returnDisplay: result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error creating cron job: ${message}`,
        returnDisplay: message,
        error: { message },
      };
    }
  }
}

export class CronCreateTool extends BaseDeclarativeTool<
  CronCreateParams,
  ToolResult
> {
  static readonly Name = ToolNames.CRON_CREATE;

  constructor(private config: Config) {
    super(
      CronCreateTool.Name,
      ToolDisplayNames.CRON_CREATE,
      'Create a new in-session cron job that fires a prompt on a schedule. ' +
        'The job runs within the current session and is gone when the session ends. ' +
        'Use standard 5-field cron expressions (minute hour day-of-month month day-of-week). ' +
        'Examples: "*/5 * * * *" (every 5 min), "0 */2 * * *" (every 2 hours), "*/1 * * * *" (every minute).',
      Kind.Other,
      {
        type: 'object',
        properties: {
          cron_expression: {
            type: 'string',
            description:
              'Standard 5-field cron expression. Fields: minute (0-59), hour (0-23), ' +
              'day-of-month (1-31), month (1-12), day-of-week (0-6, 0=Sunday). ' +
              'Supports: *, values, ranges (1-5), steps (*/15), lists (1,15,30).',
          },
          prompt: {
            type: 'string',
            description:
              'The prompt to send when the job fires. This is injected into the ' +
              'session as if the user typed it.',
          },
          recurring: {
            type: 'boolean',
            description:
              'If true (default), the job fires repeatedly. If false, it fires once and is deleted.',
          },
        },
        required: ['cron_expression', 'prompt'],
      },
    );
  }

  protected createInvocation(
    params: CronCreateParams,
  ): ToolInvocation<CronCreateParams, ToolResult> {
    return new CronCreateInvocation(this.config, params);
  }
}
