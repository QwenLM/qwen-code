/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Goal } from './types.js';

export type GoalTriggerSource =
  | 'goal_manager'
  | 'create_goal_tool'
  | 'update_goal_tool'
  | 'slash_set'
  | 'slash_pause'
  | 'slash_resume'
  | 'slash_clear'
  | 'stop_hook'
  | 'user_interrupt'
  | 'session_reset'
  | 'exit_plan_mode'
  | 'sdk_resume'
  | 'sdk_set'
  | 'sdk_clear';

export type GoalStateReason =
  | 'user'
  | 'agent'
  | 'completed'
  | 'replacement'
  | 'safety_limit'
  | 'user_interrupt'
  | 'session_reset'
  | 'blocked';

/** Detached state at a committed Goal operation boundary. */
export type GoalStateSnapshot = Readonly<
  Pick<Goal, 'id' | 'status' | 'turnsUsed' | 'maxTurns' | 'timeUsedSeconds'>
>;

export interface GoalMutationContext {
  triggerSource?: GoalTriggerSource;
  reason?: GoalStateReason;
}

export interface GoalClearOptions extends GoalMutationContext {
  /** Reason exposed by the GoalCleared business notification. */
  reason?: 'completed' | 'user';
  /** More specific operation cause, such as session reset. */
  cause?: GoalStateReason;
}

export interface GoalResumeOptions extends GoalMutationContext {
  grantFreshBudget?: boolean;
}

export interface GoalChange {
  readonly operation:
    | 'set'
    | 'block'
    | 'clear'
    | 'interrupt'
    | 'safety_limit'
    | 'resume';
  readonly before: GoalStateSnapshot | null;
  readonly after: GoalStateSnapshot | null;
  readonly context?: Readonly<
    GoalMutationContext & { cause?: GoalStateReason }
  >;
  readonly turnBudgetExtended?: boolean;
}

export interface GoalMutationResult<T> {
  readonly value: T;
  readonly change?: GoalChange;
}
