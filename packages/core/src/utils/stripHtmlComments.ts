/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Strip block-level HTML comments from markdown content.
 *
 * Uses the marked lexer to identify comments at the block level only, so
 * comments inside inline code spans and fenced code blocks are preserved.
 * Inline HTML comments inside a paragraph are also left intact; the intended
 * use case is authorial notes that occupy their own lines.
 *
 * Unclosed comments (`<!--` with no matching `-->`) are left in place so a
 * typo doesn't silently swallow the rest of the file.
 */

import { Lexer } from 'marked';

export function stripHtmlComments(content: string): {
  content: string;
  stripped: boolean;
} {
  if (!content.includes('<!--')) {
    return { content, stripped: false };
  }
  // gfm:false is fine here — html-block detection is a CommonMark rule.
  return stripHtmlCommentsFromTokens(new Lexer({ gfm: false }).lex(content));
}

function stripHtmlCommentsFromTokens(tokens: ReturnType<Lexer['lex']>): {
  content: string;
  stripped: boolean;
} {
  let result = '';
  let stripped = false;

  // A well-formed HTML comment span. Non-greedy so multiple comments on the
  // same line are matched independently; [\s\S] to span newlines.
  const commentSpan = /<!--[\s\S]*?-->/g;

  for (const token of tokens) {
    if (token.type === 'html') {
      const trimmed = token.raw.trimStart();
      if (trimmed.startsWith('<!--') && trimmed.includes('-->')) {
        // Per CommonMark, a type-2 HTML block ends at the *line* containing
        // `-->`, so text after `-->` on that line is part of this token.
        // Strip only the comment spans and keep any residual content.
        const residue = token.raw.replace(commentSpan, '');
        stripped = true;
        if (residue.trim().length > 0) {
          // Residual content exists (e.g. `<!-- note --> Use bun`): keep it.
          result += residue;
        }
        continue;
      }
    }
    result += token.raw;
  }

  return { content: result, stripped };
}
