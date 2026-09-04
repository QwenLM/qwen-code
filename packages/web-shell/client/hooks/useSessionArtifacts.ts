import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useActions,
  useConnection,
  useDaemonSessionOwnerGuard,
  useWorkspaceEventSignals,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';

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
  const [artifacts, setArtifacts] = useState<DaemonSessionArtifact[]>([]);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);
  const loadedOwnerRef = useRef<typeof owner | undefined>(undefined);
  const loadedSessionIdRef = useRef<string | undefined>(undefined);
  const loadingOwnerRef = useRef<typeof owner | undefined>(undefined);
  const loadingSessionIdRef = useRef<string | undefined>(undefined);
  const previousArtifactsVersionRef = useRef(artifactsVersion);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!sessionId) {
      loadedOwnerRef.current = undefined;
      loadedSessionIdRef.current = undefined;
      loadingOwnerRef.current = undefined;
      loadingSessionIdRef.current = undefined;
      setArtifacts([]);
      setLoading(false);
      return;
    }
    if (!isConnected || connection.catchingUp || !supportsArtifacts) {
      loadingOwnerRef.current = undefined;
      loadingSessionIdRef.current = undefined;
      setLoading(false);
      return;
    }
    if (
      loadedOwnerRef.current !== owner ||
      loadedSessionIdRef.current !== sessionId
    ) {
      setArtifacts([]);
    }
    loadingOwnerRef.current = owner;
    loadingSessionIdRef.current = sessionId;
    setLoading(true);
    try {
      const result = await actions.loadArtifacts();
      if (requestIdRef.current !== requestId || !owner.isCurrent()) return;
      loadedOwnerRef.current = owner;
      loadedSessionIdRef.current = sessionId;
      setArtifacts(result.artifacts);
    } catch {
      // The artifacts panel treats a failed refresh as an empty error state.
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [
    actions,
    connection.catchingUp,
    isConnected,
    owner,
    sessionId,
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

  const artifactById = useMemo(
    () =>
      new Map(
        (sessionId &&
        loadedOwnerRef.current === owner &&
        loadedSessionIdRef.current === sessionId
          ? artifacts
          : []
        ).map((artifact) => [artifact.id, artifact]),
      ),
    [artifacts, owner, sessionId],
  );

  const visibleArtifacts =
    sessionId &&
    loadedOwnerRef.current === owner &&
    loadedSessionIdRef.current === sessionId
      ? artifacts
      : EMPTY_ARTIFACTS;
  return {
    artifacts: visibleArtifacts,
    artifactById,
    loading:
      loading &&
      loadingOwnerRef.current === owner &&
      loadingSessionIdRef.current === sessionId,
    error: null,
    hydrated: Boolean(
      sessionId &&
        loadedOwnerRef.current === owner &&
        loadedSessionIdRef.current === sessionId,
    ),
    refresh,
  };
}
