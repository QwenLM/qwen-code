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
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<DaemonEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        // Flush any bytes the decoder is still holding for an incomplete
        // multi-byte UTF-8 sequence at the tail. Without this, the last
        // character of the last frame can be silently dropped.
        buf += decoder.decode();
        if (buf.length > 0) {
          // Normalize CRLF in any trailing fragment too.
          for (const raw of splitFrames(buf)) {
            const frame = parseFrame(raw);
            if (frame) yield frame;
          }
        }
        return;
      }
      buf += decoder.decode(value, { stream: true });
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

/** Used for trailing fragments that lack a separator but contain a frame. */
function splitFrames(raw: string): string[] {
  // No more separators expected; the whole tail is at most one frame.
  return [raw];
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
