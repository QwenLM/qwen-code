/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Message helpers for compression-v2.
 *
 * compression-v2 directly uses the runtime `Message` type from
 * `protocol/transcript/message.ts` (the `UserMessage | AssistantMessage | …`
 * discriminated union).  This module re-exports block-level types and provides
 * thin accessor helpers so compression stages don't need to know the internal
 * shape of each message variant.
 */

// ---------------------------------------------------------------------------
// Re-exports: content block types already defined elsewhere
// ---------------------------------------------------------------------------

// Re-export the runtime Message union so compression-v2 consumers can import
// from a single module.
export type {
  Message,
  UserMessage,
  AssistantMessage,
  ContentBlockParam,
} from '../protocol/transcript/message.js';

// ---------------------------------------------------------------------------
// MessageBlock — union of all block types that can appear in message content
// ---------------------------------------------------------------------------

import type {
  ContentBlock,
  TextBlock,
  ToolUseBlock,
} from '../protocol/transcript/message.js';
import type {
  Message,
  ContentBlockParam,
  ToolResultBlockParam,
} from '../protocol/transcript/message.js';

/** A single content block in a message (union of assistant-side and user-side blocks). */
export type MessageBlock = ContentBlock | ContentBlockParam;

// ---------------------------------------------------------------------------
// Accessor helpers — uniform access to role / content across message variants
// ---------------------------------------------------------------------------

/**
 * Get the wire role ('user' | 'assistant') from a runtime Message.
 * Only UserMessage and AssistantMessage are expected in compression;
 * other variants return 'user' as a safe fallback.
 */
export function getRole(msg: Message): 'user' | 'assistant' {
  if (msg.type === 'assistant') {
    return 'assistant';
  }
  return 'user';
}

/**
 * Get content blocks from a runtime Message as a flat `MessageBlock[]`.
 *
 * - `UserMessage.message.content` may be `string` → normalised to `[{type:'text', text}]`
 * - `AssistantMessage.message.content` 使用独立会话 `ContentBlock[]`
 * - Other message variants are treated as empty.
 */
export function getContentBlocks(msg: Message): MessageBlock[] {
  switch (msg.type) {
    case 'user': {
      const content = msg.message.content;
      if (!content) return [];
      if (typeof content === 'string') {
        return [{ type: 'text', text: content }];
      }
      return [...content];
    }
    case 'assistant':
      return msg.message.content.slice();
    default:
      return [];
  }
}

/**
 * Return a shallow clone of the message with its content blocks replaced.
 * Preserves uuid, timestamp, and all other metadata.
 */
export function withContent(msg: Message, content: MessageBlock[]): Message {
  if (msg.type === 'user') {
    return {
      ...msg,
      message: {
        ...msg.message,
        content: content.map((block): ContentBlockParam => {
          if (
            block.type === 'text' ||
            block.type === 'image' ||
            block.type === 'tool_result'
          ) {
            return block;
          }
          throw new Error(`用户消息不能包含 ${block.type} 块`);
        }),
      },
    };
  }
  if (msg.type === 'assistant') {
    return {
      ...msg,
      message: {
        ...msg.message,
        content: content.map((block): ContentBlock => {
          if (block.type !== 'image' && block.type !== 'tool_result') {
            return block;
          }
          throw new Error(`助手消息不能包含 ${block.type} 块`);
        }),
      },
    };
  }
  // Other variants — return unchanged (shouldn't happen in compression)
  return msg;
}

// ---------------------------------------------------------------------------
// Type guards — simplify format-checking in compression-v2 internals
// ---------------------------------------------------------------------------

export function isTextBlock(block: MessageBlock): block is TextBlock {
  return block.type === 'text';
}

export function isToolUseBlock(block: MessageBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

export function isToolResultBlock(
  block: MessageBlock,
): block is ToolResultBlockParam {
  return block.type === 'tool_result';
}

// ---------------------------------------------------------------------------
// Shared helpers used across compression-v2 stages
// ---------------------------------------------------------------------------

/**
 * Build a mapping from tool_use_id → tool name by scanning assistant messages
 * for tool_use blocks.
 */
export function buildToolUseIdToNameMap(
  history: readonly Message[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const message of history) {
    if (message.type !== 'assistant') continue;
    for (const block of getContentBlocks(message)) {
      if (isToolUseBlock(block)) {
        map.set(block.id, block.name);
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Token estimation bridge
// ---------------------------------------------------------------------------

import { estimateRequestBlockTokens } from '../utils/request-token-count.js';
import { estimateTextTokens } from '../utils/tokenCalculation.js';

/** Count a content fragment using the same rules as a complete request. */
export function estimateBlocksTokenCount(
  blocks: readonly MessageBlock[],
): number {
  return Math.floor(
    blocks.reduce((total, block) => {
      if (!isToolResultBlock(block)) {
        return total + estimateRequestBlockTokens(block);
      }
      const content = block.content;
      return (
        total +
        (typeof content === 'string'
          ? estimateTextTokens(content)
          : content.reduce(
              (sum, part) => sum + estimateRequestBlockTokens(part),
              0,
            ))
      );
    }, 0),
  );
}
