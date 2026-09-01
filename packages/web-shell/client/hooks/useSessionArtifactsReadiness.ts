import { useCallback, useRef, useState } from 'react';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';

interface SessionOwner {
  isCurrent: () => boolean;
}

export type PendingSessionArtifactsReadyEvent =
  | { reason: 'restore' }
  | { reason: 'turn_complete'; turnId: string };

export type SessionArtifactsReadyEvent = PendingSessionArtifactsReadyEvent & {
  sequence: number;
  artifacts: readonly DaemonSessionArtifact[];
};

export type SessionArtifactsLoadResult =
  | {
      status: 'success';
      artifacts: readonly DaemonSessionArtifact[];
    }
  | { status: 'unavailable' | 'superseded' | 'failed' };

/**
 * Serializes artifact snapshots for lifecycle events. Session and prompt
 * lifecycle detection stays in useSessionArtifacts; this queue only preserves
 * event order and waits for the newest requested artifact refresh.
 */
export function useSessionArtifactsReadyQueue(
  enabled: boolean,
  load: () => Promise<SessionArtifactsLoadResult>,
) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const loadRef = useRef(load);
  loadRef.current = load;
  const pendingRef = useRef<PendingSessionArtifactsReadyEvent[]>([]);
  const drainingOwnersRef = useRef(new Set<SessionOwner>());
  const refreshGenerationRef = useRef(0);
  const sequenceRef = useRef(0);
  const [readyQueue, setReadyQueue] = useState<SessionArtifactsReadyEvent[]>(
    [],
  );

  const drain = useCallback(async (owner: SessionOwner) => {
    if (!enabledRef.current || drainingOwnersRef.current.has(owner)) return;
    drainingOwnersRef.current.add(owner);
    try {
      while (enabledRef.current && owner.isCurrent()) {
        const event = pendingRef.current[0];
        if (!event) break;
        const attemptedLoad = loadRef.current;
        const attemptedGeneration = refreshGenerationRef.current;
        const result = await attemptedLoad();
        if (!enabledRef.current || !owner.isCurrent()) break;
        if (
          attemptedGeneration !== refreshGenerationRef.current ||
          result.status === 'superseded'
        ) {
          continue;
        }
        if (result.status !== 'success') break;

        if (pendingRef.current[0] !== event) continue;
        pendingRef.current.shift();
        setReadyQueue((current) => [
          ...current,
          {
            ...event,
            sequence: ++sequenceRef.current,
            artifacts: [...result.artifacts],
          },
        ]);
      }
    } finally {
      drainingOwnersRef.current.delete(owner);
    }
  }, []);

  const reset = useCallback((event?: PendingSessionArtifactsReadyEvent) => {
    pendingRef.current = event ? [event] : [];
    setReadyQueue([]);
  }, []);

  const enqueue = useCallback(
    (owner: SessionOwner, event: PendingSessionArtifactsReadyEvent) => {
      pendingRef.current.push(event);
      void drain(owner);
    },
    [drain],
  );

  const invalidate = useCallback(
    (owner: SessionOwner) => {
      refreshGenerationRef.current += 1;
      void drain(owner);
    },
    [drain],
  );

  const retry = useCallback(
    (owner: SessionOwner) => {
      void drain(owner);
    },
    [drain],
  );

  const hasPending = useCallback(() => pendingRef.current.length > 0, []);

  const consumeReady = useCallback((sequence: number) => {
    setReadyQueue((current) =>
      current.filter((event) => event.sequence > sequence),
    );
  }, []);

  return {
    ready: enabled ? (readyQueue[0] ?? null) : null,
    consumeReady,
    enqueue,
    hasPending,
    invalidate,
    reset,
    retry,
  };
}
