/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  buildGoalVerifierWindow,
  EvidenceSourceUnavailableError,
  type EvidenceSourceUnavailableCode,
  type GoalEvidenceRecord,
  type GoalVerifierWindow,
} from './goal-evidence.js';
import {
  GOAL_DEFAULT_TOKEN_BUDGET,
  GOAL_INFEASIBLE_NEXT_STEP,
  GOAL_NO_PROGRESS_TURN_LIMIT,
  GOAL_PAUSE_REASON_NO_PROGRESS,
  GOAL_STATE_VERSION,
  GOAL_REPEATED_BLOCKER_OUT_OF_REACH_REASON,
  goalActiveTimeBudgetReason,
  goalPauseReasonForInconsistentTranscript,
  goalPauseReasonForUnreadableTranscript,
  goalPauseReasonForVerifierFailure,
  isGoalVerifierFailurePause,
  goalTokenBudgetReason,
  goalTurnBudgetReason,
  isGoalActiveTimeBudgetSpent,
  isGoalTokenBudgetSpent,
  isGoalTurnBudgetSpent,
  isRepeatedBlockerProposal,
  type GoalBroadcastMeta,
  type GoalControlRequest,
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
  reduceGoalSpend,
  reduceGoalTurnFinished,
} from './goal-reducer.js';
import {
  GOAL_VERIFIER_REQUEST_BYTE_LIMIT,
  measureGoalVerifierEnvelopeBytes,
  type GoalVerificationResult,
  type GoalVerifier,
  type GoalVerifierInput,
} from './goal-verifier.js';
import {
  createMigratedGoalState,
  recoverGoalFromRecords,
  type GoalRecoveryRecord,
} from './goal-persistence.js';
import type {
  GoalContinuationTurn,
  GoalContinuationUsage,
} from './goal-continuation-prompt.js';
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
  /**
   * Bytes one verification request may carry, envelope included. Defaults
   * to the verifier's fixed ceiling; `goalVerifierRequestByteLimit` lowers
   * it for a side query model whose context window cannot hold that. A
   * function is called at each verification, so a model switched after the
   * runtime was built is honoured.
   */
  verifierRequestByteLimit?: number | (() => number);
  ledger?: GoalTurnLedger;
  /**
   * The autonomous spend window one user action (create, edit of a spent
   * Goal, or resume of a Goal whose ceiling is spent) arms, in `tokensUsed`
   * tokens. Defaults to `GOAL_DEFAULT_TOKEN_BUDGET`; tests shrink it to
   * make the bound reachable. A non-finite grant (`Infinity`) opts out:
   * Goals are then created unbounded, exactly like Goals persisted before
   * budgets existed.
   */
  tokenBudgetGrant?: number;
  /**
   * The autonomous turn window one user action arms, in finished Goal turns.
   * Defaults to unbounded: a turn budget is a cadence the user asks for, not
   * a guard every Goal needs.
   */
  turnBudgetGrant?: number;
  /**
   * The autonomous active-time window one user action arms, in milliseconds.
   * Defaults to unbounded, for the same reason as `turnBudgetGrant`.
   */
  activeTimeBudgetGrantMs?: number;
}

/**
 * What a finished Goal turn spent and what it produced.
 *
 * Scoped to the turn rather than to the session: the ledger is fed by the
 * records the turn itself produced, so an interleaved user turn or a resumed
 * session's replayed history is never attributed to a Goal.
 */
export interface GoalTurnLedger {
  /** Tokens billed to `turnId`, consumed so a turn is counted once. */
  takeGoalTurnTokens(turnId: string): number;
  /**
   * Evidence-bearing tool results `turnId` recorded, consumed the same way.
   *
   * Optional: a ledger that cannot answer leaves the no-progress bound
   * switched off for the whole session rather than reporting every turn as
   * idle. "Nothing measured" is not "nothing happened".
   */
  takeGoalTurnToolResults?(turnId: string): number;
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
  startGoalTurn(
    input: { permit: GoalTurnPermit } & GoalContinuationTurn,
  ): Promise<void>;
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
  /**
   * `meta.replayed` is set on the one broadcast `restore()` makes to
   * republish recovered state; every other broadcast passes no `meta`.
   */
  subscribe(
    listener: (
      snapshot: GoalSnapshotV2,
      cause?: GoalStateCause,
      meta?: GoalBroadcastMeta,
    ) => void,
  ): () => void;
  restore(records: readonly GoalRecoveryRecord[]): Promise<void>;
  prepareRestore(records: readonly GoalRecoveryRecord[]): Promise<void>;
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

  let snapshot: GoalSnapshotV2 = {
    v: GOAL_STATE_VERSION,
    goal: null,
    activity: 'idle',
  };
  const listeners = new Set<
    (
      value: GoalSnapshotV2,
      cause?: GoalStateCause,
      meta?: GoalBroadcastMeta,
    ) => void
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
  let restorePreparation: Promise<void> | undefined;
  let restoreActivation: Promise<void> | undefined;
  let preparedRestoreCause: GoalStateCause | undefined;
  let preparedRestoreHasSnapshot = false;
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

  /**
   * The finishing turn's spend, or zero when nothing can answer.
   *
   * Goal accounting is bookkeeping: a ledger that is absent or that throws
   * costs the Goal its spend figure for this turn, never the turn itself.
   */
  const takeTurnTokens = (turnId: string): number => {
    if (!options.ledger) return 0;
    try {
      const tokens = options.ledger.takeGoalTurnTokens(turnId);
      return Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
    } catch {
      return 0;
    }
  };

  /**
   * The finishing turn's evidence-bearing tool results, or `undefined` when
   * nothing can answer.
   *
   * `undefined` is load-bearing here in a way the spend's zero is not: it
   * switches the no-progress bound off instead of asserting that the turn
   * produced nothing. A ledger that throws says the same thing, and so does
   * one that answers with something that is not a count: reading `NaN` as
   * zero would spend one of the three turns on a measurement that never
   * happened.
   */
  const takeTurnToolResults = (turnId: string): number | undefined => {
    const take = options.ledger?.takeGoalTurnToolResults;
    if (!take) return undefined;
    try {
      const results = take.call(options.ledger, turnId);
      return Number.isFinite(results)
        ? Math.max(0, Math.floor(results))
        : undefined;
    } catch {
      return undefined;
    }
  };

  const verifierRequestByteLimit = (): number => {
    const limit =
      typeof options.verifierRequestByteLimit === 'function'
        ? options.verifierRequestByteLimit()
        : options.verifierRequestByteLimit;
    return Math.min(
      GOAL_VERIFIER_REQUEST_BYTE_LIMIT,
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : GOAL_VERIFIER_REQUEST_BYTE_LIMIT,
    );
  };
  const tokenBudgetGrant =
    options.tokenBudgetGrant ?? GOAL_DEFAULT_TOKEN_BUDGET;
  const turnBudgetGrant = options.turnBudgetGrant ?? Number.POSITIVE_INFINITY;
  const activeTimeBudgetGrantMs =
    options.activeTimeBudgetGrantMs ?? Number.POSITIVE_INFINITY;

  /**
   * The budget this Goal has spent, if any, and the stop it earns.
   *
   * One reader for every ceiling, so the continuation gate, the settle and
   * the no-progress bound cannot disagree about whether a Goal is out of
   * allowance. Ordered token, turns, time: when a turn crosses more than one
   * ceiling at once the Goal stops with a single reason, and the token budget
   * is the one that is armed by default and so the one a user is likeliest to
   * be asking about.
   */
  const spentBudget = (
    goal: NonNullable<GoalSnapshotV2['goal']>,
    now: number,
  ): { kind: GoalLimitKind; reason: string } | undefined => {
    if (isGoalTokenBudgetSpent(goal)) {
      return {
        kind: 'token_budget',
        reason: goalTokenBudgetReason(goal.tokenBudget),
      };
    }
    if (isGoalTurnBudgetSpent(goal)) {
      return {
        kind: 'turn_budget',
        reason: goalTurnBudgetReason(goal.turnBudget),
      };
    }
    const elapsed = elapsedActiveTime(goal, now);
    if (isGoalActiveTimeBudgetSpent(goal, elapsed)) {
      return {
        kind: 'time_budget',
        reason: goalActiveTimeBudgetReason(goal.activeTimeBudgetMs),
      };
    }
    return undefined;
  };

  /**
   * The snapshot a runtime-driven stop settles on, built once so the
   * journalled record and the in-memory state cannot drift, and shared by
   * every stop class so the settled shape is maintained in one place.
   */
  const settledSnapshot = (
    goal: NonNullable<GoalSnapshotV2['goal']>,
    status: 'paused' | 'usage_limited',
    reason: string,
    limitKind?: GoalLimitKind,
  ): GoalSnapshotV2 => {
    const now = Date.now();
    return {
      v: GOAL_STATE_VERSION,
      goal: {
        ...goal,
        status,
        activeTimeMs: elapsedActiveTime(goal, now),
        updatedAt: now,
        lastReason: reason,
        ...(limitKind === undefined ? {} : { limitKind }),
      },
      activity: 'idle',
    };
  };

  /**
   * The shared `usage_limited` settle: every stop builds the same limited
   * snapshot, journals it, then commits it in memory and broadcasts. Each
   * settling site keeps its own re-entry guard and flag resets around this.
   */
  const usageLimitedSnapshot = (
    goal: NonNullable<GoalSnapshotV2['goal']>,
    reason: string,
    limitKind?: GoalLimitKind,
  ): GoalSnapshotV2 =>
    settledSnapshot(goal, 'usage_limited', reason, limitKind);

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

  /**
   * The paused snapshot the no-progress bound stops on.
   *
   * A pause rather than a `usage_limited` stop: nothing was spent and no
   * limit was reached, the Goal simply stopped producing anything to judge.
   * Resuming is the whole remedy, and `/goal resume` is what a pause invites.
   */
  const noProgressPausedSnapshot = (
    goal: NonNullable<GoalSnapshotV2['goal']>,
  ): GoalSnapshotV2 =>
    settledSnapshot(goal, 'paused', GOAL_PAUSE_REASON_NO_PROGRESS);

  const commitUsageLimitedSettle = (limitedSnapshot: GoalSnapshotV2): void => {
    continuationQueued = false;
    currentTurnFeedback = undefined;
    snapshot = structuredClone(limitedSnapshot);
    broadcast('usage_limited');
  };

  /**
   * The paused snapshot a proposal whose verification could not run settles
   * on. Nothing was judged and nothing was spent on the answer, so the Goal
   * waits for the user exactly as the no-progress bound does; the proposal
   * itself is not kept, because a resumed turn re-proposes from the
   * transcript it can see.
   */
  /**
   * What a failed verification says about the transcript: nothing (the
   * verifier or the provider failed), that the cursor no longer anchors it
   * and a new one would, or that no cursor can make it readable.
   */
  type VerifierFailure = {
    detail: string;
    transcript: 'readable' | 'reanchor' | 'inconsistent';
  };
  const REANCHORABLE_CODES = new Set<EvidenceSourceUnavailableCode>([
    'cursor_unset',
    'cursor_not_found',
    'turn_reentry',
    'malformed_turn_context',
    'current_turn_not_tail',
  ]);
  const describeVerifierFailure = (error: unknown): VerifierFailure => ({
    detail: error instanceof Error ? error.message : String(error),
    transcript:
      error instanceof EvidenceSourceUnavailableError
        ? REANCHORABLE_CODES.has(error.code)
          ? 'reanchor'
          : 'inconsistent'
        : 'readable',
  });

  const verifierFailurePausedSnapshot = (
    goal: NonNullable<GoalSnapshotV2['goal']>,
    failure: VerifierFailure,
    recordUuid: string,
  ): GoalSnapshotV2 => {
    switch (failure.transcript) {
      case 'readable':
        return settledSnapshot(
          goal,
          'paused',
          goalPauseReasonForVerifierFailure(failure.detail),
        );
      case 'reanchor':
        // The transcript could not be anchored at the cursor, and the same
        // cursor would fail the same way on every later proposal. Move it
        // to the pause record itself: everything the resumed Goal does lands
        // after it, and the reason tells the user what was left behind.
        return settledSnapshot(
          { ...goal, evidenceCursor: { recordId: recordUuid } },
          'paused',
          goalPauseReasonForUnreadableTranscript(failure.detail),
        );
      case 'inconsistent':
        return settledSnapshot(
          goal,
          'paused',
          goalPauseReasonForInconsistentTranscript(failure.detail),
        );
      default: {
        const exhaustive: never = failure.transcript;
        return exhaustive;
      }
    }
  };

  /**
   * Settle a spent budget instead of minting a continuation.
   *
   * Runs from `queueContinuation`, the single point every autonomous
   * continuation passes through, so one gate bounds every continuation loop
   * at once -- turn cadence, verifier-rejection retries,
   * and families not yet discovered. User-driven turns never pass through
   * here and are never blocked by the budget.
   */
  const stopForSpentBudget = () => {
    void enqueue(async () => {
      const goal = snapshot.goal;
      const spent = goal ? spentBudget(goal, Date.now()) : undefined;
      if (
        !goal ||
        goal.status !== 'active' ||
        !spent ||
        currentPermit ||
        pendingProposal ||
        verificationAttempt
      ) {
        return;
      }
      const { kind, reason } = spent;
      let limitedSnapshot: GoalSnapshotV2;
      try {
        limitedSnapshot = await journalUsageLimitedSettle(goal, reason, kind);
      } catch {
        // A lost settle write must not strand an "active" Goal the gate will
        // never continue: the window is spent either way, so show the stop
        // and let the user's next action surface the persistence loss.
        limitedSnapshot = usageLimitedSnapshot(goal, reason, kind);
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

  const assertAvailable = () => {
    if (disposed) throw new Error(GOAL_RUNTIME_DISPOSED_MESSAGE);
  };

  const assertOperational = () => {
    assertAvailable();
    if (recoveryError) throw recoveryError;
  };

  const getSnapshot = (): GoalSnapshotV2 => structuredClone(snapshot);

  const broadcast = (cause?: GoalStateCause, meta?: GoalBroadcastMeta) => {
    for (const listener of listeners) {
      try {
        listener(getSnapshot(), cause, meta);
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
      snapshot.activity !== 'idle' ||
      snapshot.goal?.status !== 'active'
    ) {
      return;
    }
    continuationQueued = false;
    const scheduledHost = host;
    const continuationContext = snapshot.goal.objective;
    // Read here, before the broadcast below hands listeners a snapshot they
    // may act on: these figures describe the turn being scheduled.
    const usage: GoalContinuationUsage = {
      tokensUsed: snapshot.goal.tokensUsed,
      ...(snapshot.goal.tokenBudget === undefined
        ? {}
        : { tokenBudget: snapshot.goal.tokenBudget }),
      turnCount: snapshot.goal.turnCount,
      ...(snapshot.goal.turnBudget === undefined
        ? {}
        : { turnBudget: snapshot.goal.turnBudget }),
      // Elapsed rather than committed: an active Goal's clock is running, and
      // the figure only ships alongside the ceiling it is measured against.
      ...(snapshot.goal.activeTimeBudgetMs === undefined
        ? {}
        : {
            activeTimeMs: elapsedActiveTime(snapshot.goal, Date.now()),
            activeTimeBudgetMs: snapshot.goal.activeTimeBudgetMs,
          }),
    };
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
        usage,
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
      verificationAttempt
    ) {
      return;
    }
    if (spentBudget(snapshot.goal, Date.now())) {
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

  const invalidateAttempts = (reason: string) => {
    const attempt = verificationAttempt;
    verificationAttempt = undefined;
    pendingProposal = undefined;
    if (attempt && !attempt.controller.signal.aborted) {
      attempt.controller.abort(new Error(reason));
    }
  };

  const verifierInput = (
    attempt: VerificationAttempt,
    window: GoalVerifierWindow,
  ): GoalVerifierInput => {
    const base = {
      goal: {
        goalId: attempt.goal.goalId,
        revision: attempt.goal.revision,
        objective: attempt.goal.objective,
      },
      currentTurnId: attempt.permit.turnId,
      evidence: window.evidence,
      evidenceTurnIds: window.turnIds,
      omitted: window.omitted,
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
        "A blocked Goal is resumable. proposal.blockerKind selects the rule. authority: accept only when the evidence shows that new user authority or a material user choice is required and no meaningful in-scope work remains. external: accept only when the evidence shows that an external resource, capability or state change outside the tools is required and no meaningful in-scope work remains; one failed attempt, a flaky result or a transient error is not that evidence. infeasible: accept only when external_fact evidence shows the objective cannot be satisfied as written: it contradicts itself, it names a target that verifiably does not exist, or it requires an action outside what the tools can perform; reject it when the obstacle is difficulty, uncertainty, information the model could still obtain, or a preference to ask. Those three kinds reach this request unaudited, on the model's own say-so, so judge them strictly from the evidence here. repeated, or no blockerKind: the runtime has already recorded the same blocker text on three consecutive Goal turns; accept when the evidence shows the cause is real and no meaningful in-scope work remains. Difficulty, uncertainty, incomplete work, or a preference for clarification do not by themselves justify blocked.",
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
      | ({ kind: 'paused' } & VerifierFailure),
  ): Promise<void> =>
    enqueue(async () => {
      if (!isCurrentVerificationAttempt(attempt) || !snapshot.goal) return;

      const now = Date.now();
      const meteredGoal = reduceGoalSpend(
        snapshot.goal,
        outcome.kind === 'decision'
          ? (outcome.result.usage?.totalTokenCount ?? 0)
          : 0,
        now,
      );
      if (outcome.kind === 'decision' && outcome.result.decision === 'accept') {
        const acceptedGoal = {
          ...meteredGoal,
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
        return;
      }

      if (outcome.kind === 'paused') {
        const recordUuid = randomUUID();
        const pausedSnapshot = verifierFailurePausedSnapshot(
          meteredGoal,
          outcome,
          recordUuid,
        );
        // A moved cursor leaves the audited turns behind it, where no
        // window reaches; an audit that survived would let the policy's
        // word stand in for evidence the verifier cannot see.
        if (outcome.transcript === 'reanchor') blockedAudit = undefined;
        try {
          await options.journal.recordGoalState(recordUuid, {
            v: GOAL_STATE_VERSION,
            cause: 'pause',
            snapshot: pausedSnapshot,
            ...(blockedAudit
              ? { blockedAudit: structuredClone(blockedAudit) }
              : {}),
          });
        } catch {
          // A lost settle write must not strand an "active" Goal that
          // nothing will continue: the proposal is unjudged either way, so
          // show the pause and let the user's next action surface the
          // persistence loss. Same shape as the no-progress pause.
        }
        if (!isCurrentVerificationAttempt(attempt) || !snapshot.goal) return;
        verificationAttempt = undefined;
        pendingProposal = undefined;
        nextVerifierFeedback = undefined;
        continuationQueued = false;
        currentTurnFeedback = undefined;
        // A paused Goal issues no permits, so a user turn reserved while the
        // verifier ran cannot be served; drop the reservation as a user
        // pause does, or a resume could hand a permit to a turn that has
        // long since run as an ordinary one.
        queuedTurnKey = undefined;
        snapshot = structuredClone(pausedSnapshot);
        broadcast('pause');
        return;
      }

      const rejectedSnapshot: GoalSnapshotV2 = {
        v: GOAL_STATE_VERSION,
        goal: {
          ...meteredGoal,
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
        ...(blockedAudit
          ? { blockedAudit: structuredClone(blockedAudit) }
          : {}),
      });
      if (!isCurrentVerificationAttempt(attempt) || !snapshot.goal) return;
      verificationAttempt = undefined;
      pendingProposal = undefined;
      snapshot = structuredClone(rejectedSnapshot);
      nextVerifierFeedback = outcome.result.reason;
      const continuationBroadcast = admitAfterRejection();
      if (!continuationBroadcast) broadcast('verifier_reject');
    });

  /**
   * Judges the recorded proposal from the transcript tail.
   *
   * The window gets whatever the request limit leaves after the rest of the
   * request is measured, so the request the verifier receives is always
   * within its limit. A verifier that cannot answer -- a timeout, a provider
   * failure, a transcript that cannot be read -- pauses the Goal instead of
   * stopping it: nothing was judged, and resuming is the whole remedy.
   */
  const runVerification = async (
    attempt: VerificationAttempt,
  ): Promise<void> => {
    const evidenceSource = options.evidenceSource;
    const verifier = options.verifier;
    if (!evidenceSource || !verifier) return;

    let outcome:
      | { kind: 'decision'; result: GoalVerificationResult }
      | ({ kind: 'paused' } & VerifierFailure);
    try {
      await evidenceSource.flush();
      if (attempt.controller.signal.aborted) return;
      const records = await evidenceSource.readActiveTranscriptChain();
      if (attempt.controller.signal.aborted) return;
      const envelope = verifierInput(attempt, {
        evidence: [],
        turnIds: [],
        omitted: 0,
      });
      const window = buildGoalVerifierWindow(
        { records, goal: attempt.goal, permit: attempt.permit },
        {
          budgetBytes:
            verifierRequestByteLimit() -
            measureGoalVerifierEnvelopeBytes(envelope),
        },
      );
      // The blocked policy tells the verifier a repeated blocker was
      // recorded on three consecutive turns. That is only evidence if the
      // verifier can see those turns; otherwise the policy's word would be
      // doing the proving, so the runtime rejects before asking.
      if (
        isRepeatedBlockerProposal(attempt.proposal) &&
        blockedAudit !== undefined &&
        !blockedAudit.turnIds.every((turnId) => window.turnIds.includes(turnId))
      ) {
        outcome = {
          kind: 'decision',
          result: {
            decision: 'reject',
            reason: GOAL_REPEATED_BLOCKER_OUT_OF_REACH_REASON,
          },
        };
      } else {
        const result = await verifier(
          verifierInput(attempt, window),
          attempt.controller.signal,
        );
        if (attempt.controller.signal.aborted) return;
        outcome = { kind: 'decision', result };
      }
    } catch (error) {
      if (attempt.controller.signal.aborted) return;
      outcome = { kind: 'paused', ...describeVerifierFailure(error) };
    }
    await recordVerificationOutcome(attempt, outcome);
  };

  return {
    getSnapshot,
    getSnapshotForPermit,
    getRecoveryCause(): GoalStateCause | undefined {
      return recoveryCause;
    },
    subscribe(
      listener: (
        value: GoalSnapshotV2,
        cause?: GoalStateCause,
        meta?: GoalBroadcastMeta,
      ) => void,
    ): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prepareRestore(records: readonly GoalRecoveryRecord[]): Promise<void> {
      if (restorePreparation) return restorePreparation;
      restoreActivationPending = true;
      const preparation = enqueue(async (): Promise<void> => {
        assertAvailable();
        if (restored) return;
        const recovery = recoverGoalFromRecords(records);
        if (recovery.kind === 'unsupported') {
          recoveryError = new GoalPersistenceUnavailableError(recovery.reason);
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
            if (recoveredSnapshot.goal?.status === 'active') {
              recoveredSnapshot.goal.updatedAt = Date.now();
            }
            if (recoveredSnapshot.goal) {
              // Checkpoint health written by an earlier version: nothing
              // updates or clears it any more, and a surface that still
              // reads it would show a stale streak for the Goal's whole
              // remaining life. The checkpoint itself stays: its claims
              // count as evidence out of the verifier's reach.
              const {
                checkpointStalls: _stalls,
                lastCheckpointFailure: _failure,
                ...goal
              } = recoveredSnapshot.goal;
              recoveredSnapshot.goal = goal;
            }
            blockedAudit = recovery.payload.blockedAudit
              ? normalizeRecoveredBlockedAudit(recovery.payload.blockedAudit)
              : undefined;
            recoveredCause = recovery.payload.cause;
            // A `checkpointPending` left by an earlier version is dropped:
            // nothing checkpoints any more, and the restored Goal simply
            // continues from the record it recovered.
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
        } catch (error) {
          if (!disposed) {
            recoveryError =
              error instanceof Error ? error : new Error(String(error));
          }
          throw error;
        }
      });
      restorePreparation = preparation;
      return preparation.then(
        () => undefined,
        (error) => {
          if (!restored && restorePreparation === preparation) {
            restorePreparation = undefined;
            restoreActivation = undefined;
            restoreActivationPending = false;
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
      restoreActivation = restorePreparation.then(async () => {
        assertAvailable();
        restoreActivationPending = false;
        // The cause is the recovered record's: the transition it names was
        // published by the session that made it, so mark this one a replay.
        if (preparedRestoreHasSnapshot) {
          broadcast(preparedRestoreCause, { replayed: true });
        }
        await enqueue(async () => {
          assertAvailable();
          queueContinuation();
        });
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
        verificationAttempt
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
        async (): Promise<VerificationAttempt | undefined> => {
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
          // What this turn produced, and so whether it moved the Goal along.
          // A turn is idle only when it was the runtime's own continuation
          // (a turn carrying the user's text is the user steering, and the
          // streak restarts from there), recorded no evidence-bearing tool
          // result, and proposed no terminal state. The hand-off turn is
          // exempt: it is asked to hand off, not to work.
          const turnToolResults = takeTurnToolResults(permit.turnId);
          const noProgressTurns =
            turnToolResults === undefined || heldWindDown
              ? undefined
              : !delivered || turnToolResults > 0 || currentProposal
                ? 0
                : (snapshot.goal.noProgressTurns ?? 0) + 1;
          const nextGoal = reduceGoalTurnFinished(snapshot.goal, {
            now: Date.now(),
            tokensUsed: takeTurnTokens(permit.turnId),
            ...(finishedWindDown ? { windDownTurnId: permit.turnId } : {}),
            ...(noProgressTurns === undefined ? {} : { noProgressTurns }),
          });
          // Measured on this turn, not read off the record: a restored
          // streak must not stop a Goal whose ledger cannot see the turn
          // that would have relieved it.
          //
          // The bound yields to the limit that describes the Goal better: a
          // spent budget is an allowance that was used up, and the
          // continuation gate owes that Goal its wind-down hand-off before
          // the matching stop; pausing here would skip both.
          const noProgressLimitReached =
            noProgressTurns !== undefined &&
            noProgressTurns >= GOAL_NO_PROGRESS_TURN_LIMIT &&
            nextGoal.status === 'active' &&
            !spentBudget(nextGoal, Date.now());
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
          await options.journal.recordGoalState(recordUuid, {
            v: GOAL_STATE_VERSION,
            cause: 'turn_finished',
            snapshot: persistedSnapshot,
            ...(persistedBlockedAudit
              ? { blockedAudit: structuredClone(persistedBlockedAudit) }
              : {}),
          });
          assertAvailable();
          let nextTurnKey = queuedTurnKey;
          // A user turn reserved while this one ran outranks the bound: the
          // user is steering right now, and that turn restarts the streak
          // anyway. Stopping in front of it would strand the caller waiting
          // on the reservation.
          let noProgressSnapshot: GoalSnapshotV2 | undefined;
          if (noProgressLimitReached && !nextTurnKey) {
            noProgressSnapshot = noProgressPausedSnapshot(nextGoal);
            try {
              await options.journal.recordGoalState(randomUUID(), {
                v: GOAL_STATE_VERSION,
                cause: 'pause',
                snapshot: noProgressSnapshot,
              });
            } catch {
              // A lost settle write must not strand an "active" Goal that
              // nothing will continue: the streak is spent either way, so
              // show the stop and let the user's next action surface the
              // persistence loss.
            }
            assertAvailable();
            // `beginTurn` is synchronous and does not queue, so a reservation
            // can land during the write above. Re-read it, as
            // `stopForSpentBudget` re-validates after its own write, and let
            // it win: the pause is not committed and the reservation is
            // served below, exactly as one that arrived before the write.
            // The journal may then hold a `pause` record the runtime never
            // adopted. That is the same shape `stopForSpentBudget` leaves
            // when its re-validation fails after journalling, and it is the
            // conservative side to land on: a restart recovers a paused Goal
            // with its reason, and resume is the whole remedy.
            nextTurnKey = queuedTurnKey;
            if (nextTurnKey) noProgressSnapshot = undefined;
          }
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
          const verifying = Boolean(pendingProposal || verificationAttempt);
          snapshot = {
            ...structuredClone(noProgressSnapshot ?? persistedSnapshot),
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
          // The paused snapshot is what the surfaces must render, and the
          // card that renders it is keyed to the `pause` cause. Nothing
          // continues a paused Goal, so the continuation gate is skipped
          // rather than left to decline.
          broadcast(noProgressSnapshot ? 'pause' : 'turn_finished');
          if (!noProgressSnapshot && !verifying && !currentPermit) {
            queueContinuation();
          }
          return verificationAttempt;
        },
      );
      return finish.then(async (attempt) => {
        if (attempt) await runVerification(attempt);
      });
    },
    async getGoalForWorker(permit: GoalTurnPermit): Promise<GoalWorkerView> {
      assertOperational();
      if (!isCurrentPermit(permit) || !snapshot.goal) {
        throw new Error(STALE_GOAL_TURN_MESSAGE);
      }
      const goal = structuredClone(snapshot.goal);
      const verifierFeedback = currentTurnFeedback;
      return {
        goalId: goal.goalId,
        revision: goal.revision,
        objective: goal.objective,
        evidenceCursor: structuredClone(goal.evidenceCursor),
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
          turnBudgetGrant,
          activeTimeBudgetGrantMs,
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
        // A resume after a pause the verifier's failure caused keeps the
        // repeated-blocker audit the proposal had earned, and the record
        // carries it so a restart between this resume and the next finished
        // turn does not lose it.
        const keepsBlockedAudit =
          request.action === 'resume' &&
          blockedAudit !== undefined &&
          isGoalVerifierFailurePause(snapshot.goal);
        try {
          await options.journal.recordGoalState(recordUuid, {
            v: GOAL_STATE_VERSION,
            cause: request.action,
            snapshot: nextSnapshot,
            ...(keepsBlockedAudit
              ? { blockedAudit: structuredClone(blockedAudit) }
              : {}),
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
        } else if (request.action === 'resume' && !keepsBlockedAudit) {
          // A user pause breaks the streak a repeated blocker must earn on
          // consecutive turns. A pause the verifier's failure caused does
          // not: the audited turns stand, and the resumed turn may propose
          // again at once instead of earning three more.
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
