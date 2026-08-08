/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const GOAL_STATE_VERSION = 2 as const;
export const GOAL_PROPOSAL_REASON_MAX_CHARACTERS = 8_000;
export const GOAL_PROPOSAL_REASON_MAX_BYTES = 16_000;
export const GOAL_CHECKPOINT_CLAIM_LIMIT = 32;
export const GOAL_CHECKPOINT_CLAIM_MAX_CHARACTERS = 2_000;
export const GOAL_CHECKPOINT_CLAIM_MAX_BYTES = 16_000;
export const GOAL_CHECKPOINT_SOURCE_REFERENCE_LIMIT = 32;
export const GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON =
  'The current Goal revision exceeded the bounded evidence catalog. Automatic retries cannot recover. Edit or replace the Goal before resuming it.';
export const GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON =
  'The current Goal revision exceeded the checkpoint verifier request limit. Automatic retries cannot recover. Edit or replace the Goal before resuming it.';

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

export type GoalEvidenceProofKind =
  | 'user_input'
  | 'delivered_output'
  | 'external_fact';

export function isGoalEvidenceProofKind(
  value: unknown,
): value is GoalEvidenceProofKind {
  return (
    value === 'user_input' ||
    value === 'delivered_output' ||
    value === 'external_fact'
  );
}

export interface GoalEvidenceCheckpointClaim {
  id: string;
  proofKind: GoalEvidenceProofKind;
  claim: string;
  sourceRefs: string[];
}

export interface GoalEvidenceCheckpoint {
  checkpointId: string;
  createdAt: number;
  claims: GoalEvidenceCheckpointClaim[];
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
  evidenceCheckpoint?: GoalEvidenceCheckpoint;
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

export function isRepeatedBlockerProposal(
  proposal: GoalTerminalProposal,
): boolean {
  return (
    proposal.status === 'blocked' &&
    proposal.blockerKind !== 'authority' &&
    proposal.blockerKind !== 'external'
  );
}

export function validateGoalProposalReason(reason: string): string | null {
  if (!reason.trim()) return 'Goal proposal reason must not be empty';
  if ([...reason].length > GOAL_PROPOSAL_REASON_MAX_CHARACTERS) {
    return `Goal proposal reason exceeds ${GOAL_PROPOSAL_REASON_MAX_CHARACTERS} characters`;
  }
  if (
    new TextEncoder().encode(reason).byteLength > GOAL_PROPOSAL_REASON_MAX_BYTES
  ) {
    return `Goal proposal reason exceeds ${GOAL_PROPOSAL_REASON_MAX_BYTES} UTF-8 bytes`;
  }
  return null;
}

export type GoalStateCause =
  | 'create'
  | 'replace'
  | 'edit'
  | 'pause'
  | 'resume'
  | 'turn_finished'
  | 'checkpoint'
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
  checkpointPending?: {
    permit: GoalTurnPermit;
    recordUuid: string;
  };
  blockedAudit?: {
    fingerprint: string;
    count: number;
    turnIds: string[];
  };
}
