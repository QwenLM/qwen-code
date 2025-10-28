/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import { loadEnvironment, loadSettings } from './settings.js';

export function validateAuthMethod(authMethod: string): string | null {
  loadEnvironment(loadSettings().merged);

  if (authMethod === AuthType.USE_OPENAI) {
    if (!process.env['OPENAI_API_KEY']) {
      return 'OPENAI_API_KEY environment variable not found. You can enter it interactively or add it to your .env file.';
    }
    return null;
  }

  if (authMethod === AuthType.QWEN_OAUTH) {
    // Qwen OAuth doesn't require any environment variables for basic setup
    // The OAuth flow will handle authentication
    return null;
  }

  return 'Invalid auth method selected.';
}

export const setOpenAIApiKey = (apiKey: string): void => {
  process.env['OPENAI_API_KEY'] = apiKey;
};

export const setOpenAIBaseUrl = (baseUrl: string): void => {
  process.env['OPENAI_BASE_URL'] = baseUrl;
};

export const setOpenAIModel = (model: string): void => {
  process.env['OPENAI_MODEL'] = model;
};
