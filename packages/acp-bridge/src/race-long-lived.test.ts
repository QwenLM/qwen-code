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

// The same for the array form, with a second work that never settles.
async function finishArrayCalls(
  longLived: Promise<never>,
): Promise<WeakRef<object>> {
  let first: WeakRef<object> | undefined;
  for (let call = 0; call < 3; call++) {
    const result = { call };
    expect(
      await raceLongLived(
        [deferred<object>().promise, Promise.resolve(result)],
        longLived,
      ),
    ).toBe(result);
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

  it.each([
    ['the long-lived promise', 'closed first'],
    ['the work', 'work first'],
  ])(
    'lets %s win when it settles first, as Promise.race does',
    async (_winner, order) => {
      const longLived = deferred<never>();
      const work = deferred<string>();
      const closed = new Error('closed');
      const outcomes = [
        Promise.race([work.promise, longLived.promise]),
        raceLongLived(work.promise, longLived.promise),
      ].map((race) =>
        race.then(
          (value) => `resolved ${value}`,
          (error: Error) => `rejected ${error.message}`,
        ),
      );
      if (order === 'closed first') {
        longLived.reject(closed);
        work.resolve('done');
      } else {
        work.resolve('done');
        longLived.reject(closed);
      }
      const [native, patched] = await Promise.all(outcomes);
      expect(patched).toBe(native);
      expect(patched).toBe(
        order === 'closed first' ? 'rejected closed' : 'resolved done',
      );
    },
  );

  it('races several works against the long-lived promise', async () => {
    const longLived = deferred<never>();
    const slow = deferred<string>();
    const fast = deferred<string>();
    const raced = raceLongLived(
      [slow.promise, fast.promise],
      longLived.promise,
    );
    fast.resolve('fast');
    await expect(raced).resolves.toBe('fast');
  });

  it('leaves finished results of several works collectable', async ({
    skip,
  }) => {
    skip(
      !(await nativeRaceRetainsValues()),
      'native Promise.race does not retain finished values on this runtime',
    );
    const longLived = deferred<never>();
    const finished = await finishArrayCalls(longLived.promise);
    expect(await collectedAfterGc(finished)).toBe(true);
    longLived.reject(new Error('closed'));
  });

  it('races several works with no extra hop, as Promise.race does', async () => {
    const longLived = deferred<never>();
    const works = [deferred<string>().promise, Promise.resolve('ack')];
    const outcomes = [
      Promise.race([...works, longLived.promise]),
      raceLongLived(works, longLived.promise),
    ].map((race) =>
      race.then(
        (value) => `resolved ${value}`,
        (error: Error) => `rejected ${error.message}`,
      ),
    );
    // Settles after both calls but before the settled work's reaction runs.
    longLived.reject(new Error('closed'));
    const [native, patched] = await Promise.all(outcomes);
    expect(patched).toBe(native);
    expect(patched).toBe('resolved ack');
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
