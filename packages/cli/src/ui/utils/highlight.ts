/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from '../commands/types.js';
import { findSlashCommandTokens } from './commandUtils.js';
import { cpLen, cpSlice } from './textUtils.js';

export type HighlightToken = {
  text: string;
  type: 'default' | 'command' | 'file';
};

// The @-ref alternatives must stay in sync with parseAllAtCommands in
// hooks/atCommandProcessor.ts, or the input box paints a different span than
// the parser will actually consume. A URL ref (`@https://…`) runs through the
// full RFC 3986 charset — `%`, `?`, `&`, `=` are structural in a presigned
// URL — while a filesystem ref keeps the narrower path charset.
const HIGHLIGHT_REGEX =
  /(^\/[a-zA-Z][a-zA-Z0-9:_-]*)|((?<=\s)\/[a-zA-Z][a-zA-Z0-9:_-]*)|(@https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)|(@(?:\\ |[a-zA-Z0-9_.:/-])+)/g;

// Mirrors the parser's trailing-punctuation trim: '.'/','/';'/':'/'!'/'?' at
// the very end of a URL are prose, not part of the ref.
const TRAILING_URL_PUNCTUATION = /[.,;:!?]+$/;

export function parseInputForHighlighting(
  text: string,
  index: number,
  slashCommands?: readonly SlashCommand[],
): readonly HighlightToken[] {
  if (!text) {
    return [{ text: '', type: 'default' }];
  }

  const tokens: HighlightToken[] = [];
  const validSlashTokenStarts = new Set(
    slashCommands
      ? findSlashCommandTokens(text, slashCommands)
          .filter((token) => token.valid)
          .map((token) => token.start)
      : undefined,
  );
  let lastIndex = 0;
  let match;

  HIGHLIGHT_REGEX.lastIndex = 0;
  while ((match = HIGHLIGHT_REGEX.exec(text)) !== null) {
    let [fullMatch] = match;
    const matchIndex = match.index;

    if (match[3] !== undefined) {
      // URL ref: trailing sentence punctuation is prose (parser trims it the
      // same way), so paint it default rather than file-colored.
      const trimmed = fullMatch.replace(TRAILING_URL_PUNCTUATION, '');
      if (trimmed.length > 1) {
        fullMatch = trimmed;
        // Rewind so the trimmed tail is re-scanned as default text.
        HIGHLIGHT_REGEX.lastIndex = matchIndex + trimmed.length;
      }
    }

    // Add the text before the match as a default token
    if (matchIndex > lastIndex) {
      tokens.push({
        text: text.slice(lastIndex, matchIndex),
        type: 'default',
      });
    }

    // Add the matched token
    let type: HighlightToken['type'];
    if (match[1] !== undefined || match[2] !== undefined) {
      if (slashCommands) {
        type = validSlashTokenStarts.has(matchIndex) ? 'command' : 'default';
      } else if (match[1] !== undefined) {
        // Group 1: line-start slash command — only highlight on logical line 0
        type = index === 0 ? 'command' : 'default';
      } else {
        // Backwards-compatible fallback when no command metadata is provided.
        type = 'command';
      }
    } else {
      // Group 3: @file pattern
      type = 'file';
    }
    tokens.push({ text: fullMatch, type });

    lastIndex = matchIndex + fullMatch.length;
  }

  // Add any remaining text after the last match
  if (lastIndex < text.length) {
    tokens.push({
      text: text.slice(lastIndex),
      type: 'default',
    });
  }

  return tokens;
}

export function buildSegmentsForVisualSlice(
  tokens: readonly HighlightToken[],
  sliceStart: number,
  sliceEnd: number,
): readonly HighlightToken[] {
  if (sliceStart >= sliceEnd) return [];

  const segments: HighlightToken[] = [];
  let tokenCpStart = 0;

  for (const token of tokens) {
    const tokenLen = cpLen(token.text);
    const tokenStart = tokenCpStart;
    const tokenEnd = tokenStart + tokenLen;

    const overlapStart = Math.max(tokenStart, sliceStart);
    const overlapEnd = Math.min(tokenEnd, sliceEnd);
    if (overlapStart < overlapEnd) {
      const sliceStartInToken = overlapStart - tokenStart;
      const sliceEndInToken = overlapEnd - tokenStart;
      const rawSlice = cpSlice(token.text, sliceStartInToken, sliceEndInToken);

      const last = segments[segments.length - 1];
      if (last && last.type === token.type) {
        last.text += rawSlice;
      } else {
        segments.push({ type: token.type, text: rawSlice });
      }
    }

    tokenCpStart += tokenLen;
  }

  return segments;
}
