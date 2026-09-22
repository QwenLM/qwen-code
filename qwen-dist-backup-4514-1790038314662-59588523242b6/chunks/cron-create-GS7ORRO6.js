// Force strict mode and setup for ESM
"use strict";
import {
  nextFireTime,
  parseCron
} from "./chunk-5EZRLTLQ.js";
import {
  humanReadableCron
} from "./chunk-QHWCP53L.js";
import {
  CRON_TASKS_DISPLAY_PATH
} from "./chunk-C4FISGDN.js";
import {
  promptIdContext
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

// packages/core/src/tools/cron-create.ts
init_esbuild_shims();
function formatDays(days) {
  return days === 1 ? "1 day" : `${days} days`;
}
__name(formatDays, "formatDays");
function recurringExpiryBlurb(maxAgeDays) {
  if (!Number.isFinite(maxAgeDays)) {
    return "Recurring tasks never auto-expire in this configuration \u2014 they keep firing until deleted with CronDelete. Tell the user the job runs until cancelled when scheduling recurring jobs.";
  }
  const span = formatDays(maxAgeDays);
  return `Recurring tasks auto-expire after ${span} \u2014 they fire one final time, then are deleted. This bounds how long a forgotten schedule keeps firing. Tell the user about the ${span} limit when scheduling recurring jobs.`;
}
__name(recurringExpiryBlurb, "recurringExpiryBlurb");
var CronCreateInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "CronCreateInvocation");
  }
  getDescription() {
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
  async getDefaultPermission() {
    return "ask";
  }
  async execute() {
    const recurring = this.params.recurring !== false;
    const durable = this.params.durable === true;
    const useCurrentSession = this.params.sessionMode === "current";
    const prompt = this.params.prompt.trim();
    if (durable && this.config.getSessionSourceType?.() === "standalone") {
      const message = "Durable cron jobs are not supported in standalone sessions.";
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message }
      };
    }
    const scheduler = this.config.getCronScheduler();
    try {
      parseCron(this.params.cron);
      nextFireTime(this.params.cron, /* @__PURE__ */ new Date());
      if (useCurrentSession && !durable) {
        throw new Error(
          "Current-session scheduling requires durable: true because session-only jobs cannot survive a daemon session switch."
        );
      }
      let job;
      if (useCurrentSession) {
        const creator = this.config.getCurrentSessionScheduledTaskCreator();
        const promptId = promptIdContext.getStore();
        if (!creator || !promptId) {
          throw new Error(
            "current_session_scheduling_unavailable: Current-session scheduling requires an active daemon prompt."
          );
        }
        const created = await creator({
          cron: this.params.cron,
          prompt,
          recurring,
          promptId
        });
        job = { id: created.id, cronExpr: created.cron };
      } else {
        job = durable ? await scheduler.createDurable(this.params.cron, prompt, recurring) : scheduler.create(this.params.cron, prompt, recurring);
      }
      const display = humanReadableCron(job.cronExpr);
      const returnDisplay = `Scheduled ${job.id} (${display})${durable ? " [durable]" : ""}${useCurrentSession ? " [current conversation]" : ""}`;
      const where = durable ? `Persisted to ${CRON_TASKS_DISPLAY_PATH}${useCurrentSession ? " and bound to the current conversation" : ""}` : "Session-only (not written to disk, dies when Qwen Code exits)";
      const maxAgeDays = this.config.getCronRecurringMaxAgeDays();
      const expiry = Number.isFinite(maxAgeDays) ? `Auto-expires after ${formatDays(maxAgeDays)}. Use CronDelete to cancel sooner.` : "Never auto-expires. Use CronDelete to cancel.";
      const llmContent = recurring ? `Scheduled recurring job ${job.id} (${job.cronExpr}). ${where}. ` + expiry : `Scheduled one-shot task ${job.id} (${job.cronExpr}). ${where}. It will fire once then auto-delete.`;
      return { llmContent, returnDisplay };
    } catch (error) {
      const message = getErrorMessage(error);
      return {
        llmContent: `Error creating cron job: ${message}`,
        returnDisplay: message,
        error: { message }
      };
    }
  }
};
var CronCreateTool = class _CronCreateTool extends BaseDeclarativeTool {
  constructor(config) {
    const maxAgeDays = config.getCronRecurringMaxAgeDays();
    super(
      _CronCreateTool.Name,
      ToolDisplayNames.CRON_CREATE,
      `Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local \u2014 no timezone conversion needed.

## One-shot tasks (recurring: false)

For "remind me at X" or "at <time>, do Y" requests \u2014 fire once then auto-delete.
Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" \u2192 cron: "30 14 <today_dom> <today_month> *", recurring: false
  "tomorrow morning, run the smoke test" \u2192 cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

## Recurring jobs (recurring: true, the default)

For "every N minutes" / "every hour" / "weekdays at 9am" requests:
  "*/5 * * * *" (every 5 min), "0 * * * *" (hourly), "0 9 * * 1-5" (weekdays at 9am local)

## Avoid the :00 and :30 minute marks when the task allows it

Every user who asks for "9am" gets \`0 9\`, and every user who asks for "hourly" gets \`0 *\` \u2014 which means requests from across the planet land on the API at the same instant. When the user's request is approximate, pick a minute that is NOT 0 or 30:
  "every morning around 9" \u2192 "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")
  "hourly" \u2192 "7 * * * *" (not "0 * * * *")
  "in an hour or so, remind me to..." \u2192 pick whatever minute you land on, don't round

Only use minute 0 or 30 when the user names that exact time and clearly means it ("at 9:00 sharp", "at half past", coordinating with a meeting). When in doubt, nudge a few minutes early or late \u2014 the user will not notice, and the fleet will.

## Durability

By default (durable: false) the job lives only in this Qwen Code session \u2014 nothing is written to disk, and the job is gone when Qwen Code exits. Pass durable: true to write to ${CRON_TASKS_DISPLAY_PATH} so the job survives restarts. Only use durable: true when the user explicitly asks for persistence ("keep doing this every day", "set this up permanently"). Most "remind me in 5 minutes" requests should stay session-only.

## Session binding

By default (sessionMode: "unbound") a durable task stays unbound and uses the existing per-project scheduler owner; it does not reuse this conversation. Use sessionMode: "current" only when the user explicitly wants future runs to continue in this conversation. Current-session mode requires durable: true and an active daemon-backed prompt.

## Runtime behavior

Jobs only fire while the REPL is idle (not mid-query). The scheduler adds a small deterministic jitter on top of whatever you pick: recurring tasks fire up to 10% of their period late (max 15 min); one-shot tasks landing on :00 or :30 fire up to 90 s early. Picking an off-minute is still the bigger lever.

${recurringExpiryBlurb(maxAgeDays)}

Returns a job ID you can pass to CronDelete.`,
      "other" /* Other */,
      {
        type: "object",
        properties: {
          cron: {
            type: "string",
            description: 'Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local once).'
          },
          prompt: {
            type: "string",
            description: "The prompt to enqueue at each fire time."
          },
          recurring: {
            type: "boolean",
            description: `true (default) = fire on every cron match until deleted${Number.isFinite(maxAgeDays) ? ` or auto-expired after ${formatDays(maxAgeDays)}` : ""}. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.`
          },
          durable: {
            type: "boolean",
            description: `true = persist to ${CRON_TASKS_DISPLAY_PATH} and survive restarts. false (default) = in-memory only, dies when Qwen Code exits. Use true only when the user asks the task to survive across sessions.`
          },
          sessionMode: {
            type: "string",
            enum: ["unbound", "current"],
            description: "unbound (default) = preserve the existing unbound durable scheduler behavior. current = bind a durable task to this daemon conversation; requires durable: true."
          }
        },
        required: ["cron", "prompt"],
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
      "cron schedule reminder recurring timer"
    );
    this.config = config;
  }
  static {
    __name(this, "CronCreateTool");
  }
  static Name = ToolNames.CRON_CREATE;
  createInvocation(params) {
    return new CronCreateInvocation(this.config, params);
  }
  validateToolParamValues(params) {
    if (!params.prompt || params.prompt.trim() === "") {
      return 'Parameter "prompt" must be a non-empty string.';
    }
    return null;
  }
  /**
   * Forward the prompt and cadence to the classifier. The scheduled
   * prompt will be enqueued and executed against the agent at fire-time,
   * so it must go through the same scrutiny as a direct command. Without
   * this override the default projection returns `''` and the classifier
   * sees `cron_create({})` — blind to what the agent will be asked to
   * do in 8 hours.
   */
  toAutoClassifierInput(params) {
    return {
      cron: params.cron,
      prompt: params.prompt,
      recurring: params.recurring ?? true,
      durable: params.durable ?? false,
      sessionMode: params.sessionMode ?? "unbound"
    };
  }
};
export {
  CronCreateTool
};
