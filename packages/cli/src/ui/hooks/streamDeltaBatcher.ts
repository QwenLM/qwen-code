/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Leading+trailing throttle for streaming content deltas.
 *
 * Streaming emits one state-update batch per delta event, and every React
 * commit triggers a full yoga layout (ink.tsx onComputeLayout), so under
 * backlog each overdue delta costs a layout pass. This batcher coalesces
 * consecutive same-kind deltas into at most one apply per window while
 * keeping the first delta of an idle window immediate.
 *
 * Rules:
 * - A delta of a different kind than the buffered one applies the buffer
 *   first (order preservation), then the new delta applies immediately —
 *   kind transitions are rare (per content block) and must be synchronous
 *   so e.g. the thought indicator clears the moment text starts.
 * - `lastApplyAt === null` means "never applied since discard": the next
 *   delta takes the leading edge. Zero is not used as a sentinel so fake
 *   clocks starting at 0 behave correctly.
 * - A clean apply (nothing buffered) is a strict no-op and does not touch
 *   the clock, so boundary flushes never delay the next leading edge.
 * - The trailing delay is clamped to [0, windowMs]: a backwards clock step
 *   degrades to debounce instead of freezing buffered content.
 */

export type StreamDeltaKind = 'text' | 'thinking';

export interface StreamDeltaBatcherOptions {
  /** Coalescing window in ms. */
  windowMs: number;
  /** Injected clock (product passes Date.now, tests pass a fake). */
  now: () => number;
  /** Applies the buffered content of one kind. Must be synchronous. */
  onApply: (kind: StreamDeltaKind, bufferedText: string) => void;
}

export interface StreamDeltaBatcher {
  /** Buffer a delta; may apply synchronously (leading edge / kind switch). */
  push(kind: StreamDeltaKind, text: string): void;
  /** Apply anything buffered right now. No-op when clean. */
  flush(): void;
  /** Drop buffered content, cancel the timer, reset the throttle clock. */
  discard(): void;
}

export function createStreamDeltaBatcher(
  options: StreamDeltaBatcherOptions,
): StreamDeltaBatcher {
  const { windowMs, now, onApply } = options;

  // At most one kind is buffered at a time: a cross-kind push applies the
  // buffer first, so a single (kind, text) pair is sufficient.
  let bufferKind: StreamDeltaKind | null = null;
  let bufferText = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastApplyAt: number | null = null;
  let lastApplyKind: StreamDeltaKind | null = null;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const applyNow = (): void => {
    clearTimer();
    if (bufferKind === null) {
      return;
    }
    const kind = bufferKind;
    const text = bufferText;
    bufferKind = null;
    bufferText = '';
    lastApplyAt = now();
    lastApplyKind = kind;
    onApply(kind, text);
  };

  return {
    push(kind, text) {
      if (bufferKind !== null && bufferKind !== kind) {
        applyNow();
      }
      bufferKind = kind;
      bufferText += text;

      const t = now();
      if (
        lastApplyAt === null ||
        kind !== lastApplyKind ||
        t - lastApplyAt >= windowMs
      ) {
        applyNow();
        return;
      }
      if (timer === null) {
        const delay = Math.min(
          Math.max(lastApplyAt + windowMs - t, 0),
          windowMs,
        );
        timer = setTimeout(() => {
          timer = null;
          applyNow();
        }, delay);
      }
    },
    flush() {
      applyNow();
    },
    discard() {
      clearTimer();
      bufferKind = null;
      bufferText = '';
      lastApplyAt = null;
      lastApplyKind = null;
    },
  };
}
