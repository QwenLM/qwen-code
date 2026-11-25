/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScriptWorkers, WorkerWaitTimeoutError } from './workers.js';
import { SCRIPT_LIMITS } from './types.js';

const state = vi.hoisted(() => ({
  workers: [] as Worker[],
  constructionError: undefined as Error | undefined,
}));

vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      ref = vi.fn(() => this);
      unref = vi.fn(() => this);
      // Deliberately never settles: capacity must follow exit, not this promise.
      terminate = vi.fn(() => {
        this.ref();
        return new Promise<number>(() => {});
      });

      constructor() {
        super();
        if (state.constructionError) throw state.constructionError;
        state.workers.push(this as unknown as Worker);
      }
    },
  };
});

const wasm = {} as WebAssembly.Module;
const signal = () => new AbortController().signal;

beforeEach(() => {
  vi.useFakeTimers();
  state.workers = [];
  state.constructionError = undefined;
});
afterEach(() => vi.useRealTimers());

describe('CodeMode worker capacity', () => {
  it('retains capacity after terminate resolves and admits FIFO only on exit', async () => {
    const workers = new ScriptWorkers('worker.js', { maxWorkers: 1 });
    const first = await workers.acquire(wasm, signal());
    const admitted: number[] = [];
    const second = workers.acquire(wasm, signal()).then((worker) => {
      admitted.push(2);
      return worker;
    });
    const third = workers.acquire(wasm, signal()).then((worker) => {
      admitted.push(3);
      return worker;
    });
    vi.mocked(first.terminate).mockResolvedValueOnce(0);
    workers.stop(first);
    workers.stop(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.terminate).toHaveBeenCalledTimes(1);
    expect(first.unref).toHaveBeenCalledTimes(1);
    expect(vi.mocked(first.unref).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(first.terminate).mock.invocationCallOrder[0],
    );
    expect(state.workers).toHaveLength(1);
    expect(admitted).toEqual([]);

    first.emit('exit', 0);
    const next = await second;
    expect(admitted).toEqual([2]);
    expect(state.workers).toHaveLength(2);
    workers.stop(next);
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted).toEqual([2]);
    // A pending terminate promise must not block admission once exit is observed.
    next.emit('exit', 0);
    await third;
    expect(admitted).toEqual([2, 3]);
  });

  it('removes cancelled and expired waiters without starting their workers', async () => {
    const workers = new ScriptWorkers('worker.js', { maxWorkers: 1 });
    const first = await workers.acquire(wasm, signal());
    const controller = new AbortController();
    const cancelled = workers.acquire(wasm, controller.signal).catch((error: unknown) => error);
    controller.abort('cancelled');
    expect(await cancelled).toBe('cancelled');

    const expired = workers.acquire(wasm, signal()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(SCRIPT_LIMITS.workerWaitMs);
    expect(await expired).toBeInstanceOf(WorkerWaitTimeoutError);
    const next = workers.acquire(wasm, signal());
    first.emit('exit', 0);
    await next;
    expect(state.workers).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start or prewarm workers for an already cancelled acquisition', async () => {
    const workers = new ScriptWorkers('worker.js', { prewarm: true });
    const controller = new AbortController();
    controller.abort('cancelled');
    await expect(workers.acquire(wasm, controller.signal)).rejects.toBe(
      'cancelled',
    );
    expect(state.workers).toHaveLength(0);
  });

  it('does not reserve capacity when the Worker constructor throws', async () => {
    const workers = new ScriptWorkers('worker.js', { maxWorkers: 1 });
    state.constructionError = new Error('cannot start worker');
    await expect(workers.acquire(wasm, signal())).rejects.toThrow(
      'cannot start worker',
    );
    state.constructionError = undefined;
    await workers.acquire(wasm, signal());
    expect(state.workers).toHaveLength(1);
  });

  it('keeps a worker counted when termination rejects', async () => {
    const workers = new ScriptWorkers('worker.js', { maxWorkers: 1 });
    const first = await workers.acquire(wasm, signal());
    vi.mocked(first.terminate).mockRejectedValueOnce(
      new Error('termination failed'),
    );
    workers.stop(first);
    const next = workers.acquire(wasm, signal());
    await vi.advanceTimersByTimeAsync(0);
    expect(first.unref).toHaveBeenCalledOnce();
    expect(state.workers).toHaveLength(1);
    first.emit('exit', 1);
    await next;
    expect(state.workers).toHaveLength(2);
  });

  it('bounds a concurrent burst with the default limit', async () => {
    const workers = new ScriptWorkers('worker.js');
    const pending = Array.from({ length: SCRIPT_LIMITS.workers + 3 }, () =>
      workers.acquire(wasm, signal()),
    );
    expect(state.workers).toHaveLength(SCRIPT_LIMITS.workers);
    for (let i = 0; i < 3; i++) {
      state.workers[i].emit('exit', 0);
      expect(state.workers).toHaveLength(SCRIPT_LIMITS.workers + i + 1);
    }
    await Promise.all(pending);
  });
});

describe('CodeMode prewarming under capacity limits', () => {
  it('counts the spare, hands it out once and serves waiters before replenishing it', async () => {
    const workers = new ScriptWorkers('worker.js', {
      maxWorkers: 2,
      prewarm: true,
    });
    const first = await workers.acquire(wasm, signal());
    const spare = state.workers[1];
    expect(state.workers).toHaveLength(2);
    expect(spare.unref).toHaveBeenCalledOnce();
    const second = await workers.acquire(wasm, signal());
    expect(second).toBe(spare);
    expect(second.ref).toHaveBeenCalledOnce();
    expect(state.workers).toHaveLength(2);
    const third = workers.acquire(wasm, signal());
    first.emit('exit', 0);
    expect(await third).toBe(state.workers[2]);
    expect(state.workers).toHaveLength(3);
    expect(state.workers[2].unref).not.toHaveBeenCalled();

    second.emit('exit', 0);
    expect(state.workers).toHaveLength(4);
    expect(state.workers[3].unref).toHaveBeenCalledOnce();
    state.workers[2].emit('exit', 0);
    // The existing spare is sufficient; no second idle worker is created.
    expect(state.workers).toHaveLength(4);
    expect(await workers.acquire(wasm, signal())).toBe(state.workers[3]);
  });

  it('keeps failed spares counted until exit and does not respawn them in a loop', async () => {
    const workers = new ScriptWorkers('worker.js', {
      maxWorkers: 1,
      prewarm: true,
    });
    const first = await workers.acquire(wasm, signal());
    first.emit('exit', 0);
    const spare = state.workers[1];
    spare.emit('message', { type: 'done', status: 'error' });
    expect(spare.terminate).toHaveBeenCalledOnce();
    expect(spare.unref).toHaveBeenCalledTimes(2);
    const next = workers.acquire(wasm, signal());
    expect(state.workers).toHaveLength(2);
    spare.emit('error', new Error('initialization failed'));
    expect(spare.terminate).toHaveBeenCalledOnce();
    spare.emit('exit', 1);
    const active = await next;
    expect(active).toBe(state.workers[2]);
    active.emit('exit', 0);
    state.workers[3].emit('error', new Error('initialization failed'));
    state.workers[3].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.workers).toHaveLength(4);
  });

  it('treats spare construction failure as optional and retries on demand', async () => {
    const workers = new ScriptWorkers('worker.js', {
      maxWorkers: 1,
      prewarm: true,
    });
    const first = await workers.acquire(wasm, signal());
    state.constructionError = new Error('cannot prewarm');
    first.emit('exit', 0);
    expect(state.workers).toHaveLength(1);
    state.constructionError = undefined;
    await workers.acquire(wasm, signal());
    expect(state.workers).toHaveLength(2);
  });
});
