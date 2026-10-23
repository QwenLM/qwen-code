/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react';
import { useDaemonWorkspaceEventSignals } from '../../session/DaemonSessionProvider.js';
import { useDaemonWorkspaceActions } from '../DaemonWorkspaceProvider.js';
import type { DaemonResourceOptions } from '../types.js';
import { useDaemonResource } from './useDaemonResource.js';
import { useWorkspaceEventReload } from './useWorkspaceEventReload.js';

export function useDaemonAutoMemory(options: DaemonResourceOptions = {}) {
  const workspaceActions = useDaemonWorkspaceActions();
  const load = useCallback(
    () => workspaceActions.loadAutoMemoryStatus(),
    [workspaceActions],
  );
  const result = useDaemonResource(load, options);
  const signals = useDaemonWorkspaceEventSignals();
  useWorkspaceEventReload(
    signals?.memoryVersion,
    result.reload,
    options.autoLoad === true || result.data !== undefined,
  );
  return {
    ...result,
    status: result.data,
    entries: result.data?.entries ?? [],
    // Read through the auto-memory route, not the sandboxed file API:
    // the memory directories sit outside the bound workspace, and
    // `GET /file` refuses them.
    readAutoMemoryFile: workspaceActions.readAutoMemoryFile,
    openAutoMemoryFolder: workspaceActions.openAutoMemoryFolder,
  };
}
