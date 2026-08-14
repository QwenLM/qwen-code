/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  GoalPersistenceUnavailableError,
  type GoalRuntime,
  type GoalSnapshotV2,
} from '@qwen-code/qwen-code-core';
import { renderPreparedGoalUpdate } from './recovered-goal-update.js';

const hiddenSnapshot: GoalSnapshotV2 = {
  v: 2,
  activity: 'idle',
  goal: {
    goalId: 'hidden-goal',
    revision: 1,
    objective: 'hidden objective',
    status: 'active',
    evidenceCursor: { recordId: 'hidden-record' },
    turnCount: 1,
    activeTimeMs: 10,
    createdAt: 1,
    updatedAt: 2,
  },
};

function runtime(): GoalRuntime {
  return {
    getSnapshot: vi.fn(() => hiddenSnapshot),
    getRecoveryCause: vi.fn(() => 'create'),
  } as unknown as GoalRuntime;
}

describe('renderPreparedGoalUpdate', () => {
  it('renders the prepared runtime state for an ordinary load', async () => {
    const result = await renderPreparedGoalUpdate(async () => runtime());

    expect(result.publicationKey).toContain('hidden-goal');
    expect(result.updates).toEqual([
      expect.objectContaining({
        _meta: expect.objectContaining({ goalState: hiddenSnapshot }),
      }),
    ]);
  });

  it('does not duplicate the visible bootstrap for hidden-inherited history', async () => {
    const bootstrap = {
      goalStatus: { kind: 'set' as const, condition: 'visible objective' },
    };

    const result = await renderPreparedGoalUpdate(async () => runtime(), {
      hideRuntimeGoal: true,
      bootstrap,
    });

    expect(result.publicationKey).toContain('hidden-goal');
    expect(result.suppressedGoalId).toBe('hidden-goal');
    expect(result.updates).toEqual([]);
  });

  it('does not duplicate a v2 bootstrap that matches the runtime', async () => {
    const result = await renderPreparedGoalUpdate(async () => runtime(), {
      bootstrap: {
        goalStatus: { kind: 'set', condition: 'hidden objective' },
        goalState: hiddenSnapshot,
      },
    });

    expect(result.updates).toEqual([]);
  });

  it('appends the runtime correction after a legacy bootstrap', async () => {
    const result = await renderPreparedGoalUpdate(async () => runtime(), {
      bootstrap: {
        goalStatus: { kind: 'set', condition: 'hidden objective' },
      },
    });

    expect(result.updates).toEqual([
      expect.objectContaining({
        _meta: expect.objectContaining({ goalState: hiddenSnapshot }),
      }),
    ]);
  });

  it('clears a visible legacy bootstrap when recovery is unavailable', async () => {
    const result = await renderPreparedGoalUpdate(
      async () => {
        throw new GoalPersistenceUnavailableError('unsupported record');
      },
      {
        bootstrap: {
          goalStatus: {
            kind: 'checking',
            condition: 'visible objective',
            iterations: 2,
            setAt: 123,
          },
        },
      },
    );

    expect(result.updates).toEqual([
      expect.objectContaining({
        _meta: {
          goalStatus: expect.objectContaining({
            kind: 'cleared',
            condition: 'visible objective',
            iterations: 2,
            setAt: 123,
          }),
        },
      }),
    ]);
  });

  it('clears a replayed legacy Goal when recovery is unavailable', async () => {
    const result = await renderPreparedGoalUpdate(
      async () => {
        throw new GoalPersistenceUnavailableError('unsupported record');
      },
      {
        replayedRecords: [
          {
            uuid: 'goal-result',
            parentUuid: null,
            sessionId: 'session-1',
            timestamp: new Date(0).toISOString(),
            type: 'system',
            subtype: 'slash_command',
            cwd: '/tmp',
            version: 'test',
            systemPayload: {
              phase: 'result',
              rawCommand: '/goal',
              outputHistoryItems: [
                {
                  type: 'goal_status',
                  kind: 'set',
                  condition: 'replayed objective',
                  iterations: 3,
                  setAt: 456,
                },
              ],
            },
          },
        ],
      },
    );

    expect(result.updates).toEqual([
      expect.objectContaining({
        _meta: {
          goalStatus: expect.objectContaining({
            kind: 'cleared',
            condition: 'replayed objective',
            iterations: 3,
            setAt: 456,
          }),
        },
      }),
    ]);
  });

  it('falls back to a page-out bootstrap when replay has no Goal card', async () => {
    const result = await renderPreparedGoalUpdate(
      async () => {
        throw new GoalPersistenceUnavailableError('unsupported record');
      },
      {
        replayedRecords: [
          {
            uuid: 'user-1',
            parentUuid: null,
            sessionId: 'session-1',
            timestamp: new Date(0).toISOString(),
            type: 'user',
            cwd: '/tmp',
            version: 'test',
            message: { role: 'user', parts: [{ text: 'continue' }] },
          },
        ],
        bootstrap: {
          goalStatus: {
            kind: 'set',
            condition: 'page-out objective',
            iterations: 1,
          },
        },
      },
    );

    expect(result.updates).toEqual([
      expect.objectContaining({
        _meta: {
          goalStatus: expect.objectContaining({
            kind: 'cleared',
            condition: 'page-out objective',
            iterations: 1,
          }),
        },
      }),
    ]);
  });

  it('propagates unexpected runtime failures', async () => {
    await expect(
      renderPreparedGoalUpdate(async () => {
        throw new Error('snapshot failed');
      }),
    ).rejects.toThrow('snapshot failed');
  });
});
