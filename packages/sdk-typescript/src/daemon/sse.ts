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
 * Field handling follows the EventSource spec subset that the daemon emits
 * (`packages/cli/src/serve/server.ts` `formatSseFrame`):
 *   - Frames are separated by a blank line (`\n\n`).
 *   - Comment lines (`: ...`) and the `retry:` directive are ignored.
 *   - The `id`, `event`, `data` fields are recognized; the `data` field is
 *     parsed as JSON and yielded as the event payload.
 *   - Malformed frames (non-JSON `data`, missing `data`) are skipped silently
 *     so a single bad frame can't poison the iterator.
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
        // Flush any trailing complete frame.
        if (buf.length > 0) {
          const frame = parseFrame(buf);
          if (frame) yield frame;
        }
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* reader already detached */
    }
  }
}

function parseFrame(raw: string): DaemonEvent | undefined {
  if (!raw) return undefined;
  if (raw.startsWith(':') || raw.startsWith('retry:')) return undefined;
  let dataLine: string | undefined;
  for (const line of raw.split('\n')) {
    if (line.startsWith('data: ')) dataLine = line.slice(6);
    // `id:` and `event:` are encoded redundantly inside the JSON `data`
    // payload (see `formatSseFrame`) so we don't need to surface them
    // separately on the parsed object.
  }
  if (!dataLine) return undefined;
  try {
    return JSON.parse(dataLine) as DaemonEvent;
  } catch {
    return undefined;
  }
}
