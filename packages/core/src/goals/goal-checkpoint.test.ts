/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  InvalidGoalCheckpointError,
  materializeGoalEvidenceCheckpoint,
  type GoalCheckpointVerificationResult,
} from './goal-checkpoint.js';

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
    ).toThrow(InvalidGoalCheckpointError);
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
});
