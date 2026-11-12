/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { VpItem } from './virtual-items.js';

/**
 * In-session transcript search over the same item array the virtual viewport
 * renders. Search is by *item* (a prompt, an assistant message, a thought, a
 * tool group) and every match reports the viewport index it can be jumped to
 * with scrollToIndex, so the caller never has to translate between "search
 * result" and "row".
 */

/** Bounded so a single keystroke can never scan an unbounded result set. */
export const MAX_TRANSCRIPT_SEARCH_MATCHES = 500;

export interface TranscriptSearchMatch {
  /** Index into the virtual viewport's data array (banner included). */
  readonly index: number;
  /** The HistoryItem type tag, e.g. 'user' or 'tool_group'. */
  readonly itemType: string;
  /** Single-line context around the first occurrence, for the status row. */
  readonly snippet: string;
}

export interface TranscriptSearchResult {
  readonly matches: readonly TranscriptSearchMatch[];
  /** True when the match list was cut off at MAX_TRANSCRIPT_SEARCH_MATCHES. */
  readonly truncated: boolean;
}

function serializeUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    // Tool results are not always plain text: shell results, diffs, findings
    // and friends are structured objects. Serializing them keeps their fields
    // (paths, commands, error text) searchable instead of silently making the
    // most important transcript content unfindable.
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function buildSearchableText(item: VpItem): string {
  if (item.type === 'vp-banner') return '';
  if (item.type === 'tool_group') {
    const parts: string[] = [];
    for (const tool of item.tools) {
      parts.push(tool.name, tool.description);
      if (tool.args !== undefined) parts.push(serializeUnknown(tool.args));
      if (tool.resultDisplay !== undefined) {
        parts.push(serializeUnknown(tool.resultDisplay));
      }
      // Ctrl+O full-detail text holds the complete result for read/search
      // tools whose summary is only a count; without it those results would
      // not be searchable at all.
      if (tool.detailedDisplay !== undefined) {
        parts.push(tool.detailedDisplay);
      }
      if (tool.visionBridgeNotice !== undefined) {
        parts.push(tool.visionBridgeNotice);
      }
    }
    return parts.filter((part) => part.length > 0).join('\n');
  }
  if (item.type === 'tool_use_summary') {
    return item.summary;
  }
  // Every text-bearing variant (user, gemini, gemini_content, both thought
  // kinds, info, error, warning, notification, user_shell, advisor, ...) uses
  // the same optional `text` field on HistoryItemBase.
  return typeof item.text === 'string' ? item.text : '';
}

// Committed history items keep a stable object identity across renders, so a
// WeakMap caches their flattened text between keystrokes. Pending items are
// re-created per render and simply miss the cache.
const searchableTextCache = new WeakMap<VpItem, string>();

export function getSearchableText(item: VpItem): string {
  const cached = searchableTextCache.get(item);
  if (cached !== undefined) return cached;
  const text = buildSearchableText(item);
  searchableTextCache.set(item, text);
  return text;
}

function makeSnippet(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ');
  // Flattening whitespace shifts offsets, so locate the match again in the
  // flattened text instead of reusing the raw-text position.
  const found = flat.toLowerCase().indexOf(query);
  const anchor = found >= 0 ? found : 0;
  const radius = 48;
  const from = Math.max(0, anchor - radius);
  const to = Math.min(flat.length, anchor + query.length + radius);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < flat.length ? '…' : '';
  return `${prefix}${flat.slice(from, to).trim()}${suffix}`;
}

/**
 * Case-insensitive substring search over `items`, in transcript order. One
 * match per matching item (the first occurrence), which keeps next/previous
 * navigation meaningful at the granularity the viewport can anchor.
 */
export function searchTranscriptItems(
  items: readonly VpItem[],
  query: string,
  maxMatches: number = MAX_TRANSCRIPT_SEARCH_MATCHES,
): TranscriptSearchResult {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return { matches: [], truncated: false };
  }
  const matches: TranscriptSearchMatch[] = [];
  let truncated = false;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.type === 'vp-banner') continue;
    const text = getSearchableText(item);
    if (text.length === 0) continue;
    const position = text.toLowerCase().indexOf(normalized);
    if (position === -1) continue;
    matches.push({
      index,
      itemType: item.type,
      snippet: makeSnippet(text, normalized),
    });
    if (matches.length >= maxMatches) {
      truncated = true;
      break;
    }
  }
  return { matches, truncated };
}
