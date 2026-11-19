/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface LongLivedState {
  settled: boolean;
  waiters: Set<Waiter>;
}

const states = new WeakMap<Promise<unknown>, LongLivedState>();

// Kept out of `raceLongLived` so the reaction it leaves on `longLived` closes
// over this frame only, not over the first caller's waiter and result.
function stateFor(longLived: Promise<unknown>): LongLivedState {
  const existing = states.get(longLived);
  if (existing) return existing;
  const state: LongLivedState = { settled: false, waiters: new Set() };
  states.set(longLived, state);
  const settle = (notify: (waiter: Waiter) => void) => {
    state.settled = true;
    for (const waiter of state.waiters) notify(waiter);
    state.waiters.clear();
  };
  longLived.then(
    (value) => settle((waiter) => waiter.resolve(value)),
    (error: unknown) => settle((waiter) => waiter.reject(error)),
  );
  return state;
}

/**
 * Settles like `Promise.race([work, longLived])`, or
 * `Promise.race([...works, longLived])`, without leaving anything behind on
 * `longLived`.
 *
 * A reaction added to a pending promise stays queued on it until that
 * promise settles. Racing every call against a promise that lives as long
 * as a session or channel therefore keeps every finished race, and the value
 * it settled with, reachable for that whole lifetime. Here `longLived` gets
 * one reaction for its entire life, which settles every call still waiting
 * when it fires; each call drops its waiter as soon as it settles. Every
 * input reaches the result in the same microtask as with `Promise.race`, so
 * whichever settles first wins. The one difference: a call that starts with
 * its work already settled, in the job where `longLived` settles but before
 * its reaction has run, gets `longLived`'s outcome rather than the work's.
 */
export function raceLongLived<T, L>(
  work: PromiseLike<T>,
  longLived: Promise<L>,
): Promise<T | L>;
export function raceLongLived<W extends readonly unknown[], L>(
  works: W,
  longLived: Promise<L>,
): Promise<Awaited<W[number]> | L>;
export function raceLongLived(
  work: PromiseLike<unknown> | readonly unknown[],
  longLived: Promise<unknown>,
): Promise<unknown> {
  const works: readonly unknown[] = Array.isArray(work) ? work : [work];
  const state = stateFor(longLived);
  // Reactions on a settled promise run once and are released, so the native
  // race is exact here and retains nothing.
  if (state.settled) return Promise.race([...works, longLived]);
  const { waiters } = state;
  let waiter!: Waiter;
  const raced = new Promise<unknown>((resolve, reject) => {
    waiter = { resolve, reject };
    for (const each of works) Promise.resolve(each).then(resolve, reject);
  });
  waiters.add(waiter);
  const release = () => waiters.delete(waiter);
  raced.then(release, release);
  return raced;
}
