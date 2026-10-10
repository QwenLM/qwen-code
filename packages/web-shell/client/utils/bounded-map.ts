/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sets `key` to `value`, marks it most-recently-used, and evicts
 * least-recently-used entries while the map exceeds `cap`. Callers own the
 * cap because legitimate budgets differ per cache.
 */
export function setBoundedMapEntry<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  cap: number,
): void {
  // delete + set moves an existing key to the newest position; Map.set alone
  // keeps it in place, which would let the eviction loop below remove a live,
  // frequently re-recorded key.
  map.delete(key);
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
