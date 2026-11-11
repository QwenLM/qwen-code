/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// --------------------------------------------------------------------------
// IMPORTANT: After adding or updating settings, run `npm run schema:settings`
// to regenerate the settings JSON schema.
// --------------------------------------------------------------------------

import {
  DEFAULT_MAX_TURNS,
  DEFAULT_CHAT_MODEL_MAX_ATTEMPTS,
  DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
  DEFAULT_CONTEXT_FILENAME,
  SHELL_TOOL_NAME,
  BRAND_IGNORE_FILE,
  BRAND_CLI_NAME,
  REMOVED_PROVIDER_MODEL_FIELDS,
  REMOVED_MODEL_GENERATION_FIELDS,
} from '@qwen-code/core';
import { DEFAULT_MIN_RETENTION } from '../utils/sessionCleanup.js';

import {
  SettingsService,
  type SettingsSchema,
  type SettingsSchemaDefaults,
  type SettingsSchemaType,
} from '@qwen-code/resource';
export { TOGGLE_TYPES, MergeStrategy } from '@qwen-code/resource';
export type {
  Settings,
  MergedSettings,
  SettingsType,
  SettingsValue,
  SettingEnumOption,
  SettingCollectionDefinition,
  SettingDefinition,
  SettingsSchema,
  SettingsSchemaType,
  SettingsJsonSchemaDefinition,
  MemoryImportFormat,
  DnsResolutionOrder,
  CrossSessionInboundSetting,
  DialogExpirySetting,
  SpellcheckCheckerSetting,
  CustomProviderModelSetting,
  CustomProviderSetting,
} from '@qwen-code/resource';

export const SETTINGS_DEFAULTS: SettingsSchemaDefaults = {
  DEFAULT_MAX_TURNS,
  DEFAULT_CHAT_MODEL_MAX_ATTEMPTS,
  DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
  DEFAULT_CONTEXT_FILENAME,
  SHELL_TOOL_NAME,
  getCliName: () => BRAND_CLI_NAME,
  BRAND_IGNORE_FILE,
  DEFAULT_MIN_RETENTION,
  REMOVED_PROVIDER_MODEL_FIELDS,
  REMOVED_MODEL_GENERATION_FIELDS,
};
export const SETTINGS_SCHEMA_REFERENCES =
  SettingsService.getDefaultSchemaReferences(SETTINGS_DEFAULTS);
export const SETTINGS_SCHEMA_DEFINITIONS =
  SETTINGS_SCHEMA_REFERENCES.definitions;
/** Public schema for callers without a configured service. */
export function getSettingsSchema(): SettingsSchemaType {
  return SettingsService.getDefaultSchema(SETTINGS_DEFAULTS);
}

export function getConfiguredSettingsSchema(
  service?: SettingsService,
): SettingsSchema | undefined {
  // CLI services store the full schema in the adopted definition. The
  // Resource layer only needs its narrower merge-time view.
  return service?.getDefinition()?.schema as SettingsSchema | undefined;
}
