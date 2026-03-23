/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';

/** Gemini-scale windows — trimming is unnecessary. */
export const CONTEXT_BUDGET_TRIM_SKIP_THRESHOLD = 1_000_000;

const CONTEXT_BUDGET_RATIO = 0.7;
const MIN_TOOL_CONTENT_CHARS = 500;

function estimateTokens(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  tools?: unknown,
): number {
  const msgLen = JSON.stringify(messages).length;
  const toolLen = tools ? JSON.stringify(tools).length : 0;
  return Math.ceil((msgLen + toolLen) / 3);
}

/**
 * Estimates serialized request size vs context limit and trims large tool
 * results (then drops old tool pairs) so OpenAI-compatible backends are less
 * likely to reject the request before compression runs.
 */
export function trimMessagesForContextBudget(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  tools: unknown | undefined,
  contextTokenLimit: number,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const limit = contextTokenLimit;
  if (limit >= CONTEXT_BUDGET_TRIM_SKIP_THRESHOLD) {
    return messages;
  }

  const budget = Math.floor(limit * CONTEXT_BUDGET_RATIO);
  let estimate = estimateTokens(messages, tools);
  if (estimate <= budget) {
    return messages;
  }

  const toolIndices: Array<{ idx: number; len: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool') continue;
    const content = (msg as OpenAI.Chat.ChatCompletionToolMessageParam).content;
    if (typeof content === 'string') {
      toolIndices.push({ idx: i, len: content.length });
    }
  }
  toolIndices.sort((a, b) => b.len - a.len);

  const trimmed = messages.map((m) => ({ ...m }));

  for (const { idx } of toolIndices) {
    if (estimate <= budget) break;

    const tm = trimmed[idx] as OpenAI.Chat.ChatCompletionToolMessageParam;
    const content = tm.content;
    if (
      typeof content !== 'string' ||
      content.length <= MIN_TOOL_CONTENT_CHARS
    ) {
      continue;
    }

    const maxCharsPerTool = Math.max(
      MIN_TOOL_CONTENT_CHARS,
      Math.floor((budget * 3) / Math.max(toolIndices.length, 1)),
    );
    const keep = Math.min(
      Math.max(MIN_TOOL_CONTENT_CHARS, Math.floor(content.length * 0.05)),
      maxCharsPerTool,
    );
    const half = Math.floor(keep / 2);
    const head = content.slice(0, half);
    const tail = content.slice(-half);
    const dropped = content.length - keep;
    tm.content = `${head}\n\n[... ${dropped} characters trimmed to fit ${limit} token context window ...]\n\n${tail}`;

    estimate = estimateTokens(trimmed, tools);
  }

  while (estimate > budget && trimmed.length > 4) {
    const dropIdx = trimmed.findIndex((m, i) => i >= 2 && m.role === 'tool');
    if (dropIdx === -1) break;
    if (dropIdx > 0 && trimmed[dropIdx - 1].role === 'assistant') {
      trimmed.splice(dropIdx - 1, 2);
    } else {
      trimmed.splice(dropIdx, 1);
    }
    estimate = estimateTokens(trimmed, tools);
  }

  return trimmed;
}
