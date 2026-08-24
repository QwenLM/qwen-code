/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import {
  isMoonshotModelReasoningHostname,
  normalizeModelReasoningEffort,
  resolveModelReasoningConfiguration,
} from '../../model-reasoning-config.js';
import { REASONING_EFFORT_TIERS } from '../../reasoning-effort.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

export function isMoonshotHostname(
  contentGeneratorConfig: ContentGeneratorConfig,
): boolean {
  const baseUrl = contentGeneratorConfig.baseUrl;
  if (!baseUrl) {
    return false;
  }
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return isMoonshotModelReasoningHostname(hostname);
  } catch {
    return false;
  }
}

export class MoonshotOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  static isMoonshotProvider = isMoonshotHostname;
  static isMoonshotHostname = isMoonshotHostname;

  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);
    const reasoning = resolveModelReasoningConfiguration({
      modelId: request.model || this.contentGeneratorConfig.model,
      authType: this.contentGeneratorConfig.authType,
      baseUrl: this.contentGeneratorConfig.baseUrl,
    });
    if (!reasoning) {
      return baseRequest;
    }
    const nested = (baseRequest as unknown as Record<string, unknown>)[
      'reasoning'
    ] as { effort?: unknown } | undefined;
    const effort = REASONING_EFFORT_TIERS.find(
      (candidate) => candidate === nested?.effort,
    );
    return rewriteReasoningEffort(
      baseRequest,
      normalizeModelReasoningEffort(reasoning, effort),
    );
  }
}

function rewriteReasoningEffort(
  request: OpenAI.Chat.ChatCompletionCreateParams,
  effort: (typeof REASONING_EFFORT_TIERS)[number] | undefined,
): OpenAI.Chat.ChatCompletionCreateParams {
  const raw = request as unknown as Record<string, unknown>;
  const nested = raw['reasoning'];
  if (!nested || typeof nested !== 'object' || !('effort' in nested)) {
    return request;
  }

  const next = { ...raw };
  if (effort && typeof next['reasoning_effort'] !== 'string') {
    next['reasoning_effort'] = effort;
  }
  if (Object.keys(nested).length === 1) {
    delete next['reasoning'];
  } else {
    const { effort: _drop, ...rest } = nested;
    next['reasoning'] = rest;
  }
  return next as unknown as OpenAI.Chat.ChatCompletionCreateParams;
}
