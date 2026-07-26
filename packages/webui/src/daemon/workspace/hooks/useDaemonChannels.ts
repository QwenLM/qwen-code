/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef } from 'react';
import type {
  DaemonChannelStartupRequest,
  DaemonChannelUpsertRequest,
  DaemonRevisionRequest,
} from '@qwen-code/sdk/daemon';
import { useDaemonWorkspace } from '../DaemonWorkspaceProvider.js';
import type {
  DaemonChannelsResource,
  DaemonResourceOptions,
} from '../types.js';
import { useDaemonResource } from './useDaemonResource.js';

interface WorkspaceChannelsResource extends DaemonChannelsResource {
  workspaceCwd: string;
}

export function useDaemonChannels(options: DaemonResourceOptions = {}) {
  const { actions, workspaceCwd } = useDaemonWorkspace();
  const enabled = options.enabled !== false && workspaceCwd !== undefined;
  const load = useCallback(async (): Promise<WorkspaceChannelsResource> => {
    if (!workspaceCwd) {
      throw new Error('Channel management requires a workspace.');
    }
    return {
      ...(await actions.loadChannels()),
      workspaceCwd,
    };
  }, [actions, workspaceCwd]);
  const resource = useDaemonResource(load, {
    ...options,
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
      (options.autoLoad !== true && !(workspaceChanged && requestedRef.current))
    ) {
      return;
    }
    previousWorkspaceRef.current = workspaceCwd;
    void reload();
  }, [enabled, options.autoLoad, reload, workspaceCwd]);

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
      mutate(() => actions.upsertChannel(name, request)),
    [actions, mutate],
  );
  const remove = useCallback(
    (name: string, request: DaemonRevisionRequest) =>
      mutate(() => actions.removeChannel(name, request)),
    [actions, mutate],
  );
  const setStartup = useCallback(
    (name: string, request: DaemonChannelStartupRequest) =>
      mutate(() => actions.setChannelStartup(name, request)),
    [actions, mutate],
  );
  const start = useCallback(
    (name: string) => mutate(() => actions.startChannel(name)),
    [actions, mutate],
  );
  const stop = useCallback(
    (name: string) => mutate(() => actions.stopChannel(name)),
    [actions, mutate],
  );
  const restart = useCallback(
    (name: string) => mutate(() => actions.restartChannel(name)),
    [actions, mutate],
  );
  const current =
    resource.data?.workspaceCwd === workspaceCwd ? resource.data : undefined;

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
    pairing: actions.channelPairing,
  };
}
