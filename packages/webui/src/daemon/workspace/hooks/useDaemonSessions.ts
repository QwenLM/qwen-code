/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react';
import { useOptionalDaemonActions } from '../../session/DaemonSessionProvider.js';
import { useDaemonWorkspace } from '../DaemonWorkspaceProvider.js';
import type { DaemonResourceOptions } from '../types.js';
import { useDaemonResource } from './useDaemonResource.js';

export interface DaemonSessionsOptions extends DaemonResourceOptions {
  pageSize?: number;
  cursor?: string;
  archiveState?: 'active' | 'archived';
  view?: 'organized';
  group?: string;
}

export function useDaemonSessions(options: DaemonSessionsOptions = {}) {
  const { pageSize, cursor, archiveState, view, group, ...resourceOptions } =
    options;
  const workspace = useDaemonWorkspace();
  const sessionActions = useOptionalDaemonActions();
  const load = useCallback(() => {
    const listOptions = {
      ...(pageSize !== undefined ? { pageSize } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(archiveState !== undefined ? { archiveState } : {}),
      ...(view !== undefined ? { view } : {}),
      ...(group !== undefined ? { group } : {}),
    };
    return workspace.actions.listSessions(listOptions);
  }, [archiveState, cursor, group, pageSize, view, workspace.actions]);
  const workspaceReady = !!workspace.workspaceCwd;
  const result = useDaemonResource(load, {
    ...resourceOptions,
    enabled: (resourceOptions.enabled ?? true) && workspaceReady,
  });
  const { reload } = result;
  const deleteSession = useCallback(
    async (sessionId: string) => {
      const removed = await workspace.actions.deleteSession(sessionId);
      if (removed) reload();
      return removed;
    },
    [workspace.actions, reload],
  );
  const deleteSessions = useCallback(
    async (sessionIds: string[]) => {
      const res = await workspace.actions.deleteSessions(sessionIds);
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
