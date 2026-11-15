/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readDebugLogs } from '../test-helper.js';

/** How long the debug log must stop growing before its writes have landed. */
export const DEBUG_LOG_QUIET_MS = 250;

/** How long to keep watching a log that never stops growing. */
export const DEBUG_LOG_DEADLINE_MS = 5_000;

const DEBUG_LOG_POLL_MS = 50;

/**
 * The debug log is appended fire-and-forget, so a marker the child has
 * already emitted may not be on disk when the last prompt response arrives.
 * Read it once it has stopped growing — and before the agent is killed,
 * because a killed process abandons its queued appends.
 */
export async function readSettledDebugLog(runtimeDir: string): Promise<string> {
  const deadline = Date.now() + DEBUG_LOG_DEADLINE_MS;
  let quietSince = Date.now();
  let log = readDebugLogs(runtimeDir);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, DEBUG_LOG_POLL_MS));
    const next = readDebugLogs(runtimeDir);
    if (next !== log) {
      log = next;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= DEBUG_LOG_QUIET_MS) {
      break;
    }
  }
  return log;
}
