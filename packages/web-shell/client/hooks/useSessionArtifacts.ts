import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useActions,
  useConnection,
  usePromptStatus,
  useDaemonSessionOwnerGuard,
  useWorkspaceEventSignals,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import {
  useSessionArtifactsReadyQueue,
  type SessionArtifactsLoadResult,
  type SessionArtifactsReadyEvent,
} from './useSessionArtifactsReadiness';

const SESSION_ARTIFACTS_FEATURE = 'session_artifacts';

// A stable empty array for sessions whose artifact list cannot load (e.g. a
// subagent session without an artifacts endpoint). Returning a fresh literal
// here would change `artifacts` identity every render and re-run every
// consumer effect that depends on it, which cascades into an update loop.
const EMPTY_ARTIFACTS: DaemonSessionArtifact[] = [];

export interface SessionArtifactsState {
  artifacts: DaemonSessionArtifact[];
  artifactById: ReadonlyMap<string, DaemonSessionArtifact>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export interface SessionArtifactsReadinessState extends SessionArtifactsState {
  ready: SessionArtifactsReadyEvent | null;
  consumeReady: (sequence: number) => void;
}

interface SessionArtifactsOptions {
  trackReadiness: boolean;
  activeTurnId?: string;
  activeTurnIsShell: boolean;
  deferredSessionId?: string;
}

function useSessionArtifactsInternal({
  trackReadiness,
  activeTurnId,
  activeTurnIsShell,
  deferredSessionId,
}: SessionArtifactsOptions): SessionArtifactsReadinessState {
  const actions = useActions();
  const connection = useConnection();
  const ownerGuard = useDaemonSessionOwnerGuard();
  const ownerRef = useRef(ownerGuard.capture());
  if (!ownerRef.current?.isCurrent()) ownerRef.current = ownerGuard.capture();
  const owner = ownerRef.current;
  const promptStatus = usePromptStatus();
  const workspaceEventSignals = useWorkspaceEventSignals();
  const artifactsVersion = workspaceEventSignals?.artifactsVersion;
  const isConnected = connection.status === 'connected';
  const supportsArtifacts =
    connection.capabilities?.features?.includes(SESSION_ARTIFACTS_FEATURE) ??
    false;
  const sessionId = connection.sessionId;
  const [artifacts, setArtifacts] = useState<DaemonSessionArtifact[]>([]);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);
  const loadedOwnerRef = useRef<typeof owner | undefined>(undefined);
  const loadingOwnerRef = useRef<typeof owner | undefined>(undefined);
  const previousPromptRef = useRef({ owner, sessionId, status: promptStatus });
  const lastTurnIdRef = useRef(activeTurnId);
  const previousArtifactsVersionRef = useRef(artifactsVersion);
  const readinessScopeRef = useRef<
    { enabled: boolean; owner: typeof owner; sessionId?: string } | undefined
  >(undefined);
  const activeTurnRef = useRef({
    baselineTurnId: activeTurnId,
    turnId: undefined as string | undefined,
    turnIsShell: false,
    sawStreaming: false,
  });
  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!sessionId || !isConnected || !supportsArtifacts) {
      loadedOwnerRef.current = undefined;
      loadingOwnerRef.current = undefined;
      setArtifacts([]);
      setLoading(false);
      return { status: 'unavailable' } satisfies SessionArtifactsLoadResult;
    }
    if (loadedOwnerRef.current !== owner) setArtifacts([]);
    loadingOwnerRef.current = owner;
    setLoading(true);
    try {
      const result = await actions.loadArtifacts();
      if (requestIdRef.current !== requestId || !owner.isCurrent()) {
        return { status: 'superseded' } satisfies SessionArtifactsLoadResult;
      }
      loadedOwnerRef.current = owner;
      setArtifacts(result.artifacts);
      return {
        status: 'success',
        artifacts: result.artifacts,
      } satisfies SessionArtifactsLoadResult;
    } catch {
      if (requestIdRef.current !== requestId || !owner.isCurrent()) {
        return { status: 'superseded' } satisfies SessionArtifactsLoadResult;
      }
      // The artifacts panel treats a failed refresh as an empty error state.
      return { status: 'failed' } satisfies SessionArtifactsLoadResult;
    } finally {
      if (requestIdRef.current === requestId && owner.isCurrent()) {
        setLoading(false);
      }
    }
  }, [actions, isConnected, owner, sessionId, supportsArtifacts]);
  const readinessEnabled = trackReadiness && supportsArtifacts;
  const { ready, consumeReady, enqueue, hasPending, invalidate, reset, retry } =
    useSessionArtifactsReadyQueue(readinessEnabled, load);

  useEffect(() => {
    const previous = readinessScopeRef.current;
    readinessScopeRef.current = {
      enabled: readinessEnabled,
      owner,
      sessionId,
    };
    if (!readinessEnabled) {
      if (previous?.enabled) reset();
      void load();
      return;
    }

    const sameSessionOwnerReplacement =
      previous?.enabled === true &&
      previous.owner !== owner &&
      sessionId !== undefined &&
      previous.sessionId === sessionId;
    const deferredSessionCreation =
      previous?.enabled === true &&
      previous.sessionId === undefined &&
      sessionId !== undefined &&
      deferredSessionId === sessionId;
    const sessionChanged =
      previous === undefined ||
      !previous.enabled ||
      previous.sessionId !== sessionId;

    if (!sameSessionOwnerReplacement && sessionChanged) {
      reset(
        sessionId && !deferredSessionCreation
          ? { reason: 'restore' }
          : undefined,
      );
    }

    if (hasPending()) {
      retry(owner);
    } else if (sameSessionOwnerReplacement || sessionChanged) {
      void load();
    }
  }, [
    deferredSessionId,
    hasPending,
    load,
    owner,
    readinessEnabled,
    reset,
    retry,
    sessionId,
  ]);

  useEffect(() => {
    const previous = previousPromptRef.current;
    const previousTurnId = lastTurnIdRef.current;
    previousPromptRef.current = { owner, sessionId, status: promptStatus };
    lastTurnIdRef.current = activeTurnId;
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
      previous.status !== 'idle';
    const continuousOwnerReplacement =
      sameSessionOwnerReplacement || deferredOwnerReplacement;
    const settled =
      (previous.owner === owner || continuousOwnerReplacement) &&
      previous.status !== 'idle' &&
      promptStatus === 'idle';

    if (
      !continuousOwnerReplacement &&
      promptStatus !== 'idle' &&
      (previous.owner !== owner || previous.status === 'idle')
    ) {
      turn = {
        baselineTurnId: previous.owner === owner ? previousTurnId : undefined,
        turnId: undefined,
        turnIsShell: false,
        sawStreaming: false,
      };
    }
    if (promptStatus !== 'idle') {
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
      turn.turnId === undefined &&
      activeTurnIsShell &&
      activeTurnId !== undefined &&
      activeTurnId !== turn.baselineTurnId
    ) {
      turn = { ...turn, turnId: activeTurnId, turnIsShell: true };
    }
    const completedTurnId =
      turn.sawStreaming || turn.turnIsShell
        ? (turn.turnId ?? turn.baselineTurnId)
        : undefined;
    activeTurnRef.current = {
      baselineTurnId: activeTurnId,
      turnId: undefined,
      turnIsShell: false,
      sawStreaming: false,
    };

    if (!readinessEnabled) {
      void load();
    } else if (completedTurnId) {
      enqueue(owner, {
        reason: 'turn_complete',
        turnId: completedTurnId,
      });
    } else if (hasPending()) {
      invalidate(owner);
    } else {
      void load();
    }
  }, [
    activeTurnId,
    activeTurnIsShell,
    deferredSessionId,
    enqueue,
    hasPending,
    invalidate,
    load,
    owner,
    promptStatus,
    readinessEnabled,
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
    if (readinessEnabled && hasPending()) {
      invalidate(owner);
    } else {
      void load();
    }
  }, [artifactsVersion, hasPending, invalidate, load, owner, readinessEnabled]);
  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  const visibleArtifacts =
    loadedOwnerRef.current === owner ? artifacts : EMPTY_ARTIFACTS;
  const artifactById = useMemo(
    () =>
      new Map(
        visibleArtifacts.map((artifact) => [artifact.id, artifact] as const),
      ),
    [visibleArtifacts],
  );

  return {
    artifacts: visibleArtifacts,
    artifactById,
    ready,
    consumeReady,
    loading: loading && loadingOwnerRef.current === owner,
    error: null,
    refresh,
  };
}

export function useSessionArtifacts(): SessionArtifactsState {
  const {
    ready: _ready,
    consumeReady: _consumeReady,
    ...state
  } = useSessionArtifactsInternal({
    trackReadiness: false,
    activeTurnIsShell: false,
  });
  return state;
}

export function useSessionArtifactsWithReadiness(
  activeTurnId?: string,
  activeTurnIsShell = false,
  deferredSessionId?: string,
  enabled = true,
): SessionArtifactsReadinessState {
  return useSessionArtifactsInternal({
    trackReadiness: enabled,
    activeTurnId,
    activeTurnIsShell,
    deferredSessionId,
  });
}
