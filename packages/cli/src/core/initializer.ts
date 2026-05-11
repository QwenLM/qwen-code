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
import { type LoadedSettings } from '../config/settings.js';
import { performInitialAuth } from './auth.js';
import { validateTheme } from './theme.js';
import { initializeI18n, type SupportedLanguage } from '../i18n/index.js';

export interface InitializationResult {
  authError: string | null;
  themeError: string | null;
  shouldOpenAuthDialog: boolean;
  geminiMdFileCount: number;
}

/**
 * Initializes the i18n subsystem. Pure function of `settings` — has no
 * `Config` dependency, so the cli startup main path can fire it in
 * parallel with `loadCliConfig()`.
 */
export function initializeI18nFromSettings(
  settings: LoadedSettings,
): Promise<void> {
  const languageSetting =
    process.env['QWEN_CODE_LANG'] ||
    (settings.merged.general?.language as string) ||
    'auto';
  return initializeI18n(languageSetting as SupportedLanguage | 'auto');
}

/**
 * Connects the IDE client when running in IDE mode. Intended to be run in
 * parallel with auth + theme + startup-warnings after `Config` is ready.
 */
async function connectIdeIfEnabled(config: Config): Promise<void> {
  if (!config.getIdeMode()) return;
  const ideClient = await IdeClient.getInstance();
  await ideClient.connect();
  logIdeConnection(config, new IdeConnectionEvent(IdeConnectionType.START));
}

/**
 * Orchestrates the application's startup initialization.
 * This runs BEFORE the React UI is rendered.
 *
 * The post-config substeps (auth, theme, IDE) are fan-out parallel via
 * `Promise.allSettled` so an IDE-connect failure cannot short-circuit
 * auth, and vice-versa. The returned `InitializationResult` preserves the
 * legacy semantics of the prior serial implementation (auth error
 * dominates; theme error reported separately).
 *
 * @param config The application config.
 * @param settings The loaded application settings.
 * @param options.skipI18n  If true, the caller has already invoked
 *   `initializeI18nFromSettings(settings)` in parallel with
 *   `loadCliConfig`. The cli startup main path sets this so we don't
 *   re-initialize i18n a second time.
 */
export async function initializeApp(
  config: Config,
  settings: LoadedSettings,
  options?: { skipI18n?: boolean },
): Promise<InitializationResult> {
  if (!options?.skipI18n) {
    await initializeI18nFromSettings(settings);
  }

  // Use authType from modelsConfig which respects CLI --auth-type argument
  // over settings.security.auth.selectedType
  const authType = config.getModelsConfig().getCurrentAuthType();

  // Fan-out: auth + IDE connect run concurrently. Theme validation is
  // synchronous and cheap, so it runs after both settle. We use
  // `allSettled` so an IDE-connect failure doesn't reject auth (and vice
  // versa) — each error is surfaced through its own channel
  // (`authError` / debug log for IDE).
  const [authSettled, ideSettled] = await Promise.allSettled([
    performInitialAuth(config, authType),
    connectIdeIfEnabled(config),
  ]);

  const authError =
    authSettled.status === 'fulfilled'
      ? authSettled.value
      : authSettled.reason instanceof Error
        ? authSettled.reason.message
        : String(authSettled.reason);
  if (ideSettled.status === 'rejected') {
    // IDE failures already log inside `connectIdeIfEnabled` flow; surface a
    // trace here so a reviewer can correlate with timing. We don't surface
    // to the user via `InitializationResult` to keep the legacy contract.
    const reason =
      ideSettled.reason instanceof Error
        ? ideSettled.reason
        : new Error(String(ideSettled.reason));
    // eslint-disable-next-line no-console
    console.debug(`IDE connect failed during initializeApp: ${reason.message}`);
  }

  const themeError = validateTheme(settings);

  const shouldOpenAuthDialog =
    !config.getModelsConfig().wasAuthTypeExplicitlyProvided() || !!authError;

  return {
    authError,
    themeError,
    shouldOpenAuthDialog,
    geminiMdFileCount: config.getGeminiMdFileCount(),
  };
}
