/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 把本会话的 hook 事件转成会话出站通知（`hookStarted` / `hookProgress` / `hookResponse`）。
 *
 * 只产语义事件、不构造帧：subtype、`uuid`、`session_id` 与蛇形字段名都归宿主。
 * 必须用带 sessionId 的会话级订阅：hookEvents 是进程级单例，不过滤会转发别的会话的 hook。
 */

import { hookEvents } from '@qwen-code/core';
import type { ThreadNotice } from '../contract/hostContext.js';

export interface SessionHookEventsParams {
  readonly sessionId: string;
  readonly emitNotice: (notice: ThreadNotice) => void;
}

/** 挂上本会话的 hook 事件订阅，返回退订函数。 */
export function attachSessionHookEvents(
  params: SessionHookEventsParams,
): () => void {
  const { emitNotice, sessionId } = params;

  // 必须会话级订阅：不过滤的 on* 会把别的会话的 hook 转发出去；
  // 过滤在 HookEventEmitter 内部完成，不手写 payload.sessionId 比对。
  const unsubscribeStarted = hookEvents.onSessionStarted(sessionId, (p) => {
    emitNotice({ kind: 'hookStarted', payload: p });
  });

  const unsubscribeProgress = hookEvents.onSessionProgress(sessionId, (p) => {
    emitNotice({ kind: 'hookProgress', payload: p });
  });

  const unsubscribeResponse = hookEvents.onSessionResponse(sessionId, (p) => {
    emitNotice({ kind: 'hookResponse', payload: p });
  });

  return () => {
    unsubscribeStarted();
    unsubscribeProgress();
    unsubscribeResponse();
  };
}
