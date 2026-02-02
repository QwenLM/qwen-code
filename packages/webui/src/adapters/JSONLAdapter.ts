/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapter for JSONL format messages (used by ChatViewer)
 */

import type {
  UnifiedMessage,
  JSONLMessage,
  UnifiedMessageType,
} from './types.js';

/**
 * Extract text content from different message formats
 */
function extractContent(message?: {
  parts?: Array<{ text: string }>;
  content?: string | unknown[];
}): string {
  if (!message) return '';

  // Qwen format: parts array
  if (message.parts?.length) {
    return message.parts.map((p) => p.text).join('');
  }

  // Claude format: string content
  if (typeof message.content === 'string') {
    return message.content;
  }

  // Claude format: content array
  if (Array.isArray(message.content)) {
    return message.content
      .filter(
        (item): item is { type: 'text'; text: string } =>
          typeof item === 'object' &&
          item !== null &&
          'type' in item &&
          item.type === 'text',
      )
      .map((item) => item.text)
      .join('');
  }

  return '';
}

/**
 * Parse timestamp string to milliseconds
 */
function parseTimestamp(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return isNaN(parsed) ? Date.now() : parsed;
}

/**
 * Determine the unified message type from JSONL message
 */
function getMessageType(msg: JSONLMessage): UnifiedMessageType {
  if (msg.type === 'tool_call') {
    return 'tool_call';
  }
  if (msg.type === 'user') {
    return 'user';
  }
  if (msg.message?.role === 'thinking') {
    return 'thinking';
  }
  return 'assistant';
}

/**
 * Check if a message is a user type (breaks AI sequence)
 */
function isUserType(msg: JSONLMessage | undefined): boolean {
  return !msg || msg.type === 'user';
}

/**
 * Adapt JSONL messages to unified format
 *
 * @param messages - Array of JSONL messages
 * @returns Array of unified messages with timeline positions calculated
 */
export function adaptJSONLMessages(messages: JSONLMessage[]): UnifiedMessage[] {
  // Sort by timestamp
  const sorted = [...messages].sort(
    (a, b) => parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp),
  );

  return sorted.map((msg, index, arr) => {
    const prev = arr[index - 1];
    const next = arr[index + 1];

    // Calculate timeline position
    const isFirst = isUserType(prev);
    const isLast = isUserType(next);

    const type = getMessageType(msg);

    return {
      id: msg.uuid,
      type,
      timestamp: parseTimestamp(msg.timestamp),
      content: type !== 'tool_call' ? extractContent(msg.message) : undefined,
      toolCall: msg.toolCall,
      isFirst,
      isLast,
    };
  });
}

/**
 * Filter out empty messages (except tool calls)
 */
export function filterEmptyMessages(
  messages: UnifiedMessage[],
): UnifiedMessage[] {
  return messages.filter((msg) => {
    if (msg.type === 'tool_call') return true;
    return msg.content && msg.content.trim().length > 0;
  });
}
