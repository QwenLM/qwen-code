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

interface UseSessionArtifactsReadinessOptions {
  enabled: boolean;
  owner: SessionOwner;
  promptStatus: string;
  activeTurnId?: string;
  activeTurnIsShell: boolean;
  artifactsVersion?: number;
  load: () => Promise<readonly DaemonSessionArtifact[] | null>;
}

export function useSessionArtifactsReadiness({
  enabled,
  owner,
  promptStatus,
  activeTurnId,
  activeTurnIsShell,
  artifactsVersion,
  load,
}: UseSessionArtifactsReadinessOptions) {
  const sequenceRef = useRef(0);
  const pendingRef = useRef<OwnedPendingReadyEvent[]>([]);
  const drainingOwnerRef = useRef<SessionOwner | undefined>(undefined);
  const [readyQueue, setReadyQueue] = useState<SessionArtifactsReadyEvent[]>(
    [],
  );
  const previousPromptRef = useRef({ owner, status: promptStatus });
  const previousTurnIdRef = useRef({ owner, turnId: activeTurnId });
  const previousArtifactsVersionRef = useRef(artifactsVersion);
  const activeTurnRef = useRef({
    owner,
    baselineTurnId: activeTurnId,
    turnId: undefined as string | undefined,
    turnIsShell: false,
    sawStreaming: false,
  });

  const drain = useCallback(async () => {
    if (!enabled || drainingOwnerRef.current === owner) return;
    drainingOwnerRef.current = owner;
    try {
      while (owner.isCurrent()) {
        const eventIndex = pendingRef.current.findIndex(
          (event) => event.owner === owner,
        );
        if (eventIndex < 0) break;
        const artifacts = await load();
        if (!artifacts || !owner.isCurrent()) break;
        const [event] = pendingRef.current.splice(eventIndex, 1);
        if (!event) break;
        sequenceRef.current += 1;
        setReadyQueue((current) => [
          ...current,
          {
            ...event,
            sequence: sequenceRef.current,
            artifacts: [...artifacts],
          },
        ]);
      }
    } finally {
      if (drainingOwnerRef.current === owner) {
        drainingOwnerRef.current = undefined;
      }
    }
  }, [enabled, load, owner]);

  useEffect(() => {
    pendingRef.current = enabled ? [{ owner, reason: 'restore' }] : [];
    setReadyQueue([]);
    if (enabled) void drain();
    else void load();
  }, [drain, enabled, load, owner]);

  useEffect(() => {
    const previous = previousPromptRef.current;
    const previousTurn = previousTurnIdRef.current;
    previousPromptRef.current = { owner, status: promptStatus };
    previousTurnIdRef.current = { owner, turnId: activeTurnId };
    const settled =
      previous.owner === owner &&
      previous.status !== 'idle' &&
      promptStatus === 'idle';
    if (!enabled) {
      if (settled) void load();
      return;
    }

    let turn = activeTurnRef.current;
    if (
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
      void drain();
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
    if (enabled && pendingRef.current.some((event) => event.owner === owner)) {
      void drain();
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
