/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SessionEnd 收尾窗口：`close()` 一进来就关掉出站，而 SessionEnd hook 是收尾序列的
 * 最后一步、要经 `hook_callback` 反向请求到宿主执行；窗口只在这段执行期放行。
 *
 * 窗口自带 AbortController：会话信号在 close() 早期已 abort，不能再当反向请求的
 * 取消依据。上界缺省 10s，避免 close() 被一个不应答的 hook 楔住；放行哪些帧由宿主
 * 门禁决定，窗口本身不认识帧。
 */

import { runLogger } from '@qwen-code/core';

/** 窗口缺省上界；与宿主门禁的静态超时同量级。 */
export const DEFAULT_SESSION_END_CLOSEOUT_WINDOW_MS = 10_000;

/** 宿主门禁读到的窗口视图。 */
export interface SessionEndCloseoutView {
  /** 窗口作用域取消信号：窗口关闭即 abort，在途 SessionEnd 反向请求随之结算。 */
  readonly signal: AbortSignal;
}

export interface SessionEndCloseout {
  /** 当前打开的窗口视图；未打开时是 null。宿主每次放行前都要现读。 */
  view(): SessionEndCloseoutView | null;
  /** 在窗口内跑一段收尾任务：进入时开窗，finally 里关窗（abort 窗口信号）。 */
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createSessionEndCloseout(params: {
  readonly sessionId: string;
  /** 窗口上界；支持延迟求值（构造时 Config 尚未装配）。undefined 用缺省值。 */
  readonly windowMs?: number | (() => number | undefined);
}): SessionEndCloseout {
  const { sessionId } = params;
  const resolveWindowMs = (): number => {
    const configured =
      typeof params.windowMs === 'function' ? params.windowMs() : params.windowMs;
    if (configured === undefined || !Number.isFinite(configured)) {
      return DEFAULT_SESSION_END_CLOSEOUT_WINDOW_MS;
    }
    return Math.max(DEFAULT_SESSION_END_CLOSEOUT_WINDOW_MS, configured);
  };
  let current: {
    readonly controller: AbortController;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null = null;

  function shut(reason: 'completed' | 'timeout', windowMs: number): void {
    if (!current) return;
    const { controller, timer } = current;
    current = null;
    clearTimeout(timer);
    runLogger.log('[thread-session] SessionEnd closeout window closed', {
      sessionId,
      reason,
    });
    if (reason === 'timeout') {
      runLogger.warn(
        '[thread-session] SessionEnd closeout window hit its bound; aborting in-flight hook traffic',
        { sessionId, windowMs },
      );
    }
    // 关窗即 abort：晚于窗口结束才回来的宿主应答成为孤儿，由连接丢弃；
    // 本地等待全部立即结算，close() 不会被悬死的请求拖住。
    controller.abort();
  }

  return {
    view: () => (current ? { signal: current.controller.signal } : null),

    async run<T>(task: () => Promise<T>): Promise<T> {
      if (current) {
        // 正常不会重入；真重入时复用现有窗口，避免两套信号与两个计时器。
        return task();
      }
      const windowMs = resolveWindowMs();
      const controller = new AbortController();
      const timer = setTimeout(() => shut('timeout', windowMs), windowMs);
      current = { controller, timer };
      runLogger.log('[thread-session] SessionEnd closeout window opened', {
        sessionId,
        windowMs,
      });
      try {
        return await task();
      } finally {
        shut('completed', windowMs);
      }
    },
  };
}
