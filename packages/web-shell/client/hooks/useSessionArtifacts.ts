import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useActions,
  useConnection,
  useDaemonSessionOwnerGuard,
  useWorkspaceEventSignals,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';

const SESSION_ARTIFACTS_FEATURE = 'session_artifacts';
const MAX_CACHED_SESSIONS = 20;

function cacheArtifacts<Owner>(
  cache: Map<
    string,
    { artifacts: DaemonSessionArtifact[]; hydratedOwner?: Owner }
  >,
  sessionKey: string,
  artifacts: DaemonSessionArtifact[],
  hydratedOwner?: Owner,
): void {
  cache.delete(sessionKey);
  cache.set(sessionKey, { artifacts, hydratedOwner });
  while (cache.size > MAX_CACHED_SESSIONS) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

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
  hydrated: boolean;
  refresh: () => Promise<void>;
}

export function useSessionArtifacts(): SessionArtifactsState {
  const actions = useActions();
  const connection = useConnection();
  const ownerGuard = useDaemonSessionOwnerGuard();
  const ownerRef = useRef(ownerGuard.capture());
  if (!ownerRef.current?.isCurrent()) ownerRef.current = ownerGuard.capture();
  const owner = ownerRef.current;
  const workspaceEventSignals = useWorkspaceEventSignals();
  const artifactsVersion = workspaceEventSignals?.artifactsVersion;
  const isConnected = connection.status === 'connected';
  const supportsArtifacts =
    connection.capabilities?.features?.includes(SESSION_ARTIFACTS_FEATURE) ??
    false;
  const sessionId = connection.sessionId;
  const sessionKey = sessionId
    ? `${connection.workspaceCwd ?? ''}\0${sessionId}`
    : undefined;
  const [, setArtifacts] = useState<DaemonSessionArtifact[]>([]);
  const requestIdRef = useRef(0);
  const artifactsBySessionRef = useRef(
    new Map<
      string,
      { artifacts: DaemonSessionArtifact[]; hydratedOwner?: typeof owner }
    >(),
  );
  const previousArtifactsVersionRef = useRef(artifactsVersion);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!sessionKey) {
      setArtifacts([]);
      return;
    }
    if (!isConnected || connection.catchingUp || !supportsArtifacts) {
      return;
    }
    try {
      const result = await actions.loadArtifacts();
      if (requestIdRef.current !== requestId || !owner.isCurrent()) return;
      cacheArtifacts(
        artifactsBySessionRef.current,
        sessionKey,
        result.artifacts,
        owner,
      );
    } catch {
      // The artifacts panel treats a failed refresh as an empty error state.
      if (
        requestIdRef.current === requestId &&
        owner.isCurrent() &&
        !artifactsBySessionRef.current.has(sessionKey)
      ) {
        cacheArtifacts(artifactsBySessionRef.current, sessionKey, []);
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setArtifacts(
          artifactsBySessionRef.current.get(sessionKey)?.artifacts ??
            EMPTY_ARTIFACTS,
        );
      }
    }
  }, [
    actions,
    connection.catchingUp,
    isConnected,
    owner,
    sessionKey,
    supportsArtifacts,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const previous = previousArtifactsVersionRef.current;
    previousArtifactsVersionRef.current = artifactsVersion;
    if (
      previous !== undefined &&
      artifactsVersion !== undefined &&
      artifactsVersion !== previous
    ) {
      void refresh();
    }
  }, [artifactsVersion, refresh]);

  const visibleArtifacts =
    sessionKey && isConnected && supportsArtifacts
      ? (artifactsBySessionRef.current.get(sessionKey)?.artifacts ??
        EMPTY_ARTIFACTS)
      : EMPTY_ARTIFACTS;
  const artifactById = useMemo(
    () => new Map(visibleArtifacts.map((artifact) => [artifact.id, artifact])),
    [visibleArtifacts],
  );
  return {
    artifacts: visibleArtifacts,
    artifactById,
    loading:
      Boolean(
        sessionId && isConnected && !connection.catchingUp && supportsArtifacts,
      ) &&
      Boolean(sessionKey && !artifactsBySessionRef.current.has(sessionKey)),
    error: null,
    hydrated: Boolean(
      sessionKey &&
        artifactsBySessionRef.current.get(sessionKey)?.hydratedOwner === owner,
    ),
    refresh,
  };
}
