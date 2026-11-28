/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo } from 'react';
import { useDaemonWorkspaceEventSignals } from '../../session/DaemonSessionProvider.js';
import { useDaemonWorkspace } from '../DaemonWorkspaceProvider.js';
import type { DaemonResourceOptions } from '../types.js';
import { useDaemonResource } from './useDaemonResource.js';
import { useWorkspaceEventReload } from './useWorkspaceEventReload.js';

interface DaemonSettingsOptions extends DaemonResourceOptions {
  workspaceCwd?: string;
}

export function useDaemonSettings(options: DaemonSettingsOptions = {}) {
  const { actions: workspaceActions, client } = useDaemonWorkspace();
  const { workspaceCwd: requestedWorkspaceCwd, ...resourceOptions } = options;
  const workspaceClient = useMemo(
    () =>
      requestedWorkspaceCwd
        ? client.workspaceByCwd(requestedWorkspaceCwd)
        : undefined,
    [client, requestedWorkspaceCwd],
  );
  const load = useCallback(
    () =>
      workspaceClient
        ? workspaceClient.workspaceSettings()
        : workspaceActions.loadSettingsStatus(),
    [workspaceActions, workspaceClient],
  );
  const result = useDaemonResource(load, resourceOptions);
  const setValue = useCallback<typeof workspaceActions.setWorkspaceSetting>(
    (scope, key, value) => {
      if (scope === 'workspace' && workspaceClient) {
        return workspaceClient.setWorkspaceSetting('workspace', key, value);
      }
      return workspaceActions.setWorkspaceSetting(scope, key, value);
    },
    [workspaceActions, workspaceClient],
  );
  const signals = useDaemonWorkspaceEventSignals();
  useWorkspaceEventReload(
    signals?.settingsVersion,
    result.reload,
    resourceOptions.autoLoad === true || result.data !== undefined,
  );
  return {
    ...result,
    status: result.data,
    settings: result.data?.settings ?? [],
    setValue,
  };
}
