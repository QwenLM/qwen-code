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
});
