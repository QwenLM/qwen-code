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

export function useDaemonMcp(
  options: DaemonResourceOptions = {},
  workspaceCwd?: string,
) {
  const workspaceActions = useDaemonWorkspaceActions(workspaceCwd);
  const load = useCallback(
    () => workspaceActions.loadMcpStatus(),
    [workspaceActions],
  );
  const result = useDaemonResource(load, options);
  const signals = useDaemonWorkspaceEventSignals();
  const version = signals
    ? signals.mcpVersion + signals.settingsVersion + signals.extensionsVersion
    : undefined;
  useWorkspaceEventReload(
    version,
    result.reload,
    options.autoLoad === true || result.data !== undefined,
  );
  return {
    ...result,
    status: result.data,
    loadStatus: workspaceActions.loadMcpStatus,
    initialize: workspaceActions.initializeMcp,
    reloadConfig: workspaceActions.reloadMcp,
    waitForRuntime: workspaceActions.waitForMcpRuntime,
    loadTools: workspaceActions.loadMcpTools,
    loadResources: workspaceActions.loadMcpResources,
    restartServer: workspaceActions.restartMcpServer,
    manageServer: workspaceActions.manageMcpServer,
    operationStatus: workspaceActions.mcpOperationStatus,
    activeOperations: workspaceActions.activeMcpOperations,
    loadConfig: workspaceActions.loadMcpConfig,
    setConfig: workspaceActions.setMcpConfig,
    removeConfig: workspaceActions.removeMcpConfig,
  };
}
