/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Standalone command settings and the Core operations used by product hosts. */
export * as operations from '@qwen-code/core/plugin-management';
export {
  createCliSettingsService,
  resolveCommandSettings,
} from './src/config/createCliSettingsService.js';
export {
  getFlagSettingsInput,
  getFlagSettingsPath,
  restoreLoadedEnvironment,
  type SettingSource,
} from './src/config/settings.js';
