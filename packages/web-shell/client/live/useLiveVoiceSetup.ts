/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DaemonLiveSetupStatus,
  DaemonLiveSetupUpdate,
} from '@qwen-code/sdk';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';

const POLL_INTERVAL_MS = 1_000;

export interface UseLiveVoiceSetupResult {
  supported: boolean;
  status: DaemonLiveSetupStatus | undefined;
  loading: boolean;
  mutating: boolean;
  error: Error | undefined;
  refresh: () => Promise<void>;
  update: (update: DaemonLiveSetupUpdate) => Promise<void>;
  retryInstall: () => Promise<void>;
  launchHost: () => Promise<void>;
}

export function useLiveVoiceSetup(supported: boolean): UseLiveVoiceSetupResult {
  const workspace = useWorkspace();
  const [status, setStatus] = useState<DaemonLiveSetupStatus>();
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [refreshError, setRefreshError] = useState<Error>();
  const [mutationError, setMutationError] = useState<Error>();
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const contextRef = useRef({ client: workspace.client, supported });
  const requestRef = useRef<
    { generation: number; promise: Promise<void> } | undefined
  >(undefined);
  const mutationRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!supported) return;
    const generation = generationRef.current;
    if (mutationRef.current === generation) return;
    if (requestRef.current?.generation === generation) {
      return await requestRef.current.promise;
    }
    const request = (async () => {
      setLoading(true);
      try {
        const next = await workspace.client.liveSetupStatus();
        if (mountedRef.current && generationRef.current === generation) {
          setStatus(next);
          setRefreshError(undefined);
        }
      } catch (cause) {
        if (mountedRef.current && generationRef.current === generation) {
          setRefreshError(
            cause instanceof Error ? cause : new Error(String(cause)),
          );
        }
      } finally {
        if (mountedRef.current && generationRef.current === generation) {
          setLoading(false);
        }
        if (requestRef.current?.generation === generation) {
          requestRef.current = undefined;
        }
      }
    })();
    requestRef.current = { generation, promise: request };
    return await request;
  }, [supported, workspace.client]);

  useEffect(() => {
    if (
      contextRef.current.client !== workspace.client ||
      contextRef.current.supported !== supported
    ) {
      contextRef.current = { client: workspace.client, supported };
      generationRef.current += 1;
      mutationRef.current = undefined;
    }
    setStatus(undefined);
    setLoading(false);
    setMutating(false);
    setRefreshError(undefined);
    setMutationError(undefined);
    if (!supported) return undefined;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refresh, supported, workspace.client]);

  const mutate = useCallback(
    async (operation: () => Promise<DaemonLiveSetupStatus>): Promise<void> => {
      const generation = generationRef.current;
      if (mutationRef.current === generation) return;
      generationRef.current += 1;
      const mutationGeneration = generationRef.current;
      mutationRef.current = mutationGeneration;
      setLoading(false);
      setMutating(true);
      setMutationError(undefined);
      try {
        const next = await operation();
        if (
          mountedRef.current &&
          generationRef.current === mutationGeneration
        ) {
          setStatus(next);
        }
      } catch (cause) {
        const nextError =
          cause instanceof Error ? cause : new Error(String(cause));
        if (
          mountedRef.current &&
          generationRef.current === mutationGeneration
        ) {
          setMutationError(nextError);
        }
        throw nextError;
      } finally {
        if (mutationRef.current === mutationGeneration) {
          mutationRef.current = undefined;
          if (mountedRef.current) setMutating(false);
        }
      }
    },
    [],
  );

  const update = useCallback(
    async (next: DaemonLiveSetupUpdate) =>
      mutate(() => workspace.client.updateLiveSetup(next)),
    [mutate, workspace.client],
  );
  const retryInstall = useCallback(
    async () => mutate(() => workspace.client.retryLiveHostInstall()),
    [mutate, workspace.client],
  );
  const launchHost = useCallback(
    async () => mutate(() => workspace.client.launchLiveHost()),
    [mutate, workspace.client],
  );

  return {
    supported,
    status,
    loading,
    mutating,
    error: mutationError ?? refreshError,
    refresh,
    update,
    retryInstall,
    launchHost,
  };
}
