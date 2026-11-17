/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DaemonLiveHostInstallState,
  DaemonLiveSetupStatus,
  DaemonLiveSetupUpdate,
} from '@qwen-code/sdk';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import {
  useDaemonAvailability,
  useDaemonAvailabilityController,
} from '../daemon/availability-context.js';
import { isDaemonUnavailableError } from '../daemon/availability.js';
import { useI18n } from '../i18n';

const POLL_INTERVAL_MS = 1_000;
// After an install/launch the host app needs a few seconds to say hello; stop
// waiting after a bounded window so a host that never runs does not poll
// forever — the focus/visibility refresh remains as the recovery path.
const HOST_READY_WAIT_MS = 30_000;

export const INSTALLING_STATES: ReadonlySet<DaemonLiveHostInstallState> =
  new Set(['checking', 'downloading', 'verifying', 'installing', 'launching']);

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

export function useLiveVoiceSetup(
  supported: boolean,
  active = true,
  translate?: (key: string) => string,
): UseLiveVoiceSetupResult {
  const workspace = useWorkspace();
  const availability = useDaemonAvailability();
  const availabilityController = useDaemonAvailabilityController();
  // App calls this above the I18nProvider it renders, where the context
  // default is a key passthrough; the caller's own translator must win.
  const { t: contextT } = useI18n();
  const t = translate ?? contextT;
  const translateRef = useRef(t);
  translateRef.current = t;
  const [status, setStatus] = useState<DaemonLiveSetupStatus>();
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [refreshError, setRefreshError] = useState<Error>();
  const [mutationError, setMutationError] = useState<Error>();
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const pollGenerationRef = useRef(0);
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
    if (
      !supported ||
      !active ||
      (availabilityController &&
        availabilityController.getSnapshot() !== 'available')
    )
      return;
    if (mutationRef.current !== undefined) return;
    const generation = pollGenerationRef.current;
    if (requestRef.current?.generation === generation) {
      return await requestRef.current.promise;
    }
    const request = (async () => {
      setLoading(true);
      try {
        const next = await workspace.client.liveSetupStatus();
        if (mountedRef.current && pollGenerationRef.current === generation) {
          setStatus(next);
          setRefreshError(undefined);
        }
      } catch (cause) {
        if (mountedRef.current && pollGenerationRef.current === generation) {
          setRefreshError(
            isDaemonUnavailableError(cause)
              ? new Error(translateRef.current('daemon.connection.unavailable'))
              : cause instanceof Error
                ? cause
                : new Error(String(cause)),
          );
        }
      } finally {
        if (mountedRef.current && pollGenerationRef.current === generation) {
          setLoading(false);
        }
        if (requestRef.current?.generation === generation) {
          requestRef.current = undefined;
        }
      }
    })();
    requestRef.current = { generation, promise: request };
    return await request;
  }, [supported, active, workspace.client, availabilityController]);

  useEffect(() => {
    if (
      contextRef.current.client !== workspace.client ||
      contextRef.current.supported !== supported
    ) {
      contextRef.current = { client: workspace.client, supported };
      generationRef.current += 1;
      pollGenerationRef.current += 1;
      requestRef.current = undefined;
      mutationRef.current = undefined;
    }
    setStatus(undefined);
    setLoading(false);
    setMutating(false);
    setRefreshError(undefined);
    setMutationError(undefined);
  }, [supported, workspace.client]);

  useEffect(() => {
    if (availability !== 'available') {
      pollGenerationRef.current += 1;
      requestRef.current = undefined;
      setLoading(false);
      return;
    }
    if (!supported || !active) return undefined;
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [availability, refresh, supported, active, workspace.client]);

  const hostWaiting = Boolean(
    status?.enabled &&
      status.install.state === 'installed' &&
      status.live.requirements?.host !== 'ready',
  );
  const [hostWaitExpired, setHostWaitExpired] = useState(false);
  useEffect(() => {
    if (!hostWaiting) {
      setHostWaitExpired(false);
      return;
    }
    const timer = window.setTimeout(
      () => setHostWaitExpired(true),
      HOST_READY_WAIT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [hostWaiting]);

  const statusPending =
    !status ||
    Boolean(refreshError) ||
    INSTALLING_STATES.has(status.install.state) ||
    (hostWaiting && !hostWaitExpired);
  useEffect(() => {
    if (!supported || !active || !statusPending || availability !== 'available')
      return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [availability, supported, active, statusPending, refresh]);

  const mutate = useCallback(
    async (operation: () => Promise<DaemonLiveSetupStatus>): Promise<void> => {
      const generation = generationRef.current;
      if (mutationRef.current === generation) return;
      generationRef.current += 1;
      pollGenerationRef.current += 1;
      requestRef.current = undefined;
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
        const nextError = isDaemonUnavailableError(cause)
          ? new Error(translateRef.current('daemon.connection.unavailable'))
          : cause instanceof Error
            ? cause
            : new Error(String(cause));
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
    error:
      availability === 'available'
        ? (mutationError ?? refreshError)
        : new Error(
            t(
              availability === 'auth-required'
                ? 'daemon.connection.authRequired'
                : 'daemon.connection.unavailable',
            ),
          ),
    refresh,
    update,
    retryInstall,
    launchHost,
  };
}
