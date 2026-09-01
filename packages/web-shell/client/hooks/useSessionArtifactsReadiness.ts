import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';

interface SessionOwner {
  isCurrent: () => boolean;
}

type PendingReadyEvent =
  | { reason: 'restore' }
  | { reason: 'turn_complete'; turnId: string };

export type SessionArtifactsReadyEvent = PendingReadyEvent & {
  sequence: number;
  artifacts: readonly DaemonSessionArtifact[];
};

type OwnedPendingReadyEvent = PendingReadyEvent & { owner: SessionOwner };

export type SessionArtifactsLoadResult =
  | {
      status: 'success';
      artifacts: readonly DaemonSessionArtifact[];
    }
  | { status: 'unavailable' | 'superseded' | 'failed' };

interface UseSessionArtifactsReadinessOptions {
  enabled: boolean;
  owner: SessionOwner;
  sessionId?: string;
  deferredSessionId?: string;
  promptStatus: string;
  activeTurnId?: string;
  activeTurnIsShell: boolean;
  artifactsVersion?: number;
  load: () => Promise<SessionArtifactsLoadResult>;
}

export function useSessionArtifactsReadiness({
  enabled,
  owner,
  sessionId,
  deferredSessionId,
  promptStatus,
  activeTurnId,
  activeTurnIsShell,
  artifactsVersion,
  load,
}: UseSessionArtifactsReadinessOptions) {
  const sequenceRef = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const loadRef = useRef(load);
  loadRef.current = load;
  const pendingRef = useRef<OwnedPendingReadyEvent[]>([]);
  const drainingOwnerRef = useRef<SessionOwner | undefined>(undefined);
  const refreshGenerationRef = useRef(0);
  const readinessScopeRef = useRef<
    { enabled: boolean; owner: SessionOwner; sessionId?: string } | undefined
  >(undefined);
  const [readyQueue, setReadyQueue] = useState<SessionArtifactsReadyEvent[]>(
    [],
  );
  const previousPromptRef = useRef({ owner, sessionId, status: promptStatus });
  const previousTurnIdRef = useRef({ owner, turnId: activeTurnId });
  const previousArtifactsVersionRef = useRef(artifactsVersion);
  const activeTurnRef = useRef({
    owner,
    baselineTurnId: activeTurnId,
    turnId: undefined as string | undefined,
    turnIsShell: false,
    sawStreaming: false,
  });

  const drain = useCallback(async (drainOwner: SessionOwner) => {
    if (!enabledRef.current || drainingOwnerRef.current === drainOwner) return;
    drainingOwnerRef.current = drainOwner;
    let retriedFailedEvent: OwnedPendingReadyEvent | undefined;
    try {
      while (enabledRef.current && drainOwner.isCurrent()) {
        const event = pendingRef.current.find(
          (pending) => pending.owner === drainOwner,
        );
        if (!event) break;
        const attemptedLoad = loadRef.current;
        const attemptedRefreshGeneration = refreshGenerationRef.current;
        const result = await attemptedLoad();
        if (!enabledRef.current || !drainOwner.isCurrent()) break;
        if (attemptedRefreshGeneration !== refreshGenerationRef.current) {
          continue;
        }
        if (result.status !== 'success') {
          if (
            result.status === 'superseded' ||
            loadRef.current !== attemptedLoad
          ) {
            continue;
          }
          if (
            result.status === 'failed' &&
            event.reason === 'turn_complete' &&
            retriedFailedEvent !== event
          ) {
            retriedFailedEvent = event;
            continue;
          }
          break;
        }
        retriedFailedEvent = undefined;
        const eventIndex = pendingRef.current.indexOf(event);
        if (eventIndex < 0) continue;
        pendingRef.current.splice(eventIndex, 1);
        const sequence = ++sequenceRef.current;
        setReadyQueue((current) => [
          ...current,
          {
            ...event,
            sequence,
            artifacts: [...result.artifacts],
          },
        ]);
      }
    } finally {
      if (drainingOwnerRef.current === drainOwner) {
        drainingOwnerRef.current = undefined;
      }
    }
  }, []);

  useEffect(() => {
    const previous = readinessScopeRef.current;
    readinessScopeRef.current = { enabled, owner, sessionId };
    if (!enabled) {
      pendingRef.current = [];
      setReadyQueue([]);
      return;
    }
    const sameSessionOwnerReplacement =
      previous?.enabled === true &&
      previous.owner !== owner &&
      sessionId !== undefined &&
      previous.sessionId === sessionId;
    const resetScope =
      previous === undefined ||
      !previous.enabled ||
      previous.sessionId !== sessionId ||
      (previous.owner !== owner && !sameSessionOwnerReplacement);
    if (resetScope) {
      pendingRef.current = [{ owner, reason: 'restore' }];
      setReadyQueue([]);
    } else if (sameSessionOwnerReplacement) {
      pendingRef.current = pendingRef.current.map((event) =>
        event.owner === previous.owner ? { ...event, owner } : event,
      );
    }
    const hasPendingEvent = pendingRef.current.some(
      (event) => event.owner === owner,
    );
    if (hasPendingEvent) {
      void drain(owner);
    } else if (sameSessionOwnerReplacement) {
      void load();
    }
  }, [drain, enabled, load, owner, sessionId]);

  useEffect(() => {
    if (!enabled) void load();
  }, [enabled, load]);

  useEffect(() => {
    const previous = previousPromptRef.current;
    const previousTurn = previousTurnIdRef.current;
    previousPromptRef.current = { owner, sessionId, status: promptStatus };
    previousTurnIdRef.current = { owner, turnId: activeTurnId };
    let turn = activeTurnRef.current;
    const sameSessionOwnerReplacement =
      previous.owner !== owner &&
      previous.sessionId !== undefined &&
      previous.sessionId === sessionId;
    const deferredOwnerReplacement =
      previous.owner !== owner &&
      previous.sessionId === undefined &&
      sessionId !== undefined &&
      deferredSessionId === sessionId &&
      previous.status !== 'idle' &&
      turn.owner === previous.owner;
    const continuousOwnerReplacement =
      sameSessionOwnerReplacement || deferredOwnerReplacement;
    const settled =
      (previous.owner === owner || continuousOwnerReplacement) &&
      previous.status !== 'idle' &&
      promptStatus === 'idle';
    if (!enabled) {
      if (settled) void load();
      return;
    }

    if (continuousOwnerReplacement) {
      turn = { ...turn, owner };
    } else if (
      promptStatus !== 'idle' &&
      (previous.owner !== owner || previous.status === 'idle')
    ) {
      turn = {
        owner,
        baselineTurnId:
          previousTurn.owner === owner ? previousTurn.turnId : undefined,
        turnId: undefined,
        turnIsShell: false,
        sawStreaming: false,
      };
    }
    if (promptStatus !== 'idle' && turn.owner === owner) {
      if (
        turn.turnId === undefined &&
        activeTurnId !== undefined &&
        activeTurnId !== turn.baselineTurnId
      ) {
        turn = {
          ...turn,
          turnId: activeTurnId,
          turnIsShell: activeTurnIsShell,
        };
      }
      if (promptStatus === 'streaming') {
        turn = { ...turn, sawStreaming: true };
      }
      activeTurnRef.current = turn;
    }
    if (!settled) return;

    if (
      turn.owner === owner &&
      turn.turnId === undefined &&
      activeTurnIsShell &&
      activeTurnId !== undefined &&
      activeTurnId !== turn.baselineTurnId
    ) {
      turn = { ...turn, turnId: activeTurnId, turnIsShell: true };
    }
    const completedTurnId =
      turn.owner === owner && (turn.sawStreaming || turn.turnIsShell)
        ? (turn.turnId ?? turn.baselineTurnId)
        : undefined;
    if (completedTurnId) {
      pendingRef.current.push({
        owner,
        reason: 'turn_complete',
        turnId: completedTurnId,
      });
    }
    activeTurnRef.current = {
      owner,
      baselineTurnId: activeTurnId,
      turnId: undefined,
      turnIsShell: false,
      sawStreaming: false,
    };
    if (pendingRef.current.some((event) => event.owner === owner)) {
      if (!completedTurnId) refreshGenerationRef.current += 1;
      void drain(owner);
    } else {
      void load();
    }
  }, [
    activeTurnId,
    activeTurnIsShell,
    drain,
    enabled,
    load,
    owner,
    promptStatus,
    deferredSessionId,
    sessionId,
  ]);

  useEffect(() => {
    const previous = previousArtifactsVersionRef.current;
    previousArtifactsVersionRef.current = artifactsVersion;
    if (
      previous === undefined ||
      artifactsVersion === undefined ||
      artifactsVersion === previous
    ) {
      return;
    }
    if (enabled) refreshGenerationRef.current += 1;
    if (enabled && pendingRef.current.some((event) => event.owner === owner)) {
      void drain(owner);
    } else {
      void load();
    }
  }, [artifactsVersion, drain, enabled, load, owner]);

  const ready = enabled ? (readyQueue[0] ?? null) : null;
  const consumeReady = useCallback((sequence: number) => {
    setReadyQueue((current) =>
      current.filter((event) => event.sequence > sequence),
    );
  }, []);

  return { ready, consumeReady };
}
