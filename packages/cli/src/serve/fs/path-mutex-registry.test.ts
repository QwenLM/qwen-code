/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { PathMutexRegistry } from './path-mutex-registry.js';

describe('PathMutexRegistry cancellation', () => {
  it('retires a cancelled waiter without letting later callers bypass the owner', async () => {
    const locks = new PathMutexRegistry();
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = locks.runExclusive('target', () => held);
    const cancelledWork = vi.fn();
    const cancelled = locks.runExclusive(
      'target',
      cancelledWork,
      controller.signal,
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const laterWork = vi.fn().mockResolvedValue('done');
    const later = locks.runExclusive('target', laterWork);
    await new Promise((resolve) => setImmediate(resolve));
    expect(laterWork).not.toHaveBeenCalled();
    expect(cancelledWork).not.toHaveBeenCalled();
    release();
    await first;
    await expect(later).resolves.toBe('done');
  });

  it('rejects an already aborted signal without calling the callback', async () => {
    const locks = new PathMutexRegistry();
    const callback = vi.fn();
    await expect(
      locks.runExclusive('target', callback, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(callback).not.toHaveBeenCalled();
    await expect(
      locks.runExclusive('target', async () => 'next'),
    ).resolves.toBe('next');
  });

  it('keeps ownership until running work settles after cancellation', async () => {
    const locks = new PathMutexRegistry();
    const controller = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = locks.runExclusive(
      'target',
      async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      controller.signal,
    );
    await ready;
    controller.abort();
    const nextWork = vi.fn().mockResolvedValue(undefined);
    const next = locks.runExclusive('target', nextWork);
    await new Promise((resolve) => setImmediate(resolve));
    expect(nextWork).not.toHaveBeenCalled();
    release();
    await Promise.all([first, next]);
    expect(nextWork).toHaveBeenCalledOnce();
  });

  it('releases after a failed owner and permits unrelated keys', async () => {
    const locks = new PathMutexRegistry();
    const error = new Error('failed');
    await expect(
      locks.runExclusive('target', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    await expect(locks.runExclusive('target', async () => 1)).resolves.toBe(1);
    await expect(locks.runExclusive('other', async () => 2)).resolves.toBe(2);
  });
});
