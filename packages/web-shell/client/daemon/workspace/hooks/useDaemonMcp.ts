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

interface DaemonMcpOptions extends DaemonResourceOptions {
  workspaceCwd?: string;
}

export function useDaemonMcp(options: DaemonMcpOptions = {}) {
  const { actions, client, workspaceCwd } = useDaemonWorkspace();
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
      workspaceClient ? workspaceClient.runtimeMcp() : actions.loadMcpStatus(),
    [actions, workspaceClient],
  );
  const result = useDaemonResource(load, resourceOptions);
  const signals = useDaemonWorkspaceEventSignals();
  useWorkspaceEventReload(
    signals?.mcpVersion,
    result.reload,
    resourceOptions.autoLoad === true || result.data !== undefined,
  );
  return {
    ...result,
    status: result.data,
    ensureRuntime: () =>
      workspaceClient
        ? workspaceClient.ensureRuntime()
        : actions.ensureRuntime(),
    runtimeStatus: () =>
      workspaceClient
        ? workspaceClient.runtimeStatus()
        : workspaceCwd
          ? client.workspaceByCwd(workspaceCwd).runtimeStatus()
          : Promise.reject(new Error('Workspace is unavailable.')),
    loadConfig: () =>
      workspaceClient ? workspaceClient.mcpConfig() : actions.loadMcpConfig(),
    initialize: () =>
      workspaceClient
        ? workspaceClient.ensureRuntime().then(() => ({ accepted: true }))
        : actions.initializeMcp(),
    reloadConfig: () =>
      workspaceClient
        ? workspaceClient.reloadRuntimeMcp()
        : actions.reloadMcp(),
    loadTools: (serverName: string) =>
      workspaceClient
        ? workspaceClient.runtimeMcpTools(serverName)
        : actions.loadMcpTools(serverName),
    loadResources: (serverName: string) =>
      workspaceClient
        ? workspaceClient.runtimeMcpResources(serverName)
        : actions.loadMcpResources(serverName),
    restartServer: (serverName: string) =>
      workspaceClient
        ? workspaceClient.restartRuntimeMcpServer(serverName)
        : actions.restartMcpServer(serverName),
    manageServer: async (
      serverName: string,
      action: Parameters<typeof actions.manageMcpServer>[1],
    ) => {
      if (!workspaceClient) return actions.manageMcpServer(serverName, action);
      if (action !== 'enable' && action !== 'disable') {
        return workspaceClient.manageRuntimeMcpServer(serverName, action);
      }
      const config =
        action === 'disable' ? await workspaceClient.mcpConfig() : undefined;
      const scopes =
        action === 'enable'
          ? (['user', 'workspace'] as const)
          : [
              serverName in config!.user && !(serverName in config!.workspace)
                ? ('user' as const)
                : ('workspace' as const),
            ];
      let changed: boolean | undefined;
      for (const scope of scopes) {
        const result = await (scope === 'user'
          ? client.setUserMcpServerEnabled(serverName, action === 'enable')
          : workspaceClient.setMcpServerEnabled(
              serverName,
              action === 'enable',
            ));
        if (result.changed !== undefined) {
          changed = (changed ?? false) || result.changed;
        }
      }
      return {
        serverName,
        action,
        ok: true as const,
        ...(changed === undefined ? {} : { changed }),
      };
    },
    addServer: (request: Parameters<typeof actions.addRuntimeMcpServer>[0]) =>
      workspaceClient
        ? Promise.reject(
            new Error(
              'Runtime-only MCP servers are unavailable outside the primary workspace.',
            ),
          )
        : actions.addRuntimeMcpServer(request),
    removeServer: (name: string) =>
      workspaceClient
        ? Promise.reject(
            new Error(
              'Runtime-only MCP servers are unavailable outside the primary workspace.',
            ),
          )
        : actions.removeRuntimeMcpServer(name),
    setConfigServer: (
      name: string,
      scope: 'user' | 'workspace',
      config: Record<string, unknown>,
    ) =>
      scope === 'workspace' && workspaceClient
        ? workspaceClient.setMcpServer(name, config)
        : actions.setMcpServer(name, scope, config),
    removeConfigServer: (name: string, scope: 'user' | 'workspace') =>
      scope === 'workspace' && workspaceClient
        ? workspaceClient.removeMcpServer(name)
        : actions.removeMcpServer(name, scope),
    setConfigServerEnabled: (
      name: string,
      scope: 'user' | 'workspace',
      enabled: boolean,
    ) =>
      scope === 'workspace' && workspaceClient
        ? workspaceClient.setMcpServerEnabled(name, enabled)
        : actions.setMcpServerEnabled(name, scope, enabled),
  };
}
