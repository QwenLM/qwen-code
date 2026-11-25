/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactLibraryStream } from './artifact-library-stream.js';

function response() {
  const events = new EventEmitter();
  return Object.assign(events, {
    destroyed: false,
    status: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    flushHeaders: vi.fn(),
    flush: vi.fn(),
    write: vi.fn((_chunk: string) => true),
    end: vi.fn(),
  });
}

afterEach(() => vi.useRealTimers());

describe('artifact library stream', () => {
  it('serializes backpressured frames and skips queued heartbeats', async () => {
    vi.useFakeTimers();
    const res = response();
    res.write.mockReturnValueOnce(false);
    const stream = new ArtifactLibraryStream(res as unknown as Response);
    const first = stream.send('session', { sessionId: 'one' });
    const second = stream.send('session', { sessionId: 'two' });
    try {
      await vi.advanceTimersByTimeAsync(45_000);
      expect(res.write).toHaveBeenCalledTimes(1);
      res.emit('drain');
      await Promise.all([first, second]);
      expect(res.write.mock.calls.map(([chunk]) => chunk)).toEqual([
        'event: session\ndata: {"v":1,"sessionId":"one"}\n\n',
        'event: session\ndata: {"v":1,"sessionId":"two"}\n\n',
      ]);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(res.write).toHaveBeenLastCalledWith(': heartbeat\n\n');
      expect(res.listenerCount('drain')).toBe(0);
      expect(res.listenerCount('error')).toBe(0);
    } finally {
      stream.end();
    }
    await vi.advanceTimersByTimeAsync(30_000);
    expect(res.write).toHaveBeenCalledTimes(3);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('rejects pending writes on disconnect and stops heartbeats', async () => {
    vi.useFakeTimers();
    const res = response();
    res.write.mockReturnValue(false);
    const stream = new ArtifactLibraryStream(res as unknown as Response);
    const pending = stream.send('session', { sessionId: 'one' });
    const rejected = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    res.destroyed = true;
    res.emit('close');
    expect(await rejected).toMatchObject({
      message: 'Generation SSE connection closed',
    });
    expect(stream.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(res.write).toHaveBeenCalledTimes(1);
    stream.end();
    expect(res.end).not.toHaveBeenCalled();
    expect(res.listenerCount('close')).toBe(0);
  });
});
