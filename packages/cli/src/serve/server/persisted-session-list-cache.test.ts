/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PersistedSessionListCache,
  type PersistedSessionListScope,
  type PersistedSessionListSnapshot,
} from './persisted-session-list-cache.js';

const SCOPE: PersistedSessionListScope = {
  runtimeBaseDir: '/runtime/one',
  workspaceCwd: '/workspace/one',
  archiveState: 'active',
};

function snapshot(count = 1): PersistedSessionListSnapshot {
  return {
    sessions: Array.from({ length: count }, (_, index) => ({
      sessionId: `session-${index}`,
      workspaceCwd: SCOPE.workspaceCwd,
      createdAt: '2026-08-10T00:00:00.000Z',
      clientCount: 0,
      hasActivePrompt: false,
    })),
    truncated: false,
    scanPages: 1,
    scanDurationMs: 10,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PersistedSessionListCache', () => {
  it('single-flights concurrent loads for the same scope', async () => {
    const cache = new PersistedSessionListCache(2_000, 50_000);
    const load = deferred<PersistedSessionListSnapshot>();
    const loader = vi.fn(() => load.promise);
    const lookups = Array.from({ length: 5 }, () =>
      cache.lookup(SCOPE, loader),
    );

    expect(lookups.map((lookup) => lookup.status)).toEqual([
      'scan',
      'single_flight',
      'single_flight',
      'single_flight',
      'single_flight',
    ]);
    for (const lookup of lookups.slice(1)) {
      expect(lookup.promise).toBe(lookups[0]!.promise);
    }
    expect(loader).not.toHaveBeenCalled();
    load.resolve(snapshot());
    await expect(
      Promise.all(lookups.map((lookup) => lookup.promise)),
    ).resolves.toHaveLength(5);
    expect(loader).toHaveBeenCalledTimes(1);
    cache.clear();
  });

  it('does not retain loader failures', async () => {
    const cache = new PersistedSessionListCache(2_000, 50_000);
    const error = new Error('scan failed');
    const loader = vi
      .fn<() => Promise<PersistedSessionListSnapshot>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(snapshot());
    const first = cache.lookup(SCOPE, loader);
    const joined = cache.lookup(SCOPE, loader);

    const results = await Promise.allSettled([first.promise, joined.promise]);
    expect(results).toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error },
    ]);
    const retry = cache.lookup(SCOPE, loader);
    expect(retry.status).toBe('scan');
    await retry.promise;
    expect(loader).toHaveBeenCalledTimes(2);
    cache.clear();
  });

  it('uses a non-sliding TTL measured from load completion', async () => {
    vi.useFakeTimers();
    const cache = new PersistedSessionListCache(2_000, 50_000);
    const loader = vi.fn(async () => snapshot());
    await cache.lookup(SCOPE, loader).promise;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(cache.lookup(SCOPE, loader)).toMatchObject({
      status: 'cache_hit',
      cacheAgeMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(cache.lookup(SCOPE, loader).status).toBe('scan');
    cache.clear();
  });

  it('rejects an installed value when its read-path age reaches the TTL', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const cache = new PersistedSessionListCache(2_000, 50_000);
    await cache.lookup(SCOPE, async () => snapshot()).promise;

    now.mockReturnValue(3_000);
    const reload = deferred<PersistedSessionListSnapshot>();
    const lookup = cache.lookup(SCOPE, () => reload.promise);
    expect(lookup.status).toBe('scan');

    reload.resolve(snapshot());
    await lookup.promise;
    cache.clear();
  });

  it('isolates archive state, runtime root, and workspace', async () => {
    const cache = new PersistedSessionListCache(2_000, 50_000);
    const loader = vi.fn(async () => snapshot());
    const scopes: PersistedSessionListScope[] = [
      SCOPE,
      { ...SCOPE, archiveState: 'archived' },
      { ...SCOPE, runtimeBaseDir: '/runtime/two' },
      { ...SCOPE, workspaceCwd: '/workspace/two' },
    ];

    await Promise.all(
      scopes.map((scope) => cache.lookup(scope, loader).promise),
    );
    expect(loader).toHaveBeenCalledTimes(4);
    cache.clear();
  });

  it('does not let an invalidated load install or clear a newer load', async () => {
    const cache = new PersistedSessionListCache(2_000, 50_000);
    const oldLoad = deferred<PersistedSessionListSnapshot>();
    const newLoad = deferred<PersistedSessionListSnapshot>();
    const loader = vi
      .fn<() => Promise<PersistedSessionListSnapshot>>()
      .mockImplementationOnce(() => oldLoad.promise)
      .mockImplementationOnce(() => newLoad.promise);

    const oldLookup = cache.lookup(SCOPE, loader);
    cache.invalidate(SCOPE);
    const newLookup = cache.lookup(SCOPE, loader);
    expect(newLookup.status).toBe('scan');
    oldLoad.resolve(snapshot(1));
    await oldLookup.promise;

    expect(cache.lookup(SCOPE, loader).status).toBe('single_flight');
    newLoad.resolve(snapshot(2));
    await newLookup.promise;
    expect(cache.lookup(SCOPE, loader).status).toBe('cache_hit');
    expect(loader).toHaveBeenCalledTimes(2);
    cache.clear();
  });

  it('does not let an old rejection clear a newer load', async () => {
    const cache = new PersistedSessionListCache(2_000, 50_000);
    const oldLoad = deferred<PersistedSessionListSnapshot>();
    const newLoad = deferred<PersistedSessionListSnapshot>();
    const loader = vi
      .fn<() => Promise<PersistedSessionListSnapshot>>()
      .mockImplementationOnce(() => oldLoad.promise)
      .mockImplementationOnce(() => newLoad.promise);

    const oldLookup = cache.lookup(SCOPE, loader);
    cache.invalidate(SCOPE);
    const newLookup = cache.lookup(SCOPE, loader);
    expect(newLookup.status).toBe('scan');
    oldLoad.reject(new Error('old failure'));
    await expect(oldLookup.promise).rejects.toThrow('old failure');
    expect(cache.lookup(SCOPE, loader).status).toBe('single_flight');
    newLoad.resolve(snapshot());
    await newLookup.promise;
    cache.clear();
  });

  it('evicts the oldest retained snapshot to honor the global cap', async () => {
    vi.useFakeTimers();
    const cache = new PersistedSessionListCache(10_000, 2);
    const firstLoader = vi.fn(async () => snapshot(2));
    const secondLoader = vi.fn(async () => snapshot(1));
    await cache.lookup(SCOPE, firstLoader).promise;
    await vi.advanceTimersByTimeAsync(1);
    const secondScope = { ...SCOPE, workspaceCwd: '/workspace/two' };
    await cache.lookup(secondScope, secondLoader).promise;

    const reload = deferred<PersistedSessionListSnapshot>();
    const evictedLookup = cache.lookup(SCOPE, () => reload.promise);
    expect(evictedLookup.status).toBe('scan');
    expect(cache.lookup(secondScope, secondLoader).status).toBe('cache_hit');
    cache.clear();
    reload.resolve(snapshot(2));
    await evictedLookup.promise;
  });

  it('reclaims retained-summary capacity when evicting a snapshot', async () => {
    vi.useFakeTimers();
    const cache = new PersistedSessionListCache(10_000, 3);
    const firstScope = { ...SCOPE, workspaceCwd: '/workspace/first' };
    const secondScope = { ...SCOPE, workspaceCwd: '/workspace/second' };
    const thirdScope = { ...SCOPE, workspaceCwd: '/workspace/third' };

    await cache.lookup(firstScope, async () => snapshot(2)).promise;
    await vi.advanceTimersByTimeAsync(1);
    await cache.lookup(secondScope, async () => snapshot(2)).promise;
    await cache.lookup(thirdScope, async () => snapshot(1)).promise;

    expect(cache.lookup(secondScope, async () => snapshot(2)).status).toBe(
      'cache_hit',
    );
    expect(cache.lookup(thirdScope, async () => snapshot(1)).status).toBe(
      'cache_hit',
    );
    cache.clear();
  });

  it('serves but does not retain a snapshot larger than the cap', async () => {
    const cache = new PersistedSessionListCache(2_000, 1);
    const loader = vi.fn(async () => snapshot(2));
    await expect(cache.lookup(SCOPE, loader).promise).resolves.toMatchObject({
      sessions: expect.any(Array),
    });
    expect(cache.lookup(SCOPE, loader).status).toBe('scan');
    cache.clear();
  });

  it('unrefs expiry timers and clears retained values', async () => {
    const cache = new PersistedSessionListCache(10_000, 50_000);
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    await cache.lookup(SCOPE, async () => snapshot()).promise;
    const timer = timerSpy.mock.results.at(-1)?.value as
      | ReturnType<typeof setTimeout>
      | undefined;
    expect(timer?.hasRef()).toBe(false);

    cache.clear();
    const retry = cache.lookup(SCOPE, async () => snapshot());
    expect(retry.status).toBe('scan');
    await retry.promise;
    cache.clear();
  });
});
