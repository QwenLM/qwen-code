/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NonNullableUsage } from '../schemas/common.js';
import {
  isCacheReadUsageAvailable,
  isCacheWriteUsageAvailable,
  markCacheReadUsageAvailable,
  markCacheWriteUsageAvailable,
} from './empty-usage.js';

type UsageLikeWithThinking = Partial<NonNullableUsage> &
  Record<string, unknown>;

function readFiniteTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readOptionalThinkingTokenCount(
  usage?: UsageLikeWithThinking | null,
): number | undefined {
  if (!usage) return undefined;
  const completionTokenDetails = readRecord(usage['completion_tokens_details']);
  return (
    readFiniteTokenCount(usage['thinking_tokens']) ??
    readFiniteTokenCount(usage['thoughts_token_count']) ??
    readFiniteTokenCount(completionTokenDetails?.['reasoning_tokens'])
  );
}

function readOptionalTotalTokenCount(
  usage?: UsageLikeWithThinking | null,
): number | undefined {
  if (!usage) return undefined;
  return readFiniteTokenCount(usage['total_tokens']);
}

export function getThinkingTokenCount(
  usage?: UsageLikeWithThinking | null,
): number {
  return readOptionalThinkingTokenCount(usage) ?? 0;
}

export function getTotalTokenCount(
  usage?: UsageLikeWithThinking | null,
): number {
  const totalTokens = readOptionalTotalTokenCount(usage);
  if (totalTokens !== undefined) return totalTokens;
  if (!usage) return 0;

  return (
    (readFiniteTokenCount(usage.input_tokens) ?? 0) +
    (readFiniteTokenCount(usage.output_tokens) ?? 0) +
    getThinkingTokenCount(usage)
  );
}

export function attachThinkingTokenCount<T extends object>(
  usage: T,
  thinkingTokens: number | undefined,
): T & { thinking_tokens?: number; thoughts_token_count?: number } {
  const tokenCount = readFiniteTokenCount(thinkingTokens);
  if (tokenCount === undefined) return usage;
  // Keep this internal extension out of serialized SDK usage payloads.
  Object.defineProperties(usage, {
    thinking_tokens: {
      value: tokenCount,
      enumerable: false,
      writable: true,
      configurable: true,
    },
    thoughts_token_count: {
      value: tokenCount,
      enumerable: false,
      writable: true,
      configurable: true,
    },
  });
  return usage as T & {
    thinking_tokens?: number;
    thoughts_token_count?: number;
  };
}

function attachTotalTokenCount<T extends object>(
  usage: T,
  totalTokens: number | undefined,
): T & { total_tokens?: number } {
  const tokenCount = readFiniteTokenCount(totalTokens);
  if (tokenCount === undefined) return usage;
  // Preserve upstream total_tokens without serializing it into SDK usage.
  Object.defineProperty(usage, 'total_tokens', {
    value: tokenCount,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return usage as T & { total_tokens?: number };
}

/**
 * INVARIANT — `input_tokens` IS the complete prompt size.
 * OpenAI's `prompt_tokens` already includes cached tokens, so
 * `cache_read_input_tokens` is a SUBSET of `input_tokens`, not a sibling term.
 * Never compute context size as `input + cache_read (+ cache_creation)`.
 */
export function annotateContextUsageRatio(
  usage: NonNullableUsage,
  maxInputTokens: number | undefined,
): void {
  if (
    typeof maxInputTokens !== 'number' ||
    !Number.isFinite(maxInputTokens) ||
    maxInputTokens <= 0
  ) {
    return;
  }

  if (!Number.isFinite(usage.input_tokens)) {
    return;
  }

  (usage as NonNullableUsage & Record<string, unknown>)['context_usage_ratio'] =
    Math.min(1, Math.max(0, usage.input_tokens / maxInputTokens));
}

/**
 * 跨请求求和：将多轮 usage 累加到一起，用于 agent-loop 累积整个会话的 usage。
 *
 * 对于非数值字段（service_tier / inference_geo / iterations / speed），
 * 取 next 的值（后者优先）。
 */
export function addAnthropicUsage(
  accumulated: Readonly<NonNullableUsage>,
  next?: Partial<NonNullableUsage> | null,
): NonNullableUsage {
  if (!next) {
    const result: NonNullableUsage = {
      ...accumulated,
      server_tool_use: { ...accumulated.server_tool_use },
      cache_creation: { ...accumulated.cache_creation },
      iterations: [...accumulated.iterations],
    };
    delete result.credits;
    delete result.original_credits;
    delete result.billable;
    attachThinkingTokenCount(
      result,
      readOptionalThinkingTokenCount(accumulated),
    );
    attachTotalTokenCount(result, readOptionalTotalTokenCount(accumulated));
    markCacheReadUsageAvailable(
      result,
      isCacheReadUsageAvailable(accumulated),
    );
    markCacheWriteUsageAvailable(
      result,
      isCacheWriteUsageAvailable(accumulated),
    );
    return result;
  }

  const requestId = next.request_id ?? accumulated.request_id;
  const contextUsageRatio =
    (next as Record<string, unknown>)['context_usage_ratio'] ??
    (accumulated as Record<string, unknown>)['context_usage_ratio'];
  const hasContextUsageRatio =
    typeof contextUsageRatio === 'number' && Number.isFinite(contextUsageRatio);
  const result: NonNullableUsage = {
    input_tokens: accumulated.input_tokens + (next.input_tokens ?? 0),
    output_tokens: accumulated.output_tokens + (next.output_tokens ?? 0),
    cache_creation_input_tokens:
      accumulated.cache_creation_input_tokens +
      (next.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      accumulated.cache_read_input_tokens + (next.cache_read_input_tokens ?? 0),
    server_tool_use: {
      web_search_requests:
        accumulated.server_tool_use.web_search_requests +
        (next.server_tool_use?.web_search_requests ?? 0),
      web_fetch_requests:
        accumulated.server_tool_use.web_fetch_requests +
        (next.server_tool_use?.web_fetch_requests ?? 0),
    },
    cache_creation: {
      ephemeral_1h_input_tokens:
        accumulated.cache_creation.ephemeral_1h_input_tokens +
        (next.cache_creation?.ephemeral_1h_input_tokens ?? 0),
      ephemeral_5m_input_tokens:
        accumulated.cache_creation.ephemeral_5m_input_tokens +
        (next.cache_creation?.ephemeral_5m_input_tokens ?? 0),
    },
    service_tier: next.service_tier ?? accumulated.service_tier,
    inference_geo: next.inference_geo ?? accumulated.inference_geo,
    iterations: next.iterations ?? accumulated.iterations,
    speed: next.speed ?? accumulated.speed,
    ...(requestId !== undefined ? { request_id: requestId } : {}),
    ...(hasContextUsageRatio ? { context_usage_ratio: contextUsageRatio } : {}),
  };
  const thinkingTokens =
    (readOptionalThinkingTokenCount(accumulated) ?? 0) +
    (readOptionalThinkingTokenCount(next) ?? 0);
  const accumulatedTotalTokens = readOptionalTotalTokenCount(accumulated);
  const nextTotalTokens = readOptionalTotalTokenCount(next);
  const totalTokens =
    accumulatedTotalTokens !== undefined || nextTotalTokens !== undefined
      ? (accumulatedTotalTokens ?? getTotalTokenCount(accumulated)) +
        (nextTotalTokens ?? getTotalTokenCount(next))
      : undefined;
  attachTotalTokenCount(result, totalTokens);
  attachThinkingTokenCount(result, thinkingTokens);
  markCacheReadUsageAvailable(
    result,
    isCacheReadUsageAvailable(accumulated) || isCacheReadUsageAvailable(next),
  );
  markCacheWriteUsageAvailable(
    result,
    isCacheWriteUsageAvailable(accumulated) ||
      isCacheWriteUsageAvailable(next),
  );
  return result;
}
