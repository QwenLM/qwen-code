/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  GOAL_STATE_VERSION,
  goalRequiresExactPermit,
  type GoalActivity,
  type GoalControlRequest,
  type GoalExpectedVersion,
  type GoalRecord,
  type GoalSnapshotV2,
  type GoalStateCause,
  type GoalStateRecordPayloadV2,
  type GoalStateResponse,
  type GoalStatus,
  type GoalTerminalProposal,
  type GoalTurnPermit,
  type TranscriptCursor,
} from './goal-protocol.js';
export {
  parseGoalSnapshotV2,
  parseGoalStateRecordPayloadV2,
} from './goal-reducer.js';
export {
  projectGoalStateToLegacy,
  type LegacyActiveGoal,
  type LegacyGoalProjection,
  type LegacyGoalStatus,
  type LegacyGoalStatusKind,
  type LegacyGoalTerminal,
} from './goal-legacy-projection.js';
