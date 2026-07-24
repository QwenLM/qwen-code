/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  buildGoalEvidenceCatalog,
  EvidenceSourceUnavailableError,
  InvalidGoalEvidenceReferenceError,
  validateGoalEvidenceReferences,
  type GoalEvidenceCatalog,
  type GoalEvidenceRecord,
} from './goal-evidence.js';
import {
  GOAL_STATE_VERSION,
  type GoalControlRequest,
  type GoalSnapshotV2,
  type GoalStateCause,
  type GoalStateRecordPayloadV2,
  type GoalStateResponse,
  type GoalTerminalProposal,
  type GoalTurnPermit,
  type TranscriptCursor,
} from './goal-protocol.js';
import {
  elapsedActiveTime,
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
}

export interface GoalEvidenceSource {
  flush(): Promise<void>;
  readActiveTranscriptChain(): Promise<readonly GoalEvidenceRecord[]>;
}

export class GoalPersistenceUnavailableError extends Error {
  constructor() {
    super('Goal persistence is unavailable for this session');
    this.name = 'GoalPersistenceUnavailableError';
  }
}

export interface GoalTurnHost {
  startGoalTurn(input: {
    permit: GoalTurnPermit;
    continuationContext: string;
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
  subscribe(
    listener: (snapshot: GoalSnapshotV2, cause?: GoalStateCause) => void,
  ): () => void;
  restore(records: readonly GoalRecoveryRecord[]): Promise<void>;
  dispatch(request: GoalControlRequest): Promise<GoalStateResponse>;
  bindHost(host: GoalTurnHost): () => void;
  beginTurn(turnKey: string): GoalTurnPermit | undefined;
  releaseTurn(turnKey: string): Promise<boolean>;
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

export function createGoalRuntime(
  options: CreateGoalRuntimeOptions,
): GoalRuntime {
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
    (value: GoalSnapshotV2, cause?: GoalStateCause) => void
  >();
  let dispatchTail = Promise.resolve();
  let host: GoalTurnHost | undefined;
  let currentPermit: GoalTurnPermit | undefined;
  let currentPermitHost: GoalTurnHost | undefined;
  let currentTurnKey: string | undefined;
  let queuedTurnKey: string | undefined;
  let continuationQueued = false;
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
  let disposed = false;
  let recoveryError: Error | undefined;
  type VerificationAttempt = NonNullable<typeof verificationAttempt>;

  const assertAvailable = () => {
    if (disposed) throw new Error('Goal runtime has been disposed');
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

  const flushContinuation = (cause?: GoalStateCause) => {
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
    snapshot = { ...snapshot, activity: 'running' };
    broadcast(cause);
    const handleStartFailure = () => {
      void enqueue(async () => {
        if (isCurrentPermit(startedPermit)) {
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
      snapshot.goal?.status !== 'active' ||
      currentPermit ||
      pendingProposal ||
      verificationAttempt
    ) {
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

  const isCurrentVerificationAttempt = (attempt: VerificationAttempt) =>
    verificationAttempt === attempt &&
    snapshot.goal?.goalId === attempt.permit.goalId &&
    snapshot.goal.revision === attempt.permit.revision &&
    snapshot.goal.status === 'active' &&
    snapshot.activity === 'verifying';

  const invalidateVerification = (reason: string) => {
    const attempt = verificationAttempt;
    verificationAttempt = undefined;
    pendingProposal = undefined;
    if (attempt && !attempt.controller.signal.aborted) {
      attempt.controller.abort(new Error(reason));
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
        'A blocked Goal is resumable. It may be accepted immediately only when the evidence shows that new user authority or a material user choice is required, or that an external state change is required, and no meaningful in-scope work remains. An ordinary technical blocker requires evidence of the same cause from the current and two immediately preceding Goal turns. Difficulty, uncertainty, incomplete work, or a preference for clarification do not by themselves justify blocked.',
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
      | { kind: 'usage_limited'; reason: string },
  ): Promise<void> => {
    await enqueue(async () => {
      if (!isCurrentVerificationAttempt(attempt) || !snapshot.goal) return;

      const now = Date.now();
      if (outcome.kind === 'decision' && outcome.result.decision === 'accept') {
        const acceptedGoal = {
          ...snapshot.goal,
          activeTimeMs: elapsedActiveTime(snapshot.goal, now),
          updatedAt: now,
          lastReason: outcome.result.reason,
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
        snapshot = structuredClone(terminalSnapshot);
        broadcast(attempt.proposal.status);
        return;
      }

      if (outcome.kind === 'usage_limited') {
        const limitedSnapshot: GoalSnapshotV2 = {
          v: GOAL_STATE_VERSION,
          goal: {
            ...snapshot.goal,
            status: 'usage_limited',
            activeTimeMs: elapsedActiveTime(snapshot.goal, now),
            updatedAt: now,
            lastReason: outcome.reason,
          },
          activity: 'idle',
        };
        await options.journal.recordGoalState(randomUUID(), {
          v: GOAL_STATE_VERSION,
          cause: 'usage_limited',
          snapshot: limitedSnapshot,
        });
        if (!isCurrentVerificationAttempt(attempt) || !snapshot.goal) return;
        verificationAttempt = undefined;
        pendingProposal = undefined;
        continuationQueued = false;
        nextVerifierFeedback = undefined;
        currentTurnFeedback = undefined;
        snapshot = structuredClone(limitedSnapshot);
        broadcast('usage_limited');
        return;
      }

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
  };

  const runVerification = async (
    attempt: VerificationAttempt,
  ): Promise<void> => {
    const evidenceSource = options.evidenceSource;
    const verifier = options.verifier;
    if (!evidenceSource || !verifier) return;

    let outcome:
      | { kind: 'decision'; result: GoalVerificationResult }
      | { kind: 'usage_limited'; reason: string };
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
        outcome = {
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
    await recordVerificationOutcome(attempt, outcome);
  };

  return {
    getSnapshot,
    subscribe(
      listener: (value: GoalSnapshotV2, cause?: GoalStateCause) => void,
    ): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    restore(records: readonly GoalRecoveryRecord[]): Promise<void> {
      return enqueue(async () => {
        assertAvailable();
        if (restored) return;
        const recovery = recoverGoalFromRecords(records);
        if (recovery.kind === 'unsupported') {
          recoveryError = new Error(recovery.reason);
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
              ? structuredClone(recovery.payload.blockedAudit)
              : undefined;
            recoveredCause = recovery.payload.cause;
          } else if (recovery.kind === 'legacy') {
            const recordUuid = randomUUID();
            const payload = createMigratedGoalState({
              objective: recovery.objective,
              goalId: randomUUID(),
              recordUuid,
              now: Date.now(),
            });
            await options.journal.recordGoalState(recordUuid, payload);
            assertAvailable();
            recoveredSnapshot = structuredClone(payload.snapshot);
            recoveredCause = payload.cause;
          }
          if (recoveredSnapshot) snapshot = recoveredSnapshot;
          recoveryError = undefined;
          restored = true;
          if (recoveredSnapshot) broadcast(recoveredCause);
          queueContinuation();
        } catch (error) {
          if (!disposed) {
            recoveryError =
              error instanceof Error ? error : new Error(String(error));
          }
          throw error;
        }
      });
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
    releaseTurn(turnKey: string): Promise<boolean> {
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
          currentPermit = undefined;
          currentPermitHost = undefined;
          currentTurnKey = undefined;
          currentTurnFeedback = undefined;
          currentProposal = undefined;
          snapshot = { ...snapshot, activity: 'idle' };
          broadcast();
          released = true;
        }
        if (released) queueContinuation();
        return released;
      });
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
        throw new Error('Goal turn permit is no longer valid');
      }
      return currentTurnFeedback;
    },
    finishTurn(permit: GoalTurnPermit): Promise<void> {
      const finish = enqueue(
        async (): Promise<VerificationAttempt | undefined> => {
          assertOperational();
          if (!isCurrentPermit(permit) || !snapshot.goal) {
            throw new Error('Goal turn permit is no longer valid');
          }
          const recordUuid = randomUUID();
          const nextGoal = reduceGoalTurnFinished(snapshot.goal, {
            now: Date.now(),
          });
          const persistedSnapshot: GoalSnapshotV2 = {
            v: GOAL_STATE_VERSION,
            goal: nextGoal,
            activity: 'idle',
          };
          const persistedBlockedAudit = currentProposal?.blockedAuditCandidate;
          await options.journal.recordGoalState(recordUuid, {
            v: GOAL_STATE_VERSION,
            cause: 'turn_finished',
            snapshot: persistedSnapshot,
            ...(persistedBlockedAudit
              ? { blockedAudit: structuredClone(persistedBlockedAudit) }
              : {}),
          });
          assertAvailable();
          const nextTurnKey = queuedTurnKey;
          const proposal = currentProposal;
          const activeProposal =
            proposal && persistedSnapshot.goal?.status === 'active'
              ? proposal
              : undefined;
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
        throw new Error('Goal turn permit is no longer valid');
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
        throw new Error('Goal turn permit is no longer valid');
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
        throw new Error('Goal turn permit is no longer valid');
      }
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
      if (
        proposal.status === 'blocked' &&
        proposal.blockerKind !== 'authority' &&
        proposal.blockerKind !== 'external'
      ) {
        const fingerprint = `${proposal.blockerKind ?? ''}\n${proposal.reason}`;
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
    dispatch(request: GoalControlRequest): Promise<GoalStateResponse> {
      const execute = async (): Promise<GoalStateResponse> => {
        assertOperational();
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
        });
        const nextSnapshot: GoalSnapshotV2 = {
          v: GOAL_STATE_VERSION,
          goal: nextGoal,
          activity: 'idle',
        };
        await options.journal.recordGoalState(recordUuid, {
          v: GOAL_STATE_VERSION,
          cause: request.action,
          snapshot: nextSnapshot,
        });
        assertAvailable();
        const invalidatesPermit =
          request.action === 'create' ||
          request.action === 'replace' ||
          request.action === 'edit' ||
          request.action === 'pause' ||
          request.action === 'clear';
        const invalidatedHost = currentPermitHost ?? host;
        if (invalidatesPermit) {
          invalidateVerification(`Goal ${request.action}`);
        }
        if (invalidatesPermit) {
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
        } else if (request.action === 'resume') {
          blockedAudit = undefined;
          if (currentProposal?.blockedAuditCandidate) {
            currentProposal = {
              proposal: currentProposal.proposal,
              readyForVerification: false,
            };
          }
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
      invalidateVerification('Goal runtime disposed');
      blockedAudit = undefined;
      nextVerifierFeedback = undefined;
      currentTurnFeedback = undefined;
      preemptHost('Goal runtime disposed', invalidatedHost);
      host = undefined;
      listeners.clear();
    },
  };
}
