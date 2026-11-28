/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 权限 / Plan 模式能力组：`setPermissionMode` / `setPlanMode` / `getPlanMode`。
 *
 * 入参是宿主解析好的产品语义值，返回产品语义结果，失败抛 `ThreadCapabilityError`，均不带 code。
 * `setPermissionMode` 返回 `void`；Plan 快照仍由 `buildPlanModeSnapshot` 产出。
 */

import {
  applyIndependentPermissionMode,
  applySdkPermissionMode,
  parseSdkPermissionMode,
} from '../../../session/permissionMode.js';
import {
  buildPlanModeSnapshot,
  setSdkPlanMode,
} from '../../../utils/planModeControlProtocol.js';
import type { ThreadCallContext } from '../contract/hostContext.js';
import type { ThreadPlanModeResult } from '../contract/threadSessionTypes.js';
import {
  ThreadCapabilityError,
  type ThreadSessionInternals,
} from '../contract/handlerContract.js';

/**
 * 同步切换权限模式，可在运行中的 Turn 内立即生效；成功无回包 payload。
 *
 * `set_permission_mode` 必须即时派发：排队会让 SDK 在长 turn 期间拿不到回执而超时；
 * 该时序由宿主派发层保证，本函数只同步改 config。mode 非字符串抛 `missing mode`，
 * 无法识别抛 `unknown permission_mode: <mode>`，均不带 code。
 */
// 全局单例：coreEvents 是进程级总线，Plan 状态变化事件不带会话标识；
// 状态本体存于各会话 Config，事件只是通知副本，投影成 wire 帧归宿主 / 会话广播面。
export async function setPermissionMode(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  request: { mode: string; preservePlanMode?: boolean },
): Promise<void> {
  const config = session.requireConfig();
  if (typeof request.mode !== 'string') {
    throw new ThreadCapabilityError('missing mode');
  }

  const mode = parseSdkPermissionMode(request.mode);
  if (mode === undefined) {
    throw new ThreadCapabilityError(`unknown permission_mode: ${request.mode}`);
  }

  try {
    // preservePlanMode：SDK 只想改权限、不想让权限模式连带清掉 Plan Mode。
    if (request.preservePlanMode === true) {
      applyIndependentPermissionMode(config, mode);
    } else {
      applySdkPermissionMode(config, mode);
    }
    // 成功无回包 payload，宿主装空 success。
  } catch (err) {
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'set_permission_mode failed',
    );
  }
}

/**
 * 开关 Plan Mode 并返回最新快照。
 *
 * SDK 在 initialize 看到 `plan_mode_v1` 后会发这个请求并等回执；能力广告与实现必须成对
 * 出现，否则 query 会卡在启动。active 非布尔抛 `invalid active`，迁移失败抛原文。
 */
// 同 setPermissionMode：Plan 状态是会话态，coreEvents 只是进程级通知副本，事件投影归宿主。
export async function setPlanMode(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  active: boolean,
): Promise<ThreadPlanModeResult> {
  if (typeof active !== 'boolean') {
    throw new ThreadCapabilityError('invalid active');
  }
  const config = session.requireConfig();
  try {
    // 回包快照即 setSdkPlanMode 的返回值（内部为 buildPlanModeSnapshot(config)）。
    return { planMode: setSdkPlanMode(config, active) };
  } catch (err) {
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'set_plan_mode failed',
    );
  }
}

/** 只读返回当前 Plan Mode 快照。 */
export async function getPlanMode(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
): Promise<ThreadPlanModeResult> {
  return { planMode: buildPlanModeSnapshot(session.requireConfig()) };
}
