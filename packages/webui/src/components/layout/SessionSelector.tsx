/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * SessionSelector component - Session list dropdown
 * Displays sessions grouped by date with search and infinite scroll
 */

import type { FC } from 'react';
import { Fragment, useState, useRef, useEffect } from 'react';
import {
  getTimeAgo,
  groupSessionsByDate,
} from '../../utils/sessionGrouping.js';
import { SearchIcon } from '../icons/NavigationIcons.js';

/**
 * Props for SessionSelector component
 */
export interface SessionSelectorProps {
  /** Whether the selector is visible */
  visible: boolean;
  /** List of session objects */
  sessions: Array<Record<string, unknown>>;
  /** Currently selected session ID */
  currentSessionId: string | null;
  /** Current search query */
  searchQuery: string;
  /** Callback when search query changes */
  onSearchChange: (query: string) => void;
  /** Callback when a session is selected */
  onSelectSession: (sessionId: string) => void;
  /** Callback when a session is renamed */
  onRenameSession?: (sessionId: string, newTitle: string) => void;
  /** Callback when a session is deleted */
  onDeleteSession?: (sessionId: string) => void;
  /** Callback when selector should close */
  onClose: () => void;
  /** Whether there are more sessions to load */
  hasMore?: boolean;
  /** Whether loading is in progress */
  isLoading?: boolean;
  /** Callback to load more sessions */
  onLoadMore?: () => void;
}

/**
 * SessionSelector component
 *
 * Features:
 * - Sessions grouped by date (Today, Yesterday, This Week, Older)
 * - Search filtering
 * - Infinite scroll to load more sessions
 * - Click outside to close
 * - Active session highlighting
 *
 * @example
 * ```tsx
 * <SessionSelector
 *   visible={true}
 *   sessions={sessions}
 *   currentSessionId="abc123"
 *   searchQuery=""
 *   onSearchChange={(q) => setQuery(q)}
 *   onSelectSession={(id) => loadSession(id)}
 *   onClose={() => setVisible(false)}
 * />
 * ```
 */
export const SessionSelector: FC<SessionSelectorProps> = ({
  visible,
  sessions,
  currentSessionId,
  searchQuery,
  onSearchChange,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onClose,
  hasMore = false,
  isLoading = false,
  onLoadMore,
}) => {
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(
    null,
  );
  const [renameValue, setRenameValue] = useState('');
  const [originalRenameValue, setOriginalRenameValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isCancelingRenameRef = useRef(false);

  useEffect(() => {
    if (renamingSessionId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingSessionId]);

  const handleRenameSubmit = (sessionId: string) => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== originalRenameValue && onRenameSession) {
      onRenameSession(sessionId, trimmed);
    }
    setRenamingSessionId(null);
    setRenameValue('');
    setOriginalRenameValue('');
  };
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
            aria-label="Search sessions"
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
              <Fragment key={group.label}>
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

                    if (renamingSessionId === sessionId) {
                      return (
                        <div
                          key={sessionId}
                          className="session-item flex items-center py-1.5 px-2 rounded-md"
                        >
                          <input
                            ref={renameInputRef}
                            type="text"
                            maxLength={200} // SESSION_TITLE_MAX_LENGTH
                            className="flex-1 bg-[var(--vscode-input-background,var(--app-input-background))] text-[var(--vscode-input-foreground,var(--app-primary-foreground))] border-2 border-[var(--vscode-focusBorder)] rounded px-2 py-1 text-[var(--vscode-chat-font-size,13px)] font-[var(--vscode-chat-font-family)] outline-none min-w-0 shadow-[0_0_0_1px_var(--vscode-focusBorder)]"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                handleRenameSubmit(sessionId);
                              } else if (e.key === 'Escape') {
                                isCancelingRenameRef.current = true;
                                setRenamingSessionId(null);
                                setRenameValue('');
                                setOriginalRenameValue('');
                              }
                            }}
                            onBlur={() => {
                              if (isCancelingRenameRef.current) {
                                isCancelingRenameRef.current = false;
                                return;
                              }
                              handleRenameSubmit(sessionId);
                            }}
                          />
                        </div>
                      );
                    }

                    return (
                      <div
                        key={sessionId}
                        className={`session-item group flex items-center justify-between py-1.5 px-2 rounded-md cursor-pointer transition-colors duration-100 hover:bg-[var(--app-list-hover-background)] ${
                          isActive
                            ? 'active bg-[var(--app-list-active-background)] text-[var(--app-list-active-foreground)] font-[600]'
                            : 'text-[var(--app-primary-foreground)]'
                        }`}
                        onClick={() => {
                          onSelectSession(sessionId);
                          onClose();
                        }}
                      >
                        <span className="session-item-title flex-1 overflow-hidden text-ellipsis whitespace-nowrap min-w-0 text-[var(--vscode-chat-font-size,13px)] font-[var(--vscode-chat-font-family)]">
                          {title}
                        </span>
                        <span className="flex items-center gap-1 flex-shrink-0 ml-2">
                          {(onRenameSession || onDeleteSession) && (
                            <span
                              className={`items-center gap-0.5 ${confirmDeleteId === sessionId ? 'flex' : 'hidden group-hover:flex'}`}
                            >
                              {onRenameSession && (
                                <button
                                  type="button"
                                  className="p-0.5 bg-transparent border-none cursor-pointer opacity-50 hover:opacity-100 text-[var(--app-primary-foreground)] rounded"
                                  title="Rename"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setRenamingSessionId(sessionId);
                                    setRenameValue(title);
                                    setOriginalRenameValue(title);
                                  }}
                                >
                                  <svg
                                    width="14"
                                    height="14"
                                    viewBox="0 0 16 16"
                                    fill="currentColor"
                                  >
                                    <path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l8-8 1.77 1.77-8 8z" />
                                  </svg>
                                </button>
                              )}
                              {onDeleteSession &&
                                !isActive &&
                                (confirmDeleteId === sessionId ? (
                                  <button
                                    type="button"
                                    className="px-1.5 py-0.5 bg-[var(--vscode-inputValidation-errorBackground,#5a1d1d)] border border-[var(--vscode-inputValidation-errorBorder,#be1100)] cursor-pointer text-[var(--vscode-errorForeground,#f48771)] rounded text-[11px] leading-tight"
                                    title="Click to confirm delete"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setConfirmDeleteId(null);
                                      onDeleteSession(sessionId);
                                    }}
                                    onBlur={() => setConfirmDeleteId(null)}
                                  >
                                    Delete?
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="p-0.5 bg-transparent border-none cursor-pointer opacity-50 hover:opacity-100 text-[var(--app-primary-foreground)] rounded"
                                    title="Delete"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setConfirmDeleteId(sessionId);
                                    }}
                                  >
                                    <svg
                                      width="14"
                                      height="14"
                                      viewBox="0 0 16 16"
                                      fill="currentColor"
                                    >
                                      <path d="M10 3h3v1h-1v9l-1 1H5l-1-1V4H3V3h3V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1zM9 2H7v1h2V2zM5 4v9h6V4H5zm2 2h1v5H7V6zm3 0h-1v5h1V6z" />
                                    </svg>
                                  </button>
                                ))}
                            </span>
                          )}
                          <span className="session-item-time opacity-60 text-[0.9em]">
                            {getTimeAgo(lastUpdated)}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </Fragment>
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
