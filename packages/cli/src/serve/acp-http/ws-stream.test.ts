/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { WsStream } from './ws-stream.js';

// Minimal WebSocket mock that implements the surface WsStream uses.
class MockWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1; // OPEN
  sent: string[] = [];
  pinged = 0;
  closed = false;
  closeCode?: number;

  send(data: string, cb?: (err?: Error) => void) {
    this.sent.push(data);
    cb?.();
  }

  ping() {
    this.pinged++;
  }

  close(code?: number) {
    this.closed = true;
    this.closeCode = code;
  }
}

describe('WsStream', () => {
  let ws: MockWebSocket;

  beforeEach(() => {
    ws = new MockWebSocket();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('send() serializes message as JSON and delivers via ws.send', async () => {
    const stream = new WsStream(ws as never);
    await stream.send({ hello: 'world' });
    expect(ws.sent).toEqual(['{"hello":"world"}']);
    stream.close();
  });

  it('send() serializes writes sequentially (no interleaving)', async () => {
    const stream = new WsStream(ws as never);
    const p1 = stream.send({ seq: 1 });
    const p2 = stream.send({ seq: 2 });
    await Promise.all([p1, p2]);
    expect(ws.sent).toEqual(['{"seq":1}', '{"seq":2}']);
    stream.close();
  });

  it('send() resolves even after close (no hang)', async () => {
    const stream = new WsStream(ws as never);
    stream.close();
    // Should not hang or throw
    await stream.send({ after: 'close' });
    // Message not delivered (closed)
    expect(ws.sent).toEqual([]);
  });

  it('isClosed starts false, becomes true after close()', () => {
    const stream = new WsStream(ws as never);
    expect(stream.isClosed).toBe(false);
    stream.close();
    expect(stream.isClosed).toBe(true);
  });

  it('close() is idempotent', () => {
    const onClose = vi.fn();
    const stream = new WsStream(ws as never, onClose);
    stream.close();
    stream.close();
    stream.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ws.closeCode).toBe(1000);
  });

  it('close() calls onClose callback', () => {
    const onClose = vi.fn();
    const stream = new WsStream(ws as never, onClose);
    stream.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close() does not call ws.close if not OPEN', () => {
    ws.readyState = 3; // CLOSED
    const stream = new WsStream(ws as never);
    stream.close();
    expect(ws.closed).toBe(false);
  });

  it('ws "close" event triggers stream close', () => {
    const onClose = vi.fn();
    void new WsStream(ws as never, onClose);
    ws.emit('close');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ws "error" event triggers stream close', () => {
    const onClose = vi.fn();
    void new WsStream(ws as never, onClose);
    ws.emit('error', new Error('test error'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('heartbeat sends ping every 15s and calls onHeartbeat', () => {
    const onHeartbeat = vi.fn();
    const _stream = new WsStream(ws as never, undefined, onHeartbeat);
    expect(ws.pinged).toBe(0);
    vi.advanceTimersByTime(15_000);
    expect(ws.pinged).toBe(1);
    expect(onHeartbeat).toHaveBeenCalledTimes(1);
    // Simulate pong to keep alive for next tick
    ws.emit('pong');
    vi.advanceTimersByTime(15_000);
    expect(ws.pinged).toBe(2);
    _stream.close();
  });

  it('heartbeat stops after close', () => {
    const stream = new WsStream(ws as never);
    stream.close();
    vi.advanceTimersByTime(30_000);
    expect(ws.pinged).toBe(0);
  });

  it('dead connection detected via ping/pong (no pong → close)', () => {
    const onClose = vi.fn();
    void new WsStream(ws as never, onClose);

    // First tick: ping sent, alive flag set to false
    vi.advanceTimersByTime(15_000);
    expect(ws.pinged).toBe(1);

    // No pong received → second tick closes
    vi.advanceTimersByTime(15_000);
    expect(onClose).toHaveBeenCalled();
  });

  it('pong keeps connection alive', () => {
    const onClose = vi.fn();
    const _stream = new WsStream(ws as never, onClose);

    vi.advanceTimersByTime(15_000);
    expect(ws.pinged).toBe(1);

    // Simulate pong
    ws.emit('pong');

    vi.advanceTimersByTime(15_000);
    // Should NOT close — pong was received
    expect(onClose).not.toHaveBeenCalled();
    expect(ws.pinged).toBe(2);

    _stream.close();
  });

  it('send() failure closes stream', async () => {
    const onClose = vi.fn();
    ws.send = (_data: string, cb?: (err?: Error) => void) => {
      cb?.(new Error('write failed'));
    };
    const stream = new WsStream(ws as never, onClose);
    await stream.send({ fail: true });
    expect(onClose).toHaveBeenCalled();
    expect(stream.isClosed).toBe(true);
  });
});
