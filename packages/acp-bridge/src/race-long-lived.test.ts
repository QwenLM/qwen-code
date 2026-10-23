/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
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
// WeakRef points at the last result once it returns.
async function finishCalls(
  longLived: Promise<never>,
): Promise<WeakRef<object>> {
  let finished: WeakRef<object> | undefined;
  for (let call = 0; call < 3; call++) {
    const result = { call };
    expect(await raceLongLived(Promise.resolve(result), longLived)).toBe(
      result,
    );
    finished = new WeakRef(result);
  }
  return finished!;
}

describe('raceLongLived', () => {
  it('settles with the work and leaves its result collectable', async () => {
    const longLived = deferred<never>();
    const finished = await finishCalls(longLived.promise);

    // `Promise.race([work, longLived.promise])` keeps every result reachable
    // until longLived settles on Node 22 and 24 and on the Electron runtime
    // the VS Code companion runs the daemon on (Node 26 happens not to).
    v8.setFlagsFromString('--expose_gc');
    const gc = runInNewContext('gc') as () => void;
    // deref() keeps its target alive until the current job ends, so collect
    // in a job that has not dereferenced it.
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
    let collected = false;
    for (let attempt = 0; attempt < 10 && !collected; attempt++) {
      await tick();
      gc();
      await tick();
      collected = finished.deref() === undefined;
    }
    expect(collected).toBe(true);
    // Settling it here keeps the long-lived promise reachable through the
    // check above, as a live session's closed signal is.
    longLived.reject(new Error('closed'));
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
