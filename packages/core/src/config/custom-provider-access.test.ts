/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomProviderAccess } from './custom-provider-access.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('CustomProviderAccess', () => {
  afterEach(() => vi.useRealTimers());

  it('shares a check while cancellation only stops the corresponding waiter', async () => {
    const result = deferred<boolean>();
    const check = vi.fn(() => result.promise);
    const access = new CustomProviderAccess({
      getIdentity: () => 'account-a',
      isEnabled: () => true,
      check,
    });
    const controller = new AbortController();
    const cancelled = access.waitUntilReady({
      identity: 'account-a',
      signal: controller.signal,
    });
    const cancelledAssertion = (async () => {
      await expect(cancelled).rejects.toThrow('cancel this request');
    })();
    const remaining = access.waitUntilReady({ identity: 'account-a' });
    controller.abort(new Error('cancel this request'));
    await cancelledAssertion;
    expect(check).toHaveBeenCalledTimes(1);
    expect(access.state).toBe('checking');
    result.resolve(true);
    await remaining;
    expect(access.state).toBe('allowed');
  });

  it('waits through a same-account recheck and rejects sends until it completes', async () => {
    const result = deferred<boolean>();
    const check = vi
      .fn<() => Promise<boolean | null>>()
      .mockResolvedValueOnce(true)
      .mockReturnValueOnce(result.promise);
    const access = new CustomProviderAccess({
      getIdentity: () => 'a',
      isEnabled: () => true,
      check,
    });
    await access.waitUntilReady({ identity: 'a' });
    access.invalidate();
    const pending = access.waitUntilReady({ identity: 'a' });
    expect(() => access.assertReady('a')).toThrow(
      'verify Custom Provider access',
    );
    result.resolve(true);
    await pending;
    expect(() => access.assertReady('a')).not.toThrow();
  });

  it('rejects the old owner immediately and ignores its late response', async () => {
    let identity = 'a';
    const oldResult = deferred<boolean>();
    const newResult = deferred<boolean>();
    const check = vi
      .fn<() => Promise<boolean | null>>()
      .mockReturnValueOnce(oldResult.promise)
      .mockReturnValueOnce(newResult.promise);
    const access = new CustomProviderAccess({
      getIdentity: () => identity,
      isEnabled: () => true,
      check,
    });
    const previous = access.waitUntilReady({ identity: 'a' });
    const previousAssertion = (async () => {
      await expect(previous).rejects.toMatchObject({
        reason: 'identity_changed',
      });
    })();
    await Promise.resolve();
    identity = 'b';
    access.invalidate();
    const current = access.waitUntilReady({ identity: 'b' });
    await previousAssertion;
    oldResult.resolve(true);
    await Promise.resolve();
    expect(access.state).toBe('checking');
    newResult.resolve(false);
    await expect(current).rejects.toMatchObject({ reason: 'denied' });
    expect(access.state).toBe('denied');
  });

  it.each(['null', 'network error'] as const)(
    'keeps an unavailable check distinct from denial: %s',
    async (failure) => {
      const check = vi.fn<() => Promise<boolean | null>>();
      if (failure === 'null') check.mockResolvedValueOnce(null);
      else check.mockRejectedValueOnce(new Error('offline'));
      check.mockResolvedValueOnce(true);
      const access = new CustomProviderAccess({
        getIdentity: () => 'a',
        isEnabled: () => true,
        check,
      });
      await expect(
        access.waitUntilReady({ identity: 'a' }),
      ).rejects.toMatchObject({ reason: 'unavailable', status: 503 });
      expect(access.state).toBe('unavailable');
      await access.waitUntilReady({ identity: 'a' });
      expect(access.state).toBe('allowed');
    },
  );

  it('bounds each waiter without cancelling another waiter or restarting the check', async () => {
    vi.useFakeTimers();
    const result = deferred<boolean>();
    const check = vi.fn(() => result.promise);
    const access = new CustomProviderAccess({
      getIdentity: () => 'a',
      isEnabled: () => true,
      check,
    });
    const short = access.waitUntilReady({ identity: 'a', timeoutMs: 10 });
    const timedOut = (async () => {
      await expect(short).rejects.toMatchObject({ reason: 'timeout' });
    })();
    const long = access.waitUntilReady({ identity: 'a', timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(10);
    await timedOut;
    expect(check).toHaveBeenCalledTimes(1);
    result.resolve(true);
    await long;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['default', undefined, 30_000],
    ['explicit', 60_000, 60_000],
    ['longer than one timer', 2 ** 31, 2 ** 31],
  ] as const)(
    'honors the %s wait budget',
    async (_name, timeoutMs, duration) => {
      vi.useFakeTimers();
      const result = deferred<boolean>();
      const check = vi.fn(() => result.promise);
      const access = new CustomProviderAccess({
        getIdentity: () => 'a',
        isEnabled: () => true,
        check,
      });
      const settled = vi.fn();
      const waiting = access
        .waitUntilReady({ identity: 'a', timeoutMs })
        .then(settled, settled);
      await vi.advanceTimersByTimeAsync(duration - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(settled).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ reason: 'timeout', status: 503 }),
      );
      expect(check).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      result.resolve(true);
      await access.refresh();
      expect(access.state).toBe('allowed');
    },
  );

  it('rejects a late response after an identity change without an auth notification', async () => {
    let identity = 'a';
    const result = deferred<boolean>();
    const access = new CustomProviderAccess({
      getIdentity: () => identity,
      isEnabled: () => true,
      check: () => result.promise,
    });
    const waiting = access.waitUntilReady({ identity: 'a' });
    identity = 'b';
    result.resolve(true);
    await expect(waiting).rejects.toMatchObject({ reason: 'identity_changed' });
    expect(access.state).toBe('uninitialized');
  });

  it.each([0, -1, NaN, Infinity, -Infinity])(
    'does not begin an access check for an invalid budget (%s)',
    async (timeoutMs) => {
      vi.useFakeTimers();
      const check = vi.fn().mockResolvedValue(true);
      const access = new CustomProviderAccess({
        getIdentity: () => 'a',
        isEnabled: () => true,
        check,
      });
      await expect(
        access.waitUntilReady({ identity: 'a', timeoutMs }),
      ).rejects.toMatchObject({ reason: 'timeout' });
      expect(check).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not check or send after access is disabled', async () => {
    let enabled = true;
    const check = vi.fn().mockResolvedValue(true);
    const access = new CustomProviderAccess({
      getIdentity: () => 'a',
      isEnabled: () => enabled,
      check,
    });
    await access.waitUntilReady({ identity: 'a' });
    enabled = false;
    access.invalidate();
    await expect(
      access.waitUntilReady({ identity: 'a' }),
    ).rejects.toMatchObject({ reason: 'denied' });
    expect(() => access.assertReady('a')).toThrow('not allowed');
    expect(check).toHaveBeenCalledTimes(1);
  });
});
