/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapter for ACP protocol messages (used by vscode-ide-companion)
 */

import type {
  UnifiedMessage,
  ACPMessage,
  ACPMessageData,
  ToolCallData,
} from './types.js';

/**
 * Check if a message is a user message (breaks AI sequence)
 */
function isUserMessage(msg: ACPMessage | undefined): boolean {
  if (!msg) return true;
  if (msg.type !== 'message') return false;
  const data = msg.data as ACPMessageData;
  return data?.role === 'user';
}

/**
 * Adapt ACP messages to unified format
 *
 * @param messages - Array of ACP messages from vscode-ide-companion
 * @returns Array of unified messages with timeline positions calculated
 */
export function adaptACPMessages(messages: ACPMessage[]): UnifiedMessage[] {
  return messages.map((item, index, arr) => {
    const prev = arr[index - 1];
    const next = arr[index + 1];

    // Calculate timeline position
    const isFirst = isUserMessage(prev);
    const isLast = isUserMessage(next);

    switch (item.type) {
      case 'message': {
        const msg = item.data as ACPMessageData;
        return {
          id: `msg-${index}`,
          type:
            msg.role === 'user'
              ? 'user'
              : msg.role === 'thinking'
                ? 'thinking'
                : 'assistant',
          timestamp: msg.timestamp || Date.now(),
          content: msg.content,
          fileContext: msg.fileContext,
          isFirst,
          isLast,
        };
      }

      case 'in-progress-tool-call':
      case 'completed-tool-call': {
        const toolCall = item.data as ToolCallData;
        return {
          id: `tool-${toolCall.toolCallId}-${item.type}`,
          type: 'tool_call',
          timestamp: Date.now(),
          toolCall,
          isFirst,
          isLast,
        };
      }

      default:
        // Fallback for unknown types
        return {
          id: `unknown-${index}`,
          type: 'assistant',
          timestamp: Date.now(),
          content: '',
          isFirst,
          isLast,
        };
    }
  });
}

/**
 * Type guard to check if data is a tool call
 */
export function isToolCallData(data: unknown): data is ToolCallData {
  return (
    typeof data === 'object' &&
    data !== null &&
    'toolCallId' in data &&
    'kind' in data
  );
}

/**
 * Type guard to check if data is a message
 */
export function isMessageData(data: unknown): data is ACPMessageData {
  return (
    typeof data === 'object' &&
    data !== null &&
    'role' in data &&
    'content' in data
  );
}
