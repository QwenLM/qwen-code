/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export { I18nServiceProvider, useI18nService } from './I18nServiceContext.js';
export { cliUiCatalog, registerCliUiMessages } from './register.js';

export { T } from './RichMessage.js';
export {
  formatLocalizedShortcutHint,
  type LocalizedShortcutHintId,
} from './shortcutText.js';
export {
  BUILTIN_COMMAND_DESCRIPTION_KEYS,
  getMissingBuiltinCommandDescriptionPaths,
  resolveCommandDescription,
} from './commandText.js';
export {
  getLocalizedScopeDescription,
  getLocalizedScopeLabel,
  getLocalizedScopeMessageForSetting,
  getLocalizedSettingOption,
  getLocalizedSettingText,
  SETTING_OPTION_KEYS,
  SETTING_TEXT_KEYS,
} from './settingText.js';
export {
  detectSystemUiLocale,
  isUiLanguagePreference,
  normalizeUiLanguagePreference,
  resolveUiLocale,
} from './locale.js';
export type {
  MessageParams,
  UiLanguagePreference,
  UiMessageKey,
} from './types.js';
export {
  getLocalizedPermissionModeShortTitle,
  getLocalizedPermissionModeTitle,
} from './permissionText.js';
