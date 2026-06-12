/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsMigration } from '../types.js';
import {
  getNestedProperty,
  setNestedPropertySafe,
} from '../../../utils/settingsUtils.js';

/**
 * V4 -> V5 migration (model identity: add id/baseUrl/provider fields).
 *
 * Before V5, `model.name` stored the API model id (e.g. "glm-5"), which is
 * not unique across providers. V5 introduces:
 *   - `model.id` — the API model identifier (what was previously in model.name)
 *   - `model.name` — a display name (will be resolved at runtime)
 *   - `model.baseUrl` — the API base URL
 *   - `model.provider` — the authType
 *
 * This migration copies the old `model.name` (which is the API id) to
 * `model.id`, and copies `security.auth.baseUrl` and
 * `security.auth.selectedType` to `model.baseUrl` and `model.provider`.
 *
 * The `model.name` field is left as-is (still contains the id). The runtime
 * will resolve it to the proper display name on first load.
 */
export class V4ToV5Migration implements SettingsMigration {
  readonly fromVersion = 4;
  readonly toVersion = 5;

  shouldMigrate(settings: unknown): boolean {
    if (typeof settings !== 'object' || settings === null) {
      return false;
    }
    const s = settings as Record<string, unknown>;
    if (s['$version'] === 4) {
      return true;
    }
    // Versionless settings with model.name but no model.id
    if (s['$version'] === undefined) {
      const modelName = getNestedProperty(s, 'model.name');
      const modelId = getNestedProperty(s, 'model.id');
      if (modelName !== undefined && modelId === undefined) {
        return true;
      }
    }
    return false;
  }

  migrate(
    settings: unknown,
    _scope: string,
  ): { settings: unknown; warnings: string[] } {
    if (typeof settings !== 'object' || settings === null) {
      throw new Error('Settings must be an object');
    }

    const result = structuredClone(settings) as Record<string, unknown>;
    const warnings: string[] = [];

    const modelName = getNestedProperty(result, 'model.name') as
      | string
      | undefined;

    // Copy model.name (old id) to model.id
    if (modelName !== undefined) {
      setNestedPropertySafe(result, 'model.id', modelName);
    }

    // Copy security.auth.baseUrl to model.baseUrl
    const baseUrl = getNestedProperty(result, 'security.auth.baseUrl') as
      | string
      | undefined;
    if (baseUrl !== undefined) {
      setNestedPropertySafe(result, 'model.baseUrl', baseUrl);
    }

    // Copy security.auth.selectedType to model.provider
    const selectedType = getNestedProperty(
      result,
      'security.auth.selectedType',
    ) as string | undefined;
    if (selectedType !== undefined) {
      setNestedPropertySafe(result, 'model.provider', selectedType);
    }

    result['$version'] = 5;

    return { settings: result, warnings };
  }
}

export const v4ToV5Migration = new V4ToV5Migration();
