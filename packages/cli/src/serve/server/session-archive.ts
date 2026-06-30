/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { Storage, type SessionService } from '@qwen-code/qwen-code-core';
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

const SESSION_JSONL_FILE_PATTERN = /^[0-9a-fA-F-]{32,36}\.jsonl$/;

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

export function assertSessionLoadable(
  workspaceCwd: string,
  sessionId: string,
): void {
  const location = getSessionLocationByPath(workspaceCwd, sessionId);
  if (location === 'archived') {
    throw new SessionArchivedError(sessionId);
  }
  if (location === 'conflict') {
    throw new SessionConflictError(sessionId);
  }
}

function getSessionLocationByPath(
  workspaceCwd: string,
  sessionId: string,
): 'active' | 'archived' | 'conflict' | undefined {
  if (!SESSION_JSONL_FILE_PATTERN.test(`${sessionId}.jsonl`)) {
    return undefined;
  }

  const chatsDir = path.join(
    new Storage(workspaceCwd).getProjectDir(),
    'chats',
  );
  const active = fs.existsSync(path.join(chatsDir, `${sessionId}.jsonl`));
  const archived = fs.existsSync(
    path.join(chatsDir, 'archive', `${sessionId}.jsonl`),
  );

  if (active && archived) return 'conflict';
  if (active) return 'active';
  if (archived) return 'archived';
  return undefined;
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
  const uniqueSessionIds = [...new Set(sessionIds)];
  const archived: string[] = [];
  const alreadyArchived: string[] = [];
  const notFound: string[] = [];
  const errors: Array<{ sessionId: string; error: unknown }> = [];

  await coordinator.runExclusiveMany(uniqueSessionIds, async () => {
    const activeIds: string[] = [];
    for (const sessionId of uniqueSessionIds) {
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

    try {
      const result = await service.archiveSessions(archiveIds, {
        knownLocation: 'active',
      });
      archived.push(...result.archived);
      alreadyArchived.push(...result.alreadyArchived);
      notFound.push(...result.notFound);
      errors.push(...result.errors);
    } catch (err) {
      for (const sessionId of archiveIds) {
        errors.push({ sessionId, error: err });
      }
    }
  });

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
