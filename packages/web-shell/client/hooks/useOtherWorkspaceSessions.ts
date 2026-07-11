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
   * Live sessions from every non-primary, trusted registered workspace, merged
   * into one flat list. Each summary already carries its own `workspaceCwd`.
   */
  sessions: DaemonSessionSummary[];
  /** Re-fetch every target workspace. Stable identity (safe in effect deps). */
  reload: () => Promise<void>;
}

const EMPTY: DaemonSessionSummary[] = [];

/**
 * Collect the *live* sessions of the daemon's other workspaces so the split
 * view and session overview can list and open sessions that are not in the
 * primary workspace. The primary workspace's own sessions still come from
 * `useSessions()`; callers merge the two (see `mergeSessionsById`).
 *
 * Scope & guarantees:
 * - Targets only `capabilities.workspaces` entries that are non-primary **and**
 *   trusted — an untrusted workspace can't be listed (the daemon 403s it) and
 *   the primary is already covered by `useSessions`.
 * - Non-primary workspaces are live-only on the daemon (Phase 2a), so this asks
 *   for `archiveState: 'active'` and never for the organized/persisted view.
 * - Fans out with `Promise.allSettled`: one workspace failing (e.g. transiently
 *   unreachable) drops only its own rows, never the others'.
 * - Returns an empty, stable list on a single-workspace daemon (no
 *   `capabilities.workspaces`, or only the primary), so merging it is a no-op
 *   and the single-workspace UI is byte-identical.
 */
export function useOtherWorkspaceSessions(): OtherWorkspaceSessionsResult {
  const workspace = useWorkspace();
  const client = workspace.client;

  // A newline-joined key of the non-primary trusted cwds, so `load` (and the
  // effect that runs it) only change identity when the actual target set does —
  // not on every capabilities re-render.
  const targetsKey = (workspace.capabilities?.workspaces ?? [])
    .filter((w) => !w.primary && w.trusted)
    .map((w) => w.cwd)
    .join('\n');

  const [sessions, setSessions] = useState<DaemonSessionSummary[]>(EMPTY);

  const load = useCallback(async () => {
    const cwds = targetsKey ? targetsKey.split('\n') : [];
    if (cwds.length === 0) {
      setSessions((prev) => (prev.length === 0 ? prev : EMPTY));
      return;
    }
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
    setSessions(merged);
  }, [client, targetsKey]);

  useEffect(() => {
    void load();
  }, [load]);

  return { sessions, reload: load };
}
