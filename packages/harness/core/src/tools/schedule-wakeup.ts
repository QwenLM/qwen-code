/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ScheduleWakeup tool — one-shot timer for dynamic-pacing /loop mode.
 *
 * Semantics: calling this tool = continue the loop (fire again after delay).
 * NOT calling = end the loop (agent decides to stop).
 *
 * Unlike CronCreate (which schedules recurring cron expressions), this tool
 * sets a single countdown timer that fires once and auto-clears. It does NOT
 * interact with the cron file or the 7-day expiry mechanism.
 */

import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import { SCHEDULE_WAKEUP_TOOL_NAME, SCHEDULE_WAKEUP_DISPLAY_NAME } from './tool-names.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import type { Config } from '../config/config.js';
import { getCustomContextFromContext } from '../utils/sessionIdContext.js';

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface ScheduleWakeupToolParams {
  /** Seconds from now to wake up. Clamped to [60, 3600] by the cron manager. */
  delaySeconds?: number;
  /** One short sentence explaining the chosen delay. Shown to the user. Be specific. */
  reason?: string;
  maxTurns?: number;
  maxCredits?: number;
  /**
   * The /loop input to fire on wake-up. Pass the same /loop input verbatim
   * each turn so the next firing re-enters the skill and continues the loop.
   * For autonomous /loop (no user prompt), pass the literal sentinel
   * `<<autonomous-loop-dynamic>>` instead.
   */
  prompt?: string;
  /**
   * Set to true to end the loop: cancels any pending wakeup. No other
   * fields are needed. Stopping is the loop's normal ending.
   */
  stop?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ScheduleWakeupToolResult extends ToolResult {}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

class ScheduleWakeupToolInvocation extends BaseToolInvocation<
  ScheduleWakeupToolParams,
  ScheduleWakeupToolResult
> {
  constructor(
    private readonly config: Config,
    params: ScheduleWakeupToolParams,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, _toolName, _toolDisplayName);
  }

  override getDescription(): string {
    if (this.params.stop) {
      return 'Stopping the loop';
    }
    return `Scheduling wakeup in ${this.params.delaySeconds}s: ${this.params.reason}`;
  }

  async execute(_signal: AbortSignal): Promise<ScheduleWakeupToolResult> {
    const { delaySeconds, reason, prompt, stop, maxTurns, maxCredits } = this.params;
    // This session's own timer. Two sessions in one process each get a loop of
    // their own; arming one no longer replaces the other's pending wakeup.
    const cronManager = this.config.getCronManager();

    if (stop) {
      const cancelled = cronManager.cancelWakeup();
      const stopMessage = cancelled
        ? 'Loop stopped — pending wakeup cancelled.'
        : 'Loop stopped — no pending wakeup to cancel.';
      return {
        llmContent: stopMessage,
        returnDisplay: stopMessage,
        data: { stopped: true, hadPendingWakeup: cancelled },
      };
    }

    const result = cronManager.scheduleWakeup(
      delaySeconds! * 1000,
      prompt!,
      reason,
      {
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(maxCredits !== undefined ? { maxCredits } : {}),
      },
      getCustomContextFromContext(),
    );

    const clampNote = result.wasClamped
      ? ` (clamped to ${Math.round(result.actualDelay / 1000)}s from your requested value)`
      : '';

    const nextTime = new Date(result.scheduledAt).toTimeString().slice(0, 8);
    const resultMessage = `Next wakeup scheduled for ${nextTime} (in ${Math.round(result.actualDelay / 1000)}s${clampNote}).`;

    return {
      llmContent: resultMessage,
      returnDisplay: resultMessage,
      data: {
        scheduledAt: result.scheduledAt,
        actualDelay: result.actualDelay,
        wasClamped: result.wasClamped,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class ScheduleWakeupTool extends BaseDeclarativeTool<
  ScheduleWakeupToolParams,
  ScheduleWakeupToolResult
> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  static readonly Name = SCHEDULE_WAKEUP_TOOL_NAME;

  constructor(private readonly config: Config) {
    super(
      ScheduleWakeupTool.Name,
      SCHEDULE_WAKEUP_DISPLAY_NAME,
      'Schedule when to resume work in /loop dynamic mode (always pass the `prompt` arg). Call before ending the turn to keep the loop alive; call with `stop: true` to end it. Delay guidance: the context cache expires after 5 minutes, so a delay under ~270s resumes on a warm cache while anything past 300s pays a full cache miss. Avoid the 300–1200s band — it pays that miss without waiting long enough to be worth it. Either stay under 270s when the watched state changes that fast, or commit to 1200s+ so one cache miss buys a much longer wait. For idle ticks with no specific signal to watch, default to 1200–1800s.',
      Kind.Execute,
      {
        type: 'object',
        properties: {
          delaySeconds: {
            type: 'number',
            description:
              'Seconds from now to wake up. Clamped to [60, 3600] by the cron manager. Required unless stop is true.',
          },
          reason: {
            type: 'string',
            description:
              'One short sentence explaining the chosen delay. Shown to the user. Be specific. Required unless stop is true.',
          },
          maxTurns: {
            type: 'number',
            description:
              'Stop the loop after this many wakeups. Sticky: pass it on the first call of a loop and it holds for the rest, so omitting it later does not remove the cap. Omit for no limit.',
          },
          maxCredits: {
            type: 'number',
            description:
              'Stop the loop once it has spent this many credits in total. Sticky in the same way as maxTurns. Omit for no limit.',
          },
          prompt: {
            type: 'string',
            description:
              'The /loop input to fire on wake-up. Pass the same /loop input verbatim each turn so the next firing re-enters the skill and continues the loop. For autonomous /loop (no user prompt), pass the literal sentinel `<<autonomous-loop-dynamic>>` instead. Required unless stop is true.',
          },
          stop: {
            type: 'boolean',
            description:
              'Set to true to end the loop (cancels any pending wakeup). No other fields needed.',
          },
        },
        required: [],
      },
      false, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  protected override validateToolParamValues(
    params: ScheduleWakeupToolParams,
  ): string | null {
    if (params.stop === true) {
      return null; // stop: true needs no other fields
    }
    if (typeof params.delaySeconds !== 'number' || !Number.isFinite(params.delaySeconds)) {
      return "The 'delaySeconds' parameter must be a finite number (or pass stop: true to end the loop).";
    }
    if (!params.reason || params.reason.trim() === '') {
      return "The 'reason' parameter cannot be empty.";
    }
    if (!params.prompt || params.prompt.trim() === '') {
      return "The 'prompt' parameter cannot be empty.";
    }
    return null;
  }

  protected createInvocation(
    params: ScheduleWakeupToolParams,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<ScheduleWakeupToolParams, ScheduleWakeupToolResult> {
    return new ScheduleWakeupToolInvocation(this.config, params, _toolName, _toolDisplayName);
  }
}
