/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExportSessionData, ExportMessage } from '../types.js';

/**
 * Converts ExportSessionData to markdown format.
 */
export function toMarkdown(sessionData: ExportSessionData): string {
  const lines: string[] = [];

  // Add header with metadata
  lines.push('# Chat Session Export\n');
  lines.push(`**Session ID**: ${sessionData.sessionId}\n`);
  lines.push(`**Start Time**: ${sessionData.startTime}\n`);
  lines.push(`**Exported**: ${new Date().toISOString()}\n`);
  lines.push('---\n');

  // Process each message
  for (const message of sessionData.messages) {
    if (message.type === 'user') {
      lines.push('## User\n');
      const text = extractTextFromMessage(message);
      lines.push(`${text}\n`);
    } else if (message.type === 'assistant') {
      lines.push('## Assistant\n');
      const text = extractTextFromMessage(message);
      lines.push(`${text}\n`);
    } else if (message.type === 'tool_call') {
      lines.push('## Tool Call\n');
      if (message.toolCall) {
        const title =
          typeof message.toolCall.title === 'string'
            ? message.toolCall.title
            : JSON.stringify(message.toolCall.title);
        lines.push(`**Tool**: ${title}\n`);
        lines.push(`**Status**: ${message.toolCall.status}\n`);

        if (message.toolCall.content && message.toolCall.content.length > 0) {
          lines.push('```\n');
          for (const contentItem of message.toolCall.content) {
            if (contentItem.type === 'content' && contentItem['content']) {
              const contentData = contentItem['content'] as {
                type: string;
                text?: string;
              };
              if (contentData.type === 'text' && contentData.text) {
                lines.push(contentData.text);
              }
            } else if (contentItem.type === 'diff') {
              lines.push(`Diff for: ${contentItem['path']}\n`);
              lines.push(`${contentItem['newText']}\n`);
            }
          }
          lines.push('\n```\n');
        }
      }
    } else if (message.type === 'system') {
      // Skip system messages or format them minimally
      lines.push('_[System message]_\n');
    }

    lines.push('\n');
  }

  return lines.join('');
}

/**
 * Extracts text content from an export message.
 */
function extractTextFromMessage(message: ExportMessage): string {
  if (!message.message?.parts) return '';

  const textParts: string[] = [];
  for (const part of message.message.parts) {
    if ('text' in part) {
      textParts.push(part.text);
    }
  }

  return textParts.join('\n');
}
