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
  activeGoalEquals,
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
  getStopHookContinuationReason,
  createGoalStopHookCallback,
  abortGoalForStopHookCap,
  registerGoalHook,
  unregisterGoalHook,
} from './goalHook.js';
export { judgeGoal } from './goalJudge.js';
export type { GoalJudgeOutcome, JudgeResult } from './goalJudge.js';
export * from './goal-protocol.js';
export {
  GoalConflictError,
  GoalInvalidTransitionError,
  elapsedActiveTime,
  parseGoalControlRequest,
  parseGoalSnapshotV2,
  parseGoalStateRecordPayloadV2,
  reduceGoalControl,
  reduceGoalTurnFinished,
} from './goal-reducer.js';
export type {
  GoalControlTransition,
  GoalTurnFinishedTransition,
} from './goal-reducer.js';
export * from './goal-persistence.js';
export { projectGoalStateToLegacy } from './goal-legacy-projection.js';
export type {
  LegacyActiveGoal,
  LegacyGoalProjection,
  LegacyGoalStatus,
  LegacyGoalStatusKind,
  LegacyGoalTerminal,
} from './goal-legacy-projection.js';
