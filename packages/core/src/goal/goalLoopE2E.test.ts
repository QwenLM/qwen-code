/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_GOAL_MAX_TURNS, GoalManager } from './GoalManager.js';
import { GoalStorage } from './GoalStorage.js';
import { goalLoopStopHook } from './goalLoopHook.js';
import { GoalStatus } from './types.js';
import { selectContinuationKind } from './template-renderer.js';
import type { HookInput } from '../hooks/types.js';

import type { Config } from '../config/config.js';

const mockGetGoalManager = vi.fn();
const config = { getGoalManager: mockGetGoalManager } as unknown as Config;

function makeHookInput(): HookInput {
  return {
    session_id: 'test-session',
    transcript_path: '/tmp/transcript',
    cwd: '/tmp',
    hook_event_name: 'Stop',
  };
}

/**
 * Creates a mock GoalManager that simulates the real GoalManager's behavior
 * for end-to-end testing of the goal loop flow.
 */
function createSimulatedGoalManager(
  initialObjective: string,
  maxTurns?: number,
) {
  let goal: {
    id: string;
    objective: string;
    status: GoalStatus;
    turnsUsed: number;
    maxTurns?: number;
    timeUsedSeconds: number;
    createdAt: number;
    updatedAt: number;
  } | null = {
    id: 'e2e-goal-1',
    objective: initialObjective,
    status: GoalStatus.Active,
    turnsUsed: 0,
    maxTurns: maxTurns ?? DEFAULT_GOAL_MAX_TURNS,
    timeUsedSeconds: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  return {
    refresh: vi.fn(),
    getGoal: vi.fn(() => goal),
    clearGoal: vi.fn(() => {
      goal = null;
      return true;
    }),
    renderContinuationPrompt: vi.fn(() =>
      goal ? `Continue working on: ${goal.objective}` : null,
    ),
    setGoal: vi.fn((params: { status?: GoalStatus }) => {
      if (goal && params.status !== undefined) {
        goal.status = params.status;
        goal.updatedAt = Date.now();
      }
      return goal;
    }),
    recordTurn: vi.fn(() => {
      if (!goal) return;
      if (goal.status !== GoalStatus.Active) return;
      goal.turnsUsed += 1;
      goal.updatedAt = Date.now();
    }),
    isOverTurnLimit: vi.fn(() => {
      if (!goal?.maxTurns) return false;
      return goal.turnsUsed >= goal.maxTurns;
    }),
    hardTurnLimit: vi.fn(() =>
      goal?.maxTurns ? goal.maxTurns : DEFAULT_GOAL_MAX_TURNS,
    ),
    isOverHardTurnLimit: vi.fn(() => {
      if (!goal) return false;
      const ceiling = goal.maxTurns
        ? goal.maxTurns
        : DEFAULT_GOAL_MAX_TURNS;
      return goal.turnsUsed >= ceiling;
    }),
    pauseForSafetyLimit: vi.fn(async () => {
      if (!goal || goal.status !== GoalStatus.Active) return false;
      goal.status = GoalStatus.Paused;
      goal.updatedAt = Date.now();
      return true;
    }),
    renderTurnLimitPrompt: vi.fn(() =>
      goal ? `Turn limit reached for: ${goal.objective}` : null,
    ),
    // Exercise the real cadence selector against the live goal state so the
    // end-to-end flow covers full / sparse / wrap-up switching, not just a
    // canned string.
    renderTurnPrompt: vi.fn(() => {
      if (!goal) return null;
      const kind = selectContinuationKind(goal);
      return { kind, text: `[${kind}] working on: ${goal.objective}` };
    }),
    sessionId: 'test-session',
    _getInternalGoal: () => goal,
  };
}

describe('Goal Loop end-to-end flow', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should allow stop when model has called update_goal(status="complete")', async () => {
    const mgr = createSimulatedGoalManager('Fix the critical bug');
    mockGetGoalManager.mockReturnValue(mgr as any);

    // Verify it blocks while Active (and records a turn)
    const blockResult = await goalLoopStopHook(config, makeHookInput());
    expect(blockResult!.decision).toBe('deny');
    expect(mgr.recordTurn).toHaveBeenCalled();

    // Simulate model calling update_goal(status="complete")
    mgr.setGoal({ status: GoalStatus.Complete });

    // Now the stop hook should allow
    const allowResult = await goalLoopStopHook(config, makeHookInput());
    expect(allowResult!.decision).toBe('allow');
    expect(allowResult!.reason).toContain('completed');
    expect(mgr.clearGoal).toHaveBeenCalled();
  });

  it('should block stop when model has NOT called update_goal', async () => {
    const mgr = createSimulatedGoalManager('Implement the new feature');
    mockGetGoalManager.mockReturnValue(mgr as any);

    const result = await goalLoopStopHook(config, makeHookInput());

    expect(result!.decision).toBe('deny');
    // First continuation turn carries the full instruction block.
    expect(result!.modelInjection).toContain('[full]');
    expect(result!.modelInjection).toContain('working on');
    expect(mgr.recordTurn).toHaveBeenCalled();
    expect(mgr.renderTurnPrompt).toHaveBeenCalled();
  });

  it('keeps a default goal active through the old 20-turn boundary with the real manager', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'goal-loop-20-turns-'));
    try {
      const manager = new GoalManager(
        new GoalStorage(stateDir, 'real-manager-session'),
        'real-manager-session',
      );
      manager.setGoal({ objective: 'Cross the old turn boundary' });
      mockGetGoalManager.mockReturnValue(manager);

      for (let turn = 1; turn <= 20; turn++) {
        const result = await goalLoopStopHook(config, makeHookInput());
        expect(result?.decision, `turn ${turn}`).toBe('deny');
      }

      expect(manager.getGoal()).toMatchObject({
        status: GoalStatus.Active,
        turnsUsed: 20,
        maxTurns: 100,
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('drops to the sparse nudge on ordinary turns and warns before the auto-pause', async () => {
    // maxTurns 20 keeps the loop clear of the hard ceiling for this walk.
    const mgr = createSimulatedGoalManager('Long running goal', 20);
    mockGetGoalManager.mockReturnValue(mgr as any);

    const kinds: string[] = [];
    for (let i = 0; i < 19; i++) {
      const result = await goalLoopStopHook(config, makeHookInput());
      const injection = result!.modelInjection ?? '';
      kinds.push((injection.match(/^\[(\w+)\]/) || [])[1] ?? 'none');
    }

    // turn 1 full, 2-4 sparse, 6/11 refreshers, 17-19 wrap-up
    expect(kinds[0]).toBe('full');
    expect(kinds[1]).toBe('sparse');
    expect(kinds[5]).toBe('full');
    expect(kinds.slice(16, 19)).toEqual(['wrap_up', 'wrap_up', 'wrap_up']);
    // The expensive full block is the exception, not the rule.
    expect(kinds.filter((k) => k === 'full').length).toBeLessThan(
      kinds.filter((k) => k === 'sparse').length,
    );
  });

  it('should force-pause and allow stop once maxTurns (the hard ceiling) is reached', async () => {
    // Set up goal with maxTurns of 2 — the hard ceiling equals maxTurns (no grace)
    const mgr = createSimulatedGoalManager('Refactor the module', 2);
    mockGetGoalManager.mockReturnValue(mgr as any);

    // First stop hook: records turn 1, still under the ceiling → deny with continuation
    const result1 = await goalLoopStopHook(config, makeHookInput());
    expect(result1!.decision).toBe('deny');

    // Second stop hook: records turn 2, reaches the hard ceiling → force-pause + allow
    const result2 = await goalLoopStopHook(config, makeHookInput());
    expect(result2!.decision).toBe('allow');
    expect(result2!.reason?.toLowerCase()).toContain('hard turn limit');
    expect(mgr.pauseForSafetyLimit).toHaveBeenCalled();
  });

  it('should allow stop after goal is paused by user', async () => {
    const mgr = createSimulatedGoalManager('Deploy to production');
    mockGetGoalManager.mockReturnValue(mgr as any);

    // Initially blocks
    const blockResult = await goalLoopStopHook(config, makeHookInput());
    expect(blockResult!.decision).toBe('deny');

    // Simulate user pausing the goal via /goal pause
    mgr.setGoal({ status: GoalStatus.Paused });

    // Stop hook should allow
    const allowResult = await goalLoopStopHook(config, makeHookInput());
    expect(allowResult!.decision).toBe('allow');
    expect(allowResult!.reason?.toLowerCase()).toContain('paused');
  });

  it('should handle full lifecycle: active → complete → cleared', async () => {
    const mgr = createSimulatedGoalManager('Write unit tests');
    mockGetGoalManager.mockReturnValue(mgr as any);

    // Active → deny
    expect((await goalLoopStopHook(config, makeHookInput()))!.decision).toBe('deny');

    // Model calls update_goal → Complete
    mgr.setGoal({ status: GoalStatus.Complete });

    // Complete → allow (and clears goal)
    const result = await goalLoopStopHook(config, makeHookInput());
    expect(result!.decision).toBe('allow');
    expect(mgr.clearGoal).toHaveBeenCalled();

    // After clearing, goal is null → allow
    const afterClear = await goalLoopStopHook(config, makeHookInput());
    expect(afterClear).toEqual({ decision: 'allow' });
  });
});
