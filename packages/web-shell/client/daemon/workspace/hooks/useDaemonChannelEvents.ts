/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo } from 'react';
import type { DaemonChannelEventsQuery } from '@qwen-code/sdk/daemon';
import { useDaemonWorkspace } from '../DaemonWorkspaceProvider.js';
import type {
  DaemonChannelEventEntry,
  DaemonChannelEventList,
  DaemonResourceOptions,
} from '../types.js';
import { useDaemonResource } from './useDaemonResource.js';

/** Channels react within seconds; a diagnostic view can lag a little. */
export const CHANNEL_EVENTS_RELOAD_MS = 5_000;

interface DaemonChannelEventsOptions extends DaemonResourceOptions {
  workspaceCwd?: string;
  /** Restrict the timeline to one Channel instance. */
  channel?: string;
  types?: readonly DaemonChannelEventEntry['type'][];
  limit?: number;
}

/** A loaded journal together with the query that produced it. */
interface ChannelEventsSnapshot {
  queryKey: string;
  list: DaemonChannelEventList;
}

/**
 * A workspace's Channel event journal, polled while `enabled`. The page can
 * also call `reload` for an explicit refresh.
 */
export function useDaemonChannelEvents(
  options: DaemonChannelEventsOptions = {},
) {
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
  const { channel, limit } = resourceOptions;
  // An array literal from props changes identity on every render, which would
  // restart the poll on each one; the joined key keeps it stable.
  const typesKey = (resourceOptions.types ?? []).join(',');
  const types = useMemo(
    () =>
      typesKey
        ? (typesKey.split(',') as DaemonChannelEventEntry['type'][])
        : undefined,
    [typesKey],
  );

  // The resource keeps its previous data while a new query is in flight or
  // after it fails, so every snapshot is tagged with the query that produced
  // it and mismatched data is masked — otherwise the last workspace's rows
  // (and their Channel names) would show under the newly selected one.
  // NUL cannot appear in any part: the management route rejects control
  // characters in an instance name, journal names are sanitized, and a
  // filesystem path cannot contain it.
  const queryKey = [
    workspaceCwd ?? '',
    channel ?? '',
    typesKey,
    limit ?? '',
  ].join('\u0000');

  const load = useCallback(async (): Promise<ChannelEventsSnapshot> => {
    if (!workspaceCwd) {
      throw new Error('Channel events require a workspace.');
    }
    const query: DaemonChannelEventsQuery = {
      ...(limit !== undefined ? { limit } : {}),
      ...(channel ? { channels: [channel] } : {}),
      ...(types ? { types } : {}),
    };
    const list = workspaceClient
      ? await workspaceClient.workspaceChannelEvents(query)
      : await actions.listChannelEvents(query);
    return { queryKey, list };
  }, [actions, channel, limit, queryKey, types, workspaceClient, workspaceCwd]);
  const resource = useDaemonResource(load, {
    ...resourceOptions,
    autoLoad: false,
    enabled,
  });
  const { reload } = resource;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer = 0;
    const schedule = () => {
      // A forgotten background tab must not keep reading journals on a daemon
      // that is also serving sessions. Check again when the timer fires: the
      // tab can go hidden after the timer was armed.
      if (document.visibilityState === 'hidden') return;
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'hidden') return;
        void run();
      }, CHANNEL_EVENTS_RELOAD_MS);
    };
    const run = async () => {
      await reload();
      if (cancelled) return;
      schedule();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') return;
      window.clearTimeout(timer);
      void run();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (document.visibilityState !== 'hidden') void run();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, reload]);

  const data =
    resource.data?.queryKey === queryKey ? resource.data.list : undefined;
  return { ...resource, data };
}
