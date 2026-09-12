/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session-keyed floor under the Ink prompt counter, for the window between a
 * session switch's core re-key and its UI re-key + seed. From
 * `config.startNewSession(incoming)` on, `config.getSessionId()` answers the
 * incoming session while the stats provider's promptCount still holds the
 * outgoing session's count (the reset and seed run only at the UI re-key),
 * so a submit inside the window would mint `incoming########<outgoingCount>`
 * — an id the incoming transcript may already claim (R43-1). The switch
 * records the incoming session's seed here BEFORE the core swap, and the
 * mint reads `Math.max(getPromptCount(), floor)`. Keyed by session so one
 * session's floor never inflates another's mints, and monotonic per session
 * so a stale floor never lowers a counter that already ran past it.
 */
let floor: { sessionId: string; count: number } | undefined;

export function recordPromptCountFloor(sessionId: string, count: number): void {
  if (floor?.sessionId === sessionId) {
    floor = { sessionId, count: Math.max(floor.count, count) };
  } else {
    floor = { sessionId, count };
  }
}

export function getPromptCountFloor(sessionId: string): number {
  return floor?.sessionId === sessionId ? floor.count : 0;
}

/** Test seam: clear the recorded floor between cases. */
export function resetPromptCountFloorForTesting(): void {
  floor = undefined;
}

/**
 * Ink's live promptId mint (`sessionId########<promptCount>`), floored by
 * the session-keyed switch floor above so a submit inside a /resume or
 * /branch swap window can never mint an id the incoming transcript already
 * claims.
 */
export function mintLivePromptId(
  config: { getSessionId: () => string },
  getPromptCount: () => number,
): string {
  const sessionId = config.getSessionId();
  const count = Math.max(getPromptCount(), getPromptCountFloor(sessionId));
  return `${sessionId}########${count}`;
}
