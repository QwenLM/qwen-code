/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, Config } from '@qwen-code/qwen-code-core';
import { USER_SETTINGS_PATH } from './config/settings.js';
import { validateAuthMethod } from './config/auth.js';
import { getEffectiveAuthType } from './config/config.js';

export async function validateNonInteractiveAuth(
  configuredAuthType: AuthType | undefined,
  useExternalAuth: boolean | undefined,
  nonInteractiveConfig: Config,
) {
  const debug = nonInteractiveConfig.getDebugMode() || process.env.DEBUG === 'true' || process.env.DEBUG === '1';
  
  // Use the configuration hierarchy from config module
  // This ensures CLI args > env vars > settings.json precedence
  const effectiveAuthType = getEffectiveAuthType({ selectedAuthType: configuredAuthType });

  if (debug) {
    console.debug('[DEBUG:validateNonInteractiveAuth] Called\n' +
      `  configuredAuthType: ${configuredAuthType}\n` +
      `  useExternalAuth: ${useExternalAuth}\n` +
      `  effectiveAuthType: ${effectiveAuthType}`);
  }

  if (!effectiveAuthType) {
    console.error(
      `Please set an Auth method in your ${USER_SETTINGS_PATH} or specify one of the following environment variables before running: GEMINI_API_KEY, OPENAI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA`,
    );
    process.exit(1);
  }

  if (!useExternalAuth) {
    const err = validateAuthMethod(effectiveAuthType);
    if (err != null) {
      console.error(err);
      process.exit(1);
    }
  }

  if (debug) {
    console.debug('[DEBUG:validateNonInteractiveAuth] Before refreshAuth:', effectiveAuthType);
  }
  
  await nonInteractiveConfig.refreshAuth(effectiveAuthType);
  
  if (debug) {
    const contentGen = nonInteractiveConfig.getContentGeneratorConfig();
    console.debug('[DEBUG:validateNonInteractiveAuth] Auth refreshed\n' +
      `  effectiveAuthType: ${effectiveAuthType}\n` +
      `  contentGenerator: ${JSON.stringify(contentGen)}`);
  }
  
  return nonInteractiveConfig;
}
