/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rejected by the bridge's `sendPrompt` when a prompt exceeds its
 * wallclock deadline. The class itself lives in the acp-bridge package
 * (the bridge owns the deadline race since DAEMON-003); re-exported here
 * so existing `server.ts` / test imports keep working.
 */
export { PromptDeadlineExceededError } from '../acp-session-bridge.js';

/**
 * Resolve the effective per-prompt wallclock from the server flag +
 * an optional request body override. Returns `undefined` when no
 * deadline applies. The request override may SHORTEN the deadline but
 * never EXTEND it — operators stay the upper bound.
 */
export function resolvePromptDeadlineMs(
  serverMs: number | undefined,
  requestMs: number | undefined,
): number | undefined {
  if (serverMs === undefined || !Number.isFinite(serverMs) || serverMs <= 0) {
    return undefined;
  }
  if (
    requestMs === undefined ||
    !Number.isFinite(requestMs) ||
    requestMs <= 0
  ) {
    return serverMs;
  }
  return Math.min(serverMs, requestMs);
}
