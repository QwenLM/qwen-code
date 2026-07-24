/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const GOAL_STATE_VERSION = 2 as const;

export const PAUSED_GOAL_SYSTEM_REMINDER =
  '<system-reminder>\nThe Goal is paused. Do not continue its objective unless the user resumes it. Treat this message as ordinary conversation.\n</system-reminder>';

export type GoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usage_limited'
  | 'complete';

export type GoalActivity = 'idle' | 'running' | 'verifying';

export interface TranscriptCursor {
  recordId: string | null;
}

export interface GoalExpectedVersion {
  goalId: string;
  revision: number;
}

export interface GoalTurnPermit extends GoalExpectedVersion {
  turnId: string;
}

export interface GoalRecord {
  goalId: string;
  revision: number;
  objective: string;
  status: GoalStatus;
  evidenceCursor: TranscriptCursor;
  turnCount: number;
  activeTimeMs: number;
  createdAt: number;
  updatedAt: number;
  lastReason?: string;
}

export interface GoalSnapshotV2 {
  v: typeof GOAL_STATE_VERSION;
  goal: GoalRecord | null;
  activity: GoalActivity;
}

/** True while any new model send must carry the runtime's exact turn permit. */
export function goalRequiresExactPermit(snapshot: GoalSnapshotV2): boolean {
  return (
    snapshot.goal !== null &&
    (snapshot.goal.status === 'active' || snapshot.activity === 'running')
  );
}

export type GoalControlRequest =
  | { action: 'create'; objective: string }
  | {
      action: 'replace';
      objective: string;
      expectedGoalId: string;
      expectedRevision: number;
    }
  | {
      action: 'edit';
      objective: string;
      expectedGoalId: string;
      expectedRevision: number;
    }
  | {
      action: 'pause';
      expectedGoalId: string;
      expectedRevision: number;
    }
  | {
      action: 'resume';
      expectedGoalId: string;
      expectedRevision: number;
    }
  | {
      action: 'clear';
      expectedGoalId: string;
      expectedRevision: number;
    };

export interface GoalStateResponse {
  snapshot: GoalSnapshotV2;
}

export interface GoalTerminalProposal {
  status: 'complete' | 'blocked';
  reason: string;
  evidenceRefs: string[];
  blockerKind?: 'authority' | 'external' | 'repeated';
}

export type GoalStateCause =
  | 'create'
  | 'replace'
  | 'edit'
  | 'pause'
  | 'resume'
  | 'turn_finished'
  | 'verifier_accept'
  | 'verifier_reject'
  | 'complete'
  | 'blocked'
  | 'usage_limited'
  | 'clear'
  | 'migrated';

export interface GoalStateRecordPayloadV2 {
  v: typeof GOAL_STATE_VERSION;
  cause: GoalStateCause;
  snapshot: GoalSnapshotV2;
  blockedAudit?: {
    fingerprint: string;
    count: number;
    turnIds: string[];
  };
}
