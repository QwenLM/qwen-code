/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  useDaemonWorkspace,
  useDaemonWorkspaceActions,
} from '../DaemonWorkspaceProvider.js';
import type {
  DaemonChannelsResource,
  DaemonResourceOptions,
} from '../types.js';
import { withActionTimeout } from '../../timing.js';
import { useDaemonResource } from './useDaemonResource.js';

export function useDaemonChannels(options: DaemonResourceOptions = {}) {
  const { client, workspaceCwd } = useDaemonWorkspace();
  const actions = useDaemonWorkspaceActions();
  const identity = useMemo(
    () => ({ client, workspaceCwd }),
    [client, workspaceCwd],
  );
  const load = useCallback(
    (): Promise<DaemonChannelsResource> => actions.loadChannels(),
    [actions],
  );
  const resource = useDaemonResource(
    load,
    {
      ...options,
      autoLoad: false,
    },
    identity,
  );
  const reloadResource = resource.reload;
  const requestedRef = useRef(false);
  const previousIdentityRef = useRef(identity);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const authWorkspace = useMemo(
    () => (workspaceCwd ? client.workspaceByCwd(workspaceCwd) : undefined),
    [client, workspaceCwd],
  );

  const reload = useCallback(async () => {
    requestedRef.current = true;
    return reloadResource();
  }, [reloadResource]);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    const identityChanged = previousIdentityRef.current !== identity;
    previousIdentityRef.current = identity;
    if (
      options.autoLoad !== true &&
      !(identityChanged && requestedRef.current)
    ) {
      return;
    }
    void reload();
  }, [identity, options.autoLoad, reload]);

  const mutate = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      const result = await operation();
      await reloadRef.current();
      return result;
    },
    [],
  );

  const createOrUpdate = useCallback(
    (
      name: Parameters<typeof actions.upsertChannel>[0],
      request: Parameters<typeof actions.upsertChannel>[1],
    ) => mutate(() => actions.upsertChannel(name, request)),
    [actions, mutate],
  );
  const remove = useCallback(
    (
      name: Parameters<typeof actions.removeChannel>[0],
      request: Parameters<typeof actions.removeChannel>[1],
    ) => mutate(() => actions.removeChannel(name, request)),
    [actions, mutate],
  );
  const setStartup = useCallback(
    (
      name: Parameters<typeof actions.setChannelStartup>[0],
      request: Parameters<typeof actions.setChannelStartup>[1],
    ) => mutate(() => actions.setChannelStartup(name, request)),
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
  const auth = useMemo(() => {
    const requireWorkspace = () => {
      if (!authWorkspace) {
        throw new Error('Channel authentication requires a workspace.');
      }
      return authWorkspace;
    };
    return {
      begin: async (
        name: Parameters<typeof actions.channelAuth.begin>[0],
        request: Parameters<typeof actions.channelAuth.begin>[1],
      ) =>
        withActionTimeout(
          requireWorkspace().beginWorkspaceChannelAuth(name, request),
          'Begin channel auth timed out',
        ),
      status: async (
        name: Parameters<typeof actions.channelAuth.status>[0],
        sessionId: Parameters<typeof actions.channelAuth.status>[1],
      ) =>
        withActionTimeout(
          requireWorkspace().workspaceChannelAuth(name, sessionId),
          'Load channel auth timed out',
        ),
      qr: async (
        name: Parameters<typeof actions.channelAuth.qr>[0],
        sessionId: Parameters<typeof actions.channelAuth.qr>[1],
      ) =>
        withActionTimeout(
          requireWorkspace().workspaceChannelAuthQr(name, sessionId),
          'Load channel auth QR timed out',
        ),
      cancel: async (
        name: Parameters<typeof actions.channelAuth.cancel>[0],
        sessionId: Parameters<typeof actions.channelAuth.cancel>[1],
      ) =>
        withActionTimeout(
          requireWorkspace().cancelWorkspaceChannelAuth(name, sessionId),
          'Cancel channel auth timed out',
        ),
      commit: async (
        name: Parameters<typeof actions.channelAuth.commit>[0],
        sessionId: Parameters<typeof actions.channelAuth.commit>[1],
        request: Parameters<typeof actions.channelAuth.commit>[2],
      ) => {
        const result = await withActionTimeout(
          requireWorkspace().commitWorkspaceChannelAuth(
            name,
            sessionId,
            request,
          ),
          'Commit channel auth timed out',
        );
        if (identityRef.current === identity) {
          await reloadRef.current();
        }
        return result;
      },
    };
  }, [actions, authWorkspace, identity]);

  const current = resource.data;
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
    auth,
  };
}
