/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Fragment, useEffect, useRef, useState } from 'react';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { LoaderCircle, Pencil, Search, Trash2 } from 'lucide-react';

interface SessionHistoryDropdownProps {
  sessions: readonly DaemonSessionSummary[];
  currentSessionId?: string;
  searchQuery: string;
  loading: boolean;
  hasMore: boolean;
  error?: string;
  onSearchChange: (query: string) => void;
  onSelect: (session: DaemonSessionSummary) => void;
  onRename: (session: DaemonSessionSummary, title: string) => Promise<void>;
  onDelete: (session: DaemonSessionSummary) => Promise<void>;
  onLoadMore: () => void;
  onClose: () => void;
}

function groupSessions(sessions: readonly DaemonSessionSummary[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map<string, DaemonSessionSummary[]>([
    ['Today', []],
    ['Yesterday', []],
    ['This Week', []],
    ['Older', []],
  ]);

  for (const session of sessions) {
    const timestamp = session.updatedAt ?? session.createdAt;
    const date = timestamp ? new Date(timestamp) : undefined;
    let label = 'Older';
    if (date && !Number.isNaN(date.getTime())) {
      const day = new Date(date);
      day.setHours(0, 0, 0, 0);
      if (day.getTime() === today.getTime()) label = 'Today';
      else if (day.getTime() === yesterday.getTime()) label = 'Yesterday';
      else if (day.getTime() > today.getTime() - 7 * 86_400_000) {
        label = 'This Week';
      }
    }
    groups.get(label)?.push(session);
  }

  return Array.from(groups, ([label, entries]) => ({
    label,
    sessions: entries,
  })).filter((group) => group.sessions.length > 0);
}

function timeAgo(timestamp?: string): string {
  if (!timestamp) return '';
  const elapsed = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(elapsed)) return '';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(elapsed / 86_400_000);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString();
}

export function SessionHistoryDropdown({
  sessions,
  currentSessionId,
  searchQuery,
  loading,
  hasMore,
  error,
  onSearchChange,
  onSelect,
  onRename,
  onDelete,
  onLoadMore,
  onClose,
}: SessionHistoryDropdownProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const cancelRenameRef = useRef(false);
  const [hoveredId, setHoveredId] = useState<string>();
  const [renamingId, setRenamingId] = useState<string>();
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    if (renamingId) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renamingId]);

  const filtered = searchQuery.trim()
    ? sessions.filter((session) =>
        (session.displayName ?? 'Untitled')
          .toLowerCase()
          .includes(searchQuery.trim().toLowerCase()),
      )
    : sessions;

  const finishRename = async (session: DaemonSessionSummary) => {
    const cancelled = cancelRenameRef.current;
    cancelRenameRef.current = false;
    const title = renameValue.trim();
    setRenamingId(undefined);
    if (!cancelled && title && title !== (session.displayName ?? '')) {
      await onRename(session, title);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close conversation history"
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 999,
          padding: 0,
          border: 0,
          background: 'transparent',
        }}
      />
      <div
        id="qwen-session-history"
        role="dialog"
        aria-modal="true"
        aria-label="Past conversations"
        style={{
          position: 'absolute',
          top: 30,
          left: 10,
          zIndex: 1000,
          display: 'flex',
          width: 'min(400px, calc(100% - 20px))',
          maxHeight: 'min(500px, calc(100% - 42px))',
          flexDirection: 'column',
          overflow: 'hidden',
          border:
            '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
          borderRadius: 6,
          background:
            'var(--vscode-menu-background, var(--vscode-sideBar-background))',
          color: 'var(--vscode-menu-foreground, var(--vscode-foreground))',
          boxShadow: '0 4px 16px rgba(0, 0, 0, 0.28)',
        }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') onClose();
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 10px',
            borderBottom:
              '1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border))',
          }}
        >
          <Search size={15} aria-hidden="true" style={{ opacity: 0.65 }} />
          <input
            ref={searchRef}
            type="text"
            aria-label="Search conversations"
            placeholder="Search sessions…"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key !== 'ArrowDown' &&
                event.key !== 'ArrowUp' &&
                event.key !== 'Home' &&
                event.key !== 'End'
              ) {
                return;
              }
              const rows = Array.from(
                event.currentTarget
                  .closest('[role="dialog"]')
                  ?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
              );
              if (rows.length === 0) return;
              event.preventDefault();
              const index =
                event.key === 'ArrowUp' || event.key === 'End'
                  ? rows.length - 1
                  : 0;
              rows[index]?.focus();
            }}
            style={{
              minWidth: 0,
              flex: 1,
              padding: 0,
              border: 0,
              outline: 0,
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
            }}
          />
        </div>

        {error && (
          <div
            role="alert"
            style={{
              padding: '6px 10px',
              borderBottom: '1px solid var(--vscode-panel-border)',
              color: 'var(--vscode-errorForeground)',
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        <div
          role="listbox"
          aria-label="Conversations"
          style={{ minWidth: 0, overflowX: 'hidden', overflowY: 'auto', padding: 6 }}
          onScroll={(event) => {
            const element = event.currentTarget;
            if (
              element.scrollHeight - element.scrollTop - element.clientHeight <
                48 &&
              hasMore &&
              !loading
            ) {
              onLoadMore();
            }
          }}
        >
          {groupSessions(filtered).map((group) => (
            <Fragment key={group.label}>
              <div
                style={{
                  padding: '7px 8px 4px',
                  color: 'var(--vscode-descriptionForeground)',
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                {group.label}
              </div>
              {group.sessions.map((session) => {
                const active = session.sessionId === currentSessionId;
                const hovered = session.sessionId === hoveredId;
                const renaming = session.sessionId === renamingId;
                return (
                  <div
                    key={session.sessionId}
                    role="option"
                    aria-selected={active}
                    tabIndex={renaming ? -1 : 0}
                    data-session-id={session.sessionId}
                    onMouseEnter={() => setHoveredId(session.sessionId)}
                    onMouseLeave={() => setHoveredId(undefined)}
                    style={{
                      display: 'flex',
                      minHeight: 31,
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 8px',
                      overflow: 'hidden',
                      borderRadius: 4,
                      background: active
                        ? 'var(--vscode-list-activeSelectionBackground)'
                        : hovered
                          ? 'var(--vscode-list-hoverBackground)'
                          : 'transparent',
                      color: active
                        ? 'var(--vscode-list-activeSelectionForeground)'
                        : 'inherit',
                      cursor: renaming ? 'default' : 'pointer',
                    }}
                    onClick={() => {
                      if (active || renaming) return;
                      onSelect(session);
                    }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget || renaming) {
                        return;
                      }
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        if (!active) onSelect(session);
                        return;
                      }
                      if (
                        event.key !== 'ArrowDown' &&
                        event.key !== 'ArrowUp' &&
                        event.key !== 'Home' &&
                        event.key !== 'End'
                      ) {
                        return;
                      }
                      event.preventDefault();
                      const rows = Array.from(
                        event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
                          '[role="option"]',
                        ) ?? [],
                      );
                      const index = rows.indexOf(event.currentTarget);
                      const nextIndex =
                        event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? rows.length - 1
                            : Math.max(
                                0,
                                Math.min(
                                  rows.length - 1,
                                  index + (event.key === 'ArrowDown' ? 1 : -1),
                                ),
                              );
                      rows[nextIndex]?.focus();
                    }}
                  >
                    {renaming ? (
                      <input
                        ref={renameRef}
                        maxLength={200}
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            event.currentTarget.blur();
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            event.stopPropagation();
                            cancelRenameRef.current = true;
                            setRenamingId(undefined);
                          }
                        }}
                        onBlur={() => void finishRename(session)}
                        style={{
                          minWidth: 0,
                          flex: 1,
                          padding: '3px 6px',
                          border: '1px solid var(--vscode-focusBorder)',
                          borderRadius: 3,
                          outline: 0,
                          background: 'var(--vscode-input-background)',
                          color: 'var(--vscode-input-foreground)',
                          font: 'inherit',
                        }}
                      />
                    ) : (
                      <span
                        style={{
                          minWidth: 0,
                          flex: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontWeight: active ? 600 : 400,
                        }}
                      >
                        {session.displayName || 'Untitled'}
                      </span>
                    )}

                    {!renaming &&
                      (hovered || confirmDeleteId === session.sessionId) && (
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 2,
                          }}
                        >
                          <button
                            type="button"
                            title="Rename"
                            aria-label="Rename conversation"
                            onClick={(event) => {
                              event.stopPropagation();
                              cancelRenameRef.current = false;
                              setRenamingId(session.sessionId);
                              setRenameValue(session.displayName ?? '');
                            }}
                            style={iconButtonStyle}
                          >
                            <Pencil size={13} aria-hidden="true" />
                          </button>
                          {!active &&
                            (confirmDeleteId === session.sessionId ? (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setConfirmDeleteId(undefined);
                                  void onDelete(session);
                                }}
                                style={{
                                  ...iconButtonStyle,
                                  width: 'auto',
                                  padding: '0 5px',
                                  color: 'var(--vscode-errorForeground)',
                                }}
                              >
                                Delete?
                              </button>
                            ) : (
                              <button
                                type="button"
                                title="Delete"
                                aria-label="Delete conversation"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setConfirmDeleteId(session.sessionId);
                                }}
                                style={iconButtonStyle}
                              >
                                <Trash2 size={13} aria-hidden="true" />
                              </button>
                            ))}
                        </span>
                      )}
                    {!renaming ? (
                      <span
                        style={{
                          flex: '0 0 auto',
                          opacity: 0.6,
                          fontSize: 11,
                        }}
                      >
                        {timeAgo(session.updatedAt ?? session.createdAt)}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </Fragment>
          ))}

          {!loading && filtered.length === 0 && (
            <div
              style={{
                padding: 20,
                textAlign: 'center',
                color: 'var(--vscode-descriptionForeground)',
              }}
            >
              {searchQuery ? 'No matching sessions' : 'No sessions available'}
            </div>
          )}
          {loading && (
            <div
              role="status"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
                padding: 12,
                color: 'var(--vscode-descriptionForeground)',
              }}
            >
              <LoaderCircle
                size={15}
                aria-hidden="true"
                style={{ animation: 'qwen-vscode-spin 0.8s linear infinite' }}
              />
              Loading…
            </div>
          )}
        </div>
      </div>
    </>
  );
}

const iconButtonStyle = {
  display: 'inline-flex',
  width: 22,
  height: 22,
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: 0,
  borderRadius: 3,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
} as const;
