/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { V2ToV3Migration } from './v2-to-v3.js';

describe('V2ToV3Migration', () => {
  const migration = new V2ToV3Migration();

  describe('shouldMigrate', () => {
    it('should return true for V2 settings with deprecated disable* keys', () => {
      const v2Settings = {
        $version: 2,
        general: { disableAutoUpdate: true },
      };

      expect(migration.shouldMigrate(v2Settings)).toBe(true);
    });

    it('should return true for V2 settings with ui.accessibility.disableLoadingPhrases', () => {
      const v2Settings = {
        $version: 2,
        ui: { accessibility: { disableLoadingPhrases: false } },
      };

      expect(migration.shouldMigrate(v2Settings)).toBe(true);
    });

    it('should return false for V3 settings', () => {
      const v3Settings = {
        $version: 3,
        general: { enableAutoUpdate: true },
      };

      expect(migration.shouldMigrate(v3Settings)).toBe(false);
    });

    it('should return false for V1 settings without version', () => {
      const v1Settings = {
        theme: 'dark',
        disableAutoUpdate: true,
      };

      expect(migration.shouldMigrate(v1Settings)).toBe(false);
    });

    it('should return true for V2 settings without deprecated keys', () => {
      const cleanV2Settings = {
        $version: 2,
        ui: { theme: 'dark' },
        general: { enableAutoUpdate: true },
      };

      // V2 settings should always be migrated to V3 to update the version number
      expect(migration.shouldMigrate(cleanV2Settings)).toBe(true);
    });

    it('should return false for null input', () => {
      expect(migration.shouldMigrate(null)).toBe(false);
    });

    it('should return false for non-object input', () => {
      expect(migration.shouldMigrate('string')).toBe(false);
      expect(migration.shouldMigrate(123)).toBe(false);
    });
  });

  describe('migrate', () => {
    it('should migrate disableAutoUpdate to enableAutoUpdate with inverted value', () => {
      const v2Settings = {
        $version: 2,
        general: { disableAutoUpdate: true },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['general'] as Record<string, unknown>)['enableAutoUpdate'],
      ).toBe(false);
      expect(
        (result['general'] as Record<string, unknown>)['disableAutoUpdate'],
      ).toBeUndefined();
    });

    it('should migrate disableLoadingPhrases to enableLoadingPhrases', () => {
      const v2Settings = {
        $version: 2,
        ui: { accessibility: { disableLoadingPhrases: true } },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['ui'] as Record<string, unknown>)['accessibility'],
      ).toEqual({
        enableLoadingPhrases: false,
      });
    });

    it('should migrate disableFuzzySearch to enableFuzzySearch', () => {
      const v2Settings = {
        $version: 2,
        context: { fileFiltering: { disableFuzzySearch: false } },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['context'] as Record<string, unknown>)['fileFiltering'],
      ).toEqual({
        enableFuzzySearch: true,
      });
    });

    it('should migrate disableCacheControl to enableCacheControl', () => {
      const v2Settings = {
        $version: 2,
        model: { generationConfig: { disableCacheControl: true } },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['model'] as Record<string, unknown>)['generationConfig'],
      ).toEqual({
        enableCacheControl: false,
      });
    });

    it('should handle consolidated disableAutoUpdate and disableUpdateNag', () => {
      const v2Settings = {
        $version: 2,
        general: {
          disableAutoUpdate: true,
          disableUpdateNag: false,
        },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      // If ANY disable* is true, enable should be false
      expect(
        (result['general'] as Record<string, unknown>)['enableAutoUpdate'],
      ).toBe(false);
      expect(
        (result['general'] as Record<string, unknown>)['disableAutoUpdate'],
      ).toBeUndefined();
      expect(
        (result['general'] as Record<string, unknown>)['disableUpdateNag'],
      ).toBeUndefined();
    });

    it('should set enableAutoUpdate to true when both disable* are false', () => {
      const v2Settings = {
        $version: 2,
        general: {
          disableAutoUpdate: false,
          disableUpdateNag: false,
        },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['general'] as Record<string, unknown>)['enableAutoUpdate'],
      ).toBe(true);
    });

    it('should preserve other settings during migration', () => {
      const v2Settings = {
        $version: 2,
        ui: {
          theme: 'dark',
          accessibility: { disableLoadingPhrases: true },
        },
        model: {
          name: 'gemini',
        },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect((result['ui'] as Record<string, unknown>)['theme']).toBe('dark');
      expect((result['model'] as Record<string, unknown>)['name']).toBe(
        'gemini',
      );
      expect(
        (result['ui'] as Record<string, unknown>)['accessibility'],
      ).toEqual({
        enableLoadingPhrases: false,
      });
    });

    it('should not modify the input object', () => {
      const v2Settings = {
        $version: 2,
        general: { disableAutoUpdate: true },
      };

      const result = migration.migrate(v2Settings, 'user');

      expect(v2Settings.general).toEqual({ disableAutoUpdate: true });
      expect(result).not.toBe(v2Settings);
    });

    it('should throw error for non-object input', () => {
      expect(() => migration.migrate(null, 'user')).toThrow(
        'Settings must be an object',
      );
      expect(() => migration.migrate('string', 'user')).toThrow(
        'Settings must be an object',
      );
    });

    it('should handle multiple deprecated keys in one migration', () => {
      const v2Settings = {
        $version: 2,
        general: { disableAutoUpdate: false },
        ui: { accessibility: { disableLoadingPhrases: false } },
        context: { fileFiltering: { disableFuzzySearch: false } },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['general'] as Record<string, unknown>)['enableAutoUpdate'],
      ).toBe(true);
      expect(
        (result['ui'] as Record<string, unknown>)['accessibility'],
      ).toEqual({
        enableLoadingPhrases: true,
      });
      expect(
        (result['context'] as Record<string, unknown>)['fileFiltering'],
      ).toEqual({
        enableFuzzySearch: true,
      });
    });

    it('should preserve string "true" without creating enable key', () => {
      const v2Settings = {
        $version: 2,
        general: { disableAutoUpdate: 'true' },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['general'] as Record<string, unknown>)['disableAutoUpdate'],
      ).toBe('true');
      expect(
        (result['general'] as Record<string, unknown>)['enableAutoUpdate'],
      ).toBeUndefined();
    });

    it('should preserve string "false" without creating enable key', () => {
      const v2Settings = {
        $version: 2,
        general: { disableAutoUpdate: 'false' },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['general'] as Record<string, unknown>)['disableAutoUpdate'],
      ).toBe('false');
      expect(
        (result['general'] as Record<string, unknown>)['enableAutoUpdate'],
      ).toBeUndefined();
    });

    it('should preserve string "TRUE" without creating enable key', () => {
      const v2Settings = {
        $version: 2,
        general: { disableAutoUpdate: 'TRUE' },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['general'] as Record<string, unknown>)['disableAutoUpdate'],
      ).toBe('TRUE');
    });

    it('should preserve string "FALSE" without creating enable key', () => {
      const v2Settings = {
        $version: 2,
        general: { disableAutoUpdate: 'FALSE' },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['general'] as Record<string, unknown>)['disableAutoUpdate'],
      ).toBe('FALSE');
    });

    it('should preserve number value and not create enable key', () => {
      const v2Settings = {
        $version: 2,
        general: { disableAutoUpdate: 123 },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['general'] as Record<string, unknown>)['disableAutoUpdate'],
      ).toBe(123);
      expect(
        (result['general'] as Record<string, unknown>)['enableAutoUpdate'],
      ).toBeUndefined();
    });

    it('should preserve invalid string value and not create enable key', () => {
      const v2Settings = {
        $version: 2,
        general: { disableAutoUpdate: 'invalid-string' },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['general'] as Record<string, unknown>)['disableAutoUpdate'],
      ).toBe('invalid-string');
      expect(
        (result['general'] as Record<string, unknown>)['enableAutoUpdate'],
      ).toBeUndefined();
    });

    it('should preserve disableCacheControl string "true"', () => {
      const v2Settings = {
        $version: 2,
        model: { generationConfig: { disableCacheControl: 'true' } },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['model'] as Record<string, unknown>)['generationConfig'],
      ).toEqual({
        disableCacheControl: 'true',
      });
    });

    it('should preserve disableCacheControl string "false"', () => {
      const v2Settings = {
        $version: 2,
        model: { generationConfig: { disableCacheControl: 'false' } },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['model'] as Record<string, unknown>)['generationConfig'],
      ).toEqual({
        disableCacheControl: 'false',
      });
    });

    it('should preserve disableCacheControl number value and not create enable key', () => {
      const v2Settings = {
        $version: 2,
        model: { generationConfig: { disableCacheControl: 456 } },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['model'] as Record<string, unknown>)['generationConfig'],
      ).toEqual({ disableCacheControl: 456 });
      expect(
        (
          (result['model'] as Record<string, unknown>)[
            'generationConfig'
          ] as Record<string, unknown>
        )['enableCacheControl'],
      ).toBeUndefined();
    });

    it('should handle mixed valid and invalid disableAutoUpdate and disableUpdateNag', () => {
      const v2Settings = {
        $version: 2,
        general: {
          disableAutoUpdate: true,
          disableUpdateNag: 'invalid',
        },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      // Only valid values should contribute to the consolidated result
      // Since disableAutoUpdate is true, enableAutoUpdate should be false
      expect(
        (result['general'] as Record<string, unknown>)['enableAutoUpdate'],
      ).toBe(false);
      expect(
        (result['general'] as Record<string, unknown>)['disableAutoUpdate'],
      ).toBeUndefined();
      expect(
        (result['general'] as Record<string, unknown>)['disableUpdateNag'],
      ).toBe('invalid');
    });

    it('should preserve object value for disable key', () => {
      const v2Settings = {
        $version: 2,
        general: { disableAutoUpdate: { nested: 'value' } },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['general'] as Record<string, unknown>)['disableAutoUpdate'],
      ).toEqual({ nested: 'value' });
      expect(
        (result['general'] as Record<string, unknown>)['enableAutoUpdate'],
      ).toBeUndefined();
    });

    it('should preserve array value for disable key', () => {
      const v2Settings = {
        $version: 2,
        general: { disableAutoUpdate: [1, 2, 3] },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['general'] as Record<string, unknown>)['disableAutoUpdate'],
      ).toEqual([1, 2, 3]);
      expect(
        (result['general'] as Record<string, unknown>)['enableAutoUpdate'],
      ).toBeUndefined();
    });

    it('should preserve null value for disable key', () => {
      const v2Settings = {
        $version: 2,
        general: { disableAutoUpdate: null },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['general'] as Record<string, unknown>)['disableAutoUpdate'],
      ).toBeNull();
      expect(
        (result['general'] as Record<string, unknown>)['enableAutoUpdate'],
      ).toBeUndefined();
    });
  });

  describe('version properties', () => {
    it('should have correct fromVersion', () => {
      expect(migration.fromVersion).toBe(2);
    });

    it('should have correct toVersion', () => {
      expect(migration.toVersion).toBe(3);
    });
  });
});
