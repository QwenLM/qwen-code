/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import type { ChromeStrings } from '../strings.js';
import { LoaderCircle, Pencil, Search, Trash2 } from 'lucide-react';

interface SessionHistoryDropdownProps {
  t: ChromeStrings;
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

function groupSessions(
  sessions: readonly DaemonSessionSummary[],
  t: ChromeStrings,
) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map<string, DaemonSessionSummary[]>([
    [t('group.today'), []],
    [t('group.yesterday'), []],
    [t('group.thisWeek'), []],
    [t('group.older'), []],
  ]);

  for (const session of sessions) {
    const timestamp = session.updatedAt ?? session.createdAt;
    const date = timestamp ? new Date(timestamp) : undefined;
    let label = t('group.older');
    if (date && !Number.isNaN(date.getTime())) {
      const day = new Date(date);
      day.setHours(0, 0, 0, 0);
      if (day.getTime() === today.getTime()) label = t('group.today');
      else if (day.getTime() === yesterday.getTime()) {
        label = t('group.yesterday');
      } else if (day.getTime() > today.getTime() - 7 * 86_400_000) {
        label = t('group.thisWeek');
      }
    }
    groups.get(label)?.push(session);
  }

  return Array.from(groups, ([label, entries]) => ({
    label,
    sessions: entries,
  })).filter((group) => group.sessions.length > 0);
}

function timeAgo(timestamp: string | undefined, t: ChromeStrings): string {
  if (!timestamp) return '';
  const elapsed = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(elapsed)) return '';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return t('time.now');
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(elapsed / 86_400_000);
  if (days === 1) return t('group.yesterday');
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Row actions are revealed by hover *or* keyboard focus. Gating them on a
 * React `hovered` flag alone left rename and delete unreachable without a
 * mouse, and unmounting the focused button on mouse-out drops focus to
 * `<body>`; CSS keeps them mounted and reachable.
 */
const DROPDOWN_CSS = `
  .qwen-session-row-actions { visibility: hidden; }
  .qwen-session-row:hover .qwen-session-row-actions,
  .qwen-session-row:focus-within .qwen-session-row-actions,
  .qwen-session-row-actions[data-confirming] { visibility: visible; }
  .qwen-session-row:focus-visible,
  .qwen-session-search:focus-visible,
  .qwen-session-icon-button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .qwen-session-icon-button:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
`;

export function SessionHistoryDropdown({
  t,
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

  // A stale "Delete?" must not survive a change of what is on screen.
  useEffect(() => {
    setConfirmDeleteId(undefined);
  }, [searchQuery]);

  const lastRenamingIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (renamingId) {
      lastRenamingIdRef.current = renamingId;
      renameRef.current?.focus();
      renameRef.current?.select();
      return;
    }
    const finished = lastRenamingIdRef.current;
    if (!finished) return;
    lastRenamingIdRef.current = undefined;
    // The rename input unmounts when the rename ends; without a restore,
    // focus falls to <body> and the dialog stops receiving key events.
    const row = Array.from(
      document.querySelectorAll<HTMLElement>(
        '#qwen-session-history [data-session-id]',
      ),
    ).find((element) => element.dataset.sessionId === finished);
    (row ?? searchRef.current)?.focus();
  }, [renamingId]);

  // Focus can also land on <body> when a focused element unmounts (a deleted
  // row) or non-focusable content is clicked. Those events never pass
  // through the dialog div's onKeyDown, so guard Escape and re-trap Tab at
  // the window level while the dropdown is mounted.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (
        event.key !== 'Tab' ||
        document
          .getElementById('qwen-session-history')
          ?.contains(document.activeElement)
      ) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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
        aria-label={t('session.closeHistory')}
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
        aria-label={t('header.history')}
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
          if (event.key === 'Escape') {
            onClose();
            return;
          }
          // `aria-modal` promises the dialog contains focus; without a trap
          // Tab walks into the transcript behind the overlay.
          if (event.key !== 'Tab') return;
          const focusable = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'input, button, [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((element) => element.tabIndex !== -1);
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          const active = document.activeElement;
          if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <style>{DROPDOWN_CSS}</style>
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
            className="qwen-session-search"
            aria-label={t('session.searchLabel')}
            placeholder={t('session.searchPlaceholder')}
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
          aria-label={t('session.listLabel')}
          style={{
            minWidth: 0,
            overflowX: 'hidden',
            overflowY: 'auto',
            padding: 6,
          }}
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
          {groupSessions(filtered, t).map((group) => (
            <div role="group" aria-label={group.label} key={group.label}>
              <div
                aria-hidden="true"
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
                    className="qwen-session-row"
                    aria-selected={active}
                    tabIndex={renaming ? -1 : 0}
                    data-session-id={session.sessionId}
                    onMouseEnter={() => setHoveredId(session.sessionId)}
                    onMouseLeave={() => {
                      setHoveredId(undefined);
                      // Don't leave a primed "Delete?" behind on a row the
                      // pointer has left.
                      setConfirmDeleteId((current) =>
                        current === session.sessionId ? undefined : current,
                      );
                    }}
                    style={{
                      display: 'flex',
                      minHeight: 26,
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
                      // Groups wrap rows, so walk up to the listbox — the
                      // immediate parent only holds one date group.
                      const rows = Array.from(
                        event.currentTarget
                          .closest('[role="listbox"]')
                          ?.querySelectorAll<HTMLElement>('[role="option"]') ??
                          [],
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
                        {session.displayName || t('session.untitled')}
                      </span>
                    )}

                    {!renaming && (
                      <span
                        className="qwen-session-row-actions"
                        {...(confirmDeleteId === session.sessionId
                          ? { 'data-confirming': '' }
                          : {})}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 2,
                        }}
                      >
                        <button
                          type="button"
                          className="qwen-session-icon-button"
                          title={t('session.rename')}
                          aria-label={t('session.renameLabel')}
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
                              className="qwen-session-icon-button"
                              aria-label={t('session.deleteConfirmLabel')}
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
                              {t('session.deleteConfirm')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="qwen-session-icon-button"
                              title={t('session.delete')}
                              aria-label={t('session.deleteLabel')}
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
                        {timeAgo(session.updatedAt ?? session.createdAt, t)}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}

          {!loading && filtered.length === 0 && (
            <div
              style={{
                padding: 20,
                textAlign: 'center',
                color: 'var(--vscode-descriptionForeground)',
              }}
            >
              {searchQuery ? t('session.emptyFiltered') : t('session.empty')}
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
              {t('session.loading')}
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
