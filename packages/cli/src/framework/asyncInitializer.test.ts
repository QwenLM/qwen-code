/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { AsyncInitializer } from './asyncInitializer.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('AsyncInitializer', () => {
  it('publishes creation before initialization and shares both results', async () => {
    const created = deferred<object>();
    const initialized = deferred<void>();
    const value = {};
    const init = vi.fn(() => initialized.promise);
    const resource = new AsyncInitializer({
      create: () => created.promise,
      init,
      dispose: () => {},
    });
    expect(resource.whenCreated()).toBe(resource.whenCreated());
    expect(init).not.toHaveBeenCalled();
    created.resolve(value);
    expect(await resource.whenCreated()).toBe(value);
    expect(init).toHaveBeenCalledExactlyOnceWith(
      value,
      expect.any(AbortSignal),
    );
    expect(() => resource.get()).toThrow('not yet initialized');
    expect(resource.isInitialized()).toBe(false);
    initialized.resolve();
    expect(await resource.whenReady()).toBe(value);
    expect(resource.get()).toBe(value);
    await resource.dispose();
  });

  it('releases a created object when initialization fails', async () => {
    const value = {};
    const failure = new Error('runtime initialization failed');
    const dispose = vi.fn();
    const resource = new AsyncInitializer({
      create: () => value,
      init: () => {
        throw failure;
      },
      dispose,
    });
    expect(await resource.whenCreated()).toBe(value);
    await expect(resource.whenReady()).rejects.toBe(failure);
    expect(() => resource.get()).toThrow('not yet initialized');
    await resource.dispose();
    await resource.dispose();
    expect(dispose).toHaveBeenCalledExactlyOnceWith(value);
  });

  it('cancels initialization and waits for it before releasing the object', async () => {
    const events: string[] = [];
    const resource = new AsyncInitializer({
      create: () => ({}),
      init: async (_value, signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        events.push('initialization ended');
        signal.throwIfAborted();
      },
      dispose: () => {
        events.push('disposed');
      },
    });
    await resource.whenCreated();
    const ready = resource.whenReady();
    await resource.dispose();
    await expect(ready).rejects.toMatchObject({ name: 'AbortError' });
    expect(events).toEqual(['initialization ended', 'disposed']);
    expect(() => resource.whenCreated()).toThrow('disposed');
  });

  it('starts immediately and shares the result with all waiters', async () => {
    const pending = deferred<object>();
    const create = vi.fn(() => pending.promise);
    const resource = new AsyncInitializer({ create, dispose: vi.fn() });
    expect(create).toHaveBeenCalledTimes(1);
    expect(() => resource.get()).toThrow('not yet initialized');
    expect(resource.whenReady()).toBe(resource.whenReady());
    const value = {};
    pending.resolve(value);
    expect(await resource.whenReady()).toBe(value);
    expect(resource.get()).toBe(value);
  });

  it('reclaims a late result after shutdown and blocks new consumers', async () => {
    const pending = deferred<object>();
    const cleanup = deferred<void>();
    const dispose = vi.fn(() => cleanup.promise);
    const resource = new AsyncInitializer({
      create: () => pending.promise,
      dispose,
    });
    const closing = resource.dispose();
    expect(resource.dispose()).toBe(closing);
    expect(resource.whenDisposed()).toBe(closing);
    expect(() => resource.whenReady()).toThrow('disposed');
    expect(() => resource.get()).toThrow('disposed');
    expect(dispose).not.toHaveBeenCalled();
    const value = {};
    pending.resolve(value);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledWith(value));
    let finished = false;
    void closing.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    cleanup.resolve();
    await closing;
    expect(resource.isInitialized()).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not start initialization when creation finishes after disposal', async () => {
    const pending = deferred<object>();
    const init = vi.fn();
    const dispose = vi.fn();
    const resource = new AsyncInitializer({
      create: () => pending.promise,
      init,
      dispose,
    });
    const ready = resource.whenReady();
    const closing = resource.dispose();
    const value = {};
    pending.resolve(value);
    await closing;
    await expect(ready).rejects.toMatchObject({ name: 'AbortError' });
    expect(init).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledExactlyOnceWith(value);
  });

  it('preserves synchronous creation errors for later waiters', async () => {
    const failure = new Error('initialization failed');
    const dispose = vi.fn();
    const resource = new AsyncInitializer({
      create: () => {
        throw failure;
      },
      dispose,
    });
    await expect(resource.whenReady()).rejects.toBe(failure);
    await resource.dispose();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('preserves cleanup failures and does not repeat failed cleanup', async () => {
    const failure = new Error('cleanup failed');
    const dispose = vi.fn(() => {
      throw failure;
    });
    const resource = new AsyncInitializer({ create: () => ({}), dispose });
    await resource.whenReady();
    const closing = resource.dispose();
    await expect(closing).rejects.toBe(failure);
    expect(resource.dispose()).toBe(closing);
    await expect(resource.whenDisposed()).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(resource.isInitialized()).toBe(false);
  });

  it('supports a successful undefined result without using it as a state sentinel', async () => {
    const dispose = vi.fn();
    const resource = new AsyncInitializer({ create: () => undefined, dispose });
    await resource.whenReady();
    expect(resource.isInitialized()).toBe(true);
    expect(resource.get()).toBeUndefined();
    await resource.dispose();
    expect(dispose).toHaveBeenCalledWith(undefined);
  });

  it('publishes the same close promise before invoking a reentrant cleanup', async () => {
    let reentrant: Promise<void> | undefined;
    const resource = new AsyncInitializer({
      create: () => ({}),
      dispose: () => {
        reentrant = resource.dispose();
      },
    });
    await resource.whenReady();
    const closing = resource.dispose();
    await closing;
    expect(reentrant).toBe(closing);
  });
});
