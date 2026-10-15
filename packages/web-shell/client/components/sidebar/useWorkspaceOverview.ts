/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonClient } from '@qwen-code/sdk/daemon';
import {
  DEFAULT_WORKSPACE_OVERVIEW_ITEMS,
  dropExpiredFacets,
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

/**
 * A facet keeps its last known value across this many consecutive rounds
 * that did not answer for it, then reads as unavailable. Three rounds is a
 * blip's worth (about 90 s at the default cadence), not a rollback's.
 */
export const WORKSPACE_OVERVIEW_MAX_MISSES = 3;

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
  // Summarizing inside the wrapper keeps a malformed body (an intermediary
  // or mixed-version daemon answering 200 with a reduced shape) as isolated
  // as a rejected call: that facet stays unknown, the others still land.
  const [mcp, skills, extensions, channels, context, hooks] = await Promise.all(
    [
      facet(items.has('mcp'), async () =>
        summarizeMcp(await handle.workspaceMcp()),
      ),
      facet(items.has('skills'), async () =>
        summarizeSkills(await handle.workspaceSkills()),
      ),
      facet(items.has('extensions'), async () =>
        summarizeExtensions(await handle.workspaceExtensions()),
      ),
      facet(items.has('channels'), async () =>
        summarizeChannels(await handle.workspaceChannels()),
      ),
      facet(items.has('context'), async () =>
        summarizeContext(await handle.workspaceMemory()),
      ),
      facet(items.has('hooks'), async () =>
        summarizeHooks(await handle.workspaceHooks()),
      ),
    ],
  );
  return {
    ...(mcp ? { mcp } : {}),
    ...(skills ? { skills } : {}),
    ...(extensions ? { extensions } : {}),
    ...(channels ? { channels } : {}),
    ...(context ? { context } : {}),
    ...(hooks ? { hooks } : {}),
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
  const requestIdRef = useRef(0);
  // Miss budgets live per bookkeeping session: the epoch advances at every
  // reset boundary (cwd change, disable) so a round launched before a reset
  // can neither book misses into the fresh session nor zero them with a
  // stale success. Rounds inside one unbroken session keep accumulating —
  // the hang case below depends on superseded rounds still counting.
  const epochRef = useRef(0);
  // Consecutive rounds each facet went unanswered; bounds the carry-over.
  const missesRef = useRef<Partial<Record<WorkspaceOverviewItem, number>>>({});
  // The workspace the bookkeeping belongs to; a round from another cwd that
  // lands late must not touch it.
  const cwdRef = useRef(workspaceCwd);
  cwdRef.current = workspaceCwd;
  // Order-insensitive identity so a caller passing a fresh array literal each
  // render does not restart the poll loop.
  const itemsKey = [...new Set(items)].sort().join(',');
  const requested = useMemo(
    () =>
      new Set(itemsKey.split(',').filter(Boolean) as WorkspaceOverviewItem[]),
    [itemsKey],
  );
  const active = enabled && Boolean(workspaceCwd) && requested.size > 0;

  // Refreshes stay internal (mount, focus, poll tick, reload token): the
  // section refreshes through the sidebar's reload token, and exposing a
  // trigger would invite callers to bypass the visibility gating.
  const reload = useCallback(async () => {
    if (!active || !workspaceCwd) return;
    const requestId = ++requestIdRef.current;
    const cwd = workspaceCwd;
    const epoch = epochRef.current;
    const next = await fetchWorkspaceOverview(client, cwd, requested);
    if (cwd !== cwdRef.current) return;
    // Started before the last bookkeeping reset: its budget no longer
    // exists, and the snapshot it could expire was already cleared.
    if (epoch !== epochRef.current) return;
    // Bookkeeping runs for every round that lands, superseded or not: the
    // SDK's request deadline equals the poll cadence, so while the daemon
    // hangs each round times out just after the next tick has replaced it.
    // If only current rounds counted, misses would never accumulate and the
    // chips would freeze on pre-hang counts for the whole hang.
    const expired = new Set<WorkspaceOverviewItem>();
    for (const item of requested) {
      const misses = next[item] ? 0 : (missesRef.current[item] ?? 0) + 1;
      missesRef.current[item] = misses;
      if (misses >= WORKSPACE_OVERVIEW_MAX_MISSES) expired.add(item);
    }
    if (requestId !== requestIdRef.current) {
      // A superseded round's data is stale, but an expiry it observed is
      // real: drop those facets and leave the rest to the current round.
      if (expired.size > 0) {
        setOverview(
          (previous) => previous && dropExpiredFacets(previous, expired),
        );
      }
      return;
    }
    setOverview((previous) =>
      mergeOverviewSnapshots(previous, next, requested, expired),
    );
  }, [active, client, requested, workspaceCwd]);

  // A snapshot belongs to one workspace: switching cwd on a live hook must
  // not let the previous workspace's facets carry over into the next merge.
  useEffect(() => {
    epochRef.current += 1;
    missesRef.current = {};
    setOverview(undefined);
  }, [workspaceCwd]);

  useEffect(() => {
    if (!active) {
      // Invalidate any in-flight round so it cannot land after the clear.
      requestIdRef.current += 1;
      epochRef.current += 1;
      missesRef.current = {};
      setOverview(undefined);
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

  return { overview };
}
