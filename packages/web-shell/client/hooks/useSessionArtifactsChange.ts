import { useEffect, useRef } from 'react';
import { useWorkspaceEventSignals } from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import type {
  WebShellSessionArtifactsChange,
  WebShellSessionArtifactsChangeReason,
} from '../customization';

interface SessionArtifactsChangeOptions {
  sessionId?: string;
  ready: boolean;
  hydrated: boolean;
  artifacts: readonly DaemonSessionArtifact[];
  artifactsByTurn: ReadonlyMap<string, readonly DaemonSessionArtifact[]>;
  onChange?: (change: WebShellSessionArtifactsChange) => void;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function snapshotSignature(
  artifacts: readonly DaemonSessionArtifact[],
  artifactsByTurn: ReadonlyMap<string, readonly DaemonSessionArtifact[]>,
): string {
  return JSON.stringify(
    canonicalize({
      artifacts,
      artifactsByTurn: Array.from(artifactsByTurn.entries()).sort(
        ([left], [right]) => left.localeCompare(right),
      ),
    }),
  );
}

function cloneProjection(
  artifactsByTurn: ReadonlyMap<string, readonly DaemonSessionArtifact[]>,
): ReadonlyMap<string, readonly DaemonSessionArtifact[]> {
  return new Map(
    Array.from(artifactsByTurn, ([turnId, artifacts]) => [
      turnId,
      [...artifacts],
    ]),
  );
}

export function useSessionArtifactsChange({
  sessionId,
  ready,
  hydrated,
  artifacts,
  artifactsByTurn,
  onChange,
}: SessionArtifactsChangeOptions): void {
  const artifactsVersion = useWorkspaceEventSignals()?.artifactsVersion;
  const stateRef = useRef<{
    sessionId?: string;
    artifactsVersion?: number;
    pendingReason?: WebShellSessionArtifactsChangeReason;
    lastSignature?: string;
    sequence: number;
  }>({
    sessionId,
    artifactsVersion,
    sequence: 0,
  });

  useEffect(() => {
    let state = stateRef.current;
    if (state.sessionId !== sessionId) {
      state = {
        sessionId,
        artifactsVersion,
        sequence: 0,
      };
      stateRef.current = state;
    } else {
      const previousVersion = state.artifactsVersion;
      state.artifactsVersion = artifactsVersion;
      if (
        previousVersion !== undefined &&
        artifactsVersion !== undefined &&
        previousVersion !== artifactsVersion
      ) {
        state.pendingReason = 'change';
      }
    }
    if (!sessionId || !onChange || !ready || !hydrated) return;

    const signature = snapshotSignature(artifacts, artifactsByTurn);
    if (
      state.lastSignature === undefined &&
      state.pendingReason === undefined
    ) {
      state.pendingReason = 'restore';
    }
    if (
      state.lastSignature !== undefined &&
      state.lastSignature !== signature &&
      state.pendingReason === undefined
    ) {
      state.pendingReason = 'change';
    }
    if (state.lastSignature === signature) {
      state.pendingReason = undefined;
      return;
    }
    if (!state.pendingReason) return;

    const change: WebShellSessionArtifactsChange = {
      reason: state.pendingReason,
      sessionId,
      sequence: state.sequence + 1,
      artifacts: [...artifacts],
      artifactsByTurn: cloneProjection(artifactsByTurn),
    };
    state.sequence = change.sequence;
    state.lastSignature = signature;
    state.pendingReason = undefined;
    try {
      onChange(change);
    } catch (error) {
      console.error(
        '[WebShell] onSessionArtifactsChange listener failed:',
        error,
      );
    }
  }, [
    artifacts,
    artifactsVersion,
    artifactsByTurn,
    hydrated,
    onChange,
    ready,
    sessionId,
  ]);
}
