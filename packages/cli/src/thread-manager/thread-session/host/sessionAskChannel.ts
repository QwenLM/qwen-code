/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 把一次会话权限询问的落定事实写进 ask-metrics 侧信道。
 *
 * 本通道由宿主对提示的应答落定，所以 `winnerParty` 记 `'prompt'`。
 *
 * 不记这条会丢拒绝元数据：执行门只有看到 `winnerParty === 'prompt'`，才把拒绝归成
 * `toolDenialKind: 'user-rejected'` 并带上拒绝理由。
 */

import type { AskMetricsStore } from '@qwen-code/core';

/**
 * 把一次询问落定折进执行门消费的 ask-metrics 侧信道。
 *
 * 必须在 `settle(...)` 之前调用：执行门在结算后立刻读这份侧信道。
 */
export function recordSessionAsk(
  askMetrics: AskMetricsStore,
  toolUseId: string,
): void {
  askMetrics.record(toolUseId, { winnerParty: 'prompt' });
}
