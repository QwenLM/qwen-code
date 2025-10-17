/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolPlanConfirmationDetails, ToolResult } from './tools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolConfirmationOutcome,
} from './tools.js';
import type { FunctionDeclaration } from '@google/genai';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';

export interface ExitPlanModeParams {
  plan: string;
}

const exitPlanModeToolDescription = `Use this tool when you are in plan mode and have finished presenting your plan and are ready to code. This will prompt the user to exit plan mode.
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

Eg.
1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
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
    return 'Present implementation plan for user approval';
  }

  override async shouldConfirmExecute(
    _abortSignal: AbortSignal,
  ): Promise<ToolPlanConfirmationDetails> {
    const details: ToolPlanConfirmationDetails = {
      type: 'plan',
      title: 'Would you like to proceed?',
      plan: this.params.plan,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        switch (outcome) {
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
            // Treat any other outcome as manual approval to preserve conservative behaviour.
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
      console.error(
        `[ExitPlanModeTool] Failed to set approval mode to "${mode}": ${errorMessage}`,
      );
    }
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const { plan } = this.params;

    try {
      if (!this.wasApproved) {
        const rejectionMessage =
          'Plan execution was not approved. Remaining in plan mode.';
        return {
          llmContent: JSON.stringify({
            success: false,
            plan,
            error: rejectionMessage,
          }),
          returnDisplay: rejectionMessage,
        };
      }

      const llmMessage =
        'User has approved your plan. You can now start coding. Start with updating your todo list if applicable.';
      const displayMessage = 'User approved the plan.';

      return {
        llmContent: llmMessage,
        returnDisplay: {
          type: 'plan_summary',
          message: displayMessage,
          plan,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        `[ExitPlanModeTool] Error executing exit_plan_mode: ${errorMessage}`,
      );
      return {
        llmContent: JSON.stringify({
          success: false,
          error: `Failed to present plan. Detail: ${errorMessage}`,
        }),
        returnDisplay: `Error presenting plan: ${errorMessage}`,
      };
    }
  }
}

export class ExitPlanModeTool extends BaseDeclarativeTool<
  ExitPlanModeParams,
  ToolResult
> {
  static readonly Name: string = exitPlanModeToolSchemaData.name!;

  constructor(private readonly config: Config) {
    super(
      ExitPlanModeTool.Name,
      'ExitPlanMode',
      exitPlanModeToolDescription,
      Kind.Think,
      exitPlanModeToolSchemaData.parametersJsonSchema as Record<
        string,
        unknown
      >,
    );
  }

  override validateToolParams(params: ExitPlanModeParams): string | null {
    // Validate plan parameter
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
