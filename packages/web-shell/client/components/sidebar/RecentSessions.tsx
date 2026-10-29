import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { ChevronDownIcon, ChevronRightIcon, SquarePenIcon } from 'lucide-react';
import type {
  DaemonClient,
  DaemonSessionListPage,
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { SIDEBAR_SESSION_PREVIEW_LIMIT } from '../../constants/sessions';
import {
  readWorkspaceExpanded,
  writeWorkspaceExpanded,
} from './workspaceExpansion';
import styles from './WebShellSidebar.module.css';

const LIMIT = 20;

export interface RecentSessionEntry {
  session: DaemonSessionSummary;
  workspaceCwd?: string;
}

export function sortRecentSessions(entries: RecentSessionEntry[]) {
  const unique = new Map<string, RecentSessionEntry>();
  for (const entry of entries) {
    const { session } = entry;
    if (
      session.parentSessionId ||
      session.isArchived ||
      session.isPinned ||
      session.sourceType === 'qwen-live' ||
      session.sourceId?.startsWith('realtime_voice:') ||
      (session.sourceType &&
        !['default', 'standalone'].includes(session.sourceType))
    )
      continue;
    unique.set(JSON.stringify([entry.workspaceCwd, session.sessionId]), entry);
  }
  const activity = (session: DaemonSessionSummary) =>
    Math.max(
      Date.parse(session.updatedAt ?? '') || 0,
      Date.parse(session.createdAt ?? '') || 0,
    );
  return [...unique.values()]
    .sort(
      (a, b) =>
        activity(b.session) - activity(a.session) ||
        JSON.stringify([a.workspaceCwd, a.session.sessionId]).localeCompare(
          JSON.stringify([b.workspaceCwd, b.session.sessionId]),
        ),
    )
    .slice(0, LIMIT);
}

async function readRecentPage(
  load: (cursor?: string) => Promise<DaemonSessionListPage>,
  workspaceCwd?: string,
): Promise<RecentSessionEntry[]> {
  let cursor: string | undefined;
  const entries: RecentSessionEntry[] = [];
  do {
    const page = await load(cursor);
    entries.push(
      ...page.sessions.map((session) => ({ session, workspaceCwd })),
    );
    cursor = page.nextCursor;
  } while (cursor && sortRecentSessions(entries).length < LIMIT);
  return sortRecentSessions(entries);
}

interface RecentSessionsProps {
  client: DaemonClient;
  workspaces: DaemonWorkspaceCapability[];
  includeStandalone: boolean;
  sourceMetadataEnabled: boolean;
  organizationEnabled: boolean;
  currentSessionId?: string;
  refreshKey: number;
  refreshPaused?: boolean;
  onNewSession: () => void;
  newSessionDisabled: boolean;
  renderSession: (entry: RecentSessionEntry) => ReactNode;
  onVisibleRowsChange?: (keys: string) => void;
}

export function RecentSessions({
  client,
  workspaces,
  includeStandalone,
  sourceMetadataEnabled,
  organizationEnabled,
  currentSessionId,
  refreshKey,
  refreshPaused = false,
  renderSession,
  onVisibleRowsChange,
  onNewSession,
  newSessionDisabled,
}: RecentSessionsProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(() =>
    readWorkspaceExpanded('recent-sessions'),
  );
  const [showAll, setShowAll] = useState(false);
  const [entries, setEntries] = useState<RecentSessionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const workspaceKey = JSON.stringify(
    workspaces.filter((ws) => ws.trusted).map((ws) => ws.cwd),
  );

  useEffect(() => {
    setEntries([]);
    setLoading(true);
  }, [
    client,
    workspaceKey,
    includeStandalone,
    sourceMetadataEnabled,
    organizationEnabled,
  ]);

  useEffect(() => {
    if (!expanded || refreshPaused) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const cwds: string[] = JSON.parse(workspaceKey);
      const requests = cwds.map((cwd) =>
        readRecentPage(
          (cursor) =>
            client.listWorkspaceSessionsPage(cwd, {
              archiveState: 'active',
              ...(organizationEnabled
                ? { view: 'organized' as const, group: 'all' }
                : {}),
              pageSize: 50,
              cursor,
              ...(sourceMetadataEnabled ? { sourceType: 'default' } : {}),
            }),
          cwd,
        ),
      );
      if (includeStandalone)
        requests.push(
          readRecentPage((cursor) =>
            client.listStandaloneSessionsPage({
              archiveState: 'active',
              pageSize: 50,
              cursor,
            }),
          ),
        );
      const results = await Promise.allSettled(requests);
      if (disposed) return;
      setEntries(
        sortRecentSessions(
          results.flatMap((result) =>
            result.status === 'fulfilled' ? result.value : [],
          ),
        ),
      );
      setFailed(results.some((result) => result.status === 'rejected'));
      setLoading(false);
      timer = setTimeout(() => {
        void load();
      }, 10_000);
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [
    client,
    workspaceKey,
    includeStandalone,
    sourceMetadataEnabled,
    organizationEnabled,
    expanded,
    refreshPaused,
    currentSessionId,
    refreshKey,
    retry,
  ]);

  const rows = expanded
    ? entries
        .slice(0, showAll ? LIMIT : SIDEBAR_SESSION_PREVIEW_LIMIT)
        .map((entry) => ({
          key: JSON.stringify([entry.workspaceCwd, entry.session.sessionId]),
          node: renderSession(entry),
        }))
        .filter((row) => row.node !== null)
    : [];
  const visibleKeys = JSON.stringify(rows.map((row) => row.key));
  useEffect(() => {
    onVisibleRowsChange?.(visibleKeys);
  }, [onVisibleRowsChange, visibleKeys]);
  useEffect(() => () => onVisibleRowsChange?.('[]'), [onVisibleRowsChange]);

  return (
    <section
      aria-label={t('sidebar.recentSessions')}
      data-testid="recent-sessions"
    >
      <div className={styles.projectsHeader}>
        <button
          className={styles.projectsHeaderToggle}
          type="button"
          aria-expanded={expanded}
          onClick={() =>
            setExpanded((value) => {
              writeWorkspaceExpanded('recent-sessions', !value);
              return !value;
            })
          }
        >
          <span>{t('sidebar.recentSessions')}</span>
          {expanded ? (
            <ChevronDownIcon size={14} />
          ) : (
            <ChevronRightIcon size={14} />
          )}
        </button>
        <div className={styles.projectsHeaderActions}>
          <button
            type="button"
            className={styles.workspaceHeaderAction}
            title={t('sidebar.newTask')}
            aria-label={t('sidebar.newTask')}
            disabled={newSessionDisabled}
            onClick={() => {
              setExpanded(true);
              writeWorkspaceExpanded('recent-sessions', true);
              onNewSession();
            }}
          >
            <SquarePenIcon size={16} strokeWidth={1.2} />
          </button>
        </div>
      </div>
      {expanded && (
        <div className={styles.pinnedSessionList}>
          {failed && (
            <button
              className={styles.retry}
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              {t('sidebar.loadFailed')}
            </button>
          )}
          {loading && (
            <div
              className="px-3 py-1 text-xs text-muted-foreground"
              role="status"
            >
              {t('common.loading')}
            </div>
          )}
          {!loading && !failed && entries.length === 0 && (
            <div className="px-3 py-1 text-xs text-muted-foreground">
              {t('sidebar.noSessions')}
            </div>
          )}
          {rows.map((row) => (
            <Fragment key={row.key}>{row.node}</Fragment>
          ))}
          {!showAll && entries.length > SIDEBAR_SESSION_PREVIEW_LIMIT && (
            <button
              type="button"
              className={styles.showAllSessions}
              onClick={() => setShowAll(true)}
            >
              {t('sidebar.showAllSessions')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
