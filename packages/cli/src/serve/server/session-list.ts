/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  addDaemonRequestAttribute,
  SessionService,
  SessionOrganizationError,
  Storage,
  readWorktreeSession,
  readWorktreeSessionMarker,
  readSessionPrs,
  type SessionArchiveState,
  type SessionGroupPresetColor,
  type SessionPr,
} from '@qwen-code/qwen-code-core';
import type { SessionPrInfo } from '@qwen-code/acp-bridge/bridgeTypes';
import type {
  AcpSessionBridge,
  BridgeSessionSummary,
} from '../acp-session-bridge.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { createSessionOrganizationService } from '../session-organization-helpers.js';
import {
  PersistedSessionListCache,
  type PersistedSessionListSnapshot,
} from './persisted-session-list-cache.js';
import { laterActivityTimestamp } from './activity-timestamp.js';
import { classifyTopLevelConversationSource } from '../../runtime/live-session-source.js';
import { parseCallerSuppliedSessionId } from '../../config/session-id.js';

const DEFAULT_SESSION_PAGE_SIZE = 20;
const MAX_SESSION_PAGE_SIZE = 100;
const MAX_ORGANIZED_SESSIONS = 50_000;
// Bounds the emitted-identity list an activity cursor may carry; the cursor
// travels as a query parameter, so it must stay well under URL/header limits.
const MAX_EMITTED_CURSOR_SESSION_IDS = 64;
const PERSISTED_SESSION_LIST_CACHE_TTL_MS = 2_000;
const persistedSessionListCache = new PersistedSessionListCache(
  PERSISTED_SESSION_LIST_CACHE_TTL_MS,
  MAX_ORGANIZED_SESSIONS,
);

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
  /** Internal Conversations catalog restricted to top-level standalone rows. */
  conversationKind?: 'standalone-top-level';
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
  /** Runtime root owned by the selected managed workspace. */
  runtimeBaseDir?: string;
  /** Aborts this caller's wait without cancelling other shared waiters. */
  signal?: AbortSignal;
}

interface ResolvedListWorkspaceSessionsReadOptions {
  mergeLive?: boolean;
  runtimeBaseDir: string;
  signal?: AbortSignal;
}

export interface InvalidateWorkspaceSessionListCacheOptions {
  runtimeBaseDir: string;
  workspaceCwd: string;
  archiveStates: readonly SessionArchiveState[];
}

export function invalidateWorkspaceSessionListCache(
  options: InvalidateWorkspaceSessionListCacheOptions,
): void {
  for (const archiveState of options.archiveStates) {
    persistedSessionListCache.invalidate({
      runtimeBaseDir: options.runtimeBaseDir,
      workspaceCwd: options.workspaceCwd,
      archiveState,
    });
  }
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
  conversationKind?: 'standalone-top-level';
  last: OrganizedCursorKey;
  emitted?: string[];
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

/**
 * `emitted` is optional so cursors minted before the field existed stay
 * valid; absent means no identities are excluded.
 */
function parseEmittedSessionIds(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    return undefined;
  }
  return value as string[];
}

function parseOrganizedCursor(
  cursor: string,
  expected: {
    group: string;
    archiveState: SessionArchiveState;
    sourceType?: string;
    sourceId?: string;
    conversationKind?: 'standalone-top-level';
  },
): { last: OrganizedCursorKey; emitted: readonly string[] } | undefined {
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
      (parsed as OrganizedCursor).sourceId !== expected.sourceId ||
      (parsed as OrganizedCursor).conversationKind !== expected.conversationKind
    ) {
      throw new Error('invalid organized cursor');
    }
    const emitted = parseEmittedSessionIds((parsed as OrganizedCursor).emitted);
    if (emitted === undefined) {
      throw new Error('invalid organized cursor');
    }
    return { last, emitted };
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
  conversationKind?: 'standalone-top-level',
  emitted: readonly string[] = [],
): string {
  return Buffer.from(
    JSON.stringify({
      group,
      archiveState,
      sourceType,
      sourceId,
      conversationKind,
      last,
      ...(emitted.length > 0 ? { emitted } : {}),
    }),
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
  conversationKind?: 'standalone-top-level';
}

function matchesSessionMetadataSource(
  session: BridgeSessionSummary,
  filter: Pick<
    SessionMetadataFilter,
    'sourceType' | 'sourceId' | 'conversationKind'
  >,
): boolean {
  if (
    filter.conversationKind === 'standalone-top-level' &&
    classifyTopLevelConversationSource(session)?.kind !== 'standalone'
  ) {
    return false;
  }
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
): { last: LiveSessionCursorKey; emitted: readonly string[] } | undefined {
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
      (parsed as { conversationKind?: unknown }).conversationKind !==
        expected.conversationKind ||
      (parsed as { archiveState?: unknown }).archiveState !==
        expected.archiveState
    ) {
      throw new Error('invalid metadata cursor');
    }
    const emitted = parseEmittedSessionIds(
      (parsed as { emitted?: unknown }).emitted,
    );
    if (emitted === undefined) {
      throw new Error('invalid metadata cursor');
    }
    return {
      last: { activityTime: last.activityTime, sessionId: last.sessionId },
      emitted,
    };
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
  emitted: readonly string[] = [],
): string {
  return Buffer.from(
    JSON.stringify({
      ...filter,
      archiveState,
      last,
      ...(emitted.length > 0 ? { emitted } : {}),
    }),
    'utf8',
  ).toString('base64url');
}

/**
 * Enrich persisted session summaries with worktree metadata from sidecar
 * files so the ⑂ badge survives daemon restarts. Shared by all three
 * listing paths (default, organized, metadata-filtered).
 */
async function enrichWorktreeSidecars(
  bySessionId: Map<string, BridgeSessionSummary>,
  sessionService: SessionService,
  archiveState: SessionArchiveState = 'active',
  signal?: AbortSignal,
): Promise<void> {
  for (const [sessionId, summary] of bySessionId) {
    signal?.throwIfAborted();
    if (summary.worktree) continue;
    let sidecar: Awaited<ReturnType<typeof readWorktreeSession>>;
    try {
      const sidecarPath = sessionService.getWorktreeSessionPathForArchiveState(
        sessionId,
        archiveState,
      );
      sidecar = signal
        ? await readWorktreeSession(sidecarPath, { signal })
        : await readWorktreeSession(sidecarPath);
    } catch {
      signal?.throwIfAborted();
      sidecar = null;
    }
    if (
      sidecar &&
      (await readWorktreeSessionMarker(sidecar.worktreePath)) === sessionId
    ) {
      bySessionId.set(sessionId, {
        ...summary,
        worktree: {
          slug: sidecar.slug,
          path: sidecar.worktreePath,
          branch: sidecar.worktreeBranch,
        },
      });
    }
  }
}

/**
 * Enrich persisted session summaries with GitHub PR bindings from sidecar
 * files so the binding survives daemon restarts. Same pattern as
 * {@link enrichWorktreeSidecars}. Runs before the live merge, when the map
 * only holds persisted summaries — {@link mergeLiveSessionSummary} merges
 * these with the live entry's daemon-lifetime bindings.
 */
async function enrichPrSidecars(
  bySessionId: Map<string, BridgeSessionSummary>,
  sessionService: SessionService,
  // Required (no default): silently defaulting to 'active' would let a
  // future archived-listing call site that omits the argument enrich from
  // the wrong chats dir and drop every binding.
  archiveState: SessionArchiveState,
  signal?: AbortSignal,
): Promise<void> {
  for (const [sessionId, summary] of bySessionId) {
    signal?.throwIfAborted();
    let sidecar: Awaited<ReturnType<typeof readSessionPrs>>;
    try {
      const sidecarPath = sessionService.getPrSessionPathForArchiveState(
        sessionId,
        archiveState,
      );
      sidecar = signal
        ? await readSessionPrs(sidecarPath, { signal })
        : await readSessionPrs(sidecarPath);
    } catch {
      signal?.throwIfAborted();
      sidecar = null;
    }
    if (sidecar) {
      bySessionId.set(sessionId, {
        ...summary,
        prs: sidecarToPrInfos(sidecar),
      });
    }
  }
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
 * state (`clientCount`, `hasActivePrompt`, a fresher `displayName`). `updatedAt`
 * is the one field neither side owns outright: the later valid value wins.
 * Shared by all three list paths (default, organized, metadata-filtered) so the merge
 * rule lives in one place.
 */
function mergeLiveSessionSummary(
  existing: BridgeSessionSummary,
  live: BridgeSessionSummary,
): BridgeSessionSummary {
  const merged: BridgeSessionSummary = {
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
    updatedAt: laterActivityTimestamp(live.updatedAt, existing.updatedAt),
    clientCount: live.clientCount,
    hasActivePrompt: live.hasActivePrompt,
    isArchived: false,
  };
  // The live entry only knows PR bindings from this daemon lifetime while the
  // sidecar-enriched persisted summary holds the full history — merge by PR
  // number (live url wins, live-only bindings sort latest) instead of letting
  // the spread overwrite the history.
  if (existing.prs || live.prs) {
    merged.prs = mergeSummaryPrs(existing.prs, live.prs);
  }
  return merged;
}

function sidecarToPrInfos(sidecar: readonly SessionPr[]): SessionPrInfo[] {
  return sidecar.map(({ number, url, state }) => ({
    number,
    url,
    ...(state ? { state } : {}),
  }));
}

/**
 * Merges persisted (sidecar-enriched) PR bindings with a live entry's for
 * summary rendering: dedupe by number (live url wins, live-only bindings
 * sort latest). For `state` the persisted sidecar wins: the refresh timer
 * rewrites it there while the live entry is frozen at bind-time.
 */
function mergeSummaryPrs(
  persistedPrs: readonly SessionPrInfo[] | undefined,
  livePrs: readonly SessionPrInfo[] | undefined,
): SessionPrInfo[] {
  const live = livePrs ?? [];
  const persistedByNumber = new Map(
    (persistedPrs ?? []).map((p) => [p.number, p]),
  );
  return [
    ...(persistedPrs ?? []).filter(
      (p) => !live.some((l) => l.number === p.number),
    ),
    ...live.map((l) => {
      const persisted = persistedByNumber.get(l.number);
      return persisted?.state !== undefined && persisted.state !== l.state
        ? { ...l, state: persisted.state }
        : l;
    }),
  ];
}

/**
 * Builds the first-page insertion for a session that is live but has no
 * persisted record yet. The bind route persists the PR sidecar before the
 * session's first flush, so best-effort read it: the row then renders the
 * sidecar's refreshed `state` instead of the live entry's bind-time
 * snapshot, matching {@link mergeLiveSessionSummary}.
 */
async function liveOnlySummary(
  live: BridgeSessionSummary,
  sessionService: SessionService,
  signal?: AbortSignal,
): Promise<BridgeSessionSummary> {
  const summary: BridgeSessionSummary = {
    ...live,
    createdAt: live.createdAt,
    clientCount: live.clientCount,
    hasActivePrompt: live.hasActivePrompt,
    isArchived: false,
  };
  let sidecar: Awaited<ReturnType<typeof readSessionPrs>>;
  try {
    const sidecarPath = sessionService.getPrSessionPathForArchiveState(
      live.sessionId,
      'active',
    );
    sidecar = signal
      ? await readSessionPrs(sidecarPath, { signal })
      : await readSessionPrs(sidecarPath);
  } catch {
    signal?.throwIfAborted();
    sidecar = null;
  }
  if (sidecar) {
    summary.prs = mergeSummaryPrs(sidecarToPrInfos(sidecar), live.prs);
  }
  return summary;
}

function clonePersistedSummary(
  session: Readonly<BridgeSessionSummary>,
): BridgeSessionSummary {
  return {
    ...session,
    ...(session.worktree ? { worktree: { ...session.worktree } } : {}),
  };
}

async function loadAllPersistedSummaries(
  sessionService: SessionService,
  archiveState: SessionArchiveState,
  signal: AbortSignal,
): Promise<PersistedSessionListSnapshot> {
  const scanStartedAt = performance.now();
  signal.throwIfAborted();
  // Organized view needs global pin/group ordering before pagination; v1 keeps
  // the storage API unchanged and performs that merge in memory.
  const sessions: BridgeSessionSummary[] = [];
  let truncated = false;
  let scanPages = 0;
  let cursor: number | undefined;
  do {
    scanPages += 1;
    const page = await sessionService.listSessions({
      cursor,
      size: 10_000,
      archiveState,
      signal,
    });
    signal.throwIfAborted();
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
  const bySessionId = new Map(
    sessions.map((session) => [session.sessionId, session]),
  );
  await enrichWorktreeSidecars(
    bySessionId,
    sessionService,
    archiveState,
    signal,
  );
  await enrichPrSidecars(bySessionId, sessionService, archiveState, signal);
  signal.throwIfAborted();
  return {
    sessions: [...bySessionId.values()],
    truncated,
    scanPages,
    scanDurationMs: Math.max(0, performance.now() - scanStartedAt),
  };
}

async function listAllPersistedSummaries(
  sessionService: SessionService,
  workspaceCwd: string,
  archiveState: SessionArchiveState,
  runtimeBaseDir: string,
  queryKind: 'organized' | 'metadata',
  signal?: AbortSignal,
): Promise<PersistedSessionListSnapshot> {
  const lookup = persistedSessionListCache.lookup(
    { runtimeBaseDir, workspaceCwd, archiveState },
    (loadSignal) =>
      loadAllPersistedSummaries(sessionService, archiveState, loadSignal),
    { signal },
  );
  addDaemonRequestAttribute(
    'qwen-code.daemon.session_list.cache_status',
    lookup.status,
  );
  addDaemonRequestAttribute(
    'qwen-code.daemon.session_list.archive_state',
    archiveState,
  );
  addDaemonRequestAttribute(
    'qwen-code.daemon.session_list.query_kind',
    queryKind,
  );
  if (lookup.cacheAgeMs !== undefined) {
    addDaemonRequestAttribute(
      'qwen-code.daemon.session_list.cache_age_ms',
      lookup.cacheAgeMs,
    );
  }

  const snapshot = await lookup.promise;
  signal?.throwIfAborted();
  addDaemonRequestAttribute(
    'qwen-code.daemon.session_list.persisted_sessions',
    snapshot.sessions.length,
  );
  addDaemonRequestAttribute(
    'qwen-code.daemon.session_list.scan_pages',
    snapshot.scanPages,
  );
  addDaemonRequestAttribute(
    'qwen-code.daemon.session_list.truncated',
    snapshot.truncated,
  );
  if (lookup.status !== 'cache_hit') {
    addDaemonRequestAttribute(
      'qwen-code.daemon.session_list.scan_duration_ms',
      snapshot.scanDurationMs,
    );
  }
  return snapshot;
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

/**
 * Rebuilds the emitted-identity list an activity cursor carries across a
 * pagination pass. A row's activity key is not stable: a live watermark that
 * leads the transcript mtime evaporates when the live entry retires, and a
 * live-only row gains a persisted key only after its first flush. Either
 * transition can drop a row already emitted on an earlier page back behind
 * the cursor boundary, where the strictly-older key filter would admit it a
 * second time. The cursor therefore names the emitted rows whose keys were
 * live-derived, and the after-cursor filter excludes them for the rest of the
 * pass.
 *
 * The list stays bounded. An identity is dropped once its persisted key alone
 * can no longer pass the key filter (`reenters`). Past
 * MAX_EMITTED_CURSOR_SESSION_IDS the identities with the highest persisted
 * keys are dropped first — they leave the re-admission window soonest — and a
 * dropped identity degrades to an at-most-once duplicate instead of failing
 * the pass.
 */
function nextEmittedSessionIds(options: {
  carried: ReadonlySet<string>;
  page: readonly BridgeSessionSummary[];
  liveSessionIds: ReadonlySet<string>;
  listedById: ReadonlyMap<string, BridgeSessionSummary>;
  persistedTimeById: ReadonlyMap<string, number>;
  reenters: (row: BridgeSessionSummary, persistedTime: number) => boolean;
}): string[] {
  const candidates = new Set(options.carried);
  for (const row of options.page) {
    if (options.liveSessionIds.has(row.sessionId)) {
      candidates.add(row.sessionId);
    }
  }
  const kept: Array<{ sessionId: string; persistedTime: number }> = [];
  for (const sessionId of candidates) {
    const row = options.listedById.get(sessionId);
    if (!row) {
      // Absent from the filtered collection — but absence can be transient:
      // the persisted snapshot is a short-TTL cache that can predate a
      // live-only row's first flush, group membership can move mid-pass, and
      // the live list can be unavailable. Retain the identity until a
      // persisted floor rules re-admission out; the cap bounds the list.
      kept.push({ sessionId, persistedTime: Number.NEGATIVE_INFINITY });
      continue;
    }
    const persistedTime = options.persistedTimeById.get(sessionId);
    if (persistedTime === undefined) {
      // Live-only: no persisted floor yet, so it can land anywhere once it
      // flushes.
      kept.push({ sessionId, persistedTime: Number.NEGATIVE_INFINITY });
      continue;
    }
    if (options.reenters(row, persistedTime)) {
      kept.push({ sessionId, persistedTime });
    }
  }
  if (kept.length > MAX_EMITTED_CURSOR_SESSION_IDS) {
    kept.sort((a, b) => a.persistedTime - b.persistedTime);
    kept.length = MAX_EMITTED_CURSOR_SESSION_IDS;
  }
  return kept.map((entry) => entry.sessionId);
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
  readOptions: ResolvedListWorkspaceSessionsReadOptions,
): Promise<ListWorkspaceSessionsResult> {
  const archiveState = options.archiveState ?? 'active';
  const sessionService = new SessionService(workspaceCwd);
  const organizationService = createSessionOrganizationService(workspaceCwd);
  readOptions.signal?.throwIfAborted();
  const snapshot = await organizationService.readSnapshot();
  readOptions.signal?.throwIfAborted();
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
  const cursor =
    options.cursor !== undefined
      ? parseOrganizedCursor(options.cursor, {
          group,
          archiveState,
          sourceType: options.sourceType,
          sourceId: options.sourceId,
          conversationKind: options.conversationKind,
        })
      : undefined;
  const cursorKey = cursor?.last;
  const emittedBeforePage = new Set(cursor?.emitted ?? []);
  const isFirstPage = cursorKey === undefined;
  let liveMergeFailed = false;

  const bySessionId = new Map<string, BridgeSessionSummary>();
  const persisted = await listAllPersistedSummaries(
    sessionService,
    workspaceCwd,
    archiveState,
    readOptions.runtimeBaseDir,
    'organized',
    readOptions.signal,
  );
  readOptions.signal?.throwIfAborted();
  for (const session of persisted.sessions) {
    bySessionId.set(
      session.sessionId,
      applyOrganization(
        clonePersistedSummary(session),
        snapshot.sessions.get(session.sessionId),
      ),
    );
  }
  // Activity floors: the key a row falls back to once its live entry is gone.
  const persistedTimeById = new Map(
    persisted.sessions.map((session) => [
      session.sessionId,
      getSummaryActivityTime(session),
    ]),
  );
  const liveSessionIds = new Set<string>();

  if (readOptions.mergeLive !== false && archiveState !== 'archived') {
    try {
      const liveSessions = bridge.listWorkspaceSessions(workspaceCwd);
      for (const live of liveSessions) {
        liveSessionIds.add(live.sessionId);
        const existing = bySessionId.get(live.sessionId);
        const organization = snapshot.sessions.get(live.sessionId);
        if (existing) {
          // Merged on every page, not just the first: the page-1 cursor is
          // encoded from merged activity keys, so a later page that keyed the
          // same row by its persisted mtime alone would re-admit a row whose
          // watermark leads storage and return it twice.
          bySessionId.set(
            live.sessionId,
            applyOrganization(
              mergeLiveSessionSummary(existing, live),
              organization,
            ),
          );
        } else if (
          // A live-only row has no persisted key to page by, so it stays a
          // first-page-only insertion as before.
          isFirstPage &&
          // `listAllPersistedSummaries` already scanned every persisted
          // session when the scan wasn't truncated, so a `sessionId` missing
          // from `bySessionId` is definitively new — no disk re-check
          // needed. Re-checking here raced a session that persists its
          // first write (e.g. a `displayName` update) between the scan
          // above and this point: `existing` stayed undefined but
          // `sessionExists` flipped to true, silently dropping the live
          // session from the response instead of merging it.
          (!persisted.truncated ||
            !(await (readOptions.signal
              ? sessionService.sessionExists(live.sessionId, {
                  signal: readOptions.signal,
                })
              : sessionService.sessionExists(live.sessionId))))
        ) {
          bySessionId.set(
            live.sessionId,
            applyOrganization(
              await liveOnlySummary(live, sessionService, readOptions.signal),
              organization,
            ),
          );
        }
      }
    } catch (error) {
      readOptions.signal?.throwIfAborted();
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
  readOptions.signal?.throwIfAborted();
  const activityTimeById = new Map(
    filtered.map((session) => [
      session.sessionId,
      getSummaryActivityTime(session),
    ]),
  );
  filtered.sort((a, b) => compareOrganizedSessions(activityTimeById, a, b));
  readOptions.signal?.throwIfAborted();
  const afterCursor =
    cursorKey === undefined
      ? filtered
      : filtered.filter(
          (session) =>
            // A row already emitted at a live-derived key stays excluded even
            // if its key regressed behind the cursor (live retirement, or a
            // live-only row that persisted mid-pass).
            !emittedBeforePage.has(session.sessionId) &&
            compareOrganizedCursorKeys(
              cursorKey,
              getOrganizedCursorKey(activityTimeById, session),
            ) < 0,
        );
  const page = afterCursor.slice(0, pageSize);
  let nextCursor: string | undefined;
  if (page.length < afterCursor.length) {
    const boundary = getOrganizedCursorKey(
      activityTimeById,
      page[page.length - 1]!,
    );
    const emitted = nextEmittedSessionIds({
      carried: emittedBeforePage,
      page,
      liveSessionIds,
      listedById: new Map(
        filtered.map((session) => [session.sessionId, session]),
      ),
      persistedTimeById,
      // `isPinned` is re-read from the organization snapshot on every page
      // request, so a pin flip between fetches can move the persisted key
      // across the pinned/unpinned blocks. Keep the identity while the key
      // could re-enter under either state.
      reenters: (row, persistedTime) =>
        [true, false].some(
          (isPinned) =>
            compareOrganizedCursorKeys(boundary, {
              isPinned,
              activityTime: persistedTime,
              sessionId: row.sessionId,
            }) < 0,
        ),
    });
    nextCursor = encodeOrganizedCursor(
      boundary,
      group,
      archiveState,
      options.sourceType,
      options.sourceId,
      options.conversationKind,
      emitted,
    );
  }
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
  readOptions: ResolvedListWorkspaceSessionsReadOptions,
): Promise<ListWorkspaceSessionsResult> {
  const archiveState = options.archiveState ?? 'active';
  const sessionService = new SessionService(workspaceCwd);
  const bySessionId = new Map<string, BridgeSessionSummary>();
  const persisted = await listAllPersistedSummaries(
    sessionService,
    workspaceCwd,
    archiveState,
    readOptions.runtimeBaseDir,
    'metadata',
    readOptions.signal,
  );
  readOptions.signal?.throwIfAborted();
  const canonicalizeStandaloneIds =
    filter.conversationKind === 'standalone-top-level';
  const conflictedStandaloneIds = new Set<string>();
  const persistedTimeById = new Map<string, number>();
  for (const session of persisted.sessions) {
    let sessionId = session.sessionId;
    if (canonicalizeStandaloneIds) {
      const parsed = parseCallerSuppliedSessionId(sessionId);
      if (parsed.kind !== 'valid') continue;
      sessionId = parsed.sessionId;
      if (conflictedStandaloneIds.has(sessionId)) continue;
      if (bySessionId.has(sessionId)) {
        bySessionId.delete(sessionId);
        persistedTimeById.delete(sessionId);
        conflictedStandaloneIds.add(sessionId);
        continue;
      }
    }
    bySessionId.set(sessionId, {
      ...clonePersistedSummary(session),
      sessionId,
    });
    persistedTimeById.set(sessionId, getSummaryActivityTime(session));
  }
  // Activity floors: the key a row falls back to once its live entry is gone.
  const liveSessionIds = new Set<string>();

  let liveMergeFailed = false;
  if (readOptions.mergeLive !== false && archiveState !== 'archived') {
    try {
      for (const live of bridge.listWorkspaceSessions(workspaceCwd)) {
        let sessionId = live.sessionId;
        if (canonicalizeStandaloneIds) {
          const parsed = parseCallerSuppliedSessionId(sessionId);
          if (
            parsed.kind !== 'valid' ||
            conflictedStandaloneIds.has(parsed.sessionId)
          ) {
            continue;
          }
          sessionId = parsed.sessionId;
        }
        const canonicalLive =
          sessionId === live.sessionId ? live : { ...live, sessionId };
        liveSessionIds.add(sessionId);
        const existing = bySessionId.get(sessionId);
        if (existing) {
          bySessionId.set(
            sessionId,
            mergeLiveSessionSummary(existing, canonicalLive),
          );
        } else if (
          // See the matching comment in
          // `listOrganizedWorkspaceSessionsForResponse`: an untruncated scan
          // already covers every persisted session, so skip the racy
          // re-check when nothing was truncated.
          !persisted.truncated ||
          !(await (readOptions.signal
            ? sessionService.sessionExists(sessionId, {
                signal: readOptions.signal,
              })
            : sessionService.sessionExists(sessionId)))
        ) {
          bySessionId.set(
            sessionId,
            await liveOnlySummary(
              canonicalLive,
              sessionService,
              readOptions.signal,
            ),
          );
        }
      }
    } catch (error) {
      readOptions.signal?.throwIfAborted();
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
  readOptions.signal?.throwIfAborted();
  const cursor =
    options.cursor !== undefined && options.cursor !== ''
      ? parseMetadataSessionCursor(options.cursor, {
          ...filter,
          archiveState,
        })
      : undefined;
  const cursorKey = cursor?.last;
  const emittedBeforePage = new Set(cursor?.emitted ?? []);
  const afterCursor =
    cursorKey === undefined
      ? matches
      : matches.filter(
          (session) =>
            // See the organized path: exclude rows already emitted at a
            // live-derived key whose key regressed behind the cursor.
            !emittedBeforePage.has(session.sessionId) &&
            compareLiveSessionCursorKeys(
              cursorKey,
              getLiveSessionCursorKey(session),
            ) < 0,
        );
  const page = afterCursor.slice(0, pageSize);
  let nextCursor: string | undefined;
  if (page.length < afterCursor.length) {
    const boundary = getLiveSessionCursorKey(page[page.length - 1]!);
    const emitted = nextEmittedSessionIds({
      carried: emittedBeforePage,
      page,
      liveSessionIds,
      listedById: new Map(
        matches.map((session) => [session.sessionId, session]),
      ),
      persistedTimeById,
      reenters: (row, persistedTime) =>
        compareLiveSessionCursorKeys(boundary, {
          activityTime: persistedTime,
          sessionId: row.sessionId,
        }) < 0,
    });
    nextCursor = encodeMetadataSessionCursor(
      boundary,
      filter,
      archiveState,
      emitted,
    );
  }
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
  readOptions.signal?.throwIfAborted();
  const runtimeBaseDir = new Storage(
    workspaceCwd,
    readOptions.runtimeBaseDir,
  ).getRuntimeBaseDir();
  const result = await Storage.runWithResolvedRuntimeBaseDir(
    runtimeBaseDir,
    () =>
      listWorkspaceSessionsForResponseInRuntime(bridge, workspaceCwd, options, {
        ...(readOptions.mergeLive !== undefined
          ? { mergeLive: readOptions.mergeLive }
          : {}),
        ...(readOptions.signal !== undefined
          ? { signal: readOptions.signal }
          : {}),
        runtimeBaseDir,
      }),
  );
  readOptions.signal?.throwIfAborted();
  return result;
}

async function listWorkspaceSessionsForResponseInRuntime(
  bridge: AcpSessionBridge,
  workspaceCwd: string,
  options: ListWorkspaceSessionsOptions | undefined,
  readOptions: ResolvedListWorkspaceSessionsReadOptions,
): Promise<ListWorkspaceSessionsResult> {
  readOptions.signal?.throwIfAborted();
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
    options?.sourceType !== undefined ||
    options?.conversationKind !== undefined
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
        ...(options.conversationKind !== undefined
          ? { conversationKind: options.conversationKind }
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
    ...(readOptions.signal ? { signal: readOptions.signal } : {}),
  });
  readOptions.signal?.throwIfAborted();
  const bySessionId = new Map<string, BridgeSessionSummary>();

  for (const item of persisted.items) {
    bySessionId.set(item.sessionId, toSummary(item));
  }

  await enrichWorktreeSidecars(
    bySessionId,
    sessionService,
    archiveState,
    readOptions.signal,
  );
  await enrichPrSidecars(
    bySessionId,
    sessionService,
    archiveState,
    readOptions.signal,
  );
  readOptions.signal?.throwIfAborted();

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
      // If this is a complete scan (no further pages), a missing
      // `sessionId` here is definitively new — no disk re-check needed.
      // Re-checking raced a session that persists its first write (e.g. a
      // `displayName` update) between the scan above and this point:
      // `existing` stayed undefined but `sessionExists` flipped to true,
      // silently dropping the live session from the response instead of
      // merging it.
      (persisted.nextCursor == null ||
        !(await (readOptions.signal
          ? sessionService.sessionExists(live.sessionId, {
              signal: readOptions.signal,
            })
          : sessionService.sessionExists(live.sessionId))))
    ) {
      bySessionId.set(
        live.sessionId,
        await liveOnlySummary(live, sessionService, readOptions.signal),
      );
    }
  }

  const sessions = [...bySessionId.values()].sort((a, b) => {
    const aTime = Date.parse(a.updatedAt ?? a.createdAt);
    const bTime = Date.parse(b.updatedAt ?? b.createdAt);
    return bTime - aTime;
  });
  readOptions.signal?.throwIfAborted();

  const nextCursor =
    persisted.nextCursor != null ? String(persisted.nextCursor) : undefined;

  return { sessions, nextCursor };
}

export async function listLiveWorkspaceSessionsForResponse(
  bridge: AcpSessionBridge,
  workspaceCwd: string,
  options?: Pick<ListWorkspaceSessionsOptions, 'cursor' | 'size'>,
  readOptions: { runtimeBaseDir?: string; signal?: AbortSignal } = {},
): Promise<ListWorkspaceSessionsResult> {
  const runtimeBaseDir = new Storage(
    workspaceCwd,
    readOptions.runtimeBaseDir,
  ).getRuntimeBaseDir();
  return Storage.runWithResolvedRuntimeBaseDir(runtimeBaseDir, async () => {
    const rawSize = options?.size;
    const requestedSize =
      typeof rawSize === 'number' && Number.isSafeInteger(rawSize)
        ? rawSize
        : DEFAULT_SESSION_PAGE_SIZE;
    const pageSize = Math.min(
      Math.max(requestedSize, 1),
      MAX_SESSION_PAGE_SIZE,
    );
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
    // The bind route persists the PR sidecar before the session's first
    // flush, and a bridge entry re-created after a restart/close/reload
    // carries no `prs`, so every live-only row must read the sidecar like
    // the sibling live-only paths do — unconditionally.
    const sessionService = new SessionService(workspaceCwd);
    const enriched = await Promise.all(
      page.map((summary) =>
        liveOnlySummary(summary, sessionService, readOptions.signal),
      ),
    );
    const nextCursor =
      page.length < afterCursor.length
        ? encodeLiveSessionCursor(
            getLiveSessionCursorKey(page[page.length - 1]!),
          )
        : undefined;
    return {
      sessions: enriched,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  });
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
