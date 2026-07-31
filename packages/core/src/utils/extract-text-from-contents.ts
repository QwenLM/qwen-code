/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentListUnion } from '@google/genai';

/**
 * Extract the concatenated text of every text part across a `@google/genai`
 * `ContentListUnion`, used by the OpenAI-compatible generators' `embedContent`
 * to build the embedding input string. Shared so a change to how `Part` text
 * is shaped only needs to be made once -- this was previously duplicated
 * verbatim between `openaiContentGenerator.ts` and
 * `openaiResponsesContentGenerator/index.ts`.
 */
export function extractTextFromContents(contents: ContentListUnion): string {
  let text = '';
  if (Array.isArray(contents)) {
    text = contents
      .map((content) => {
        if (typeof content === 'string') return content;
        if ('parts' in content && content.parts) {
          return content.parts
            .map((part) =>
              typeof part === 'string'
                ? part
                : 'text' in part
                  ? (part as { text?: string }).text || ''
                  : '',
            )
            .join(' ');
        }
        return '';
      })
      .join(' ');
  } else if (contents) {
    if (typeof contents === 'string') {
      text = contents;
    } else if ('parts' in contents && contents.parts) {
      text = contents.parts
        .map((part) =>
          typeof part === 'string'
            ? part
            : 'text' in part
              ? (part as { text?: string }).text || ''
              : '',
        )
        .join(' ');
    }
  }
  return text;
}
