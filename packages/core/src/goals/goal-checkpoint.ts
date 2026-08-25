/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GoalEvidenceCheckpointWindow,
  ValidatedGoalEvidenceRecord,
} from './goal-evidence.js';
import type {
  GoalEvidenceCheckpoint,
  GoalEvidenceCheckpointClaim,
  GoalEvidenceProofKind,
} from './goal-protocol.js';
import {
  GOAL_CHECKPOINT_CLAIM_LIMIT,
  GOAL_CHECKPOINT_CLAIM_MAX_BYTES,
  GOAL_CHECKPOINT_CLAIM_MAX_CHARACTERS,
  GOAL_CHECKPOINT_SOURCE_REFERENCE_LIMIT,
  isGoalEvidenceProofKind,
} from './goal-protocol.js';

export interface GoalCheckpointVerifierClaim {
  proofKind: GoalEvidenceProofKind;
  claim: string;
  sourceRefs: string[];
}

export interface GoalCheckpointVerifierInput {
  goal: {
    goalId: string;
    revision: number;
    objective: string;
  };
  previousClaims: readonly GoalEvidenceCheckpointClaim[];
  evidence: readonly ValidatedGoalEvidenceRecord[];
}

export interface GoalCheckpointVerificationResult {
  claims: GoalCheckpointVerifierClaim[];
}

export type GoalCheckpointVerifier = (
  input: GoalCheckpointVerifierInput,
  attemptSignal?: AbortSignal,
) => Promise<GoalCheckpointVerificationResult>;

/**
 * Whether a checkpoint ran at the compaction ceiling without relieving the
 * window it compacted.
 *
 * Compaction has two levers: folding evidence into claims, and moving the
 * cursor past what was folded. A checkpoint that comes back holding the
 * maximum number of claims has exhausted the first lever -- the next
 * checkpoint can only merge, not absorb -- and a window that was already
 * truncated when this one ran shows the second lever is not keeping up
 * either: eligible evidence was left behind uncatalogued. Both at once means
 * the Goal is paying a checkpoint verifier call every turn and still losing
 * evidence; that is the stall the runtime counts, not a busy turn (which
 * truncates while the claims still have room) nor a full claim list on a
 * quiet Goal (which never truncates).
 */
export function isGoalCheckpointStalled(
  window: Pick<GoalEvidenceCheckpointWindow, 'truncated'>,
  checkpoint: Pick<GoalEvidenceCheckpoint, 'claims'>,
): boolean {
  return (
    window.truncated && checkpoint.claims.length >= GOAL_CHECKPOINT_CLAIM_LIMIT
  );
}

export class InvalidGoalCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGoalCheckpointError';
  }
}

export function materializeGoalEvidenceCheckpoint(input: {
  checkpointId: string;
  createdAt: number;
  previousClaims: readonly GoalEvidenceCheckpointClaim[];
  evidence: readonly ValidatedGoalEvidenceRecord[];
  result: GoalCheckpointVerificationResult;
}): GoalEvidenceCheckpoint {
  if (!isRecord(input.result) || !hasOnlyKeys(input.result, ['claims'])) {
    throw new InvalidGoalCheckpointError(
      'Goal checkpoint verifier returned an invalid result',
    );
  }
  const claims: unknown = input.result.claims;
  if (
    !Array.isArray(claims) ||
    claims.length === 0 ||
    claims.length > GOAL_CHECKPOINT_CLAIM_LIMIT
  ) {
    throw new InvalidGoalCheckpointError(
      `Goal checkpoint must contain between 1 and ${GOAL_CHECKPOINT_CLAIM_LIMIT} claims`,
    );
  }

  const sources = new Map<string, GoalEvidenceProofKind>();
  for (const claim of input.previousClaims) {
    sources.set(claim.id, claim.proofKind);
  }
  for (const record of input.evidence) {
    sources.set(record.uuid, record.proofKind);
  }

  let checkpointBytes = 0;
  const materialized = claims.map((value, index) => {
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ['proofKind', 'claim', 'sourceRefs']) ||
      !isGoalEvidenceProofKind(value['proofKind']) ||
      typeof value['claim'] !== 'string' ||
      !Array.isArray(value['sourceRefs'])
    ) {
      throw new InvalidGoalCheckpointError(
        `Goal checkpoint claim ${index + 1} is malformed`,
      );
    }
    const claim = value['claim'].trim();
    if (
      claim.length === 0 ||
      [...claim].length > GOAL_CHECKPOINT_CLAIM_MAX_CHARACTERS
    ) {
      throw new InvalidGoalCheckpointError(
        `Goal checkpoint claim ${index + 1} has an invalid length`,
      );
    }
    const sourceRefs = value['sourceRefs'];
    if (
      sourceRefs.length === 0 ||
      sourceRefs.length > GOAL_CHECKPOINT_SOURCE_REFERENCE_LIMIT ||
      sourceRefs.some(
        (reference) => typeof reference !== 'string' || reference.length === 0,
      ) ||
      new Set(sourceRefs).size !== sourceRefs.length
    ) {
      throw new InvalidGoalCheckpointError(
        `Goal checkpoint claim ${index + 1} has invalid source references`,
      );
    }
    for (const reference of sourceRefs) {
      const sourceProofKind = sources.get(reference);
      if (!sourceProofKind) {
        throw new InvalidGoalCheckpointError(
          `Goal checkpoint claim ${index + 1} cites unknown source ${reference}`,
        );
      }
      if (sourceProofKind !== value['proofKind']) {
        throw new InvalidGoalCheckpointError(
          `Goal checkpoint claim ${index + 1} changes the proof kind of source ${reference}`,
        );
      }
    }
    // Count only claim text: the verifier prompt advertises that budget,
    // while Core-assigned ids and cited source refs add per-claim overhead
    // the producer cannot anticipate.
    checkpointBytes += Buffer.byteLength(claim, 'utf8');
    return {
      id: `${input.checkpointId}:${index + 1}`,
      proofKind: value['proofKind'],
      claim,
      sourceRefs: sourceRefs.slice(),
    };
  });
  if (checkpointBytes > GOAL_CHECKPOINT_CLAIM_MAX_BYTES) {
    throw new InvalidGoalCheckpointError(
      `Goal checkpoint exceeds the ${GOAL_CHECKPOINT_CLAIM_MAX_BYTES}-byte claim limit`,
    );
  }

  return {
    checkpointId: input.checkpointId,
    createdAt: input.createdAt,
    claims: materialized,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
