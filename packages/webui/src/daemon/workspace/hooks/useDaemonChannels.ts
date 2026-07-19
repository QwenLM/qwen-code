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
import { useDaemonResource } from './useDaemonResource.js';

interface KeyedChannelsResource extends DaemonChannelsResource {
  identity: object;
}

export function useDaemonChannels(options: DaemonResourceOptions = {}) {
  const { client, workspaceCwd } = useDaemonWorkspace();
  const actions = useDaemonWorkspaceActions();
  const identity = useMemo(
    () => ({ client, workspaceCwd }),
    [client, workspaceCwd],
  );
  const load = useCallback(async (): Promise<KeyedChannelsResource> => {
    const result = await actions.loadChannels();
    return { ...result, identity };
  }, [actions, identity]);
  const resource = useDaemonResource(load, {
    ...options,
    autoLoad: false,
  });
  const reloadResource = resource.reload;
  const requestedRef = useRef(false);
  const previousIdentityRef = useRef(identity);

  const reload = useCallback(async () => {
    requestedRef.current = true;
    const result = await reloadResource();
    return result?.identity === identity
      ? { catalog: result.catalog, snapshot: result.snapshot }
      : undefined;
  }, [identity, reloadResource]);
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
  const auth = useMemo(
    () => ({
      begin: actions.channelAuth.begin,
      status: actions.channelAuth.status,
      qr: actions.channelAuth.qr,
      cancel: actions.channelAuth.cancel,
      commit: (
        name: Parameters<typeof actions.channelAuth.commit>[0],
        sessionId: Parameters<typeof actions.channelAuth.commit>[1],
        request: Parameters<typeof actions.channelAuth.commit>[2],
      ) => mutate(() => actions.channelAuth.commit(name, sessionId, request)),
    }),
    [actions, mutate],
  );

  const current =
    resource.data?.identity === identity ? resource.data : undefined;
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
