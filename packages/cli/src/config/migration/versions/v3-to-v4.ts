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
    return s['$version'] === 3;
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
    } else if (
      value !== undefined &&
      (typeof value !== 'object' || value === null || Array.isArray(value))
    ) {
      // Invalid: can't safely interpret. Drop so the schema default (both
      // toggles on) applies on next load.
      setNestedPropertySafe(result, GIT_CO_AUTHOR_PATH, {});
      warnings.push(
        `Reset '${GIT_CO_AUTHOR_PATH}' in ${scope} settings because the stored value was not a boolean or object.`,
      );
    }
    // Object values (including the new shape) pass through unchanged.

    result['$version'] = 4;

    return { settings: result, warnings };
  }
}

export const v3ToV4Migration = new V3ToV4Migration();
