/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  IdeClient,
  IdeConnectionEvent,
  IdeConnectionType,
  logIdeConnection,
  type Config,
} from '@qwen-code/qwen-code-core';
import { type LoadedSettings, SettingScope } from '../config/settings.js';
import { performInitialAuth } from './auth.js';
import { validateTheme } from './theme.js';
import { initializeI18n } from '../i18n/index.js';
import { initializeLlmOutputLanguage } from '../ui/commands/languageCommand.js';

export interface InitializationResult {
  authError: string | null;
  themeError: string | null;
  shouldOpenAuthDialog: boolean;
  geminiMdFileCount: number;
}

/**
 * Orchestrates the application's startup initialization.
 * This runs BEFORE the React UI is rendered.
 * @param config The application config.
 * @param settings The loaded application settings.
 * @returns The results of the initialization.
 */
export async function initializeApp(
  config: Config,
  settings: LoadedSettings,
): Promise<InitializationResult> {
  // Initialize i18n system
  const languageSetting =
    process.env['QWEN_CODE_LANG'] ||
    settings.merged.general?.language ||
    'auto';
  await initializeI18n(languageSetting);

  // Auto-detect and set LLM output language on first use
  initializeLlmOutputLanguage();

  const authType = settings.merged.security?.auth?.selectedType;
  const authError = await performInitialAuth(config, authType);

  // Fallback to user select when initial authentication fails
  if (authError) {
    settings.setValue(
      SettingScope.User,
      'security.auth.selectedType',
      undefined,
    );
  }
  const themeError = validateTheme(settings);

  const shouldOpenAuthDialog =
    settings.merged.security?.auth?.selectedType === undefined || !!authError;

  if (config.getIdeMode()) {
    const ideClient = await IdeClient.getInstance();
    await ideClient.connect();
    logIdeConnection(config, new IdeConnectionEvent(IdeConnectionType.START));
  }

  return {
    authError,
    themeError,
    shouldOpenAuthDialog,
    geminiMdFileCount: config.getGeminiMdFileCount(),
  };
}
