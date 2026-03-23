/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type Anthropic from '@anthropic-ai/sdk';

/** Gemini-scale windows — trimming is unnecessary. */
export const CONTEXT_BUDGET_TRIM_SKIP_THRESHOLD = 1_000_000;

const CONTEXT_BUDGET_RATIO = 0.7;
const MIN_TOOL_CONTENT_CHARS = 500;

type AnthropicMessageParam = Anthropic.MessageParam;
type AnthropicContentBlockParam = Anthropic.ContentBlockParam;

function estimateTokens(
  messages: AnthropicMessageParam[],
  system: string | Anthropic.TextBlockParam[] | undefined,
  tools?: unknown,
): number {
  const msgLen = JSON.stringify(messages).length;
  const sysLen = system ? JSON.stringify(system).length : 0;
  const toolLen = tools ? JSON.stringify(tools).length : 0;
  return Math.ceil((msgLen + sysLen + toolLen) / 3);
}

/**
 * Estimates serialized request size vs context limit and trims large tool
 * results (then drops old message pairs) so Anthropic native API is less
 * likely to reject the request before compression runs.
 */
export function trimAnthropicMessagesForContextBudget(
  messages: AnthropicMessageParam[],
  system: string | Anthropic.TextBlockParam[] | undefined,
  tools: unknown | undefined,
  contextTokenLimit: number,
): {
  messages: AnthropicMessageParam[];
  system: string | Anthropic.TextBlockParam[] | undefined;
} {
  const limit = contextTokenLimit;
  if (limit >= CONTEXT_BUDGET_TRIM_SKIP_THRESHOLD) {
    return { messages, system };
  }

  const budget = Math.floor(limit * CONTEXT_BUDGET_RATIO);
  let estimate = estimateTokens(messages, system, tools);
  if (estimate <= budget) {
    return { messages, system };
  }

  // Find tool_result blocks in user messages and collect indices
  const toolResultIndices: Array<{
    msgIdx: number;
    blockIdx: number;
    len: number;
  }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') continue;
    const blocks = msg.content as AnthropicContentBlockParam[];
    for (let j = 0; j < blocks.length; j++) {
      const block = blocks[j];
      if (block.type === 'tool_result') {
        const content = block.content;
        if (typeof content === 'string') {
          toolResultIndices.push({
            msgIdx: i,
            blockIdx: j,
            len: content.length,
          });
        }
      }
    }
  }
  toolResultIndices.sort((a, b) => b.len - a.len);

  const trimmed = messages.map((m) => ({
    ...m,
    content:
      typeof m.content === 'string'
        ? m.content
        : (m.content as AnthropicContentBlockParam[]).map((b) => ({ ...b })),
  })) as AnthropicMessageParam[];

  for (const { msgIdx, blockIdx } of toolResultIndices) {
    if (estimate <= budget) break;

    const msg = trimmed[msgIdx];
    if (typeof msg.content === 'string') continue;
    const blocks = msg.content as AnthropicContentBlockParam[];
    const block = blocks[blockIdx];
    if (block.type !== 'tool_result') continue;
    const content = block.content;
    if (
      typeof content !== 'string' ||
      content.length <= MIN_TOOL_CONTENT_CHARS
    ) {
      continue;
    }

    const maxCharsPerTool = Math.max(
      MIN_TOOL_CONTENT_CHARS,
      Math.floor((budget * 3) / Math.max(toolResultIndices.length, 1)),
    );
    const keep = Math.min(
      Math.max(MIN_TOOL_CONTENT_CHARS, Math.floor(content.length * 0.05)),
      maxCharsPerTool,
    );
    const half = Math.floor(keep / 2);
    const head = content.slice(0, half);
    const tail = content.slice(-half);
    const dropped = content.length - keep;
    block.content = `${head}\n\n[... ${dropped} characters trimmed to fit ${limit} token context window ...]\n\n${tail}`;

    estimate = estimateTokens(trimmed, system, tools);
  }

  // If still over budget, drop oldest tool result pairs from the middle
  while (estimate > budget && trimmed.length > 4) {
    // Find earliest user message with tool_result after system/first-user block
    const dropIdx = trimmed.findIndex((m, i) => {
      if (i < 2) return false;
      if (m.role !== 'user') return false;
      if (typeof m.content === 'string') return false;
      const blocks = m.content as AnthropicContentBlockParam[];
      return blocks.some((b) => b.type === 'tool_result');
    });
    if (dropIdx === -1) break;
    // Also remove the preceding assistant message that requested this tool call
    if (dropIdx > 0 && trimmed[dropIdx - 1].role === 'assistant') {
      trimmed.splice(dropIdx - 1, 2);
    } else {
      trimmed.splice(dropIdx, 1);
    }
    estimate = estimateTokens(trimmed, system, tools);
  }

  return { messages: trimmed, system };
}
