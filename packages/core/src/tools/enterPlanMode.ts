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
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('ENTER_PLAN_MODE');

export type EnterPlanModeParams = Record<string, never>;

const enterPlanModeToolDescription = `Use this tool to lower into plan mode before doing uncertain or complex work. Entering plan mode is a privilege reduction, so it does not require user confirmation.

## When to Use This Tool
Use this tool when the task is not yet clear enough to safely execute, for example when it requires multi-file changes, design choices, investigation before a plan can be summarized, or when requirements are ambiguous. While investigating, if complexity rises or you find yourself repeatedly needing to ask the user, enter plan mode and consolidate a plan.

## When NOT to Use This Tool
If the request is already clear, small, and low-risk, you may execute directly without entering plan mode. Do not make speculative small edits before you have thought the change through.

## Important
Do NOT use this tool if the user has explicitly asked you not to use plan mode.`;

const enterPlanModeToolSchemaData: FunctionDeclaration = {
  name: 'enter_plan_mode',
  description: enterPlanModeToolDescription,
  parametersJsonSchema: {
    type: 'object',
    properties: {},
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
    try {
      // Idempotent: only switch when not already in plan mode so we never
      // overwrite the saved prePlanMode.
      if (this.config.getApprovalMode() !== ApprovalMode.PLAN) {
        this.config.setApprovalMode(ApprovalMode.PLAN);
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
      false, // shouldDefer — always visible so the model can enter plan mode
      false, // alwaysLoad
      'plan mode enter start',
    );
  }

  protected createInvocation(params: EnterPlanModeParams) {
    return new EnterPlanModeToolInvocation(this.config, params);
  }
}
