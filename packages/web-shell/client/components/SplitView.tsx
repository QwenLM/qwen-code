/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo, useState } from 'react';
import {
  DaemonSessionProvider,
  useConnection,
  useSessions,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../i18n';
import { ChatPane } from './ChatPane';
import styles from './SplitView.module.css';

// Cap the number of live panes: each is a full session (its own SSE stream +
// transcript), so an unbounded split would open unbounded daemon connections.
// Beyond a handful they also stop being readable side by side.
const MAX_PANES = 6;
const SESSION_PAGE_SIZE = 1000;
const SESSION_ORGANIZATION_FEATURE = 'session_organization';

export interface SplitViewProps {
  /** Sessions to open initially (e.g. the selection from the overview). */
  initialSessionIds?: string[];
  /** Leave the split view (back to the single-session chat). */
  onExit: () => void;
  onError?: (error: unknown, fallback: string) => void;
}

/**
 * Shows 2+ independent interactive chats side by side in one window. Each pane
 * is its own `DaemonSessionProvider` (own session, SSE, transcript, approvals),
 * all sharing the one `DaemonWorkspaceProvider` above the app. Browser focus
 * naturally scopes the keyboard to the pane the user clicks into, so panes never
 * fight over which session an approval or Enter belongs to.
 */
export function SplitView({
  initialSessionIds,
  onExit,
  onError,
}: SplitViewProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const currentSessionId = connection.sessionId;
  const organizationEnabled =
    connection.capabilities?.features?.includes(
      SESSION_ORGANIZATION_FEATURE,
    ) ?? false;
  const { sessions } = useSessions({
    autoLoad: true,
    pageSize: SESSION_PAGE_SIZE,
    archiveState: 'active',
    ...(organizationEnabled
      ? { view: 'organized' as const, group: 'all' }
      : {}),
  });

  const [paneIds, setPaneIds] = useState<string[]>(() => {
    const seed = Array.from(new Set((initialSessionIds ?? []).filter(Boolean)));
    if (seed.length > 0) return seed.slice(0, MAX_PANES);
    return currentSessionId ? [currentSessionId] : [];
  });
  const [pickerOpen, setPickerOpen] = useState(false);

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
        <div className={styles.addWrap}>
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
              <DaemonSessionProvider
                sessionId={sessionId}
                // Distinct from the main view's client for the same session so
                // the two attachments don't collide on one client identity.
                clientId={`split-pane:${sessionId}`}
                suppressOwnUserEcho
              >
                <ChatPane
                  title={titleById.get(sessionId)}
                  isCurrent={sessionId === currentSessionId}
                  onClose={() => removePane(sessionId)}
                  onError={onError}
                />
              </DaemonSessionProvider>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
