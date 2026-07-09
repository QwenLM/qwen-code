import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useActions,
  useConnection,
  usePromptStatus,
  useWorkspaceEventSignals,
} from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';

const SESSION_ARTIFACTS_FEATURE = 'session_artifacts';

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
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const previousPromptStatusRef = useRef(promptStatus);
  const previousArtifactsVersionRef = useRef(artifactsVersion);

  const refresh = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (!sessionId) {
      setArtifacts([]);
      setError(null);
      setLoading(false);
      return;
    }
    if (!isConnected) {
      setArtifacts([]);
      setError(null);
      setLoading(false);
      return;
    }
    if (!supportsArtifacts) {
      setArtifacts([]);
      setError(null);
      setLoading(false);
      return;
    }
    setArtifacts([]);
    setLoading(true);
    try {
      const result = await actions.loadArtifacts();
      if (requestIdRef.current !== requestId) return;
      setArtifacts(result.artifacts);
      setError(null);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      if (isSessionDisconnectedError(err)) {
        setError(null);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [actions, isConnected, sessionId, supportsArtifacts]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const previous = previousPromptStatusRef.current;
    previousPromptStatusRef.current = promptStatus;
    if (previous !== 'idle' && promptStatus === 'idle') {
      void refresh();
    }
  }, [promptStatus, refresh]);

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
    () => new Map(artifacts.map((artifact) => [artifact.id, artifact])),
    [artifacts],
  );

  return { artifacts, artifactById, loading, error, refresh };
}

function isSessionDisconnectedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message === 'Daemon session is not connected';
}
