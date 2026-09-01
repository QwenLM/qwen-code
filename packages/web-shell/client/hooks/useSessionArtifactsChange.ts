import { useEffect, useRef } from 'react';
import {
  useDaemonSessionOwnerGuard,
  useWorkspaceEventSignals,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import type {
  WebShellSessionArtifactsChange,
  WebShellSessionArtifactsChangeReason,
} from '../customization';

interface SessionArtifactsChangeOptions {
  sessionId?: string;
  reconciling: boolean;
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
  reconciling,
  ready,
  hydrated,
  artifacts,
  artifactsByTurn,
  onChange,
}: SessionArtifactsChangeOptions): void {
  const ownerGuard = useDaemonSessionOwnerGuard();
  const ownerRef = useRef(ownerGuard.capture());
  if (!ownerRef.current.isCurrent()) ownerRef.current = ownerGuard.capture();
  const owner = ownerRef.current;
  const artifactsVersion = useWorkspaceEventSignals()?.artifactsVersion;
  const stateRef = useRef<{
    sessionId?: string;
    owner: typeof owner;
    artifactsVersion?: number;
    pendingReason?: WebShellSessionArtifactsChangeReason;
    reconciliationArtifacts?: readonly DaemonSessionArtifact[];
    lastSignature?: string;
    lastArtifactIds: ReadonlySet<string>;
    sequence: number;
  }>({
    sessionId,
    owner,
    artifactsVersion,
    lastArtifactIds: new Set(),
    sequence: 0,
  });

  useEffect(() => {
    let state = stateRef.current;
    if (state.sessionId !== sessionId) {
      state = {
        sessionId,
        owner,
        artifactsVersion,
        lastArtifactIds: new Set(),
        sequence: 0,
      };
      stateRef.current = state;
    } else {
      state.owner = owner;
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
    if (reconciling && state.lastSignature !== undefined) {
      state.reconciliationArtifacts ??= artifacts;
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
      if (state.reconciliationArtifacts !== artifacts) {
        state.reconciliationArtifacts = undefined;
      }
      return;
    }
    if (!state.pendingReason) return;

    if (state.pendingReason === 'change' && !state.reconciliationArtifacts) {
      const projectedArtifactIds = new Set(
        Array.from(artifactsByTurn.values()).flatMap((items) =>
          items.map((artifact) => artifact.id),
        ),
      );
      const hasNewUnprojectedArtifact = artifacts.some(
        (artifact) =>
          artifact.toolCallId &&
          !state.lastArtifactIds.has(artifact.id) &&
          !projectedArtifactIds.has(artifact.id),
      );
      if (hasNewUnprojectedArtifact) return;
    }

    const change: WebShellSessionArtifactsChange = {
      reason: state.pendingReason,
      sessionId,
      sequence: state.sequence + 1,
      artifacts: [...artifacts],
      artifactsByTurn: cloneProjection(artifactsByTurn),
    };
    state.sequence = change.sequence;
    state.lastSignature = signature;
    state.lastArtifactIds = new Set(artifacts.map((artifact) => artifact.id));
    state.pendingReason = undefined;
    if (state.reconciliationArtifacts !== artifacts) {
      state.reconciliationArtifacts = undefined;
    }
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
    owner,
    ready,
    reconciling,
    sessionId,
  ]);
}
