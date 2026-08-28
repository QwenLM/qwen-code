import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useSessions, useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import type {
  DaemonClient,
  DaemonSessionArchiveState,
  DaemonSessionListPageOptions,
  DaemonSessionSummary,
} from '@qwen-code/sdk/daemon';
import {
  getSessionCatalogQueryKey,
  getSessionCatalogStore,
  type SessionCatalogQuery,
  type SessionCatalogSnapshot,
} from './session-catalog-store';

const EMPTY_SNAPSHOTS: readonly SessionCatalogSnapshot[] = [];
const EMPTY_QUERIES: readonly SessionCatalogQuery[] = [];

interface SessionCatalogHookOptions {
  autoLoad?: boolean;
  enabled?: boolean;
  maxAgeMs?: number;
  pollIntervalMs?: number;
}

export interface WebShellSessionsOptions extends SessionCatalogHookOptions {
  pageSize?: number;
  cursor?: string;
  archiveState?: DaemonSessionArchiveState;
  view?: 'organized';
  group?: string;
  sourceType?: string;
  sourceId?: string;
  parentSessionId?: string;
}

export function useSessionCatalogQuery(
  client: DaemonClient,
  query: SessionCatalogQuery | undefined,
  options: SessionCatalogHookOptions = {},
) {
  const {
    autoLoad = false,
    enabled = true,
    maxAgeMs,
    pollIntervalMs,
  } = options;
  const store = useMemo(() => getSessionCatalogStore(client), [client]);
  const queryKey = query ? getSessionCatalogQueryKey(query) : undefined;
  const stableQueryRef = useRef<{
    key?: string;
    query?: SessionCatalogQuery;
  }>({});
  if (stableQueryRef.current.key !== queryKey) {
    stableQueryRef.current = { key: queryKey, query };
  }
  const stableQuery = stableQueryRef.current.query;

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!enabled || !stableQuery) return () => undefined;
      return store.subscribe(stableQuery, listener, {
        autoLoad,
        ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
        ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
      });
    },
    [autoLoad, enabled, maxAgeMs, pollIntervalMs, stableQuery, store],
  );
  const getSnapshot = useCallback(
    () =>
      enabled && stableQuery
        ? store.getSnapshot(stableQuery)
        : store.getEmptySnapshot(),
    [enabled, stableQuery, store],
  );
  const getServerSnapshot = useCallback(
    () => store.getEmptySnapshot(),
    [store],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const reload = useCallback(
    (options: { interactive?: boolean } = {}) => {
      if (!enabled || !stableQuery) return Promise.resolve(undefined);
      return store.refresh(stableQuery, options);
    },
    [enabled, stableQuery, store],
  );

  return {
    ...snapshot,
    sessions: snapshot.page?.sessions ?? [],
    nextCursor: snapshot.page?.nextCursor,
    liveMergeFailed: snapshot.page?.liveMergeFailed === true,
    truncated: snapshot.page?.truncated === true,
    reload,
  };
}

export function useSessionCatalogQueries(
  client: DaemonClient,
  queries: readonly SessionCatalogQuery[],
  options: SessionCatalogHookOptions = {},
): readonly SessionCatalogSnapshot[] {
  const {
    autoLoad = false,
    enabled = true,
    maxAgeMs,
    pollIntervalMs,
  } = options;
  const store = useMemo(() => getSessionCatalogStore(client), [client]);
  const queriesKey = queries.map(getSessionCatalogQueryKey).join('\n');
  const stableQueriesRef = useRef<{
    key?: string;
    queries: readonly SessionCatalogQuery[];
  }>({ queries: EMPTY_QUERIES });
  if (stableQueriesRef.current.key !== queriesKey) {
    stableQueriesRef.current = { key: queriesKey, queries: [...queries] };
  }
  const stableQueries = stableQueriesRef.current.queries;
  const cachedSnapshots = useRef<readonly SessionCatalogSnapshot[]>([]);

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!enabled) return () => undefined;
      const unsubscribes = stableQueries.map((query) =>
        store.subscribe(query, listener, {
          autoLoad,
          ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
          ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
        }),
      );
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    [autoLoad, enabled, maxAgeMs, pollIntervalMs, stableQueries, store],
  );
  const getSnapshot = useCallback(() => {
    if (!enabled || stableQueries.length === 0) {
      cachedSnapshots.current = EMPTY_SNAPSHOTS;
      return cachedSnapshots.current;
    }
    const next = stableQueries.map((query) => store.getSnapshot(query));
    const current = cachedSnapshots.current;
    if (
      current.length === next.length &&
      current.every((snapshot, index) => snapshot === next[index])
    ) {
      return current;
    }
    cachedSnapshots.current = next;
    return next;
  }, [enabled, stableQueries, store]);

  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOTS);
}

export function useSessionHasActivePrompt(
  client: DaemonClient,
  workspaceCwd: string | undefined,
  sessionId: string | undefined,
): boolean {
  const store = useMemo(() => getSessionCatalogStore(client), [client]);
  const subscribeLiveSessions = useCallback(
    (listener: () => void) =>
      workspaceCwd
        ? store.subscribeLiveSessions(workspaceCwd, listener)
        : () => undefined,
    [store, workspaceCwd],
  );
  const hasLiveSessions = useSyncExternalStore(
    subscribeLiveSessions,
    () => (workspaceCwd ? store.hasLiveSessions(workspaceCwd) : false),
    () => false,
  );
  // The live-state response is authoritative and independent of catalog
  // paging. Arm the full-catalog fallback only when nothing tracks live-state
  // for this workspace — i.e. the daemon lacks workspace_session_live_state.
  // Evaluating in an effect (after mount) lets the sidebar's live-state
  // retain win first; deciding at render time would fire one redundant
  // full-catalog fetch on every page load before the first live-state
  // response arrives, breaking the "no catalog polling" smoke contract.
  const [catalogFallbackArmed, setCatalogFallbackArmed] = useState(false);
  useEffect(() => {
    setCatalogFallbackArmed(
      Boolean(
        workspaceCwd &&
          !hasLiveSessions &&
          !store.isWorkspaceLiveStateEnabled(workspaceCwd),
      ),
    );
  }, [store, workspaceCwd, hasLiveSessions]);
  const catalogQuery = useMemo<SessionCatalogQuery | undefined>(() => {
    if (!catalogFallbackArmed || hasLiveSessions || !workspaceCwd) {
      return undefined;
    }
    return { routeKind: 'qualified', workspaceCwd, options: {} };
  }, [catalogFallbackArmed, hasLiveSessions, workspaceCwd]);
  // autoLoad keeps the fallback page loading (and the store's error-retry
  // timer armed) for observer panes that never trigger an invalidation.
  const { sessions } = useSessionCatalogQuery(client, catalogQuery, {
    autoLoad: true,
  });
  if (!workspaceCwd || !sessionId) return false;
  if (hasLiveSessions) {
    return (
      store.getLiveSession(workspaceCwd, sessionId)?.hasActivePrompt === true
    );
  }
  return sessions.some(
    (session) => session.sessionId === sessionId && session.hasActivePrompt,
  );
}

export function useSessionCatalogPolling(
  client: DaemonClient,
  query: SessionCatalogQuery | undefined,
  pollIntervalMs: number | undefined,
): void {
  useSessionCatalogQuery(client, query, {
    enabled: pollIntervalMs !== undefined,
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
  });
}

export function useSessionCatalogController(client: DaemonClient) {
  const store = useMemo(() => getSessionCatalogStore(client), [client]);
  return useMemo(() => {
    const update = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        console.warn('[session-catalog] failed to update catalog:', error);
      }
    };
    return {
      refreshQueries(queries: readonly SessionCatalogQuery[]) {
        for (const query of queries) {
          void store.loadOnce(query, { fresh: true }).catch((error) => {
            console.warn('[session-catalog] failed to refresh catalog:', error);
          });
        }
      },
      invalidateWorkspace(workspaceCwd: string) {
        update(() => store.invalidateWorkspace(workspaceCwd));
      },
      refreshWorkspace(workspaceCwd: string) {
        update(() =>
          store.invalidateWorkspace(workspaceCwd, { interactive: true }),
        );
      },
      sessionCreated(workspaceCwd: string, _sessionId: string) {
        update(() => {
          store.invalidateWorkspace(workspaceCwd);
          if (store.isWorkspaceLiveStateEnabled(workspaceCwd)) return;
          store.scheduleWorkspaceRefresh(workspaceCwd);
        });
      },
      promptAdmitted(workspaceCwd: string, sessionId: string) {
        update(() => {
          store.patchSession(workspaceCwd, sessionId, {
            hasActivePrompt: true,
          });
          if (store.isWorkspaceLiveStateEnabled(workspaceCwd)) return;
          store.invalidateWorkspace(workspaceCwd);
          store.scheduleWorkspaceRefresh(workspaceCwd);
        });
      },
      promptAdmissionUncertain(workspaceCwd: string) {
        update(() => {
          store.invalidateWorkspace(workspaceCwd);
          if (store.isWorkspaceLiveStateEnabled(workspaceCwd)) return;
          store.scheduleWorkspaceRefresh(workspaceCwd);
        });
      },
      renamed(workspaceCwd: string, sessionId: string, displayName: string) {
        update(() => {
          store.patchSession(workspaceCwd, sessionId, { displayName });
          store.invalidateWorkspace(workspaceCwd);
        });
      },
      toggleSessionPinned(
        workspaceCwd: string,
        session: DaemonSessionSummary,
        toggle: { pinned: boolean; pinnedAt?: string },
      ) {
        update(() =>
          store.applySessionPinToggle(workspaceCwd, session, toggle),
        );
      },
      turnCompleted(workspaceCwd: string, sessionId: string) {
        update(() => {
          if (store.isWorkspaceLiveStateEnabled(workspaceCwd)) {
            // The catalog revision doesn't advance on turn completion; record
            // the completion so the live-state loop can settle it from the
            // response's updatedAt watermark instead of a full catalog scan.
            store.recordSessionActivity(workspaceCwd, sessionId);
            return;
          }
          // Mirror promptAdmitted's optimistic patch: a failed clearing
          // refresh must not pin hasActivePrompt true forever (#9487).
          store.patchSession(workspaceCwd, sessionId, {
            hasActivePrompt: false,
          });
          store.invalidateWorkspace(workspaceCwd);
          store.scheduleWorkspaceRefresh(workspaceCwd);
        });
      },
    };
  }, [store]);
}

export function useWebShellSessions(options: WebShellSessionsOptions = {}) {
  const {
    autoLoad = false,
    enabled = true,
    maxAgeMs,
    pollIntervalMs,
    pageSize,
    cursor,
    archiveState,
    view,
    group,
    sourceType,
    sourceId,
    parentSessionId,
  } = options;
  const workspace = useWorkspace();
  const legacy = useSessions({
    autoLoad: false,
    enabled: false,
    pageSize,
    cursor,
    archiveState,
    view,
    group,
    sourceType,
  });
  const legacyReleaseSession = legacy.releaseSession;
  const controller = useSessionCatalogController(workspace.client);
  const workspaceCwd = workspace.workspaceCwd;
  const listOptions = useMemo<DaemonSessionListPageOptions>(
    () => ({
      ...(pageSize !== undefined ? { pageSize } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(archiveState !== undefined ? { archiveState } : {}),
      ...(view !== undefined ? { view } : {}),
      ...(group !== undefined ? { group } : {}),
      ...(sourceType !== undefined ? { sourceType } : {}),
      ...(sourceId !== undefined ? { sourceId } : {}),
      ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    }),
    [
      archiveState,
      cursor,
      group,
      pageSize,
      parentSessionId,
      sourceId,
      sourceType,
      view,
    ],
  );
  const query = useMemo<SessionCatalogQuery | undefined>(
    () =>
      workspaceCwd
        ? {
            routeKind: 'legacy',
            workspaceCwd,
            options: listOptions,
          }
        : undefined,
    [listOptions, workspaceCwd],
  );
  const result = useSessionCatalogQuery(workspace.client, query, {
    autoLoad,
    enabled: enabled && Boolean(workspaceCwd),
    ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
  });
  const reloadPage = result.reload;
  const reload = useCallback(
    async (reloadOptions: { interactive?: boolean } = {}) => {
      try {
        return (await reloadPage(reloadOptions))?.sessions;
      } catch {
        return undefined;
      }
    },
    [reloadPage],
  );
  const invalidate = useCallback(() => {
    if (workspaceCwd) controller.refreshWorkspace(workspaceCwd);
  }, [controller, workspaceCwd]);
  const deleteSession = useCallback(
    async (sessionId: string) => {
      try {
        return await workspace.actions.deleteSession(sessionId);
      } finally {
        invalidate();
      }
    },
    [invalidate, workspace.actions],
  );
  const deleteSessions = useCallback(
    async (sessionIds: string[]) => {
      try {
        return await workspace.actions.deleteSessions(sessionIds);
      } finally {
        invalidate();
      }
    },
    [invalidate, workspace.actions],
  );
  const archiveSession = useCallback(
    async (sessionId: string) => {
      try {
        return await workspace.actions.archiveSession(sessionId);
      } finally {
        invalidate();
      }
    },
    [invalidate, workspace.actions],
  );
  const unarchiveSession = useCallback(
    async (sessionId: string) => {
      try {
        return await workspace.actions.unarchiveSession(sessionId);
      } finally {
        invalidate();
      }
    },
    [invalidate, workspace.actions],
  );
  const releaseSession = useCallback(
    async (sessionId: string) => {
      try {
        if (!legacyReleaseSession) return;
        return await legacyReleaseSession(sessionId);
      } finally {
        invalidate();
      }
    },
    [invalidate, legacyReleaseSession],
  );
  const page = result.page;
  return {
    data: page ? page.sessions : undefined,
    sessions: result.sessions,
    loading: result.loading,
    error: result.error,
    reload,
    nextCursor: page?.nextCursor,
    liveMergeFailed: page?.liveMergeFailed === true,
    truncated: page?.truncated === true,
    loadSession: legacy.loadSession,
    resumeSession: legacy.resumeSession,
    newSession: legacy.newSession,
    releaseSession: legacyReleaseSession ? releaseSession : undefined,
    releaseSessionAction: legacyReleaseSession,
    deleteSession,
    deleteSessions,
    exportSession: legacy.exportSession,
    archiveSession,
    unarchiveSession,
    catalogQuery: query,
  };
}
