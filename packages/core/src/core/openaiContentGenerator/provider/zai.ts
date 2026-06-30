/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

/**
 * Hostname check for Z.ai / Zhipu GLM endpoints. GLM's OpenAI-compatible
 * chat-completions endpoint takes a flat `reasoning_effort` field (GLM-5.2+),
 * not the nested `reasoning: { effort }` object the OpenAI pipeline passes
 * through by default — see https://docs.z.ai/guides/capabilities/thinking.
 *
 * Hostname-gated so the reshape never leaks to an unrelated strict
 * OpenAI-compatible backend matched only by model name.
 */
export function isZaiHostname(
  contentGeneratorConfig: ContentGeneratorConfig,
): boolean {
  const baseUrl = contentGeneratorConfig.baseUrl;
  if (!baseUrl) {
    return false;
  }
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      hostname === 'z.ai' ||
      hostname.endsWith('.z.ai') ||
      hostname === 'bigmodel.cn' ||
      hostname.endsWith('.bigmodel.cn')
    );
  } catch {
    return false;
  }
}

/**
 * Broader routing check: hostname OR a `glm-*` model name. Only the hostname
 * gate drives the wire reshape (see buildRequest); the model-name fallback just
 * routes obviously-GLM configs through this provider.
 */
export function isZaiProvider(
  contentGeneratorConfig: ContentGeneratorConfig,
): boolean {
  if (isZaiHostname(contentGeneratorConfig)) {
    return true;
  }
  const model = contentGeneratorConfig.model ?? '';
  return model.toLowerCase().startsWith('glm-');
}

export class ZaiOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  static isZaiProvider = isZaiProvider;
  static isZaiHostname = isZaiHostname;

  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);
    return isZaiHostname(this.contentGeneratorConfig)
      ? flattenReasoningEffort(baseRequest)
      : baseRequest;
  }
}

/**
 * Move the unified nested `reasoning: { effort }` onto GLM's flat
 * `reasoning_effort` field, verbatim. Unlike DeepSeek (whose API only accepts
 * high/max, so its adapter remaps low/medium → high), GLM-5.2 accepts the full
 * ladder (low/medium/high/xhigh/max) and groups low/medium → high and
 * xhigh → max server-side, so we keep the raw tier for fidelity and
 * observability. A user-set top-level `reasoning_effort` (via
 * samplingParams/extra_body) wins and is left untouched.
 */
function flattenReasoningEffort(
  request: OpenAI.Chat.ChatCompletionCreateParams,
): OpenAI.Chat.ChatCompletionCreateParams {
  const r = request as unknown as Record<string, unknown>;
  const nested = r['reasoning'] as { effort?: unknown } | undefined;
  const effort = nested?.effort;
  if (typeof effort !== 'string' || !effort) {
    return request;
  }

  const next: Record<string, unknown> = { ...r };
  if (
    typeof next['reasoning_effort'] !== 'string' ||
    !next['reasoning_effort']
  ) {
    next['reasoning_effort'] = effort;
  }

  // Drop the duplicated nested `effort` so we don't ship two competing knobs;
  // keep any sibling keys (e.g. budget_tokens) the server may honor.
  if (nested && Object.keys(nested).length === 1) {
    delete next['reasoning'];
  } else if (nested) {
    const { effort: _drop, ...rest } = nested as Record<string, unknown>;
    next['reasoning'] = rest;
  }

  return next as unknown as OpenAI.Chat.ChatCompletionCreateParams;
}
