/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type {
  DaemonChannelStartupRequest,
  DaemonChannelUpsertRequest,
  DaemonRevisionRequest,
} from '@qwen-code/sdk/daemon';
import { useDaemonWorkspace } from '../DaemonWorkspaceProvider.js';
import type {
  DaemonChannelPairingActions,
  DaemonChannelsResource,
  DaemonResourceOptions,
} from '../types.js';
import { useDaemonResource } from './useDaemonResource.js';

interface WorkspaceChannelsResource extends DaemonChannelsResource {
  workspaceCwd: string;
}

interface DaemonChannelsOptions extends DaemonResourceOptions {
  workspaceCwd?: string;
}

export function useDaemonChannels(options: DaemonChannelsOptions = {}) {
  const {
    actions,
    client,
    workspaceCwd: providerWorkspaceCwd,
  } = useDaemonWorkspace();
  const { workspaceCwd: requestedWorkspaceCwd, ...resourceOptions } = options;
  const workspaceCwd = requestedWorkspaceCwd ?? providerWorkspaceCwd;
  const usesProviderWorkspace = workspaceCwd === providerWorkspaceCwd;
  const workspaceClient = useMemo(
    () =>
      workspaceCwd && !usesProviderWorkspace
        ? client.workspaceByCwd(workspaceCwd)
        : undefined,
    [client, usesProviderWorkspace, workspaceCwd],
  );
  const enabled =
    resourceOptions.enabled !== false && workspaceCwd !== undefined;
  const load = useCallback(async (): Promise<WorkspaceChannelsResource> => {
    if (!workspaceCwd) {
      throw new Error('Channel management requires a workspace.');
    }
    const data = workspaceClient
      ? await Promise.all([
          workspaceClient.workspaceChannelTypes(),
          workspaceClient.workspaceChannels(),
        ]).then(([catalog, snapshot]) => ({ catalog, snapshot }))
      : await actions.loadChannels();
    return {
      ...data,
      workspaceCwd,
    };
  }, [actions, workspaceClient, workspaceCwd]);
  const resource = useDaemonResource(load, {
    ...resourceOptions,
    autoLoad: false,
    enabled,
  });
  const resourceReload = resource.reload;
  const requestedRef = useRef(false);
  const previousWorkspaceRef = useRef(workspaceCwd);
  const reload = useCallback(async () => {
    requestedRef.current = true;
    return resourceReload();
  }, [resourceReload]);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    const workspaceChanged = previousWorkspaceRef.current !== workspaceCwd;
    if (
      !enabled ||
      (resourceOptions.autoLoad !== true &&
        !(workspaceChanged && requestedRef.current))
    ) {
      return;
    }
    previousWorkspaceRef.current = workspaceCwd;
    void reload();
  }, [enabled, reload, resourceOptions.autoLoad, workspaceCwd]);

  const mutate = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      const result = await operation();
      await reloadRef.current();
      return result;
    },
    [],
  );
  const createOrUpdate = useCallback(
    (name: string, request: DaemonChannelUpsertRequest) =>
      mutate(() =>
        workspaceClient
          ? workspaceClient.upsertWorkspaceChannel(name, request)
          : actions.upsertChannel(name, request),
      ),
    [actions, mutate, workspaceClient],
  );
  const remove = useCallback(
    (name: string, request: DaemonRevisionRequest) =>
      mutate(() =>
        workspaceClient
          ? workspaceClient.deleteWorkspaceChannel(name, request)
          : actions.removeChannel(name, request),
      ),
    [actions, mutate, workspaceClient],
  );
  const setStartup = useCallback(
    (name: string, request: DaemonChannelStartupRequest) =>
      mutate(() =>
        workspaceClient
          ? workspaceClient.setWorkspaceChannelStartup(name, request)
          : actions.setChannelStartup(name, request),
      ),
    [actions, mutate, workspaceClient],
  );
  const start = useCallback(
    (name: string) =>
      mutate(() =>
        workspaceClient
          ? workspaceClient.startWorkspaceChannel(name)
          : actions.startChannel(name),
      ),
    [actions, mutate, workspaceClient],
  );
  const stop = useCallback(
    (name: string) =>
      mutate(() =>
        workspaceClient
          ? workspaceClient.stopWorkspaceChannel(name)
          : actions.stopChannel(name),
      ),
    [actions, mutate, workspaceClient],
  );
  const restart = useCallback(
    (name: string) =>
      mutate(() =>
        workspaceClient
          ? workspaceClient.restartWorkspaceChannel(name)
          : actions.restartChannel(name),
      ),
    [actions, mutate, workspaceClient],
  );
  const current =
    resource.data?.workspaceCwd === workspaceCwd ? resource.data : undefined;
  const pairing = useMemo<DaemonChannelPairingActions>(
    () =>
      workspaceClient
        ? {
            list: (name) =>
              workspaceClient.workspaceChannelPairingRequests(name),
            approve: (name, code) =>
              workspaceClient.approveWorkspaceChannelPairing(name, { code }),
            approvals: (name) =>
              workspaceClient.workspaceChannelPairingApprovals(name),
            revoke: (name, request) =>
              workspaceClient.revokeWorkspaceChannelPairingApproval(
                name,
                request,
              ),
          }
        : actions.channelPairing,
    [actions.channelPairing, workspaceClient],
  );

  return {
    data: current
      ? { catalog: current.catalog, snapshot: current.snapshot }
      : undefined,
    loading: resource.loading,
    error: resource.error,
    reload,
    catalog: current?.catalog ?? [],
    snapshot: current?.snapshot,
    channels: current?.snapshot.instances ?? {},
    createOrUpdate,
    remove,
    setStartup,
    start,
    stop,
    restart,
    pairing,
  };
}
