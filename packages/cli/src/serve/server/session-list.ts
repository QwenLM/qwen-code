/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SessionService,
  SessionOrganizationError,
  type SessionArchiveState,
  type SessionGroupColor,
} from '@qwen-code/qwen-code-core';
import type {
  AcpSessionBridge,
  BridgeSessionSummary,
} from '../acp-session-bridge.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { createSessionOrganizationService } from '../session-organization-helpers.js';

const DEFAULT_SESSION_PAGE_SIZE = 20;
const MAX_SESSION_PAGE_SIZE = 100;
const MAX_ORGANIZED_SESSIONS = 50_000;

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
  liveMergeFailed?: boolean;
  truncated?: boolean;
}

export class InvalidCursorError extends Error {
  constructor(cursor: string, kind: 'numeric' | 'organized' = 'numeric') {
    super(`Invalid cursor: "${cursor}" is not a valid ${kind} cursor`);
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
  group: string;
  archiveState: SessionArchiveState;
  last: OrganizedCursorKey;
}

interface OrganizedCursorKey {
  isPinned: boolean;
  activityTime: number;
  sessionId: string;
}

function parseOrganizedCursor(
  cursor: string,
  expected: { group: string; archiveState: SessionArchiveState },
): OrganizedCursorKey | undefined {
  if (cursor === '') return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;
    const last = (parsed as OrganizedCursor).last;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof last !== 'object' ||
      last === null ||
      Array.isArray(last) ||
      typeof last.isPinned !== 'boolean' ||
      typeof last.activityTime !== 'number' ||
      !Number.isFinite(last.activityTime) ||
      typeof last.sessionId !== 'string' ||
      last.sessionId.length === 0 ||
      (parsed as OrganizedCursor).group !== expected.group ||
      (parsed as OrganizedCursor).archiveState !== expected.archiveState
    ) {
      throw new Error('invalid organized cursor');
    }
    return last;
  } catch {
    throw new InvalidCursorError(cursor, 'organized');
  }
}

function encodeOrganizedCursor(
  last: OrganizedCursorKey,
  group: string,
  archiveState: SessionArchiveState,
): string {
  return Buffer.from(
    JSON.stringify({ group, archiveState, last }),
    'utf8',
  ).toString('base64url');
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
): Promise<{ sessions: BridgeSessionSummary[]; truncated: boolean }> {
  // Organized view needs global pin/group ordering before pagination; v1 keeps
  // the storage API unchanged and performs that merge in memory.
  const sessions: BridgeSessionSummary[] = [];
  let truncated = false;
  let cursor: number | undefined;
  do {
    const page = await sessionService.listSessions({
      cursor,
      size: 10_000,
      archiveState,
    });
    const remaining = MAX_ORGANIZED_SESSIONS - sessions.length;
    sessions.push(...page.items.slice(0, remaining).map(toSummary));
    cursor = page.nextCursor;
    if (page.items.length === 0) {
      break;
    }
    if (
      page.items.length > remaining ||
      (sessions.length >= MAX_ORGANIZED_SESSIONS && cursor !== undefined)
    ) {
      writeStderrLine(
        `qwen serve: organized session list truncated at ${MAX_ORGANIZED_SESSIONS} sessions`,
      );
      truncated = true;
      break;
    }
  } while (cursor !== undefined);
  return { sessions, truncated };
}

function getSummaryActivityTime(session: BridgeSessionSummary): number {
  const time = Date.parse(session.updatedAt ?? session.createdAt);
  return Number.isFinite(time) ? time : 0;
}

function compareOrganizedSessions(
  activityTimeById: ReadonlyMap<string, number>,
  a: BridgeSessionSummary,
  b: BridgeSessionSummary,
): number {
  return compareOrganizedCursorKeys(
    getOrganizedCursorKey(activityTimeById, a),
    getOrganizedCursorKey(activityTimeById, b),
  );
}

function getOrganizedCursorKey(
  activityTimeById: ReadonlyMap<string, number>,
  session: BridgeSessionSummary,
): OrganizedCursorKey {
  return {
    isPinned: session.isPinned === true,
    activityTime: activityTimeById.get(session.sessionId) ?? 0,
    sessionId: session.sessionId,
  };
}

function compareOrganizedCursorKeys(
  a: OrganizedCursorKey,
  b: OrganizedCursorKey,
): number {
  const byPinned = Number(b.isPinned) - Number(a.isPinned);
  if (byPinned !== 0) return byPinned;
  const byTime = b.activityTime - a.activityTime;
  if (byTime !== 0) return byTime;
  return a.sessionId.localeCompare(b.sessionId);
}

function applyOrganization(
  session: BridgeSessionSummary,
  organization:
    | {
        groupId: string | null;
        color?: SessionGroupColor | null;
        isPinned: boolean;
        pinnedAt?: string;
      }
    | undefined,
): BridgeSessionSummary {
  return {
    ...session,
    groupId: organization?.groupId ?? null,
    color: organization?.color ?? null,
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
  const archiveState = options.archiveState ?? 'active';
  const sessionService = new SessionService(workspaceCwd);
  const organizationService = createSessionOrganizationService(workspaceCwd);
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
  const cursorKey =
    options.cursor !== undefined
      ? parseOrganizedCursor(options.cursor, { group, archiveState })
      : undefined;
  const isFirstPage = cursorKey === undefined;
  let liveMergeFailed = false;

  const bySessionId = new Map<string, BridgeSessionSummary>();
  const persisted = await listAllPersistedSummaries(
    sessionService,
    archiveState,
  );
  for (const session of persisted.sessions) {
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
              organization,
            ),
          );
        }
      }
    } catch (error) {
      liveMergeFailed = true;
      writeStderrLine(
        `qwen serve: organized session list live merge failed; using persisted sessions only: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const filtered = [...bySessionId.values()].filter((session) => {
    if (group === 'all') return true;
    if (group === 'pinned') return session.isPinned === true;
    if (group === 'ungrouped')
      return session.groupId == null && session.color == null;
    // Color takes precedence over a named group in the sidebar's bucketing, so
    // a session carrying a color tag is never shown under its group. Keep the
    // named-group filter consistent for REST/ACP consumers (the store allows
    // both fields even though the UI keeps them mutually exclusive).
    return session.color == null && session.groupId === group;
  });
  const activityTimeById = new Map(
    filtered.map((session) => [
      session.sessionId,
      getSummaryActivityTime(session),
    ]),
  );
  filtered.sort((a, b) => compareOrganizedSessions(activityTimeById, a, b));
  const afterCursor =
    cursorKey === undefined
      ? filtered
      : filtered.filter(
          (session) =>
            compareOrganizedCursorKeys(
              cursorKey,
              getOrganizedCursorKey(activityTimeById, session),
            ) < 0,
        );
  const page = afterCursor.slice(0, pageSize);
  const nextCursor =
    page.length < afterCursor.length
      ? encodeOrganizedCursor(
          getOrganizedCursorKey(activityTimeById, page[page.length - 1]!),
          group,
          archiveState,
        )
      : undefined;
  return {
    sessions: page,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    ...(liveMergeFailed ? { liveMergeFailed: true } : {}),
    ...(persisted.truncated ? { truncated: true } : {}),
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
