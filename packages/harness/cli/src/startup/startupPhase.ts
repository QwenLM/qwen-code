/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getErrorMessage, runLogger } from '@qwen-code/core';

export async function runStartupPhase<T>(
  phase: string,
  sessionId: string | undefined,
  action: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const context = `phase=${phase} pid=${process.pid} session_id=${sessionId ?? 'unknown'}`;
  runLogger.log(`[startup.phase] started ${context}`);

  try {
    const result = await action();
    runLogger.log(
      `[startup.phase] finished ${context} duration_ms=${Date.now() - startedAt} success=true`,
    );
    return result;
  } catch (error) {
    runLogger.warn(
      `[startup.phase] finished ${context} duration_ms=${Date.now() - startedAt} success=false error=${JSON.stringify(getErrorMessage(error))}`,
    );
    throw error;
  }
}
