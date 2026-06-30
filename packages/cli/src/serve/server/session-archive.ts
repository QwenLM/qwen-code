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
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { safeLogValue } from './request-helpers.js';

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

function logSessionArchiveResult(
  action: 'archive' | 'unarchive',
  result: {
    requested: string[];
    changed: string[];
    already: string[];
    notFound: string[];
    errors: Array<{ sessionId: string; error: unknown }>;
  },
): void {
  const changedLabel = action === 'archive' ? 'archived' : 'unarchived';
  const alreadyLabel =
    action === 'archive' ? 'alreadyArchived' : 'alreadyActive';
  const details = [
    `requested=${result.requested.length} requestedIds=${formatSessionIds(result.requested)}`,
    `${changedLabel}=${result.changed.length} ${changedLabel}Ids=${formatSessionIds(result.changed)}`,
    `${alreadyLabel}=${result.already.length} ${alreadyLabel}Ids=${formatSessionIds(result.already)}`,
    `notFound=${result.notFound.length} notFoundIds=${formatSessionIds(result.notFound)}`,
    `errors=${result.errors.length} errorIds=${formatSessionErrors(result.errors)}`,
  ].join(' ');
  writeStderrLine(`qwen serve: sessions ${action} result ${details}`);
}

function formatSessionIds(sessionIds: string[]): string {
  return `[${sessionIds.map((sessionId) => safeLogValue(sessionId)).join(',')}]`;
}

function formatSessionErrors(
  errors: Array<{ sessionId: string; error: unknown }>,
): string {
  return `[${errors
    .map(
      ({ sessionId, error }) =>
        `${safeLogValue(sessionId)}:${safeLogValue(errorMessage(error))}`,
    )
    .join(',')}]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function logSessionArchiveWarning(message: string): void {
  writeStderrLine(`qwen serve: ${sanitizeLogLine(message)}`);
}

// Control characters are intentionally stripped from daemon log lines.
/* eslint-disable no-control-regex */
const LOG_LINE_UNSAFE_RE =
  /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;
/* eslint-enable no-control-regex */

function sanitizeLogLine(message: string): string {
  return message.replace(LOG_LINE_UNSAFE_RE, ' ').slice(0, 4096);
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
    const activeIds: string[] = [];
    for (const sessionId of sessionIds) {
      try {
        const location = await service.getSessionLocation(sessionId);
        if (location === undefined) {
          notFound.push(sessionId);
        } else if (location === 'archived') {
          alreadyArchived.push(sessionId);
        } else if (location === 'conflict') {
          errors.push({
            sessionId,
            error: new Error(`Session archive conflict: ${sessionId}`),
          });
        } else {
          activeIds.push(sessionId);
        }
      } catch (err) {
        errors.push({ sessionId, error: err });
      }
    }

    // Close+flush before moving JSONL: live writers keep the active path.
    // If the later move fails, the active JSONL remains and a retry treats
    // SessionNotFound as the recoverable "already closed" state.
    const closeResults = await Promise.allSettled(
      activeIds.map(async (sessionId) => {
        try {
          await bridge.closeSession(sessionId, undefined, {
            requireAgentClose: true,
          });
        } catch (err) {
          if (!isSessionNotFoundError(err)) {
            throw err;
          }
        }
      }),
    );
    const archiveIds: string[] = [];
    for (let i = 0; i < closeResults.length; i++) {
      const sessionId = activeIds[i]!;
      const result = closeResults[i]!;
      if (result.status === 'fulfilled') {
        archiveIds.push(sessionId);
      } else {
        errors.push({ sessionId, error: result.reason });
      }
    }

    for (const sessionId of archiveIds) {
      try {
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

  logSessionArchiveResult('archive', {
    requested: sessionIds,
    changed: archived,
    already: alreadyArchived,
    notFound,
    errors,
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
      // The service reports normal per-session failures in `result.errors`.
      // Reaching this catch means the batch could not produce a result at all.
      for (const sessionId of sessionIds) {
        errors.push({ sessionId, error: err });
      }
    }
  });

  logSessionArchiveResult('unarchive', {
    requested: sessionIds,
    changed: unarchived,
    already: alreadyActive,
    notFound,
    errors,
  });

  return { unarchived, alreadyActive, notFound, errors };
}
