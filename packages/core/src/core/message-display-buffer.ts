/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Debounce window for the MessageDisplay hook. Unlike Claude Code — whose
 * MessageDisplay hook spawns a separate OS process per streamed batch and
 * therefore needs cross-process locking to reassemble order — Qwen Code's
 * streaming loop is single and sequential, so no such reassembly is needed.
 * This constant just bounds how often a `command` hook process gets spawned
 * per streamed reply.
 */
export const MESSAGE_DISPLAY_DEBOUNCE_MS = 200;

/**
 * Per-message accumulation state for the MessageDisplay hook, threaded
 * through repeated calls to {@link stepMessageDisplay} as Content events
 * arrive from the model. Kept as plain data (no clock/IO) so the whole
 * decision is unit-testable without mocking timers.
 */
export interface MessageDisplayState {
  /** Cumulative text streamed so far (all Content chunks appended in order). */
  displayedText: string;
  /** Wall-clock time (ms) the last flush fired, or the state's creation time if none yet. */
  lastFlushMs: number;
  /** The `displayedText` value as of the last flush, to detect "nothing new to say". */
  lastFlushedText: string;
}

export function createInitialMessageDisplayState(
  nowMs: number,
): MessageDisplayState {
  return { displayedText: '', lastFlushMs: nowMs, lastFlushedText: '' };
}

/** What a batch produced: the updated state, plus a flush payload if one is due. */
export interface MessageDisplayStep {
  next: MessageDisplayState;
  flush?: { displayedText: string; isFinal: boolean };
}

/**
 * Decide what one streamed chunk does to the MessageDisplay accumulator,
 * PURELY (no IO, no real timer) — the seam this feature's unit tests drive.
 *
 * A flush fires when either:
 *   - `isFinal` is true (the caller is closing out this message — always
 *     flushes, even with an empty `chunk`, so the reply's tail is never
 *     dropped waiting on the debounce window), or
 *   - there is new text since the last flush AND at least `debounceMs` has
 *     elapsed since then.
 * Otherwise the chunk is folded into `displayedText` with no flush — the
 * caller fires nothing this batch.
 */
export function stepMessageDisplay(
  prev: MessageDisplayState,
  chunk: string,
  nowMs: number,
  debounceMs: number,
  isFinal: boolean,
): MessageDisplayStep {
  const displayedText = prev.displayedText + chunk;
  const hasNewText = displayedText !== prev.lastFlushedText;
  const dueByTime = nowMs - prev.lastFlushMs >= debounceMs;
  const shouldFlush = isFinal || (hasNewText && dueByTime);

  if (!shouldFlush) {
    return { next: { ...prev, displayedText } };
  }

  return {
    next: {
      displayedText,
      lastFlushMs: nowMs,
      lastFlushedText: displayedText,
    },
    flush: { displayedText, isFinal },
  };
}
