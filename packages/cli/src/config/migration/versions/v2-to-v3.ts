/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * V2 to V3 migration.
 *
 * Transforms V2 settings with `disable*` boolean naming to V3 with `enable*` naming.
 * This is primarily a boolean inversion migration.
 */

import type { SettingsV2, SettingsV3, MigrationResult } from '../types.js';
import {
  getNestedValue,
  setNestedValue,
  deleteNestedProperty,
  deepClone,
} from '../utils.js';
import { createMigrationStep } from '../pipeline.js';

/**
 * Mapping of V2 paths to V3 paths that need boolean inversion.
 * Format: { 'v2.path.disableX': 'v3.path.enableX' }
 */
const INVERTED_PATHS: Record<string, string> = {
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
 * Consolidated settings: multiple V2 paths map to a single V3 path.
 * Policy: if ANY of the old disable* settings is true, the new enable* should be false.
 */
const CONSOLIDATED_PATHS: Record<string, string[]> = {
  'general.enableAutoUpdate': [
    'general.disableAutoUpdate',
    'general.disableUpdateNag',
  ],
};

/**
 * Migrates V2 settings to V3.
 *
 * Primary changes:
 * - Boolean inversion: disable* → enable* (with value inverted)
 * - Consolidated settings: multiple disable* → single enable*
 *
 * @param v2 - V2 settings object
 * @returns Migration result with V3 settings
 */
export function migrateV2ToV3(v2: SettingsV2): MigrationResult<SettingsV3> {
  return createMigrationStep<SettingsV2, SettingsV3>(
    2,
    3,
    (data, addChange, _addWarning) => {
      const result = deepClone(data) as unknown as SettingsV3;
      result.$version = 3;
      const processedPaths = new Set<string>();

      // Handle consolidated paths first (multiple sources → single target)
      for (const [newPath, oldPaths] of Object.entries(CONSOLIDATED_PATHS)) {
        let hasAnyDisable = false;
        let hasAnyValue = false;
        const foundValues: unknown[] = [];

        for (const oldPath of oldPaths) {
          const oldValue = getNestedValue(result, oldPath);
          if (oldValue !== undefined) {
            hasAnyValue = true;
            foundValues.push({ path: oldPath, value: oldValue });

            if (typeof oldValue === 'boolean' && oldValue === true) {
              hasAnyDisable = true;
            }

            // Delete the old path
            deleteNestedProperty(result, oldPath);
            processedPaths.add(oldPath);
          }
        }

        if (hasAnyValue) {
          // Policy: if ANY disable* is true, enable* should be false
          const newValue = !hasAnyDisable;
          setNestedValue(result, newPath, newValue);

          addChange({
            type: 'transform',
            path: newPath,
            oldValue: foundValues,
            newValue,
            reason: `Consolidated ${oldPaths.join(', ')} into ${newPath} with boolean inversion (if any disable=true, enable=false)`,
          });
        }
      }

      // Handle remaining inverted paths (one-to-one with boolean inversion)
      for (const [oldPath, newPath] of Object.entries(INVERTED_PATHS)) {
        // Skip if already processed by consolidated paths
        if (processedPaths.has(oldPath)) {
          continue;
        }

        const oldValue = getNestedValue(result, oldPath);
        if (oldValue !== undefined) {
          // Invert boolean value
          const newValue = typeof oldValue === 'boolean' ? !oldValue : oldValue;

          // Set new path
          setNestedValue(result, newPath, newValue);

          // Delete old path
          deleteNestedProperty(result, oldPath);

          addChange({
            type: 'transform',
            path: newPath,
            oldValue,
            newValue,
            reason: `Renamed ${oldPath} to ${newPath} with boolean inversion`,
          });
        }
      }

      // Preserve all other fields as-is (already cloned)
      // No additional transformation needed for non-boolean fields

      return result;
    },
  )(v2);
}
