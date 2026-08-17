/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  APPROVAL_MODES,
  BTW_MAX_INPUT_LENGTH,
  GROUP_COLOR_OPTIONS,
  GitWorktreeService,
  SessionOrganizationError,
  SESSION_TRANSCRIPT_MAX_LIMIT,
  SESSION_TRANSCRIPT_MAX_EXPANDED_PAGE_BYTES,
  SESSION_TRANSCRIPT_MAX_PAGE_BYTES,
  SessionTranscriptPageTooLargeError,
  SessionTranscriptCursorCodec,
  SessionTranscriptReader,
  SessionTranscriptSnapshotUnavailableError,
  addDaemonRequestAttribute,
  runWithoutDebugLogSession,
  writeWorktreeSessionMarker,
  writeWorktreeSession,
  readWorktreeSession,
  type ApprovalMode,
  type SessionGroupColor,
  type SessionGroupPresetColor,
  type SessionArchiveState,
} from '@qwen-code/qwen-code-core';
import type { SessionArtifactInput } from '@qwen-code/acp-bridge/sessionArtifacts';
import {
  CHANNEL_PROMPT_META_KEY,
  DAEMON_PROMPT_DISPLAY_TEXT_META_KEY,
  type BridgeBranchedSession,
} from '@qwen-code/acp-bridge/bridgeTypes';
import { parseSessionSource } from '@qwen-code/acp-bridge';
import {
  isReservedLiveSessionSource,
  readLoadableLiveConversationMetadata,
} from '../conversations/session-source.js';
import type { ConversationRuntimeActivityGate } from '../conversations/conversation-runtime-activity.js';
import { ConversationRuntimeOwnershipError } from '../conversations/conversation-runtime-errors.js';
import express, {
  type Application,
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { parseCallerSuppliedSessionId } from '../../config/session-id.js';
import { isChannelDeliveryError } from '../../runtime/channel-delivery-ipc.js';
import { parseChannelDelivery } from '../../runtime/channel-delivery.js';
import {
  canonicalizeWorkspace,
  InvalidClientIdError,
  InvalidSessionMetadataError,
  PromptQueueFullError,
  SessionArtifactValidationError,
  SessionArchivedError,
  SessionConflictError,
  SessionNotFoundError,
  SessionShellClientRequiredError,
  SessionShellDisabledError,
  type AcpSessionBridge,
  type BridgePromptContentBlock,
  type BridgeSessionCatalogVersion,
} from '../acp-session-bridge.js';
import type { DaemonLogger } from '../daemon-logger.js';
import type { SendBridgeError } from '../server/error-response.js';
import { resolvePromptDeadlineMs } from '../server/prompt-deadline.js';
import {
  parseClientIdHeader,
  parseOptionalWorkspaceCwd,
  requireSessionId,
  safeBody,
  safeLogValue,
} from '../server/request-helpers.js';
import {
  InvalidCursorError,
  getWorkspaceSessionInfoForResponse,
  invalidateWorkspaceSessionListCache,
  listLiveWorkspaceSessionsForResponse,
  listWorkspaceSessionsForResponse,
  parseSessionPageSizeQuery,
} from '../server/session-list.js';
import {
  archiveDaemonSessions,
  assertSessionArchived,
  assertSessionLoadable,
  deleteDaemonSessionIfOrphan,
  deleteDaemonSessions,
  logSessionArchiveWarning,
  type SessionArchiveCoordinator,
  unarchiveDaemonSessions,
} from '../server/session-archive.js';
import {
  exportSessionTranscript,
  parseSessionExportFormat,
  sessionExportFormatValues,
} from '../server/session-export.js';
import { setDaemonTelemetryWorkspace } from '../server/telemetry.js';
import { createSessionOrganizationService } from '../session-organization-helpers.js';
import {
  omitSkillDetailsForSdkSurface,
  omitSkillDetailsFromReplayArrays,
} from '../skill-details-redaction.js';
import { replayTranscriptRecordPage } from '../../acp-integration/session/history-replay-page.js';
import { GENERATION_MAX_PROMPT_BYTES } from '../../acp-integration/generation.js';
import {
  formatGenerationSse,
  GENERATION_HEARTBEAT_MS,
  writeGenerationSseChunk,
} from '../generation-sse.js';
import {
  requirePrimarySessionRuntime,
  requireSessionRuntime,
} from './session-runtime.js';
import {
  branchExists,
  isDirtyTree,
  getHeadCommit,
  createBranch,
  checkoutRef,
  deleteBranch,
} from '../server/git-branch-ops.js';
import {
  MAX_VIRTUAL_SESSION_ID_PART_LENGTH,
  parseVirtualSubagentSessionId,
  type VirtualSubagentSessions,
} from '../virtual-subagent-sessions.js';
import {
  resolveWorkspaceEntryFromParam,
  resolveWorkspaceRuntimeFromParam,
  sendUntrustedWorkspaceResponse,
  sendWorkspaceRuntimeUnavailable,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceEntry,
  WorkspaceRegistry,
  WorkspaceRuntime,
  WorkspaceRuntimeGeneration,
} from '../workspace-registry.js';
import { isInternalWorkspaceRuntime } from '../workspace-runtime-visibility.js';
import {
  createWorkspaceRuntimeSessionService,
  runWithWorkspaceRuntimeStorage,
} from '../workspace-runtime-storage.js';
import type { ChannelDeliveryAuthorizationStore } from '../channel-delivery-authorization.js';
import {
  CHANNEL_WORKER_PROMPT_AUTHORIZATION_META_KEY,
  isChannelWorkerPromptAuthorized,
} from '../channel-worker-prompt-authorization.js';
import {
  createRequestedSessionIdAdmission,
  RequestedSessionIdAdmissionError,
  type RequestedSessionIdAdmission,
  type RequestedSessionIdReservation,
} from '../session-id-admission.js';

// `HEAD` is the most prominent ref name git rejects as a branch name.
// The surrounding predicate covers the remaining reserved forms (`@`, `-`,
// `..`, `.lock` suffixes, etc.). Compared case-insensitively because ref
// storage is case-folding on macOS/Windows.
const GIT_RESERVED_BRANCH = 'HEAD';

// Byte-length caps for branch names. git creates loose refs as files under
// `.git/refs/heads/`, so each `/`-separated component is bounded by the
// filesystem's per-component name limit (255 bytes on Linux/macOS, minus the
// `.lock` suffix git appends while writing). A component over that limit fails
// inside `git checkout -b` with a raw error that embeds the absolute workspace
// path; rejecting here keeps every bad name a clean 400. Unicode is allowed, so
// count UTF-8 bytes, not code points. Mirrors validateBranchName in
// GitModePopover.tsx; keep the two in sync.
const MAX_BRANCH_NAME_BYTES = 1000;
const MAX_BRANCH_COMPONENT_BYTES = 200;

interface RegisterSessionRoutesDeps {
  boundWorkspace: string;
  bridge: AcpSessionBridge;
  workspaceRegistry: WorkspaceRegistry;
  archiveCoordinator: SessionArchiveCoordinator;
  requestedSessionIdAdmission?: RequestedSessionIdAdmission;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  sendBridgeError: SendBridgeError;
  daemonLog?: DaemonLogger;
  channelDeliveryAuthorizations?: ChannelDeliveryAuthorizationStore;
  promptDeadlineMs?: number;
  sessionShellCommandEnabled: boolean;
  languageCodes: string[];
  virtualSubagentSessions?: VirtualSubagentSessions;
  materializeLiveConversationDirectory?: (sessionId: string) => Promise<string>;
  isLiveSessionActive?: (sessionId: string) => boolean;
  ensureConversationRuntime?: () => Promise<WorkspaceRuntime>;
  liveConversationRootPath?: string;
  conversationRuntimeActivity?: ConversationRuntimeActivityGate;
}

// Chosen cap for one serialized transcript response, kept proportional to
// the core expanded-page ceiling so the two cannot drift arbitrarily. This
// is not a derived guarantee: a single aggregated record can exceed any
// page budget (the reader always takes at least one record so pagination
// cannot dead-end), and replayed SessionUpdate objects are not a fixed
// multiple of their source records. A page this route cannot serialize
// returns transcript_page_too_large for that anchor.
const WORKSPACE_TRANSCRIPT_RESPONSE_MAX_BYTES =
  2 * SESSION_TRANSCRIPT_MAX_EXPANDED_PAGE_BYTES;
const WORKSPACE_TRANSCRIPT_CURSOR_MAX_BYTES = 64 * 1024;
const TRANSCRIPT_CURSOR_TOO_LARGE_REPLAY_ERROR =
  'Transcript pagination state exceeds the safe limit';
// Must exceed CHANNEL_DELIVERY_IPC_TIMEOUT_MS (30 s, channel-delivery-ipc.ts) plus scheduling slack.
const CHANNEL_DELIVERY_AUTHORIZATION_GRACE_MS = 60_000;
// Media blocks are resolved into inline bytes at dispatch, so an unbounded
// content array lets one small request fan out into gigabytes of heap (a
// repeated reference resolves to the same 8 MiB image once per occurrence).
// 256 matches the session media store's item cap, so a message can still
// reference every stored item.
const MEDIA_CONTENT_MAX_BLOCKS = 256;

// SVG can carry scripts; this origin also hosts the daemon API and Web
// Shell UI, and stored bytes are served back to browsers — raster formats
// only. Compare the normalized media type: standards-conformant spelling
// variants (`image/svg+xml;charset=utf-8`, `image/SVG+XML`) must not slip
// past an exact-string match.
function isSvgMimeType(mimeType: string | undefined): boolean {
  return mimeType?.split(';', 1)[0]?.trim().toLowerCase() === 'image/svg+xml';
}

// Shared per-block validation for the prompt and mid-turn routes. SVG can
// carry scripts; this origin also hosts the daemon API and Web Shell UI, and
// stored bytes are served back to browsers — raster formats only, matching
// the upload route's policy.
type MediaBlockParseResult =
  | { valid: true; block: BridgePromptContentBlock }
  | { valid: false; code: 'not-object' | 'invalid-shape' | 'svg' };

function parseMediaContentBlock(block: unknown): MediaBlockParseResult {
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    return { valid: false, code: 'not-object' };
  }
  const record = block as Record<string, unknown>;
  const type = record['type'];
  const data = record['data'];
  const mediaId = record['mediaId'];
  const mimeType = record['mimeType'];
  const size = record['size'];
  const inline = typeof data === 'string' && data.length > 0;
  const reference =
    typeof mediaId === 'string' &&
    mediaId.length > 0 &&
    typeof size === 'number' &&
    Number.isSafeInteger(size) &&
    size > 0;
  if (
    type !== 'image' ||
    inline === reference ||
    typeof mimeType !== 'string' ||
    !mimeType.startsWith(`${type}/`)
  ) {
    return { valid: false, code: 'invalid-shape' };
  }
  if (isSvgMimeType(mimeType)) {
    return { valid: false, code: 'svg' };
  }
  return {
    valid: true,
    block: inline
      ? ({ type, data, mimeType } as BridgePromptContentBlock)
      : ({ type, mediaId, mimeType, size } as BridgePromptContentBlock),
  };
}

function mediaBlockParseError(
  code: 'not-object' | 'invalid-shape' | 'svg',
  entryLabel: string,
): string {
  if (code === 'not-object') {
    return `each ${entryLabel} must be a media content block`;
  }
  if (code === 'svg') {
    return 'SVG images are not supported';
  }
  return `each ${entryLabel} must be an image block with either \`data\`, or \`mediaId\` and \`size\`, plus a matching \`mimeType\``;
}
const PRIMARY_ONLY_LIVE_SESSION_ROUTES = ['POST /session/:id/cd'] as const;
const PRIMARY_OR_INTERNAL_LIVE_SESSION_ROUTES = [
  'POST /session/:id/branch',
  'POST /session/:id/side-task',
  'POST /session/:id/fork',
] as const;
type PrimaryOnlyLiveSessionRoute =
  (typeof PRIMARY_ONLY_LIVE_SESSION_ROUTES)[number];
type PrimaryOrInternalLiveSessionRoute =
  (typeof PRIMARY_OR_INTERNAL_LIVE_SESSION_ROUTES)[number];
type RestrictedLiveSessionRoute =
  | PrimaryOnlyLiveSessionRoute
  | PrimaryOrInternalLiveSessionRoute;

function isPrimaryOnlyLiveSessionRoute(
  route: string,
): route is PrimaryOnlyLiveSessionRoute {
  return (PRIMARY_ONLY_LIVE_SESSION_ROUTES as readonly string[]).includes(
    route,
  );
}

function isPrimaryOrInternalLiveSessionRoute(
  route: string,
): route is PrimaryOrInternalLiveSessionRoute {
  return (
    PRIMARY_OR_INTERNAL_LIVE_SESSION_ROUTES as readonly string[]
  ).includes(route);
}

function isReadOnlyWorkspaceInspection(runtime: WorkspaceRuntime): boolean {
  return !runtime.primary && !runtime.trusted;
}

function runWorkspaceInspectionWithLogPolicy<T>(
  runtime: WorkspaceRuntime,
  read: () => Promise<T>,
): Promise<T> {
  const readInRuntime = () => runWithWorkspaceRuntimeStorage(runtime, read);
  return isReadOnlyWorkspaceInspection(runtime)
    ? runWithoutDebugLogSession(readInRuntime)
    : readInRuntime();
}

function requireSessionArtifactClientId(
  clientId: string | undefined,
  res: Response,
): clientId is string {
  if (clientId !== undefined) return true;
  res.status(403).json({
    error: 'Session artifact access requires a session-bound client id',
    code: 'client_id_required',
    errorKind: 'client_id_required',
  });
  return false;
}

function sendArtifactValidationError(res: Response, err: unknown): boolean {
  if (!(err instanceof SessionArtifactValidationError)) {
    return false;
  }
  res.status(400).json({
    v: 1,
    error: {
      code: err.code,
      message: err.message,
      ...(err.field ? { field: err.field } : {}),
    },
  });
  return true;
}

function sendSessionOrganizationError(res: Response, err: unknown): boolean {
  if (!(err instanceof SessionOrganizationError)) {
    return false;
  }
  const status =
    err.code === 'group_name_conflict'
      ? 409
      : err.code === 'group_not_found'
        ? 404
        : err.code === 'session_organization_store_unreadable'
          ? 500
          : 400;
  res.status(status).json({
    error: err.message,
    code: err.code,
    ...(err.field !== undefined ? { field: err.field } : {}),
  });
  return true;
}

function parseTranscriptLimitQuery(
  rawLimit: unknown,
  res: Response,
): number | undefined | null {
  if (rawLimit === undefined) return undefined;
  if (typeof rawLimit !== 'string' || rawLimit.trim() === '') {
    res.status(400).json({
      error: '`limit` must be a positive integer',
      code: 'invalid_transcript_limit',
    });
    return null;
  }
  if (!/^\d+$/.test(rawLimit)) {
    res.status(400).json({
      error: '`limit` must be a positive integer',
      code: 'invalid_transcript_limit',
    });
    return null;
  }
  const limit = Number(rawLimit);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > SESSION_TRANSCRIPT_MAX_LIMIT
  ) {
    res.status(400).json({
      error: `\`limit\` must be between 1 and ${SESSION_TRANSCRIPT_MAX_LIMIT}`,
      code: 'invalid_transcript_limit',
      maxLimit: SESSION_TRANSCRIPT_MAX_LIMIT,
    });
    return null;
  }
  return limit;
}

function parseTranscriptCursorQuery(
  rawCursor: unknown,
  res: Response,
): string | undefined | null {
  if (rawCursor === undefined) return undefined;
  if (typeof rawCursor !== 'string' || rawCursor.trim() === '') {
    res.status(400).json({
      error: '`cursor` must be a non-empty string',
      code: 'invalid_transcript_cursor',
    });
    return null;
  }
  return rawCursor;
}

function parseTranscriptRecordBoundaryQuery(
  rawBoundary: unknown,
  res: Response,
): string | undefined | null {
  if (rawBoundary === undefined) return undefined;
  if (
    typeof rawBoundary !== 'string' ||
    rawBoundary.trim() === '' ||
    rawBoundary.length > 200
  ) {
    res.status(400).json({
      error: '`beforeRecordId` must be a non-empty record id',
      code: 'invalid_transcript_cursor',
    });
    return null;
  }
  return rawBoundary;
}

function parseHistoryPageSize(
  body: Record<string, unknown>,
  res: Response,
): number | undefined | null {
  const value = body['historyPageSize'];
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > SESSION_TRANSCRIPT_MAX_LIMIT
  ) {
    res.status(400).json({
      error: `\`historyPageSize\` must be between 1 and ${SESSION_TRANSCRIPT_MAX_LIMIT}`,
      code: 'invalid_transcript_limit',
      maxLimit: SESSION_TRANSCRIPT_MAX_LIMIT,
    });
    return null;
  }
  return value as number;
}

function parseLiveReplayMode(
  body: Record<string, unknown>,
  res: Response,
): 'full' | 'summary' | undefined | null {
  const value = body['liveReplayMode'];
  if (value === undefined) return undefined;
  if (value !== 'full' && value !== 'summary') {
    res.status(400).json({
      error: '`liveReplayMode` must be `full` or `summary`',
      code: 'invalid_live_replay_mode',
    });
    return null;
  }
  return value;
}

function workspaceTranscriptCursorExceedsLimit(
  cursor: string,
  maxBytes = WORKSPACE_TRANSCRIPT_CURSOR_MAX_BYTES,
): boolean {
  return Buffer.byteLength(cursor) > maxBytes;
}

export const workspaceTranscriptCursorExceedsLimitForTesting =
  workspaceTranscriptCursorExceedsLimit;

function serializeWorkspaceTranscriptResponse(
  result: unknown,
  sessionId: string,
  maxBytes = WORKSPACE_TRANSCRIPT_RESPONSE_MAX_BYTES,
): string {
  const serialized = JSON.stringify(result);
  const responseBytes = Buffer.byteLength(serialized);
  if (responseBytes > maxBytes) {
    throw new SessionTranscriptPageTooLargeError(
      sessionId,
      responseBytes,
      maxBytes,
    );
  }
  return serialized;
}

export const serializeWorkspaceTranscriptResponseForTesting =
  serializeWorkspaceTranscriptResponse;

function transcriptSnapshotUnavailableError(sessionId: string): Error & {
  data: { errorKind: 'transcript_snapshot_unavailable'; sessionId: string };
} {
  return Object.assign(new Error('Transcript snapshot is unavailable'), {
    data: {
      errorKind: 'transcript_snapshot_unavailable' as const,
      sessionId,
    },
  });
}

function shouldPreserveTranscriptResolutionError(err: unknown): boolean {
  return (
    err instanceof SessionArchivedError ||
    err instanceof SessionConflictError ||
    err instanceof SessionNotFoundError
  );
}

function parseOptionalApprovalMode(
  body: Record<string, unknown>,
  res: Response,
): ApprovalMode | undefined | null {
  const rawApprovalMode = body['approvalMode'];
  if (rawApprovalMode === undefined) {
    return undefined;
  }
  if (
    typeof rawApprovalMode !== 'string' ||
    !APPROVAL_MODES.includes(rawApprovalMode as ApprovalMode)
  ) {
    res.status(400).json({
      error: '`approvalMode` must be a known approval mode when provided',
      code: 'invalid_approval_mode',
      allowed: APPROVAL_MODES,
    });
    return null;
  }
  return rawApprovalMode as ApprovalMode;
}

export function registerSessionRoutes(
  app: Application,
  deps: RegisterSessionRoutesDeps,
): void {
  const {
    boundWorkspace,
    workspaceRegistry,
    archiveCoordinator,
    mutate,
    sendBridgeError,
    daemonLog,
    promptDeadlineMs,
    sessionShellCommandEnabled,
    virtualSubagentSessions,
  } = deps;
  const invalidateSessionLists = (
    runtime: WorkspaceRuntime,
    archiveStates: readonly SessionArchiveState[],
  ): void => {
    invalidateWorkspaceSessionListCache({
      runtimeBaseDir: runtime.sessionRuntimeBaseDir,
      workspaceCwd: runtime.workspaceCwd,
      archiveStates,
    });
  };
  // Combined operation for catalog mutations whose conservative
  // finally-semantics match (delete/archive/unarchive/close): invalidate the
  // persisted cache scopes, then advance the runtime bridge's catalog
  // revision. The ordering guarantees a newly exposed version never precedes
  // the invalidation. Paths with exact no-op semantics (rename, group
  // delete) gate the mark on an actual change instead of using this helper.
  const invalidateSessionListsAndMarkCatalog = (
    runtime: WorkspaceRuntime,
    archiveStates: readonly SessionArchiveState[],
  ): void => {
    invalidateSessionLists(runtime, archiveStates);
    runtime.bridge.markSessionCatalogChanged();
  };
  const runWithSessionListInvalidation = async <T>(
    runtime: WorkspaceRuntime,
    archiveStates: readonly SessionArchiveState[],
    mutation: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await mutation();
    } finally {
      invalidateSessionListsAndMarkCatalog(runtime, archiveStates);
    }
  };
  const requestedSessionIdAdmission =
    deps.requestedSessionIdAdmission ??
    createRequestedSessionIdAdmission({
      archiveCoordinator,
      getBridges: () =>
        workspaceRegistry.listManaged().map((runtime) => runtime.bridge),
      getPersistenceTargets: () =>
        workspaceRegistry.listManaged().map((runtime) => ({
          workspaceCwd: runtime.workspaceCwd,
          runtimeBaseDir: runtime.sessionRuntimeBaseDir,
        })),
      getBridgeWorkspaceId: (bridge) =>
        workspaceRegistry
          .listAllEntries()
          .find((entry) => entry.current?.runtime.bridge === bridge)
          ?.workspaceId,
    });
  const captureRuntimeGenerationAssertion = (
    runtime: WorkspaceRuntime,
  ): (() => void) | undefined => {
    const registeredGeneration = workspaceRegistry.getManagedEntryByWorkspaceId(
      runtime.workspaceId,
    )?.current;
    const guard =
      registeredGeneration?.runtime === runtime
        ? registeredGeneration.guard
        : runtime.generationGuard;
    return guard ? () => guard.assertOpen() : undefined;
  };
  const LANGUAGE_CODES = deps.languageCodes;
  const transcriptCursorMasterKey = crypto.randomBytes(32);
  const transcriptCursorCodecs = new Map<
    string,
    SessionTranscriptCursorCodec
  >();

  // Tracks workspaces with an active branch session (workspaceCwd → sessionId).
  // Prevents concurrent branch sessions that would conflict on HEAD. The
  // POST /session branch block additionally rejects branch creation while any
  // other live (client-attached) non-worktree session shares the workspace, so
  // a concurrent current-branch session is not silently moved onto the new
  // branch. A detached session is not blocked; the dirty-tree check still
  // covers the most common dirty-tree case.
  const activeBranchSessions = new Map<string, string>();
  // Workspaces with a branch creation currently in flight (reserved between
  // the conflict guard and `activeBranchSessions.set`, which only happens
  // after spawn). Closes the TOCTOU where two concurrent requests both pass
  // the guard before either populates `activeBranchSessions`.
  const inFlightBranchWorkspaces = new Set<string>();

  /** Remove the branch-session tracking entry when a session ends. */
  const clearBranchSessionEntry = (sessionId: string): void => {
    for (const [cwd, sid] of activeBranchSessions) {
      if (sid === sessionId) {
        activeBranchSessions.delete(cwd);
      }
    }
  };

  const rejectActiveLiveSessionMutation = (
    res: Response,
    sessionIds: readonly string[],
  ): boolean => {
    const activeSessionId = sessionIds.find((sessionId) =>
      deps.isLiveSessionActive?.(sessionId),
    );
    if (!activeSessionId) return false;
    res.status(409).json({
      error:
        'An active Live Voice session cannot be closed, deleted, or archived. Stop or replace the Live call first.',
      code: 'live_session_active',
      sessionId: activeSessionId,
    });
    return true;
  };

  /** Roll back a branch creation: restore the base ref and delete the branch. */
  const rollbackBranchCreation = async (
    cwd: string,
    meta: { name: string; baseBranch: string },
    baseCommit: string | undefined,
    log: typeof daemonLog,
  ): Promise<void> => {
    activeBranchSessions.delete(cwd);
    inFlightBranchWorkspaces.delete(cwd);
    // Restore the base ref first and only delete the new branch once the
    // workspace is off it: `git branch -D` refuses to delete the checked-out
    // branch, so deleting unconditionally after a failed checkout would just
    // fail and relies on that git-specific protection. An orphaned branch left
    // behind here is harmless and cleanable with `git branch -D`.
    const baseRestored = await checkoutRef(
      cwd,
      meta.baseBranch === 'HEAD' && baseCommit ? baseCommit : meta.baseBranch,
    )
      .then(() => true)
      .catch((rollbackErr) => {
        log?.warn('branch rollback checkout failed', {
          error: rollbackErr,
        });
        return false;
      });
    if (!baseRestored) return;
    await deleteBranch(cwd, meta.name).catch((rollbackErr) => {
      log?.warn('branch rollback delete failed', {
        error: rollbackErr,
      });
    });
  };

  const getTranscriptCursorCodec = (
    runtime: WorkspaceRuntime,
  ): SessionTranscriptCursorCodec => {
    const canonicalCwd = canonicalizeWorkspace(runtime.workspaceCwd);
    const cacheKey = `${runtime.workspaceId}\0${canonicalCwd}`;
    const cached = transcriptCursorCodecs.get(cacheKey);
    if (cached) return cached;
    const derivedKey = crypto.hkdfSync(
      'sha256',
      transcriptCursorMasterKey,
      Buffer.alloc(0),
      Buffer.from(cacheKey, 'utf8'),
      32,
    );
    const codec = new SessionTranscriptCursorCodec(new Uint8Array(derivedKey));
    transcriptCursorCodecs.set(cacheKey, codec);
    return codec;
  };

  const logSessionRoutingFailure = (
    route: string,
    resolutionKind: string,
    details: Record<string, unknown> = {},
  ): void => {
    daemonLog?.warn('session routing failed', {
      route,
      resolutionKind,
      ...details,
    });
  };

  const sendRequestedSessionIdAdmissionError = (
    res: Response,
    error: RequestedSessionIdAdmissionError,
    route: string,
  ): void => {
    const resolutionKind =
      error.code === 'session_workspace_conflict'
        ? 'workspace_conflict'
        : error.code;
    logSessionRoutingFailure(route, resolutionKind, {
      sessionId: error.sessionId,
      ...error.details,
    });
    const status =
      error.code === 'session_id_admission_unavailable' ? 503 : 409;
    const internalIdentities = new Set(
      workspaceRegistry
        .listAllEntries()
        .filter((entry) => entry.internal)
        .flatMap((entry) => [entry.workspaceCwd, entry.workspaceId]),
    );
    const publicDetails = Object.fromEntries(
      Object.entries(error.details).filter(
        ([, value]) =>
          typeof value !== 'string' || !internalIdentities.has(value),
      ),
    );
    res.status(status).json({
      error: error.message,
      code: error.code,
      sessionId: error.sessionId,
      ...publicDetails,
    });
  };

  const sendWorkspaceMismatch = (
    res: Response,
    requestedWorkspace: string,
  ): void => {
    const runtimes = workspaceRegistry.list();
    if (runtimes.length > 1) {
      res.status(400).json({
        error: `Workspace mismatch: daemon is bound to ${runtimes.length} workspaces; none matched the requested workspace.`,
        code: 'workspace_mismatch',
        boundWorkspace,
        workspaceCount: runtimes.length,
        requestedWorkspace,
      });
      return;
    }
    res.status(400).json({
      error: `Workspace mismatch: daemon is bound to "${boundWorkspace}"`,
      code: 'workspace_mismatch',
      boundWorkspace,
      requestedWorkspace,
    });
  };

  const resolveRuntimeForSessionCreation = (
    body: Record<string, unknown>,
    res: Response,
  ): { runtime: WorkspaceRuntime; workspaceCwd: string } | undefined => {
    const cwd = parseOptionalWorkspaceCwd(body, boundWorkspace, res);
    if (cwd === undefined) return undefined;
    const isWithinConversationRoot = (root: string, candidate: string) => {
      const relative = path.relative(root, candidate);
      return (
        relative === '' ||
        (relative !== '..' &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative))
      );
    };
    const canonicalizeIfPresent = (candidate: string): string => {
      const resolved = path.resolve(candidate);
      try {
        return fs.realpathSync.native(resolved);
      } catch {
        return resolved;
      }
    };
    const canonicalizeExistingAncestor = (candidate: string): string => {
      let ancestor = path.resolve(candidate);
      const missingTail: string[] = [];
      while (true) {
        try {
          return path.join(fs.realpathSync.native(ancestor), ...missingTail);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const parent = path.dirname(ancestor);
          if (parent === ancestor) throw error;
          missingTail.unshift(path.basename(ancestor));
          ancestor = parent;
        }
      }
    };
    const rejectReservedConversationRoot = (): undefined => {
      res.status(400).json({
        error:
          'Generic session creation is unavailable in the Conversations workspace.',
        code: 'live_session_creation_reserved',
      });
      return undefined;
    };
    if (
      'cwd' in body &&
      deps.liveConversationRootPath &&
      isWithinConversationRoot(
        path.resolve(deps.liveConversationRootPath),
        path.resolve(cwd),
      )
    ) {
      return rejectReservedConversationRoot();
    }
    let key: string;
    let reservedCheckKey: string;
    try {
      key = canonicalizeWorkspace(cwd);
      reservedCheckKey =
        'cwd' in body ? canonicalizeExistingAncestor(key) : key;
    } catch (err) {
      if (workspaceRegistry.listEntries().length > 1 && 'cwd' in body) {
        logSessionRoutingFailure('POST /session', 'workspace_mismatch', {
          requestedWorkspace: cwd,
        });
        sendWorkspaceMismatch(res, cwd);
        return undefined;
      }
      sendBridgeError(res, err, { route: 'POST /session' });
      return undefined;
    }
    const liveRoots = [
      ...workspaceRegistry
        .listAllEntries()
        .filter((entry) => entry.internal)
        .map((entry) => entry.workspaceCwd),
      ...(deps.liveConversationRootPath
        ? [
            path.resolve(deps.liveConversationRootPath),
            canonicalizeIfPresent(deps.liveConversationRootPath),
          ]
        : []),
    ];
    if (
      'cwd' in body &&
      liveRoots.some((root) => isWithinConversationRoot(root, reservedCheckKey))
    ) {
      return rejectReservedConversationRoot();
    }
    if (workspaceRegistry.listEntries().length === 1) {
      const runtime = requirePrimarySessionRuntime(workspaceRegistry, res);
      if (!runtime) return undefined;
      return {
        runtime,
        workspaceCwd: 'cwd' in body ? key : runtime.workspaceCwd,
      };
    }
    if (!('cwd' in body)) {
      const runtime = requirePrimarySessionRuntime(workspaceRegistry, res);
      return runtime
        ? { runtime, workspaceCwd: runtime.workspaceCwd }
        : undefined;
    }
    const entry = workspaceRegistry.getEntryByWorkspaceCwd(key);
    if (entry && (entry.state !== 'active' || !entry.current)) {
      sendWorkspaceRuntimeUnavailable(res, entry);
      return undefined;
    }
    const runtime = workspaceRegistry.resolveWorkspaceCwd(key);
    if (!runtime) {
      logSessionRoutingFailure('POST /session', 'workspace_mismatch', {
        requestedWorkspace: key,
      });
      sendWorkspaceMismatch(res, key);
      return undefined;
    }
    setDaemonTelemetryWorkspace(res, runtime.workspaceCwd);
    if (!runtime.primary && !runtime.trusted) {
      logSessionRoutingFailure('POST /session', 'untrusted_workspace', {
        workspaceId: runtime.workspaceId,
        workspaceCwd: runtime.workspaceCwd,
      });
      sendUntrustedWorkspaceResponse(res, {
        workspaceCwd: runtime.workspaceCwd,
        workspaceId: runtime.workspaceId,
      });
      return undefined;
    }
    return { runtime, workspaceCwd: runtime.workspaceCwd };
  };

  const resolveRuntimeFromWorkspaceParam = (
    req: Request,
    res: Response,
    paramName = 'id',
  ): WorkspaceRuntime | null => {
    const workspaceParam = req.params[paramName] ?? '';
    const byId = workspaceRegistry.getByWorkspaceId(workspaceParam);
    if (byId) return byId;
    if (!path.isAbsolute(workspaceParam)) {
      res.status(400).json({
        error: `\`:${paramName}\` must decode to a workspace id or absolute path`,
      });
      return null;
    }
    let key: string;
    try {
      key = canonicalizeWorkspace(workspaceParam);
    } catch {
      sendWorkspaceMismatch(res, workspaceParam);
      return null;
    }
    const runtime = workspaceRegistry.getByWorkspaceCwd(key);
    if (!runtime) {
      sendWorkspaceMismatch(res, key);
      return null;
    }
    return runtime;
  };

  const resolveRuntimeForCatalogRoute = (
    req: Request,
    res: Response,
    paramName: 'id' | 'workspace',
    route: string,
  ): WorkspaceRuntime | null => {
    const runtime =
      paramName === 'workspace'
        ? resolveWorkspaceRuntimeFromParam(
            workspaceRegistry,
            req,
            res,
            'workspace',
          )
        : resolveRuntimeFromWorkspaceParam(req, res, paramName);
    if (runtime === null) return null;
    if (paramName === 'workspace' && runtime.primary && !runtime.trusted) {
      logSessionRoutingFailure(route, 'untrusted_workspace', {
        workspaceId: runtime.workspaceId,
        workspaceCwd: runtime.workspaceCwd,
      });
      sendUntrustedWorkspaceResponse(res);
      return null;
    }
    return runtime;
  };

  const sendConversationRuntimeError = (
    res: Response,
    error: unknown,
  ): boolean => {
    if (!(error instanceof ConversationRuntimeOwnershipError)) return false;
    res.status(error.status).json({
      error: error.message,
      code: error.code,
      retryable: error.retryable,
    });
    return true;
  };

  const resolveLiveCatalogRuntime = async (
    req: Request,
    res: Response,
    paramName: 'id' | 'workspace',
  ): Promise<WorkspaceRuntime | null | undefined> => {
    if (
      req.query['sourceType'] !== 'default' ||
      req.query['sourceId'] !== undefined ||
      !deps.ensureConversationRuntime
    ) {
      return undefined;
    }

    const selector = req.params[paramName] ?? '';
    let entry = workspaceRegistry.getManagedEntryByWorkspaceId(selector);
    if (!entry && path.isAbsolute(selector)) {
      entry = workspaceRegistry.getManagedEntryByWorkspaceCwd(selector);
    }
    const configuredRoot = deps.liveConversationRootPath
      ? path.resolve(deps.liveConversationRootPath)
      : undefined;
    const matchesConfiguredRoot =
      configuredRoot !== undefined &&
      selector === configuredRoot &&
      path.resolve(selector) === selector;
    if ((!entry || !entry.internal) && !matchesConfiguredRoot) {
      return undefined;
    }
    if (entry?.internal && entry.state !== 'active') {
      res.status(503).json({
        error: 'The Conversations runtime is temporarily unavailable.',
        code: 'conversation_runtime_unavailable',
        retryable: true,
      });
      return null;
    }

    try {
      const runtime = await deps.ensureConversationRuntime();
      const activeEntry = workspaceRegistry.getManagedEntryByWorkspaceCwd(
        runtime.workspaceCwd,
      );
      const selectorMatchesRuntime =
        matchesConfiguredRoot ||
        selector === runtime.workspaceId ||
        selector === runtime.workspaceCwd;
      if (
        !selectorMatchesRuntime ||
        !activeEntry?.internal ||
        activeEntry.state !== 'active' ||
        activeEntry.current?.runtime !== runtime
      ) {
        return undefined;
      }
      return runtime;
    } catch (error) {
      if (sendConversationRuntimeError(res, error)) return null;
      throw error;
    }
  };

  const resolveQualifiedSessionTarget = (
    req: Request,
    res: Response,
    options: { allowUntrustedSecondary?: boolean } = {},
  ):
    | { kind: 'internal'; entry: WorkspaceEntry }
    | { kind: 'ordinary'; runtime: WorkspaceRuntime }
    | undefined => {
    const selector = req.params['workspace'] ?? '';
    const entry =
      workspaceRegistry.getManagedEntryByWorkspaceId(selector) ??
      (path.isAbsolute(selector)
        ? workspaceRegistry.getManagedEntryByWorkspaceCwd(selector)
        : undefined);
    if (entry?.internal) return { kind: 'internal', entry };
    const runtime = resolveWorkspaceRuntimeFromParam(
      workspaceRegistry,
      req,
      res,
    );
    if (!runtime) return undefined;
    if (
      !runtime.trusted &&
      (!options.allowUntrustedSecondary || runtime.primary)
    ) {
      sendUntrustedWorkspaceResponse(res, {
        workspaceCwd: runtime.workspaceCwd,
        workspaceId: runtime.workspaceId,
      });
      return undefined;
    }
    setDaemonTelemetryWorkspace(res, runtime.workspaceCwd);
    return { kind: 'ordinary', runtime };
  };

  const assertCurrentInternalGeneration = (
    entry: WorkspaceEntry,
    generation: WorkspaceRuntimeGeneration,
    res: Response,
  ): boolean => {
    if (
      entry.state !== 'active' ||
      entry.current !== generation ||
      generation.guard.closed
    ) {
      sendWorkspaceRuntimeUnavailable(res);
      return false;
    }
    generation.guard.assertOpen();
    return true;
  };

  const resolveQualifiedSessionRuntime = async (
    req: Request,
    res: Response,
    route: string,
    sessionIds: readonly string[],
    archiveState: SessionArchiveState | 'any',
  ): Promise<WorkspaceRuntime | undefined> => {
    const target = resolveQualifiedSessionTarget(req, res);
    if (!target) return undefined;
    if (target.kind === 'ordinary') return target.runtime;
    const internalEntry = target.entry;
    const generation =
      internalEntry.state === 'active' ? internalEntry.current : undefined;
    if (!generation) {
      sendWorkspaceRuntimeUnavailable(res);
      return undefined;
    }
    const runtime = generation.runtime;
    const service = createWorkspaceRuntimeSessionService(runtime);
    for (const sessionId of sessionIds) {
      const location = await service.getSessionLocation(sessionId);
      if (location === 'conflict') throw new SessionConflictError(sessionId);
      if (
        location === undefined ||
        (archiveState !== 'any' && location !== archiveState)
      ) {
        throw new SessionNotFoundError(sessionId);
      }
      const metadata = await readLoadableLiveConversationMetadata(
        sessionId,
        (candidateId) => service.readCreationMetadata(candidateId),
      );
      if (!metadata) throw new SessionNotFoundError(sessionId);
    }
    if (!assertCurrentInternalGeneration(internalEntry, generation, res)) {
      return undefined;
    }
    if (!assertTrustedSessionOwner(res, route, sessionIds[0] ?? '', runtime)) {
      return undefined;
    }
    setDaemonTelemetryWorkspace(res, runtime.workspaceCwd);
    return runtime;
  };

  const resolveLegacyPrimaryRuntimeFromParam = (
    req: Request,
    res: Response,
  ): WorkspaceRuntime | null => {
    const entry = resolveWorkspaceEntryFromParam(
      workspaceRegistry,
      req,
      res,
      'id',
    );
    if (!entry) return null;
    if (!entry.primary) {
      sendWorkspaceMismatch(res, entry.workspaceCwd);
      return null;
    }
    const runtime =
      entry.state === 'active' ? entry.current?.runtime : undefined;
    if (!runtime) {
      sendWorkspaceRuntimeUnavailable(res, entry);
      return null;
    }
    return runtime;
  };

  const hasActivePersistedSessions = async (
    runtime: WorkspaceRuntime,
    signal: AbortSignal,
  ) => {
    try {
      const page = await createWorkspaceRuntimeSessionService(
        runtime,
      ).listSessions({
        archiveState: 'active',
        size: 1,
        signal,
      });
      signal.throwIfAborted();
      return page.items.length > 0;
    } catch {
      signal.throwIfAborted();
      return false;
    }
  };

  const isNumericSessionCursor = (cursor: string): boolean => {
    const trimmed = cursor.trim();
    if (trimmed === '') return false;
    const parsed = Number(trimmed);
    return (
      Number.isFinite(parsed) &&
      parsed >= 0 &&
      parsed <= Number.MAX_SAFE_INTEGER
    );
  };

  const requireTrustedRuntimeForWorkspaceRoute = (
    req: Request,
    res: Response,
    route: string,
  ): WorkspaceRuntime | null => {
    const runtime = resolveWorkspaceRuntimeFromParam(
      workspaceRegistry,
      req,
      res,
      'workspace',
    );
    if (runtime === null) return null;
    if (!runtime.trusted) {
      logSessionRoutingFailure(route, 'untrusted_workspace', {
        workspaceId: runtime.workspaceId,
        workspaceCwd: runtime.workspaceCwd,
      });
      sendUntrustedWorkspaceResponse(res);
      return null;
    }
    return runtime;
  };

  const handleSessionExport = async (
    req: Request,
    res: Response,
    target: {
      route: string;
      runtime?: WorkspaceRuntime;
      resolveRuntime?: (
        sessionId: string,
      ) => Promise<WorkspaceRuntime | undefined>;
      workspaceQualified?: boolean;
      archiveState?: SessionArchiveState;
    },
  ): Promise<void> => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    let preResolvedRuntime = target.runtime;
    if (target.workspaceQualified && !preResolvedRuntime) {
      const qualifiedTarget = resolveQualifiedSessionTarget(req, res);
      if (!qualifiedTarget) return;
      if (qualifiedTarget.kind === 'ordinary') {
        preResolvedRuntime = qualifiedTarget.runtime;
      }
    }
    const rawFormat = req.query['format'];
    const format = parseSessionExportFormat(rawFormat);
    if (!format) {
      res.status(400).json({
        error: 'Invalid export format',
        code: 'invalid_export_format',
        format: typeof rawFormat === 'string' ? rawFormat : String(rawFormat),
        allowedFormats: sessionExportFormatValues(),
      });
      return;
    }
    try {
      const result = await archiveCoordinator.runSharedMany([sessionId], () =>
        (async () => {
          const runtime =
            preResolvedRuntime ?? (await target.resolveRuntime?.(sessionId));
          if (!runtime) return undefined;
          const assertRuntimeGenerationOpen =
            captureRuntimeGenerationAssertion(runtime);
          assertRuntimeGenerationOpen?.();
          return runWithWorkspaceRuntimeStorage(runtime, async () => {
            if (target.archiveState === 'archived') {
              await assertSessionArchived(
                runtime.workspaceCwd,
                sessionId,
                runtime.sessionRuntimeBaseDir,
              );
            } else {
              await assertSessionLoadable(
                runtime.workspaceCwd,
                sessionId,
                runtime.sessionRuntimeBaseDir,
              );
            }
            assertRuntimeGenerationOpen?.();
            return exportSessionTranscript({
              workspaceCwd: runtime.workspaceCwd,
              sessionId,
              format,
              archiveState: target.archiveState,
              config: { getChannel: () => 'daemon' },
            });
          });
        })(),
      );
      if (!result) return;
      const filename = result.filename.replace(/["\\\r\n]/g, '_');
      res
        .status(200)
        .set('Cache-Control', 'no-store')
        .set('X-Content-Type-Options', 'nosniff')
        .set('Content-Type', result.mimeType)
        .set('Content-Disposition', `attachment; filename="${filename}"`)
        .send(result.content);
    } catch (err) {
      if (target.workspaceQualified && err instanceof SessionNotFoundError) {
        res.status(404).json({
          error: err.message,
          code: 'session_not_found',
          sessionId: err.sessionId,
        });
        return;
      }
      sendBridgeError(res, err, {
        route: target.route,
        sessionId,
        ...(target.workspaceQualified
          ? { workspaceCwd: target.runtime?.workspaceCwd }
          : {}),
      });
    }
  };

  const sendAmbiguousSessionOwner = (
    res: Response,
    route: string,
    sessionId: string,
    runtimes: readonly WorkspaceRuntime[],
  ): void => {
    const workspaceIds = runtimes.map((runtime) => runtime.workspaceId);
    logSessionRoutingFailure(route, 'ambiguous', {
      sessionId,
      workspaceIds,
    });
    res.status(500).json({
      error: `Session owner is ambiguous for "${sessionId}"`,
      code: 'ambiguous_session_owner',
      sessionId,
      route,
      ...(runtimes.every((runtime) => !isInternalWorkspaceRuntime(runtime))
        ? { workspaceIds }
        : {}),
    });
  };

  const sendUntrustedSessionOwner = (
    res: Response,
    route: string,
    sessionId: string,
    runtime: WorkspaceRuntime,
  ): void => {
    logSessionRoutingFailure(route, 'untrusted_workspace', {
      sessionId,
      workspaceId: runtime.workspaceId,
      workspaceCwd: runtime.workspaceCwd,
    });
    // Reuse the shared responder so the untrusted-workspace response format and
    // message stay consistent across every session route; the route-specific
    // context is preserved via the extra fields and the logging above.
    sendUntrustedWorkspaceResponse(res, {
      sessionId,
      workspaceCwd: runtime.workspaceCwd,
      workspaceId: runtime.workspaceId,
    });
  };

  const assertTrustedSessionOwner = (
    res: Response,
    route: string,
    sessionId: string,
    runtime: WorkspaceRuntime,
  ): boolean => {
    if (runtime.primary || runtime.trusted) {
      return true;
    }
    sendUntrustedSessionOwner(res, route, sessionId, runtime);
    return false;
  };
  const sendSessionWorkspaceConflict = (
    res: Response,
    route: string,
    sessionId: string,
    runtime: Pick<
      WorkspaceRuntime,
      'workspaceCwd' | 'workspaceId' | 'provenance'
    >,
    liveRuntime: Pick<
      WorkspaceRuntime,
      'workspaceCwd' | 'workspaceId' | 'provenance'
    >,
  ): void => {
    logSessionRoutingFailure(route, 'workspace_conflict', {
      sessionId,
      workspaceId: runtime.workspaceId,
      workspaceCwd: runtime.workspaceCwd,
      liveWorkspaceId: liveRuntime.workspaceId,
      liveWorkspaceCwd: liveRuntime.workspaceCwd,
    });
    res.status(409).json({
      error: `Session "${sessionId}" is already live or restoring in another workspace runtime.`,
      code: 'session_workspace_conflict',
      sessionId,
      ...(!isInternalWorkspaceRuntime(runtime) &&
      !isInternalWorkspaceRuntime(liveRuntime)
        ? {
            workspaceId: runtime.workspaceId,
            workspaceCwd: runtime.workspaceCwd,
            liveWorkspaceId: liveRuntime.workspaceId,
            liveWorkspaceCwd: liveRuntime.workspaceCwd,
          }
        : {}),
    });
  };

  const resolveRuntimeForSessionRestore = async (
    body: Record<string, unknown>,
    res: Response,
    route: string,
    sessionId: string,
  ): Promise<
    { runtime: WorkspaceRuntime; workspaceCwd: string } | undefined
  > => {
    const cwd = parseOptionalWorkspaceCwd(body, boundWorkspace, res);
    if (cwd === undefined) return undefined;
    const configuredRoot = deps.liveConversationRootPath
      ? path.resolve(deps.liveConversationRootPath)
      : undefined;
    const bootstrappedRuntime =
      'cwd' in body &&
      configuredRoot !== undefined &&
      path.isAbsolute(cwd) &&
      path.resolve(cwd) === configuredRoot &&
      deps.ensureConversationRuntime
        ? await deps.ensureConversationRuntime()
        : undefined;
    let key: string;
    try {
      key = canonicalizeWorkspace(cwd);
    } catch (err) {
      if ('cwd' in body) {
        logSessionRoutingFailure(route, 'workspace_mismatch', {
          requestedWorkspace: cwd,
        });
        sendWorkspaceMismatch(res, cwd);
        return undefined;
      }
      sendBridgeError(res, err, { route, sessionId });
      return undefined;
    }

    const managedEntry =
      'cwd' in body
        ? workspaceRegistry.getManagedEntryByWorkspaceCwd(key)
        : undefined;
    if (
      bootstrappedRuntime &&
      (!managedEntry?.internal ||
        managedEntry.state !== 'active' ||
        managedEntry.current?.runtime !== bootstrappedRuntime)
    ) {
      sendWorkspaceRuntimeUnavailable(res);
      return undefined;
    }
    if (
      managedEntry?.internal &&
      (managedEntry.state !== 'active' || !managedEntry.current)
    ) {
      sendWorkspaceRuntimeUnavailable(res);
      return undefined;
    }
    const runtime = managedEntry?.internal
      ? managedEntry.current?.runtime
      : workspaceRegistry.resolveWorkspaceCwd('cwd' in body ? key : undefined);
    if (!runtime) {
      logSessionRoutingFailure(route, 'workspace_mismatch', {
        requestedWorkspace: key,
      });
      sendWorkspaceMismatch(res, key);
      return undefined;
    }
    if (!managedEntry?.internal) {
      setDaemonTelemetryWorkspace(res, runtime.workspaceCwd);
    }
    if (!runtime.primary && !runtime.trusted) {
      logSessionRoutingFailure(route, 'untrusted_workspace', {
        workspaceId: runtime.workspaceId,
        workspaceCwd: runtime.workspaceCwd,
      });
      sendUntrustedWorkspaceResponse(res, {
        workspaceCwd: runtime.workspaceCwd,
        workspaceId: runtime.workspaceId,
      });
      return undefined;
    }

    const liveOwner = workspaceRegistry.resolveLiveSessionOwner(sessionId);
    if (liveOwner.kind === 'unavailable') {
      sendWorkspaceRuntimeUnavailable(res);
      return undefined;
    }
    if (liveOwner.kind === 'ambiguous') {
      sendAmbiguousSessionOwner(res, route, sessionId, liveOwner.runtimes);
      return undefined;
    }
    if (
      liveOwner.kind === 'found' &&
      liveOwner.runtime.workspaceCwd !== runtime.workspaceCwd
    ) {
      sendSessionWorkspaceConflict(
        res,
        route,
        sessionId,
        runtime,
        liveOwner.runtime,
      );
      return undefined;
    }

    return { runtime, workspaceCwd: runtime.workspaceCwd };
  };

  const resolveLiveSessionRuntime = (
    sessionId: string,
    res: Response,
    route: string,
  ): WorkspaceRuntime | undefined =>
    requireSessionRuntime({
      sessionId,
      route,
      res,
      workspaceRegistry,
      daemonLog,
    });

  const sendNonPrimarySessionRouteUnsupported = (
    res: Response,
    route: RestrictedLiveSessionRoute,
    sessionId: string,
    runtime: WorkspaceRuntime,
  ): void => {
    res.status(400).json({
      error: `Route "${route}" is only available for primary workspace sessions.`,
      code: 'non_primary_session_route_not_supported',
      sessionId,
      ...(!isInternalWorkspaceRuntime(runtime)
        ? {
            workspaceId: runtime.workspaceId,
            workspaceCwd: runtime.workspaceCwd,
          }
        : {}),
      route,
    });
  };

  const withOwnerMutableSession =
    (
      route: string,
      handler: (
        req: Request,
        res: Response,
        sessionId: string,
        runtime: WorkspaceRuntime,
      ) => Promise<void> | void,
    ): RequestHandler =>
    async (req, res) => {
      const sessionId = requireSessionId(req, res);
      if (sessionId === null) return;
      try {
        const runtime = resolveLiveSessionRuntime(sessionId, res, route);
        if (!runtime) return;
        await archiveCoordinator.runSharedMany([sessionId], async () => {
          runtime.generationGuard?.assertOpen();
          await handler(req, res, sessionId, runtime);
        });
      } catch (err) {
        sendBridgeError(res, err, { route, sessionId });
      }
    };

  const withOwnerReadSession =
    (
      route: string,
      handler: (
        req: Request,
        res: Response,
        sessionId: string,
        runtime: WorkspaceRuntime,
      ) => Promise<void> | void,
    ): RequestHandler =>
    async (req, res) => {
      const sessionId = requireSessionId(req, res);
      if (sessionId === null) return;
      try {
        const runtime = resolveLiveSessionRuntime(sessionId, res, route);
        if (!runtime) return;
        await handler(req, res, sessionId, runtime);
      } catch (err) {
        sendBridgeError(res, err, { route, sessionId });
      }
    };

  const resolveTranscriptSessionRuntime = async (
    res: Response,
    route: string,
    sessionId: string,
    hasCursor: boolean,
    legacyPrimaryFallback = false,
  ): Promise<WorkspaceRuntime | undefined> => {
    const activeInRuntime = async (
      runtime: WorkspaceRuntime,
    ): Promise<boolean> => {
      const location = await assertSessionLoadable(
        runtime.workspaceCwd,
        sessionId,
        runtime.sessionRuntimeBaseDir,
      );
      if (location !== 'active') return false;
      if (!isInternalWorkspaceRuntime(runtime)) return true;
      const service = createWorkspaceRuntimeSessionService(runtime);
      return (
        (await readLoadableLiveConversationMetadata(sessionId, (candidateId) =>
          service.readCreationMetadata(candidateId),
        )) !== undefined
      );
    };
    const throwMissingActiveTranscript = (): never => {
      if (hasCursor) {
        throw transcriptSnapshotUnavailableError(sessionId);
      }
      throw new SessionNotFoundError(sessionId);
    };
    let loadError: unknown;
    const recordLoadError = (err: unknown): void => {
      if (
        loadError !== undefined &&
        shouldPreserveTranscriptResolutionError(loadError) &&
        shouldPreserveTranscriptResolutionError(err)
      ) {
        // Rare (a session id usually resolves to one workspace): two
        // workspaces each raised a structured error. We keep the later one
        // but log the superseded error so it is not lost silently.
        logSessionRoutingFailure(
          route,
          'transcript_resolution_error_superseded',
          {
            sessionId,
            supersededError:
              loadError instanceof Error ? loadError.name : String(loadError),
            newError: err instanceof Error ? err.name : String(err),
          },
        );
      }
      if (
        loadError === undefined ||
        shouldPreserveTranscriptResolutionError(err)
      ) {
        loadError = err;
      }
    };

    for (const entry of workspaceRegistry.listAllEntries()) {
      const generation = entry.current;
      if (!entry.internal || !generation) continue;
      if (!assertCurrentInternalGeneration(entry, generation, res)) {
        return undefined;
      }
      const runtime = generation.runtime;
      let active: boolean;
      try {
        active = await activeInRuntime(runtime);
      } catch (err) {
        if (!assertCurrentInternalGeneration(entry, generation, res)) {
          return undefined;
        }
        recordLoadError(err);
        continue;
      }
      if (!assertCurrentInternalGeneration(entry, generation, res)) {
        return undefined;
      }
      if (!active) continue;
      const ordinaryCollisions: WorkspaceRuntime[] = [];
      for (const ordinaryRuntime of workspaceRegistry.list()) {
        const ordinaryService =
          createWorkspaceRuntimeSessionService(ordinaryRuntime);
        if (await ordinaryService.sessionExistsInAnyState(sessionId)) {
          ordinaryCollisions.push(ordinaryRuntime);
        }
      }
      if (ordinaryCollisions.length > 0) {
        sendAmbiguousSessionOwner(res, route, sessionId, [
          runtime,
          ...ordinaryCollisions,
        ]);
        return undefined;
      }
      if (!assertTrustedSessionOwner(res, route, sessionId, runtime)) {
        return undefined;
      }
      setDaemonTelemetryWorkspace(res, runtime.workspaceCwd);
      return runtime;
    }

    if (legacyPrimaryFallback) {
      const runtime = workspaceRegistry.primary;
      if (loadError === undefined) return runtime;
      try {
        if (await activeInRuntime(runtime)) return runtime;
      } catch (err) {
        recordLoadError(err);
      }
      throw loadError;
    }

    const liveOwner = workspaceRegistry.resolveLiveSessionOwner(sessionId);
    if (liveOwner.kind === 'unavailable') {
      sendWorkspaceRuntimeUnavailable(res);
      return undefined;
    }
    if (liveOwner.kind === 'ambiguous') {
      sendAmbiguousSessionOwner(res, route, sessionId, liveOwner.runtimes);
      return undefined;
    }
    if (liveOwner.kind === 'found') {
      const internalEntry = isInternalWorkspaceRuntime(liveOwner.runtime)
        ? workspaceRegistry.getManagedEntryByWorkspaceCwd(
            liveOwner.runtime.workspaceCwd,
          )
        : undefined;
      const internalGeneration = internalEntry?.current;
      if (
        isInternalWorkspaceRuntime(liveOwner.runtime) &&
        (!internalEntry?.internal ||
          !internalGeneration ||
          internalGeneration.runtime !== liveOwner.runtime)
      ) {
        sendWorkspaceRuntimeUnavailable(res);
        return undefined;
      }
      if (
        internalEntry &&
        internalGeneration &&
        !assertCurrentInternalGeneration(internalEntry, internalGeneration, res)
      ) {
        return undefined;
      }
      if (
        !assertTrustedSessionOwner(res, route, sessionId, liveOwner.runtime)
      ) {
        return undefined;
      }
      let active = false;
      try {
        active = await activeInRuntime(liveOwner.runtime);
      } catch (err) {
        recordLoadError(err);
      }
      if (
        internalEntry &&
        internalGeneration &&
        !assertCurrentInternalGeneration(internalEntry, internalGeneration, res)
      ) {
        return undefined;
      }
      if (active) {
        setDaemonTelemetryWorkspace(res, liveOwner.runtime.workspaceCwd);
        return liveOwner.runtime;
      }
      if (loadError !== undefined) throw loadError;
      return throwMissingActiveTranscript();
    }

    if (workspaceRegistry.listEntries().length === 1) {
      const runtime = requirePrimarySessionRuntime(workspaceRegistry, res);
      if (!runtime) return undefined;
      try {
        if (await activeInRuntime(runtime)) {
          return runtime;
        }
      } catch (err) {
        recordLoadError(err);
      }
      if (loadError !== undefined) throw loadError;
      return throwMissingActiveTranscript();
    }

    const activeRuntimes: WorkspaceRuntime[] = [];
    for (const runtime of workspaceRegistry.list()) {
      try {
        if (await activeInRuntime(runtime)) {
          activeRuntimes.push(runtime);
        }
      } catch (err) {
        recordLoadError(err);
      }
    }
    if (activeRuntimes.length === 1) {
      const runtime = activeRuntimes[0]!;
      setDaemonTelemetryWorkspace(res, runtime.workspaceCwd);
      if (!assertTrustedSessionOwner(res, route, sessionId, runtime)) {
        return undefined;
      }
      return runtime;
    }
    if (activeRuntimes.length > 1) {
      sendAmbiguousSessionOwner(res, route, sessionId, activeRuntimes);
      return undefined;
    }
    if (loadError !== undefined) {
      if (shouldPreserveTranscriptResolutionError(loadError)) {
        throw loadError;
      }
      const runtimes = workspaceRegistry.list();
      const firstError =
        loadError instanceof Error ? loadError.message : String(loadError);
      daemonLog?.warn('transcript session resolution failed', {
        route,
        sessionId,
        workspaceCount: runtimes.length,
        error: firstError,
      });
      throw new Error(
        `Transcript session resolution failed across ${runtimes.length} workspace(s)`,
      );
    }
    return throwMissingActiveTranscript();
  };

  const resolveSessionAnyStateRuntime = async (
    res: Response,
    route: string,
    sessionId: string,
  ): Promise<WorkspaceRuntime | undefined> => {
    const owner = workspaceRegistry.resolveLiveSessionOwner(sessionId);
    if (owner.kind === 'unavailable') {
      sendWorkspaceRuntimeUnavailable(res);
      return undefined;
    }
    if (owner.kind === 'ambiguous') {
      sendAmbiguousSessionOwner(res, route, sessionId, owner.runtimes);
      return undefined;
    }
    const matches = new Set<WorkspaceRuntime>();
    if (owner.kind === 'found') matches.add(owner.runtime);
    for (const entry of workspaceRegistry.listAllEntries()) {
      const generation = entry.current;
      if (!entry.internal || !generation) continue;
      if (!assertCurrentInternalGeneration(entry, generation, res)) {
        return undefined;
      }
      const runtime = generation.runtime;
      const service = createWorkspaceRuntimeSessionService(runtime);
      const exists = await service.sessionExistsInAnyState(sessionId);
      if (!assertCurrentInternalGeneration(entry, generation, res)) {
        return undefined;
      }
      if (!exists) continue;
      const metadata = await readLoadableLiveConversationMetadata(
        sessionId,
        (candidateId) => service.readCreationMetadata(candidateId),
      );
      if (!assertCurrentInternalGeneration(entry, generation, res)) {
        return undefined;
      }
      if (metadata === undefined) continue;
      matches.add(runtime);
    }
    if (owner.kind !== 'found' || isInternalWorkspaceRuntime(owner.runtime)) {
      for (const runtime of workspaceRegistry.list()) {
        const service = createWorkspaceRuntimeSessionService(runtime);
        if (await service.sessionExistsInAnyState(sessionId)) {
          matches.add(runtime);
        }
      }
    }
    if (matches.size > 1) {
      sendAmbiguousSessionOwner(res, route, sessionId, [...matches]);
      return undefined;
    }
    const runtime = [...matches][0];
    if (!runtime) {
      res.status(404).json({
        error: `No session with id "${sessionId}"`,
        code: 'session_not_found',
        sessionId,
      });
      return undefined;
    }
    if (!assertTrustedSessionOwner(res, route, sessionId, runtime)) {
      return undefined;
    }
    setDaemonTelemetryWorkspace(res, runtime.workspaceCwd);
    return runtime;
  };

  const resolveSessionBatchRuntime = async (
    req: Request | undefined,
    res: Response,
    route: string,
    sessionIds: readonly string[],
  ): Promise<WorkspaceRuntime | undefined> => {
    if (req) {
      return resolveQualifiedSessionRuntime(req, res, route, sessionIds, 'any');
    }

    let internalRuntime: WorkspaceRuntime | undefined;
    let hasInternalSession = false;
    const hasOrdinarySession = async (sessionId: string): Promise<boolean> => {
      for (const runtime of workspaceRegistry.list()) {
        if (
          await createWorkspaceRuntimeSessionService(
            runtime,
          ).sessionExistsInAnyState(sessionId)
        ) {
          return true;
        }
      }
      return false;
    };
    const sendBatchWorkspaceConflict = (): void => {
      res.status(409).json({
        error: 'All sessions in this operation must share one workspace.',
        code: 'session_workspace_conflict',
      });
    };
    for (const sessionId of sessionIds) {
      const candidates = new Set<WorkspaceRuntime>();
      const owner = workspaceRegistry.resolveLiveSessionOwner(sessionId);
      if (owner.kind === 'unavailable') {
        sendWorkspaceRuntimeUnavailable(res);
        return undefined;
      }
      if (owner.kind === 'found' && isInternalWorkspaceRuntime(owner.runtime)) {
        candidates.add(owner.runtime);
      }
      if (owner.kind === 'ambiguous') {
        for (const runtime of owner.runtimes) {
          if (isInternalWorkspaceRuntime(runtime)) candidates.add(runtime);
        }
      }
      for (const entry of workspaceRegistry.listAllEntries()) {
        const generation = entry.current;
        if (!entry.internal || !generation) continue;
        if (!assertCurrentInternalGeneration(entry, generation, res)) {
          return undefined;
        }
        const runtime = generation.runtime;
        const service = createWorkspaceRuntimeSessionService(runtime);
        const exists = await service.sessionExistsInAnyState(sessionId);
        if (!assertCurrentInternalGeneration(entry, generation, res)) {
          return undefined;
        }
        if (!exists) continue;
        const metadata = await readLoadableLiveConversationMetadata(
          sessionId,
          (candidateId) => service.readCreationMetadata(candidateId),
        );
        if (!assertCurrentInternalGeneration(entry, generation, res)) {
          return undefined;
        }
        if (!metadata) continue;
        candidates.add(runtime);
      }
      if (candidates.size > 0) {
        for (const runtime of workspaceRegistry.list()) {
          const service = createWorkspaceRuntimeSessionService(runtime);
          if (await service.sessionExistsInAnyState(sessionId)) {
            candidates.add(runtime);
          }
        }
      }
      if (candidates.size === 0) {
        if (hasInternalSession) {
          if (await hasOrdinarySession(sessionId)) {
            sendBatchWorkspaceConflict();
            return undefined;
          }
          throw new SessionNotFoundError(sessionId);
        }
        continue;
      }
      if (candidates.size !== 1) {
        sendAmbiguousSessionOwner(res, route, sessionId, [...candidates]);
        return undefined;
      }
      const candidate = [...candidates][0]!;
      if (internalRuntime && internalRuntime !== candidate) {
        sendBatchWorkspaceConflict();
        return undefined;
      }
      internalRuntime = candidate;
      hasInternalSession = true;
    }
    if (!internalRuntime) {
      const runtime = workspaceRegistry.primary;
      setDaemonTelemetryWorkspace(res, runtime.workspaceCwd);
      return runtime;
    }

    for (const sessionId of sessionIds) {
      const service = createWorkspaceRuntimeSessionService(internalRuntime);
      if (!(await service.sessionExistsInAnyState(sessionId))) {
        if (await hasOrdinarySession(sessionId)) {
          sendBatchWorkspaceConflict();
          return undefined;
        }
        throw new SessionNotFoundError(sessionId);
      }
      const metadata = await readLoadableLiveConversationMetadata(
        sessionId,
        (candidateId) => service.readCreationMetadata(candidateId),
      );
      if (!metadata) {
        throw new SessionNotFoundError(sessionId);
      }
    }
    const internalEntry = workspaceRegistry.getManagedEntryByWorkspaceCwd(
      internalRuntime.workspaceCwd,
    );
    const generation = internalEntry?.current;
    if (
      !internalEntry?.internal ||
      !generation ||
      generation.runtime !== internalRuntime ||
      !assertCurrentInternalGeneration(internalEntry, generation, res)
    ) {
      if (!res.headersSent) sendWorkspaceRuntimeUnavailable(res);
      return undefined;
    }
    if (
      !assertTrustedSessionOwner(
        res,
        route,
        sessionIds[0] ?? '',
        internalRuntime,
      )
    ) {
      return undefined;
    }
    setDaemonTelemetryWorkspace(res, internalRuntime.workspaceCwd);
    return internalRuntime;
  };

  const parseSessionIdsBody = (
    req: Request,
    res: Response,
  ): string[] | undefined => {
    const body = safeBody(req);
    const sessionIds: unknown = body['sessionIds'];
    if (
      !Array.isArray(sessionIds) ||
      sessionIds.length === 0 ||
      sessionIds.length > 100 ||
      !sessionIds.every((id) => typeof id === 'string')
    ) {
      res.status(400).json({
        error: '`sessionIds` must be a non-empty string array (max 100)',
        code: 'invalid_request',
      });
      return undefined;
    }
    return [...new Set(sessionIds as string[])];
  };

  const serializeSessionErrors = (
    errors: Array<{ sessionId: string; error: unknown }>,
    redactDetails = false,
  ): Array<{ sessionId: string; error: string }> =>
    errors.map((e) => ({
      sessionId: e.sessionId,
      error: redactDetails
        ? 'Session operation failed.'
        : e.error instanceof Error
          ? e.error.message
          : String(e.error),
    }));

  const runResolvedSessionBatch = async <T>(params: {
    req: Request | undefined;
    res: Response;
    route: string;
    sessionIds: string[];
    run: (
      runtime: WorkspaceRuntime,
      coordinatorLockHeld: boolean,
    ) => Promise<T>;
  }): Promise<{ result: T; internal: boolean } | undefined> => {
    const { req, res, route, sessionIds, run } = params;
    const runtime = await resolveSessionBatchRuntime(
      req,
      res,
      route,
      sessionIds,
    );
    if (!runtime) return undefined;
    if (!isInternalWorkspaceRuntime(runtime)) {
      return { result: await run(runtime, false), internal: false };
    }
    return archiveCoordinator.runExclusiveMany(sessionIds, async () => {
      const verifiedRuntime = await resolveSessionBatchRuntime(
        req,
        res,
        route,
        sessionIds,
      );
      if (!verifiedRuntime) return undefined;
      if (verifiedRuntime !== runtime) {
        sendWorkspaceRuntimeUnavailable(res);
        return undefined;
      }
      return { result: await run(verifiedRuntime, true), internal: true };
    });
  };

  const deleteSessions = (
    req: Request | undefined,
    res: Response,
    route: string,
    sessionIds: string[],
  ) => {
    const run = async (
      runtime: WorkspaceRuntime,
      coordinatorLockHeld: boolean,
    ) => {
      captureRuntimeGenerationAssertion(runtime)?.();
      const service = createWorkspaceRuntimeSessionService(runtime);
      return runWithSessionListInvalidation(
        runtime,
        ['active', 'archived'],
        () =>
          runWithWorkspaceRuntimeStorage(runtime, () =>
            deleteDaemonSessions({
              sessionIds,
              service,
              bridge: runtime.bridge,
              coordinator: archiveCoordinator,
              coordinatorLockHeld,
              onError: ({ phase, sessionId, error }) => {
                writeStderrLine(
                  `qwen serve: ${phase}Session failed for ${safeLogValue(sessionId)}: ${safeLogValue(error)}`,
                );
              },
            }),
          ),
      );
    };
    return runResolvedSessionBatch({ req, res, route, sessionIds, run });
  };

  const archiveSessions = (
    req: Request | undefined,
    res: Response,
    route: string,
    sessionIds: string[],
  ) => {
    const run = async (
      runtime: WorkspaceRuntime,
      coordinatorLockHeld: boolean,
    ) => {
      captureRuntimeGenerationAssertion(runtime)?.();
      const service = createWorkspaceRuntimeSessionService(runtime, {
        onWarning: logSessionArchiveWarning,
      });
      return runWithSessionListInvalidation(
        runtime,
        ['active', 'archived'],
        () =>
          runWithWorkspaceRuntimeStorage(runtime, () =>
            archiveDaemonSessions({
              sessionIds,
              service,
              bridge: runtime.bridge,
              coordinator: archiveCoordinator,
              coordinatorLockHeld,
            }),
          ),
      );
    };
    return runResolvedSessionBatch({ req, res, route, sessionIds, run });
  };

  const unarchiveSessions = (
    req: Request | undefined,
    res: Response,
    route: string,
    sessionIds: string[],
  ) => {
    const run = async (
      runtime: WorkspaceRuntime,
      coordinatorLockHeld: boolean,
    ) => {
      captureRuntimeGenerationAssertion(runtime)?.();
      const service = createWorkspaceRuntimeSessionService(runtime, {
        onWarning: logSessionArchiveWarning,
      });
      return runWithSessionListInvalidation(
        runtime,
        ['active', 'archived'],
        () =>
          runWithWorkspaceRuntimeStorage(runtime, () =>
            unarchiveDaemonSessions({
              sessionIds,
              service,
              coordinator: archiveCoordinator,
              coordinatorLockHeld,
            }),
          ),
      );
    };
    return runResolvedSessionBatch({ req, res, route, sessionIds, run });
  };

  const withRestrictedMutableSession = (
    route: string,
    handler: (
      req: Request,
      res: Response,
      sessionId: string,
      runtime: WorkspaceRuntime,
    ) => Promise<void> | void,
  ): RequestHandler => {
    const primaryOnly = isPrimaryOnlyLiveSessionRoute(route);
    if (!primaryOnly && !isPrimaryOrInternalLiveSessionRoute(route)) {
      throw new Error(`Unregistered restricted session route: ${route}`);
    }
    return async (req, res) => {
      const sessionId = requireSessionId(req, res);
      if (sessionId === null) return;
      const runtime = resolveLiveSessionRuntime(sessionId, res, route);
      if (!runtime) return;
      if (
        !runtime.primary &&
        (primaryOnly || !isInternalWorkspaceRuntime(runtime))
      ) {
        logSessionRoutingFailure(
          route,
          'non_primary_session_route_not_supported',
          {
            sessionId,
            workspaceId: runtime.workspaceId,
            workspaceCwd: runtime.workspaceCwd,
          },
        );
        sendNonPrimarySessionRouteUnsupported(res, route, sessionId, runtime);
        return;
      }
      try {
        await archiveCoordinator.runSharedMany([sessionId], async () => {
          runtime.generationGuard?.assertOpen();
          await handler(req, res, sessionId, runtime);
        });
      } catch (err) {
        sendBridgeError(res, err, { route, sessionId });
      }
    };
  };

  app.post('/session', mutate(), async (req, res) => {
    const body = safeBody(req);
    const resolvedRuntime = resolveRuntimeForSessionCreation(body, res);
    if (resolvedRuntime === undefined) return;
    const { runtime, workspaceCwd } = resolvedRuntime;
    if (runtime.provenance === 'live-conversation') {
      res.status(400).json({
        error:
          'Sessions in the Conversations workspace can only be created by Live Voice.',
        code: 'live_session_creation_reserved',
      });
      return;
    }
    const assertRuntimeGenerationOpen =
      captureRuntimeGenerationAssertion(runtime);
    const modelServiceId =
      typeof body['modelServiceId'] === 'string'
        ? (body['modelServiceId'] as string)
        : undefined;
    // Per-request `sessionScope` override. Validate at the route
    // boundary so a 400 surfaces before touching the bridge.
    const rawSessionScope = body['sessionScope'];
    let sessionScope: 'single' | 'thread' | undefined;
    if (rawSessionScope !== undefined) {
      if (rawSessionScope !== 'single' && rawSessionScope !== 'thread') {
        res.status(400).json({
          error: '`sessionScope` must be "single" or "thread" when provided',
          code: 'invalid_session_scope',
        });
        return;
      }
      sessionScope = rawSessionScope;
    }
    const approvalMode = parseOptionalApprovalMode(body, res);
    if (approvalMode === null) return;
    const source = parseSessionSource(body['sourceType'], body['sourceId']);
    if ('error' in source) {
      res.status(400).json({
        error: source.error,
        code: 'invalid_session_source',
      });
      return;
    }
    if (isReservedLiveSessionSource(source)) {
      res.status(400).json({
        error:
          'The requested session source is reserved for daemon-owned Live Voice sessions.',
        code: 'reserved_session_source',
      });
      return;
    }
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;

    const parsedSessionId = parseCallerSuppliedSessionId(body['sessionId']);
    if (parsedSessionId.kind === 'invalid') {
      res.status(400).json({
        error:
          '`sessionId` must be an RFC UUID v1-v5 (e.g. "550e8400-e29b-41d4-a716-446655440000")',
        code: 'invalid_session_id',
      });
      return;
    }
    const requestedSessionId =
      parsedSessionId.kind === 'valid' ? parsedSessionId.sessionId : undefined;
    let sessionIdReservation: RequestedSessionIdReservation | undefined;
    if (requestedSessionId !== undefined) {
      try {
        sessionIdReservation = await requestedSessionIdAdmission.reserveCreate(
          requestedSessionId,
          {
            bridge: runtime.bridge,
            workspaceCwd,
            workspaceId: runtime.workspaceId,
          },
        );
      } catch (error) {
        if (error instanceof RequestedSessionIdAdmissionError) {
          sendRequestedSessionIdAdmissionError(res, error, 'POST /session');
          return;
        }
        throw error;
      }
    }

    let branchMeta: { name: string; baseBranch: string } | undefined;
    let branchBaseCommit: string | undefined;
    let worktreeMeta:
      | { slug: string; path: string; branch: string }
      | undefined;

    try {
      // ── Branch creation ────────────────────────────────────────────
      // When `branch` is present, create and checkout a new git branch
      // before spawning. The session runs in the same working directory
      // but on the new branch. Mutually exclusive with `worktree`.
      // Caller-supplied IDs perform an asynchronous persistence scan before
      // this block. Re-check the captured runtime before any branch, worktree,
      // or bridge side effect in case its generation changed during the scan.
      assertRuntimeGenerationOpen?.();
      const rawBranch = body['branch'];
      if (rawBranch !== undefined && rawBranch !== null) {
        if (body['worktree'] !== undefined && body['worktree'] !== null) {
          res.status(400).json({
            error: '`branch` and `worktree` are mutually exclusive',
            code: 'branch_and_worktree_conflict',
          });
          return;
        }
        if (typeof rawBranch !== 'object' || Array.isArray(rawBranch)) {
          res.status(400).json({
            error:
              '`branch` must be an object (e.g. `{"name":"feat/my-feature"}`)',
            code: 'invalid_branch',
          });
          return;
        }
        const branchReq = rawBranch as Record<string, unknown>;
        const branchName = branchReq['name'];
        if (typeof branchName !== 'string' || branchName.length === 0) {
          res.status(400).json({
            error: '`branch.name` must be a non-empty string',
            code: 'branch_invalid_name',
          });
          return;
        }
        // Validate git branch name characters and reserved names.
        // Mirrors validateBranchName in GitModePopover.tsx; keep in sync.
        if (
          /[^\p{L}\p{N}._/-]/u.test(branchName) ||
          branchName.includes('..') ||
          branchName.includes('//') ||
          branchName.startsWith('.') ||
          branchName.startsWith('-') ||
          branchName.startsWith('/') ||
          branchName.endsWith('/') ||
          branchName.endsWith('.') ||
          branchName.endsWith('.git') ||
          branchName.includes('@{') ||
          branchName
            .split('/')
            .some((c) => c.startsWith('.') || c.endsWith('.lock')) ||
          branchName.toUpperCase() === GIT_RESERVED_BRANCH ||
          Buffer.byteLength(branchName, 'utf8') > MAX_BRANCH_NAME_BYTES ||
          branchName
            .split('/')
            .some(
              (c) => Buffer.byteLength(c, 'utf8') > MAX_BRANCH_COMPONENT_BYTES,
            )
        ) {
          res.status(400).json({
            error: `Invalid branch name: ${branchName}`,
            code: 'branch_invalid_name',
          });
          return;
        }
        // Reject when another branch session is already active for this
        // workspace — concurrent branch sessions conflict on HEAD. Runs after
        // shape/name validation so a malformed body gets 400, not 409.
        const existingBranchSession = activeBranchSessions.get(workspaceCwd);
        if (existingBranchSession) {
          try {
            // Throws if the session is gone, letting us clean up the stale entry.
            runtime.bridge.getSessionSummary(existingBranchSession);
            res.status(409).json({
              error: 'A branch session is already active for this workspace',
              code: 'branch_session_conflict',
              existingSessionId: existingBranchSession,
            });
            return;
          } catch {
            activeBranchSessions.delete(workspaceCwd);
          }
        }
        // Reject when any other live (client-attached) non-worktree session
        // already runs in this workspace. `git checkout -b` moves the shared
        // HEAD, so a concurrent current-branch session with a clean tree would
        // be silently relocated onto the new branch and commit to the wrong
        // ref. Worktree sessions are exempt (they run in their own cwd). Scoped
        // to sessions with an attached client so a detached session left behind
        // by a "new chat" does not block a fresh branch session.
        const sharedCheckoutSession = runtime.bridge
          .listWorkspaceSessions(workspaceCwd)
          .find((session) => !session.worktree && session.clientCount > 0);
        if (sharedCheckoutSession) {
          res.status(409).json({
            error:
              'Another session is already active in this workspace; creating a branch would move its shared checkout',
            code: 'branch_session_conflict',
            existingSessionId: sharedCheckoutSession.sessionId,
          });
          return;
        }
        let wtService: GitWorktreeService;
        try {
          wtService = new GitWorktreeService(workspaceCwd);
        } catch {
          res.status(500).json({
            error: 'Failed to initialize git service',
            code: 'branch_init_failed',
          });
          return;
        }
        if (!(await wtService.isGitRepository())) {
          res.status(400).json({
            error: 'Branch creation requires a git repository',
            code: 'branch_not_git_repo',
          });
          return;
        }
        // Check the branch doesn't already exist.
        if (await branchExists(workspaceCwd, branchName)) {
          res.status(409).json({
            error: `Branch "${branchName}" already exists`,
            code: 'branch_already_exists',
          });
          return;
        }
        // Gate on a dirty tree as surprise-prevention: `git checkout -b` carries
        // uncommitted tracked changes onto the new branch, which would silently
        // mix the user's WIP with a fresh branch. Untracked files are excluded
        // (`--untracked-files=no`) because they survive any checkout unchanged.
        let dirty: boolean;
        try {
          dirty = await isDirtyTree(workspaceCwd);
        } catch {
          res.status(500).json({
            error: 'Failed to check working tree status',
            code: 'branch_status_failed',
          });
          return;
        }
        if (dirty) {
          res.status(409).json({
            error: 'Uncommitted changes detected. Commit or stash first.',
            code: 'branch_dirty_tree',
          });
          return;
        }
        const baseCommit = await getHeadCommit(workspaceCwd);
        const baseBranch = await wtService
          .getCurrentBranch()
          .catch(() => 'HEAD');
        // Reserve the workspace before mutating HEAD. The conflict guard above
        // runs before several awaits (rev-parse, status, checkout), so two
        // concurrent `POST /session { branch }` can both pass it and race on
        // `git checkout -b`. This synchronous check-and-add (no await between)
        // serializes the checkout; every exit path below clears the reservation
        // (transferred to `activeBranchSessions` on success). Re-check
        // `activeBranchSessions` here too: a request that passed the early guard
        // before a concurrent request registered can still be in flight while
        // the first request has already completed and populated the map.
        if (
          inFlightBranchWorkspaces.has(workspaceCwd) ||
          activeBranchSessions.has(workspaceCwd)
        ) {
          res.status(409).json({
            error:
              'A branch session is already being created for this workspace',
            code: 'branch_session_conflict',
          });
          return;
        }
        assertRuntimeGenerationOpen?.();
        inFlightBranchWorkspaces.add(workspaceCwd);
        try {
          await createBranch(workspaceCwd, branchName);
        } catch (checkoutErr) {
          // `git checkout -b` can reject AFTER git already created the ref and
          // moved HEAD — a failing post-checkout hook or a timeout past the ref
          // update both leave the workspace on the new branch while the command
          // exits nonzero. Roll back transactionally (restore the base ref, then
          // delete the partial branch) so the shared workspace is never silently
          // left on the new branch; when nothing was created the rollback is a
          // harmless no-op. Log the full git error but return a generic detail —
          // git stderr can embed the absolute workspace path, which must not
          // reach the caller in the 500 body.
          daemonLog?.warn('branch checkout failed', {
            error:
              checkoutErr instanceof Error
                ? checkoutErr.message
                : String(checkoutErr),
          });
          await rollbackBranchCreation(
            workspaceCwd,
            { name: branchName, baseBranch },
            baseCommit,
            daemonLog,
          );
          res.status(500).json({
            error: 'Failed to create branch',
            code: 'branch_checkout_failed',
          });
          return;
        }
        branchMeta = { name: branchName, baseBranch };
        branchBaseCommit = baseCommit;
        sessionScope = 'thread';
      }

      // ── Worktree isolation ──────────────────────────────────────────
      // When `worktree` is present, create a git worktree before spawning
      // and relocate the session into it immediately after. The workspace
      // runtime resolution still uses the main workspace cwd; only the
      // child process's effective working directory changes.
      const rawWorktree = body['worktree'];
      if (rawWorktree !== undefined && rawWorktree !== null) {
        if (typeof rawWorktree !== 'object' || Array.isArray(rawWorktree)) {
          res.status(400).json({
            error:
              '`worktree` must be an object (e.g. `{}` or `{"slug":"my-task"}`)',
            code: 'invalid_worktree',
          });
          return;
        }
        const wtReq = rawWorktree as Record<string, unknown>;
        let wtService: GitWorktreeService;
        try {
          wtService = new GitWorktreeService(workspaceCwd);
        } catch {
          res.status(500).json({
            error: 'Failed to initialize worktree service',
            code: 'worktree_init_failed',
          });
          return;
        }
        if (!(await wtService.isGitRepository())) {
          res.status(400).json({
            error: 'Worktree isolation requires a git repository',
            code: 'worktree_not_git_repo',
          });
          return;
        }
        const rawSlug = wtReq['slug'];
        let slug: string;
        if (rawSlug === undefined || rawSlug === null) {
          slug = GitWorktreeService.generateAutoSlug();
        } else if (typeof rawSlug !== 'string' || rawSlug.length === 0) {
          res.status(400).json({
            error: '`worktree.slug` must be a non-empty string when provided',
            code: 'worktree_invalid_slug',
          });
          return;
        } else {
          slug = rawSlug;
        }
        const slugError = GitWorktreeService.validateUserWorktreeSlug(slug);
        if (slugError) {
          res
            .status(400)
            .json({ error: slugError, code: 'worktree_invalid_slug' });
          return;
        }
        const baseBranch = await wtService
          .getCurrentBranch()
          .catch(() => undefined);
        assertRuntimeGenerationOpen?.();
        const wtResult = await wtService.createUserWorktree(slug, baseBranch);
        if (!wtResult.success || !wtResult.worktree) {
          res.status(500).json({
            error: wtResult.error ?? 'Failed to create worktree',
            code: 'worktree_create_failed',
          });
          return;
        }
        worktreeMeta = {
          slug,
          path: wtResult.worktree.path,
          branch: wtResult.worktree.branch,
        };
        // Worktree sessions must be independent — never coalesce onto an
        // existing single-scope session that lives in the main checkout.
        sessionScope = 'thread';
      }
      // A caller-supplied sessionId implies a new, distinct session —
      // never coalesce onto an existing single-scope session.
      if (requestedSessionId !== undefined) {
        sessionScope = 'thread';
      }

      assertRuntimeGenerationOpen?.();
      const session = await runtime.bridge.spawnOrAttach({
        workspaceCwd,
        modelServiceId,
        ...(clientId !== undefined ? { clientId } : {}),
        ...(sessionScope !== undefined ? { sessionScope } : {}),
        ...(approvalMode !== undefined ? { approvalMode } : {}),
        ...(source.sourceType !== undefined
          ? { sourceType: source.sourceType }
          : {}),
        ...(source.sourceId !== undefined ? { sourceId: source.sourceId } : {}),
        ...(worktreeMeta ? { worktree: worktreeMeta } : {}),
        ...(branchMeta ? { branch: branchMeta } : {}),
        ...(requestedSessionId !== undefined
          ? { sessionId: requestedSessionId }
          : {}),
      });
      // Defensive: the bridge/agent must honor a caller-supplied id. If it was
      // dropped anywhere in the chain (older agent binary, coalesced attach),
      // never return a surprise id — fail the request instead.
      if (
        requestedSessionId !== undefined &&
        session.sessionId !== requestedSessionId
      ) {
        if (daemonLog) {
          daemonLog.warn('session id not honored by agent', {
            requested: requestedSessionId,
            actual: session.sessionId,
          });
        }
        if (!session.attached) {
          await runWithWorkspaceRuntimeStorage(runtime, () =>
            deleteDaemonSessionIfOrphan({
              sessionId: session.sessionId,
              service: createWorkspaceRuntimeSessionService(runtime),
              bridge: runtime.bridge,
              coordinator: archiveCoordinator,
            }),
          ).catch(() => false);
        } else {
          await runtime.bridge
            .detachClient(session.sessionId, session.clientId)
            .catch(() => {});
        }
        // This early return runs inside the outer try, but a return skips
        // that try's catch — so replicate the catch's resource cleanup here.
        // Otherwise the branch/worktree created for this request is orphaned
        // and inFlightBranchWorkspaces permanently blocks the workspace.
        if (worktreeMeta) {
          await new GitWorktreeService(workspaceCwd)
            .removeUserWorktree(worktreeMeta.slug, { deleteBranch: true })
            .catch(() => {});
        }
        if (branchMeta) {
          await rollbackBranchCreation(
            workspaceCwd,
            branchMeta,
            branchBaseCommit,
            daemonLog,
          );
        }
        res.status(500).json({
          error: 'Agent did not honor the requested session id',
          code: 'session_id_not_honored',
        });
        return;
      }
      try {
        assertRuntimeGenerationOpen?.();
      } catch (error) {
        if (!session.attached) {
          try {
            const removed = await runWithWorkspaceRuntimeStorage(runtime, () =>
              deleteDaemonSessionIfOrphan({
                sessionId: session.sessionId,
                service: createWorkspaceRuntimeSessionService(runtime),
                bridge: runtime.bridge,
                coordinator: archiveCoordinator,
              }),
            );
            if (removed) {
              if (worktreeMeta) {
                await new GitWorktreeService(workspaceCwd)
                  .removeUserWorktree(worktreeMeta.slug, { deleteBranch: true })
                  .catch(() => {});
              }
            }
          } catch {
            // Runtime disposal remains responsible for final containment.
          }
        } else {
          await runtime.bridge
            .detachClient(session.sessionId, session.clientId)
            .catch(() => {});
        }
        throw error;
      }
      // Client may have disconnected during the 1–3s spawn window. If
      // so, the response can't be delivered. The session is otherwise
      // orphaned (in `byId` / `defaultEntry` with no client knowing the
      // id), and under churn this leaks one child per aborted request.
      //
      // Detect "can we still write the response?" via `res.writable`,
      // which stays true until the SOCKET destination side closes
      // (the right signal for our case). The legacy `req.aborted`
      // only flips while the request body is still being received,
      // so a client that completed the POST and then closed during
      // the spawn would slip past it. `req.destroyed` is too eager
      // — clients (incl. supertest) close their writable end after
      // sending the body even though they're still listening for the
      // response. `res.writable` is the documented signal for
      // "ServerResponse can still send to client".
      //
      // Combined with `!session.attached` we only reap when WE spawned
      // a fresh child for this request — if another client legitimately
      // attached, killing it would tear out their work mid-flight.
      // The disconnect-without-reap branch also needs to skip
      // `res.json` — writing to a closed socket would throw EPIPE
      // through Express's default error handler.
      if (daemonLog) {
        daemonLog.info(
          session.attached ? 'session attached' : 'session spawned',
          { sessionId: session.sessionId, clientId: session.clientId },
        );
      }
      if (!res.writable) {
        if (daemonLog) {
          daemonLog.warn(
            'session reaped (client disconnected before response)',
            {
              sessionId: session.sessionId,
              attached: session.attached,
            },
          );
        }
        if (!session.attached) {
          // `requireZeroAttaches: true` closes a race: if
          // a second client called `spawnOrAttach` for the same
          // workspace between our `await` resolving and this reap
          // dispatching, the bridge will see `attachCount > 0` and
          // skip the kill. Without the flag, that second client's
          // session would die mid-prompt.
          try {
            const removed = await runWithWorkspaceRuntimeStorage(runtime, () =>
              deleteDaemonSessionIfOrphan({
                sessionId: session.sessionId,
                service: createWorkspaceRuntimeSessionService(runtime),
                bridge: runtime.bridge,
                coordinator: archiveCoordinator,
              }),
            );
            if (removed) {
              // Clean up the worktree if one was created for this session.
              if (worktreeMeta) {
                await new GitWorktreeService(workspaceCwd)
                  .removeUserWorktree(worktreeMeta.slug, { deleteBranch: true })
                  .catch(() => {});
              }
              // Roll back the branch if one was created for this session.
              if (branchMeta) {
                await rollbackBranchCreation(
                  workspaceCwd,
                  branchMeta,
                  branchBaseCommit,
                  daemonLog,
                );
              }
            } else if (branchMeta) {
              // Another client attached before we could reap — the session
              // is alive. Transfer the in-flight reservation to the active
              // map so the workspace is tracked, not permanently blocked.
              activeBranchSessions.set(workspaceCwd, session.sessionId);
              inFlightBranchWorkspaces.delete(workspaceCwd);
            }
          } catch {
            // Best-effort cleanup; channel.exited will eventually reap the
            // session, but it has no awareness of this route-local in-flight
            // reservation. Pessimistically track the session so the workspace
            // stays blocked until the stale-entry detection self-heals.
            if (branchMeta) {
              activeBranchSessions.set(workspaceCwd, session.sessionId);
              inFlightBranchWorkspaces.delete(workspaceCwd);
            }
          }
        } else {
          // When an attaching client disconnects
          // before its 200 response can be written, the
          // `attachCount` bump we did inside `spawnOrAttach` is
          // fictitious — there's no live attaching client. Roll the
          // counter back and let the bridge decide whether to reap
          // (it does if attachCount returns to 0 AND no live SSE
          // subscribers). Without this, both-coalesced-callers-
          // disconnect leaves an orphan agent child no client knows
          // the id of.
          runtime.bridge
            .detachClient(session.sessionId, session.clientId)
            .catch(() => {
              // Best-effort cleanup; channel.exited will eventually reap.
            });
          // Unreachable for branch sessions (sessionScope='thread' forces a
          // fresh spawn, never attach), but kept as a safety net: release the
          // in-flight reservation so the workspace is not permanently blocked.
          if (branchMeta) {
            inFlightBranchWorkspaces.delete(workspaceCwd);
          }
        }
        return;
      }

      // Relocate the freshly spawned session into its worktree. The
      // cd chains onto the session's promptQueue, so it completes
      // before any subsequent prompt is processed.
      if (worktreeMeta) {
        try {
          // Compute allowed roots for the sessionCd containment check.
          // Narrow to <root>/.qwen/worktrees (not the whole repo) so a
          // symlink .qwen/worktrees/task -> <repo>/src is rejected.
          const createAllowedRoots = [
            path.join(workspaceCwd, '.qwen', 'worktrees'),
          ];
          let createRepoTop: string | null = null;
          try {
            createRepoTop = await new GitWorktreeService(
              workspaceCwd,
            ).getRepoTopLevel();
          } catch {
            // Not a git repo or getRepoTopLevel unavailable.
          }
          if (createRepoTop && createRepoTop !== workspaceCwd) {
            createAllowedRoots.push(
              path.join(createRepoTop, '.qwen', 'worktrees'),
            );
          }
          await runtime.bridge.changeSessionCwd(session.sessionId, {
            path: worktreeMeta.path,
            allowedRoots: createAllowedRoots,
          });
          await writeWorktreeSessionMarker(
            worktreeMeta.path,
            session.sessionId,
          ).catch(() => {});
          // Write the worktree sidecar so the session list can restore
          // worktree metadata after a daemon restart.
          await writeWorktreeSession(
            createWorkspaceRuntimeSessionService(
              runtime,
            ).getWorktreeSessionPath(session.sessionId),
            {
              slug: worktreeMeta.slug,
              worktreePath: worktreeMeta.path,
              worktreeBranch: worktreeMeta.branch,
              originalCwd: workspaceCwd,
              originalBranch: '',
              originalHeadCommit: '',
            },
          ).catch(() => {});
        } catch (cdErr) {
          // cd failed — relocation is transactional: kill the session,
          // remove the worktree, and return an error. Leaving the session
          // alive with stale worktree metadata in the bridge entry would
          // make GET /session/:id/status claim isolation the session
          // doesn't have.
          if (daemonLog) {
            daemonLog.warn('worktree cd failed, rolling back', {
              sessionId: session.sessionId,
              error: cdErr instanceof Error ? cdErr.message : String(cdErr),
            });
          }
          await runWithWorkspaceRuntimeStorage(runtime, () =>
            deleteDaemonSessionIfOrphan({
              sessionId: session.sessionId,
              service: createWorkspaceRuntimeSessionService(runtime),
              bridge: runtime.bridge,
              coordinator: archiveCoordinator,
            }),
          ).catch(() => false);
          // cd failed so the session never entered the worktree — the
          // worktree is unused regardless of whether the session was
          // killed or another client keeps it alive in the main checkout.
          await new GitWorktreeService(workspaceCwd)
            .removeUserWorktree(worktreeMeta.slug, { deleteBranch: true })
            .catch(() => {});
          res.status(500).json({
            error: 'Failed to relocate session into worktree',
            code: 'worktree_relocate_failed',
          });
          return;
        }
      }

      if (branchMeta) {
        activeBranchSessions.set(workspaceCwd, session.sessionId);
        inFlightBranchWorkspaces.delete(workspaceCwd);
      }

      res.status(200).json(session);
    } catch (err) {
      // Roll back the worktree if spawn failed — otherwise the directory
      // and branch are orphaned (the agent-* stale cleanup won't collect
      // user-named worktrees).
      if (worktreeMeta) {
        await new GitWorktreeService(workspaceCwd)
          .removeUserWorktree(worktreeMeta.slug, { deleteBranch: true })
          .catch(() => {});
      }
      // Roll back the branch if spawn failed — switch back to the base
      // branch and delete the newly created one.
      if (branchMeta) {
        await rollbackBranchCreation(
          workspaceCwd,
          branchMeta,
          branchBaseCommit,
          daemonLog,
        );
      }
      sendBridgeError(res, err, { route: 'POST /session' });
    } finally {
      sessionIdReservation?.release();
    }
  });

  const restoreSessionHandler =
    (action: 'load' | 'resume') => async (req: Request, res: Response) => {
      const sessionId = requireSessionId(req, res);
      if (!sessionId) return;
      const virtualKey = parseVirtualSubagentSessionId(sessionId);
      if (virtualKey) {
        const route = `POST /session/:id/${action}`;
        if (action !== 'load') {
          res.status(400).json({
            error: `Virtual subagent sessions do not support ${action}`,
            code: 'unsupported_action',
            sessionId,
          });
          return;
        }
        if (!virtualSubagentSessions) {
          res.status(404).json({
            error: `No session with id "${sessionId}"`,
            code: 'session_not_found',
            sessionId,
          });
          return;
        }
        const runtime = requireSessionRuntime({
          sessionId: virtualKey.parentSessionId,
          route,
          res,
          workspaceRegistry,
          daemonLog,
        });
        if (!runtime) return;
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        try {
          const session = await virtualSubagentSessions.load(
            runtime,
            sessionId,
            clientId,
          );
          if (!session) {
            res.status(404).json({
              error: 'Subagent session not found',
              code: 'session_not_found',
              sessionId,
            });
            return;
          }
          // Same replay-array shape as the load response; redact skill
          // bodies for the browser surface (#9234).
          res.status(200).json(omitSkillDetailsFromReplayArrays(session));
        } catch (err) {
          sendBridgeError(res, err, { route, sessionId });
        }
        return;
      }
      const body = safeBody(req);
      const route = `POST /session/:id/${action}`;
      let resolvedRuntime:
        | { runtime: WorkspaceRuntime; workspaceCwd: string }
        | undefined;
      try {
        resolvedRuntime = await resolveRuntimeForSessionRestore(
          body,
          res,
          route,
          sessionId,
        );
      } catch (err) {
        if (sendConversationRuntimeError(res, err)) return;
        sendBridgeError(res, err, { route, sessionId });
        return;
      }
      if (resolvedRuntime === undefined) return;
      const { runtime, workspaceCwd } = resolvedRuntime;
      const assertRuntimeGenerationOpen =
        captureRuntimeGenerationAssertion(runtime);
      const approvalMode = parseOptionalApprovalMode(body, res);
      if (approvalMode === null) return;
      const historyPageSize =
        action === 'load' ? parseHistoryPageSize(body ?? {}, res) : undefined;
      if (historyPageSize === null) return;
      const liveReplayMode = parseLiveReplayMode(body ?? {}, res);
      if (liveReplayMode === null) return;
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      let sessionIdReservation: RequestedSessionIdReservation | undefined;
      if (!isInternalWorkspaceRuntime(runtime)) {
        try {
          sessionIdReservation = requestedSessionIdAdmission.reserveRestore(
            sessionId,
            {
              bridge: runtime.bridge,
              workspaceCwd,
              workspaceId: runtime.workspaceId,
            },
          );
        } catch (error) {
          if (error instanceof RequestedSessionIdAdmissionError) {
            sendRequestedSessionIdAdmissionError(res, error, route);
            return;
          }
          throw error;
        }
      }
      try {
        const session = await archiveCoordinator.runSharedMany(
          [sessionId],
          async () => {
            const location = await assertSessionLoadable(
              workspaceCwd,
              sessionId,
              runtime.sessionRuntimeBaseDir,
            );
            if (location === undefined && isInternalWorkspaceRuntime(runtime)) {
              throw new SessionNotFoundError(sessionId);
            }
            // Recover the persisted parent lineage so the restored live entry
            // reports it (the bridge otherwise creates the entry without it, and
            // status calls would show a restored sub-session as top-level).
            const sessionService =
              createWorkspaceRuntimeSessionService(runtime);
            const metadata =
              runtime.provenance === 'live-conversation'
                ? await readLoadableLiveConversationMetadata(
                    sessionId,
                    (candidateId) =>
                      sessionService.readCreationMetadata(candidateId),
                  )
                : await sessionService.readCreationMetadata(sessionId);
            if (metadata === undefined) {
              throw new SessionNotFoundError(sessionId);
            }
            assertRuntimeGenerationOpen?.();
            if (isInternalWorkspaceRuntime(runtime)) {
              sessionIdReservation = requestedSessionIdAdmission.reserveRestore(
                sessionId,
                {
                  bridge: runtime.bridge,
                  workspaceCwd,
                  workspaceId: runtime.workspaceId,
                },
              );
              setDaemonTelemetryWorkspace(res, runtime.workspaceCwd);
            }
            let liveConversationCwd: string | undefined;
            if (runtime.provenance === 'live-conversation') {
              const materialize = deps.materializeLiveConversationDirectory;
              if (!materialize) {
                throw new Error('Live conversation workspace is unavailable.');
              }
              liveConversationCwd = await materialize(sessionId);
            }
            assertRuntimeGenerationOpen?.();
            const restored =
              action === 'load'
                ? await runtime.bridge.loadSession({
                    sessionId,
                    workspaceCwd,
                    historyReplay: 'response',
                    ...(historyPageSize !== undefined
                      ? { historyPageSize }
                      : {}),
                    ...(liveReplayMode !== undefined ? { liveReplayMode } : {}),
                    ...(clientId !== undefined ? { clientId } : {}),
                    ...(approvalMode !== undefined ? { approvalMode } : {}),
                    ...metadata,
                  })
                : await runtime.bridge.resumeSession({
                    sessionId,
                    workspaceCwd,
                    ...(clientId !== undefined ? { clientId } : {}),
                    ...(approvalMode !== undefined ? { approvalMode } : {}),
                    ...metadata,
                  });
            // Every path that can register a Live entry relocates it before a
            // prompt can start. Re-queuing cd for an active entry would block
            // this load behind the prompt it is meant to observe.
            if (liveConversationCwd !== undefined) {
              if (restored.hasActivePrompt) {
                if (restored.currentCwd === liveConversationCwd) {
                  return restored;
                }
                try {
                  if (restored.clientId) {
                    await runtime.bridge.detachClient(
                      restored.sessionId,
                      restored.clientId,
                    );
                  }
                } catch {
                  // Preserve the isolation error. Never kill an active owner.
                }
                throw new Error(
                  'Active Live session is outside its isolated conversation directory.',
                );
              }
              try {
                const changed = await runtime.bridge.changeSessionCwd(
                  sessionId,
                  {
                    path: liveConversationCwd,
                    allowedRoots: [runtime.workspaceCwd],
                    managedRelocation: 'live-conversation',
                  },
                );
                if (changed.newCwd !== liveConversationCwd) {
                  throw new Error(
                    'Live conversation directory relocation was rejected.',
                  );
                }
                restored.currentCwd = changed.newCwd;
              } catch (error) {
                try {
                  if (restored.attached) {
                    if (restored.clientId) {
                      await runtime.bridge.detachClient(
                        restored.sessionId,
                        restored.clientId,
                      );
                    }
                  } else {
                    await runtime.bridge.killSession(restored.sessionId, {
                      requireZeroAttaches: true,
                    });
                  }
                } catch {
                  // Preserve the relocation error.
                }
                throw error;
              }
            }
            return restored;
          },
        );
        try {
          assertRuntimeGenerationOpen?.();
        } catch (error) {
          if (!session.attached) {
            await runtime.bridge
              .killSession(session.sessionId, { requireZeroAttaches: true })
              .catch(() => {});
          } else {
            await runtime.bridge
              .detachClient(session.sessionId, session.clientId)
              .catch(() => {});
          }
          throw error;
        }
        if (daemonLog) {
          daemonLog.info(
            `session ${action}${session.attached ? ' (attached)' : ''}`,
            { sessionId: session.sessionId, clientId: session.clientId },
          );
        }
        // Mirror the `POST /session` disconnect-cleanup path (see the
        // long comment above the matching `if (!res.writable)` there
        // for the rationale around `res.writable` vs `req.aborted` /
        // `req.destroyed`, plus the `requireZeroAttaches` race
        // and the attach-rollback case). Restore needs the
        // same cleanup because a client that disconnects during a
        // multi-second `session/load` would otherwise leave a freshly
        // restored session in `byId` with no client holding its id.
        if (!res.writable) {
          if (!session.attached) {
            runtime.bridge
              .killSession(session.sessionId, { requireZeroAttaches: true })
              .catch(() => {
                // Best-effort cleanup; channel.exited will eventually reap.
              });
          } else {
            runtime.bridge
              .detachClient(session.sessionId, session.clientId)
              .catch(() => {
                // Best-effort cleanup; channel.exited will eventually reap.
              });
          }
          return;
        }
        // Restore worktree isolation. Read the sidecar AFTER load/resume
        // so we inherit the ACP layer's verdict: #restoreWorktreeOnResume
        // clears the sidecar on dead-worktree / containment-failure paths,
        // so a post-read naturally skips those cases. On the healthy path
        // the sidecar is untouched and we relocate + populate the entry.
        // Note: the !res.writable early-return above skips this restore;
        // a client that disconnects mid-load leaves the session parked in
        // the main workspace (pre-existing shape, low frequency).
        if (runtime.provenance !== 'live-conversation' && !session.worktree) {
          const sidecar = await readWorktreeSession(
            createWorkspaceRuntimeSessionService(
              runtime,
            ).getWorktreeSessionPath(sessionId),
          ).catch(() => null);
          if (sidecar) {
            // Defense-in-depth: resolve symlinks on both the target and
            // the expected worktrees root, then verify containment. This
            // defeats both `..` traversal and symlink escapes (e.g.
            // .qwen/worktrees/escape -> /etc). The allowed root is always
            // derived from the server (never from the sidecar, which is
            // attacker-writable). The canonical realTarget is passed to
            // changeSessionCwd to eliminate the TOCTOU window between
            // validation and relocation.
            // For monorepo subdirectory workspaces, worktrees live under
            // the repo top-level, not the workspace cwd. Try workspaceCwd
            // first, then fall back to the git repo top-level.
            let realTarget: string | undefined;
            const candidateRoots = [
              path.join(workspaceCwd, '.qwen', 'worktrees'),
            ];
            try {
              realTarget = fs.realpathSync(sidecar.worktreePath);
              let repoTop: string | null = null;
              try {
                repoTop = await new GitWorktreeService(
                  workspaceCwd,
                ).getRepoTopLevel();
              } catch {
                // Not a git repo or getRepoTopLevel unavailable.
              }
              if (repoTop && repoTop !== workspaceCwd) {
                candidateRoots.push(path.join(repoTop, '.qwen', 'worktrees'));
              }
              const contained = candidateRoots.some((root) => {
                try {
                  const realRoot = fs.realpathSync(root);
                  const rel = path.relative(realRoot, realTarget!);
                  return !rel.startsWith('..') && !path.isAbsolute(rel);
                } catch {
                  return false;
                }
              });
              if (!contained) {
                realTarget = undefined;
              }
            } catch {
              realTarget = undefined;
            }
            if (!realTarget) {
              daemonLog?.warn('worktree sidecar path failed containment', {
                sessionId,
                path: sidecar.worktreePath,
              });
            } else {
              const wt = {
                slug: sidecar.slug,
                path: realTarget,
                branch: sidecar.worktreeBranch,
              };
              try {
                // changeSessionCwd chains onto the prompt queue and
                // blocks until any in-flight prompt finishes. When the
                // session is actively running a task this would stall the
                // HTTP response (bounded by the ~30s changeSessionCwd
                // timeout), making the session unopenable in the Web
                // Shell. Skip the cwd relocation in that case.
                // Invariant: hasActivePrompt implies a live bridge entry
                // that was relocated into the worktree cwd at creation
                // (before any prompt could run), so relocation is
                // unnecessary. A cold-restored session cannot have an
                // in-flight prompt.
                if (!session.hasActivePrompt) {
                  await runtime.bridge.changeSessionCwd(sessionId, {
                    path: wt.path,
                    allowedRoots: candidateRoots,
                  });
                }
                runtime.bridge.setSessionWorktree(sessionId, wt);
                session.worktree = wt;
              } catch (restoreErr) {
                daemonLog?.warn('worktree restore failed on load/resume', {
                  sessionId,
                  worktreePath: wt.path,
                  error:
                    restoreErr instanceof Error
                      ? restoreErr.message
                      : String(restoreErr),
                });
              }
            }
          }
        }
        // The load response embeds the replay snapshot inline; redact the
        // skill bodies there just like the SSE egress does (#9234).
        res.status(200).json(omitSkillDetailsFromReplayArrays(session));
      } catch (err) {
        if (err instanceof RequestedSessionIdAdmissionError) {
          sendRequestedSessionIdAdmissionError(res, err, route);
          return;
        }
        sendBridgeError(res, err, {
          route,
          sessionId,
        });
      } finally {
        sessionIdReservation?.release();
      }
    };

  app.post('/session/:id/load', mutate(), restoreSessionHandler('load'));
  app.post('/session/:id/resume', mutate(), restoreSessionHandler('resume'));

  app.get('/session/:id/subagents/:subagentRef', async (req, res) => {
    const route = 'GET /session/:id/subagents/:subagentRef';
    const sessionId = requireSessionId(req, res);
    if (!sessionId) return;
    if (!virtualSubagentSessions) {
      res.status(404).json({
        error: `No session with id "${sessionId}"`,
        code: 'session_not_found',
        sessionId,
      });
      return;
    }
    const subagentRef = req.params['subagentRef'];
    if (
      !subagentRef ||
      subagentRef.length > MAX_VIRTUAL_SESSION_ID_PART_LENGTH
    ) {
      res.status(400).json({
        error: '`subagentRef` must be a non-empty subagent reference',
        code: 'invalid_subagent_ref',
      });
      return;
    }
    const runtime = requireSessionRuntime({
      sessionId,
      route,
      res,
      workspaceRegistry,
      daemonLog,
    });
    if (!runtime) return;
    try {
      const resolved = await virtualSubagentSessions.resolve(
        runtime,
        sessionId,
        subagentRef,
      );
      if (!resolved) {
        res.status(404).json({
          error: 'Subagent session not found',
          code: 'session_not_found',
          sessionId,
          subagentRef,
        });
        return;
      }
      res.status(200).set('Cache-Control', 'no-store').json(resolved);
    } catch (err) {
      sendBridgeError(res, err, { route, sessionId });
    }
  });

  app.post(
    '/session/:id/subagents/:subagentRef/cancel',
    mutate(),
    async (req, res) => {
      const route = 'POST /session/:id/subagents/:subagentRef/cancel';
      const sessionId = requireSessionId(req, res);
      if (!sessionId) return;
      if (!virtualSubagentSessions) {
        res.status(404).json({
          error: `No session with id "${sessionId}"`,
          code: 'session_not_found',
          sessionId,
        });
        return;
      }
      const subagentRef = req.params['subagentRef'];
      if (
        !subagentRef ||
        subagentRef.length > MAX_VIRTUAL_SESSION_ID_PART_LENGTH
      ) {
        res.status(400).json({
          error: '`subagentRef` must be a non-empty subagent reference',
          code: 'invalid_subagent_ref',
        });
        return;
      }
      const runtime = requireSessionRuntime({
        sessionId,
        route,
        res,
        workspaceRegistry,
        daemonLog,
      });
      if (!runtime) return;
      try {
        const resolved = await virtualSubagentSessions.resolve(
          runtime,
          sessionId,
          subagentRef,
        );
        if (!resolved) {
          res.status(404).json({
            error: 'Subagent session not found',
            code: 'session_not_found',
            sessionId,
            subagentRef,
          });
          return;
        }
        res
          .status(200)
          .json(
            await runtime.bridge.cancelSessionTask(
              sessionId,
              resolved.taskId,
              'agent',
            ),
          );
      } catch (err) {
        sendBridgeError(res, err, { route, sessionId });
      }
    },
  );

  app.post(
    '/session/:id/branch',
    mutate(),
    withRestrictedMutableSession(
      'POST /session/:id/branch',
      async (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        let name =
          typeof body?.['name'] === 'string' ? body['name'] : undefined;
        if (name) {
          // eslint-disable-next-line no-control-regex
          name = name.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
          if (name.length > 200) {
            name = name.slice(0, 200);
          }
        }
        const atRecordId = body?.['atRecordId'];
        if (atRecordId !== undefined && typeof atRecordId !== 'string') {
          res.status(400).json({
            error: '`atRecordId` must be a string',
            code: 'branch_point_invalid',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const result = await runtime.bridge.branchSession(
          sessionId,
          {
            name,
            ...(atRecordId !== undefined ? { atRecordId } : {}),
          },
          { clientId },
        );
        if (atRecordId === undefined) {
          const restored = result as BridgeBranchedSession;
          const releaseLiveBranch = async () => {
            if (restored.attached) {
              await runtime.bridge
                .detachClient(restored.sessionId, restored.clientId)
                .catch(() => {});
              return;
            }
            await runtime.bridge
              .killSession(restored.sessionId, { requireZeroAttaches: true })
              .catch(() => false);
          };
          if (!res.writable) {
            void releaseLiveBranch();
            return;
          }
        }
        if (!res.writable) return;
        // Branch/side-task responses carry the same replay snapshot shape as
        // load; apply the same redaction (#9234). The helper returns its
        // input unchanged when no replay arrays are present (checkpoint
        // branches), so apply it unconditionally rather than re-deriving the
        // bridge's variant discrimination here.
        res
          .status(201)
          .json(
            omitSkillDetailsFromReplayArrays(result as BridgeBranchedSession),
          );
      },
    ),
  );

  app.post(
    '/session/:id/side-task',
    mutate(),
    withRestrictedMutableSession(
      'POST /session/:id/side-task',
      async (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        let name =
          typeof body?.['name'] === 'string' ? body['name'] : undefined;
        if (name) {
          // eslint-disable-next-line no-control-regex
          name = Array.from(name.replace(/[\x00-\x1F\x7F-\x9F]/g, ''))
            .slice(0, 200)
            .join('');
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const result = await runtime.bridge.createSideTaskSession(
          sessionId,
          { name },
          { clientId },
        );
        try {
          runtime.generationGuard?.assertOpen();
        } catch (error) {
          if (!result.attached) {
            const killed = await runtime.bridge
              .killSession(result.sessionId, { requireZeroAttaches: true })
              .catch(() => false);
            if (killed) {
              const removed = await createWorkspaceRuntimeSessionService(
                runtime,
              )
                .removeSession(result.sessionId)
                .catch(() => false);
              if (removed) runtime.bridge.markSessionCatalogChanged();
            }
          } else {
            await runtime.bridge
              .detachClient(result.sessionId, result.clientId)
              .catch(() => {});
          }
          throw error;
        }
        if (!res.writable) {
          if (!result.attached) {
            runtime.bridge
              .killSession(result.sessionId, { requireZeroAttaches: true })
              .then(async (killed) => {
                if (!killed) return;
                const removed = await createWorkspaceRuntimeSessionService(
                  runtime,
                ).removeSession(result.sessionId);
                if (removed) runtime.bridge.markSessionCatalogChanged();
              })
              .catch(() => {});
          } else {
            runtime.bridge
              .detachClient(result.sessionId, result.clientId)
              .catch(() => {});
          }
          return;
        }
        res.status(201).json(omitSkillDetailsFromReplayArrays(result));
      },
    ),
  );

  app.post(
    '/session/:id/fork',
    mutate(),
    withRestrictedMutableSession(
      'POST /session/:id/fork',
      async (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        const directive = body['directive'];
        if (typeof directive !== 'string' || directive.trim().length === 0) {
          res.status(400).json({
            error: '`directive` is required and must be a non-empty string',
            code: 'missing_directive',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const result = await runtime.bridge.launchSessionForkAgent(
          sessionId,
          directive,
          clientId !== undefined ? { clientId } : undefined,
        );
        try {
          runtime.generationGuard?.assertOpen();
        } catch (error) {
          if (result.launched) {
            await runtime.bridge
              .killSession(result.sessionId, { requireZeroAttaches: true })
              .catch(() => {});
          }
          throw error;
        }
        res.status(202).json(result);
      },
    ),
  );

  app.post(
    '/session/:id/cd',
    mutate(),
    withRestrictedMutableSession(
      'POST /session/:id/cd',
      async (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        const targetPath = body['path'];
        if (
          typeof targetPath !== 'string' ||
          targetPath.length === 0 ||
          !path.isAbsolute(targetPath)
        ) {
          res.status(400).json({
            error: '`path` is required and must be an absolute path',
            code: 'invalid_path',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        runtime.generationGuard?.assertOpen();
        const result = await runtime.bridge.changeSessionCwd(
          sessionId,
          { path: targetPath },
          clientId !== undefined ? { clientId } : undefined,
        );
        runtime.generationGuard?.assertOpen();
        res.status(200).json(result);
      },
    ),
  );

  app.get('/session/:id/status', (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const runtime = resolveLiveSessionRuntime(
      sessionId,
      res,
      'GET /session/:id/status',
    );
    if (!runtime) return;
    try {
      res.status(200).json(runtime.bridge.getSessionSummary(sessionId));
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/status',
        sessionId,
      });
    }
  });

  app.get('/session/:id/export', async (req, res) => {
    await handleSessionExport(req, res, {
      route: 'GET /session/:id/export',
      resolveRuntime: (sessionId) =>
        resolveTranscriptSessionRuntime(
          res,
          'GET /session/:id/export',
          sessionId,
          false,
          true,
        ),
    });
  });

  app.get('/workspaces/:workspace/session/:id/export', async (req, res) => {
    const route = 'GET /workspaces/:workspace/session/:id/export';
    await handleSessionExport(req, res, {
      route,
      resolveRuntime: (sessionId) =>
        resolveQualifiedSessionRuntime(req, res, route, [sessionId], 'active'),
      workspaceQualified: true,
    });
  });

  app.get(
    '/workspaces/:workspace/session/:id/archive/export',
    async (req, res) => {
      const route = 'GET /workspaces/:workspace/session/:id/archive/export';
      await handleSessionExport(req, res, {
        route,
        resolveRuntime: (sessionId) =>
          resolveQualifiedSessionRuntime(
            req,
            res,
            route,
            [sessionId],
            'archived',
          ),
        workspaceQualified: true,
        archiveState: 'archived',
      });
    },
  );

  app.get('/session/:id/transcript', async (req, res) => {
    const route = 'GET /session/:id/transcript';
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const limit = parseTranscriptLimitQuery(req.query['limit'], res);
    if (limit === null) return;
    const cursor = parseTranscriptCursorQuery(req.query['cursor'], res);
    if (cursor === null) return;
    const beforeRecordId = parseTranscriptRecordBoundaryQuery(
      req.query['beforeRecordId'],
      res,
    );
    if (beforeRecordId === null) return;
    if (cursor !== undefined && beforeRecordId !== undefined) {
      res.status(400).json({
        error: '`cursor` and `beforeRecordId` are mutually exclusive',
        code: 'invalid_transcript_cursor',
      });
      return;
    }

    try {
      const result = await archiveCoordinator.runSharedMany(
        [sessionId],
        async () => {
          const runtime = await resolveTranscriptSessionRuntime(
            res,
            route,
            sessionId,
            cursor !== undefined,
          );
          if (!runtime) return undefined;
          captureRuntimeGenerationAssertion(runtime)?.();
          return runtime.bridge.getSessionTranscriptPage({
            sessionId,
            ...(limit !== undefined ? { limit } : {}),
            ...(cursor !== undefined ? { cursor } : {}),
            ...(beforeRecordId !== undefined ? { beforeRecordId } : {}),
          });
        },
      );
      if (result === undefined) return;
      res
        .status(200)
        .set('Cache-Control', 'no-store')
        .json({
          ...result,
          events: (result.events ?? []).map(omitSkillDetailsForSdkSurface),
        });
    } catch (err) {
      sendBridgeError(res, err, {
        route,
        sessionId,
      });
    }
  });

  app.get('/workspaces/:workspace/session/:id/transcript', async (req, res) => {
    const route = 'GET /workspaces/:workspace/session/:id/transcript';
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const qualifiedTarget = resolveQualifiedSessionTarget(req, res, {
      allowUntrustedSecondary: true,
    });
    if (!qualifiedTarget) return;
    const preResolvedRuntime =
      qualifiedTarget.kind === 'ordinary' ? qualifiedTarget.runtime : undefined;
    const limit = parseTranscriptLimitQuery(req.query['limit'], res);
    if (limit === null) return;
    const cursor = parseTranscriptCursorQuery(req.query['cursor'], res);
    if (cursor === null) return;
    const beforeRecordId = parseTranscriptRecordBoundaryQuery(
      req.query['beforeRecordId'],
      res,
    );
    if (beforeRecordId === null) return;
    if (cursor !== undefined && beforeRecordId !== undefined) {
      res.status(400).json({
        error: '`cursor` and `beforeRecordId` are mutually exclusive',
        code: 'invalid_transcript_cursor',
      });
      return;
    }
    if (cursor !== undefined && workspaceTranscriptCursorExceedsLimit(cursor)) {
      res.status(400).json({
        error: '`cursor` exceeds the maximum size',
        code: 'invalid_transcript_cursor',
      });
      return;
    }

    try {
      const result = await runWithoutDebugLogSession(() =>
        archiveCoordinator.runSharedMany([sessionId], async () => {
          const runtime =
            preResolvedRuntime ??
            (await resolveQualifiedSessionRuntime(
              req,
              res,
              route,
              [sessionId],
              'active',
            ));
          if (!runtime) return undefined;
          const assertRuntimeGenerationOpen =
            captureRuntimeGenerationAssertion(runtime);
          assertRuntimeGenerationOpen?.();
          return runWithWorkspaceRuntimeStorage(runtime, async () => {
            const service = createWorkspaceRuntimeSessionService(runtime);
            if (cursor === undefined) {
              await assertSessionLoadable(
                runtime.workspaceCwd,
                sessionId,
                runtime.sessionRuntimeBaseDir,
              );
            }
            const codec = getTranscriptCursorCodec(runtime);
            const reader = new SessionTranscriptReader(
              runtime.workspaceCwd,
              codec,
            );
            const hasActivePrompt = (): boolean => {
              try {
                return runtime.bridge.getSessionSummary(sessionId)
                  .hasActivePrompt;
              } catch (error) {
                if (error instanceof SessionNotFoundError) return false;
                throw error;
              }
            };
            const activePromptBeforeRead = hasActivePrompt();
            let page;
            try {
              page = await reader.readPage(sessionId, {
                ...(limit !== undefined ? { limit } : {}),
                ...(cursor !== undefined ? { cursor } : {}),
                ...(beforeRecordId !== undefined ? { beforeRecordId } : {}),
                maxBytes: SESSION_TRANSCRIPT_MAX_PAGE_BYTES,
              });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
              }
              if (cursor !== undefined) {
                throw new SessionTranscriptSnapshotUnavailableError(sessionId);
              }
              const location = await service.getSessionLocation(sessionId);
              if (location === 'archived') {
                throw new SessionArchivedError(sessionId);
              }
              if (location === 'conflict') {
                throw new SessionConflictError(sessionId);
              }
              throw new SessionNotFoundError(sessionId);
            }
            if (page.records.some((record) => record.sessionId !== sessionId)) {
              throw new SessionTranscriptSnapshotUnavailableError(sessionId);
            }
            const activePromptAfterRead = hasActivePrompt();
            const replay = await replayTranscriptRecordPage({
              sessionId,
              page,
              finalizeDangling:
                !activePromptBeforeRead && !activePromptAfterRead,
              encodeCursor: (state) => codec.encode(state),
            });
            assertRuntimeGenerationOpen?.();
            const cursorTooLarge =
              replay.nextCursor !== undefined &&
              Buffer.byteLength(replay.nextCursor) >
                WORKSPACE_TRANSCRIPT_CURSOR_MAX_BYTES;
            return {
              v: 1 as const,
              sessionId,
              events: replay.updates.map((update) =>
                omitSkillDetailsForSdkSurface({
                  v: 1 as const,
                  type: 'session_update' as const,
                  data: update,
                }),
              ),
              ...(replay.nextCursor && !cursorTooLarge
                ? { nextCursor: replay.nextCursor }
                : {}),
              hasMore: cursorTooLarge ? false : replay.hasMore,
              startTime: replay.startTime,
              lastUpdated: replay.lastUpdated,
              ...(replay.partial || cursorTooLarge
                ? {
                    partial: true as const,
                    replayError: cursorTooLarge
                      ? TRANSCRIPT_CURSOR_TOO_LARGE_REPLAY_ERROR
                      : replay.replayError,
                  }
                : {}),
            };
          });
        }),
      );
      if (result === undefined) return;
      const serialized = serializeWorkspaceTranscriptResponse(
        result,
        sessionId,
      );
      res
        .status(200)
        .set('Cache-Control', 'no-store')
        .type('application/json')
        .send(serialized);
    } catch (err) {
      sendBridgeError(res, err, { route, sessionId });
    }
  });

  app.get(
    '/session/:id/context',
    (req, res, next) => {
      const sessionId = req.params['id'];
      const key = sessionId
        ? parseVirtualSubagentSessionId(sessionId)
        : undefined;
      if (!sessionId || !key) {
        next();
        return;
      }
      const runtime = requireSessionRuntime({
        sessionId: key.parentSessionId,
        route: 'GET /session/:id/context',
        res,
        workspaceRegistry,
        daemonLog,
      });
      if (!runtime) return;
      res.status(200).json({
        v: 1,
        sessionId,
        workspaceCwd: runtime.workspaceCwd,
        state: {},
      });
    },
    withOwnerReadSession(
      'GET /session/:id/context',
      async (_req, res, sessionId, runtime) => {
        res
          .status(200)
          .json(await runtime.bridge.getSessionContextStatus(sessionId));
      },
    ),
  );

  app.get(
    '/session/:id/context-usage',
    withOwnerReadSession(
      'GET /session/:id/context-usage',
      async (req, res, sessionId, runtime) => {
        res.status(200).json(
          await runtime.bridge.getSessionContextUsageStatus(sessionId, {
            detail: req.query['detail'] === 'true',
          }),
        );
      },
    ),
  );

  app.get(
    '/session/:id/stats',
    withOwnerReadSession(
      'GET /session/:id/stats',
      async (_req, res, sessionId, runtime) => {
        res
          .status(200)
          .json(await runtime.bridge.getSessionStatsStatus(sessionId));
      },
    ),
  );

  app.get(
    '/session/:id/supported-commands',
    (req, res, next) => {
      const sessionId = req.params['id'];
      const key = sessionId
        ? parseVirtualSubagentSessionId(sessionId)
        : undefined;
      if (!sessionId || !key) {
        next();
        return;
      }
      const runtime = requireSessionRuntime({
        sessionId: key.parentSessionId,
        route: 'GET /session/:id/supported-commands',
        res,
        workspaceRegistry,
        daemonLog,
      });
      if (!runtime) return;
      res.status(200).json({
        v: 1,
        sessionId,
        availableCommands: [],
        availableSkills: [],
      });
    },
    withOwnerReadSession(
      'GET /session/:id/supported-commands',
      async (_req, res, sessionId, runtime) => {
        res
          .status(200)
          .json(
            await runtime.bridge.getSessionSupportedCommandsStatus(sessionId),
          );
      },
    ),
  );

  app.get(
    '/session/:id/tasks',
    withOwnerReadSession(
      'GET /session/:id/tasks',
      async (_req, res, sessionId, runtime) => {
        res
          .status(200)
          .json(await runtime.bridge.getSessionTasksStatus(sessionId));
      },
    ),
  );

  app.get(
    '/session/:id/lsp',
    withOwnerReadSession(
      'GET /session/:id/lsp',
      async (_req, res, sessionId, runtime) => {
        res
          .status(200)
          .json(await runtime.bridge.getSessionLspStatus(sessionId));
      },
    ),
  );

  // GET /session/:id/hooks — read-only session-scoped hook status.
  app.get(
    '/session/:id/hooks',
    withOwnerReadSession(
      'GET /session/:id/hooks',
      async (_req, res, sessionId, runtime) => {
        res
          .status(200)
          .json(await runtime.bridge.getSessionHooksStatus(sessionId));
      },
    ),
  );

  app.get(
    '/session/:id/artifacts',
    withOwnerReadSession(
      'GET /session/:id/artifacts',
      async (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        res
          .status(200)
          .json(
            await runtime.bridge.getSessionArtifacts(
              sessionId,
              clientId !== undefined ? { clientId } : undefined,
            ),
          );
      },
    ),
  );

  app.post(
    '/session/:id/artifacts',
    mutate({ strict: true }),
    withOwnerMutableSession(
      'POST /session/:id/artifacts',
      async (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        if (!requireSessionArtifactClientId(clientId, res)) return;
        try {
          const body = safeBody(req);
          const artifact: SessionArtifactInput = {
            title: body['title'] as SessionArtifactInput['title'],
            kind: body['kind'] as SessionArtifactInput['kind'],
            storage: body['storage'] as SessionArtifactInput['storage'],
            description: body[
              'description'
            ] as SessionArtifactInput['description'],
            workspacePath: body[
              'workspacePath'
            ] as SessionArtifactInput['workspacePath'],
            managedId: body['managedId'] as SessionArtifactInput['managedId'],
            url: body['url'] as SessionArtifactInput['url'],
            mimeType: body['mimeType'] as SessionArtifactInput['mimeType'],
            sizeBytes: body['sizeBytes'] as SessionArtifactInput['sizeBytes'],
            metadata: body['metadata'] as SessionArtifactInput['metadata'],
            retention: body['retention'] as SessionArtifactInput['retention'],
            clientRetained: body[
              'clientRetained'
            ] as SessionArtifactInput['clientRetained'],
          };
          const result = await runtime.bridge.addSessionArtifact(
            sessionId,
            artifact,
            { clientId },
          );
          res.status(200).json(result);
        } catch (err) {
          if (sendArtifactValidationError(res, err)) return;
          sendBridgeError(res, err, {
            route: 'POST /session/:id/artifacts',
            sessionId,
          });
        }
      },
    ),
  );

  app.delete(
    '/session/:id/artifacts/:artifactId',
    mutate({ strict: true }),
    withOwnerMutableSession(
      'DELETE /session/:id/artifacts/:artifactId',
      async (req, res, sessionId, runtime) => {
        const artifactId = req.params['artifactId'];
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        if (!requireSessionArtifactClientId(clientId, res)) return;
        if (!artifactId) {
          res.status(400).json({
            v: 1,
            error: {
              code: 'VALIDATION_FAILED',
              message: '`artifactId` route parameter is required',
              field: 'artifactId',
            },
          });
          return;
        }
        try {
          const result = await runtime.bridge.removeSessionArtifact(
            sessionId,
            artifactId,
            { clientId },
          );
          res.status(200).json(result);
        } catch (err) {
          if (sendArtifactValidationError(res, err)) return;
          sendBridgeError(res, err, {
            route: 'DELETE /session/:id/artifacts/:artifactId',
            sessionId,
          });
        }
      },
    ),
  );

  app.post(
    '/session/:id/tasks/:taskId/cancel',
    mutate({ strict: true }),
    withOwnerMutableSession(
      'POST /session/:id/tasks/:taskId/cancel',
      async (req, res, sessionId, runtime) => {
        const taskId = req.params['taskId'];
        if (!taskId) {
          res.status(400).json({
            error: '`taskId` route parameter is required',
          });
          return;
        }
        const body = safeBody(req);
        const kind = body['kind'];
        if (kind !== 'agent' && kind !== 'shell' && kind !== 'monitor') {
          res
            .status(400)
            .json({ error: '`kind` must be "agent", "shell", or "monitor"' });
          return;
        }
        res
          .status(200)
          .json(
            await runtime.bridge.cancelSessionTask(sessionId, taskId, kind),
          );
      },
    ),
  );

  app.post(
    '/session/:id/goal/clear',
    mutate({ strict: true }),
    withOwnerMutableSession(
      'POST /session/:id/goal/clear',
      async (_req, res, sessionId, runtime) => {
        res.status(200).json(await runtime.bridge.clearSessionGoal(sessionId));
      },
    ),
  );

  app.post(
    '/session/:id/continue',
    mutate({ strict: true }),
    withOwnerMutableSession(
      'POST /session/:id/continue',
      async (req, res, sessionId, runtime) => {
        // Forward the originator and a generated promptId so the bridge can
        // attribute and correlate the continuation turn (it now runs through the
        // prompt-admission path, same as POST /session/:id/prompt). The accepted
        // response echoes promptId + lastEventId as the replay/correlation anchor.
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const promptId = crypto.randomUUID();
        const result = await runtime.bridge.continueSession(sessionId, {
          ...(clientId !== undefined ? { clientId } : {}),
          promptId,
        });
        if (daemonLog && result.accepted) {
          daemonLog.info('continuation enqueued', {
            sessionId,
            promptId,
            clientId,
          });
        }
        res.status(200).json(result);
      },
    ),
  );

  app.post(
    '/session/:id/media',
    mutate(),
    express.raw({ type: 'image/*', limit: '8mb' }),
    ((error, _req, res, next) => {
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        error.status === 413
      ) {
        res.status(413).json({ error: 'Request body too large (max 8 MiB)' });
        return;
      }
      next(error);
    }) satisfies ErrorRequestHandler,
    withOwnerMutableSession(
      'POST /session/:id/media',
      async (req, res, sessionId, runtime) => {
        const contentType = req.headers['content-type']
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase();
        // SVG can carry scripts; this origin also hosts the daemon API and
        // Web Shell UI, and the bytes are served back to browsers, so an
        // inline SVG would run same-origin. Raster formats only.
        if (isSvgMimeType(contentType)) {
          res.status(415).json({ error: 'SVG uploads are not supported' });
          return;
        }
        if (
          !contentType ||
          !contentType.startsWith('image/') ||
          !Buffer.isBuffer(req.body) ||
          req.body.byteLength === 0
        ) {
          res.status(400).json({
            error:
              'request body must contain image/* bytes with a matching Content-Type',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        try {
          const reference = await runtime.bridge.storeSessionMedia(
            sessionId,
            req.body,
            contentType,
            clientId !== undefined ? { clientId } : undefined,
          );
          res.status(201).json(reference);
        } catch (error) {
          if (error instanceof RangeError) {
            res.status(413).json({ error: error.message });
            return;
          }
          throw error;
        }
      },
    ),
  );

  app.get(
    '/session/:id/media/:mediaId',
    withOwnerReadSession(
      'GET /session/:id/media/:mediaId',
      async (req, res, sessionId, runtime) => {
        const mediaId = req.params['mediaId'];
        if (!mediaId) {
          res.status(400).json({ error: '`mediaId` is required' });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const media = await runtime.bridge.readSessionMedia(
          sessionId,
          mediaId,
          clientId !== undefined ? { clientId } : undefined,
        );
        if (!media) {
          res.status(404).json({ error: 'session media not found' });
          return;
        }
        res.setHeader('Content-Type', media.mimeType);
        res.setHeader('Content-Length', String(media.data.byteLength));
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('Content-Disposition', 'attachment');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.status(200).send(media.data);
      },
    ),
  );

  app.delete(
    '/session/:id/media/:mediaId',
    mutate(),
    withOwnerMutableSession(
      'DELETE /session/:id/media/:mediaId',
      async (req, res, sessionId, runtime) => {
        const mediaId = req.params['mediaId'];
        if (!mediaId) {
          res.status(400).json({ error: '`mediaId` is required' });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const removed = await runtime.bridge.removeSessionMedia(
          sessionId,
          mediaId,
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json({ removed });
      },
    ),
  );

  app.post(
    '/session/:id/prompt',
    mutate(),
    withOwnerMutableSession(
      'POST /session/:id/prompt',
      async (req, res, sessionId, runtime) => {
        const ownerBridge = runtime.bridge;
        const body = safeBody(req);
        const prompt = body['prompt'];
        if (!Array.isArray(prompt) || prompt.length === 0) {
          res.status(400).json({
            error:
              '`prompt` is required and must be a non-empty array of content blocks',
          });
          return;
        }
        if (
          !prompt.every(
            (item: unknown) =>
              typeof item === 'object' && item !== null && !Array.isArray(item),
          )
        ) {
          res.status(400).json({
            error: 'each `prompt` element must be an object (content block)',
          });
          return;
        }
        const mediaBlockCount = prompt.filter(
          (item: unknown) =>
            (item as Record<string, unknown>)['type'] !== 'text',
        ).length;
        if (mediaBlockCount > MEDIA_CONTENT_MAX_BLOCKS) {
          res.status(400).json({
            error: `\`prompt\` must carry at most ${MEDIA_CONTENT_MAX_BLOCKS} media blocks`,
          });
          return;
        }
        // Same per-block validation as the mid-turn route, scoped to image
        // blocks: a malformed image admitted here only fails the ACP child's
        // schema parse later, surfacing an async turn error instead of a
        // synchronous 400. Other non-text blocks (legacy inline audio,
        // embedded resources) keep their pre-existing child-side validation.
        for (const item of prompt) {
          if ((item as Record<string, unknown>)['type'] !== 'image') continue;
          const parsed = parseMediaContentBlock(item);
          if (!parsed.valid) {
            res.status(400).json({
              error: mediaBlockParseError(parsed.code, '`prompt` image block'),
            });
            return;
          }
        }
        const rawRequestDeadline = body['deadlineMs'];
        let requestDeadlineMs: number | undefined;
        if (rawRequestDeadline !== undefined && rawRequestDeadline !== null) {
          if (
            typeof rawRequestDeadline !== 'number' ||
            !Number.isFinite(rawRequestDeadline) ||
            !Number.isInteger(rawRequestDeadline) ||
            rawRequestDeadline <= 0
          ) {
            res.status(400).json({
              error: '`deadlineMs` must be a positive integer (milliseconds)',
              code: 'invalid_deadline_ms',
            });
            return;
          }
          requestDeadlineMs = rawRequestDeadline;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;

        let delivery: ReturnType<typeof parseChannelDelivery> | undefined;
        if (body['delivery'] !== undefined) {
          try {
            delivery = parseChannelDelivery(body['delivery']);
          } catch (err) {
            if (!isChannelDeliveryError(err)) throw err;
            res.status(400).json({ error: err.message, code: err.code });
            return;
          }
        }

        const promptId = crypto.randomUUID();
        if (delivery && deps.channelDeliveryAuthorizations) {
          deps.channelDeliveryAuthorizations.authorizePrompt(
            runtime.workspaceCwd,
            {
              sessionId,
              deliveryId: promptId,
              target: delivery.target,
            },
          );
        }
        const forwardedBody = { ...body };
        delete forwardedBody['deadlineMs'];
        delete forwardedBody['delivery'];
        const forwardedMeta =
          typeof forwardedBody['_meta'] === 'object' &&
          forwardedBody['_meta'] !== null &&
          !Array.isArray(forwardedBody['_meta'])
            ? { ...(forwardedBody['_meta'] as Record<string, unknown>) }
            : undefined;
        const promptAuthorization =
          forwardedMeta?.[CHANNEL_WORKER_PROMPT_AUTHORIZATION_META_KEY];
        const promptDisplayText =
          forwardedMeta?.[DAEMON_PROMPT_DISPLAY_TEXT_META_KEY];
        const channelPrompt = forwardedMeta?.[CHANNEL_PROMPT_META_KEY];
        if (forwardedMeta) {
          delete forwardedMeta[CHANNEL_WORKER_PROMPT_AUTHORIZATION_META_KEY];
          delete forwardedMeta[DAEMON_PROMPT_DISPLAY_TEXT_META_KEY];
          delete forwardedMeta[CHANNEL_PROMPT_META_KEY];
          if (Object.keys(forwardedMeta).length > 0) {
            forwardedBody['_meta'] = forwardedMeta;
          } else {
            delete forwardedBody['_meta'];
          }
        }
        const channelWorkerAuthorized = isChannelWorkerPromptAuthorized(
          promptAuthorization,
          runtime.workspaceCwd,
        );
        const trustedPromptDisplayText =
          typeof promptDisplayText === 'string' && channelWorkerAuthorized
            ? promptDisplayText
            : undefined;
        // Channel classification opts the turn out of loop-detected
        // rejection, so it rides the same worker authorization as the
        // display projection; a forged key from any other caller is dropped
        // here and again at the bridge admission strip.
        const trustedChannelPrompt =
          channelWorkerAuthorized && channelPrompt === true;

        const lastEventId = ownerBridge.getSessionLastEventId(sessionId);
        // Epoch token paired with the cursor above: a client that seeds its
        // SSE resume position from this 202 must also learn the bus epoch so
        // a daemon restart in between is detected (DAEMON-001).
        const eventEpoch = ownerBridge.getSessionEventEpoch(sessionId);
        addDaemonRequestAttribute('qwen-code.prompt_id', promptId);

        const abort = new AbortController();
        let responseFinished = false;
        const onResClose = () => {
          if (!responseFinished) abort.abort();
        };
        const onResFinish = () => {
          responseFinished = true;
          res.off('close', onResClose);
        };
        res.once('close', onResClose);
        res.once('finish', onResFinish);
        // The effective deadline (server cap ∩ request override) is passed
        // to the bridge, which owns the deadline race: it publishes the
        // formal `turn_error{code:'prompt_deadline_exceeded'}` terminal,
        // releases the per-session FIFO, and best-effort cancels the agent.
        // A route-side timer can't do any of that — it could only abort
        // this request's signal.
        const effectiveDeadlineMs = resolvePromptDeadlineMs(
          promptDeadlineMs,
          requestDeadlineMs,
        );

        let promptPromise: ReturnType<AcpSessionBridge['sendPrompt']>;
        try {
          promptPromise = ownerBridge.sendPrompt(
            sessionId,
            {
              ...forwardedBody,
              sessionId,
              prompt,
            } as Parameters<AcpSessionBridge['sendPrompt']>[1],
            abort.signal,
            {
              ...(clientId !== undefined ? { clientId } : {}),
              promptId,
              ...(effectiveDeadlineMs !== undefined
                ? { deadlineMs: effectiveDeadlineMs }
                : {}),
              ...(trustedPromptDisplayText !== undefined
                ? { promptDisplayText: trustedPromptDisplayText }
                : {}),
              ...(trustedChannelPrompt ? { channelPrompt: true } : {}),
              ...(delivery !== undefined
                ? {
                    channelDelivery: {
                      deliveryId: promptId,
                      target: delivery.target,
                    },
                  }
                : {}),
            },
          );
        } catch (err) {
          deps.channelDeliveryAuthorizations?.revokePrompt(
            runtime.workspaceCwd,
            sessionId,
            promptId,
          );
          res.off('close', onResClose);
          res.off('finish', onResFinish);
          if (daemonLog && err instanceof PromptQueueFullError) {
            daemonLog.warn('prompt admission rejected: queue full', {
              sessionId,
              promptId,
              ...(clientId !== undefined ? { clientId } : {}),
              limit: err.limit,
              pendingCount: err.pendingCount,
            });
          }
          if (daemonLog && err instanceof InvalidClientIdError) {
            daemonLog.warn('prompt admission rejected: invalid client id', {
              sessionId,
              promptId,
              ...(clientId !== undefined ? { clientId } : {}),
            });
          }
          sendBridgeError(res, err, {
            route: 'POST /session/:id/prompt',
            sessionId,
          });
          return;
        }
        res.off('close', onResClose);

        promptPromise
          .then(
            () => {
              if (daemonLog) {
                daemonLog.info('prompt turn completed', {
                  sessionId,
                  promptId,
                  clientId,
                });
              }
            },
            (err) => {
              if (daemonLog) {
                const errName = err instanceof Error ? err.name : undefined;
                daemonLog.warn(
                  `prompt turn failed: ${errName ? `[${errName}] ` : ''}${err instanceof Error ? err.message : String(err)}`,
                  { sessionId, promptId, clientId },
                );
              }
            },
          )
          .finally(() => {
            if (delivery && deps.channelDeliveryAuthorizations) {
              const revokeTimer = setTimeout(() => {
                deps.channelDeliveryAuthorizations?.revokePrompt(
                  runtime.workspaceCwd,
                  sessionId,
                  promptId,
                );
              }, CHANNEL_DELIVERY_AUTHORIZATION_GRACE_MS);
              revokeTimer.unref();
            }
          })
          .catch(() => {});

        if (daemonLog) {
          daemonLog.info('prompt enqueued', { sessionId, promptId, clientId });
        }
        res.status(202).json({ promptId, lastEventId, eventEpoch });
      },
    ),
  );

  app.post(
    '/session/:id/generate',
    mutate(),
    withOwnerReadSession(
      'POST /session/:id/generate',
      async (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        const prompt = body['prompt'];
        if (
          typeof prompt !== 'string' ||
          prompt.trim().length === 0 ||
          Buffer.byteLength(prompt, 'utf8') > GENERATION_MAX_PROMPT_BYTES
        ) {
          res.status(400).json({
            error: `\`prompt\` must be a non-empty string no larger than ${GENERATION_MAX_PROMPT_BYTES} UTF-8 bytes`,
            code: 'invalid_prompt',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        if (!runtime.bridge.generateSessionContent) {
          res.status(501).json({
            error: 'Stateless generation is not supported by this bridge',
            code: 'generation_not_supported',
          });
          return;
        }

        const abort = new AbortController();
        let completed = false;
        const onClose = () => {
          if (!completed) abort.abort();
        };
        res.once('close', onClose);

        const stream = runtime.bridge.generateSessionContent(
          sessionId,
          prompt,
          abort.signal,
          clientId !== undefined ? { clientId } : undefined,
        );

        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        let writeChain = Promise.resolve();
        const write = (chunk: string): Promise<void> => {
          writeChain = writeChain.then(() =>
            writeGenerationSseChunk(res, chunk),
          );
          return writeChain;
        };
        await write(': connected\n\n');
        const heartbeat = setInterval(() => {
          void write(': heartbeat\n\n').catch(() => abort.abort());
        }, GENERATION_HEARTBEAT_MS);
        heartbeat.unref();

        try {
          for await (const event of stream) {
            await write(formatGenerationSse(event.type, event));
          }
        } catch (err) {
          if (!abort.signal.aborted && !res.destroyed) {
            daemonLog?.error(
              'session generation failed',
              err instanceof Error ? err : new Error(String(err)),
              { sessionId, clientId },
            );
            await write(
              formatGenerationSse('error', {
                type: 'error',
                code: 'generation_failed',
                message: 'Generation failed',
              }),
            ).catch(() => undefined);
          }
        } finally {
          completed = true;
          clearInterval(heartbeat);
          res.off('close', onClose);
          if (!res.destroyed) res.end();
        }
      },
    ),
  );

  app.post(
    '/session/:id/heartbeat',
    mutate(),
    (req, res, next) => {
      const sessionId = req.params['id'];
      const key = sessionId
        ? parseVirtualSubagentSessionId(sessionId)
        : undefined;
      if (!sessionId || !key) {
        next();
        return;
      }
      const runtime = requireSessionRuntime({
        sessionId: key.parentSessionId,
        route: 'POST /session/:id/heartbeat',
        res,
        workspaceRegistry,
        daemonLog,
      });
      if (!runtime) return;
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      res.status(200).json({
        sessionId,
        ...(clientId ? { clientId } : {}),
        lastSeenAt: Date.now(),
      });
    },
    withOwnerMutableSession(
      'POST /session/:id/heartbeat',
      (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const result = runtime.bridge.recordHeartbeat(
          sessionId,
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(result);
      },
    ),
  );

  app.post(
    '/session/:id/detach',
    mutate(),
    (req, res, next) => {
      const sessionId = req.params['id'];
      const key = sessionId
        ? parseVirtualSubagentSessionId(sessionId)
        : undefined;
      if (!sessionId || !key) {
        next();
        return;
      }
      const runtime = requireSessionRuntime({
        sessionId: key.parentSessionId,
        route: 'POST /session/:id/detach',
        res,
        workspaceRegistry,
        daemonLog,
      });
      if (!runtime) return;
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      res.status(204).end();
    },
    withOwnerMutableSession(
      'POST /session/:id/detach',
      async (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        await runtime.bridge.detachClient(sessionId, clientId);
        res.status(204).end();
      },
    ),
  );

  app.post(
    '/session/:id/cancel',
    mutate(),
    withOwnerMutableSession(
      'POST /session/:id/cancel',
      async (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        await runtime.bridge.cancelSession(
          sessionId,
          {
            ...(body as object),
            sessionId,
          } as Parameters<AcpSessionBridge['cancelSession']>[1],
          clientId !== undefined ? { clientId } : undefined,
        );
        if (daemonLog) {
          daemonLog.info('cancel sent', { sessionId, clientId });
        }
        res.status(204).end();
      },
    ),
  );

  app.delete('/session/:id', async (req, res) => {
    const sessionId = req.params['id'];
    if (rejectActiveLiveSessionMutation(res, [sessionId])) return;
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    const runtime = resolveLiveSessionRuntime(
      sessionId,
      res,
      'DELETE /session/:id',
    );
    if (!runtime) return;
    try {
      // ACP session/close can fall back to a shared gate because it has
      // connection-local promptAbort state; REST close does not.
      await runWithSessionListInvalidation(runtime, ['active'], () =>
        archiveCoordinator.runExclusiveMany([sessionId], async () =>
          runtime.bridge.closeSession(
            sessionId,
            clientId !== undefined ? { clientId } : undefined,
          ),
        ),
      );
      clearBranchSessionEntry(sessionId);
      res.status(204).end();
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'DELETE /session/:id',
        sessionId,
      });
    }
  });

  app.post('/sessions/delete', mutate(), async (req, res) => {
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    const uniqueIds = parseSessionIdsBody(req, res);
    if (uniqueIds === undefined) return;
    if (rejectActiveLiveSessionMutation(res, uniqueIds)) return;
    try {
      const operation = await deleteSessions(
        undefined,
        res,
        'POST /sessions/delete',
        uniqueIds,
      );
      if (!operation) return;
      const result = operation.internal
        ? {
            ...operation.result,
            errors: serializeSessionErrors(operation.result.errors, true),
          }
        : operation.result;
      for (const removedId of result.removed) {
        clearBranchSessionEntry(removedId);
      }
      res.status(200).json(result);
    } catch (err) {
      sendBridgeError(res, err, { route: 'POST /sessions/delete' });
    }
  });

  app.post('/sessions/archive', mutate(), async (req, res) => {
    const uniqueIds = parseSessionIdsBody(req, res);
    if (uniqueIds === undefined) return;
    if (rejectActiveLiveSessionMutation(res, uniqueIds)) return;

    try {
      const operation = await archiveSessions(
        undefined,
        res,
        'POST /sessions/archive',
        uniqueIds,
      );
      if (!operation) return;
      const { result } = operation;
      res.status(200).json({
        archived: result.archived,
        alreadyArchived: result.alreadyArchived,
        notFound: result.notFound,
        errors: serializeSessionErrors(result.errors, operation.internal),
      });
    } catch (err) {
      sendBridgeError(res, err, { route: 'POST /sessions/archive' });
    }
  });

  app.post('/sessions/unarchive', mutate(), async (req, res) => {
    const uniqueIds = parseSessionIdsBody(req, res);
    if (uniqueIds === undefined) return;

    try {
      const operation = await unarchiveSessions(
        undefined,
        res,
        'POST /sessions/unarchive',
        uniqueIds,
      );
      if (!operation) return;
      const { result } = operation;
      res.status(200).json({
        unarchived: result.unarchived,
        alreadyActive: result.alreadyActive,
        notFound: result.notFound,
        errors: serializeSessionErrors(result.errors, operation.internal),
      });
    } catch (err) {
      sendBridgeError(res, err, { route: 'POST /sessions/unarchive' });
    }
  });

  app.post(
    '/workspaces/:workspace/sessions/delete',
    mutate(),
    async (req, res) => {
      const route = 'POST /workspaces/:workspace/sessions/delete';
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      const uniqueIds = parseSessionIdsBody(req, res);
      if (uniqueIds === undefined) return;
      if (rejectActiveLiveSessionMutation(res, uniqueIds)) return;
      try {
        const operation = await deleteSessions(req, res, route, uniqueIds);
        if (!operation) return;
        const result = operation.internal
          ? {
              ...operation.result,
              errors: serializeSessionErrors(operation.result.errors, true),
            }
          : operation.result;
        for (const removedId of result.removed) {
          clearBranchSessionEntry(removedId);
        }
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, { route });
      }
    },
  );

  app.post(
    '/workspaces/:workspace/sessions/archive',
    mutate(),
    async (req, res) => {
      const route = 'POST /workspaces/:workspace/sessions/archive';
      const uniqueIds = parseSessionIdsBody(req, res);
      if (uniqueIds === undefined) return;
      if (rejectActiveLiveSessionMutation(res, uniqueIds)) return;
      try {
        const operation = await archiveSessions(req, res, route, uniqueIds);
        if (!operation) return;
        const { result } = operation;
        res.status(200).json({
          archived: result.archived,
          alreadyArchived: result.alreadyArchived,
          notFound: result.notFound,
          errors: serializeSessionErrors(result.errors, operation.internal),
        });
      } catch (err) {
        sendBridgeError(res, err, { route });
      }
    },
  );

  app.post(
    '/workspaces/:workspace/sessions/unarchive',
    mutate(),
    async (req, res) => {
      const route = 'POST /workspaces/:workspace/sessions/unarchive';
      const uniqueIds = parseSessionIdsBody(req, res);
      if (uniqueIds === undefined) return;
      try {
        const operation = await unarchiveSessions(req, res, route, uniqueIds);
        if (!operation) return;
        const { result } = operation;
        res.status(200).json({
          unarchived: result.unarchived,
          alreadyActive: result.alreadyActive,
          notFound: result.notFound,
          errors: serializeSessionErrors(result.errors, operation.internal),
        });
      } catch (err) {
        sendBridgeError(res, err, { route });
      }
    },
  );

  app.patch(
    '/session/:id/metadata',
    mutate({ strict: true }),
    withOwnerMutableSession(
      'PATCH /session/:id/metadata',
      (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const rawDisplayName = body['displayName'];
        if (
          rawDisplayName !== undefined &&
          typeof rawDisplayName !== 'string'
        ) {
          res.status(400).json({
            error: '`displayName` must be a string',
            code: 'invalid_metadata',
            field: 'displayName',
          });
          return;
        }
        const displayName =
          typeof rawDisplayName === 'string'
            ? rawDisplayName.slice(0, 256)
            : undefined;
        let effective: ReturnType<AcpSessionBridge['updateSessionMetadata']>;
        try {
          effective = runtime.bridge.updateSessionMetadata(
            sessionId,
            { displayName },
            clientId !== undefined ? { clientId } : undefined,
          );
        } finally {
          invalidateSessionLists(runtime, ['active']);
        }
        res.status(200).json({ sessionId, ...effective });
      },
    ),
  );

  app.patch(
    '/workspaces/:workspace/session/:id/metadata',
    mutate({ strict: true }),
    async (req, res) => {
      const route = 'PATCH /workspaces/:workspace/session/:id/metadata';
      const runtime = requireTrustedRuntimeForWorkspaceRoute(req, res, route);
      if (!runtime) return;
      const sessionId = requireSessionId(req, res);
      if (sessionId === null) return;
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      const rawDisplayName = safeBody(req)['displayName'];
      if (typeof rawDisplayName !== 'string') {
        res.status(400).json({
          error: '`displayName` must be a string',
          code: 'invalid_metadata',
          field: 'displayName',
        });
        return;
      }
      try {
        const displayName = rawDisplayName.slice(0, 256);
        if (displayName.trim() === '') {
          // An empty name would append an empty custom_title record to
          // persisted sessions, which the title readers disagree on.
          throw new InvalidSessionMetadataError(
            'displayName',
            'must not be empty',
          );
        }
        if (
          Array.from(displayName).some((character) => {
            const code = character.charCodeAt(0);
            return code <= 31 || code === 127;
          })
        ) {
          throw new InvalidSessionMetadataError(
            'displayName',
            'must not contain control characters',
          );
        }
        await archiveCoordinator.runExclusiveMany([sessionId], async () => {
          const assertRuntimeGenerationOpen =
            captureRuntimeGenerationAssertion(runtime);
          assertRuntimeGenerationOpen?.();
          const liveOwner =
            workspaceRegistry.resolveLiveSessionOwner(sessionId);
          if (liveOwner.kind === 'unavailable') {
            sendWorkspaceRuntimeUnavailable(res);
            return;
          }
          if (liveOwner.kind === 'ambiguous') {
            sendAmbiguousSessionOwner(
              res,
              route,
              sessionId,
              liveOwner.runtimes,
            );
            return;
          }
          if (
            liveOwner.kind === 'found' &&
            liveOwner.runtime.workspaceCwd !== runtime.workspaceCwd
          ) {
            sendSessionWorkspaceConflict(
              res,
              route,
              sessionId,
              runtime,
              liveOwner.runtime,
            );
            return;
          }
          await runWithWorkspaceRuntimeStorage(runtime, async () => {
            let effective: { displayName?: string };
            try {
              effective = runtime.bridge.updateSessionMetadata(
                sessionId,
                { displayName },
                clientId !== undefined ? { clientId } : undefined,
              );
              assertRuntimeGenerationOpen?.();
            } catch (err) {
              if (!(err instanceof SessionNotFoundError)) throw err;
              const service = createWorkspaceRuntimeSessionService(runtime);
              const location = await service.getSessionLocation(sessionId);
              assertRuntimeGenerationOpen?.();
              if (location === 'conflict') {
                throw new SessionConflictError(sessionId);
              }
              const renamed = location
                ? await service.renameSession(
                    sessionId,
                    displayName,
                    'manual',
                    location,
                  )
                : false;
              assertRuntimeGenerationOpen?.();
              if (!renamed) {
                throw new SessionNotFoundError(sessionId);
              }
              // The persisted rename appends a custom_title record the next
              // catalog scan serves, so this fallback must advance the same
              // catalog revision the live rename marks — otherwise
              // version-watching clients keep the stale name.
              runtime.bridge.markSessionCatalogChanged();
              effective = { displayName: displayName || undefined };
            }
            invalidateSessionLists(runtime, ['active', 'archived']);
            res.status(200).json({ sessionId, ...effective });
          });
        });
      } catch (err) {
        sendBridgeError(res, err, {
          route,
          sessionId,
          workspaceCwd: runtime.workspaceCwd,
        });
      }
    },
  );

  type SessionOrganizationTarget = {
    runtime?: WorkspaceRuntime;
    resolveRuntime?: (
      sessionId: string,
    ) => Promise<WorkspaceRuntime | undefined>;
    route: string;
  };

  const handleSessionOrganizationUpdate = async (
    req: Request,
    res: Response,
    target: SessionOrganizationTarget,
  ): Promise<void> => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    try {
      await archiveCoordinator.runSharedMany([sessionId], () =>
        (async () => {
          const runtime =
            target.runtime ?? (await target.resolveRuntime?.(sessionId));
          if (!runtime) return;
          const assertRuntimeGenerationOpen =
            captureRuntimeGenerationAssertion(runtime);
          assertRuntimeGenerationOpen?.();
          return runWithWorkspaceRuntimeStorage(runtime, async () => {
            // Organization is workspace-scoped sidecar state, not live-session
            // metadata. It intentionally applies to persisted and archived sessions.
            const sessionService =
              createWorkspaceRuntimeSessionService(runtime);
            let exists =
              await sessionService.sessionExistsInAnyState(sessionId);
            if (!exists) {
              try {
                const summary = runtime.bridge.getSessionSummary(sessionId);
                exists = summary.workspaceCwd === runtime.workspaceCwd;
              } catch {
                exists = false;
              }
            }
            if (!exists) {
              res.status(404).json({
                error: `No session with id "${sessionId}"`,
                sessionId,
              });
              return;
            }
            assertRuntimeGenerationOpen?.();

            const body = safeBody(req);
            const rawIsPinned = body['isPinned'];
            if (rawIsPinned !== undefined && typeof rawIsPinned !== 'boolean') {
              res.status(400).json({
                error: '`isPinned` must be a boolean',
                code: 'invalid_session_organization',
                field: 'isPinned',
              });
              return;
            }
            const rawGroupId = body['groupId'];
            if (
              rawGroupId !== undefined &&
              rawGroupId !== null &&
              typeof rawGroupId !== 'string'
            ) {
              res.status(400).json({
                error: '`groupId` must be a string or null',
                code: 'invalid_session_organization',
                field: 'groupId',
              });
              return;
            }
            const rawColor = body['color'];
            if (
              rawColor !== undefined &&
              rawColor !== null &&
              (typeof rawColor !== 'string' ||
                !GROUP_COLOR_OPTIONS.includes(
                  rawColor as SessionGroupPresetColor,
                ))
            ) {
              res.status(400).json({
                error: '`color` must be a supported color or null',
                code: 'invalid_session_organization',
                field: 'color',
              });
              return;
            }

            const organization = await createSessionOrganizationService(
              runtime.workspaceCwd,
            ).updateSessionOrganization(sessionId, {
              ...(rawIsPinned !== undefined ? { isPinned: rawIsPinned } : {}),
              ...(rawGroupId !== undefined
                ? { groupId: rawGroupId as string | null }
                : {}),
              ...(rawColor !== undefined
                ? { color: rawColor as SessionGroupPresetColor | null }
                : {}),
            });
            invalidateSessionListsAndMarkCatalog(runtime, [
              'active',
              'archived',
            ]);
            res.status(200).json({ sessionId, ...organization });
          });
        })(),
      );
    } catch (err) {
      if (sendSessionOrganizationError(res, err)) return;
      sendBridgeError(res, err, {
        route: target.route,
        sessionId,
        ...(target.runtime
          ? { workspaceCwd: target.runtime.workspaceCwd }
          : {}),
      });
    }
  };

  app.patch('/session/:id/organization', mutate(), async (req, res) => {
    await handleSessionOrganizationUpdate(req, res, {
      route: 'PATCH /session/:id/organization',
      resolveRuntime: (sessionId) =>
        resolveSessionAnyStateRuntime(
          res,
          'PATCH /session/:id/organization',
          sessionId,
        ),
    });
  });

  app.patch(
    '/workspaces/:workspace/session/:id/organization',
    mutate(),
    async (req, res) => {
      const route = 'PATCH /workspaces/:workspace/session/:id/organization';
      await handleSessionOrganizationUpdate(req, res, {
        route,
        resolveRuntime: (sessionId) =>
          resolveQualifiedSessionRuntime(req, res, route, [sessionId], 'any'),
      });
    },
  );

  app.get('/workspace/:id/session-groups', async (req, res) => {
    // Preserve the legacy singular-route behavior for an untrusted primary;
    // plural catalog routes intentionally retain their trust gate.
    const runtime = resolveRuntimeFromWorkspaceParam(req, res);
    if (runtime === null) return;
    try {
      res
        .status(200)
        .json(
          await runWorkspaceInspectionWithLogPolicy(runtime, () =>
            createSessionOrganizationService(runtime.workspaceCwd).listGroups(),
          ),
        );
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /workspace/:id/session-groups',
      });
    }
  });

  app.post('/workspace/:id/session-groups', mutate(), async (req, res) => {
    const runtime = resolveLegacyPrimaryRuntimeFromParam(req, res);
    if (runtime === null) return;
    const body = safeBody(req);
    try {
      const group = await runWithWorkspaceRuntimeStorage(runtime, () =>
        createSessionOrganizationService(runtime.workspaceCwd).createGroup({
          name: body['name'] as string,
          color: body['color'] as SessionGroupColor,
        }),
      );
      invalidateSessionListsAndMarkCatalog(runtime, ['active', 'archived']);
      res.status(201).json({ group });
    } catch (err) {
      if (sendSessionOrganizationError(res, err)) return;
      sendBridgeError(res, err, {
        route: 'POST /workspace/:id/session-groups',
      });
    }
  });

  app.patch(
    '/workspace/:id/session-groups/:groupId',
    mutate(),
    async (req, res) => {
      const runtime = resolveLegacyPrimaryRuntimeFromParam(req, res);
      if (runtime === null) return;
      const body = safeBody(req);
      try {
        const group = await runWithWorkspaceRuntimeStorage(runtime, () =>
          createSessionOrganizationService(runtime.workspaceCwd).updateGroup(
            req.params['groupId'] ?? '',
            {
              ...(Object.prototype.hasOwnProperty.call(body, 'name')
                ? { name: body['name'] as string }
                : {}),
              ...(Object.prototype.hasOwnProperty.call(body, 'color')
                ? { color: body['color'] as SessionGroupColor }
                : {}),
              ...(Object.prototype.hasOwnProperty.call(body, 'order')
                ? { order: body['order'] as number }
                : {}),
            },
          ),
        );
        invalidateSessionListsAndMarkCatalog(runtime, ['active', 'archived']);
        res.status(200).json({ group });
      } catch (err) {
        if (sendSessionOrganizationError(res, err)) return;
        sendBridgeError(res, err, {
          route: 'PATCH /workspace/:id/session-groups/:groupId',
        });
      }
    },
  );

  app.delete(
    '/workspace/:id/session-groups/:groupId',
    mutate(),
    async (req, res) => {
      const runtime = resolveLegacyPrimaryRuntimeFromParam(req, res);
      if (runtime === null) return;
      try {
        const deleted = await runWithWorkspaceRuntimeStorage(runtime, () =>
          createSessionOrganizationService(runtime.workspaceCwd).deleteGroup(
            req.params['groupId'] ?? '',
          ),
        );
        // A delete that reports `deleted: false` changed nothing and must
        // not advance the catalog version.
        if (deleted) {
          invalidateSessionListsAndMarkCatalog(runtime, ['active', 'archived']);
        }
        res.status(200).json({ deleted });
      } catch (err) {
        if (sendSessionOrganizationError(res, err)) return;
        sendBridgeError(res, err, {
          route: 'DELETE /workspace/:id/session-groups/:groupId',
        });
      }
    },
  );

  app.get('/workspaces/:workspace/session-groups', async (req, res) => {
    const route = 'GET /workspaces/:workspace/session-groups';
    const runtime = resolveRuntimeForCatalogRoute(req, res, 'workspace', route);
    if (!runtime) return;
    try {
      res
        .status(200)
        .json(
          await runWorkspaceInspectionWithLogPolicy(runtime, () =>
            createSessionOrganizationService(runtime.workspaceCwd).listGroups(),
          ),
        );
    } catch (err) {
      sendBridgeError(res, err, { route });
    }
  });

  app.post(
    '/workspaces/:workspace/session-groups',
    mutate(),
    async (req, res) => {
      const route = 'POST /workspaces/:workspace/session-groups';
      const runtime = requireTrustedRuntimeForWorkspaceRoute(req, res, route);
      if (!runtime) return;
      const body = safeBody(req);
      try {
        const group = await runWithWorkspaceRuntimeStorage(runtime, () =>
          createSessionOrganizationService(runtime.workspaceCwd).createGroup({
            name: body['name'] as string,
            color: body['color'] as SessionGroupColor,
          }),
        );
        invalidateSessionListsAndMarkCatalog(runtime, ['active', 'archived']);
        res.status(201).json({ group });
      } catch (err) {
        if (sendSessionOrganizationError(res, err)) return;
        sendBridgeError(res, err, { route });
      }
    },
  );

  app.patch(
    '/workspaces/:workspace/session-groups/:groupId',
    mutate(),
    async (req, res) => {
      const route = 'PATCH /workspaces/:workspace/session-groups/:groupId';
      const runtime = requireTrustedRuntimeForWorkspaceRoute(req, res, route);
      if (!runtime) return;
      const body = safeBody(req);
      try {
        const group = await runWithWorkspaceRuntimeStorage(runtime, () =>
          createSessionOrganizationService(runtime.workspaceCwd).updateGroup(
            req.params['groupId'] ?? '',
            {
              ...(Object.prototype.hasOwnProperty.call(body, 'name')
                ? { name: body['name'] as string }
                : {}),
              ...(Object.prototype.hasOwnProperty.call(body, 'color')
                ? { color: body['color'] as SessionGroupColor }
                : {}),
              ...(Object.prototype.hasOwnProperty.call(body, 'order')
                ? { order: body['order'] as number }
                : {}),
            },
          ),
        );
        invalidateSessionListsAndMarkCatalog(runtime, ['active', 'archived']);
        res.status(200).json({ group });
      } catch (err) {
        if (sendSessionOrganizationError(res, err)) return;
        sendBridgeError(res, err, { route });
      }
    },
  );

  app.delete(
    '/workspaces/:workspace/session-groups/:groupId',
    mutate(),
    async (req, res) => {
      const route = 'DELETE /workspaces/:workspace/session-groups/:groupId';
      const runtime = requireTrustedRuntimeForWorkspaceRoute(req, res, route);
      if (!runtime) return;
      try {
        const deleted = await runWithWorkspaceRuntimeStorage(runtime, () =>
          createSessionOrganizationService(runtime.workspaceCwd).deleteGroup(
            req.params['groupId'] ?? '',
          ),
        );
        // A delete that reports `deleted: false` changed nothing and must
        // not advance the catalog version.
        if (deleted) {
          invalidateSessionListsAndMarkCatalog(runtime, ['active', 'archived']);
        }
        res.status(200).json({ deleted });
      } catch (err) {
        if (sendSessionOrganizationError(res, err)) return;
        sendBridgeError(res, err, { route });
      }
    },
  );

  const listWorkspaceSessionsHandler =
    (paramName: 'id' | 'workspace'): RequestHandler =>
    async (req, res) => {
      const route =
        paramName === 'workspace'
          ? 'GET /workspaces/:workspace/sessions'
          : 'GET /workspace/:id/sessions';
      // Express decodes URL-encoded path params automatically; clients pass
      // the absolute workspace cwd encoded (e.g.
      // GET /workspace/%2Fwork%2Fa/sessions).
      const liveRuntime = await resolveLiveCatalogRuntime(req, res, paramName);
      if (liveRuntime === null) return;
      const runtime =
        liveRuntime ??
        resolveRuntimeForCatalogRoute(req, res, paramName, route);
      if (runtime === null) return;
      const key = runtime.workspaceCwd;
      const readOnlySecondary = isReadOnlyWorkspaceInspection(runtime);
      try {
        const cursor =
          typeof req.query['cursor'] === 'string'
            ? req.query['cursor']
            : undefined;
        const size = parseSessionPageSizeQuery(req.query['size']);
        const rawView = req.query['view'];
        let view: 'organized' | undefined;
        if (rawView !== undefined) {
          if (rawView !== 'organized') {
            res.status(400).json({
              error: '`view` must be "organized"',
              code: 'invalid_session_view',
            });
            return;
          }
          view = 'organized';
        }
        const group =
          typeof req.query['group'] === 'string'
            ? req.query['group']
            : undefined;
        if (group !== undefined && view !== 'organized') {
          res.status(400).json({
            error: '`group` requires `view=organized`',
            code: 'invalid_session_group_filter',
          });
          return;
        }
        const rawArchiveState = req.query['archiveState'];
        let archiveState: SessionArchiveState | undefined;
        if (rawArchiveState !== undefined) {
          if (
            typeof rawArchiveState !== 'string' ||
            (rawArchiveState !== 'active' && rawArchiveState !== 'archived')
          ) {
            res.status(400).json({
              error: '`archiveState` must be "active" or "archived"',
              code: 'invalid_archive_state',
            });
            return;
          }
          archiveState = rawArchiveState;
        }
        const rawParentSessionId = req.query['parentSessionId'];
        let parentSessionId: string | undefined;
        if (rawParentSessionId !== undefined) {
          if (
            typeof rawParentSessionId !== 'string' ||
            rawParentSessionId.length === 0
          ) {
            res.status(400).json({
              error: '`parentSessionId` must be a non-empty string',
              code: 'invalid_parent_session_id',
            });
            return;
          }
          if (view === 'organized') {
            res.status(400).json({
              error: '`parentSessionId` is not supported with `view=organized`',
              code: 'invalid_parent_session_filter',
            });
            return;
          }
          parentSessionId = rawParentSessionId;
        }
        const parsedSource = parseSessionSource(
          req.query['sourceType'],
          req.query['sourceId'],
        );
        if ('error' in parsedSource) {
          res.status(400).json({
            error: parsedSource.error,
            code: 'invalid_session_source',
          });
          return;
        }
        const options = {
          ...(cursor !== undefined ? { cursor } : {}),
          ...(size !== undefined ? { size } : {}),
          ...(archiveState !== undefined ? { archiveState } : {}),
          ...(view !== undefined ? { view } : {}),
          ...(group !== undefined ? { group } : {}),
          ...(parentSessionId !== undefined ? { parentSessionId } : {}),
          ...parsedSource,
        };
        const controller = new AbortController();
        const onRequestAborted = () => {
          controller.abort(new DOMException('Request aborted', 'AbortError'));
        };
        const onResponseClosed = () => {
          if (!res.writableEnded) {
            controller.abort(new DOMException('Response closed', 'AbortError'));
          }
        };
        req.once('aborted', onRequestAborted);
        res.once('close', onResponseClosed);
        if (req.aborted || res.destroyed) onRequestAborted();
        try {
          // Organized/archived views always need the persisted store: organized
          // cursors are opaque (non-numeric) and archived-only workspaces have no
          // active persisted sessions, so the live-only fallback would drop them.
          // Metadata filters gather the whole workspace
          // (persisted + live) to filter completely and paginates with an opaque
          // activity cursor, so the numeric-cursor live fallback can't serve it.
          const usePersisted =
            readOnlySecondary ||
            runtime.primary ||
            view === 'organized' ||
            archiveState === 'archived' ||
            parentSessionId !== undefined ||
            parsedSource.sourceType !== undefined ||
            (cursor !== undefined && cursor !== ''
              ? isNumericSessionCursor(cursor)
              : await hasActivePersistedSessions(runtime, controller.signal));
          // The live path only reads cursor/size; persisted-only options
          // (organized view or archived state) would be silently dropped there.
          // usePersisted already routes those to the persisted path — assert it so
          // a future option added to validation but not to that gate fails loudly.
          if (
            !usePersisted &&
            (view !== undefined ||
              archiveState === 'archived' ||
              parentSessionId !== undefined ||
              parsedSource.sourceType !== undefined)
          ) {
            throw new Error(
              'session list live path received persisted-only options',
            );
          }
          const listSessions = () =>
            usePersisted
              ? runWorkspaceInspectionWithLogPolicy(runtime, () =>
                  listWorkspaceSessionsForResponse(
                    runtime.bridge,
                    key,
                    options,
                    {
                      mergeLive: !readOnlySecondary,
                      runtimeBaseDir: runtime.sessionRuntimeBaseDir,
                      signal: controller.signal,
                    },
                  ),
                )
              : Promise.resolve(
                  listLiveWorkspaceSessionsForResponse(
                    runtime.bridge,
                    key,
                    options,
                  ),
                );
          const result =
            liveRuntime && deps.conversationRuntimeActivity
              ? await deps.conversationRuntimeActivity.run(listSessions)
              : await listSessions();
          controller.signal.throwIfAborted();
          if (res.destroyed) return;
          res.status(200).json({
            sessions: result.sessions,
            ...(result.nextCursor != null
              ? { nextCursor: result.nextCursor }
              : {}),
            ...(result.liveMergeFailed ? { liveMergeFailed: true } : {}),
            ...(result.truncated ? { truncated: true } : {}),
          });
        } catch (err) {
          if (controller.signal.aborted || res.destroyed) {
            return;
          }
          throw err;
        } finally {
          req.off('aborted', onRequestAborted);
          res.off('close', onResponseClosed);
        }
      } catch (err) {
        if (
          err &&
          typeof err === 'object' &&
          (err as { code?: unknown }).code === 'daemon_draining'
        ) {
          res.status(503).json({
            error: 'The daemon is draining and no longer accepts work.',
            code: 'daemon_draining',
          });
          return;
        }
        if (err instanceof InvalidCursorError) {
          res.status(400).json({
            error: err.message,
            code: 'invalid_cursor',
          });
          return;
        }
        if (sendSessionOrganizationError(res, err)) return;
        writeStderrLine(
          `qwen serve: failed to list sessions for workspace ${safeLogValue(
            key,
          )} (options=${safeLogValue(
            JSON.stringify({
              view: req.query['view'],
              archiveState: req.query['archiveState'],
              group: req.query['group'],
            }),
          )}): ${safeLogValue(
            err instanceof Error ? err.message : String(err),
          )}`,
        );
        res.status(500).json({
          error: 'Failed to list sessions',
          code: 'session_list_failed',
        });
      }
    };

  app.get('/workspace/:id/sessions', listWorkspaceSessionsHandler('id'));
  app.get(
    '/workspaces/:workspace/sessions',
    listWorkspaceSessionsHandler('workspace'),
  );

  // Last catalog version successfully exposed per bridge by the live-state
  // route. A newly observed version synchronously invalidates the persisted
  // catalog cache scopes before the version is answered, so a client that
  // reconciles with the `live A -> full catalog -> live B` handshake can
  // never load a catalog snapshot that predates the version it observed.
  // WeakMap: replaced bridges (runtime replacement) drop with the instance.
  const lastExposedCatalogVersions = new WeakMap<
    AcpSessionBridge,
    BridgeSessionCatalogVersion
  >();

  app.get('/workspaces/:workspace/sessions/live-state', async (req, res) => {
    const route = 'GET /workspaces/:workspace/sessions/live-state';
    // Strict trust gate: live state is never read from an untrusted
    // runtime, and an unknown selector never falls back to primary.
    const runtime = requireTrustedRuntimeForWorkspaceRoute(req, res, route);
    if (runtime === null) return;
    const assertRuntimeOpen = captureRuntimeGenerationAssertion(runtime);
    const bridge = runtime.bridge;
    try {
      assertRuntimeOpen?.();
      const catalogVersion = bridge.getSessionCatalogVersion();
      const lastExposed = lastExposedCatalogVersions.get(bridge);
      if (
        lastExposed === undefined ||
        lastExposed.generation !== catalogVersion.generation ||
        lastExposed.revision !== catalogVersion.revision
      ) {
        invalidateSessionLists(runtime, ['active', 'archived']);
      }
      const sessions = bridge
        .listWorkspaceSessions(runtime.workspaceCwd)
        .map((session) => ({
          sessionId: session.sessionId,
          clientCount: session.clientCount,
          hasActivePrompt: session.hasActivePrompt,
          isWaitingForPermission: session.isWaitingForPermission ?? false,
          isWaitingForUserQuestion: session.isWaitingForUserQuestion ?? false,
        }));
      assertRuntimeOpen?.();
      lastExposedCatalogVersions.set(bridge, catalogVersion);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ v: 1, catalogVersion, sessions });
    } catch (err) {
      sendBridgeError(res, err, { route });
    }
  });

  const workspaceSessionInfoHandler =
    (paramName: 'id' | 'workspace'): RequestHandler =>
    async (req, res) => {
      const route =
        paramName === 'workspace'
          ? 'GET /workspaces/:workspace/session-info'
          : 'GET /workspace/:id/session-info';
      const runtime = resolveRuntimeForCatalogRoute(req, res, paramName, route);
      if (runtime === null) return;
      const key = runtime.workspaceCwd;
      try {
        // Disk-scan aggregate: do not call this from hot paths / UI polls.
        const info = await runWorkspaceInspectionWithLogPolicy(runtime, () =>
          getWorkspaceSessionInfoForResponse(runtime.bridge, key, {
            includeLive: !isReadOnlyWorkspaceInspection(runtime),
          }),
        );
        res.status(200).json(info);
      } catch (err) {
        writeStderrLine(
          `qwen serve: failed to read session-info for workspace ${safeLogValue(
            key,
          )}: ${safeLogValue(err instanceof Error ? err.message : String(err))}`,
        );
        res.status(500).json({
          error: 'Failed to read session info',
          code: 'session_info_failed',
        });
      }
    };

  app.get('/workspace/:id/session-info', workspaceSessionInfoHandler('id'));
  app.get(
    '/workspaces/:workspace/session-info',
    workspaceSessionInfoHandler('workspace'),
  );

  app.post(
    '/session/:id/model',
    mutate(),
    withOwnerMutableSession(
      'POST /session/:id/model',
      async (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        const modelId = body['modelId'];
        if (typeof modelId !== 'string' || !modelId) {
          res.status(400).json({
            error: '`modelId` is required and must be a non-empty string',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const response = await runtime.bridge.setSessionModel(
          sessionId,
          {
            ...(body as object),
            sessionId,
            modelId,
          } as Parameters<AcpSessionBridge['setSessionModel']>[1],
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(response);
      },
    ),
  );

  app.post(
    '/session/:id/config-option',
    mutate(),
    withOwnerMutableSession(
      'POST /session/:id/config-option',
      async (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        const configId = body['configId'];
        const value = body['value'];
        if (configId !== 'reasoning_effort') {
          res.status(400).json({
            error: '`configId` must be reasoning_effort',
          });
          return;
        }
        if (typeof value !== 'string' || !value) {
          res.status(400).json({
            error: '`value` is required and must be a non-empty string',
          });
          return;
        }
        const response = await runtime.bridge.setSessionConfigOption(
          sessionId,
          { sessionId, configId, value },
        );
        res.status(200).json(response);
      },
    ),
  );

  app.post(
    '/session/:id/recap',
    mutate(),
    withOwnerMutableSession(
      'POST /session/:id/recap',
      async (req, res, sessionId, runtime) => {
        // Wraps `generateSessionRecap` so daemon clients can fetch a
        // one-sentence "where did I leave off" summary without a full
        // prompt turn. Best-effort — `recap: null` on short history or
        // transient model failure is a normal 200, not an error.
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const response = await runtime.bridge.generateSessionRecap(
          sessionId,
          clientId !== undefined ? { clientId } : undefined,
        );
        if (daemonLog) {
          const recap = response.recap;
          daemonLog.info(
            recap
              ? `recap generated len=${recap.length}`
              : 'recap returned null',
            { sessionId, clientId },
          );
        }
        res.status(200).json(response);
      },
    ),
  );

  app.post(
    '/session/:id/btw',
    mutate(),
    withOwnerMutableSession(
      'POST /session/:id/btw',
      async (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        const question = body['question'];
        if (
          typeof question !== 'string' ||
          question.trim().length === 0 ||
          question.length > BTW_MAX_INPUT_LENGTH
        ) {
          res.status(400).json({
            error: `\`question\` is required, must be a non-empty string, and at most ${BTW_MAX_INPUT_LENGTH} characters`,
          });
          return;
        }
        const abort = new AbortController();
        const onResClose = () => {
          if (!res.writableEnded) abort.abort();
        };
        res.once('close', onResClose);
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) {
          res.off('close', onResClose);
          return;
        }
        try {
          const result = await runtime.bridge.generateSessionBtw(
            sessionId,
            question.trim(),
            abort.signal,
            clientId !== undefined ? { clientId } : undefined,
          );
          res.status(200).json(result);
        } catch (err) {
          if (
            err instanceof DOMException &&
            err.name === 'AbortError' &&
            abort.signal.aborted
          ) {
            return;
          }
          sendBridgeError(res, err, {
            route: 'POST /session/:id/btw',
            sessionId,
          });
        } finally {
          res.off('close', onResClose);
        }
      },
    ),
  );

  // Queue a user message typed while the session's turn is still running. The
  // ACP child drains it between tool batches (`craft/drainMidTurnQueue`) so the
  // model sees it before the turn ends, instead of waiting for the next turn.
  // Returns `{ accepted, messageId? }`. Accepted requests are owned by the
  // daemon; rejected requests were not admitted. Synchronous — the bridge only
  // mutates its in-memory session queues.
  //
  // Per-message abuse guard. The sibling `/btw` caps its field; without this
  // only the global 10 MB body limit applies. It bounds how much a single
  // mid-turn push can pin in memory; queue depth is bounded separately in
  // `enqueueMidTurnMessage`.
  const MID_TURN_MESSAGE_MAX_LENGTH = 16 * 1024;
  app.post(
    '/session/:id/mid-turn-message',
    mutate(),
    withOwnerMutableSession(
      'POST /session/:id/mid-turn-message',
      (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        const message = body['message'];
        const messageId = body['messageId'];
        // Validate (and length-check, and enqueue) the TRIMMED value — the bridge
        // stores the trimmed string, so checking the raw length would reject input
        // whose real content fits but is padded with whitespace.
        const trimmed = typeof message === 'string' ? message.trim() : '';
        // Optional image blocks injected mid-turn alongside the
        // text. Validate strictly here — the ACP child silently drops blocks
        // that fail its own `isContentBlock` check, so a malformed block would
        // vanish from the turn without any error. Media size is bounded by the
        // global request body limit.
        const rawContent = body['content'];
        let mediaBlocks: BridgePromptContentBlock[] | undefined;
        if (rawContent !== undefined) {
          if (!Array.isArray(rawContent) || rawContent.length === 0) {
            res.status(400).json({
              error: '`content` must be a non-empty array of media blocks',
            });
            return;
          }
          if (rawContent.length > MEDIA_CONTENT_MAX_BLOCKS) {
            res.status(400).json({
              error: `\`content\` must carry at most ${MEDIA_CONTENT_MAX_BLOCKS} media blocks`,
            });
            return;
          }
          mediaBlocks = [];
          for (const block of rawContent) {
            const parsed = parseMediaContentBlock(block);
            if (!parsed.valid) {
              res.status(400).json({
                error: mediaBlockParseError(parsed.code, '`content` entry'),
              });
              return;
            }
            mediaBlocks.push(parsed.block);
          }
        }
        if (trimmed.length === 0 && mediaBlocks === undefined) {
          res.status(400).json({
            error:
              '`message` must be a non-empty string, or `content` must carry at least one media block',
          });
          return;
        }
        if (trimmed.length > MID_TURN_MESSAGE_MAX_LENGTH) {
          res.status(400).json({
            error: `\`message\` must be at most ${MID_TURN_MESSAGE_MAX_LENGTH} characters`,
          });
          return;
        }
        if (
          messageId !== undefined &&
          (typeof messageId !== 'string' ||
            messageId.length === 0 ||
            messageId.length > 128)
        ) {
          res.status(400).json({
            error:
              '`messageId` must be a non-empty string of at most 128 characters',
          });
          return;
        }
        // Forward the client id so the bridge authorizes it against the session
        // (like `/prompt` and `/btw`) — a token-holding client bound to another
        // session must not push into this one — and records it as the message's
        // originator for SSE echo routing. `null` = malformed id (already answered).
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const result = runtime.bridge.enqueueMidTurnMessage(
          sessionId,
          trimmed,
          clientId !== undefined ? { clientId } : undefined,
          typeof messageId === 'string' ? messageId : undefined,
          mediaBlocks ? { content: mediaBlocks } : undefined,
        );
        res.status(200).json(result);
      },
    ),
  );

  app.delete(
    '/session/:id/mid-turn-messages/:messageId',
    mutate(),
    withOwnerMutableSession(
      'DELETE /session/:id/mid-turn-messages/:messageId',
      (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const messageId = req.params['messageId'];
        if (!messageId) {
          res
            .status(400)
            .json({ error: '`messageId` route parameter is required' });
          return;
        }
        const result = runtime.bridge.removeMidTurnMessage(
          sessionId,
          messageId,
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(result);
      },
    ),
  );

  // Session-owned mid-turn snapshot: messages still waiting plus bounded
  // terminal id rings. Query-capable clients project it after refresh,
  // session switches, or missed events. Older daemons lack this route and
  // retain the legacy client-side fallback.
  app.get('/session/:id/mid-turn-messages', (req, res) => {
    const route = 'GET /session/:id/mid-turn-messages';
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const runtime = resolveLiveSessionRuntime(sessionId, res, route);
    if (!runtime) return;
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      const snapshot = runtime.bridge.getMidTurnMessages(
        sessionId,
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(200).json(snapshot);
    } catch (err) {
      sendBridgeError(res, err, { route, sessionId });
    }
  });

  // Pending prompt queue: list and remove.
  app.get('/session/:id/pending-prompts', (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const runtime = resolveLiveSessionRuntime(
      sessionId,
      res,
      'GET /session/:id/pending-prompts',
    );
    if (!runtime) return;
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      const pendingPrompts = runtime.bridge.getPendingPrompts(
        sessionId,
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(200).json({ pendingPrompts });
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/pending-prompts',
        sessionId,
      });
    }
  });

  app.delete(
    '/session/:id/pending-prompts/:promptId',
    mutate(),
    withOwnerMutableSession(
      'DELETE /session/:id/pending-prompts/:promptId',
      (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const promptId = req.params['promptId'];
        if (!promptId) {
          res
            .status(400)
            .json({ error: '`promptId` route parameter is required' });
          return;
        }
        const result = runtime.bridge.removePendingPrompt(
          sessionId,
          promptId,
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(result);
      },
    ),
  );

  app.post(
    '/session/:id/shell',
    mutate({ strict: true }),
    withOwnerMutableSession(
      'POST /session/:id/shell',
      async (req, res, sessionId, runtime) => {
        if (!sessionShellCommandEnabled) {
          sendBridgeError(res, new SessionShellDisabledError(), {
            route: 'POST /session/:id/shell',
            sessionId,
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) {
          return;
        }
        if (clientId === undefined) {
          sendBridgeError(res, new SessionShellClientRequiredError(), {
            route: 'POST /session/:id/shell',
            sessionId,
          });
          return;
        }
        const body = safeBody(req);
        const command = body['command'];
        if (typeof command !== 'string' || command.trim().length === 0) {
          res.status(400).json({
            error: '`command` is required and must be a non-empty string',
          });
          return;
        }
        const abort = new AbortController();
        const onResClose = () => {
          if (!res.writableEnded) abort.abort();
        };
        res.once('close', onResClose);
        try {
          const result = await runtime.bridge.executeShellCommand(
            sessionId,
            command.trim(),
            abort.signal,
            { clientId },
          );
          if (daemonLog) {
            daemonLog.info('shell command completed', {
              sessionId,
              clientId,
              exitCode: result.exitCode,
              workspaceId: runtime.workspaceId,
              workspaceCwd: runtime.workspaceCwd,
            });
          }
          res.status(200).json(result);
        } catch (err) {
          if (
            err instanceof DOMException &&
            err.name === 'AbortError' &&
            abort.signal.aborted
          ) {
            return;
          }
          sendBridgeError(res, err, {
            route: 'POST /session/:id/shell',
            sessionId,
          });
        } finally {
          res.off('close', onResClose);
        }
      },
    ),
  );

  app.get(
    '/session/:id/rewind/snapshots',
    withOwnerReadSession(
      'GET /session/:id/rewind/snapshots',
      async (_req, res, sessionId, runtime) => {
        const response = await runtime.bridge.getRewindSnapshots(sessionId);
        if (daemonLog) {
          daemonLog.info('rewind snapshots loaded', {
            sessionId,
            snapshotCount: response.snapshots.length,
            workspaceId: runtime.workspaceId,
            workspaceCwd: runtime.workspaceCwd,
          });
        }
        res.status(200).json(response);
      },
    ),
  );

  app.post(
    '/session/:id/rewind',
    mutate({ strict: true }),
    withOwnerMutableSession(
      'POST /session/:id/rewind',
      async (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        const promptId = body['promptId'];
        if (typeof promptId !== 'string' || promptId.length === 0) {
          res.status(400).json({
            error: '`promptId` is required and must be a non-empty string',
            code: 'missing_prompt_id',
          });
          return;
        }
        const rewindFiles = body['rewindFiles'];
        if (rewindFiles !== undefined && typeof rewindFiles !== 'boolean') {
          res.status(400).json({
            error: '`rewindFiles` must be a boolean when provided',
            code: 'invalid_rewind_files_flag',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const response = await runtime.bridge.rewindSession(
          sessionId,
          { promptId, rewindFiles: rewindFiles !== false },
          clientId !== undefined ? { clientId } : undefined,
        );
        if (daemonLog) {
          daemonLog.info('session rewind completed', {
            sessionId,
            promptId,
            rewindFiles: rewindFiles !== false,
            rewound: response.rewound,
            filesChangedCount: response.filesChanged.length,
            filesFailedCount: response.filesFailed.length,
            workspaceId: runtime.workspaceId,
            workspaceCwd: runtime.workspaceCwd,
          });
        }
        res.status(200).json(response);
      },
    ),
  );

  app.post(
    '/session/:id/approval-mode',
    mutate(),
    withOwnerMutableSession(
      'POST /session/:id/approval-mode',
      async (req, res, sessionId, runtime) => {
        // Validates `mode` against `APPROVAL_MODES` and an optional
        // `persist: boolean` flag.
        const body = safeBody(req);
        const mode = body['mode'];
        const persist = body['persist'];
        if (
          typeof mode !== 'string' ||
          !APPROVAL_MODES.includes(mode as ApprovalMode)
        ) {
          res.status(400).json({
            error: '`mode` is required and must be one of the allowed values',
            code: 'invalid_approval_mode',
            allowed: APPROVAL_MODES,
          });
          return;
        }
        if (persist !== undefined && typeof persist !== 'boolean') {
          res.status(400).json({
            error: '`persist` must be a boolean when provided',
            code: 'invalid_persist_flag',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const response = await runtime.bridge.setSessionApprovalMode(
          sessionId,
          mode as ApprovalMode,
          { persist: persist === true },
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(response);
      },
    ),
  );

  app.post(
    '/session/:id/language',
    mutate(),
    withOwnerMutableSession(
      'POST /session/:id/language',
      async (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        const language = body['language'];
        const syncOutputLanguage = body['syncOutputLanguage'];

        if (
          typeof language !== 'string' ||
          !LANGUAGE_CODES.includes(language)
        ) {
          res.status(400).json({
            error:
              '`language` is required and must be one of: ' +
              LANGUAGE_CODES.join(', '),
            code: 'invalid_language',
            allowed: LANGUAGE_CODES,
          });
          return;
        }

        if (
          syncOutputLanguage !== undefined &&
          typeof syncOutputLanguage !== 'boolean'
        ) {
          res.status(400).json({
            error: '`syncOutputLanguage` must be a boolean when provided',
            code: 'invalid_sync_flag',
          });
          return;
        }

        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;

        const response = await runtime.bridge.setSessionLanguage(
          sessionId,
          {
            language,
            syncOutputLanguage: syncOutputLanguage === true,
          },
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(response);
      },
    ),
  );
}
