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
 */

import { useEffect, useMemo, useState } from 'react';
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
 * instance (its next request fails) and its entry is dropped by
 * `dropHostClient` when the host is removed from the saved set.
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

export function dropHostClient(origin: string): void {
  clients.get(origin)?.client.dispose();
  clients.delete(origin);
}

/** The hosts this page currently fans out to: saved workspace hosts minus
 * the focused daemon, plus the page origin when the focused daemon is remote
 * (the "way back" group). Callers compose the focused origin separately. */

const POLL_MS = 30_000;
const UNAUTHORIZED_PATTERN = /401|unauthori[sz]ed/i;

function isUnauthorized(error: unknown): boolean {
  return error instanceof Error
    ? UNAUTHORIZED_PATTERN.test(error.message)
    : UNAUTHORIZED_PATTERN.test(String(error));
}

/**
 * Live connection state + a client for every `origins` entry. Polls
 * `capabilities()` per host and on a slow cadence; a failed round marks the
 * host offline (or unauthorized on a 401-class error) without tearing the
 * client down — the group keeps rendering its last-known snapshot.
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
  const clientsByOrigin = useMemo(() => {
    const map = new Map<string, DaemonClient>();
    for (const origin of stableOrigins) map.set(origin, getHostClient(origin));
    return map;
  }, [stableOrigins]);
  const [statusByOrigin, setStatusByOrigin] = useState<
    ReadonlyMap<string, HostConnectionStatus>
  >(new Map());
  const [workspacesByOrigin, setWorkspacesByOrigin] = useState<
    ReadonlyMap<string, DaemonCapabilities['workspaces'] | undefined>
  >(new Map());
  const [round, setRound] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      const entries = await Promise.all(
        stableOrigins.map(async (origin) => {
          const client = clientsByOrigin.get(origin);
          if (!client) return undefined;
          try {
            const capabilities = await client.capabilities();
            return [origin, 'online', capabilities.workspaces] as const;
          } catch (error) {
            return [
              origin,
              isUnauthorized(error) ? 'unauthorized' : 'offline',
              undefined,
            ] as const;
          }
        }),
      );
      if (cancelled) return;
      // Hosts that left the set lose their client and their row entirely.
      for (const origin of [...clients.keys()]) {
        if (!stableOrigins.includes(origin)) dropHostClient(origin);
      }
      setStatusByOrigin(() => {
        const next = new Map<string, HostConnectionStatus>();
        for (const entry of entries) {
          if (entry) next.set(entry[0], entry[1]);
        }
        return next;
      });
      setWorkspacesByOrigin((previous) => {
        const next = new Map(previous);
        for (const origin of [...next.keys()]) {
          if (!stableOrigins.includes(origin)) next.delete(origin);
        }
        for (const entry of entries) {
          if (!entry) continue;
          // Failed rounds keep the last known workspaces for that host.
          if (entry[2] !== undefined) next.set(entry[0], entry[2]);
        }
        return next;
      });
    };
    setStatusByOrigin((previous) => {
      const next = new Map(previous);
      for (const origin of stableOrigins) {
        if (!next.has(origin)) next.set(origin, 'connecting');
      }
      return next;
    });
    void probe();
    const timer = setInterval(probe, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [clientsByOrigin, stableOrigins, round]);

  return {
    clientsByOrigin,
    statusByOrigin,
    workspacesByOrigin,
    refreshAll: () => setRound((value) => value + 1),
  };
}

export const HOST_FANOUT_POLL_MS = POLL_MS;

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

export interface HostCapabilitiesState {
  workspaces: DaemonCapabilities['workspaces'];
  status: HostConnectionStatus;
  /** Bumps on every successful refresh so poll consumers can resubscribe. */
  generation: number;
}

/**
 * Live `capabilities().workspaces` for one fan-out host, refreshed on mount
 * and on a slow cadence. The last successful payload survives later failures
 * (status flips to offline/unauthorized but the rows keep rendering) and
 * hosts are always polled with their own per-origin client.
 */
export function useHostCapabilities(origin: string): HostCapabilitiesState {
  const [state, setState] = useState<HostCapabilitiesState>({
    workspaces: undefined,
    status: 'connecting',
    generation: 0,
  });
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const capabilities = await getHostClient(origin).capabilities();
        if (cancelled) return;
        setState((previous) => ({
          workspaces: capabilities.workspaces,
          status: 'online',
          generation: previous.generation + 1,
        }));
      } catch (error) {
        if (cancelled) return;
        setState((previous) => ({
          ...previous,
          status: isUnauthorized(error) ? 'unauthorized' : 'offline',
        }));
      }
    };
    setState((previous) => ({ ...previous, status: 'connecting' }));
    void refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [origin]);
  return state;
}
