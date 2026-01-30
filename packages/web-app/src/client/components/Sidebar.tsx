/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo, Fragment } from 'react';
import { groupSessionsByDate, getTimeAgo } from '@qwen-code/webui';
import type { Session } from '../../shared/types.js';

interface SidebarProps {
  sessions: Session[];
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onRefresh: () => void;
  isLoading: boolean;
}

export function Sidebar({
  sessions,
  currentSessionId,
  onSelectSession,
  onCreateSession,
  onRefresh,
  isLoading,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');

  // Filter sessions by search query
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const query = searchQuery.toLowerCase();
    return sessions.filter((s) => s.title.toLowerCase().includes(query));
  }, [sessions, searchQuery]);

  // Group sessions by date
  const groupedSessions = useMemo(() => {
    // Convert sessions to the format expected by groupSessionsByDate
    const sessionsWithDate = filteredSessions.map((s) => ({
      ...s,
      sessionId: s.id,
      lastUpdated: s.lastUpdated,
    }));
    return groupSessionsByDate(sessionsWithDate);
  }, [filteredSessions]);

  return (
    <aside className="w-64 border-r border-[var(--app-border)] flex flex-col bg-[var(--app-secondary-background)]">
      {/* Brand header */}
      <div className="p-4 border-b border-[var(--app-border)]">
        <h1 className="text-lg font-semibold text-[var(--app-primary-foreground)]">
          Qwen Code
        </h1>
        <span className="text-xs text-[var(--app-secondary-foreground)]">
          Web GUI
        </span>
      </div>

      {/* Sessions header */}
      <div className="px-4 py-2 flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--app-secondary-foreground)] uppercase tracking-wider">
          Sessions
        </span>
        <div className="flex gap-1">
          <button
            onClick={onRefresh}
            disabled={isLoading}
            className="p-1.5 rounded hover:bg-[var(--app-list-hover-background)] transition-colors"
            title="Refresh sessions"
          >
            <svg
              className={`w-4 h-4 text-[var(--app-secondary-foreground)] ${isLoading ? 'animate-spin' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>
          <button
            onClick={onCreateSession}
            className="p-1.5 rounded hover:bg-[var(--app-list-hover-background)] transition-colors"
            title="New session"
          >
            <svg
              className="w-4 h-4 text-[var(--app-secondary-foreground)]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Search box */}
      <div className="px-4 py-2">
        <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-[var(--app-input-background)]">
          <svg
            className="w-4 h-4 text-[var(--app-secondary-foreground)] opacity-60"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-transparent border-none outline-none text-sm text-[var(--app-primary-foreground)] placeholder:text-[var(--app-input-placeholder-foreground)]"
          />
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {groupedSessions.length === 0 ? (
          <div className="px-2 py-8 text-center text-sm text-[var(--app-secondary-foreground)]">
            {searchQuery ? 'No matching sessions' : 'No sessions yet'}
          </div>
        ) : (
          groupedSessions.map((group) => (
            <Fragment key={group.label}>
              <div className="px-2 py-1.5 text-xs font-medium text-[var(--app-secondary-foreground)] opacity-60 mt-2 first:mt-0">
                {group.label}
              </div>
              {group.sessions.map((session) => {
                const sessionId =
                  (session.id as string) || (session.sessionId as string) || '';
                const title = (session.title as string) || 'Untitled';
                const lastUpdated =
                  (session.lastUpdated as string) ||
                  (session.startTime as string) ||
                  '';
                const isActive = sessionId === currentSessionId;

                return (
                  <button
                    key={sessionId}
                    onClick={() => onSelectSession(sessionId)}
                    className={`w-full text-left px-2 py-2 rounded text-sm flex justify-between items-center gap-2 transition-colors ${
                      isActive
                        ? 'bg-[var(--app-list-active-background)] text-[var(--app-list-active-foreground)] font-medium'
                        : 'text-[var(--app-primary-foreground)] hover:bg-[var(--app-list-hover-background)]'
                    }`}
                  >
                    <span className="truncate flex-1 min-w-0">{title}</span>
                    <span
                      className={`text-xs flex-shrink-0 ${isActive ? 'opacity-80' : 'opacity-50'}`}
                    >
                      {getTimeAgo(lastUpdated)}
                    </span>
                  </button>
                );
              })}
            </Fragment>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-[var(--app-border)] flex items-center justify-between">
        <span className="text-xs text-[var(--app-secondary-foreground)]">
          {sessions.length} session{sessions.length !== 1 ? 's' : ''}
        </span>
      </div>
    </aside>
  );
}
