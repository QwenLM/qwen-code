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

    // `gitCoAuthor` post-dates the V1 indicator-key list, so a settings
    // file that has ONLY this legacy boolean shape (no `$version`,
    // no other migration-triggering keys) wouldn't fire any earlier
    // migration. The v3→v4 step must catch it directly so the dialog
    // doesn't silently overwrite the user's stored opt-out with the
    // schema defaults on next save.
    it('returns true for versionless settings with legacy boolean gitCoAuthor', () => {
      expect(
        migration.shouldMigrate({
          general: { gitCoAuthor: false },
        }),
      ).toBe(true);
    });

    it('returns false for versionless settings without gitCoAuthor', () => {
      expect(migration.shouldMigrate({ general: {} })).toBe(false);
      expect(migration.shouldMigrate({})).toBe(false);
    });

    it('returns false for versionless settings with already-object gitCoAuthor', () => {
      // User who hand-edited to the v4 shape — let the loader's
      // version normalization handle it without rewriting.
      expect(
        migration.shouldMigrate({
          general: { gitCoAuthor: { commit: false, pr: true } },
        }),
      ).toBe(false);
    });

    // Without the migration firing on invalid versionless values, the
    // loader would stamp $version: 4 with `"off"` / `[]` / etc. left
    // on disk, and runtime normalization would silently re-enable
    // attribution. The migrate() body's drop-and-warn handles these
    // — shouldMigrate has to fire so it gets a chance to run.
    it.each([
      ['"off"', 'off'],
      ['empty array', []],
      ['number', 42],
      ['null', null],
    ])(
      'returns true for versionless settings with invalid gitCoAuthor (%s)',
      (_label, value) => {
        expect(
          migration.shouldMigrate({
            general: { gitCoAuthor: value },
          }),
        ).toBe(true);
      },
    );
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

    // String enable-intent forms map to {commit: true, pr: true};
    // disable-intent forms map to {commit: false, pr: false}; an
    // unrecognised string also defaults to disabled (safer-by-default
    // — same contract as the runtime `pickBool`) but emits a warning.
    it.each([
      ['"true"', 'true', { commit: true, pr: true }, false],
      ['"yes"', 'yes', { commit: true, pr: true }, false],
      ['"on"', 'on', { commit: true, pr: true }, false],
      ['"1"', '1', { commit: true, pr: true }, false],
      ['"false"', 'false', { commit: false, pr: false }, false],
      ['"no"', 'no', { commit: false, pr: false }, false],
      ['"off"', 'off', { commit: false, pr: false }, false],
      ['"0"', '0', { commit: false, pr: false }, false],
      ['empty string', '', { commit: false, pr: false }, false],
      ['"OFF" (case)', 'OFF', { commit: false, pr: false }, false],
      ['unknown string', 'maybe', { commit: false, pr: false }, true],
    ])(
      'maps string %s to %j (warn=%s)',
      (_label, str, expected, expectWarn) => {
        const input = { $version: 3, general: { gitCoAuthor: str } };
        const { settings, warnings } = migration.migrate(input, 'user') as {
          settings: Record<string, unknown>;
          warnings: string[];
        };
        expect(
          (settings['general'] as Record<string, unknown>)['gitCoAuthor'],
        ).toEqual(expected);
        if (expectWarn) {
          expect(warnings).toHaveLength(1);
          expect(warnings[0]).toContain('gitCoAuthor');
        } else {
          expect(warnings).toHaveLength(0);
        }
      },
    );

    // Non-string invalid values (null/array/number) get the
    // safer-by-default disabled state with a warning.
    it.each([
      ['null', null],
      ['array', []],
      ['number', 42],
    ])(
      'treats %s as invalid and resets to disabled with a warning',
      (_label, bad) => {
        const input = { $version: 3, general: { gitCoAuthor: bad } };
        const { settings, warnings } = migration.migrate(input, 'user') as {
          settings: Record<string, unknown>;
          warnings: string[];
        };

        expect(
          (settings['general'] as Record<string, unknown>)['gitCoAuthor'],
        ).toEqual({ commit: false, pr: false });
        expect(warnings).toHaveLength(1);
      },
    );

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
