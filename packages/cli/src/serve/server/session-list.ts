/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SessionService,
  SessionOrganizationError,
  SessionOrganizationService,
  type SessionArchiveState,
} from '@qwen-code/qwen-code-core';
import type {
  AcpSessionBridge,
  BridgeSessionSummary,
} from '../acp-session-bridge.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

const DEFAULT_SESSION_PAGE_SIZE = 20;
const MAX_SESSION_PAGE_SIZE = 100;

export interface ListWorkspaceSessionsOptions {
  cursor?: string;
  size?: number;
  archiveState?: SessionArchiveState;
  view?: 'organized';
  group?: string;
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

interface OrganizedCursor {
  offset: number;
}

function parseOrganizedCursor(cursor: string): number | undefined {
  if (cursor === '') return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      !Number.isSafeInteger((parsed as OrganizedCursor).offset) ||
      (parsed as OrganizedCursor).offset < 0
    ) {
      throw new Error('invalid organized cursor');
    }
    return (parsed as OrganizedCursor).offset;
  } catch {
    throw new InvalidCursorError(cursor);
  }
}

function encodeOrganizedCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function toSummary(item: {
  sessionId: string;
  cwd: string;
  startTime: string;
  mtime: number;
  prompt: string;
  customTitle?: string;
  isArchived?: boolean;
}): BridgeSessionSummary {
  return {
    sessionId: item.sessionId,
    workspaceCwd: item.cwd,
    createdAt: item.startTime,
    updatedAt: new Date(item.mtime).toISOString(),
    displayName: item.customTitle || item.prompt,
    clientCount: 0,
    hasActivePrompt: false,
    isArchived: item.isArchived === true,
  };
}

async function listAllPersistedSummaries(
  sessionService: SessionService,
  archiveState: SessionArchiveState,
): Promise<BridgeSessionSummary[]> {
  // Organized view needs global pin/group ordering before pagination; v1 keeps
  // the storage API unchanged and performs that merge in memory.
  const sessions: BridgeSessionSummary[] = [];
  let cursor: number | undefined;
  do {
    const page = await sessionService.listSessions({
      cursor,
      size: 10_000,
      archiveState,
    });
    sessions.push(...page.items.map(toSummary));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return sessions;
}

function getSummaryActivityTime(session: BridgeSessionSummary): number {
  const time = Date.parse(session.updatedAt ?? session.createdAt);
  return Number.isFinite(time) ? time : 0;
}

function compareOrganizedSessions(
  a: BridgeSessionSummary,
  b: BridgeSessionSummary,
): number {
  const byPinned = Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned));
  if (byPinned !== 0) return byPinned;
  const byTime = getSummaryActivityTime(b) - getSummaryActivityTime(a);
  if (byTime !== 0) return byTime;
  return a.sessionId.localeCompare(b.sessionId);
}

function applyOrganization(
  session: BridgeSessionSummary,
  organization:
    | {
        groupId: string | null;
        isPinned: boolean;
        pinnedAt?: string;
      }
    | undefined,
): BridgeSessionSummary {
  return {
    ...session,
    groupId: organization?.groupId ?? null,
    isPinned: organization?.isPinned === true,
    ...(organization?.pinnedAt !== undefined
      ? { pinnedAt: organization.pinnedAt }
      : {}),
  };
}

async function listOrganizedWorkspaceSessionsForResponse(
  bridge: AcpSessionBridge,
  workspaceCwd: string,
  options: ListWorkspaceSessionsOptions,
  pageSize: number,
): Promise<ListWorkspaceSessionsResult> {
  const offset =
    options.cursor !== undefined
      ? (parseOrganizedCursor(options.cursor) ?? 0)
      : 0;
  const archiveState = options.archiveState ?? 'active';
  const isFirstPage = offset === 0;
  const sessionService = new SessionService(workspaceCwd);
  const organizationService = new SessionOrganizationService(workspaceCwd);
  const snapshot = await organizationService.readSnapshot();
  const knownGroupIds = new Set(snapshot.groups.map((group) => group.id));
  const group = options.group ?? 'all';
  if (
    group !== 'all' &&
    group !== 'pinned' &&
    group !== 'ungrouped' &&
    !knownGroupIds.has(group)
  ) {
    throw new SessionOrganizationError(
      `Group not found: ${group}`,
      'group_not_found',
      'group',
    );
  }

  const bySessionId = new Map<string, BridgeSessionSummary>();
  for (const session of await listAllPersistedSummaries(
    sessionService,
    archiveState,
  )) {
    bySessionId.set(
      session.sessionId,
      applyOrganization(session, snapshot.sessions.get(session.sessionId)),
    );
  }

  if (archiveState !== 'archived' && isFirstPage) {
    try {
      const liveSessions = bridge.listWorkspaceSessions(workspaceCwd);
      for (const live of liveSessions) {
        const existing = bySessionId.get(live.sessionId);
        const organization = snapshot.sessions.get(live.sessionId);
        if (existing) {
          bySessionId.set(
            live.sessionId,
            applyOrganization(
              {
                ...existing,
                ...live,
                createdAt: existing.createdAt,
                displayName: live.displayName ?? existing.displayName,
                updatedAt: live.updatedAt ?? existing.updatedAt,
                clientCount: live.clientCount,
                hasActivePrompt: live.hasActivePrompt,
                isArchived: false,
              },
              organization,
            ),
          );
        } else if (!(await sessionService.sessionExists(live.sessionId))) {
          bySessionId.set(
            live.sessionId,
            applyOrganization(
              {
                ...live,
                createdAt: live.createdAt,
                clientCount: live.clientCount,
                hasActivePrompt: live.hasActivePrompt,
                isArchived: false,
              },
              undefined,
            ),
          );
        }
      }
    } catch (error) {
      writeStderrLine(
        `qwen serve: organized session list live merge failed; using persisted sessions only: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const filtered = [...bySessionId.values()]
    .filter((session) => {
      if (group === 'all') return true;
      if (group === 'pinned') return session.isPinned === true;
      if (group === 'ungrouped') return session.groupId == null;
      return session.groupId === group;
    })
    .sort(compareOrganizedSessions);
  const page = filtered.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  const nextCursor =
    nextOffset < filtered.length
      ? encodeOrganizedCursor(nextOffset)
      : undefined;
  return {
    sessions: page,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
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

  if (options?.view === 'organized') {
    return listOrganizedWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      options,
      pageSize,
    );
  }

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
    bySessionId.set(item.sessionId, toSummary(item));
  }

  if (archiveState === 'archived') {
    const sessions = [...bySessionId.values()];
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
