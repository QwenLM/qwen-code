/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import {
  SESSION_LIST_PAGE_SIZE,
  WEB_SHELL_SESSION_SOURCE_TYPE,
} from '../constants/sessions';
import { useSessionCatalogQueries } from '../session-catalog/session-catalog-hooks';
import {
  getSessionCatalogStore,
  type SessionCatalogQuery,
} from '../session-catalog/session-catalog-store';

export interface OtherWorkspaceSessionsResult {
  sessions: DaemonSessionSummary[];
  /**
   * True only while a non-primary workspace list is still in flight. A first
   * fetch that failed is settled, not loading — it is reported per-cwd by
   * `notReadyCwds` instead, so a persistently-failing workspace can't pin
   * this forever. Consumers that compare the merged list against live state
   * (for example, pruning panes) must wait for this to be false so a
   * still-loading workspace can't look like a vanished session.
   */
  loading: boolean;
  /**
   * The workspaces the fan-out is actually querying (the daemon's listed
   * non-primary trusted workspaces). Empty while the hook is disabled or the
   * daemon lists none. Consumers that prune panes must reason over this set
   * (plus their own primary page) and never over workspaces the daemon no
   * longer advertises: a pane whose workspace is not here is outside the
   * catalog's coverage, and its absence from the merged list proves nothing.
   */
  queriedCwds: string[];
  /**
   * The subset of `queriedCwds` where absence can't currently be proven: the
   * page never landed (an errored fetch, a deferred load in a hidden tab),
   * it settled with an error (even while the store still serves a retained
   * page), or it landed but is incomplete (truncated / nextCursor /
   * liveMergeFailed) or stale. A pane whose workspace is here must not be
   * pruned on catalog absence. The set is derived from the live snapshots, so
   * it self-clears: the store re-tries an errored fetch, and a deferred load
   * is scheduled the moment the store becomes active again.
   */
  notReadyCwds: string[];
  reload: () => Promise<void>;
}

const EMPTY: DaemonSessionSummary[] = [];

export function useOtherWorkspaceSessions(
  enabled = true,
  pollIntervalMs?: number,
): OtherWorkspaceSessionsResult {
  const workspace = useWorkspace();
  const client = workspace.client;
  const targetsKey = JSON.stringify(
    enabled
      ? (workspace.capabilities?.workspaces ?? [])
          .filter((entry) => !entry.primary && entry.trusted)
          .map((entry) => entry.cwd)
      : [],
  );
  const queries = useMemo<SessionCatalogQuery[]>(
    () =>
      (JSON.parse(targetsKey) as string[]).map((workspaceCwd) => ({
        routeKind: 'legacy',
        workspaceCwd,
        options: {
          pageSize: SESSION_LIST_PAGE_SIZE,
          archiveState: 'active',
          sourceType: WEB_SHELL_SESSION_SOURCE_TYPE,
        },
      })),
    [targetsKey],
  );
  const snapshots = useSessionCatalogQueries(client, queries, {
    autoLoad: true,
    enabled,
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
  });
  const reportedErrors = useRef(new Map<string, Error>());

  useEffect(() => {
    const activeCwds = new Set(queries.map((query) => query.workspaceCwd));
    for (const cwd of reportedErrors.current.keys()) {
      if (!activeCwds.has(cwd)) reportedErrors.current.delete(cwd);
    }
    snapshots.forEach((snapshot, index) => {
      const error = snapshot.error;
      const cwd = queries[index]?.workspaceCwd;
      if (!error || !cwd || reportedErrors.current.get(cwd) === error) return;
      reportedErrors.current.set(cwd, error);
      console.warn(
        `[useOtherWorkspaceSessions] failed to list sessions for ${cwd}:`,
        error,
      );
    });
  }, [queries, snapshots]);

  const sessions = useMemo(() => {
    if (snapshots.length === 0) return EMPTY;
    const merged = snapshots.flatMap(
      (snapshot) => snapshot.page?.sessions ?? [],
    );
    return merged.length === 0 ? EMPTY : merged;
  }, [snapshots]);
  // In-flight only. A workspace whose first fetch failed has settled (its
  // `loading` is false) but is unknown — that is reported per-cwd by
  // `notReadyCwds`, not pinned here.
  const loading = useMemo(
    () => snapshots.some((snapshot) => snapshot.loading),
    [snapshots],
  );
  const queriedCwds = useMemo(
    () => (enabled ? queries.map((query) => query.workspaceCwd) : []),
    [enabled, queries],
  );
  // Positive proof per cwd: a workspace can prove a session is gone only when
  // the daemon vouched it a page that landed fresh (no error, not
  // stale-retained after a failed refresh) and complete (not truncated, no
  // nextCursor, live merge intact). Everything else — never landed (whatever
  // the reason), errored-but-retained, incomplete — is "not ready".
  const notReadyCwds = useMemo(() => {
    if (!enabled) {
      // A disabled fan-out sees no other workspace at all: it proves nothing
      // about any of them, but it has no query that could be not-ready.
      return [] as string[];
    }
    const notReady: string[] = [];
    snapshots.forEach((snapshot, index) => {
      const cwd = queries[index]?.workspaceCwd;
      if (!cwd) return;
      const page = snapshot.page;
      const ready =
        snapshot.error === undefined &&
        snapshot.stale !== true &&
        page !== undefined &&
        page.truncated !== true &&
        page.nextCursor === undefined &&
        page.liveMergeFailed !== true;
      if (!ready) notReady.push(cwd);
    });
    return notReady;
  }, [enabled, queries, snapshots]);
  const store = useMemo(() => getSessionCatalogStore(client), [client]);
  const reload = useCallback(async () => {
    if (queries.length === 0) return;
    await Promise.allSettled(queries.map((query) => store.refresh(query)));
  }, [queries, store]);

  return { sessions, loading, queriedCwds, notReadyCwds, reload };
}
