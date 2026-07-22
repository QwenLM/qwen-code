/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ChatRecord } from '../services/chatRecordingService.js';
import type { GoalStateRecordPayloadV2 } from './goal-protocol.js';
import {
  createMigratedGoalState,
  recoverGoalFromRecords,
  recordMigratedGoalState,
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
      createdAt: 100,
      updatedAt: 200,
    },
  },
};

function record(uuid: string, overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    uuid,
    parentUuid: null,
    sessionId: 'session-1',
    timestamp: '2026-07-21T00:00:00.000Z',
    type: 'system',
    cwd: '/tmp/project',
    version: '1.0.0',
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

  it('surfaces an invalid newest lifecycle record without using older state', () => {
    expect(
      recoverGoalFromRecords([
        record('state-1', {
          subtype: 'goal_state',
          systemPayload: ACTIVE_PAYLOAD,
        }),
        record('state-2', {
          subtype: 'goal_state',
          systemPayload: {
            v: 3,
            snapshot: ACTIVE_PAYLOAD.snapshot,
          } as unknown as GoalStateRecordPayloadV2,
        }),
      ]),
    ).toEqual({
      kind: 'unsupported',
      reason: expect.stringContaining('state-2'),
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

  it('uses only the objective from a legacy active Goal', () => {
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
                kind: 'checking',
                condition: 'ship it',
                iterations: 19,
                setAt: 42,
                lastReason: 'old evidence',
              },
            ],
          },
        }),
      ]),
    ).toEqual({ kind: 'legacy', objective: 'ship it' });
  });

  it('does not revive a stopped legacy Goal', () => {
    expect(
      recoverGoalFromRecords([
        record('legacy', {
          subtype: 'slash_command',
          systemPayload: {
            phase: 'result',
            rawCommand: '/goal',
            outputHistoryItems: [
              { type: 'goal_status', kind: 'aborted', condition: 'ship it' },
            ],
          },
        }),
      ]),
    ).toEqual({ kind: 'none' });
  });
});

describe('legacy migration', () => {
  it('creates a fresh active payload at the lifecycle record boundary', () => {
    expect(
      createMigratedGoalState({
        objective: 'ship it',
        goalId: 'new-goal',
        recordUuid: 'migration-record',
        now: 1000,
      }),
    ).toEqual({
      v: 2,
      cause: 'migrated',
      snapshot: {
        v: 2,
        activity: 'idle',
        goal: {
          goalId: 'new-goal',
          revision: 1,
          objective: 'ship it',
          status: 'active',
          evidenceCursor: { recordId: 'migration-record' },
          turnCount: 0,
          activeTimeMs: 0,
          createdAt: 1000,
          updatedAt: 1000,
        },
      },
    });
  });

  it('strictly appends exactly one migrated record', async () => {
    const recordGoalState = vi.fn().mockResolvedValue(record('migration'));

    const persisted = await recordMigratedGoalState(
      { recordGoalState },
      {
        objective: 'ship it',
        goalId: 'new-goal',
        recordUuid: 'migration-record',
        now: 1000,
      },
    );

    expect(recordGoalState).toHaveBeenCalledOnce();
    expect(recordGoalState).toHaveBeenCalledWith(
      'migration-record',
      expect.objectContaining({ cause: 'migrated' }),
    );
    expect(persisted.payload.snapshot.goal?.evidenceCursor).toEqual({
      recordId: 'migration-record',
    });
  });
});
