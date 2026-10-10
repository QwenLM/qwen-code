/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

const warnings = vi.hoisted(() => [] as string[]);
vi.mock('../utils/debugLogger.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../utils/debugLogger.js')>();
  return {
    ...original,
    createDebugLogger: (tag?: string) => {
      const logger = original.createDebugLogger(tag);
      return {
        ...logger,
        warn: (...args: unknown[]) => {
          if (tag === 'GOAL_PERSISTENCE') warnings.push(String(args[0]));
          logger.warn(...args);
        },
      };
    },
  };
});
import type { GoalStateRecordPayloadV2 } from './goal-protocol.js';
import type { GoalRecoveryRecord } from './goal-persistence.js';
import {
  isGoalRecoveryCandidate,
  normalizeGoalRecoveryRecord,
  recoverGoalFromRecords,
  selectGoalRecoveryFromRecords,
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

  it('says in the debug log which newer records it walked past', () => {
    const malformed = {
      v: 3,
      snapshot: ACTIVE_PAYLOAD.snapshot,
    } as unknown as GoalStateRecordPayloadV2;
    warnings.length = 0;

    const selection = selectGoalRecoveryFromRecords([
      record('state-1', {
        subtype: 'goal_state',
        systemPayload: ACTIVE_PAYLOAD,
      }),
      record('state-2', { subtype: 'goal_state', systemPayload: malformed }),
      record('state-3', { subtype: 'goal_state', systemPayload: malformed }),
    ]);

    // The Goal still restores, from an older transition than the newest on
    // the transcript: that is a silent rewind unless something names it.
    expect(selection).toEqual({
      recovery: { kind: 'v2', payload: ACTIVE_PAYLOAD },
      sourceUuid: 'state-1',
    });
    expect(warnings).toEqual([
      expect.stringContaining(
        'skipped 2 newer goal_state record(s) that did not parse (state-3, state-2) and restored from state-1',
      ),
    ]);
  });

  it('stays quiet when the newest record parses', () => {
    warnings.length = 0;
    const selection = selectGoalRecoveryFromRecords([
      record('state-1', {
        subtype: 'goal_state',
        systemPayload: ACTIVE_PAYLOAD,
      }),
    ]);
    expect(selection).toEqual({
      recovery: { kind: 'v2', payload: ACTIVE_PAYLOAD },
      sourceUuid: 'state-1',
    });
    expect(warnings).toEqual([]);
  });

  it('stays quiet when no record parses', () => {
    const malformed = {
      v: 3,
      snapshot: ACTIVE_PAYLOAD.snapshot,
    } as unknown as GoalStateRecordPayloadV2;
    warnings.length = 0;
    const selection = selectGoalRecoveryFromRecords([
      record('state-1', { subtype: 'goal_state', systemPayload: malformed }),
      record('state-2', { subtype: 'goal_state', systemPayload: malformed }),
    ]);
    // Nothing was stepped over to reach an older transition: the newest
    // record is the one reported, and the restore itself fails.
    expect(selection.recovery.kind).toBe('unsupported');
    expect(selection.sourceUuid).toBe('state-2');
    expect(warnings).toEqual([]);
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
