/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会话关闭时等待后台任务的策略。具体取值由宿主注入；本模块只给缺省值，
 * 不读取任何环境变量。
 */
export interface BackgroundWindDownPolicy {
  /** 没有可排续跑后，等待后台任务结束的上限（ms）。0 表示无限等。 */
  readonly waitCeilingMs: number;
  /** 会话关闭的硬界（ms）。缺省表示不设硬界。 */
  readonly boundMs?: number;
}

/** 缺省策略（daemon / ACP / SDK）：600s 等待，10s 有界退出。 */
export const DEFAULT_BACKGROUND_WIND_DOWN_POLICY = {
  waitCeilingMs: 600_000,
  boundMs: 10_000,
} as const satisfies BackgroundWindDownPolicy;
