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
  lines.push(`- **Session ID**: \`${sanitizeText(sessionData.sessionId)}\``);
  lines.push(`- **Start Time**: ${sanitizeText(sessionData.startTime)}`);
  lines.push(`- **Exported**: ${new Date().toISOString()}`);
  lines.push('\n---\n');

  // Process each message
  for (const message of sessionData.messages) {
    if (message.type === 'user') {
      lines.push('## User\n');
      lines.push(formatMessageContent(message));
    } else if (message.type === 'assistant') {
      lines.push('## Assistant\n');
      lines.push(formatMessageContent(message));
    } else if (message.type === 'tool_call') {
      lines.push(formatToolCall(message));
    } else if (message.type === 'system') {
      lines.push('### System\n');
      // Format as blockquote
      const text = formatMessageContent(message);
      lines.push(`> ${text.replace(/\n/g, '\n> ')}`);
    }

    lines.push('\n');
  }

  return lines.join('\n');
}

function formatMessageContent(message: ExportMessage): string {
  const text = extractTextFromMessage(message);

  // Special handling for "Content from referenced files"
  // We look for the pattern: --- Content from referenced files --- ... --- End of content ---
  // and wrap the inner content in code blocks if possible.

  // Note: This simple regex replacement might be fragile if nested, but usually this marker is top-level.
  // We'll use a replacer function to handle the wrapping.

  const processedText = text.replace(
    /--- Content from referenced files ---\n([\s\S]*?)\n--- End of content ---/g,
    (match, content) =>
      `\n> **Referenced Files:**\n\n${createCodeBlock(content)}\n`,
  );

  return processedText;
}

function formatToolCall(message: ExportMessage): string {
  if (!message.toolCall) return '';

  const lines: string[] = [];
  const { title, status, rawInput, content, locations } = message.toolCall;

  const titleStr = typeof title === 'string' ? title : JSON.stringify(title);

  lines.push(`### Tool: ${sanitizeText(titleStr)}`);
  lines.push(`**Status**: ${sanitizeText(status)}\n`);

  // Input
  if (rawInput) {
    lines.push('**Input:**');
    const inputStr =
      typeof rawInput === 'string'
        ? rawInput
        : JSON.stringify(rawInput, null, 2);
    lines.push(createCodeBlock(inputStr, 'json'));
    lines.push('');
  }

  // Locations
  if (locations && locations.length > 0) {
    lines.push('**Affected Files:**');
    for (const loc of locations) {
      const lineSuffix = loc.line ? `:${loc.line}` : '';
      lines.push(`- \`${sanitizeText(loc.path)}${lineSuffix}\``);
    }
    lines.push('');
  }

  // Output Content
  if (content && content.length > 0) {
    lines.push('**Output:**');

    for (const item of content) {
      if (item.type === 'content' && item['content']) {
        const contentData = item['content'] as { type: string; text?: string };
        if (contentData.type === 'text' && contentData.text) {
          // Try to infer language from locations if available and if there is only one location
          // or if the tool title suggests a file operation.
          let language = '';
          if (locations && locations.length === 1 && locations[0].path) {
            language = getLanguageFromPath(locations[0].path);
          }

          lines.push(createCodeBlock(contentData.text, language));
        }
      } else if (item.type === 'diff') {
        const path = item['path'] as string;
        const diffText = item['newText'] as string;
        lines.push(`\n*Diff for \`${sanitizeText(path)}\`:*`);
        lines.push(createCodeBlock(diffText, 'diff'));
      }
    }
  }

  return lines.join('\n');
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

/**
 * Creates a markdown code block with dynamic fence length to avoid escaping issues.
 * Does NOT escape HTML content inside the block, as that would break code readability.
 * Security is handled by the fence.
 */
function createCodeBlock(content: string, language: string = ''): string {
  const fence = buildFence(content);
  return `${fence}${language}\n${content}\n${fence}`;
}

/**
 * Sanitizes text to prevent HTML injection while preserving Markdown.
 * Only escapes < and & to avoid breaking Markdown structures like code blocks (if used inline) or quotes.
 */
function sanitizeText(value: string): string {
  return (value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/**
 * Calculates the necessary fence length for a code block.
 * Ensures the fence is longer than any sequence of backticks in the content.
 */
function buildFence(value: string): string {
  const matches = (value ?? '').match(/`+/g);
  const maxRun = matches
    ? Math.max(...matches.map((match) => match.length))
    : 0;
  const fenceLength = Math.max(3, maxRun + 1);
  return '`'.repeat(fenceLength);
}

/**
 * Simple helper to guess language from file extension.
 */
function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'py':
      return 'python';
    case 'rb':
      return 'ruby';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'java':
      return 'java';
    case 'c':
    case 'cpp':
    case 'h':
    case 'hpp':
      return 'cpp';
    case 'cs':
      return 'csharp';
    case 'html':
      return 'html';
    case 'css':
      return 'css';
    case 'json':
      return 'json';
    case 'md':
      return 'markdown';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'xml':
      return 'xml';
    case 'sql':
      return 'sql';
    default:
      return '';
  }
}
