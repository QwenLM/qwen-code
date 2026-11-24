import {
  Fragment,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { ChevronDownIcon, ChevronRightIcon, SquarePenIcon } from 'lucide-react';
import type {
  DaemonClient,
  DaemonSessionListPage,
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import {
  SIDEBAR_SESSION_EXPAND_STEP,
  SIDEBAR_SESSION_PREVIEW_LIMIT,
} from '../../constants/sessions';
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

export function sortRecentSessions(
  entries: RecentSessionEntry[],
  sortBy?: 'updatedAt' | 'lastUserPromptAt',
) {
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
    sortBy === 'lastUserPromptAt'
      ? Number.isFinite(Date.parse(session.lastUserPromptAt ?? ''))
        ? Date.parse(session.lastUserPromptAt!)
        : Number.MIN_SAFE_INTEGER
      : Math.max(
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
  sortBy?: 'updatedAt' | 'lastUserPromptAt',
): Promise<RecentSessionEntry[]> {
  let cursor: string | undefined;
  const entries: RecentSessionEntry[] = [];
  do {
    const page = await load(cursor);
    entries.push(
      ...page.sessions.map((session) => ({ session, workspaceCwd })),
    );
    cursor = page.nextCursor;
  } while (cursor && sortRecentSessions(entries, sortBy).length < LIMIT);
  return sortRecentSessions(entries, sortBy);
}

type ArchiveChange = (
  workspaceCwd: string,
  session?: DaemonSessionSummary,
) => void;

interface RecentSessionsProps {
  sortBy?: 'updatedAt' | 'lastUserPromptAt';
  client: DaemonClient;
  workspaces: DaemonWorkspaceCapability[];
  includeStandalone: boolean;
  sourceMetadataEnabled: boolean;
  organizationEnabled: boolean;
  currentSessionId?: string;
  refreshKey: number;
  archiveChangeRef?: Ref<ArchiveChange>;
  refreshPaused?: boolean;
  onNewSession: () => void;
  newSessionDisabled: boolean;
  renderSession: (entry: RecentSessionEntry) => ReactNode;
  onVisibleRowsChange?: (keys: string) => void;
}

export function RecentSessions({
  sortBy,
  client,
  workspaces,
  includeStandalone,
  sourceMetadataEnabled,
  organizationEnabled,
  currentSessionId,
  refreshKey,
  archiveChangeRef,
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
  const [visibleCount, setVisibleCount] = useState(
    SIDEBAR_SESSION_PREVIEW_LIMIT,
  );
  const [catalogs, setCatalogs] = useState(
    () =>
      new Map<
        string | undefined,
        { entries: RecentSessionEntry[]; failed: boolean }
      >(),
  );
  const [loading, setLoading] = useState(true);
  const refreshWorkspace = useRef<((workspaceCwd: string) => void) | null>(
    null,
  );
  const [retry, setRetry] = useState(0);
  const workspaceKey = JSON.stringify(
    workspaces.filter((ws) => ws.trusted).map((ws) => ws.cwd),
  );

  useEffect(() => {
    setCatalogs(new Map());
    setLoading(true);
    setVisibleCount(SIDEBAR_SESSION_PREVIEW_LIMIT);
  }, [
    client,
    workspaceKey,
    includeStandalone,
    sourceMetadataEnabled,
    organizationEnabled,
    sortBy,
  ]);

  useEffect(() => {
    if (!expanded) setVisibleCount(SIDEBAR_SESSION_PREVIEW_LIMIT);
  }, [expanded]);

  useEffect(() => {
    if (!expanded || refreshPaused) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const cwds: Array<string | undefined> = JSON.parse(workspaceKey);
    if (includeStandalone) cwds.push(undefined);
    const requests = new Map<string | undefined, symbol>();

    const loadScope = async (workspaceCwd: string | undefined) => {
      const request = Symbol();
      requests.set(workspaceCwd, request);
      const options = {
        archiveState: 'active',
        ...(sortBy !== undefined ? { sortBy } : {}),
        pageSize: 50,
      } as const;
      const entries = await readRecentPage(
        (cursor) =>
          workspaceCwd === undefined
            ? client.listStandaloneSessionsPage({ ...options, cursor })
            : client.listWorkspaceSessionsPage(workspaceCwd, {
                ...options,
                ...(organizationEnabled
                  ? { view: 'organized', group: 'all' }
                  : {}),
                cursor,
                ...(sourceMetadataEnabled ? { sourceType: 'default' } : {}),
              }),
        workspaceCwd,
        sortBy,
      ).catch(() => undefined);
      if (disposed || requests.get(workspaceCwd) !== request) return;
      setCatalogs((current) =>
        new Map(current).set(workspaceCwd, {
          entries: entries ?? current.get(workspaceCwd)?.entries ?? [],
          failed: entries === undefined,
        }),
      );
    };

    refreshWorkspace.current = (workspaceCwd) => {
      if (cwds.includes(workspaceCwd)) void loadScope(workspaceCwd);
    };
    const load = async () => {
      await Promise.all(cwds.map(loadScope));
      if (disposed) return;
      setLoading(false);
      timer = setTimeout(() => {
        void load();
      }, 10_000);
    };
    void load();
    return () => {
      disposed = true;
      refreshWorkspace.current = null;
      clearTimeout(timer);
    };
  }, [
    client,
    workspaceKey,
    includeStandalone,
    sourceMetadataEnabled,
    organizationEnabled,
    sortBy,
    expanded,
    refreshPaused,
    currentSessionId,
    refreshKey,
    retry,
  ]);

  useImperativeHandle(
    archiveChangeRef,
    () => (workspaceCwd, session) => {
      if (session) {
        setCatalogs((current) => {
          const catalog = current.get(workspaceCwd);
          if (!catalog) return current;
          const entries = catalog.entries.filter(
            (entry) => entry.session.sessionId !== session.sessionId,
          );
          if (!session.isArchived) entries.push({ session, workspaceCwd });
          return new Map(current).set(workspaceCwd, {
            ...catalog,
            entries: sortRecentSessions(entries, sortBy),
          });
        });
      }
      refreshWorkspace.current?.(workspaceCwd);
    },
    [sortBy],
  );

  const entries = useMemo(
    () =>
      sortRecentSessions(
        [...catalogs.values()].flatMap(({ entries }) => entries),
        sortBy,
      ),
    [catalogs, sortBy],
  );
  const failed = [...catalogs.values()].some((catalog) => catalog.failed);
  const workspaceCwds = new Set(JSON.parse(workspaceKey) as string[]);
  const scopedEntries = entries.filter((entry) =>
    entry.workspaceCwd === undefined
      ? includeStandalone
      : workspaceCwds.has(entry.workspaceCwd),
  );
  // Count renderable rows, not raw entries: renderSession returns null for
  // entries this list does not draw (e.g. an optimistically pinned session),
  // and the expand label must promise only rows the click actually reveals.
  const renderableRows = expanded
    ? scopedEntries
        .map((entry) => ({
          key: JSON.stringify([entry.workspaceCwd, entry.session.sessionId]),
          node: renderSession(entry),
        }))
        .filter((row) => row.node !== null)
    : [];
  const rows = renderableRows.slice(0, visibleCount);
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
          {renderableRows.length > visibleCount && (
            <button
              type="button"
              className={styles.showAllSessions}
              onClick={() =>
                setVisibleCount((count) => count + SIDEBAR_SESSION_EXPAND_STEP)
              }
            >
              {t('sidebar.showMoreSessions', {
                count: Math.min(
                  SIDEBAR_SESSION_EXPAND_STEP,
                  renderableRows.length - visibleCount,
                ),
              })}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
