/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  type UiProviderTransactionContext,
  useUiProviderTransaction,
} from './use-ui-provider-transaction.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('useUiProviderTransaction', () => {
  it('runs one operation with a live context and returns its sentinel result', async () => {
    const { result } = renderHook(() => useUiProviderTransaction());
    let calls = 0;
    let context: UiProviderTransactionContext | undefined;

    const transaction = result.current.run(async (currentContext) => {
      calls += 1;
      context = currentContext;
      expect(currentContext.signal.aborted).toBe(false);
      expect(currentContext.canPublish()).toBe(true);
      expect(currentContext.ownsRollback()).toBe(true);
      return 'sentinel';
    });

    await expect(transaction).resolves.toBe('sentinel');
    expect(calls).toBe(1);
    expect(context).toBeDefined();
  });

  it('supersedes an active operation without releasing rollback ownership before settlement', async () => {
    const { result } = renderHook(() => useUiProviderTransaction());
    const firstStarted = createDeferred<void>();
    const firstSettled = createDeferred<string>();
    const secondStarted = createDeferred<UiProviderTransactionContext>();
    const secondSettled = createDeferred<string>();
    let firstContext: UiProviderTransactionContext | undefined;
    let secondCalls = 0;

    const first = result.current.run(async (context) => {
      firstContext = context;
      firstStarted.resolve(undefined);
      return firstSettled.promise;
    });
    await firstStarted.promise;

    const second = result.current.run(async (context) => {
      secondCalls += 1;
      secondStarted.resolve(context);
      return secondSettled.promise;
    });

    expect(firstContext!.signal.aborted).toBe(true);
    expect(firstContext!.canPublish()).toBe(false);
    expect(firstContext!.ownsRollback()).toBe(true);
    expect(secondCalls).toBe(0);

    firstSettled.resolve('first');
    await expect(first).resolves.toBe('first');

    expect(firstContext!.ownsRollback()).toBe(false);
    const secondContext = await secondStarted.promise;
    expect(secondContext.signal.aborted).toBe(false);
    expect(secondContext.canPublish()).toBe(true);
    expect(secondContext.ownsRollback()).toBe(true);
    secondSettled.resolve('second');
    await expect(second).resolves.toBe('second');
  });

  it('cancels the active operation while preserving a queued operation', async () => {
    const { result } = renderHook(() => useUiProviderTransaction());
    const firstStarted = createDeferred<void>();
    const firstSettled = createDeferred<string>();
    const secondStarted = createDeferred<UiProviderTransactionContext>();
    const secondSettled = createDeferred<string>();
    let firstContext: UiProviderTransactionContext | undefined;
    let secondCalls = 0;

    const first = result.current.run(async (context) => {
      firstContext = context;
      firstStarted.resolve(undefined);
      return firstSettled.promise;
    });
    await firstStarted.promise;

    const second = result.current.run(async (context) => {
      secondCalls += 1;
      secondStarted.resolve(context);
      return secondSettled.promise;
    });

    act(() => {
      result.current.cancelActive();
    });

    expect(firstContext!.signal.aborted).toBe(true);
    expect(firstContext!.canPublish()).toBe(false);
    expect(firstContext!.ownsRollback()).toBe(true);
    expect(secondCalls).toBe(0);

    firstSettled.resolve('first');
    await expect(first).resolves.toBe('first');

    expect(firstContext!.ownsRollback()).toBe(false);
    const secondContext = await secondStarted.promise;
    expect(secondContext.signal.aborted).toBe(false);
    expect(secondContext.canPublish()).toBe(true);
    expect(secondContext.ownsRollback()).toBe(true);
    secondSettled.resolve('second');
    await expect(second).resolves.toBe('second');
  });

  it('resolves a queued operation as undefined when a newer queued operation supersedes it', async () => {
    const { result } = renderHook(() => useUiProviderTransaction());
    const firstStarted = createDeferred<void>();
    const firstSettled = createDeferred<string>();
    const thirdStarted = createDeferred<UiProviderTransactionContext>();
    const thirdSettled = createDeferred<string>();
    let secondCalls = 0;

    const first = result.current.run(async () => {
      firstStarted.resolve(undefined);
      return firstSettled.promise;
    });
    await firstStarted.promise;

    const second = result.current.run(async () => {
      secondCalls += 1;
      return 'second';
    });
    const third = result.current.run(async (context) => {
      thirdStarted.resolve(context);
      return thirdSettled.promise;
    });

    firstSettled.resolve('first');
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBeUndefined();
    expect(secondCalls).toBe(0);

    const thirdContext = await thirdStarted.promise;
    expect(thirdContext.signal.aborted).toBe(false);
    expect(thirdContext.canPublish()).toBe(true);
    expect(thirdContext.ownsRollback()).toBe(true);
    thirdSettled.resolve('third');
    await expect(third).resolves.toBe('third');
  });

  it('starts a queued operation after the active operation rejects', async () => {
    const { result } = renderHook(() => useUiProviderTransaction());
    const firstStarted = createDeferred<void>();
    const firstSettled = createDeferred<string>();
    const secondStarted = createDeferred<UiProviderTransactionContext>();
    const secondSettled = createDeferred<string>();

    const first = result.current.run(async () => {
      firstStarted.resolve(undefined);
      return firstSettled.promise;
    });
    await firstStarted.promise;

    const second = result.current.run(async (context) => {
      secondStarted.resolve(context);
      return secondSettled.promise;
    });

    const failure = new Error('first transaction failed');
    firstSettled.reject(failure);

    await expect(first).rejects.toBe(failure);
    const secondContext = await secondStarted.promise;
    expect(secondContext.signal.aborted).toBe(false);
    expect(secondContext.canPublish()).toBe(true);
    expect(secondContext.ownsRollback()).toBe(true);
    secondSettled.resolve('second');
    await expect(second).resolves.toBe('second');
  });

  it('aborts active work and invalidates queued work when the coordinator unmounts', async () => {
    const { result, unmount } = renderHook(() => useUiProviderTransaction());
    const firstStarted = createDeferred<void>();
    const firstSettled = createDeferred<string>();
    let firstContext: UiProviderTransactionContext | undefined;
    let secondCalls = 0;

    const first = result.current.run(async (context) => {
      firstContext = context;
      firstStarted.resolve(undefined);
      return firstSettled.promise;
    });
    await firstStarted.promise;

    const second = result.current.run(async () => {
      secondCalls += 1;
      return 'second';
    });

    act(() => {
      unmount();
    });

    expect(firstContext!.signal.aborted).toBe(true);
    expect(firstContext!.canPublish()).toBe(false);
    expect(firstContext!.ownsRollback()).toBe(true);
    expect(secondCalls).toBe(0);

    firstSettled.resolve('first');
    await expect(first).resolves.toBe('first');

    expect(firstContext!.ownsRollback()).toBe(false);
    await expect(second).resolves.toBeUndefined();
    expect(secondCalls).toBe(0);
  });
});
