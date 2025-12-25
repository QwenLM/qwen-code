/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import { loadEnvironment, loadSettings } from './settings.js';

export function validateAuthMethod(authMethod: string): string | null {
  const settings = loadSettings();
  loadEnvironment(settings.merged);

  if (authMethod === AuthType.USE_OPENAI) {
    const hasApiKey =
      process.env['OPENAI_API_KEY'] || settings.merged.security?.auth?.apiKey;
    if (!hasApiKey) {
      return 'OPENAI_API_KEY environment variable not found. You can enter it interactively or add it to your .env file.';
    }
    return null;
  }

  if (authMethod === AuthType.QWEN_OAUTH) {
    // Qwen OAuth doesn't require any environment variables for basic setup
    // The OAuth flow will handle authentication
    return null;
  }

  if (authMethod === AuthType.USE_ANTHROPIC) {
    const hasApiKey = process.env['ANTHROPIC_API_KEY'];
    if (!hasApiKey) {
      return 'ANTHROPIC_API_KEY environment variable not found.';
    }

    const hasBaseUrl = process.env['ANTHROPIC_BASE_URL'];
    if (!hasBaseUrl) {
      return 'ANTHROPIC_BASE_URL environment variable not found.';
    }

    return null;
  }

  if (authMethod === AuthType.USE_GEMINI) {
    const hasApiKey = process.env['GEMINI_API_KEY'];
    if (!hasApiKey) {
      return 'GEMINI_API_KEY environment variable not found. Please set it in your .env file or environment variables.';
    }
    return null;
  }

  if (authMethod === AuthType.USE_VERTEX_AI) {
    const hasApiKey = process.env['GOOGLE_API_KEY'];
    if (!hasApiKey) {
      return 'GOOGLE_API_KEY environment variable not found. Please set it in your .env file or environment variables.';
    }

    process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
    return null;
  }

  return 'Invalid auth method selected.';
}
