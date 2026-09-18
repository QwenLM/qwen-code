/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { GoalStateRecordPayloadV2 } from './goal-protocol.js';
import type { GoalRecoveryRecord } from './goal-persistence.js';
import {
  isGoalRecoveryCandidate,
  normalizeGoalRecoveryRecord,
  recoverGoalFromRecords,
} from './goal-persistence.js';

const ACTIVE_PAYLOAD: GoalStateRecordPayloadV2 = {
  v: 2,
  cause: 'create',
  snapshot: {
    v: 2,
    activity: 'idle',
    goal: {
      goalId: 'goal-1',
      revision: 1,
      objective: 'ship it',
      status: 'active',
      evidenceCursor: { recordId: 'state-1' },
      turnCount: 3,
      activeTimeMs: 1500,
      tokensUsed: 0,
      createdAt: 100,
      updatedAt: 200,
    },
  },
};

function record(
  uuid: string,
  overrides: Partial<GoalRecoveryRecord> = {},
): GoalRecoveryRecord {
  return {
    uuid,
    type: 'system',
    ...overrides,
  };
}

describe('recoverGoalFromRecords', () => {
  it('returns the newest valid v2 lifecycle snapshot', () => {
    const newer = {
      ...ACTIVE_PAYLOAD,
      cause: 'pause' as const,
      snapshot: {
        ...ACTIVE_PAYLOAD.snapshot,
        goal: { ...ACTIVE_PAYLOAD.snapshot.goal!, status: 'paused' as const },
      },
    };

    expect(
      recoverGoalFromRecords([
        record('state-1', {
          subtype: 'goal_state',
          systemPayload: ACTIVE_PAYLOAD,
        }),
        record('state-2', {
          subtype: 'goal_state',
          systemPayload: newer,
        }),
      ]),
    ).toEqual({ kind: 'v2', payload: newer });
  });

  it.each<{
    label: string;
    overrides: Partial<GoalRecoveryRecord>;
  }>([
    {
      label: 'malformed',
      overrides: {
        systemPayload: {
          v: 3,
          snapshot: ACTIVE_PAYLOAD.snapshot,
        } as unknown as GoalStateRecordPayloadV2,
      },
    },
    {
      label: 'non-system',
      overrides: {
        type: 'user',
        systemPayload: ACTIVE_PAYLOAD,
      },
    },
  ])(
    'uses the newest valid lifecycle record when a newer record is $label',
    ({ overrides }) => {
      expect(
        recoverGoalFromRecords([
          record('state-1', {
            subtype: 'goal_state',
            systemPayload: ACTIVE_PAYLOAD,
          }),
          record('state-2', {
            subtype: 'goal_state',
            ...overrides,
          }),
        ]),
      ).toEqual({ kind: 'v2', payload: ACTIVE_PAYLOAD });
    },
  );

  it('treats only goal_state records as recovery candidates', () => {
    // A restore projection reads candidates and carries their normalized
    // slice; a legacy goal_status card is neither, so it is never read or
    // carried for recovery.
    const legacyCard = record('legacy', {
      subtype: 'slash_command',
      systemPayload: {
        phase: 'result',
        rawCommand: '/goal ship it',
        outputHistoryItems: [
          { type: 'goal_status', kind: 'set', condition: 'ship it' },
        ],
      },
    });
    const stateRecord = record('state', {
      subtype: 'goal_state',
      systemPayload: ACTIVE_PAYLOAD,
    });

    expect(isGoalRecoveryCandidate(legacyCard)).toBe(false);
    expect(normalizeGoalRecoveryRecord(legacyCard)).toBeUndefined();
    expect(isGoalRecoveryCandidate(stateRecord)).toBe(true);
    expect(normalizeGoalRecoveryRecord(stateRecord)).toEqual({
      uuid: 'state',
      type: 'system',
      subtype: 'goal_state',
      systemPayload: ACTIVE_PAYLOAD,
    });
  });

  it('rejects a goal_state payload stored on a non-system record', () => {
    expect(
      recoverGoalFromRecords([
        record('state-1', {
          type: 'user',
          subtype: 'goal_state',
          systemPayload: ACTIVE_PAYLOAD,
        }),
      ]),
    ).toEqual({
      kind: 'unsupported',
      reason: expect.stringContaining('state-1'),
    });
  });

  it.each(['paused', 'blocked', 'usage_limited', 'complete'] as const)(
    'restores %s state for display without making it active',
    (status) => {
      const payload: GoalStateRecordPayloadV2 = {
        ...ACTIVE_PAYLOAD,
        snapshot: {
          ...ACTIVE_PAYLOAD.snapshot,
          goal: { ...ACTIVE_PAYLOAD.snapshot.goal!, status },
        },
      };

      const recovery = recoverGoalFromRecords([
        record('state-1', {
          subtype: 'goal_state',
          systemPayload: payload,
        }),
      ]);

      expect(recovery).toEqual({ kind: 'v2', payload });
      if (recovery.kind === 'v2') {
        expect(recovery.payload.snapshot.activity).toBe('idle');
        expect(recovery.payload.snapshot.goal?.status).toBe(status);
      }
    },
  );

  it.each(['set', 'checking', 'achieved', 'cleared', 'paused'])(
    'restores no Goal from a transcript whose only Goal records are legacy %s cards',
    (kind) => {
      // Builds before #7895 journaled goal_status cards, not state. They are
      // history: nothing is migrated from them, whatever the card says.
      expect(
        recoverGoalFromRecords([
          record('legacy', {
            subtype: 'slash_command',
            systemPayload: {
              phase: 'result',
              rawCommand: '/goal ship it',
              outputHistoryItems: [
                {
                  type: 'goal_status',
                  kind,
                  condition: 'ship it',
                  iterations: 19,
                  setAt: 42,
                },
              ],
            },
          }),
        ]),
      ).toEqual({ kind: 'none' });
    },
  );
});
