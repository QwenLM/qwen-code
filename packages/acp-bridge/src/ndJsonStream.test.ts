/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { format } from 'node:util';
import {
  ClientSideConnection,
  type AnyMessage,
} from '@agentclientprotocol/sdk';
import {
  NDJSON_QUEUE_SATURATION_GRACE_MS,
  NdJsonIncompleteFrameError,
  NdJsonQueueLimitError,
  ndJsonStream,
  type NdJsonStreamLimits,
} from './ndJsonStream.js';
import {
  CHANNEL_LIVENESS_INTERVAL_MS,
  CHANNEL_LIVENESS_PROBE_TIMEOUT_MS,
} from './channel-liveness.js';

const encoder = new TextEncoder();

function message(method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', method, params } satisfies AnyMessage;
}

function byteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function limits(
  overrides: Partial<NdJsonStreamLimits> = {},
): NdJsonStreamLimits {
  return {
    maxFrameBytes: 1024,
    maxQueuedMessages: 4,
    maxQueuedBytes: 4096,
    ...overrides,
  };
}

async function readAll(readable: ReadableStream<AnyMessage>) {
  const reader = readable.getReader();
  const out: AnyMessage[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      out.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return out;
}

async function writeOne(
  writable: WritableStream<AnyMessage>,
  msg: AnyMessage,
): Promise<void> {
  const writer = writable.getWriter();
  try {
    await writer.write(msg);
  } finally {
    writer.releaseLock();
  }
}

describe('ndJsonStream', () => {
  it('round-trips one message', async () => {
    const sent = message('hello', { n: 1 });
    const line = `${JSON.stringify(sent)}\n`;
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([encoder.encode(line)]),
    );

    await expect(readAll(stream.readable)).resolves.toEqual([sent]);
  });

  it('parses multiple messages from one chunk', async () => {
    const first = message('first');
    const second = message('second', { ok: true });
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([
        encoder.encode(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`),
      ]),
    );

    await expect(readAll(stream.readable)).resolves.toEqual([first, second]);
  });

  it('parses a large message split across many chunks', async () => {
    const sent = message('large', { text: 'x'.repeat(1024 * 1024) });
    const bytes = encoder.encode(`${JSON.stringify(sent)}\n`);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      chunks.push(bytes.slice(offset, offset + 64 * 1024));
    }
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream(chunks),
    );

    await expect(readAll(stream.readable)).resolves.toEqual([sent]);
  });

  it('preserves multibyte UTF-8 characters across chunk boundaries', async () => {
    const sent = message('unicode', { text: 'a中b' });
    const bytes = encoder.encode(`${JSON.stringify(sent)}\n`);
    const split = bytes.indexOf(encoder.encode('中')[1]!);
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([bytes.slice(0, split), bytes.slice(split)]),
    );

    await expect(readAll(stream.readable)).resolves.toEqual([sent]);
  });

  it('skips empty and CRLF lines', async () => {
    const sent = message('crlf');
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([encoder.encode(`\n\r\n${JSON.stringify(sent)}\r\n`)]),
    );

    await expect(readAll(stream.readable)).resolves.toEqual([sent]);
  });

  it('logs invalid JSON and continues with later messages', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sent = message('after-error');
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([encoder.encode(`{bad json}\n${JSON.stringify(sent)}\n`)]),
    );

    await expect(readAll(stream.readable)).resolves.toEqual([sent]);
    expect(stderr).toHaveBeenCalledWith(
      'Failed to parse JSON message:',
      '{bad json}',
      expect.any(SyntaxError),
    );
    stderr.mockRestore();
  });

  it('drops an unterminated final line at EOF', async () => {
    const complete = message('complete');
    const partial = message('partial');
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([
        encoder.encode(
          `${JSON.stringify(complete)}\n${JSON.stringify(partial)}`,
        ),
      ]),
    );

    await expect(readAll(stream.readable)).resolves.toEqual([complete]);
  });

  it('reports received and sent payload byte counts without newlines', async () => {
    const received = message('received');
    const sent = message('sent', { value: 'ok' });
    const receivedBytes = encoder.encode(JSON.stringify(received)).byteLength;
    const sentBytes = encoder.encode(JSON.stringify(sent)).byteLength;
    const onMessageReceived = vi.fn();
    const onMessageSent = vi.fn();
    const outputChunks: Uint8Array[] = [];
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>({
        write(chunk) {
          outputChunks.push(chunk);
        },
      }),
      byteStream([encoder.encode(`${JSON.stringify(received)}\r\n`)]),
      { onMessageReceived, onMessageSent },
    );

    await expect(readAll(stream.readable)).resolves.toEqual([received]);
    await writeOne(stream.writable, sent);

    expect(onMessageReceived).toHaveBeenCalledWith(receivedBytes);
    expect(onMessageSent).toHaveBeenCalledWith(sentBytes);
    expect(new TextDecoder().decode(outputChunks[0])).toBe(
      `${JSON.stringify(sent)}\n`,
    );
  });

  it('reports observed sent and received messages without changing byte hooks', async () => {
    const received = message('observed-received');
    const sent = message('observed-sent', { value: 'ok' });
    const receivedBytes = encoder.encode(JSON.stringify(received)).byteLength;
    const sentBytes = encoder.encode(JSON.stringify(sent)).byteLength;
    const onMessageReceived = vi.fn();
    const onMessageSent = vi.fn();
    const onMessageObserved = vi.fn();
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([encoder.encode(`${JSON.stringify(received)}\r\n`)]),
      { onMessageReceived, onMessageSent, onMessageObserved },
    );

    await expect(readAll(stream.readable)).resolves.toEqual([received]);
    await writeOne(stream.writable, sent);

    expect(onMessageReceived).toHaveBeenCalledWith(receivedBytes);
    expect(onMessageReceived.mock.calls[0]).toHaveLength(1);
    expect(onMessageSent).toHaveBeenCalledWith(sentBytes);
    expect(onMessageSent.mock.calls[0]).toHaveLength(1);
    expect(onMessageObserved).toHaveBeenCalledWith({
      direction: 'received',
      bytes: receivedBytes,
      message: received,
    });
    expect(onMessageObserved).toHaveBeenCalledWith({
      direction: 'sent',
      bytes: sentBytes,
      message: sent,
    });
  });

  it('does not let hook errors break transport', async () => {
    const received = message('received');
    const sent = message('sent');
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([encoder.encode(`${JSON.stringify(received)}\n`)]),
      {
        onMessageReceived: () => {
          throw new Error('received hook failed');
        },
        onMessageSent: () => {
          throw new Error('sent hook failed');
        },
        onMessageObserved: () => {
          throw new Error('observed hook failed');
        },
      },
    );

    await expect(readAll(stream.readable)).resolves.toEqual([received]);
    await expect(writeOne(stream.writable, sent)).resolves.toBeUndefined();
  });

  it('propagates output write errors without reporting sent bytes', async () => {
    const sent = message('write-error');
    const onMessageSent = vi.fn();
    const onMessageObserved = vi.fn();
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>({
        write() {
          throw new Error('output closed');
        },
      }),
      byteStream([]),
      { onMessageSent, onMessageObserved },
    );

    await expect(writeOne(stream.writable, sent)).rejects.toThrow(
      'output closed',
    );
    expect(onMessageSent).not.toHaveBeenCalled();
    expect(onMessageObserved).not.toHaveBeenCalled();
  });

  it('accepts an inbound frame exactly at the configured byte limit', async () => {
    const sent = message('exact-limit');
    const frame = encoder.encode(`${JSON.stringify(sent)}\n`);
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([frame.slice(0, 3), frame.slice(3)]),
      undefined,
      limits({
        maxFrameBytes: frame.byteLength,
        maxQueuedMessages: 2,
        maxQueuedBytes: frame.byteLength * 2,
      }),
    );

    await expect(readAll(stream.readable)).resolves.toEqual([sent]);
  });

  it('counts CRLF and resets the bounded accumulator between frames', async () => {
    const first = message('first-crlf');
    const second = message('second-crlf');
    const firstFrame = encoder.encode(`${JSON.stringify(first)}\r\n`);
    const secondFrame = encoder.encode(`${JSON.stringify(second)}\r\n`);
    const maxFrameBytes = Math.max(
      firstFrame.byteLength,
      secondFrame.byteLength,
    );
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([
        firstFrame.slice(0, firstFrame.byteLength - 1),
        new Uint8Array([
          firstFrame[firstFrame.byteLength - 1]!,
          ...secondFrame,
        ]),
      ]),
      undefined,
      limits({
        maxFrameBytes,
        maxQueuedMessages: 2,
        maxQueuedBytes: maxFrameBytes * 2,
      }),
    );

    await expect(readAll(stream.readable)).resolves.toEqual([first, second]);

    const onTransportError = vi.fn();
    const rejected = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([firstFrame]),
      { onTransportError },
      limits({ maxFrameBytes: firstFrame.byteLength - 1 }),
    );
    await expect(readAll(rejected.readable)).resolves.toEqual([]);
    expect(onTransportError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'ndjson_frame_too_large',
        observedBytes: firstFrame.byteLength,
      }),
    );
    expect(onTransportError).toHaveBeenCalledOnce();
  });

  it('rejects an oversized inbound frame before parsing or reporting it', async () => {
    const sent = message('over-limit', { secret: 'do-not-log' });
    const frame = encoder.encode(`${JSON.stringify(sent)}\n`);
    const onMessageReceived = vi.fn();
    const onTransportError = vi.fn();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([frame.slice(0, 5), frame.slice(5)]),
      { onMessageReceived, onTransportError },
      limits({ maxFrameBytes: frame.byteLength - 1 }),
    );

    await expect(readAll(stream.readable)).resolves.toEqual([]);
    expect(onMessageReceived).not.toHaveBeenCalled();
    expect(onTransportError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'ndjson_frame_too_large',
        direction: 'received',
        limitBytes: frame.byteLength - 1,
        observedBytes: frame.byteLength,
      }),
    );
    expect(onTransportError).toHaveBeenCalledOnce();
    expect(stderr).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('rejects an incomplete final frame only on the bounded path', async () => {
    const partial = encoder.encode(JSON.stringify(message('partial')));
    const onTransportError = vi.fn();
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([partial]),
      { onTransportError },
      limits(),
    );

    await expect(readAll(stream.readable)).resolves.toEqual([]);
    expect(onTransportError).toHaveBeenCalledWith(
      expect.objectContaining({
        name: NdJsonIncompleteFrameError.name,
        code: 'ndjson_incomplete_frame',
        observedBytes: partial.byteLength,
      }),
    );
    expect(onTransportError).toHaveBeenCalledOnce();
  });

  it('bounds the decoded queue by message count for a stalled consumer', async () => {
    const frames = ['one', 'two', 'three']
      .map((method) => `${JSON.stringify(message(method))}\n`)
      .join('');
    const onMessageReceived = vi.fn();
    const onTransportError = vi.fn();
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([encoder.encode(frames)]),
      { onMessageReceived, onTransportError },
      limits({
        maxFrameBytes: 200,
        maxQueuedMessages: 2,
        maxQueuedBytes: 200,
        queueSaturationGraceMs: 25,
      }),
    );
    await vi.waitFor(() =>
      expect(onTransportError).toHaveBeenCalledWith(
        expect.any(NdJsonQueueLimitError),
      ),
    );
    expect(onTransportError).toHaveBeenCalledOnce();
    expect(onMessageReceived).toHaveBeenCalledTimes(2);
    await stream.readable.cancel();
  });

  it('bounds the decoded queue by retained wire bytes', async () => {
    const first = `${JSON.stringify(message('first', { text: 'x'.repeat(40) }))}\n`;
    const second = `${JSON.stringify(message('second', { text: 'y'.repeat(40) }))}\n`;
    const firstBytes = encoder.encode(first).byteLength;
    const onMessageReceived = vi.fn();
    const onTransportError = vi.fn();
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([encoder.encode(first + second)]),
      { onMessageReceived, onTransportError },
      limits({
        maxFrameBytes: 200,
        maxQueuedMessages: 100,
        maxQueuedBytes: firstBytes + 1,
        queueSaturationGraceMs: 25,
      }),
    );
    await vi.waitFor(() =>
      expect(onTransportError).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'ndjson_queue_limit_exceeded',
          maxQueuedBytes: firstBytes + 1,
        }),
      ),
    );
    expect(onTransportError).toHaveBeenCalledOnce();
    expect(onMessageReceived).toHaveBeenCalledOnce();
    await stream.readable.cancel();
  });

  it('backpressures a saturated queue until a transiently slow consumer drains', async () => {
    let inputController!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        inputController = controller;
      },
    });
    const first = message('first', { text: 'x'.repeat(120) });
    const second = message('second', { text: 'y'.repeat(120) });
    const onQueueSaturated = vi.fn();
    const onTransportError = vi.fn();
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      input,
      { onQueueSaturated, onTransportError },
      limits({
        maxFrameBytes: 1024,
        maxQueuedMessages: 2,
        maxQueuedBytes: 220,
        queueSaturationGraceMs: 5_000,
      }),
    );
    inputController.enqueue(
      encoder.encode(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`),
    );

    // No consumer read yet, so both frames charge the decoded queue and the
    // second one saturates it. The pump must wait instead of failing.
    await vi.waitFor(() => expect(onQueueSaturated).toHaveBeenCalledOnce());
    expect(onTransportError).not.toHaveBeenCalled();

    // Draining frees the queue; the waiting frame is then delivered.
    const reader = stream.readable.getReader();
    await expect(reader.read()).resolves.toMatchObject({
      value: first,
      done: false,
    });
    inputController.close();
    await expect(reader.read()).resolves.toMatchObject({
      value: second,
      done: false,
    });
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    expect(onQueueSaturated).toHaveBeenCalledOnce();
    expect(onTransportError).not.toHaveBeenCalled();
    reader.releaseLock();
  });

  it('warns once before failing closed when the consumer stays stalled', async () => {
    const first = message('first', { text: 'x'.repeat(120) });
    const second = message('second', { text: 'y'.repeat(120) });
    const onQueueSaturated = vi.fn();
    const onTransportError = vi.fn();
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([
        encoder.encode(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`),
      ]),
      { onQueueSaturated, onTransportError },
      limits({
        maxFrameBytes: 1024,
        maxQueuedMessages: 2,
        maxQueuedBytes: 220,
        queueSaturationGraceMs: 25,
      }),
    );

    await vi.waitFor(() =>
      expect(onTransportError).toHaveBeenCalledWith(
        expect.any(NdJsonQueueLimitError),
      ),
    );
    expect(onQueueSaturated).toHaveBeenCalledOnce();
    const firstFrameBytes =
      encoder.encode(JSON.stringify(first)).byteLength + 1;
    const secondFrameBytes =
      encoder.encode(JSON.stringify(second)).byteLength + 1;
    expect(onQueueSaturated).toHaveBeenCalledWith({
      requiredBytes: secondFrameBytes,
      availableBytes: 220 - firstFrameBytes,
      maxQueuedMessages: 2,
      maxQueuedBytes: 220,
      graceMs: 25,
    });
    await stream.readable.cancel();
  });

  it('warns once per saturation episode, not once per saturating frame', async () => {
    let inputController!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        inputController = controller;
      },
    });
    const frames = [
      message('first', { text: 'x'.repeat(120) }),
      message('second', { text: 'y'.repeat(120) }),
      message('third', { text: 'z'.repeat(120) }),
    ];
    const onQueueSaturated = vi.fn();
    const onTransportError = vi.fn();
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      input,
      { onQueueSaturated, onTransportError },
      limits({
        maxFrameBytes: 1024,
        maxQueuedMessages: 3,
        maxQueuedBytes: 220,
        queueSaturationGraceMs: 5_000,
      }),
    );
    inputController.enqueue(
      encoder.encode(
        frames.map((frame) => `${JSON.stringify(frame)}\n`).join(''),
      ),
    );

    // Frame one fits; frames two and three each saturate before the queue
    // fully drains, but only the first saturation of the episode warns.
    await vi.waitFor(() => expect(onQueueSaturated).toHaveBeenCalledOnce());
    const reader = stream.readable.getReader();
    for (const frame of frames) {
      await expect(reader.read()).resolves.toMatchObject({
        value: frame,
        done: false,
      });
    }

    const nextFrames = [
      message('fourth', { text: 'a'.repeat(120) }),
      message('fifth', { text: 'b'.repeat(120) }),
    ];
    inputController.enqueue(
      encoder.encode(
        nextFrames.map((frame) => `${JSON.stringify(frame)}\n`).join(''),
      ),
    );
    await vi.waitFor(() => expect(onQueueSaturated).toHaveBeenCalledTimes(2));
    for (const frame of nextFrames) {
      await expect(reader.read()).resolves.toMatchObject({
        value: frame,
        done: false,
      });
    }
    inputController.close();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    expect(onQueueSaturated).toHaveBeenCalledTimes(2);
    expect(onTransportError).not.toHaveBeenCalled();
    reader.releaseLock();
  });

  it('cancel while backpressured wakes the pump without a transport error', async () => {
    let inputController!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        inputController = controller;
      },
    });
    const first = message('first', { text: 'x'.repeat(120) });
    const second = message('second', { text: 'y'.repeat(120) });
    const onQueueSaturated = vi.fn();
    const onTransportError = vi.fn();
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      input,
      { onQueueSaturated, onTransportError },
      limits({
        maxFrameBytes: 1024,
        maxQueuedMessages: 2,
        maxQueuedBytes: 220,
        queueSaturationGraceMs: 200,
      }),
    );
    inputController.enqueue(
      encoder.encode(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`),
    );
    await vi.waitFor(() => expect(onQueueSaturated).toHaveBeenCalledOnce());

    await stream.readable.cancel();
    await vi.waitFor(() => expect(input.locked).toBe(false), { timeout: 100 });
    // Keep checking past the grace window for a late transport error.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(onTransportError).not.toHaveBeenCalled();
  });

  it('caps the queue-space timer at the Node timeout maximum', async () => {
    let inputController!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        inputController = controller;
      },
    });
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const onQueueSaturated = vi.fn();
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      input,
      { onQueueSaturated },
      limits({
        maxQueuedMessages: 2,
        maxQueuedBytes: 220,
        queueSaturationGraceMs: 2_147_483_648,
      }),
    );
    const first = message('first', { text: 'x'.repeat(120) });
    const second = message('second', { text: 'y'.repeat(120) });
    inputController.enqueue(
      encoder.encode(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`),
    );

    try {
      await vi.waitFor(() => expect(onQueueSaturated).toHaveBeenCalledOnce());
      expect(setTimeoutSpy.mock.calls.map((call) => call[1])).toContain(
        2_147_483_647,
      );
    } finally {
      await stream.readable.cancel();
      setTimeoutSpy.mockRestore();
    }
  });

  it('fails immediately for a frame that can never fit, without the saturation warning', async () => {
    const big = message('big', { text: 'x'.repeat(300) });
    const onQueueSaturated = vi.fn();
    const onTransportError = vi.fn();
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([encoder.encode(`${JSON.stringify(big)}\n`)]),
      { onQueueSaturated, onTransportError },
      limits({
        maxFrameBytes: 1024,
        maxQueuedMessages: 2,
        maxQueuedBytes: 220,
        queueSaturationGraceMs: 5_000,
      }),
    );

    await vi.waitFor(() =>
      expect(onTransportError).toHaveBeenCalledWith(
        expect.any(NdJsonQueueLimitError),
      ),
    );
    expect(onQueueSaturated).not.toHaveBeenCalled();
    await stream.readable.cancel();
  });

  it('keeps the default grace window under the liveness probe timeout', () => {
    // The channel liveness probe's response travels over this same stream, so
    // a pump parked on backpressure cannot answer it. At or above parity a
    // saturation episode burns a probe, and two episodes inside two probe
    // intervals tear the channel down as a liveness timeout — the outage the
    // grace window exists to prevent, reported as the wrong cause.
    expect(NDJSON_QUEUE_SATURATION_GRACE_MS).toBeLessThan(
      CHANNEL_LIVENESS_PROBE_TIMEOUT_MS,
    );
    expect(NDJSON_QUEUE_SATURATION_GRACE_MS).toBeLessThan(
      CHANNEL_LIVENESS_INTERVAL_MS,
    );
  });

  it('rejects a non-positive queueSaturationGraceMs', () => {
    expect(() =>
      ndJsonStream(
        new WritableStream<Uint8Array>(),
        byteStream([]),
        undefined,
        limits({ queueSaturationGraceMs: 0 }),
      ),
    ).toThrow(RangeError);
  });

  it('bounds requests retained by the ACP SDK while responses are blocked', async () => {
    const cancel = vi.fn();
    let inputController!: ReadableStreamDefaultController<Uint8Array>;
    let nextRequestId = 1;
    let timer: ReturnType<typeof setInterval> | undefined;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        inputController = controller;
        timer = setInterval(() => {
          if (nextRequestId > 3) {
            clearInterval(timer);
            return;
          }
          const request = {
            jsonrpc: '2.0',
            id: nextRequestId++,
            method: 'terminal/create',
            params: { command: 'true', sessionId: 'session' },
          };
          inputController.enqueue(
            encoder.encode(`${JSON.stringify(request)}\n`),
          );
        }, 0);
      },
      cancel,
    });
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let writeCount = 0;
    const outputWrite = vi.fn(() => {
      writeCount++;
      return writeCount === 1 ? firstWriteBlocked : Promise.resolve();
    });
    const onTransportError = vi.fn();
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>({ write: outputWrite }),
      input,
      { onTransportError },
      limits({
        maxFrameBytes: 1024,
        maxQueuedMessages: 2,
        maxQueuedBytes: 4096,
        queueSaturationGraceMs: 25,
      }),
    );
    const connection = new ClientSideConnection(() => ({}) as never, stream);

    await vi.waitFor(() =>
      expect(onTransportError).toHaveBeenCalledWith(
        expect.any(NdJsonQueueLimitError),
      ),
    );
    clearInterval(timer);
    expect(nextRequestId).toBe(4);
    expect(outputWrite).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    await expect(connection.closed).resolves.toBeUndefined();
    releaseFirstWrite();
  });

  it('keeps bounded parse-error logs free of input and parser text', async () => {
    const payload = '{"secret":"do-not-echo"';
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onTransportError = vi.fn();
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([encoder.encode(`${payload}\n`)]),
      { onTransportError },
      limits(),
    );

    await expect(readAll(stream.readable)).resolves.toEqual([]);
    expect(onTransportError).toHaveBeenCalledOnce();
    expect(onTransportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ndjson_parse_error' }),
    );
    expect(stderr).toHaveBeenCalledWith('Failed to parse JSON message:', {
      errorKind: 'ndjson_parse_error',
      bytes: encoder.encode(payload).byteLength,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      payloadOmitted: true,
    });
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('do-not-echo');
    stderr.mockRestore();
  });

  it('rejects malformed JSON-RPC envelopes without logging their payloads', async () => {
    const invalidLines = [
      JSON.stringify({ jsonrpc: '2.0', secret: 'object-secret' }),
      JSON.stringify(['array-secret']),
      JSON.stringify('scalar-secret'),
      JSON.stringify({
        jsonrpc: '1.0',
        method: 'bad',
        secret: 'version-secret',
      }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, secret: 'response-secret' }),
      JSON.stringify({ jsonrpc: '2.0', id: 99, result: 'unknown-response' }),
    ];
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onMessageReceived = vi.fn();
    for (const line of invalidLines) {
      const onTransportError = vi.fn();
      const stream = ndJsonStream(
        new WritableStream<Uint8Array>(),
        byteStream([encoder.encode(`${line}\n`)]),
        { onMessageReceived, onTransportError },
        limits({ maxQueuedMessages: 8, maxQueuedBytes: 8192 }),
      );
      await expect(readAll(stream.readable)).resolves.toEqual([]);
      expect(onTransportError).toHaveBeenCalledOnce();
      expect(onTransportError).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'ndjson_invalid_message' }),
      );
    }
    expect(onMessageReceived).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(invalidLines.length);
    for (const call of stderr.mock.calls) {
      expect(call).toEqual([
        'Failed to parse JSON message:',
        {
          errorKind: 'ndjson_invalid_message',
          bytes: expect.any(Number),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          payloadOmitted: true,
        },
      ]);
    }
    expect(JSON.stringify(stderr.mock.calls)).not.toMatch(/-secret/u);
    stderr.mockRestore();
  });

  it('accepts bounded JSON-RPC string ids', async () => {
    const request = {
      jsonrpc: '2.0',
      id: 'request-1',
      method: 'client/request',
      params: { ok: true },
    } satisfies AnyMessage;
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([encoder.encode(`${JSON.stringify(request)}\n`)]),
      undefined,
      limits(),
    );

    await expect(readAll(stream.readable)).resolves.toEqual([request]);
  });

  it('accepts a string response id only when an outbound request owns it', async () => {
    let inputController!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        inputController = controller;
      },
    });
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      input,
      undefined,
      limits(),
    );
    const writer = stream.writable.getWriter();
    await writer.write({
      jsonrpc: '2.0',
      id: 'owned-request',
      method: 'agent/request',
      params: {},
    });
    const response = {
      jsonrpc: '2.0',
      id: 'owned-request',
      result: { ok: true },
    } satisfies AnyMessage;
    inputController.enqueue(encoder.encode(`${JSON.stringify(response)}\n`));
    inputController.close();

    await expect(readAll(stream.readable)).resolves.toEqual([response]);
    writer.releaseLock();
  });

  it('allows an owned bulk response beyond inbound structure limits', async () => {
    let inputController!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        inputController = controller;
      },
    });
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      input,
      undefined,
      limits({ maxFrameBytes: 128_000, maxQueuedBytes: 128_000 }),
    );
    const writer = stream.writable.getWriter();
    await writer.write({
      jsonrpc: '2.0',
      id: 41,
      method: 'session/load',
      params: {},
    });
    const response = {
      jsonrpc: '2.0',
      id: 41,
      result: { updates: Array.from({ length: 4_097 }, () => null) },
    } satisfies AnyMessage;
    inputController.enqueue(encoder.encode(`${JSON.stringify(response)}\n`));
    inputController.close();

    await expect(readAll(stream.readable)).resolves.toEqual([response]);
    writer.releaseLock();
  });

  it('rejects oversized request structures without materializing values', async () => {
    const params = Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [`k${index}`, index]),
    );
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'client/request',
      params,
    } satisfies AnyMessage;
    const line = `${JSON.stringify(request)}\n`;
    const onTransportError = vi.fn();
    const valuesSpy = vi.spyOn(Object, 'values');
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([encoder.encode(line)]),
      { onTransportError },
      limits({ maxFrameBytes: 256_000, maxQueuedBytes: 256_000 }),
    );

    await expect(readAll(stream.readable)).resolves.toEqual([]);
    expect(onTransportError).toHaveBeenCalledOnce();
    expect(onTransportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ndjson_invalid_message' }),
    );
    expect(valuesSpy).not.toHaveBeenCalled();
    valuesSpy.mockRestore();
  });

  it('accepts a matching response before local write completion', async () => {
    let inputController!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        inputController = controller;
      },
    });
    let finishWrite!: () => void;
    const writeFinished = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const response = {
      jsonrpc: '2.0',
      id: 7,
      result: { ok: true },
    } satisfies AnyMessage;
    const onTransportError = vi.fn();
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>({
        write() {
          inputController.enqueue(
            encoder.encode(`${JSON.stringify(response)}\n`),
          );
          inputController.close();
          return writeFinished;
        },
      }),
      input,
      { onTransportError },
      limits(),
    );
    const writer = stream.writable.getWriter();
    const write = writer.write({
      jsonrpc: '2.0',
      id: 7,
      method: 'agent/request',
      params: {},
    });

    await expect(readAll(stream.readable)).resolves.toEqual([response]);
    expect(onTransportError).not.toHaveBeenCalled();
    finishWrite();
    await write;
    writer.releaseLock();
  });

  it('bounds outbound requests that never receive a response', async () => {
    const input = new ReadableStream<Uint8Array>();
    const onTransportError = vi.fn();
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      input,
      { onTransportError },
      limits({ maxQueuedMessages: 2, maxQueuedBytes: 4096 }),
    );
    const writer = stream.writable.getWriter();
    await writer.write({
      jsonrpc: '2.0',
      id: 1,
      method: 'agent/request',
      params: {},
    });
    await writer.write({
      jsonrpc: '2.0',
      id: 2,
      method: 'agent/request',
      params: {},
    });

    await expect(
      writer.write({
        jsonrpc: '2.0',
        id: 3,
        method: 'agent/request',
        params: {},
      }),
    ).rejects.toBeInstanceOf(NdJsonQueueLimitError);
    expect(onTransportError).toHaveBeenCalledOnce();
    writer.releaseLock();
    await stream.readable.cancel();
  });

  it('rejects log-amplifying protocol scalars before ACP SDK dispatch', async () => {
    const renderedErrors: string[] = [];
    const stderr = vi.spyOn(console, 'error').mockImplementation((...args) => {
      renderedErrors.push(format(...args));
    });
    const invalidLines = [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: `unknown/${'SECRET_METHOD'.repeat(100)}`,
        params: {},
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'SECRET_ID',
        result: {},
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        error: {
          code: -32603,
          message: 'SECRET_ERROR'.repeat(100),
        },
      }),
    ];
    const onMessageReceived = vi.fn();
    for (const line of invalidLines) {
      const onTransportError = vi.fn();
      const stream = ndJsonStream(
        new WritableStream<Uint8Array>(),
        byteStream([encoder.encode(`${line}\n`)]),
        { onMessageReceived, onTransportError },
        limits({ maxFrameBytes: 4096, maxQueuedBytes: 16_384 }),
      );
      const connection = new ClientSideConnection(() => ({}) as never, stream);
      await expect(connection.closed).resolves.toBeUndefined();
      expect(onTransportError).toHaveBeenCalledOnce();
      expect(onTransportError).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'ndjson_invalid_message' }),
      );
    }
    expect(onMessageReceived).not.toHaveBeenCalled();
    expect(renderedErrors).toHaveLength(invalidLines.length);
    expect(renderedErrors.join('\n')).toContain('ndjson_invalid_message');
    expect(renderedErrors.join('\n')).not.toMatch(
      /SECRET_METHOD|SECRET_ID|SECRET_ERROR/u,
    );
    stderr.mockRestore();
  });

  it('checks outbound frame bytes including the newline', async () => {
    const sent = message('outbound-exact');
    const payloadBytes = encoder.encode(JSON.stringify(sent)).byteLength;
    const outputChunks: Uint8Array[] = [];
    const exact = ndJsonStream(
      new WritableStream<Uint8Array>({
        write(chunk) {
          outputChunks.push(chunk);
        },
      }),
      byteStream([]),
      undefined,
      limits({ maxFrameBytes: payloadBytes + 1 }),
    );
    await expect(writeOne(exact.writable, sent)).resolves.toBeUndefined();
    expect(outputChunks[0]?.byteLength).toBe(payloadBytes + 1);

    const onTransportError = vi.fn();
    const rejected = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([]),
      { onTransportError },
      limits({ maxFrameBytes: payloadBytes }),
    );
    await expect(writeOne(rejected.writable, sent)).rejects.toMatchObject({
      code: 'ndjson_frame_too_large',
      direction: 'sent',
      observedBytes: payloadBytes + 1,
    });
    expect(onTransportError).toHaveBeenCalledOnce();
  });

  it('reports bounded outbound serialization failures exactly once', async () => {
    const cyclic: Record<string, unknown> = {
      jsonrpc: '2.0',
      method: 'cyclic',
    };
    cyclic['self'] = cyclic;
    const invalidMessages = [
      cyclic,
      { jsonrpc: '2.0', method: 'bigint', params: { value: 1n } },
    ];

    for (const invalid of invalidMessages) {
      const onTransportError = vi.fn();
      const stream = ndJsonStream(
        new WritableStream<Uint8Array>(),
        byteStream([]),
        { onTransportError },
        limits(),
      );

      await expect(
        writeOne(stream.writable, invalid as unknown as AnyMessage),
      ).rejects.toBeInstanceOf(TypeError);
      expect(onTransportError).toHaveBeenCalledOnce();
      expect(onTransportError).toHaveBeenCalledWith(expect.any(TypeError));
    }
  });

  it('cancels and unlocks bounded input during frame assembly', async () => {
    const cancel = vi.fn();
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"partial":'));
      },
      cancel,
    });
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      input,
      undefined,
      limits(),
    );

    await stream.readable.cancel('test cancellation');

    expect(cancel).toHaveBeenCalledWith('test cancellation');
    await vi.waitFor(() => expect(input.locked).toBe(false));
  });

  it('closes the ACP SDK connection without rejecting on inbound fatal', async () => {
    const onTransportError = vi.fn();
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([encoder.encode('x'.repeat(17))]),
      { onTransportError },
      limits({ maxFrameBytes: 16 }),
    );
    const connection = new ClientSideConnection(() => ({}) as never, stream);

    await expect(connection.closed).resolves.toBeUndefined();
    expect(connection.signal.aborted).toBe(true);
    expect(onTransportError).toHaveBeenCalledOnce();
    expect(onTransportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ndjson_frame_too_large' }),
    );
  });

  it('delivers complete admitted frames before a later inbound fatal', async () => {
    const notifications = vi.fn();
    const onTransportError = vi.fn();
    const first = message('prefix-one', { n: 1 });
    const second = message('prefix-two', { n: 2 });
    const maxFrameBytes = 128;
    const input = encoder.encode(
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n${'x'.repeat(maxFrameBytes + 1)}`,
    );
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([input]),
      { onTransportError },
      limits({
        maxFrameBytes,
        maxQueuedMessages: 4,
        maxQueuedBytes: maxFrameBytes * 4,
      }),
    );
    const connection = new ClientSideConnection(
      () =>
        ({
          extNotification: async (method: string, params: unknown) => {
            notifications(method, params);
          },
        }) as never,
      stream,
    );

    await expect(connection.closed).resolves.toBeUndefined();
    expect(notifications.mock.calls).toEqual([
      ['prefix-one', { n: 1 }],
      ['prefix-two', { n: 2 }],
    ]);
    expect(onTransportError).toHaveBeenCalledOnce();
    expect(onTransportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ndjson_frame_too_large' }),
    );
  });

  it('redacts bounded valid messages when the ACP SDK logs handler errors', async () => {
    const renderedErrors: string[] = [];
    const stderr = vi.spyOn(console, 'error').mockImplementation((...args) => {
      renderedErrors.push(format(...args));
    });
    const input = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'unknown/request',
        params: { secret: 'unknown-secret' },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'session/request_permission',
        params: { secret: 'params-secret' },
      },
    ];
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([
        encoder.encode(
          `${input.map((value) => JSON.stringify(value)).join('\n')}\n`,
        ),
      ]),
      undefined,
      limits({ maxQueuedMessages: 4, maxQueuedBytes: 4096 }),
    );
    const connection = new ClientSideConnection(() => ({}) as never, stream);

    await expect(connection.closed).resolves.toBeUndefined();
    await vi.waitFor(() => expect(renderedErrors).toHaveLength(2));
    expect(renderedErrors.join('\n')).toContain('payloadOmitted: true');
    expect(renderedErrors.join('\n')).not.toMatch(
      /unknown-secret|params-secret/u,
    );
    stderr.mockRestore();
  });
});
