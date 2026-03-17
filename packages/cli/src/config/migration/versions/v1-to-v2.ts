/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsMigration } from '../types.js';
import {
  CONSOLIDATED_DISABLE_KEYS,
  V1_INDICATOR_KEYS,
  V1_TO_V2_MIGRATION_MAP,
  V1_TO_V2_PRESERVE_DISABLE_MAP,
  V2_CONTAINER_KEYS,
} from './v1-to-v2-shared.js';
import { setNestedPropertySafe } from '../../../utils/settingsUtils.js';

/**
 * Heuristic indicators for deciding whether an object is "V1-like".
 *
 * Detection strategy:
 * - A file is considered migratable as V1 when:
 *   1) It is not explicitly versioned as V2+ (`$version` is missing or invalid), and
 *   2) At least one indicator key appears in a legacy-compatible top-level shape.
 * - Indicator list intentionally excludes keys that are valid top-level entries in
 *   both old and new structures to reduce false positives.
 *
 * Shape rule:
 * - Object values for indicator keys are treated as already-nested V2-like content
 *   and do not alone trigger migration.
 * - Primitive/array/null values on indicator keys are treated as legacy V1 signals.
 */

/**
 * V1 -> V2 migration (structural normalization stage).
 *
 * Migration contract:
 * - Input: settings in legacy V1-like shape (mostly flat, may contain mixed partial V2).
 * - Output: V2-compatible nested structure with `$version: 2`.
 * - No semantic inversion of disable* naming in this stage.
 *
 * Data-preservation strategy:
 * - Prefer transforming known keys into canonical V2 locations.
 * - Preserve unrecognized keys verbatim.
 * - Preserve parent-path scalar values when nested writes would collide with them.
 * - Preserve/merge existing partial V2 objects where safe.
 *
 * This class intentionally optimizes for backward compatibility and non-destructive
 * behavior over aggressive normalization.
 */
export class V1ToV2Migration implements SettingsMigration {
  readonly fromVersion = 1;
  readonly toVersion = 2;

  /**
   * Determines whether this migration should execute.
   *
   * Decision strategy:
   * - Hard-stop when `$version` is a number >= 2 (already V2+).
   * - Otherwise, scan indicator keys and trigger only when at least one indicator is
   *   still in legacy top-level shape (primitive/array/null).
   *
   * Mixed-shape tolerance:
   * - Files that are partially migrated are supported; V2-like object-valued indicators
   *   are ignored while legacy-shaped indicators can still trigger migration.
   */
  shouldMigrate(settings: unknown): boolean {
    if (typeof settings !== 'object' || settings === null) {
      return false;
    }

    const s = settings as Record<string, unknown>;

    // If $version exists and is a number >= 2, it's not V1
    const version = s['$version'];
    if (typeof version === 'number' && version >= 2) {
      return false;
    }

    // Check for V1 indicator keys with primitive values
    // A setting is considered V1 if ANY indicator key has a primitive value
    // (string, number, boolean, null, or array) at the top level.
    // Keys with object values are skipped as they may already be in V2 format.
    return V1_INDICATOR_KEYS.some((key) => {
      if (!(key in s)) {
        return false;
      }
      const value = s[key];
      // Skip keys with object values - they may already be in V2 nested format
      // But don't let them block migration of other keys
      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
      ) {
        // This key appears to be in V2 format, skip it but continue
        // checking other keys
        return false;
      }
      // Found a key with primitive value - this is V1 format
      return true;
    });
  }

  /**
   * Performs non-destructive V1 -> V2 transformation.
   *
   * Detailed strategy:
   * 1) Relocate known V1 keys using `V1_TO_V2_MIGRATION_MAP`.
   *    - If a source value is already an object and maps to a child path of itself
   *      (partial V2 shape), merge child properties into target path.
   * 2) Relocate disable* keys into V2 disable* locations.
   *    - Consolidated keys (`disableAutoUpdate`, `disableUpdateNag`): normalize to
   *      boolean with stable-compatible presence semantics (`value === true`).
   *    - Other disable* keys: migrate only boolean values.
   * 3) Preserve `mcpServers` top-level placement.
   * 4) Carry over remaining keys:
   *    - If a key is parent of migrated nested paths, merge unprocessed object children.
   *    - If parent value is non-object, preserve that scalar/array/null as-is.
   *    - Otherwise copy untouched key/value.
   * 5) Stamp `$version = 2`.
   *
   * The method is pure with respect to input mutation.
   */
  migrate(
    settings: unknown,
    _scope: string,
  ): { settings: unknown; warnings: string[] } {
    if (typeof settings !== 'object' || settings === null) {
      throw new Error('Settings must be an object');
    }

    const source = settings as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    const processedKeys = new Set<string>();
    const warnings: string[] = [];

    // Step 1: Map known V1 keys to V2 nested paths
    for (const [v1Key, v2Path] of Object.entries(V1_TO_V2_MIGRATION_MAP)) {
      if (v1Key in source) {
        const value = source[v1Key];

        // Safety check: If this key is a V2 container (like 'model') and it's
        // already an object, it's likely already in V2 format. Skip migration
        // to prevent double-nesting (e.g., model.name.name).
        if (
          V2_CONTAINER_KEYS.has(v1Key) &&
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value)
        ) {
          // This is already a V2 container, carry it over as-is
          result[v1Key] = value;
          processedKeys.add(v1Key);
          continue;
        }

        // If value is already an object and the path matches the key,
        // it might be a partial V2 structure. Merge its contents.
        if (
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value) &&
          v2Path.startsWith(v1Key + '.')
        ) {
          // Merge nested properties from this partial V2 structure
          for (const [nestedKey, nestedValue] of Object.entries(value)) {
            setNestedPropertySafe(
              result,
              `${v2Path}.${nestedKey}`,
              nestedValue,
            );
          }
        } else {
          setNestedPropertySafe(result, v2Path, value);
        }
        processedKeys.add(v1Key);
      }
    }

    // Step 2: Map V1 disable* keys to V2 nested disable* paths
    for (const [v1Key, v2Path] of Object.entries(
      V1_TO_V2_PRESERVE_DISABLE_MAP,
    )) {
      if (v1Key in source) {
        const value = source[v1Key];
        if (CONSOLIDATED_DISABLE_KEYS.has(v1Key)) {
          // Preserve stable behavior: consolidated keys use presence semantics.
          // Only literal true remains true; all other present values become false.
          setNestedPropertySafe(result, v2Path, value === true);
        } else if (typeof value === 'boolean') {
          // Non-consolidated disable* keys only migrate when explicitly boolean.
          setNestedPropertySafe(result, v2Path, value);
        }
        processedKeys.add(v1Key);
      }
    }

    // Step 3: Preserve mcpServers at the top level
    if ('mcpServers' in source) {
      result['mcpServers'] = source['mcpServers'];
      processedKeys.add('mcpServers');
    }

    // Step 4: Carry over any unrecognized keys (including unknown nested objects)
    // Important: Skip keys that are parent paths of already-migrated properties
    // to avoid overwriting merged structures (e.g., 'ui' should not overwrite 'ui.theme')
    for (const key of Object.keys(source)) {
      if (!processedKeys.has(key)) {
        // Check if this key is a parent of any already-migrated path
        const isParentOfMigratedPath = Array.from(processedKeys).some(
          (processedKey) => {
            // Get the v2 path for this processed key
            const v2Path =
              V1_TO_V2_MIGRATION_MAP[processedKey] ||
              V1_TO_V2_PRESERVE_DISABLE_MAP[processedKey];
            if (!v2Path) return false;
            // Check if the v2 path starts with this key + '.'
            return v2Path.startsWith(key + '.');
          },
        );

        if (isParentOfMigratedPath) {
          // This key is a parent of an already-migrated path
          // Merge its unprocessed children instead of overwriting
          const existingValue = source[key];
          if (
            typeof existingValue === 'object' &&
            existingValue !== null &&
            !Array.isArray(existingValue)
          ) {
            for (const [nestedKey, nestedValue] of Object.entries(
              existingValue,
            )) {
              // Only merge if this nested key wasn't already processed
              const fullNestedPath = `${key}.${nestedKey}`;
              const wasProcessed = Array.from(processedKeys).some(
                (processedKey) => {
                  const v2Path =
                    V1_TO_V2_MIGRATION_MAP[processedKey] ||
                    V1_TO_V2_PRESERVE_DISABLE_MAP[processedKey];
                  return v2Path === fullNestedPath;
                },
              );
              if (!wasProcessed) {
                setNestedPropertySafe(result, fullNestedPath, nestedValue);
              }
            }
          } else {
            // Preserve non-object parent values to match legacy overwrite semantics.
            result[key] = source[key];
          }
        } else {
          // Not a parent path, safe to copy as-is
          result[key] = source[key];
        }
      }
    }

    // Step 5: Set version to 2
    result['$version'] = 2;

    return { settings: result, warnings };
  }
}

/** Singleton instance of V1→V2 migration */
export const v1ToV2Migration = new V1ToV2Migration();
