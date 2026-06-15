/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonEvent } from './types.js';

/**
 * Bd10T: typed error raised by `parseSseStream` on framing-level
 * violations (today: buffer-overflow from a non-SSE upstream that
 * never emits the `\n\n` separator). Lets SDK consumers distinguish
 * "the upstream isn't an SSE stream" from generic network failures
 * via `err instanceof SseFramingError` instead of fragile string
 * matching on `err.message`.
 */
export class SseFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SseFramingError';
  }
}

/**
 * Parse an SSE-encoded event-stream `Response.body` into a stream of
 * `DaemonEvent`s.
 *
 * Field handling follows the EventSource spec subset the daemon emits
 * (`packages/cli/src/serve/server.ts` `formatSseFrame`):
 *   - Frames are separated by a blank line. Both `\n\n` and `\r\n\r\n`
 *     are accepted; CRLF can show up when an intermediary (corporate
 *     proxy, some Node http servers) normalizes line endings.
 *   - Comment lines (`: ...`) and the `retry:` directive are ignored.
 *   - The `data` field is parsed as JSON and yielded as the event payload;
 *     `id` and `event` fields are encoded redundantly inside the JSON
 *     data payload by the daemon, so we don't need to surface them
 *     separately.
 *   - Malformed frames (non-JSON `data`, missing `data`) are skipped
 *     silently so a single bad frame can't poison the iterator.
 *
 * The reader is released in `finally` so `for await … break` paths and
 * AbortSignal cancellation both clean up cleanly.
 */
/**
 * Hard cap on accumulated unread UTF-16 code units (`buf.length`)
 * before we abort the stream as malformed. SSE frames are typically a
 * few hundred bytes; even a heavily-batched provider rarely crosses
 * 64 KiB. A buffer that grows past 16 Mi code units is a strong
 * signal that the upstream is NOT SSE — e.g. a misconfigured proxy
 * returned a non-streaming body, or the server never emits the
 * `\n\n` separator. Without a cap, `buf` grows until the consumer
 * OOMs.
 *
 * The cap is **code units, not bytes** (BRker). JS strings are
 * stored as UTF-16 (sometimes Latin-1 under the hood, depending on
 * engine string representation), so `buf.length` is NOT a reliable
 * byte-count proxy — a mostly-ASCII payload uses ~1 byte per code
 * unit on V8's Latin-1 path, while supplementary code points (a
 * single user-perceived character like an emoji) cost 2 code units
 * per source byte after decode. We cap on what we can cheaply
 * measure (`buf.length`); the *intent* is "stop runaway non-SSE
 * bodies", not exact memory accounting. Operators that need a
 * tighter byte-precise bound should put a reverse proxy in front of
 * the daemon with a request-size limit. 16 Mi code units is generous
 * enough that legitimate SSE traffic won't hit it under any sane
 * encoding mix.
 */
const MAX_BUF_CHARS = 16 * 1024 * 1024;

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<DaemonEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  // Wire abort to `reader.cancel()` so an idle/stalled upstream
  // doesn't trap the generator inside `await reader.read()`. Polling
  // `signal.aborted` between reads (the previous behavior) is fine
  // when frames are flowing, but if the stream sits silent and
  // somebody calls `controller.abort()`, the generator stays parked
  // on the pending `read()` until the upstream eventually closes —
  // contradicting this function's "AbortSignal cancellation cleans
  // up cleanly" contract. `reader.cancel()` is a no-op if already
  // cancelled, so racing the listener with the finally cleanup is
  // safe.
  let onAbort: (() => void) | undefined;
  if (signal) {
    onAbort = () => {
      reader.cancel().catch(() => {
        /* already cancelled or detached */
      });
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (true) {
      // Pre-read fast-path check: if abort already fired, return
      // without entering `read()`. The listener-driven cancel above
      // covers the parked-read case; this covers the
      // already-aborted-when-loop-iterates case.
      if (signal?.aborted) {
        return;
      }
      // BlqF_: wrap `reader.read()` so an abort-driven body-stream
      // error doesn't bubble. `reader.cancel()` (fired by the abort
      // listener above) settles the reader cleanly on most paths,
      // but undici-on-abort can also reject the in-flight `read()`
      // with an AbortError / "BodyStreamBuffer was aborted". The
      // public contract says "abort cancels cleanly" — so if we
      // catch a rejection AFTER the signal already aborted, treat
      // it as clean completion. Re-throw for any other failure so
      // consumers still see real upstream errors (network drop,
      // unexpected close, etc.) on streams they didn't abort.
      let value: Uint8Array | undefined;
      let done: boolean;
      try {
        ({ value, done } = await reader.read());
      } catch (err) {
        if (signal?.aborted) return;
        throw err;
      }
      if (done) {
        // Flush any bytes the decoder is still holding for an incomplete
        // multi-byte UTF-8 sequence at the tail. Without this, the last
        // character of the last frame can be silently dropped.
        buf += decoder.decode();
        if (buf.length > 0) {
          // Use the same `consumeFrames` walker as the main loop
          // so a multi-byte split that completed multiple frame
          // separators in the trailing decode flush still yields
          // every frame instead of being merged into one parse.
          // The previous `splitFrames(buf)` returned `[buf]` (a
          // single-frame fallback) which silently dropped events.
          const consumed = consumeFrames(buf);
          for (const raw of consumed.frames) {
            const frame = parseFrame(raw);
            if (frame) yield frame;
          }
          // Anything left over after the last separator is a
          // legitimate trailing fragment (no `\n\n` ever arrived);
          // try to parse it once as a final attempt.
          if (consumed.tail.length > 0) {
            const frame = parseFrame(consumed.tail);
            if (frame) yield frame;
          }
        }
        return;
      }
      buf += decoder.decode(value, { stream: true });
      // Unbounded buffer is a memory-pressure vector — see MAX_BUF_CHARS.
      if (buf.length > MAX_BUF_CHARS) {
        throw new SseFramingError(
          `parseSseStream: unread buffer exceeded ${MAX_BUF_CHARS} ` +
            `UTF-16 code units without a frame separator — upstream likely not SSE`,
        );
      }
      const consumed = consumeFrames(buf);
      if (consumed.frames.length > 0) {
        for (const raw of consumed.frames) {
          const frame = parseFrame(raw);
          if (frame) yield frame;
        }
      }
      buf = consumed.tail;
    }
  } finally {
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
    // `reader.cancel()` does both the release-lock work AND signals the
    // upstream that we don't want any more data — closing the underlying
    // HTTP body stream when the consumer breaks out early. Using only
    // `releaseLock()` would orphan the connection until idle timeout.
    try {
      await reader.cancel();
    } catch {
      /* already cancelled or detached */
    }
  }
}

/**
 * Walk `buf` and pull off every complete frame (either `\n\n` or
 * `\r\n\r\n` separator). Returns the frames + the unconsumed tail.
 */
function consumeFrames(buf: string): { frames: string[]; tail: string } {
  const frames: string[] = [];
  let cursor = 0;
  // BX9_a + BeFHR + BeFId: scan for `\n\n` first; on hit, look for
  // an earlier `\r\n\r\n` within the window `[cursor, lf)` ONLY by
  // slicing before scanning (Node's `String.indexOf` has no upper-
  // bound argument). On the LF-not-found path, fall back to a full
  // CRLF scan over the remainder. Net cost in the common LF-only
  // case is one full scan + one bounded scan over the matched
  // frame's bytes (small).
  while (cursor < buf.length) {
    const lf = buf.indexOf('\n\n', cursor);
    if (lf === -1) {
      // No LF separator left — try the CRLF fallback.
      const crlf = buf.indexOf('\r\n\r\n', cursor);
      if (crlf === -1) break;
      frames.push(buf.slice(cursor, crlf));
      cursor = crlf + 4;
      continue;
    }
    // An LF exists. Look for a CRLF that appears earlier
    // (mixed-encoding edge case) by searching ONLY the
    // pre-LF window so we don't pay for a full-remainder scan
    // every iteration.
    const window = buf.slice(cursor, lf);
    const crlfInWindow = window.indexOf('\r\n\r\n');
    if (crlfInWindow !== -1) {
      const crlf = cursor + crlfInWindow;
      frames.push(buf.slice(cursor, crlf));
      cursor = crlf + 4;
    } else {
      frames.push(buf.slice(cursor, lf));
      cursor = lf + 2;
    }
  }
  return { frames, tail: buf.slice(cursor) };
}

function parseFrame(raw: string): DaemonEvent | undefined {
  if (!raw) return undefined;
  // Per the EventSource spec, comment lines (`:` prefix) and `retry:`
  // are line-level fields, not frame-level. A frame may legitimately
  // contain a leading comment / retry line AND `data:` lines (e.g. an
  // intermediary that prepends `: keep-alive` to every frame). The
  // line-level loop below only collects `data:` lines, so a
  // pure-comment frame still returns undefined via the
  // `dataLines.length === 0` guard — without us dropping real events
  // whose first line happens to be a comment (BRgq-).
  // Split on either CRLF or LF (same forgiving stance as frame boundaries).
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const rest = line.slice(5);
    // Strip ONE leading space if present (per spec); preserve subsequent
    // whitespace verbatim.
    dataLines.push(rest.startsWith(' ') ? rest.slice(1) : rest);
  }
  if (dataLines.length === 0) return undefined;
  const dataText = dataLines.join('\n');
  try {
    const parsed = JSON.parse(dataText);
    // `JSON.parse('null')` / `JSON.parse('42')` / `JSON.parse('[1,2]')`
    // etc. parse cleanly but aren't `DaemonEvent`-shaped. Casting
    // them through would hand consumers a value that violates the
    // generator's `AsyncGenerator<DaemonEvent>` contract (e.g.
    // `null` where `ev.type` is supposed to be readable, or an
    // array where `ev.v` would be undefined). The daemon itself
    // never emits these — `formatSseFrame` always serializes a
    // populated object with `v === 1` and `type: string` — so the
    // guard is defense-in-depth against misbehaving proxies /
    // alternate daemon implementations. Per BREsR: also reject
    // arrays and require minimal shape (`v === 1`, `type` is a
    // string) before yielding so the generator's static type is a
    // genuine runtime guarantee.
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    if (Array.isArray(parsed)) return undefined;
    if (
      (parsed as { v?: unknown }).v !== 1 ||
      typeof (parsed as { type?: unknown }).type !== 'string'
    ) {
      return undefined;
    }
    // BSP1-: when `id` is present it must be a finite safe integer.
    // `DaemonEvent.id` is `number | undefined`; a string `id` from a
    // misbehaving proxy would survive the v+type guard above and
    // break Last-Event-ID resume logic on the consumer side (which
    // does numeric comparisons). Reject the frame entirely so the
    // consumer's id-monotonicity invariant holds.
    //
    // BX8Y1: also require `id >= 1`. The daemon's `Last-Event-ID`
    // parser only accepts decimal digits (positive integers ≥ 0)
    // and the EventBus emits monotonic ids starting at 1. A client
    // that persisted `id = -1` from a malformed frame would later
    // send `Last-Event-ID: -1`, which the daemon silently ignores
    // → replay diverges. Fail loud at parse time instead.
    const rawId = (parsed as { id?: unknown }).id;
    if (rawId !== undefined) {
      if (!Number.isSafeInteger(rawId)) return undefined;
      if ((rawId as number) < 1) return undefined;
    }
    return parsed as DaemonEvent;
  } catch {
    return undefined;
  }
}
