/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { groupSessionsByDate } from '../../utils/sessionGrouping.js';
import { getTimeAgo } from '../../utils/timeUtils.js';
import { SearchIcon } from '../icons/index.js';

interface SessionSelectorProps {
  visible: boolean;
  sessions: Array<Record<string, unknown>>;
  currentSessionId: string | null;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSelectSession: (sessionId: string) => void;
  onClose: () => void;
  hasMore?: boolean;
  isLoading?: boolean;
  onLoadMore?: () => void;
}

/**
 * Session selector component
 * Display session list and support search and selection
 */
export const SessionSelector: React.FC<SessionSelectorProps> = ({
  visible,
  sessions,
  currentSessionId,
  searchQuery,
  onSearchChange,
  onSelectSession,
  onClose,
  hasMore = false,
  isLoading = false,
  onLoadMore,
}) => {
  if (!visible) {
    return null;
  }

  const hasNoSessions = sessions.length === 0;

  return (
    <>
      <div
        className="session-selector-backdrop fixed top-0 left-0 right-0 bottom-0 z-[999] bg-transparent"
        onClick={onClose}
      />
      <div
        className="session-dropdown fixed bg-[var(--app-menu-background)] rounded-[var(--corner-radius-small)] w-[min(400px,calc(100vw-32px))] max-h-[min(500px,50vh)] flex flex-col shadow-[0_4px_16px_rgba(0,0,0,0.1)] z-[1000] outline-none text-[var(--vscode-chat-font-size,13px)] font-[var(--vscode-chat-font-family)]"
        tabIndex={-1}
        style={{
          top: '30px',
          left: '10px',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Box */}
        <div className="session-search p-2 flex items-center gap-2">
          <SearchIcon className="session-search-icon w-4 h-4 opacity-50 flex-shrink-0 text-[var(--app-primary-foreground)]" />
          <input
            type="text"
            className="session-search-input flex-1 bg-transparent border-none outline-none text-[var(--app-menu-foreground)] text-[var(--vscode-chat-font-size,13px)] font-[var(--vscode-chat-font-family)] p-0 placeholder:text-[var(--app-input-placeholder-foreground)] placeholder:opacity-60"
            placeholder="Search sessions…"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>

        {/* Session List with Grouping */}
        <div
          className="session-list-content overflow-y-auto flex-1 select-none p-2"
          onScroll={(e) => {
            const el = e.currentTarget;
            const distanceToBottom =
              el.scrollHeight - (el.scrollTop + el.clientHeight);
            if (distanceToBottom < 48 && hasMore && !isLoading) {
              onLoadMore?.();
            }
          }}
        >
          {hasNoSessions ? (
            <div
              className="p-5 text-center text-[var(--app-secondary-foreground)]"
              style={{
                padding: '20px',
                textAlign: 'center',
                color: 'var(--app-secondary-foreground)',
              }}
            >
              {searchQuery ? 'No matching sessions' : 'No sessions available'}
            </div>
          ) : (
            groupSessionsByDate(sessions).map((group) => (
              <React.Fragment key={group.label}>
                <div className="session-group-label p-1 px-2 text-[var(--app-primary-foreground)] opacity-50 text-[0.9em] font-medium [&:not(:first-child)]:mt-2">
                  {group.label}
                </div>
                <div className="session-group flex flex-col gap-[2px]">
                  {group.sessions.map((session) => {
                    const sessionId =
                      (session.id as string) ||
                      (session.sessionId as string) ||
                      '';
                    const title =
                      (session.title as string) ||
                      (session.name as string) ||
                      'Untitled';
                    const lastUpdated =
                      (session.lastUpdated as string) ||
                      (session.startTime as string) ||
                      '';
                    const isActive = sessionId === currentSessionId;

                    return (
                      <button
                        key={sessionId}
                        className={`session-item flex items-center justify-between py-1.5 px-2 bg-transparent border-none rounded-md cursor-pointer text-left w-full text-[var(--vscode-chat-font-size,13px)] font-[var(--vscode-chat-font-family)] text-[var(--app-primary-foreground)] transition-colors duration-100 hover:bg-[var(--app-list-hover-background)] ${
                          isActive
                            ? 'active bg-[var(--app-list-active-background)] text-[var(--app-list-active-foreground)] font-[600]'
                            : ''
                        }`}
                        onClick={() => {
                          onSelectSession(sessionId);
                          onClose();
                        }}
                      >
                        <span className="session-item-title flex-1 overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
                          {title}
                        </span>
                        <span className="session-item-time opacity-60 text-[0.9em] flex-shrink-0 ml-3">
                          {getTimeAgo(lastUpdated)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </React.Fragment>
            ))
          )}
          {hasMore && (
            <div className="p-2 text-center opacity-60 text-[0.9em]">
              {isLoading ? 'Loading…' : ''}
            </div>
          )}
        </div>
      </div>
    </>
  );
};
