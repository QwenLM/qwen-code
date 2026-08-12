/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ClientSideConnection,
  type AnyMessage,
} from '@agentclientprotocol/sdk';
import {
  NdJsonIncompleteFrameError,
  NdJsonQueueLimitError,
  ndJsonStream,
  type NdJsonStreamLimits,
} from './ndJsonStream.js';

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

  it('keeps bounded parse-error logs free of input and parser text', async () => {
    const payload = '{"secret":"do-not-echo"';
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>(),
      byteStream([encoder.encode(`${payload}\n`)]),
      undefined,
      limits(),
    );

    await expect(readAll(stream.readable)).resolves.toEqual([]);
    expect(stderr).toHaveBeenCalledWith('Failed to parse JSON message:', {
      errorKind: 'ndjson_parse_error',
      bytes: encoder.encode(payload).byteLength,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      payloadOmitted: true,
    });
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('do-not-echo');
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
});
