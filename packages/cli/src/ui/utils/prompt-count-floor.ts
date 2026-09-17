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
 * claims. A mint inside that window persists its id onto the incoming
 * session's transcript, so the ordinal is spent: advance the floor past it,
 * or the re-key seed (computed from transcript claims alone) would reinstall
 * a counter that walks back up through the spent id (R45-1). Advances only
 * when a switch recorded a floor for this session, so a plain live session
 * mints exactly as before.
 */
export function mintLivePromptId(
  config: { getSessionId: () => string },
  getPromptCount: () => number,
): string {
  const sessionId = config.getSessionId();
  const count = Math.max(getPromptCount(), getPromptCountFloor(sessionId));
  if (floor?.sessionId === sessionId) {
    recordPromptCountFloor(sessionId, count + 1);
  }
  return `${sessionId}########${count}`;
}

/**
 * Spends a live mint whose turn was abandoned AFTER the id reached a
 * displayed history item — an @-command or vision bridge that declined to
 * proceed leaves its user/invocation item wearing the id, while the prompt
 * counter only advances on an actual send. Without this the next submit
 * re-mints the same id and two live items share it, tripping the
 * shared-identity rewind refusal on a turn whose snapshot is unambiguous
 * (R51-1). Parses the ordinal back out of the id so the caller needs no
 * mint-time state; a foreign-format id is a no-op.
 */
export function spendLivePromptId(
  config: { getSessionId: () => string },
  promptId: string,
): void {
  const sessionId = config.getSessionId();
  const prefix = `${sessionId}########`;
  if (!promptId.startsWith(prefix)) return;
  const ordinal = Number(promptId.slice(prefix.length));
  if (Number.isSafeInteger(ordinal) && ordinal >= 0) {
    recordPromptCountFloor(sessionId, ordinal + 1);
  }
}
