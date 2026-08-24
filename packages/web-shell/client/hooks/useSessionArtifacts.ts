import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useActions,
  useConnection,
  usePromptStatus,
  useDaemonSessionOwnerGuard,
  useWorkspaceEventSignals,
} from '@qwen-code/webui/daemon-react-sdk';
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
  refresh: () => Promise<void>;
}

export function useSessionArtifacts(): SessionArtifactsState {
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
  const previousPromptStatusRef = useRef(promptStatus);
  const previousArtifactsVersionRef = useRef(artifactsVersion);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!sessionId || !isConnected || !supportsArtifacts) {
      loadedOwnerRef.current = undefined;
      loadingOwnerRef.current = undefined;
      setArtifacts([]);
      setLoading(false);
      return;
    }
    if (loadedOwnerRef.current !== owner) setArtifacts([]);
    loadingOwnerRef.current = owner;
    setLoading(true);
    try {
      const result = await actions.loadArtifacts();
      if (requestIdRef.current !== requestId || !owner.isCurrent()) return;
      loadedOwnerRef.current = owner;
      setArtifacts(result.artifacts);
    } catch {
      // The artifacts panel treats a failed refresh as an empty error state.
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [actions, isConnected, owner, sessionId, supportsArtifacts]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const previous = previousPromptStatusRef.current;
    previousPromptStatusRef.current = promptStatus;
    if (previous !== 'idle' && promptStatus === 'idle') {
      void refreshRef.current();
    }
  }, [promptStatus]);

  useEffect(() => {
    const previous = previousArtifactsVersionRef.current;
    previousArtifactsVersionRef.current = artifactsVersion;
    if (
      previous !== undefined &&
      artifactsVersion !== undefined &&
      artifactsVersion !== previous
    ) {
      void refreshRef.current();
    }
  }, [artifactsVersion]);

  const artifactById = useMemo(
    () =>
      new Map(
        (loadedOwnerRef.current === owner ? artifacts : []).map((artifact) => [
          artifact.id,
          artifact,
        ]),
      ),
    [artifacts, owner],
  );

  const visibleArtifacts =
    loadedOwnerRef.current === owner ? artifacts : EMPTY_ARTIFACTS;
  return {
    artifacts: visibleArtifacts,
    artifactById,
    loading: loading && loadingOwnerRef.current === owner,
    error: null,
    refresh,
  };
}
