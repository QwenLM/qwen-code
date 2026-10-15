/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfig } from '../../contentGenerator.js';

/**
 * Hostname-only check used to decide whether a thinking-disable request
 * should carry OpenRouter's provider-level `reasoning` parameter. Mirrors
 * `isDeepSeekHostname`: hostname matching only — no model-name fallback.
 * OpenRouter's `reasoning` parameter is a gateway-level extension of the
 * chat-completions API; pushing it at strict OpenAI-compatible backends
 * (self-hosted vLLM/SGLang, official OpenAI) could trip an unknown-key
 * rejection, and those gateways have their own thinking switches anyway.
 *
 * Parses the baseUrl with `new URL(...)` and matches the hostname against
 * `openrouter.ai` (and its subdomains) exactly — a naive substring check
 * would false-positive on hostile hosts like
 * `https://openrouter.ai.evil.com/v1`. Invalid URLs are treated as
 * non-OpenRouter. The hostname shape mirrors `openRouterProvider.ownsModel`
 * in `providers/presets/openrouter.ts`.
 *
 * Exposed as a free function so consumers (the pipeline post-processing
 * hook, in particular) can run the check without a provider class —
 * OpenRouter requests flow through `DefaultOpenAICompatibleProvider`.
 */
export function isOpenRouterHostname(
  contentGeneratorConfig: ContentGeneratorConfig,
): boolean {
  const baseUrl = contentGeneratorConfig.baseUrl ?? '';
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}
