/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsMigration } from '../types.js';

/**
 * Maps v4 modelProviders keys to their Protocol string values.
 *
 * This is a plain string map (not the Protocol enum) because the migration
 * operates on raw JSON settings before any runtime types are available.
 */
const PROVIDER_KEY_TO_PROTOCOL: Record<string, string> = {
  openai: 'openai',
  'qwen-oauth': 'qwen-oauth',
  gemini: 'gemini',
  'vertex-ai': 'gemini',
  anthropic: 'anthropic',
};

/**
 * V4 -> V5 migration (modelProviders array → ProviderConfig object).
 *
 * Before V5, `modelProviders` values were `ModelConfig[]` (plain arrays).
 * V5 wraps each array in a `ProviderConfig` object:
 *   `{ protocol: string, models: ModelConfig[] }`
 *
 * The `protocol` value is derived from the provider key using a fixed 1:1
 * mapping of the 5 v4 AuthType enum keys to 4 Protocol values.
 */
export class V4ToV5Migration implements SettingsMigration {
  readonly fromVersion = 4;
  readonly toVersion = 5;

  shouldMigrate(settings: unknown): boolean {
    if (typeof settings !== 'object' || settings === null) {
      return false;
    }
    const s = settings as Record<string, unknown>;
    if (s['$version'] !== 4 && s['$version'] !== undefined) {
      return false;
    }
    if (s['$version'] === 4) {
      return true;
    }
    const modelProviders = s['modelProviders'];
    if (typeof modelProviders !== 'object' || modelProviders === null) {
      return false;
    }
    return Object.values(modelProviders).some((v) => Array.isArray(v));
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

    const modelProviders = result['modelProviders'];
    if (typeof modelProviders === 'object' && modelProviders !== null) {
      const providers = modelProviders as Record<string, unknown>;
      for (const [key, value] of Object.entries(providers)) {
        if (!Array.isArray(value)) {
          continue;
        }

        if (!Object.hasOwn(PROVIDER_KEY_TO_PROTOCOL, key)) {
          warnings.push(
            `Unknown provider key "${key}", defaulting protocol to "openai". ` +
              `If this provider uses a different protocol (anthropic, gemini), ` +
              `edit settings.json to set "protocol" explicitly.`,
          );
        }

        providers[key] = {
          protocol: Object.hasOwn(PROVIDER_KEY_TO_PROTOCOL, key)
            ? PROVIDER_KEY_TO_PROTOCOL[key]
            : 'openai',
          models: value,
        };
      }
    }

    result['$version'] = 5;

    return { settings: result, warnings };
  }
}

export const v4ToV5Migration = new V4ToV5Migration();
