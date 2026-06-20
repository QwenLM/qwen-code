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

const debugLogger = createDebugLogger('ENTER_PLAN_MODE');

export type EnterPlanModeParams = Record<string, never>;

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

    // Reveal the exit_plan_mode deferred tool so the model can call it
    // directly without needing to search for it first. This mirrors the
    // pattern in ToolSearch's select: path (reveal + setTools sync).
    try {
      const registry = this.config.getToolRegistry();
      const exitPlanModeName = ToolNames.EXIT_PLAN_MODE;
      const revealedBefore = registry.isDeferredToolRevealed(exitPlanModeName);
      if (!revealedBefore) {
        registry.revealDeferredTool(exitPlanModeName);
        const geminiClient = this.config.getGeminiClient();
        if (geminiClient) {
          try {
            await geminiClient.setTools();
          } catch (setErr) {
            // Rollback the reveal on setTools failure so the registry
            // stays consistent with the chat's declaration list.
            registry.unrevealDeferredTool(exitPlanModeName);
            debugLogger.error(
              `[EnterPlanModeTool] Failed to sync exit_plan_mode tool declaration: ${setErr instanceof Error ? setErr.message : String(setErr)}`,
            );
          }
        }
      }
    } catch (error) {
      // Non-fatal: log the failure but still return success for
      // entering plan mode. The model can use ToolSearch to find
      // exit_plan_mode if the reveal failed.
      debugLogger.warn(
        `[EnterPlanModeTool] Failed to reveal exit_plan_mode: ${error instanceof Error ? error.message : String(error)}`,
      );
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
