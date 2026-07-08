/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DaemonSessionProvider,
  useConnection,
  useSessions,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../i18n';
import { ChatPane } from './ChatPane';
import { ErrorBoundary } from './ErrorBoundary';
import { MAX_SPLIT_PANES } from '../utils/splitUrl';
import {
  SESSION_LIST_PAGE_SIZE,
  SESSION_ORGANIZATION_FEATURE,
} from '../constants/sessions';
import styles from './SplitView.module.css';

const MAX_PANES = MAX_SPLIT_PANES;

export interface SplitViewProps {
  /** Sessions to show in the split view. */
  sessionIds?: string[];
  /**
   * Report the live pane set (after every add / remove) up to the parent so it
   * survives this view unmounting. Switching away from the split and back must
   * restore exactly the panes the user had, not reseed from a stale selection.
   * Must be referentially stable (e.g. a `useState` setter) — a fresh callback
   * each render would re-fire the reporting effect and loop.
   */
  onPanesChange?: (sessionIds: string[]) => void;
  /** Leave the split view (back to the single-session chat). */
  onExit: () => void;
  onError?: (error: unknown, fallback: string) => void;
  /**
   * Bumped by the parent whenever the session list changes elsewhere (create /
   * delete / rename). The "add pane" picker reloads on a change so it never
   * offers a session that has since been removed or misses one just created.
   */
  sessionListReloadToken?: number;
}

/**
 * Shows 2+ independent interactive chats side by side in one window. Each pane
 * is its own `DaemonSessionProvider` (own session, SSE, transcript, approvals),
 * all sharing the one `DaemonWorkspaceProvider` above the app. Browser focus
 * naturally scopes the keyboard to the pane the user clicks into, so panes never
 * fight over which session an approval or Enter belongs to.
 */
export function SplitView({
  sessionIds,
  onPanesChange,
  onExit,
  onError,
  sessionListReloadToken,
}: SplitViewProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const currentSessionId = connection.sessionId;
  const organizationEnabled =
    connection.capabilities?.features?.includes(SESSION_ORGANIZATION_FEATURE) ??
    false;
  const { sessions, reload } = useSessions({
    autoLoad: true,
    pageSize: SESSION_LIST_PAGE_SIZE,
    archiveState: 'active',
    ...(organizationEnabled
      ? { view: 'organized' as const, group: 'all' }
      : {}),
  });
  const sessionIdsControlled = sessionIds !== undefined;
  const normalizedSessionIds = useMemo(
    () =>
      Array.from(new Set((sessionIds ?? []).filter(Boolean))).slice(
        0,
        MAX_PANES,
      ),
    [sessionIds],
  );

  const [paneIds, setPaneIds] = useState<string[]>(() => {
    if (normalizedSessionIds.length > 0) return normalizedSessionIds;
    return currentSessionId ? [currentSessionId] : [];
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const addWrapRef = useRef<HTMLDivElement | null>(null);
  // A per-tab/per-mount nonce: two browser tabs opening the same split must not
  // register the same daemon client id, or suppressOwnUserEcho would treat one
  // tab's prompt as the other's own echo and drop it from the transcript.
  const [instanceId] = useState(() =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2),
  );

  useEffect(() => {
    if (!sessionIdsControlled) return;
    setPaneIds((prev) =>
      prev.length === normalizedSessionIds.length &&
      prev.every((id, index) => id === normalizedSessionIds[index])
        ? prev
        : normalizedSessionIds,
    );
  }, [normalizedSessionIds, sessionIdsControlled]);

  // Dismiss the "add session" picker on Escape or a click outside it.
  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!addWrapRef.current?.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPickerOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [pickerOpen]);

  // Refresh the list the moment the picker opens — `useSessions` only fetches on
  // mount, so without this the picker would offer whatever was current when the
  // split was first entered, missing sessions created since.
  useEffect(() => {
    if (pickerOpen) void reload();
  }, [pickerOpen, reload]);

  // Also refresh when the parent signals the list changed elsewhere (a session
  // created / deleted / renamed in the sidebar or another tab), so an open
  // picker — or the next open — reflects it without re-entering the split.
  // Reload on every distinct token bump. `useDaemonResource` serializes
  // responses via its sequence counter (last write wins), so overlapping reloads
  // are safe; and the token is bumped only on discrete session-change events
  // (App fires an immediate bump plus one delayed follow-up per change), not as a
  // high-frequency stream. Deliberately *not* skipping while a reload is in
  // flight: doing so would drop a bump that lands mid-reload — the effect has
  // already run for that value and clearing an in-flight flag wouldn't re-run it,
  // so the picker could stay stale after a burst. An occasional redundant fetch
  // is far cheaper than a lost refresh, and the split has no polling fallback.
  const prevReloadTokenRef = useRef(sessionListReloadToken);
  useEffect(() => {
    if (
      sessionListReloadToken !== undefined &&
      sessionListReloadToken !== prevReloadTokenRef.current
    ) {
      prevReloadTokenRef.current = sessionListReloadToken;
      void reload();
    }
  }, [sessionListReloadToken, reload]);

  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of sessions) {
      map.set(
        session.sessionId,
        session.displayName?.trim() || session.sessionId.slice(0, 8),
      );
    }
    return map;
  }, [sessions]);

  const addPane = useCallback((sessionId: string) => {
    setPaneIds((prev) =>
      prev.includes(sessionId) || prev.length >= MAX_PANES
        ? prev
        : [...prev, sessionId],
    );
    setPickerOpen(false);
  }, []);

  // Closing the last pane is a natural "I'm done" gesture — return to the
  // overview instead of stranding the user on an empty split. Guarded so an
  // initial empty seed (no current session) doesn't bounce straight back out.
  const hadPanesRef = useRef(false);
  useEffect(() => {
    if (paneIds.length > 0) {
      hadPanesRef.current = true;
    } else if (hadPanesRef.current) {
      onExit();
    }
  }, [paneIds, onExit]);

  // Mirror the live pane set up to the parent so it outlives this component
  // unmounting when the user switches views. On re-entry the parent reseeds
  // `sessionIds` from it, restoring the exact panes instead of clearing.
  useEffect(() => {
    onPanesChange?.(paneIds);
  }, [paneIds, onPanesChange]);

  const removePane = useCallback((sessionId: string) => {
    setPaneIds((prev) => prev.filter((id) => id !== sessionId));
  }, []);

  const available = useMemo(
    () => sessions.filter((session) => !paneIds.includes(session.sessionId)),
    [sessions, paneIds],
  );
  const canAdd = paneIds.length < MAX_PANES && available.length > 0;

  return (
    <div className={styles.split} data-testid="split-view">
      <header className={styles.toolbar}>
        <button
          type="button"
          className={styles.backButton}
          onClick={onExit}
          aria-label={t('common.back')}
          title={t('common.back')}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M15 18l-6-6 6-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span className={styles.title}>{t('splitView.title')}</span>
        <span className={styles.count}>
          {t('splitView.count', { count: paneIds.length })}
        </span>
        <div className={styles.addWrap} ref={addWrapRef}>
          <button
            type="button"
            className={styles.addButton}
            disabled={!canAdd}
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
          >
            + {t('splitView.addPane')}
          </button>
          {pickerOpen && available.length > 0 && (
            <ul className={styles.picker} role="listbox">
              {available.map((session) => (
                <li key={session.sessionId} role="option" aria-selected="false">
                  <button
                    type="button"
                    className={styles.pickerItem}
                    onClick={() => addPane(session.sessionId)}
                  >
                    {titleById.get(session.sessionId) ??
                      session.sessionId.slice(0, 8)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </header>

      <div className={styles.panes}>
        {paneIds.length === 0 ? (
          <div className={styles.empty}>{t('splitView.empty')}</div>
        ) : (
          paneIds.map((sessionId) => (
            <div className={styles.paneSlot} key={sessionId}>
              {/* Contain a render crash to its own pane — a malformed block in
                  one session must not white-screen the whole split. */}
              <ErrorBoundary
                label={`split-pane:${sessionId}`}
                resetKeys={[sessionId]}
                fallback={(error) => (
                  <div className={styles.paneError} role="alert">
                    <div className={styles.paneErrorTitle}>
                      {titleById.get(sessionId) ?? sessionId.slice(0, 8)}
                    </div>
                    <div className={styles.paneErrorMessage}>
                      {t('splitView.paneError')}: {error.message}
                    </div>
                    <button
                      type="button"
                      className={styles.paneErrorClose}
                      onClick={() => removePane(sessionId)}
                    >
                      {t('splitView.closePane')}
                    </button>
                  </div>
                )}
              >
                <DaemonSessionProvider
                  sessionId={sessionId}
                  // Distinct from the main view's client (and from any other
                  // tab's panes) for the same session, so the attachments don't
                  // collide on one client identity.
                  clientId={`split-pane:${instanceId}:${sessionId}`}
                  suppressOwnUserEcho
                >
                  <ChatPane
                    title={titleById.get(sessionId)}
                    onClose={() => removePane(sessionId)}
                    onError={onError}
                  />
                </DaemonSessionProvider>
              </ErrorBoundary>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
