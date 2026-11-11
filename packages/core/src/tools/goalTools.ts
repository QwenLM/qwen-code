/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import {
  GET_GOAL_DECLARATION,
  CREATE_GOAL_DECLARATION,
  UPDATE_GOAL_DECLARATION,
} from './definitions/goalTools.js';
import {
  GET_GOAL_TOOL_NAME,
  CREATE_GOAL_TOOL_NAME,
  UPDATE_GOAL_TOOL_NAME,
} from './tool-names.js';
import type { ToolResult, ToolInvocation } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import type { Config } from '../config/config.js';
import { GoalStatus, isUnlimitedGoalTurns } from '../goal/types.js';
import { getCustomContextFromContext } from '../utils/sessionIdContext.js';

// --- get_goal ---

type GetGoalParams = Record<string, never>;

class GetGoalInvocation extends BaseToolInvocation<GetGoalParams, ToolResult> {
  constructor(
    private readonly config: Config,
    params: GetGoalParams,
    toolName?: string,
    displayName?: string,
  ) {
    super(params, toolName, displayName);
  }

  getDescription(): string {
    return 'Retrieving current goal.';
  }

  override async execute(_signal: AbortSignal): Promise<ToolResult> {
    const mgr = this.config.getGoalManager();
    mgr.refresh();
    const goal = mgr.getGoal();
    if (!goal) {
      return {
        llmContent: 'No active goal.',
        returnDisplay: 'No active goal.',
      };
    }
    return {
      llmContent: JSON.stringify({
        objective: goal.objective,
        status: goal.status,
        turns_used: goal.turnsUsed,
        max_turns: goal.maxTurns ?? null,
        remaining_turns:
          goal.maxTurns !== undefined &&
          !isUnlimitedGoalTurns(goal.maxTurns)
            ? Math.max(0, goal.maxTurns - goal.turnsUsed)
            : null,
        time_used_seconds: goal.timeUsedSeconds,
      }),
      returnDisplay: `Goal: ${goal.objective} [${goal.status}]`,
    };
  }
}

export class GetGoalTool extends BaseDeclarativeTool<
  GetGoalParams,
  ToolResult
> {
  static readonly Name = GET_GOAL_TOOL_NAME;
  constructor(private readonly config: Config) {
    super(
      GetGoalTool.Name,
      'Get Goal',
      GET_GOAL_DECLARATION.description!,
      Kind.Read,
      GET_GOAL_DECLARATION.parametersJsonSchema,
    );
  }
  protected createInvocation(
    params: GetGoalParams,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<GetGoalParams, ToolResult> {
    return new GetGoalInvocation(this.config, params, toolName, displayName);
  }
}

// --- create_goal ---

interface CreateGoalParams {
  objective: string;
  max_turns?: number;
}

class CreateGoalInvocation extends BaseToolInvocation<
  CreateGoalParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: CreateGoalParams,
    toolName?: string,
    displayName?: string,
  ) {
    super(params, toolName, displayName);
  }

  getDescription(): string {
    return `Creating goal: ${this.params.objective}`;
  }

  override async execute(_signal: AbortSignal): Promise<ToolResult> {
    const mgr = this.config.getGoalManager();

    mgr.refresh();
    const existingGoal = mgr.getGoal();
    if (existingGoal && existingGoal.status !== GoalStatus.Complete) {
      return {
        llmContent:
          'cannot create a new goal because this thread already has a goal; use UpdateGoal only when the existing goal is complete',
        returnDisplay: 'Goal already exists.',
        error: {
          message:
            'cannot create a new goal because this thread already has a goal',
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }

    // If there's a completed goal, clear it first
    if (existingGoal && existingGoal.status === GoalStatus.Complete) {
      mgr.clearGoal({
        reason: 'completed',
      });
    }

    const goal = mgr.setGoal({
      objective: this.params.objective,
      status: GoalStatus.Active,
      maxTurns: this.params.max_turns,
      customContext: getCustomContextFromContext(),
    });
    return {
      llmContent: JSON.stringify({
        id: goal.id,
        objective: goal.objective,
        status: goal.status,
        turns_used: goal.turnsUsed,
        max_turns: goal.maxTurns ?? null,
        turn_limit_note:
          goal.maxTurns !== undefined &&
          isUnlimitedGoalTurns(goal.maxTurns)
            ? 'unlimited'
            : 'the goal is force-paused automatically once max_turns is reached',
        current_time: new Date().toISOString(),
      }),
      returnDisplay: `Created goal: ${goal.objective}`,
    };
  }
}

export class CreateGoalTool extends BaseDeclarativeTool<
  CreateGoalParams,
  ToolResult
> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  static readonly Name = CREATE_GOAL_TOOL_NAME;
  constructor(private readonly config: Config) {
    super(
      CreateGoalTool.Name,
      'Create Goal',
      CREATE_GOAL_DECLARATION.description!,
      Kind.Edit,
      CREATE_GOAL_DECLARATION.parametersJsonSchema,
    );
  }
  protected createInvocation(
    params: CreateGoalParams,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<CreateGoalParams, ToolResult> {
    return new CreateGoalInvocation(this.config, params, toolName, displayName);
  }
}

// --- update_goal ---

interface UpdateGoalParams {
  status: string;
}

class UpdateGoalInvocation extends BaseToolInvocation<
  UpdateGoalParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: UpdateGoalParams,
    toolName?: string,
    displayName?: string,
  ) {
    super(params, toolName, displayName);
  }

  getDescription(): string {
    return 'Updating goal status.';
  }

  override async execute(_signal: AbortSignal): Promise<ToolResult> {
    const mgr = this.config.getGoalManager();
    mgr.refresh();
    const goal = mgr.getGoal();
    if (!goal) {
      return {
        llmContent: 'Error: No active goal to update.',
        returnDisplay: 'No active goal.',
        error: {
          message: 'No active goal to update.',
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
    if (this.params.status === 'blocked') {
      const marked = await mgr.markBlocked();
      if (!marked) {
        return {
          llmContent:
            'Error: Goal is not in active state and cannot be marked blocked.',
          returnDisplay: 'Goal is not active.',
          error: {
            message:
              'Goal is not in active state and cannot be marked blocked.',
            type: ToolErrorType.EXECUTION_FAILED,
          },
        };
      }

      return {
        llmContent: JSON.stringify({
          id: goal.id,
          status: 'blocked',
          note: 'The goal loop is halted. Report the blocker to the user and stop; the user can revive the goal with /goal resume.',
        }),
        returnDisplay: `Goal blocked: ${goal.objective}`,
      };
    }
    if (this.params.status !== 'complete') {
      return {
        llmContent: 'Error: Only "complete" or "blocked" status is allowed.',
        returnDisplay: 'Invalid status.',
        error: {
          message: 'Only "complete" or "blocked" status is allowed.',
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
      };
    }
    mgr.setGoal({ status: GoalStatus.Complete });
    const report = completionReport(goal);
    return {
      llmContent: JSON.stringify({
        id: goal.id,
        status: 'complete',
        completion_report: report,
      }),
      returnDisplay: `Goal completed: ${goal.objective}`,
    };
  }
}

function completionReport(goal: {
  maxTurns?: number;
  turnsUsed: number;
  timeUsedSeconds: number;
}): string | null {
  const parts: string[] = [];
  if (goal.maxTurns != null) {
    const maxTurns = isUnlimitedGoalTurns(goal.maxTurns)
      ? 'unlimited'
      : goal.maxTurns;
    parts.push(`turns used: ${goal.turnsUsed} of ${maxTurns}`);
  } else {
    parts.push(`turns used: ${goal.turnsUsed}`);
  }
  if (goal.timeUsedSeconds > 0) {
    parts.push(`time used: ${goal.timeUsedSeconds} seconds`);
  }
  if (parts.length === 0) return null;
  return `Goal achieved. Report final usage to the user: ${parts.join('; ')}.`;
}

export class UpdateGoalTool extends BaseDeclarativeTool<
  UpdateGoalParams,
  ToolResult
> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  static readonly Name = UPDATE_GOAL_TOOL_NAME;
  constructor(private readonly config: Config) {
    super(
      UpdateGoalTool.Name,
      'Update Goal',
      UPDATE_GOAL_DECLARATION.description!,
      Kind.Edit,
      UPDATE_GOAL_DECLARATION.parametersJsonSchema,
    );
  }
  protected createInvocation(
    params: UpdateGoalParams,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<UpdateGoalParams, ToolResult> {
    return new UpdateGoalInvocation(this.config, params, toolName, displayName);
  }
}
