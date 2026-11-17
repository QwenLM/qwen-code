/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAcpOutput } from './acp-output.js';

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => vi.useRealTimers());

describe('ACP EOF output', () => {
  it('waits for native finish even when a small Web write already resolved', async () => {
    let finishWrite!: () => void;
    const native = new Writable({
      write(_chunk, _encoding, callback) {
        finishWrite = callback;
      },
    });
    const output = createAcpOutput(native);
    const writer = output.stream.getWriter();
    await writer.write(new TextEncoder().encode('{}\n'));
    expect(native.writableLength).toBe(3);
    let closed = false;
    const closing = output.close().then(() => {
      closed = true;
    });

    await nextTurn();
    expect(closed).toBe(false);
    expect(native.writableFinished).toBe(false);
    finishWrite();
    await closing;
    expect(native.writableFinished).toBe(true);
    writer.releaseLock();
  });

  it('finishes a backpressured frame before closing and refuses later frames', async () => {
    let finishWrite!: () => void;
    const chunks: Buffer[] = [];
    const native = new Writable({
      highWaterMark: 16,
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        finishWrite = callback;
      },
    });
    const output = createAcpOutput(native);
    const writer = output.stream.getWriter();
    const frame = new TextEncoder().encode(
      `${JSON.stringify({ text: 'x'.repeat(256 * 1024) })}\n`,
    );
    const writing = writer.write(frame);
    await nextTurn();
    const closing = output.close();
    const lateWrite = writer
      .write(new TextEncoder().encode('{"late":true}\n'))
      .catch((error: unknown) => error);

    finishWrite();
    await writing;
    await closing;
    await expect(lateWrite).resolves.toEqual(new Error('ACP output is closed'));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(frame));
    expect(native.writableFinished).toBe(true);
    writer.releaseLock();
  });

  it('reuses the close promise and only finalizes the native output once', async () => {
    const finalize = vi.fn((callback: (error?: Error | null) => void) =>
      callback(),
    );
    const native = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final: finalize,
    });
    const output = createAcpOutput(native);
    const closing = output.close();
    expect(output.close()).toBe(closing);
    await closing;
    expect(output.close()).toBe(closing);
    expect(finalize).toHaveBeenCalledOnce();
  });

  it('retains the original write error when EOF arrives after the stream errored', async () => {
    const error = Object.assign(new Error('reader closed'), { code: 'EPIPE' });
    const native = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        callback(error);
      },
    });
    const output = createAcpOutput(native);
    const writer = output.stream.getWriter();
    await expect(writer.write(new Uint8Array([1]))).rejects.toBe(error);

    await expect(output.close()).rejects.toBe(error);
    writer.releaseLock();
  });

  it('propagates a native finish failure', async () => {
    const error = new Error('finish failed');
    const output = createAcpOutput(
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
        final(callback) {
          callback(error);
        },
      }),
    );

    await expect(output.close()).rejects.toBe(error);
  });

  it('bounds a stalled native write, destroys it, and clears the deadline', async () => {
    const native = new Writable({
      highWaterMark: 1,
      write() {},
    });
    const output = createAcpOutput(native);
    const writer = output.stream.getWriter();
    const writing = writer.write(new Uint8Array([1])).catch(() => {});
    await nextTurn();
    vi.useFakeTimers();
    const closing = output.close();
    const rejection = closing.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(native.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(rejection).resolves.toEqual(
      new Error('ACP output did not drain within 2000ms'),
    );
    await writing;
    expect(native.destroyed).toBe(true);
    expect(native.writableFinished).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    writer.releaseLock();
  });

  it('cancels the deadline after successful finish', async () => {
    const native = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      autoDestroy: false,
    });
    const output = createAcpOutput(native);
    vi.useFakeTimers();

    await output.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(native.destroyed).toBe(false);
    native.destroy();
  });
});
