// Force strict mode and setup for ESM
"use strict";
import {
  assertValidTaskId,
  listTasks,
  normalizeTaskId
} from "./chunk-PQQV3OBW.js";
import {
  sanitizeName
} from "./chunk-YVYK3JYU.js";
import "./chunk-MLXTMF7H.js";
import {
  getTeamName,
  resolveActiveTeamName
} from "./chunk-S6LOFUVP.js";
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

// packages/core/src/tools/task-list.ts
init_esbuild_shims();
var TaskListInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "TaskListInvocation");
  }
  getDescription() {
    const filters = [];
    if (this.params.status) {
      filters.push(`status=${this.params.status}`);
    }
    if (this.params.owner?.trim()) {
      filters.push(`owner=${this.params.owner}`);
    }
    if (this.params.blockedBy?.trim()) {
      filters.push(`blockedBy=${this.params.blockedBy}`);
    }
    return filters.length > 0 ? `List tasks (${filters.join(", ")})` : "List all tasks";
  }
  async execute() {
    const teamName = resolveActiveTeamName(
      this.config.getTeamContext()?.teamName
    );
    if (!teamName) {
      const msg = "No active team. Create a team first.";
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg }
      };
    }
    let ownerFilter;
    if (this.params.owner !== void 0 && this.params.owner.trim() !== "") {
      ownerFilter = sanitizeName(this.params.owner);
      if (!ownerFilter) {
        const msg = "Cannot filter by owner: owner must include at least one letter, number, or hyphen.";
        return {
          llmContent: msg,
          returnDisplay: msg,
          error: { message: msg }
        };
      }
    }
    let blockedByFilter;
    if (this.params.blockedBy?.trim()) {
      blockedByFilter = normalizeTaskId(this.params.blockedBy);
      if (blockedByFilter === void 0) {
        const msg = "Cannot filter by blockedBy: blockedBy must be a task ID, optionally prefixed with #.";
        return {
          llmContent: msg,
          returnDisplay: msg,
          error: { message: msg }
        };
      }
      try {
        assertValidTaskId(blockedByFilter);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          llmContent: msg,
          returnDisplay: msg,
          error: { message: msg }
        };
      }
    }
    const tasks = await listTasks(teamName, {
      status: this.params.status,
      owner: ownerFilter,
      blockedBy: blockedByFilter
    });
    if (tasks.length === 0) {
      const llmContent2 = "No tasks found.";
      return { llmContent: llmContent2, returnDisplay: llmContent2 };
    }
    const lines = tasks.map(
      (t) => `#${t.id} [${t.status}]` + (t.owner ? ` @${t.owner}` : "") + ` \u2014 ${t.subject}`
    );
    const manager = this.config.getTeamManager();
    if (manager && !getTeamName()) {
      try {
        const msgs = await manager.getLeaderMessages();
        if (msgs.length > 0) {
          lines.push("");
          lines.push("--- Teammate messages ---");
          for (const wrapped of manager.formatLeaderEnvelope(msgs)) {
            lines.push(wrapped);
          }
        }
      } catch {
      }
      if (manager.hasActiveTeammates()) {
        lines.push("");
        lines.push(
          "NOTE: Teammates are still working. Their results will be delivered as messages \u2014 do NOT call task_list again to check. End your turn and wait for teammate messages."
        );
      }
    }
    const llmContent = lines.join("\n");
    const display = {
      type: "task_list",
      tasks: tasks.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        owner: t.owner
      }))
    };
    return { llmContent, returnDisplay: display };
  }
};
var TaskListTool = class _TaskListTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _TaskListTool.Name,
      ToolDisplayNames.TASK_LIST,
      "List tasks in the team task list. All filter parameters are optional.",
      "read" /* Read */,
      {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed"],
            description: "Filter by task status."
          },
          owner: {
            type: "string",
            description: "Filter by owner agent name."
          },
          blockedBy: {
            type: "string",
            description: "Filter for tasks blocked by this task ID."
          }
        },
        additionalProperties: false
      }
    );
    this.config = config;
  }
  static {
    __name(this, "TaskListTool");
  }
  static Name = ToolNames.TASK_LIST;
  createInvocation(params) {
    return new TaskListInvocation(this.config, params);
  }
};
export {
  TaskListTool
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
