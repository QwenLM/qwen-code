/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { V3ToV4Migration } from './v3-to-v4.js';

describe('V3ToV4Migration', () => {
  const migration = new V3ToV4Migration();

  describe('shouldMigrate', () => {
    it('returns true for V3 settings', () => {
      expect(
        migration.shouldMigrate({
          $version: 3,
          general: { gitCoAuthor: false },
        }),
      ).toBe(true);
    });

    it('returns true for V3 settings without gitCoAuthor', () => {
      // Even without the relevant key, the version must still bump.
      expect(migration.shouldMigrate({ $version: 3 })).toBe(true);
    });

    it('returns false for V4 settings', () => {
      expect(
        migration.shouldMigrate({
          $version: 4,
          general: { gitCoAuthor: { commit: true, pr: true } },
        }),
      ).toBe(false);
    });

    it('returns false for non-object input', () => {
      expect(migration.shouldMigrate(null)).toBe(false);
      expect(migration.shouldMigrate('x')).toBe(false);
      expect(migration.shouldMigrate(42)).toBe(false);
    });
  });

  describe('migrate', () => {
    it('expands legacy boolean true into { commit: true, pr: true }', () => {
      const input = { $version: 3, general: { gitCoAuthor: true } };
      const { settings, warnings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(
        (settings['general'] as Record<string, unknown>)['gitCoAuthor'],
      ).toEqual({ commit: true, pr: true });
      expect(settings['$version']).toBe(4);
      expect(warnings).toEqual([]);
    });

    it('expands legacy boolean false into { commit: false, pr: false }', () => {
      const input = { $version: 3, general: { gitCoAuthor: false } };
      const { settings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(
        (settings['general'] as Record<string, unknown>)['gitCoAuthor'],
      ).toEqual({ commit: false, pr: false });
    });

    it('leaves an already-object value untouched', () => {
      const input = {
        $version: 3,
        general: { gitCoAuthor: { commit: false, pr: true } },
      };
      const { settings, warnings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(
        (settings['general'] as Record<string, unknown>)['gitCoAuthor'],
      ).toEqual({ commit: false, pr: true });
      expect(warnings).toEqual([]);
    });

    it('bumps version when gitCoAuthor is absent', () => {
      const input = { $version: 3, general: {} };
      const { settings, warnings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(settings['$version']).toBe(4);
      expect(
        (settings['general'] as Record<string, unknown>)['gitCoAuthor'],
      ).toBeUndefined();
      expect(warnings).toEqual([]);
    });

    it('drops invalid values and emits a warning', () => {
      const input = { $version: 3, general: { gitCoAuthor: 'yes' } };
      const { settings, warnings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(
        (settings['general'] as Record<string, unknown>)['gitCoAuthor'],
      ).toEqual({});
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('gitCoAuthor');
      expect(warnings[0]).toContain('user');
    });

    it.each([
      ['null', null],
      ['array', []],
      ['number', 42],
    ])('treats %s as invalid and resets with a warning', (_label, bad) => {
      const input = { $version: 3, general: { gitCoAuthor: bad } };
      const { settings, warnings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(
        (settings['general'] as Record<string, unknown>)['gitCoAuthor'],
      ).toEqual({});
      expect(warnings).toHaveLength(1);
    });

    it('leaves a partially-specified object unchanged', () => {
      // Downstream normalizeGitCoAuthor fills missing sub-keys with defaults;
      // the migration only reshapes, it does not paternalistically fill defaults.
      const input = {
        $version: 3,
        general: { gitCoAuthor: { commit: false } },
      };
      const { settings, warnings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(
        (settings['general'] as Record<string, unknown>)['gitCoAuthor'],
      ).toEqual({ commit: false });
      expect(warnings).toEqual([]);
    });

    it('does not mutate the input settings object', () => {
      const input = { $version: 3, general: { gitCoAuthor: false } };
      migration.migrate(input, 'user');

      expect(input).toEqual({
        $version: 3,
        general: { gitCoAuthor: false },
      });
    });

    it('throws for non-object input', () => {
      expect(() => migration.migrate(null, 'user')).toThrow();
      expect(() => migration.migrate('string', 'user')).toThrow();
    });
  });
});
