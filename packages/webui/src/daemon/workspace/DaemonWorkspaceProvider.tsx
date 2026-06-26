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
import type {
  DaemonWorkspaceContextValue,
  DaemonWorkspaceProviderProps,
  DaemonWorkspaceActions,
  DaemonWorkspaceStatus,
} from './types.js';

const DaemonWorkspaceContext = createContext<
  DaemonWorkspaceContextValue | undefined
>(undefined);

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
    void getCapabilities()
      .then((caps) => {
        if (!disposed) {
          setCapabilities(caps);
          setStatus('connected');
        }
      })
      .catch((err: unknown) => {
        if (!disposed) {
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
    return {
      client,
      token,
      baseUrl,
      workspaceCwd: capabilities?.workspaceCwd ?? workspaceCwd,
      status,
      error,
      capabilities,
      getCapabilities,
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
    throw new Error(
      'useDaemonWorkspace must be used within DaemonWorkspaceProvider',
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
