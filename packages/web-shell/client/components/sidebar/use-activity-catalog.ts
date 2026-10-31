import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonClient, DaemonEvent } from '@qwen-code/sdk/daemon';
import { useSessionCatalogQueries } from '../../session-catalog/session-catalog-hooks';
import {
  getSessionCatalogStore,
  type SessionCatalogQuery,
} from '../../session-catalog/session-catalog-store';
import type { ActivityEntry } from './activity-model';

const EMPTY_QUERIES: SessionCatalogQuery[] = [];

export function activityKey(workspaceCwd: string, sessionId: string): string {
  return JSON.stringify([workspaceCwd, sessionId]);
}

export function activityPreview(
  events: readonly DaemonEvent[],
): string | undefined {
  let text = '';
  let interrupted = false;
  for (const event of events) {
    if (
      event.type !== 'session_update' ||
      !event.data ||
      typeof event.data !== 'object'
    )
      continue;
    const update = (event.data as { update?: unknown }).update;
    if (!update || typeof update !== 'object') continue;
    const value = update as {
      sessionUpdate?: string;
      content?: { type?: string; text?: string };
    };
    if (
      value.sessionUpdate === 'user_message_chunk' ||
      value.sessionUpdate === 'tool_call'
    ) {
      interrupted = true;
    }
    if (
      value.sessionUpdate !== 'agent_message_chunk' ||
      value.content?.type !== 'text' ||
      typeof value.content.text !== 'string'
    )
      continue;
    if (interrupted) text = '';
    interrupted = false;
    text += value.content.text;
  }
  return [...text.trim()].slice(0, 600).join('') || undefined;
}

export async function activityBatch<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let offset = 0; offset < items.length; offset += 8) {
    results.push(
      ...(await Promise.allSettled(items.slice(offset, offset + 8).map(run))),
    );
  }
  return results;
}

interface ActivityCatalogOptions {
  client: DaemonClient;
  workspaceCwds: readonly string[];
  enabled: boolean;
  open: boolean;
  liveStateEnabled: boolean;
  currentKey?: string;
  onArchivedCurrent: (entry: ActivityEntry) => void;
}

export function useActivityCatalog({
  client,
  workspaceCwds,
  enabled,
  open,
  liveStateEnabled,
  currentKey,
  onArchivedCurrent,
}: ActivityCatalogOptions) {
  const store = useMemo(() => getSessionCatalogStore(client), [client]);
  const scope = JSON.stringify([...workspaceCwds].sort());
  const owner = useMemo(() => ({ client, scope }), [client, scope]);
  const latest = useRef({ owner, currentKey, onArchivedCurrent });
  latest.current = { owner, currentKey, onArchivedCurrent };
  const initialQueries = useMemo<SessionCatalogQuery[]>(
    () =>
      (JSON.parse(scope) as string[]).map((workspaceCwd) => ({
        routeKind: 'qualified',
        workspaceCwd,
        options: {
          archiveState: 'active',
          view: 'organized',
          group: 'all',
          pageSize: 100,
        },
      })),
    [scope],
  );
  const [pages, setPages] = useState<{
    client: DaemonClient;
    scope: string;
    queries: SessionCatalogQuery[];
  }>({ client, scope, queries: [] });
  const extraQueries =
    pages.client === client && pages.scope === scope
      ? pages.queries
      : EMPTY_QUERIES;
  const queries = useMemo(
    () => [...initialQueries, ...extraQueries],
    [initialQueries, extraQueries],
  );
  const snapshots = useSessionCatalogQueries(client, queries, {
    enabled,
    autoLoad: enabled,
    ...(!liveStateEnabled && enabled ? { pollIntervalMs: 30_000 } : {}),
  });
  useEffect(() => {
    const reachable: SessionCatalogQuery[] = [];
    if (enabled && open) {
      for (const root of initialQueries) {
        let query = root;
        const visited = new Set<string>();
        for (;;) {
          const index = queries.findIndex(
            (candidate) =>
              candidate.workspaceCwd === query.workspaceCwd &&
              candidate.options.cursor === query.options.cursor,
          );
          const snapshot = snapshots[index];
          const cursor = snapshot?.page?.nextCursor;
          if (!cursor || snapshot.error || visited.has(cursor)) break;
          visited.add(cursor);
          query = { ...root, options: { ...root.options, cursor } };
          reachable.push(query);
        }
      }
    }
    if (JSON.stringify(reachable) !== JSON.stringify(extraQueries))
      setPages({ client, scope, queries: reachable });
  }, [
    client,
    enabled,
    extraQueries,
    initialQueries,
    open,
    queries,
    scope,
    snapshots,
  ]);

  const entries = useMemo(() => {
    const byKey = new Map<string, ActivityEntry>();
    if (!enabled) return [];
    snapshots.forEach((snapshot, index) => {
      const cwd = queries[index]?.workspaceCwd;
      if (!cwd) return;
      for (const session of snapshot.page?.sessions ?? []) {
        if (session.workspaceCwd !== cwd || session.isArchived) continue;
        const key = activityKey(cwd, session.sessionId);
        const previous = byKey.get(key);
        if (
          previous &&
          Date.parse(previous.session.updatedAt ?? '') >
            Date.parse(session.updatedAt ?? '')
        )
          continue;
        byKey.set(key, {
          key,
          session,
        });
      }
    });
    return [...byKey.values()];
  }, [enabled, queries, snapshots]);

  const mutateArchive = useCallback(
    async (items: ActivityEntry[], undo: boolean) => {
      const attachedKey = latest.current.currentKey;
      const results = await activityBatch(items, async (entry) => {
        const api = client.workspaceByCwd(entry.session.workspaceCwd);
        const result = undo
          ? await api.unarchiveSessionsData([entry.session.sessionId])
          : await api.archiveSessionsData([entry.session.sessionId]);
        const succeeded =
          'archived' in result
            ? [...result.archived, ...result.alreadyArchived]
            : [...result.unarchived, ...result.alreadyActive];
        if (!succeeded.includes(entry.session.sessionId))
          throw new Error('Session archive operation failed.');
        store.patchSession(
          entry.session.workspaceCwd,
          entry.session.sessionId,
          { isArchived: !undo },
        );
        store.invalidateWorkspace(entry.session.workspaceCwd);
        if (
          !undo &&
          latest.current.owner === owner &&
          entry.key === attachedKey &&
          (latest.current.currentKey === attachedKey ||
            latest.current.currentKey === undefined)
        )
          latest.current.onArchivedCurrent(entry);
        return entry;
      });
      return {
        succeeded: results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        ),
        failed: results.filter((result) => result.status === 'rejected').length,
      };
    },
    [client, owner, store],
  );
  const archive = useCallback(
    (items: ActivityEntry[]) => mutateArchive(items, false),
    [mutateArchive],
  );
  const undo = useCallback(
    (items: ActivityEntry[]) => mutateArchive(items, true),
    [mutateArchive],
  );
  const previewQueue = useMemo(
    () => ({ active: 0, waiting: [] as Array<() => void> }),
    [],
  );
  const loadPreview = useCallback(
    async (entry: ActivityEntry) => {
      if (previewQueue.active >= 8)
        await new Promise<void>((resolve) =>
          previewQueue.waiting.push(resolve),
        );
      else previewQueue.active++;
      try {
        const page = await client
          .workspaceByCwd(entry.session.workspaceCwd)
          .getSessionTranscriptPage(entry.session.sessionId, {
            direction: 'backward',
            limit: 5,
          });
        if (page.partial || page.replayError)
          throw new Error('Session preview is temporarily unavailable.');
        return activityPreview(page.events);
      } finally {
        const next = previewQueue.waiting.shift();
        if (next) next();
        else previewQueue.active--;
      }
    },
    [client, previewQueue],
  );
  const retry = useCallback(() => {
    setPages({ client, scope, queries: [] });
    for (const query of initialQueries)
      void store.refresh(query, { interactive: true }).catch(() => undefined);
  }, [client, initialQueries, scope, store]);
  const loading =
    enabled && snapshots.some((snapshot) => !snapshot.page && !snapshot.error);
  const unavailable = snapshots.some(
    (snapshot) =>
      Boolean(snapshot.error) ||
      snapshot.page?.truncated ||
      snapshot.page?.liveMergeFailed,
  );
  const hasMore = snapshots.some(
    (snapshot, index) =>
      snapshot.page?.nextCursor &&
      !queries.some(
        (query) =>
          query.workspaceCwd === queries[index]?.workspaceCwd &&
          query.options.cursor === snapshot.page?.nextCursor,
      ),
  );
  return {
    entries,
    loading,
    unavailable,
    hasMore,
    archive,
    undo,
    loadPreview,
    retry,
  };
}
