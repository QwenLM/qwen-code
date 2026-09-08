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
import type { DaemonBrand, DaemonCapabilities } from '@qwen-code/sdk/daemon';
import { DaemonClient, DaemonHttpError } from '@qwen-code/sdk/daemon';
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
  const capabilitiesGenerationRef = useRef(0);
  const resolvedCwdRef = useRef<string | undefined>(workspaceCwd);

  const [capabilities, setCapabilities] = useState<
    DaemonCapabilities | undefined
  >(undefined);
  const [brand, setBrand] = useState<DaemonBrand | undefined>(undefined);
  const [brandSettled, setBrandSettled] = useState(false);
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

  // Brand is fetched beside capabilities but deliberately stays out of the
  // connection status machine. An older daemon without `GET /brand`, a logo the
  // daemon rejected, or a daemon still starting must leave the client's built-in
  // brand in place rather than put the shell into an error state. The deferred
  // call covers one more case: `@qwen-code/sdk` is a peer dependency, so a host
  // on an older SDK has no `brand()` method, and calling it directly would throw
  // a synchronous TypeError out of this effect — white-screening the shell over
  // a cosmetic feature. Deferring turns that throw into a rejection the catch
  // below swallows like any other.
  //
  // `brandSettled` is per-client: it flips true once this client's fetch
  // reaches a definitive outcome, and resets to false when the client changes.
  // Consumers must not fire on the in-flight undefined (that would reset
  // cached branding mid-load), but they must learn about the
  // settled-with-no-brand outcome: it is the only way to clear branding
  // cached from an earlier daemon.
  //
  // The fetch runs once per client, but NOT once per page: `refreshBrand`
  // re-issues it for the recovery path (a retryable failure would otherwise
  // leave the brand unsettled for the page's lifetime). The generation
  // counter replaces the single-effect disposed flag so both entry points
  // share one staleness rule — a superseded client's late answer, or a
  // superseded fetch's, can neither write a brand nor settle the current one.
  const brandGenerationRef = useRef(0);
  const brandInFlightRef = useRef(false);
  const fetchBrand = useCallback((brandClient: DaemonClient) => {
    const generation = ++brandGenerationRef.current;
    brandInFlightRef.current = true;
    setBrand(undefined);
    setBrandSettled(false);
    void Promise.resolve()
      .then(() => brandClient.brand())
      .then((resolved) => {
        if (brandGenerationRef.current === generation) {
          setBrand(resolved);
          setBrandSettled(true);
        }
      })
      .catch((error: unknown) => {
        // Silent by design; see the comment above. Settle only on the one
        // definitive "no brand here" answer: a 404 means this daemon has no
        // route and never will. Everything else — a 503 while the deferred
        // runtime is still starting, a 429 from the rate limiter, a transport
        // failure, an old SDK with no `brand()` — is unknown, not absent:
        // settling would report an authoritative empty brand and clear cached
        // chrome over a retryable blip.
        if (
          brandGenerationRef.current === generation &&
          error instanceof DaemonHttpError &&
          error.status === 404
        ) {
          setBrandSettled(true);
        }
      })
      .finally(() => {
        if (brandGenerationRef.current === generation) {
          brandInFlightRef.current = false;
        }
      });
  }, []);
  // Invalidates any in-flight fetch without touching state — stable so the
  // effect cleanup can call it without capturing a ref's `.current`.
  const invalidateBrandFetch = useCallback(() => {
    brandGenerationRef.current++;
    brandInFlightRef.current = false;
  }, []);
  useEffect(() => {
    if (!client) return undefined;
    fetchBrand(client);
    return () => invalidateBrandFetch();
  }, [client, fetchBrand, invalidateBrandFetch]);
  // Retry entry point for the recovery path. Gated to the genuinely-missing
  // state: re-running on an already-resolved brand would blank the shell's
  // chrome mid-session for no reason, re-running on a settled-with-no-brand
  // one would turn a definitive answer back into "loading", and re-running
  // while a fetch is in flight would just supersede it.
  const refreshBrand = useCallback(() => {
    if (clientRef.current === undefined) return;
    if (brand !== undefined || brandSettled || brandInFlightRef.current) {
      return;
    }
    fetchBrand(clientRef.current);
  }, [brand, brandSettled, fetchBrand]);

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
      brand,
      brandSettled,
      getCapabilities,
      refreshCapabilities,
      refreshBrand,
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
    brand,
    brandSettled,
    getCapabilities,
    refreshCapabilities,
    refreshBrand,
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
