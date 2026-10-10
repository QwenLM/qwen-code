/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-origin read-only daemon clients for the multi-daemon Web Shell
 * (#13727): the sidebar needs live workspace/session views of every
 * connected host at once, ahead of full multi-provider support.
 *
 * Each host gets ONE stable `DaemonClient` (memoized by origin + token), so
 * client-keyed catalog stores keep their caches across renders. Fan-out
 * clients carry that origin's own per-origin token and are used for read
 * paths only (capabilities, session listings); session creation and every
 * mutation go through the focused provider or an explicit one-shot call that
 * immediately hands the session to the focused provider.
 *
 * Polling is shared: one `capabilities()` round per tracked origin every
 * 30 s, no matter how many components subscribe (the composer picker, the
 * sidebar host groups and the App-level fan-out all read the same store).
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { DaemonClient } from '@qwen-code/sdk/daemon';
import type { DaemonCapabilities } from '@qwen-code/sdk/daemon';
import { getDaemonToken } from './daemon';
import { useRemoteConnections } from './remote-connections';
import { useWorkspaceHosts } from './workspace-hosts';
import { useDaemonTargetOptional } from './daemon-target';

export type HostConnectionStatus =
  | 'connecting'
  | 'online'
  | 'offline'
  | 'unauthorized';

const clients = new Map<
  string,
  { client: DaemonClient; token: string | undefined }
>();

/**
 * Stable read-only client for `origin`. Recreated only when the stored
 * per-origin token changed; a client whose daemon vanished stays online as an
 * instance (its next request fails) and its entry is dropped when the host
 * loses its last subscriber.
 */
export function getHostClient(origin: string): DaemonClient {
  const existing = clients.get(origin);
  const token = getDaemonToken(origin);
  if (existing && existing.token === token) return existing.client;
  existing?.client.dispose();
  const client = new DaemonClient({ baseUrl: origin, token });
  clients.set(origin, { client, token });
  return client;
}

function dropHostClient(origin: string): void {
  clients.get(origin)?.client.dispose();
  clients.delete(origin);
}

const POLL_MS = 30_000;
const UNAUTHORIZED_PATTERN = /401|unauthori[sz]ed/i;

export const HOST_FANOUT_POLL_MS = POLL_MS;

export interface HostCapabilitiesState {
  workspaces: DaemonCapabilities['workspaces'];
  status: HostConnectionStatus;
  /** Bumps on every content-changed refresh so poll consumers resubscribe. */
  generation: number;
}

interface HostFanoutEntry extends HostCapabilitiesState {
  listeners: Set<() => void>;
  /** Immutable per-round snapshot handed to useSyncExternalStore. */
  snapshot: HostCapabilitiesState;
}

/** Monotonic store version: bumped on every settled poll round. */
let storeVersion = 0;
const versionListeners = new Set<() => void>();

function storeVersionSnapshot(): number {
  return storeVersion;
}

function notify(): void {
  storeVersion += 1;
  for (const listener of versionListeners) listener();
}

function notifyOrigin(origin: string): void {
  const entry = fanoutStore.get(origin);
  if (!entry) return;
  for (const listener of entry.listeners) listener();
}

/**
 * Module-level fan-out store: one poller per origin, shared by every
 * consumer. The sidebar groups, the composer picker and any other
 * `useHostFanout`/`useHostCapabilities` subscriber observe the same rounds —
 * N hosts cost N `capabilities()` requests per interval, never one per
 * consumer. The interval runs while at least one origin is tracked.
 */
const fanoutStore = new Map<string, HostFanoutEntry>();
let pollTimer: number | undefined;

async function pollOrigin(origin: string): Promise<void> {
  const entry = fanoutStore.get(origin);
  if (!entry) return;
  try {
    const capabilities = await getHostClient(origin).capabilities();
    const current = fanoutStore.get(origin);
    if (!current) return;
    // Generation feeds WorkspaceSection's reloadToken: bumping it on every
    // poll re-runs the whole session catalog and visibly flickers the
    // sidebar every 30 s. Only a really different snapshot may advance it.
    const changed =
      current.workspaces === undefined ||
      workspacesSignature(current.workspaces) !==
        workspacesSignature(capabilities.workspaces);
    current.workspaces = capabilities.workspaces;
    current.status = 'online';
    if (changed) current.generation += 1;
    publishSnapshot(current);
    notifyOrigin(origin);
    notify();
  } catch (error) {
    const current = fanoutStore.get(origin);
    if (!current) return;
    // Failed rounds keep the last known workspaces for that host.
    current.status = isUnauthorized(error) ? 'unauthorized' : 'offline';
    publishSnapshot(current);
    notifyOrigin(origin);
    notify();
  }
}

function publishSnapshot(entry: HostFanoutEntry): void {
  entry.snapshot = {
    workspaces: entry.workspaces,
    status: entry.status,
    generation: entry.generation,
  };
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof Error
    ? UNAUTHORIZED_PATTERN.test(error.message)
    : UNAUTHORIZED_PATTERN.test(String(error));
}

/** Content address for a workspaces snapshot: id + identity fields. */
function workspacesSignature(
  workspaces: DaemonCapabilities['workspaces'],
): string {
  return (workspaces ?? [])
    .map((workspace) =>
      [
        workspace.id,
        workspace.cwd,
        workspace.displayName ?? '',
        workspace.trusted ? '1' : '0',
        workspace.primary ? '1' : '0',
        workspace.kind ?? '',
        workspace.removable ? '1' : '0',
      ].join(''),
    )
    .join('');
}

function ensurePollTimer(): void {
  if (pollTimer !== undefined || fanoutStore.size === 0) return;
  pollTimer = window.setInterval(() => {
    for (const origin of fanoutStore.keys()) void pollOrigin(origin);
  }, POLL_MS);
}

function stopPollTimerIfIdle(): void {
  if (pollTimer === undefined || fanoutStore.size > 0) return;
  window.clearInterval(pollTimer);
  pollTimer = undefined;
}

function trackOrigin(origin: string): HostFanoutEntry {
  let entry = fanoutStore.get(origin);
  if (!entry) {
    entry = {
      workspaces: undefined,
      status: 'connecting',
      generation: 0,
      listeners: new Set(),
      snapshot: {
        workspaces: undefined,
        status: 'connecting',
        generation: 0,
      },
    };
    fanoutStore.set(origin, entry);
    void pollOrigin(origin);
    ensurePollTimer();
  }
  return entry;
}

function untrackOrigin(origin: string): void {
  fanoutStore.delete(origin);
  stopPollTimerIfIdle();
}

/**
 * Live `capabilities().workspaces` + connection status for one fan-out host.
 * Shares the store's single poll round with every other consumer; the last
 * successful payload survives later failures (status flips to
 * offline/unauthorized but the rows keep rendering) and hosts are always
 * polled with their own per-origin client.
 */
export function useHostCapabilities(origin: string): HostCapabilitiesState & {
  refresh: () => void;
} {
  const subscribe = useMemo(
    () => (listener: () => void) => {
      const entry = trackOrigin(origin);
      entry.listeners.add(listener);
      return () => {
        const current = fanoutStore.get(origin);
        if (!current) return;
        current.listeners.delete(listener);
        if (current.listeners.size === 0) {
          untrackOrigin(origin);
          dropHostClient(origin);
        }
      };
    },
    [origin],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => fanoutStore.get(origin)?.snapshot,
  );
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    if (refreshTick > 0) void pollOrigin(origin);
  }, [origin, refreshTick]);
  const state: HostCapabilitiesState = snapshot ?? {
    workspaces: undefined,
    status: 'connecting',
    generation: 0,
  };
  return { ...state, refresh: () => setRefreshTick((tick) => tick + 1) };
}

/**
 * The single ordered host set both the sidebar fan-out and App composers
 * render from: every saved workspace host and connected remote origin, minus
 * the focused daemon (its own UI comes from the interactive provider), plus
 * the page origin when focused remote — the "way back" group. Memoized on
 * content so consumers can pass it straight into `useHostFanout`.
 */
export function useFanoutOrigins(): string[] {
  const hosts = useWorkspaceHosts();
  const connections = useRemoteConnections();
  const focused = useDaemonTargetOptional()?.activeOrigin;
  const pageOrigin = window.location.origin;
  return useMemo(() => {
    const origins = new Set<string>([
      ...hosts.map((host) => host.origin),
      ...connections,
    ]);
    const active = focused ?? '';
    origins.delete(active);
    if (active && active !== pageOrigin) {
      origins.add(pageOrigin);
    } else if (active === pageOrigin) {
      origins.delete(pageOrigin);
    }
    return [...origins].sort();
  }, [hosts, connections, focused, pageOrigin]);
}

/**
 * Live connection state + a client for every `origins` entry, drawn from the
 * shared per-origin store: subscribing here never adds a second poller — the
 * composer picker and the sidebar groups observe the same rounds. Failed
 * hosts keep their last-known snapshot; hosts that lose their last
 * subscriber are dropped from the client pool.
 */
export function useHostFanout(origins: readonly string[]): {
  clientsByOrigin: ReadonlyMap<string, DaemonClient>;
  statusByOrigin: ReadonlyMap<string, HostConnectionStatus>;
  workspacesByOrigin: ReadonlyMap<
    string,
    DaemonCapabilities['workspaces'] | undefined
  >;
  refreshAll: () => void;
} {
  const stableOrigins = useMemo(
    () => [...new Set(origins)].sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [origins.join('')],
  );
  const subscribe = useMemo(
    () => (listener: () => void) => {
      for (const origin of stableOrigins) {
        trackOrigin(origin).listeners.add(listener);
      }
      return () => {
        for (const origin of stableOrigins) {
          const entry = fanoutStore.get(origin);
          if (!entry) continue;
          entry.listeners.delete(listener);
          if (entry.listeners.size === 0) {
            untrackOrigin(origin);
            dropHostClient(origin);
          }
        }
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stableOrigins.join('')],
  );
  useSyncExternalStore(subscribe, storeVersionSnapshot, storeVersionSnapshot);
  const clientsByOrigin = new Map<string, DaemonClient>();
  const statusByOrigin = new Map<string, HostConnectionStatus>();
  const workspacesByOrigin = new Map<
    string,
    DaemonCapabilities['workspaces'] | undefined
  >();
  for (const origin of stableOrigins) {
    const entry = fanoutStore.get(origin);
    clientsByOrigin.set(origin, getHostClient(origin));
    statusByOrigin.set(origin, entry?.status ?? 'connecting');
    workspacesByOrigin.set(origin, entry?.workspaces);
  }
  return {
    clientsByOrigin,
    statusByOrigin,
    workspacesByOrigin,
    refreshAll: () => {
      for (const origin of stableOrigins) void pollOrigin(origin);
    },
  };
}
