// Force strict mode and setup for ESM
"use strict";
import {
  getPlanRequiredTeammatePreApprovalMessage,
  isPlanRequiredTeammateAwaitingApproval,
  isSubagentLikeExecutionContext
} from "./chunk-B5WYAQ4I.js";
import "./chunk-JX6XHPTX.js";
import "./chunk-5FHOPPLZ.js";
import "./chunk-S6LOFUVP.js";
import "./chunk-2A6RZKP2.js";
import "./chunk-WDVSRQIQ.js";
import "./chunk-GXNXX7A2.js";
import "./chunk-IITTKFWM.js";
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

// packages/core/src/tools/request-shutdown.ts
init_esbuild_shims();
var RequestShutdownInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "RequestShutdownInvocation");
  }
  getDescription() {
    return `Request shutdown for "${this.params.to}"`;
  }
  /**
   * Shutdown is cooperative — the teammate may reply `shutdown_rejected` — but
   * it still ends another agent's participation and releases its task
   * ownership. Keep the L4 default at 'ask' so AUTO routes through the
   * classifier rather than short-circuiting, matching `send_message`.
   */
  async getDefaultPermission() {
    return "ask";
  }
  async execute(_signal) {
    if (isPlanRequiredTeammateAwaitingApproval(this.config)) {
      const msg = getPlanRequiredTeammatePreApprovalMessage(
        ToolNames.REQUEST_SHUTDOWN
      );
      return { llmContent: msg, returnDisplay: msg, error: { message: msg } };
    }
    if (isSubagentLikeExecutionContext()) {
      const msg = "Only the team leader can request shutdowns.";
      return { llmContent: msg, returnDisplay: msg, error: { message: msg } };
    }
    const teamManager = this.config.getTeamManager();
    if (!teamManager) {
      const msg = "No active team. Create a team before requesting a shutdown.";
      return { llmContent: msg, returnDisplay: msg, error: { message: msg } };
    }
    const to = this.params.to?.trim();
    if (!to) {
      const msg = 'Recipient "to" is required.';
      return { llmContent: msg, returnDisplay: msg, error: { message: msg } };
    }
    try {
      await teamManager.requestShutdown(to);
      const msg = `Shutdown requested for "${to}".`;
      return { llmContent: msg, returnDisplay: msg };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { llmContent: msg, returnDisplay: msg, error: { message: msg } };
    }
  }
};
var RequestShutdownTool = class extends BaseDeclarativeTool {
  constructor(config) {
    super(
      ToolNames.REQUEST_SHUTDOWN,
      ToolDisplayNames.REQUEST_SHUTDOWN,
      'Ask a teammate to finish its current work and wind down. The teammate replies "shutdown_approved" or "shutdown_rejected: <reason>". Once a shutdown is pending the teammate is excluded from automatic task assignment. Leader-only. To send a teammate ordinary text, use send_message instead.',
      "other" /* Other */,
      {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "Teammate name to wind down (bare name, no @)."
          }
        },
        required: ["to"],
        additionalProperties: false
      },
      true,
      // isOutputMarkdown
      false,
      // canUpdateOutput
      true,
      // shouldDefer — shutting a teammate down is infrequent
      false,
      // alwaysLoad
      "shutdown teammate team stop wind down finish"
    );
    this.config = config;
  }
  static {
    __name(this, "RequestShutdownTool");
  }
  createInvocation(params) {
    return new RequestShutdownInvocation(this.config, params);
  }
  /**
   * The recipient is the whole action — forward it so the classifier can see
   * which teammate is being wound down.
   */
  toAutoClassifierInput(params) {
    return { to: params.to };
  }
};
export {
  RequestShutdownTool
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
