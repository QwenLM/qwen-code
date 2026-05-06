/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import type { ExtendedChatCompletionAssistantMessageParam } from '../converter.js';
import { DefaultOpenAICompatibleProvider } from './default.js';
import type { GenerateContentConfig } from '@google/genai';

/**
 * Hostname-only check used to decide whether `reasoning.effort` should be
 * rewritten into DeepSeek's flat `reasoning_effort` body parameter, and
 * whether to emit `thinking: { type: 'disabled' }` when reasoning is
 * turned off. The broader `isDeepSeekProvider` falls back to model-name
 * matching to cover self-hosted deployments (sglang/vllm/ollama) — that
 * fallback is right for content-part flattening (a model-format
 * constraint) but trusting it for the body-shape rewrite would push a
 * DeepSeek extension at strict OpenAI-compat backends that may not
 * accept it. Keep the two decisions separated.
 *
 * Parses the baseUrl with `new URL(...)` and matches the hostname
 * against `api.deepseek.com` (and its subdomains) exactly — a naive
 * substring check would false-positive on hostile hosts like
 * `https://api.deepseek.com.evil.com/v1`. Invalid URLs are treated as
 * non-DeepSeek. Mirrors `isDeepSeekAnthropicHostname` on the Anthropic
 * side.
 *
 * Exposed as a free function so consumers (the pipeline post-processing
 * hook, in particular) can run the check without coupling to the
 * concrete `DeepSeekOpenAICompatibleProvider` class.
 */
export function isDeepSeekHostname(
  contentGeneratorConfig: ContentGeneratorConfig,
): boolean {
  const baseUrl = contentGeneratorConfig.baseUrl ?? '';
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      hostname === 'api.deepseek.com' || hostname.endsWith('.api.deepseek.com')
    );
  } catch {
    return false;
  }
}

/**
 * Broad detection used to select the DeepSeek provider class for
 * content-part flattening: hostname OR model-name. Self-hosted
 * deployments (sglang/vllm/ollama) running DeepSeek models share the
 * same input-format constraint, so the model-name fallback is
 * intentional. For decisions that depend on the wire shape DeepSeek's
 * own API exposes (e.g. `reasoning_effort`, `thinking`), use
 * `isDeepSeekHostname` instead — see https://github.com/QwenLM/qwen-code/issues/3613.
 */
export function isDeepSeekProvider(
  contentGeneratorConfig: ContentGeneratorConfig,
): boolean {
  if (isDeepSeekHostname(contentGeneratorConfig)) return true;
  const model = contentGeneratorConfig.model ?? '';
  return model.toLowerCase().includes('deepseek');
}

export class DeepSeekOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    super(contentGeneratorConfig, cliConfig);
  }

  /**
   * Backward-compatible static delegates for the free `isDeepSeek*`
   * helpers. New call sites should import the free functions directly to
   * avoid coupling to this class.
   */
  static isDeepSeekProvider = isDeepSeekProvider;
  static isDeepSeekHostname = isDeepSeekHostname;

  /**
   * DeepSeek's API requires message content to be a plain string, not an
   * array of content parts. Flatten any text-part arrays into joined
   * strings; non-text parts (image_url, audio, …) are replaced with a
   * `[Unsupported content type: <type>]` placeholder so the request still
   * goes through with a textual breadcrumb rather than silently dropping
   * the part or raising mid-conversation. Also translate the standard
   * `reasoning.effort` config into DeepSeek's flat `reasoning_effort`
   * body parameter — but only on actual DeepSeek hostnames, since the
   * model-name fallback above can match self-hosted/strict OpenAI-compat
   * backends that don't accept the DeepSeek extension.
   */
  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);

    const reshaped = isDeepSeekHostname(this.contentGeneratorConfig)
      ? translateReasoningEffort(baseRequest)
      : baseRequest;
    if (!reshaped.messages?.length) {
      return reshaped;
    }

    const messages = reshaped.messages.map((message) => {
      const flattened = flattenContentParts(message);
      return ensureReasoningContentOnToolCalls(flattened);
    });

    return {
      ...reshaped,
      messages,
    };
  }

  override getDefaultGenerationConfig(): GenerateContentConfig {
    return {
      temperature: 0,
    };
  }
}

function flattenContentParts(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.ChatCompletionMessageParam {
  if (!('content' in message)) {
    return message;
  }

  const { content } = message;

  if (
    typeof content === 'string' ||
    content === null ||
    content === undefined
  ) {
    return message;
  }

  if (!Array.isArray(content)) {
    return message;
  }

  const text = content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part.type === 'text') {
        return part.text ?? '';
      }
      return `[Unsupported content type: ${part.type}]`;
    })
    .join('\n\n');

  return {
    ...message,
    content: text,
  } as OpenAI.Chat.ChatCompletionMessageParam;
}

// DeepSeek's chat-completions endpoint accepts a flat `reasoning_effort`
// body parameter (Possible values: high, max — see
// https://api-docs.deepseek.com/zh-cn/api/create-chat-completion). The
// standard qwen-code config shape is `reasoning: { effort, ... }` which gets
// passed through verbatim by the OpenAI pipeline. Translate to the flat
// shape DeepSeek expects so user-configured effort levels actually take
// effect; otherwise the nested `reasoning` object is ignored and the server
// silently defaults to `high`. Backward-compatible mapping per the doc:
// low / medium → high (the API does this anyway, but we surface it
// explicitly so logs / dashboards are accurate).
function translateReasoningEffort(
  request: OpenAI.Chat.ChatCompletionCreateParams,
): OpenAI.Chat.ChatCompletionCreateParams {
  // The SDK type narrows reasoning_effort to 'low'|'medium'|'high', but
  // DeepSeek extends it with 'max'. Treat the request as a loose record
  // here so we can set 'max' without fighting the upstream union.
  const r = request as unknown as Record<string, unknown>;
  const nested = r['reasoning'] as { effort?: unknown } | undefined;
  const nestedEffort = nested?.effort;
  if (typeof nestedEffort !== 'string' || !nestedEffort) {
    return request;
  }

  const next: Record<string, unknown> = { ...r };
  // Don't clobber an already-set top-level reasoning_effort (user override
  // via samplingParams or extra_body).
  if (
    typeof next['reasoning_effort'] !== 'string' ||
    !next['reasoning_effort']
  ) {
    // Backward-compat mapping per the doc: low/medium → high, xhigh → max.
    // Surface it client-side so logs reflect the wire value the server will
    // actually act on (the server does the same mapping if we passed the
    // raw value through, but explicit is better for observability).
    let normalized = nestedEffort;
    if (normalized === 'low' || normalized === 'medium') normalized = 'high';
    else if (normalized === 'xhigh') normalized = 'max';
    next['reasoning_effort'] = normalized;
  }

  // Drop only the duplicated `effort` key from the nested form so we don't
  // ship two competing values for the same knob. Other keys inside
  // `reasoning` (e.g. an extra_body-injected `budget_tokens`) stay
  // intact — they're orthogonal data the server can ignore or honor on
  // its own, and silently swallowing them here would be a surprise.
  if (nested && Object.keys(nested).length === 1) {
    delete next['reasoning'];
  } else if (nested) {
    const { effort: _drop, ...rest } = nested as Record<string, unknown>;
    next['reasoning'] = rest;
  }
  return next as unknown as OpenAI.Chat.ChatCompletionCreateParams;
}

// DeepSeek's thinking mode requires reasoning_content to be replayed on every
// prior assistant turn, including ones without tool_calls. The model may
// legitimately return a turn without reasoning text, so the field can be
// missing when we rebuild the request. Send an empty string in that case so
// the API contract is satisfied. https://github.com/QwenLM/qwen-code/issues/3695
function ensureReasoningContentOnToolCalls(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role !== 'assistant') {
    return message;
  }
  const extended = message as ExtendedChatCompletionAssistantMessageParam;
  if (
    typeof extended.reasoning_content === 'string' &&
    extended.reasoning_content.length > 0
  ) {
    return message;
  }
  return {
    ...extended,
    reasoning_content: '',
  } as OpenAI.Chat.ChatCompletionMessageParam;
}
