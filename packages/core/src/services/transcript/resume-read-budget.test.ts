/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginResumeRead,
  ResumeReadError,
  type ResumeReadAttempt,
  type ResumeReadLimits,
} from './resume-read-budget.js';

const attempts: ResumeReadAttempt[] = [];
const controllers: AbortController[] = [];

function controller(): AbortController {
  const value = new AbortController();
  controllers.push(value);
  return value;
}

async function start(
  limits?: Partial<ResumeReadLimits>,
  signal = controller().signal,
): Promise<ResumeReadAttempt> {
  const attempt = await beginResumeRead({ limits, signal });
  attempts.push(attempt);
  return attempt;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const value of controllers.splice(0)) value.abort();
  for (const attempt of attempts.splice(0)) attempt.finish();
  vi.useRealTimers();
});

describe('resume read budgets', () => {
  it('does not reject default reads at the former byte, entry or nested-item ceilings', async () => {
    const attempt = await start();
    attempt.checkLineBytes(8 * 1024 ** 2 + 1);
    attempt.addReadBytes(8 * 1024 ** 3 + 1);
    attempt.addStructure(32 * 1024 ** 2 + 1, 200_001);
    attempt.retain(64 * 1024 ** 2 + 1, 200_001, true);
    for (let index = 0; index < 50_000; index++) attempt.retain(0);
    expect(attempt.validateValue(Array(50_001).fill(null))).toBe(50_001);
    expect(attempt.stats).toMatchObject({
      bytesRead: 8 * 1024 ** 3 + 1,
      retainedEntries: 50_001,
      nestedItems: 200_001,
      structureEntries: 200_001,
    });
    expect(attempt.signal.aborted).toBe(false);
  });

  it('keeps default reads and queued requests alive beyond 60 seconds until cancellation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const abort = controller();
    const active = await start(undefined, abort.signal);
    let admitted = false;
    const pending = start().then((attempt) => {
      admitted = true;
      return attempt;
    });
    // Observe rejection even when the old deadline makes an earlier assertion fail.
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(120_000);
    expect(active.signal.aborted).toBe(false);
    expect(admitted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(await active.run(async () => 'continued')).toBe('continued');
    abort.abort();
    expect(() => active.check()).toThrow(
      expect.objectContaining({ reason: 'cancelled' }),
    );
    const next = await pending;
    expect(admitted).toBe(true);
    next.check();
  });

  it('releases phase residency and structure without resetting cumulative I/O', async () => {
    const attempt = await start();
    attempt.addReadBytes(10);
    const items = attempt.validateValue({ content: [1, { text: 'x' }] });
    expect(items).toBe(4);
    attempt.retain(20, items, true);
    attempt.retain(30, 2);
    attempt.addStructure(40, 3);
    expect(attempt.stats).toMatchObject({
      bytesRead: 10,
      retainedBytes: 50,
      retainedEntries: 2,
      nestedItems: 6,
      metadataBytes: 20,
      metadataEntries: 1,
      structureBytes: 40,
      structureEntries: 3,
    });
    attempt.resetRetained();
    attempt.resetStructure();
    expect(attempt.stats).toMatchObject({
      bytesRead: 10,
      retainedBytes: 0,
      retainedEntries: 0,
      nestedItems: 0,
      metadataBytes: 0,
      metadataEntries: 0,
      structureBytes: 0,
      structureEntries: 0,
    });
    attempt.addReadBytes(5);
    expect(attempt.stats.bytesRead).toBe(15);
  });

  it.each([
    [
      'line bytes',
      { maxLineBytes: 2 },
      (a: ResumeReadAttempt) => a.checkLineBytes(2),
      (a: ResumeReadAttempt) => a.checkLineBytes(3),
    ],
    [
      'read bytes',
      { maxReadBytes: 2 },
      (a: ResumeReadAttempt) => a.addReadBytes(2),
      (a: ResumeReadAttempt) => a.addReadBytes(1),
    ],
    [
      'resident bytes',
      { maxRetainedBytes: 2 },
      (a: ResumeReadAttempt) => a.retain(2),
      (a: ResumeReadAttempt) => a.retain(1),
    ],
    [
      'resident entries',
      { maxRetainedEntries: 1 },
      (a: ResumeReadAttempt) => a.retain(1),
      (a: ResumeReadAttempt) => a.retain(0),
    ],
    [
      'metadata bytes',
      { maxMetadataBytes: 2 },
      (a: ResumeReadAttempt) => a.retain(2, 0, true),
      (a: ResumeReadAttempt) => a.retain(1, 0, true),
    ],
    [
      'structure bytes',
      { maxStructureBytes: 2 },
      (a: ResumeReadAttempt) => a.addStructure(2, 0),
      (a: ResumeReadAttempt) => a.addStructure(1, 0),
    ],
    [
      'structure entries',
      { maxStructureEntries: 1 },
      (a: ResumeReadAttempt) => a.addStructure(0),
      (a: ResumeReadAttempt) => a.addStructure(0),
    ],
    [
      'resident nested items',
      { maxNestedItems: 2 },
      (a: ResumeReadAttempt) => a.retain(1, 2),
      (a: ResumeReadAttempt) => a.retain(1, 1),
    ],
    [
      'per-entry nested items',
      { maxNestedItemsPerEntry: 2 },
      (a: ResumeReadAttempt) => a.validateValue([1, 2]),
      (a: ResumeReadAttempt) => a.validateValue([1, 2, 3]),
    ],
  ] as const)(
    'accepts the exact %s boundary and rejects growth before accounting it',
    async (_name, limits, accept, exceed) => {
      const attempt = await start(limits);
      accept(attempt);
      const before = { ...attempt.stats };
      expect(() => exceed(attempt)).toThrow(ResumeReadError);
      expect(attempt.stats).toEqual(before);
      expect(attempt.signal.aborted).toBe(true);
      expect(() => attempt.check()).toThrow(
        expect.objectContaining({ reason: 'budget' }),
      );
      const next = await start();
      next.check();
    },
  );

  it('metadata consumes the total record and byte budget as well as its sub-budget', async () => {
    const attempt = await start({
      maxRetainedEntries: 1,
      maxMetadataBytes: 100,
    });
    attempt.retain(1);
    expect(() => attempt.retain(1, 0, true)).toThrow(
      expect.objectContaining({ reason: 'budget' }),
    );
  });

  it('counts properties and array elements without charging released historical records', async () => {
    const attempt = await start({
      maxNestedItemsPerEntry: 4,
      maxNestedItems: 4,
      maxDepth: 3,
    });
    for (let index = 0; index < 100; index++) {
      expect(
        attempt.validateValue({ blocks: [{ text: 'x' }], extra: null }),
      ).toBe(4);
    }
    expect(attempt.stats.nestedItems).toBe(0);
    expect(() => attempt.validateValue({ blocks: [[[]]] })).toThrow(
      expect.objectContaining({ reason: 'budget' }),
    );
  });

  it('counts deeply nested historical values iteratively without imposing a default depth ceiling', async () => {
    const attempt = await start();
    let value: unknown = null;
    for (let depth = 0; depth < 10_000; depth++) value = { child: value };
    expect(attempt.validateValue(value)).toBe(10_000);
  });

  it('shares one snapshot retry across read and Writer stages without resetting cumulative work', async () => {
    const attempt = await start();
    attempt.addReadBytes(64);
    attempt.retrySnapshot();
    attempt.resetRetained();
    attempt.resetStructure();
    expect(attempt.stats.bytesRead).toBe(64);
    expect(attempt.stats.snapshotRetries).toBe(1);
    expect(() => attempt.retrySnapshot()).toThrow(expect.objectContaining({ reason: 'snapshot' }));
    (await start()).check();
  });

});

describe('process-wide resume admission and ownership', () => {
  it('holds a single FIFO lease across successful read stages and initialization until finish', async () => {
    const first = await start();
    const admitted: number[] = [];
    const second = start().then((attempt) => {
      admitted.push(2);
      return attempt;
    });
    const third = start().then((attempt) => {
      admitted.push(3);
      return attempt;
    });
    expect(await first.run(async () => 'structure')).toBe('structure');
    expect(await first.run(async () => 'body')).toBe('body');
    expect(admitted).toEqual([]);
    first.finish();
    first.finish();
    const secondAttempt = await second;
    expect(admitted).toEqual([2]);
    secondAttempt.finish();
    await third;
    expect(admitted).toEqual([2, 3]);
    expect(() => first.check()).toThrow(
      expect.objectContaining({ reason: 'cancelled' }),
    );
  });

  it('bounds pending attempts to eight and removes a cancelled waiter without disturbing FIFO', async () => {
    const active = await start();
    const signals = Array.from({ length: 8 }, () => controller());
    const pending = signals.map((value) =>
      start(undefined, value.signal).then(
        (attempt) => ({ attempt }),
        (error: unknown) => ({ error }),
      ),
    );
    await expect(start()).rejects.toMatchObject({ reason: 'busy' });
    signals[3].abort(new Error('private-content'));
    expect(await pending[3]).toMatchObject({ error: { reason: 'cancelled' } });
    const replacement = start();
    active.finish();
    for (let index = 0; index < pending.length; index++) {
      if (index === 3) continue;
      const result = await pending[index];
      expect(result).toHaveProperty('attempt');
      if ('attempt' in result) result.attempt.finish();
    }
    (await replacement).check();
  });

  it('does not acquire a lease for a pre-aborted request or retain its raw abort reason', async () => {
    const abort = controller();
    abort.abort(new Error('/private/path and content'));
    await expect(start(undefined, abort.signal)).rejects.toMatchObject({
      reason: 'cancelled',
      message: 'Transcript resume failed: cancelled.',
    });
    (await start()).check();
  });

  it('defers finish and cancellation release until an ongoing read run has actually stopped', async () => {
    const abort = controller();
    const attempt = await start(undefined, abort.signal);
    const reading = deferred<void>();
    const result = attempt
      .run(() => reading.promise)
      .catch((error: unknown) => error);
    let admitted = false;
    const next = start().then((value) => {
      admitted = true;
      return value;
    });
    abort.abort();
    attempt.finish();
    await Promise.resolve();
    expect(admitted).toBe(false);
    reading.resolve();
    expect(await result).toMatchObject({ reason: 'cancelled' });
    (await next).check();
  });

  it('preserves non-budget I/O errors and releases only when the owner finishes', async () => {
    const attempt = await start();
    const ioError = new Error('I/O operation failed');
    await expect(
      attempt.run(async () => {
        throw ioError;
      }),
    ).rejects.toBe(ioError);
    // 非恢复错误不改写终态，也不能替持有方释放共享名额。
    expect(attempt.signal.aborted).toBe(false);
    const next = start();
    let admitted = false;
    void next.then(() => {
      admitted = true;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
    attempt.finish();
    (await next).check();
  });

  it('reuses admission and cumulative budgets when snapshot retry is handled within the run', async () => {
    const attempt = await start();
    let admitted = false;
    const next = start().then((value) => {
      admitted = true;
      return value;
    });
    await attempt.run(async () => {
      try {
        attempt.addReadBytes(10);
        throw new ResumeReadError('snapshot');
      } catch (error) {
        expect(error).toMatchObject({ reason: 'snapshot' });
        attempt.resetRetained();
        attempt.resetStructure();
        attempt.check();
        attempt.addReadBytes(20);
      }
    });
    expect(attempt.stats.bytesRead).toBe(30);
    expect(admitted).toBe(false);
    attempt.finish();
    (await next).check();
  });

  it('checks elapsed deadlines on failure even before a timer callback can execute', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const attempt = await start({ timeoutMs: 100 });
    await expect(
      attempt.run(async () => {
        vi.advanceTimersByTime(100);
        throw new Error('late I/O error');
      }),
    ).rejects.toMatchObject({ reason: 'timeout' });
    (await start()).check();
  });

  it('automatically frees an initialization lease on deadline and rejects late commit checks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const attempt = await start({ timeoutMs: 100 });
    await attempt.run(async () => undefined);
    const next = start();
    await vi.advanceTimersByTimeAsync(100);
    expect(attempt.signal.aborted).toBe(true);
    expect(() => attempt.check()).toThrow(
      expect.objectContaining({ reason: 'timeout' }),
    );
    (await next).check();
    attempt.finish();
  });

  it('includes FIFO waiting time in the same deadline across all stages', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const active = await start();
    const pending = start({ timeoutMs: 100 });
    const outcome = pending.then(() => undefined, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toMatchObject({ reason: 'timeout' });
    active.finish();
    (await start()).check();
  });

  it('does not return the lease while a timed-out run is still draining', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const attempt = await start({ timeoutMs: 100 });
    const reading = deferred<void>();
    const result = attempt
      .run(() => reading.promise)
      .catch((error: unknown) => error);
    let admitted = false;
    const next = start().then((value) => {
      admitted = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(attempt.signal.aborted).toBe(true);
    expect(admitted).toBe(false);
    reading.resolve();
    expect(await result).toMatchObject({ reason: 'timeout' });
    (await next).check();
  });

  it('releases timeout and admission when a no-Writer owner finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const abort = controller();
    const attempt = await start(undefined, abort.signal);
    await attempt.run(async () => undefined);
    attempt.finish();
    expect(vi.getTimerCount()).toBe(0);
    (await start()).check();
  });
});
