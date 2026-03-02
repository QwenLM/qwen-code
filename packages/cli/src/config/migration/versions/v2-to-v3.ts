/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsMigration } from '../types.js';
import {
  deleteNestedPropertySafe,
  getNestedProperty,
  setNestedPropertySafe,
} from '../../../utils/settingsUtils.js';

/**
 * Path mapping for boolean polarity migration (V2 disable* -> V3 enable*).
 *
 * Strategy:
 * - For each mapped path, values are normalized before migration:
 *   - boolean values are accepted directly
 *   - string values "true"/"false" (case-insensitive, trim-aware) are coerced
 *   - all other present values are treated as invalid
 * - Transformation is inversion-based: disable=true -> enable=false, disable=false -> enable=true.
 * - Deprecated disable* keys are removed whenever present (valid or invalid).
 * - Invalid values do not create enable* keys and produce warnings.
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
 * - If any valid normalized source is true, target becomes false.
 * - If at least one valid normalized source exists, consolidated target is emitted.
 * - Invalid present values are removed and warned, and do not contribute to target calculation.
 */
const CONSOLIDATED_V2_PATHS: Record<string, string[]> = {
  'general.enableAutoUpdate': [
    'general.disableAutoUpdate',
    'general.disableUpdateNag',
  ],
};

/**
 * Normalizes deprecated disable* values for migration.
 *
 * Returns:
 * - `isPresent=false` when the path does not exist
 * - `isPresent=true, isValid=true` when value is boolean or coercible string
 * - `isPresent=true, isValid=false` for invalid values (number/object/array/null/other strings)
 */
function normalizeDisableValue(value: unknown): {
  isPresent: boolean;
  isValid: boolean;
  booleanValue?: boolean;
} {
  if (value === undefined) {
    return { isPresent: false, isValid: false };
  }
  if (typeof value === 'boolean') {
    return { isPresent: true, isValid: true, booleanValue: value };
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return { isPresent: true, isValid: true, booleanValue: true };
    }
    if (normalized === 'false') {
      return { isPresent: true, isValid: true, booleanValue: false };
    }
  }
  return { isPresent: true, isValid: false };
}

/**
 * V2 -> V3 migration (boolean polarity normalization stage).
 *
 * Migration contract:
 * - Input: V2 settings object (`$version: 2`).
 * - Output: `$version: 3` with deprecated disable* fields removed and
 *   valid values migrated to enable* equivalents.
 *
 * Compatibility strategy:
 * - Accept boolean values and coercible strings "true"/"false".
 * - Remove invalid deprecated values (rather than preserving them).
 * - Emit warnings for each removed invalid deprecated key.
 * - Always bump version to 3 so future loads are idempotent and skip repeated checks.
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
   * Applies V2 -> V3 transformation with deterministic deprecated-key cleanup.
   *
   * Detailed strategy:
   * 1) Clone input.
   * 2) Process consolidated paths first:
   *    - Inspect each source path.
   *    - Normalize each present value (boolean / coercible string / invalid).
   *    - Always delete present deprecated source key.
   *    - Valid normalized values contribute to aggregate.
   *    - Invalid values emit warnings.
   *    - Emit consolidated target when at least one valid source was consumed.
   * 3) Process remaining one-to-one mappings:
   *    - For each unmapped source, normalize value.
   *    - If valid -> delete old key and write inverted target.
   *    - If invalid -> delete old key and emit warning.
   * 4) Set `$version = 3`.
   *
   * Guarantees:
   * - Input object is not mutated.
   * - Valid migration and invalid cleanup are deterministic.
   * - Deprecated disable* keys are not retained after migration.
   */
  migrate(
    settings: unknown,
    scope: string,
  ): { settings: unknown; warnings: string[] } {
    if (typeof settings !== 'object' || settings === null) {
      throw new Error('Settings must be an object');
    }

    // Deep clone to avoid mutating input
    const result = structuredClone(settings) as Record<string, unknown>;
    const processedPaths = new Set<string>();
    const warnings: string[] = [];

    // Step 1: Handle consolidated paths (multiple old paths → single new path)
    // Policy: if ANY of the old disable* settings is true, the new enable* should be false
    for (const [newPath, oldPaths] of Object.entries(CONSOLIDATED_V2_PATHS)) {
      let hasAnyDisable = false;
      let hasAnyBooleanValue = false;

      for (const oldPath of oldPaths) {
        const oldValue = getNestedProperty(result, oldPath);
        const normalized = normalizeDisableValue(oldValue);
        if (!normalized.isPresent) {
          continue;
        }

        deleteNestedPropertySafe(result, oldPath);
        processedPaths.add(oldPath);

        if (normalized.isValid) {
          hasAnyBooleanValue = true;
          if (normalized.booleanValue === true) {
            hasAnyDisable = true;
          }
        } else {
          warnings.push(
            `Removed deprecated setting '${oldPath}' from ${scope} settings because the value is invalid. Expected boolean.`,
          );
        }
      }

      if (hasAnyBooleanValue) {
        // enableAutoUpdate = !hasAnyDisable (if any disable* was true, enable should be false)
        setNestedPropertySafe(result, newPath, !hasAnyDisable);
      }
    }

    // Step 2: Handle remaining individual disable* → enable* mappings
    for (const [oldPath, newPath] of Object.entries(V2_TO_V3_BOOLEAN_MAP)) {
      if (processedPaths.has(oldPath)) {
        continue;
      }

      const oldValue = getNestedProperty(result, oldPath);
      const normalized = normalizeDisableValue(oldValue);
      if (!normalized.isPresent) {
        continue;
      }

      deleteNestedPropertySafe(result, oldPath);
      if (normalized.isValid) {
        // Set new property with inverted value
        setNestedPropertySafe(result, newPath, !normalized.booleanValue);
      } else {
        warnings.push(
          `Removed deprecated setting '${oldPath}' from ${scope} settings because the value is invalid. Expected boolean or string "true"/"false".`,
        );
      }
    }

    // Step 3: Always update version to 3
    result['$version'] = 3;

    return { settings: result, warnings };
  }
}

/** Singleton instance of V2→V3 migration */
export const v2ToV3Migration = new V2ToV3Migration();
