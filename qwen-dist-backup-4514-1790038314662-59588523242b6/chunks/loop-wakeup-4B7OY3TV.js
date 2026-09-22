// Force strict mode and setup for ESM
"use strict";
import {
  WAKEUP_MAX_SECONDS,
  WAKEUP_MIN_SECONDS,
  clampWakeupSeconds
} from "./chunk-4SZ2636R.js";
import "./chunk-5EZRLTLQ.js";
import "./chunk-QHWCP53L.js";
import "./chunk-C4FISGDN.js";
import {
  todoWorkChainContext
} from "./chunk-O6GEWCJA.js";
import "./chunk-VGC4I5JJ.js";
import "./chunk-CA63HYHU.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import "./chunk-ZYDMQCQP.js";
import {
  getErrorMessage
} from "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/loop-wakeup.ts
init_esbuild_shims();
function formatRequested(delaySeconds) {
  return Number.isFinite(delaySeconds) ? `${delaySeconds}s` : `${delaySeconds}`;
}
__name(formatRequested, "formatRequested");
var LoopWakeupInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "LoopWakeupInvocation");
  }
  getDescription() {
    const clamped = clampWakeupSeconds(this.params.delaySeconds);
    const roundedDelaySeconds = Number.isFinite(this.params.delaySeconds) ? Math.round(this.params.delaySeconds) : this.params.delaySeconds;
    const prefix = clamped === roundedDelaySeconds ? `${clamped}s` : `${clamped}s (requested ${formatRequested(this.params.delaySeconds)})`;
    return `${prefix}: ${this.params.prompt}`;
  }
  /**
   * Scheduling future model input is side-effectful: the continuation runs
   * against the agent with full tool access at fire time. Returning 'ask'
   * (never 'allow') keeps it out of AUTO mode's L4 short-circuit so the
   * classifier still vets it — same reasoning as CronCreate.
   */
  async getDefaultPermission() {
    return "ask";
  }
  async execute() {
    const prompt = this.params.prompt.trim();
    if (!prompt) {
      const message = "Loop wakeup prompt must not be empty.";
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message }
      };
    }
    try {
      const scheduler = this.config.getCronScheduler();
      if (scheduler.disabled) {
        const message = "Loop wakeups are disabled for the rest of this session (token limit reached). Restart the session to re-enable.";
        return {
          llmContent: message,
          returnDisplay: message,
          error: { message }
        };
      }
      const { id, scheduledFor, clampedDelaySeconds, wasClamped, replacedId } = scheduler.scheduleWakeup(
        this.params.delaySeconds,
        prompt,
        todoWorkChainContext.getStore()
      );
      const reason = this.params.reason?.trim();
      const llmContent = [
        `Scheduled loop wakeup ${id}.`,
        replacedId ? `Replaced pending wakeup ${replacedId}.` : null,
        `Scheduled for: ${scheduledFor} (in ${clampedDelaySeconds}s).`,
        wasClamped ? `Requested ${formatRequested(this.params.delaySeconds)} was clamped to the [${WAKEUP_MIN_SECONDS}, ${WAKEUP_MAX_SECONDS}] s range.` : null,
        reason ? `Reason: ${reason}.` : null,
        "Session-only one-shot; not persisted. Call LoopWakeup again before ending the turn to keep the loop alive; omit it to end the loop."
      ].filter(Boolean).join("\n");
      const returnDisplay = `Loop wakeup ${id} scheduled for ${scheduledFor}${reason ? ` \u2014 ${reason}` : ""}`;
      return { llmContent, returnDisplay };
    } catch (error) {
      const message = getErrorMessage(error);
      return {
        llmContent: `Error scheduling loop wakeup: ${message}`,
        returnDisplay: message,
        error: { message }
      };
    }
  }
};
var LoopWakeupTool = class _LoopWakeupTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _LoopWakeupTool.Name,
      ToolDisplayNames.LOOP_WAKEUP,
      "Schedule when to resume work in a self-paced loop iteration (always pass the `prompt` arg). Call this before ending the turn to keep the loop alive; omit the call to end the loop. Session-only and one-shot \u2014 it does not persist or recur. A self-paced wakeup chain may run for at most 24h. When a background task you started will wake you on its own \u2014 a backgrounded agent or a Monitor sends a terminal `<task-notification>` on exit, failure, cancellation, or monitor auto-stop \u2014 keep this wakeup as a long fallback heartbeat rather than a poll; see `delaySeconds`.",
      "other" /* Other */,
      {
        type: "object",
        properties: {
          delaySeconds: {
            type: "number",
            description: `Seconds from now to wake up. Clamped to [${WAKEUP_MIN_SECONDS}, ${WAKEUP_MAX_SECONDS}]. Use 60-270s only when actively polling external state that nothing else reports (a CI run, a remote queue) \u2014 staying inside the ~5-min prompt-cache window. When a background task you started will wake you via a \`<task-notification>\` once it finishes, that is the real wake signal \u2014 use 1200-1800s here as a fallback for when it never arrives (the task hangs, a Monitor auto-stops on idle or max-events, or another agent owns it). With no specific signal to watch, default to 1200s+.`
          },
          prompt: {
            type: "string",
            maxLength: 1e4,
            description: "Continuation prompt to enqueue when the wakeup fires. Prefix with `/loop` so the next firing re-invokes the loop skill, e.g. `/loop check the deploy`."
          },
          reason: {
            type: "string",
            description: "One short sentence explaining the chosen delay. Shown to the user. Be specific."
          }
        },
        required: ["delaySeconds", "prompt"],
        additionalProperties: false
      },
      true,
      // isOutputMarkdown
      false,
      // canUpdateOutput
      true,
      // shouldDefer — scheduling is infrequent
      false,
      // alwaysLoad
      "loop wakeup continuation follow-up self-pace"
    );
    this.config = config;
  }
  static {
    __name(this, "LoopWakeupTool");
  }
  static Name = ToolNames.LOOP_WAKEUP;
  createInvocation(params) {
    return new LoopWakeupInvocation(this.config, params);
  }
  /**
   * Forward the continuation prompt and cadence to the AUTO classifier —
   * it is enqueued and executed against the agent at fire time, so it
   * needs the same scrutiny as a direct command (mirrors CronCreate).
   */
  toAutoClassifierInput(params) {
    return {
      delaySeconds: clampWakeupSeconds(params.delaySeconds),
      prompt: params.prompt,
      reason: params.reason ?? ""
    };
  }
};
export {
  LoopWakeupTool
};
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
