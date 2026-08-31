import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useActions,
  useConnection,
  usePromptStatus,
  useDaemonSessionOwnerGuard,
  useWorkspaceEventSignals,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';

const SESSION_ARTIFACTS_FEATURE = 'session_artifacts';
const MAX_CACHED_SESSIONS = 20;

function cacheArtifacts(
  cache: Map<string, DaemonSessionArtifact[]>,
  sessionKey: string,
  artifacts: DaemonSessionArtifact[],
): void {
  cache.delete(sessionKey);
  cache.set(sessionKey, artifacts);
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
  const sessionKey = sessionId
    ? `${connection.workspaceCwd ?? ''}\0${sessionId}`
    : undefined;
  const [artifacts, setArtifacts] = useState<DaemonSessionArtifact[]>([]);
  const [, setLoadRevision] = useState(0);
  const requestIdRef = useRef(0);
  const loadedSessionKeyRef = useRef<string | undefined>(undefined);
  const artifactsBySessionRef = useRef(
    new Map<string, DaemonSessionArtifact[]>(),
  );
  const previousPromptStatusRef = useRef(promptStatus);
  const previousArtifactsVersionRef = useRef(artifactsVersion);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!sessionKey || !isConnected || !supportsArtifacts) {
      loadedSessionKeyRef.current = undefined;
      setArtifacts([]);
      return;
    }
    if (loadedSessionKeyRef.current !== sessionKey) {
      loadedSessionKeyRef.current = sessionKey;
      setArtifacts(artifactsBySessionRef.current.get(sessionKey) ?? []);
    }
    try {
      const result = await actions.loadArtifacts();
      if (requestIdRef.current !== requestId || !owner.isCurrent()) return;
      cacheArtifacts(
        artifactsBySessionRef.current,
        sessionKey,
        result.artifacts,
      );
      setArtifacts(result.artifacts);
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
        setLoadRevision((revision) => revision + 1);
      }
    }
  }, [actions, isConnected, owner, sessionKey, supportsArtifacts]);
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

  const visibleArtifacts =
    sessionKey && isConnected && supportsArtifacts
      ? (artifactsBySessionRef.current.get(sessionKey) ??
        (loadedSessionKeyRef.current === sessionKey
          ? artifacts
          : EMPTY_ARTIFACTS))
      : EMPTY_ARTIFACTS;
  const artifactById = useMemo(
    () => new Map(visibleArtifacts.map((artifact) => [artifact.id, artifact])),
    [visibleArtifacts],
  );
  return {
    artifacts: visibleArtifacts,
    artifactById,
    loading:
      Boolean(sessionId && isConnected && supportsArtifacts) &&
      Boolean(sessionKey && !artifactsBySessionRef.current.has(sessionKey)),
    error: null,
    refresh,
  };
}
