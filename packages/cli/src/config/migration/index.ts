/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Export types
export type { SettingsMigration, MigrationResult } from './types.js';

// Export scheduler
export { MigrationScheduler } from './scheduler.js';

// Export migrations
export { v1ToV2Migration, V1ToV2Migration } from './versions/v1-to-v2.js';
export { v2ToV3Migration, V2ToV3Migration } from './versions/v2-to-v3.js';

// Import settings version from single source of truth
import { SETTINGS_VERSION } from '../settings.js';

// Ordered array of all migrations for use with MigrationScheduler
// Each migration handles one version transition (N → N+1)
// Order matters: migrations must be sorted by ascending version
import { v1ToV2Migration } from './versions/v1-to-v2.js';
import { v2ToV3Migration } from './versions/v2-to-v3.js';
import { MigrationScheduler } from './scheduler.js';
import type { MigrationResult } from './types.js';

/**
 * Ordered array of all settings migrations.
 * Use this with MigrationScheduler to run the full migration chain.
 *
 * @example
 * ```typescript
 * const scheduler = new MigrationScheduler(ALL_MIGRATIONS);
 * const result = scheduler.migrate(settings);
 * ```
 */
export const ALL_MIGRATIONS = [v1ToV2Migration, v2ToV3Migration] as const;

/**
 * Convenience function that runs all migrations on the given settings.
 * This is the primary entry point for settings migration.
 *
 * @param settings - The settings object to migrate
 * @param scope - The scope of settings being migrated
 * @returns MigrationResult containing the final settings, version, and execution log
 *
 * @example
 * ```typescript
 * const result = runMigrations(settings, 'User');
 * if (result.executedMigrations.length > 0) {
 *   console.log(`Migrated from version ${result.executedMigrations[0].fromVersion} to ${result.finalVersion}`);
 * }
 * ```
 */
export function runMigrations(
  settings: unknown,
  scope: string,
): MigrationResult {
  const scheduler = new MigrationScheduler([...ALL_MIGRATIONS], scope);
  return scheduler.migrate(settings);
}

/**
 * Checks if the given settings need migration.
 * Returns true only if at least one registered migration would be applied.
 *
 * This function checks:
 * 1. If $version field exists and is a number:
 *    - Returns false if $version >= SETTINGS_VERSION
 *    - Returns true only when $version < SETTINGS_VERSION AND at least one
 *      migration can execute for the current settings shape
 * 2. If $version field is missing or invalid:
 *    - Uses fallback logic by checking individual migrations
 *
 * Note:
 * - Legacy numeric versions that have no executable migrations are handled by
 *   the settings loader via version normalization (bump metadata to current).
 *
 * @param settings - The settings object to check
 * @returns true if migration is needed, false otherwise
 */
export function needsMigration(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) {
    return false;
  }

  const s = settings as Record<string, unknown>;
  const version = s['$version'];
  const hasApplicableMigration = ALL_MIGRATIONS.some((migration) =>
    migration.shouldMigrate(settings),
  );

  // If $version is a valid number, use version comparison
  if (typeof version === 'number') {
    if (version >= SETTINGS_VERSION) {
      return false;
    }
    // Guardrail: only report migration-needed if at least one migration can execute.
    return hasApplicableMigration;
  }

  // If $version exists but is not a number (invalid), or is missing:
  // Use fallback logic - check if any migration would be applied
  return hasApplicableMigration;
}
