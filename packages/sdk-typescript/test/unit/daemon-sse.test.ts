/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseSseStream } from '../../src/daemon/sse.js';
import type { DaemonEvent } from '../../src/daemon/types.js';

function bodyFromString(s: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(s));
      controller.close();
    },
  });
}

function bodyFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(
  iter: AsyncIterable<DaemonEvent>,
  max = 100,
): Promise<DaemonEvent[]> {
  const out: DaemonEvent[] = [];
  for await (const e of iter) {
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

describe('parseSseStream', () => {
  it('parses a single frame', async () => {
    const stream = bodyFromString(
      'id: 1\nevent: session_update\ndata: {"id":1,"v":1,"type":"session_update","data":"hello"}\n\n',
    );
    const events = await collect(parseSseStream(stream));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      id: 1,
      v: 1,
      type: 'session_update',
      data: 'hello',
    });
  });

  it('parses multiple frames', async () => {
    const stream = bodyFromString(
      'id: 1\nevent: session_update\ndata: {"id":1,"v":1,"type":"session_update","data":"a"}\n\n' +
        'id: 2\nevent: session_update\ndata: {"id":2,"v":1,"type":"session_update","data":"b"}\n\n',
    );
    const events = await collect(parseSseStream(stream));
    expect(events.map((e) => e.id)).toEqual([1, 2]);
  });

  it('skips comment lines and retry directives', async () => {
    const stream = bodyFromString(
      'retry: 3000\n\n' +
        ': heartbeat\n\n' +
        'id: 1\nevent: x\ndata: {"id":1,"v":1,"type":"x","data":1}\n\n',
    );
    const events = await collect(parseSseStream(stream));
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(1);
  });

  it('still parses a frame whose FIRST line is a comment / retry (BRgq-)', async () => {
    // Per SSE spec, comment + retry are line-level, not frame-level.
    // An intermediary that prepends `: keep-alive` or `retry: …` to
    // every frame must NOT cause the embedded event to be dropped.
    const stream = bodyFromString(
      ': intermediary keep-alive\nid: 1\nevent: x\ndata: {"id":1,"v":1,"type":"x","data":"ok"}\n\n' +
        'retry: 5000\nid: 2\nevent: x\ndata: {"id":2,"v":1,"type":"x","data":"ok"}\n\n',
    );
    const events = await collect(parseSseStream(stream));
    expect(events.map((e) => e.id)).toEqual([1, 2]);
  });

  it('handles frames split across read chunks', async () => {
    const stream = bodyFromChunks([
      'id: 1\nevent: x\nda',
      'ta: {"id":1,"v":1,"type"',
      ':"x","data":42}\n\n',
    ]);
    const events = await collect(parseSseStream(stream));
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe(42);
  });

  it('skips frames whose data is not valid JSON', async () => {
    const stream = bodyFromString(
      'id: 1\ndata: {bogus json\n\n' +
        'id: 2\nevent: x\ndata: {"id":2,"v":1,"type":"x","data":"ok"}\n\n',
    );
    const events = await collect(parseSseStream(stream));
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(2);
  });

  it('skips frames whose `id` is present but not a safe integer (BSP1-)', async () => {
    // `DaemonEvent.id` is `number | undefined`. A string / float /
    // unsafe-bigint id from a misbehaving proxy would break the
    // consumer's Last-Event-ID resume math (which does numeric
    // comparisons against the in-memory monotonic counter).
    const stream = bodyFromString(
      'data: {"id":"1","v":1,"type":"x","data":"ok"}\n\n' + // string id
        'data: {"id":1.5,"v":1,"type":"x","data":"ok"}\n\n' + // float id
        'data: {"id":9007199254740993,"v":1,"type":"x","data":"ok"}\n\n' + // > MAX_SAFE_INTEGER
        'data: {"id":-1,"v":1,"type":"x","data":"ok"}\n\n' + // negative — passes
        'data: {"v":1,"type":"x","data":"ok"}\n\n' + // no id — passes
        'data: {"id":42,"v":1,"type":"x","data":"ok"}\n\n', // ok
    );
    const events = await collect(parseSseStream(stream));
    // Only the negative-id, no-id, and 42-id frames pass. (Negative
    // is technically a safe integer; the daemon never emits negative
    // ids but the guard isn't responsible for that constraint.)
    expect(events.map((e) => e.id)).toEqual([-1, undefined, 42]);
  });

  it('skips non-DaemonEvent JSON (null/primitive/array/shape-mismatch) — BQ9ze+BREsR guards', async () => {
    // `JSON.parse('null')` / `JSON.parse('[...]')` / objects missing
    // `v === 1` / `type: string` parse cleanly but aren't
    // `DaemonEvent`-shaped. The generator's static type is
    // `AsyncGenerator<DaemonEvent>` — yielding non-event values
    // would violate the runtime contract. The daemon never emits
    // any of these; defense-in-depth against misbehaving proxies.
    const stream = bodyFromString(
      'id: 1\ndata: null\n\n' +
        'id: 2\ndata: 42\n\n' +
        'id: 3\ndata: "string"\n\n' +
        'id: 4\ndata: [1,2,3]\n\n' +
        'id: 5\ndata: {"v":1}\n\n' + // missing `type`
        'id: 6\ndata: {"v":2,"type":"x","data":"ok"}\n\n' + // wrong `v`
        'id: 7\ndata: {"v":1,"type":42,"data":"ok"}\n\n' + // type not string
        'id: 8\nevent: x\ndata: {"id":8,"v":1,"type":"x","data":"ok"}\n\n',
    );
    const events = await collect(parseSseStream(stream));
    // Only the well-formed frame should yield.
    expect(events.map((e) => e.id)).toEqual([8]);
  });

  it('flushes a trailing frame with no terminating blank line on stream close', async () => {
    const stream = bodyFromString(
      'id: 1\nevent: x\ndata: {"id":1,"v":1,"type":"x","data":1}',
    );
    const events = await collect(parseSseStream(stream));
    expect(events).toHaveLength(1);
  });

  it('yields nothing for an empty stream', async () => {
    const stream = bodyFromString('');
    const events = await collect(parseSseStream(stream));
    expect(events).toEqual([]);
  });

  it('parses CRLF-delimited frames', async () => {
    // Some proxies / Node http servers normalize line endings to CRLF.
    const stream = bodyFromString(
      'id: 1\r\nevent: x\r\ndata: {"id":1,"v":1,"type":"x","data":1}\r\n\r\n' +
        'id: 2\r\nevent: x\r\ndata: {"id":2,"v":1,"type":"x","data":2}\r\n\r\n',
    );
    const events = await collect(parseSseStream(stream));
    expect(events.map((e) => e.id)).toEqual([1, 2]);
  });

  it('parses a mix of LF and CRLF frame separators', async () => {
    const stream = bodyFromString(
      'id: 1\nevent: x\ndata: {"id":1,"v":1,"type":"x","data":1}\n\n' +
        'id: 2\r\nevent: x\r\ndata: {"id":2,"v":1,"type":"x","data":2}\r\n\r\n',
    );
    const events = await collect(parseSseStream(stream));
    expect(events.map((e) => e.id)).toEqual([1, 2]);
  });

  it('accepts data: lines without a trailing space (per SSE spec)', async () => {
    const stream = bodyFromString(
      'id: 1\nevent: x\ndata:{"id":1,"v":1,"type":"x","data":"no-space"}\n\n',
    );
    const events = await collect(parseSseStream(stream));
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('no-space');
  });

  it('accumulates multiple data: lines per spec (joined by \\n)', async () => {
    // Per SSE field parsing, a frame with two `data:` lines yields a value
    // with a `\n` between them. JSON-encoded objects with embedded newlines
    // round-trip fine when re-parsed.
    const stream = bodyFromString(
      'id: 1\nevent: x\ndata: {"id":1,"v":1,"type":"x",\ndata: "data":"split"}\n\n',
    );
    const events = await collect(parseSseStream(stream));
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('split');
  });

  it('cancels the underlying reader on early consumer break', async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'id: 1\nevent: x\ndata: {"id":1,"v":1,"type":"x","data":1}\n\n',
          ),
        );
        // Hold the stream open — we expect the consumer to cancel before
        // we send another frame.
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const _e of parseSseStream(body)) {
      // First event arrives; break out immediately.
      break;
    }
    // The for-await break invokes the iterator's `return()`, which runs
    // the parser's finally block and calls `reader.cancel()` — that
    // propagates to the underlying ReadableStream's `cancel()`.
    expect(cancelled).toBe(true);
  });

  it('flushes the TextDecoder on stream close so the last UTF-8 char is preserved', async () => {
    // "中" is 3 bytes in UTF-8 (0xE4 0xB8 0xAD). Split the byte stream
    // mid-character to simulate a chunk boundary that lands inside the
    // multi-byte sequence; without `decoder.decode()` flush at end-of-
    // stream the trailing byte would be dropped and the JSON parse would
    // fail.
    const fullFrame =
      'id: 1\nevent: x\ndata: {"id":1,"v":1,"type":"x","data":"中"}';
    const bytes = new TextEncoder().encode(fullFrame);
    const splitAt = bytes.length - 1; // chop off the last byte
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, splitAt));
        controller.enqueue(bytes.slice(splitAt));
        controller.close();
      },
    });
    const events = await collect(parseSseStream(stream));
    expect(events).toHaveLength(1);
    expect(events[0]?.data as string).toBe('中');
  });
});
