/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsMigration } from '../types.js';

/**
 * Path mapping for boolean polarity migration (V2 disable* -> V3 enable*).
 *
 * Strategy:
 * - For each mapped path, only boolean inputs are transformed.
 * - Transformation is inversion-based: disable=true -> enable=false, disable=false -> enable=true.
 * - Non-boolean values are intentionally ignored here to preserve stable compatibility.
 */
const V2_TO_V3_BOOLEAN_MAP: Record<string, string> = {
  'general.disableAutoUpdate': 'general.enableAutoUpdate',
  'general.disableUpdateNag': 'general.enableAutoUpdate',
  'ui.accessibility.disableLoadingPhrases':
    'ui.accessibility.enableLoadingPhrases',
  'context.fileFiltering.disableFuzzySearch':
    'context.fileFiltering.enableFuzzySearch',
  'model.generationConfig.disableCacheControl':
    'model.generationConfig.enableCacheControl',
};

/**
 * Consolidated old paths that collapse into one V3 field.
 *
 * Current policy:
 * - `general.disableAutoUpdate` and `general.disableUpdateNag` both drive
 *   `general.enableAutoUpdate`.
 * - If any observed boolean source is true, target becomes false.
 * - If no boolean source exists, consolidation does not emit a target value.
 */
const CONSOLIDATED_V2_PATHS: Record<string, string[]> = {
  'general.enableAutoUpdate': [
    'general.disableAutoUpdate',
    'general.disableUpdateNag',
  ],
};

/**
 * Safe nested getter used during migration path inspection.
 *
 * Returns `undefined` when traversal cannot continue (missing key or non-object parent).
 */
function getNestedProperty(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const keys = path.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Safe nested setter used for emitting migrated paths.
 *
 * Behavior:
 * - Creates intermediate objects when absent.
 * - Aborts write if a parent segment is a non-object (collision protection).
 */
function setNestedProperty(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split('.');
  const lastKey = keys.pop();
  if (!lastKey) return;

  let current: Record<string, unknown> = obj;
  for (const key of keys) {
    if (current[key] === undefined) {
      current[key] = {};
    }
    const next = current[key];
    if (typeof next === 'object' && next !== null) {
      current = next as Record<string, unknown>;
    } else {
      // Path collision with non-object, stop here
      return;
    }
  }
  current[lastKey] = value;
}

/**
 * Best-effort nested delete for removing deprecated disable* keys.
 *
 * If traversal hits a non-object parent, deletion is skipped.
 */
function deleteNestedProperty(
  obj: Record<string, unknown>,
  path: string,
): void {
  const keys = path.split('.');
  const lastKey = keys.pop();
  if (!lastKey) return;

  let current: Record<string, unknown> = obj;
  for (const key of keys) {
    const next = current[key];
    if (typeof next !== 'object' || next === null) {
      return;
    }
    current = next as Record<string, unknown>;
  }
  delete current[lastKey];
}

/**
 * JSON-based deep clone used to keep `migrate()` input immutable.
 */
function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * V2 -> V3 migration (boolean polarity normalization stage).
 *
 * Migration contract:
 * - Input: V2 settings object (`$version: 2`).
 * - Output: `$version: 3` with boolean disable* fields migrated to enable* equivalents.
 *
 * Compatibility strategy:
 * - Transform only boolean-valued deprecated fields.
 * - Preserve non-boolean deprecated values untouched.
 * - Always bump version to 3 so future loads are idempotent and skip repeated checks.
 *
 * This implementation mirrors stable behavior and prioritizes parity over aggressive cleanup.
 */
export class V2ToV3Migration implements SettingsMigration {
  readonly fromVersion = 2;
  readonly toVersion = 3;

  /**
   * Migration trigger rule.
   *
   * Execute only when `$version === 2`.
   * This includes V2 files with no migratable disable* booleans so that version
   * metadata still advances to 3.
   */
  shouldMigrate(settings: unknown): boolean {
    if (typeof settings !== 'object' || settings === null) {
      return false;
    }

    const s = settings as Record<string, unknown>;

    // Migrate if $version is 2
    return s['$version'] === 2;
  }

  /**
   * Applies V2 -> V3 transformation with stable-compatible rules.
   *
   * Detailed strategy:
   * 1) Clone input.
   * 2) Process consolidated paths first:
   *    - Inspect each source path.
   *    - If value is boolean, consume it (delete old key) and contribute to aggregate.
   *    - Emit consolidated target when at least one boolean source was consumed.
   * 3) Process remaining one-to-one mappings:
   *    - For each unmapped source, if boolean -> delete old key and write inverted target.
   *    - If non-boolean -> keep old value unchanged.
   * 4) Set `$version = 3`.
   *
   * Guarantees:
   * - Input object is not mutated.
   * - Boolean migration is deterministic.
   * - Non-boolean legacy values are preserved for compatibility.
   */
  migrate(
    settings: unknown,
    _scope: string,
  ): { settings: unknown; warnings: string[] } {
    if (typeof settings !== 'object' || settings === null) {
      throw new Error('Settings must be an object');
    }

    // Deep clone to avoid mutating input
    const result = deepClone(settings) as Record<string, unknown>;
    const processedPaths = new Set<string>();
    const warnings: string[] = [];

    // Step 1: Handle consolidated paths (multiple old paths → single new path)
    // Policy: if ANY of the old disable* settings is true, the new enable* should be false
    for (const [newPath, oldPaths] of Object.entries(CONSOLIDATED_V2_PATHS)) {
      let hasAnyDisable = false;
      let hasAnyBooleanValue = false;

      for (const oldPath of oldPaths) {
        const oldValue = getNestedProperty(result, oldPath);
        if (typeof oldValue === 'boolean') {
          hasAnyBooleanValue = true;
          if (oldValue === true) {
            hasAnyDisable = true;
          }
          deleteNestedProperty(result, oldPath);
          processedPaths.add(oldPath);
        }
      }

      if (hasAnyBooleanValue) {
        // enableAutoUpdate = !hasAnyDisable (if any disable* was true, enable should be false)
        setNestedProperty(result, newPath, !hasAnyDisable);
      }
    }

    // Step 2: Handle remaining individual disable* → enable* mappings
    for (const [oldPath, newPath] of Object.entries(V2_TO_V3_BOOLEAN_MAP)) {
      if (processedPaths.has(oldPath)) {
        continue;
      }

      const oldValue = getNestedProperty(result, oldPath);
      if (typeof oldValue === 'boolean') {
        deleteNestedProperty(result, oldPath);
        // Set new property with inverted value
        setNestedProperty(result, newPath, !oldValue);
      }
    }

    // Step 3: Always update version to 3
    result['$version'] = 3;

    return { settings: result, warnings };
  }
}

/** Singleton instance of V2→V3 migration */
export const v2ToV3Migration = new V2ToV3Migration();
