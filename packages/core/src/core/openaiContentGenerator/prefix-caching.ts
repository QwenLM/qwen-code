/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import { AuthType, type ContentGeneratorConfig } from '../contentGenerator.js';

type OpenAIRequestWithExplicitCaching =
  OpenAI.Chat.ChatCompletionCreateParams & {
    prompt_cache_options?: {
      mode?: 'implicit' | 'explicit';
      ttl?: string;
    };
  };

type OpenAIContentPartWithBreakpoint = OpenAI.Chat.ChatCompletionContentPart & {
  prompt_cache_breakpoint?: { mode: 'explicit' };
};

const CACHE_KEY_PREFIX = 'qwen-code:';
const EXPLICIT_BREAKPOINT_COUNT = 2;

export function supportsOpenAIPrefixCaching(
  contentGeneratorConfig: ContentGeneratorConfig,
): boolean {
  return (
    contentGeneratorConfig.authType === AuthType.USE_OPENAI ||
    contentGeneratorConfig.authType === AuthType.QWEN_OAUTH
  );
}

export function isOfficialOpenAIEndpoint(
  contentGeneratorConfig: ContentGeneratorConfig,
): boolean {
  if (contentGeneratorConfig.authType !== AuthType.USE_OPENAI) return false;
  const { baseUrl } = contentGeneratorConfig;
  // An unset base URL is routed to the DashScope provider by provider
  // selection, so only an explicit official OpenAI endpoint qualifies.
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

export function supportsExplicitOpenAIPromptCaching(model: string): boolean {
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:[-.]|$)/i.exec(model);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6);
}

function withCacheBreakpoint(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.ChatCompletionMessageParam | undefined {
  if (message.role !== 'user' && message.role !== 'tool') return undefined;
  const marker = { prompt_cache_breakpoint: { mode: 'explicit' as const } };
  if (typeof message.content === 'string') {
    return {
      ...message,
      content: [{ type: 'text', text: message.content, ...marker }],
    };
  }
  if (!Array.isArray(message.content) || message.content.length === 0) {
    return undefined;
  }
  const content = [...message.content] as OpenAIContentPartWithBreakpoint[];
  const lastIndex = content.length - 1;
  content[lastIndex] = { ...content[lastIndex], ...marker };
  return { ...message, content } as OpenAI.Chat.ChatCompletionMessageParam;
}

export function applyOfficialOpenAIPromptCaching(
  request: OpenAI.Chat.ChatCompletionCreateParams,
  sessionId: string | undefined,
  cacheSharing: boolean,
  cacheKeyPartition?: string,
): OpenAI.Chat.ChatCompletionCreateParams {
  const result = { ...request } as OpenAIRequestWithExplicitCaching;
  if (sessionId && !result.prompt_cache_key) {
    const partition = cacheKeyPartition ? `:${cacheKeyPartition}` : '';
    result.prompt_cache_key = `${CACHE_KEY_PREFIX}${sessionId}${partition}`;
  }
  if (!cacheSharing || !supportsExplicitOpenAIPromptCaching(request.model)) {
    return result;
  }

  const messages = [...request.messages];
  let marked = 0;
  // Skip the trailing compression directive. Two earlier user/tool boundaries
  // cover both the last main request and an unsent pending tool result.
  for (
    let index = messages.length - 2;
    index >= 0 && marked < EXPLICIT_BREAKPOINT_COUNT;
    index -= 1
  ) {
    const message = messages[index];
    const updated = message ? withCacheBreakpoint(message) : undefined;
    if (!updated) continue;
    messages[index] = updated;
    marked += 1;
  }
  if (marked === 0) return result;

  result.messages = messages;
  result.prompt_cache_options = {
    ...result.prompt_cache_options,
    mode: 'explicit',
  };
  return result;
}
