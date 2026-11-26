/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChokidarBackendPool } from './chokidarBackend.js';
import { FileSystemWatcher } from './fileWatcher.js';

const mocks = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock('chokidar', () => ({ watch: mocks.watch }));

// Some assertions are captured without `await` on purpose: the handler must
// attach before fake timers advance, so the rejection is never unhandled. The
// captured promise is awaited further down in each of those cases.
afterEach(() => vi.useRealTimers());

function createPool() {
  const backend = Object.assign(new EventEmitter(), {
    add: vi.fn(), close: vi.fn(async () => {}), unwatch: vi.fn(),
  });
  mocks.watch.mockReturnValue(backend);
  const onError = vi.fn();
  const pool = new ChokidarBackendPool({ onError }, vi.fn(), () => false);
  pool.start();
  pool.retain(process.cwd(), false, 2);
  return { pool, backend, onError };
}

describe('Chokidar startup lifecycle', () => {
  it('rejects at 5 seconds, reports watched paths and closes only once', async () => {
    vi.useFakeTimers();
    const { pool, backend, onError } = createPool();
    const result = pool.ready().catch((error) => error);
    const done = vi.fn();
    void result.then(done);
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const error = await result;
    expect(error).toMatchObject({ code: 'ETIMEDOUT', paths: [process.cwd()] });
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(backend.close).toHaveBeenCalledTimes(1);
    backend.emit('ready');
    await expect(pool.ready()).rejects.toBe(error);
    await pool.stop();
    expect(backend.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not reset the first-ready deadline for file events or recoverable errors', async () => {
    vi.useFakeTimers();
    const { pool, backend } = createPool();
    // oxlint-disable-next-line vitest/valid-expect
    const pending = expect(pool.ready()).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await vi.advanceTimersByTimeAsync(4000);
    backend.emit('add', 'new-file');
    backend.emit('error', Object.assign(new Error('skip entry'), { code: 'ELOOP' }));
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    await pool.stop();
  });

  it('clears the deadline after success and keeps reporting runtime errors', async () => {
    vi.useFakeTimers();
    const { pool, backend, onError } = createPool();
    backend.emit('ready');
    const pending = pool.ready();
    await vi.advanceTimersByTimeAsync(10000);
    await pending;
    expect(onError).not.toHaveBeenCalled();
    expect(backend.close).not.toHaveBeenCalled();
    const error = new Error('runtime failure');
    backend.emit('error', error);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    await pool.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the deadline on stop without reporting a timeout', async () => {
    vi.useFakeTimers();
    const { pool, onError } = createPool();
    // oxlint-disable-next-line vitest/valid-expect
    const pending = expect(pool.ready()).rejects.toThrow('Watcher stopped before ready');
    await pool.stop();
    await pending;
    await vi.advanceTimersByTimeAsync(10000);
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects startup at the deadline even if close never finishes', async () => {
    vi.useFakeTimers();
    const { pool, backend } = createPool();
    backend.close.mockImplementation(() => new Promise(() => {}));
    // oxlint-disable-next-line vitest/valid-expect
    const pending = expect(pool.ready()).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    const stopped = pool.stop();
    await vi.advanceTimersByTimeAsync(2000);
    await stopped;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('remembers ready emitted before the caller waits, including repeated waits', async () => {
    vi.useFakeTimers();
    const { pool, backend } = createPool();
    try {
      backend.emit('ready');
      for (let i = 0; i < 2; i++) {
        // oxlint-disable-next-line vitest/valid-expect
        const result = expect(pool.ready()).resolves.toBeUndefined();
        await vi.runAllTimersAsync();
        await result;
      }
    } finally { await pool.stop(); }
  });

  it('rejects startup on a fatal error even if it precedes ready()', async () => {
    const { pool, backend, onError } = createPool();
    const error = Object.assign(new Error('watch limit'), { code: 'EMFILE' });
    try {
      backend.emit('error', error);
      await expect(pool.ready()).rejects.toBe(error);
      expect(onError).toHaveBeenCalledWith(error);
      expect(backend.close).toHaveBeenCalledTimes(1);
    } finally { await pool.stop(); }
  });

  it('keeps waiting after a recoverable warning and still catches a later fatal error', async () => {
    const { pool, backend } = createPool();
    const error = Object.assign(new Error('I/O error'), { code: 'EIO' });
    try {
      backend.emit('error', Object.assign(new Error('cycle'), { code: 'ELOOP' }));
      backend.emit('error', error);
      await expect(pool.ready()).rejects.toBe(error);
    } finally { await pool.stop(); }
  });

  it('settles pending startup when stopped', async () => {
    const { pool } = createPool();
    // oxlint-disable-next-line vitest/valid-expect
    const pending = expect(pool.ready()).rejects.toThrow('Watcher stopped before ready');
    await pool.stop();
    await pending;
  });

  it('does not allocate a backend for a missing anchor', async () => {
    mocks.watch.mockClear();
    const pool = new ChokidarBackendPool({}, vi.fn(), () => false);
    pool.start();
    pool.retain(`${process.cwd()}/nonexistent-watcher-anchor`, false);
    await pool.ready();
    expect(mocks.watch).not.toHaveBeenCalled();
    await pool.stop();
  });
});

it('closes sibling backends on startup failure and can start again', async () => {
  vi.useFakeTimers();
  const backends: Array<ReturnType<typeof createPool>['backend']> = [];
  mocks.watch.mockImplementation(() => {
    const backend = Object.assign(new EventEmitter(), {
      add: vi.fn(), close: vi.fn(async () => {}), unwatch: vi.fn(),
    });
    backends.push(backend);
    return backend;
  });
  const watcher = new FileSystemWatcher({ usePolling: true });
  watcher.watch({ path: process.cwd(), depth: 1 }, vi.fn());
  watcher.watch({ path: process.cwd(), depth: 2 }, vi.fn());
  try {
    const error = Object.assign(new Error('watch limit'), { code: 'EMFILE' });
    // oxlint-disable-next-line vitest/valid-expect
    const failed = expect(watcher.start()).rejects.toBe(error);
    expect(backends).toHaveLength(2);
    backends[0].emit('error', error);
    await failed;
    for (const backend of backends) expect(backend.close).toHaveBeenCalledTimes(1);
    const restarted = watcher.start();
    expect(backends).toHaveLength(4);
    backends[2].emit('ready');
    backends[3].emit('ready');
    await vi.advanceTimersByTimeAsync(100);
    await restarted;
  } finally { await watcher.stop(); }
  expect(vi.getTimerCount()).toBe(0);
});
