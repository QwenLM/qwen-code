/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MIN_CHILD_HEAP_MB,
  type DaemonMemoryBudget,
} from './daemon-memory-budget.js';
import { MAX_DAEMON_WORKSPACES } from './channel-control-timeouts.js';

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
  /** Children admitted concurrently. `perChildCeilingMb * this <= childPoolMb`. */
  maxConcurrentChildren: number;
  /** The constant every admitted child receives. */
  perChildCeilingMb: number;
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

  // A FIXED partition, not a share of the pool divided by the children live at
  // this instant. The difference is the whole contract.
  //
  // A per-spawn share bounds the child *count* but not the memory: V8 cannot
  // lower a running child's ceiling, so grants accumulate as
  // P + P/2 + P/3 + ... = P x H(n) — 2.6x the pool at seven children on an
  // 8 GB host, 4x at twenty-five on 32 GB. That authorises more old space than
  // the host has, which is what this policy exists to stop.
  //
  // Holding the ceiling constant makes the sum n * ceiling, and admitting at
  // most `maxConcurrentChildren` makes that <= childPoolMb by construction —
  // no ledger of outstanding grants, and no dependence on the order children
  // happened to arrive in.
  //
  // The cost is real and deliberate: a lone workspace on a 32 GB host gets
  // 614 MB rather than the whole pool. Every admitted child is sized for a
  // full house, because any child may still be running when the house fills.
  const maxConcurrentChildren = Math.max(
    1,
    Math.min(
      Math.floor(budget.childPoolMb / MIN_CHILD_HEAP_MB),
      MAX_DAEMON_WORKSPACES,
    ),
  );
  const perChildCeilingMb = Math.min(
    Math.floor(budget.childPoolMb / maxConcurrentChildren),
    budget.legacyChildCeilingMb,
  );

  return {
    decide(concurrentChildren) {
      if (mode === 'off') return { ceilingMb: undefined, refuse: false };

      // Refuse on the count, since the ceiling no longer varies with it. This
      // is the only thing keeping the sum inside the pool.
      const refuse = concurrentChildren > maxConcurrentChildren;
      if (refuse) refusals += 1;

      return { ceilingMb: perChildCeilingMb, refuse };
    },

    snapshot() {
      return {
        mode,
        enforced: mode === 'enforce',
        childPoolMb: budget.childPoolMb,
        minChildHeapMb: MIN_CHILD_HEAP_MB,
        maxConcurrentChildren,
        perChildCeilingMb,
        refusals,
      };
    },
  };
}
