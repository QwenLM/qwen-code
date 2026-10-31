/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { waitForPendingMemoryTasks } from './memory-tasks.js';

function deferredMemory() {
  let resolve!: (value: number) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<number>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function trackedMemory(initial: Array<Promise<number>>) {
  let tasks = initial;
  return {
    getPendingMemoryTaskPromises: vi.fn(() => [...tasks]),
    removePendingMemoryTaskPromises: vi.fn(
      (completed: ReadonlyArray<Promise<number>>) => {
        tasks = tasks.filter((task) => !completed.includes(task));
      },
    ),
    append: (task: Promise<number>) => tasks.push(task),
  };
}

const flushPromises = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

describe('waitForPendingMemoryTasks', () => {
  it.each(['during wait', 'before entry'] as const)(
    'stops normally on the memory-only signal %s and retains unfinished tasks',
    async (when) => {
      const memory = deferredMemory();
      const client = trackedMemory([memory.promise]);
      const abort = new AbortController();
      const stop = new AbortController();
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      if (when === 'before entry') stop.abort();
      let outcome: unknown = 'pending';
      const run = waitForPendingMemoryTasks(
        client,
        abort.signal,
        stop.signal,
      ).then(
        () => {
          outcome = 'finished';
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      try {
        await flushPromises();
        if (when === 'during wait') {
          expect(outcome).toBe('pending');
          stop.abort();
          await flushPromises();
        }
        expect(outcome).toBe('finished');
        expect(abort.signal.aborted).toBe(false);
        expect(client.getPendingMemoryTaskPromises()).toEqual([memory.promise]);
        expect(getEventListeners(abort.signal, 'abort')).toEqual([]);
        expect(getEventListeners(stop.signal, 'abort')).toEqual([]);
        memory.reject(new Error('late memory rejection after EOF deadline'));
        await flushPromises();
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        abort.abort();
        memory.resolve(0);
        await run;
        process.off('unhandledRejection', unhandled);
      }
    },
  );

  it('removes only settled snapshot identities on the memory-only stop', async () => {
    const completed = deferredMemory();
    const failed = deferredMemory();
    const pending = deferredMemory();
    const appended = deferredMemory();
    const client = trackedMemory([
      completed.promise,
      failed.promise,
      pending.promise,
    ]);
    const abort = new AbortController();
    const stop = new AbortController();
    let finished = false;
    const run = waitForPendingMemoryTasks(
      client,
      abort.signal,
      stop.signal,
    ).then(
      () => {
        finished = true;
      },
      () => undefined,
    );
    try {
      client.append(appended.promise);
      completed.resolve(1);
      failed.reject(new Error('observed memory failure'));
      await flushPromises();
      stop.abort();
      await flushPromises();
      expect(finished).toBe(true);
      expect(client.removePendingMemoryTaskPromises).toHaveBeenCalledWith([
        completed.promise,
        failed.promise,
      ]);
      expect(client.getPendingMemoryTaskPromises()).toEqual([
        pending.promise,
        appended.promise,
      ]);
    } finally {
      abort.abort();
      pending.resolve(0);
      appended.resolve(0);
      await run;
    }
  });

  it.each(['already aborted', 'same turn'] as const)(
    'preserves the real abort reason when both signals are observed: %s',
    async (when) => {
      const memory = deferredMemory();
      const client = trackedMemory([memory.promise]);
      const abort = new AbortController();
      const stop = new AbortController();
      const reason = new Error('real turn cancellation');
      if (when === 'already aborted') {
        stop.abort();
        abort.abort(reason);
      }
      const run = waitForPendingMemoryTasks(client, abort.signal, stop.signal);
      const outcome = run.catch((error: unknown) => error);
      if (when === 'same turn') {
        stop.abort();
        abort.abort(reason);
      }
      expect(await outcome).toBe(reason);
      expect(client.getPendingMemoryTaskPromises()).toEqual([memory.promise]);
      expect(getEventListeners(abort.signal, 'abort')).toEqual([]);
      expect(getEventListeners(stop.signal, 'abort')).toEqual([]);
      memory.reject(new Error('late rejection after real abort'));
      await flushPromises();
    },
  );

  it('keeps the default wait pending until memory settles', async () => {
    const memory = deferredMemory();
    const client = trackedMemory([memory.promise]);
    const abort = new AbortController();
    let finished = false;
    const run = waitForPendingMemoryTasks(client, abort.signal).then(() => {
      finished = true;
    });
    try {
      await flushPromises();
      expect(finished).toBe(false);
      memory.resolve(1);
      await run;
      expect(client.getPendingMemoryTaskPromises()).toEqual([]);
      expect(getEventListeners(abort.signal, 'abort')).toEqual([]);
    } finally {
      memory.resolve(0);
      await run;
    }
  });

  it('removes both listeners after early settlement and adds none for an empty queue', async () => {
    const memory = deferredMemory();
    const client = trackedMemory([memory.promise]);
    const abort = new AbortController();
    const stop = new AbortController();
    const run = waitForPendingMemoryTasks(client, abort.signal, stop.signal);
    memory.resolve(1);
    await run;
    expect(getEventListeners(abort.signal, 'abort')).toEqual([]);
    expect(getEventListeners(stop.signal, 'abort')).toEqual([]);
    await waitForPendingMemoryTasks(client, abort.signal, stop.signal);
    expect(getEventListeners(abort.signal, 'abort')).toEqual([]);
    expect(getEventListeners(stop.signal, 'abort')).toEqual([]);
  });
});
