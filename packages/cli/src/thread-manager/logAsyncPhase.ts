/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger } from '@qwen-code/core';

/** 只记录阶段边界，不记录返回值或异常内容，也不改变业务执行结果。 */
export async function logAsyncPhase<T>(
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const log = (
    event: 'started' | 'finished',
    status?: 'resolved' | 'rejected',
  ) => {
    try {
      runLogger.log('[daemon.phase]', {
        name,
        event,
        durationMs: Date.now() - startedAt,
        ...(status ? { status } : {}),
      });
    } catch {
      // 日志写入失败不能阻止启动或覆盖原始异常。
    }
  };
  log('started');
  try {
    const result = await run();
    log('finished', 'resolved');
    return result;
  } catch (error) {
    log('finished', 'rejected');
    throw error;
  }
}
