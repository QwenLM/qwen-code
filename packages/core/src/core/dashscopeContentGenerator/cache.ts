/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DashScopeContentBlock, DashScopeMessage } from './types.js';

export interface PlanCacheMarkersOptions {
  enabled: boolean;
  streaming: boolean;
}

/**
 * Plans the explicit prompt-cache breakpoints for one request's messages.
 * Pure and non-mutating: the input array and its messages/blocks are never
 * modified, only shallow-cloned where a marker is attached.
 *
 * Anchors (api-contract.md §7, live-verified profitable):
 *   1. The first `role: 'system'` message — always marked when enabled.
 *   2. The last message of the request — only on streaming requests (the
 *      rolling marker that makes turn N+1 hit turn N's prefix). Non-streaming
 *      one-shot side queries must not churn the rolling breakpoint.
 */
export function planCacheMarkers(
  messages: DashScopeMessage[],
  opts: PlanCacheMarkersOptions,
): DashScopeMessage[] {
  if (!opts.enabled) {
    return messages;
  }

  const systemIndex = messages.findIndex(
    (message) => message.role === 'system',
  );
  const lastIndex = opts.streaming ? messages.length - 1 : -1;

  const anchors = new Set<number>();
  if (systemIndex >= 0) {
    anchors.add(systemIndex);
  }
  if (lastIndex >= 0) {
    anchors.add(lastIndex);
  }

  if (anchors.size === 0) {
    return messages;
  }

  return messages.map((message, index) =>
    anchors.has(index) ? markMessageWithCacheControl(message) : message,
  );
}

/**
 * Shallow-clones `message` and attaches `cache_control: { type: 'ephemeral' }`
 * to the last content block that carries a `text` field, promoting a plain
 * string `content` to array form first. Returns the original message
 * unchanged when no text block exists (e.g. a media-only message) — the
 * marker is silently skipped rather than throwing.
 */
function markMessageWithCacheControl(
  message: DashScopeMessage,
): DashScopeMessage {
  const blocks: DashScopeContentBlock[] =
    typeof message.content === 'string'
      ? [{ text: message.content }]
      : (message.content ?? []).map((block) => ({ ...block }));

  let lastTextIndex = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (typeof blocks[i]?.text === 'string') {
      lastTextIndex = i;
      break;
    }
  }

  if (lastTextIndex === -1) {
    return message;
  }

  blocks[lastTextIndex] = {
    ...blocks[lastTextIndex],
    cache_control: { type: 'ephemeral' },
  };

  return { ...message, content: blocks };
}
