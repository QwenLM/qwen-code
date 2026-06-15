/**
 * cron_create tool — creates a new cron job (in-session or durable).
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import { parseCron, nextFireTime } from '../utils/cronParser.js';
import { humanReadableCron } from '../utils/cronDisplay.js';
import { CRON_TASKS_DISPLAY_PATH } from '../services/cronTasksFile.js';

export interface CronCreateParams {
  cron: string;
  prompt: string;
  recurring?: boolean;
  durable?: boolean;
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

  /**
   * The scheduled prompt fires against the agent at cron-trigger time
   * and executes with full tool access. The CronCreateTool's L3 default
   * must NOT be 'allow', because AUTO mode short-circuits at L4 when
   * `finalPermission === 'allow'` — the classifier never runs and an
   * arbitrary scheduled prompt is silently approved. `'ask'` routes
   * the call through the classifier (or manual approval in DEFAULT).
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  async execute(): Promise<ToolResult> {
    const scheduler = this.config.getCronScheduler();
    const recurring = this.params.recurring !== false;
    const durable = this.params.durable === true;

    try {
      // Validate cron expression before creating the job
      parseCron(this.params.cron);
      // Reject expressions that parse but never match a real date
      // (e.g. "0 0 30 2 *") — otherwise the job would be accepted and
      // silently never fire. Throws with a clear message.
      nextFireTime(this.params.cron, new Date());

      const job = durable
        ? await scheduler.createDurable(
            this.params.cron,
            this.params.prompt,
            recurring,
          )
        : scheduler.create(this.params.cron, this.params.prompt, recurring);

      const display = humanReadableCron(job.cronExpr);
      const returnDisplay = `Scheduled ${job.id} (${display})${durable ? ' [durable]' : ''}`;

      const where = durable
        ? `Persisted to ${CRON_TASKS_DISPLAY_PATH}`
        : 'Session-only (not written to disk, dies when Qwen Code exits)';
      const llmContent = recurring
        ? `Scheduled recurring job ${job.id} (${job.cronExpr}). ${where}. ` +
          'Auto-expires after 7 days. Use CronDelete to cancel sooner.'
        : `Scheduled one-shot task ${job.id} (${job.cronExpr}). ${where}. ` +
          'It will fire once then auto-delete.';

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
        '## Durability\n\n' +
        'By default (durable: false) the job lives only in this Qwen Code session — nothing is written to disk, and the job is gone when Qwen Code exits. ' +
        `Pass durable: true to write to ${CRON_TASKS_DISPLAY_PATH} so the job survives restarts. ` +
        'Only use durable: true when the user explicitly asks for persistence ("keep doing this every day", "set this up permanently"). ' +
        'Most "remind me in 5 minutes" requests should stay session-only.\n\n' +
        '## Runtime behavior\n\n' +
        'Jobs only fire while the REPL is idle (not mid-query). The scheduler adds a small deterministic jitter on top of whatever you pick: recurring tasks fire up to 10% of their period late (max 15 min); one-shot tasks landing on :00 or :30 fire up to 90 s early. Picking an off-minute is still the bigger lever.\n\n' +
        'Recurring tasks auto-expire after 7 days — they fire one final time, then are deleted. This bounds how long a forgotten schedule keeps firing. Tell the user about the 7-day limit when scheduling recurring jobs.\n\n' +
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
              'true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.',
          },
          durable: {
            type: 'boolean',
            description: `true = persist to ${CRON_TASKS_DISPLAY_PATH} and survive restarts. false (default) = in-memory only, dies when Qwen Code exits. Use true only when the user asks the task to survive across sessions.`,
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

  /**
   * Forward the prompt and cadence to the classifier. The scheduled
   * prompt will be enqueued and executed against the agent at fire-time,
   * so it must go through the same scrutiny as a direct command. Without
   * this override the default projection returns `''` and the classifier
   * sees `cron_create({})` — blind to what the agent will be asked to
   * do in 8 hours.
   */
  override toAutoClassifierInput(
    params: CronCreateParams,
  ): Record<string, unknown> {
    return {
      cron: params.cron,
      prompt: params.prompt,
      recurring: params.recurring ?? true,
      durable: params.durable ?? false,
    };
  }
}
