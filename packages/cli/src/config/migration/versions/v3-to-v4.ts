/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsMigration } from '../types.js';
import {
  getNestedProperty,
  setNestedPropertySafe,
} from '../../../utils/settingsUtils.js';

const GIT_CO_AUTHOR_PATH = 'general.gitCoAuthor';

/**
 * V3 -> V4 migration (gitCoAuthor boolean → object expansion).
 *
 * Before V4, `general.gitCoAuthor` was a single boolean that governed both
 * commit message attribution and PR body attribution. V4 splits those into
 * two independent sub-toggles so users can disable one without losing the
 * other. This migration rewrites any stored boolean into `{ commit: v,
 * pr: v }` so the user's prior choice carries over to both new toggles and
 * the settings dialog reads the expected object shape.
 *
 * Compatibility strategy:
 * - Boolean values are expanded in place.
 * - Object values with `commit`/`pr` keys are left untouched (forward-
 *   compatible — a user who edited their settings.json by hand to the new
 *   shape is already on V4-equivalent data).
 * - Any other present value (string, number, array, null) is dropped with
 *   a warning so the caller sees an actionable message.
 */
export class V3ToV4Migration implements SettingsMigration {
  readonly fromVersion = 3;
  readonly toVersion = 4;

  shouldMigrate(settings: unknown): boolean {
    if (typeof settings !== 'object' || settings === null) {
      return false;
    }
    const s = settings as Record<string, unknown>;
    if (s['$version'] === 3) {
      return true;
    }
    // Versionless settings file (no $version key): the V1/V2 migrations
    // don't list `gitCoAuthor` as an indicator key (it post-dates them),
    // so a settings file with ONLY this shape wouldn't trigger any
    // earlier migration. Catch it here so:
    //   - legacy boolean (`gitCoAuthor: false`) gets expanded to
    //     `{commit: false, pr: false}` instead of being silently
    //     overwritten by the dialog's schema defaults on first save;
    //   - invalid shapes (`gitCoAuthor: "off"`, `gitCoAuthor: []`,
    //     etc.) get reset by the migrate() body's drop-and-warn path
    //     so runtime normalization doesn't quietly re-enable
    //     attribution against the user's intent.
    if (s['$version'] === undefined) {
      const value = getNestedProperty(s, GIT_CO_AUTHOR_PATH);
      if (value === undefined) return false;
      // Already in the v4 shape — leave the loader to stamp $version: 4.
      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
      ) {
        return false;
      }
      // Anything else (boolean, string, number, array, null) needs
      // rewriting via migrate().
      return true;
    }
    return false;
  }

  migrate(
    settings: unknown,
    scope: string,
  ): { settings: unknown; warnings: string[] } {
    if (typeof settings !== 'object' || settings === null) {
      throw new Error('Settings must be an object');
    }

    const result = structuredClone(settings) as Record<string, unknown>;
    const warnings: string[] = [];

    const value = getNestedProperty(result, GIT_CO_AUTHOR_PATH);

    if (typeof value === 'boolean') {
      // Legacy shape — rewrite as { commit, pr } preserving the prior choice.
      setNestedPropertySafe(result, GIT_CO_AUTHOR_PATH, {
        commit: value,
        pr: value,
      });
    } else if (typeof value === 'string') {
      // String forms: a user who hand-edited `"gitCoAuthor": "off"` (or
      // similar) to disable the feature must NOT see attribution
      // silently re-enable just because we couldn't parse the literal
      // shape. Map disable-intent strings to `{commit: false, pr: false}`,
      // enable-intent strings to `{commit: true, pr: true}`, and
      // anything else to disabled with a warning (safer-by-default
      // than enabling against an ambiguous opt-out).
      const lowered = value.trim().toLowerCase();
      const disableIntent = ['false', 'no', 'off', '0', 'disabled', ''];
      const enableIntent = ['true', 'yes', 'on', '1', 'enabled'];
      if (enableIntent.includes(lowered)) {
        setNestedPropertySafe(result, GIT_CO_AUTHOR_PATH, {
          commit: true,
          pr: true,
        });
      } else if (disableIntent.includes(lowered)) {
        setNestedPropertySafe(result, GIT_CO_AUTHOR_PATH, {
          commit: false,
          pr: false,
        });
      } else {
        setNestedPropertySafe(result, GIT_CO_AUTHOR_PATH, {
          commit: false,
          pr: false,
        });
        warnings.push(
          `Reset '${GIT_CO_AUTHOR_PATH}' in ${scope} settings to {commit: false, pr: false} because the stored string '${value}' was not a recognized boolean form.`,
        );
      }
    } else if (
      value !== undefined &&
      (typeof value !== 'object' || value === null || Array.isArray(value))
    ) {
      // Invalid non-string shape (number, array, null). Drop and
      // disable rather than re-enable on ambiguity — same
      // safer-by-default contract as `pickBool` at runtime.
      setNestedPropertySafe(result, GIT_CO_AUTHOR_PATH, {
        commit: false,
        pr: false,
      });
      warnings.push(
        `Reset '${GIT_CO_AUTHOR_PATH}' in ${scope} settings to {commit: false, pr: false} because the stored value was not a boolean or object.`,
      );
    }
    // Object values (including the new shape) pass through unchanged.

    result['$version'] = 4;

    return { settings: result, warnings };
  }
}

export const v3ToV4Migration = new V3ToV4Migration();
