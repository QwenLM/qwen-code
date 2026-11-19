/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  SessionArtifactStore,
  type SessionArtifactMutationResult,
  type SessionArtifactsEnvelope,
} from '@qwen-code/acp-bridge/sessionArtifacts';
import {
  SessionNotFoundError,
  SessionConflictError,
  SessionArchivingError,
} from '../acp-session-bridge.js';
import {
  SessionArtifactLibraryError,
  SessionStorageEntryError,
  type SessionListItem,
} from '@qwen-code/qwen-code-core/services/sessionService.js';
import { SessionWriterError } from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import { SessionTranscriptTooLargeError } from '@qwen-code/qwen-code-core/services/session-transcript-reader.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';

export interface ArtifactLibrarySessionMetadata {
  displayName?: string;
  createdAt: string;
  archiveState: 'active' | 'archived';
  sourceType: string;
  sourceId?: string;
}

export interface WorkspaceSessionArtifactsEnvelope
  extends SessionArtifactsEnvelope {
  session: ArtifactLibrarySessionMetadata;
}

export class ArtifactLibraryRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ArtifactLibraryMemberError {
  status: number;
  code: string;
  message: string;
}

export function artifactLibraryMemberError(
  error: unknown,
): ArtifactLibraryMemberError {
  if (error instanceof ArtifactLibraryRequestError)
    return { status: error.status, code: error.code, message: error.message };
  if (error instanceof SessionNotFoundError)
    return { status: 404, code: error.code, message: error.message };
  if (error instanceof SessionStorageEntryError)
    return error.reason === 'foreign_project'
      ? {
          status: 404,
          code: 'session_not_found',
          message: 'Session not found.',
        }
      : {
          status: 409,
          code: 'session_storage_conflict',
          message: error.message,
        };
  if (error instanceof SessionArtifactLibraryError)
    return { status: 409, code: error.code, message: error.message };
  if (error instanceof SessionWriterError)
    return {
      status: error.httpStatus,
      code: error.errorKind,
      message: error.message,
    };
  if (error instanceof SessionConflictError)
    return { status: 409, code: 'session_conflict', message: error.message };
  if (error instanceof SessionArchivingError)
    return { status: 409, code: 'session_archiving', message: error.message };
  if (error instanceof SessionTranscriptTooLargeError)
    return {
      status: 413,
      code: 'transcript_too_large',
      message: error.message,
    };
  return {
    status: 500,
    code: 'artifact_library_failed',
    message: 'Could not access session artifacts.',
  };
}

export type ArtifactLibraryRemovalResult = { artifactId: string } & (
  | SessionArtifactMutationResult
  | { sessionId: string; error: ArtifactLibraryMemberError }
);

export async function removeWorkspaceLibraryArtifacts(
  runtime: WorkspaceRuntime,
  sessionId: string,
  artifactIds: string[],
  assertCanMutate: () => void,
): Promise<ArtifactLibraryRemovalResult[]> {
  assertCanMutate();
  if (isLive(runtime, sessionId)) {
    const results: ArtifactLibraryRemovalResult[] = [];
    for (const artifactId of artifactIds) {
      assertCanMutate();
      try {
        results.push({
          ...(await runtime.bridge.removeSessionArtifactForWorkspaceOwner(
            sessionId,
            artifactId,
          )),
          artifactId,
        });
      } catch (error) {
        results.push({
          sessionId,
          artifactId,
          error: artifactLibraryMemberError(error),
        });
      }
    }
    return results;
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
    const removed = await service.removeSessionArtifactsForLibrary(
      sessionId,
      artifactIds,
      {
        assertStorageUnchanged: () => lease.assertOwnedAndUnchanged(),
        assertCanMutate,
      },
    );
    if (removed === undefined) throw new SessionNotFoundError(sessionId);
    return artifactIds.map((artifactId) => ({
      v: 1,
      sessionId,
      artifactId,
      changes: removed.includes(artifactId)
        ? [{ action: 'removed', artifactId, reason: 'explicit' }]
        : [],
    }));
  } finally {
    await lease.release();
  }
}

function isLive(runtime: WorkspaceRuntime, sessionId: string) {
  try {
    runtime.bridge.getSessionSummary(sessionId);
    return true;
  } catch (error) {
    if (error instanceof SessionNotFoundError) return false;
    throw error;
  }
}

export async function readPersistedWorkspaceArtifactLibrary(
  runtime: WorkspaceRuntime,
  sessionId: string,
): Promise<WorkspaceSessionArtifactsEnvelope> {
  const service = createWorkspaceRuntimeSessionService(runtime);
  const location = await service.getMaintainableSessionLocation(sessionId);
  if (!location) throw new SessionNotFoundError(sessionId);
  if (location === 'conflict') throw new SessionConflictError(sessionId);
  const snapshot = await service.readSessionArtifactSnapshot(sessionId);
  if (!snapshot) throw new SessionNotFoundError(sessionId);
  const metadata = await service.getSessionListItem(sessionId, location);
  if (!metadata) throw new SessionNotFoundError(sessionId);
  const envelope = await new SessionArtifactStore({
    sessionId,
    workspaceCwd: runtime.workspaceCwd,
    runtimeBaseDir: runtime.sessionRuntimeBaseDir,
  }).readPersistedLibrary(snapshot);
  const displayName = metadata.customTitle || metadata.prompt;
  return {
    ...envelope,
    session: {
      ...(displayName ? { displayName } : {}),
      createdAt: metadata.startTime,
      archiveState: location,
      sourceType: metadata.sourceType ?? 'default',
      ...(metadata.sourceId !== undefined
        ? { sourceId: metadata.sourceId }
        : {}),
    },
  };
}

export async function readPersistedWorkspaceSessionMetadata(
  runtime: WorkspaceRuntime,
  sessionId: string,
): Promise<SessionListItem | undefined> {
  const service = createWorkspaceRuntimeSessionService(runtime);
  const location = await service.getMaintainableSessionLocation(sessionId);
  if (location === 'conflict') throw new SessionConflictError(sessionId);
  return location ? service.getSessionListItem(sessionId, location) : undefined;
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
