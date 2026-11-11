/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * goal 能力组：`setGoal` / `setGoalMaxTurns` / `getGoal` / `clearGoal` / `resumeGoal`。
 *
 * 入参是宿主归一后的产品语义值，返回产品语义结果，失败抛 `ThreadCapabilityError`；错误文本
 * 与 wire 一致、不带 code。goal manager 是模块级单槽，一律显式按 `session.sessionId` 解析。
 */

import {
  enqueue,
  GoalStatus,
  renderObjectiveUpdatedSteering,
} from '@qwen-code/core';
import {
  buildGoalSnapshot,
  isSdkGoalStatus,
  toGoalStatus,
} from '../../../utils/goalControlProtocol.js';
import type { ThreadCallContext } from '../contract/hostContext.js';
import type { ThreadGoalResult } from '../contract/threadSessionTypes.js';
import {
  ThreadCapabilityError,
  type ThreadSessionInternals,
} from '../contract/handlerContract.js';

/**
 * 写入 / 更新 goal，返回快照，并在空闲会话上以 kickoff turn 启动 goal loop。
 *
 * 运行中 Turn 的 objective 被改时，往该 Turn 的 mid-turn 队列注入一条 objective_updated
 * steering，否则模型会把静默改动当成注入而拒答。续跑交给会话的 `continueGoalIfIdle`；
 * 回包是 goal 快照，不被 kickoff 阻塞。校验失败抛 `invalid objective/status/credits_budget`。
 */
export async function setGoal(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  goal: {
    objective?: string;
    status?: string;
    creditsBudget?: number | null;
    customContext?: Readonly<Record<string, string>>;
  },
): Promise<ThreadGoalResult> {
  const objective = goal.objective;
  if (objective !== undefined && typeof objective !== 'string') {
    throw new ThreadCapabilityError('invalid objective');
  }
  const status = goal.status;
  if (status !== undefined && !isSdkGoalStatus(status)) {
    throw new ThreadCapabilityError('invalid status');
  }
  const creditsBudget = goal.creditsBudget;
  if (
    creditsBudget !== undefined &&
    creditsBudget !== null &&
    typeof creditsBudget !== 'number'
  ) {
    throw new ThreadCapabilityError('invalid credits_budget');
  }

  try {
    // 全局单例：goal manager 是模块级单槽，按 sessionId 驱逐重建，并发会话会互相丢态；
    // 显式按本会话 sessionId 解析，避免落到进程级 config。
    const manager = session.requireConfig().getGoalManager();
    const previousGoal = manager.getGoal();
    manager.setGoal({
      objective,
      status: status !== undefined ? toGoalStatus(status) : undefined,
      creditsBudget,
      customContext: goal.customContext,
    });

    const current = manager.getGoal();

    // active goal 在运行中的 turn 里被改 objective 时，注入一条 objective_updated steering，
    // 否则模型在下次 goal_state reminder 会把静默改动当成注入而拒答。
    const objectivePivoted =
      objective !== undefined &&
      previousGoal !== null &&
      current !== null &&
      previousGoal.id === current.id &&
      previousGoal.objective !== current.objective;
    if (
      objectivePivoted &&
      current?.status === GoalStatus.Active &&
      session.isTurnRunning()
    ) {
      // 全局单例：命令队列是模块级数组，不 stamp sessionId 的命令会被任意会话捡走，
      // 因此显式 stamp 本会话，只注入本会话正在跑的 turn。
      enqueue({
        prompt: renderObjectiveUpdatedSteering(current),
        commandMode: 'prompt',
        priority: 'next',
        isMeta: true,
        sessionId: session.sessionId,
      });
    }

    // 空闲时立即用 kickoff turn 启动；result 已出但 turn 仍在收尾时由会话登记 pending，
    // 真正空闲后补启动一次。
    session.continueGoalIfIdle();

    return { goal: current ? buildGoalSnapshot(current) : null };
  } catch (err) {
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'set_goal failed',
    );
  }
}

/**
 * 设置 goal loop 的最大轮数；`null` 表示恢复默认上限（不是「不限」）。
 *
 * `null` 是一条独立的 wire 语义，必须原样下传、不能折成某个数字，否则
 * `max_turns must be a number or null` 会拒绝自己声明合法的值。
 */
export async function setGoalMaxTurns(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  maxTurns: number | null,
): Promise<{ goalMaxTurns: number }> {
  try {
    if (maxTurns !== null && typeof maxTurns !== 'number') {
      throw new ThreadCapabilityError('max_turns must be a number or null');
    }
    const goalMaxTurns = session.requireConfig().getGoalManager().setGoalMaxTurns(
      maxTurns,
    );
    return { goalMaxTurns };
  } catch (err) {
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'set_goal_max_turns failed',
    );
  }
}

/**
 * 刷新 goal 状态后返回快照。
 *
 * 始终返回 `{goal:…}` 包裹体，无 goal 时是 `{goal:null}`——「成功但无 goal」与「键不出现」
 * 在 wire 上是两回事。异常抛 `<err.message 或 'get_goal failed'>`，不带 code。
 */
export async function getGoal(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
): Promise<ThreadGoalResult> {
  try {
    // 同 setGoal：goal manager 为模块级单槽，按本会话 sessionId 解析。
    const manager = session.requireConfig().getGoalManager();
    manager.refresh();
    const goal = manager.getGoal();
    return { goal: goal ? buildGoalSnapshot(goal) : null };
  } catch (err) {
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'get_goal failed',
    );
  }
}

/**
 * 恢复已暂停 / 阻塞的 goal：重授预算、返回快照，并在空闲会话上 kickoff 续跑。
 *
 * 收尾窗口内并发的多条 resume 由会话的 pending 标记合并为一次 kickoff；正常在途 turn 的
 * 续跑仍由该轮 stop hook 负责，避免重复起轮。异常取 `err.message`，不带 code。
 */
export async function resumeGoal(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
): Promise<ThreadGoalResult> {
  try {
    // 同 getGoal：goal manager 为模块级单槽，按本会话 sessionId 解析。
    const manager = session.requireConfig().getGoalManager();
    await manager.activateAfterResume({
      grantFreshBudget: true,
    });
    const goal = manager.getGoal();

    // 与 set_goal 共用会话的 idle 续跑入口。
    session.continueGoalIfIdle();

    return { goal: goal ? buildGoalSnapshot(goal) : null };
  } catch (err) {
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'resume_goal failed',
    );
  }
}

/**
 * 用户主动清除当前 goal，返回是否真的清掉。
 *
 * 异常抛 `<err.message 或 'clear_goal failed'>`，不带 code。
 */
export async function clearGoal(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
): Promise<{ cleared: boolean }> {
  try {
    // 同 getGoal：goal manager 为模块级单槽，按本会话 sessionId 解析。
    const manager = session.requireConfig().getGoalManager();
    const cleared = manager.clearGoal({
      reason: 'user',
    });
    return { cleared };
  } catch (err) {
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'clear_goal failed',
    );
  }
}
