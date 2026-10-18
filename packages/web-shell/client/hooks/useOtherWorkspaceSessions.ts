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
   * True until every non-primary workspace list has settled at least once
   * (or failed, which leaves its page absent). Consumers that compare the
   * merged list against live state (for example pruning panes) must wait for
   * this to be false so a still-loading workspace can't look like a vanished
   * session.
   */
  loading: boolean;
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
  const loading = useMemo(
    () =>
      snapshots.some(
        (snapshot) => snapshot.loading || snapshot.page === undefined,
      ),
    [snapshots],
  );
  const store = useMemo(() => getSessionCatalogStore(client), [client]);
  const reload = useCallback(async () => {
    if (queries.length === 0) return;
    await Promise.allSettled(queries.map((query) => store.refresh(query)));
  }, [queries, store]);

  return { sessions, loading, reload };
}
