/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { SseStream } from './sse-stream.js';

type WriteCallback = (err?: Error | null) => void;

/**
 * Minimal Express `Response` mock: an EventEmitter with the `write`/`end`/
 * header surface `SseStream` touches. `writeBehavior` lets a test force
 * `res.write` to return false (backpressure) or throw (socket error).
 */
function mockRes(
  writeBehavior?: () => boolean,
  writeCallbacks?: WriteCallback[],
) {
  const ee = new EventEmitter() as unknown as Response & {
    chunks: string[];
    ended: boolean;
  };
  const m = ee as unknown as {
    chunks: string[];
    ended: boolean;
    writableEnded: boolean;
    status: () => unknown;
    setHeader: () => void;
    flushHeaders: () => void;
    write: (c: string, callback?: WriteCallback) => boolean;
    end: () => void;
    req: EventEmitter;
  };
  m.chunks = [];
  m.ended = false;
  m.writableEnded = false;
  m.status = () => ee;
  m.setHeader = () => {};
  m.flushHeaders = () => {};
  m.req = new EventEmitter();
  m.write = (chunk: string, callback?: WriteCallback) => {
    m.chunks.push(chunk);
    if (callback) {
      if (writeCallbacks) writeCallbacks.push(callback);
      else queueMicrotask(callback);
    }
    return writeBehavior ? writeBehavior() : true;
  };
  m.end = () => {
    m.ended = true;
    m.writableEnded = true;
    ee.emit('finish');
  };
  return ee as unknown as Response & { chunks: string[]; ended: boolean };
}

describe('SseStream', () => {
  afterEach(() => vi.useRealTimers());

  it('open() writes the retry hint; send() writes a data: frame', async () => {
    const res = mockRes();
    const s = new SseStream(res);
    s.open();
    await s.send({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    const joined = (res as unknown as { chunks: string[] }).chunks.join('');
    expect(joined).toContain('retry: 3000');
    expect(joined).toContain(
      'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',
    );
  });

  it('send(message, id) prepends an `id:` line before `data:` (resume cursor)', async () => {
    const res = mockRes();
    const s = new SseStream(res);
    s.open();
    await s.send({ jsonrpc: '2.0', method: 'session/update', params: {} }, 7);
    const joined = (res as unknown as { chunks: string[] }).chunks.join('');
    expect(joined).toContain(
      'id: 7\ndata: {"jsonrpc":"2.0","method":"session/update","params":{}}\n\n',
    );
  });

  it('send(message) without an id omits the `id:` line (synthetic/response frames)', async () => {
    const res = mockRes();
    const s = new SseStream(res);
    s.open();
    await s.send({ jsonrpc: '2.0', id: 1, result: {} });
    const joined = (res as unknown as { chunks: string[] }).chunks.join('');
    expect(joined).toContain('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
    expect(joined).not.toMatch(/(^|\n)id: /);
  });

  it('send(message, 0) emits `id: 0` (id 0 is a real cursor, not "absent")', async () => {
    const res = mockRes();
    const s = new SseStream(res);
    s.open();
    await s.send({ ping: true }, 0);
    const joined = (res as unknown as { chunks: string[] }).chunks.join('');
    expect(joined).toContain('id: 0\ndata: {"ping":true}\n\n');
  });

  it('close() ends the response once and is idempotent', () => {
    const res = mockRes();
    const s = new SseStream(res);
    s.open();
    s.close();
    expect((res as unknown as { ended: boolean }).ended).toBe(true);
    expect(s.isClosed).toBe(true);
    s.close(); // no throw on double close
  });

  it('close() swallows a throwing onClose callback', () => {
    const res = mockRes();
    const s = new SseStream(res, () => {
      throw new Error('onClose boom');
    });
    s.open();
    expect(() => s.close()).not.toThrow();
    expect(s.isClosed).toBe(true);
  });

  it('a write failure closes the stream and fires onClose', async () => {
    let closed = false;
    const res = mockRes(() => {
      throw new Error('EPIPE');
    });
    const s = new SseStream(res, () => {
      closed = true;
    });
    s.open(); // retry write throws → chain catch closes
    await new Promise((r) => setTimeout(r, 10));
    expect(s.isClosed).toBe(true);
    expect(closed).toBe(true);
  });

  it('heartbeat fires onHeartbeat on the interval', () => {
    vi.useFakeTimers();
    let beats = 0;
    const res = mockRes();
    const s = new SseStream(res, undefined, () => {
      beats++;
    });
    s.open();
    vi.advanceTimersByTime(15_000);
    expect(beats).toBe(1);
    vi.advanceTimersByTime(15_000);
    expect(beats).toBe(2);
    s.close();
  });

  it('a req "close" event auto-closes the stream and fires onClose', () => {
    let closed = false;
    const res = mockRes();
    const s = new SseStream(res, () => {
      closed = true;
    });
    s.open();
    (res as unknown as { req: EventEmitter }).req.emit('close');
    expect(s.isClosed).toBe(true);
    expect(closed).toBe(true);
  });

  it('a res "error" event auto-closes the stream', () => {
    const res = mockRes();
    const s = new SseStream(res);
    s.open();
    (res as unknown as EventEmitter).emit('error', new Error('ECONNRESET'));
    expect(s.isClosed).toBe(true);
  });

  it('doWrite resolves after drain when write() returns false (backpressure)', async () => {
    let backpressured = true;
    const res = mockRes(() => !backpressured); // false first → drain needed
    const s = new SseStream(res);
    s.open();
    const p = s.send({ id: 2 });
    let settled = false;
    void p.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false); // still awaiting drain
    backpressured = false;
    (res as unknown as EventEmitter).emit('drain');
    await p;
    expect(settled).toBe(true);
  });

  it('waits for every write callback before reporting local delivery', async () => {
    const callbacks: WriteCallback[] = [];
    const res = mockRes(undefined, callbacks);
    const s = new SseStream(res);
    const delivery = s.sendSerialized(Buffer.from('{"ok":true}'));
    let settled = false;
    void delivery.then(() => {
      settled = true;
    });

    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      expect(settled).toBe(false);
      callbacks.shift()?.();
    }

    await expect(delivery).resolves.toBe('delivered');
    expect(settled).toBe(true);
  });

  it('reports a write callback error as failed delivery', async () => {
    const callbacks: WriteCallback[] = [];
    const res = mockRes(undefined, callbacks);
    const s = new SseStream(res);
    const delivery = s.sendSerialized(Buffer.from('{"ok":true}'));

    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    callbacks.shift()?.(new Error('EPIPE'));

    await expect(delivery).resolves.toBe('failed');
    await vi.waitFor(() => expect(s.isClosed).toBe(true));
  });

  it('does not retain drain listeners after a synchronous callback error', async () => {
    const res = mockRes(() => false);
    const writable = res as unknown as {
      write: (chunk: string | Buffer, callback?: WriteCallback) => boolean;
    };
    writable.write = (_chunk, callback) => {
      callback?.(new Error('EPIPE'));
      return false;
    };
    const s = new SseStream(res);

    await expect(s.sendSerialized(Buffer.from('{"ok":true}'))).resolves.toBe(
      'failed',
    );
    expect((res as unknown as EventEmitter).listenerCount('drain')).toBe(0);
  });

  it('settles an active write as closed before its callback arrives', async () => {
    const callbacks: WriteCallback[] = [];
    const res = mockRes(undefined, callbacks);
    const s = new SseStream(res);
    const delivery = s.sendSerialized(Buffer.from('{"ok":true}'));

    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    s.close();
    await expect(delivery).resolves.toBe('closed');

    callbacks.shift()?.();
    expect(s.isClosed).toBe(true);
  });

  it('reports an accepted complete frame as outcome unknown on close', async () => {
    const callbacks: WriteCallback[] = [];
    const res = mockRes(undefined, callbacks);
    const s = new SseStream(res);
    const delivery = s.sendSerialized(Buffer.from('{"ok":true}'));

    for (let index = 0; index < 2; index++) {
      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      callbacks.shift()?.();
    }
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    expect((res as unknown as { chunks: string[] }).chunks.join('')).toBe(
      'data: {"ok":true}\n\n',
    );

    (res as unknown as EventEmitter).emit('close');
    await expect(delivery).resolves.toBe('outcome_unknown');
    callbacks.shift()?.();
  });

  it('reports an incomplete accepted frame as closed', async () => {
    const callbacks: WriteCallback[] = [];
    const res = mockRes(undefined, callbacks);
    const s = new SseStream(res);
    const delivery = s.sendSerialized(Buffer.from('{"ok":true}'));

    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    (res as unknown as EventEmitter).emit('close');

    await expect(delivery).resolves.toBe('closed');
    callbacks.shift()?.();
  });
});
