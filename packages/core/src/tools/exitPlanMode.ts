/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolPlanConfirmationDetails, ToolResult } from './tools.js';
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
import { isAutonomousPrePlanMode } from '../plan-gate/state.js';
import {
  runPlanApprovalGate,
  formatBlockedResponse,
  formatNeedsUserResponse,
  formatCapEscalationResponse,
  formatUnavailableResponse,
  formatApprovedNotes,
} from '../plan-gate/planApprovalGate.js';
import type { EvidenceBundle } from '../plan-gate/types.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('EXIT_PLAN_MODE');

export interface ExitPlanModeParams {
  plan: string;
  originalRequest?: string;
  researchSummary?: string;
  resolutionSummary?: string;
}

const exitPlanModeToolDescription = `Use this tool when you are in plan mode and have finished presenting your plan and are ready to code. This will prompt the user to exit plan mode.

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskUserQuestion first (in earlier phases)
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
          'The plan you came up with, that you want to run by the user for approval. Supports markdown. The plan should be pretty concise.',
      },
      originalRequest: {
        type: 'string',
        description:
          'The original user request that prompted this plan. Restate it faithfully — it is the primary input for the plan approval gate.',
      },
      researchSummary: {
        type: 'string',
        description:
          'A brief summary of the investigation and key findings gathered during plan mode, including important file paths, symbols, and constraints discovered.',
      },
      resolutionSummary: {
        type: 'string',
        description:
          'When re-submitting after a gate review blocked the plan, include a summary referencing each finding id (e.g. GF-1) and how you addressed it.',
      },
    },
    required: ['plan'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
};

class ExitPlanModeToolInvocation extends BaseToolInvocation<
  ExitPlanModeParams,
  ToolResult
> {
  private wasApproved = false;

  constructor(
    private readonly config: Config,
    params: ExitPlanModeParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return 'Plan:';
  }

  /**
   * For AUTO/YOLO pre-plan modes (without user takeover), the gate runs
   * inside execute() and no user confirmation prompt is needed. For
   * DEFAULT/AUTO_EDIT (or after user takeover), the existing confirmation
   * UI handles approval.
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    const prePlanMode = this.config.getPrePlanMode();
    const gateState = this.config.getPlanGateState();
    if (
      isAutonomousPrePlanMode(prePlanMode) &&
      gateState?.gateMode !== 'user_takeover'
    ) {
      return 'allow';
    }
    return 'ask';
  }

  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolPlanConfirmationDetails> {
    const prePlanMode = this.config.getPrePlanMode();
    const details: ToolPlanConfirmationDetails = {
      type: 'plan',
      title: 'Would you like to proceed?',
      plan: this.params.plan,
      prePlanMode,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        switch (outcome) {
          case ToolConfirmationOutcome.RestorePrevious:
            this.wasApproved = true;
            this.setApprovalModeSafely(prePlanMode);
            break;
          case ToolConfirmationOutcome.ProceedAlways:
            this.wasApproved = true;
            this.setApprovalModeSafely(ApprovalMode.AUTO_EDIT);
            break;
          case ToolConfirmationOutcome.ProceedOnce:
            this.wasApproved = true;
            this.setApprovalModeSafely(ApprovalMode.DEFAULT);
            break;
          case ToolConfirmationOutcome.Cancel:
            this.wasApproved = false;
            this.setApprovalModeSafely(ApprovalMode.PLAN);
            break;
          default:
            this.wasApproved = true;
            this.setApprovalModeSafely(ApprovalMode.DEFAULT);
            break;
        }
      },
    };

    return details;
  }

  private setApprovalModeSafely(mode: ApprovalMode): void {
    try {
      this.config.setApprovalMode(mode);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      debugLogger.error(
        `[ExitPlanModeTool] Failed to set approval mode to "${mode}": ${errorMessage}`,
      );
    }
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const { plan, originalRequest, researchSummary, resolutionSummary } =
      this.params;
    const prePlanMode = this.config.getPrePlanMode();
    const gateState = this.config.getPlanGateState();

    try {
      // ── Path A: user_override from cap escalation ──────────────
      if (gateState?.gateMode === 'user_override') {
        return this.approveAndRestore(plan, prePlanMode, 'Gate user override');
      }

      // ── Path B: AUTO/YOLO gate path (no takeover) ──────────────
      if (
        isAutonomousPrePlanMode(prePlanMode) &&
        gateState &&
        gateState.gateMode !== 'user_takeover'
      ) {
        // Update the gate state with the latest resolution summary
        if (resolutionSummary) {
          gateState.lastResolutionSummary = resolutionSummary;
        }

        const bundle: EvidenceBundle = {
          originalRequest: originalRequest ?? '(not provided)',
          plan,
          researchSummary,
          resolutionSummary: gateState.lastResolutionSummary,
          lastFindings:
            gateState.lastFindings.length > 0
              ? gateState.lastFindings
              : undefined,
        };

        const decision = await runPlanApprovalGate(this.config, bundle, signal);

        switch (decision.kind) {
          case 'approved': {
            const notes = decision.nonBlockingFindings
              ? formatApprovedNotes(decision.nonBlockingFindings)
              : '';
            return this.approveAndRestore(
              plan,
              prePlanMode,
              'Gate approved' + (notes ? `\n\n${notes}` : ''),
            );
          }
          case 'blocked':
            return {
              llmContent: formatBlockedResponse(decision),
              returnDisplay: `Plan gate: blocked (${decision.findings.length} finding(s))`,
            };
          case 'needs_user':
            return {
              llmContent: formatNeedsUserResponse(decision),
              returnDisplay: `Plan gate: needs user input (${decision.questions.length} question(s))`,
            };
          case 'cap_escalation': {
            gateState.capEscalationPending = true;
            return {
              llmContent: formatCapEscalationResponse(decision),
              returnDisplay: `Plan gate: cap reached with ${decision.blockingFindings.length} blocking finding(s)`,
            };
          }
          case 'unavailable':
            return {
              llmContent: formatUnavailableResponse(decision),
              returnDisplay: `Plan gate: unavailable — ${decision.reason}`,
            };
          default: {
            const _exhaustive: never = decision;
            return {
              llmContent: `Unexpected gate decision: ${JSON.stringify(_exhaustive)}`,
              returnDisplay: 'Unexpected gate decision',
            };
          }
        }
      }

      // ── Path C: normal user confirmation path ──────────────────
      if (!this.wasApproved) {
        const rejectionMessage =
          'Plan execution was not approved. Remaining in plan mode.';
        return {
          llmContent: rejectionMessage,
          returnDisplay: rejectionMessage,
        };
      }

      return this.approveAndRestore(plan, prePlanMode, 'User approved');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      debugLogger.error(
        `[ExitPlanModeTool] Error executing exit_plan_mode: ${errorMessage}`,
      );

      const errorLlmContent = `Failed to present plan: ${errorMessage}`;

      return {
        llmContent: errorLlmContent,
        returnDisplay: `Error presenting plan: ${errorMessage}`,
      };
    }
  }

  private approveAndRestore(
    plan: string,
    targetMode: ApprovalMode,
    context: string,
  ): ToolResult {
    // Persist the approved plan to disk
    try {
      this.config.savePlan(plan);
    } catch (error) {
      debugLogger.warn(
        `[ExitPlanModeTool] Failed to save plan to disk: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Restore the pre-plan approval mode (this also clears gate state
    // via setApprovalMode's PLAN→non-PLAN transition).
    this.setApprovalModeSafely(targetMode);

    const llmMessage = `${context}. You can now start coding. Start with updating your todo list if applicable.`;
    const displayMessage = `${context}.`;

    return {
      llmContent: llmMessage,
      returnDisplay: {
        type: 'plan_summary',
        message: displayMessage,
        plan,
      },
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
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer — only used when leaving plan mode
      false, // alwaysLoad
      'plan mode exit approve',
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
