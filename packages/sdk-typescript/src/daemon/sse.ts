/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonEvent } from './types.js';

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
 * Hard cap on accumulated unread UTF-16 code units (i.e. `buf.length`,
 * NOT bytes — see the byte-equivalence note below) before we abort
 * the stream as malformed. SSE frames are typically a few hundred
 * bytes; even a heavily-batched provider rarely crosses 64 KiB. A
 * buffer that grows past 16 Mi code units is a strong signal that
 * the upstream is NOT SSE — e.g. a misconfigured proxy returned a
 * non-streaming body, or the server never emits the `\n\n`
 * separator. Without a cap, `buf` grows until the consumer OOMs.
 *
 * Cap is in UTF-16 code units (`buf.length`), NOT bytes — `buf` is a
 * decoded JS string. For mostly-ASCII content (the daemon's JSON
 * envelope) one code unit ≈ one byte, so the cap behaves like a
 * ~16 MiB byte cap. Mixed BMP / supplementary content can push the
 * actual byte count up to ~64 MiB before tripping (one code unit per
 * UTF-16 unit, but UTF-8 bytes can be 1–4 per code point). Either way
 * the threshold's job is "stop runaway non-SSE bodies", not exact
 * accounting, so the proxy is intentional.
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
      const { value, done } = await reader.read();
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
        throw new Error(
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
  while (cursor < buf.length) {
    const lf = buf.indexOf('\n\n', cursor);
    const crlf = buf.indexOf('\r\n\r\n', cursor);
    let sepIdx: number;
    let sepLen: number;
    if (lf === -1 && crlf === -1) break;
    if (lf === -1) {
      sepIdx = crlf;
      sepLen = 4;
    } else if (crlf === -1) {
      sepIdx = lf;
      sepLen = 2;
    } else if (crlf < lf) {
      sepIdx = crlf;
      sepLen = 4;
    } else {
      sepIdx = lf;
      sepLen = 2;
    }
    frames.push(buf.slice(cursor, sepIdx));
    cursor = sepIdx + sepLen;
  }
  return { frames, tail: buf.slice(cursor) };
}

function parseFrame(raw: string): DaemonEvent | undefined {
  if (!raw) return undefined;
  if (raw.startsWith(':') || raw.startsWith('retry:')) return undefined;
  // Per the EventSource spec, a frame may have multiple `data:` lines that
  // accumulate into the final field value joined by `\n`. Whitespace after
  // the colon is optional — `data: foo` and `data:foo` are both valid.
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
    return JSON.parse(dataText) as DaemonEvent;
  } catch {
    return undefined;
  }
}
