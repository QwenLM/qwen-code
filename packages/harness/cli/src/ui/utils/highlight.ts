/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Transformation,
  PASTED_TEXT_PLACEHOLDER_REGEX,
} from '../components/shared/text-buffer.js';
import { LRUCache } from 'mnemonist';
import { cpLen, cpSlice } from './textUtils.js';
import { LRU_BUFFER_PERF_CACHE_LIMIT } from '../constants.js';
import { AT_MENTION_HIGHLIGHT_REGEX_SOURCE } from './atMentionUtils.js';
import { MID_INPUT_SLASH_SEPARATORS } from './inlineCommandGhost.js';

export type HighlightToken = {
  text: string;
  type: 'default' | 'command' | 'file' | 'paste';
};

// Command-name characters, matching the set the command loaders produce —
// namespaced plugin and skill commands use `:` and `.`.
const COMMAND_NAME_CHARS = 'a-zA-Z0-9._:-';
// A mid-line command has to follow whitespace or CJK punctuation. Imported
// rather than restated so highlighting can never disagree with what the inline
// ghost triggers on.
const COMMAND_SEPARATORS = MID_INPUT_SLASH_SEPARATORS;

// Matches slash commands (e.g., /help), @ references (files or MCP resource URIs),
// and large paste placeholders (e.g., [Pasted Text: 6 lines]).
//
// A slash command is matched either at the start of the line — where the whole
// line is a command invocation — or mid-line after a separator. Mid-line
// matches are only *highlighted* when they resolve against the command
// catalog, so ordinary paths like `ls /usr/bin` stay plain.
//
// The @ pattern uses the same source as the command processor to ensure consistency.
// It matches any character except strict delimiters (ASCII whitespace, comma, etc.).
// This supports URIs like `@file:///example.txt` and filenames with Unicode spaces (like NNBSP).
const HIGHLIGHT_REGEX = new RegExp(
  `(^/[${COMMAND_NAME_CHARS}]+|(?<=[${COMMAND_SEPARATORS}])/[${COMMAND_NAME_CHARS}]+|(?<!\\\\)@${AT_MENTION_HIGHLIGHT_REGEX_SOURCE}|${PASTED_TEXT_PLACEHOLDER_REGEX.source})`,
  'g',
);

// Trailing punctuation a user would write in prose right after a command
// ("use /plan." / "用 /plan：") but which is not part of the name.
const TRAILING_PUNCTUATION_REGEX = /[.:-]+$/;

const highlightCache = new LRUCache<string, readonly HighlightToken[]>(
  LRU_BUFFER_PERF_CACHE_LIMIT,
);

// Command catalogs are memoized upstream, so identity is stable per catalog.
// Give each one an id so cached tokens can't leak across catalog changes.
const commandSetIds = new WeakMap<ReadonlySet<string>, number>();
let nextCommandSetId = 0;

function commandSetCacheKey(
  knownCommands: ReadonlySet<string> | undefined,
): string {
  if (!knownCommands || knownCommands.size === 0) {
    return 'NK';
  }
  let id = commandSetIds.get(knownCommands);
  if (id === undefined) {
    id = nextCommandSetId++;
    commandSetIds.set(knownCommands, id);
  }
  return `K${id}`;
}

/**
 * Resolves a mid-line `/token` against the command catalog.
 *
 * @returns The matched command name including its leading `/`, or null when
 *   the token is not a command (an ordinary path, say).
 */
function resolveMidLineCommand(
  fullMatch: string,
  knownCommands: ReadonlySet<string> | undefined,
): string | null {
  if (!knownCommands || knownCommands.size === 0) {
    return null;
  }
  const name = fullMatch.slice(1);
  if (knownCommands.has(name)) {
    return fullMatch;
  }
  // The name pattern is greedy, so prose punctuation gets swallowed. Retry
  // without it before giving up.
  const trimmed = name.replace(TRAILING_PUNCTUATION_REGEX, '');
  if (trimmed !== name && trimmed && knownCommands.has(trimmed)) {
    return `/${trimmed}`;
  }
  return null;
}

export function parseInputForHighlighting(
  text: string,
  index: number,
  transformations: Transformation[] = [],
  cursorCol?: number,
  knownCommands?: ReadonlySet<string>,
): readonly HighlightToken[] {
  let isCursorInsideTransform = false;
  if (cursorCol !== undefined) {
    for (const transform of transformations) {
      if (cursorCol >= transform.logStart && cursorCol <= transform.logEnd) {
        isCursorInsideTransform = true;
        break;
      }
    }
  }

  const cacheKey = `${index === 0 ? 'F' : 'N'}:${isCursorInsideTransform ? cursorCol : 'NC'}:${commandSetCacheKey(knownCommands)}:${text}`;
  const cached = highlightCache.get(cacheKey);
  if (cached !== undefined) return cached;

  HIGHLIGHT_REGEX.lastIndex = 0;

  if (!text) {
    return [{ text: '', type: 'default' }];
  }

  const parseUntransformedInput = (text: string): HighlightToken[] => {
    const tokens: HighlightToken[] = [];
    if (!text) return tokens;

    HIGHLIGHT_REGEX.lastIndex = 0;
    let last = 0;
    let match: RegExpExecArray | null;

    while ((match = HIGHLIGHT_REGEX.exec(text)) !== null) {
      const [fullMatch] = match;
      const matchIndex = match.index;

      let matchText = fullMatch;
      if (fullMatch.startsWith('/') && matchIndex > 0) {
        // Mid-line: only a resolvable command earns the accent. Anything else
        // stays part of the surrounding run rather than becoming its own
        // default token, so plain prose tokenizes exactly as it did before.
        const resolved = resolveMidLineCommand(fullMatch, knownCommands);
        if (resolved === null) {
          continue;
        }
        matchText = resolved;
      }

      if (matchIndex > last) {
        tokens.push({ text: text.slice(last, matchIndex), type: 'default' });
      }

      const type = matchText.startsWith('/')
        ? 'command'
        : matchText.startsWith('@')
          ? 'file'
          : 'paste';
      // A line-leading `/` only invokes a command on the first line; elsewhere
      // it is ordinary text. Mid-line matches already resolved above, so they
      // are commands on any line.
      if (type === 'command' && matchIndex === 0 && index !== 0) {
        tokens.push({ text: matchText, type: 'default' });
      } else {
        tokens.push({ text: matchText, type });
      }

      last = matchIndex + matchText.length;
    }

    if (last < text.length) {
      tokens.push({ text: text.slice(last), type: 'default' });
    }

    return tokens;
  };

  const tokens: HighlightToken[] = [];

  let column = 0;
  const sortedTransformations = (transformations ?? [])
    .slice()
    .sort((a, b) => a.logStart - b.logStart);

  for (const transformation of sortedTransformations) {
    const textBeforeTransformation = cpSlice(
      text,
      column,
      transformation.logStart,
    );
    tokens.push(...parseUntransformedInput(textBeforeTransformation));

    const isCursorInside =
      cursorCol !== undefined &&
      cursorCol >= transformation.logStart &&
      cursorCol <= transformation.logEnd;
    const transformationText = isCursorInside
      ? transformation.logicalText
      : transformation.collapsedText;
    tokens.push({ text: transformationText, type: 'file' });

    column = transformation.logEnd;
  }

  const textAfterFinalTransformation = cpSlice(text, column);
  tokens.push(...parseUntransformedInput(textAfterFinalTransformation));

  highlightCache.set(cacheKey, tokens);

  return tokens;
}

export function parseSegmentsFromTokens(
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
