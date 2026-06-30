/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SessionService,
  type SessionArchiveState,
} from '@qwen-code/qwen-code-core';
import type {
  AcpSessionBridge,
  BridgeSessionSummary,
} from '../acp-session-bridge.js';

const DEFAULT_SESSION_PAGE_SIZE = 20;
const MAX_SESSION_PAGE_SIZE = 100;

export interface ListWorkspaceSessionsOptions {
  cursor?: string;
  size?: number;
  archiveState?: SessionArchiveState;
}

export interface ListWorkspaceSessionsResult {
  sessions: BridgeSessionSummary[];
  nextCursor?: string;
}

export class InvalidCursorError extends Error {
  constructor(cursor: string) {
    super(`Invalid cursor: "${cursor}" is not a valid numeric cursor`);
    this.name = 'InvalidCursorError';
  }
}

function parseSessionCursor(cursor: string): number | undefined {
  if (cursor === '') return undefined;
  const trimmed = cursor.trim();
  const parsed = Number(trimmed);
  if (
    trimmed === '' ||
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    parsed > Number.MAX_SAFE_INTEGER
  ) {
    throw new InvalidCursorError(cursor);
  }
  return parsed;
}

export async function listWorkspaceSessionsForResponse(
  bridge: AcpSessionBridge,
  workspaceCwd: string,
  options?: ListWorkspaceSessionsOptions,
): Promise<ListWorkspaceSessionsResult> {
  const rawSize = options?.size;
  const requestedSize =
    typeof rawSize === 'number' && Number.isSafeInteger(rawSize)
      ? rawSize
      : DEFAULT_SESSION_PAGE_SIZE;
  const pageSize = Math.min(Math.max(requestedSize, 1), MAX_SESSION_PAGE_SIZE);

  let numericCursor: number | undefined;
  if (options?.cursor != null) {
    numericCursor = parseSessionCursor(options.cursor);
  }
  const isFirstPage = numericCursor === undefined;

  const sessionService = new SessionService(workspaceCwd);
  const archiveState = options?.archiveState ?? 'active';
  const persisted = await sessionService.listSessions({
    cursor: numericCursor,
    size: pageSize,
    archiveState,
  });
  const bySessionId = new Map<string, BridgeSessionSummary>();

  for (const item of persisted.items) {
    bySessionId.set(item.sessionId, {
      sessionId: item.sessionId,
      workspaceCwd: item.cwd,
      createdAt: item.startTime,
      updatedAt: new Date(item.mtime).toISOString(),
      displayName: item.customTitle || item.prompt,
      clientCount: 0,
      hasActivePrompt: false,
      isArchived: item.isArchived === true,
    });
  }

  if (archiveState === 'archived') {
    const sessions = [...bySessionId.values()].sort((a, b) => {
      const aTime = Date.parse(a.updatedAt ?? a.createdAt);
      const bTime = Date.parse(b.updatedAt ?? b.createdAt);
      return bTime - aTime;
    });
    const nextCursor =
      persisted.nextCursor != null ? String(persisted.nextCursor) : undefined;
    return { sessions, nextCursor };
  }

  const liveSessions = bridge.listWorkspaceSessions(workspaceCwd);
  for (const live of liveSessions) {
    const existing = bySessionId.get(live.sessionId);
    if (existing) {
      bySessionId.set(live.sessionId, {
        ...existing,
        ...live,
        createdAt: existing.createdAt,
        displayName: live.displayName ?? existing.displayName,
        updatedAt: live.updatedAt ?? existing.updatedAt,
        clientCount: live.clientCount,
        hasActivePrompt: live.hasActivePrompt,
        isArchived: false,
      });
    } else if (
      isFirstPage &&
      !(await sessionService.sessionExists(live.sessionId))
    ) {
      bySessionId.set(live.sessionId, {
        ...live,
        createdAt: live.createdAt,
        clientCount: live.clientCount,
        hasActivePrompt: live.hasActivePrompt,
        isArchived: false,
      });
    }
  }

  const sessions = [...bySessionId.values()].sort((a, b) => {
    const aTime = Date.parse(a.updatedAt ?? a.createdAt);
    const bTime = Date.parse(b.updatedAt ?? b.createdAt);
    return bTime - aTime;
  });

  const nextCursor =
    persisted.nextCursor != null ? String(persisted.nextCursor) : undefined;

  return { sessions, nextCursor };
}

export function parseSessionPageSizeQuery(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return undefined;
  if (Number.isSafeInteger(parsed)) return parsed;
  return trimmed.startsWith('-') ? 1 : MAX_SESSION_PAGE_SIZE;
}
