/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
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
import type { DaemonCapabilities } from '@qwen-code/sdk/daemon';
import { DaemonClient } from '@qwen-code/sdk/daemon';
import { createDaemonWorkspaceActions } from './actions.js';
import { setBoundedMapEntry } from '../../utils/bounded-map.js';
import type {
  DaemonWorkspaceContextValue,
  DaemonWorkspaceProviderProps,
  DaemonWorkspaceActions,
  DaemonWorkspaceStatus,
} from './types.js';

const DaemonWorkspaceContext = createContext<
  DaemonWorkspaceContextValue | undefined
>(undefined);

// Module-copy marker for diagnosing "must be used within" failures. When the
// page ends up with two copies of this module (a Vite dev module-graph hiccup,
// a host bundling both web-shell entries), each copy has its own
// DaemonWorkspaceContext, so a consumer resolved to one copy reads no provider
// even though a provider from the other copy is mounted. The registry records
// which module copies rendered a provider — and whether they produced a
// context value — so the strict hook's error can say which case it hit. The
// id carries the module URL so the message points at the offending chunk; the
// esbuild iife build for export documents lowers import.meta to {}, hence the
// guarded fallback. Diagnostic only — the context itself is never shared.
const moduleUrl =
  typeof import.meta.url === 'string' && import.meta.url
    ? import.meta.url
    : 'web-shell/DaemonWorkspaceProvider';
const moduleInstanceId = `${moduleUrl}#${Math.random().toString(36).slice(2, 8)}`;

type ProviderCopyState =
  // Rendered, but never produced a context value (e.g. autoConnect={false}).
  | 'rendered'
  // Produced a context value at least once. Terminal state for the copy: a
  // discarded or unmounted render keeps it, and the guard's wording hedges.
  | 'provided';

const PROVIDER_REGISTRY_KEY = '__qwenWebShellDaemonWorkspaceProviderCopies';
// Hot re-evaluation mints a fresh id per save; cap so a long dev session
// cannot grow the breadcrumb (or the error message) without bound.
const MAX_TRACKED_PROVIDER_COPIES = 8;

function providerCopyRegistry(): Map<string, ProviderCopyState> {
  const scope = globalThis as typeof globalThis & {
    [PROVIDER_REGISTRY_KEY]?: Map<string, ProviderCopyState>;
  };
  return (scope[PROVIDER_REGISTRY_KEY] ??= new Map());
}

function recordProviderCopy(id: string, provided: boolean): void {
  const registry = providerCopyRegistry();
  const next: ProviderCopyState =
    provided || registry.get(id) === 'provided' ? 'provided' : 'rendered';
  // Re-recording moves the entry to the newest position, so the cap evicts
  // stale copies (e.g. from hot re-evaluations whose provider is gone),
  // never a live one — a live provider re-records on every render.
  setBoundedMapEntry(registry, id, next, MAX_TRACKED_PROVIDER_COPIES);
}

// Module-level sentinel for deferred-disposal StrictMode guard.
// See the useEffect cleanup in DaemonWorkspaceProvider for details.
let pendingDisposeClient: DaemonClient | undefined;

export type {
  DaemonWorkspaceActions,
  DaemonWorkspaceContextValue,
  DaemonWorkspaceProviderProps,
} from './types.js';

export function DaemonWorkspaceProvider({
  baseUrl,
  token,
  workspaceCwd,
  autoConnect = true,
  transport,
  children,
}: DaemonWorkspaceProviderProps) {
  // Render-phase so the breadcrumb exists before any child can throw, and
  // recorded even when no client is built (autoConnect={false}).
  recordProviderCopy(moduleInstanceId, false);
  const client = useMemo(
    () =>
      autoConnect ? new DaemonClient({ baseUrl, token, transport }) : undefined,
    [autoConnect, baseUrl, token, transport],
  );
  const clientRef = useRef<DaemonClient | undefined>(client);
  clientRef.current = client;
  const capabilitiesClientRef = useRef<DaemonClient | undefined>(undefined);
  const capabilitiesPromiseRef = useRef<
    Promise<DaemonCapabilities> | undefined
  >(undefined);
  const capabilitiesGenerationRef = useRef(0);
  const resolvedCwdRef = useRef<string | undefined>(workspaceCwd);

  const [capabilities, setCapabilities] = useState<
    DaemonCapabilities | undefined
  >(undefined);
  const [status, setStatus] = useState<DaemonWorkspaceStatus>(
    autoConnect ? 'connecting' : 'idle',
  );
  const [error, setError] = useState<Error | undefined>(undefined);
  const getCapabilities = useCallback(() => {
    if (!client) {
      return Promise.reject(new Error('Daemon workspace client unavailable'));
    }
    if (capabilitiesClientRef.current !== client) {
      capabilitiesClientRef.current = client;
      capabilitiesPromiseRef.current = undefined;
      capabilitiesGenerationRef.current++;
    }
    if (!capabilitiesPromiseRef.current) {
      const promise = client.capabilities().catch((error: unknown) => {
        if (capabilitiesPromiseRef.current === promise) {
          capabilitiesPromiseRef.current = undefined;
        }
        throw error;
      });
      capabilitiesPromiseRef.current = promise;
    }
    return capabilitiesPromiseRef.current;
  }, [client]);

  // Force a fresh capabilities fetch and update state. `getCapabilities`
  // memoizes its first in-flight promise and only feeds `setCapabilities`
  // from the mount effect, so callers that mutate capabilities at runtime
  // (e.g. registering a workspace) would otherwise see no change until a
  // full reload. This bypasses the cache, replaces the cached promise so
  // later `getCapabilities` callers see the new value too, and pushes the
  // result into state.
  const refreshCapabilities = useCallback(() => {
    if (!client) {
      return Promise.reject(new Error('Daemon workspace client unavailable'));
    }
    if (capabilitiesClientRef.current !== client) {
      capabilitiesClientRef.current = client;
      capabilitiesGenerationRef.current++;
    }
    const generation = ++capabilitiesGenerationRef.current;
    // Superseded callers must observe the accepted successor, not the stale
    // payload they happened to receive from their own HTTP request.
    const followAcceptedSuccessor = (): Promise<DaemonCapabilities> => {
      const successor = capabilitiesPromiseRef.current;
      if (
        capabilitiesClientRef.current === client &&
        successor &&
        capabilitiesGenerationRef.current !== generation
      ) {
        return successor;
      }
      return Promise.reject(
        new Error('Capabilities refresh was superseded by a client change'),
      );
    };
    const acceptedPromise = client.capabilities().then(
      (caps) => {
        if (
          capabilitiesClientRef.current !== client ||
          capabilitiesGenerationRef.current !== generation
        ) {
          return followAcceptedSuccessor();
        }
        setCapabilities(caps);
        setStatus('connected');
        setError(undefined);
        return caps;
      },
      (error: unknown) => {
        if (
          capabilitiesClientRef.current !== client ||
          capabilitiesGenerationRef.current !== generation
        ) {
          return followAcceptedSuccessor();
        }
        setError(error instanceof Error ? error : new Error(String(error)));
        setStatus('error');
        throw error;
      },
    );
    capabilitiesPromiseRef.current = acceptedPromise;
    return acceptedPromise;
  }, [client]);

  useEffect(() => {
    if (!client) return undefined;
    setStatus('connecting');
    setError(undefined);
    setCapabilities(undefined);

    // Cancel any pending deferred disposal from a previous cleanup (handles
    // React StrictMode double-invocation: the first cleanup schedules a
    // disposal microtask, but the synchronous second mount cancels it).
    if (pendingDisposeClient === client) {
      pendingDisposeClient = undefined;
    }

    let disposed = false;
    const initialPromise = getCapabilities();
    void initialPromise
      .then((caps) => {
        // A user-triggered refresh may supersede the mount request before it
        // resolves; only the still-current promise may initialize state.
        if (
          !disposed &&
          capabilitiesClientRef.current === client &&
          capabilitiesPromiseRef.current === initialPromise
        ) {
          setCapabilities(caps);
          setStatus('connected');
        }
      })
      .catch((err: unknown) => {
        if (
          !disposed &&
          capabilitiesClientRef.current === client &&
          capabilitiesPromiseRef.current === initialPromise
        ) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setStatus('error');
        }
      });

    return () => {
      disposed = true;
      // Defer disposal by one microtask. In StrictMode the synchronous
      // re-mount cancels disposal before the microtask fires, preserving
      // the memoized client. On real unmount or client replacement no
      // cancellation occurs and disposal proceeds.
      pendingDisposeClient = client;
      queueMicrotask(() => {
        if (pendingDisposeClient === client) {
          pendingDisposeClient = undefined;
          client.dispose();
        }
      });
    };
  }, [client, getCapabilities]);

  resolvedCwdRef.current = capabilities?.workspaceCwd ?? workspaceCwd;

  const workspaceActions = useMemo<DaemonWorkspaceActions>(
    () =>
      createDaemonWorkspaceActions({
        getClient: () => clientRef.current,
        getWorkspaceCwd: () => resolvedCwdRef.current,
        baseUrl,
        token,
      }),
    [baseUrl, token],
  );

  const contextValue = useMemo<DaemonWorkspaceContextValue | undefined>(() => {
    if (!client) return undefined;
    recordProviderCopy(moduleInstanceId, true);
    return {
      client,
      token,
      baseUrl,
      workspaceCwd: capabilities?.workspaceCwd ?? workspaceCwd,
      status,
      error,
      capabilities,
      getCapabilities,
      refreshCapabilities,
      actions: workspaceActions,
    };
  }, [
    client,
    token,
    baseUrl,
    workspaceCwd,
    status,
    error,
    capabilities,
    getCapabilities,
    refreshCapabilities,
    workspaceActions,
  ]);

  return (
    <DaemonWorkspaceContext.Provider value={contextValue}>
      {children}
    </DaemonWorkspaceContext.Provider>
  );
}

export function useDaemonWorkspace(): DaemonWorkspaceContextValue {
  const context = useContext(DaemonWorkspaceContext);
  if (!context) {
    const registry = providerCopyRegistry();
    const ownState = registry.get(moduleInstanceId);
    const foreignIds = [...registry.keys()].filter(
      (id) => id !== moduleInstanceId,
    );
    const detail =
      foreignIds.length > 0
        ? `a DaemonWorkspaceProvider rendered from module copy ` +
          `${foreignIds.join(', ')}, but this hook resolved module copy ` +
          `${moduleInstanceId} — the page holds duplicate copies of the ` +
          `DaemonWorkspaceProvider module`
        : ownState === 'provided'
          ? 'a DaemonWorkspaceProvider from this module copy has rendered, ' +
            'so this consumer is outside its live subtree, that provider ' +
            'has unmounted, or it currently has no active client ' +
            '(autoConnect is false)'
          : ownState === 'rendered'
            ? 'a DaemonWorkspaceProvider from this module copy has rendered ' +
              'without an active client (e.g. autoConnect is false), or ' +
              'has since unmounted, so it provides no workspace context'
            : 'no DaemonWorkspaceProvider has rendered in this page';
    throw new Error(
      `useDaemonWorkspace must be used within DaemonWorkspaceProvider ` +
        `(${detail})`,
    );
  }
  return context;
}

export function useDaemonWorkspaceActions(): DaemonWorkspaceActions {
  const context = useDaemonWorkspace();
  return context.actions;
}

/**
 * Returns the workspace context if available, or undefined if no ancestor
 * `DaemonWorkspaceProvider` exists. Useful for optional integration.
 */
export function useOptionalDaemonWorkspace():
  | DaemonWorkspaceContextValue
  | undefined {
  return useContext(DaemonWorkspaceContext);
}
