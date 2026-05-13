/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type {
  ActiveGoal,
  GoalTerminalEvent,
  GoalTerminalKind,
  GoalTerminalObserver,
} from './activeGoalStore.js';
export {
  getActiveGoal,
  setActiveGoal,
  clearActiveGoal,
  recordGoalIteration,
  setGoalTerminalObserver,
  clearGoalTerminalObserver,
  notifyGoalTerminal,
  getLastGoalTerminal,
  setLastGoalTerminal,
  __resetActiveGoalStoreForTests,
} from './activeGoalStore.js';
export {
  MAX_GOAL_ITERATIONS,
  GOAL_HOOK_TIMEOUT_MS,
  GOAL_HOOK_TIMEOUT_SECONDS,
  createGoalStopHookCallback,
  registerGoalHook,
  unregisterGoalHook,
} from './goalHook.js';
export { judgeGoal } from './goalJudge.js';
export type { JudgeResult } from './goalJudge.js';
