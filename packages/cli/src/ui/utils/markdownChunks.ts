/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Splits a run of formatted markdown tokens into per-block chunks so that a
 * streaming response does not re-measure the whole document on every delta.
 *
 * Background: `MarkdownDisplay` used to concatenate every non-code, non-table
 * token into one giant ANSI string and hand it to a single `<Text>`. Because
 * `setTextNodeValue` marks a text node dirty whenever its content changes
 * (`ink/dom.ts`), that one node was re-measured and re-wrapped in full on
 * every delta — the dominant cost in streaming profiles (`isWide`,
 * `stringWidth`, `wrap-ansi`).
 *
 * Two caches live here:
 *   1. `formatToken` results, keyed by token identity. The streaming lexer
 *      reuses the same token objects for its stable prefix, so a `WeakMap`
 *      is exactly the "has this block settled" predicate.
 *   2. Nothing else. Chunk strings are rebuilt every call; that is cheap
 *      memcpy compared to per-grapheme width measurement, and any cache
 *      keyed on run position is unsound while a table or fenced block is
 *      still materializing.
 *
 * Chunk boundaries obey three constraints, all load-bearing:
 *   - a cut must land on `\n`, so per-line wrapping is unchanged;
 *   - a cut must land on a part boundary, so a chalk span that crosses a
 *     newline (`**bold\nmore**`) is never split open;
 *   - a chunk must span at least `MARKDOWN_CHUNK_MIN_LINES` lines, measured
 *     in lines rather than characters so ANSI-dense content does not shatter
 *     into hundreds of tiny nodes.
 */

import chalk from 'chalk';
import type { Token, Tokens } from 'marked';
import { formatToken } from './markdownTokenizer.js';
import { themeManager } from '../themes/theme-manager.js';

/**
 * Minimum lines per settled chunk. Larger means fewer yoga nodes but a bigger
 * streaming tail to re-measure; this constant is the rollback lever if node
 * count ever regresses long-history scenarios.
 */
export const MARKDOWN_CHUNK_MIN_LINES = 16;

interface FormattedPart {
  text: string;
  lines: number;
}

export interface MarkdownChunkCache {
  formatted: WeakMap<Token, FormattedPart>;
  themeToken: unknown;
  chalkLevel: number;
}

export function createMarkdownChunkCache(): MarkdownChunkCache {
  return {
    formatted: new WeakMap(),
    themeToken: undefined,
    chalkLevel: -1,
  };
}

function countLines(text: string): number {
  let lines = 0;
  let index = text.indexOf('\n');
  while (index !== -1) {
    lines++;
    index = text.indexOf('\n', index + 1);
  }
  return lines;
}

/**
 * Drop every cached format result when the colors they were produced with
 * are no longer current. `getSemanticColors()` returns a per-theme cached
 * object, so identity is a sound change signal.
 */
function ensureCacheFresh(cache: MarkdownChunkCache): void {
  const themeToken: unknown = themeManager.getSemanticColors();
  const chalkLevel = chalk.level;
  if (cache.themeToken !== themeToken || cache.chalkLevel !== chalkLevel) {
    cache.formatted = new WeakMap();
    cache.themeToken = themeToken;
    cache.chalkLevel = chalkLevel;
  }
}

function cachedPart(
  token: Token,
  cache: MarkdownChunkCache,
  format: () => string,
): FormattedPart {
  const hit = cache.formatted.get(token);
  if (hit) return hit;
  const text = format();
  const part: FormattedPart = { text, lines: countLines(text) };
  cache.formatted.set(token, part);
  return part;
}

/**
 * Formatted pieces for one top-level token.
 *
 * A `list` is expanded into one piece per item. `marked` represents an entire
 * list as a single top-level token, and long lists are common in assistant
 * replies — without this expansion they would offer no cut point at all. The
 * per-item calls mirror `formatToken`'s own list branch exactly, so the
 * concatenation is byte-identical to formatting the list as a whole.
 *
 * `blockquote` is deliberately not expanded: its bar prefix is applied per
 * rendered line, not per inner token, so splitting it would not be
 * byte-identical.
 */
function appendPartsForToken(
  token: Token,
  cache: MarkdownChunkCache,
  out: FormattedPart[],
): void {
  if (token.type === 'list') {
    const list = token as Tokens.List;
    const start = (list.start as number) || 1;
    for (let index = 0; index < list.items.length; index++) {
      const item = list.items[index];
      out.push(
        cachedPart(item, cache, () =>
          formatToken(item, 0, list.ordered ? start + index : null, list),
        ),
      );
    }
    return;
  }
  out.push(cachedPart(token, cache, () => formatToken(token)));
}

/**
 * Build the `<Text>` payloads for one contiguous run of non-code, non-table
 * tokens.
 *
 * Equivalent, row for row, to rendering `parts.join('')` with leading and
 * trailing newlines trimmed inside a single `<Text wrap="wrap">`: every cut
 * removes exactly one newline, and the column layout that stacks the chunks
 * puts that line break back.
 */
export function buildMarkdownChunks(
  tokens: Token[],
  cache: MarkdownChunkCache,
): string[] {
  ensureCacheFresh(cache);

  const parts: FormattedPart[] = [];
  for (const token of tokens) {
    appendPartsForToken(token, cache, parts);
  }

  let text = '';
  let lineTotal = 0;
  const bounds: Array<{ offset: number; lines: number }> = [];
  for (const part of parts) {
    text += part.text;
    lineTotal += part.lines;
    bounds.push({ offset: text.length, lines: lineTotal });
  }

  // Same trim as the original single-<Text> path: leading and trailing blank
  // lines never contributed rows.
  let start = 0;
  while (start < text.length && text.charCodeAt(start) === 10) start++;
  let end = text.length;
  while (end > start && text.charCodeAt(end - 1) === 10) end--;
  if (start >= end) return [];

  const chunks: string[] = [];
  let chunkStart = start;
  let chunkStartLines = 0;
  for (const bound of bounds) {
    if (bound.offset <= chunkStart || bound.offset >= end) continue;
    // Cut only on a line break, so wrapping stays line-local.
    if (text.charCodeAt(bound.offset - 1) !== 10) continue;
    if (bound.lines - chunkStartLines < MARKDOWN_CHUNK_MIN_LINES) continue;
    chunks.push(text.slice(chunkStart, bound.offset - 1));
    chunkStart = bound.offset;
    chunkStartLines = bound.lines;
  }
  // Cuts require offset < end, so the tail is always non-empty; the guard is
  // defensive only. An empty <Text> measures as zero rows, which would break
  // the row-for-row equivalence above.
  if (chunkStart < end) chunks.push(text.slice(chunkStart, end));
  return chunks;
}
