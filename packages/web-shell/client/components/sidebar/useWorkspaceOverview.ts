/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonClient } from '@qwen-code/sdk/daemon';
import {
  DEFAULT_WORKSPACE_OVERVIEW_ITEMS,
  mergeOverviewSnapshots,
  summarizeChannels,
  summarizeContext,
  summarizeExtensions,
  summarizeHooks,
  summarizeMcp,
  summarizeSkills,
  type WorkspaceOverviewItem,
  type WorkspaceOverviewSnapshot,
} from './workspaceOverviewModel';

/**
 * Overview facets change on the order of minutes (a server reconnects, a
 * skill is installed); the git chip already polls at 60s. 30s keeps a
 * reconnect visible within one glance without turning N expanded workspaces
 * into a request storm.
 */
export const WORKSPACE_OVERVIEW_POLL_MS = 30_000;

export interface UseWorkspaceOverviewOptions {
  /** Fetch only while true; false clears the snapshot and stops polling. */
  enabled: boolean;
  items?: readonly WorkspaceOverviewItem[];
  /** Bump to force a refetch (the sidebar's reload token). */
  reloadToken?: number;
  pollIntervalMs?: number;
}

export interface WorkspaceOverviewResult {
  overview: WorkspaceOverviewSnapshot | undefined;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * Fetch every requested facet for one workspace. Facets fail independently:
 * a daemon that predates one of the routes, or a transient error on one call,
 * leaves that facet `undefined` and the others intact. Calls are deferred to
 * a microtask so a client whose handle lacks a method (older SDK, test
 * double) rejects instead of throwing synchronously out of the hook.
 */
export async function fetchWorkspaceOverview(
  client: DaemonClient,
  workspaceCwd: string,
  items: ReadonlySet<WorkspaceOverviewItem>,
): Promise<WorkspaceOverviewSnapshot> {
  const handle = client.workspaceByCwd(workspaceCwd);
  const facet = <T>(
    wanted: boolean,
    call: () => Promise<T>,
  ): Promise<T | undefined> =>
    wanted
      ? Promise.resolve()
          .then(call)
          .catch(() => undefined)
      : Promise.resolve(undefined);
  const [mcp, skills, extensions, channels, memory, hooks] = await Promise.all([
    facet(items.has('mcp'), () => handle.workspaceMcp()),
    facet(items.has('skills'), () => handle.workspaceSkills()),
    facet(items.has('extensions'), () => handle.workspaceExtensions()),
    facet(items.has('channels'), () => handle.workspaceChannels()),
    facet(items.has('context'), () => handle.workspaceMemory()),
    facet(items.has('hooks'), () => handle.workspaceHooks()),
  ]);
  return {
    ...(mcp ? { mcp: summarizeMcp(mcp) } : {}),
    ...(skills ? { skills: summarizeSkills(skills) } : {}),
    ...(extensions ? { extensions: summarizeExtensions(extensions) } : {}),
    ...(channels ? { channels: summarizeChannels(channels) } : {}),
    ...(memory ? { context: summarizeContext(memory) } : {}),
    ...(hooks ? { hooks: summarizeHooks(hooks) } : {}),
    fetchedAt: Date.now(),
  };
}

export function useWorkspaceOverview(
  client: DaemonClient,
  workspaceCwd: string | undefined,
  {
    enabled,
    items = DEFAULT_WORKSPACE_OVERVIEW_ITEMS,
    reloadToken,
    pollIntervalMs = WORKSPACE_OVERVIEW_POLL_MS,
  }: UseWorkspaceOverviewOptions,
): WorkspaceOverviewResult {
  const [overview, setOverview] = useState<WorkspaceOverviewSnapshot>();
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);
  // Order-insensitive identity so a caller passing a fresh array literal each
  // render does not restart the poll loop.
  const itemsKey = [...new Set(items)].sort().join(',');
  const requested = useMemo(
    () =>
      new Set(itemsKey.split(',').filter(Boolean) as WorkspaceOverviewItem[]),
    [itemsKey],
  );
  const active = enabled && Boolean(workspaceCwd) && requested.size > 0;

  const reload = useCallback(async () => {
    if (!active || !workspaceCwd) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    const next = await fetchWorkspaceOverview(client, workspaceCwd, requested);
    if (requestId !== requestIdRef.current) return;
    setOverview((previous) =>
      mergeOverviewSnapshots(previous, next, requested),
    );
    setLoading(false);
  }, [active, client, requested, workspaceCwd]);

  useEffect(() => {
    if (!active) {
      // Invalidate any in-flight round so it cannot land after the clear.
      requestIdRef.current += 1;
      setOverview(undefined);
      setLoading(false);
      return;
    }
    void reload();
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, pollIntervalMs);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [active, pollIntervalMs, reload, reloadToken]);

  return { overview, loading, reload };
}
