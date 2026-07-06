/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useConnection,
  useSessions,
  useStatusReport,
} from '@qwen-code/webui/daemon-react-sdk';
import type {
  DaemonSessionGroupColor,
  DaemonSessionSummary,
  DaemonStatusReportSession,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../i18n';
import { formatRelativeTime } from '../utils/formatRelativeTime';
import { buildSplitUrl, MAX_SPLIT_PANES } from '../utils/splitUrl';
import { getDaemonToken } from '../config/daemon';
import { ErrorBoundary } from './ErrorBoundary';
import styles from './SessionOverviewPanel.module.css';

// The list is cheap to poll (it's the same endpoint the sidebar already hits),
// so it drives the primary running/idle liveness at a snappy cadence. The
// detail=full status report is materially more expensive — it aggregates
// per-session diagnostics and can spawn the ACP child — so DaemonStatusDialog
// deliberately never polls it. We do poll it here, but slowly: it is the only
// source of the per-session "needs approval" signal, which is the whole point
// of a mission-control view, and a bounded 10s cadence keeps the cost in check
// while approval badges stay live-enough. Both polls pause when the tab is
// hidden or a previous request is still outstanding.
const LIST_POLL_MS = 3000;
const STATUS_POLL_MS = 10000;
const SESSION_PAGE_SIZE = 1000;
const SESSION_ORGANIZATION_FEATURE = 'session_organization';

export type SessionCardStatus = 'needsApproval' | 'running' | 'idle';

export interface SessionCard {
  sessionId: string;
  label: string;
  status: SessionCardStatus;
  clientCount: number;
  model?: string;
  updatedAt?: string;
  color?: DaemonSessionGroupColor | null;
  isCurrent: boolean;
}

const STATUS_PRIORITY: Record<SessionCardStatus, number> = {
  needsApproval: 0,
  running: 1,
  idle: 2,
};

/**
 * Merge the (cheap, all-sessions) list with the (richer, loaded-sessions-only)
 * status report into one ranked set of cards. `needsApproval` is derived from
 * the status report's `pendingPermissionCount` and takes precedence over
 * `running` because it is the actionable state — the session is blocked waiting
 * for the user. Cold sessions absent from the status report simply read as
 * idle. Sorted needs-approval → running → idle, then most-recent first, so the
 * sessions that want attention float to the top of a 10+ session grid.
 */
export function deriveSessionCards(
  sessions: DaemonSessionSummary[],
  statusSessions: DaemonStatusReportSession[],
  currentSessionId: string | undefined,
): SessionCard[] {
  const statusById = new Map(
    statusSessions.map((session) => [session.sessionId, session]),
  );
  const cards = sessions.map((session): SessionCard => {
    const status = statusById.get(session.sessionId);
    const running = session.hasActivePrompt ?? status?.hasActivePrompt ?? false;
    const needsApproval = (status?.pendingPermissionCount ?? 0) > 0;
    return {
      sessionId: session.sessionId,
      label: session.displayName?.trim() || session.sessionId.slice(0, 8),
      status: needsApproval ? 'needsApproval' : running ? 'running' : 'idle',
      clientCount: session.clientCount ?? status?.clientCount ?? 0,
      model: status?.currentModelId,
      updatedAt: session.updatedAt || session.createdAt,
      color: session.color,
      isCurrent: session.sessionId === currentSessionId,
    };
  });
  cards.sort((a, b) => {
    const byStatus = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (byStatus !== 0) return byStatus;
    // ISO timestamps sort lexicographically; newest first.
    return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  });
  return cards;
}

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function colorDotClass(color: DaemonSessionGroupColor): string | undefined {
  switch (color) {
    case 'red':
      return styles.colorRed;
    case 'orange':
      return styles.colorOrange;
    case 'yellow':
      return styles.colorYellow;
    case 'green':
      return styles.colorGreen;
    case 'blue':
      return styles.colorBlue;
    case 'purple':
      return styles.colorPurple;
    default:
      return undefined;
  }
}

function statusClass(status: SessionCardStatus): string {
  switch (status) {
    case 'needsApproval':
      return styles.statusApproval;
    case 'running':
      return styles.statusRunning;
    default:
      return styles.statusIdle;
  }
}

function SessionOverviewPanelInner({
  onOpenSession,
  onOpenSplit,
}: {
  onOpenSession: (sessionId: string) => void;
  onOpenSplit?: (sessionIds: string[]) => void;
}) {
  const { t } = useI18n();
  const connection = useConnection();
  const currentSessionId = connection.sessionId;
  const organizationEnabled =
    connection.capabilities?.features?.includes(
      SESSION_ORGANIZATION_FEATURE,
    ) ?? false;

  const { sessions, loading, error, reload } = useSessions({
    autoLoad: true,
    pageSize: SESSION_PAGE_SIZE,
    archiveState: 'active',
    ...(organizationEnabled
      ? { view: 'organized' as const, group: 'all' }
      : {}),
  });
  const status = useStatusReport({ autoLoad: true, detail: 'full' });
  const statusReload = status.reload;
  const statusReport = status.report;

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [popupBlocked, setPopupBlocked] = useState(false);

  // Poll the cheap list. Skip a tick when the tab is hidden or the previous
  // request is still outstanding (mirrors the sidebar / daemon-status polls).
  const listInFlight = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden || listInFlight.current) return;
      listInFlight.current = true;
      void reload().finally(() => {
        listInFlight.current = false;
      });
    }, LIST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  // Poll the richer status report less often — it is the only source of
  // per-session "needs approval" and current-model, but costs more to build.
  const statusInFlight = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden || statusInFlight.current) return;
      statusInFlight.current = true;
      void statusReload().finally(() => {
        statusInFlight.current = false;
      });
    }, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [statusReload]);

  const cards = useMemo(
    () =>
      deriveSessionCards(
        sessions,
        statusReport?.full?.sessions ?? [],
        currentSessionId,
      ),
    [sessions, statusReport, currentSessionId],
  );

  const toggleSelected = useCallback((sessionId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  // Selection drives the batch actions: open the checked sessions each in a new
  // tab, or open them together in the in-window split.
  const selectedIds = cards
    .map((card) => card.sessionId)
    .filter((id) => selected.has(id));
  const selectedCount = selectedIds.length;
  const allSelected = cards.length > 0 && selectedCount === cards.length;
  // The split shows at most MAX_SPLIT_PANES; cap what we hand off so the new-tab
  // URL doesn't bloat with ids that get discarded and the in-window path doesn't
  // silently open fewer than were checked. The top-ranked selections win.
  const splitIds = selectedIds.slice(0, MAX_SPLIT_PANES);
  const overCap = selectedCount > MAX_SPLIT_PANES;
  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const ids = cards.map((card) => card.sessionId);
      // Toggle off only when every currently-listed card is selected — using
      // the intersection, not prev.size, so stale ids can't skew it.
      const everySelected = ids.length > 0 && ids.every((id) => prev.has(id));
      return everySelected ? new Set() : new Set(ids);
    });
  }, [cards]);

  // Drop selections for sessions that have left the list, so a reappearing
  // session isn't silently pre-selected and select-all/counts stay accurate.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const present = new Set(cards.map((card) => card.sessionId));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (present.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [cards]);

  // Open the selected sessions as a split view in a NEW browser tab: one tab
  // showing all of them side by side (not one tab per session). Passing no
  // window features makes browsers open a tab rather than a popup window.
  const openSelectedInNewTab = useCallback(() => {
    if (splitIds.length === 0) return;
    // Carry the (already-stripped-from-the-URL) daemon token so the new tab can
    // authenticate on token-auth deployments.
    const url = buildSplitUrl(splitIds, window.location.href, getDaemonToken());
    const win = window.open(url, '_blank');
    win?.focus();
    setPopupBlocked(!win);
  }, [splitIds]);

  const refresh = useCallback(() => {
    void reload();
    void statusReload();
  }, [reload, statusReload]);

  if (cards.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.empty}>
          {loading
            ? t('sessionsOverview.loading')
            : error
              ? `${t('sessionsOverview.loadFailed')}: ${error.message}`
              : t('sessionsOverview.empty')}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <span className={styles.count}>
          {t('sessionsOverview.count', { count: cards.length })}
        </span>
        <label className={styles.selectAll}>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleSelectAll}
          />
          {t('sessionsOverview.selectAll')}
        </label>
        <button
          type="button"
          className={styles.actionButton}
          disabled={selectedCount === 0}
          onClick={openSelectedInNewTab}
          title={t('sessionsOverview.openInTabHint')}
        >
          {t('sessionsOverview.openInTab')}
        </button>
        {onOpenSplit && (
          <button
            type="button"
            className={styles.actionButton}
            disabled={selectedCount === 0}
            onClick={() => onOpenSplit(splitIds)}
            title={t('sessionsOverview.openInSplitHint')}
          >
            {t('sessionsOverview.openInSplit')}
          </button>
        )}
        <button
          type="button"
          className={styles.refreshButton}
          onClick={refresh}
        >
          {t('sessionsOverview.refresh')}
        </button>
      </div>

      {overCap && (
        <div className={styles.notice} role="status">
          {t('sessionsOverview.splitCap', { max: MAX_SPLIT_PANES })}
        </div>
      )}
      {popupBlocked && (
        <div className={styles.notice} role="alert">
          {t('sessionsOverview.popupBlocked')}
        </div>
      )}

      <ul className={styles.grid}>
        {cards.map((card) => (
          <li
            key={card.sessionId}
            className={cx(
              styles.card,
              statusClass(card.status),
              card.isCurrent && styles.cardCurrent,
            )}
          >
            <div className={styles.cardTop}>
              <input
                type="checkbox"
                className={styles.cardCheckbox}
                checked={selected.has(card.sessionId)}
                onChange={() => toggleSelected(card.sessionId)}
                aria-label={t('sessionsOverview.selectSession', {
                  name: card.label,
                })}
              />
              {card.color && (
                <span
                  className={cx(styles.colorDot, colorDotClass(card.color))}
                  aria-hidden="true"
                />
              )}
              <button
                type="button"
                className={styles.cardLabel}
                onClick={() => onOpenSession(card.sessionId)}
                title={card.label}
              >
                {card.label}
              </button>
              {card.isCurrent && (
                <span className={styles.currentBadge}>
                  {t('sessionsOverview.current')}
                </span>
              )}
            </div>
            <div className={styles.cardMeta}>
              <span className={cx(styles.statusBadge, statusClass(card.status))}>
                {t(`sessionsOverview.status.${card.status}`)}
              </span>
              {card.model && (
                <span className={styles.metaItem} title={card.model}>
                  {card.model}
                </span>
              )}
              {card.clientCount > 0 && (
                <span
                  className={styles.metaItem}
                  title={t('sessionsOverview.openElsewhere')}
                >
                  {t('common.clients', { count: card.clientCount })}
                </span>
              )}
              {card.updatedAt && (
                <span className={styles.metaItem}>
                  {formatRelativeTime(card.updatedAt, t)}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A malformed daemon payload must not white-screen the shell; contain any
 * render throw to the panel, mirroring DaemonStatusDialog.
 */
export function SessionOverviewPanel({
  onOpenSession,
  onOpenSplit,
}: {
  onOpenSession: (sessionId: string) => void;
  onOpenSplit?: (sessionIds: string[]) => void;
}) {
  const { t } = useI18n();
  return (
    <ErrorBoundary
      label="session-overview"
      fallback={(fallbackError) => (
        <div className={styles.panel}>
          <div className={styles.empty}>
            {t('sessionsOverview.loadFailed')}: {fallbackError.message}
          </div>
        </div>
      )}
    >
      <SessionOverviewPanelInner
        onOpenSession={onOpenSession}
        onOpenSplit={onOpenSplit}
      />
    </ErrorBoundary>
  );
}
