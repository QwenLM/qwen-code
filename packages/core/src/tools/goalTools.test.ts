/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreateGoalTool, GetGoalTool, UpdateGoalTool } from './goalTools.js';
import { GoalStatus } from '../goal/types.js';

import type { Config } from '../config/config.js';

const mockGetGoalManager = vi.fn();
const config = { getGoalManager: mockGetGoalManager } as unknown as Config;

function makeMockGoalManager(goal: any) {
  return {
    refresh: vi.fn(),
    getGoal: vi.fn().mockReturnValue(goal),
    setGoal: vi.fn().mockReturnValue(goal),
    markBlocked: vi.fn().mockResolvedValue(true),
  };
}

function makeGoal(overrides?: Partial<{ status: GoalStatus }>) {
  return {
    id: 'goal-1',
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

async function invoke(params: Record<string, unknown>) {
  const tool = new UpdateGoalTool(config);
  const invocation = tool.build(params as any);
  return invocation.execute(new AbortController().signal);
}

async function invokeCreate(params: Record<string, unknown>) {
  const tool = new CreateGoalTool(config);
  const invocation = tool.build(params as any);
  return invocation.execute(new AbortController().signal);
}

async function invokeGet() {
  const tool = new GetGoalTool(config);
  const invocation = tool.build({});
  return invocation.execute(new AbortController().signal);
}

describe('CreateGoalTool', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('leaves an omitted max_turns to GoalManager', async () => {
    const goal = { ...makeGoal(), maxTurns: 220, turnsUsed: 0 };
    const mgr = makeMockGoalManager(null);
    mgr.setGoal.mockReturnValue(goal);
    mockGetGoalManager.mockReturnValue(mgr as any);

    const result = await invokeCreate({ objective: 'Natural language goal' });

    expect(mgr.setGoal).toHaveBeenCalledWith({
      objective: 'Natural language goal',
      status: GoalStatus.Active,
      maxTurns: undefined,
    });
    expect(JSON.parse(result.llmContent as string).max_turns).toBe(220);
  });
});

describe('GetGoalTool', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the unlimited sentinel without a numeric remainder', async () => {
    const mgr = makeMockGoalManager({
      ...makeGoal(),
      maxTurns: -1,
      turnsUsed: 150,
    });
    mockGetGoalManager.mockReturnValue(mgr as any);

    const result = await invokeGet();

    expect(JSON.parse(result.llmContent as string)).toMatchObject({
      max_turns: -1,
      remaining_turns: null,
    });
  });
});

describe('UpdateGoalTool', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects statuses outside the complete/blocked enum at validation', () => {
    mockGetGoalManager.mockReturnValue(
      makeMockGoalManager(makeGoal()) as any,
    );

    // The schema enum blocks anything but complete/blocked before the tool
    // ever runs — the model cannot pause/clear a goal on its own.
    const tool = new UpdateGoalTool(config);
    expect(() => tool.build({ status: 'paused' } as any)).toThrow(
      /must be equal to one of the allowed values/,
    );
  });

  it('rejects the removed "active" self-resume path at validation', () => {
    mockGetGoalManager.mockReturnValue(
      makeMockGoalManager(makeGoal()) as any,
    );

    const tool = new UpdateGoalTool(config);
    expect(() => tool.build({ status: 'active' } as any)).toThrow(
      /must be equal to one of the allowed values/,
    );
  });

  it('marks the goal complete', async () => {
    const mgr = makeMockGoalManager(makeGoal());
    mockGetGoalManager.mockReturnValue(mgr as any);

    const result = await invoke({ status: 'complete' });

    expect(mgr.setGoal).toHaveBeenCalledWith({ status: GoalStatus.Complete });
    expect(result.error).toBeUndefined();
  });

  it('reports unlimited completion usage without exposing the sentinel', async () => {
    const mgr = makeMockGoalManager({
      ...makeGoal(),
      maxTurns: -1,
      turnsUsed: 150,
    });
    mockGetGoalManager.mockReturnValue(mgr as any);

    const result = await invoke({ status: 'complete' });
    const report = JSON.parse(result.llmContent as string).completion_report;

    expect(report).toContain('turns used: 150 of unlimited');
    expect(report).not.toContain('-1');
  });

  it('marks the goal blocked directly (three-turn rule is a prompt convention)', async () => {
    const mgr = makeMockGoalManager(makeGoal());
    mockGetGoalManager.mockReturnValue(mgr as any);

    const result = await invoke({ status: 'blocked' });

    expect(mgr.markBlocked).toHaveBeenCalledWith();
    expect(result.error).toBeUndefined();
    expect(result.llmContent as string).toContain('"status":"blocked"');
    expect(result.returnDisplay).toContain('Goal blocked');
  });

  it('errors when there is no active goal to mark blocked', async () => {
    const mgr = makeMockGoalManager(makeGoal());
    mgr.markBlocked.mockResolvedValue(false);
    mockGetGoalManager.mockReturnValue(mgr as any);

    const result = await invoke({ status: 'blocked' });

    expect(result.error).toBeDefined();
  });
});
