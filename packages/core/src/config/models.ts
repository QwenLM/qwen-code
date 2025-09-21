/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../core/contentGenerator.js';

export const DEFAULT_QWEN_MODEL = 'qwen3-coder-plus';
// We do not have a fallback model for now, but note it here anyway.
export const DEFAULT_QWEN_FLASH_MODEL = 'qwen3-coder-flash';

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-pro';
export const DEFAULT_GEMINI_FLASH_MODEL = 'gemini-2.5-flash';
export const DEFAULT_GEMINI_FLASH_LITE_MODEL = 'gemini-2.5-flash-lite';

export const DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';

/**
 * Default models for each authentication provider
 */
export const DEFAULT_MODELS_FOR_AUTH_TYPE: Record<AuthType, string> = {
  [AuthType.LOGIN_WITH_GOOGLE]: DEFAULT_GEMINI_MODEL,
  [AuthType.USE_GEMINI]: DEFAULT_GEMINI_MODEL,
  [AuthType.USE_VERTEX_AI]: DEFAULT_GEMINI_MODEL,
  [AuthType.CLOUD_SHELL]: DEFAULT_GEMINI_MODEL,
  [AuthType.USE_OPENAI]: process.env['OPENAI_MODEL'] || 'gpt-4o',
  [AuthType.QWEN_OAUTH]: DEFAULT_QWEN_MODEL,
};
