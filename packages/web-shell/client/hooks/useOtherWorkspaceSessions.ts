/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react';
import { useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { SESSION_LIST_PAGE_SIZE } from '../constants/sessions';

export interface OtherWorkspaceSessionsResult {
  /**
   * Active sessions from every non-primary, trusted registered workspace,
   * merged into one flat list. Each summary carries its own `workspaceCwd`.
   */
  sessions: DaemonSessionSummary[];
  /** Re-fetch every target workspace. Stable identity (safe in effect deps). */
  reload: () => Promise<void>;
}

const EMPTY: DaemonSessionSummary[] = [];

/**
 * Collect the active sessions of the daemon's other workspaces so the split
 * view and session overview can list and open sessions that are not in the
 * primary workspace. The primary workspace's own sessions still come from
 * `useSessions()`; callers merge the two (see `mergeSessionsById`).
 *
 * Scope & guarantees:
 * - Targets only `capabilities.workspaces` entries that are non-primary **and**
 *   trusted. Untrusted workspaces expose a persisted read-only catalog, but
 *   those rows are not openable and therefore do not belong in this hook; the
 *   primary is already covered by `useSessions`.
 * - Trusted non-primary active lists merge persisted rows with matching live
 *   summaries. This hook asks for `archiveState: 'active'`; archived and
 *   organized views are handled by their dedicated surfaces.
 * - Fans out with `Promise.allSettled`: one workspace failing (e.g. transiently
 *   unreachable) drops only its own rows, never the others'.
 * - Returns an empty, stable list on a single-workspace daemon (no
 *   `capabilities.workspaces`, or only the primary), so merging it is a no-op
 *   and the single-workspace UI is byte-identical.
 */
export function useOtherWorkspaceSessions(
  enabled = true,
): OtherWorkspaceSessionsResult {
  const workspace = useWorkspace();
  const client = workspace.client;

  // A newline-joined key of the non-primary trusted cwds, so `load` (and the
  // effect that runs it) only change identity when the actual target set does —
  // not on every capabilities re-render.
  const targetsKey = enabled
    ? (workspace.capabilities?.workspaces ?? [])
        .filter((w) => !w.primary && w.trusted)
        .map((w) => w.cwd)
        .join('\n')
    : '';

  const [sessions, setSessions] = useState<DaemonSessionSummary[]>(EMPTY);

  // Fetch + merge the target workspaces' active sessions. Returns the stable
  // EMPTY sentinel when there is nothing to fetch or every list came back
  // empty, so `setSessions` is a reference-equal no-op re-render in that case.
  const fetchSessions = useCallback(async (): Promise<
    DaemonSessionSummary[]
  > => {
    const cwds = targetsKey ? targetsKey.split('\n') : [];
    if (cwds.length === 0) return EMPTY;
    const settled = await Promise.allSettled(
      cwds.map((cwd) =>
        // Match the primary list's page size (both callers fetch the primary
        // with SESSION_LIST_PAGE_SIZE); the daemon's default is far smaller, so
        // without this a busy non-primary workspace would silently truncate.
        client.listWorkspaceSessions(cwd, {
          pageSize: SESSION_LIST_PAGE_SIZE,
          archiveState: 'active',
        }),
      ),
    );
    const merged: DaemonSessionSummary[] = [];
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        merged.push(...result.value);
      } else {
        // Surface connectivity failures without blanking the workspaces that
        // did respond — mirrors the sidebar's per-section poll.
        console.warn(
          `[useOtherWorkspaceSessions] failed to list sessions for ${cwds[index]}:`,
          result.reason,
        );
      }
    });
    return merged.length === 0 ? EMPTY : merged;
  }, [client, targetsKey]);

  const reload = useCallback(async () => {
    // Nothing to reload on a single-workspace daemon — return synchronously so
    // callers polling `reloadOther()` don't trigger a no-op async state update.
    if (!targetsKey) return;
    setSessions(await fetchSessions());
  }, [targetsKey, fetchSessions]);

  // Load on mount and whenever the target set changes. With no other
  // workspaces (the single-workspace daemon) this stays fully synchronous — no
  // fetch, no post-render `setState` — so the common path never even touches
  // the daemon. The `cancelled` guard stops a slow in-flight fetch from
  // overwriting a newer one when the target set changes mid-flight (e.g. a
  // workspace is registered / unregistered).
  useEffect(() => {
    if (!targetsKey) {
      setSessions((prev) => (prev.length === 0 ? prev : EMPTY));
      return;
    }
    let cancelled = false;
    void fetchSessions().then((result) => {
      if (!cancelled) setSessions(result);
    });
    return () => {
      cancelled = true;
    };
  }, [targetsKey, fetchSessions]);

  return { sessions, reload };
}
