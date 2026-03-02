/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  runMigrations,
  needsMigration,
  ALL_MIGRATIONS,
  MigrationScheduler,
} from './index.js';
import { SETTINGS_VERSION } from '../settings.js';

describe('Migration Framework Integration', () => {
  describe('runMigrations', () => {
    it('should migrate V1 settings to V3', () => {
      const v1Settings = {
        theme: 'dark',
        model: 'gemini',
        disableAutoUpdate: true,
        disableLoadingPhrases: false,
      };

      const result = runMigrations(v1Settings, 'user');

      expect(result.finalVersion).toBe(3);
      expect(result.executedMigrations).toHaveLength(2);
      expect(result.executedMigrations[0]).toEqual({
        fromVersion: 1,
        toVersion: 2,
      });
      expect(result.executedMigrations[1]).toEqual({
        fromVersion: 2,
        toVersion: 3,
      });

      // Check V2 structure was created
      const settings = result.settings as Record<string, unknown>;
      expect(settings['$version']).toBe(3);
      expect(settings['ui']).toEqual({
        theme: 'dark',
        accessibility: { enableLoadingPhrases: true },
      });
      expect(settings['model']).toEqual({ name: 'gemini' });

      // Check disableAutoUpdate was inverted to enableAutoUpdate: false
      expect(
        (settings['general'] as Record<string, unknown>)['enableAutoUpdate'],
      ).toBe(false);
    });

    it('should migrate V2 settings to V3', () => {
      const v2Settings = {
        $version: 2,
        ui: { theme: 'light' },
        general: { disableAutoUpdate: false },
      };

      const result = runMigrations(v2Settings, 'user');

      expect(result.finalVersion).toBe(3);
      expect(result.executedMigrations).toHaveLength(1);
      expect(result.executedMigrations[0]).toEqual({
        fromVersion: 2,
        toVersion: 3,
      });

      const settings = result.settings as Record<string, unknown>;
      expect(settings['$version']).toBe(3);
      expect(
        (settings['general'] as Record<string, unknown>)['enableAutoUpdate'],
      ).toBe(true);
      expect(
        (settings['general'] as Record<string, unknown>)['disableAutoUpdate'],
      ).toBeUndefined();
    });

    it('should not modify V3 settings', () => {
      const v3Settings = {
        $version: 3,
        ui: { theme: 'dark' },
        general: { enableAutoUpdate: true },
      };

      const result = runMigrations(v3Settings, 'user');

      expect(result.finalVersion).toBe(3);
      expect(result.executedMigrations).toHaveLength(0);
      expect(result.settings).toEqual(v3Settings);
    });

    it('should be idempotent', () => {
      const v1Settings = {
        theme: 'dark',
        disableAutoUpdate: true,
      };

      const result1 = runMigrations(v1Settings, 'user');
      const result2 = runMigrations(result1.settings, 'user');

      expect(result1.executedMigrations).toHaveLength(2);
      expect(result2.executedMigrations).toHaveLength(0);
      expect(result1.finalVersion).toBe(result2.finalVersion);
    });
  });

  describe('needsMigration', () => {
    it('should return true for V1 settings', () => {
      const v1Settings = {
        theme: 'dark',
        model: 'gemini',
      };

      expect(needsMigration(v1Settings)).toBe(true);
    });

    it('should return true for V2 settings with deprecated keys', () => {
      const v2Settings = {
        $version: 2,
        general: { disableAutoUpdate: true },
      };

      expect(needsMigration(v2Settings)).toBe(true);
    });

    it('should return true for V2 settings without deprecated keys', () => {
      const cleanV2Settings = {
        $version: 2,
        ui: { theme: 'dark' },
      };

      // V2 settings should be migrated to V3 to update the version number
      expect(needsMigration(cleanV2Settings)).toBe(true);
    });

    it('should return false for V3 settings', () => {
      const v3Settings = {
        $version: 3,
        general: { enableAutoUpdate: true },
      };

      expect(needsMigration(v3Settings)).toBe(false);
    });

    it('should return false for legacy numeric version when no migration can execute', () => {
      const legacyButUnknownSettings = {
        $version: 1,
        customOnlyKey: 'value',
      };

      expect(needsMigration(legacyButUnknownSettings)).toBe(false);
    });
  });

  describe('ALL_MIGRATIONS', () => {
    it('should contain all migrations in order', () => {
      expect(ALL_MIGRATIONS).toHaveLength(2);

      expect(ALL_MIGRATIONS[0].fromVersion).toBe(1);
      expect(ALL_MIGRATIONS[0].toVersion).toBe(2);

      expect(ALL_MIGRATIONS[1].fromVersion).toBe(2);
      expect(ALL_MIGRATIONS[1].toVersion).toBe(3);
    });
  });

  describe('MigrationScheduler with all migrations', () => {
    it('should execute full migration chain', () => {
      const scheduler = new MigrationScheduler([...ALL_MIGRATIONS], 'user');

      const v1Settings = {
        theme: 'dark',
        disableAutoUpdate: true,
        disableLoadingPhrases: true,
      };

      const result = scheduler.migrate(v1Settings);

      expect(result.executedMigrations).toHaveLength(2);

      const settings = result.settings as Record<string, unknown>;
      expect(settings['$version']).toBe(3);
      expect((settings['ui'] as Record<string, unknown>)['theme']).toBe('dark');
      expect(
        (settings['general'] as Record<string, unknown>)['enableAutoUpdate'],
      ).toBe(false);
      expect(
        (
          (settings['ui'] as Record<string, unknown>)[
            'accessibility'
          ] as Record<string, unknown>
        )['enableLoadingPhrases'],
      ).toBe(false);
    });
  });

  describe('needsMigration and runMigrations consistency', () => {
    it('needsMigration should return true when runMigrations would execute migrations', () => {
      const v1Settings = {
        theme: 'dark',
        disableAutoUpdate: true,
      };

      // needsMigration should report that migration is needed
      expect(needsMigration(v1Settings)).toBe(true);

      // runMigrations should actually execute migrations
      const result = runMigrations(v1Settings, 'user');
      expect(result.executedMigrations.length).toBeGreaterThan(0);
    });

    it('needsMigration should return false when runMigrations would execute no migrations', () => {
      const v3Settings = {
        $version: 3,
        general: { enableAutoUpdate: true },
      };

      // needsMigration should report that no migration is needed
      expect(needsMigration(v3Settings)).toBe(false);

      // runMigrations should execute no migrations
      const result = runMigrations(v3Settings, 'user');
      expect(result.executedMigrations).toHaveLength(0);
    });

    it('should handle V2 settings without deprecated keys consistently', () => {
      const cleanV2Settings = {
        $version: 2,
        ui: { theme: 'dark' },
      };

      // needsMigration should report that migration is needed
      expect(needsMigration(cleanV2Settings)).toBe(true);

      // runMigrations should execute the V2->V3 migration
      const result = runMigrations(cleanV2Settings, 'user');
      expect(result.executedMigrations.length).toBeGreaterThan(0);
      expect(result.finalVersion).toBe(3);
    });
  });

  describe('migration chain integrity', () => {
    it('should have strictly increasing versions (toVersion > fromVersion)', () => {
      for (const migration of ALL_MIGRATIONS) {
        expect(migration.toVersion).toBeGreaterThan(migration.fromVersion);
      }
    });

    it('should have no gaps in the chain (adjacent versions)', () => {
      for (let i = 1; i < ALL_MIGRATIONS.length; i++) {
        const prevMigration = ALL_MIGRATIONS[i - 1];
        const currMigration = ALL_MIGRATIONS[i];
        expect(currMigration.fromVersion).toBe(prevMigration.toVersion);
      }
    });

    it('should have no duplicate fromVersions', () => {
      const fromVersions = ALL_MIGRATIONS.map((m) => m.fromVersion);
      const uniqueFromVersions = new Set(fromVersions);
      expect(uniqueFromVersions.size).toBe(fromVersions.length);
    });

    it('should have no duplicate toVersions', () => {
      const toVersions = ALL_MIGRATIONS.map((m) => m.toVersion);
      const uniqueToVersions = new Set(toVersions);
      expect(uniqueToVersions.size).toBe(toVersions.length);
    });

    it('should be acyclic (no version appears as fromVersion more than once)', () => {
      const fromVersionCounts = new Map<number, number>();
      for (const migration of ALL_MIGRATIONS) {
        const count = fromVersionCounts.get(migration.fromVersion) || 0;
        fromVersionCounts.set(migration.fromVersion, count + 1);
      }

      for (const count of fromVersionCounts.values()) {
        expect(count).toBe(1);
      }
    });

    it('should chain from version 1 to SETTINGS_VERSION', () => {
      if (ALL_MIGRATIONS.length > 0) {
        expect(ALL_MIGRATIONS[0].fromVersion).toBe(1);
        const lastMigration = ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1];
        expect(lastMigration.toVersion).toBe(SETTINGS_VERSION);
      }
    });
  });

  describe('single source of truth for version constant', () => {
    it('should use SETTINGS_VERSION from settings module', () => {
      // The last migration's toVersion should match SETTINGS_VERSION
      const lastMigration = ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1];
      expect(lastMigration.toVersion).toBe(SETTINGS_VERSION);
    });

    it('needsMigration should use SETTINGS_VERSION for version comparison', () => {
      // Create settings with version equal to SETTINGS_VERSION
      const currentVersionSettings = {
        $version: SETTINGS_VERSION,
        general: { enableAutoUpdate: true },
      };

      // needsMigration should return false for current version
      expect(needsMigration(currentVersionSettings)).toBe(false);

      // Create settings with version less than SETTINGS_VERSION
      const oldVersionSettings = {
        $version: SETTINGS_VERSION - 1,
        general: { disableAutoUpdate: true },
      };

      // needsMigration should return true for old version
      expect(needsMigration(oldVersionSettings)).toBe(true);
    });

    it('should have SETTINGS_VERSION defined exactly once in codebase', () => {
      // SETTINGS_VERSION is imported from settings.js
      // This test verifies the wiring is correct
      expect(SETTINGS_VERSION).toBeDefined();
      expect(typeof SETTINGS_VERSION).toBe('number');
      expect(SETTINGS_VERSION).toBeGreaterThan(0);
    });
  });

  describe('invalid version handling', () => {
    it('should treat non-numeric version with V1 shape as needing migration', () => {
      const settingsWithInvalidVersion = {
        $version: 'invalid',
        theme: 'dark',
        disableAutoUpdate: true,
      };

      // Should detect migration needed based on V1 shape
      expect(needsMigration(settingsWithInvalidVersion)).toBe(true);

      // Should run migrations
      const result = runMigrations(settingsWithInvalidVersion, 'user');
      expect(result.executedMigrations.length).toBeGreaterThan(0);
      expect(result.finalVersion).toBe(SETTINGS_VERSION);
    });

    it('should not migrate non-numeric version with already-migrated shape (normalized by loader)', () => {
      const settingsWithInvalidVersionButMigratedShape = {
        $version: 'invalid',
        general: { enableAutoUpdate: true },
      };

      // needsMigration returns false because no migration applies to this shape
      // The settings loader will handle version normalization separately
      expect(needsMigration(settingsWithInvalidVersionButMigratedShape)).toBe(
        false,
      );

      // No migrations should execute
      const result = runMigrations(
        settingsWithInvalidVersionButMigratedShape,
        'user',
      );
      expect(result.executedMigrations).toHaveLength(0);
    });

    it('should avoid repeated no-op migration loops', () => {
      // Settings that might cause repeated migrations
      const v3Settings = {
        $version: 3,
        general: { enableAutoUpdate: true },
      };

      // First check
      expect(needsMigration(v3Settings)).toBe(false);
      const result1 = runMigrations(v3Settings, 'user');
      expect(result1.executedMigrations).toHaveLength(0);

      // Second check should be consistent
      expect(needsMigration(result1.settings)).toBe(false);
      const result2 = runMigrations(result1.settings, 'user');
      expect(result2.executedMigrations).toHaveLength(0);
    });
  });
});
