/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { V1ToV2Migration } from './v1-to-v2.js';

describe('V1ToV2Migration', () => {
  const migration = new V1ToV2Migration();

  describe('shouldMigrate', () => {
    it('should return true for V1 settings without version and with V1 keys', () => {
      const v1Settings = {
        theme: 'dark',
        model: 'gemini',
      };

      expect(migration.shouldMigrate(v1Settings)).toBe(true);
    });

    it('should return true for V1 settings with disable* keys', () => {
      const v1Settings = {
        disableAutoUpdate: true,
        disableLoadingPhrases: false,
      };

      expect(migration.shouldMigrate(v1Settings)).toBe(true);
    });

    it('should return false for settings with $version field', () => {
      const v2Settings = {
        $version: 2,
        ui: { theme: 'dark' },
      };

      expect(migration.shouldMigrate(v2Settings)).toBe(false);
    });

    it('should return false for V3 settings', () => {
      const v3Settings = {
        $version: 3,
        general: { enableAutoUpdate: true },
      };

      expect(migration.shouldMigrate(v3Settings)).toBe(false);
    });

    it('should return false for settings without V1 indicator keys', () => {
      const unknownSettings = {
        customKey: 'value',
        anotherKey: 123,
      };

      expect(migration.shouldMigrate(unknownSettings)).toBe(false);
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
    it('should migrate flat V1 keys to nested V2 structure', () => {
      const v1Settings = {
        theme: 'dark',
        model: 'gemini',
        autoAccept: true,
        hideTips: false,
      };

      const { settings: result } = migration.migrate(v1Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(2);
      expect(result['ui']).toEqual({ theme: 'dark', hideTips: false });
      expect(result['model']).toEqual({ name: 'gemini' });
      expect(result['tools']).toEqual({ autoAccept: true });
    });

    it('should migrate disable* keys to nested V2 paths without inversion', () => {
      const v1Settings = {
        theme: 'light',
        disableAutoUpdate: true,
        disableLoadingPhrases: false,
      };

      const { settings: result } = migration.migrate(v1Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(2);
      expect(result['general']).toEqual({ disableAutoUpdate: true });
      expect(result['ui']).toEqual({
        theme: 'light',
        accessibility: { disableLoadingPhrases: false },
      });
    });

    it('should normalize consolidated disable* non-boolean values to false', () => {
      const v1Settings = {
        theme: 'dark',
        disableAutoUpdate: 'false',
        disableUpdateNag: null,
      };

      const { settings: result } = migration.migrate(v1Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(2);
      expect(result['general']).toEqual({
        disableAutoUpdate: false,
        disableUpdateNag: false,
      });
    });

    it('should drop non-boolean non-consolidated disable* values', () => {
      const v1Settings = {
        theme: 'dark',
        disableLoadingPhrases: 'TRUE',
        disableFuzzySearch: 1,
      };

      const { settings: result } = migration.migrate(v1Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(2);
      expect(
        (result['ui'] as Record<string, unknown>)?.['accessibility'],
      ).toBeUndefined();
      expect(
        (
          (result['context'] as Record<string, unknown>)?.[
            'fileFiltering'
          ] as Record<string, unknown>
        )?.['disableFuzzySearch'],
      ).toBeUndefined();
    });

    it('should preserve mcpServers at top level', () => {
      const v1Settings = {
        theme: 'dark',
        mcpServers: {
          myServer: { command: 'node', args: ['server.js'] },
        },
      };

      const { settings: result } = migration.migrate(v1Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(2);
      expect(result['mcpServers']).toEqual({
        myServer: { command: 'node', args: ['server.js'] },
      });
    });

    it('should preserve unrecognized keys', () => {
      const v1Settings = {
        theme: 'dark',
        myCustomSetting: 'value',
        anotherCustom: 123,
      };

      const { settings: result } = migration.migrate(v1Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(2);
      expect(result['myCustomSetting']).toBe('value');
      expect(result['anotherCustom']).toBe(123);
    });

    it('should preserve non-object parent path values on collision', () => {
      const v1Settings = {
        theme: 'dark',
        disableAutoUpdate: true,
        ui: 'legacy-ui-string',
        general: 'legacy-general-string',
      };

      const { settings: result } = migration.migrate(v1Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(2);
      expect(result['ui']).toBe('legacy-ui-string');
      expect(result['general']).toBe('legacy-general-string');
    });

    it('should not modify the input object', () => {
      const v1Settings = {
        theme: 'dark',
        model: 'gemini',
      };

      const { settings: result } = migration.migrate(v1Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(v1Settings).toEqual({ theme: 'dark', model: 'gemini' });
      expect(result).not.toBe(v1Settings);
    });

    it('should throw error for non-object input', () => {
      expect(() => migration.migrate(null, 'user')).toThrow(
        'Settings must be an object',
      );
      expect(() => migration.migrate('string', 'user')).toThrow(
        'Settings must be an object',
      );
    });

    it('should handle empty V1 settings', () => {
      const v1Settings = {
        theme: 'dark',
      };

      const { settings: result } = migration.migrate(v1Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(2);
      expect(result['ui']).toEqual({ theme: 'dark' });
    });

    it('should correctly handle all V1 indicator keys', () => {
      const v1Settings = {
        theme: 'dark',
        model: 'gemini',
        autoAccept: true,
        hideTips: false,
        vimMode: true,
        checkpointing: false,
        telemetry: {},
        accessibility: {},
        extensions: [],
        mcpServers: {},
      };

      const { settings: result } = migration.migrate(v1Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(2);
    });
  });

  describe('version properties', () => {
    it('should have correct fromVersion', () => {
      expect(migration.fromVersion).toBe(1);
    });

    it('should have correct toVersion', () => {
      expect(migration.toVersion).toBe(2);
    });
  });
});
