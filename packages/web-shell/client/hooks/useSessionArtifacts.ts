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
  consumeReady: (sequence: number) => void;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useSessionArtifacts(
  activeTurnId?: string,
  activeTurnIsShell = false,
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
  const [readyQueueState, setReadyQueueState] = useState<
    | {
        owner: typeof owner;
        events: SequencedSessionArtifactsReady[];
      }
    | undefined
  >(undefined);
  const pendingReadyRef = useRef<
    Array<SessionArtifactsReady & { owner: typeof owner }>
  >([]);
  const requestIdRef = useRef(0);
  const loadedOwnerRef = useRef<typeof owner | undefined>(undefined);
  const loadingOwnerRef = useRef<typeof owner | undefined>(undefined);
  const previousPromptStatusRef = useRef({ owner, promptStatus });
  const activeTurnRef = useRef({
    owner,
    baselineTurnId: activeTurnId,
    turnId: undefined as string | undefined,
    turnIsShell: false,
    sawStreaming: false,
  });
  const previousActiveTurnRef = useRef({ owner, turnId: activeTurnId });
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
        if (succeeded) {
          const pending = pendingReadyRef.current.filter(
            (event) => event.owner === owner,
          );
          if (pending.length > 0) {
            pendingReadyRef.current = pendingReadyRef.current.filter(
              (event) => event.owner !== owner,
            );
            const events = pending.map((event) => {
              readySequenceRef.current += 1;
              return event.reason === 'turn_complete'
                ? {
                    reason: event.reason,
                    sequence: readySequenceRef.current,
                    turnId: event.turnId,
                  }
                : {
                    reason: event.reason,
                    sequence: readySequenceRef.current,
                  };
            });
            setReadyQueueState((current) => ({
              owner,
              events: [
                ...(current?.owner === owner ? current.events : []),
                ...events,
              ],
            }));
          }
        }
        setLoading(false);
      }
    }
  }, [actions, isConnected, owner, sessionId, supportsArtifacts]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    pendingReadyRef.current = [{ owner, reason: 'restore' }];
    setReadyQueueState(undefined);
    void refresh();
  }, [owner, refresh]);

  useEffect(() => {
    const previous = previousPromptStatusRef.current;
    const previousActiveTurn = previousActiveTurnRef.current;
    previousPromptStatusRef.current = { owner, promptStatus };
    previousActiveTurnRef.current = { owner, turnId: activeTurnId };
    let capturedTurn = activeTurnRef.current;
    if (
      promptStatus !== 'idle' &&
      (previous.owner !== owner || previous.promptStatus === 'idle')
    ) {
      capturedTurn = {
        owner,
        baselineTurnId:
          previousActiveTurn.owner === owner
            ? previousActiveTurn.turnId
            : undefined,
        turnId: undefined,
        turnIsShell: false,
        sawStreaming: false,
      };
    }
    if (promptStatus !== 'idle' && capturedTurn.owner === owner) {
      if (
        capturedTurn.turnId === undefined &&
        activeTurnId !== undefined &&
        activeTurnId !== capturedTurn.baselineTurnId
      ) {
        capturedTurn = {
          ...capturedTurn,
          turnId: activeTurnId,
          turnIsShell: activeTurnIsShell,
        };
      }
      if (promptStatus === 'streaming') {
        capturedTurn = { ...capturedTurn, sawStreaming: true };
      }
      activeTurnRef.current = capturedTurn;
    }
    if (
      previous.owner === owner &&
      previous.promptStatus !== 'idle' &&
      promptStatus === 'idle'
    ) {
      if (
        capturedTurn.owner === owner &&
        capturedTurn.turnId === undefined &&
        activeTurnIsShell &&
        activeTurnId !== undefined &&
        activeTurnId !== capturedTurn.baselineTurnId
      ) {
        capturedTurn = {
          ...capturedTurn,
          turnId: activeTurnId,
          turnIsShell: true,
        };
      }
      const completedTurnId =
        capturedTurn.owner === owner &&
        (capturedTurn.sawStreaming || capturedTurn.turnIsShell)
          ? (capturedTurn.turnId ?? capturedTurn.baselineTurnId)
          : undefined;
      if (completedTurnId) {
        pendingReadyRef.current.push({
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
      void refreshRef.current();
    }
  }, [activeTurnId, activeTurnIsShell, owner, promptStatus]);

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
  const ready =
    supportsArtifacts && readyQueueState?.owner === owner
      ? (readyQueueState.events[0] ?? null)
      : null;
  const consumeReady = useCallback(
    (sequence: number) => {
      setReadyQueueState((current) =>
        current?.owner === owner
          ? {
              owner,
              events: current.events.filter(
                (event) => event.sequence > sequence,
              ),
            }
          : current,
      );
    },
    [owner],
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
