/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Interface that all settings migrations must implement.
 * Each migration handles a single version transition (N → N+1).
 */
export interface SettingsMigration {
  /** Source version number */
  readonly fromVersion: number;

  /** Target version number */
  readonly toVersion: number;

  /**
   * Determines whether this migration should be applied to the given settings.
   * The migration inspects the settings object to detect its current version
   * and returns true if this migration is applicable.
   *
   * @param settings - The current settings object
   * @returns true if this migration should be applied, false otherwise
   */
  shouldMigrate(settings: unknown): boolean;

  /**
   * Executes the migration transformation.
   * This should be a pure function that does not modify the input object.
   *
   * @param settings - The current settings object of version N
   * @param scope - The scope of settings being migrated
   * @returns The migrated settings object of version N+1 with optional warnings
   * @throws Error if the migration fails
   */
  migrate(
    settings: unknown,
    scope: string,
  ): { settings: unknown; warnings: string[] };
}

/**
 * Result of a migration execution by MigrationScheduler.
 */
export interface MigrationResult {
  /** The final settings object after all applicable migrations */
  settings: unknown;

  /** The final version number after migrations */
  finalVersion: number;

  /** List of migrations that were executed */
  executedMigrations: Array<{ fromVersion: number; toVersion: number }>;

  /** List of warning messages generated during migration */
  warnings: string[];
}
