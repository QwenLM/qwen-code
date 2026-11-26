/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ModelCacheControl,
  ModelPrompt,
  ModelStreamMessage,
} from '../modelStreamRequest.js';

type CacheableContent =
  | string
  | ReadonlyArray<{
      readonly type: string;
      readonly cacheControl?: ModelCacheControl;
    }>;

/**
 * 按 provider 缓存策略改写提示词断点。
 * cacheControl 缺省表示该模型不支持断点：清除上游已有标记；
 * 否则统一已有块断点及工具整体断点的 TTL，并在前置 system 的末个非空块补一个断点。
 * 无改写时返回原 prompt。
 */
export function applyPromptCachePolicy(
  prompt: ModelPrompt,
  cacheControl: ModelCacheControl | undefined,
): ModelPrompt {
  let messages: ModelStreamMessage[] | undefined;
  prompt.messages.forEach((message, i) => {
    let next = rewriteContent(message, cacheControl);
    if (next.role === 'tool' && next.cacheControl) {
      if (cacheControl) {
        next = { ...next, cacheControl };
      } else {
        const { cacheControl: _dropped, ...rest } = next;
        next = rest;
      }
    }
    if (next === message) return;
    messages ??= prompt.messages.slice();
    messages[i] = next;
  });
  if (cacheControl) {
    const system = markSystemTail(messages ?? prompt.messages, cacheControl);
    if (system) {
      messages ??= prompt.messages.slice();
      messages[system.index] = system.message;
    }
  }
  return messages ? { ...prompt, messages } : prompt;
}

function rewriteContent<M extends { readonly content: CacheableContent }>(
  message: M,
  cacheControl: ModelCacheControl | undefined,
): M {
  const { content } = message;
  if (typeof content === 'string') return message;
  if (!content.some((block) => block.cacheControl)) return message;
  return {
    ...message,
    content: content.map((block) => {
      if (!block.cacheControl) return block;
      if (cacheControl) return { ...block, cacheControl };
      const { cacheControl: _dropped, ...rest } = block;
      return rest;
    }),
  };
}

function markSystemTail(
  messages: readonly ModelStreamMessage[],
  cacheControl: ModelCacheControl,
): { index: number; message: ModelStreamMessage } | undefined {
  const end = messages.findIndex((message) => message.role !== 'system');
  const index = (end < 0 ? messages.length : end) - 1;
  const system = messages[index];
  if (system?.role !== 'system') return undefined;
  const blocks =
    typeof system.content === 'string'
      ? [{ type: 'text' as const, text: system.content }]
      : system.content;
  const tail = blocks.findLastIndex((block) => block.text.length > 0);
  if (tail < 0) return undefined;
  return {
    index,
    message: {
      role: 'system',
      content: blocks.map((block, i) =>
        i === tail ? { ...block, cacheControl } : block,
      ),
    },
  };
}
