/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import fs from 'node:fs';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  type PayloadResult,
  type ToolResult,
  Kind,
} from './tools.js';
import type { Config } from '../config/config.js';
import {
  ENTER_PLAN_MODE_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
} from './tool-names.js';
import { CORE_TOOL_SET } from './definitions/coreTools.js';
import { runLogger } from '../utils/runLogger.js';

export interface EnterPlanModeParams {
  reason?: string;
}

export class EnterPlanModeTool extends BaseDeclarativeTool<
  EnterPlanModeParams,
  ToolResult
> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  static readonly Name = ENTER_PLAN_MODE_TOOL_NAME;

  constructor(private config: Config) {
    super(
      EnterPlanModeTool.Name,
      'Enter Plan Mode',
      CORE_TOOL_SET.EnterPlanMode.description!,
      Kind.Plan,
      CORE_TOOL_SET.EnterPlanMode.parametersJsonSchema,
    );
  }

  protected createInvocation(
    params: EnterPlanModeParams,
    toolName: string,
    toolDisplayName: string,
  ): EnterPlanModeInvocation {
    return new EnterPlanModeInvocation(
      params,
      toolName,
      toolDisplayName,
      this.config,
    );
  }

  // === Permission Pipeline methods ===

  /**
   * Entering plan mode is a workflow decision about how the session proceeds,
   * not an action whose risk a mode can weigh, so the dialog must survive
   * bypassPermissions and auto. An explicit allow rule still opts out, because
   * a matched rule resolves to allow before the mode layer sees an ask.
   */
  override requiresUserInteraction(): boolean {
    return true;
  }
}

export class EnterPlanModeInvocation extends BaseToolInvocation<
  EnterPlanModeParams,
  ToolResult
> {
  constructor(
    params: EnterPlanModeParams,
    toolName: string,
    toolDisplayName: string,
    private config: Config,
  ) {
    super(params, toolName, toolDisplayName);
  }

  getDescription(): string {
    return this.params.reason || 'Initiating Plan Mode';
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    if (this.config.isPlanMode()) {
      return {
        llmContent: 'Already in plan mode.',
        returnDisplay: 'Already in plan mode.',
        toolUseResult: {
          summary: 'Already in plan mode.',
          payload: '',
        } satisfies PayloadResult,
      };
    }

    // Enter plan state via PlanStateManager (orthogonal to permission mode).
    this.config.planStateManager.enter();
    // Reset pre-approved prompts — they were authorized for the previous plan session only.
    this.config.resetPreApprovedPrompts?.();
    this.config.notifyPlanStateChanged();

    // Ensure plans directory exists so that the agent can write the plan file.
    const plansDir = this.config.storage.getPlansDir();
    try {
      fs.mkdirSync(plansDir, { recursive: true });
    } catch (e) {
      // Log error but don't fail; Write will try again later
      runLogger.error(`Failed to create plans directory: ${plansDir}`, e);
    }

    // Derive the slug-based plan file path so the model has a concrete target.
    const planFilePath = this.config.planStateManager.getPlanFilePath(
      plansDir,
      this.config.getSessionId(),
    );

    const reasonSuffix = this.params.reason
      ? `\n\nReason: ${this.params.reason}`
      : '';
    const displayText = this.params.reason
      ? `Switching to Plan mode: ${this.params.reason}`
      : 'Switching to Plan mode';
    const toolUseResult: PayloadResult = {
      summary: displayText,
      payload: planFilePath,
    };

    return {
      llmContent:
        `Entered plan mode.${reasonSuffix}\n\n` +
        `You should now focus on exploring the codebase and designing an implementation approach.\n\n` +
        `In plan mode, you should:\n` +
        `1. Thoroughly explore the codebase to understand existing patterns\n` +
        `2. Identify similar features and architectural approaches\n` +
        `3. Consider multiple approaches and their trade-offs\n` +
        `4. Use ${ASK_USER_TOOL_NAME} if you need to clarify the approach\n` +
        `5. Design a concrete implementation strategy\n` +
        `6. When ready, use ${EXIT_PLAN_MODE_TOOL_NAME} to present your plan for approval\n\n` +
        `**Plan file**: Write your plan to ${planFilePath}\n\n` +
        `Remember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.`,
      returnDisplay: displayText,
      toolUseResult,
    };
  }
}
