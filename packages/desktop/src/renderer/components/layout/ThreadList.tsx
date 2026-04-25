/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DesktopSessionSummary } from '../../api/client.js';

export function ThreadList({
  activeSessionId,
  sessions,
  onSelect,
}: {
  activeSessionId: string | null;
  sessions: DesktopSessionSummary[];
  onSelect: (sessionId: string) => void;
}) {
  if (sessions.length === 0) {
    return <div className="empty-row">No sessions</div>;
  }

  return (
    <div
      className="session-list"
      aria-label="Threads"
      data-testid="thread-list"
    >
      {sessions.map((session) => (
        <button
          className={
            session.sessionId === activeSessionId
              ? 'session-row session-row-active'
              : 'session-row'
          }
          key={session.sessionId}
          onClick={() => onSelect(session.sessionId)}
          type="button"
        >
          <span>{session.title || session.sessionId}</span>
          <small>{session.cwd || session.sessionId}</small>
        </button>
      ))}
    </div>
  );
}
