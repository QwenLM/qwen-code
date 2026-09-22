// Force strict mode and setup for ESM
"use strict";
import {
  humanReadableCron
} from "./chunk-QHWCP53L.js";
import {
  CRON_TASKS_DISPLAY_PATH,
  readCronTasks,
  taskHasLegacyCondition
} from "./chunk-C4FISGDN.js";
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
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/cron-list.ts
init_esbuild_shims();
function truncatePrompt(prompt) {
  return prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
}
__name(truncatePrompt, "truncatePrompt");
function displaySchedule(cron, fireAtMs) {
  if (cron === "@wakeup" && fireAtMs !== void 0) {
    return `wakeup at ${new Date(fireAtMs).toISOString()}`;
  }
  return humanReadableCron(cron);
}
__name(displaySchedule, "displaySchedule");
var CronListInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "CronListInvocation");
  }
  getDescription() {
    return "";
  }
  async execute() {
    const scheduler = this.config.getCronScheduler();
    let fileTasks;
    try {
      fileTasks = await readCronTasks(this.config.getProjectRoot());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error listing cron jobs: ${message}`,
        returnDisplay: message,
        error: { message }
      };
    }
    const jobs = [
      ...fileTasks.map((task) => ({
        id: task.id,
        cron: task.cron,
        prompt: task.prompt,
        recurring: task.recurring,
        durable: true,
        ...task.name ? { name: task.name } : {},
        // A legacy guarded task (removed isolated mode + precondition) can never
        // fire — the scheduler skips it — so report it disabled here too rather
        // than as an enabled task that silently never runs.
        enabled: task.enabled !== false && !taskHasLegacyCondition(task)
      })),
      ...scheduler.list().filter((job) => !job.durable).map((job) => ({
        id: job.id,
        cron: job.cronExpr,
        prompt: job.prompt,
        recurring: job.recurring,
        durable: false,
        fireAtMs: job.fireAtMs
      }))
    ];
    if (jobs.length === 0) {
      const result = "No active cron jobs or loop wakeups.";
      return { llmContent: result, returnDisplay: result };
    }
    const llmLines = jobs.map((job) => {
      const type = job.recurring ? "recurring" : "one-shot";
      const durability = job.durable ? "durable" : "session-only";
      const status = job.enabled === false ? ", disabled" : "";
      const schedule = job.cron === "@wakeup" ? displaySchedule(job.cron, job.fireAtMs) : job.cron;
      const prompt = job.cron === "@wakeup" ? truncatePrompt(job.prompt) : job.prompt;
      const label = job.name ? `${job.name}: ` : "";
      return `${job.id} \u2014 ${schedule} (${type}) [${durability}${status}]: ${label}${prompt}`;
    });
    const llmContent = llmLines.join("\n");
    const displayLines = jobs.map(
      (job) => `${job.id} ${displaySchedule(job.cron, job.fireAtMs)} [${job.durable ? "durable" : "session-only"}${job.enabled === false ? ", disabled" : ""}]${job.name ? `: ${job.name}` : ""}`
    );
    const returnDisplay = displayLines.join("\n");
    return { llmContent, returnDisplay };
  }
};
var CronListTool = class _CronListTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _CronListTool.Name,
      ToolDisplayNames.CRON_LIST,
      `List all cron jobs scheduled via CronCreate (session-only, or durable under ${CRON_TASKS_DISPLAY_PATH}) and pending loop wakeups scheduled via LoopWakeup (always session-only).`,
      "other" /* Other */,
      {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      true,
      // isOutputMarkdown
      false,
      // canUpdateOutput
      true,
      // shouldDefer — low-frequency inspection tool
      false,
      // alwaysLoad
      "cron list show active scheduled tasks loop jobs wakeups"
    );
    this.config = config;
  }
  static {
    __name(this, "CronListTool");
  }
  static Name = ToolNames.CRON_LIST;
  createInvocation(params) {
    return new CronListInvocation(this.config, params);
  }
};
export {
  CronListTool
};
