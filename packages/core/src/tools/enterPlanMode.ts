/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolResult } from './tools.js';
import type { PermissionDecision } from '../permissions/types.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { FunctionDeclaration } from '@google/genai';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import { InputFormat } from '../output/types.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  buildSubagentPlanToolBlockedResult,
  isPlanLifecycleToolUnavailableInSubagent,
} from '../agents/runtime/subagent-plan-tool-policy.js';

const debugLogger = createDebugLogger('ENTER_PLAN_MODE');

export interface EnterPlanModeParams {
  /**
   * Set to `true` only when the user explicitly asked for plan mode in this
   * turn (or explicitly confirmed they want it). Distinguishes a genuine
   * user-requested entry from the model deciding to plan on its own, which
   * matters when the session is in YOLO mode — see the guard in `execute()`.
   */
  userRequested?: boolean;
}

const enterPlanModeToolDescription = `Use this tool only after the user explicitly asks to switch into plan mode or confirms they want plan mode. Entering plan mode is a privilege reduction, so it does not require user confirmation at execution time.

## When to Use This Tool
Use this tool when the user has opted into plan mode for a task that should be read-only while the plan is formed, such as multi-file changes, design choices, or ambiguous requirements.

## When NOT to Use This Tool
Do not use this tool just because a task involves planning, is complex, or requires investigation. In the current mode, you can still think, inspect files, ask clarifying questions, and present a plan without switching modes.

## Important
If plan mode seems helpful but the user has not asked for it, ask first. Do NOT use this tool if the user has explicitly asked you not to use plan mode.`;

const enterPlanModeToolSchemaData: FunctionDeclaration = {
  name: 'enter_plan_mode',
  description: enterPlanModeToolDescription,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      userRequested: {
        type: 'boolean',
        description:
          'Set to true ONLY when the user explicitly asked for plan mode in this turn, or explicitly confirmed they want it. Leave unset (or false) when you are deciding to plan on your own without the user asking. In YOLO mode, an explicit user request will not take effect unless this is true.',
      },
    },
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
};

class EnterPlanModeToolInvocation extends BaseToolInvocation<
  EnterPlanModeParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: EnterPlanModeParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return 'Enter plan mode';
  }

  /**
   * Entering plan mode lowers privileges, so it is always allowed without a
   * confirmation prompt.
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'allow';
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    if (isPlanLifecycleToolUnavailableInSubagent(ToolNames.ENTER_PLAN_MODE)) {
      return buildSubagentPlanToolBlockedResult(
        ToolNames.ENTER_PLAN_MODE,
        'EnterPlanModeTool',
        debugLogger,
      );
    }

    // A model-initiated entry from YOLO (not requested by the user this
    // turn) is a no-op. The user explicitly chose YOLO for low-friction
    // execution; silently switching to the read-only Plan mode surprises
    // them and then blocks the reads/writes they expected to proceed
    // (#5970). This tool is ALSO the only door into plan mode in
    // headless/ACP sessions — `/plan` is `interactive`-only and there is no
    // Shift+Tab there — so a blanket YOLO guard would make a genuine,
    // explicit user request unreachable in those sessions. `userRequested`
    // lets the model tell the two apart: only gate the no-op when the
    // entry is NOT user-requested. Keep the current mode and tell the
    // model to continue planning without switching, or to retry with
    // `userRequested: true` if the user did explicitly ask.
    if (
      this.config.getApprovalMode() === ApprovalMode.YOLO &&
      !this.params.userRequested
    ) {
      debugLogger.info(
        'Blocked model-initiated plan entry from YOLO (userRequested=%s)',
        this.params.userRequested,
      );
      return {
        llmContent:
          'Plan mode was not entered: the session is in YOLO mode, which the user explicitly chose for low-friction execution. Continue investigating and presenting your plan in the current mode without switching. If the user explicitly asked for plan mode in this turn, retry this tool call with userRequested: true.',
        returnDisplay: 'Stayed in YOLO mode (plan mode not entered).',
      };
    }

    // In headless (non-interactive) mode without ACP support, the gate
    // exit paths require user interaction that cannot be fulfilled.
    const isAcpMode =
      this.config.getExperimentalZedIntegration?.() ||
      this.config.getInputFormat?.() === InputFormat.STREAM_JSON;

    if (!this.config.isInteractive() && !isAcpMode) {
      return {
        llmContent:
          'Cannot enter plan mode in non-interactive mode without ACP support. The gate exit paths require user interaction.',
        returnDisplay: 'Plan mode unavailable in non-interactive mode.',
      };
    }

    try {
      // Idempotent: only switch when not already in plan mode so we never
      // overwrite the saved prePlanMode.
      // Mark this entry as model-initiated so exit_plan_mode runs the Plan
      // Approval Gate for AUTO/YOLO sessions. User-initiated entries (Shift+Tab,
      // /plan) leave this false and always get the confirmation dialog (#5574).
      if (this.config.getApprovalMode() !== ApprovalMode.PLAN) {
        this.config.setApprovalMode(ApprovalMode.PLAN, {
          enteredByModel: true,
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      debugLogger.error(
        `[EnterPlanModeTool] Failed to set approval mode to plan: ${errorMessage}`,
      );
      return {
        llmContent: `Failed to enter plan mode: ${errorMessage}`,
        returnDisplay: `Error entering plan mode: ${errorMessage}`,
      };
    }

    return {
      llmContent:
        'Plan mode is now active. Continue with read-only investigation, ask the user when needed, and use exit_plan_mode when the plan is ready.',
      returnDisplay: 'Entered plan mode.',
    };
  }
}

export class EnterPlanModeTool extends BaseDeclarativeTool<
  EnterPlanModeParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.ENTER_PLAN_MODE;

  constructor(private readonly config: Config) {
    super(
      EnterPlanModeTool.Name,
      ToolDisplayNames.ENTER_PLAN_MODE,
      enterPlanModeToolDescription,
      Kind.Think,
      enterPlanModeToolSchemaData.parametersJsonSchema as Record<
        string,
        unknown
      >,
      true, // isOutputMarkdown
      false, // canUpdateOutput
      false, // shouldDefer — always visible so explicit plan-mode requests work
      false, // alwaysLoad
      'plan mode enter start',
    );
  }

  protected createInvocation(params: EnterPlanModeParams) {
    return new EnterPlanModeToolInvocation(this.config, params);
  }
}
