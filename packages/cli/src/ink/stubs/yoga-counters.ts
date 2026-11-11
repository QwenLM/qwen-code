/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

// Yoga counter tracking stub
// The engine's custom yoga fork tracks layout stats internally.
// With npm yoga-layout, we provide no-op counters.

let _visited = 0;
let _measured = 0;
let _cacheHits = 0;
let _liveNodes = 0;

export function getYogaCounters(): {
  visited: number;
  measured: number;
  cacheHits: number;
  live: number;
} {
  return {
    visited: _visited,
    measured: _measured,
    cacheHits: _cacheHits,
    live: _liveNodes,
  };
}

export function recordYogaMs(_ms: number): void {
  // No-op: npm yoga-layout doesn't expose per-layout timing
}
