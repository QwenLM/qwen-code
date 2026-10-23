/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  collectedAfterGc,
  nativeRaceRetainsValues,
} from './internal/testUtils.js';
import { raceLongLived } from './race-long-lived.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Runs a few calls in a frame of its own, so nothing but the returned
// WeakRef points at the first result once it returns. The first call is the
// one that sets up the long-lived promise's single reaction.
async function finishCalls(
  longLived: Promise<never>,
): Promise<WeakRef<object>> {
  let first: WeakRef<object> | undefined;
  for (let call = 0; call < 3; call++) {
    const result = { call };
    expect(await raceLongLived(Promise.resolve(result), longLived)).toBe(
      result,
    );
    first ??= new WeakRef(result);
  }
  return first!;
}

describe('raceLongLived', () => {
  it('leaves finished results collectable while the long-lived promise is pending', async ({
    skip,
  }) => {
    skip(
      !(await nativeRaceRetainsValues()),
      'native Promise.race does not retain finished values on this runtime',
    );
    const longLived = deferred<never>();
    const finished = await finishCalls(longLived.promise);
    expect(await collectedAfterGc(finished)).toBe(true);
    // Settling it here keeps the long-lived promise reachable through the
    // check above, as a live session's closed signal is.
    longLived.reject(new Error('closed'));
  });

  it('lets work that has already settled win, as Promise.race does', async () => {
    const longLived = deferred<never>();
    const waiting = raceLongLived(
      deferred<string>().promise,
      longLived.promise,
    );
    const closed = new Error('closed');
    longLived.reject(closed);
    // The long-lived reaction has not run yet in this job.
    await expect(
      raceLongLived(Promise.resolve('done'), longLived.promise),
    ).resolves.toBe('done');
    await expect(waiting).rejects.toBe(closed);
  });

  it('passes through a failure of the work', async () => {
    const longLived = deferred<never>();
    const failure = new Error('call failed');
    await expect(
      raceLongLived(Promise.reject(failure), longLived.promise),
    ).rejects.toBe(failure);
  });

  it('rejects every waiting call when the long-lived promise rejects', async () => {
    const longLived = deferred<never>();
    const first = raceLongLived(deferred<string>().promise, longLived.promise);
    const second = raceLongLived(deferred<string>().promise, longLived.promise);
    const closed = new Error('channel closed');
    longLived.reject(closed);
    await expect(first).rejects.toBe(closed);
    await expect(second).rejects.toBe(closed);
  });

  it('rejects calls that start after the long-lived promise rejected', async () => {
    const longLived = deferred<never>();
    const closed = new Error('channel closed');
    longLived.reject(closed);
    await expect(
      raceLongLived(deferred<string>().promise, longLived.promise),
    ).rejects.toBe(closed);
    await expect(
      raceLongLived(deferred<string>().promise, longLived.promise),
    ).rejects.toBe(closed);
  });

  it('resolves waiting calls with the value of a long-lived promise that fulfills', async () => {
    const longLived = deferred<{ kind: 'stopped' }>();
    const waiting = raceLongLived(
      deferred<string>().promise,
      longLived.promise,
    );
    longLived.resolve({ kind: 'stopped' });
    await expect(waiting).resolves.toEqual({ kind: 'stopped' });
  });
});
