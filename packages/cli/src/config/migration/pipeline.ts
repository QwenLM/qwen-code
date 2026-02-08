/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Migration pipeline and version detection.
 *
 * This module provides the infrastructure for composing and executing
 * migrations in a linear chain from any version to the latest.
 */

import {
  type Migration,
  type MigrationResult,
  type MigrationChange,
  LATEST_VERSION,
  SETTINGS_VERSION_KEY,
} from './types.js';

/**
 * Detects the schema version of a settings object.
 *
 * Uses field presence heuristics:
 * - V3+: Has explicit $version field >= 3
 * - V2: Has nested structure with disable* booleans (no $version)
 * - V1: Flat structure (no $version, or $version < 3)
 *
 * @param data - The settings object to check
 * @returns The detected version number (1, 2, or 3)
 */
export function detectVersion(data: unknown): number {
  if (typeof data !== 'object' || data === null) {
    return 1;
  }

  const obj = data as Record<string, unknown>;

  // Check for explicit version field (V3+)
  const version = obj[SETTINGS_VERSION_KEY];
  if (typeof version === 'number' && version >= 3) {
    return version;
  }

  // Check for V2: nested structure with disable* booleans
  // Key indicator: general.disableAutoUpdate exists
  const general = obj['general'];
  if (
    general &&
    typeof general === 'object' &&
    general !== null &&
    ('disableAutoUpdate' in general || 'disableUpdateNag' in general)
  ) {
    return 2;
  }

  // Check for V2: ui.accessibility.disableLoadingPhrases
  const ui = obj['ui'];
  if (ui && typeof ui === 'object' && ui !== null) {
    const accessibility = (ui as Record<string, unknown>)['accessibility'];
    if (
      accessibility &&
      typeof accessibility === 'object' &&
      'disableLoadingPhrases' in (accessibility as Record<string, unknown>)
    ) {
      return 2;
    }
  }

  // Check for V2: context.fileFiltering.disableFuzzySearch
  const context = obj['context'];
  if (context && typeof context === 'object' && context !== null) {
    const fileFiltering = (context as Record<string, unknown>)['fileFiltering'];
    if (
      fileFiltering &&
      typeof fileFiltering === 'object' &&
      'disableFuzzySearch' in (fileFiltering as Record<string, unknown>)
    ) {
      return 2;
    }
  }

  // Check for V2: model.generationConfig.disableCacheControl
  const model = obj['model'];
  if (model && typeof model === 'object' && model !== null) {
    const generationConfig = (model as Record<string, unknown>)[
      'generationConfig'
    ];
    if (
      generationConfig &&
      typeof generationConfig === 'object' &&
      'disableCacheControl' in (generationConfig as Record<string, unknown>)
    ) {
      return 2;
    }
  }

  // Default to V1 for flat structure or unknown format
  return 1;
}

/**
 * Creates a migration pipeline that chains multiple migrations together.
 *
 * The pipeline will:
 * 1. Detect the current version of the input
 * 2. Apply migrations sequentially from current version to target version
 * 3. Aggregate changes and warnings from all steps
 *
 * @param migrations - Array of migration functions in version order (V1→V2, V2→V3, etc.)
 * @returns A pipeline function that migrates from any version to the latest
 */
export function createPipeline(
  migrations: Array<Migration<unknown, unknown>>,
): (input: unknown) => MigrationResult<unknown> {
  return (input: unknown): MigrationResult<unknown> => {
    const startVersion = detectVersion(input);

    // If already at latest version, return as-is
    if (startVersion >= LATEST_VERSION) {
      return {
        success: true,
        data: input,
        version: startVersion,
        changes: [],
        warnings: [],
      };
    }

    // Calculate which migrations to apply
    // migrations[0] = V1→V2, migrations[1] = V2→V3, etc.
    const startIndex = startVersion - 1;
    const migrationsToApply = migrations.slice(startIndex);

    let currentData: unknown = input;
    const allChanges: MigrationChange[] = [];
    const allWarnings: string[] = [];
    let currentVersion = startVersion;

    for (const migrate of migrationsToApply) {
      const result = migrate(currentData);

      if (!result.success) {
        return {
          success: false,
          data: currentData,
          version: currentVersion,
          changes: allChanges,
          warnings: [...allWarnings, ...result.warnings],
        };
      }

      currentData = result.data;
      currentVersion = result.version;
      allChanges.push(...result.changes);
      allWarnings.push(...result.warnings);
    }

    return {
      success: true,
      data: currentData,
      version: currentVersion,
      changes: allChanges,
      warnings: allWarnings,
    };
  };
}

/**
 * Creates a single migration step that transforms data from one version to the next.
 *
 * This is a helper function to ensure consistent migration result format.
 *
 * @param fromVersion - The source version number
 * @param toVersion - The target version number
 * @param transform - The transformation function
 * @returns A migration function with proper result wrapping
 */
export function createMigrationStep<VFrom, VTo>(
  fromVersion: number,
  toVersion: number,
  transform: (
    data: VFrom,
    addChange: (change: MigrationChange) => void,
    addWarning: (warning: string) => void,
  ) => VTo,
): Migration<VFrom, VTo> {
  return (from: VFrom): MigrationResult<VTo> => {
    const changes: MigrationChange[] = [];
    const warnings: string[] = [];

    try {
      const result = transform(
        from,
        (change) => changes.push(change),
        (warning) => warnings.push(warning),
      );

      return {
        success: true,
        data: result,
        version: toVersion,
        changes,
        warnings,
      };
    } catch (error) {
      return {
        success: false,
        data: from as unknown as VTo,
        version: fromVersion,
        changes,
        warnings: [
          ...warnings,
          `Migration from v${fromVersion} to v${toVersion} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      };
    }
  };
}
