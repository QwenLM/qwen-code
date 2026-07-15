/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ToolCallConfirmationDetails,
  ToolPlanConfirmationDetails,
  ToolResult,
} from './tools.js';
import type { PermissionDecision } from '../permissions/types.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolConfirmationOutcome,
} from './tools.js';
import type { FunctionDeclaration } from '@google/genai';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  buildSubagentPlanToolBlockedResult,
  isPlanRequiredTeammateContext,
  isPlanLifecycleToolUnavailableInSubagent,
} from '../agents/runtime/subagent-plan-tool-policy.js';
import { getTeammateContext } from '../agents/team/identity.js';
import type { TeamPlanApprovalDecision } from '../agents/team/TeamManager.js';

const debugLogger = createDebugLogger('EXIT_PLAN_MODE');

export interface ExitPlanModeParams {
  plan: string;
  originalRequest?: string;
  researchSummary?: string;
  /** @deprecated Plan approval no longer uses an LLM review gate. */
  resolutionSummary?: string;
}

const exitPlanModeToolDescription = `Use this tool when you are in plan mode and have finished presenting your plan and are ready to code. This will prompt the user to exit plan mode.

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskUserQuestion first (in earlier phases)
- The plan parameter MUST contain your actual plan content — empty strings will be rejected
- Once your plan is finalized, use THIS tool to request approval

**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.

## Examples
1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.
`;

const exitPlanModeToolSchemaData: FunctionDeclaration = {
  name: 'exit_plan_mode',
  description: exitPlanModeToolDescription,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description:
          'The plan you came up with, that you want to run by the user for approval. Supports markdown. The plan should be pretty concise. Must contain your actual plan content — empty strings will be rejected.',
      },
      originalRequest: {
        type: 'string',
        description:
          'The original user request that prompted this plan. Restate it faithfully for a plan-required teammate leader.',
      },
      researchSummary: {
        type: 'string',
        description:
          'A brief summary of the investigation and key findings gathered during plan mode for a plan-required teammate leader.',
      },
    },
    required: ['plan'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
};

interface ExitApprovalSnapshot {
  plan: string;
  approvalModeRevision: number;
  prePlanMode: ApprovalMode;
}

interface ExitApproval {
  snapshot: ExitApprovalSnapshot;
  targetMode: ApprovalMode;
}

class ExitPlanModeToolInvocation extends BaseToolInvocation<
  ExitPlanModeParams,
  ToolResult
> {
  private approval?: ExitApproval;

  constructor(
    private readonly config: Config,
    params: ExitPlanModeParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return 'Plan:';
  }

  override requiresUserInteraction(): boolean {
    return (
      !isPlanRequiredTeammateContext() &&
      !isPlanLifecycleToolUnavailableInSubagent(ToolNames.EXIT_PLAN_MODE)
    );
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    if (
      isPlanRequiredTeammateContext() ||
      isPlanLifecycleToolUnavailableInSubagent(ToolNames.EXIT_PLAN_MODE)
    ) {
      return 'allow';
    }
    return this.config.getApprovalMode() === ApprovalMode.PLAN ? 'ask' : 'deny';
  }

  override async getConfirmationDetails(
    abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    if (isPlanRequiredTeammateContext()) {
      return super.getConfirmationDetails(abortSignal);
    }
    if (isPlanLifecycleToolUnavailableInSubagent(ToolNames.EXIT_PLAN_MODE)) {
      return super.getConfirmationDetails(abortSignal);
    }
    if (this.config.getApprovalMode() !== ApprovalMode.PLAN) {
      throw new Error('Cannot request plan approval outside plan mode.');
    }

    const snapshot: ExitApprovalSnapshot = {
      plan: this.params.plan,
      approvalModeRevision: this.config.getApprovalModeRevision(),
      prePlanMode: this.config.getPrePlanMode(),
    };
    this.approval = undefined;

    const details: ToolPlanConfirmationDetails = {
      type: 'plan',
      title: 'Would you like to proceed?',
      hideAlwaysAllow: true,
      plan: snapshot.plan,
      prePlanMode: snapshot.prePlanMode,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        switch (outcome) {
          case ToolConfirmationOutcome.RestorePrevious:
            this.approval = {
              snapshot,
              targetMode: snapshot.prePlanMode,
            };
            break;
          case ToolConfirmationOutcome.ProceedAlways:
            this.approval = {
              snapshot,
              targetMode: ApprovalMode.AUTO_EDIT,
            };
            break;
          case ToolConfirmationOutcome.ProceedOnce:
            this.approval = {
              snapshot,
              targetMode: ApprovalMode.DEFAULT,
            };
            break;
          case ToolConfirmationOutcome.Cancel:
            this.approval = undefined;
            break;
          default:
            this.approval = undefined;
            throw new Error(
              `Invalid plan approval outcome: ${String(outcome)}`,
            );
        }
      },
    };

    return details;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    if (isPlanLifecycleToolUnavailableInSubagent(ToolNames.EXIT_PLAN_MODE)) {
      return buildSubagentPlanToolBlockedResult(
        ToolNames.EXIT_PLAN_MODE,
        'ExitPlanModeTool',
        debugLogger,
      );
    }

    const { plan, originalRequest, researchSummary } = this.params;
    if (isPlanRequiredTeammateContext()) {
      return this.executePlanRequiredTeammate(
        plan,
        originalRequest,
        researchSummary,
        signal,
      );
    }

    const approval = this.approval;
    if (!approval) {
      return this.errorResult(
        'Plan execution was not approved. Remaining in plan mode.',
      );
    }
    const { snapshot, targetMode } = approval;
    if (signal.aborted) {
      return this.errorResult(
        'Plan exit was cancelled. Remaining in plan mode.',
      );
    }
    if (
      this.config.getApprovalMode() !== ApprovalMode.PLAN ||
      this.config.getApprovalModeRevision() !== snapshot.approvalModeRevision
    ) {
      return this.errorResult(
        'Plan approval is stale because the approval mode changed. No action was taken.',
      );
    }

    try {
      this.config.setApprovalMode(targetMode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLogger.error(
        `[ExitPlanModeTool] Failed to set approval mode to "${targetMode}": ${message}`,
      );
      return this.errorResult(
        `Failed to exit plan mode: ${message}. Remaining in plan mode.`,
      );
    }

    this.savePlanBestEffort(snapshot.plan);
    return {
      llmContent:
        'User approved. You can now start coding. Start with updating your todo list if applicable.',
      returnDisplay: {
        type: 'plan_summary',
        message: 'User approved.',
        plan: snapshot.plan,
      },
    };
  }

  private async executePlanRequiredTeammate(
    plan: string,
    originalRequest: string | undefined,
    researchSummary: string | undefined,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (this.config.getApprovalMode() !== ApprovalMode.PLAN) {
      return this.errorResult('Not in plan mode — no action taken.');
    }

    const approvalModeRevision = this.config.getApprovalModeRevision();
    const teammate = getTeammateContext();
    const manager = this.config.getTeamManager();
    if (!teammate || !manager) {
      return this.errorResult(
        'Plan-required teammate approval is unavailable in this context.',
      );
    }

    let decision: TeamPlanApprovalDecision;
    try {
      decision = await manager.requestPlanApproval({
        teammateName: teammate.agentName,
        plan,
        originalRequest,
        researchSummary,
        signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.errorResult(
        `Failed to request leader plan approval: ${message}`,
      );
    }

    if (signal.aborted) {
      return this.errorResult(
        'Leader plan approval was cancelled. Remaining in plan mode.',
      );
    }
    if (
      this.config.getApprovalMode() !== ApprovalMode.PLAN ||
      this.config.getApprovalModeRevision() !== approvalModeRevision
    ) {
      return this.errorResult(
        'Leader plan approval is stale because the approval mode changed. No action was taken.',
      );
    }

    if (decision.action === 'reject') {
      const feedback = decision.message
        ? `\n\nLeader feedback:\n${decision.message}`
        : '';
      const llmContent =
        'Leader rejected the plan. Revise the plan based on the feedback and call exit_plan_mode again.' +
        feedback;
      return {
        llmContent,
        returnDisplay: {
          type: 'plan_summary',
          message: 'Leader rejected the plan.',
          plan: `${plan.trimEnd()}\n\n---\n\n${llmContent}`,
          rejected: true,
        },
      };
    }

    if (decision.targetMode === ApprovalMode.PLAN) {
      return this.errorResult(
        'Leader approval did not select an execution mode. Remaining in plan mode.',
      );
    }

    try {
      this.config.setApprovalMode(decision.targetMode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.errorResult(
        `Leader approved the plan, but failed to exit plan mode: ${message}.`,
      );
    }

    this.savePlanBestEffort(plan);
    const feedback = decision.message
      ? ` Leader note: ${decision.message}`
      : '';
    return {
      llmContent: `Leader approved.${feedback} You can now start coding. Start with updating your todo list if applicable.`,
      returnDisplay: {
        type: 'plan_summary',
        message: 'Leader approved.',
        plan,
      },
    };
  }

  private savePlanBestEffort(plan: string): void {
    try {
      this.config.savePlan(plan);
    } catch (error) {
      debugLogger.warn(
        `[ExitPlanModeTool] Failed to save plan to disk: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private errorResult(message: string): ToolResult {
    return {
      llmContent: message,
      returnDisplay: message,
      error: { message },
    };
  }
}

export class ExitPlanModeTool extends BaseDeclarativeTool<
  ExitPlanModeParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.EXIT_PLAN_MODE;

  constructor(private readonly config: Config) {
    super(
      ExitPlanModeTool.Name,
      ToolDisplayNames.EXIT_PLAN_MODE,
      exitPlanModeToolDescription,
      Kind.Think,
      exitPlanModeToolSchemaData.parametersJsonSchema as Record<
        string,
        unknown
      >,
      true,
      false,
      true,
      // Plan mode tells the model to call exit_plan_mode directly, so its schema
      // must always be declared instead of deferred (issue #5210).
      true,
    );
  }

  override validateToolParams(params: ExitPlanModeParams): string | null {
    if (
      !params.plan ||
      typeof params.plan !== 'string' ||
      params.plan.trim() === ''
    ) {
      return 'Parameter "plan" must be a non-empty string.';
    }
    return null;
  }

  protected createInvocation(params: ExitPlanModeParams) {
    return new ExitPlanModeToolInvocation(this.config, params);
  }
}
