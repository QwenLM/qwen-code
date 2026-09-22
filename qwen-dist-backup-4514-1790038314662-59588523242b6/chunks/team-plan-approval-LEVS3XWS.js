// Force strict mode and setup for ESM
"use strict";
import "./chunk-MRTRBONQ.js";
import "./chunk-GOFAQQZA.js";
import "./chunk-65I7S4Z3.js";
import "./chunk-HEOH7JZY.js";
import "./chunk-TWPJO254.js";
import "./chunk-CQ35AJ4Z.js";
import "./chunk-4YS7RMCB.js";
import "./chunk-PQQV3OBW.js";
import "./chunk-ANKISCKU.js";
import "./chunk-4SZ2636R.js";
import "./chunk-5EZRLTLQ.js";
import "./chunk-QHWCP53L.js";
import "./chunk-C4FISGDN.js";
import "./chunk-O6GEWCJA.js";
import "./chunk-KS6F6LZQ.js";
import "./chunk-6PVPNMXU.js";
import "./chunk-OB57Y2WH.js";
import "./chunk-IMV5DBIP.js";
import "./chunk-IWMYX5LB.js";
import "./chunk-QJNDUTOL.js";
import "./chunk-QPTE6BKL.js";
import "./chunk-U6H3XTFA.js";
import "./chunk-ACHCT36C.js";
import "./chunk-CHEIIBT3.js";
import "./chunk-GHG4PQY2.js";
import "./chunk-YVYK3JYU.js";
import "./chunk-Q5N5NEVT.js";
import "./chunk-ADN5KESB.js";
import "./chunk-SK3RZOPS.js";
import "./chunk-EVZT24AF.js";
import "./chunk-ELRMZTPF.js";
import {
  isSubagentLikeExecutionContext
} from "./chunk-B5WYAQ4I.js";
import "./chunk-JX6XHPTX.js";
import "./chunk-6C3D7BKK.js";
import "./chunk-ZAQM5T2X.js";
import "./chunk-MNU36NGH.js";
import "./chunk-B3HGO6BB.js";
import "./chunk-AUFTA63J.js";
import "./chunk-SATGWSS6.js";
import "./chunk-MLXTMF7H.js";
import "./chunk-BQMSZSG6.js";
import "./chunk-WFNEY5G7.js";
import "./chunk-5FHOPPLZ.js";
import "./chunk-S6LOFUVP.js";
import "./chunk-BKVPLSEI.js";
import "./chunk-WNM6BA7E.js";
import "./chunk-S7UQ3V2H.js";
import "./chunk-QE36VXWP.js";
import "./chunk-2A6RZKP2.js";
import "./chunk-WDVSRQIQ.js";
import "./chunk-GXNXX7A2.js";
import "./chunk-IITTKFWM.js";
import "./chunk-Z72PLR74.js";
import "./chunk-NUQ4GK5I.js";
import "./chunk-KP2FHIFR.js";
import "./chunk-TLS6QN2S.js";
import "./chunk-NAVJD2PQ.js";
import "./chunk-KKPIFWTZ.js";
import "./chunk-NFC4WTY2.js";
import "./chunk-YSD6IY6F.js";
import "./chunk-DJ2GSRLV.js";
import "./chunk-MS4SXNJ6.js";
import "./chunk-GVTAFLWB.js";
import "./chunk-KKGSJZWK.js";
import "./chunk-5ETULJLP.js";
import "./chunk-VGC4I5JJ.js";
import "./chunk-RVT5L74D.js";
import "./chunk-HD7O6WLV.js";
import "./chunk-25FMWESU.js";
import "./chunk-CFMZLE3L.js";
import "./chunk-43QUA4MC.js";
import "./chunk-WZAD4ZNJ.js";
import "./chunk-EKBQJ627.js";
import "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import "./chunk-CA63HYHU.js";
import "./chunk-SBP43AO6.js";
import "./chunk-HHJLM3WQ.js";
import "./chunk-B3XJFEEH.js";
import "./chunk-74TONY4F.js";
import "./chunk-ZRQGTRHA.js";
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
import "./chunk-UKMWZ5NS.js";
import "./chunk-75DOP5OR.js";
import "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
import "./chunk-MATEIJZF.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/team-plan-approval.ts
init_esbuild_shims();
var TeamPlanApprovalInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "TeamPlanApprovalInvocation");
  }
  getDescription() {
    return `${this.params.action} teammate plan ${this.params.request_id}`;
  }
  async getDefaultPermission() {
    return "allow";
  }
  async execute(_signal) {
    if (isSubagentLikeExecutionContext()) {
      const msg = "Only the team leader can approve teammate plans.";
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg }
      };
    }
    const manager = this.config.getTeamManager();
    if (!manager) {
      const msg = "No active team. Create a team first.";
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg }
      };
    }
    try {
      if (this.params.action === "approve") {
        const targetMode = this.getApprovalTargetMode();
        if (targetMode === "plan" /* PLAN */) {
          const msg3 = "Cannot approve teammate plan while the leader is still in plan mode. Exit the leader plan mode first; the request remains pending.";
          return {
            llmContent: msg3,
            returnDisplay: msg3,
            error: { message: msg3 }
          };
        }
        manager.resolvePlanApprovalRequest(this.params.request_id, {
          action: "approve",
          targetMode,
          message: this.params.message
        });
        const msg2 = `Teammate plan request "${this.params.request_id}" approved.`;
        return { llmContent: msg2, returnDisplay: msg2 };
      }
      manager.resolvePlanApprovalRequest(this.params.request_id, {
        action: "reject",
        message: this.params.message
      });
      const msg = `Teammate plan request "${this.params.request_id}" rejected.`;
      return { llmContent: msg, returnDisplay: msg };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Failed to resolve teammate plan approval: ${message}`,
        returnDisplay: `Plan approval failed: ${message}`,
        error: { message }
      };
    }
  }
  getApprovalTargetMode() {
    const current = this.config.getApprovalMode();
    if (current === "auto" /* AUTO */) {
      return "default" /* DEFAULT */;
    }
    if (!this.config.isTrustedFolder() && (current === "auto-edit" /* AUTO_EDIT */ || current === "yolo" /* YOLO */)) {
      return "default" /* DEFAULT */;
    }
    return current;
  }
};
var TeamPlanApprovalTool = class _TeamPlanApprovalTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _TeamPlanApprovalTool.Name,
      ToolDisplayNames.TEAM_PLAN_APPROVAL,
      "Approve or reject a plan submitted by a plan-required teammate. Only the team leader can use this tool.",
      "think" /* Think */,
      {
        type: "object",
        properties: {
          request_id: {
            type: "string",
            description: "The request id from the team plan approval request."
          },
          action: {
            type: "string",
            enum: ["approve", "reject"],
            description: "Approve or reject the teammate plan."
          },
          message: {
            type: "string",
            description: "Optional feedback for the teammate, especially when rejecting."
          }
        },
        required: ["request_id", "action"],
        additionalProperties: false
      }
    );
    this.config = config;
  }
  static {
    __name(this, "TeamPlanApprovalTool");
  }
  static Name = ToolNames.TEAM_PLAN_APPROVAL;
  validateToolParams(params) {
    if (!params.request_id || typeof params.request_id !== "string" || params.request_id.trim() === "") {
      return 'Parameter "request_id" must be a non-empty string.';
    }
    if (params.action !== "approve" && params.action !== "reject") {
      return 'Parameter "action" must be "approve" or "reject".';
    }
    if (params.message !== void 0 && typeof params.message !== "string") {
      return 'Parameter "message" must be a string when set.';
    }
    return null;
  }
  createInvocation(params) {
    return new TeamPlanApprovalInvocation(this.config, params);
  }
};
export {
  TeamPlanApprovalTool
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
