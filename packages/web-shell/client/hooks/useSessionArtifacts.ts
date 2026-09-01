import { useCallback, useMemo, useRef, useState } from 'react';
import {
  useActions,
  useConnection,
  usePromptStatus,
  useDaemonSessionOwnerGuard,
  useWorkspaceEventSignals,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import {
  useSessionArtifactsReadiness,
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
  const readiness = useSessionArtifactsReadiness({
    enabled: trackReadiness && supportsArtifacts,
    owner,
    sessionId,
    deferredSessionId,
    promptStatus,
    activeTurnId,
    activeTurnIsShell,
    artifactsVersion,
    load,
  });
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
    ready: readiness.ready,
    consumeReady: readiness.consumeReady,
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
): SessionArtifactsReadinessState {
  return useSessionArtifactsInternal({
    trackReadiness: true,
    activeTurnId,
    activeTurnIsShell,
    deferredSessionId,
  });
}
