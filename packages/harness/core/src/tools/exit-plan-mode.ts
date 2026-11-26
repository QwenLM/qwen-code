/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ExitPlanModeResult,
  type ToolResult,
} from './tools.js';
import type { Config } from '../config/config.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import { readFileWithEncoding } from '../utils/fileUtils.js';
import { EXIT_PLAN_MODE_TOOL_NAME } from './tool-names.js';
import {
  autoNameSessionFromPlan,
  resolveCurrentPlanPath,
} from '../utils/planUtils.js';
import { createToolParameterDiagnosticData } from './tool-parameter-diagnostics.js';
import { getExitPlanModeDeclaration } from './definitions/dynamic-declaration-helpers.js';
import { runLogger } from '../utils/runLogger.js';
import { getCustomContextFromContext } from '../utils/sessionIdContext.js';


export interface ExitPlanModeParams {
  /**
   * Optional list of shell command categories to pre-authorize for the
   * implementation phase. Each entry has { tool: '<SHELL_TOOL_NAME>', prompt: string }.
   * Stored on Config for use by the permission system during implementation.
   */
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;

  // ── Fields injected by the UI confirmation pipeline ──
  // These are merged into params when the user interacts with the
  // ExitPlanModeDialog; the model never sends them.
  approved?: boolean;
  feedback?: string;
  planWasEdited?: boolean;
  /**
   * When true, exit-plan-mode also activates the goal loop; the permission
   * mode is left unchanged. Set by ExitPlanModeDialog's
   * "Yes, start goal execution" option.
   */
  startGoal?: boolean;
}

export class ExitPlanModeTool extends BaseDeclarativeTool<
  ExitPlanModeParams,
  ToolResult
> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  static readonly Name = EXIT_PLAN_MODE_TOOL_NAME;

  /**
   * Bound when this tool instance lives in a subagent's tool registry. The
   * subagent's plan state is isolated on its own AgentLoopContext rather than
   * the global PlanStateManager, so validation and execution must read/mutate
   * this context instead of the global Config when present.
   */
  private subagentContext?: AgentLoopContext;

  constructor(private config: Config) {
    const declaration = getExitPlanModeDeclaration();
    super(
      ExitPlanModeTool.Name,
      'Exit Plan Mode',
      declaration.description!,
      Kind.Plan,
      declaration.parametersJsonSchema,
    );
  }

  /**
   * Binds the subagent's AgentLoopContext so this instance operates on the
   * subagent's isolated plan state. Called by buildSubagentRegistries after the
   * scheduler context is created. We hold the context container (not its
   * toolPermissionContext) because runSubagent reassigns that property after
   * registries are built — reading it lazily picks up the current object.
   */
  bindSubagentContext(ctx: AgentLoopContext): void {
    this.subagentContext = ctx;
  }

  protected override validateToolParamValues(
    _params: ExitPlanModeParams,
  ): string | null {
    if (this.subagentContext) {
      // Subagent path: gate on the isolated plan flag, not global plan state.
      if (!this.subagentContext.planModeActive) {
        return (
          'You are not in plan mode. This tool is only for exiting plan mode ' +
          'after planning. If you already exited, continue with your task.'
        );
      }
      return null;
    }

    // Reject before the approval dialog opens when the session is not in
    // plan mode. The deferred-tool list keeps ExitPlanMode visible to the
    // model after compact/clear/resume so a stale tool_use can land in
    // default mode — without this guard the dialog tries to read a plan
    // file that was never written for this session.
    if (!this.config.isPlanMode()) {
      return (
        'You are not in plan mode. This tool is only for exiting plan mode ' +
        'after writing a plan. If your plan was already approved, continue ' +
        'with implementation.'
      );
    }
    return null;
  }

  protected override createCustomParameterValidationDiagnostic() {
    return createToolParameterDiagnosticData('tool_state', {
      validation_source: 'custom',
      constraint_category: 'plan_mode_inactive',
      quality: 'precise',
      validation_phase: 'build',
    });
  }

  protected createInvocation(
    params: ExitPlanModeParams,
    toolName: string,
    toolDisplayName: string,
  ): ExitPlanModeInvocation {
    return new ExitPlanModeInvocation(
      params,
      toolName,
      toolDisplayName,
      this.config,
      this.subagentContext,
    );
  }

  // === Permission Pipeline methods ===


  /**
   * The exit dialog is where the plan itself gets accepted, so it must survive
   * bypassPermissions and auto: a mode cannot approve a plan on the user's
   * behalf without discarding the only review step plan mode exists for.
   */
  override requiresUserInteraction(): boolean {
    return true;
  }
}

export class ExitPlanModeInvocation extends BaseToolInvocation<
  ExitPlanModeParams,
  ToolResult
> {
  constructor(
    params: ExitPlanModeParams,
    toolName: string,
    toolDisplayName: string,
    private config: Config,
    private subagentContext?: AgentLoopContext,
  ) {
    super(params, toolName, toolDisplayName);
  }

  getDescription(): string {
    return `Requesting plan approval for: ${resolveCurrentPlanPath(this.config)}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    if (this.subagentContext) {
      return this.executeForSubagent();
    }

    const resolvedPlanPath = resolveCurrentPlanPath(this.config);

    // When a user policy grants `allow` for ExitPlanMode, the scheduler
    // skips the confirmation phase entirely and the confirmation callback is never
    // called, leaving the approval fields unset in params.
    const approved = this.params.approved ?? true;
    const feedback = this.params.feedback;
    const planWasEdited = this.params.planWasEdited;

    if (approved) {
      // Plan is orthogonal to permission mode. Exiting plan never changes the
      // current permission mode.
      // Exit plan state.
      // planStateManager.exit() schedules the exit attachment and resets state.
      this.config.planStateManager.exit();
      this.config.notifyPlanStateChanged();
      this.config.setApprovedPlanPath(resolvedPlanPath);

      // If the user chose "start goal execution" in the dialog, activate the
      // goal loop. The permission mode is untouched — the dialog approves
      // without one, so execution runs under whatever mode the user has.
      let goalActivationError: string | null = null;
      if (this.params.startGoal) {
        try {
          const goalMgr = this.config.getGoalManager();
          goalMgr.setGoal({
            objective: `Execute the approved plan from ${resolvedPlanPath}`,
            customContext: getCustomContextFromContext(),
          });
        } catch (e) {
          // Plan has already exited and mode has switched — surface the goal
          // activation failure to the user instead of swallowing it silently.
          goalActivationError =
            e instanceof Error ? e.message : String(e);
          runLogger.error(
            '[ExitPlanMode] Failed to activate goal loop',
            e,
          );
        }
      }

      // Store allowedPrompts for use by the permission system during
      // implementation (best-effort: only if Config supports it).
      if (this.params.allowedPrompts?.length) {
        this.config.setAllowedPrompts(this.params.allowedPrompts);
      }

      let planContent = '';
      try {
        planContent = (await readFileWithEncoding(resolvedPlanPath)).trim();
      } catch {
        // File read failed — fall through to the empty-plan branch.
      }

      // Fire-and-forget: auto-name the session from the plan content.
      // Non-blocking — failures are silently discarded.
      if (planContent) {
        void autoNameSessionFromPlan(
          planContent.slice(0, 1000),
          this.config,
        ).catch(() => {});
      }

      if (!planContent) {
        const toolUseResult: ExitPlanModeResult = {
          plan: null,
          isAgent: false,
          status: 'approved',
          filePath: resolvedPlanPath,
          planWasEdited,
        };
        return {
          llmContent:
            'User has approved exiting plan mode. You can now proceed.',
          returnDisplay: `Plan approved: ${resolvedPlanPath}`,
          toolUseResult,
        };
      }

      const approvedPlanHeader = planWasEdited
        ? '## Approved Plan (edited by user):'
        : '## Approved Plan:';

      const goalErrorSuffix = goalActivationError
        ? `\n\n⚠ Goal loop activation failed: ${goalActivationError}. ` +
          `You can manually run /goal <objective> to retry.`
        : '';

      return {
        llmContent:
          `User has approved your plan. You can now start coding.\n` +
          `Start with updating your todo list if applicable.\n\n` +
          `Your plan has been saved to: ${resolvedPlanPath}\n` +
          `You can refer back to it if needed during implementation.\n\n` +
          `${approvedPlanHeader}\n${planContent}${goalErrorSuffix}`,
        returnDisplay:
          `Plan approved: ${resolvedPlanPath}` +
          (goalActivationError
            ? `\n⚠ Goal loop activation failed: ${goalActivationError}`
            : ''),
        toolUseResult: {
          plan: planContent,
          isAgent: false,
          status: 'approved',
          filePath: resolvedPlanPath,
          planWasEdited,
        } satisfies ExitPlanModeResult,
      };
    } else {
      let planContent: string | null = null;
      try {
        planContent =
          (await readFileWithEncoding(resolvedPlanPath)).trim() || null;
      } catch {
        // Preserve the existing null fallback when the plan file is unavailable.
      }

      const trimmedFeedback = feedback?.trim();
      if (trimmedFeedback) {
        const toolUseResult: ExitPlanModeResult = {
          plan: planContent,
          isAgent: false,
          status: 'rejected',
          filePath: resolvedPlanPath,
          feedback: trimmedFeedback,
        };
        return {
          llmContent:
            `Plan rejected. User feedback: ${trimmedFeedback}\n\n` +
            `The plan is stored at: ${resolvedPlanPath}\n` +
            `Revise the plan based on the feedback.`,
          returnDisplay: `Feedback: ${trimmedFeedback}`,
          toolUseResult,
        };
      } else {
        const toolUseResult: ExitPlanModeResult = {
          plan: planContent,
          isAgent: false,
          status: 'rejected',
          filePath: resolvedPlanPath,
        };
        return {
          llmContent:
            `Plan rejected. No feedback provided.\n\n` +
            `The plan is stored at: ${resolvedPlanPath}\n` +
            `Ask the user for specific feedback on how to improve the plan.`,
          returnDisplay: 'Rejected (no feedback)',
          toolUseResult,
        };
      }
    }
  }

  /**
   * Isolated plan-mode exit for a subagent. Mutates only the subagent's own
   * AgentLoopContext — never the global Config / PlanStateManager — so the
   * parent session's plan and permission state is left untouched.
   */
  private executeForSubagent(): ToolResult {
    const ctx = this.subagentContext!;
    const approved = this.params.approved ?? true;

    if (!approved) {
      const feedback = this.params.feedback?.trim();
      return {
        llmContent: feedback
          ? `Plan rejected. User feedback: ${feedback}\n\n` +
            `Revise your plan based on the feedback before exiting again.`
          : `Plan rejected. No feedback provided.\n\n` +
            `Ask the user for specific feedback on how to improve the plan.`,
        returnDisplay: feedback
          ? `Feedback: ${feedback}`
          : 'Rejected (no feedback)',
        toolUseResult: {
          plan: null,
          isAgent: true,
          status: 'rejected',
          filePath: '',
          ...(feedback ? { feedback } : {}),
        } satisfies ExitPlanModeResult,
      };
    }

    // Clear the isolated plan flag. Permission mode stays unchanged.
    ctx.planModeActive = false;

    return {
      llmContent:
        `You have exited plan mode. You can now proceed with implementation ` +
        `using your full tool set.`,
      returnDisplay: 'Exited plan mode',
      toolUseResult: {
        plan: null,
        isAgent: true,
        status: 'approved',
        filePath: '',
      } satisfies ExitPlanModeResult,
    };
  }
}
