/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CronCreate tool — schedules a recurring or one-shot prompt via cron expression.
 */

import { DEFAULT_DEFERRED_HINTS } from '../codemode/types.js';
import { CRON_CREATE_TOOL_NAME, CRON_CREATE_DISPLAY_NAME } from './tool-names.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type CronCreateResultDisplay,
} from './tools.js';
import {
  parseCronExpression,
  cronToHuman,
  nextCronRunMs,
} from '../cron/index.js';
import type { Config } from '../config/config.js';
import { getCustomContextFromContext } from '../utils/sessionIdContext.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_JOBS = 50;
const DEFAULT_MAX_AGE_DAYS = 7;

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface CronCreateToolParams {
  cron: string;
  prompt: string;
  recurring?: boolean;
  durable?: boolean;
  permanent?: boolean;
  expiresDays?: number;
  maxTurns?: number;
  maxCredits?: number;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CronCreateToolResult extends ToolResult {}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

class CronCreateToolInvocation extends BaseToolInvocation<
  CronCreateToolParams,
  CronCreateToolResult
> {
  constructor(
    private readonly config: Config,
    params: CronCreateToolParams,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, _toolName, _toolDisplayName);
  }

  override getDescription(): string {
    return `Scheduling cron job: "${this.params.cron}" — ${this.params.prompt}`;
  }

  async execute(_signal: AbortSignal): Promise<CronCreateToolResult> {
    const { cron, prompt, recurring = true, durable = false, permanent = false, expiresDays, maxTurns, maxCredits } = this.params;
    const cronManager = this.config.getCronManager();

    const expiresAt =
      expiresDays !== undefined && !permanent
        ? Date.now() + expiresDays * 24 * 60 * 60 * 1000
        : undefined;

    // Rejected rather than silently dropped. A ceiling of zero or less would
    // retire the task before its first fire, and a model that asked for one has
    // misunderstood something the reply should correct.
    for (const [name, value] of [
      ['maxTurns', maxTurns],
      ['maxCredits', maxCredits],
    ] as const) {
      if (value === undefined) continue;
      if (!Number.isFinite(value) || value <= 0) {
        return {
          llmContent: `Error: ${name} must be a positive number, got ${value}. Omit it for no limit.`,
          returnDisplay: `${name} must be a positive number.`,
          error: {
            message: `${name} must be a positive number, got ${value}.`,
          },
        };
      }
    }

    // Validate cron expression
    if (!parseCronExpression(cron)) {
      return {
        llmContent: `Error: Invalid cron expression '${cron}'. Expected 5 fields: M H DoM Mon DoW.`,
        returnDisplay: `Invalid cron expression '${cron}'.`,
        error: {
          message: `Invalid cron expression '${cron}'.`,
        },
      };
    }

    // Validate next fire time exists
    if (nextCronRunMs(cron, Date.now()) === null) {
      return {
        llmContent: `Error: Cron expression '${cron}' does not match any calendar date in the next year.`,
        returnDisplay: `Cron expression '${cron}' has no upcoming match.`,
        error: {
          message: `Cron expression '${cron}' does not match any calendar date in the next year.`,
        },
      };
    }

    // Check task count limit
    const tasks = await cronManager.listTasks();
    if (tasks.length >= MAX_JOBS) {
      return {
        llmContent: `Error: Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.`,
        returnDisplay: `Too many scheduled jobs (max ${MAX_JOBS}).`,
        error: {
          message: `Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.`,
        },
      };
    }

    // Create the task. A durable one is stamped with this session's fingerprint
    // by the manager, so other sessions in the same workspace never auto-fire it.
    const id = await cronManager.addTask(cron, prompt, recurring, durable, {
      permanent,
      expiresAt,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(maxCredits !== undefined ? { maxCredits } : {}),
      // Persisted so every fired turn keeps the identity of the turn that
      // created the schedule.
      customContext: getCustomContextFromContext(),
    });
    const humanSchedule = cronToHuman(cron);

    // Lazily start this session's cron scheduler on first task creation. The
    // manager already knows which session it belongs to, so the ownership gate
    // cannot end up filtering by somebody else's id.
    cronManager.ensureStarted();

    const where = durable
      ? 'Persisted to disk (survives restarts)'
      : 'Session-only (dies when this session ends)';

    const expiryNote = permanent
      ? 'Permanent — will NOT auto-expire.'
      : expiresDays !== undefined
        ? `Auto-expires after ${expiresDays} days.`
        : `Auto-expires after ${DEFAULT_MAX_AGE_DAYS} days.`;

    // Echoed so the model sees the ceiling it asked for take effect, and so a
    // ceiling it forgot to mention is visibly absent rather than ambiguous.
    const limits: string[] = [];
    if (maxTurns !== undefined) limits.push(`${maxTurns} turns`);
    if (maxCredits !== undefined) limits.push(`${maxCredits} credits`);
    const limitNote =
      limits.length > 0 ? ` Stops after ${limits.join(' or ')}.` : '';

    const resultMessage = recurring
      ? `Scheduled recurring job ${id} (${humanSchedule}). ${where}. ${expiryNote}${limitNote} Use CronDelete to cancel.`
      : `Scheduled one-shot task ${id} (${humanSchedule}). ${where}. It will fire once then auto-delete.`;

    return {
      llmContent: resultMessage,
      returnDisplay: {
        cronResultType: 'create',
        id,
        cron,
        humanSchedule,
        prompt,
        recurring,
        durable,
      } satisfies CronCreateResultDisplay,
      data: { id, humanSchedule, recurring, durable },
    };
  }
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class CronCreateTool extends BaseDeclarativeTool<
  CronCreateToolParams,
  CronCreateToolResult
> {
  override get exposureHints() {
    return DEFAULT_DEFERRED_HINTS;
  }
  static readonly Name = CRON_CREATE_TOOL_NAME;

  constructor(private readonly config: Config) {
    super(
      CronCreateTool.Name,
      CRON_CREATE_DISPLAY_NAME,
      `Schedule a recurring or one-shot prompt using a cron expression. The prompt will be enqueued at each fire time. Recurring jobs auto-expire after ${DEFAULT_MAX_AGE_DAYS} days unless cancelled earlier.`,
      Kind.Execute,
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
            description: `true (default) = fire on every cron match until deleted or auto-expired after ${DEFAULT_MAX_AGE_DAYS} days. false = fire once at the next match, then auto-delete.`,
          },
          durable: {
            type: 'boolean',
            description:
              'true = persist to disk and survive restarts. false (default) = in-memory only, dies when this session ends.',
          },
          permanent: {
            type: 'boolean',
            description:
              'true = exempt from 7-day auto-expiry (use for critical recurring monitors). false (default) = auto-expires after 7 days. Only applies to recurring tasks.',
          },
          expiresDays: {
            type: 'number',
            description:
              'Custom auto-expiry in days from now (e.g. 30 = expire after 30 days). Overrides the 7-day default. Ignored when permanent is true. Only applies to recurring tasks.',
          },
          maxTurns: {
            type: 'number',
            description:
              'Stop the task after this many fires. Counted over the task\'s whole life, not per session, so a restart does not reset it. Omit for no limit. Set this whenever the user asks for a bounded number of runs ("check five times", "run it twice an hour for a day").',
          },
          maxCredits: {
            type: 'number',
            description:
              'Stop the task once it has spent this many credits in total. Checked after each turn is metered, so one expensive turn can finish slightly over. Omit for no limit. Set this when the user caps the spend rather than the count ("stop after 50 credits", "don\'t let it burn more than a few credits").',
          },
        },
        required: ['cron', 'prompt'],
      },
      false, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  protected override validateToolParamValues(
    params: CronCreateToolParams,
  ): string | null {
    if (!params.cron || params.cron.trim() === '') {
      return "The 'cron' parameter cannot be empty.";
    }
    if (!params.prompt || params.prompt.trim() === '') {
      return "The 'prompt' parameter cannot be empty.";
    }
    if (params.permanent && !params.recurring) {
      return "'permanent' only applies to recurring tasks.";
    }
    if (params.expiresDays !== undefined) {
      if (!Number.isFinite(params.expiresDays) || params.expiresDays <= 0) {
        return "'expiresDays' must be a positive number of days.";
      }
      if (params.recurring === false) {
        return "'expiresDays' only applies to recurring tasks.";
      }
    }
    return null;
  }

  protected createInvocation(
    params: CronCreateToolParams,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<CronCreateToolParams, CronCreateToolResult> {
    return new CronCreateToolInvocation(this.config, params, _toolName, _toolDisplayName);
  }
}
