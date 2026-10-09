/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Focused-daemon controller for the multi-daemon Web Shell (#13727).
 *
 * One daemon is "focused": it owns the interactive `DaemonWorkspaceProvider`
 * subtree (chat, composer, terminals). Every saved host stays connected for
 * reads through the fan-out pool (`host-fanout.ts`). Switching the focused
 * host inside the CSP-covered set is a React state change plus a
 * `history.replaceState` — the document never reloads, so there is no flash.
 *
 * The served CSP only covers origins named in `?daemon=`/`?fanout=` at
 * document load; connecting a host outside that set must still navigate once
 * to re-serve the shell with a widened policy. `coversOrigin` answers which
 * case a target is.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import {
  getAllowedDaemonOrigin,
  getDaemonBaseUrl,
  getDaemonToken,
  getFanoutOrigins,
  syncFanoutParams,
} from './daemon';
import {
  readRemoteConnections,
  REMOTE_CONNECTIONS_CHANGE_EVENT,
} from './remote-connections';
import {
  readWorkspaceHosts,
  WORKSPACE_HOSTS_CHANGE_EVENT,
} from './workspace-hosts';

export interface FocusHostTarget {
  origin: string;
  /** Preselect this workspace on the new host (by id), or clear otherwise. */
  workspaceId?: string;
}

/**
 * One-shot intent carried across a focused-host switch: the remounted app
 * performs it against the NEW host's provider (composer create on a picked
 * workspace, or open an existing session). Kept here because this provider
 * sits outside the interactive provider's remount boundary.
 */
export interface HostHandoff {
  kind: 'create' | 'open';
  /** The focused host this intent belongs to — stale intents are dropped. */
  origin: string;
  workspaceCwd?: string;
  sessionId?: string;
  /** Composer text to restore on the new host (attachments cannot carry). */
  draftText?: string;
}

export interface DaemonTargetController {
  /** The focused daemon origin (page origin when no `?daemon=` is active). */
  activeOrigin: string;
  /** Origins the current document may open network connections to. */
  coveredOrigins: ReadonlySet<string>;
  coversOrigin(origin: string): boolean;
  /**
   * Focus another CSP-covered host: remounts the interactive provider at the
   * new origin and rewrites `?daemon=` (+ optional `?workspace=`) in place.
   * Never navigates; throws on an uncovered origin — callers must route those
   * through the navigation-based connect flow instead.
   */
  focusHost(target: FocusHostTarget): void;
  /** Token for the focused host, read per render so token edits re-key it. */
  activeToken: string | undefined;
  /**
   * Focus another host and hand an intent to the remounted app. The app
   * drains it via `takePendingHandoff` once the new provider is connected
   * (create a session in that workspace / open that session there).
   */
  focusHostWithHandoff(target: FocusHostTarget, handoff: HostHandoff): void;
  /** Pending intent from the latest focus switch; consumed exactly once. */
  pendingHandoff: HostHandoff | undefined;
  takePendingHandoff(): HostHandoff | undefined;
}

const DaemonTargetContext = createContext<DaemonTargetController | undefined>(
  undefined,
);

function pageOrigin(): string {
  return window.location.origin;
}

function activeUrlOrigin(): string {
  return getDaemonBaseUrl() || pageOrigin();
}

function applyFocusToUrl(target: FocusHostTarget): void {
  const url = new URL(window.location.href);
  if (target.origin === pageOrigin()) {
    url.searchParams.delete('daemon');
  } else {
    url.searchParams.set('daemon', target.origin);
  }
  if (target.workspaceId) {
    url.searchParams.set('workspace', target.workspaceId);
  } else {
    url.searchParams.delete('workspace');
  }
  // A focused switch always leaves the previous host's session surface.
  url.searchParams.delete('context');
  window.history.replaceState(window.history.state, '', url);
}

export function DaemonTargetProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  // Boot freezes the first focused origin; the document's CSP was served for
  // exactly the boot daemon + fanout set, so `coveredOrigins` is stable for
  // the document's lifetime.
  const [activeOrigin, setActiveOrigin] = useState(activeUrlOrigin);
  const coveredOrigins = useMemo<ReadonlySet<string>>(
    () => new Set([pageOrigin(), activeUrlOrigin(), ...getFanoutOrigins()]),
    [],
  );
  const [pendingHandoffState, setPendingHandoffState] = useState<
    HostHandoff | undefined
  >(undefined);
  // Reads must be synchronous: state updaters run at commit time, so a
  // take-then-read through setState would always see the pre-take value.
  const pendingHandoffRef = useRef(pendingHandoffState);
  pendingHandoffRef.current = pendingHandoffState;
  const setPendingHandoff = useCallback((handoff: HostHandoff | undefined) => {
    pendingHandoffRef.current = handoff;
    setPendingHandoffState(handoff);
  }, []);
  const pendingHandoff = pendingHandoffState;
  const focusHost = useCallback(
    (target: FocusHostTarget) => {
      const origin = getAllowedDaemonOrigin(target.origin);
      if (!origin || !coveredOrigins.has(origin)) {
        throw new Error(
          `Refusing to focus an origin the current document cannot reach: ${target.origin}`,
        );
      }
      applyFocusToUrl({ ...target, origin });
      setActiveOrigin(origin);
    },
    [coveredOrigins],
  );
  const focusHostWithHandoff = useCallback(
    (target: FocusHostTarget, handoff: HostHandoff) => {
      setPendingHandoff(handoff);
      focusHost(target);
    },
    [focusHost, setPendingHandoff],
  );
  const takePendingHandoff = useCallback(() => {
    const taken = pendingHandoffRef.current;
    setPendingHandoff(undefined);
    return taken;
  }, [setPendingHandoff]);
  const value = useMemo<DaemonTargetController>(
    () => ({
      activeOrigin,
      coveredOrigins,
      coversOrigin: (origin) =>
        coveredOrigins.has(getAllowedDaemonOrigin(origin) || ''),
      focusHost,
      activeToken: getDaemonToken(activeOrigin),
      focusHostWithHandoff,
      pendingHandoff,
      takePendingHandoff,
    }),
    [
      activeOrigin,
      coveredOrigins,
      focusHost,
      focusHostWithHandoff,
      pendingHandoff,
      takePendingHandoff,
    ],
  );
  return (
    <DaemonTargetContext.Provider value={value}>
      {children}
    </DaemonTargetContext.Provider>
  );
}

export function useDaemonTarget(): DaemonTargetController {
  const controller = useContext(DaemonTargetContext);
  if (!controller) {
    throw new Error(
      'useDaemonTarget requires DaemonTargetProvider (standalone shell)',
    );
  }
  return controller;
}

/** Optional-context variant for components rendered both inside and outside
 * the standalone tree (tests, embedded shells without the provider). */
export function useDaemonTargetOptional(): DaemonTargetController | undefined {
  return useContext(DaemonTargetContext);
}

/**
 * Intercept same-origin anchor clicks that point at another connected host
 * (#13727): a transcript/session link with `?daemon=B` would otherwise
 * hard-reload the document, losing all sidebar and composer state. When the
 * target is inside the CSP-covered set the click becomes an in-app focus
 * switch (open that session there); anything uncovered keeps the default
 * navigation, which still re-serves the shell widened for the host.
 */
export function useInterceptHostLinks(): void {
  const controller = useDaemonTargetOptional();
  useEffect(() => {
    if (!controller) return undefined;
    const handler = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!anchor) return;
      let url: URL;
      try {
        url = new URL(anchor.getAttribute('href') ?? '', window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      const raw = url.searchParams.get('daemon');
      if (!raw) return; // Same-daemon links: the SPA router already owns them.
      const daemon = getAllowedDaemonOrigin(raw);
      if (!daemon || daemon === controller.activeOrigin) return;
      if (!controller.coversOrigin(daemon)) return;
      event.preventDefault();
      const sessionMatch = url.pathname.match(/\/session\/([^/]+)/);
      const sessionId = sessionMatch?.[1]
        ? decodeURIComponent(sessionMatch[1])
        : undefined;
      controller.focusHostWithHandoff(
        { origin: daemon },
        sessionId
          ? { kind: 'open', origin: daemon, sessionId }
          : { kind: 'create', origin: daemon },
      );
    };
    document.addEventListener('click', handler, true);
    return () => document.removeEventListener('click', handler, true);
  }, [controller]);
}

/**
 * Keep the URL's `fanout` params equal to the saved-host set minus the
 * focused daemon (which `?daemon=` already covers). Runs on mount, on host
 * catalog changes, on focus switches, on cross-tab storage writes, and when
 * the tab regains focus (settings flows that edited catalogs in place).
 * `replaceState` only — the current document's CSP is unaffected.
 */
export function useFanoutUrlSync(): void {
  const { activeOrigin } = useDaemonTarget();
  useEffect(() => {
    const sync = () => {
      const hosts = new Set([
        ...readWorkspaceHosts().map((host) => host.origin),
        ...readRemoteConnections(),
      ]);
      hosts.delete(activeOrigin);
      syncFanoutParams([...hosts]);
    };
    sync();
    window.addEventListener(WORKSPACE_HOSTS_CHANGE_EVENT, sync);
    window.addEventListener(REMOTE_CONNECTIONS_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    window.addEventListener('focus', sync);
    return () => {
      window.removeEventListener(WORKSPACE_HOSTS_CHANGE_EVENT, sync);
      window.removeEventListener(REMOTE_CONNECTIONS_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
      window.removeEventListener('focus', sync);
    };
  }, [activeOrigin]);
}
