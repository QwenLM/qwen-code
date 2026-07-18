/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SessionService,
  SessionOrganizationError,
  type SessionArchiveState,
  type SessionGroupPresetColor,
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
  /** Restrict results to sessions created by this source type. */
  sourceType?: string;
  /** Further restrict `sourceType` matches to this source identifier. */
  sourceId?: string;
}

export interface ListWorkspaceSessionsResult {
  sessions: BridgeSessionSummary[];
  nextCursor?: string;
  liveMergeFailed?: boolean;
  truncated?: boolean;
}

/**
 * Aggregate session counts for `GET .../session-info`.
 *
 * `expensive` is always true: the persisted totals require a disk scan of
 * local JSONL files and must not be polled in a tight loop.
 */
export interface WorkspaceSessionInfoResult {
  active: number;
  archived: number;
  total: number;
  live?: number;
  expensive: true;
  /**
   * Stable machine-readable hint that this response came from a full disk
   * scan. Clients should refresh infrequently / on demand only.
   */
  cost: 'disk_scan';
  truncated?: boolean;
}

export interface ListWorkspaceSessionsReadOptions {
  /** Merge live bridge state into persisted summaries. */
  mergeLive?: boolean;
}

export class InvalidCursorError extends Error {
  constructor(
    cursor: string,
    kind: 'numeric' | 'organized' | 'live' | 'parent' | 'metadata' = 'numeric',
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
  sourceType?: string;
  sourceId?: string;
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
  expected: {
    group: string;
    archiveState: SessionArchiveState;
    sourceType?: string;
    sourceId?: string;
  },
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
      (parsed as OrganizedCursor).archiveState !== expected.archiveState ||
      (parsed as OrganizedCursor).sourceType !== expected.sourceType ||
      (parsed as OrganizedCursor).sourceId !== expected.sourceId
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
  sourceType?: string,
  sourceId?: string,
): string {
  return Buffer.from(
    JSON.stringify({ group, archiveState, sourceType, sourceId, last }),
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

/** Binds an opaque cursor to the metadata filter that produced it. */
interface SessionMetadataFilter {
  parentSessionId?: string;
  sourceType?: string;
  sourceId?: string;
}

function matchesSessionMetadataSource(
  session: BridgeSessionSummary,
  filter: Pick<SessionMetadataFilter, 'sourceType' | 'sourceId'>,
): boolean {
  const sourceTypeMatches =
    filter.sourceType === undefined ||
    session.sourceType === filter.sourceType ||
    // Legacy sessions without source metadata belong to the default catalog.
    (filter.sourceType === 'default' && session.sourceType === undefined);
  return (
    sourceTypeMatches &&
    // sourceId remains exact; only the default source type has legacy fallback.
    (filter.sourceId === undefined || session.sourceId === filter.sourceId)
  );
}

function parseMetadataSessionCursor(
  cursor: string,
  expected: SessionMetadataFilter & { archiveState: SessionArchiveState },
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
      (parsed as { sourceType?: unknown }).sourceType !== expected.sourceType ||
      (parsed as { sourceId?: unknown }).sourceId !== expected.sourceId ||
      (parsed as { archiveState?: unknown }).archiveState !==
        expected.archiveState
    ) {
      throw new Error('invalid metadata cursor');
    }
    return { activityTime: last.activityTime, sessionId: last.sessionId };
  } catch {
    throw new InvalidCursorError(
      cursor,
      expected.sourceType === undefined ? 'parent' : 'metadata',
    );
  }
}

function encodeMetadataSessionCursor(
  last: LiveSessionCursorKey,
  filter: SessionMetadataFilter,
  archiveState: SessionArchiveState,
): string {
  return Buffer.from(
    JSON.stringify({ ...filter, archiveState, last }),
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
  sourceType?: string;
  sourceId?: string;
  isArchived?: boolean;
}): BridgeSessionSummary {
  return {
    sessionId: item.sessionId,
    workspaceCwd: item.cwd,
    createdAt: item.startTime,
    updatedAt: new Date(item.mtime).toISOString(),
    displayName: item.customTitle || item.prompt,
    ...(item.parentSessionId ? { parentSessionId: item.parentSessionId } : {}),
    ...(item.sourceType ? { sourceType: item.sourceType } : {}),
    ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {}),
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
 * Shared by all three list paths (default, organized, metadata-filtered) so the merge
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
    sourceType: existing.sourceType ?? live.sourceType,
    sourceId:
      existing.sourceType !== undefined ? existing.sourceId : live.sourceId,
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
        color?: SessionGroupPresetColor | null;
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
      ? parseOrganizedCursor(options.cursor, {
          group,
          archiveState,
          sourceType: options.sourceType,
          sourceId: options.sourceId,
        })
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
    if (!matchesSessionMetadataSource(session, options)) return false;
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
          options.sourceType,
          options.sourceId,
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
 * Applies persisted metadata filters before pagination so pages are not
 * silently short of matches.
 */
async function listWorkspaceSessionsByMetadataForResponse(
  bridge: AcpSessionBridge,
  workspaceCwd: string,
  options: ListWorkspaceSessionsOptions,
  pageSize: number,
  filter: SessionMetadataFilter,
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
        `qwen serve: session metadata filter live merge failed; using persisted sessions only: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const matches = [...bySessionId.values()]
    .filter(
      (session) =>
        (filter.parentSessionId === undefined ||
          session.parentSessionId === filter.parentSessionId) &&
        matchesSessionMetadataSource(session, filter),
    )
    .sort((a, b) =>
      compareLiveSessionCursorKeys(
        getLiveSessionCursorKey(a),
        getLiveSessionCursorKey(b),
      ),
    );
  const cursorKey =
    options.cursor !== undefined && options.cursor !== ''
      ? parseMetadataSessionCursor(options.cursor, {
          ...filter,
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
      ? encodeMetadataSessionCursor(
          getLiveSessionCursorKey(page[page.length - 1]!),
          filter,
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

  if (
    options?.parentSessionId !== undefined ||
    options?.sourceType !== undefined
  ) {
    return listWorkspaceSessionsByMetadataForResponse(
      bridge,
      workspaceCwd,
      options,
      pageSize,
      {
        ...(options.parentSessionId !== undefined
          ? { parentSessionId: options.parentSessionId }
          : {}),
        ...(options.sourceType !== undefined
          ? { sourceType: options.sourceType }
          : {}),
        ...(options.sourceId !== undefined
          ? { sourceId: options.sourceId }
          : {}),
      },
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

/**
 * Scans local persisted session JSONL files for aggregate counts and merges
 * the current in-memory live count from the bridge.
 *
 * This is an O(n) disk walk. Callers (and HTTP clients) must treat it as an
 * infrequent / on-demand operator endpoint, not a polling source.
 */
export async function getWorkspaceSessionInfoForResponse(
  bridge: AcpSessionBridge,
  workspaceCwd: string,
  options: { includeLive?: boolean } = {},
): Promise<WorkspaceSessionInfoResult> {
  const counts = await new SessionService(workspaceCwd).getSessionInfoCounts();
  return {
    active: counts.active,
    archived: counts.archived,
    total: counts.total,
    ...(options.includeLive === false
      ? {}
      : { live: bridge.listWorkspaceSessions(workspaceCwd).length }),
    expensive: true,
    cost: 'disk_scan',
    ...(counts.truncated ? { truncated: true } : {}),
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
