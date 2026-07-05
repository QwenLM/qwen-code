/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionListItem } from '@qwen-code/qwen-code-core';
import { getCachedStringWidth } from './textUtils.js';

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

/**
 * State for managing loaded sessions in the session picker.
 */
export interface SessionState {
  sessions: SessionListItem[];
  hasMore: boolean;
  nextCursor?: number;
}

/**
 * Page size for loading sessions.
 */
export const SESSION_PAGE_SIZE = 20;

/**
 * Truncates text to fit within a given width, adding ellipsis if needed.
 */
export function truncateText(text: string, maxWidth: number): string {
  const widthLimit = Math.max(0, Math.floor(maxWidth));
  if (widthLimit === 0) {
    return '';
  }

  const firstLine = text.split(/\r?\n/, 1)[0];
  if (getCachedStringWidth(firstLine) <= widthLimit) {
    return firstLine;
  }

  if (widthLimit <= 3) {
    return truncateToDisplayWidth(firstLine, widthLimit);
  }

  return `${truncateToDisplayWidth(firstLine, widthLimit - 3)}...`;
}

function truncateToDisplayWidth(text: string, maxWidth: number): string {
  let width = 0;
  let result = '';

  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = getCachedStringWidth(segment);
    if (width + segmentWidth > maxWidth) {
      break;
    }
    result += segment;
    width += segmentWidth;
  }

  return result;
}

/**
 * Returns true when the session matches the query as a substring on any of:
 * customTitle, first prompt, gitBranch.
 *
 * Empty queries match everything. The query is expected pre-normalized —
 * `filterSessions` does the trim+lowercase once before the per-session
 * loop, so this helper can do straight `includes()` checks per haystack.
 */
function matchesQuery(
  session: SessionListItem,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return true;
  const haystacks: Array<string | undefined> = [
    session.customTitle,
    session.prompt,
    session.gitBranch,
  ];
  for (const h of haystacks) {
    if (h && h.toLowerCase().includes(normalizedQuery)) return true;
  }
  return false;
}

/**
 * Filters sessions by branch and/or a free-text query.
 *
 * Branch filter and query filter compose (AND): when both are active, a
 * session must satisfy both. Query is matched case-insensitively against
 * customTitle, prompt, and gitBranch — branch is included in query matching
 * so users can type a branch name without first toggling branch-filter.
 */
export function filterSessions(
  sessions: SessionListItem[],
  filterByBranch: boolean,
  currentBranch?: string,
  query?: string,
): SessionListItem[] {
  const normalizedQuery = query?.toLowerCase().trim() ?? '';
  return sessions.filter((session) => {
    if (filterByBranch && currentBranch) {
      if (session.gitBranch !== currentBranch) return false;
    }
    return matchesQuery(session, normalizedQuery);
  });
}

/**
 * Formats message count for display with proper pluralization.
 */
export function formatMessageCount(count: number): string {
  return count === 1 ? '1 message' : `${count} messages`;
}
