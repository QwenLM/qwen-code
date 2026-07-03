/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { AnyMessage } from '@agentclientprotocol/sdk';
import { ndJsonStream } from './ndJsonStream.js';

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
      },
    );

    await expect(readAll(stream.readable)).resolves.toEqual([received]);
    await expect(writeOne(stream.writable, sent)).resolves.toBeUndefined();
  });

  it('propagates output write errors without reporting sent bytes', async () => {
    const sent = message('write-error');
    const onMessageSent = vi.fn();
    const stream = ndJsonStream(
      new WritableStream<Uint8Array>({
        write() {
          throw new Error('output closed');
        },
      }),
      byteStream([]),
      { onMessageSent },
    );

    await expect(writeOne(stream.writable, sent)).rejects.toThrow(
      'output closed',
    );
    expect(onMessageSent).not.toHaveBeenCalled();
  });
});
