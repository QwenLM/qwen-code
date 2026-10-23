/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

interface LongLivedState {
  settled?: { ok: true; value: unknown } | { ok: false; error: unknown };
  waiters: Set<{
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }>;
}

const states = new WeakMap<Promise<unknown>, LongLivedState>();

/**
 * Settles like `Promise.race([work, longLived])` without leaving anything
 * behind on `longLived`.
 *
 * A reaction added to a pending promise stays queued on it until that
 * promise settles. Racing every call against a promise that lives as long
 * as a session or channel therefore keeps every finished race, and the value
 * it settled with, reachable for that whole lifetime. Here `longLived` gets
 * one reaction for its entire life. That reaction settles the calls still
 * waiting when it fires, and each call drops its waiter as soon as it
 * settles itself.
 */
export function raceLongLived<T, L>(
  work: PromiseLike<T>,
  longLived: Promise<L>,
): Promise<T | L> {
  let state = states.get(longLived);
  if (!state) {
    const created: LongLivedState = { waiters: new Set() };
    states.set(longLived, created);
    longLived.then(
      (value) => {
        created.settled = { ok: true, value };
        for (const waiter of created.waiters) waiter.resolve(value);
        created.waiters.clear();
      },
      (error: unknown) => {
        created.settled = { ok: false, error };
        for (const waiter of created.waiters) waiter.reject(error);
        created.waiters.clear();
      },
    );
    state = created;
  }
  // Reactions on a settled promise run once and are released, so the native
  // race is exact here and retains nothing.
  if (state.settled) return Promise.race([work, longLived]);
  const { waiters } = state;
  return new Promise<T | L>((resolve, reject) => {
    const waiter = {
      resolve: resolve as (value: unknown) => void,
      reject,
    };
    waiters.add(waiter);
    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => waiters.delete(waiter));
  });
}
