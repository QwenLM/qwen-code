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
/**
 * How many consecutive stalled checkpoints a Goal may run before it stops.
 * Three matches the thrash bounds elsewhere in this family of runtimes: one
 * stalled checkpoint is a busy turn, two is a pattern, three is the loop.
 */
export const GOAL_CHECKPOINT_STALL_LIMIT = 3;
export const GOAL_CHECKPOINT_STALLED_REASON =
  'The current Goal revision ran three consecutive evidence checkpoints without relief: the evidence window overflowed every time, and each check either came back with a full claim list or a result that could not be folded into claims at all, so every turn paid a checkpoint call and lost uncatalogued evidence. Automatic retries cannot recover. Edit or replace the Goal with a narrower objective before resuming it.';

/**
 * Default autonomous spend window armed on a newly created Goal, in model
 * tokens on the `tokensUsed` metric (`totalTokenCount` summed per model call,
 * so a call's full input context counts every time it is sent).
 *
 * The meter bills Goal-turn model calls only -- per-turn side queries and
 * checkpoint-verifier calls are unmetered -- so real provider spend at a
 * stop runs above this window.
 *
 * This is an authorization quantum, not a cost estimate: it bounds how much
 * autonomous continuation one explicit user action (create, or a later
 * resume) pays for before the Goal stops and asks again. Sized to a few hours
 * of continuous turn cadence -- the runaway session this bound exists for
 * burned ~8.6M tokens in half an hour before a human killed it, so a healthy
 * long run reaches this ceiling late and a stuck loop reaches it unattended.
 */
export const GOAL_DEFAULT_TOKEN_BUDGET = 30_000_000;

/** The `lastReason` a Goal stops with when `tokensUsed` reaches its budget. */
export function goalTokenBudgetReason(tokenBudget: number): string {
  return `The Goal spent its autonomous token budget (${tokenBudget.toLocaleString('en-US')} tokens). Resume the Goal to authorize another budget window, or clear it.`;
}

/**
 * Whether `tokensUsed` has reached the armed ceiling. One predicate serves
 * both the runtime's stop condition and the reducer's re-arm condition, so
 * the stop/re-arm cycle cannot desynchronize.
 */
export function isGoalTokenBudgetSpent(
  goal: Pick<GoalRecord, 'tokensUsed' | 'tokenBudget'>,
): goal is Pick<GoalRecord, 'tokensUsed' | 'tokenBudget'> & {
  tokenBudget: number;
} {
  return goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget;
}

/**
 * Which bound a `usage_limited` Goal ran into.
 *
 * Only the enumerated bounds are typed: they are the ones a caller has to
 * branch on. The evidence kinds mark a window a plain resume cannot simply
 * re-enter; `token_budget` marks a spent authorization that a resume re-arms.
 * Every other route to `usage_limited` is an operational failure that carries
 * prose in `lastReason` and nothing to key off.
 */
export type GoalLimitKind =
  | 'evidence_catalog'
  | 'checkpoint_request'
  | 'token_budget';

export function isGoalLimitKind(value: unknown): value is GoalLimitKind {
  return (
    value === 'evidence_catalog' ||
    value === 'checkpoint_request' ||
    value === 'token_budget'
  );
}

/** The limit a `usage_limited` reason denotes, for reasons that denote one. */
export function goalLimitKindForReason(
  reason: string,
): GoalLimitKind | undefined {
  if (reason === GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON) {
    return 'evidence_catalog';
  }
  if (reason === GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON) {
    return 'checkpoint_request';
  }
  return undefined;
}

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
  /**
   * Model tokens billed to this Goal so far, summed across its turn windows.
   *
   * Measured from the same session token source as `/stats`. Verification and
   * checkpoint side queries run between turn windows and are not included.
   * Zero on Goals recovered from a transcript written before the field existed.
   */
  tokensUsed: number;
  /**
   * The ceiling `tokensUsed` may reach before autonomous continuation stops
   * and the Goal waits for the user. Armed at creation from the runtime's
   * grant; a resume or edit of a Goal whose ceiling is spent moves it forward
   * (`tokensUsed + grant`) -- the spent meter itself is never reset. Absent
   * on Goals persisted before budgets existed: those stay unbounded.
   */
  tokenBudget?: number;
  createdAt: number;
  updatedAt: number;
  evidenceCheckpoint?: GoalEvidenceCheckpoint;
  /**
   * Consecutive checkpoint checks that failed to relieve an overflowing
   * evidence window: the checkpoint came back full (see
   * `isGoalCheckpointStalled`) or the verifier result could not be folded
   * into claims at all. Persisted on the record rather than held in memory
   * so a daemon restart or session resume cannot launder the count; absent
   * means zero. Reset by any checkpoint check that finds room, and by every
   * control action that starts a different evidence window: edit, replace,
   * and the resume of an evidence-limited Goal.
   */
  checkpointStalls?: number;
  lastReason?: string;
  /**
   * Set alongside `lastReason` whenever the runtime stops a Goal at one of the
   * enumerated bounds. `lastReason` stays the human-readable half; this is the
   * half state transitions are allowed to read.
   */
  limitKind?: GoalLimitKind;
}

export interface GoalSnapshotV2 {
  v: typeof GOAL_STATE_VERSION;
  goal: GoalRecord | null;
  activity: GoalActivity;
  clearedGoal?: GoalOrder;
}

export interface GoalOrder {
  goalId: string;
  revision: number;
  updatedAt: number;
}

/**
 * What a session with no reachable Goal runtime looks like.
 *
 * `getGoalRuntimeReady()` rejects when goal persistence is unavailable —
 * permanently, once a malformed transcript record has set a sticky recovery
 * error. For anything that only reads or reduces goal state, the honest
 * answer is "no goal", not a failed request: the caller asked what the goal
 * is, and the answer is nothing.
 */
export function emptyGoalSnapshot(): GoalSnapshotV2 {
  return { v: GOAL_STATE_VERSION, goal: null, activity: 'idle' };
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
