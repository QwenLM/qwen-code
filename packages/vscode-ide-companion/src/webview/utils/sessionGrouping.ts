/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface SessionGroup {
  label: string;
  sessions: Array<Record<string, unknown>>;
}

/**
 * Group sessions by date
 *
 * @param sessions - Array of session objects
 * @returns Array of grouped sessions
 */
export const groupSessionsByDate = (
  sessions: Array<Record<string, unknown>>,
): SessionGroup[] => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const groups: {
    [key: string]: Array<Record<string, unknown>>;
  } = {
    Today: [],
    Yesterday: [],
    'This Week': [],
    Older: [],
  };

  sessions.forEach((session) => {
    const timestamp =
      (session.lastUpdated as string) || (session.startTime as string) || '';
    if (!timestamp) {
      groups['Older'].push(session);
      return;
    }

    const sessionDate = new Date(timestamp);
    const sessionDay = new Date(
      sessionDate.getFullYear(),
      sessionDate.getMonth(),
      sessionDate.getDate(),
    );

    if (sessionDay.getTime() === today.getTime()) {
      groups['Today'].push(session);
    } else if (sessionDay.getTime() === yesterday.getTime()) {
      groups['Yesterday'].push(session);
    } else if (sessionDay.getTime() > today.getTime() - 7 * 86400000) {
      groups['This Week'].push(session);
    } else {
      groups['Older'].push(session);
    }
  });

  return Object.entries(groups)
    .filter(([, sessions]) => sessions.length > 0)
    .map(([label, sessions]) => ({ label, sessions }));
};

/**
 * Time ago formatter
 *
 * @param timestamp - ISO timestamp string
 * @returns Formatted time string
 */
export const getTimeAgo = (timestamp: string): string => {
  if (!timestamp) {
    return '';
  }
  const now = new Date().getTime();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) {
    return 'now';
  }
  if (diffMins < 60) {
    return `${diffMins}m`;
  }
  if (diffHours < 24) {
    return `${diffHours}h`;
  }
  if (diffDays === 1) {
    return 'Yesterday';
  }
  if (diffDays < 7) {
    return `${diffDays}d`;
  }
  return new Date(timestamp).toLocaleDateString();
};
