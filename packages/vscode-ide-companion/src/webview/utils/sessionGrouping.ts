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
 * Group sessions by date (matching Claude Code)
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
