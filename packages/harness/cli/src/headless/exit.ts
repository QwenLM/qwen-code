/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ExitCodes, sessionLogger } from '@qwen-code/core';
import { gracefulExit } from '../utils/cleanup.js';

export function resetHeadlessExitCode(): void {
  process.exitCode = undefined;
}

/**
 * 启动阶段已确定失败、且失败结果已经按输出格式写出后抛出：`run()` 不再进入
 * 正常输入/轮次流程，只做会话收尾并按已写入的 `process.exitCode` 退出。
 *
 * 用于「配置/认证阶段无法继续，但 headless 消费者仍应拿到 result 帧」的错误，
 * 例如非法 `-m`：不能再让它以空 stdout + 42 结束。
 */
export class HeadlessStartupAbort extends Error {
  constructor(readonly failure: unknown) {
    super('headless startup aborted');
    this.name = 'HeadlessStartupAbort';
  }
}

export async function exitHeadlessMode(): Promise<never> {
  const exitCode =
    typeof process.exitCode === 'number' ? process.exitCode : ExitCodes.SUCCESS;
  sessionLogger.setExitContext({
    reason: exitCode === ExitCodes.SUCCESS ? 'success' : 'fatal_error',
    exit_code: exitCode,
    message:
      exitCode === ExitCodes.SUCCESS
        ? 'Headless session completed successfully'
        : 'Headless session exited with error',
    source: 'gemini.exitHeadlessMode',
  });
  return gracefulExit(exitCode, {
    exitReason: exitCode === ExitCodes.SUCCESS ? 'natural_end' : 'error',
  });
}
