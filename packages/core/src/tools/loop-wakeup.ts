/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import { getErrorMessage } from '../utils/errors.js';

export interface LoopWakeupParams {
  delaySeconds: number;
  prompt: string;
  reason?: string;
}

function formatRequested(delaySeconds: number): string {
  return Number.isFinite(delaySeconds) ? `${delaySeconds}s` : `${delaySeconds}`;
}

class LoopWakeupInvocation extends BaseToolInvocation<
  LoopWakeupParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: LoopWakeupParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `${this.params.delaySeconds}s: ${this.params.prompt}`;
  }

  /**
   * Scheduling future model input is side-effectful: the continuation runs
   * against the agent with full tool access at fire time. Returning 'ask'
   * (never 'allow') keeps it out of AUTO mode's L4 short-circuit so the
   * classifier still vets it — same reasoning as CronCreate.
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  async execute(): Promise<ToolResult> {
    const prompt = this.params.prompt.trim();
    if (!prompt) {
      const message = 'Loop wakeup prompt must not be empty.';
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message },
      };
    }

    try {
      const { id, scheduledFor, clampedDelaySeconds, wasClamped } = this.config
        .getCronScheduler()
        .scheduleWakeup(this.params.delaySeconds, prompt);
      const reason = this.params.reason?.trim();

      const llmContent = [
        `Scheduled loop wakeup ${id}.`,
        `Scheduled for: ${scheduledFor} (in ${clampedDelaySeconds}s).`,
        wasClamped
          ? `Requested ${formatRequested(this.params.delaySeconds)} was clamped to the [60, 3600] s range.`
          : null,
        reason ? `Reason: ${reason}.` : null,
        'Session-only one-shot; not persisted. Call LoopWakeup again before ' +
          'ending the turn to keep the loop alive; omit it to end the loop.',
      ]
        .filter(Boolean)
        .join('\n');
      const returnDisplay = `Loop wakeup ${id} scheduled for ${scheduledFor}${
        reason ? ` — ${reason}` : ''
      }`;

      return { llmContent, returnDisplay };
    } catch (error) {
      const message = getErrorMessage(error);
      return {
        llmContent: `Error scheduling loop wakeup: ${message}`,
        returnDisplay: message,
        error: { message },
      };
    }
  }
}

export class LoopWakeupTool extends BaseDeclarativeTool<
  LoopWakeupParams,
  ToolResult
> {
  static readonly Name = ToolNames.LOOP_WAKEUP;

  constructor(private readonly config: Config) {
    super(
      LoopWakeupTool.Name,
      ToolDisplayNames.LOOP_WAKEUP,
      'Schedule when to resume work in a self-paced loop iteration (always pass the `prompt` arg). Call this before ending the turn to keep the loop alive; omit the call to end the loop. Session-only and one-shot — it does not persist or recur.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          delaySeconds: {
            type: 'number',
            description:
              'Seconds from now to wake up. Clamped to [60, 3600]. Prefer 60-270s for fast-changing state, 1200s+ when there is no reason to check sooner.',
          },
          prompt: {
            type: 'string',
            description:
              'Continuation prompt to enqueue when the wakeup fires. Pass the prompt to re-run when the loop resumes — typically the same input that started this self-paced loop, verbatim — so the next firing continues it.',
          },
          reason: {
            type: 'string',
            description:
              'One short sentence explaining the chosen delay. Shown to the user. Be specific.',
          },
        },
        required: ['delaySeconds', 'prompt'],
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer — scheduling is infrequent
      false, // alwaysLoad
      'loop wakeup continuation follow-up self-pace',
    );
  }

  protected createInvocation(
    params: LoopWakeupParams,
  ): ToolInvocation<LoopWakeupParams, ToolResult> {
    return new LoopWakeupInvocation(this.config, params);
  }

  /**
   * Forward the continuation prompt and cadence to the AUTO classifier —
   * it is enqueued and executed against the agent at fire time, so it
   * needs the same scrutiny as a direct command (mirrors CronCreate).
   */
  override toAutoClassifierInput(
    params: LoopWakeupParams,
  ): Record<string, unknown> {
    return {
      delaySeconds: params.delaySeconds,
      prompt: params.prompt,
      reason: params.reason ?? '',
    };
  }
}
