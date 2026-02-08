/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Settings migration module.
 *
 * This module provides a pure function migration framework for settings schema versions.
 * It supports linear migration chains from any version to the latest.
 *
 * @example
 * ```typescript
 * import { migrateToLatest, LATEST_VERSION } from './migration/index.js';
 *
 * const rawSettings = JSON.parse(fs.readFileSync('settings.json', 'utf-8'));
 * const result = migrateToLatest(rawSettings);
 *
 * if (result.success) {
 *   console.log(`Migrated to v${result.version}`);
 *   console.log('Changes:', result.changes);
 *   fs.writeFileSync('settings.json', JSON.stringify(result.data, null, 2));
 * }
 * ```
 */

import { createPipeline, detectVersion } from './pipeline.js';
import { MIGRATIONS } from './versions/index.js';
import {
  LATEST_VERSION,
  type MigrationResult,
  type Settings,
} from './types.js';

export { LATEST_VERSION, SETTINGS_VERSION_KEY } from './types.js';
export type {
  Migration,
  MigrationChange,
  MigrationResult,
  Settings,
  SettingsV1,
  SettingsV2,
  SettingsV3,
} from './types.js';
export { detectVersion, createPipeline } from './pipeline.js';
export {
  getNestedValue,
  setNestedValue,
  deleteNestedProperty,
  moveField,
  renameField,
  invertBoolean,
  consolidateFields,
  preserveUnknownFields,
  deepClone,
} from './utils.js';
export { migrateV1ToV2, migrateV2ToV3 } from './versions/index.js';

/**
 * The migration pipeline instance.
 * Composes all migrations into a single callable function.
 */
const pipeline = createPipeline(MIGRATIONS);

/**
 * Migrates settings from any version to the latest version.
 *
 * This function:
 * 1. Detects the current version of the input settings
 * 2. Applies necessary migrations in sequence
 * 3. Returns the migrated settings with change tracking
 *
 * @param data - Settings object of any version (V1, V2, V3, or already latest)
 * @returns Migration result containing the migrated data and change information
 *
 * @example
 * ```typescript
 * // Migrate V1 settings
 * const v1 = { theme: 'dark', disableAutoUpdate: true };
 * const result = migrateToLatest(v1);
 * // result.data = { $version: 3, ui: { theme: 'dark' }, general: { enableAutoUpdate: false } }
 * // result.changes = [...]
 * ```
 */
export function migrateToLatest(data: unknown): MigrationResult<Settings> {
  return pipeline(data) as MigrationResult<Settings>;
}

/**
 * Checks if the given settings need migration.
 *
 * @param data - Settings object to check
 * @returns True if migration is needed, false if already at latest version
 */
export function needsMigration(data: unknown): boolean {
  const version = detectVersion(data);
  return version < LATEST_VERSION;
}
