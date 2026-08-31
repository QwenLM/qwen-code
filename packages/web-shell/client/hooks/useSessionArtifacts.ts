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

// A stable empty array for sessions whose artifact list cannot load (e.g. a
// subagent session without an artifacts endpoint). Returning a fresh literal
// here would change `artifacts` identity every render and re-run every
// consumer effect that depends on it, which cascades into an update loop.
const EMPTY_ARTIFACTS: DaemonSessionArtifact[] = [];

type SessionArtifactsReady =
  | { reason: 'restore' }
  | { reason: 'turn_complete'; turnId: string };

type SequencedSessionArtifactsReady = SessionArtifactsReady & {
  sequence: number;
};

export interface SessionArtifactsState {
  artifacts: DaemonSessionArtifact[];
  artifactById: ReadonlyMap<string, DaemonSessionArtifact>;
  ready: SequencedSessionArtifactsReady | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useSessionArtifacts(
  activeTurnId?: string,
): SessionArtifactsState {
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
  const readySequenceRef = useRef(0);
  const [readyState, setReadyState] = useState<
    (SequencedSessionArtifactsReady & { owner: typeof owner }) | undefined
  >(undefined);
  const pendingReadyRef = useRef<
    (SessionArtifactsReady & { owner: typeof owner }) | undefined
  >(undefined);
  const requestIdRef = useRef(0);
  const loadedOwnerRef = useRef<typeof owner | undefined>(undefined);
  const loadingOwnerRef = useRef<typeof owner | undefined>(undefined);
  const previousPromptStatusRef = useRef({ owner, promptStatus });
  const activeTurnRef = useRef({ owner, turnId: activeTurnId });
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
    let succeeded = false;
    try {
      const result = await actions.loadArtifacts();
      if (requestIdRef.current !== requestId || !owner.isCurrent()) return;
      loadedOwnerRef.current = owner;
      setArtifacts(result.artifacts);
      succeeded = true;
    } catch {
      // The artifacts panel treats a failed refresh as an empty error state.
    } finally {
      if (requestIdRef.current === requestId && owner.isCurrent()) {
        if (succeeded && pendingReadyRef.current?.owner === owner) {
          const pendingReady = pendingReadyRef.current;
          readySequenceRef.current += 1;
          setReadyState(
            pendingReady.reason === 'turn_complete'
              ? {
                  owner,
                  reason: pendingReady.reason,
                  sequence: readySequenceRef.current,
                  turnId: pendingReady.turnId,
                }
              : {
                  owner,
                  reason: pendingReady.reason,
                  sequence: readySequenceRef.current,
                },
          );
          pendingReadyRef.current = undefined;
        }
        setLoading(false);
      }
    }
  }, [actions, isConnected, owner, sessionId, supportsArtifacts]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    pendingReadyRef.current = { owner, reason: 'restore' };
    void refresh();
  }, [owner, refresh]);

  useEffect(() => {
    const previous = previousPromptStatusRef.current;
    previousPromptStatusRef.current = { owner, promptStatus };
    const capturedTurn = activeTurnRef.current;
    if (
      promptStatus !== 'idle' &&
      (previous.owner !== owner ||
        previous.promptStatus === 'idle' ||
        (capturedTurn.owner === owner && capturedTurn.turnId === undefined))
    ) {
      activeTurnRef.current = { owner, turnId: activeTurnId };
    }
    if (
      previous.owner === owner &&
      previous.promptStatus !== 'idle' &&
      promptStatus === 'idle'
    ) {
      const completedTurnId =
        activeTurnRef.current.owner === owner
          ? activeTurnRef.current.turnId
          : undefined;
      pendingReadyRef.current = completedTurnId
        ? { owner, reason: 'turn_complete', turnId: completedTurnId }
        : undefined;
      void refreshRef.current();
    }
  }, [activeTurnId, owner, promptStatus]);

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
    ready:
      !supportsArtifacts || readyState?.owner !== owner
        ? null
        : readyState.reason === 'turn_complete'
          ? {
              reason: readyState.reason,
              sequence: readyState.sequence,
              turnId: readyState.turnId,
            }
          : {
              reason: readyState.reason,
              sequence: readyState.sequence,
            },
    loading: loading && loadingOwnerRef.current === owner,
    error: null,
    refresh,
  };
}
