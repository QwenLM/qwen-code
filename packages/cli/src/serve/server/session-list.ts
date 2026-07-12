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
  /**
   * Restrict the result to sessions spawned by this parent (via
   * `create_sub_session`), matched exactly against each session's
   * `parentSessionId`. When set on the default (non-organized) path the whole
   * workspace is gathered and filtered before pagination, so a page is never
   * silently short of matches; the returned cursor is opaque and activity-based
   * (not the numeric storage cursor). Absent = no parent filter.
   */
  parentSessionId?: string;
}

export interface ListWorkspaceSessionsResult {
  sessions: BridgeSessionSummary[];
  nextCursor?: string;
  liveMergeFailed?: boolean;
  truncated?: boolean;
}

export interface ListWorkspaceSessionsReadOptions {
  /** Merge live bridge state into persisted summaries. */
  mergeLive?: boolean;
}

export class InvalidCursorError extends Error {
  constructor(
    cursor: string,
    kind: 'numeric' | 'organized' | 'live' | 'parent' = 'numeric',
  ) {
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

interface LiveSessionCursorKey {
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

function parseLiveSessionCursor(
  cursor: string,
): LiveSessionCursorKey | undefined {
  if (cursor === '') return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as LiveSessionCursorKey).activityTime !== 'number' ||
      !Number.isFinite((parsed as LiveSessionCursorKey).activityTime) ||
      typeof (parsed as LiveSessionCursorKey).sessionId !== 'string' ||
      (parsed as LiveSessionCursorKey).sessionId.length === 0
    ) {
      throw new Error('invalid live cursor');
    }
    return parsed as LiveSessionCursorKey;
  } catch {
    throw new InvalidCursorError(cursor, 'live');
  }
}

function encodeLiveSessionCursor(last: LiveSessionCursorKey): string {
  return Buffer.from(JSON.stringify(last), 'utf8').toString('base64url');
}

/**
 * Decodes a `?parentSessionId=` page cursor, binding it to the query that
 * produced it. The cursor carries the `parentSessionId` and `archiveState` it
 * was minted for, and decode REJECTS a cursor whose scope differs from the
 * current request — otherwise a cursor from parent A (or from the active set)
 * replayed against parent B (or the archived set) would be accepted and
 * silently skip every session newer than that unrelated key. Same
 * bind-and-validate contract as {@link parseOrganizedCursor}.
 */
function parseParentSessionCursor(
  cursor: string,
  expected: { parentSessionId: string; archiveState: SessionArchiveState },
): LiveSessionCursorKey | undefined {
  if (cursor === '') return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as unknown;
    const last = (parsed as { last?: LiveSessionCursorKey }).last;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof last !== 'object' ||
      last === null ||
      Array.isArray(last) ||
      typeof last.activityTime !== 'number' ||
      !Number.isFinite(last.activityTime) ||
      typeof last.sessionId !== 'string' ||
      last.sessionId.length === 0 ||
      (parsed as { parentSessionId?: unknown }).parentSessionId !==
        expected.parentSessionId ||
      (parsed as { archiveState?: unknown }).archiveState !==
        expected.archiveState
    ) {
      throw new Error('invalid parent cursor');
    }
    return { activityTime: last.activityTime, sessionId: last.sessionId };
  } catch {
    throw new InvalidCursorError(cursor, 'parent');
  }
}

function encodeParentSessionCursor(
  last: LiveSessionCursorKey,
  parentSessionId: string,
  archiveState: SessionArchiveState,
): string {
  return Buffer.from(
    JSON.stringify({ parentSessionId, archiveState, last }),
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
  parentSessionId?: string;
  isArchived?: boolean;
}): BridgeSessionSummary {
  return {
    sessionId: item.sessionId,
    workspaceCwd: item.cwd,
    createdAt: item.startTime,
    updatedAt: new Date(item.mtime).toISOString(),
    displayName: item.customTitle || item.prompt,
    ...(item.parentSessionId ? { parentSessionId: item.parentSessionId } : {}),
    clientCount: 0,
    hasActivePrompt: false,
    isArchived: item.isArchived === true,
  };
}

/**
 * Merges a live session's summary onto its persisted counterpart for a session
 * that exists in both. The persisted record owns identity/immutable facts
 * (`createdAt`, `parentSessionId` lineage) while the live entry owns volatile
 * state (`clientCount`, `hasActivePrompt`, a fresher `displayName`/`updatedAt`).
 * Shared by all three list paths (default, organized, by-parent) so the merge
 * rule lives in one place.
 */
function mergeLiveSessionSummary(
  existing: BridgeSessionSummary,
  live: BridgeSessionSummary,
): BridgeSessionSummary {
  return {
    ...existing,
    ...live,
    createdAt: existing.createdAt,
    displayName: live.displayName ?? existing.displayName,
    // Immutable lineage; the persisted transcript is authoritative, and a live
    // entry only carries it when spawned this run.
    parentSessionId: existing.parentSessionId ?? live.parentSessionId,
    updatedAt: live.updatedAt ?? existing.updatedAt,
    clientCount: live.clientCount,
    hasActivePrompt: live.hasActivePrompt,
    isArchived: false,
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

function getLiveSessionCursorKey(
  session: BridgeSessionSummary,
): LiveSessionCursorKey {
  return {
    activityTime: getSummaryActivityTime(session),
    sessionId: session.sessionId,
  };
}

function compareLiveSessionCursorKeys(
  a: LiveSessionCursorKey,
  b: LiveSessionCursorKey,
): number {
  const byTime = b.activityTime - a.activityTime;
  if (byTime !== 0) return byTime;
  return a.sessionId.localeCompare(b.sessionId);
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
  readOptions: ListWorkspaceSessionsReadOptions,
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

  if (
    readOptions.mergeLive !== false &&
    archiveState !== 'archived' &&
    isFirstPage
  ) {
    try {
      const liveSessions = bridge.listWorkspaceSessions(workspaceCwd);
      for (const live of liveSessions) {
        const existing = bySessionId.get(live.sessionId);
        const organization = snapshot.sessions.get(live.sessionId);
        if (existing) {
          bySessionId.set(
            live.sessionId,
            applyOrganization(
              mergeLiveSessionSummary(existing, live),
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

/**
 * Lists only the sessions spawned by `parentSessionId`. Unlike the default
 * storage-paginated path, this gathers the whole workspace (capped, like the
 * organized view) and filters before paginating, so a page is never short of
 * matches and the client can page to completion without wading through empty
 * pages. Sorted newest-activity-first and paginated with the same opaque
 * activity cursor as the live-only path.
 */
async function listWorkspaceSessionsByParentForResponse(
  bridge: AcpSessionBridge,
  workspaceCwd: string,
  options: ListWorkspaceSessionsOptions,
  pageSize: number,
  parentSessionId: string,
  readOptions: ListWorkspaceSessionsReadOptions,
): Promise<ListWorkspaceSessionsResult> {
  const archiveState = options.archiveState ?? 'active';
  const sessionService = new SessionService(workspaceCwd);
  const bySessionId = new Map<string, BridgeSessionSummary>();
  const persisted = await listAllPersistedSummaries(
    sessionService,
    archiveState,
  );
  for (const session of persisted.sessions) {
    bySessionId.set(session.sessionId, session);
  }

  let liveMergeFailed = false;
  if (readOptions.mergeLive !== false && archiveState !== 'archived') {
    try {
      for (const live of bridge.listWorkspaceSessions(workspaceCwd)) {
        const existing = bySessionId.get(live.sessionId);
        if (existing) {
          bySessionId.set(
            live.sessionId,
            mergeLiveSessionSummary(existing, live),
          );
        } else if (!(await sessionService.sessionExists(live.sessionId))) {
          bySessionId.set(live.sessionId, {
            ...live,
            createdAt: live.createdAt,
            clientCount: live.clientCount,
            hasActivePrompt: live.hasActivePrompt,
            isArchived: false,
          });
        }
      }
    } catch (error) {
      liveMergeFailed = true;
      writeStderrLine(
        `qwen serve: session-by-parent live merge failed; using persisted sessions only: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const matches = [...bySessionId.values()]
    .filter((session) => session.parentSessionId === parentSessionId)
    .sort((a, b) =>
      compareLiveSessionCursorKeys(
        getLiveSessionCursorKey(a),
        getLiveSessionCursorKey(b),
      ),
    );
  const cursorKey =
    options.cursor !== undefined && options.cursor !== ''
      ? parseParentSessionCursor(options.cursor, {
          parentSessionId,
          archiveState,
        })
      : undefined;
  const afterCursor =
    cursorKey === undefined
      ? matches
      : matches.filter(
          (session) =>
            compareLiveSessionCursorKeys(
              cursorKey,
              getLiveSessionCursorKey(session),
            ) < 0,
        );
  const page = afterCursor.slice(0, pageSize);
  const nextCursor =
    page.length < afterCursor.length
      ? encodeParentSessionCursor(
          getLiveSessionCursorKey(page[page.length - 1]!),
          parentSessionId,
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
  readOptions: ListWorkspaceSessionsReadOptions = {},
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
      readOptions,
    );
  }

  if (options?.parentSessionId !== undefined) {
    return listWorkspaceSessionsByParentForResponse(
      bridge,
      workspaceCwd,
      options,
      pageSize,
      options.parentSessionId,
      readOptions,
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

  if (archiveState === 'archived' || readOptions.mergeLive === false) {
    const sessions = [...bySessionId.values()];
    const nextCursor =
      persisted.nextCursor != null ? String(persisted.nextCursor) : undefined;
    return { sessions, nextCursor };
  }

  const liveSessions = bridge.listWorkspaceSessions(workspaceCwd);
  for (const live of liveSessions) {
    const existing = bySessionId.get(live.sessionId);
    if (existing) {
      bySessionId.set(live.sessionId, mergeLiveSessionSummary(existing, live));
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

export function listLiveWorkspaceSessionsForResponse(
  bridge: AcpSessionBridge,
  workspaceCwd: string,
  options?: Pick<ListWorkspaceSessionsOptions, 'cursor' | 'size'>,
): ListWorkspaceSessionsResult {
  const rawSize = options?.size;
  const requestedSize =
    typeof rawSize === 'number' && Number.isSafeInteger(rawSize)
      ? rawSize
      : DEFAULT_SESSION_PAGE_SIZE;
  const pageSize = Math.min(Math.max(requestedSize, 1), MAX_SESSION_PAGE_SIZE);
  const cursorKey =
    options?.cursor !== undefined
      ? parseLiveSessionCursor(options.cursor)
      : undefined;
  const sessions = bridge
    .listWorkspaceSessions(workspaceCwd)
    .sort((a, b) =>
      compareLiveSessionCursorKeys(
        getLiveSessionCursorKey(a),
        getLiveSessionCursorKey(b),
      ),
    );
  const afterCursor =
    cursorKey === undefined
      ? sessions
      : sessions.filter(
          (session) =>
            compareLiveSessionCursorKeys(
              cursorKey,
              getLiveSessionCursorKey(session),
            ) < 0,
        );
  const page = afterCursor.slice(0, pageSize);
  const nextCursor =
    page.length < afterCursor.length
      ? encodeLiveSessionCursor(getLiveSessionCursorKey(page[page.length - 1]!))
      : undefined;
  return {
    sessions: page,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
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
