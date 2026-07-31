/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsMigration } from '../types.js';

/**
 * Protocol that V4 implicitly derives from each built-in modelProviders key.
 *
 * Mirrors the forward V4 -> V5 mapping. Used only to detect (and warn about)
 * an explicit V5 `protocol` that V4 cannot represent, so the downgrade is not
 * silently lossy.
 */
const PROVIDER_KEY_TO_PROTOCOL: Record<string, string> = {
  openai: 'openai',
  'qwen-oauth': 'qwen-oauth',
  gemini: 'gemini',
  'vertex-ai': 'gemini',
  anthropic: 'anthropic',
};

/**
 * A V5 `ProviderConfig` is any non-array object value under `modelProviders`.
 * In V4 every `modelProviders` value is a `ModelConfig[]` (array), so a
 * non-array object is unambiguously the V5 `{ protocol, models }` wrapper
 * (or a malformed remnant of it).
 */
function isWrappedProviderConfig(
  value: unknown,
): value is { protocol?: unknown; models?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * V5 -> V4 migration (ProviderConfig object → modelProviders array).
 *
 * This is the inverse of the V4 -> V5 migration that shipped with #5089 and
 * was subsequently reverted. V5 wrapped each `modelProviders` array in a
 * `{ protocol, models }` object; the reverted (V4) code consumes the arrays
 * directly, so a settings file left at `$version: 5` would throw on load
 * ("models is not iterable").
 *
 * This migration unwraps each `{ protocol, models }` back to its `models`
 * array and resets `$version` to 4. The `protocol` field is dropped because
 * V4 re-derives the protocol from the provider key.
 */
export class V5ToV4Migration implements SettingsMigration {
  readonly fromVersion = 5;
  readonly toVersion = 4;

  shouldMigrate(settings: unknown): boolean {
    if (typeof settings !== 'object' || settings === null) {
      return false;
    }
    const s = settings as Record<string, unknown>;
    if (s['$version'] === 5) {
      return true;
    }
    // Only inspect the shape for untagged settings; never touch settings that
    // explicitly declare a different version.
    if (s['$version'] !== undefined) {
      return false;
    }
    const modelProviders = s['modelProviders'];
    if (typeof modelProviders !== 'object' || modelProviders === null) {
      return false;
    }
    return Object.values(modelProviders).some((v) =>
      isWrappedProviderConfig(v),
    );
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
        if (Array.isArray(value)) {
          continue; // already a V4 array
        }
        if (!isWrappedProviderConfig(value)) {
          continue; // primitive/unknown — leave untouched
        }

        const derivedProtocol = Object.hasOwn(PROVIDER_KEY_TO_PROTOCOL, key)
          ? PROVIDER_KEY_TO_PROTOCOL[key]
          : undefined;
        if (
          typeof value.protocol === 'string' &&
          derivedProtocol !== undefined &&
          value.protocol !== derivedProtocol
        ) {
          warnings.push(
            `Provider "${key}" declared protocol "${value.protocol}", but V4 ` +
              `derives protocol "${derivedProtocol}" from the provider key. ` +
              `The explicit protocol has been dropped.`,
          );
        }

        providers[key] = Array.isArray(value.models) ? value.models : [];
      }
    }

    result['$version'] = 4;

    return { settings: result, warnings };
  }
}

export const v5ToV4Migration = new V5ToV4Migration();
