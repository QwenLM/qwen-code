/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  buildGoalEvidenceCheckpointWindow,
  buildGoalEvidenceCatalog,
  EvidenceSourceUnavailableError,
  InvalidGoalEvidenceReferenceError,
  validateGoalEvidenceReferences,
  type GoalEvidenceCatalog,
  type GoalEvidenceCheckpointWindow,
  type GoalEvidenceRecord,
} from './goal-evidence.js';
import {
  InvalidGoalCheckpointError,
  isGoalCheckpointStalled,
  materializeGoalEvidenceCheckpoint,
  type GoalCheckpointVerifier,
} from './goal-checkpoint.js';
import { GoalCheckpointVerifierInputTooLargeError } from './goal-checkpoint-verifier.js';
import {
  GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON,
  GOAL_CHECKPOINT_STALL_LIMIT,
  GOAL_CHECKPOINT_STALLED_REASON,
  GOAL_DEFAULT_TOKEN_BUDGET,
  GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
  GOAL_INFEASIBLE_NEXT_STEP,
  GOAL_STATE_VERSION,
  goalTokenBudgetReason,
  isGoalTokenBudgetSpent,
  isRepeatedBlockerProposal,
  type GoalControlRequest,
  type GoalEvidenceCheckpoint,
  type GoalLimitKind,
  type GoalSnapshotV2,
  type GoalStateCause,
  type GoalStateRecordPayloadV2,
  type GoalStateResponse,
  type GoalTerminalProposal,
  type GoalTurnPermit,
  type TranscriptCursor,
  validateGoalProposalReason,
} from './goal-protocol.js';
import {
  elapsedActiveTime,
  GoalInvalidTransitionError,
  reduceGoalControl,
  reduceGoalTurnFinished,
} from './goal-reducer.js';
import type {
  GoalVerificationResult,
  GoalVerifier,
  GoalVerifierInput,
} from './goal-verifier.js';
import {
  createMigratedGoalState,
  recoverGoalFromRecords,
  type GoalRecoveryRecord,
} from './goal-persistence.js';

export const GOAL_RUNTIME_DISPOSED_MESSAGE = 'Goal runtime has been disposed';
export const STALE_GOAL_TURN_MESSAGE = 'Goal turn permit is no longer valid';

export interface GoalJournal {
  getTranscriptCursor(): TranscriptCursor;
  recordGoalState(
    recordUuid: string,
    payload: GoalStateRecordPayloadV2,
  ): Promise<unknown>;
}

export interface CreateGoalRuntimeOptions {
  journal: GoalJournal;
  evidenceSource?: GoalEvidenceSource;
  verifier?: GoalVerifier;
  checkpointVerifier?: GoalCheckpointVerifier;
  tokenLedger?: GoalTurnTokenLedger;
  /**
   * The autonomous spend window one user action (create, edit of a spent
   * Goal, or resume of a Goal whose ceiling is spent) arms, in `tokensUsed`
   * tokens. Defaults to `GOAL_DEFAULT_TOKEN_BUDGET`; tests shrink it to
   * make the bound reachable. A non-finite grant (`Infinity`) opts out:
   * Goals are then created unbounded, exactly like Goals persisted before
   * budgets existed.
   */
  tokenBudgetGrant?: number;
}

/**
 * The tokens a finished Goal turn billed.
 *
 * Scoped to the turn rather than to the session: the ledger is fed by the
 * records the turn itself produced, so an interleaved user turn or a resumed
 * session's replayed history is never attributed to a Goal.
 */
export interface GoalTurnTokenLedger {
  /** Tokens billed to `turnId`, consumed so a turn is counted once. */
  takeGoalTurnTokens(turnId: string): number;
}

export interface GoalEvidenceSource {
  flush(): Promise<void>;
  readActiveTranscriptChain(): Promise<readonly GoalEvidenceRecord[]>;
}

export class GoalPersistenceUnavailableError extends Error {
  constructor(
    message = 'Goal persistence is unavailable for this session',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GoalPersistenceUnavailableError';
  }
}

export interface GoalTurnHost {
  startGoalTurn(input: {
    permit: GoalTurnPermit;
    continuationContext: string;
    /**
     * Set on the first continuation carrying an objective the model has not
     * been handed before, when it had been handed an earlier one. Hosts pass
     * it straight to `renderGoalContinuationPrompt`.
     */
    objectiveUpdated?: boolean;
    /**
     * Set on the one continuation a spent budget still grants: the model is
     * to hand off, not to keep working. Hosts pass it straight to
     * `renderGoalContinuationPrompt`.
     */
    windDown?: boolean;
    verifierFeedback?: string;
  }): Promise<void>;
  preemptGoalTurn(reason: string): void;
}

export interface GoalProposalReceipt {
  recorded: boolean;
  readyForVerification: boolean;
}

export interface GoalWorkerView {
  goalId: string;
  revision: number;
  objective: string;
  evidenceCursor: TranscriptCursor;
  evidenceCatalog?: GoalEvidenceCatalog;
  verifierFeedback?: string;
}

export interface GoalPendingProposal {
  permit: GoalTurnPermit;
  proposal: GoalTerminalProposal;
}

export interface GoalRuntime {
  getSnapshot(): GoalSnapshotV2;
  getSnapshotForPermit?(permit: GoalTurnPermit): GoalSnapshotV2;
  /**
   * The cause the last successful {@link restore} broadcast, or undefined if
   * nothing was recovered. Lets a subscriber that attached after restore —
   * the ACP resume path always does — republish the recovered state with the
   * cause the broadcast carried.
   */
  getRecoveryCause?(): GoalStateCause | undefined;
  subscribe(
    listener: (snapshot: GoalSnapshotV2, cause?: GoalStateCause) => void,
  ): () => void;
  restore(records: readonly GoalRecoveryRecord[]): Promise<void>;
  prepareRestore(
    records: readonly GoalRecoveryRecord[],
    checkpointWindow?: GoalEvidenceCheckpointWindow,
  ): Promise<void>;
  getPreparedRestore(): Promise<void>;
  activateRestoredWork(): Promise<void>;
  dispatch(
    request: GoalControlRequest,
    options?: { refuseIfActive?: boolean },
  ): Promise<GoalStateResponse>;
  bindHost(host: GoalTurnHost): () => void;
  beginTurn(turnKey: string): GoalTurnPermit | undefined;
  releaseTurn(
    turnKey: string,
    options?: { requeue?: boolean },
  ): Promise<boolean>;
  /**
   * Confirms the turn's prompt reached the model.
   *
   * Every host resolves `startGoalTurn` at enqueue time, before the model
   * sees the prompt, so acceptance is not delivery. A continuation dropped
   * after this call keeps its announcement; one dropped before it leaves
   * its notice owed to the replacement continuation.
   */
  markTurnDelivered(turnKey: string): void;
  permitForTurn(turnKey: string): GoalTurnPermit | undefined;
  getVerifierFeedback(permit: GoalTurnPermit): string | undefined;
  finishTurn(permit: GoalTurnPermit): Promise<void>;
  getGoalForWorker(permit: GoalTurnPermit): Promise<GoalWorkerView>;
  recordTerminalProposal(
    permit: GoalTurnPermit,
    proposal: GoalTerminalProposal,
  ): GoalProposalReceipt;
  takePendingTerminalProposal(): GoalPendingProposal | undefined;
  dispose(): void;
}

function normalizeRecoveredBlockedAudit(
  audit: NonNullable<GoalStateRecordPayloadV2['blockedAudit']>,
): NonNullable<GoalStateRecordPayloadV2['blockedAudit']> {
  return {
    ...structuredClone(audit),
    fingerprint: audit.fingerprint.startsWith('\n')
      ? `repeated${audit.fingerprint}`
      : audit.fingerprint,
  };
}

export function createGoalRuntime(
  options: CreateGoalRuntimeOptions,
): GoalRuntime & {
  getSnapshotForPermit(permit: GoalTurnPermit): GoalSnapshotV2;
} {
  if (Boolean(options.evidenceSource) !== Boolean(options.verifier)) {
    throw new Error(
      'Goal evidence source and verifier must be configured together',
    );
  }
  if (options.checkpointVerifier && !options.evidenceSource) {
    throw new Error('Goal checkpoint verifier requires a Goal evidence source');
  }

  let snapshot: GoalSnapshotV2 = {
    v: GOAL_STATE_VERSION,
    goal: null,
    activity: 'idle',
  };
  const listeners = new Set<
    (value: GoalSnapshotV2, cause?: GoalStateCause) => void
  >();
  let dispatchTail = Promise.resolve();
  let host: GoalTurnHost | undefined;
  let currentPermit: GoalTurnPermit | undefined;
  let currentPermitHost: GoalTurnHost | undefined;
  let currentTurnKey: string | undefined;
  let queuedTurnKey: string | undefined;
  let continuationQueued = false;
  /**
   * The objective text the model last received in a continuation prompt.
   *
   * Committed when a continuation is delivered (`markTurnDelivered`) or finishes,
   * not when it is merely accepted: every host resolves `startGoalTurn` at
   * enqueue time, and a turn dropped before the model sees it must leave
   * its notice owed to the replacement. Keyed on content rather than the
   * (goalId, revision) pair because an edit that bumps the revision without
   * changing the text hands the model nothing new. Only continuations
   * count: a user turn carries the user's own text, not the objective, so
   * it neither announces nor stales one. Held in memory rather than on the
   * record because the consequence of losing it across a restart is one
   * missing prompt line -- the objective itself still travels in the data
   * block on every turn, and `get_goal` stays authoritative.
   */
  let announcedObjective: string | undefined;
  /**
   * The announcement the in-flight continuation carries, committed or
   * discarded as a whole when the turn settles: delivered turns commit it,
   * released or invalidated undelivered turns discard it.
   */
  let currentTurnAnnouncement: string | undefined;
  let currentTurnDelivered = false;
  let currentProposal:
    | {
        proposal: GoalTerminalProposal;
        readyForVerification: boolean;
        blockedAuditCandidate?: {
          fingerprint: string;
          count: number;
          turnIds: string[];
        };
      }
    | undefined;
  let pendingProposal: GoalPendingProposal | undefined;
  let verificationAttempt:
    | {
        permit: GoalTurnPermit;
        proposal: GoalTerminalProposal;
        goal: NonNullable<GoalSnapshotV2['goal']>;
        controller: AbortController;
      }
    | undefined;
  let checkpointAttempt:
    | {
        permit: GoalTurnPermit;
        goal: NonNullable<GoalSnapshotV2['goal']>;
        recordUuid: string;
        controller: AbortController;
      }
    | undefined;
  let blockedAudit: GoalStateRecordPayloadV2['blockedAudit'];
  let nextVerifierFeedback: string | undefined;
  let currentTurnFeedback: string | undefined;
  let restored = false;
  let restoreActivationPending = false;
  /**
   * The permit turn of the wind-down continuation now in flight, if any.
   * In memory only: a wind-down the host dropped undelivered must be minted
   * again, and only a wind-down turn that finishes delivered stamps the
   * record; one finished under someone else's text leaves the hand-off owed.
   */
  let windDownTurnId: string | undefined;
  let restorePreparation: Promise<CheckpointAttempt | undefined> | undefined;
  let restoreActivation: Promise<void> | undefined;
  let preparedRestoreCause: GoalStateCause | undefined;
  let preparedRestoreHasSnapshot = false;
  let preparedCheckpointWindow: GoalEvidenceCheckpointWindow | undefined;
  let disposed = false;
  let recoveryError: Error | undefined;
  /**
   * The cause `restore()` broadcast. Retained because that broadcast can fire
   * before anything has subscribed — the ACP resume path constructs its
   * Session well after the Config constructor kicks restore off — and the
   * `migrated -> paused` projection is only correct if the client sees the
   * cause, not just the snapshot.
   */
  let recoveryCause: GoalStateCause | undefined;
  type VerificationAttempt = NonNullable<typeof verificationAttempt>;
  type CheckpointAttempt = NonNullable<typeof checkpointAttempt>;

  const createCheckpointAttempt = (
    permit: GoalTurnPermit,
    goal: NonNullable<GoalSnapshotV2['goal']>,
    recordUuid: string = randomUUID(),
  ): CheckpointAttempt | undefined =>
    options.evidenceSource && options.checkpointVerifier
      ? {
          permit: structuredClone(permit),
          goal: structuredClone(goal),
          recordUuid,
          controller: new AbortController(),
        }
      : undefined;

  /**
   * The finishing turn's spend, or zero when nothing can answer.
   *
   * Goal accounting is bookkeeping: a ledger that is absent or that throws
   * costs the Goal its spend figure for this turn, never the turn itself.
   */
  const takeTurnTokens = (turnId: string): number => {
    if (!options.tokenLedger) return 0;
    try {
      const tokens = options.tokenLedger.takeGoalTurnTokens(turnId);
      return Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
    } catch {
      return 0;
    }
  };

  const tokenBudgetGrant =
    options.tokenBudgetGrant ?? GOAL_DEFAULT_TOKEN_BUDGET;

  /**
   * The shared `usage_limited` settle: every stop builds the same limited
   * snapshot, journals it, then commits it in memory and broadcasts. Each
   * settling site keeps its own re-entry guard and flag resets around this.
   */
  const usageLimitedSnapshot = (
    goal: NonNullable<GoalSnapshotV2['goal']>,
    reason: string,
    limitKind?: GoalLimitKind,
  ): GoalSnapshotV2 => {
    const now = Date.now();
    return {
      v: GOAL_STATE_VERSION,
      goal: {
        ...goal,
        status: 'usage_limited',
        activeTimeMs: elapsedActiveTime(goal, now),
        updatedAt: now,
        lastReason: reason,
        ...(limitKind === undefined ? {} : { limitKind }),
      },
      activity: 'idle',
    };
  };

  const journalUsageLimitedSettle = async (
    goal: NonNullable<GoalSnapshotV2['goal']>,
    reason: string,
    limitKind?: GoalLimitKind,
  ): Promise<GoalSnapshotV2> => {
    const limitedSnapshot = usageLimitedSnapshot(goal, reason, limitKind);
    await options.journal.recordGoalState(randomUUID(), {
      v: GOAL_STATE_VERSION,
      cause: 'usage_limited',
      snapshot: limitedSnapshot,
    });
    return limitedSnapshot;
  };

  const commitUsageLimitedSettle = (limitedSnapshot: GoalSnapshotV2): void => {
    continuationQueued = false;
    currentTurnFeedback = undefined;
    snapshot = structuredClone(limitedSnapshot);
    broadcast('usage_limited');
  };

  /**
   * Settle a spent budget instead of minting a continuation.
   *
   * Runs from `queueContinuation`, the single point every autonomous
   * continuation passes through, so one gate bounds every continuation loop
   * at once -- turn cadence, verifier-rejection retries, checkpoint cycles,
   * and families not yet discovered. User-driven turns never pass through
   * here and are never blocked by the budget.
   */
  const stopForSpentBudget = () => {
    void enqueue(async () => {
      const goal = snapshot.goal;
      if (
        !goal ||
        goal.status !== 'active' ||
        !isGoalTokenBudgetSpent(goal) ||
        currentPermit ||
        pendingProposal ||
        verificationAttempt ||
        checkpointAttempt
      ) {
        return;
      }
      const reason = goalTokenBudgetReason(goal.tokenBudget);
      let limitedSnapshot: GoalSnapshotV2;
      try {
        limitedSnapshot = await journalUsageLimitedSettle(
          goal,
          reason,
          'token_budget',
        );
      } catch {
        // A lost settle write must not strand an "active" Goal the gate will
        // never continue: the window is spent either way, so show the stop
        // and let the user's next action surface the persistence loss.
        limitedSnapshot = usageLimitedSnapshot(goal, reason, 'token_budget');
      }
      if (
        snapshot.goal?.goalId !== goal.goalId ||
        snapshot.goal.revision !== goal.revision ||
        snapshot.goal.status !== 'active' ||
        currentPermit
      ) {
        return;
      }
      commitUsageLimitedSettle(limitedSnapshot);
    }).catch(() => undefined);
  };

  const withCheckpointStalls = (
    goal: NonNullable<GoalSnapshotV2['goal']>,
    checkpointStalls: number,
  ): NonNullable<GoalSnapshotV2['goal']> => {
    const { checkpointStalls: _previous, ...rest } = goal;
    return checkpointStalls > 0 ? { ...rest, checkpointStalls } : rest;
  };

  const assertAvailable = () => {
    if (disposed) throw new Error(GOAL_RUNTIME_DISPOSED_MESSAGE);
  };

  const assertOperational = () => {
    assertAvailable();
    if (recoveryError) throw recoveryError;
  };

  const getSnapshot = (): GoalSnapshotV2 => structuredClone(snapshot);

  const broadcast = (cause?: GoalStateCause) => {
    for (const listener of listeners) {
      try {
        listener(getSnapshot(), cause);
      } catch {
        // Subscribers cannot roll back a committed runtime transition.
      }
    }
  };

  const preemptHost = (reason: string, target = host) => {
    try {
      target?.preemptGoalTurn(reason);
    } catch {
      // The lifecycle is already committed before host preemption begins.
    }
  };

  /**
   * Settles the in-flight continuation's announcement: delivered turns
   * commit it (the model holds that objective now), anything else discards
   * it so a later continuation re-derives the notice it carried.
   */
  const settleCurrentTurnAnnouncement = (delivered: boolean) => {
    if (delivered && currentTurnAnnouncement !== undefined) {
      announcedObjective = currentTurnAnnouncement;
    }
    currentTurnAnnouncement = undefined;
    currentTurnDelivered = false;
  };

  const flushContinuation = (cause?: GoalStateCause, windDown = false) => {
    if (
      !continuationQueued ||
      !host ||
      currentPermit ||
      pendingProposal ||
      verificationAttempt ||
      checkpointAttempt ||
      snapshot.activity !== 'idle' ||
      snapshot.goal?.status !== 'active'
    ) {
      return;
    }
    continuationQueued = false;
    const scheduledHost = host;
    const continuationContext = snapshot.goal.objective;
    const verifierFeedback = nextVerifierFeedback;
    nextVerifierFeedback = undefined;
    currentTurnFeedback = verifierFeedback;
    currentPermit = {
      goalId: snapshot.goal.goalId,
      revision: snapshot.goal.revision,
      turnId: randomUUID(),
    };
    currentPermitHost = scheduledHost;
    currentTurnKey = `goal-runtime:${currentPermit.turnId}`;
    const startedPermit = structuredClone(currentPermit);
    // The model is about to be handed objective text different from the one
    // it last received. Content is the key, not the (goalId, revision) pair:
    // a no-op edit bumps the revision without changing what the model gets,
    // and firing the notice for a change that did not happen would make the
    // model stop work for nothing. No previous announcement means this is
    // the model's first continuation, which supersedes nothing.
    const objectiveUpdated =
      announcedObjective !== undefined &&
      announcedObjective !== continuationContext;
    currentTurnAnnouncement = continuationContext;
    currentTurnDelivered = false;
    windDownTurnId = windDown ? startedPermit.turnId : undefined;
    snapshot = { ...snapshot, activity: 'running' };
    broadcast(cause);
    const handleStartFailure = () => {
      void enqueue(async () => {
        if (isCurrentPermit(startedPermit)) {
          // The prompt never reached a host: discard the announcement
          // whole so the retry re-derives the notice it carried.
          settleCurrentTurnAnnouncement(false);
          const nextTurnKey = queuedTurnKey;
          currentPermit = undefined;
          currentPermitHost = undefined;
          currentTurnKey = undefined;
          currentProposal = undefined;
          if (currentTurnFeedback !== undefined) {
            nextVerifierFeedback ??= currentTurnFeedback;
          }
          currentTurnFeedback = undefined;
          if (host === scheduledHost) host = undefined;
          if (nextTurnKey && snapshot.goal?.status === 'active') {
            currentPermit = {
              goalId: snapshot.goal.goalId,
              revision: snapshot.goal.revision,
              turnId: randomUUID(),
            };
            currentPermitHost = host;
            currentTurnKey = nextTurnKey;
            currentTurnFeedback = nextVerifierFeedback;
            nextVerifierFeedback = undefined;
            queuedTurnKey = undefined;
            continuationQueued = false;
            snapshot = { ...snapshot, activity: 'running' };
          } else {
            snapshot = { ...snapshot, activity: 'idle' };
          }
          broadcast();
          if (!currentPermit) queueContinuation();
        }
      }).catch(() => undefined);
    };
    let started: Promise<void>;
    try {
      started = scheduledHost.startGoalTurn({
        permit: startedPermit,
        continuationContext,
        ...(objectiveUpdated ? { objectiveUpdated } : {}),
        ...(windDown ? { windDown } : {}),
        ...(verifierFeedback ? { verifierFeedback } : {}),
      });
    } catch {
      handleStartFailure();
      return;
    }
    void started.catch(handleStartFailure);
  };

  const queueContinuation = (cause?: GoalStateCause) => {
    if (
      restoreActivationPending ||
      snapshot.goal?.status !== 'active' ||
      currentPermit ||
      pendingProposal ||
      verificationAttempt ||
      checkpointAttempt
    ) {
      return;
    }
    if (isGoalTokenBudgetSpent(snapshot.goal)) {
      // A spent window buys one hand-off before it stops. The record marks
      // the hand-off that was delivered and finished; until then -- never
      // granted, dropped before the model saw it, or finished under someone
      // else's text -- grant it.
      if (snapshot.goal.windDownTurnId !== undefined) {
        stopForSpentBudget();
        return;
      }
      continuationQueued = true;
      flushContinuation(cause, true);
      return;
    }
    continuationQueued = true;
    flushContinuation(cause);
  };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = dispatchTail.then(operation, operation);
    dispatchTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const isCurrentPermit = (permit: GoalTurnPermit) =>
    snapshot.goal?.goalId === permit.goalId &&
    snapshot.goal.revision === permit.revision &&
    currentPermit?.goalId === permit.goalId &&
    currentPermit.revision === permit.revision &&
    currentPermit.turnId === permit.turnId;

  const getSnapshotForPermit = (permit: GoalTurnPermit): GoalSnapshotV2 => {
    assertOperational();
    if (!isCurrentPermit(permit) || !snapshot.goal) {
      throw new Error(STALE_GOAL_TURN_MESSAGE);
    }
    return getSnapshot();
  };

  const isCurrentVerificationAttempt = (attempt: VerificationAttempt) =>
    verificationAttempt === attempt &&
    snapshot.goal?.goalId === attempt.permit.goalId &&
    snapshot.goal.revision === attempt.permit.revision &&
    snapshot.goal.status === 'active' &&
    snapshot.activity === 'verifying';

  const isCurrentCheckpointAttempt = (attempt: CheckpointAttempt) =>
    checkpointAttempt === attempt &&
    snapshot.goal?.goalId === attempt.permit.goalId &&
    snapshot.goal.revision === attempt.permit.revision &&
    snapshot.goal.status === 'active' &&
    snapshot.activity === 'verifying';

  const invalidateAttempts = (reason: string) => {
    const attempt = verificationAttempt;
    const checkpoint = checkpointAttempt;
    verificationAttempt = undefined;
    checkpointAttempt = undefined;
    pendingProposal = undefined;
    if (attempt && !attempt.controller.signal.aborted) {
      attempt.controller.abort(new Error(reason));
    }
    if (checkpoint && !checkpoint.controller.signal.aborted) {
      checkpoint.controller.abort(new Error(reason));
    }
  };

  const verifierInput = (
    attempt: VerificationAttempt,
    evidence: ReturnType<typeof validateGoalEvidenceReferences>,
  ): GoalVerifierInput => {
    const currentDeliveredOutput = evidence.citedRecords
      .filter(
        (record) =>
          record.proofKind === 'delivered_output' &&
          record.turnId === attempt.permit.turnId,
      )
      .map((record) => record.content);
    const base = {
      goal: {
        goalId: attempt.goal.goalId,
        revision: attempt.goal.revision,
        objective: attempt.goal.objective,
      },
      currentTurnId: attempt.permit.turnId,
      evidence: evidence.citedRecords,
      ...(currentDeliveredOutput.length > 0 ? { currentDeliveredOutput } : {}),
    };
    if (attempt.proposal.status === 'complete') {
      return {
        ...base,
        proposal: { ...attempt.proposal, status: 'complete' },
      };
    }
    return {
      ...base,
      proposal: { ...attempt.proposal, status: 'blocked' },
      blockedPolicy:
        'A blocked Goal is resumable. It may be accepted immediately only when the evidence shows that new user authority or a material user choice is required, or that an external state change is required, and no meaningful in-scope work remains. An infeasible blocker may also be accepted immediately, only when cited external_fact evidence shows the objective cannot be satisfied as written: it contradicts itself, it names a target that verifiably does not exist, or it requires an action outside what the tools can perform; reject it when the obstacle is difficulty, uncertainty, information the model could still obtain, or a preference to ask. An ordinary technical blocker requires evidence of the same cause from the current and two immediately preceding Goal turns. Difficulty, uncertainty, incomplete work, or a preference for clarification do not by themselves justify blocked.',
    };
  };

  const promoteQueuedUserTurn = (): boolean => {
    const nextTurnKey = queuedTurnKey;
    if (!nextTurnKey || currentPermit || snapshot.goal?.status !== 'active') {
      return false;
    }
    queuedTurnKey = undefined;
    continuationQueued = false;
    currentPermit = {
      goalId: snapshot.goal.goalId,
      revision: snapshot.goal.revision,
      turnId: randomUUID(),
    };
    currentPermitHost = host;
    currentTurnKey = nextTurnKey;
    currentTurnFeedback = nextVerifierFeedback;
    nextVerifierFeedback = undefined;
    snapshot = { ...snapshot, activity: 'running' };
    return true;
  };

  const admitAfterRejection = (): boolean => {
    continuationQueued = false;
    if (promoteQueuedUserTurn()) return false;
    const activityBefore = snapshot.activity;
    queueContinuation('verifier_reject');
    return activityBefore !== snapshot.activity;
  };

  const recordVerificationOutcome = async (
    attempt: VerificationAttempt,
    outcome:
      | { kind: 'decision'; result: GoalVerificationResult }
      | {
          kind: 'usage_limited';
          reason: string;
          limitKind?: GoalLimitKind;
        },
  ): Promise<CheckpointAttempt | undefined> =>
    enqueue(async () => {
      if (!isCurrentVerificationAttempt(attempt) || !snapshot.goal) return;

      const now = Date.now();
      if (outcome.kind === 'decision' && outcome.result.decision === 'accept') {
        const acceptedGoal = {
          ...snapshot.goal,
          activeTimeMs: elapsedActiveTime(snapshot.goal, now),
          updatedAt: now,
          lastReason:
            attempt.proposal.blockerKind === 'infeasible'
              ? `${outcome.result.reason} ${GOAL_INFEASIBLE_NEXT_STEP}`
              : outcome.result.reason,
        };
        const acceptedSnapshot: GoalSnapshotV2 = {
          v: GOAL_STATE_VERSION,
          goal: acceptedGoal,
          activity: 'idle',
        };
        const terminalSnapshot: GoalSnapshotV2 = {
          v: GOAL_STATE_VERSION,
          goal: {
            ...acceptedGoal,
            status: attempt.proposal.status,
          },
          activity: 'idle',
        };
        await options.journal.recordGoalState(randomUUID(), {
          v: GOAL_STATE_VERSION,
          cause: 'verifier_accept',
          snapshot: acceptedSnapshot,
        });
        if (!isCurrentVerificationAttempt(attempt) || !snapshot.goal) return;
        await options.journal.recordGoalState(randomUUID(), {
          v: GOAL_STATE_VERSION,
          cause: attempt.proposal.status,
          snapshot: terminalSnapshot,
        });
        if (!isCurrentVerificationAttempt(attempt) || !snapshot.goal) return;
        verificationAttempt = undefined;
        pendingProposal = undefined;
        if (attempt.proposal.status === 'complete') queuedTurnKey = undefined;
        continuationQueued = false;
        nextVerifierFeedback = undefined;
        currentTurnFeedback = undefined;
        // A completed Goal ended holding the objective the model has; a
        // fresh Goal after it is a new work item, not a replacement. A
        // blocked Goal is suspended, not ended: it resumes with the objective
        // the model already holds, so its announcement stays, exactly as a
        // usage-limited Goal's does -- otherwise blocked -> edit -> resume
        // would send no notice for a real change.
        if (attempt.proposal.status === 'complete') {
          announcedObjective = undefined;
        }
        snapshot = structuredClone(terminalSnapshot);
        broadcast(attempt.proposal.status);
        return undefined;
      }

      if (outcome.kind === 'usage_limited') {
        const limitedSnapshot = await journalUsageLimitedSettle(
          snapshot.goal,
          outcome.reason,
          outcome.limitKind,
        );
        if (!isCurrentVerificationAttempt(attempt) || !snapshot.goal) return;
        verificationAttempt = undefined;
        pendingProposal = undefined;
        nextVerifierFeedback = undefined;
        commitUsageLimitedSettle(limitedSnapshot);
        return undefined;
      }

      const rejectedCheckpoint = isRepeatedBlockerProposal(attempt.proposal)
        ? undefined
        : createCheckpointAttempt(attempt.permit, snapshot.goal);
      const rejectedSnapshot: GoalSnapshotV2 = {
        v: GOAL_STATE_VERSION,
        goal: {
          ...snapshot.goal,
          activeTimeMs: elapsedActiveTime(snapshot.goal, now),
          updatedAt: now,
          lastReason: outcome.result.reason,
        },
        activity: 'idle',
      };
      await options.journal.recordGoalState(randomUUID(), {
        v: GOAL_STATE_VERSION,
        cause: 'verifier_reject',
        snapshot: rejectedSnapshot,
        ...(rejectedCheckpoint
          ? {
              checkpointPending: {
                permit: structuredClone(rejectedCheckpoint.permit),
                recordUuid: rejectedCheckpoint.recordUuid,
              },
            }
          : {}),
        ...(blockedAudit
          ? { blockedAudit: structuredClone(blockedAudit) }
          : {}),
      });
      if (!isCurrentVerificationAttempt(attempt) || !snapshot.goal) return;
      verificationAttempt = undefined;
      pendingProposal = undefined;
      checkpointAttempt = rejectedCheckpoint;
      snapshot = {
        ...structuredClone(rejectedSnapshot),
        activity: rejectedCheckpoint ? 'verifying' : 'idle',
      };
      nextVerifierFeedback = outcome.result.reason;
      if (rejectedCheckpoint) {
        continuationQueued = false;
        broadcast('verifier_reject');
        return rejectedCheckpoint;
      }
      const continuationBroadcast = admitAfterRejection();
      if (!continuationBroadcast) broadcast('verifier_reject');
      return undefined;
    });

  // Post-commit checkpoint recording is best-effort bookkeeping. When its
  // persistence fails, settle the attempt it left behind so the runtime
  // converges with the committed snapshot instead of stranding the goal on
  // an activity that no later operation can clear.
  const settleDanglingAttempt = (permit: GoalTurnPermit): Promise<void> =>
    enqueue(async () => {
      if (disposed) return;
      const dangling = verificationAttempt ?? checkpointAttempt;
      if (!dangling) return;
      if (
        snapshot.goal?.goalId !== permit.goalId ||
        snapshot.goal?.revision !== permit.revision
      ) {
        return;
      }
      verificationAttempt = undefined;
      checkpointAttempt = undefined;
      pendingProposal = undefined;
      snapshot = { ...snapshot, activity: 'idle' };
      broadcast();
      if (promoteQueuedUserTurn()) {
        broadcast();
      } else {
        queueContinuation();
      }
    });

  const runVerification = async (
    attempt: VerificationAttempt,
  ): Promise<void> => {
    const evidenceSource = options.evidenceSource;
    const verifier = options.verifier;
    if (!evidenceSource || !verifier) return;

    let outcome:
      | { kind: 'decision'; result: GoalVerificationResult }
      | {
          kind: 'usage_limited';
          reason: string;
          limitKind?: GoalLimitKind;
        };
    try {
      await evidenceSource.flush();
      if (attempt.controller.signal.aborted) return;
      const records = await evidenceSource.readActiveTranscriptChain();
      if (attempt.controller.signal.aborted) return;
      const evidence = validateGoalEvidenceReferences({
        records,
        goal: attempt.goal,
        permit: attempt.permit,
        proposal: attempt.proposal,
      });
      const result = await verifier(
        verifierInput(attempt, evidence),
        attempt.controller.signal,
      );
      if (attempt.controller.signal.aborted) return;
      outcome = { kind: 'decision', result };
    } catch (error) {
      if (attempt.controller.signal.aborted) return;
      if (error instanceof InvalidGoalEvidenceReferenceError) {
        outcome =
          error.code === 'catalog_truncated'
            ? {
                kind: 'usage_limited',
                reason: error.message,
                limitKind: 'evidence_catalog',
              }
            : {
                kind: 'decision',
                result: { decision: 'reject', reason: error.message },
              };
      } else {
        const reason =
          error instanceof EvidenceSourceUnavailableError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        outcome = { kind: 'usage_limited', reason };
      }
    }
    const checkpoint = await recordVerificationOutcome(attempt, outcome);
    if (!checkpoint) return;
    try {
      await runCheckpoint(checkpoint);
    } catch {
      // Same contract as finishTurn: the verifier outcome committed, so a
      // failed checkpoint recording settles instead of escaping.
      await settleDanglingAttempt(checkpoint.permit);
    }
  };

  const finishCheckpointCheck = async (
    attempt: CheckpointAttempt,
    outcome: 'room' | 'stalled' | 'inconclusive' = 'inconclusive',
  ): Promise<void> => {
    await enqueue(async () => {
      if (!isCurrentCheckpointAttempt(attempt) || !snapshot.goal) return;
      // Only a check that found room ends a stall streak. A check that
      // never ran or failed transiently proved nothing about the window;
      // resetting there would launder the count. An unusable verifier
      // result while the window overflowed counts like a stalled checkpoint.
      const checkpointStalls =
        outcome === 'room'
          ? 0
          : outcome === 'stalled'
            ? (snapshot.goal.checkpointStalls ?? 0) + 1
            : (snapshot.goal.checkpointStalls ?? 0);
      if (
        await settleIfCheckpointStalled(
          attempt,
          snapshot.goal,
          checkpointStalls,
        )
      ) {
        return;
      }
      const persistedCause =
        nextVerifierFeedback === undefined ? 'checkpoint' : 'verifier_reject';
      const now = Date.now();
      const checkedSnapshot: GoalSnapshotV2 = {
        v: GOAL_STATE_VERSION,
        goal: {
          ...withCheckpointStalls(snapshot.goal, checkpointStalls),
          activeTimeMs: elapsedActiveTime(snapshot.goal, now),
          updatedAt: now,
        },
        activity: 'idle',
      };
      await options.journal.recordGoalState(attempt.recordUuid, {
        v: GOAL_STATE_VERSION,
        cause: persistedCause,
        snapshot: checkedSnapshot,
        ...(blockedAudit
          ? { blockedAudit: structuredClone(blockedAudit) }
          : {}),
      });
      if (!isCurrentCheckpointAttempt(attempt) || !snapshot.goal) return;
      checkpointAttempt = undefined;
      snapshot = structuredClone(checkedSnapshot);
      if (promoteQueuedUserTurn()) {
        broadcast('checkpoint');
      } else {
        queueContinuation('checkpoint');
      }
    });
  };

  /** The `usage_limited` settle for a checkpoint attempt; runs on the queue. */
  const settleCheckpointFailure = async (
    attempt: CheckpointAttempt,
    goal: NonNullable<GoalSnapshotV2['goal']>,
    reason: string,
    limitKind?: GoalLimitKind,
  ): Promise<void> => {
    const limitedSnapshot = await journalUsageLimitedSettle(
      goal,
      reason,
      limitKind,
    );
    if (!isCurrentCheckpointAttempt(attempt) || !snapshot.goal) return;
    checkpointAttempt = undefined;
    // Keep nextVerifierFeedback: a rejection committed before this
    // checkpoint failure must still reach the resumed continuation.
    commitUsageLimitedSettle(limitedSnapshot);
  };

  /**
   * Stops the Goal once its stall streak reaches the limit, persisting the
   * streak with the stop so the record explains itself. Returns whether the
   * attempt was settled.
   */
  const settleIfCheckpointStalled = async (
    attempt: CheckpointAttempt,
    goal: NonNullable<GoalSnapshotV2['goal']>,
    checkpointStalls: number,
  ): Promise<boolean> => {
    if (checkpointStalls < GOAL_CHECKPOINT_STALL_LIMIT) return false;
    await settleCheckpointFailure(
      attempt,
      withCheckpointStalls(goal, checkpointStalls),
      GOAL_CHECKPOINT_STALLED_REASON,
      'evidence_catalog',
    );
    return true;
  };

  const recordCheckpointFailure = async (
    attempt: CheckpointAttempt,
    reason: string,
    limitKind?: GoalLimitKind,
  ): Promise<void> => {
    await enqueue(async () => {
      if (!isCurrentCheckpointAttempt(attempt) || !snapshot.goal) return;
      await settleCheckpointFailure(attempt, snapshot.goal, reason, limitKind);
    });
  };

  const recordCheckpoint = async (
    attempt: CheckpointAttempt,
    checkpoint: NonNullable<GoalSnapshotV2['goal']>['evidenceCheckpoint'],
    stalled: boolean,
  ): Promise<void> => {
    if (!checkpoint) return;
    await enqueue(async () => {
      if (!isCurrentCheckpointAttempt(attempt) || !snapshot.goal) return;
      const checkpointStalls = stalled
        ? (snapshot.goal.checkpointStalls ?? 0) + 1
        : 0;
      // A stopped Goal discards the checkpoint it would have written: a
      // resumed window restarts from a fresh cursor anyway.
      if (
        await settleIfCheckpointStalled(
          attempt,
          snapshot.goal,
          checkpointStalls,
        )
      ) {
        return;
      }
      const now = Date.now();
      const persistedCause =
        nextVerifierFeedback === undefined ? 'checkpoint' : 'verifier_reject';
      const checkpointSnapshot: GoalSnapshotV2 = {
        v: GOAL_STATE_VERSION,
        goal: {
          ...withCheckpointStalls(snapshot.goal, checkpointStalls),
          evidenceCursor: { recordId: attempt.recordUuid },
          evidenceCheckpoint: checkpoint,
          activeTimeMs: elapsedActiveTime(snapshot.goal, now),
          updatedAt: now,
        },
        activity: 'idle',
      };
      await options.journal.recordGoalState(attempt.recordUuid, {
        v: GOAL_STATE_VERSION,
        cause: persistedCause,
        snapshot: checkpointSnapshot,
        ...(blockedAudit
          ? { blockedAudit: structuredClone(blockedAudit) }
          : {}),
      });
      if (!isCurrentCheckpointAttempt(attempt) || !snapshot.goal) return;
      checkpointAttempt = undefined;
      snapshot = structuredClone(checkpointSnapshot);
      if (promoteQueuedUserTurn()) {
        broadcast('checkpoint');
      } else {
        queueContinuation('checkpoint');
      }
    });
  };

  const runCheckpoint = async (
    attempt: CheckpointAttempt,
    preparedWindow?: GoalEvidenceCheckpointWindow,
  ): Promise<void> => {
    const evidenceSource = options.evidenceSource;
    const checkpointVerifier = options.checkpointVerifier;
    if ((!preparedWindow && !evidenceSource) || !checkpointVerifier) {
      await recordCheckpointFailure(
        attempt,
        'Goal checkpoint recovery dependencies are unavailable',
      );
      return;
    }

    try {
      let window = preparedWindow;
      if (!window) {
        await evidenceSource!.flush();
        if (attempt.controller.signal.aborted) return;
        const records = await evidenceSource!.readActiveTranscriptChain();
        if (attempt.controller.signal.aborted) return;
        window = buildGoalEvidenceCheckpointWindow({
          records,
          goal: attempt.goal,
          permit: attempt.permit,
        });
      }
      // A truncated window still compresses: `shouldCheckpoint` stays true
      // whenever anything was captured, and folding that into claims is what
      // frees the budget. Only a window that captured nothing at all has
      // nothing to salvage, and that is the state this stops the Goal in.
      if (window.truncated && !window.shouldCheckpoint) {
        await recordCheckpointFailure(
          attempt,
          GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
          'evidence_catalog',
        );
        return;
      }
      if (!window.shouldCheckpoint) {
        await finishCheckpointCheck(attempt, 'room');
        return;
      }
      let checkpoint: GoalEvidenceCheckpoint;
      try {
        const result = await checkpointVerifier(
          {
            goal: {
              goalId: attempt.goal.goalId,
              revision: attempt.goal.revision,
              objective: attempt.goal.objective,
            },
            previousClaims: window.previousClaims,
            evidence: window.evidence,
          },
          attempt.controller.signal,
        );
        if (attempt.controller.signal.aborted) return;
        checkpoint = materializeGoalEvidenceCheckpoint({
          checkpointId: attempt.recordUuid,
          createdAt: Date.now(),
          previousClaims: window.previousClaims,
          evidence: window.evidence,
          result,
        });
      } catch (error) {
        if (attempt.controller.signal.aborted) return;
        if (error instanceof GoalCheckpointVerifierInputTooLargeError) {
          await recordCheckpointFailure(
            attempt,
            GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON,
            'checkpoint_request',
          );
          return;
        }
        if (error instanceof InvalidGoalCheckpointError && window.truncated) {
          // An unusable result while the window overflows is a compaction
          // that produced nothing: like a full claim list, it counts toward
          // the stall limit.
          await finishCheckpointCheck(attempt, 'stalled');
          return;
        }
        // A transient failure, or an unusable result while the window still
        // has room, must not abort a healthy Goal: settle the attempt as
        // bookkeeping so the evidence stays citable and a later turn retries
        // the checkpoint.
        await finishCheckpointCheck(attempt);
        return;
      }
      await recordCheckpoint(
        attempt,
        checkpoint,
        isGoalCheckpointStalled(window, checkpoint),
      );
    } catch (error) {
      if (attempt.controller.signal.aborted) return;
      if (
        error instanceof EvidenceSourceUnavailableError &&
        error.code === 'current_turn_not_tail'
      ) {
        // A turn that recorded no goal-owned transcript records (e.g. a
        // hook-blocked permit finished before anything was recorded) is a
        // legitimate empty turn, not an integrity failure; close the
        // attempt with bookkeeping only so the goal stays active.
        await finishCheckpointCheck(attempt);
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      await recordCheckpointFailure(attempt, reason);
    }
  };

  return {
    getSnapshot,
    getSnapshotForPermit,
    getRecoveryCause(): GoalStateCause | undefined {
      return recoveryCause;
    },
    subscribe(
      listener: (value: GoalSnapshotV2, cause?: GoalStateCause) => void,
    ): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prepareRestore(
      records: readonly GoalRecoveryRecord[],
      checkpointWindow?: GoalEvidenceCheckpointWindow,
    ): Promise<void> {
      if (restorePreparation) return restorePreparation.then(() => undefined);
      restoreActivationPending = true;
      preparedCheckpointWindow = checkpointWindow;
      const preparation = enqueue(
        async (): Promise<CheckpointAttempt | undefined> => {
          assertAvailable();
          if (restored) return;
          const recovery = recoverGoalFromRecords(records);
          if (recovery.kind === 'unsupported') {
            recoveryError = new GoalPersistenceUnavailableError(
              recovery.reason,
            );
            throw recoveryError;
          }
          try {
            let recoveredSnapshot: GoalSnapshotV2 | undefined;
            let recoveredCause: GoalStateCause | undefined;
            if (recovery.kind === 'v2') {
              recoveredSnapshot = {
                ...structuredClone(recovery.payload.snapshot),
                activity: 'idle',
              };
              blockedAudit = recovery.payload.blockedAudit
                ? normalizeRecoveredBlockedAudit(recovery.payload.blockedAudit)
                : undefined;
              recoveredCause = recovery.payload.cause;
              const pending = recovery.payload.checkpointPending;
              if (pending && recoveredSnapshot.goal) {
                checkpointAttempt = createCheckpointAttempt(
                  pending.permit,
                  recoveredSnapshot.goal,
                  pending.recordUuid,
                );
                if (!checkpointAttempt) {
                  throw new GoalPersistenceUnavailableError(
                    'Goal checkpoint recovery dependencies are unavailable',
                  );
                }
                recoveredSnapshot.activity = 'verifying';
              }
              if (recoveredCause === 'verifier_reject') {
                nextVerifierFeedback = recoveredSnapshot.goal?.lastReason;
              }
            } else if (recovery.kind === 'legacy') {
              const recordUuid = randomUUID();
              const payload = createMigratedGoalState({
                objective: recovery.objective,
                goalId: randomUUID(),
                recordUuid,
                now: Date.now(),
              });
              try {
                await options.journal.recordGoalState(recordUuid, payload);
              } catch (error) {
                throw new GoalPersistenceUnavailableError(
                  error instanceof Error ? error.message : String(error),
                  { cause: error },
                );
              }
              assertAvailable();
              recoveredSnapshot = structuredClone(payload.snapshot);
              recoveredCause = payload.cause;
            }
            assertAvailable();
            if (recoveredSnapshot) snapshot = recoveredSnapshot;
            recoveryError = undefined;
            restored = true;
            if (recoveredSnapshot) {
              recoveryCause = recoveredCause;
            }
            preparedRestoreHasSnapshot = recoveredSnapshot !== undefined;
            preparedRestoreCause = recoveredCause;
            return checkpointAttempt;
          } catch (error) {
            if (!disposed) {
              recoveryError =
                error instanceof Error ? error : new Error(String(error));
            }
            throw error;
          }
        },
      );
      restorePreparation = preparation;
      return preparation.then(
        () => undefined,
        (error) => {
          if (!restored && restorePreparation === preparation) {
            restorePreparation = undefined;
            restoreActivation = undefined;
            restoreActivationPending = false;
            preparedCheckpointWindow = undefined;
          }
          throw error;
        },
      );
    },
    getPreparedRestore(): Promise<void> {
      if (!restorePreparation) {
        return Promise.reject(
          new GoalPersistenceUnavailableError(
            'Goal restore preparation has not started',
          ),
        );
      }
      return restorePreparation.then(() => undefined);
    },
    activateRestoredWork(): Promise<void> {
      try {
        assertAvailable();
      } catch (error) {
        return Promise.reject(error);
      }
      if (!restorePreparation) {
        return Promise.reject(
          new GoalPersistenceUnavailableError(
            'Goal restore preparation has not started',
          ),
        );
      }
      if (restoreActivation) return restoreActivation;
      restoreActivation = restorePreparation.then(async (attempt) => {
        assertAvailable();
        restoreActivationPending = false;
        if (preparedRestoreHasSnapshot) broadcast(preparedRestoreCause);
        if (!attempt) {
          await enqueue(async () => {
            assertAvailable();
            queueContinuation();
          });
          return;
        }
        try {
          await runCheckpoint(attempt, preparedCheckpointWindow);
        } catch {
          // Recovery committed before the replay began, so a failed replay
          // degrades instead of bricking the runtime: drop the pending
          // checkpoint and let the restored goal continue.
          await settleDanglingAttempt(attempt.permit);
        }
      });
      return restoreActivation;
    },
    async restore(records: readonly GoalRecoveryRecord[]): Promise<void> {
      await this.prepareRestore(records);
      await this.activateRestoredWork();
    },
    bindHost(nextHost: GoalTurnHost): () => void {
      assertOperational();
      host = nextHost;
      queueContinuation();
      return () => {
        if (host === nextHost) host = undefined;
      };
    },
    beginTurn(turnKey: string): GoalTurnPermit | undefined {
      assertOperational();
      if (snapshot.goal?.status !== 'active') return undefined;
      if (
        snapshot.activity === 'verifying' ||
        pendingProposal ||
        verificationAttempt ||
        checkpointAttempt
      ) {
        queuedTurnKey ??= turnKey;
        continuationQueued = false;
        return undefined;
      }
      if (currentPermit) {
        if (currentTurnKey === turnKey) return structuredClone(currentPermit);
        queuedTurnKey ??= turnKey;
        continuationQueued = false;
        return undefined;
      }
      continuationQueued = false;
      currentPermit = {
        goalId: snapshot.goal.goalId,
        revision: snapshot.goal.revision,
        turnId: randomUUID(),
      };
      currentPermitHost = host;
      currentTurnKey = turnKey;
      currentTurnFeedback = nextVerifierFeedback;
      nextVerifierFeedback = undefined;
      snapshot = { ...snapshot, activity: 'running' };
      broadcast();
      return structuredClone(currentPermit);
    },
    releaseTurn(
      turnKey: string,
      options?: { requeue?: boolean },
    ): Promise<boolean> {
      return enqueue(async () => {
        assertOperational();
        let released = false;
        if (queuedTurnKey === turnKey) {
          queuedTurnKey = undefined;
          released = true;
        }
        if (currentPermit && currentTurnKey === turnKey) {
          if (currentTurnFeedback !== undefined) {
            nextVerifierFeedback ??= currentTurnFeedback;
          }
          settleCurrentTurnAnnouncement(currentTurnDelivered);
          currentPermit = undefined;
          currentPermitHost = undefined;
          currentTurnKey = undefined;
          currentTurnFeedback = undefined;
          currentProposal = undefined;
          snapshot = { ...snapshot, activity: 'idle' };
          // Promote a waiting reservation instead of minting a continuation,
          // exactly as `finishTurn` does. A continuation only reaches the
          // model once the host drains it, and the host that owns the drain
          // is blocked by the very caller waiting on `queuedTurnKey` -- so
          // scheduling one here strands that caller in `claimGoalTurn`
          // forever.
          const nextTurnKey = queuedTurnKey;
          if (
            nextTurnKey &&
            snapshot.goal?.status === 'active' &&
            !pendingProposal &&
            !verificationAttempt
          ) {
            queuedTurnKey = undefined;
            continuationQueued = false;
            currentPermit = {
              goalId: snapshot.goal.goalId,
              revision: snapshot.goal.revision,
              turnId: randomUUID(),
            };
            currentPermitHost = host;
            currentTurnKey = nextTurnKey;
            currentTurnFeedback = nextVerifierFeedback;
            nextVerifierFeedback = undefined;
            snapshot = { ...snapshot, activity: 'running' };
          }
          broadcast();
          released = true;
        }
        if (released && !currentPermit && options?.requeue !== false) {
          queueContinuation();
        }
        return released;
      });
    },
    markTurnDelivered(turnKey: string): void {
      assertOperational();
      if (currentPermit && currentTurnKey === turnKey) {
        currentTurnDelivered = true;
      }
    },
    permitForTurn(turnKey: string): GoalTurnPermit | undefined {
      assertOperational();
      return currentPermit && currentTurnKey === turnKey
        ? structuredClone(currentPermit)
        : undefined;
    },
    getVerifierFeedback(permit: GoalTurnPermit): string | undefined {
      assertOperational();
      if (!isCurrentPermit(permit)) {
        throw new Error(STALE_GOAL_TURN_MESSAGE);
      }
      return currentTurnFeedback;
    },
    finishTurn(permit: GoalTurnPermit): Promise<void> {
      const finish = enqueue(
        async (): Promise<{
          verification?: VerificationAttempt;
          checkpoint?: CheckpointAttempt;
        }> => {
          assertOperational();
          if (!isCurrentPermit(permit) || !snapshot.goal) {
            throw new Error(STALE_GOAL_TURN_MESSAGE);
          }
          // Finishing proves the permit was used, not that the continuation
          // prompt was sent under it: a system message or a direct user
          // query can claim a queued continuation's permit and send its own
          // text instead. Only the host's delivery mark says the model saw
          // the objective; without it the notice stays owed.
          const delivered = currentTurnDelivered;
          settleCurrentTurnAnnouncement(delivered);
          const recordUuid = randomUUID();
          // The same rule decides the hand-off. The record's marker means
          // "the user got the hand-off", and the budget gate stops the Goal
          // on it -- so a wind-down permit that finished under someone
          // else's text leaves no marker, and the next continuation grants
          // the hand-off again instead of stopping cold.
          const heldWindDown = windDownTurnId === permit.turnId;
          const finishedWindDown = heldWindDown && delivered;
          const nextGoal = reduceGoalTurnFinished(snapshot.goal, {
            now: Date.now(),
            tokensUsed: takeTurnTokens(permit.turnId),
            ...(finishedWindDown ? { windDownTurnId: permit.turnId } : {}),
          });
          if (heldWindDown) windDownTurnId = undefined;
          const persistedSnapshot: GoalSnapshotV2 = {
            v: GOAL_STATE_VERSION,
            goal: nextGoal,
            activity: 'idle',
          };
          const persistedBlockedAudit = currentProposal?.blockedAuditCandidate;
          const proposal = currentProposal;
          const activeProposal =
            proposal && persistedSnapshot.goal?.status === 'active'
              ? proposal
              : undefined;
          const nextCheckpoint = !activeProposal
            ? createCheckpointAttempt(permit, nextGoal)
            : undefined;
          await options.journal.recordGoalState(recordUuid, {
            v: GOAL_STATE_VERSION,
            cause: 'turn_finished',
            snapshot: persistedSnapshot,
            ...(nextCheckpoint
              ? {
                  checkpointPending: {
                    permit: structuredClone(nextCheckpoint.permit),
                    recordUuid: nextCheckpoint.recordUuid,
                  },
                }
              : {}),
            ...(persistedBlockedAudit
              ? { blockedAudit: structuredClone(persistedBlockedAudit) }
              : {}),
          });
          assertAvailable();
          const nextTurnKey = queuedTurnKey;
          if (activeProposal?.blockedAuditCandidate) {
            blockedAudit = activeProposal.blockedAuditCandidate;
          } else if (persistedSnapshot.goal?.status === 'active') {
            blockedAudit = undefined;
          }
          pendingProposal =
            activeProposal?.readyForVerification && !options.verifier
              ? {
                  permit: structuredClone(permit),
                  proposal: structuredClone(activeProposal.proposal),
                }
              : undefined;
          verificationAttempt =
            activeProposal?.readyForVerification && options.verifier
              ? {
                  permit: structuredClone(permit),
                  proposal: structuredClone(activeProposal.proposal),
                  goal: structuredClone(nextGoal),
                  controller: new AbortController(),
                }
              : undefined;
          checkpointAttempt = nextCheckpoint;
          const verifying = Boolean(
            pendingProposal || verificationAttempt || checkpointAttempt,
          );
          snapshot = {
            ...structuredClone(persistedSnapshot),
            activity: verifying ? 'verifying' : 'idle',
          };
          currentPermit = undefined;
          currentPermitHost = undefined;
          currentTurnKey = undefined;
          currentTurnFeedback = undefined;
          queuedTurnKey = verifying ? nextTurnKey : undefined;
          continuationQueued = false;
          currentProposal = undefined;
          if (!verifying && nextTurnKey && snapshot.goal?.status === 'active') {
            currentPermit = {
              goalId: snapshot.goal.goalId,
              revision: snapshot.goal.revision,
              turnId: randomUUID(),
            };
            currentPermitHost = host;
            currentTurnKey = nextTurnKey;
            currentTurnFeedback = nextVerifierFeedback;
            nextVerifierFeedback = undefined;
            snapshot = { ...snapshot, activity: 'running' };
          }
          broadcast('turn_finished');
          if (!verifying && !currentPermit) {
            queueContinuation();
          }
          return {
            ...(verificationAttempt
              ? { verification: verificationAttempt }
              : {}),
            ...(checkpointAttempt ? { checkpoint: checkpointAttempt } : {}),
          };
        },
      );
      return finish.then(async (attempts) => {
        if (attempts.verification) {
          await runVerification(attempts.verification);
          return;
        }
        if (!attempts.checkpoint) return;
        try {
          await runCheckpoint(attempts.checkpoint);
        } catch {
          // The turn already committed; a failed checkpoint recording must
          // not surface as a failed turn or leave the goal verifying.
          await settleDanglingAttempt(attempts.checkpoint.permit);
        }
      });
    },
    async getGoalForWorker(permit: GoalTurnPermit): Promise<GoalWorkerView> {
      assertOperational();
      if (!isCurrentPermit(permit) || !snapshot.goal) {
        throw new Error(STALE_GOAL_TURN_MESSAGE);
      }
      const goal = structuredClone(snapshot.goal);
      const verifierFeedback = currentTurnFeedback;
      const evidenceSource = options.evidenceSource;
      if (!evidenceSource) {
        return {
          goalId: goal.goalId,
          revision: goal.revision,
          objective: goal.objective,
          evidenceCursor: structuredClone(goal.evidenceCursor),
          ...(verifierFeedback ? { verifierFeedback } : {}),
        };
      }
      await evidenceSource.flush();
      const records = await evidenceSource.readActiveTranscriptChain();
      const evidenceCatalog = buildGoalEvidenceCatalog({
        records,
        goal,
        permit,
      });
      if (!isCurrentPermit(permit) || !snapshot.goal) {
        throw new Error(STALE_GOAL_TURN_MESSAGE);
      }
      return {
        goalId: goal.goalId,
        revision: goal.revision,
        objective: goal.objective,
        evidenceCursor: structuredClone(goal.evidenceCursor),
        evidenceCatalog,
        ...(verifierFeedback ? { verifierFeedback } : {}),
      };
    },
    recordTerminalProposal(
      permit: GoalTurnPermit,
      proposal: GoalTerminalProposal,
    ): GoalProposalReceipt {
      assertOperational();
      if (!isCurrentPermit(permit)) {
        throw new Error(STALE_GOAL_TURN_MESSAGE);
      }
      const reasonError = validateGoalProposalReason(proposal.reason);
      if (reasonError) throw new Error(reasonError);
      if (currentProposal) {
        return {
          recorded: false,
          readyForVerification: currentProposal.readyForVerification,
        };
      }
      let readyForVerification = true;
      let blockedAuditCandidate:
        | { fingerprint: string; count: number; turnIds: string[] }
        | undefined;
      if (isRepeatedBlockerProposal(proposal)) {
        const fingerprint = `${proposal.blockerKind ?? 'repeated'}\n${proposal.reason}`;
        blockedAuditCandidate = {
          fingerprint,
          count:
            blockedAudit?.fingerprint === fingerprint
              ? Math.min(blockedAudit.count + 1, 3)
              : 1,
          turnIds:
            blockedAudit?.fingerprint === fingerprint
              ? [...blockedAudit.turnIds, permit.turnId].slice(-3)
              : [permit.turnId],
        };
        readyForVerification = blockedAuditCandidate.count >= 3;
      }
      currentProposal = {
        proposal: structuredClone(proposal),
        readyForVerification,
        ...(blockedAuditCandidate ? { blockedAuditCandidate } : {}),
      };
      return { recorded: true, readyForVerification };
    },
    takePendingTerminalProposal(): GoalPendingProposal | undefined {
      assertOperational();
      const proposal = pendingProposal;
      pendingProposal = undefined;
      return proposal ? structuredClone(proposal) : undefined;
    },
    dispatch(
      request: GoalControlRequest,
      dispatchOptions?: { refuseIfActive?: boolean },
    ): Promise<GoalStateResponse> {
      const execute = async (): Promise<GoalStateResponse> => {
        assertOperational();
        if (
          dispatchOptions?.refuseIfActive &&
          request.action === 'replace' &&
          snapshot.goal?.status === 'active'
        ) {
          throw new GoalInvalidTransitionError(
            'An active Goal cannot be replaced by an approved proposal',
            getSnapshot(),
          );
        }
        const recordUuid = randomUUID();
        const nextGoal = reduceGoalControl(snapshot.goal, {
          request,
          now: Date.now(),
          nextGoalId: randomUUID(),
          cursor:
            request.action === 'create' ||
            request.action === 'replace' ||
            request.action === 'edit'
              ? { recordId: recordUuid }
              : options.journal.getTranscriptCursor(),
          tokenBudgetGrant,
        });
        const nextSnapshot: GoalSnapshotV2 = {
          v: GOAL_STATE_VERSION,
          goal: nextGoal,
          activity: 'idle',
          ...(request.action === 'clear' && snapshot.goal
            ? {
                clearedGoal: {
                  goalId: snapshot.goal.goalId,
                  revision: snapshot.goal.revision,
                  updatedAt: snapshot.goal.updatedAt,
                },
              }
            : {}),
        };
        try {
          await options.journal.recordGoalState(recordUuid, {
            v: GOAL_STATE_VERSION,
            cause: request.action,
            snapshot: nextSnapshot,
          });
        } catch (error) {
          // A lost session writer surfaces here as `SessionWriterUnavailableError`
          // or as the raw latched write failure, neither of which callers can
          // tell apart from a bug by class. Speak the same error `restore` uses
          // for its migration write, so "this session cannot persist goals"
          // stays one type: `/goal status` and `/goal clear` degrade to the
          // empty snapshot instead of failing the caller's whole request.
          throw error instanceof GoalPersistenceUnavailableError
            ? error
            : new GoalPersistenceUnavailableError(
                error instanceof Error ? error.message : String(error),
                { cause: error },
              );
        }
        assertAvailable();
        const invalidatesPermit =
          request.action === 'create' ||
          request.action === 'replace' ||
          request.action === 'edit' ||
          request.action === 'pause' ||
          request.action === 'clear';
        const invalidatedHost = currentPermitHost ?? host;
        if (invalidatesPermit) {
          invalidateAttempts(`Goal ${request.action}`);
        }
        if (invalidatesPermit) {
          settleCurrentTurnAnnouncement(currentTurnDelivered);
          currentPermit = undefined;
          currentPermitHost = undefined;
          currentTurnKey = undefined;
          queuedTurnKey = undefined;
          currentProposal = undefined;
          pendingProposal = undefined;
          blockedAudit = undefined;
          nextVerifierFeedback = undefined;
          currentTurnFeedback = undefined;
          continuationQueued = false;
          if (request.action === 'clear') announcedObjective = undefined;
        } else if (request.action === 'resume') {
          blockedAudit = undefined;
        }
        snapshot = {
          ...structuredClone(nextSnapshot),
          activity:
            currentPermit && request.action === 'resume' ? 'running' : 'idle',
        };
        if (request.action === 'resume') promoteQueuedUserTurn();
        broadcast(request.action);
        if (invalidatesPermit) {
          preemptHost(`Goal ${request.action}`, invalidatedHost);
        }
        if (
          request.action === 'resume' ||
          (request.action !== 'clear' && snapshot.goal?.status === 'active')
        ) {
          queueContinuation();
        }
        return { snapshot: getSnapshot() };
      };

      return enqueue(execute);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const invalidatedHost = currentPermitHost ?? host;
      currentPermit = undefined;
      currentPermitHost = undefined;
      currentTurnKey = undefined;
      queuedTurnKey = undefined;
      continuationQueued = false;
      currentProposal = undefined;
      pendingProposal = undefined;
      invalidateAttempts('Goal runtime disposed');
      blockedAudit = undefined;
      nextVerifierFeedback = undefined;
      currentTurnFeedback = undefined;
      currentTurnAnnouncement = undefined;
      currentTurnDelivered = false;
      preemptHost('Goal runtime disposed', invalidatedHost);
      host = undefined;
      listeners.clear();
    },
  };
}
