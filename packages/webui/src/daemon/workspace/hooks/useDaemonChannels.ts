/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type {
  DaemonChannelAuthBeginRequest,
  DaemonChannelAuthCommitRequest,
  DaemonChannelStartupRequest,
  DaemonChannelUpsertRequest,
  DaemonRevisionRequest,
} from '@qwen-code/sdk/daemon';
import { useDaemonWorkspace } from '../DaemonWorkspaceProvider.js';
import type {
  DaemonChannelsResource,
  DaemonResourceOptions,
} from '../types.js';
import { withActionTimeout } from '../../timing.js';
import { useDaemonResource } from './useDaemonResource.js';

export interface DaemonChannelsOptions extends DaemonResourceOptions {
  workspaceCwd?: string;
}

export function useDaemonChannels(options: DaemonChannelsOptions = {}) {
  const { workspaceCwd: workspaceOverride, ...resourceOptions } = options;
  const { client, workspaceCwd: providerWorkspaceCwd } = useDaemonWorkspace();
  const workspaceCwd = workspaceOverride ?? providerWorkspaceCwd;
  const workspace = useMemo(
    () => (workspaceCwd ? client.workspaceByCwd(workspaceCwd) : undefined),
    [client, workspaceCwd],
  );
  const requireWorkspace = useCallback(() => {
    if (!workspace) {
      throw new Error('Channel management requires a workspace.');
    }
    return workspace;
  }, [workspace]);
  const identity = useMemo(
    () => ({ client, workspaceCwd }),
    [client, workspaceCwd],
  );
  const load = useCallback(async (): Promise<DaemonChannelsResource> => {
    const selected = requireWorkspace();
    const [catalog, snapshot] = await withActionTimeout(
      Promise.all([
        selected.workspaceChannelTypes(),
        selected.workspaceChannels(),
      ]),
      'Load channels timed out',
    );
    return { catalog, snapshot };
  }, [requireWorkspace]);
  const resource = useDaemonResource(
    load,
    {
      ...resourceOptions,
      autoLoad: false,
    },
    identity,
  );
  const reloadResource = resource.reload;
  const requestedRef = useRef(false);
  const previousIdentityRef = useRef(identity);
  const identityRef = useRef(identity);
  identityRef.current = identity;
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
      resourceOptions.autoLoad !== true &&
      !(identityChanged && requestedRef.current)
    ) {
      return;
    }
    void reload();
  }, [identity, resourceOptions.autoLoad, reload]);

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
        withActionTimeout(
          requireWorkspace().upsertWorkspaceChannel(name, request),
          'Update channel timed out',
        ),
      ),
    [mutate, requireWorkspace],
  );
  const remove = useCallback(
    (name: string, request: DaemonRevisionRequest) =>
      mutate(() =>
        withActionTimeout(
          requireWorkspace().deleteWorkspaceChannel(name, request),
          'Remove channel timed out',
        ),
      ),
    [mutate, requireWorkspace],
  );
  const setStartup = useCallback(
    (name: string, request: DaemonChannelStartupRequest) =>
      mutate(() =>
        withActionTimeout(
          requireWorkspace().setWorkspaceChannelStartup(name, request),
          'Update channel startup timed out',
        ),
      ),
    [mutate, requireWorkspace],
  );
  const start = useCallback(
    (name: string) =>
      mutate(() =>
        withActionTimeout(
          requireWorkspace().startWorkspaceChannel(name),
          'Start channel timed out',
        ),
      ),
    [mutate, requireWorkspace],
  );
  const stop = useCallback(
    (name: string) =>
      mutate(() =>
        withActionTimeout(
          requireWorkspace().stopWorkspaceChannel(name),
          'Stop channel timed out',
        ),
      ),
    [mutate, requireWorkspace],
  );
  const restart = useCallback(
    (name: string) =>
      mutate(() =>
        withActionTimeout(
          requireWorkspace().restartWorkspaceChannel(name),
          'Restart channel timed out',
        ),
      ),
    [mutate, requireWorkspace],
  );
  const auth = useMemo(() => ({
      begin: async (name: string, request: DaemonChannelAuthBeginRequest) =>
        withActionTimeout(
          requireWorkspace().beginWorkspaceChannelAuth(name, request),
          'Begin channel auth timed out',
        ),
      status: async (name: string, sessionId: string) =>
        withActionTimeout(
          requireWorkspace().workspaceChannelAuth(name, sessionId),
          'Load channel auth timed out',
        ),
      qr: async (name: string, sessionId: string) =>
        withActionTimeout(
          requireWorkspace().workspaceChannelAuthQr(name, sessionId),
          'Load channel auth QR timed out',
        ),
      cancel: async (name: string, sessionId: string) =>
        withActionTimeout(
          requireWorkspace().cancelWorkspaceChannelAuth(name, sessionId),
          'Cancel channel auth timed out',
        ),
      commit: async (
        name: string,
        sessionId: string,
        request: DaemonChannelAuthCommitRequest,
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
    }), [identity, requireWorkspace]);

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
