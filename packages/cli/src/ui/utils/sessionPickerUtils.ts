/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionListItem } from '@qwen-code/qwen-code-core';

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
  if (text.length <= maxWidth) {
    return text;
  }
  if (maxWidth <= 3) {
    return text.slice(0, maxWidth);
  }
  return text.slice(0, maxWidth - 3) + '...';
}

/**
 * Filters sessions to exclude empty ones (0 messages) and optionally by branch.
 */
export function filterSessions(
  sessions: SessionListItem[],
  filterByBranch: boolean,
  currentBranch?: string,
): SessionListItem[] {
  return sessions.filter((session) => {
    // Always exclude sessions with no messages
    if (session.messageCount === 0) {
      return false;
    }
    // Apply branch filter if enabled
    if (filterByBranch && currentBranch) {
      return session.gitBranch === currentBranch;
    }
    return true;
  });
}

/**
 * Formats message count for display with proper pluralization.
 */
export function formatMessageCount(count: number): string {
  return count === 1 ? '1 message' : `${count} messages`;
}
