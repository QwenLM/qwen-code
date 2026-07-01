/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SessionService } from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import {
  SessionArchivedError,
  SessionArchivingError,
  SessionConflictError,
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
  private readonly exclusive = new Set<string>();
  private readonly shared = new Map<string, number>();

  assertNotTransitioning(sessionId: string): void {
    if (this.exclusive.has(sessionId)) {
      throw new SessionArchivingError(sessionId);
    }
  }

  async runExclusiveMany<T>(
    sessionIds: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const uniqueSessionIds = [...new Set(sessionIds)];
    for (const sessionId of uniqueSessionIds) {
      this.assertNotTransitioning(sessionId);
      if ((this.shared.get(sessionId) ?? 0) > 0) {
        throw new SessionArchivingError(sessionId);
      }
    }
    for (const sessionId of uniqueSessionIds) {
      this.exclusive.add(sessionId);
    }
    try {
      return await fn();
    } finally {
      for (const sessionId of uniqueSessionIds) {
        this.exclusive.delete(sessionId);
      }
    }
  }

  async runSharedMany<T>(
    sessionIds: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const uniqueSessionIds = [...new Set(sessionIds)];
    for (const sessionId of uniqueSessionIds) {
      this.assertNotTransitioning(sessionId);
    }
    for (const sessionId of uniqueSessionIds) {
      this.shared.set(sessionId, (this.shared.get(sessionId) ?? 0) + 1);
    }
    try {
      return await fn();
    } finally {
      for (const sessionId of uniqueSessionIds) {
        const count = (this.shared.get(sessionId) ?? 1) - 1;
        if (count <= 0) {
          this.shared.delete(sessionId);
        } else {
          this.shared.set(sessionId, count);
        }
      }
    }
  }
}

export async function assertSessionLoadable(
  workspaceCwd: string,
  sessionId: string,
): Promise<void> {
  const location = await new SessionService(workspaceCwd).getSessionLocation(
    sessionId,
  );
  if (location === 'archived') {
    throw new SessionArchivedError(sessionId);
  }
  if (location === 'conflict') {
    throw new SessionConflictError(sessionId);
  }
}

function isSessionNotFoundError(err: unknown): boolean {
  return (
    err instanceof SessionNotFoundError ||
    (err instanceof Error && err.name === 'SessionNotFoundError')
  );
}

interface SessionLocationBuckets {
  active: string[];
  archived: string[];
  notFound: string[];
  errors: Array<{ sessionId: string; error: unknown }>;
}

async function classifySessionLocations(
  service: SessionService,
  sessionIds: string[],
): Promise<SessionLocationBuckets> {
  const result: SessionLocationBuckets = {
    active: [],
    archived: [],
    notFound: [],
    errors: [],
  };
  const locationResults = await Promise.allSettled(
    sessionIds.map(async (sessionId) => ({
      sessionId,
      location: await service.getSessionLocation(sessionId),
    })),
  );
  for (let i = 0; i < locationResults.length; i++) {
    const sessionId = sessionIds[i]!;
    const locationResult = locationResults[i]!;
    if (locationResult.status === 'rejected') {
      result.errors.push({ sessionId, error: locationResult.reason });
      continue;
    }
    const location = locationResult.value.location;
    if (location === undefined) {
      result.notFound.push(sessionId);
    } else if (location === 'archived') {
      result.archived.push(sessionId);
    } else if (location === 'conflict') {
      result.errors.push({
        sessionId,
        error: new Error(`Session archive conflict: ${sessionId}`),
      });
    } else {
      result.active.push(sessionId);
    }
  }
  return result;
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
  const uniqueSessionIds = [...new Set(sessionIds)];
  const archived: string[] = [];
  const alreadyArchived: string[] = [];
  const notFound: string[] = [];
  const errors: Array<{ sessionId: string; error: unknown }> = [];

  const initial = await classifySessionLocations(service, uniqueSessionIds);
  const activeIds = initial.active;
  alreadyArchived.push(...initial.archived);
  notFound.push(...initial.notFound);
  errors.push(...initial.errors);

  if (activeIds.length > 0) {
    await coordinator.runExclusiveMany(activeIds, async () => {
      const locked = await classifySessionLocations(service, activeIds);
      const closableIds = locked.active;
      alreadyArchived.push(...locked.archived);
      notFound.push(...locked.notFound);
      errors.push(...locked.errors);

      // Close+flush before moving JSONL: live writers keep the active path.
      // If the later move fails, the active JSONL remains and a retry treats
      // SessionNotFound as the recoverable "already closed" state.
      const closeResults = await Promise.allSettled(
        closableIds.map(async (sessionId) => {
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
        const sessionId = closableIds[i]!;
        const result = closeResults[i]!;
        if (result.status === 'fulfilled') {
          archiveIds.push(sessionId);
        } else {
          errors.push({ sessionId, error: result.reason });
        }
      }

      try {
        const archiveResult = await service.archiveSessions(archiveIds, {
          knownLocation: 'active',
        });
        archived.push(...archiveResult.archived);
        alreadyArchived.push(...archiveResult.alreadyArchived);
        notFound.push(...archiveResult.notFound);
        errors.push(...archiveResult.errors);
      } catch (err) {
        for (const sessionId of archiveIds) {
          errors.push({ sessionId, error: err });
        }
      }
    });
  }

  logSessionArchiveResult('archive', {
    requested: uniqueSessionIds,
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
  const uniqueSessionIds = [...new Set(sessionIds)];
  const unarchived: string[] = [];
  const alreadyActive: string[] = [];
  const notFound: string[] = [];
  const errors: Array<{ sessionId: string; error: unknown }> = [];

  const initial = await classifySessionLocations(service, uniqueSessionIds);
  const archivedIds = initial.archived;
  alreadyActive.push(...initial.active);
  notFound.push(...initial.notFound);
  errors.push(...initial.errors);

  if (archivedIds.length > 0) {
    await coordinator.runExclusiveMany(archivedIds, async () => {
      const locked = await classifySessionLocations(service, archivedIds);
      const unarchiveIds = locked.archived;
      alreadyActive.push(...locked.active);
      notFound.push(...locked.notFound);
      errors.push(...locked.errors);

      if (unarchiveIds.length > 0) {
        try {
          const result = await service.unarchiveSessions(unarchiveIds);
          unarchived.push(...result.unarchived);
          alreadyActive.push(...result.alreadyActive);
          notFound.push(...result.notFound);
          errors.push(...result.errors);
        } catch (err) {
          // The service reports normal per-session failures in `result.errors`.
          // Reaching this catch means the batch could not produce a result at all.
          for (const sessionId of unarchiveIds) {
            errors.push({ sessionId, error: err });
          }
        }
      }
    });
  }

  logSessionArchiveResult('unarchive', {
    requested: uniqueSessionIds,
    changed: unarchived,
    already: alreadyActive,
    notFound,
    errors,
  });

  return { unarchived, alreadyActive, notFound, errors };
}
