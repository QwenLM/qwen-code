/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `goalHandlers.setGoalMaxTurns` 的入参校验契约。
 *
 * 被保护的不变量只有一条：**`null` 是合法值，语义是「恢复默认上限」，原样透传给
 * GoalManager。** 这条不变量有四个同源事实钉着，任一被违反都是协议分叉：
 *
 * 1. 协议层 wire 类型 `SetGoalMaxTurnsRequest = { max_turns?: number | null }`
 *    （sdk/protocol/spec.ts）；
 * 2. 错误文案本身——`max_turns must be a number or null` 明说 null 合法；
 * 3. 旧 worker 路径 `handleGoalMaxTurnsSetRequest`（headlessSession.ts）判据是
 *    `value !== null && typeof value !== 'number'`，且 headlessSession.test.ts 用
 *    `{ label: 'null reset', value: null, subtype: 'success', result: 100 }` 钉住；
 * 4. core `GoalManager.setGoalMaxTurns(maxTurns: number | null)` 把 null 归一到
 *    DEFAULT_GOAL_MAX_TURNS，GoalManager.test.ts 钉住 `null → 100`。
 *
 * 曾经这里声明成 `maxTurns: number` 并用 `typeof !== 'number'` 兜底，于是 daemon / 进程内
 * 会话路径把 `setGoalMaxTurns(null)` 判成错误——而抛出的文案正是「null 合法」。本文件就是
 * 那次回归的护栏。
 *
 * GoalManager 用桩替换（只对齐 `setGoalMaxTurns` 的签名与 null 归一语义）：本文件测的是
 * handler 的**校验与透传**，不是 core 的默认值实现——后者由 GoalManager.test.ts 负责。
 */

import { describe, expect, it, vi } from 'vitest';
import { setGoal, setGoalMaxTurns, resumeGoal } from './goalHandlers.js';
import { GoalStatus } from '@qwen-code/core';
import { ThreadCapabilityError } from '../contract/handlerContract.js';
import type { ThreadSessionInternals } from '../contract/handlerContract.js';
import type { ThreadCallContext } from '../contract/hostContext.js';

/** 与 core GoalManager 的 null 归一语义对齐：null → 默认上限 100。 */
const DEFAULT_GOAL_MAX_TURNS = 100;

function createHarness() {
  const goalManager = {
    setGoalMaxTurns: vi.fn((maxTurns: number | null) => {
      // null＝恢复默认（core 的 `maxTurns ?? DEFAULT_GOAL_MAX_TURNS`）。
      if (maxTurns === null) return DEFAULT_GOAL_MAX_TURNS;
      // 复刻 core validateMaxTurns 的拒绝面，用来验证 handler 不吞掉下游异常。
      if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) {
        throw new Error('max_turns must be a positive safe integer');
      }
      return maxTurns;
    }),
  };
  const session = {
    sessionId: 'sess-1',
    requireConfig: () => ({ getGoalManager: () => goalManager }),
  } as unknown as ThreadSessionInternals;
  const ctx = { signal: new AbortController().signal } as ThreadCallContext;
  return { session, ctx, goalManager };
}

describe('setGoalMaxTurns 入参校验', () => {
  it('null＝恢复默认上限：原样透传给 GoalManager，不当作非法值拒绝', async () => {
    const { session, ctx, goalManager } = createHarness();

    await expect(setGoalMaxTurns(session, ctx, null)).resolves.toEqual({
      goalMaxTurns: DEFAULT_GOAL_MAX_TURNS,
    });
    // 关键是「原样透传」：handler 不得把 null 折成某个数字再交给下游，
    // 否则 core 的默认值就成了两份事实源。
    expect(goalManager.setGoalMaxTurns).toHaveBeenCalledWith(null);
  });

  it('正整数原样透传并回传生效值', async () => {
    const { session, ctx, goalManager } = createHarness();

    await expect(setGoalMaxTurns(session, ctx, 260)).resolves.toEqual({
      goalMaxTurns: 260,
    });
    expect(goalManager.setGoalMaxTurns).toHaveBeenCalledWith(260);
  });

  it('既不是 number 也不是 null 时抛 ThreadCapabilityError，文案与旧 worker 逐字一致且不带 code', async () => {
    const { session, ctx, goalManager } = createHarness();

    // 宿主若漏掉归一，wire 上的字符串会一路走到这里；这是运行时兜底。
    const invalid = '220' as unknown as number | null;
    const err = await setGoalMaxTurns(session, ctx, invalid).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ThreadCapabilityError);
    expect((err as Error).message).toBe('max_turns must be a number or null');
    expect((err as ThreadCapabilityError).code).toBeUndefined();
    expect(goalManager.setGoalMaxTurns).not.toHaveBeenCalled();
  });

  it('GoalManager 抛出的下游异常原样上抛，不被吞成成功', async () => {
    const { session, ctx } = createHarness();

    // 0 是 number，过得了 handler 的校验，但过不了 core 的 validateMaxTurns。
    const err = await setGoalMaxTurns(session, ctx, 0).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ThreadCapabilityError);
    expect((err as Error).message).toBe(
      'max_turns must be a positive safe integer',
    );
  });
});

// ===========================================================================
// setGoal：objective 缺省与 credits_budget null 的 wire 契约
// ===========================================================================

function createSetGoalHarness(options: {
  goal?: { id: string; status: GoalStatus; objective: string } | null;
  turnRunning?: boolean;
} = {}) {
  let currentGoal = options.goal ? { ...options.goal } : null;
  const goalManager = {
    getGoal: vi.fn(() => currentGoal),
    setGoal: vi.fn(
      (params: {
        objective?: string;
        status?: GoalStatus;
        creditsBudget?: number | null;
        customContext?: Readonly<Record<string, string>>;
      }) => {
        currentGoal =
          currentGoal !== null
            ? {
                ...currentGoal,
                ...(params.objective !== undefined
                  ? { objective: params.objective }
                  : {}),
                ...(params.status !== undefined
                  ? { status: params.status }
                  : {}),
              }
            : {
                id: 'g-new',
                status: params.status ?? GoalStatus.Active,
                objective: params.objective ?? '',
              };
        return currentGoal;
      },
    ),
  };
  const continueGoalIfIdle = vi.fn();
  const session = {
    sessionId: 'sess-1',
    requireConfig: () => ({ getGoalManager: () => goalManager }),
    isTurnRunning: () => false,
    continueGoalIfIdle,
  } as unknown as ThreadSessionInternals;
  const ctx = { signal: new AbortController().signal } as ThreadCallContext;
  return { session, ctx, goalManager, continueGoalIfIdle };
}

describe('setGoal 入参契约', () => {
  it('只传 status 时 objective 保持缺省，暂停交给会话判断 idle 续跑', async () => {
    const { session, ctx, goalManager, continueGoalIfIdle } =
      createSetGoalHarness({
        goal: { id: 'g-1', status: GoalStatus.Active, objective: 'o' },
      });

    const result = await setGoal(session, ctx, { status: 'paused' });

    expect(goalManager.setGoal).toHaveBeenCalledWith({
      objective: undefined,
      status: GoalStatus.Paused,
      creditsBudget: undefined,
    });
    expect(result.goal).toMatchObject({ objective: 'o', status: 'paused' });
    // 暂停也走会话的 idle 入口：会话会看到非 Active goal，清掉可能残留的 pending。
    expect(continueGoalIfIdle).toHaveBeenCalledTimes(1);
  });

  it('credits_budget null 原样下传，表示显式清空预算', async () => {
    const { session, ctx, goalManager } = createSetGoalHarness({
      goal: { id: 'g-1', status: GoalStatus.Paused, objective: 'o' },
    });

    await setGoal(session, ctx, { creditsBudget: null });

    expect(goalManager.setGoal).toHaveBeenCalledWith(
      expect.objectContaining({ creditsBudget: null }),
    );
  });

  it('customContext 原样下传给 GoalManager', async () => {
    const { session, ctx, goalManager } = createSetGoalHarness();
    const customContext = Object.freeze({ tenant: 'alpha' });

    await setGoal(session, ctx, { objective: 'new', customContext });

    expect(goalManager.setGoal).toHaveBeenCalledWith(
      expect.objectContaining({ customContext }),
    );
  });

  it('objective 提供时仍按原值下传', async () => {
    const { session, ctx, goalManager } = createSetGoalHarness({
      goal: { id: 'g-1', status: GoalStatus.Active, objective: 'old' },
    });

    await setGoal(session, ctx, { objective: 'new' });

    expect(goalManager.setGoal).toHaveBeenCalledWith(
      expect.objectContaining({ objective: 'new' }),
    );
  });

  it('objective 类型错误仍拒绝，且不写 GoalManager', async () => {
    const { session, ctx, goalManager } = createSetGoalHarness();

    const err = await setGoal(
      session,
      ctx,
      { objective: 42 as unknown as string },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ThreadCapabilityError);
    expect((err as Error).message).toBe('invalid objective');
    expect(goalManager.setGoal).not.toHaveBeenCalled();
  });

  it('credits_budget 类型错误仍拒绝，null 与 number 以外的值不写 GoalManager', async () => {
    const { session, ctx, goalManager } = createSetGoalHarness();

    const err = await setGoal(
      session,
      ctx,
      { creditsBudget: '10' as unknown as number },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ThreadCapabilityError);
    expect((err as Error).message).toBe('invalid credits_budget');
    expect(goalManager.setGoal).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// resumeGoal：从 worker 的 handleGoalResumeRequest 移植
// ===========================================================================

function createResumeHarness(options: {
  goal?: { id: string; status: GoalStatus; objective: string } | null;
  activateError?: Error;
}) {
  const activateAfterResume = vi.fn(async () => {
    if (options.activateError) throw options.activateError;
    return true;
  });
  const goalManager = {
    activateAfterResume,
    getGoal: () => options.goal ?? null,
  };
  const continueGoalIfIdle = vi.fn();
  const session = {
    sessionId: 'sess-1',
    requireConfig: () => ({ getGoalManager: () => goalManager }),
    isTurnRunning: () => false,
    continueGoalIfIdle,
  } as unknown as ThreadSessionInternals;
  const ctx = { signal: new AbortController().signal } as ThreadCallContext;
  return { session, ctx, activateAfterResume, continueGoalIfIdle };
}

describe('resumeGoal', () => {
  it('activateAfterResume 只传入 grantFreshBudget 以重授预算', async () => {
    const { session, ctx, activateAfterResume } = createResumeHarness({
      goal: { id: 'g-1', status: GoalStatus.Paused, objective: 'o' },
    });

    await resumeGoal(session, ctx);

    // grantFreshBudget 是 resume 与「模型自己把 goal 设回 active」的区别：
    // 为 false 就会让硬上限熔断被绕过（见 GoalManager 的头注）。
    expect(activateAfterResume).toHaveBeenCalledWith({
      grantFreshBudget: true,
    });
  });

  it('回包是 goal 快照；当前无 goal 时回 null 而不是抛', async () => {
    const withGoal = createResumeHarness({
      goal: { id: 'g-1', status: GoalStatus.Active, objective: 'o' },
    });
    const result = await resumeGoal(withGoal.session, withGoal.ctx);
    expect(result.goal).toMatchObject({ id: 'g-1' });

    const empty = createResumeHarness({ goal: null });
    const emptyResult = await resumeGoal(empty.session, empty.ctx);
    expect(emptyResult.goal).toBeNull();
  });

  it('resume 后把续跑交给会话的 idle 入口，由会话处理收尾窗口', async () => {
    const { session, ctx, continueGoalIfIdle } = createResumeHarness({
      goal: { id: 'g-1', status: GoalStatus.Active, objective: 'o' },
    });

    await resumeGoal(session, ctx);

    expect(continueGoalIfIdle).toHaveBeenCalledTimes(1);
  });

  it('下游异常包成 ThreadCapabilityError，兜底文案与 worker 逐字一致且无 code', async () => {
    const { session, ctx } = createResumeHarness({
      goal: null,
      activateError: new Error('goal store 不可写'),
    });

    const err = await resumeGoal(session, ctx).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ThreadCapabilityError);
    expect((err as Error).message).toBe('goal store 不可写');
    expect((err as ThreadCapabilityError).code).toBeUndefined();
  });
});
