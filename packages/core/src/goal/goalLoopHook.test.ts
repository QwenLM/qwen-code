/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { goalLoopStopHook } from './goalLoopHook.js';
import { GoalStatus } from './types.js';
import type { HookInput } from '../hooks/types.js';

import type { Config } from '../config/config.js';

const mockGetGoalManager = vi.fn();
const config = { getGoalManager: mockGetGoalManager } as unknown as Config;

function makeHookInput(overrides?: Partial<HookInput>): HookInput {
  return {
    session_id: 'test-session',
    transcript_path: '/tmp/transcript',
    cwd: '/tmp',
    hook_event_name: 'Stop',
    ...overrides,
  };
}

function makeMockGoalManager(goal: ReturnType<typeof makeGoal> | null) {
  return {
    refresh: vi.fn(),
    getGoal: vi.fn().mockReturnValue(goal),
    clearGoal: vi.fn().mockReturnValue(true),
    renderContinuationPrompt: vi
      .fn()
      .mockReturnValue('Continue working on the goal.'),
    renderTurnLimitPrompt: vi
      .fn()
      .mockReturnValue('Turn limit reached, consider wrapping up.'),
    // The hook asks for one prompt and the manager picks the cadence
    // (full / sparse / wrap-up / turn-limit) internally.
    renderTurnPrompt: vi
      .fn()
      .mockReturnValue({ kind: 'sparse', text: 'Continue working on the goal.' }),
    isOverTurnLimit: vi.fn().mockReturnValue(false),
    isOverHardTurnLimit: vi.fn().mockReturnValue(false),
    hardTurnLimit: vi.fn(() => goal?.maxTurns ?? 100),
    pauseForSafetyLimit: vi.fn().mockResolvedValue(true),
    sessionId: 'test-session',
    setGoal: vi.fn(),
    recordTurn: vi.fn(),
  };
}

function makeGoal(
  overrides?: Partial<{
    status: GoalStatus;
    objective: string;
    maxTurns: number;
    turnsUsed: number;
  }>,
) {
  return {
    id: 'test-goal-1',
    objective: 'Fix the bug',
    status: GoalStatus.Active,
    turnsUsed: 2,
    maxTurns: 10,
    timeUsedSeconds: 30,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('goalLoopStopHook', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // Decision path 1: No active goal → allow
  it('should return allow when no active goal exists', async () => {
    const mgr = makeMockGoalManager(null);
    mockGetGoalManager.mockReturnValue(mgr as any);

    const result = await goalLoopStopHook(config, makeHookInput());

    expect(result).toEqual({ decision: 'allow' });
    expect(mgr.clearGoal).not.toHaveBeenCalled();
  });

  // Decision path 2: Goal completed via update_goal → clear and allow
  it('should clear goal and return allow when goal.status is Complete', async () => {
    const mgr = makeMockGoalManager(makeGoal({ status: GoalStatus.Complete }));
    mockGetGoalManager.mockReturnValue(mgr as any);

    const result = await goalLoopStopHook(config, makeHookInput());

    expect(mgr.clearGoal).toHaveBeenCalled();
    expect(result).toBeDefined();
    expect(result!.decision).toBe('allow');
    expect(result!.reason).toContain('completed');
  });

  // Decision path 3: Turn limit reached (soft) → deny with the turn-limit prompt.
  // Cadence selection lives in the manager, so the hook just relays whatever
  // renderTurnPrompt() returns.
  it('should return deny with turn limit prompt when over turn limit', async () => {
    const mgr = makeMockGoalManager(makeGoal({ status: GoalStatus.Active }));
    mgr.isOverTurnLimit.mockReturnValue(true);
    mgr.renderTurnPrompt.mockReturnValue({
      kind: 'turn_limit',
      text: 'Turn limit reached, consider wrapping up.',
    });
    mockGetGoalManager.mockReturnValue(mgr as any);

    const result = await goalLoopStopHook(config, makeHookInput());

    expect(result).toBeDefined();
    expect(result!.decision).toBe('deny');
    expect(result!.modelInjection).toBe(
      'Turn limit reached, consider wrapping up.',
    );
    expect(mgr.recordTurn).toHaveBeenCalled();
    expect(mgr.renderTurnPrompt).toHaveBeenCalled();
  });

  // Decision path 4: Goal paused → allow
  it('should return allow with paused reason when goal.status is Paused', async () => {
    const mgr = makeMockGoalManager(makeGoal({ status: GoalStatus.Paused }));
    mockGetGoalManager.mockReturnValue(mgr as any);

    const result = await goalLoopStopHook(config, makeHookInput());

    expect(result).toBeDefined();
    expect(result!.decision).toBe('allow');
    expect(result!.reason?.toLowerCase()).toContain('paused');
    expect(mgr.clearGoal).not.toHaveBeenCalled();
  });

  // Decision path 5: Goal still active → record turn, block with continuation prompt
  it('should record turn and return deny with modelInjection when goal.status is Active', async () => {
    const mgr = makeMockGoalManager(makeGoal({ status: GoalStatus.Active }));
    mockGetGoalManager.mockReturnValue(mgr as any);

    const result = await goalLoopStopHook(config, makeHookInput());

    expect(result).toBeDefined();
    expect(result!.decision).toBe('deny');
    expect(result!.modelInjection).toBe('Continue working on the goal.');
    expect(mgr.recordTurn).toHaveBeenCalled();
    expect(mgr.renderTurnPrompt).toHaveBeenCalled();
    expect(mgr.clearGoal).not.toHaveBeenCalled();
  });

  it('should keep a legacy goal on the effective default limit', async () => {
    const mgr = makeMockGoalManager(
      makeGoal({ status: GoalStatus.Active, maxTurns: undefined }),
    );
    mockGetGoalManager.mockReturnValue(mgr as any);

    const result = await goalLoopStopHook(config, makeHookInput());

    expect(result?.decision).toBe('deny');
    expect(mgr.pauseForSafetyLimit).not.toHaveBeenCalled();
  });

  it('should continue an unlimited goal without pausing', async () => {
    const mgr = makeMockGoalManager(
      makeGoal({
        status: GoalStatus.Active,
        maxTurns: -1,
        turnsUsed: 150,
      }),
    );
    mockGetGoalManager.mockReturnValue(mgr as any);

    const result = await goalLoopStopHook(config, makeHookInput());

    expect(result?.decision).toBe('deny');
    expect(mgr.pauseForSafetyLimit).not.toHaveBeenCalled();
  });

  // Edge case: Active goal with no prompt available
  it('should return deny with undefined modelInjection when continuation prompt is null', async () => {
    const mgr = makeMockGoalManager(makeGoal({ status: GoalStatus.Active }));
    mgr.renderTurnPrompt.mockReturnValue(null);
    mockGetGoalManager.mockReturnValue(mgr as any);

    const result = await goalLoopStopHook(config, makeHookInput());

    expect(result).toBeDefined();
    expect(result!.decision).toBe('deny');
    expect(result!.modelInjection).toBeUndefined();
  });

  // Circuit breaker: over the hard ceiling → force-pause and allow stop
  it('should force-pause and allow stop when over the hard turn limit', async () => {
    const mgr = makeMockGoalManager(makeGoal({ status: GoalStatus.Active }));
    mgr.isOverHardTurnLimit.mockReturnValue(true);
    mockGetGoalManager.mockReturnValue(mgr as any);

    const result = await goalLoopStopHook(config, makeHookInput());

    expect(mgr.recordTurn).toHaveBeenCalled();
    expect(mgr.pauseForSafetyLimit).toHaveBeenCalled();
    expect(result).toBeDefined();
    expect(result!.decision).toBe('allow');
    expect(result!.reason?.toLowerCase()).toContain('hard turn limit');
  });

  // The hard breaker takes precedence over the soft turn-limit prompt path
  it('should not inject a continuation/turn-limit prompt once the hard limit trips', async () => {
    const mgr = makeMockGoalManager(makeGoal({ status: GoalStatus.Active }));
    mgr.isOverTurnLimit.mockReturnValue(true);
    mgr.isOverHardTurnLimit.mockReturnValue(true);
    mockGetGoalManager.mockReturnValue(mgr as any);

    const result = await goalLoopStopHook(config, makeHookInput());

    expect(result!.decision).toBe('allow');
    expect(result!.modelInjection).toBeUndefined();
    expect(mgr.renderTurnPrompt).not.toHaveBeenCalled();
  });
});
