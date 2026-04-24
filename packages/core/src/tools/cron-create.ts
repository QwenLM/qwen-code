/**
 * cron_create tool — creates a new in-session cron job.
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { parseCron } from '../utils/cronParser.js';
import { humanReadableCron } from '../utils/cronDisplay.js';

export interface CronCreateParams {
  cron: string;
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
    return `${this.params.cron}: ${this.params.prompt}`;
  }

  async execute(): Promise<ToolResult> {
    const scheduler = this.config.getCronScheduler();
    const recurring = this.params.recurring !== false;

    try {
      // Validate cron expression before creating the job
      parseCron(this.params.cron);

      const job = scheduler.create(
        this.params.cron,
        this.params.prompt,
        recurring,
      );

      const display = humanReadableCron(job.cronExpr);
      const returnDisplay = `Scheduled ${job.id} (${display})`;

      let llmContent: string;
      if (recurring) {
        llmContent =
          `Scheduled recurring job ${job.id} (${job.cronExpr}). ` +
          'Session-only (not written to disk, dies when Qwen Code exits). ' +
          'Auto-expires after 3 days. Use CronDelete to cancel sooner.';
      } else {
        llmContent =
          `Scheduled one-shot task ${job.id} (${job.cronExpr}). ` +
          'Session-only (not written to disk, dies when Qwen Code exits). ' +
          'It will fire once then auto-delete.';
      }

      return { llmContent, returnDisplay };
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
      'Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.\n\n' +
        'Uses standard 5-field cron in the user\'s local timezone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local — no timezone conversion needed.\n\n' +
        '## One-shot tasks (recurring: false)\n\n' +
        'For "remind me at X" or "at <time>, do Y" requests — fire once then auto-delete.\n' +
        'Pin minute/hour/day-of-month/month to specific values:\n' +
        '  "remind me at 2:30pm today to check the deploy" → cron: "30 14 <today_dom> <today_month> *", recurring: false\n' +
        '  "tomorrow morning, run the smoke test" → cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false\n\n' +
        '## Recurring jobs (recurring: true, the default)\n\n' +
        'For "every N minutes" / "every hour" / "weekdays at 9am" requests:\n' +
        '  "*/5 * * * *" (every 5 min), "0 * * * *" (hourly), "0 9 * * 1-5" (weekdays at 9am local)\n\n' +
        '## Avoid the :00 and :30 minute marks when the task allows it\n\n' +
        'Every user who asks for "9am" gets `0 9`, and every user who asks for "hourly" gets `0 *` — which means requests from across the planet land on the API at the same instant. When the user\'s request is approximate, pick a minute that is NOT 0 or 30:\n' +
        '  "every morning around 9" → "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")\n' +
        '  "hourly" → "7 * * * *" (not "0 * * * *")\n' +
        '  "in an hour or so, remind me to..." → pick whatever minute you land on, don\'t round\n\n' +
        'Only use minute 0 or 30 when the user names that exact time and clearly means it ("at 9:00 sharp", "at half past", coordinating with a meeting). When in doubt, nudge a few minutes early or late — the user will not notice, and the fleet will.\n\n' +
        '## Session-only\n\n' +
        'Jobs live only in this Qwen Code session — nothing is written to disk, and the job is gone when Qwen Code exits.\n\n' +
        '## Runtime behavior\n\n' +
        'Jobs only fire while the REPL is idle (not mid-query). The scheduler adds a small deterministic jitter on top of whatever you pick: recurring tasks fire up to 10% of their period late (max 15 min); one-shot tasks landing on :00 or :30 fire up to 90 s early. Picking an off-minute is still the bigger lever.\n\n' +
        'Recurring tasks auto-expire after 3 days — they fire one final time, then are deleted. This bounds session lifetime. Tell the user about the 3-day limit when scheduling recurring jobs.\n\n' +
        'Returns a job ID you can pass to CronDelete.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          cron: {
            type: 'string',
            description:
              'Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local once).',
          },
          prompt: {
            type: 'string',
            description: 'The prompt to enqueue at each fire time.',
          },
          recurring: {
            type: 'boolean',
            description:
              'true (default) = fire on every cron match until deleted or auto-expired after 3 days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.',
          },
        },
        required: ['cron', 'prompt'],
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer — scheduling is infrequent
      false, // alwaysLoad
      'cron schedule reminder recurring timer',
    );
  }

  protected createInvocation(
    params: CronCreateParams,
  ): ToolInvocation<CronCreateParams, ToolResult> {
    return new CronCreateInvocation(this.config, params);
  }
}
