/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MIN_CHILD_HEAP_MB,
  recommendedChildShareMb,
  type DaemonMemoryBudget,
} from './daemon-memory-budget.js';

/**
 * What the daemon does with the child-heap share it computes.
 *
 * `off` — do not compute it. Children get the historical host-derived ceiling.
 *
 * `observe` — compute the share and the admission decision, apply **neither**,
 * and count the refusals that would have happened. Deliberately the default:
 * the thresholds this policy divides by have never been checked against a real
 * multi-workspace deployment, and a non-zero refusal count is the evidence
 * that turning `enforce` on would have broken someone.
 *
 * `enforce` — pass the share to the child and refuse the spawn when the pool
 * cannot cover another one.
 */
export type ChildHeapMode = 'off' | 'observe' | 'enforce';

export interface ChildHeapDecision {
  /**
   * The share this child should receive, or `undefined` when the mode does not
   * produce one. `undefined` means "spawn as before", never "zero".
   */
  ceilingMb: number | undefined;
  /** Whether the pool cannot cover this child. Only acted on under `enforce`. */
  refuse: boolean;
}

export interface ChildHeapPolicySnapshot {
  mode: ChildHeapMode;
  /** True only under `enforce` — i.e. only when a spawn argument really derives from this. */
  enforced: boolean;
  childPoolMb: number;
  minChildHeapMb: number;
  /**
   * Spawns this policy refused, or would have refused under `enforce`. The
   * calibration signal: non-zero under `observe` means enforcement would have
   * failed a real spawn, including the channel-swap case where a replacement
   * is counted alongside the process it replaces.
   */
  refusals: number;
}

export interface ChildHeapPolicy {
  /**
   * @param concurrentChildren Children already committed *including this one*
   *   — `ProcessRegistry.committedProcessCount` taken after `reserve()`.
   */
  decide(concurrentChildren: number): ChildHeapDecision;
  snapshot(): ChildHeapPolicySnapshot;
}

export function createChildHeapPolicy(options: {
  budget: DaemonMemoryBudget;
  mode: ChildHeapMode;
}): ChildHeapPolicy {
  const { budget, mode } = options;
  let refusals = 0;

  return {
    decide(concurrentChildren) {
      if (mode === 'off') return { ceilingMb: undefined, refuse: false };
      const children = Math.max(concurrentChildren, 1);

      // `recommendedChildShareMb` clamps UP to MIN_CHILD_HEAP_MB, so past the
      // point where the pool stops covering the count its answer saturates at
      // 512 and can no longer say "will not fit" — a 600 MB pool split four
      // ways still returns 512. Derive the refusal from the unclamped
      // quotient, or the clamp silently authorises the very overcommit this
      // policy exists to bound.
      const refuse =
        Math.floor(budget.childPoolMb / children) < MIN_CHILD_HEAP_MB;
      if (refuse) refusals += 1;

      return {
        // Reported in both modes; only `enforce` lets the caller apply it.
        ceilingMb: recommendedChildShareMb(budget, children),
        refuse,
      };
    },

    snapshot() {
      return {
        mode,
        enforced: mode === 'enforce',
        childPoolMb: budget.childPoolMb,
        minChildHeapMb: MIN_CHILD_HEAP_MB,
        refusals,
      };
    },
  };
}
