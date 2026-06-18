/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionConfig } from './extensionManager.js';
import type { ExtensionSetting } from './extensionSettings.js';

/**
 * A string field that can be either a plain string or a locale map.
 * Keys in the record are locale codes (e.g., 'en', 'zh', 'zh-TW', 'ja').
 */
export type LocalizableString = string | Record<string, string>;

/**
 * Raw shape of qwen-extension.json before locale resolution.
 * `description`, `displayName`, and setting descriptions may be locale maps.
 */
export interface RawExtensionConfig
  extends Omit<ExtensionConfig, 'description' | 'displayName' | 'settings'> {
  description?: LocalizableString;
  displayName?: LocalizableString;
  settings?: RawExtensionSetting[];
}

export interface RawExtensionSetting
  extends Omit<ExtensionSetting, 'description'> {
  description: LocalizableString;
}

/**
 * Resolves a LocalizableString to a plain string for the given locale.
 *
 * Fallback chain:
 *   exact match (e.g., 'zh-TW') → base language (e.g., 'zh') → 'en' → first value
 */
export function resolveLocalizableString(
  value: LocalizableString | undefined,
  locale: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;

  if (value[locale]) return value[locale];

  const baseLang = locale.split('-')[0];
  if (baseLang !== locale && baseLang && value[baseLang]) return value[baseLang];

  if (value['en']) return value['en'];

  const keys = Object.keys(value);
  if (keys.length > 0) return value[keys[0]!];

  return undefined;
}

/**
 * Resolves all localizable fields in a raw extension config to plain strings.
 */
export function resolveExtensionConfigLocale(
  rawConfig: RawExtensionConfig,
  locale: string,
): ExtensionConfig {
  const {
    displayName,
    description,
    settings: rawSettings,
    ...rest
  } = rawConfig;

  const hasLocalizableFields =
    (typeof displayName === 'object' && displayName !== null) ||
    (typeof description === 'object' && description !== null);

  const resolved: ExtensionConfig = {
    ...rest,
    displayName: resolveLocalizableString(displayName, locale),
    description: resolveLocalizableString(description, locale),
    ...(hasLocalizableFields
      ? { _rawLocalizable: { displayName, description } }
      : {}),
  };

  if (rawSettings) {
    resolved.settings = rawSettings.map(
      (setting): ExtensionSetting => ({
        ...setting,
        description:
          resolveLocalizableString(setting.description, locale) ?? '',
      }),
    );
  }

  return resolved;
}

/**
 * Resolves extension displayName for the given locale at display time.
 * Falls back to the pre-resolved value, then to extension name.
 */
export function getExtensionDisplayName(
  ext: { name: string; displayName?: string; config?: ExtensionConfig },
  locale: string,
): string {
  const raw = ext.config?._rawLocalizable?.displayName;
  if (raw) return resolveLocalizableString(raw, locale) ?? ext.name;
  return ext.displayName ?? ext.name;
}

/**
 * Resolves extension description for the given locale at display time.
 */
export function getExtensionDescription(
  ext: { config?: ExtensionConfig; description?: string },
  locale: string,
): string | undefined {
  const raw = ext.config?._rawLocalizable?.description;
  if (raw) return resolveLocalizableString(raw, locale);
  return ext.config?.description;
}
