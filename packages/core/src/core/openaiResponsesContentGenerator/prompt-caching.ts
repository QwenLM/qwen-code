/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfig } from '../contentGenerator.js';
import { supportsExplicitOpenAIPromptCaching } from '../openaiContentGenerator/prefix-caching.js';
import { normalizeOpenAiWireBaseUrl } from '../openaiContentGenerator/constants.js';
import type { ResponsesApiRequest } from './types.js';

/** End of the stable prefix, before request-only memory or image reattachment. */
export interface ResponsesCacheBoundary {
  itemIndex: number;
  contentIndex?: number;
}

export function applyResponsesPromptCaching(
  request: ResponsesApiRequest,
  config: ContentGeneratorConfig,
  boundary: ResponsesCacheBoundary | undefined,
): ResponsesApiRequest {
  const options = request.prompt_cache_options;
  if (
    !boundary ||
    config.enableCacheControl === false ||
    !supportsExplicitOpenAIPromptCaching(request.model) ||
    (options !== undefined &&
      (!options ||
        typeof options !== 'object' ||
        (options.mode !== undefined && options.mode !== 'implicit')))
  ) {
    return request;
  }
  // A compatible proxy must opt in; its model name alone is not a capability.
  const official =
    new URL(normalizeOpenAiWireBaseUrl(config.baseUrl)).hostname ===
    'api.openai.com';
  if (!official && config.enableCacheControl !== true && !options) {
    return request;
  }
  if (
    request.input.some((item) => {
      const blocks =
        item.type === 'message'
          ? item.content
          : item.type === 'function_call_output' ||
              item.type === 'custom_tool_call_output'
            ? item.output
            : undefined;
      return (
        Array.isArray(blocks) &&
        blocks.some((block) => 'prompt_cache_breakpoint' in block)
      );
    })
  ) {
    return request;
  }

  // Normalize every historical text output, including ones whose marker has
  // aged out. Rotating markers must not reshape the earlier rendered prefix.
  const input = request.input.map((item) => {
    if (
      item.type === 'function_call_output' &&
      typeof item.output === 'string'
    ) {
      return {
        ...item,
        output: [{ type: 'input_text' as const, text: item.output }],
      };
    }
    if (
      item.type === 'message' &&
      item.role === 'user' &&
      typeof item.content === 'string'
    ) {
      return {
        ...item,
        content: [{ type: 'input_text' as const, text: item.content }],
      };
    }
    return item;
  });
  const candidates: ResponsesCacheBoundary[] = [];
  for (let index = 0; index <= boundary.itemIndex; index++) {
    const item = input[index];
    const next = input[index + 1];
    const blocks =
      item?.type === 'message' && item.role === 'user'
        ? item.content
        : item?.type === 'function_call_output' &&
            next?.type !== 'function_call_output' &&
            next?.type !== 'custom_tool_call_output'
          ? item.output
          : undefined;
    if (!Array.isArray(blocks)) continue;
    const end =
      index === boundary.itemIndex && boundary.contentIndex !== undefined
        ? boundary.contentIndex
        : blocks.length - 1;
    for (let partIndex = end; partIndex >= 0; partIndex--) {
      if (blocks[partIndex]?.type !== 'input_text') continue;
      candidates.push({ itemIndex: index, contentIndex: partIndex });
      break;
    }
  }
  if (candidates.length === 0) return request;

  // The implicit tail uses the fourth write slot. Keep older boundaries for
  // lookup while the newest stable boundary grows on subsequent requests.
  for (const candidate of candidates.slice(-3)) {
    const item = input[candidate.itemIndex];
    if (item?.type !== 'message' && item?.type !== 'function_call_output') {
      continue;
    }
    const blocks = item.type === 'message' ? item.content : item.output;
    if (!Array.isArray(blocks)) continue;
    const marked = blocks.map((block, index) =>
      index === candidate.contentIndex && block.type === 'input_text'
        ? { ...block, prompt_cache_breakpoint: { mode: 'explicit' as const } }
        : block,
    );
    input[candidate.itemIndex] =
      item.type === 'message'
        ? { ...item, content: marked }
        : { ...item, output: marked };
  }
  return {
    ...request,
    input,
    prompt_cache_options: { mode: 'implicit', ...options },
  };
}
