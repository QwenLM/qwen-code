/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

interface Gate {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface LongLivedState {
  settled: boolean;
  gates: Set<Gate>;
}

const states = new WeakMap<Promise<unknown>, LongLivedState>();

// Kept out of `raceLongLived` so the reaction it leaves on `longLived` closes
// over this frame only, not over the first caller's gate and result.
function stateFor(longLived: Promise<unknown>): LongLivedState {
  const existing = states.get(longLived);
  if (existing) return existing;
  const state: LongLivedState = { settled: false, gates: new Set() };
  states.set(longLived, state);
  const settle = (open: (gate: Gate) => void) => {
    state.settled = true;
    for (const gate of state.gates) open(gate);
    state.gates.clear();
  };
  longLived.then(
    (value) => settle((gate) => gate.resolve(value)),
    (error: unknown) => settle((gate) => gate.reject(error)),
  );
  return state;
}

/**
 * Settles like `Promise.race([work, longLived])` without leaving anything
 * behind on `longLived`.
 *
 * A reaction added to a pending promise stays queued on it until that
 * promise settles. Racing every call against a promise that lives as long
 * as a session or channel therefore keeps every finished race, and the value
 * it settled with, reachable for that whole lifetime. Here `longLived` gets
 * one reaction for its entire life, which settles a per-call gate for each
 * call still waiting; each call races its work against its own gate and
 * drops the gate as soon as that race settles.
 */
export function raceLongLived<T, L>(
  work: PromiseLike<T>,
  longLived: Promise<L>,
): Promise<T | L> {
  const state = stateFor(longLived);
  // Reactions on a settled promise run once and are released, so the native
  // race is exact here and retains nothing.
  if (state.settled) return Promise.race([work, longLived]);
  const { gates } = state;
  let gate!: Gate;
  const gated = new Promise<L>((resolve, reject) => {
    gate = { resolve: resolve as (value: unknown) => void, reject };
  });
  gates.add(gate);
  // Racing the gate natively keeps Promise.race's tie-breaking: work that has
  // already settled wins over a closed signal still being delivered.
  const raced = Promise.race([work, gated]);
  const release = () => gates.delete(gate);
  raced.then(release, release);
  return raced;
}
