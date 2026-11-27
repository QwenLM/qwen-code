/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import * as fs from 'node:fs/promises';
import { GitWorktreeService } from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import { selectWorktreeSnapshot } from '@qwen-code/qwen-code-core/services/worktree-snapshot-service.js';
import {
  addDaemonRequestAttribute,
  SESSION_PR_LIST_LIMIT,
  SessionService,
  SessionOrganizationError,
  Storage,
  readWorktreeSession,
  readWorktreeSessionMarker,
  canonicalSessionPrUrl,
  readSessionPrsDetailed,
  readSessionArtifactSummarySidecarAsync,
  readSessionGoalSidecar,
  toSessionPrInfo,
  type SessionArchiveState,
  type SessionGroupPresetColor,
  type SessionPr,
} from '@qwen-code/qwen-code-core';
import {
  GROUP_COLOR_OPTIONS,
  type SessionGroupCatalog,
} from '@qwen-code/qwen-code-core/services/session-organization-service.js';
import type { SessionPrInfo } from '@qwen-code/acp-bridge/bridgeTypes';
import {
  isPromptLedgerTerminalRecord,
  readPromptLedgerRecords,
} from '@qwen-code/acp-bridge/promptLedger';
import type {
  AcpSessionBridge,
  BridgeSessionSummary,
} from '../acp-session-bridge.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { createSessionOrganizationService } from '../session-organization-helpers.js';
import { preclassifyWorktreeCleanup } from './worktree-orphan-cleanup.js';
import { assertRestoreCoordinates } from './worktree-snapshot-binding.js';
import { canConvergeInterruptedSnapshotMove } from './worktree-snapshot-pairs.js';
import {
  PersistedSessionListCache,
  waitForSessionListLoad,
  type PersistedSessionListSnapshot,
  type SessionListLoad,
} from './persisted-session-list-cache.js';
import { laterActivityTimestamp } from './activity-timestamp.js';
import {
  projectTempDirFor,
  resolveDetachedBackgroundWork,
} from './detached-work-liveness.js';
import { classifyTopLevelConversationSource } from '../../runtime/live-session-source.js';
import {
  normalizeSessionIdForLookup,
  parseCallerSuppliedSessionId,
} from '../../config/session-id.js';
import {
  HIDDEN_CATALOG_SOURCE_TYPES,
  isHiddenCatalogSource,
} from '../../runtime/agent-session-source.js';

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
// Each row is owned by one persisted snapshot. Its sidecars expire with it.
interface PersistedSidecarLoad extends SessionListLoad<BridgeSessionSummary> {
  worktreeLoad?: SessionListLoad<BridgeSessionSummary>;
}

interface CachedCatalogSnapshot extends PersistedSessionListSnapshot {
  revalidateWorktree: boolean;
}

const persistedSidecarLoads = new WeakMap<
  Readonly<BridgeSessionSummary>,
  PersistedSidecarLoad
>();

export interface ListWorkspaceSessionsOptions {
  sortBy?: 'updatedAt' | 'lastUserPromptAt';
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
  /** Filter by source; `default` includes legacy and `qwen-live` tasks. */
  sourceType?: string;
  /** Further restrict `sourceType` matches to this source identifier. */
  sourceId?: string;
  /** Internal Conversations catalog restricted to top-level standalone rows. */
  conversationKind?: 'standalone-top-level';
}

export interface ListWorkspaceSessionsResult {
  sessions: BridgeSessionSummary[];
  groups?: SessionGroupCatalog;
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
  /** Paginate the combined persisted/live catalog, including unfiltered reads. */
  paginateMerged?: boolean;
  includeGroups?: boolean;
  /** Runtime root owned by the selected managed workspace. */
  runtimeBaseDir?: string;
  /** Aborts this caller's wait without cancelling other shared waiters. */
  signal?: AbortSignal;
  /** Optional retirement-fence probe for search results that lack a bridge parameter. */
  isSessionRetirementFenced?: (sessionId: string) => boolean;
}

interface ResolvedListWorkspaceSessionsReadOptions {
  mergeLive?: boolean;
  paginateMerged?: boolean;
  includeGroups?: boolean;
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
    kind:
      | 'numeric'
      | 'persisted'
      | 'organized'
      | 'live'
      | 'parent'
      | 'metadata' = 'numeric',
  ) {
    super(`Invalid cursor: "${cursor}" is not a valid ${kind} cursor`);
    this.name = 'InvalidCursorError';
  }
}

/**
 * True when `cursor` addresses a position in the persisted session store: a
 * bare page offset, or one of the composite `"<mtime>|<name>"` cursors minted
 * by listSessions when a page ends inside a group of files sharing an mtime.
 * Callers use this to pick the persisted listing path over the live one; it
 * only classifies the shape, `parseSessionCursor` still rejects bad values.
 */
export function isPersistedSessionCursor(cursor: string): boolean {
  if (cursor === '') return false;
  const trimmed = cursor.trim();
  if (trimmed === '') return false;
  // Composite cursors are opaque to this layer beyond their mtime prefix. An
  // empty prefix ("|name") is malformed: Number('') is 0, so without this
  // guard it would pass as a real position and answer 200 with an empty page.
  const parts = trimmed.split('|');
  if (parts.length === 2 && parts[0].trim() !== '' && parts[1].length > 0) {
    const mtime = Number(parts[0]);
    if (Number.isFinite(mtime) && mtime >= 0) return true;
  }
  const parsed = Number(trimmed);
  return (
    Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER
  );
}

function parseSessionCursor(cursor: string): number | string | undefined {
  if (cursor === '') return undefined;
  if (!isPersistedSessionCursor(cursor)) {
    throw new InvalidCursorError(cursor, 'persisted');
  }
  const trimmed = cursor.trim();
  // A bare offset parses as a number; a composite cursor stays opaque so it
  // can be handed back to the persisted listing layer verbatim.
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : trimmed;
}

interface OrganizedCursor {
  sortBy?: 'updatedAt' | 'lastUserPromptAt';
  catalogKind?: 'organized';
  paginateMerged?: boolean;
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
    paginateMerged: boolean;
    sortBy?: 'updatedAt' | 'lastUserPromptAt';
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
      ((parsed as OrganizedCursor).catalogKind !== undefined &&
        (parsed as OrganizedCursor).catalogKind !== 'organized') ||
      ((parsed as OrganizedCursor).paginateMerged !== undefined &&
        (parsed as OrganizedCursor).paginateMerged !==
          expected.paginateMerged) ||
      ((parsed as OrganizedCursor).sortBy ?? 'updatedAt') !==
        (expected.sortBy ?? 'updatedAt') ||
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
  paginateMerged: boolean,
  sourceType?: string,
  sourceId?: string,
  conversationKind?: 'standalone-top-level',
  emitted: readonly string[] = [],
  sortBy?: 'updatedAt' | 'lastUserPromptAt',
): string {
  return Buffer.from(
    JSON.stringify({
      catalogKind: 'organized',
      sortBy,
      paginateMerged,
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
  sortBy?: 'updatedAt' | 'lastUserPromptAt';
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
    // Live-created tasks retain attribution while sharing the task catalog.
    (filter.sourceType === 'default' &&
      (session.sourceType === undefined || session.sourceType === 'qwen-live'));
  return (
    sourceTypeMatches &&
    // Source identifiers remain exact within the selected catalog.
    (filter.sourceId === undefined || session.sourceId === filter.sourceId)
  );
}

function parseMetadataSessionCursor(
  cursor: string,
  expected: SessionMetadataFilter & {
    archiveState: SessionArchiveState;
    paginateMerged: boolean;
  },
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
      ((parsed as { catalogKind?: unknown }).catalogKind !== undefined &&
        (parsed as { catalogKind?: unknown }).catalogKind !== 'metadata') ||
      ((parsed as { paginateMerged?: unknown }).paginateMerged !== undefined &&
        (parsed as { paginateMerged?: unknown }).paginateMerged !==
          expected.paginateMerged) ||
      ((parsed as { sortBy?: unknown }).sortBy ?? 'updatedAt') !==
        (expected.sortBy ?? 'updatedAt') ||
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
      expected.parentSessionId !== undefined ? 'parent' : 'metadata',
    );
  }
}

function encodeMetadataSessionCursor(
  last: LiveSessionCursorKey,
  filter: SessionMetadataFilter,
  archiveState: SessionArchiveState,
  paginateMerged: boolean,
  emitted: readonly string[] = [],
): string {
  return Buffer.from(
    JSON.stringify({
      catalogKind: 'metadata',
      paginateMerged,
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
export function isBridgeSessionRetirementFenced(
  bridge: Partial<Pick<AcpSessionBridge, 'getSessionRetirement'>>,
  sessionId: string,
): boolean {
  if (!bridge.getSessionRetirement) return false;
  const normalized = normalizeSessionIdForLookup(sessionId);
  const ids = normalized === sessionId ? [sessionId] : [sessionId, normalized];
  try {
    return ids.some((id) => Boolean(bridge.getSessionRetirement!(id)));
  } catch {
    // Unreadable or corrupt retirement ledger entries fail closed.
    return true;
  }
}

export async function enrichWorktreeSidecars(
  bySessionId: Map<string, BridgeSessionSummary>,
  sessionService: SessionService,
  archiveState: SessionArchiveState = 'active',
  signal?: AbortSignal,
  isSessionRetirementFenced?: (sessionId: string) => boolean,
): Promise<void> {
  let runtimeRoots: readonly string[] | undefined;
  const getRuntimeRoots = async () => {
    if (runtimeRoots !== undefined) return runtimeRoots;
    const roots = new Set([sessionService.getProjectRoot()]);
    try {
      const repoTop = await new GitWorktreeService(
        sessionService.getProjectRoot(),
      ).getRepoTopLevel();
      if (repoTop) roots.add(repoTop);
    } catch {
      // The runtime root still bounds a plain workspace. Ownership
      // calibration and the actual restore use a fresh Git read.
    }
    runtimeRoots = [...roots];
    return runtimeRoots;
  };
  for (const [sessionId, summary] of bySessionId) {
    signal?.throwIfAborted();
    const sidecarPath = sessionService.getWorktreeSessionPathForArchiveState(
      sessionId,
      archiveState,
    );
    let sidecar: Awaited<ReturnType<typeof readWorktreeSession>>;
    let readFailed = false;
    try {
      sidecar = await readWorktreeSession(sidecarPath, {
        signal,
        onInvalid: () => {
          readFailed = true;
        },
      });
    } catch {
      signal?.throwIfAborted();
      sidecar = null;
      readFailed = true;
    }
    if (!sidecar) {
      if (readFailed) {
        if (summary.worktree?.worktreeRemoved) {
          bySessionId.set(sessionId, {
            ...summary,
            worktree: { ...summary.worktree, canRestore: false },
          });
        }
        continue;
      }
      if (summary.worktree) {
        const updated = { ...summary };
        delete updated.worktree;
        bySessionId.set(sessionId, updated);
      }
      continue;
    }
    let removed = sidecar.worktreeRemoved;
    if (
      !removed &&
      (await readWorktreeSessionMarker(sidecar.worktreePath)) !== sessionId
    ) {
      // A historical removal can lose the checkout and its marker before the
      // sidecar binding is written. Only a genuinely absent checkout with an
      // exact session/slug pair may be exposed as a retained snapshot.
      try {
        await fs.lstat(sidecar.worktreePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          const candidate = await preclassifyWorktreeCleanup(
            sessionService,
            sessionId,
            sessionService.getProjectRoot(),
            { quiet: true, runtimeRoots: await getRuntimeRoots() },
          );
          if (
            candidate &&
            path.dirname(candidate.sidecarPath) === path.dirname(sidecarPath)
          ) {
            try {
              await assertRestoreCoordinates(candidate);
              const selected = await selectWorktreeSnapshot({
                directory: path.dirname(candidate.sidecarPath),
                sessionId,
                slug: candidate.sidecar.slug,
              });
              if (selected) {
                removed = { archiveKey: path.basename(selected.snapshotPath) };
              }
            } catch {
              // Invalid coordinates or an unreadable pair are not a restore
              // capability; leave the ordinary missing-owner handling intact.
            }
          }
        }
      }
      if (!removed) {
        if (summary.worktree) {
          const stripped = { ...summary };
          delete stripped.worktree;
          bySessionId.set(sessionId, stripped);
        }
        continue;
      }
    }
    let canRestore = false;
    if (
      removed &&
      archiveState === 'active' &&
      !isSessionRetirementFenced?.(sessionId)
    ) {
      try {
        // The restore route refuses every non-active location, so a row that
        // still has an archived twin must not advertise a capability the
        // click can never satisfy.
        if (
          (await sessionService.getMaintainableSessionLocation(sessionId)) ===
          'active'
        ) {
          const candidate = await preclassifyWorktreeCleanup(
            sessionService,
            sessionId,
            sessionService.getProjectRoot(),
            { quiet: true, runtimeRoots: await getRuntimeRoots() },
          );
          if (
            candidate &&
            path.dirname(candidate.sidecarPath) === path.dirname(sidecarPath)
          ) {
            await assertRestoreCoordinates(candidate);
            try {
              canRestore =
                (await selectWorktreeSnapshot({
                  directory: path.dirname(sidecarPath),
                  sessionId,
                  slug: sidecar.slug,
                  archiveKey: removed.archiveKey,
                })) !== undefined;
            } catch {
              canRestore = false;
            }
            if (!canRestore && candidate.otherStateSidecarDir !== undefined) {
              canRestore = await canConvergeInterruptedSnapshotMove(
                candidate.otherStateSidecarDir,
                path.dirname(sidecarPath),
                sessionId,
                sidecar.slug,
                removed.archiveKey,
              );
            }
          }
        }
      } catch {
        // An unavailable pair is shown as such, never as a restore capability.
      }
    }
    // Normal metadata remains with its scan snapshot so a concurrent sidecar
    // write never tears a cold response; refresh coordinates only when a
    // previously removed entry has just been restored or no worktree was
    // cached yet.
    const worktree =
      !removed &&
      summary.worktree &&
      summary.worktree.worktreeRemoved === undefined
        ? { ...summary.worktree }
        : {
            ...(summary.worktree ?? {}),
            slug: sidecar.slug,
            path: sidecar.worktreePath,
            branch: sidecar.worktreeBranch,
            baseCommit:
              sidecar.worktreeBase || sidecar.originalHeadCommit || undefined,
            baseBranch: sidecar.originalBranch || undefined,
          };
    delete worktree.worktreeRemoved;
    delete worktree.canRestore;
    if (removed) {
      worktree.worktreeRemoved = removed;
      worktree.canRestore = canRestore;
    }
    bySessionId.set(sessionId, {
      ...summary,
      worktree,
    });
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
    let result: Awaited<ReturnType<typeof readSessionPrsDetailed>>;
    try {
      const sidecarPath = sessionService.getPrSessionPathForArchiveState(
        sessionId,
        archiveState,
      );
      result = signal
        ? await readSessionPrsDetailed(sidecarPath, { signal })
        : await readSessionPrsDetailed(sidecarPath);
    } catch {
      signal?.throwIfAborted();
      result = { status: 'invalid' };
    }
    if (result.status === 'ok') {
      bySessionId.set(sessionId, {
        ...summary,
        prs: sidecarToPrInfos(result.prs),
      });
    }
    // An unreadable sidecar is UNKNOWN bindings, not an unbind: leave `prs`
    // unset rather than projecting an empty list. The PR-bindings snapshot
    // reads the sidecars itself and reports such a session as partial.
  }
}

/**
 * Enrich persisted session summaries with the restorable artifact count from
 * the summary sidecar so the header entry can show it at click time. Same
 * best-effort pattern as {@link enrichPrSidecars}: a missing or unreadable
 * sidecar is an UNKNOWN count, not zero artifacts, and leaves the field
 * unset. Runs before the live merge; a live entry's own count supersedes it.
 */
async function enrichArtifactSummaries(
  bySessionId: Map<string, BridgeSessionSummary>,
  sessionService: SessionService,
  archiveState: SessionArchiveState,
  signal?: AbortSignal,
): Promise<void> {
  for (const [sessionId, summary] of bySessionId) {
    signal?.throwIfAborted();
    let count: number | undefined;
    try {
      const sidecarPath = sessionService.getArtifactSummaryPathForArchiveState(
        sessionId,
        archiveState,
      );
      // Yield between reads so a cancelled page stops doing work promptly.
      const sidecar = signal
        ? await readSessionArtifactSummarySidecarAsync(sidecarPath, { signal })
        : await readSessionArtifactSummarySidecarAsync(sidecarPath);
      count = sidecar?.artifactCount;
    } catch {
      signal?.throwIfAborted();
      count = undefined;
    }
    if (count !== undefined && count > 0) {
      bySessionId.set(sessionId, { ...summary, artifactCount: count });
    }
  }
}

/**
 * Enrich persisted session summaries with the goal list projection from
 * sidecar files, so the sidebar marker survives daemon restarts and shows
 * for unloaded/archived sessions the live-only Goals listing cannot see.
 * Same pattern as {@link enrichPrSidecars}; disk-only, no IPC probes. An
 * absent or unreadable sidecar leaves `goal` unset (no marker).
 */
async function enrichGoalSidecars(
  bySessionId: Map<string, BridgeSessionSummary>,
  sessionService: SessionService,
  archiveState: SessionArchiveState,
  signal?: AbortSignal,
): Promise<void> {
  for (const [sessionId, summary] of bySessionId) {
    signal?.throwIfAborted();
    let sidecar: Awaited<ReturnType<typeof readSessionGoalSidecar>>;
    try {
      const sidecarPath = sessionService.getGoalSessionPathForArchiveState(
        sessionId,
        archiveState,
      );
      sidecar = signal
        ? await readSessionGoalSidecar(sidecarPath, { signal })
        : await readSessionGoalSidecar(sidecarPath);
    } catch {
      signal?.throwIfAborted();
      sidecar = null;
    }
    if (sidecar) {
      bySessionId.set(sessionId, {
        ...summary,
        goal: {
          status: sidecar.status,
          objective: sidecar.objective,
          updatedAt: new Date(sidecar.updatedAt).toISOString(),
        },
      });
    }
  }
}

/**
 * Teardown flush codes: `flushPromptTerminals` publishes an `error` terminal
 * with one of these codes for every still-pending prompt when the daemon
 * shuts down, the agent channel exits, or the session is closed/killed. The
 * turn was cut off by teardown, not by a model failure, so the session can
 * offer "Continue execution" on its next load.
 */
const CONTINUATION_TEARDOWN_CODES = new Set([
  'daemon_shutdown',
  'channel_closed',
  'session_closed',
  'session_killed',
]);

/**
 * Only the ledger's last record decides, so a small tail window suffices;
 * the reader drops a torn final line and falls back to the previous record.
 */
const CONTINUATION_LEDGER_TAIL_BYTES = 4 * 1024;

/**
 * Enrich persisted summaries with prompt-ledger continuation evidence so the
 * sidebar can mark sessions whose latest prompt was cut off mid-flight. Same
 * pattern as {@link enrichPrSidecars}; active sessions only — the ledger path
 * is the active one, and archived conversations are closed. Fail-closed: an
 * unreadable ledger leaves the field absent.
 */
async function enrichPromptContinuation(
  bySessionId: Map<string, BridgeSessionSummary>,
  sessionService: SessionService,
  archiveState: SessionArchiveState,
  signal?: AbortSignal,
): Promise<void> {
  if (archiveState !== 'active') return;
  let scanned = 0;
  for (const [sessionId, summary] of bySessionId) {
    signal?.throwIfAborted();
    // The ledger reads are synchronous; yield periodically so a large
    // catalog scan does not stall the daemon's event loop (the async PR
    // sidecar enrichment interleaves naturally).
    if (++scanned % 64 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal?.throwIfAborted();
    }
    let records: ReturnType<typeof readPromptLedgerRecords>;
    try {
      records = readPromptLedgerRecords(
        sessionService.getPromptLedgerPath(sessionId),
        { tailBytes: CONTINUATION_LEDGER_TAIL_BYTES },
      );
    } catch {
      signal?.throwIfAborted();
      continue;
    }
    const last = records[records.length - 1];
    if (!last) continue;
    const cutOff = !isPromptLedgerTerminalRecord(last)
      ? true // dangling admission: no terminal ever landed
      : last.terminal === 'interrupted' ||
        (last.terminal === 'error' &&
          last.code !== undefined &&
          CONTINUATION_TEARDOWN_CODES.has(last.code));
    if (cutOff) {
      bySessionId.set(sessionId, { ...summary, needsContinuation: true });
    }
  }
}

async function enrichDetachedBackgroundWork(
  bySessionId: Map<string, BridgeSessionSummary>,
  liveRows: readonly BridgeSessionSummary[],
  workspaceCwd: string,
  signal?: AbortSignal,
): Promise<void> {
  if (bySessionId.size === 0) return;
  // The raw live summary timestamps the current registration. A merged row
  // carries the original transcript timestamp, which would hide older shells.
  const liveSince = new Map<string, number>();
  for (const row of liveRows) {
    if (!bySessionId.has(row.sessionId)) continue;
    const createdAt = Date.parse(row.createdAt);
    if (Number.isFinite(createdAt)) liveSince.set(row.sessionId, createdAt);
  }
  const verdicts = await resolveDetachedBackgroundWork({
    sessionIds: [...bySessionId.keys()],
    projectTempDir: projectTempDirFor(workspaceCwd),
    liveSince,
    signal,
  });
  for (const [sessionId, detachedBackgroundWork] of verdicts) {
    const row = bySessionId.get(sessionId);
    if (row) {
      bySessionId.set(sessionId, { ...row, detachedBackgroundWork });
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
  titleSource?: 'manual' | 'auto';
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
    ...(item.customTitle && item.titleSource
      ? { titleSource: item.titleSource }
      : {}),
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
    backgroundTurn: live.backgroundTurn,
    hasRunningBackgroundTasks: live.hasRunningBackgroundTasks,
    isArchived: false,
  };
  if (live.worktree) {
    // Snapshot lifecycle changes are owned by the sidecar, not a live
    // summary that may predate its removal or restoration.
    const worktree = { ...live.worktree };
    delete worktree.worktreeRemoved;
    delete worktree.canRestore;
    const removed = existing.worktree?.worktreeRemoved;
    if (removed) {
      merged.worktree = {
        ...worktree,
        worktreeRemoved: removed,
        ...(existing.worktree?.canRestore !== undefined
          ? { canRestore: existing.worktree.canRestore }
          : {}),
      };
    } else {
      merged.worktree = worktree;
    }
  }
  // Work in flight supersedes the persisted cut-off evidence: the running
  // turn owns the transcript tail now, so a fresh catalog read of a running
  // session must not carry the continuation hint.
  if (
    merged.hasActivePrompt ||
    merged.activeWorkState === 'active' ||
    merged.hasRunningBackgroundTasks ||
    merged.backgroundTurn
  ) {
    delete merged.needsContinuation;
  }
  // The live entry only knows PR bindings from this daemon lifetime while the
  // sidecar-enriched persisted summary holds the full history. The sidecar is
  // the append-only binding-time record (last = latest — the order the badge
  // renders by), so it supplies the merged order; the live entry overlays
  // fresher volatile data onto it. Positional concatenation (persisted-only
  // before live) breaks that order whenever a persisted-only binding is
  // NEWER than a live one — exactly what a shell-hook write lands after a
  // GitDialog bind. For `state` the sidecar wins: the refresh timer rewrites
  // it there, while the live entry is frozen at bind-time.
  if (existing.prs || live.prs) {
    merged.prs = mergeSummaryPrs(existing.prs, live.prs);
  }
  // The live entry is authoritative for its artifact count (the spread above
  // already overlays a non-zero one). When it omits the field — count zero —
  // a stale sidecar-derived count from the persisted summary must not survive.
  // The exception is a pending restore: the entry is live but its store is
  // not hydrated yet, so the omission is unknown, not zero, and the
  // sidecar-enriched count stays until the restore settles.
  if (live.artifactCount === undefined && live.artifactCountPending !== true) {
    delete merged.artifactCount;
  }
  return merged;
}

function sidecarToPrInfos(sidecar: readonly SessionPr[]): SessionPrInfo[] {
  return sidecar.map(toSessionPrInfo);
}

/**
 * Merges persisted (sidecar-enriched) PR bindings with a live entry's for
 * summary rendering. The sidecar is the append-only binding-time record
 * (last = latest — the order the badge renders by), so it supplies the
 * merged order; the live entry overlays fresher volatile data onto it.
 * Positional concatenation (persisted-only before live) breaks that order
 * whenever a persisted-only binding is NEWER than a live one — exactly what
 * a shell-hook write lands after a GitDialog bind. For `state` and `issues`
 * the persisted sidecar wins: the refresh timer rewrites them there, while
 * the live entry is frozen at bind-time — and only for the same PR (same
 * canonical url), whose live spelling (a query, a trailing slash) is kept.
 * A same-numbered entry at a DIFFERENT canonical url is another PR: the
 * sidecar-only writers (the shell hook, backfill) re-bind without touching
 * the live entry, so the persisted binding wins wholesale and no stale live
 * field survives; when a hand-edited sidecar holds two same-numbered
 * entries, the live binding attaches to the url-matched one. A binding
 * present only in the live entry was either bound this daemon lifetime and
 * has not landed in the sidecar yet (the newest binding), or was EVICTED
 * from the sidecar once it overflowed; eviction only happens at the cap, so
 * below it a live-only entry is genuinely the newest and at the cap it must
 * not be re-appended as the session's latest.
 */
function mergeSummaryPrs(
  persistedPrs: readonly SessionPrInfo[] | undefined,
  livePrs: readonly SessionPrInfo[] | undefined,
): SessionPrInfo[] {
  const live = livePrs ?? [];
  const persisted = persistedPrs ?? [];
  const liveByNumber = new Map(live.map((l) => [l.number, l]));
  const persistedNumbers = new Set(persisted.map((p) => p.number));
  const consumedLive = new Set<number>();
  const ordered: SessionPrInfo[] = [];
  for (const p of persisted) {
    const liveEntry = liveByNumber.get(p.number);
    if (!liveEntry) {
      ordered.push(p);
      continue;
    }
    const samePr =
      canonicalSessionPrUrl(p.url) === canonicalSessionPrUrl(liveEntry.url);
    // Matched by url, not a number-keyed map: a hand-edited sidecar can
    // hold two same-numbered entries, and the live binding must attach to
    // its own entry, not whichever one comes last.
    const matchedTwinExists = persisted.some(
      (q) =>
        q.number === p.number &&
        canonicalSessionPrUrl(q.url) === canonicalSessionPrUrl(liveEntry.url),
    );
    if (!samePr && matchedTwinExists) continue;
    if (consumedLive.has(p.number)) continue;
    consumedLive.add(p.number);
    ordered.push(
      samePr
        ? {
            ...liveEntry,
            ...(p.state ? { state: p.state } : {}),
            ...(p.issues ? { issues: p.issues } : {}),
          }
        : p,
    );
  }
  for (const liveEntry of live) {
    // Gate on the PERSISTED size: eviction only happens at the cap, so
    // below it a live-only entry is genuinely the newest binding and must
    // not be dropped once the running total fills up — the final slice
    // keeps the newest and evicts the oldest persisted instead.
    if (
      !persistedNumbers.has(liveEntry.number) &&
      persisted.length < SESSION_PR_LIST_LIMIT
    ) {
      ordered.push(liveEntry);
    }
  }
  return ordered.slice(-SESSION_PR_LIST_LIMIT);
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
    backgroundTurn: live.backgroundTurn,
    hasRunningBackgroundTasks: live.hasRunningBackgroundTasks,
    isArchived: false,
  };
  let result: Awaited<ReturnType<typeof readSessionPrsDetailed>>;
  try {
    const sidecarPath = sessionService.getPrSessionPathForArchiveState(
      live.sessionId,
      'active',
    );
    result = signal
      ? await readSessionPrsDetailed(sidecarPath, { signal })
      : await readSessionPrsDetailed(sidecarPath);
  } catch {
    signal?.throwIfAborted();
    result = { status: 'invalid' };
  }
  if (result.status === 'ok') {
    summary.prs = mergeSummaryPrs(sidecarToPrInfos(result.prs), live.prs);
  }
  // Invalid: unknown bindings, not an unbind; the live entry's own bindings
  // (if any) survive via the spread above.
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

function readPersistedSidecars(
  session: Readonly<BridgeSessionSummary>,
  service: SessionService,
  archiveState: SessionArchiveState,
  signal: AbortSignal | undefined,
  revalidateWorktree: boolean,
  isSessionRetirementFenced?: (sessionId: string) => boolean,
): Promise<BridgeSessionSummary> {
  signal?.throwIfAborted();
  const cachedLoad = persistedSidecarLoads.get(session);
  let load = cachedLoad;
  // A load created or still pending for this call already read the sidecar
  // in this request; revalidating it again would double every page read.
  const revalidateCachedWorktree =
    revalidateWorktree &&
    cachedLoad !== undefined &&
    !cachedLoad.controller.signal.aborted &&
    cachedLoad.settled;
  if (!load || load.controller.signal.aborted) {
    const controller = new AbortController();
    const read = async () => {
      const readSignal = controller.signal;
      readSignal.throwIfAborted();
      const rows = new Map([[session.sessionId, { ...session }]]);
      await enrichWorktreeSidecars(
        rows,
        service,
        archiveState,
        readSignal,
        isSessionRetirementFenced,
      );
      await enrichPrSidecars(rows, service, archiveState, readSignal);
      await enrichArtifactSummaries(rows, service, archiveState, readSignal);
      await enrichGoalSidecars(rows, service, archiveState, readSignal);
      readSignal.throwIfAborted();
      return rows.get(session.sessionId)!;
    };
    const started: PersistedSidecarLoad = {
      controller,
      waiterCount: 0,
      settled: false,
      promise: Promise.resolve()
        .then(read)
        .catch((error: unknown) => {
          if (persistedSidecarLoads.get(session) === started) {
            persistedSidecarLoads.delete(session);
          }
          throw error;
        })
        .finally(() => {
          started.settled = true;
        }),
    };
    persistedSidecarLoads.set(session, started);
    load = started;
  }
  const metadataLoad = load;
  return waitForSessionListLoad(metadataLoad, signal).then(async (cached) => {
    // A fresh scan and its joiners already share this validated projection.
    if (!revalidateCachedWorktree) return clonePersistedSummary(cached);
    let worktreeLoad = metadataLoad.worktreeLoad;
    if (
      !worktreeLoad ||
      worktreeLoad.settled ||
      worktreeLoad.controller.signal.aborted
    ) {
      // Removal and restoration can change while metadata is cached. Share
      // only the pending read; a later view validates the sidecar again.
      const controller = new AbortController();
      const started: SessionListLoad<BridgeSessionSummary> = {
        controller,
        waiterCount: 0,
        settled: false,
        promise: Promise.resolve()
          .then(async () => {
            controller.signal.throwIfAborted();
            const rows = new Map([
              [session.sessionId, clonePersistedSummary(cached)],
            ]);
            await enrichWorktreeSidecars(
              rows,
              service,
              archiveState,
              controller.signal,
              isSessionRetirementFenced,
            );
            controller.signal.throwIfAborted();
            return rows.get(session.sessionId)!;
          })
          .catch((error: unknown) => {
            if (metadataLoad.worktreeLoad === started) {
              delete metadataLoad.worktreeLoad;
            }
            throw error;
          })
          .finally(() => {
            started.settled = true;
          }),
      };
      worktreeLoad = started;
      metadataLoad.worktreeLoad = started;
    }
    return waitForSessionListLoad(worktreeLoad, signal).then(
      clonePersistedSummary,
    );
  });
}

async function enrichCatalogPage(
  page: BridgeSessionSummary[],
  persistedById: ReadonlyMap<string, Readonly<BridgeSessionSummary>>,
  liveRows: readonly BridgeSessionSummary[],
  service: SessionService,
  archiveState: SessionArchiveState,
  workspaceCwd: string,
  signal: AbortSignal | undefined,
  revalidateWorktree: boolean,
  isSessionRetirementFenced?: (sessionId: string) => boolean,
): Promise<void> {
  const selectedIds = new Set(page.map((session) => session.sessionId));
  const detailsById = new Map<string, BridgeSessionSummary>();
  for (const { sessionId } of page) {
    const stored = persistedById.get(sessionId);
    if (stored) {
      detailsById.set(
        sessionId,
        clonePersistedSummary(
          await readPersistedSidecars(
            stored,
            service,
            archiveState,
            signal,
            revalidateWorktree,
            isSessionRetirementFenced,
          ),
        ),
      );
    }
  }
  await enrichDetachedBackgroundWork(
    detailsById,
    liveRows,
    workspaceCwd,
    signal,
  );
  // Replay live merges on the enriched rows. The selected summaries keep
  // their organization, sort keys, and cursor identity.
  for (const live of liveRows) {
    signal?.throwIfAborted();
    if (!selectedIds.has(live.sessionId)) continue;
    const stored = detailsById.get(live.sessionId);
    detailsById.set(
      live.sessionId,
      stored
        ? mergeLiveSessionSummary(stored, live)
        : await liveOnlySummary(live, service, signal),
    );
  }
  signal?.throwIfAborted();
  for (const session of page) {
    const details = detailsById.get(session.sessionId);
    if (!details) continue;
    if (details.worktree !== undefined) session.worktree = details.worktree;
    if (details.prs !== undefined) session.prs = details.prs;
    if (details.artifactCount !== undefined)
      session.artifactCount = details.artifactCount;
    if (details.goal !== undefined) session.goal = details.goal;
    if (details.detachedBackgroundWork !== undefined)
      session.detachedBackgroundWork = details.detachedBackgroundWork;
  }
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
  let catalogReadFallbacks = 0;
  let cursor: number | string | undefined;
  do {
    scanPages += 1;
    const page = await sessionService.listSessions({
      cursor,
      size: 10_000,
      archiveState,
      signal,
      forCatalog: true,
      excludeSourceTypes: [...HIDDEN_CATALOG_SOURCE_TYPES],
    });
    signal.throwIfAborted();
    catalogReadFallbacks += page.catalogReadFallbacks ?? 0;
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
  await enrichPromptContinuation(
    bySessionId,
    sessionService,
    archiveState,
    signal,
  );
  signal.throwIfAborted();
  return {
    sessions: [...bySessionId.values()],
    truncated,
    scanPages,
    catalogReadFallbacks,
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
): Promise<CachedCatalogSnapshot> {
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
    addDaemonRequestAttribute(
      'qwen-code.daemon.session_list.catalog_read_fallbacks',
      snapshot.catalogReadFallbacks ?? 0,
    );
  }
  return {
    ...snapshot,
    revalidateWorktree: lookup.status === 'cache_hit',
  };
}

function getSummaryActivityTime(
  session: BridgeSessionSummary,
  sortBy?: 'updatedAt' | 'lastUserPromptAt',
): number {
  if (sortBy === 'lastUserPromptAt') {
    const time = Date.parse(session.lastUserPromptAt ?? '');
    return Number.isFinite(time) ? time : Number.MIN_SAFE_INTEGER;
  }
  const time = Date.parse(session.updatedAt ?? session.createdAt);
  return Number.isFinite(time) ? time : 0;
}

function getLiveSessionCursorKey(
  session: BridgeSessionSummary,
  sortBy?: 'updatedAt' | 'lastUserPromptAt',
): LiveSessionCursorKey {
  return {
    activityTime: getSummaryActivityTime(session, sortBy),
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
          paginateMerged: readOptions.paginateMerged === true,
          group,
          sortBy: options.sortBy,
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
  const persistedById = new Map<string, Readonly<BridgeSessionSummary>>();
  for (const session of persisted.sessions) {
    persistedById.set(session.sessionId, session);
    bySessionId.set(
      session.sessionId,
      applyOrganization(
        { ...session },
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
  const liveRows: BridgeSessionSummary[] = [];

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
          // Preserve legacy first-page-only insertion unless the caller
          // requests pagination across the complete merged catalog. Question
          // sorting also needs later pages: a live-only row has no question
          // time yet, so it sorts last and would otherwise be unreachable.
          (isFirstPage ||
            readOptions.paginateMerged ||
            options.sortBy === 'lastUserPromptAt') &&
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
            applyOrganization({ ...live, isArchived: false }, organization),
          );
        } else {
          continue;
        }
        liveRows.push(live);
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
    if (isHiddenCatalogSource(session.sourceType)) return false;
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
  if (options.sortBy === 'lastUserPromptAt') {
    await enrichPromptTimes(
      filtered,
      sessionService,
      archiveState,
      readOptions,
      true,
    );
    for (const session of filtered)
      persistedTimeById.set(
        session.sessionId,
        getSummaryActivityTime(session, options.sortBy),
      );
  }
  const activityTimeById = new Map(
    filtered.map((session) => [
      session.sessionId,
      getSummaryActivityTime(session, options.sortBy),
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
      readOptions.paginateMerged === true,
      options.sourceType,
      options.sourceId,
      options.conversationKind,
      emitted,
      options.sortBy,
    );
  }
  await enrichCatalogPage(
    page,
    persistedById,
    liveRows,
    sessionService,
    archiveState,
    workspaceCwd,
    readOptions.signal,
    persisted.revalidateWorktree,
    (id) => isBridgeSessionRetirementFenced(bridge, id),
  );
  return {
    sessions: page,
    ...(readOptions.includeGroups
      ? {
          groups: {
            groups: snapshot.groups,
            colorOptions: [...GROUP_COLOR_OPTIONS],
          },
        }
      : {}),
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
  const persistedById = new Map<string, Readonly<BridgeSessionSummary>>();
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
        persistedById.delete(sessionId);
        persistedTimeById.delete(sessionId);
        conflictedStandaloneIds.add(sessionId);
        continue;
      }
    }
    persistedById.set(sessionId, session);
    bySessionId.set(sessionId, {
      ...session,
      sessionId,
    });
    persistedTimeById.set(sessionId, getSummaryActivityTime(session));
  }
  // Activity floors: the key a row falls back to once its live entry is gone.
  const liveSessionIds = new Set<string>();
  const liveRows: BridgeSessionSummary[] = [];

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
          bySessionId.set(sessionId, { ...canonicalLive, isArchived: false });
        } else {
          continue;
        }
        liveRows.push(canonicalLive);
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

  const matches = [...bySessionId.values()].filter(
    (session) =>
      !isHiddenCatalogSource(session.sourceType) &&
      (filter.parentSessionId === undefined ||
        session.parentSessionId === filter.parentSessionId) &&
      matchesSessionMetadataSource(session, filter),
  );
  readOptions.signal?.throwIfAborted();
  // Reject a cross-sort cursor before paying for any transcript read.
  const cursor =
    options.cursor !== undefined && options.cursor !== ''
      ? parseMetadataSessionCursor(options.cursor, {
          paginateMerged: readOptions.paginateMerged === true,
          ...filter,
          archiveState,
        })
      : undefined;
  if (options.sortBy === 'lastUserPromptAt') {
    await enrichPromptTimes(
      matches,
      sessionService,
      archiveState,
      readOptions,
      true,
    );
    for (const session of matches)
      persistedTimeById.set(
        session.sessionId,
        getSummaryActivityTime(session, options.sortBy),
      );
  }
  matches.sort((a, b) =>
    compareLiveSessionCursorKeys(
      getLiveSessionCursorKey(a, options.sortBy),
      getLiveSessionCursorKey(b, options.sortBy),
    ),
  );
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
              getLiveSessionCursorKey(session, options.sortBy),
            ) < 0,
        );
  const page = afterCursor.slice(0, pageSize);
  let nextCursor: string | undefined;
  if (page.length < afterCursor.length) {
    const boundary = getLiveSessionCursorKey(
      page[page.length - 1]!,
      options.sortBy,
    );
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
      readOptions.paginateMerged === true,
      emitted,
    );
  }
  await enrichCatalogPage(
    page,
    persistedById,
    liveRows,
    sessionService,
    archiveState,
    workspaceCwd,
    readOptions.signal,
    persisted.revalidateWorktree,
    (id) => isBridgeSessionRetirementFenced(bridge, id),
  );
  return {
    sessions: page,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    ...(liveMergeFailed ? { liveMergeFailed: true } : {}),
    ...(persisted.truncated ? { truncated: true } : {}),
  };
}

function waitForQuestionTime(
  promise: Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
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
        ...(readOptions.paginateMerged !== undefined
          ? { paginateMerged: readOptions.paginateMerged }
          : {}),
        ...(readOptions.includeGroups !== undefined
          ? { includeGroups: readOptions.includeGroups }
          : {}),
        ...(readOptions.signal !== undefined
          ? { signal: readOptions.signal }
          : {}),
        runtimeBaseDir,
      }),
  );
  readOptions.signal?.throwIfAborted();
  if (options?.sortBy !== 'lastUserPromptAt') {
    await enrichPromptTimes(
      result.sessions,
      new SessionService(workspaceCwd, { runtimeBaseDir }),
      options?.archiveState ?? 'active',
      readOptions,
    );
  }
  return result;
}

async function enrichPromptTimes(
  sessions: BridgeSessionSummary[],
  service: SessionService,
  archiveState: SessionArchiveState,
  readOptions: Pick<ListWorkspaceSessionsReadOptions, 'signal'>,
  preferCache = false,
): Promise<void> {
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, sessions.length) }, async () => {
      while (nextIndex < sessions.length) {
        readOptions.signal?.throwIfAborted();
        const session = sessions[nextIndex++]!;
        try {
          session.lastUserPromptAt = await waitForQuestionTime(
            preferCache
              ? service.getLastUserPromptAt(session.sessionId, archiveState, {
                  preferCache: true,
                })
              : service.getLastUserPromptAt(session.sessionId, archiveState),
            readOptions.signal,
          );
        } catch {
          // One unreadable transcript must not fail the page; abort still wins.
          readOptions.signal?.throwIfAborted();
          session.lastUserPromptAt = undefined;
        }
      }
    }),
  );
  readOptions.signal?.throwIfAborted();
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
    readOptions.paginateMerged ||
    options?.sortBy === 'lastUserPromptAt' ||
    options?.parentSessionId !== undefined ||
    options?.sourceType !== undefined ||
    options?.conversationKind !== undefined
  ) {
    return listWorkspaceSessionsByMetadataForResponse(
      bridge,
      workspaceCwd,
      options ?? {},
      pageSize,
      {
        ...(options?.sortBy !== undefined ? { sortBy: options.sortBy } : {}),
        ...(options?.parentSessionId !== undefined
          ? { parentSessionId: options.parentSessionId }
          : {}),
        ...(options?.sourceType !== undefined
          ? { sourceType: options.sourceType }
          : {}),
        ...(options?.sourceId !== undefined
          ? { sourceId: options.sourceId }
          : {}),
        ...(options?.conversationKind !== undefined
          ? { conversationKind: options.conversationKind }
          : {}),
      },
      readOptions,
    );
  }

  let persistedCursor: number | string | undefined;
  if (options?.cursor != null) {
    persistedCursor = parseSessionCursor(options.cursor);
  }
  const isFirstPage = persistedCursor === undefined;

  const sessionService = new SessionService(workspaceCwd);
  const archiveState = options?.archiveState ?? 'active';
  const persisted = await sessionService.listSessions({
    cursor: persistedCursor,
    size: pageSize,
    archiveState,
    excludeSourceTypes: [...HIDDEN_CATALOG_SOURCE_TYPES],
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
    (id) => isBridgeSessionRetirementFenced(bridge, id),
  );
  await enrichPrSidecars(
    bySessionId,
    sessionService,
    archiveState,
    readOptions.signal,
  );
  await enrichArtifactSummaries(
    bySessionId,
    sessionService,
    archiveState,
    readOptions.signal,
  );
  await enrichGoalSidecars(
    bySessionId,
    sessionService,
    archiveState,
    readOptions.signal,
  );
  await enrichPromptContinuation(
    bySessionId,
    sessionService,
    archiveState,
    readOptions.signal,
  );
  const mergingLive =
    archiveState !== 'archived' && readOptions.mergeLive !== false;
  const preProbeLive = mergingLive
    ? bridge
        .listWorkspaceSessions(workspaceCwd)
        .filter((session) => !isHiddenCatalogSource(session.sourceType))
    : [];
  await enrichDetachedBackgroundWork(
    bySessionId,
    preProbeLive,
    workspaceCwd,
    readOptions.signal,
  );
  readOptions.signal?.throwIfAborted();

  if (!mergingLive) {
    const sessions = [...bySessionId.values()];
    const nextCursor =
      persisted.nextCursor != null ? String(persisted.nextCursor) : undefined;
    return { sessions, nextCursor };
  }

  // Re-read after the probe await so the response uses the latest live state.
  const liveSessions = bridge
    .listWorkspaceSessions(workspaceCwd)
    .filter((session) => !isHiddenCatalogSource(session.sourceType));
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
      .filter((session) => !isHiddenCatalogSource(session.sourceType))
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

export interface SearchWorkspaceSessionsResult {
  results: Array<{ session: BridgeSessionSummary; snippet: string }>;
}

/**
 * Searches user/assistant message text across the workspace's persisted
 * active sessions and returns one summary + snippet per matching session,
 * most recently modified first. Persisted-only: live sessions without a
 * flushed transcript have no searchable content yet, and read-only secondary
 * runtimes may only inspect the persisted store.
 */
export async function searchWorkspaceSessionsForResponse(
  workspaceCwd: string,
  query: string,
  options: { maxResults?: number } = {},
  readOptions: ListWorkspaceSessionsReadOptions = {},
): Promise<SearchWorkspaceSessionsResult> {
  readOptions.signal?.throwIfAborted();
  const runtimeBaseDir = new Storage(
    workspaceCwd,
    readOptions.runtimeBaseDir,
  ).getRuntimeBaseDir();
  return Storage.runWithResolvedRuntimeBaseDir(runtimeBaseDir, async () => {
    const sessionService = new SessionService(workspaceCwd);
    const hits = await sessionService.searchSessionContent(query, {
      ...(options.maxResults !== undefined
        ? { maxResults: options.maxResults }
        : {}),
      ...(readOptions.signal ? { signal: readOptions.signal } : {}),
    });
    const bySessionId = new Map<string, BridgeSessionSummary>();
    // Ghost hits (sessions the client's loaded catalog page doesn't carry)
    // must render with the same organization state as catalog entries —
    // pin/group/color — or they break the pin/group invariants downstream.
    const organizationSnapshot =
      await createSessionOrganizationService(workspaceCwd).readSnapshot();
    readOptions.signal?.throwIfAborted();
    for (const hit of hits) {
      readOptions.signal?.throwIfAborted();
      const item = await sessionService.getSessionListItem(hit.sessionId);
      if (item && !isHiddenCatalogSource(item.sourceType))
        bySessionId.set(
          hit.sessionId,
          applyOrganization(
            toSummary(item),
            organizationSnapshot.sessions.get(hit.sessionId),
          ),
        );
    }
    await enrichWorktreeSidecars(
      bySessionId,
      sessionService,
      'active',
      readOptions.signal,
      readOptions.isSessionRetirementFenced,
    );
    await enrichPrSidecars(
      bySessionId,
      sessionService,
      'active',
      readOptions.signal,
    );
    await enrichArtifactSummaries(
      bySessionId,
      sessionService,
      'active',
      readOptions.signal,
    );
    await enrichGoalSidecars(
      bySessionId,
      sessionService,
      'active',
      readOptions.signal,
    );
    await enrichPromptContinuation(
      bySessionId,
      sessionService,
      'active',
      readOptions.signal,
    );
    readOptions.signal?.throwIfAborted();
    const results: SearchWorkspaceSessionsResult['results'] = [];
    for (const hit of hits) {
      const session = bySessionId.get(hit.sessionId);
      if (session) results.push({ session, snippet: hit.snippet });
    }
    return { results };
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
  const counts = await new SessionService(workspaceCwd).getSessionInfoCounts({
    excludeSourceTypes: [...HIDDEN_CATALOG_SOURCE_TYPES],
  });
  return {
    active: counts.active,
    archived: counts.archived,
    total: counts.total,
    ...(options.includeLive === false
      ? {}
      : {
          live: bridge
            .listWorkspaceSessions(workspaceCwd)
            .filter((session) => !isHiddenCatalogSource(session.sourceType))
            .length,
        }),
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
