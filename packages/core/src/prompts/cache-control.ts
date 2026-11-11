/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cache Control 工具
 *
 * - getCacheControl()       : 构造 cache_control 对象（messages 层使用）
 * - addCacheBreakpoints()   : 在对话历史最后一条消息上注入 cache_control 断点
 *
 * System prompt 使用普通 text block，不在客户端设置 cache_control。
 */

import type { CacheScope } from './types.js';
import type { ModelStreamMessage } from '../provider/modelStreamRequest.js';

// ---------------------------------------------------------------------------
// getCacheControl
// ---------------------------------------------------------------------------

/** cache_control 块格式 */
export interface CacheControlEntry {
  type: 'ephemeral';
  ttl?: '1h';
  scope?: CacheScope;
}

/**
 * 构造 cache_control 对象。
 * scope='global' 仅在 1P global cache 模式下出现。
 */
export function getCacheControl(opts: {
  scope: CacheScope;
  use1hTTL: boolean;
}): CacheControlEntry {
  return {
    type: 'ephemeral',
    ...(opts.use1hTTL && { ttl: '1h' }),
    ...(opts.scope === 'global' && { scope: 'global' as const }),
  };
}

// ---------------------------------------------------------------------------
// addCacheBreakpoints
// ---------------------------------------------------------------------------

/** 只有当前支持的文本和图片块可以标记缓存断点。 */
const CACHEABLE_BLOCK_TYPES = new Set(['text', 'image']);

/**
 * Inject a prompt-cache breakpoint onto the last cacheable content block of
 * the last message in `messages`.
 *
 * The Anthropic / product API caches up to the most recently-marked block.
 * By marking the last cacheable block in the conversation history, each turn
 * can reuse the cache from the previous turn, dramatically reducing costs for
 * long conversations.
 *
 * Rules:
 * - 只有 text/image 块允许 cache_control；其他块不设置缓存断点。
 * - If `skipCacheWrite` is true (fork / fire-and-forget mode), mark the
 *   second-to-last message instead so the current turn is NOT written to cache
 *   (avoiding polluting the cache with one-off branches).
 * - If the target message has string content (not an array), no breakpoint is
 *   added (string content has no granular block structure to tag).
 * - Returns a new array; input is not mutated.
 *
 * @param messages - 已完成工具结果配对的标准请求消息
 * @param skipCacheWrite - When true, mark the penultimate message instead
 */
export function addCacheBreakpoints(
  messages: readonly ModelStreamMessage[],
  skipCacheWrite = false,
): ModelStreamMessage[] {
  if (messages.length === 0) return [];

  // Choose which message to mark
  const targetIdx = skipCacheWrite ? messages.length - 2 : messages.length - 1;

  if (targetIdx < 0) return [...messages];

  const target = messages[targetIdx];
  if (typeof target.content === 'string') return [...messages];

  // Find the last cacheable block (scanning from the end)
  let lastCacheableIdx = -1;
  for (let i = target.content.length - 1; i >= 0; i--) {
    const block = target.content[i];
    if (block?.type && CACHEABLE_BLOCK_TYPES.has(block.type)) {
      lastCacheableIdx = i;
      break;
    }
  }

  if (lastCacheableIdx === -1) return [...messages];

  const mark = <T extends { readonly type: string }>(blocks: readonly T[]) =>
    blocks.map((block, index) => index === lastCacheableIdx
      ? { ...block, cacheControl: { type: 'ephemeral' as const } }
      : block);
  const newMessages = [...messages];
  switch (target.role) {
    case 'system':
      if (typeof target.content !== 'string')
        newMessages[targetIdx] = { ...target, content: mark(target.content) };
      break;
    case 'user':
      if (typeof target.content !== 'string')
        newMessages[targetIdx] = { ...target, content: mark(target.content) };
      break;
    case 'tool':
      if (typeof target.content !== 'string')
        newMessages[targetIdx] = { ...target, content: mark(target.content) };
      break;
    case 'assistant':
      if (typeof target.content !== 'string')
        newMessages[targetIdx] = { ...target, content: mark(target.content) };
      break;
    default:
      break;
  }
  return newMessages;
}
