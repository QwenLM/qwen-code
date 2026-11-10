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
import { getSubscriptionStartupFallbackModel } from '../config/modelProvidersScope.js';
import { performInitialAuth } from './auth.js';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { subscriptionModelUnavailable } from '@qwen-code/qwen-code-core/qwen/subscription-models.js';
import { validateTheme } from './theme.js';
import { initializeI18n, resolveLanguageSetting } from '../i18n/index.js';

export interface InitializationResult {
  authError: string | null;
  authNotice?: string;
  skipStartupAuthDialog?: boolean;
  themeError: string | null;
  shouldOpenAuthDialog: boolean;
  memoryFileCount: number;
}

export interface InitializeAppOptions {
  /**
   * When true, skip the awaited IDE connection inside initializeApp().
   * Ordinary interactive TUI startup uses this so IDE IPC can run after first
   * paint; non-TUI paths leave it false so the first request keeps IDE context.
   */
  deferIdeConnection?: boolean;
  allowSubscriptionStartupFallback?: boolean;
}

/**
 * Establishes the startup IDE connection and records the connection telemetry.
 *
 * Callers choose whether to await this on the startup critical path. Headless,
 * stream-json, and ACP/Zed await it before their first request; ordinary TUI
 * startup schedules it post-render through startup prefetch.
 */
export async function connectIdeForStartup(config: Config): Promise<void> {
  if (!config.getIdeMode()) return;

  const ideClient = await IdeClient.getInstance();
  await ideClient.connect();
  logIdeConnection(config, new IdeConnectionEvent(IdeConnectionType.START));
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
  options: InitializeAppOptions = {},
): Promise<InitializationResult> {
  // Initialize i18n system
  await initializeI18n(
    resolveLanguageSetting(settings.merged.general?.language as string),
  );

  // Use authType from modelsConfig which respects CLI --auth-type argument
  // over settings.security.auth.selectedType
  const authType = config.getModelsConfig().getCurrentAuthType();
  const subscriptionFallbackModel = options.allowSubscriptionStartupFallback
    ? getSubscriptionStartupFallbackModel(settings, authType, config)
    : undefined;
  const authError = await performInitialAuth(
    config,
    authType,
    subscriptionFallbackModel,
  );
  const inactiveSubscription =
    authType === AuthType.QWEN_SUBSCRIPTION && !config.getAuthType();
  const authNotice =
    inactiveSubscription &&
    authError?.includes(subscriptionModelUnavailable(config.getModel()))
      ? authError
      : undefined;
  const skipStartupAuthDialog =
    inactiveSubscription && (authError === null || authNotice !== undefined);

  const themeError = validateTheme(settings);

  const shouldOpenAuthDialog =
    !config.getModelsConfig().wasAuthTypeExplicitlyProvided() || !!authError;

  if (!options.deferIdeConnection) {
    await connectIdeForStartup(config);
  }

  return {
    authError,
    ...(authNotice ? { authNotice } : {}),
    ...(skipStartupAuthDialog ? { skipStartupAuthDialog } : {}),
    themeError,
    shouldOpenAuthDialog,
    memoryFileCount: config.getMemoryFileCount(),
  };
}
