/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonLiveMuteUpdate, DaemonLiveStatus } from '@qwen-code/sdk';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import { useSessionCatalogController } from '../session-catalog/session-catalog-hooks';
import {
  useLiveBrowserHost,
  type UseLiveBrowserHostResult,
} from './useLiveBrowserHost';
import { getLivePresence, setLivePresence } from './live-presence';

// A native macOS Host can attach (`/live/host`).
const LIVE_NATIVE_FEATURE = 'realtime_voice';
// This page may itself be the audio endpoint (`/live/web`), on any platform.
const LIVE_BROWSER_FEATURE = 'realtime_voice_web';
const POLL_INTERVAL_MS = 1_000;

export interface UseLiveVoiceResult {
  /** Either kind of Host is available on this daemon. */
  supported: boolean;
  nativeSupported: boolean;
  browserSupported: boolean;
  /** This page as the audio endpoint; idle until the user connects it. */
  browserHost: UseLiveBrowserHostResult;
  status: DaemonLiveStatus | undefined;
  loading: boolean;
  mutating: boolean;
  refresh: () => Promise<void>;
  begin: () => void;
  cancelPending: () => void;
  start: (mode?: 'resume' | 'new') => Promise<void>;
  stop: () => Promise<void>;
  setMute: (update: DaemonLiveMuteUpdate) => Promise<void>;
}

function unavailableStatus(message: string): DaemonLiveStatus {
  return {
    v: 1,
    available: false,
    state: 'error',
    shortcut: '',
    message,
  };
}

export function useLiveVoice(): UseLiveVoiceResult {
  const workspace = useWorkspace();
  const sessionCatalog = useSessionCatalogController(workspace.client);
  const features = workspace.capabilities?.features ?? [];
  const nativeSupported = features.includes(LIVE_NATIVE_FEATURE);
  const browserSupported = features.includes(LIVE_BROWSER_FEATURE);
  const supported = nativeSupported || browserSupported;
  const [status, setStatus] = useState<DaemonLiveStatus>();
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  // Polls and pushes share a validity counter of their own: a push must
  // retire an older in-flight poll without invalidating a mutation, whose
  // identity is generationRef/mutationRef.
  const pollGenerationRef = useRef(0);
  const contextRef = useRef({ client: workspace.client, supported });
  const requestRef = useRef<Promise<void> | undefined>(undefined);
  const mutationRef = useRef<number | undefined>(undefined);
  const discoveredSessionRef = useRef<
    | {
        client: typeof workspace.client;
        sessionId: string;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!supported) return;
    // A mutation in flight delivers its own status; polling now would race it.
    if (mutationRef.current !== undefined) return;
    // Dedupe on the in-flight request itself. The poll generation cannot key
    // this: every push bumps it (to retire stale answers), so under a chatty
    // Host each interval would stack another identical liveStatus request.
    if (requestRef.current) return await requestRef.current;
    const generation = pollGenerationRef.current;
    // Not an IIFE: a self-referencing one fails `tsc` definite assignment
    // (TS2454), since the `finally` below names `request` mid-initializer.
    const run = async (): Promise<void> => {
      setLoading(true);
      try {
        const next = await workspace.client.liveStatus();
        if (mountedRef.current && pollGenerationRef.current === generation) {
          setStatus(next);
        }
      } catch (error) {
        if (mountedRef.current && pollGenerationRef.current === generation) {
          setStatus(
            unavailableStatus(
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      } finally {
        if (mountedRef.current && pollGenerationRef.current === generation) {
          setLoading(false);
        }
        if (requestRef.current === request) {
          requestRef.current = undefined;
        }
      }
    };
    const request = run();
    requestRef.current = request;
    return await request;
  }, [supported, workspace.client]);

  useEffect(() => {
    if (
      contextRef.current.client !== workspace.client ||
      contextRef.current.supported !== supported
    ) {
      contextRef.current = { client: workspace.client, supported };
      generationRef.current += 1;
      pollGenerationRef.current += 1;
      mutationRef.current = undefined;
      // A request still pending on the replaced client must not absorb the
      // first refresh against the new one.
      requestRef.current = undefined;
    }
    setStatus(undefined);
    setLoading(false);
    setMutating(false);
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
    async (operation: () => Promise<DaemonLiveStatus>): Promise<void> => {
      if (mutationRef.current !== undefined) return;
      generationRef.current += 1;
      const mutationGeneration = generationRef.current;
      mutationRef.current = mutationGeneration;
      // A poll answered now predates the mutation's own outcome.
      pollGenerationRef.current += 1;
      setLoading(false);
      setMutating(true);
      try {
        const next = await operation();
        if (
          mountedRef.current &&
          generationRef.current === mutationGeneration
        ) {
          setStatus(next);
        }
      } catch (error) {
        if (
          mountedRef.current &&
          generationRef.current === mutationGeneration
        ) {
          setStatus(
            unavailableStatus(
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      } finally {
        if (mutationRef.current === mutationGeneration) {
          mutationRef.current = undefined;
          if (mountedRef.current) setMutating(false);
        }
      }
    },
    [],
  );

  const start = useCallback(
    async (mode: 'resume' | 'new' = 'resume') =>
      mutate(() => workspace.client.startLive(mode)),
    [mutate, workspace.client],
  );
  const stop = useCallback(
    async () => mutate(() => workspace.client.stopLive()),
    [mutate, workspace.client],
  );
  const setMute = useCallback(
    async (update: DaemonLiveMuteUpdate) =>
      mutate(() => workspace.client.setLiveMute(update)),
    [mutate, workspace.client],
  );

  const begin = useCallback(() => {
    if (!getLivePresence(workspace.client)) {
      setLivePresence(workspace.client, { state: 'connecting' });
    }
  }, [workspace.client]);
  const cancelPending = useCallback(() => {
    if (getLivePresence(workspace.client)?.state === 'connecting') {
      setLivePresence(workspace.client, undefined);
    }
  }, [workspace.client]);

  useEffect(() => {
    if (!status) return;
    if (
      ['starting', 'listening', 'thinking', 'speaking', 'stopping'].includes(
        status.state,
      )
    ) {
      setLivePresence(workspace.client, {
        callId: status.callId,
        state: status.state,
        coordinator: status.coordinator,
      });
    } else if (
      status.state === 'error' ||
      (status.state === 'unavailable' &&
        status.blocker !== 'host_missing' &&
        status.blocker !== 'host_disconnected') ||
      (status.state === 'idle' &&
        getLivePresence(workspace.client)?.state !== 'connecting')
    ) {
      setLivePresence(workspace.client, undefined);
    }
  }, [status, workspace.client]);

  useEffect(() => {
    const coordinator = status?.coordinator;
    if (!coordinator) return;
    if (
      discoveredSessionRef.current?.client === workspace.client &&
      discoveredSessionRef.current.sessionId === coordinator.sessionId
    ) {
      return;
    }
    discoveredSessionRef.current = {
      client: workspace.client,
      sessionId: coordinator.sessionId,
    };
    sessionCatalog.sessionCreated(
      coordinator.workspaceCwd,
      coordinator.sessionId,
    );
    void workspace.refreshCapabilities?.().catch((error: unknown) => {
      console.warn('[live] failed to refresh conversation workspace:', error);
      discoveredSessionRef.current = undefined;
    });
  }, [sessionCatalog, status?.coordinator, workspace]);

  const pushStatus = useCallback((next: DaemonLiveStatus) => {
    if (!mountedRef.current) return;
    // A poll already in flight was answered before this push, so it is older
    // however late it lands. Bumping the poll generation makes it a no-op
    // instead of letting it overwrite the fresher status for up to a poll
    // interval. The mutation identity is untouched: the daemon pushes
    // host.state before the mutation's HTTP response finishes, and the push
    // must not discard that mutation's own result or error.
    pollGenerationRef.current += 1;
    setLoading(false);
    setStatus(next);
  }, []);

  // The daemon pushes status over the Host socket; it beats the 1 s poll.
  const browserHost = useLiveBrowserHost({
    baseUrl: workspace.baseUrl,
    token: workspace.token,
    onStatus: pushStatus,
  });

  useEffect(() => {
    if (
      browserHost.closeReason &&
      getLivePresence(workspace.client)?.state === 'connecting'
    ) {
      setLivePresence(workspace.client, undefined);
    }
  }, [browserHost.closeReason, workspace.client]);

  return {
    supported,
    nativeSupported,
    browserSupported,
    browserHost,
    status,
    loading,
    mutating,
    refresh,
    begin,
    cancelPending,
    start,
    stop,
    setMute,
  };
}
