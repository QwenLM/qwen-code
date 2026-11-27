/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 同一个 sessionId 在同一时刻只允许一个在世会话。`opening` 是装配中、`active` 是已入表，
 * 两者都不幂等复用：daemon 分不清「同一逻辑请求的重传」与「另一个独立 Query」，复用会
 * 静默丢掉第二次请求的 workerArgs / cwd，或在装配失败时回一个实际不存在的会话。
 */
export type ThreadSessionOpenState = 'opening' | 'active';

export class ThreadSessionAlreadyOpenError extends Error {
  readonly code = 'SESSION_ALREADY_OPEN';

  constructor(
    readonly sessionId: string,
    readonly state: ThreadSessionOpenState,
  ) {
    super(`session ${sessionId} is already open (state=${state})`);
    this.name = 'ThreadSessionAlreadyOpenError';
  }
}
