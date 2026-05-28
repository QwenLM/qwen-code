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

export function useDaemonSessions(options: DaemonResourceOptions = {}) {
  const workspace = useDaemonWorkspace();
  const sessionActions = useOptionalDaemonActions();
  const load = useCallback(
    () => workspace.actions.listSessions(),
    [workspace.actions],
  );
  const workspaceReady = !!workspace.workspaceCwd;
  const result = useDaemonResource(load, {
    ...options,
    enabled: (options.enabled ?? true) && workspaceReady,
  });
  return {
    ...result,
    sessions: result.data ?? [],
    loadSession: sessionActions?.loadSession,
    resumeSession: sessionActions?.resumeSession,
    newSession: sessionActions?.newSession,
    releaseSession: sessionActions?.releaseSession,
  };
}
