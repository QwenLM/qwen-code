/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Coalesces consecutive `text` stream events into one delta per window.
 * Token-level deltas arrive far faster than a terminal frame, and every one
 * re-folds the history and re-parses the whole streaming markdown block —
 * the dominant source of streaming flicker. The window is the
 * renderer-shared STREAM_UPDATE_WINDOW_MS (src/ui/model/stream-aggregation.ts)
 * — ~16 renders/s, smooth to the eye, far below the delta rate — while any
 * other event flushes the pending text first so cross-kind ordering and
 * turn-boundary semantics are unchanged.
 */
import { STREAM_UPDATE_WINDOW_MS } from '../model/stream-aggregation.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';

export async function* batchTextEvents(
  events: AsyncIterable<OpenTuiStreamEvent>,
  windowMs: number = STREAM_UPDATE_WINDOW_MS,
): AsyncGenerator<OpenTuiStreamEvent> {
  const it = events[Symbol.asyncIterator]();
  let fetch: Promise<IteratorResult<OpenTuiStreamEvent>> | null = null;
  let pending = '';
  let deadline = 0;
  try {
    for (;;) {
      if (!fetch) fetch = it.next();
      let result: IteratorResult<OpenTuiStreamEvent>;
      if (pending === '') {
        result = await fetch;
        fetch = null;
      } else {
        // Race the next event against the window deadline; when the timer
        // wins, the in-flight fetch stays parked and is reused next round.
        // setTimeout passes its callback args to resolve, so wrap it to
        // settle with an explicit null sentinel.
        const timer = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())),
        );
        const winner = await Promise.race([fetch.then((r) => r), timer]);
        if (winner === null) {
          yield { type: 'text', delta: pending };
          pending = '';
          continue;
        }
        result = winner;
        fetch = null;
      }
      if (result.done) {
        if (pending !== '') yield { type: 'text', delta: pending };
        return;
      }
      const ev = result.value;
      if (ev.type === 'text') {
        if (pending === '') deadline = Date.now() + windowMs;
        pending += ev.delta;
      } else {
        if (pending !== '') {
          yield { type: 'text', delta: pending };
          pending = '';
        }
        yield ev;
      }
    }
  } finally {
    // Consumer break/return: release the upstream generator so its cleanup
    // runs instead of leaving it suspended mid-stream.
    await it.return?.();
  }
}
