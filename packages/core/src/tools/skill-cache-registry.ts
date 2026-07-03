/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Leaf module for the `collectAvailableSkillEntries` WeakMap cache. Extracted
 * so that `skill-manager.ts` and `config.ts` can value-import
 * `invalidateCollectedSkillEntriesCache` without creating a circular dependency
 * through `skill-utils.ts` (which type-imports from both modules).
 */

import type { CollectedAvailableSkills } from './skill-utils.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('SKILL_CACHE');

/**
 * WeakMap-based cache keyed by `(skillManager, config)` identity.
 *
 * The old module-level singleton (`cachedEntries` + `cacheInvalidated`) was
 * shared across all callers regardless of which `SkillManager` / `Config`
 * instance was used.  This broke tests because different test fixtures created
 * distinct mock instances but read the same cached result.  A WeakMap keyed by
 * `(skillManager, config)` guarantees per-instance isolation: each unique pair
 * gets its own cache entry, and entries are automatically reclaimed when the
 * key objects are garbage-collected.
 *
 * Stores `Promise<CollectedAvailableSkills>` during the first compute so that
 * concurrent callers (e.g. SkillCommandLoader, BundledSkillLoader,
 * buildAvailableSkillsReminder) share one disk scan instead of each triggering
 * an independent `listSkills()`.  The resolved value overwrites the promise on
 * `.then()` — subsequent hits bypass the Promise check entirely.
 *
 * Wrapped in an object so we can reassign the entire WeakMap on full
 * invalidation — avoids `WeakMap.clear()` which is unreliable in some
 * environments (e.g. vitest mock transformers).
 */
let cacheByManager = new WeakMap<
  object,
  Map<unknown, CollectedAvailableSkills | Promise<CollectedAvailableSkills>>
>();

/**
 * Computes or returns a cached result for `collectAvailableSkillEntries`
 * keyed by `(skillManager, config)` identity.
 *
 * Stores the in-flight Promise in the cache so that concurrent callers during
 * startup share a single `listSkills()` disk scan.  The resolved value
 * overwrites the Promise on `.then()` — subsequent hits bypass the Promise
 * check entirely.  On failure the entry is evicted so the next caller retries
 * instead of replaying the same rejection.
 */
export function getCachedOrCompute(
  skillManager: object,
  config: object,
  compute: () => Promise<CollectedAvailableSkills>,
): Promise<CollectedAvailableSkills> {
  const managerCache = cacheByManager.get(skillManager);
  if (managerCache) {
    const cached = managerCache.get(config);
    if (cached) {
      if (cached instanceof Promise) {
        // In-flight: another caller already started compute — share the promise.
        debugLogger.debug('cache hit (promise in-flight)');
        return cached;
      }
      // Resolved value — fast path.
      debugLogger.debug('cache hit (entries=%d)', cached.entries.length);
      return Promise.resolve(cached);
    }
  }

  // Cache miss: start compute and store the promise for concurrent dedup.
  // Capture WeakMap reference before compute so .then()/.catch() handlers
  // don't write stale results into a new WeakMap after invalidation.
  const cacheSnapshot = cacheByManager;
  const promise = compute()
    .then((result) => {
      if (cacheByManager !== cacheSnapshot) return result;
      let mc = cacheSnapshot.get(skillManager);
      if (!mc) {
        mc = new Map();
        cacheSnapshot.set(skillManager, mc);
      }
      // Overwrite the in-flight Promise with the resolved value so subsequent
      // hits skip the instanceof Promise check.
      mc.set(config, result);
      debugLogger.debug(
        'cache populated (skills=%d, commands=%d, entries=%d)',
        result.availableSkills.length,
        result.modelInvocableCommands.length,
        result.entries.length,
      );
      return result;
    })
    .catch((err: unknown) => {
      if (cacheByManager !== cacheSnapshot) throw err;
      // Evict so the next caller retries instead of replaying rejection.
      const mc = cacheSnapshot.get(skillManager);
      if (mc) mc.delete(config);
      debugLogger.warn(
        'cache computation failed: %s',
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    });

  let mc = cacheByManager.get(skillManager);
  if (!mc) {
    mc = new Map();
    cacheByManager.set(skillManager, mc);
  }
  mc.set(config, promise);
  return promise;
}

/**
 * Invalidates all cached entries. Called by `invalidateCollectedSkillEntriesCache()`.
 */
function invalidateAllCache(): void {
  cacheByManager = new WeakMap();
  debugLogger.debug('all cache invalidated');
}

/**
 * Invalidates the module-level skill-entries cache. Call this whenever the
 * underlying skill set or disabled-skill state changes so that the next
 * `collectAvailableSkillEntries()` call recomputes from disk.
 */
export function invalidateCollectedSkillEntriesCache(): void {
  invalidateAllCache();
}
