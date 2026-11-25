/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared enum identity keeps Settings assignable to Core's authentication APIs.
export enum AuthType {
  QODER_BROWSER = 'qoder-browser',
  QODER_PAT = 'qoder-pat',
  QODER_OAUTH = 'qoder-oauth',
  /** Provider-backed auth types: endpoints and keys come from settings.providers. */
  USE_OPENAI = 'openai',
  USE_OPENAI_RESPONSES = 'openai-responses',
  USE_ANTHROPIC = 'anthropic',
  USE_GEMINI = 'gemini',
  /** Qwen membership account: provider entry plus subscription credentials. */
  QWEN_SUBSCRIPTION = 'qwen-subscription',
}

export enum AuthProviderType {
  DYNAMIC_DISCOVERY = 'dynamic_discovery',
}
