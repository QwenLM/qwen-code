/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef } from 'react';
import { useOptionalDaemonActions } from '../../session/DaemonSessionProvider.js';
import { getStableClientId } from '../../session/clientLifecycle.js';
import { useDaemonWorkspace } from '../DaemonWorkspaceProvider.js';
import type { DaemonResourceOptions } from '../types.js';
import { useDaemonResource } from './useDaemonResource.js';

export function useDaemonSessions(options: DaemonResourceOptions = {}) {
  const workspace = useDaemonWorkspace();
  const sessionActions = useOptionalDaemonActions();
  const clientIdRef = useRef(getStableClientId(undefined));
  const load = useCallback(
    () => workspace.actions.listSessions(),
    [workspace.actions],
  );
  const workspaceReady = !!workspace.workspaceCwd;
  const result = useDaemonResource(load, {
    ...options,
    enabled: (options.enabled ?? true) && workspaceReady,
  });
  const { reload } = result;
  const deleteSession = useCallback(
    async (sessionId: string) => {
      const removed = await workspace.actions.deleteSession(
        sessionId,
        clientIdRef.current,
      );
      if (removed) reload();
      return removed;
    },
    [workspace.actions, reload],
  );
  const deleteSessions = useCallback(
    async (sessionIds: string[]) => {
      const res = await workspace.actions.deleteSessions(
        sessionIds,
        clientIdRef.current,
      );
      if (res.removed.length > 0 || res.notFound.length > 0) reload();
      return res;
    },
    [workspace.actions, reload],
  );
  return {
    ...result,
    sessions: result.data ?? [],
    loadSession: sessionActions?.loadSession,
    resumeSession: sessionActions?.resumeSession,
    newSession: sessionActions?.newSession,
    releaseSession: sessionActions?.releaseSession,
    deleteSession,
    deleteSessions,
  };
}
