/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '@qwen-code/qwen-code-core';
import type { SettingsMigration, MigrationResult } from './types.js';

const debugLogger = createDebugLogger('SETTINGS_MIGRATION');

/**
 * Formats a SettingScope enum value to a human-readable string.
 * - Converts to lowercase
 * - Special case: 'SystemDefaults' -> 'system default'
 */
export function formatScope(scope: string): string {
  if (scope === 'SystemDefaults') {
    return 'system default';
  }
  return scope.toLowerCase();
}

/**
 * Chain scheduler for settings migrations.
 *
 * The MigrationScheduler orchestrates multiple migrations in sequence,
 * delegating version detection to each individual migration via `shouldMigrate`.
 * It has no centralized version logic - migrations self-determine applicability.
 *
 * Key characteristics:
 * - Linear chain execution: migrations are applied in registration order
 * - Idempotent: already-migrated versions return false from shouldMigrate
 * - Adjacent versions only: each migration handles N → N+1
 * - Pure functions: migrations don't modify input objects
 */
export class MigrationScheduler {
  /**
   * Creates a new MigrationScheduler with the given migrations.
   *
   * @param migrations - Array of migrations in execution order (typically ascending version)
   * @param scope - The scope of settings being migrated
   */
  constructor(
    private readonly migrations: SettingsMigration[],
    private readonly scope: string,
  ) {}

  /**
   * Executes the migration chain on the given settings.
   *
   * Iterates through all registered migrations in order. For each migration:
   * 1. Calls `shouldMigrate` with the current settings
   * 2. If true, calls `migrate` to transform the settings
   * 3. Records the execution
   *
   * The scheduler itself has no version awareness - all version detection
   * is delegated to the individual migrations.
   *
   * @param settings - The settings object to migrate
   * @returns MigrationResult containing the final settings, version, and execution log
   */
  migrate(settings: unknown): MigrationResult {
    debugLogger.debug('MigrationScheduler: Starting migration chain');

    let current = settings;
    const executed: Array<{ fromVersion: number; toVersion: number }> = [];
    const allWarnings: string[] = [];

    for (const migration of this.migrations) {
      try {
        if (migration.shouldMigrate(current)) {
          debugLogger.debug(
            `MigrationScheduler: Executing migration ${migration.fromVersion} → ${migration.toVersion}`,
          );

          const formattedScope = formatScope(this.scope);
          const result = migration.migrate(current, formattedScope);
          current = result.settings;
          allWarnings.push(...result.warnings);

          executed.push({
            fromVersion: migration.fromVersion,
            toVersion: migration.toVersion,
          });

          debugLogger.debug(
            `MigrationScheduler: Migration ${migration.fromVersion} → ${migration.toVersion} completed successfully`,
          );
        }
      } catch (error) {
        debugLogger.error(
          `MigrationScheduler: Migration ${migration.fromVersion} → ${migration.toVersion} failed:`,
          error,
        );
        throw error;
      }
    }

    // Determine final version from the settings object
    const finalVersion =
      ((current as Record<string, unknown>)['$version'] as number) ?? 1;

    debugLogger.debug(
      `MigrationScheduler: Migration chain complete. Final version: ${finalVersion}, Executed: ${executed.length} migrations`,
    );

    return {
      settings: current,
      finalVersion,
      executedMigrations: executed,
      warnings: allWarnings,
    };
  }
}
