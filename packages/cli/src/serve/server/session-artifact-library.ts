/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  SessionArtifactStore,
  type SessionArtifactMutationResult,
} from '@qwen-code/acp-bridge/sessionArtifacts';
import {
  SessionNotFoundError,
  SessionConflictError,
} from '../acp-session-bridge.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';

function isLive(runtime: WorkspaceRuntime, sessionId: string) {
  try {
    runtime.bridge.getSessionSummary(sessionId);
    return true;
  } catch (error) {
    if (error instanceof SessionNotFoundError) return false;
    throw error;
  }
}

export async function readWorkspaceArtifactLibrary(
  runtime: WorkspaceRuntime,
  sessionId: string,
) {
  if (isLive(runtime, sessionId))
    return runtime.bridge.getSessionArtifacts(sessionId);
  const service = createWorkspaceRuntimeSessionService(runtime);
  const location = await service.getMaintainableSessionLocation(sessionId);
  if (!location) throw new SessionNotFoundError(sessionId);
  if (location === 'conflict') throw new SessionConflictError(sessionId);
  const snapshot = await service.readSessionArtifactSnapshot(sessionId);
  if (!snapshot) throw new SessionNotFoundError(sessionId);
  return new SessionArtifactStore({
    sessionId,
    workspaceCwd: runtime.workspaceCwd,
    runtimeBaseDir: runtime.sessionRuntimeBaseDir,
  }).readPersistedLibrary(snapshot);
}

export async function removeWorkspaceLibraryArtifact(
  runtime: WorkspaceRuntime,
  sessionId: string,
  artifactId: string,
  assertCanMutate: () => void,
): Promise<SessionArtifactMutationResult> {
  assertCanMutate();
  if (isLive(runtime, sessionId)) {
    return runtime.bridge.removeSessionArtifactForWorkspaceOwner(
      sessionId,
      artifactId,
    );
  }
  const service = createWorkspaceRuntimeSessionService(runtime);
  const location = await service.getMaintainableSessionLocation(sessionId);
  if (!location) throw new SessionNotFoundError(sessionId);
  if (location === 'conflict') throw new SessionConflictError(sessionId);
  const options = {
    processKind: 'daemon' as const,
    reclaimPolicy: 'never' as const,
  };
  const lease =
    location === 'active'
      ? await service.acquireSessionWriterLease(sessionId, {
          ...options,
          takeoverPolicy: 'certified',
        })
      : await service.acquireSessionMaintenanceLease(sessionId, options);
  try {
    const removed = await service.removeSessionArtifactForLibrary(
      sessionId,
      artifactId,
      {
        assertStorageUnchanged: () => lease.assertOwnedAndUnchanged(),
        assertCanMutate,
      },
    );
    if (removed === undefined) throw new SessionNotFoundError(sessionId);
    return {
      v: 1,
      sessionId,
      changes: removed
        ? [{ action: 'removed', artifactId, reason: 'explicit' }]
        : [],
    };
  } finally {
    await lease.release();
  }
}
