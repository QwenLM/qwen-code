/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isGoalCheckpointStalled,
  materializeGoalEvidenceCheckpoint,
  type GoalCheckpointVerificationResult,
} from './goal-checkpoint.js';
import {
  GOAL_CHECKPOINT_CLAIM_LIMIT,
  GOAL_CHECKPOINT_CLAIM_MAX_BYTES,
} from './goal-protocol.js';

const evidence = [
  {
    uuid: 'assistant-1',
    provenance: 'assistant_output' as const,
    turnId: 'turn-1',
    preview: 'Delivered result',
    proofKind: 'delivered_output' as const,
    content: 'Delivered result',
  },
];

function materialize(result: GoalCheckpointVerificationResult) {
  return materializeGoalEvidenceCheckpoint({
    checkpointId: 'checkpoint-1',
    createdAt: 42,
    previousClaims: [],
    evidence,
    result,
  });
}

describe('materializeGoalEvidenceCheckpoint', () => {
  it('assigns Core-owned claim IDs after validating their sources', () => {
    expect(
      materialize({
        claims: [
          {
            proofKind: 'delivered_output',
            claim: 'The result was delivered.',
            sourceRefs: ['assistant-1'],
          },
        ],
      }),
    ).toEqual({
      checkpointId: 'checkpoint-1',
      createdAt: 42,
      claims: [
        {
          id: 'checkpoint-1:1',
          proofKind: 'delivered_output',
          claim: 'The result was delivered.',
          sourceRefs: ['assistant-1'],
        },
      ],
    });
  });

  it('rejects unknown sources and proof-kind upgrades', () => {
    expect(() =>
      materialize({
        claims: [
          {
            proofKind: 'delivered_output',
            claim: 'Unknown result.',
            sourceRefs: ['missing'],
          },
        ],
      }),
    ).toThrow(/cites unknown source missing/);
    expect(() =>
      materialize({
        claims: [
          {
            proofKind: 'external_fact',
            claim: 'The implementation was verified.',
            sourceRefs: ['assistant-1'],
          },
        ],
      }),
    ).toThrow(/changes the proof kind/i);
  });

  it('rejects cumulative claims that exceed the byte budget', () => {
    expect(() =>
      materialize({
        claims: Array.from({ length: 16 }, (_unused, index) => ({
          proofKind: 'delivered_output' as const,
          claim: `Claim ${index}: ${'x'.repeat(1_900)}`,
          sourceRefs: ['assistant-1'],
        })),
      }),
    ).toThrow(
      new RegExp(`exceeds the ${GOAL_CHECKPOINT_CLAIM_MAX_BYTES}-byte`),
    );
  });

  it('enforces the byte limit on claim text, not serialization overhead', () => {
    // The verifier prompt advertises a budget over claim text, so compliant
    // output must clear the cap even when Core-assigned ids and cited source
    // refs push the serialized checkpoint above it.
    const wideEvidence = Array.from({ length: 8 }, (_unused, index) => ({
      uuid: `tool-${index}`,
      provenance: 'tool_result' as const,
      turnId: 'turn-1',
      preview: `preview ${index}`,
      proofKind: 'external_fact' as const,
      content: `content ${index}`,
    }));
    const claims = Array.from({ length: 32 }, (_unused, index) => ({
      proofKind: 'external_fact' as const,
      claim: `Claim ${index}: ${'x'.repeat(400)}`,
      sourceRefs: wideEvidence.map(({ uuid }) => uuid),
    }));

    const checkpoint = materializeGoalEvidenceCheckpoint({
      checkpointId: 'checkpoint-1',
      createdAt: 42,
      previousClaims: [],
      evidence: wideEvidence,
      result: { claims },
    });

    expect(checkpoint.claims).toHaveLength(32);
    expect(
      Buffer.byteLength(JSON.stringify(checkpoint.claims), 'utf8'),
    ).toBeGreaterThan(GOAL_CHECKPOINT_CLAIM_MAX_BYTES);
  });
});

describe('isGoalCheckpointStalled', () => {
  const claims = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `claim-${index}`,
      proofKind: 'delivered_output' as const,
      claim: `Claim ${index}`,
      sourceRefs: ['assistant-1'],
    }));

  it('needs both a truncated window and a full claim list', () => {
    expect(
      isGoalCheckpointStalled(
        { truncated: true },
        { claims: claims(GOAL_CHECKPOINT_CLAIM_LIMIT) },
      ),
    ).toBe(true);
  });

  it('is not a busy turn: truncation with claim room left', () => {
    expect(
      isGoalCheckpointStalled(
        { truncated: true },
        { claims: claims(GOAL_CHECKPOINT_CLAIM_LIMIT - 1) },
      ),
    ).toBe(false);
  });

  it('is not a quiet full Goal: full claims without truncation', () => {
    expect(
      isGoalCheckpointStalled(
        { truncated: false },
        { claims: claims(GOAL_CHECKPOINT_CLAIM_LIMIT) },
      ),
    ).toBe(false);
  });
});
