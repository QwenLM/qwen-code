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
   * True while any non-primary workspace list is still in flight. A first
   * fetch that failed is settled, not loading — it is reported by `degraded`
   * instead, so a persistently-failing workspace can't pin this forever.
   * Consumers that compare the merged list against live state (for example
   * pruning panes) must wait for this to be false so a still-loading
   * workspace can't look like a vanished session.
   */
  loading: boolean;
  /**
   * True while the fan-out can't prove a session is gone, for a reason that
   * isn't "still loading": a queried workspace settled with an error and no
   * page (its sessions are missing from the merged list for a reason other
   * than archiving), or the daemon lists a non-primary workspace we never
   * queried (untrusted) whose sessions could still be a live pane. Consumers
   * that prune panes on catalog absence must wait for this to be false as
   * well — while it is true, absence from the merged list is not proof of
   * removal.
   */
  degraded: boolean;
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
  // `loading` is false) but is unknown — that is reported by `degraded`, not
  // pinned here. Keying `loading` off `page === undefined` (the old behaviour)
  // kept a persistently-failing workspace "loading" forever, which blocked the
  // prune for every pane, not just the failing workspace's.
  const loading = useMemo(
    () => snapshots.some((snapshot) => snapshot.loading),
    [snapshots],
  );
  // The fan-out can't prove a session is gone while: a queried workspace
  // settled with an error and no page (its sessions are absent for a reason
  // other than archiving), or the daemon lists a non-primary workspace we
  // never queried (untrusted) whose sessions could still be a live pane. Only
  // consulted while the hook is enabled — a disabled fan-out (single or
  // workspace-locked split) has no other-workspace concern at all.
  const degraded = useMemo(() => {
    if (!enabled) return false;
    const queried = new Set(queries.map((query) => query.workspaceCwd));
    const unqueriedNonPrimary = (
      workspace.capabilities?.workspaces ?? []
    ).some((entry) => !entry.primary && !queried.has(entry.cwd));
    const landedDegraded = snapshots.some(
      (snapshot) =>
        snapshot.error !== undefined && snapshot.page === undefined,
    );
    return unqueriedNonPrimary || landedDegraded;
  }, [enabled, queries, snapshots, workspace.capabilities]);
  const store = useMemo(() => getSessionCatalogStore(client), [client]);
  const reload = useCallback(async () => {
    if (queries.length === 0) return;
    await Promise.allSettled(queries.map((query) => store.refresh(query)));
  }, [queries, store]);

  return { sessions, loading, degraded, reload };
}
