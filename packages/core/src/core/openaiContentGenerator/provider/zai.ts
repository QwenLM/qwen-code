/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import type { ReasoningEffort } from '../../reasoning-effort.js';
import { DefaultOpenAICompatibleProvider } from './default.js';
import { createDebugLogger } from '../../../utils/debugLogger.js';
import { resolveModelReasoningConfiguration } from '../../model-reasoning-config.js';

const debugLogger = createDebugLogger('ZAI');

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

  // Latch so the skipped-flatten warning fires once per provider lifetime.
  private nonZaiHostnameFlattenWarned = false;

  /** The registered route's native ladder; otherwise the generic ceiling. */
  protected override supportedReasoningEffortsFor(
    model: string | undefined,
  ): readonly ReasoningEffort[] {
    const configuration = resolveModelReasoningConfiguration({
      modelId: model ?? this.contentGeneratorConfig.model,
      authType: this.contentGeneratorConfig.authType,
      baseUrl: this.contentGeneratorConfig.baseUrl,
    });
    return configuration && !configuration.toggleOnly
      ? configuration.efforts
      : super.supportedReasoningEffortsFor(model);
  }

  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);
    const configuration = resolveModelReasoningConfiguration({
      modelId: request.model || this.contentGeneratorConfig.model,
      authType: this.contentGeneratorConfig.authType,
      baseUrl: this.contentGeneratorConfig.baseUrl,
    });
    if (configuration?.endpointFamily === 'zai') {
      return flattenReasoningEffort(baseRequest);
    }
    // Model-name routing also reaches self-hosted and unregistered GLM models.
    // Keep their generic nested shape and make the skipped reshape observable.
    const reasoning = (baseRequest as unknown as Record<string, unknown>)[
      'reasoning'
    ] as { effort?: unknown } | undefined;
    if (
      reasoning?.effort &&
      !(baseRequest as unknown as Record<string, unknown>)[
        'reasoning_effort'
      ] &&
      !this.nonZaiHostnameFlattenWarned
    ) {
      debugLogger.warn(
        `GLM model '${
          this.contentGeneratorConfig.model ?? 'unknown'
        }' is not registered for the Z.AI reasoning reshape; leaving nested ` +
          `reasoning.effort='${String(reasoning.effort)}' unflattened.`,
      );
      this.nonZaiHostnameFlattenWarned = true;
    }
    return baseRequest;
  }
}

/**
 * Move the normalized nested effort onto GLM's flat `reasoning_effort` field.
 * A user-set top-level value wins and is left untouched.
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
