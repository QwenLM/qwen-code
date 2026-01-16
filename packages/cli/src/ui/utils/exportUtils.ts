/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, Content } from '@google/genai';
import type { ChatRecord } from '@qwen-code/qwen-code-core';

const HTML_TEMPLATE_URL =
  'https://raw.githubusercontent.com/QwenLM/qwen-code/main/template_portable.html';

/**
 * Extracts text content from a Content object's parts.
 */
export function extractTextFromContent(content: Content | undefined): string {
  if (!content?.parts) return '';

  const textParts: string[] = [];
  for (const part of content.parts as Part[]) {
    if ('text' in part) {
      const textPart = part as { text: string };
      textParts.push(textPart.text);
    } else if ('functionCall' in part) {
      const fnPart = part as { functionCall: { name: string; args: unknown } };
      textParts.push(
        `[Function Call: ${fnPart.functionCall.name}]\n${JSON.stringify(fnPart.functionCall.args, null, 2)}`,
      );
    } else if ('functionResponse' in part) {
      const fnResPart = part as {
        functionResponse: { name: string; response: unknown };
      };
      textParts.push(
        `[Function Response: ${fnResPart.functionResponse.name}]\n${JSON.stringify(fnResPart.functionResponse.response, null, 2)}`,
      );
    }
  }

  return textParts.join('\n');
}

/**
 * Transforms ChatRecord messages to markdown format.
 */
export function transformToMarkdown(
  messages: ChatRecord[],
  sessionId: string,
  startTime: string,
): string {
  const lines: string[] = [];

  // Add header with metadata
  lines.push('# Chat Session Export\n');
  lines.push(`**Session ID**: ${sessionId}\n`);
  lines.push(`**Start Time**: ${startTime}\n`);
  lines.push(`**Exported**: ${new Date().toISOString()}\n`);
  lines.push('---\n');

  // Process each message
  for (const record of messages) {
    if (record.type === 'user') {
      lines.push('## User\n');
      const text = extractTextFromContent(record.message);
      lines.push(`${text}\n`);
    } else if (record.type === 'assistant') {
      lines.push('## Assistant\n');
      const text = extractTextFromContent(record.message);
      lines.push(`${text}\n`);
    } else if (record.type === 'tool_result') {
      lines.push('## Tool Result\n');
      if (record.toolCallResult) {
        const resultDisplay = record.toolCallResult.resultDisplay;
        if (resultDisplay) {
          lines.push('```\n');
          lines.push(
            typeof resultDisplay === 'string'
              ? resultDisplay
              : JSON.stringify(resultDisplay, null, 2),
          );
          lines.push('\n```\n');
        }
      }
      const text = extractTextFromContent(record.message);
      if (text) {
        lines.push(`${text}\n`);
      }
    } else if (record.type === 'system') {
      // Skip system messages or format them minimally
      if (record.subtype === 'chat_compression') {
        lines.push('_[Chat history compressed]_\n');
      }
    }

    lines.push('\n');
  }

  return lines.join('');
}

/**
 * Loads the HTML template from a remote URL via fetch.
 * Throws an error if the fetch fails.
 */
export async function loadHtmlTemplate(): Promise<string> {
  try {
    const response = await fetch(HTML_TEMPLATE_URL);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch HTML template: ${response.status} ${response.statusText}`,
      );
    }
    const template = await response.text();
    return template;
  } catch (error) {
    throw new Error(
      `Failed to load HTML template from ${HTML_TEMPLATE_URL}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Prepares export data from conversation.
 */
export function prepareExportData(conversation: {
  sessionId: string;
  startTime: string;
  messages: ChatRecord[];
}): {
  sessionId: string;
  startTime: string;
  messages: ChatRecord[];
} {
  return {
    sessionId: conversation.sessionId,
    startTime: conversation.startTime,
    messages: conversation.messages,
  };
}

/**
 * Injects JSON data into the HTML template.
 */
export function injectDataIntoHtmlTemplate(
  template: string,
  data: {
    sessionId: string;
    startTime: string;
    messages: ChatRecord[];
  },
): string {
  const jsonData = JSON.stringify(data, null, 2);
  const html = template.replace(
    /<script id="chat-data" type="application\/json">\s*\/\/ DATA_PLACEHOLDER:.*?\s*<\/script>/s,
    `<script id="chat-data" type="application/json">\n${jsonData}\n    </script>`,
  );
  return html;
}

/**
 * Generates a filename with timestamp for export files.
 */
export function generateExportFilename(extension: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `export-${timestamp}.${extension}`;
}
