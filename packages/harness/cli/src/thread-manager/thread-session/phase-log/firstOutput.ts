/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SDKMessage } from '@qwen-code/core';

/** Main-agent visible answer text; thinking, tool calls and subagent output do not count. */
export function isFirstTextMessage(message: SDKMessage): boolean {
  if (message.type === 'stream_event') {
    if (message.parent_tool_use_id !== null) return false;
    const event = message.event;
    return (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta' &&
      event.delta.text.length > 0
    );
  }
  if (message.type === 'assistant') {
    if (message.parent_tool_use_id !== null) return false;
    const content: unknown = message.message.content;
    return (
      Array.isArray(content) &&
      content.some(
        (block: { type?: unknown; text?: unknown }) =>
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.length > 0,
      )
    );
  }
  return false;
}
