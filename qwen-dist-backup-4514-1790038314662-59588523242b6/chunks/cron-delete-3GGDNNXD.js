// Force strict mode and setup for ESM
"use strict";
import {
  CRON_TASKS_DISPLAY_PATH,
  removeCronTasks
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

// packages/core/src/tools/cron-delete.ts
init_esbuild_shims();
var CronDeleteInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "CronDeleteInvocation");
  }
  getDescription() {
    return this.params.id;
  }
  async execute() {
    const scheduler = this.config.getCronScheduler();
    let deleted;
    try {
      deleted = await scheduler.delete(this.params.id);
      if (!deleted) {
        deleted = await removeCronTasks(this.config.getProjectRoot(), [
          this.params.id
        ]) > 0;
      }
    } catch (error) {
      const message = `Failed to cancel job ${this.params.id}: ${getErrorMessage(error)}`;
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message }
      };
    }
    if (deleted) {
      const llmContent = `Cancelled job ${this.params.id}.`;
      const returnDisplay = `Cancelled ${this.params.id}`;
      return { llmContent, returnDisplay };
    } else {
      const result = `Job ${this.params.id} not found.`;
      return {
        llmContent: result,
        returnDisplay: result,
        error: { message: result }
      };
    }
  }
};
var CronDeleteTool = class _CronDeleteTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _CronDeleteTool.Name,
      ToolDisplayNames.CRON_DELETE,
      `Stop or cancel a cron job previously scheduled with CronCreate, or a pending loop wakeup scheduled with LoopWakeup. Removes cron jobs from the in-memory session store or from ${CRON_TASKS_DISPLAY_PATH} (durable jobs).`,
      "other" /* Other */,
      {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Job ID returned by CronCreate or LoopWakeup."
          }
        },
        required: ["id"],
        additionalProperties: false
      },
      true,
      // isOutputMarkdown
      false,
      // canUpdateOutput
      true,
      // shouldDefer — only needed after CronCreate/CronList
      false,
      // alwaysLoad
      "cron delete cancel remove stop clear scheduled task loop wakeup"
    );
    this.config = config;
  }
  static {
    __name(this, "CronDeleteTool");
  }
  static Name = ToolNames.CRON_DELETE;
  createInvocation(params) {
    return new CronDeleteInvocation(this.config, params);
  }
};
export {
  CronDeleteTool
};
