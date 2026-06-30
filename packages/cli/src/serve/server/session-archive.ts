/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionService } from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import {
  SessionArchivedError,
  SessionArchivingError,
  SessionNotFoundError,
} from '../acp-session-bridge.js';

export interface DaemonArchiveSessionsResult {
  archived: string[];
  alreadyArchived: string[];
  notFound: string[];
  errors: Array<{ sessionId: string; error: unknown }>;
}

export interface DaemonUnarchiveSessionsResult {
  unarchived: string[];
  alreadyActive: string[];
  notFound: string[];
  errors: Array<{ sessionId: string; error: unknown }>;
}

export class SessionArchiveCoordinator {
  private readonly inFlight = new Set<string>();

  assertNotTransitioning(sessionId: string): void {
    if (this.inFlight.has(sessionId)) {
      throw new SessionArchivingError(sessionId);
    }
  }

  async runExclusiveMany<T>(
    sessionIds: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    for (const sessionId of sessionIds) {
      this.assertNotTransitioning(sessionId);
    }
    for (const sessionId of sessionIds) {
      this.inFlight.add(sessionId);
    }
    try {
      return await fn();
    } finally {
      for (const sessionId of sessionIds) {
        this.inFlight.delete(sessionId);
      }
    }
  }
}

export async function assertSessionLoadable(
  sessionService: SessionService,
  sessionId: string,
): Promise<void> {
  const location = await sessionService.getSessionLocation(sessionId);
  if (location === 'archived' || location === 'conflict') {
    throw new SessionArchivedError(sessionId);
  }
}

function isSessionNotFoundError(err: unknown): boolean {
  return (
    err instanceof SessionNotFoundError ||
    (err instanceof Error && err.name === 'SessionNotFoundError')
  );
}

export async function archiveDaemonSessions(params: {
  sessionIds: string[];
  service: SessionService;
  bridge: Pick<AcpSessionBridge, 'closeSession'>;
  coordinator: SessionArchiveCoordinator;
}): Promise<DaemonArchiveSessionsResult> {
  const { sessionIds, service, bridge, coordinator } = params;
  const archived: string[] = [];
  const alreadyArchived: string[] = [];
  const notFound: string[] = [];
  const errors: Array<{ sessionId: string; error: unknown }> = [];

  await coordinator.runExclusiveMany(sessionIds, async () => {
    for (const sessionId of sessionIds) {
      try {
        try {
          await bridge.closeSession(sessionId, undefined, {
            requireAgentClose: true,
          });
        } catch (err) {
          if (!isSessionNotFoundError(err)) {
            throw err;
          }
        }
        const result = await service.archiveSessions([sessionId]);
        archived.push(...result.archived);
        alreadyArchived.push(...result.alreadyArchived);
        notFound.push(...result.notFound);
        errors.push(...result.errors);
      } catch (err) {
        errors.push({ sessionId, error: err });
      }
    }
  });

  return { archived, alreadyArchived, notFound, errors };
}

export async function unarchiveDaemonSessions(params: {
  sessionIds: string[];
  service: SessionService;
  coordinator: SessionArchiveCoordinator;
}): Promise<DaemonUnarchiveSessionsResult> {
  const { sessionIds, service, coordinator } = params;
  const unarchived: string[] = [];
  const alreadyActive: string[] = [];
  const notFound: string[] = [];
  const errors: Array<{ sessionId: string; error: unknown }> = [];

  await coordinator.runExclusiveMany(sessionIds, async () => {
    try {
      const result = await service.unarchiveSessions(sessionIds);
      unarchived.push(...result.unarchived);
      alreadyActive.push(...result.alreadyActive);
      notFound.push(...result.notFound);
      errors.push(...result.errors);
    } catch (err) {
      for (const sessionId of sessionIds) {
        errors.push({ sessionId, error: err });
      }
    }
  });

  return { unarchived, alreadyActive, notFound, errors };
}
