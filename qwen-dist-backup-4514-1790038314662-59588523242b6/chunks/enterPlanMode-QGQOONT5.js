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
  buildSubagentPlanToolBlockedResult,
  isPlanLifecycleToolUnavailableInSubagent
} from "./chunk-B5WYAQ4I.js";
import "./chunk-JX6XHPTX.js";
import "./chunk-6C3D7BKK.js";
import "./chunk-ZAQM5T2X.js";
import "./chunk-MNU36NGH.js";
import {
  getPlanModeSystemReminder
} from "./chunk-B3HGO6BB.js";
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
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
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

// packages/core/src/tools/enterPlanMode.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("ENTER_PLAN_MODE");
var enterPlanModeToolDescription = `Use this tool only after the user explicitly asks to switch into plan mode or confirms they want plan mode. Entering plan mode is a privilege reduction, so it does not require user confirmation at execution time.

## When to Use This Tool
Use this tool when the user has opted into plan mode for a task that should be read-only while the plan is formed, such as multi-file changes, design choices, or ambiguous requirements.

## When NOT to Use This Tool
Do not use this tool just because a task involves planning, is complex, or requires investigation. In the current mode, you can still think, inspect files, ask clarifying questions, and present a plan without switching modes.

## Important
If plan mode seems helpful but the user has not asked for it, ask first. Do NOT use this tool if the user has explicitly asked you not to use plan mode.`;
var enterPlanModeToolSchemaData = {
  name: "enter_plan_mode",
  description: enterPlanModeToolDescription,
  parametersJsonSchema: {
    type: "object",
    properties: {
      userRequested: {
        type: "boolean",
        description: "Set to true ONLY when the user explicitly asked for plan mode in this turn, or explicitly confirmed they want it. Leave unset (or false) when you are deciding to plan on your own without the user asking. In YOLO mode, an explicit user request will not take effect unless this is true."
      }
    },
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#"
  }
};
var EnterPlanModeToolInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "EnterPlanModeToolInvocation");
  }
  getDescription() {
    return "Enter plan mode";
  }
  /**
   * Entering plan mode lowers privileges, so it is always allowed without a
   * confirmation prompt.
   */
  async getDefaultPermission() {
    return "allow";
  }
  async execute(_signal) {
    if (isPlanLifecycleToolUnavailableInSubagent(ToolNames.ENTER_PLAN_MODE)) {
      return buildSubagentPlanToolBlockedResult(
        ToolNames.ENTER_PLAN_MODE,
        "EnterPlanModeTool",
        debugLogger
      );
    }
    if (this.config.getApprovalMode() === "yolo" /* YOLO */ && !this.params.userRequested) {
      debugLogger.info(
        "Blocked model-initiated plan entry from YOLO (userRequested=%s)",
        this.params.userRequested
      );
      return {
        llmContent: "Plan mode was not entered: the session is in YOLO mode, which the user explicitly chose for low-friction execution. Continue investigating and presenting your plan in the current mode without switching. If the user explicitly asked for plan mode in this turn, retry this tool call with userRequested: true.",
        returnDisplay: "Stayed in YOLO mode (plan mode not entered)."
      };
    }
    const isAcpMode = this.config.getExperimentalZedIntegration?.() || this.config.getInputFormat?.() === "stream-json" /* STREAM_JSON */;
    if (!this.config.isInteractive() && !isAcpMode) {
      return {
        llmContent: "Cannot enter plan mode in non-interactive mode without ACP support. The gate exit paths require user interaction.",
        returnDisplay: "Plan mode unavailable in non-interactive mode."
      };
    }
    try {
      if (this.config.getApprovalMode() !== "plan" /* PLAN */) {
        this.config.setApprovalMode("plan" /* PLAN */);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      debugLogger.error(
        `[EnterPlanModeTool] Failed to set approval mode to plan: ${errorMessage}`
      );
      return {
        llmContent: `Failed to enter plan mode: ${errorMessage}`,
        returnDisplay: `Error entering plan mode: ${errorMessage}`
      };
    }
    try {
      const registry = this.config.getToolRegistry();
      const exitPlanModeName = ToolNames.EXIT_PLAN_MODE;
      const revealedBefore = registry.isDeferredToolRevealed(exitPlanModeName);
      if (!revealedBefore) {
        registry.revealDeferredTool(exitPlanModeName);
        const llmClient = this.config.getLlmClient();
        if (llmClient) {
          try {
            await llmClient.setTools();
          } catch (setErr) {
            registry.unrevealDeferredTool(exitPlanModeName);
            debugLogger.error(
              `[EnterPlanModeTool] Failed to sync exit_plan_mode tool declaration: ${setErr instanceof Error ? setErr.message : String(setErr)}`
            );
          }
        }
      }
    } catch (error) {
      debugLogger.warn(
        `[EnterPlanModeTool] Failed to reveal exit_plan_mode: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return {
      llmContent: getPlanModeSystemReminder(this.config.getSdkMode()),
      returnDisplay: "Entered plan mode."
    };
  }
};
var EnterPlanModeTool = class _EnterPlanModeTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _EnterPlanModeTool.Name,
      ToolDisplayNames.ENTER_PLAN_MODE,
      enterPlanModeToolDescription,
      "think" /* Think */,
      enterPlanModeToolSchemaData.parametersJsonSchema,
      true,
      // isOutputMarkdown
      false,
      // canUpdateOutput
      false,
      // shouldDefer — always visible so explicit plan-mode requests work
      false,
      // alwaysLoad
      "plan mode enter start"
    );
    this.config = config;
  }
  static {
    __name(this, "EnterPlanModeTool");
  }
  static Name = ToolNames.ENTER_PLAN_MODE;
  get maxOutputChars() {
    return Number.POSITIVE_INFINITY;
  }
  createInvocation(params) {
    return new EnterPlanModeToolInvocation(this.config, params);
  }
};
export {
  EnterPlanModeTool
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
