/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SessionService } from '@qwen-code/qwen-code-core';
import { access } from 'node:fs/promises';
import {
  SessionNotFoundError,
  type AcpSessionBridge,
} from './acp-session-bridge.js';
import { normalizeSessionIdForLookup } from '../config/session-id.js';
import type { SessionArchiveCoordinator } from './server/session-archive.js';

export interface RequestedSessionIdTarget {
  readonly bridge: AcpSessionBridge;
  readonly workspaceCwd: string;
  readonly workspaceId?: string;
}

export interface RequestedSessionIdPersistenceTarget {
  readonly workspaceCwd: string;
  readonly runtimeBaseDir: string;
}

export interface RequestedSessionIdReservation {
  release(): void;
}

export type RequestedSessionIdAdmissionErrorCode =
  | 'session_id_conflict'
  | 'session_workspace_conflict'
  | 'session_id_admission_unavailable';

export class RequestedSessionIdAdmissionError extends Error {
  override readonly name = 'RequestedSessionIdAdmissionError';

  constructor(
    readonly code: RequestedSessionIdAdmissionErrorCode,
    readonly sessionId: string,
    message: string,
    readonly details: {
      conflict?: 'live' | 'pending' | 'persisted';
      workspaceCwd?: string;
      workspaceId?: string;
      liveWorkspaceCwd?: string;
      liveWorkspaceId?: string;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
  }
}

interface PendingCreate {
  readonly kind: 'create';
  readonly target: RequestedSessionIdTarget;
}

interface PendingRestore {
  readonly kind: 'restore';
  readonly target: RequestedSessionIdTarget;
  count: number;
}

type PendingAdmission = PendingCreate | PendingRestore;

async function persistedSessionExists(
  sessionService: SessionService,
  sessionId: string,
): Promise<boolean> {
  if ((await sessionService.getSessionLocation(sessionId)) !== undefined) {
    return true;
  }
  if (
    (await sessionService.findSessionIdIgnoringCase?.(sessionId)) !== undefined
  ) {
    return true;
  }

  for (const state of ['active', 'archived'] as const) {
    try {
      await access(
        sessionService.getWorktreeSessionPathForArchiveState(sessionId, state),
      );
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return false;
}

export interface RequestedSessionIdAdmissionOptions {
  readonly archiveCoordinator: SessionArchiveCoordinator;
  readonly getBridges: () => readonly AcpSessionBridge[];
  readonly getPersistenceTargets: () => readonly RequestedSessionIdPersistenceTarget[];
  /**
   * Resolves the registered workspace id for a live bridge, so conflict
   * responses can name the foreign owner. Absent for bridges whose runtime
   * is no longer registered (a replaced generation still draining).
   */
  readonly getBridgeWorkspaceId?: (
    bridge: AcpSessionBridge,
  ) => string | undefined;
}

export interface RequestedSessionIdAdmission {
  reserveCreate(
    sessionId: string,
    target: RequestedSessionIdTarget,
  ): Promise<RequestedSessionIdReservation>;
  reserveRestore(
    sessionId: string,
    target: RequestedSessionIdTarget,
  ): RequestedSessionIdReservation;
}

export function createRequestedSessionIdAdmission({
  archiveCoordinator,
  getBridges,
  getPersistenceTargets,
  getBridgeWorkspaceId,
}: RequestedSessionIdAdmissionOptions): RequestedSessionIdAdmission {
  const pending = new Map<string, PendingAdmission>();

  const liveOwners = (
    sessionId: string,
  ): Array<{
    bridge: AcpSessionBridge;
    workspaceCwd: string;
    workspaceId?: string;
  }> => {
    const owners: Array<{
      bridge: AcpSessionBridge;
      workspaceCwd: string;
      workspaceId?: string;
    }> = [];
    let bridges: readonly AcpSessionBridge[];
    try {
      bridges = getBridges();
    } catch {
      throw new RequestedSessionIdAdmissionError(
        'session_id_admission_unavailable',
        sessionId,
        `Unable to enumerate live bridges for session "${sessionId}".`,
        { retryable: true },
      );
    }
    for (const bridge of new Set(bridges)) {
      try {
        const summary = bridge.getSessionSummary(sessionId);
        owners.push({
          bridge,
          workspaceCwd: summary.workspaceCwd,
          workspaceId: getBridgeWorkspaceId?.(bridge),
        });
      } catch (error) {
        if (error instanceof SessionNotFoundError) continue;
        throw new RequestedSessionIdAdmissionError(
          'session_id_admission_unavailable',
          sessionId,
          `Unable to verify whether session "${sessionId}" is already live.`,
          { retryable: true },
        );
      }
    }
    return owners;
  };

  const conflict = (
    sessionId: string,
    conflictKind: 'live' | 'pending' | 'persisted',
    workspaceCwd?: string,
  ) =>
    new RequestedSessionIdAdmissionError(
      'session_id_conflict',
      sessionId,
      `Session "${sessionId}" already exists or is being created.`,
      {
        conflict: conflictKind,
        ...(workspaceCwd ? { liveWorkspaceCwd: workspaceCwd } : {}),
      },
    );

  const workspaceConflict = (
    sessionId: string,
    target: RequestedSessionIdTarget,
    conflictKind: 'live' | 'pending',
    liveWorkspaceCwd?: string,
    liveWorkspaceId?: string,
  ) =>
    new RequestedSessionIdAdmissionError(
      'session_workspace_conflict',
      sessionId,
      `Session "${sessionId}" is already live or restoring in another workspace runtime.`,
      {
        conflict: conflictKind,
        workspaceCwd: target.workspaceCwd,
        ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
        ...(liveWorkspaceCwd ? { liveWorkspaceCwd } : {}),
        ...(liveWorkspaceId ? { liveWorkspaceId } : {}),
      },
    );

  const createReservation = (
    sessionId: string,
    state: PendingAdmission,
  ): RequestedSessionIdReservation => {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        if (pending.get(sessionId) !== state) return;
        if (state.kind === 'restore' && state.count > 1) {
          state.count--;
          return;
        }
        pending.delete(sessionId);
      },
    };
  };

  return {
    async reserveCreate(rawSessionId, target) {
      const sessionId = normalizeSessionIdForLookup(rawSessionId);
      const live = liveOwners(sessionId)[0];
      if (live) throw conflict(sessionId, 'live', live.workspaceCwd);
      if (pending.has(sessionId)) throw conflict(sessionId, 'pending');

      const state: PendingCreate = { kind: 'create', target };
      pending.set(sessionId, state);
      const reservation = createReservation(sessionId, state);
      try {
        let persisted: RequestedSessionIdPersistenceTarget | undefined;
        try {
          persisted = await archiveCoordinator.runSharedMany(
            [sessionId],
            async () => {
              const targets = [
                ...new Map(
                  getPersistenceTargets().map((entry) => [
                    `${entry.runtimeBaseDir}\0${entry.workspaceCwd}`,
                    entry,
                  ]),
                ).values(),
              ];
              const results = await Promise.all(
                targets.map(async (entry) => {
                  const sessionService = new SessionService(
                    entry.workspaceCwd,
                    { runtimeBaseDir: entry.runtimeBaseDir },
                  );
                  return {
                    entry,
                    exists: await persistedSessionExists(
                      sessionService,
                      sessionId,
                    ),
                  };
                }),
              );
              return results.find((result) => result.exists)?.entry;
            },
          );
        } catch {
          throw new RequestedSessionIdAdmissionError(
            'session_id_admission_unavailable',
            sessionId,
            `Unable to verify persisted state for session "${sessionId}".`,
            { retryable: true },
          );
        }
        if (persisted) {
          throw conflict(sessionId, 'persisted', persisted.workspaceCwd);
        }
        return reservation;
      } catch (error) {
        reservation.release();
        throw error;
      }
    },

    reserveRestore(rawSessionId, target) {
      const sessionId = normalizeSessionIdForLookup(rawSessionId);
      const foreignLive = liveOwners(sessionId).find(
        (owner) => owner.bridge !== target.bridge,
      );
      if (foreignLive) {
        throw workspaceConflict(
          sessionId,
          target,
          'live',
          foreignLive.workspaceCwd,
          foreignLive.workspaceId,
        );
      }

      const existing = pending.get(sessionId);
      if (existing?.kind === 'create') {
        throw conflict(sessionId, 'pending');
      }
      if (existing?.kind === 'restore') {
        if (existing.target.bridge !== target.bridge) {
          throw workspaceConflict(
            sessionId,
            target,
            'pending',
            existing.target.workspaceCwd,
            existing.target.workspaceId,
          );
        }
        existing.count++;
        return createReservation(sessionId, existing);
      }

      const state: PendingRestore = { kind: 'restore', target, count: 1 };
      pending.set(sessionId, state);
      return createReservation(sessionId, state);
    },
  };
}
