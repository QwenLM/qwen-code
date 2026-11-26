/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isSessionStartupConfigError,
  parseSessionStartupConfig,
} from '@qwen-code/acp-bridge/sessionStartupConfig';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  hashDaemonWorkspace,
  withDaemonSpan,
} from '@qwen-code/qwen-code-core/telemetry/daemon-tracing.js';
import { GENERATED_UI_CARD_ID_PATTERN } from '@qwen-code/qwen-code-core/services/generated-ui-state.js';
import { parseLineTolerantWithIntegrity } from '@qwen-code/qwen-code-core/utils/jsonl-utils.js';
import { writeSessionBranchSidecar } from '@qwen-code/qwen-code-core/services/session-branch-sidecar.js';
import { encodeSessionTranscriptCursor } from '@qwen-code/qwen-code-core/services/session-transcript-reader.js';
import type { SessionTranscriptCursorState } from '@qwen-code/qwen-code-core/services/session-transcript-reader.js';
import {
  APPROVAL_MODES,
  AGENT_WORKTREE_SLUG_PATTERN,
  BTW_MAX_INPUT_LENGTH,
  CARRIED_PATHS_MAX_BYTES,
  GROUP_COLOR_OPTIONS,
  GitWorktreeService,
  WorktreeDirtyCarryConflictError,
  clearWorktreeSessionDurable,
  createWorktreeSession,
  createWorktreeSessionMarker,
  worktreeBranchForSlug,
  SessionOrganizationError,
  SessionIdCaseConflictError,
  SessionStorageEntryError,
  SessionTranscriptChangedError,
  SessionTranscriptIdentityUnavailableError,
  SESSION_TRANSCRIPT_MAX_LIMIT,
  SESSION_TRANSCRIPT_MAX_EXPANDED_PAGE_BYTES,
  SESSION_TRANSCRIPT_MAX_PAGE_BYTES,
  SessionTranscriptPageTooLargeError,
  SessionTranscriptCursorCodec,
  SessionTranscriptReader,
  SessionTranscriptSnapshotUnavailableError,
  addDaemonRequestAttribute,
  runWithoutDebugLogSession,
  createWorktreeSessionMarkerExclusive,
  readWorktreeSessionMarkerStrict,
  readWorktreeSessionStrict,
  transferWorktreeSessionMarkerOwner,
  WorktreeMarkerCommittedError,
  clearWorktreeSession,
  writeWorktreeSession,
  readSessionPrs,
  toSessionPrInfo,
  upsertSessionPr,
  isSessionPrRole,
  SESSION_PR_URL_MAX_LENGTH,
  type SessionPrRole,
  type SessionSourceInput,
  type ApprovalMode,
  type SessionGroupColor,
  type SessionGroupPresetColor,
  type SessionArchiveState,
  type WorktreeSession,
  parseGoalControlRequest,
  readArtifactSnapshot,
  isValidCronTaskRoutingId,
  MAX_CRON_TASK_ROUTING_ID_LENGTH,
} from '@qwen-code/qwen-code-core';
import {
  MAX_SUB_SESSION_PROMPT_CHARS,
  MAX_SUB_SESSION_WORKSPACE_CHARS,
} from '@qwen-code/acp-bridge/bridgeOptions';
import type { SubSessionLauncher } from '../create-sub-session.js';
import type { SessionArtifactInput } from '@qwen-code/acp-bridge/sessionArtifacts';
import {
  SESSION_ATTACHMENT_CHUNK_BYTES,
  SessionAttachmentUploadError,
} from '@qwen-code/acp-bridge/sessionAttachments';
import {
  type BridgeBranchedSession,
  type BridgePersistedBranchedSession,
} from '@qwen-code/acp-bridge/bridgeTypes';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import { parseSessionSource, summarizeReplay } from '@qwen-code/acp-bridge';
import { readServeWorkflowActionInput } from '@qwen-code/acp-bridge/status';
import {
  isReservedLiveSessionSource,
  isReservedStandaloneSessionSource,
  readLoadableConversationSession,
  readLoadableLiveConversationMetadata,
} from '../../runtime/live-session-source.js';
import type { ConversationRuntimeActivityGate } from '../conversations/conversation-runtime-activity.js';
import { ConversationRuntimeOwnershipError } from '../conversations/conversation-runtime-errors.js';
import {
  StandaloneSessionServiceError,
  type StandaloneSessionService,
} from '../conversations/standalone-session-service.js';
import express, {
  type Application,
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  isValidSessionId,
  normalizeSessionIdForLookup,
  parseCallerSuppliedSessionId,
} from '../../config/session-id.js';
import { isChannelDeliveryError } from '../../runtime/channel-delivery-ipc.js';
import { parseChannelDelivery } from '../../runtime/channel-delivery.js';
import {
  canonicalizeWorkspace,
  BranchWhilePromptActiveError,
  BridgeChannelQuarantinedError,
  CdWhilePromptActiveError,
  InvalidClientIdError,
  InvalidSessionMetadataError,
  SessionArtifactValidationError,
  SessionArchivedError,
  SessionArchivingError,
  SessionConflictError,
  SessionBusyError,
  SessionLimitExceededError,
  SessionNotFoundError,
  SessionResetPendingError,
  SystemOverloadedError,
  BridgeTimeoutError,
  SessionShellClientRequiredError,
  SessionShellDisabledError,
  type AcpSessionBridge,
  type BridgePromptContentBlock,
  type BridgeSessionCatalogVersion,
} from '../acp-session-bridge.js';
import type { DaemonLogger } from '../daemon-logger.js';
import type { LoadAdmissionSnapshot } from '../load-admission.js';
import {
  BtwStreamError,
  BtwStreamRequests,
  streamBtwSnapshots,
} from '../btw-stream.js';
import type { SendBridgeError } from '../server/error-response.js';
import {
  WorktreeResetActiveError,
  WorktreeResetInvalidStateError,
  WorktreeResetUnsupportedError,
} from '../server/worktree-reset-errors.js';
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
  isBridgeSessionRetirementFenced,
  isPersistedSessionCursor,
  listLiveWorkspaceSessionsForResponse,
  listWorkspaceSessionsForResponse,
  parseSessionPageSizeQuery,
  searchWorkspaceSessionsForResponse,
  type ListWorkspaceSessionsOptions,
} from '../server/session-list.js';
import {
  archiveDaemonSessions,
  assertSessionArchived,
  assertSessionLoadable,
  deleteDaemonSessionIfOrphan,
  deleteDaemonSessions,
  logSessionArchiveWarning,
  resolveSessionIdForRestore,
  DaemonDrainingError,
  type SessionArchiveCoordinator,
  unarchiveDaemonSessions,
} from '../server/session-archive.js';
import {
  ArtifactLibraryRequestError,
  artifactLibraryMemberError,
  removeWorkspaceLibraryArtifact,
  removeWorkspaceLibraryArtifacts,
  type ArtifactLibraryRemovalResult,
  type WorkspaceSessionArtifactsEnvelope,
} from '../server/session-artifact-library.js';
import { WorkspaceArtifactCache } from '../server/workspace-artifact-cache.js';
import { ArtifactLibraryStream } from '../server/artifact-library-stream.js';
import type { SseAdmissionCaps } from '../daemon-status.js';
import { checkSseAdmission, countSseStream } from '../sse-occupancy.js';
import {
  PROMPT_IDEMPOTENCY_KEY_MAX_LENGTH,
  admitSessionPrompt,
  findPromptReceipt,
  classifyPromptRequest,
  type SessionPromptAdmission,
} from './session-prompt-admission.js';
import { acquireWorktreeOwnershipOp } from '../server/worktree-ownership-op.js';
import {
  restoreSessionCore,
  type WorktreeRestoreHandoff,
} from '../server/session-restore.js';
import {
  assertNotRetirementFenced,
  restoreWorktreeFromSessionSnapshot,
  WorktreeRestoreUnavailableError,
} from '../server/session-worktree-restore.js';
import {
  exportSessionTranscript,
  parseSessionExportFormat,
  sessionExportFormatValues,
} from '../server/session-export.js';
import { setDaemonTelemetryWorkspace } from '../server/telemetry.js';
import { createSessionOrganizationService } from '../session-organization-helpers.js';
import {
  AGENT_HOST_SESSION_SOURCE_TYPE,
  AGENT_SESSION_SOURCE_TYPE,
  isHiddenCatalogSource,
} from '../../runtime/agent-session-source.js';
import {
  omitSkillDetailsForSdkSurface,
  omitSkillDetailsFromReplayArrays,
} from '../skill-details-redaction.js';
import {
  appendWorkspaceInputHistory,
  extractPromptHistoryText,
  type WorkspaceInputHistoryKind,
} from '../workspace-input-history.js';
import { replayTranscriptRecordPage } from '../../acp-integration/session/history-replay-page.js';
import {
  readSessionToolCalls,
  SessionToolCallsLimitError,
  SessionToolCallsReplayError,
} from '../session-tool-calls.js';
import { GENERATION_MAX_PROMPT_BYTES } from '../../acp-integration/generation.js';
import {
  PERSIST_REASONING_SELECTION_META_KEY,
  REASONING_SELECTION_PERSISTED_META_KEY,
} from '../../acp-integration/model-configuration.js';
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
  isCommitAncestor,
  probeCommitAncestry,
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
  captureWorkspaceEntryCurrency,
  failedBatchMember,
  isGenerationClosedError,
  MAX_BATCH_WORKSPACES,
  MAX_MEMBER_BYTES,
  MAX_SELECTOR_CHARS,
  resolveWorkspaceEntryBySelector,
  resolveWorkspaceEntryFromParam,
  resolveWorkspaceRuntimeFromParam,
  sendUntrustedWorkspaceResponse,
  sendWorkspaceRuntimeUnavailable,
} from '../workspace-route-runtime.js';
import {
  redactWorkflowModeFromConfigOptions,
  redactWorkflowModeFromSessionState,
  redactWorkflowsFromAvailableCommandsEvent,
  redactWorkflowsFromReplayArrays,
  redactWorkflowsFromSupportedCommands,
} from '../workflow-session-gate.js';
import { WorkspaceGenerationClosedError } from '../workspace-registry.js';
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
import {
  DEFAULT_RESTART_RECOVERY_WINDOW_MS,
  MAX_RESTART_RECOVERY_ITEMS,
  MAX_RESTART_RECOVERY_WINDOW_MS,
  readRestartRecoveryState,
  scanRestartRecoveries,
} from '../restart-recovery-scan.js';
import {
  clearBranchWorktreeJournalDurable,
  createBranchWorktreeJournal,
  getBranchWorktreeJournalPath,
  isBranchWorktreeCreationSupported,
  resolveBranchWorktreeBaseCheckout,
  updateBranchWorktreeJournal,
  type BranchWorktreePreparationJournal,
} from '../branch-worktree-preparation.js';
import type { ChannelDeliveryAuthorizationStore } from '../channel-delivery-authorization.js';
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

function redactSdkSurfaceEvent<T extends { type: string; data: unknown }>(
  event: T,
  workspaceTrusted: boolean,
): T {
  const shaped = omitSkillDetailsForSdkSurface(event);
  return workspaceTrusted
    ? shaped
    : redactWorkflowsFromAvailableCommandsEvent(shaped);
}

function redactSdkSurfaceReplay<
  T extends {
    compactedReplay?: BridgeEvent[];
    liveJournal?: BridgeEvent[];
  },
>(session: T, workspaceTrusted: boolean): T {
  const shaped = omitSkillDetailsFromReplayArrays(session);
  return workspaceTrusted ? shaped : redactWorkflowsFromReplayArrays(shaped);
}

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

// Mirrors validateBranchName in GitModePopover.tsx; keep the two in sync.
function isValidGitBranchName(name: string): boolean {
  return !(
    /[^\p{L}\p{N}._/-]/u.test(name) ||
    name.includes('..') ||
    name.includes('//') ||
    name.startsWith('.') ||
    name.startsWith('-') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.endsWith('.git') ||
    name.includes('@{') ||
    name.split('/').some((c) => c.startsWith('.') || c.endsWith('.lock')) ||
    name.toUpperCase() === GIT_RESERVED_BRANCH ||
    Buffer.byteLength(name, 'utf8') > MAX_BRANCH_NAME_BYTES ||
    name
      .split('/')
      .some((c) => Buffer.byteLength(c, 'utf8') > MAX_BRANCH_COMPONENT_BYTES)
  );
}

interface RegisterSessionRoutesDeps {
  boundWorkspace: string;
  bridge: AcpSessionBridge;
  workspaceRegistry: WorkspaceRegistry;
  archiveCoordinator: SessionArchiveCoordinator;
  /**
   * Channel label for transcript exports, resolved once per daemon at boot
   * (hosted-harness → managed, desktop shell → desktop, otherwise daemon).
   * Reading the shared process.env marker at request time would let a
   * co-resident daemon relabel this daemon's exports.
   */
  exportChannel?: string;
  requestedSessionIdAdmission?: RequestedSessionIdAdmission;
  /**
   * Fired after a load/resume makes a session live, so the PR watch can deliver
   * its pending transitions now instead of at the next tick (design §2). Never
   * awaited: the watch's per-PR lock is not re-entrant, and a restore the drain
   * itself dispatched must not wait on a drain.
   */
  onSessionRestored?: (input: {
    runtime: WorkspaceRuntime;
    workspaceCwd: string;
    sessionId: string;
  }) => void;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  sendBridgeError: SendBridgeError;
  getLoadAdmissionSnapshot?: () => LoadAdmissionSnapshot;
  daemonLog?: DaemonLogger;
  sseAdmissionCaps?: SseAdmissionCaps;
  channelDeliveryAuthorizations?: ChannelDeliveryAuthorizationStore;
  promptDeadlineMs?: number;
  sessionShellCommandEnabled: boolean;
  sessionArtifactsPersistenceAvailable?: boolean;
  languageCodes: string[];
  virtualSubagentSessions?: VirtualSubagentSessions;
  materializeLiveConversationDirectory?: (sessionId: string) => Promise<string>;
  isLiveSessionActive?: (sessionId: string) => boolean;
  ensureConversationRuntime?: () => Promise<WorkspaceRuntime>;
  liveConversationRootPath?: string;
  conversationRuntimeActivity?: ConversationRuntimeActivityGate;
  standaloneSessionService?: Pick<
    StandaloneSessionService,
    'restoreLegacyForCompatibility' | 'dispatchPrompt' | 'continueSession'
  >;
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
const ARTIFACT_LIBRARY_CONCURRENCY = 4;
// Media blocks are resolved into inline bytes at dispatch, so an unbounded
// content array lets one small request fan out into gigabytes of heap (a
// repeated reference resolves to the same 8 MiB image once per occurrence).
// Keep a single request from expanding an unbounded number of content blocks.
const MEDIA_CONTENT_MAX_BLOCKS = 256;

// The two restoreFailed refusal notes for a handoff-to-local snapshot conflict,
// chosen from rollback()'s actual result. Named so each arm is greppable by its
// text (the route tests assert on these substrings).
const HANDOFF_RESTORE_NOTE_RESTORED =
  ' — the local checkout was force-restored by rollback; inspect it if conflict markers remain';
const HANDOFF_RESTORE_NOTE_FAILED =
  ' — the local checkout could not be restored and may still hold conflict markers; inspect it before retrying';

// SVG is allowed as an ordinary file resource but never as an inline image.
// Compare the normalized media type so spelling variants cannot bypass the
// image-block check.
function isSvgMimeType(mimeType: string | undefined): boolean {
  return mimeType?.split(';', 1)[0]?.trim().toLowerCase() === 'image/svg+xml';
}

// Shared per-block validation for the prompt and mid-turn routes.
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
  const attachmentId = record['attachmentId'];
  const mimeType = record['mimeType'];
  const size = record['size'];
  const inline = typeof data === 'string' && data.length > 0;
  const reference =
    typeof attachmentId === 'string' &&
    attachmentId.length > 0 &&
    typeof size === 'number' &&
    Number.isSafeInteger(size) &&
    size >= 0 &&
    (type !== 'image' || size > 0);
  if (type === 'resource' && !reference) {
    const resource = record['resource'];
    if (typeof resource !== 'object' || resource === null) {
      return { valid: false, code: 'invalid-shape' };
    }
    const value = resource as Record<string, unknown>;
    const hasText = typeof value['text'] === 'string';
    const hasBlob = typeof value['blob'] === 'string';
    if (
      typeof value['uri'] !== 'string' ||
      value['uri'].length === 0 ||
      hasText === hasBlob
    ) {
      return { valid: false, code: 'invalid-shape' };
    }
    return { valid: true, block: block as BridgePromptContentBlock };
  }
  if (
    (type !== 'image' && type !== 'resource') ||
    (type === 'image' ? inline === reference : inline || !reference) ||
    typeof mimeType !== 'string' ||
    (type === 'image' && !mimeType.startsWith('image/'))
  ) {
    return { valid: false, code: 'invalid-shape' };
  }
  if (type === 'image' && isSvgMimeType(mimeType)) {
    return { valid: false, code: 'svg' };
  }
  return {
    valid: true,
    block: inline
      ? ({ type, data, mimeType } as BridgePromptContentBlock)
      : ({ type, attachmentId, mimeType, size } as BridgePromptContentBlock),
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
  return `each ${entryLabel} must be an inline content block or carry \`attachmentId\`, \`size\`, and \`mimeType\``;
}
const PRIMARY_OR_INTERNAL_LIVE_SESSION_ROUTES = [
  'POST /session/:id/branch',
  'POST /session/:id/fork',
] as const;
type PrimaryOrInternalLiveSessionRoute =
  (typeof PRIMARY_OR_INTERNAL_LIVE_SESSION_ROUTES)[number];
type RestrictedLiveSessionRoute =
  | 'POST /session/:id/cd'
  | PrimaryOrInternalLiveSessionRoute;

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

function parseTranscriptDirectionQuery(
  rawDirection: unknown,
  res: Response,
): 'backward' | undefined | null {
  if (rawDirection === undefined) return undefined;
  if (rawDirection !== 'backward') {
    res.status(400).json({
      error: '`direction` must be `backward`',
      code: 'invalid_transcript_cursor',
    });
    return null;
  }
  return rawDirection;
}

function parseTranscriptSnapshotQuery(
  rawSnapshot: unknown,
  res: Response,
): string | undefined | null {
  if (rawSnapshot === undefined) return undefined;
  if (typeof rawSnapshot !== 'string' || rawSnapshot.trim() === '') {
    res.status(400).json({
      error: '`snapshot` must be a non-empty string',
      code: 'invalid_transcript_cursor',
    });
    return null;
  }
  return rawSnapshot;
}

function parseTranscriptStartQuery(
  rawStart: unknown,
  res: Response,
): number | undefined | null {
  if (rawStart === undefined) return undefined;
  if (typeof rawStart !== 'string' || !/^\d+$/.test(rawStart)) {
    res.status(400).json({
      error: '`start` must be a non-negative integer',
      code: 'invalid_transcript_cursor',
    });
    return null;
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start)) {
    res.status(400).json({
      error: '`start` must be a non-negative safe integer',
      code: 'invalid_transcript_cursor',
    });
    return null;
  }
  return start;
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

function parseTranscriptTurnAnchorQuery(
  rawAnchor: unknown,
  res: Response,
): string | undefined | null {
  if (rawAnchor === undefined) return undefined;
  if (
    typeof rawAnchor !== 'string' ||
    rawAnchor.trim() === '' ||
    rawAnchor.length > 200
  ) {
    res.status(400).json({
      error: '`atRecordId` must be a non-empty record id',
      code: 'invalid_turn_anchor',
    });
    return null;
  }
  return rawAnchor;
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

function parseReplayMode(
  body: Record<string, unknown>,
  res: Response,
  key: 'liveReplayMode' | 'compactedReplayMode' | 'eventDetailMode',
): 'full' | 'summary' | undefined | null {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value !== 'full' && value !== 'summary') {
    res.status(400).json({
      error: `\`${key}\` must be \`full\` or \`summary\``,
      code:
        key === 'liveReplayMode'
          ? 'invalid_live_replay_mode'
          : key === 'compactedReplayMode'
            ? 'invalid_compacted_replay_mode'
            : 'invalid_event_detail_mode',
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

function parseRequestedSessionSource(
  body: Record<string, unknown>,
  res: Response,
): { sourceType?: string; sourceId?: string } | null {
  // Agent sessions are created by the session-agents orchestrator
  // in-process, never through this route. Accepting the source here would let
  // a client relabel a session it restores so a real run is sent into it.
  if (
    body['sourceType'] === AGENT_HOST_SESSION_SOURCE_TYPE ||
    body['sourceType'] === AGENT_SESSION_SOURCE_TYPE
  ) {
    res.status(400).json({
      error:
        'The requested session source is reserved for daemon-owned agent sessions.',
      code: 'reserved_session_source',
    });
    return null;
  }
  if (
    isReservedStandaloneSessionSource({
      sourceType:
        typeof body['sourceType'] === 'string' ? body['sourceType'] : undefined,
    })
  ) {
    res.status(400).json({
      error:
        'The requested session source is reserved for daemon-owned standalone sessions.',
      code: 'reserved_session_source',
    });
    return null;
  }
  const source = parseSessionSource(body['sourceType'], body['sourceId']);
  if ('error' in source) {
    res.status(400).json({
      error: source.error,
      code: 'invalid_session_source',
    });
    return null;
  }
  if (isReservedLiveSessionSource(source)) {
    res.status(400).json({
      error:
        'The requested session source is reserved for daemon-owned Live Voice sessions.',
      code: 'reserved_session_source',
    });
    return null;
  }
  return source;
}

interface ParsedSessionRestoreFields {
  approvalMode: ApprovalMode | undefined;
  historyPageSize: number | undefined;
  liveReplayMode: 'full' | 'summary' | undefined;
  compactedReplayMode: 'full' | 'summary' | undefined;
  restoreSource: { sourceType?: string; sourceId?: string };
  clientId: string | undefined;
}

function parseSessionRestoreFields(
  req: Request,
  res: Response,
  body: Record<string, unknown>,
  action: 'load' | 'resume',
): ParsedSessionRestoreFields | null {
  const approvalMode = parseOptionalApprovalMode(body, res);
  if (approvalMode === null) return null;
  const historyPageSize =
    action === 'load' ? parseHistoryPageSize(body, res) : undefined;
  if (historyPageSize === null) return null;
  // Resume restores the full journal and neither uses nor rejects load-only
  // replay fields (see restore-request-fields.ts).
  const liveReplayMode =
    action === 'load'
      ? parseReplayMode(body, res, 'liveReplayMode')
      : undefined;
  if (liveReplayMode === null) return null;
  const compactedReplayMode =
    action === 'load'
      ? parseReplayMode(body, res, 'compactedReplayMode')
      : undefined;
  if (compactedReplayMode === null) return null;
  const restoreSource = parseRequestedSessionSource(body, res);
  if (restoreSource === null) return null;
  const clientId = parseClientIdHeader(req, res);
  if (clientId === null) return null;
  return {
    approvalMode,
    historyPageSize,
    liveReplayMode,
    compactedReplayMode,
    restoreSource,
    clientId,
  };
}

export type ResolveSubagentSessionRuntime = (
  res: Response,
  route: string,
  parentSessionId: string,
) => Promise<WorkspaceRuntime | undefined>;

const SESSION_FILE_ID_PATTERN = /^[0-9a-fA-F-]{32,36}$/;

/**
 * Bridge errors can cross module or process boundaries, where `instanceof`
 * alone is not reliable; the typed name and code survive that boundary.
 */
function isSessionNotFoundError(error: unknown): boolean {
  if (error instanceof SessionNotFoundError) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === 'SessionNotFoundError') return true;
  const code = (error as Error & { code?: unknown }).code;
  return code === 'session_not_found' || code === 'session_closing';
}

export function registerSessionRoutes(
  app: Application,
  deps: RegisterSessionRoutesDeps,
): { resolveSubagentSessionRuntime: ResolveSubagentSessionRuntime } {
  const btwStreams = new BtwStreamRequests();
  const skillPreparations = new Map<string, Promise<void>>();
  const {
    boundWorkspace,
    workspaceRegistry,
    archiveCoordinator,
    mutate,
    sendBridgeError,
    getLoadAdmissionSnapshot,
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
    runtime.bridge.markSessionCatalogChanged?.();
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
  const workspaceArtifactCaches = new WeakMap<
    WorkspaceRuntime,
    WorkspaceArtifactCache
  >();
  const artifactCache = (runtime: WorkspaceRuntime): WorkspaceArtifactCache => {
    let cache = workspaceArtifactCaches.get(runtime);
    if (!cache) {
      cache = new WorkspaceArtifactCache(runtime);
      workspaceArtifactCaches.set(runtime, cache);
    }
    return cache;
  };
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

  // Daemon-local transcript read shared by the workspace-qualified route and
  // the default (singular) route. Reading in the daemon process keeps the
  // index cache alive across ACP child exits (session switch, the session
  // idle TTL, a child crash/respawn), so default-route pagination stops
  // rebuilding the whole transcript on every cold reopen. The cache is an
  // in-memory Map, so a daemon restart still rebuilds it once. readerCodec
  // selects how incoming cursors and snapshots are decoded: the workspace
  // route passes
  // its per-runtime codec; the singular route passes undefined so the reader
  // falls back to the persisted per-workspace key the ACP child also uses,
  // keeping cursors issued by either side interchangeable. encodeCursor must
  // sign with that same key. Ownership is still enforced by each route's
  // runtime resolution before this helper runs; the loadable re-check here
  // mirrors the workspace route and tolerates an active conflict the caller
  // already admitted.
  const readDaemonLocalTranscriptPage = async (
    runtime: WorkspaceRuntime,
    sessionId: string,
    opts: {
      limit?: number;
      cursor?: string;
      direction?: 'backward';
      beforeRecordId?: string;
      atRecordId?: string;
      snapshot?: string;
    },
    readerCodec: SessionTranscriptCursorCodec | undefined,
    encodeCursor: (state: SessionTranscriptCursorState) => string,
    assertRuntimeGenerationOpen?: () => void,
    recheckLoadable = true,
  ) => {
    const { limit, cursor, direction, beforeRecordId, atRecordId, snapshot } =
      opts;
    return runWithWorkspaceRuntimeStorage(runtime, async () => {
      const service = createWorkspaceRuntimeSessionService(runtime);
      // The default route's resolution already gated loadability: the
      // active-runtime path asserts it (allowActiveConflict:false) and the
      // persisted fallback only returns loadable conversations. The readPage
      // ENOENT mapping below still distinguishes archived/conflict/missing, so
      // the redundant re-check is skipped. The workspace route's resolution
      // does not gate loadability, so it keeps the re-check.
      if (recheckLoadable && cursor === undefined) {
        await assertSessionLoadable(
          runtime.workspaceCwd,
          sessionId,
          runtime.sessionRuntimeBaseDir,
          { allowActiveConflict: true },
        );
      }
      const reader = new SessionTranscriptReader(
        runtime.workspaceCwd,
        readerCodec,
      );
      const getLivePromptState = (): {
        live: boolean;
        activePrompt: boolean;
      } => {
        try {
          return {
            live: true,
            activePrompt:
              runtime.bridge.getSessionSummary(sessionId).hasActivePrompt,
          };
        } catch (error) {
          if (error instanceof SessionNotFoundError) {
            return { live: false, activePrompt: false };
          }
          throw error;
        }
      };
      const promptStateBeforeRead = getLivePromptState();
      if (
        cursor === undefined &&
        direction === 'backward' &&
        promptStateBeforeRead.live
      ) {
        try {
          if (runtime.bridge.flushSessionTranscript) {
            await runtime.bridge.flushSessionTranscript(sessionId);
          } else {
            await runtime.bridge.getSessionTranscriptPage({
              sessionId,
              direction,
              limit: 1,
            });
          }
        } catch (error) {
          if (!(error instanceof SessionNotFoundError)) throw error;
        }
      }
      let page;
      try {
        page = await reader.readPage(sessionId, {
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          ...(direction !== undefined ? { direction } : {}),
          ...(beforeRecordId !== undefined ? { beforeRecordId } : {}),
          ...(atRecordId !== undefined ? { atRecordId } : {}),
          ...(snapshot !== undefined ? { snapshot } : {}),
          maxBytes: SESSION_TRANSCRIPT_MAX_PAGE_BYTES,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        if (cursor !== undefined || snapshot !== undefined) {
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
      const activePromptAfterRead = getLivePromptState().activePrompt;
      const replay = await replayTranscriptRecordPage({
        sessionId,
        page,
        finalizeDangling:
          !promptStateBeforeRead.activePrompt && !activePromptAfterRead,
        encodeCursor,
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
          redactSdkSurfaceEvent(
            {
              v: 1 as const,
              type: 'session_update' as const,
              data: update,
            },
            runtime.trusted,
          ),
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
        ...(page.targetRecordId ? { targetRecordId: page.targetRecordId } : {}),
        ...(page.hasOlder !== undefined ? { hasOlder: page.hasOlder } : {}),
      };
    });
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

  // A workspace with no registry entry at all (removed, or never registered)
  // is a PERMANENT absence, unlike the reversible draining/transitioning
  // states that still have an entry and answer workspace_mismatch /
  // workspace_runtime_unavailable. Callers (e.g. the channel worker's
  // bound-session wake) may classify this 404 as gone without risking the
  // reversible states.
  const sendWorkspaceNotFound = (
    res: Response,
    requestedWorkspace: string,
  ): void => {
    res.status(404).json({
      error: `Workspace not found: "${requestedWorkspace}" is not registered with this daemon.`,
      code: 'workspace_not_found',
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

  const hasLifecycleStorageEvidence = async (
    service: ReturnType<typeof createWorkspaceRuntimeSessionService>,
    sessionId: string,
  ): Promise<boolean> => {
    try {
      return (
        (await service.getMaintainableSessionLocation(sessionId)) !== undefined
      );
    } catch (error) {
      if (error instanceof SessionStorageEntryError) {
        return error.reason !== 'foreign_project';
      }
      if (error instanceof SessionTranscriptIdentityUnavailableError) {
        return true;
      }
      if (error instanceof SessionTranscriptChangedError) {
        return true;
      }
      if (
        error !== null &&
        typeof error === 'object' &&
        typeof (error as NodeJS.ErrnoException).code === 'string'
      ) {
        return true;
      }
      throw error;
    }
  };

  const resolveQualifiedSessionRuntime = async (
    req: Request,
    res: Response,
    route: string,
    sessionIds: readonly string[],
    archiveState: SessionArchiveState | 'any',
    options: { lifecycleMaintenance?: boolean } = {},
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
      if (options.lifecycleMaintenance) {
        if (!(await hasLifecycleStorageEvidence(service, sessionId))) {
          throw new SessionNotFoundError(sessionId);
        }
        continue;
      }
      const location = await service.getSessionLocation(sessionId);
      if (location === 'conflict') {
        if (archiveState !== 'active') {
          throw new SessionConflictError(sessionId);
        }
      } else if (
        location === undefined ||
        (archiveState !== 'any' && location !== archiveState)
      ) {
        throw new SessionNotFoundError(sessionId);
      }
      const metadata = await readLoadableLiveConversationMetadata(
        sessionId,
        service,
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
        excludeSourceTypes: [
          AGENT_HOST_SESSION_SOURCE_TYPE,
          AGENT_SESSION_SOURCE_TYPE,
        ],
      });
      signal.throwIfAborted();
      return page.items.length > 0;
    } catch {
      signal.throwIfAborted();
      return false;
    }
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
                { allowActiveConflict: true },
              );
            }
            assertRuntimeGenerationOpen?.();
            return exportSessionTranscript({
              workspaceCwd: runtime.workspaceCwd,
              sessionId,
              format,
              archiveState: target.archiveState,
              config: { getChannel: () => deps.exportChannel ?? 'daemon' },
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
      // Distinguish permanent absence (no registry entry at all) from the
      // reversible non-active states (entry exists but is draining /
      // transitioning / blocked): only the former is a gone workspace.
      const entry =
        'cwd' in body
          ? workspaceRegistry.getEntryByWorkspaceCwd(key)
          : undefined;
      if ('cwd' in body && !entry) {
        logSessionRoutingFailure(route, 'workspace_not_found', {
          requestedWorkspace: key,
        });
        sendWorkspaceNotFound(res, key);
        return undefined;
      }
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

  const sendStandaloneActionUnsupported = (
    res: Response,
    route: string,
    sessionId: string,
  ): void => {
    res.status(400).json({
      error: 'This action is not supported in a standalone session.',
      code: 'unsupported_action',
      sessionId,
      route,
    });
  };

  const isStandaloneOwner = (
    runtime: WorkspaceRuntime,
    sessionId: string,
  ): boolean =>
    isInternalWorkspaceRuntime(runtime) &&
    isReservedStandaloneSessionSource(
      runtime.bridge.getSessionSummary(sessionId),
    );

  const resolveOwnerSessionRuntime = async (
    sessionId: string,
    res: Response,
    route: string,
  ): Promise<
    { runtime: WorkspaceRuntime; standalone: boolean } | undefined
  > => {
    const runtime = resolveLiveSessionRuntime(sessionId, res, route);
    if (!runtime) return undefined;
    if (!isInternalWorkspaceRuntime(runtime)) {
      return { runtime, standalone: false };
    }
    if (!deps.conversationRuntimeActivity) {
      throw new Error('Conversations runtime activity gate is unavailable.');
    }
    const standalone = await deps.conversationRuntimeActivity.run(async () =>
      isStandaloneOwner(runtime, sessionId),
    );
    return { runtime, standalone };
  };

  const runOwnerRuntimeActivity = <T>(
    runtime: WorkspaceRuntime,
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (!isInternalWorkspaceRuntime(runtime)) return operation();
    if (!deps.conversationRuntimeActivity) {
      throw new Error('Conversations runtime activity gate is unavailable.');
    }
    return deps.conversationRuntimeActivity.run(operation);
  };

  const withOwnerMutableSession =
    (
      route: string,
      handler: (
        req: Request,
        res: Response,
        sessionId: string,
        runtime: WorkspaceRuntime,
        onPromptAdmitted?: () => void,
      ) => Promise<void> | void,
      options: {
        cwdBound?: 'always' | 'rewind-files' | 'sync-output-language';
        promptAdmission?: boolean;
        rejectStandalone?: boolean;
      } = {},
    ): RequestHandler =>
    async (req, res) => {
      const sessionId = requireSessionId(req, res);
      if (sessionId === null) return;
      try {
        const owner = await resolveOwnerSessionRuntime(sessionId, res, route);
        if (!owner) return;
        const { runtime, standalone } = owner;
        if (options.rejectStandalone && standalone) {
          sendStandaloneActionUnsupported(res, route, sessionId);
          return;
        }
        const cwdBound =
          options.cwdBound === 'always' ||
          (options.cwdBound === 'rewind-files' &&
            safeBody(req)['rewindFiles'] !== false) ||
          (options.cwdBound === 'sync-output-language' &&
            safeBody(req)['syncOutputLanguage'] === true);
        if (
          runtime.routeFileSystemFactory.sshWorkspace &&
          cwdBound &&
          route !== 'POST /session/:id/continue'
        ) {
          res.status(501).json({
            code: 'ssh_workspace_operation_unsupported',
            error: 'This operation is not supported for SSH workspaces.',
          });
          return;
        }
        if (standalone && (options.promptAdmission || cwdBound)) {
          const service = deps.standaloneSessionService;
          if (!service) {
            throw new Error('Standalone session service is unavailable.');
          }
          if (options.promptAdmission) {
            await service.dispatchPrompt(
              sessionId,
              (ownerRuntime, canonicalSessionId, onPromptAdmitted) =>
                Promise.resolve(
                  handler(
                    req,
                    res,
                    canonicalSessionId,
                    ownerRuntime,
                    onPromptAdmitted,
                  ),
                ),
            );
          } else {
            await service.continueSession(
              sessionId,
              (ownerRuntime, canonicalSessionId) =>
                Promise.resolve(
                  handler(req, res, canonicalSessionId, ownerRuntime),
                ),
            );
          }
          return;
        }
        await runOwnerRuntimeActivity(runtime, () =>
          archiveCoordinator.runSharedMany([sessionId], async () => {
            runtime.generationGuard?.assertOpen();
            await handler(req, res, sessionId, runtime);
          }),
        );
      } catch (err) {
        if (!res.headersSent) {
          sendBridgeError(res, err, { route, sessionId });
        }
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
      options: { cwdBound?: boolean } = {},
    ): RequestHandler =>
    async (req, res) => {
      const sessionId = requireSessionId(req, res);
      if (sessionId === null) return;
      try {
        const owner = await resolveOwnerSessionRuntime(sessionId, res, route);
        if (!owner) return;
        const { runtime, standalone } = owner;
        if (options.cwdBound && standalone) {
          const service = deps.standaloneSessionService;
          if (!service) {
            throw new Error('Standalone session service is unavailable.');
          }
          await service.continueSession(
            sessionId,
            (ownerRuntime, canonicalSessionId) =>
              Promise.resolve(
                handler(req, res, canonicalSessionId, ownerRuntime),
              ),
          );
          return;
        }
        await runOwnerRuntimeActivity(runtime, () =>
          Promise.resolve(handler(req, res, sessionId, runtime)),
        );
      } catch (err) {
        if (!res.headersSent) {
          sendBridgeError(res, err, { route, sessionId });
        }
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
      allowActiveConflict = false,
    ): Promise<boolean> => {
      const location = await assertSessionLoadable(
        runtime.workspaceCwd,
        sessionId,
        runtime.sessionRuntimeBaseDir,
        { allowActiveConflict },
      );
      if (location !== 'active') return false;
      if (!isInternalWorkspaceRuntime(runtime)) return true;
      const service = createWorkspaceRuntimeSessionService(runtime);
      const session = await readLoadableConversationSession(sessionId, service);
      if (session === undefined) return false;
      // Beyond what the Live-only compatibility adapter admitted, only a
      // top-level explicit standalone session is in scope here: the dedicated
      // standalone surface refuses child sessions, so they stay unreachable
      // from the generic transcript routes.
      if (session.metadata.parentSessionId === undefined) return true;
      return (
        session.kind === 'live' ||
        (session.kind === 'standalone' &&
          session.persistence === 'legacy' &&
          session.parentSource?.persistence === 'legacy')
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
        if (await activeInRuntime(runtime, true)) return runtime;
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
        active = await activeInRuntime(liveOwner.runtime, true);
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
        if (isInternalWorkspaceRuntime(liveOwner.runtime)) {
          const ordinaryCollisions: WorkspaceRuntime[] = [];
          for (const ordinaryRuntime of workspaceRegistry.list()) {
            const ordinaryService =
              createWorkspaceRuntimeSessionService(ordinaryRuntime);
            if (await ordinaryService.sessionExistsInAnyState(sessionId)) {
              ordinaryCollisions.push(ordinaryRuntime);
            }
          }
          if (
            internalEntry &&
            internalGeneration &&
            !assertCurrentInternalGeneration(
              internalEntry,
              internalGeneration,
              res,
            )
          ) {
            return undefined;
          }
          if (ordinaryCollisions.length > 0) {
            sendAmbiguousSessionOwner(res, route, sessionId, [
              liveOwner.runtime,
              ...ordinaryCollisions,
            ]);
            return undefined;
          }
        }
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
        if (await activeInRuntime(runtime, true)) {
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

  const resolveSubagentSessionRuntime: ResolveSubagentSessionRuntime = async (
    res,
    route,
    parentSessionId,
  ) => {
    const owner = workspaceRegistry.resolveLiveSessionOwner(parentSessionId);
    if (owner.kind !== 'not_found') {
      return requireSessionRuntime({
        sessionId: parentSessionId,
        route,
        res,
        workspaceRegistry,
        daemonLog,
      });
    }
    try {
      return await resolveTranscriptSessionRuntime(
        res,
        route,
        parentSessionId,
        false,
      );
    } catch (error) {
      if (
        error instanceof SessionNotFoundError &&
        error.code === 'session_not_found' &&
        (workspaceRegistry.primaryEntry.state !== 'active' ||
          !workspaceRegistry.primaryEntry.current)
      ) {
        logSessionRoutingFailure(route, 'workspace_runtime_unavailable', {
          sessionId: parentSessionId,
        });
        return requirePrimarySessionRuntime(workspaceRegistry, res);
      }
      throw error;
    }
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
        service,
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
      return resolveQualifiedSessionRuntime(
        req,
        res,
        route,
        sessionIds,
        'any',
        { lifecycleMaintenance: true },
      );
    }

    let internalRuntime: WorkspaceRuntime | undefined;
    let hasInternalSession = false;
    let hasOrdinaryLiveSession = false;
    const findOrdinarySessions = async (
      sessionId: string,
    ): Promise<Set<WorkspaceRuntime> | undefined> => {
      const runtimes = new Set<WorkspaceRuntime>();
      for (const entry of workspaceRegistry.listAllEntries()) {
        const generation = entry.current;
        if (entry.internal || !generation) continue;
        if (
          entry.state !== 'active' ||
          entry.current !== generation ||
          generation.guard.closed
        ) {
          sendWorkspaceRuntimeUnavailable(res);
          return undefined;
        }
        generation.guard.assertOpen();
        const exists = await hasLifecycleStorageEvidence(
          createWorkspaceRuntimeSessionService(generation.runtime),
          sessionId,
        );
        if (
          entry.state !== 'active' ||
          entry.current !== generation ||
          generation.guard.closed
        ) {
          sendWorkspaceRuntimeUnavailable(res);
          return undefined;
        }
        if (!exists) continue;
        generation.guard.assertOpen();
        runtimes.add(generation.runtime);
      }
      return runtimes;
    };
    const sendBatchWorkspaceConflict = (): void => {
      res.status(409).json({
        error: 'All sessions in this operation must share one workspace.',
        code: 'session_workspace_conflict',
      });
    };
    for (const sessionId of sessionIds) {
      const candidates = new Set<WorkspaceRuntime>();
      const ordinaryLiveCandidates = new Set<WorkspaceRuntime>();
      const owner = workspaceRegistry.resolveLiveSessionOwner(sessionId);
      if (owner.kind === 'unavailable') {
        sendWorkspaceRuntimeUnavailable(res);
        return undefined;
      }
      if (owner.kind === 'found') {
        if (isInternalWorkspaceRuntime(owner.runtime)) {
          candidates.add(owner.runtime);
        } else {
          ordinaryLiveCandidates.add(owner.runtime);
          hasOrdinaryLiveSession = true;
        }
      }
      if (owner.kind === 'ambiguous') {
        for (const runtime of owner.runtimes) {
          if (isInternalWorkspaceRuntime(runtime)) {
            candidates.add(runtime);
          } else {
            ordinaryLiveCandidates.add(runtime);
            hasOrdinaryLiveSession = true;
          }
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
        const exists = await hasLifecycleStorageEvidence(service, sessionId);
        if (!assertCurrentInternalGeneration(entry, generation, res)) {
          return undefined;
        }
        if (!exists) continue;
        candidates.add(runtime);
      }
      if (candidates.size > 0 || hasInternalSession) {
        if (hasOrdinaryLiveSession && ordinaryLiveCandidates.size === 0) {
          sendBatchWorkspaceConflict();
          return undefined;
        }
        for (const runtime of ordinaryLiveCandidates) {
          candidates.add(runtime);
        }
        const ordinarySessions = await findOrdinarySessions(sessionId);
        if (!ordinarySessions) return undefined;
        for (const runtime of ordinarySessions) {
          candidates.add(runtime);
        }
      }
      if (candidates.size === 0) {
        if (hasInternalSession) {
          const ordinarySessions = await findOrdinarySessions(sessionId);
          if (!ordinarySessions) return undefined;
          if (ordinarySessions.size > 0) {
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
      if (!(await hasLifecycleStorageEvidence(service, sessionId))) {
        const ordinarySessions = await findOrdinarySessions(sessionId);
        if (!ordinarySessions) return undefined;
        if (ordinarySessions.size > 0) {
          sendBatchWorkspaceConflict();
          return undefined;
        }
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

  const parseResolveConflicts = (
    req: Request,
    res: Response,
  ): boolean | undefined => {
    const value: unknown = safeBody(req)['resolveConflicts'];
    if (value === undefined) return false;
    if (typeof value === 'boolean') return value;
    res.status(400).json({
      error: '`resolveConflicts` must be a boolean',
      code: 'invalid_request',
    });
    return undefined;
  };

  const parseRequireIdle = (
    req: Request,
    res: Response,
  ): boolean | undefined => {
    const value: unknown = safeBody(req)['requireIdle'];
    if (value === undefined) return false;
    if (typeof value === 'boolean') return value;
    res.status(400).json({
      error: '`requireIdle` must be a boolean',
      code: 'invalid_request',
    });
    return undefined;
  };

  // Mirrors the bridge's displayName control-character rule (ESLint forbids
  // control-char regexes).
  const hasControlCharacter = (value: string): boolean =>
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });

  // Tri-state: absent → undefined (skip); invalid → null (400 already sent);
  // valid → the PR binding to apply.
  const parseSessionPrBody = (
    req: Request,
    res: Response,
  ):
    | {
        number: number;
        url: string;
        state?: 'open' | 'merged' | 'closed';
        role?: SessionPrRole | null;
      }
    | null
    | undefined => {
    const raw: unknown = safeBody(req)['pr'];
    if (raw === undefined) return undefined;
    const candidate = raw as Record<string, unknown> | null;
    const number = candidate?.['number'];
    const url = candidate?.['url'];
    const state = candidate?.['state'];
    const role = candidate?.['role'];
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      typeof number !== 'number' ||
      !Number.isInteger(number) ||
      number <= 0 ||
      typeof url !== 'string' ||
      url.length > SESSION_PR_URL_MAX_LENGTH ||
      !/^https?:\/\//i.test(url) ||
      // The url lands in the bridge's stderr audit line — control
      // characters would let a caller forge log lines.
      hasControlCharacter(url) ||
      (state !== undefined &&
        state !== 'open' &&
        state !== 'merged' &&
        state !== 'closed') ||
      // null is the explicit clear; an omitted role preserves the known one.
      (role !== undefined && role !== null && !isSessionPrRole(role))
    ) {
      res.status(400).json({
        error: `\`pr\` must be an object with a positive integer \`number\` and an http(s) \`url\` of at most ${SESSION_PR_URL_MAX_LENGTH} characters, without control characters, an optional \`state\` that is one of \`open\`, \`merged\`, or \`closed\`, and an optional \`role\` that is one of \`review\`, \`verify\`, \`fix\`, or null to clear`,
        code: 'invalid_metadata',
        field: 'pr',
      });
      return null;
    }
    return {
      number,
      url,
      ...(state ? { state } : {}),
      ...(role !== undefined ? { role: role as SessionPrRole | null } : {}),
    };
  };

  const serializeSessionErrors = (
    errors: Array<{ sessionId: string; error: unknown }>,
    redactDetails = false,
  ): Array<{ sessionId: string; error: string }> =>
    errors.map((e) => ({
      sessionId: e.sessionId,
      error:
        redactDetails && !(e.error instanceof SessionConflictError)
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
      return {
        result: await run(verifiedRuntime, true),
        internal: isInternalWorkspaceRuntime(verifiedRuntime),
      };
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
      const assertCanMutate = captureRuntimeGenerationAssertion(runtime);
      assertCanMutate?.();
      const service = createWorkspaceRuntimeSessionService(runtime);
      const result = await runWithSessionListInvalidation(
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
              assertCanMutate,
              runtimeWorkspaceCwd: runtime.workspaceCwd,
              onError: ({ phase, sessionId, error }) => {
                writeStderrLine(
                  `qwen serve: ${phase}Session failed for ${safeLogValue(sessionId)}: ${safeLogValue(error)}`,
                );
              },
            }),
          ),
      );
      assertCanMutate?.();
      return result;
    };
    return runResolvedSessionBatch({ req, res, route, sessionIds, run });
  };

  const archiveSessions = (
    req: Request | undefined,
    res: Response,
    route: string,
    sessionIds: string[],
    resolveConflicts = false,
    requireIdle = false,
  ) => {
    const run = async (
      runtime: WorkspaceRuntime,
      coordinatorLockHeld: boolean,
    ) => {
      const assertCanMutate = captureRuntimeGenerationAssertion(runtime);
      assertCanMutate?.();
      const service = createWorkspaceRuntimeSessionService(runtime, {
        onWarning: logSessionArchiveWarning,
      });
      const result = await runWithSessionListInvalidation(
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
              resolveConflicts,
              requireIdle,
              assertCanMutate,
            }),
          ),
      );
      assertCanMutate?.();
      return result;
    };
    return runResolvedSessionBatch({ req, res, route, sessionIds, run });
  };

  const unarchiveSessions = (
    req: Request | undefined,
    res: Response,
    route: string,
    sessionIds: string[],
    resolveConflicts = false,
  ) => {
    const run = async (
      runtime: WorkspaceRuntime,
      coordinatorLockHeld: boolean,
    ) => {
      const assertCanMutate = captureRuntimeGenerationAssertion(runtime);
      assertCanMutate?.();
      const service = createWorkspaceRuntimeSessionService(runtime, {
        onWarning: logSessionArchiveWarning,
      });
      const result = await runWithSessionListInvalidation(
        runtime,
        ['active', 'archived'],
        () =>
          runWithWorkspaceRuntimeStorage(runtime, () =>
            unarchiveDaemonSessions({
              sessionIds,
              service,
              coordinator: archiveCoordinator,
              coordinatorLockHeld,
              resolveConflicts,
              assertCanMutate,
            }),
          ),
      );
      assertCanMutate?.();
      return result;
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
    options: { cwdBound?: boolean; rejectStandalone?: boolean } = {},
  ): RequestHandler => {
    if (!isPrimaryOrInternalLiveSessionRoute(route)) {
      throw new Error(`Unregistered restricted session route: ${route}`);
    }
    return async (req, res) => {
      const sessionId = requireSessionId(req, res);
      if (sessionId === null) return;
      try {
        const owner = await resolveOwnerSessionRuntime(sessionId, res, route);
        if (!owner) return;
        const { runtime, standalone } = owner;
        if (options.rejectStandalone && standalone) {
          sendStandaloneActionUnsupported(res, route, sessionId);
          return;
        }
        if (!runtime.primary && !isInternalWorkspaceRuntime(runtime)) {
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
        if (options.cwdBound && standalone) {
          const service = deps.standaloneSessionService;
          if (!service) {
            throw new Error('Standalone session service is unavailable.');
          }
          await service.continueSession(
            sessionId,
            (ownerRuntime, canonicalSessionId) =>
              Promise.resolve(
                handler(req, res, canonicalSessionId, ownerRuntime),
              ),
          );
          return;
        }
        await runOwnerRuntimeActivity(runtime, () =>
          archiveCoordinator.runSharedMany([sessionId], async () => {
            runtime.generationGuard?.assertOpen();
            await handler(req, res, sessionId, runtime);
          }),
        );
      } catch (err) {
        if (!res.headersSent) {
          sendBridgeError(res, err, { route, sessionId });
        }
      }
    };
  };

  app.post('/session', mutate(), async (req, res) => {
    const body = safeBody(req);
    const resolvedRuntime = resolveRuntimeForSessionCreation(body, res);
    if (resolvedRuntime === undefined) return;
    const { runtime, workspaceCwd } = resolvedRuntime;
    if (
      runtime.routeFileSystemFactory.sshWorkspace &&
      (body['branch'] != null || body['worktree'] != null)
    ) {
      res.status(501).json({
        code: 'ssh_workspace_operation_unsupported',
        error:
          'Create branches and worktrees through the remote agent or SSH terminal.',
      });
      return;
    }
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
    let startupConfig;
    try {
      startupConfig = parseSessionStartupConfig(body['startupConfig'], body);
    } catch (error) {
      sendBridgeError(res, error, { route: 'POST /session' });
      return;
    }
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
    const source = parseRequestedSessionSource(body, res);
    if (source === null) return;
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

    let branchMeta:
      | { name: string; baseBranch: string; baseCommit?: string }
      | undefined;
    let branchBaseCommit: string | undefined;
    let worktreeMeta:
      | {
          slug: string;
          path: string;
          branch: string;
          baseCommit?: string;
          baseBranch?: string;
        }
      | undefined;
    let worktreeBaseBranch: string | undefined;
    let worktreeBaseCommit: string | undefined;
    let worktreeCarriedEntries: WorktreeSession['carriedEntries'];
    let worktreeDurablyAttached = false;
    let spawnCompleted = false;

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
        if (!isValidGitBranchName(branchName)) {
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
          .find(
            (session) =>
              session.sourceType !== AGENT_HOST_SESSION_SOURCE_TYPE &&
              // Mesh agent bodies hold no user edits and are driven by the
              // daemon, not by a person at a checkout — they must not block
              // branch creation in the workspace they happen to share.
              session.sourceType !== AGENT_SESSION_SOURCE_TYPE &&
              !session.worktree &&
              session.clientCount > 0,
          );
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
        // This request must allocate a fresh child. Avoid mutating git only
        // to roll it back when overload admission is closed.
        const load = getLoadAdmissionSnapshot?.();
        if (load?.overloaded) {
          throw new SystemOverloadedError(
            load.reason ?? 'cpu_load',
            load.loadRatio,
            load.eventLoopLagP99Ms,
          );
        }
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
        branchMeta = { name: branchName, baseBranch, baseCommit };
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
        const slugError = AGENT_WORKTREE_SLUG_PATTERN.test(slug)
          ? 'Worktree name is reserved for ephemeral agent worktrees.'
          : GitWorktreeService.validateUserWorktreeSlug(slug);
        if (slugError) {
          res
            .status(400)
            .json({ error: slugError, code: 'worktree_invalid_slug' });
          return;
        }
        const baseBranch = await wtService
          .getCurrentBranch()
          .catch(() => undefined);
        // Record the base the worktree starts from: the handoff back to
        // local promotes a branch only when HEAD moved past this commit.
        worktreeBaseBranch = baseBranch;
        worktreeBaseCommit = await getHeadCommit(workspaceCwd);
        if (!worktreeBaseCommit) {
          // An unborn HEAD (no commits yet) has no base to detach from;
          // git worktree add would fail with a generic error.
          res.status(409).json({
            error: 'The workspace has no commits to base a worktree on',
            code: 'worktree_base_unavailable',
          });
          return;
        }
        assertRuntimeGenerationOpen?.();
        const load = getLoadAdmissionSnapshot?.();
        if (load?.overloaded) {
          throw new SystemOverloadedError(
            load.reason ?? 'cpu_load',
            load.loadRatio,
            load.eventLoopLagP99Ms,
          );
        }
        const wtResult = await wtService.createUserWorktree(slug, baseBranch, {
          carryDirtyState: true,
          detached: true,
        });
        if (!wtResult.success || !wtResult.worktree) {
          // An in-progress merge/rebase is a state the user can clear, not a
          // daemon fault: answer a readable 409 rather than a 500 (R12-1).
          if (wtResult.code === 'worktree_merge_in_progress') {
            res.status(409).json({
              error: wtResult.error ?? 'The workspace has an in-progress merge',
              code: 'worktree_merge_in_progress',
            });
            return;
          }
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
          baseCommit: worktreeBaseCommit,
          baseBranch: worktreeBaseBranch,
        };
        worktreeCarriedEntries = wtResult.carriedEntries;
        // Worktree sessions must be independent — never coalesce onto an
        // existing single-scope session that lives in the main checkout.
        sessionScope = 'thread';
      }
      // A caller-supplied sessionId implies a new, distinct session —
      // never coalesce onto an existing single-scope session.
      if (requestedSessionId !== undefined) {
        sessionScope = 'thread';
      }

      // A plain session (no branch/worktree) still has a start commit: the
      // HEAD it was created from. Capture it so the change overview's commit
      // fallback can scope to <baseCommit>..HEAD instead of suppressing for
      // lack of a boundary. A failed read stays undefined (no boundary).
      const plainBaseCommit =
        !branchMeta && !worktreeMeta
          ? await getHeadCommit(workspaceCwd).catch(() => undefined)
          : undefined;

      assertRuntimeGenerationOpen?.();
      const session = await runtime.bridge.spawnOrAttach({
        workspaceCwd,
        modelServiceId,
        ...(startupConfig ? { startupConfig } : {}),
        ...(clientId !== undefined ? { clientId } : {}),
        ...(sessionScope !== undefined ? { sessionScope } : {}),
        ...(approvalMode !== undefined ? { approvalMode } : {}),
        ...(source.sourceType !== undefined
          ? { sourceType: source.sourceType }
          : {}),
        ...(source.sourceId !== undefined ? { sourceId: source.sourceId } : {}),
        ...(worktreeMeta ? { worktree: worktreeMeta } : {}),
        ...(branchMeta ? { branch: branchMeta } : {}),
        ...(plainBaseCommit ? { baseCommit: plainBaseCommit } : {}),
        ...(requestedSessionId !== undefined
          ? { sessionId: requestedSessionId }
          : {}),
      });
      spawnCompleted = true;
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
            .removeUserWorktree(worktreeMeta.slug, {
              deleteBranch: true,
              baseCommit: worktreeBaseCommit,
            })
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
            await runWithWorkspaceRuntimeStorage(runtime, () =>
              deleteDaemonSessionIfOrphan({
                sessionId: session.sessionId,
                service: createWorkspaceRuntimeSessionService(runtime),
                bridge: runtime.bridge,
                coordinator: archiveCoordinator,
              }),
            );
          } catch {
            // Runtime disposal remains responsible for final containment.
          }
        } else {
          await runtime.bridge
            .detachClient(session.sessionId, session.clientId)
            .catch(() => {});
        }
        // Relocation is only attempted after this check, so no session has
        // entered the worktree and nothing can own the checkout regardless of
        // how session cleanup turned out. This deliberately differs from the
        // relocation and persistence failure handlers below, which may still
        // have a live session inside the checkout and so remove it only after
        // a definitive session delete; leaving the checkout here would orphan
        // the directory, its git registration, and its branch permanently.
        if (worktreeMeta) {
          const rollbackSlug = worktreeMeta.slug;
          await new GitWorktreeService(workspaceCwd)
            .removeUserWorktree(rollbackSlug, {
              deleteBranch: true,
              baseCommit: worktreeBaseCommit,
            })
            .catch((removalError) => {
              // A failed removal here recreates the exact orphan this block
              // exists to prevent, and the caller only sees the generation
              // 503 — name the worktree in the daemon log so the leak is
              // diagnosable.
              daemonLog?.warn(
                'worktree removal failed during generation-closed rollback',
                {
                  sessionId: session.sessionId,
                  slug: rollbackSlug,
                  error:
                    removalError instanceof Error
                      ? removalError.message
                      : String(removalError),
                },
              );
            });
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
                  .removeUserWorktree(worktreeMeta.slug, {
                    deleteBranch: true,
                    baseCommit: worktreeBaseCommit,
                  })
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
          const expectedWorktreePath = fs.realpathSync(worktreeMeta.path);
          const changed = await runtime.bridge.changeSessionCwd(
            session.sessionId,
            {
              path: worktreeMeta.path,
              allowedRoots: createAllowedRoots,
            },
          );
          if (changed.newCwd !== expectedWorktreePath) {
            throw new Error('Worktree relocation returned an unexpected path');
          }
          worktreeMeta = { ...worktreeMeta, path: expectedWorktreePath };
          runtime.bridge.setSessionWorktree(session.sessionId, worktreeMeta);
          session.worktree = worktreeMeta;
          session.currentCwd = changed.newCwd;
        } catch (cdErr) {
          if (daemonLog) {
            daemonLog.warn('worktree cd failed, rolling back', {
              sessionId: session.sessionId,
              error: cdErr instanceof Error ? cdErr.message : String(cdErr),
            });
          }
          const removedSession = await runWithWorkspaceRuntimeStorage(
            runtime,
            () =>
              deleteDaemonSessionIfOrphan({
                sessionId: session.sessionId,
                service: createWorkspaceRuntimeSessionService(runtime),
                bridge: runtime.bridge,
                coordinator: archiveCoordinator,
              }),
          ).catch(() => false);
          // A bridge timeout is caller-facing only: relocation may still
          // complete after this rejection. Remove the checkout only when the
          // session was definitively removed.
          if (removedSession) {
            await new GitWorktreeService(workspaceCwd)
              .removeUserWorktree(worktreeMeta.slug, {
                deleteBranch: true,
                baseCommit: worktreeBaseCommit,
              })
              .catch(() => {});
          }
          res.status(500).json({
            error: 'Failed to relocate session into worktree',
            code: 'worktree_relocate_failed',
          });
          return;
        }

        try {
          await createWorktreeSessionMarkerExclusive(
            worktreeMeta.path,
            session.sessionId,
          );
          await writeWorktreeSession(
            createWorkspaceRuntimeSessionService(
              runtime,
            ).getWorktreeSessionPath(session.sessionId),
            {
              slug: worktreeMeta.slug,
              worktreePath: worktreeMeta.path,
              worktreeBranch: worktreeMeta.branch,
              originalCwd: workspaceCwd,
              workspaceCwd,
              originalBranch: worktreeBaseBranch ?? '',
              originalHeadCommit: worktreeBaseCommit ?? '',
              worktreeBase: worktreeBaseCommit,
              // Record the carried overlay so the orphan reaper can exempt it
              // (R9-6). Absent when the creation carried nothing.
              carriedEntries: worktreeCarriedEntries,
            },
          );
          assertRuntimeGenerationOpen?.();
          session.worktreeState = 'persisted-v1';
          worktreeDurablyAttached = true;
        } catch (persistErr) {
          daemonLog?.warn('worktree persistence failed after relocation', {
            sessionId: session.sessionId,
            error:
              persistErr instanceof Error
                ? persistErr.message
                : String(persistErr),
          });
          let removed = false;
          try {
            removed = await runWithWorkspaceRuntimeStorage(runtime, () =>
              deleteDaemonSessionIfOrphan({
                sessionId: session.sessionId,
                service: createWorkspaceRuntimeSessionService(runtime),
                bridge: runtime.bridge,
                coordinator: archiveCoordinator,
              }),
            );
          } catch {
            // Preserve the live session and its worktree when ownership is uncertain.
          }
          if (removed) {
            await new GitWorktreeService(workspaceCwd)
              .removeUserWorktree(worktreeMeta.slug, {
                deleteBranch: true,
                baseCommit: worktreeBaseCommit,
              })
              .catch(() => {});
          } else {
            daemonLog?.warn(
              'worktree preserved after persistence cleanup was inconclusive',
              {
                sessionId: session.sessionId,
                slug: worktreeMeta.slug,
                worktreePath: worktreeMeta.path,
                branch: worktreeMeta.branch,
              },
            );
          }
          res.status(500).json({
            error: 'Failed to persist worktree session ownership',
            code: 'worktree_persistence_failed',
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
      if (worktreeMeta && !worktreeDurablyAttached && !spawnCompleted) {
        await new GitWorktreeService(workspaceCwd)
          .removeUserWorktree(worktreeMeta.slug, {
            deleteBranch: true,
            baseCommit: worktreeBaseCommit,
          })
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
      // A definite startup-config rejection already closed the live
      // session in the bridge, but the recording the spawn persisted
      // survives — and reserveCreate would answer every retry of the
      // caller-supplied id with 409 session_id_conflict, while a
      // daemon-generated id leaves a listed, resumable phantom. Roll the
      // recording back the way the other spawn-failure paths do, naming
      // the session the rejection was actually applied to. Uncertain
      // outcomes keep it: the close result is unknown.
      const rejectedSessionId =
        (isSessionStartupConfigError(err) ? err.sessionId : undefined) ??
        requestedSessionId;
      if (
        rejectedSessionId !== undefined &&
        isSessionStartupConfigError(err) &&
        err.code === 'startup_config_rejected'
      ) {
        let rollbackError: unknown;
        const removed = await runWithWorkspaceRuntimeStorage(runtime, () =>
          deleteDaemonSessionIfOrphan({
            sessionId: rejectedSessionId,
            service: createWorkspaceRuntimeSessionService(runtime),
            bridge: runtime.bridge,
            coordinator: archiveCoordinator,
          }),
        ).catch((cleanupError: unknown) => {
          rollbackError = cleanupError;
          return false;
        });
        if (!removed) {
          // The definite rejection still owes the caller its 422, so an
          // inconclusive rollback — refused because the session stayed
          // live, or failed outright — is a daemon-log line, not a throw.
          daemonLog?.warn(
            'startup rejection recording rollback was inconclusive; the session id may stay occupied',
            {
              sessionId: rejectedSessionId,
              ...(rollbackError === undefined
                ? {}
                : {
                    error:
                      rollbackError instanceof Error
                        ? rollbackError.message
                        : String(rollbackError),
                  }),
            },
          );
        }
      }
      // Only the plain creation path can promise that the initialize
      // handshake preceded every durable mutation: `branch`/`worktree`
      // bodies mutate git BEFORE spawn, and their rollback above is
      // best-effort (a failed checkout rollback leaves the workspace on
      // the new branch while the error response goes out).
      sendBridgeError(res, err, {
        route: 'POST /session',
        ...(branchMeta || worktreeMeta ? {} : { initPrecedesMutations: true }),
      });
    } finally {
      sessionIdReservation?.release();
    }
  });

  const restoreSessionHandler =
    (
      action: 'load' | 'resume',
      parsedFields?: ParsedSessionRestoreFields,
      worktreeRestoreHandoff?: WorktreeRestoreHandoff,
    ) =>
    async (req: Request, res: Response) => {
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
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        try {
          const runtime = await resolveSubagentSessionRuntime(
            res,
            route,
            virtualKey.parentSessionId,
          );
          if (!runtime) return;
          const session = await runOwnerRuntimeActivity(runtime, () =>
            virtualSubagentSessions.load(runtime, sessionId, clientId),
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
          res
            .status(200)
            .json(redactSdkSurfaceReplay(session, runtime.trusted));
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
      const fields =
        parsedFields ?? parseSessionRestoreFields(req, res, body, action);
      if (fields === null) return;
      const {
        approvalMode,
        historyPageSize,
        liveReplayMode,
        compactedReplayMode,
        restoreSource,
        clientId,
      } = fields;
      if (
        isInternalWorkspaceRuntime(runtime) &&
        deps.standaloneSessionService &&
        parseCallerSuppliedSessionId(sessionId).kind === 'valid'
      ) {
        try {
          const legacyStandalone = await runWithWorkspaceRuntimeStorage(
            runtime,
            async () => {
              const service = createWorkspaceRuntimeSessionService(runtime);
              let storageSessionId: string | undefined;
              try {
                storageSessionId =
                  await service.findSessionIdIgnoringCase(sessionId);
              } catch (error) {
                if (
                  error instanceof SessionIdCaseConflictError &&
                  error.candidateSessionId === sessionId
                ) {
                  return false;
                }
                throw error;
              }
              if (storageSessionId === undefined) return false;
              const source = await readLoadableConversationSession(
                storageSessionId,
                service,
              );
              return (
                source?.kind === 'standalone' && source.persistence === 'legacy'
              );
            },
          );
          if (legacyStandalone) {
            const session =
              await deps.standaloneSessionService.restoreLegacyForCompatibility(
                action,
                sessionId,
                {
                  ...(clientId !== undefined ? { clientId } : {}),
                  ...(historyPageSize !== undefined ? { historyPageSize } : {}),
                  ...(liveReplayMode !== undefined ? { liveReplayMode } : {}),
                  ...(compactedReplayMode !== undefined
                    ? { compactedReplayMode }
                    : {}),
                  ...(approvalMode !== undefined ? { approvalMode } : {}),
                },
              );
            try {
              assertRuntimeGenerationOpen?.();
            } catch (error) {
              if (session.attached) {
                await runtime.bridge
                  .detachClient(session.sessionId, session.clientId)
                  .catch(() => {});
              } else {
                await runtime.bridge
                  .killSession(session.sessionId, {
                    requireZeroAttaches: true,
                  })
                  .catch(() => {});
              }
              throw error;
            }
            setDaemonTelemetryWorkspace(res, runtime.workspaceCwd);
            daemonLog?.info(`session ${action} (legacy standalone adoption)`, {
              sessionId: session.sessionId,
              clientId: session.clientId,
            });
            if (!res.writable) {
              if (session.attached) {
                runtime.bridge
                  .detachClient(session.sessionId, session.clientId)
                  .catch(() => {});
              } else {
                runtime.bridge
                  .killSession(session.sessionId, {
                    requireZeroAttaches: true,
                  })
                  .catch(() => {});
              }
              return;
            }
            res
              .status(200)
              .json(redactSdkSurfaceReplay(session, runtime.trusted));
            return;
          }
        } catch (error) {
          if (
            !(
              error instanceof StandaloneSessionServiceError &&
              error.code === 'standalone_session_not_found'
            )
          ) {
            sendBridgeError(res, error, { route, sessionId });
            return;
          }
        }
      }
      try {
        const outcome = await restoreSessionCore({
          action,
          runtime,
          workspaceCwd,
          sessionId,
          ...(worktreeRestoreHandoff ? { worktreeRestoreHandoff } : {}),
          archiveCoordinator,
          requestedSessionIdAdmission,
          assertRuntimeGenerationOpen,
          daemonLog,
          materializeLiveConversationDirectory:
            deps.materializeLiveConversationDirectory,
          historyPageSize,
          liveReplayMode,
          compactedReplayMode,
          clientId,
          approvalMode,
          restoreSource,
          isCancelled: () => !res.writable,
          onWorkspaceResolved: (cwd) => setDaemonTelemetryWorkspace(res, cwd),
        });
        if (outcome.kind === 'cancelled') return;
        res
          .status(200)
          .json(redactSdkSurfaceReplay(outcome.session, runtime.trusted));
        // The core's finally has already released the reservation and the
        // worktree lock by the time it returns. Never awaited: the watch's
        // per-PR lock is not re-entrant, and a restore the drain dispatched
        // must not wait on a drain.
        try {
          deps.onSessionRestored?.({ runtime, workspaceCwd, sessionId });
        } catch (err) {
          daemonLog?.warn(
            `session restored hook failed for ${sessionId}: ${String(err)}`,
          );
        }
      } catch (err) {
        if (err instanceof RequestedSessionIdAdmissionError) {
          sendRequestedSessionIdAdmissionError(res, err, route);
          return;
        }
        sendBridgeError(res, err, {
          route,
          sessionId,
        });
      }
    };

  app.post('/session/:id/load', mutate(), restoreSessionHandler('load'));
  app.post('/session/:id/resume', mutate(), restoreSessionHandler('resume'));

  // ── Worktree reset (ownership transfer) ──────────────────────────
  // POST /session/:id/worktree-reset moves a worktree session's checkout
  // ownership to a fresh replacement session: spawn in the root workspace,
  // relocate into the checkout, link the sidecar pair (supersedes /
  // supersededBy), flip the marker, then attest persisted-v1. The transfer
  // holds the worktree-keyed ownership lock for its whole duration, so a
  // restore can never pass its ownership validation mid-transfer, and two
  // resets for one checkout serialize. See
  // docs/design/channel-named-sessions-part4b.md for the full protocol.
  const resolveWorktreeOwnershipTarget = async (
    runtime: WorkspaceRuntime,
    workspaceCwd: string,
    sidecar: WorktreeSession,
    sessionId: string,
  ): Promise<{ realTarget: string; candidateRoots: string[] }> => {
    // Every refusal here is the typed invalid-state 409: the specific
    // reason goes to the daemon log, never to the wire. Returns the error
    // so call sites `throw invalidState(...)` explicitly (definite-
    // assignment analysis does not follow never-returning calls in catch).
    const invalidState = (reason: string): WorktreeResetInvalidStateError => {
      daemonLog?.warn('worktree reset rejected sidecar state', {
        sessionId,
        reason,
      });
      return new WorktreeResetInvalidStateError(sessionId);
    };
    if (sidecar.worktreeRemoved !== undefined) {
      throw new WorktreeRestoreUnavailableError(
        'This session has a retained worktree. Use /session/:id/worktree-restore before modifying it.',
      );
    }
    const realWorkspace = fs.realpathSync(workspaceCwd);
    if (sidecar.workspaceCwd !== undefined) {
      let realSidecarWorkspace: string;
      try {
        realSidecarWorkspace = fs.realpathSync(sidecar.workspaceCwd);
      } catch {
        throw invalidState('sidecar workspace is missing or inaccessible');
      }
      if (realSidecarWorkspace !== realWorkspace) {
        throw invalidState('sidecar belongs to another workspace');
      }
    }
    const workspaceRoots = [realWorkspace];
    let repoTop: string | null = null;
    try {
      repoTop = await new GitWorktreeService(realWorkspace).getRepoTopLevel();
    } catch {
      // A missing repository makes containment validation fail below.
    }
    if (repoTop && repoTop !== realWorkspace) {
      workspaceRoots.push(fs.realpathSync(repoTop));
    }
    let realOriginalCwd: string;
    try {
      realOriginalCwd = fs.realpathSync(sidecar.originalCwd);
    } catch {
      throw invalidState('sidecar original cwd is missing or inaccessible');
    }
    if (!workspaceRoots.includes(realOriginalCwd)) {
      throw invalidState('sidecar original cwd is outside the accepted roots');
    }
    const candidateRoots = workspaceRoots.map((root) =>
      path.join(root, '.qwen', 'worktrees'),
    );
    // Also the ownership lock key, so it must keep the rule stated in
    // `server/worktree-ownership-op.ts`.
    let realTarget: string;
    try {
      realTarget = fs.realpathSync(sidecar.worktreePath);
    } catch {
      throw invalidState('worktree checkout is missing or inaccessible');
    }
    const contained = candidateRoots.some((root) => {
      try {
        const realRoot = fs.realpathSync(root);
        const relative = path.relative(realRoot, realTarget);
        return (
          relative.length > 0 &&
          !relative.startsWith('..') &&
          !path.isAbsolute(relative)
        );
      } catch {
        return false;
      }
    });
    if (!contained) {
      throw invalidState('worktree path failed containment');
    }
    return { realTarget, candidateRoots };
  };

  const worktreeResetHandler = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const route = 'POST /session/:id/worktree-reset';
    const sessionId = requireSessionId(req, res);
    if (!sessionId) return;
    if (parseVirtualSubagentSessionId(sessionId)) {
      res.status(400).json({
        error: 'Virtual subagent sessions do not support worktree reset',
        code: 'unsupported_action',
        sessionId,
      });
      return;
    }
    const body = safeBody(req);
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
    const approvalMode = parseOptionalApprovalMode(body, res);
    if (approvalMode === null) return;
    const source = parseRequestedSessionSource(body, res);
    if (source === null) return;
    const modelServiceId =
      typeof body['modelServiceId'] === 'string'
        ? (body['modelServiceId'] as string)
        : undefined;
    const assertRuntimeGenerationOpen =
      captureRuntimeGenerationAssertion(runtime);
    try {
      await runOwnerRuntimeActivity(runtime, () =>
        archiveCoordinator.runSharedMany([sessionId], async () => {
          const sessionService = createWorkspaceRuntimeSessionService(runtime);
          // The session record must exist (this resolver also normalizes
          // legacy case-variant spellings to the stored id).
          const storageSessionId = await resolveSessionIdForRestore(
            sessionService,
            sessionId,
          );
          if (storageSessionId === undefined) {
            throw new SessionNotFoundError(sessionId);
          }
          const oldSidecarPath =
            sessionService.getWorktreeSessionPath(storageSessionId);
          if (
            runtime.bridge.setSessionResetPending === undefined ||
            runtime.bridge.clearSessionResetPending === undefined ||
            runtime.bridge.clearSessionWorktree === undefined ||
            runtime.bridge.severSessionClients === undefined
          ) {
            throw new Error('Bridge does not support worktree reset');
          }
          // Pre-read (unlocked) only to locate the worktree and classify the
          // entry; every value that drives a decision is re-read under the
          // ownership lock.
          const preRead = await readWorktreeSessionStrict(oldSidecarPath);
          if (
            preRead.state === 'missing' ||
            (preRead.state === 'valid' &&
              preRead.session.workspaceCwd === undefined)
          ) {
            throw new WorktreeResetUnsupportedError(sessionId);
          }
          if (preRead.state !== 'valid') {
            daemonLog?.warn('worktree reset rejected invalid sidecar', {
              sessionId,
              reason: preRead.reason,
            });
            throw new WorktreeResetInvalidStateError(sessionId);
          }
          const preTarget = await resolveWorktreeOwnershipTarget(
            runtime,
            workspaceCwd,
            preRead.session,
            sessionId,
          );
          const releaseOwnership = await acquireWorktreeOwnershipOp(
            preTarget.realTarget,
          );
          try {
            // Re-read and re-validate under the lock; a concurrent edit
            // between the pre-read and here must not drive the transfer.
            const lockedRead = await readWorktreeSessionStrict(oldSidecarPath);
            if (
              lockedRead.state === 'missing' ||
              (lockedRead.state === 'valid' &&
                lockedRead.session.workspaceCwd === undefined)
            ) {
              throw new WorktreeResetUnsupportedError(sessionId);
            }
            if (lockedRead.state !== 'valid') {
              daemonLog?.warn('worktree reset rejected invalid sidecar', {
                sessionId,
                reason: lockedRead.reason,
              });
              throw new WorktreeResetInvalidStateError(sessionId);
            }
            const oldSidecar = lockedRead.session;
            const { realTarget, candidateRoots } =
              await resolveWorktreeOwnershipTarget(
                runtime,
                workspaceCwd,
                oldSidecar,
                sessionId,
              );
            if (realTarget !== preTarget.realTarget) {
              daemonLog?.warn('worktree reset rejected: sidecar moved', {
                sessionId,
              });
              throw new WorktreeResetInvalidStateError(sessionId);
            }
            const readSummary = (
              id: string,
            ):
              | ReturnType<AcpSessionBridge['getSessionSummary']>
              | undefined => {
              try {
                return runtime.bridge.getSessionSummary(id);
              } catch (error) {
                // A session unknown to the live bridge is dormant, and a
                // dormant session is quiescent.
                if (error instanceof SessionNotFoundError) return undefined;
                throw error;
              }
            };
            runtime.bridge.setSessionResetPending(sessionId);
            let barrierArmed = true;
            try {
              let effectiveOldSidecar = oldSidecar;
              if (oldSidecar.supersededBy !== undefined) {
                // ── Resume path ──────────────────────────────────────
                // A previous transfer for this session crashed mid-flight.
                // Classify by the marker: naming the old session means the
                // flip never committed — roll the interrupted transfer back
                // and proceed with a fresh replacement in the same request;
                // naming the replacement means the flip committed — finish
                // the severance and return it. An absent marker only reads
                // as pre-commit while the replacement is dormant (below).
                const replacementId = oldSidecar.supersededBy;
                const newSidecarPath =
                  sessionService.getWorktreeSessionPath(replacementId);
                const newRead = await readWorktreeSessionStrict(newSidecarPath);
                const archivedNewSidecarPath =
                  sessionService.getWorktreeSessionPathForArchiveState(
                    replacementId,
                    'archived',
                  );
                const archivedNewRead =
                  archivedNewSidecarPath !== newSidecarPath
                    ? await readWorktreeSessionStrict(archivedNewSidecarPath)
                    : ({ state: 'missing' } as const);
                if (
                  newRead.state !== 'missing' &&
                  archivedNewRead.state !== 'missing'
                ) {
                  // Active/archived conflict on the replacement session; keep
                  // any existing resetPending fence armed.
                  barrierArmed = false;
                  throw new WorktreeResetInvalidStateError(sessionId);
                }
                const effectiveNewRead =
                  newRead.state === 'missing' ? archivedNewRead : newRead;
                if (
                  effectiveNewRead.state === 'valid' &&
                  effectiveNewRead.session.worktreeRemoved !== undefined
                ) {
                  // Ownership already moved to the replacement session; never
                  // disarm the superseded session's resetPending fence here.
                  barrierArmed = false;
                  throw new WorktreeRestoreUnavailableError(
                    'The replacement session has a retained worktree. Use /session/:id/worktree-restore before modifying it.',
                  );
                }
                if (
                  (effectiveNewRead.state === 'valid' &&
                    (effectiveNewRead.session.supersededBy !== undefined ||
                      newRead.state === 'missing')) ||
                  (newRead.state === 'missing' &&
                    archivedNewRead.state === 'invalid')
                ) {
                  // Ownership already moved past the direct replacement (or the
                  // replacement lives in archived state); never disarm the
                  // superseded session's resetPending fence.
                  barrierArmed = false;
                  throw new WorktreeResetInvalidStateError(sessionId);
                }
                // Sidecar-link agreement only. The marker is the authority on
                // what committed, so neither branch may consult the
                // replacement's transcript record: a crash can leave the
                // linked pair with no record yet, and a retry that refuses on
                // it never converges.
                const linksAgree =
                  newRead.state === 'valid' &&
                  newRead.session.supersedes === storageSessionId &&
                  newRead.session.supersededBy === undefined;
                const marker =
                  await readWorktreeSessionMarkerStrict(realTarget);
                if (marker.state === 'invalid') {
                  daemonLog?.warn('worktree reset resume rejected marker', {
                    sessionId,
                    reason: marker.reason,
                  });
                  throw new WorktreeResetInvalidStateError(sessionId);
                }
                if (
                  marker.state === 'missing' ||
                  (marker.state === 'valid' &&
                    marker.sessionId === storageSessionId)
                ) {
                  // Pre-commit: a marker naming the old session proves S_new
                  // non-authoritative, so the destructive rollback is correct
                  // and the fresh transfer below recreates the marker through
                  // the hatch.
                  if (!linksAgree) {
                    daemonLog?.warn(
                      'worktree reset resume found inconsistent links',
                      { sessionId, replacementSessionId: replacementId },
                    );
                    throw new WorktreeResetInvalidStateError(sessionId);
                  }
                  // An absent marker proves nothing on its own: a committed
                  // transfer whose git-excluded marker was later cleaned (a
                  // task-local `git clean -xdf`) reads exactly like the
                  // supervisor-cleaned pre-commit shape. A replacement still
                  // live on this daemon is that committed owner, so refuse
                  // before any destructive write instead of dismantling it
                  // and spawning a second writer. A dormant replacement is
                  // the genuine post-crash shape and still rolls back.
                  if (
                    marker.state === 'missing' &&
                    readSummary(replacementId) !== undefined
                  ) {
                    daemonLog?.warn(
                      'worktree reset resume found a live replacement with no marker',
                      { sessionId, replacementSessionId: replacementId },
                    );
                    throw new WorktreeResetInvalidStateError(sessionId);
                  }
                  const { supersededBy: _drop, ...restoredOld } = oldSidecar;
                  // Confirm the removal before the sidecar writes destroy the
                  // links a retry classifies by. `false` is a documented
                  // outcome, not an error — a client attached, so
                  // `requireZeroAttaches` bailed — and it leaves the
                  // interrupted replacement live inside the checkout, where
                  // the fresh transfer below would spawn a second writer
                  // beside it with nothing on disk naming the survivor.
                  const removed = await runWithWorkspaceRuntimeStorage(
                    runtime,
                    () =>
                      deleteDaemonSessionIfOrphan({
                        sessionId: replacementId,
                        service: sessionService,
                        bridge: runtime.bridge,
                        coordinator: archiveCoordinator,
                      }),
                  ).catch(() => false);
                  if (!removed) {
                    daemonLog?.warn(
                      'worktree reset could not remove the interrupted replacement',
                      { sessionId, replacementSessionId: replacementId },
                    );
                    throw new WorktreeResetInvalidStateError(sessionId);
                  }
                  // Undo in the reverse of the transfer's write order so a
                  // crash mid-rollback leaves the backward link alone — the
                  // shape a retry refuses for repair — instead of a forward
                  // link nothing scans for.
                  await clearWorktreeSession(newSidecarPath);
                  await writeWorktreeSession(oldSidecarPath, restoredOld);
                  daemonLog?.warn(
                    'worktree reset rolled back an interrupted transfer',
                    { sessionId, replacementSessionId: replacementId },
                  );
                  effectiveOldSidecar = restoredOld;
                } else if (
                  marker.state === 'valid' &&
                  marker.sessionId === replacementId
                ) {
                  // Committed: the replacement is the authoritative owner and
                  // is never rolled back. Finish the transfer idempotently.
                  // The marker already moved ownership, so releasing the
                  // barrier stops being this request's to do: every refusal
                  // below leaves the superseded entry fenced for the retry
                  // that finishes the severance, exactly as the survivor
                  // branch does, instead of re-admitting a writer to a
                  // checkout the marker has handed to the replacement.
                  barrierArmed = false;
                  if (!linksAgree) {
                    daemonLog?.warn(
                      'worktree reset resume found inconsistent links',
                      { sessionId, replacementSessionId: replacementId },
                    );
                    throw new WorktreeResetInvalidStateError(sessionId);
                  }
                  const newSummary = readSummary(replacementId);
                  if (
                    newSummary &&
                    (newSummary.hasActivePrompt ||
                      (newSummary.pendingInteractionCount ?? 0) > 0)
                  ) {
                    throw new WorktreeResetActiveError(replacementId);
                  }
                  // Carry the superseded session's recorded start onto the
                  // resumed replacement too (R9-13): its worktree.baseCommit is
                  // the creation tip T, and T..HEAD would hide the session's own
                  // pre-handoff S..T commits.
                  const supersededSummary = readSummary(sessionId);
                  const priorStart =
                    supersededSummary?.baseCommit ??
                    supersededSummary?.branch?.baseCommit ??
                    supersededSummary?.worktree?.baseCommit;
                  if (priorStart) {
                    runtime.bridge.setSessionBaseCommit?.(
                      replacementId,
                      priorStart,
                    );
                  }
                  runtime.bridge.clearSessionWorktree(sessionId);
                  const severCompleted =
                    await runtime.bridge.severSessionClients(sessionId);
                  if (severCompleted) {
                    runtime.bridge.clearSessionResetPending(sessionId);
                  } else {
                    // The same hold the fresh transfer's sever step reports:
                    // keep the barrier armed on the surviving superseded
                    // entry instead of certifying a severance that did not
                    // happen.
                    daemonLog?.warn(
                      'worktree reset left the superseded session live',
                      { sessionId, replacementSessionId: replacementId },
                    );
                  }
                  assertRuntimeGenerationOpen?.();
                  daemonLog?.info(
                    'worktree session reset resumed after interruption',
                    { sessionId, replacementSessionId: replacementId },
                  );
                  res.status(200).json({
                    sessionId: replacementId,
                    workspaceCwd,
                    currentCwd: realTarget,
                    worktree: {
                      slug: oldSidecar.slug,
                      path: realTarget,
                      branch: oldSidecar.worktreeBranch,
                      baseCommit:
                        oldSidecar.worktreeBase ||
                        oldSidecar.originalHeadCommit ||
                        undefined,
                      baseBranch: oldSidecar.originalBranch || undefined,
                    },
                    worktreeState: 'persisted-v1',
                    attached: false,
                    ...(severCompleted ? {} : { supersededSessionLive: true }),
                  });
                  return;
                } else {
                  daemonLog?.warn(
                    'worktree reset resume found a marker naming another session',
                    { sessionId },
                  );
                  // Ownership already moved past this superseded session; keep
                  // any existing resetPending fence armed.
                  barrierArmed = false;
                  throw new WorktreeResetInvalidStateError(sessionId);
                }
              }

              // ── Fresh transfer (also the fall-through after a pre-commit
              // rollback) ─────────────────────────────────────────────
              const oldSummary = readSummary(sessionId);
              if (
                oldSummary &&
                (oldSummary.hasActivePrompt ||
                  (oldSummary.pendingInteractionCount ?? 0) > 0)
              ) {
                throw new WorktreeResetActiveError(sessionId);
              }
              let spawnedNew: { sessionId: string } | undefined;
              let newSidecarWritten = false;
              let oldSupersededWritten = false;
              let markerTransferred = false;
              try {
                assertRuntimeGenerationOpen?.();
                // 1. The replacement spawns in the root workspace with the
                // same thread-scope, source and worktree metadata conventions
                // as a fresh worktree creation, minus worktree creation. The
                // worktree metadata also keeps it on the Legacy engine.
                // Carry the superseded session's recorded start so the
                // replacement keeps its pre-handoff commits: worktree.baseCommit
                // below is the worktree's creation tip T, and T..HEAD would hide
                // the session's own S..T work (R9-13). T stays on the worktree
                // meta for the handoff rewind classification.
                const priorStart =
                  oldSummary?.baseCommit ??
                  oldSummary?.branch?.baseCommit ??
                  oldSummary?.worktree?.baseCommit;
                const spawned = await runtime.bridge.spawnOrAttach({
                  workspaceCwd,
                  modelServiceId,
                  sessionScope: 'thread',
                  ...(priorStart ? { baseCommit: priorStart } : {}),
                  ...(approvalMode !== undefined ? { approvalMode } : {}),
                  ...(source.sourceType !== undefined
                    ? { sourceType: source.sourceType }
                    : {}),
                  ...(source.sourceId !== undefined
                    ? { sourceId: source.sourceId }
                    : {}),
                  worktree: {
                    slug: effectiveOldSidecar.slug,
                    path: realTarget,
                    branch: effectiveOldSidecar.worktreeBranch,
                    baseCommit:
                      effectiveOldSidecar.worktreeBase ||
                      effectiveOldSidecar.originalHeadCommit ||
                      undefined,
                    baseBranch: effectiveOldSidecar.originalBranch || undefined,
                  },
                });
                spawnedNew = { sessionId: spawned.sessionId };
                // 2. Relocate into the checkout.
                const changed = await runtime.bridge.changeSessionCwd(
                  spawned.sessionId,
                  { path: realTarget, allowedRoots: candidateRoots },
                );
                if (changed.newCwd !== realTarget) {
                  throw new Error('Worktree relocation was rejected');
                }
                // 3. The old sidecar names its replacement first: that
                // backward link is the only door into the resume
                // classification above, so a crash between the two writes
                // stays observable to a retry — it refuses the disagreeing
                // pair for operator repair instead of spawning a second
                // replacement and stranding the first under a dangling
                // forward link nothing ever scans for.
                await writeWorktreeSession(oldSidecarPath, {
                  ...effectiveOldSidecar,
                  supersededBy: spawned.sessionId,
                });
                oldSupersededWritten = true;
                // 4. The replacement's sidecar carries the forward link.
                const newSidecarPath = sessionService.getWorktreeSessionPath(
                  spawned.sessionId,
                );
                const {
                  supersededBy: _dropOld,
                  supersedes: _dropOldLink,
                  ...oldSidecarCore
                } = effectiveOldSidecar;
                await writeWorktreeSession(newSidecarPath, {
                  ...oldSidecarCore,
                  supersedes: storageSessionId,
                });
                newSidecarWritten = true;
                // The caller is gone — an expired `fetchWithTimeout` budget
                // aborts the socket mid-transfer. Only the fresh-transfer 200
                // carries the bridge-minted owner registration, so a handover
                // nobody receives leaves one no client can detach, and past
                // the flip below it could not be undone anyway: refuse here
                // and let the pre-commit rollback reap the replacement. Do
                // not test `res.writable` — it is an own data property that
                // stays `true` after a disconnect, unlike these two.
                if (res.destroyed || res.socket?.writable === false) {
                  throw new Error(
                    'Client disconnected before the worktree ownership flip',
                  );
                }
                // 5. A prompt admitted in the check-to-arm window and still
                // winding down aborts the transfer; after the flip it would
                // write into a checkout whose ownership just moved.
                const windingDown = readSummary(sessionId);
                if (
                  windingDown &&
                  (windingDown.hasActivePrompt ||
                    (windingDown.pendingInteractionCount ?? 0) > 0)
                ) {
                  throw new WorktreeResetActiveError(sessionId);
                }
                const markerBeforeFlip =
                  await readWorktreeSessionMarkerStrict(realTarget);
                try {
                  await transferWorktreeSessionMarkerOwner(
                    realTarget,
                    markerBeforeFlip.state === 'missing'
                      ? null
                      : storageSessionId,
                    spawned.sessionId,
                  );
                } catch (markerError) {
                  // Bounded typed failure: the core primitive's message can
                  // carry I/O detail; the daemon log gets it, the wire does
                  // not. The rollback below runs before this propagates.
                  daemonLog?.warn('worktree marker transfer failed', {
                    sessionId,
                    replacementSessionId: spawned.sessionId,
                    error:
                      markerError instanceof Error
                        ? markerError.message
                        : String(markerError),
                  });
                  if (markerError instanceof WorktreeMarkerCommittedError) {
                    // The primitive's own post-commit tail failed with the
                    // marker already naming the replacement, so the flip did
                    // happen: never compensate backwards, and never report
                    // the invalid-state 409 whose contract is that this
                    // request changed nothing. A retry resumes the committed
                    // transfer idempotently.
                    markerTransferred = true;
                    barrierArmed = false;
                    throw new Error(
                      'Worktree ownership moved to the replacement, but the marker commit did not finish cleanly; retry the reset to complete the transfer',
                    );
                  }
                  throw new WorktreeResetInvalidStateError(sessionId);
                }
                markerTransferred = true;
                // Ownership moved, so this request stops owning the barrier
                // release: a completed severance clears it explicitly below,
                // while a survivor's fence — or a failure anywhere in this
                // post-flip tail — has to outlive the request that left it
                // armed rather than re-admit a writer to a checkout the
                // marker already handed to the replacement.
                barrierArmed = false;
                // 6. Attest the replacement, then bring the superseded
                // session's runtime view in line with the disk: no worktree
                // association, no attaches.
                const newWorktree = {
                  slug: effectiveOldSidecar.slug,
                  path: realTarget,
                  branch: effectiveOldSidecar.worktreeBranch,
                  baseCommit:
                    effectiveOldSidecar.worktreeBase ||
                    effectiveOldSidecar.originalHeadCommit ||
                    undefined,
                  baseBranch: effectiveOldSidecar.originalBranch || undefined,
                };
                runtime.bridge.setSessionWorktree(
                  spawned.sessionId,
                  newWorktree,
                );
                assertRuntimeGenerationOpen?.();
                runtime.bridge.clearSessionWorktree(sessionId);
                const severCompleted =
                  await runtime.bridge.severSessionClients(sessionId);
                if (severCompleted) {
                  runtime.bridge.clearSessionResetPending(sessionId);
                } else {
                  // The child holds background work, so the last detach's
                  // idle close was refused and the superseded session is
                  // still live inside the checkout whose ownership just
                  // moved. Keep the prompt barrier armed — it is the only
                  // fence left on that entry — and report the hold instead of
                  // certifying a severance that did not happen. Escalating to
                  // killSession is not an option: it turns a close error into
                  // a channel kill, and the replacement was spawned onto that
                  // same workspace-bound bridge.
                  daemonLog?.warn(
                    'worktree reset left the superseded session live',
                    {
                      sessionId,
                      replacementSessionId: spawned.sessionId,
                    },
                  );
                }
                daemonLog?.info('worktree session reset', {
                  sessionId,
                  replacementSessionId: spawned.sessionId,
                });
                res.status(200).json({
                  ...spawned,
                  currentCwd: realTarget,
                  worktree: newWorktree,
                  worktreeState: 'persisted-v1',
                  ...(severCompleted ? {} : { supersededSessionLive: true }),
                });
              } catch (transferError) {
                if (markerTransferred) {
                  // Past the point of no return: the checkout belongs to the
                  // replacement. The superseded redirect heals the caller's
                  // registry on its next selection; never compensate
                  // backwards here.
                  daemonLog?.warn(
                    'worktree reset failed after the ownership flip',
                    {
                      sessionId,
                      replacementSessionId: spawnedNew?.sessionId,
                      error:
                        transferError instanceof Error
                          ? transferError.message
                          : String(transferError),
                    },
                  );
                  throw transferError;
                }
                // Roll back to the pre-commit shape: the old session keeps
                // ownership and a retry starts a fresh transfer. The removal
                // goes first and has to be confirmed — `false` means a client
                // attached, so the replacement is still live inside the
                // checkout. Unwriting the links anyway would leave that
                // survivor with nothing on disk naming it and a retry would
                // spawn a second writer beside it; keeping the pair makes the
                // retry take the resume path above and refuse for repair.
                if (spawnedNew) {
                  const orphanSessionId = spawnedNew.sessionId;
                  const removed = await runWithWorkspaceRuntimeStorage(
                    runtime,
                    () =>
                      deleteDaemonSessionIfOrphan({
                        sessionId: orphanSessionId,
                        service: sessionService,
                        bridge: runtime.bridge,
                        coordinator: archiveCoordinator,
                      }),
                  ).catch(() => false);
                  if (!removed) {
                    daemonLog?.warn(
                      'worktree reset could not remove the spawned replacement',
                      { sessionId, replacementSessionId: orphanSessionId },
                    );
                    throw transferError;
                  }
                }
                // Undo in the reverse of the write order above so a crash
                // mid-rollback leaves the backward link alone — the shape a
                // retry refuses for repair — instead of a forward link
                // nothing scans for.
                if (newSidecarWritten && spawnedNew) {
                  await clearWorktreeSession(
                    sessionService.getWorktreeSessionPath(spawnedNew.sessionId),
                  );
                }
                if (oldSupersededWritten) {
                  await writeWorktreeSession(
                    oldSidecarPath,
                    effectiveOldSidecar,
                  );
                }
                throw transferError;
              }
            } finally {
              if (barrierArmed) {
                runtime.bridge.clearSessionResetPending(sessionId);
              }
            }
          } finally {
            releaseOwnership();
          }
        }),
      );
    } catch (err) {
      if (!res.headersSent) {
        sendBridgeError(res, err, { route, sessionId });
      }
    }
  };
  app.post('/session/:id/worktree-reset', mutate(), worktreeResetHandler);

  const worktreeRestoreHandler = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const route = 'POST /session/:id/worktree-restore';
    const sessionId = requireSessionId(req, res);
    if (!sessionId) return;
    if (parseVirtualSubagentSessionId(sessionId)) {
      res.status(400).json({
        error: 'Virtual subagent sessions do not support worktree restore',
        code: 'unsupported_action',
        sessionId,
      });
      return;
    }
    const body = safeBody(req);
    let worktreeRestoreHandoff: WorktreeRestoreHandoff | undefined;
    try {
      const resolved = await resolveRuntimeForSessionRestore(
        body,
        res,
        route,
        sessionId,
      );
      if (resolved === undefined) return;
      const { runtime } = resolved;
      if (isInternalWorkspaceRuntime(runtime)) {
        res.status(400).json({
          error:
            'Conversation sessions do not support snapshot worktree restore',
          code: 'unsupported_action',
          sessionId,
        });
        return;
      }
      if (runtime.routeFileSystemFactory.sshWorkspace) {
        res.status(501).json({
          error: 'Restore through the remote workspace client',
          code: 'ssh_workspace_operation_unsupported',
          sessionId,
        });
        return;
      }
      const assertRuntimeGenerationOpen =
        captureRuntimeGenerationAssertion(runtime);
      const fields = parseSessionRestoreFields(req, res, body, 'load');
      if (fields === null) return;
      const service = createWorkspaceRuntimeSessionService(runtime);
      const storedSessionId = await resolveSessionIdForRestore(
        service,
        sessionId,
      );
      if (storedSessionId === undefined) {
        throw new SessionNotFoundError(sessionId);
      }
      let busy = false;
      const busyCandidateIds = [
        ...new Set([
          sessionId,
          normalizeSessionIdForLookup(sessionId),
          storedSessionId,
        ]),
      ];
      let liveOnBridge = false;
      for (const candidateId of busyCandidateIds) {
        try {
          const summary = runtime.bridge.getSessionSummary(candidateId);
          liveOnBridge = true;
          busy =
            summary.hasActivePrompt ||
            (summary.pendingPromptCount ?? 0) > 0 ||
            (summary.pendingInteractionCount ?? 0) > 0;
          break;
        } catch (error) {
          // An offline retained chat has no live summary to be busy in.
          if (
            !isSessionNotFoundError(error) ||
            (error as SessionNotFoundError).code === 'session_closing'
          ) {
            throw error;
          }
        }
      }
      if (busy) {
        res.status(409).json({
          error:
            'The session is busy; restore it after the active turn settles',
          code: 'worktree_restore_active',
          sessionId,
        });
        return;
      }
      assertNotRetirementFenced(runtime.bridge, [sessionId, storedSessionId]);
      if (
        (await service.getMaintainableSessionLocation(storedSessionId)) ===
        'conflict'
      ) {
        throw new SessionConflictError(storedSessionId);
      }
      if (!liveOnBridge) {
        // Cold worktree restore always allocates a fresh child in the
        // subsequent load. Refuse before mutating git/disk while overload
        // admission is closed; already-live sessions remain warm and proceed.
        const load = getLoadAdmissionSnapshot?.();
        if (load?.overloaded) {
          throw new SystemOverloadedError(
            load.reason ?? 'cpu_load',
            load.loadRatio,
            load.eventLoopLagP99Ms,
          );
        }
      }
      await runOwnerRuntimeActivity(runtime, async () => {
        await restoreWorktreeFromSessionSnapshot({
          runtime,
          sessionId: storedSessionId,
          archiveCoordinator,
          assertRuntimeGenerationOpen,
          handoffWorktreeOwnership: (handoff) => {
            worktreeRestoreHandoff = handoff;
          },
          explicitWorkspaceCwd: Object.hasOwn(body, 'cwd'),
        });
      });
      invalidateSessionListsAndMarkCatalog(runtime, ['active']);
      await restoreSessionHandler(
        'load',
        fields,
        worktreeRestoreHandoff,
      )(req, res);
    } catch (err) {
      if (res.headersSent) return;
      if (sendConversationRuntimeError(res, err)) return;
      if (err instanceof WorktreeRestoreUnavailableError) {
        res.status(409).json({
          error: err.message,
          code: err.code,
          sessionId,
        });
        return;
      }
      sendBridgeError(res, err, { route, sessionId });
    } finally {
      worktreeRestoreHandoff?.release();
    }
  };
  app.post('/session/:id/worktree-restore', mutate(), worktreeRestoreHandler);

  // "Create branch here" (Codex parity): turn a detached managed worktree
  // into a named branch at its current HEAD, in place. No session transfer —
  // the checkout, marker owner, and session id all stay; only the branch
  // metadata changes. Serialized against reset/restore by the same
  // worktree-keyed ownership lock.
  const worktreeBranchHandler = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const route = 'POST /session/:id/worktree-branch';
    const sessionId = requireSessionId(req, res);
    if (!sessionId) return;
    if (parseVirtualSubagentSessionId(sessionId)) {
      res.status(400).json({
        error:
          'Virtual subagent sessions do not support worktree branch creation',
        code: 'unsupported_action',
        sessionId,
      });
      return;
    }
    const body = safeBody(req);
    const name = body['name'];
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      !isValidGitBranchName(name)
    ) {
      res.status(400).json({
        error: '`name` must be a valid git branch name',
        code: 'branch_invalid_name',
      });
      return;
    }
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
    try {
      await runOwnerRuntimeActivity(runtime, () =>
        archiveCoordinator.runSharedMany([sessionId], async () => {
          const sessionService = createWorkspaceRuntimeSessionService(runtime);
          let storageSessionId = await resolveSessionIdForRestore(
            sessionService,
            sessionId,
          );
          if (storageSessionId === undefined) {
            // A freshly created session may have no transcript yet (the
            // user branches before the first prompt); the live bridge
            // summary is authoritative for it. Throws when unknown.
            runtime.bridge.getSessionSummary(sessionId);
            storageSessionId = sessionId;
          }
          // Same busy gate as worktree-reset: branching reads HEAD and
          // writes a ref, which must not race an in-flight turn.
          const branchBusySummary =
            runtime.bridge.getSessionSummary(storageSessionId);
          if (
            branchBusySummary.hasActivePrompt ||
            (branchBusySummary.pendingPromptCount ?? 0) > 0
          ) {
            throw new BranchWhilePromptActiveError(storageSessionId);
          }
          if (runtime.bridge.setSessionWorktree === undefined) {
            throw new Error('Bridge does not support worktree branch creation');
          }
          const sidecarPath =
            sessionService.getWorktreeSessionPath(storageSessionId);
          const preRead = await readWorktreeSessionStrict(sidecarPath);
          if (
            preRead.state === 'missing' ||
            (preRead.state === 'valid' &&
              preRead.session.workspaceCwd === undefined)
          ) {
            res.status(409).json({
              error: 'Session has no managed worktree',
              code: 'worktree_branch_unsupported',
              sessionId: storageSessionId,
            });
            return;
          }
          if (preRead.state !== 'valid') {
            throw new WorktreeResetInvalidStateError(storageSessionId);
          }
          const { realTarget } = await resolveWorktreeOwnershipTarget(
            runtime,
            workspaceCwd,
            preRead.session,
            storageSessionId,
          );
          const releaseOwnership = await acquireWorktreeOwnershipOp(realTarget);
          try {
            // Re-read under the lock: a concurrent reset may have moved
            // ownership or branched the checkout since the pre-read.
            const lockedRead = await readWorktreeSessionStrict(sidecarPath);
            if (lockedRead.state !== 'valid') {
              throw new WorktreeResetInvalidStateError(storageSessionId);
            }
            const sidecar = lockedRead.session;
            if (sidecar.worktreeRemoved !== undefined) {
              throw new WorktreeRestoreUnavailableError(
                'This session has a retained worktree. Use /session/:id/worktree-restore before modifying it.',
              );
            }
            if (sidecar.worktreeBranch !== '') {
              res.status(409).json({
                error: 'Worktree already has a branch',
                code: 'worktree_already_branched',
                sessionId: storageSessionId,
              });
              return;
            }
            // A superseded sidecar means a reset moved the checkout to a
            // replacement session; the marker must still name this session.
            if (sidecar.supersededBy !== undefined) {
              throw new WorktreeResetInvalidStateError(storageSessionId);
            }
            const branchMarker =
              await readWorktreeSessionMarkerStrict(realTarget);
            if (
              branchMarker.state !== 'valid' ||
              branchMarker.sessionId !== storageSessionId
            ) {
              throw new WorktreeResetInvalidStateError(storageSessionId);
            }
            const wtService = new GitWorktreeService(workspaceCwd);
            if (await wtService.localBranchExists(name)) {
              res.status(409).json({
                error: `Branch ${name} already exists`,
                code: 'branch_already_exists',
                sessionId: storageSessionId,
              });
              return;
            }
            assertRuntimeGenerationOpen?.();
            await wtService.createWorktreeBranch(realTarget, name);
            await writeWorktreeSession(sidecarPath, {
              ...sidecar,
              worktreeBranch: name,
            });
            // Branching the checkout must not drop the session's start
            // commit/base branch: the change overview still scopes its window
            // to them, so carry them onto the live meta and the response.
            const branchedWorktree = {
              slug: sidecar.slug,
              path: realTarget,
              branch: name,
              baseCommit:
                sidecar.worktreeBase || sidecar.originalHeadCommit || undefined,
              baseBranch: sidecar.originalBranch || undefined,
            };
            runtime.bridge.setSessionWorktree(
              storageSessionId,
              branchedWorktree,
            );
            res.status(200).json({
              sessionId: storageSessionId,
              worktree: branchedWorktree,
            });
          } finally {
            releaseOwnership();
          }
        }),
      );
    } catch (err) {
      if (!res.headersSent) {
        sendBridgeError(res, err, { route, sessionId });
      }
    }
  };
  app.post('/session/:id/worktree-branch', mutate(), worktreeBranchHandler);

  // "Hand off" (Codex parity): move the SAME session between its managed
  // worktree and the local checkout, carrying the work. Design D6 documents
  // the protocol and the v1 limitations (local-clean stands in for occupancy;
  // no crash-window atomic rollback).
  const worktreeHandoffHandler = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const route = 'POST /session/:id/worktree-handoff';
    const sessionId = requireSessionId(req, res);
    if (!sessionId) return;
    if (parseVirtualSubagentSessionId(sessionId)) {
      res.status(400).json({
        error: 'Virtual subagent sessions do not support worktree handoff',
        code: 'unsupported_action',
        sessionId,
      });
      return;
    }
    const body = safeBody(req);
    const to = body['to'];
    if (to !== 'local' && to !== 'worktree') {
      res.status(400).json({
        error: "`to` must be 'local' or 'worktree'",
        code: 'invalid_handoff_target',
      });
      return;
    }
    const name = body['name'];
    if (
      name !== undefined &&
      (typeof name !== 'string' ||
        name.length === 0 ||
        !isValidGitBranchName(name))
    ) {
      res.status(400).json({
        error: '`name` must be a valid git branch name',
        code: 'branch_invalid_name',
      });
      return;
    }
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
    try {
      await runOwnerRuntimeActivity(runtime, () =>
        archiveCoordinator.runSharedMany([sessionId], async () => {
          const sessionService = createWorkspaceRuntimeSessionService(runtime);
          let storageSessionId = await resolveSessionIdForRestore(
            sessionService,
            sessionId,
          );
          if (storageSessionId === undefined) {
            runtime.bridge.getSessionSummary(sessionId);
            storageSessionId = sessionId;
          }
          const sidecarPath =
            sessionService.getWorktreeSessionPath(storageSessionId);
          const realWorkspace = fs.realpathSync(workspaceCwd);

          if (to === 'local') {
            const preRead = await readWorktreeSessionStrict(sidecarPath);
            if (
              preRead.state === 'missing' ||
              (preRead.state === 'valid' &&
                preRead.session.workspaceCwd === undefined)
            ) {
              res.status(409).json({
                error: 'Session has no managed worktree',
                code: 'worktree_handoff_unsupported',
                sessionId: storageSessionId,
              });
              return;
            }
            if (preRead.state !== 'valid') {
              throw new WorktreeResetInvalidStateError(storageSessionId);
            }
            const { realTarget } = await resolveWorktreeOwnershipTarget(
              runtime,
              workspaceCwd,
              preRead.session,
              storageSessionId,
            );
            const releaseOwnership =
              await acquireWorktreeOwnershipOp(realTarget);
            // The reset-pending fence is a non-refcounted set: only clear it
            // in the finally if THIS request armed it. A refusal that exits
            // before arming (superseded sidecar, marker mismatch, ...) must
            // not release a fence another operation (e.g. a refused reset)
            // is still holding.
            let barrierArmed = false;
            // R11-1: the realTarget lock serializes the worktree being LEFT,
            // not the local checkout being mutated. Two handoffs from
            // different worktrees into one checkout hold different realTarget
            // keys, so also lock the local checkout (nested) once its path is
            // known; released in the same finally.
            let releaseLocalOwnership: (() => void) | null = null;
            try {
              const lockedRead = await readWorktreeSessionStrict(sidecarPath);
              if (lockedRead.state !== 'valid') {
                throw new WorktreeResetInvalidStateError(storageSessionId);
              }
              const sidecar = lockedRead.session;
              // A superseded sidecar means a reset moved the checkout to a
              // replacement session; the marker must still name this session.
              if (sidecar.worktreeRemoved !== undefined) {
                throw new WorktreeRestoreUnavailableError(
                  'This session has a retained worktree. Use /session/:id/worktree-restore before modifying it.',
                );
              }
              if (sidecar.supersededBy !== undefined) {
                throw new WorktreeResetInvalidStateError(storageSessionId);
              }
              const handoffMarker =
                await readWorktreeSessionMarkerStrict(realTarget);
              if (
                handoffMarker.state !== 'valid' ||
                handoffMarker.sessionId !== storageSessionId
              ) {
                throw new WorktreeResetInvalidStateError(storageSessionId);
              }
              // Fence prompt admission for the whole transfer. The busy
              // gate below only sees prompts already active; a prompt
              // admitted mid-handoff would write files after the snapshot
              // and lose its last edits (the queue-tail check runs after
              // the queue drains, so it cannot catch that interleaving).
              // The reset-pending barrier is the bridge's existing
              // admission fence: sendPrompt, cd, workflow actions and goal
              // control all fail closed on it while it is armed.
              if (
                runtime.bridge.setSessionResetPending === undefined ||
                runtime.bridge.clearSessionResetPending === undefined
              ) {
                throw new Error(
                  'Bridge does not support handoff serialization',
                );
              }
              runtime.bridge.setSessionResetPending(storageSessionId);
              barrierArmed = true;
              let localCwd: string;
              try {
                localCwd = fs.realpathSync(sidecar.originalCwd);
              } catch {
                throw new WorktreeResetInvalidStateError(storageSessionId);
              }
              // Serialize on the checkout actually being mutated (R11-1), so
              // the cleanliness/occupancy gates below and the carry/checkout
              // cannot interleave with another handoff into the same tree.
              releaseLocalOwnership =
                await acquireWorktreeOwnershipOp(localCwd);
              const localService = new GitWorktreeService(localCwd);
              // An upgraded checkout may still hold the old daemon-written
              // .qwen/.gitignore; migrate it before the clean gate so the
              // daemon's own residue does not refuse the handoff.
              await localService.migrateLegacyWorktreeGitignore();
              if (await localService.hasWorktreeChanges(localCwd)) {
                res.status(409).json({
                  error: 'Local checkout has uncommitted changes',
                  code: 'local_checkout_dirty',
                  sessionId: storageSessionId,
                });
                return;
              }
              // Refuse a busy session before any git mutation: the
              // snapshot/branch/checkout below do not run on the bridge's
              // prompt queue, so an in-flight turn could write files after
              // the copy and leave its last edits behind. Same gate as the
              // worktree-reset route; changeSessionCwd re-checks at the
              // queue tail for the race window after this read.
              const localBusySummary =
                runtime.bridge.getSessionSummary(storageSessionId);
              if (
                localBusySummary.hasActivePrompt ||
                (localBusySummary.pendingPromptCount ?? 0) > 0
              ) {
                throw new CdWhilePromptActiveError(storageSessionId);
              }
              // Refuse when another live client-attached non-worktree session
              // occupies the local checkout: the branch checkout below moves
              // its shared HEAD (and the snapshot writes its files), which
              // would silently relocate that session onto the handed-off
              // branch. The branch route applies the same predicate; ownership
              // is keyed on the worktree path, so two sessions from different
              // worktrees sharing one originalCwd hold different locks over
              // this same checkout. Worktree sessions are exempt — they run in
              // their own cwd, including the handing-off session itself.
              // listWorkspaceSessions only answers for the BOUND workspace;
              // asking about localCwd when it differs (a branch-route sidecar
              // whose originalCwd is the repo top while the daemon is bound to
              // a subdirectory) silently returns [], hiding exactly the
              // occupants of the shared checkout (R9-1). Query the bound
              // workspace, and fail closed when the checkout being moved is
              // not that workspace — its occupants cannot be enumerated.
              let boundWorkspaceReal: string;
              try {
                boundWorkspaceReal = fs.realpathSync(runtime.workspaceCwd);
              } catch {
                boundWorkspaceReal = runtime.workspaceCwd;
              }
              if (localCwd !== boundWorkspaceReal) {
                res.status(409).json({
                  error:
                    'Cannot verify the occupants of the local checkout; handing off would move a shared checkout',
                  code: 'handoff_workspace_occupied',
                  sessionId: storageSessionId,
                });
                return;
              }
              // Policy (6902429921): the occupancy guard protects a live
              // HUMAN attachment — a user actively viewing/editing the shared
              // checkout whose HEAD a handoff would move. Agent sessions
              // (AGENT_HOST / AGENT source types) are daemon-spawned subagent
              // subprocesses, not independent user attachments: they have no
              // user watching the checkout, and their work is owned by the
              // parent session's worktree lifecycle, so they are deliberately
              // excluded. Worktree sessions are excluded too (they live in
              // their own checkout, not this shared one). clientCount > 0
              // keeps only sessions with a live attachment.
              const occupyingSession = runtime.bridge
                .listWorkspaceSessions(runtime.workspaceCwd)
                .find(
                  (session) =>
                    session.sourceType !== AGENT_HOST_SESSION_SOURCE_TYPE &&
                    session.sourceType !== AGENT_SESSION_SOURCE_TYPE &&
                    !session.worktree &&
                    session.clientCount > 0,
                );
              if (occupyingSession) {
                res.status(409).json({
                  error:
                    'Another session is already active in this workspace; handing off would move its shared checkout',
                  code: 'handoff_workspace_occupied',
                  existingSessionId: occupyingSession.sessionId,
                  sessionId: storageSessionId,
                });
                return;
              }
              const wtService = new GitWorktreeService(workspaceCwd);
              const wtCheckoutService = new GitWorktreeService(realTarget);
              // gateBase describes originalCwd's checkout (the local HEAD
              // the gate compares against); base is the commit the worktree
              // was created at (the promotion test). They differ when a
              // branch worktree was created from a sibling managed worktree.
              const gateBase = sidecar.originalHeadCommit;
              const base = sidecar.worktreeBase ?? sidecar.originalHeadCommit;
              // The local checkout may have moved ahead of the recorded
              // base — committing locally while the agent works in the
              // worktree is the normal reason to use one. A descendant is
              // reconcilable for the snapshot-only path (the snapshot
              // applies on top; a conflicting apply is refused below). A
              // divergent or unreadable HEAD is terminal. The descendant
              // case is re-checked below once we know whether a branch will
              // be checked out — checking out a branch would drop the user's
              // own ahead-of-base commit from the working tree.
              let localHead: string | undefined;
              if (gateBase) {
                localHead = await getHeadCommit(localCwd);
                if (
                  !localHead ||
                  (localHead !== gateBase &&
                    !(await isCommitAncestor(gateBase, localHead, localCwd)))
                ) {
                  res.status(409).json({
                    error:
                      'Local checkout HEAD moved past the recorded handoff base',
                    code: 'local_head_moved',
                    sessionId: storageSessionId,
                  });
                  return;
                }
              }
              // Carry the work before moving the session: branch checkout
              // first, then the tracked dirty snapshot, then the untracked
              // overlay (stash create excludes untracked files).
              const info =
                await wtService.getRegisteredWorktreeBranch(realTarget);
              const head = info?.headCommit ?? '';
              // Trust the checkout's actual branch, not the sidecar's
              // record: the agent runs git freely in its worktree and may
              // have switched branches since the sidecar was written.
              // Checking out the recorded branch would leave the real
              // work behind behind a 200.
              if (!info || info.branch !== sidecar.worktreeBranch) {
                res.status(409).json({
                  error:
                    'The worktree branch no longer matches the session record',
                  code: 'worktree_branch_mismatch',
                  sessionId: storageSessionId,
                });
                return;
              }
              let branch = info.branch;
              // Fail closed when the worktree HEAD or its recorded base
              // cannot be verified: skipping the promotion would report
              // success while the agent's commits stay in the worktree.
              if (!branch && (!head || !base)) {
                res.status(409).json({
                  error:
                    'Cannot verify the worktree HEAD against its recorded base',
                  code: 'worktree_handoff_base_unavailable',
                  sessionId: storageSessionId,
                });
                return;
              }
              // Promotion carries the agent's work to the local checkout only
              // when the worktree HEAD moved PAST its creation base. A HEAD
              // behind the base (an ancestor of it) would rewind the user's
              // clean checkout. This applies to the recorded-branch shape too
              // (no `!branch` short-circuit, R10-1), and the ancestry probe is
              // three-valued so an unreadable/pruned base fails closed instead
              // of being misread as "not behind" and promoted (R11-14).
              let headBehindBase = false;
              if (head && base && head !== base) {
                const ancestry = await probeCommitAncestry(
                  head,
                  base,
                  realTarget,
                );
                if (ancestry === 'unanswerable') {
                  res.status(409).json({
                    error:
                      'Cannot verify the worktree HEAD against its recorded base',
                    code: 'worktree_handoff_base_unavailable',
                    sessionId: storageSessionId,
                  });
                  return;
                }
                headBehindBase = ancestry === 'ancestor';
              }
              // A recorded branch whose tip is behind the base must be checked
              // out by the handoff, which would rewind the local checkout —
              // refuse (R10-1). The detached shape instead stays snapshot-only
              // below (R9-4), since its promotion is optional.
              if (headBehindBase && branch !== '') {
                res.status(409).json({
                  error:
                    'The worktree branch tip is behind the recorded handoff base',
                  code: 'worktree_head_behind_base',
                  sessionId: storageSessionId,
                });
                return;
              }
              // A descendant local HEAD is reconcilable only when no branch
              // is checked out (the snapshot applies on top of the local
              // HEAD). Checking out a branch — recorded, or promoted at the
              // worktree HEAD — would remove the user's own ahead-of-base
              // commit from the working tree, so refuse that combination.
              const willCheckoutBranch =
                branch !== '' || (head !== base && !headBehindBase);
              // A legacy sidecar may carry an empty originalHeadCommit, which
              // skips the local-HEAD gate above. The snapshot-only path is
              // still safe (it applies on top of the local HEAD), but a
              // branch checkout would move the local checkout without ever
              // verifying its HEAD — fail closed like the detached sibling
              // rather than silently dropping the user's ahead-of-base work.
              if (willCheckoutBranch && !gateBase) {
                res.status(409).json({
                  error:
                    'Cannot verify the local HEAD against its recorded handoff base',
                  code: 'worktree_handoff_base_unavailable',
                  sessionId: storageSessionId,
                });
                return;
              }
              // The checkout target must CONTAIN the local HEAD, else the
              // checkout rewinds the user's work — including a divergent base
              // where localHead === gateBase (so no moved-ahead flag fires)
              // but the worktree tip sits on another line (R11-6). Subsumes
              // the moved-ahead refusal; scoped to an actual branch checkout.
              if (
                willCheckoutBranch &&
                (!localHead ||
                  !(await isCommitAncestor(localHead, head, realTarget)))
              ) {
                res.status(409).json({
                  error:
                    'Local checkout HEAD moved past the recorded handoff base',
                  code: 'local_head_moved',
                  sessionId: storageSessionId,
                });
                return;
              }
              // Captured before any mutation, so a capture failure needs no
              // rollback. A silent `stash create` failure must refuse the
              // handoff rather than relocate the session without the
              // worktree's tracked edits (R13-1).
              let snapshot: string;
              try {
                snapshot = await wtService.createStashSnapshot(realTarget);
              } catch (error) {
                res.status(409).json({
                  error:
                    'The worktree snapshot could not be captured from the worktree',
                  code: 'handoff_carry_failed',
                  detail:
                    error instanceof Error ? error.message : String(error),
                  sessionId: storageSessionId,
                });
                return;
              }
              // Everything below mutates the local checkout, the worktree,
              // or the sidecar; a late failure (checkout hook, stash
              // conflict, busy-turn refusal at the queue tail) must restore
              // the pre-handoff shape so a retry is not stranded.
              let autoBranch: string | null = null;
              let localOriginalBranch: string | null = null;
              let detachedFrom: string | null = null;
              let copiedUntracked: string[] = [];
              const rollback = async (): Promise<boolean> => {
                // Whether the local checkout was force-restored to its
                // pre-handoff committed state. A failed force-checkout (e.g.
                // the same held index lock that failed the apply's own reset)
                // leaves conflict markers behind, so the refusal must not
                // claim a restore that did not happen (round-9 S18).
                let localRestored = false;
                if (copiedUntracked.length > 0) {
                  const localTop =
                    (await localService.getRepoTopLevel().catch(() => null)) ??
                    localCwd;
                  for (const rel of copiedUntracked) {
                    try {
                      fs.rmSync(path.join(localTop, rel), { force: true });
                    } catch {
                      // Best-effort: the file may already be gone.
                    }
                  }
                }
                if (localOriginalBranch !== null) {
                  localRestored = await localService
                    .forceCheckoutBranch(localCwd, localOriginalBranch)
                    .then(() => true)
                    .catch(() => false);
                }
                if (autoBranch !== null) {
                  const deleted = await wtService
                    .deleteLocalBranch(autoBranch)
                    .then(() => true)
                    .catch(() => false);
                  if (deleted) {
                    await writeWorktreeSession(sidecarPath, {
                      ...sidecar,
                      worktreeBranch: '',
                    }).catch(() => undefined);
                  } else {
                    // The delete was refused — typically because
                    // detachCheckout failed and the worktree still sits on
                    // the branch. Keep the sidecar naming it (a retry then
                    // matches); if the worktree is detached, re-attach it so
                    // the record describes the checkout again. Rewriting the
                    // sidecar to '' here would wedge every later handoff in
                    // worktree_branch_mismatch.
                    await wtService
                      .checkoutBranchInCheckout(realTarget, autoBranch)
                      .catch(() => undefined);
                  }
                } else if (detachedFrom !== null) {
                  // The worktree sat on a named branch the handoff did not
                  // create ("Create branch here"). Re-attach it after the
                  // local restore releases the ref, or the sidecar records
                  // a branch the detached checkout no longer matches and
                  // every retry 409s worktree_branch_mismatch.
                  await wtService
                    .checkoutBranchInCheckout(realTarget, detachedFrom)
                    .catch(() => undefined);
                }
                return localRestored;
              };
              // Capture the local ref before ANY mutation (the stash apply
              // and untracked carry run even when no branch is promoted),
              // so a late failure can restore the pre-handoff shape. A
              // detached local checkout rolls back to its commit, not to
              // 'HEAD' (which would stay at the promoted tip).
              const origBranch = await localService
                .getCurrentBranch()
                .catch(() => null);
              localOriginalBranch =
                origBranch === 'HEAD'
                  ? ((await getHeadCommit(localCwd)) ?? null)
                  : origBranch;
              if (!branch && head !== base && !headBehindBase) {
                branch = name || worktreeBranchForSlug(sidecar.slug);
                // Same typed refusal as the explicit-name path: an occupied
                // auto name must not degrade into a generic bridge error.
                if (await wtService.localBranchExists(branch)) {
                  res.status(409).json({
                    error: `Branch ${branch} already exists`,
                    code: 'branch_already_exists',
                    sessionId: storageSessionId,
                  });
                  return;
                }
                await wtService.createWorktreeBranch(realTarget, branch);
                autoBranch = branch;
                // Persist immediately: a later failure must not leave the
                // branch unrecorded, or every retry re-derives the same
                // name and hits branch_already_exists forever.
                await writeWorktreeSession(sidecarPath, {
                  ...sidecar,
                  worktreeBranch: branch,
                });
              }
              if (branch) {
                try {
                  // Release the branch from the worktree first: git forbids
                  // the same branch checked out in two worktrees at once.
                  // The session is leaving, so the worktree stays detached
                  // at the same commit (its dirty state survives).
                  await wtService.detachCheckout(realTarget);
                  detachedFrom = branch;
                  // Refuse (atomically) to overwrite a local ignored file the
                  // branch tracks: the clean gate cannot see ignored files, so
                  // a plain checkout could destroy unrecoverable local content.
                  await localService.checkoutBranchInCheckout(
                    localCwd,
                    branch,
                    {
                      noOverwriteIgnore: true,
                    },
                  );
                } catch (error) {
                  await rollback();
                  res.status(409).json({
                    error: `Cannot check out ${branch} in the local checkout`,
                    code: 'handoff_checkout_failed',
                    detail:
                      error instanceof Error ? error.message : String(error),
                    sessionId: storageSessionId,
                  });
                  return;
                }
              }
              let relocatedCwd: string;
              try {
                if (snapshot) {
                  try {
                    await localService.applyStashSnapshot(localCwd, snapshot);
                  } catch (error) {
                    // A conflicting 3-way apply writes markers and unmerged
                    // index entries into the user's checkout. An environment
                    // failure (unwritable index, unreadable index state) did
                    // not land the work at all; a conflict whose own restore
                    // failed (restoreFailed) leaves markers behind for
                    // rollback's force-checkout to clear. Refuse with a typed
                    // code that distinguishes content to resolve from a carry
                    // that could not apply, and surface restoreFailed so the
                    // refusal never claims a clean restore the service could
                    // not make (6903276958). The note must track what rollback
                    // actually did: when the same fault (e.g. a held index
                    // lock) also fails rollback's force-checkout, the checkout
                    // still holds markers and the refusal must say so rather
                    // than claim a restore that never happened (round-9 S18).
                    const localRestored = await rollback();
                    const isConflict =
                      error instanceof WorktreeDirtyCarryConflictError &&
                      error.conflict;
                    const restoreFailed =
                      error instanceof WorktreeDirtyCarryConflictError &&
                      error.restoreFailed;
                    res.status(409).json({
                      error: isConflict
                        ? 'The worktree snapshot conflicts with the local checkout'
                        : 'The worktree snapshot could not be applied to the local checkout',
                      code: isConflict
                        ? 'handoff_snapshot_conflict'
                        : 'handoff_carry_failed',
                      detail:
                        (error instanceof Error
                          ? error.message
                          : String(error)) +
                        (restoreFailed
                          ? localRestored
                            ? HANDOFF_RESTORE_NOTE_RESTORED
                            : HANDOFF_RESTORE_NOTE_FAILED
                          : ''),
                      sessionId: storageSessionId,
                    });
                    return;
                  }
                }
                // The stash omits a tracked deletion whose path became a
                // directory; remove the local file so the untracked carry can
                // mkdir the directory there (R11-10, the create-direction
                // carry already does this). The removed tracked file is
                // restored by rollback's forceCheckoutBranch, so it is not
                // added to copiedUntracked. A local modification to that file
                // conflicts just like a snapshot conflict — refuse, not clobber.
                try {
                  await wtCheckoutService.removeDeletedToDirectoryFiles(
                    localCwd,
                  );
                } catch (error) {
                  if (
                    error instanceof WorktreeDirtyCarryConflictError &&
                    error.conflict
                  ) {
                    await rollback();
                    res.status(409).json({
                      error:
                        'The worktree snapshot conflicts with the local checkout',
                      code: 'handoff_snapshot_conflict',
                      detail:
                        error instanceof Error ? error.message : String(error),
                      sessionId: storageSessionId,
                    });
                    return;
                  }
                  throw error;
                }
                copiedUntracked =
                  await wtCheckoutService.carryUntrackedFilesTo(localCwd);
                assertRuntimeGenerationOpen?.();
                const repoTop =
                  (await wtService.getRepoTopLevel().catch(() => null)) ??
                  realWorkspace;
                const changed = await runtime.bridge.changeSessionCwd(
                  storageSessionId,
                  {
                    path: localCwd,
                    allowedRoots: [realWorkspace, fs.realpathSync(repoTop)],
                    // This route owns the reset-pending barrier armed above.
                    allowWhileResetPending: true,
                  },
                );
                if (changed.newCwd !== localCwd) {
                  throw new Error('Handoff relocation was rejected');
                }
                relocatedCwd = changed.newCwd;
              } catch (error) {
                // A caller-facing timeout does NOT abort the queued cd
                // (mirrors the to=worktree arm): it can still land the
                // session in localCwd after this rejection. Decide by
                // observed state rather than rolling back the carried work.
                if (error instanceof BridgeTimeoutError) {
                  const observedCwd =
                    runtime.bridge.getSessionExecutionSnapshot(
                      storageSessionId,
                    ).effectiveCwd;
                  if (observedCwd === localCwd) {
                    // The cd landed: finish the transfer instead of
                    // discarding the branch/snapshot just applied locally.
                    await clearWorktreeSessionDurable(sidecarPath);
                    // Promote the worktree base into the plain start commit so
                    // the commit fallback keeps a boundary after the worktree
                    // meta is removed (R5-1).
                    if (base) {
                      runtime.bridge.setSessionBaseCommit?.(
                        storageSessionId,
                        base,
                      );
                    }
                    runtime.bridge.clearSessionWorktree?.(storageSessionId);
                    res.status(200).json({
                      sessionId: storageSessionId,
                      worktree: null,
                      currentCwd: localCwd,
                    });
                    return;
                  }
                  // Undetermined: keep the checkout + sidecar (the cd may
                  // still land); rolling back would discard the carried
                  // local work and contradict the session's real cwd.
                  throw error;
                }
                await rollback();
                throw error;
              }
              await clearWorktreeSessionDurable(sidecarPath);
              // Promote the worktree base into the plain start commit so the
              // commit fallback keeps a boundary after the worktree meta is
              // removed (R5-1).
              if (base) {
                runtime.bridge.setSessionBaseCommit?.(storageSessionId, base);
              }
              runtime.bridge.clearSessionWorktree?.(storageSessionId);
              res.status(200).json({
                sessionId: storageSessionId,
                worktree: null,
                currentCwd: relocatedCwd,
              });
            } finally {
              if (barrierArmed) {
                runtime.bridge.clearSessionResetPending?.(storageSessionId);
              }
              // Release in reverse acquisition order (local nested in realTarget).
              if (releaseLocalOwnership) {
                releaseLocalOwnership();
              }
              releaseOwnership();
            }
            return;
          }

          // to === 'worktree'
          const execution =
            runtime.bridge.getSessionExecutionSnapshot(storageSessionId);
          let sourceCwd: string;
          try {
            sourceCwd = fs.realpathSync(execution.effectiveCwd);
          } catch {
            throw new WorktreeResetInvalidStateError(storageSessionId);
          }
          const releaseOwnership = await acquireWorktreeOwnershipOp(sourceCwd);
          // Only clear the reset-pending fence in the finally if THIS
          // request armed it (the set is non-refcounted); the "already has a
          // managed worktree" 409 exits before arming and must not release a
          // fence a concurrent transfer is holding.
          let barrierArmed = false;
          try {
            // Decide inside the ownership lock, mirroring the to=local and
            // worktree-branch siblings: a pre-read outside it let two
            // concurrent requests both create a worktree, and treating an
            // invalid sidecar as "no worktree" overwrote the record and
            // orphaned the previous checkout.
            const preRead = await readWorktreeSessionStrict(sidecarPath);
            if (preRead.state === 'valid') {
              if (preRead.session.worktreeRemoved !== undefined) {
                throw new WorktreeRestoreUnavailableError(
                  'This session has a retained worktree. Use /session/:id/worktree-restore before modifying it.',
                );
              }
              res.status(409).json({
                error: 'Session already has a managed worktree',
                code: 'worktree_handoff_unsupported',
                sessionId: storageSessionId,
              });
              return;
            }
            if (preRead.state !== 'missing') {
              throw new WorktreeResetInvalidStateError(storageSessionId);
            }
            // Arm the admission fence FIRST, then read the busy gate: a
            // prompt admitted between the gate read and the arm would
            // slip past both. With the barrier armed, sendPrompt fails
            // closed synchronously, so the gate only has to catch prompts
            // admitted before the arm (pendingPromptCount covers the
            // attachment-resolution window where promptActive is false).
            if (
              runtime.bridge.setSessionResetPending === undefined ||
              runtime.bridge.clearSessionResetPending === undefined
            ) {
              throw new Error('Bridge does not support handoff serialization');
            }
            runtime.bridge.setSessionResetPending(storageSessionId);
            barrierArmed = true;
            const wtBusySummary =
              runtime.bridge.getSessionSummary(storageSessionId);
            if (
              wtBusySummary.hasActivePrompt ||
              (wtBusySummary.pendingPromptCount ?? 0) > 0
            ) {
              throw new CdWhilePromptActiveError(storageSessionId);
            }
            const sourceService = new GitWorktreeService(sourceCwd);
            await sourceService.migrateLegacyWorktreeGitignore();
            const currentBranch = await sourceService
              .getCurrentBranch()
              .catch(() => undefined);
            // Read the base from the checkout the sidecar records as
            // originalCwd (the workspace root), NOT from the session's
            // effective cwd: the return leg compares originalCwd's HEAD
            // against this base, so the pair must describe one checkout.
            // A session cd'd into a sibling checkout with a divergent HEAD
            // therefore starts its worktree at the workspace HEAD (the
            // sibling's own commits stay in the sibling); its dirty files
            // are still carried from sourceCwd below, and a carry conflict
            // fails the handoff closed rather than relocating without them.
            const baseCommit = await getHeadCommit(workspaceCwd);
            if (!baseCommit) {
              res.status(409).json({
                error: 'Cannot read the local HEAD to record the handoff base',
                code: 'worktree_handoff_base_unavailable',
                sessionId: storageSessionId,
              });
              return;
            }
            const slug = GitWorktreeService.generateAutoSlug();
            // Place the worktree under the workspace's managed root (the
            // same root POST /session uses), not the session's effective
            // cwd — a /cd into a subdirectory must not move the managed
            // directory. Capture the dirty state from the session's own
            // checkout, which may differ from the placement root. Base the
            // worktree on the recorded SHA, not a branch name: the service
            // resolves names in the placement repository, so a branch name
            // could start the worktree at a different commit than recorded.
            const placementService = new GitWorktreeService(workspaceCwd);
            const created = await placementService.createUserWorktree(
              slug,
              baseCommit,
              {
                detached: true,
                carryDirtyState: true,
                dirtyStateSource: sourceCwd,
              },
            );
            if (!created.success || !created.worktree) {
              // An in-progress merge/rebase is a user-clearable state, not a
              // daemon fault: surface the typed 409 here too (R13-2).
              if (created.code === 'worktree_merge_in_progress') {
                res.status(409).json({
                  error:
                    created.error ?? 'The workspace has an in-progress merge',
                  code: 'worktree_merge_in_progress',
                  sessionId: storageSessionId,
                });
                return;
              }
              res.status(500).json({
                error: created.error ?? 'Failed to create worktree',
                code: 'worktree_create_failed',
                sessionId: storageSessionId,
              });
              return;
            }
            const worktree = created.worktree;
            // The bridge reports the canonical (realpath'd) cwd while the
            // service returns the raw join; a symlinked workspace root
            // (macOS /var → /private/var) must not roll back the checkout
            // the session now lives in.
            let canonicalWorktreePath = worktree.path;
            try {
              canonicalWorktreePath = fs.realpathSync(worktree.path);
              await createWorktreeSessionMarkerExclusive(
                worktree.path,
                storageSessionId,
              );
              await writeWorktreeSession(sidecarPath, {
                slug,
                worktreePath: worktree.path,
                worktreeBranch: '',
                // The ownership-checked routes accept originalCwd only at
                // the workspace root or repo top; recording the session's
                // effective cwd (a /cd may point into a subdirectory)
                // would strand the session with 409s on every later route.
                originalCwd: workspaceCwd,
                workspaceCwd,
                originalBranch: currentBranch ?? '',
                originalHeadCommit: baseCommit,
                worktreeBase: baseCommit,
                // Record the carried overlay so the orphan reaper can exempt
                // it (R9-6). Absent when the handoff carried nothing.
                carriedEntries: created.carriedEntries,
                // The carry came from the session's own checkout, which a
                // /cd may have moved to a sibling: the reaper's source-side
                // check must verify THAT checkout, not originalCwd (R5-14).
                carriedFrom: sourceCwd,
              });
              assertRuntimeGenerationOpen?.();
              const changed = await runtime.bridge.changeSessionCwd(
                storageSessionId,
                {
                  path: worktree.path,
                  allowedRoots: [placementService.getUserWorktreesDir()],
                  // This route owns the reset-pending barrier armed above.
                  allowWhileResetPending: true,
                },
              );
              if (changed.newCwd !== canonicalWorktreePath) {
                throw new Error('Handoff relocation was rejected');
              }
              runtime.bridge.setSessionWorktree?.(storageSessionId, {
                slug,
                path: worktree.path,
                branch: '',
                baseCommit,
                baseBranch: currentBranch ?? undefined,
              });
              res.status(200).json({
                sessionId: storageSessionId,
                worktree: {
                  slug,
                  path: worktree.path,
                  branch: '',
                  baseCommit,
                  baseBranch: currentBranch ?? undefined,
                },
                currentCwd: changed.newCwd,
              });
            } catch (error) {
              // A bridge timeout is caller-facing: the queued cd can still
              // land the session in the worktree after this await rejects.
              // Decide by observed state — deleting a checkout the session
              // now lives in would strand it in a vanished directory with
              // the sidecar gone and every route failing on realpath.
              const observedCwd =
                runtime.bridge.getSessionExecutionSnapshot(
                  storageSessionId,
                ).effectiveCwd;
              if (observedCwd === canonicalWorktreePath) {
                runtime.bridge.setSessionWorktree?.(storageSessionId, {
                  slug,
                  path: worktree.path,
                  branch: '',
                  baseCommit,
                  baseBranch: currentBranch ?? undefined,
                });
                res.status(200).json({
                  sessionId: storageSessionId,
                  worktree: {
                    slug,
                    path: worktree.path,
                    branch: '',
                    baseCommit,
                    baseBranch: currentBranch ?? undefined,
                  },
                  currentCwd: worktree.path,
                });
                return;
              }
              // A caller-facing timeout does NOT abort the underlying cd
              // (withTimeout only ends the caller's wait): the queued cd can
              // still land the session in this worktree after this rejection
              // and update effectiveCwd to it, so the observed-cwd read above
              // may be stale. Rolling back on an undetermined timeout would
              // delete the checkout the session is about to inhabit and
              // strand it in a vanished directory. Keep the checkout +
              // sidecar so a late-landing cd has a valid home; only a
              // definitive failure (the cd rejected, or settled elsewhere)
              // is safe to roll back.
              if (error instanceof BridgeTimeoutError) {
                throw error;
              }
              // Roll back the fresh worktree, sidecar, and marker; the
              // session stays in the local checkout.
              await clearWorktreeSessionDurable(sidecarPath).catch(
                () => undefined,
              );
              await placementService
                .removeUserWorktree(slug, {
                  deleteBranch: true,
                  baseCommit,
                })
                .catch(() => undefined);
              throw error;
            }
          } finally {
            if (barrierArmed) {
              runtime.bridge.clearSessionResetPending?.(storageSessionId);
            }
            releaseOwnership();
          }
        }),
      );
    } catch (err) {
      if (!res.headersSent) {
        sendBridgeError(res, err, { route, sessionId });
      }
    }
  };
  app.post('/session/:id/worktree-handoff', mutate(), worktreeHandoffHandler);

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
    try {
      const runtime = await resolveSubagentSessionRuntime(
        res,
        route,
        sessionId,
      );
      if (!runtime) return;
      await runOwnerRuntimeActivity(runtime, async () => {
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
      });
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
        await runOwnerRuntimeActivity(runtime, async () => {
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
        });
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
        const rawWorktree = body?.['worktree'];
        if (rawWorktree !== undefined) {
          if (!runtime.trusted) {
            res.status(403).json({
              error: 'Worktree creation requires a trusted workspace',
              code: 'untrusted_workspace',
            });
            return;
          }
          if (
            rawWorktree === null ||
            typeof rawWorktree !== 'object' ||
            Array.isArray(rawWorktree)
          ) {
            res.status(400).json({
              error: '`worktree` must be an object',
              code: 'invalid_worktree',
            });
            return;
          }
          const worktreeRequest = rawWorktree as Record<string, unknown>;
          const rawSlug = worktreeRequest['slug'];
          const slug =
            rawSlug === undefined
              ? GitWorktreeService.generateAutoSlug()
              : rawSlug;
          if (typeof slug !== 'string' || slug.length === 0) {
            res.status(400).json({
              error: '`worktree.slug` must be a non-empty string',
              code: 'worktree_invalid_slug',
            });
            return;
          }
          const slugError = AGENT_WORKTREE_SLUG_PATTERN.test(slug)
            ? 'Worktree name is reserved for ephemeral agent worktrees.'
            : GitWorktreeService.validateUserWorktreeSlug(slug);
          if (slugError) {
            res.status(400).json({
              error: slugError,
              code: 'worktree_invalid_slug',
            });
            return;
          }

          const sessionService = createWorkspaceRuntimeSessionService(runtime);
          if (runtime.bridge.getSessionSummary(sessionId).hasActivePrompt) {
            throw new BranchWhilePromptActiveError(sessionId);
          }
          const snapshot =
            runtime.bridge.getSessionExecutionSnapshot(sessionId);
          const base = await resolveBranchWorktreeBaseCheckout({
            workspaceCwd: runtime.workspaceCwd,
            sessionId,
            snapshot,
            sidecarPath: sessionService.getWorktreeSessionPath(sessionId),
          });
          if (!base) {
            res.status(409).json({
              error:
                'The current session cwd cannot be used as a worktree base',
              code: 'worktree_base_checkout_unsupported',
            });
            return;
          }
          if (!(await isBranchWorktreeCreationSupported(base))) {
            res.status(500).json({
              error: 'Worktree creation is not available for this checkout',
              code: 'worktree_create_failed',
            });
            return;
          }

          const targetSessionId = crypto.randomUUID();
          await archiveCoordinator.runSharedMany(
            [targetSessionId],
            async () => {
              let reservation: RequestedSessionIdReservation | undefined;
              let worktreeCreated = false;
              let markerCreated = false;
              let mutationDispatched = false;
              let published: BridgePersistedBranchedSession | undefined;
              let restored: BridgeBranchedSession | undefined;
              const worktreeService = new GitWorktreeService(base.repoTop);
              const sidecarPath =
                sessionService.getWorktreeSessionPath(targetSessionId);
              const journalPath = getBranchWorktreeJournalPath(
                sidecarPath,
                targetSessionId,
              );
              let journal: BranchWorktreePreparationJournal | undefined;
              const cleanupPrepared = async (): Promise<void> => {
                if (!journal) return;
                if (
                  await sessionService.sessionExistsInAnyState(targetSessionId)
                ) {
                  await clearBranchWorktreeJournalDurable(journalPath);
                  return;
                }
                if (!worktreeCreated) {
                  const pathExists = await fs.promises
                    .lstat(journal.worktreePath)
                    .then(() => true)
                    .catch((error: NodeJS.ErrnoException) => {
                      if (error.code === 'ENOENT') return false;
                      throw error;
                    });
                  if (!pathExists) {
                    await clearBranchWorktreeJournalDurable(journalPath);
                  } else {
                    daemonLog?.warn(
                      'planned branch worktree residue preserved',
                      { targetSessionId },
                    );
                  }
                  return;
                }
                if (!journal.sidecarCreated) {
                  const sidecarExists = await fs.promises
                    .lstat(sidecarPath)
                    .then(() => true)
                    .catch((error: NodeJS.ErrnoException) => {
                      if (error.code === 'ENOENT') return false;
                      throw error;
                    });
                  if (sidecarExists) {
                    daemonLog?.warn(
                      'branch worktree sidecar ownership is unknown',
                      { targetSessionId },
                    );
                    return;
                  }
                }
                journal = await updateBranchWorktreeJournal(
                  journalPath,
                  journal,
                  'cleanup-intent',
                );
                const removed =
                  await worktreeService.removePreparedUserWorktree(
                    slug,
                    markerCreated ? targetSessionId : null,
                    base.headCommit,
                    async () => {
                      journal = await updateBranchWorktreeJournal(
                        journalPath,
                        journal!,
                        'worktree-removed',
                      );
                      runtime.generationGuard?.assertOpen();
                    },
                    journal!.worktreeBranch !== '',
                    journal!.carriedPaths,
                  );
                if (!removed.success) {
                  daemonLog?.warn('branch worktree cleanup refused', {
                    targetSessionId,
                    error: removed.error,
                  });
                  return;
                }
                journal = await updateBranchWorktreeJournal(
                  journalPath,
                  journal,
                  removed.branchPreserved
                    ? 'branch-preserved'
                    : 'branch-deleted',
                );
                if (removed.branchPreserved) {
                  daemonLog?.warn('branch worktree cleanup preserved branch', {
                    targetSessionId,
                    branch: journal.worktreeBranch,
                  });
                }
                if (journal.sidecarCreated) {
                  await clearWorktreeSessionDurable(sidecarPath);
                } else {
                  const lateSidecarExists = await fs.promises
                    .lstat(sidecarPath)
                    .then(() => true)
                    .catch((error: NodeJS.ErrnoException) => {
                      if (error.code === 'ENOENT') return false;
                      throw error;
                    });
                  if (lateSidecarExists) {
                    daemonLog?.warn(
                      'branch worktree sidecar ownership is unknown',
                      { targetSessionId },
                    );
                    return;
                  }
                }
                await clearBranchWorktreeJournalDurable(journalPath);
              };
              const releaseRestored = async (): Promise<void> => {
                if (!restored) return;
                if (restored.attached) {
                  await runtime.bridge
                    .detachClient(restored.sessionId, restored.clientId)
                    .catch(() => {});
                } else {
                  await runtime.bridge
                    .killSession(restored.sessionId, {
                      requireZeroAttaches: true,
                    })
                    .catch(() => false);
                }
              };

              try {
                // Pre-commit load check: a worktree branch always runs a cold
                // loadSession after persistOnly branchSession, so refuse before
                // creating the worktree or committing the branch.
                const load = getLoadAdmissionSnapshot?.();
                if (load?.overloaded) {
                  throw Object.assign(
                    new SystemOverloadedError(
                      load.reason ?? 'cpu_load',
                      load.loadRatio,
                      load.eventLoopLagP99Ms,
                    ),
                    {
                      operation: 'branch',
                      workspaceCwd: runtime.workspaceCwd,
                      sessionId: targetSessionId,
                      sourceSessionId: sessionId,
                    },
                  );
                }
                reservation = await requestedSessionIdAdmission.reserveCreate(
                  targetSessionId,
                  {
                    bridge: runtime.bridge,
                    workspaceCwd: runtime.workspaceCwd,
                    workspaceId: runtime.workspaceId,
                  },
                );
                runtime.generationGuard?.assertOpen();
                const worktreePath = worktreeService.getUserWorktreePath(slug);
                const pathExists = await fs.promises
                  .lstat(worktreePath)
                  .then(() => true)
                  .catch((error: NodeJS.ErrnoException) => {
                    if (error.code === 'ENOENT') return false;
                    throw error;
                  });
                if (pathExists) {
                  res.status(500).json({
                    error: 'Failed to create worktree',
                    code: 'worktree_create_failed',
                  });
                  return;
                }
                journal = await createBranchWorktreeJournal({
                  journalPath,
                  targetSessionId,
                  slug,
                  worktreePath,
                  // Detached managed worktree: no branch ref exists.
                  worktreeBranch: '',
                  repoTop: base.repoTop,
                  baseCommit: base.headCommit,
                  sidecarPath,
                });
                runtime.generationGuard?.assertOpen();
                const worktreeResult = await worktreeService.createUserWorktree(
                  slug,
                  base.headCommit,
                  {
                    carryDirtyState: true,
                    detached: true,
                    // The worktree sits at the source checkout's HEAD,
                    // which may differ from the main checkout's: capture
                    // the session's own dirty state, not the main's.
                    dirtyStateSource: base.checkoutCwd,
                    // This route persists carriedPaths in the preparation
                    // journal, whose reader refuses oversized records;
                    // bound the carry so the journal stays readable. The
                    // handoff and POST /session write no journal and carry
                    // any size.
                    maxCarriedPathsBytes: CARRIED_PATHS_MAX_BYTES,
                  },
                );
                if (!worktreeResult.success || !worktreeResult.worktree) {
                  await cleanupPrepared();
                  // An in-progress merge/rebase is a user-clearable state, not
                  // a daemon fault: surface the typed 409 here too, and keep
                  // the service's refusal text rather than a generic one
                  // (R13-2).
                  if (worktreeResult.code === 'worktree_merge_in_progress') {
                    res.status(409).json({
                      error:
                        worktreeResult.error ??
                        'The workspace has an in-progress merge',
                      code: 'worktree_merge_in_progress',
                    });
                    return;
                  }
                  res.status(500).json({
                    error: worktreeResult.error ?? 'Failed to create worktree',
                    code: 'worktree_create_failed',
                  });
                  return;
                }
                worktreeCreated = true;
                // Record the carried overlay in the in-memory journal BEFORE
                // the persist that can throw: if the journal write fails,
                // cleanupPrepared still reads carriedPaths from this variable
                // and can reap the worktree the carry just dirtied. Assigning
                // only from the await's result would leave it undefined on a
                // write failure, handing cleanup an empty exemption set that
                // refuses the dirty checkout forever.
                journal = {
                  ...journal,
                  carriedPaths: worktreeResult.carriedPaths,
                };
                journal = await updateBranchWorktreeJournal(
                  journalPath,
                  journal,
                  'worktree-created',
                );
                runtime.generationGuard?.assertOpen();
                const worktree = {
                  slug,
                  path: worktreeResult.worktree.path,
                  branch: worktreeResult.worktree.branch,
                  baseCommit: base.headCommit,
                  // Carry the base branch so the live summary has the same
                  // base-branch exclusion the sidecar restores after restart
                  // (R9-1); without it, integrating upstream re-lists foreign
                  // commits as this session's loose work.
                  baseBranch: base.branch || undefined,
                };
                await createWorktreeSessionMarker(
                  worktree.path,
                  targetSessionId,
                );
                markerCreated = true;
                journal = await updateBranchWorktreeJournal(
                  journalPath,
                  journal,
                  'marker-created',
                );
                runtime.generationGuard?.assertOpen();
                // originalHeadCommit must describe originalCwd's checkout
                // (the repo top) for the handoff's local_head_moved gate;
                // an unreadable HEAD fails closed rather than disabling the
                // gate with an empty base.
                const repoTopHead = await getHeadCommit(base.repoTop);
                if (!repoTopHead) {
                  await cleanupPrepared();
                  res.status(500).json({
                    error:
                      'Cannot read the workspace HEAD to record the handoff base',
                    code: 'worktree_create_failed',
                  });
                  return;
                }
                await createWorktreeSession(sidecarPath, {
                  slug,
                  worktreePath: worktree.path,
                  worktreeBranch: worktree.branch,
                  originalCwd: base.repoTop,
                  workspaceCwd: runtime.workspaceCwd,
                  originalBranch: base.branch,
                  originalHeadCommit: repoTopHead,
                  // The worktree was created at the source checkout's HEAD,
                  // which may differ from the repo top's HEAD (a session
                  // living in a sibling managed worktree). The promotion
                  // test, exit_worktree and the orphan reaper read this.
                  worktreeBase: base.headCommit,
                  // Record the carried overlay so the orphan reaper can exempt
                  // it (R9-6); the journal already carries the paths for the
                  // prepared cleanup.
                  carriedEntries: worktreeResult.carriedEntries,
                  // The carry came from the session's checkout, which may be
                  // a sibling of the repo top: the reaper's source-side check
                  // must verify THAT checkout, not originalCwd (R5-14).
                  carriedFrom: base.checkoutCwd,
                });
                journal = await updateBranchWorktreeJournal(
                  journalPath,
                  journal,
                  'sidecar-ready',
                );

                runtime.generationGuard?.assertOpen();
                journal = await updateBranchWorktreeJournal(
                  journalPath,
                  journal,
                  'mutation-dispatched',
                );
                runtime.generationGuard?.assertOpen();
                mutationDispatched = true;
                published = (await runtime.bridge.branchSession(
                  sessionId,
                  {
                    name,
                    ...(atRecordId !== undefined ? { atRecordId } : {}),
                    targetSessionId,
                    persistOnly: true,
                  },
                  { clientId },
                )) as BridgePersistedBranchedSession;
                await clearBranchWorktreeJournalDurable(journalPath);

                runtime.generationGuard?.assertOpen();
                const loaded = await runtime.bridge.loadSession({
                  sessionId: targetSessionId,
                  workspaceCwd: runtime.workspaceCwd,
                  historyReplay: 'response',
                  ...(clientId !== undefined ? { clientId } : {}),
                });
                restored = {
                  ...loaded,
                  displayName: published.displayName,
                  forkedFrom: published.forkedFrom,
                  ...(published.sourceWarnings?.length
                    ? { sourceWarnings: published.sourceWarnings }
                    : {}),
                };
                runtime.generationGuard?.assertOpen();
                const changed = await runtime.bridge.changeSessionCwd(
                  targetSessionId,
                  {
                    path: worktree.path,
                    allowedRoots: [
                      path.join(base.repoTop, '.qwen', 'worktrees'),
                    ],
                  },
                );
                runtime.generationGuard?.assertOpen();
                runtime.bridge.setSessionWorktree(targetSessionId, worktree);
                restored.currentCwd = changed.newCwd;
                restored.worktree = worktree;
                if (!res.writable) {
                  await releaseRestored();
                  return;
                }
                res
                  .status(201)
                  .json(omitSkillDetailsFromReplayArrays(restored));
                return;
              } catch (error) {
                if (published) {
                  await releaseRestored();
                  // If the load monitor latched between branchSession and the
                  // subsequent cold loadSession, preserve the documented 503
                  // retryable contract instead of a 500 activation failure.
                  // The branch + worktree are already committed, so the body
                  // must carry targetSessionId to let the caller rehydrate the
                  // branched child once load subsides — the generic
                  // sendBridgeError load shape omits it for routes that have
                  // not allocated a session yet.
                  if (error instanceof SystemOverloadedError) {
                    const loggedSessionId = targetSessionId;
                    daemonLog?.warn('load admission rejected', {
                      route: 'POST /session/:id/branch',
                      sessionId: loggedSessionId,
                      reason: error.reason,
                      loadRatio: error.loadRatio,
                      eventLoopLagP99Ms: error.eventLoopLagP99Ms,
                      operation: 'branch',
                      workspaceCwd: runtime.workspaceCwd,
                      sourceSessionId: sessionId,
                    });
                    if (res.writable) {
                      res.set('Retry-After', '15');
                      res.status(503).json({
                        error: error.message,
                        code: 'system_overloaded',
                        reason: error.reason,
                        loadRatio: error.loadRatio,
                        eventLoopLagP99Ms: error.eventLoopLagP99Ms,
                        sessionId: targetSessionId,
                      });
                    }
                    return;
                  }
                  if (res.writable) {
                    res.status(500).json({
                      error: 'Branch created but failed to open its worktree',
                      code: 'branch_worktree_activation_failed',
                      sessionId: targetSessionId,
                    });
                  }
                  return;
                }
                const errorKind = (error as { data?: { errorKind?: unknown } })
                  .data?.errorKind;
                const settledPrecommitFailure =
                  error instanceof BranchWhilePromptActiveError ||
                  error instanceof BridgeChannelQuarantinedError ||
                  error instanceof InvalidClientIdError ||
                  error instanceof SessionBusyError ||
                  error instanceof SessionLimitExceededError ||
                  error instanceof SessionNotFoundError ||
                  error instanceof SessionResetPendingError ||
                  errorKind === 'branch_point_invalid' ||
                  errorKind === 'session_not_found' ||
                  errorKind === 'session_busy';
                if (!mutationDispatched || settledPrecommitFailure) {
                  try {
                    await cleanupPrepared();
                  } catch (cleanupError) {
                    daemonLog?.warn('branch worktree cleanup failed', {
                      targetSessionId,
                      error:
                        cleanupError instanceof Error
                          ? cleanupError.message
                          : String(cleanupError),
                    });
                    if (res.writable) {
                      res.status(500).json({
                        error: 'Failed to prepare worktree branch',
                        code: 'worktree_create_failed',
                      });
                    }
                    return;
                  }
                  if (error instanceof RequestedSessionIdAdmissionError) {
                    sendRequestedSessionIdAdmissionError(
                      res,
                      error,
                      'POST /session/:id/branch',
                    );
                    return;
                  }
                  const fileSystemError = error as NodeJS.ErrnoException;
                  if (
                    typeof fileSystemError.path === 'string' ||
                    typeof fileSystemError.syscall === 'string'
                  ) {
                    if (res.writable) {
                      res.status(500).json({
                        error: 'Failed to prepare worktree branch',
                        code: 'worktree_create_failed',
                      });
                    }
                    return;
                  }
                  throw error;
                }
                if (res.writable) {
                  res.status(500).json({
                    error:
                      'Branch outcome is unknown; prepared resources were preserved',
                    code: 'branch_worktree_outcome_unknown',
                    sessionId: targetSessionId,
                  });
                }
                return;
              } finally {
                reservation?.release();
              }
            },
          );
          return;
        }
        // Record the branch point so the change overview's commit fallback can
        // scope this session's window to <baseCommit>..HEAD. A current-checkout
        // branch session has no worktree sidecar to restore it from, so without
        // this capture the fallback would be suppressed permanently (R5-1).
        const branchBaseCommit = await getHeadCommit(runtime.workspaceCwd);
        const result = await runtime.bridge.branchSession(
          sessionId,
          {
            name,
            ...(atRecordId !== undefined ? { atRecordId } : {}),
          },
          { clientId },
        );
        // Persist the branch point next to the new transcript. A checkpoint
        // branch (atRecordId) is persist-only — no live entry exists at branch
        // time, so the in-memory setter below cannot reach it; the restore flow
        // re-applies this sidecar as the start commit (R8-2). Writing it for the
        // live arm too heals that arm's start commit across a daemon restart.
        // Best-effort: a durably committed fork must not fail on a sidecar write.
        if (branchBaseCommit) {
          // Best-effort: writeSessionBranchSidecar never throws (returns false
          // on failure), so a failed persist degrades to the pre-sidecar
          // behavior and the fork stays committed; surface it in the log.
          const persisted = writeSessionBranchSidecar(
            createWorkspaceRuntimeSessionService(
              runtime,
            ).getBranchSessionPathForArchiveState(result.sessionId, 'active'),
            branchBaseCommit,
          );
          if (!persisted) {
            daemonLog?.warn('branch point sidecar write failed', {
              sessionId: result.sessionId,
            });
          }
        }
        if (atRecordId === undefined) {
          const restored = result as BridgeBranchedSession;
          if (branchBaseCommit) {
            runtime.bridge.setSessionBaseCommit?.(
              restored.sessionId,
              branchBaseCommit,
            );
          }
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
            redactSdkSurfaceReplay(
              result as BridgeBranchedSession,
              runtime.trusted,
            ),
          );
      },
      { rejectStandalone: true },
    ),
  );

  app.post(
    '/session/:id/side-task',
    mutate(),
    withOwnerMutableSession(
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
        res.status(201).json(redactSdkSurfaceReplay(result, runtime.trusted));
      },
      { rejectStandalone: true },
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
      { cwdBound: true },
    ),
  );

  // A person's "send to another session" from Web Shell: the open session
  // is the caller, and the launcher of its workspace runs the launch.
  app.post(
    '/session/:id/sub-sessions',
    mutate(),
    withOwnerMutableSession(
      'POST /session/:id/sub-sessions',
      async (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        const prompt = body['prompt'];
        if (
          typeof prompt !== 'string' ||
          prompt.trim().length === 0 ||
          prompt.length > MAX_SUB_SESSION_PROMPT_CHARS
        ) {
          res.status(400).json({
            code: 'invalid_sub_session_prompt',
            error: `\`prompt\` must be a non-empty string of at most ${MAX_SUB_SESSION_PROMPT_CHARS} characters`,
          });
          return;
        }
        const workspace = body['workspace'];
        if (
          workspace !== undefined &&
          (typeof workspace !== 'string' ||
            workspace.trim().length === 0 ||
            workspace.length > MAX_SUB_SESSION_WORKSPACE_CHARS ||
            // eslint-disable-next-line no-control-regex -- rejecting C0 control chars
            /[\x00-\x1f\x7f]/.test(workspace))
        ) {
          res.status(400).json({
            code: 'invalid_sub_session_workspace',
            error: `\`workspace\` must be a non-empty string of at most ${MAX_SUB_SESSION_WORKSPACE_CHARS} characters without control characters`,
          });
          return;
        }
        const targetSessionId = body['targetSessionId'];
        if (
          targetSessionId !== undefined &&
          !isValidCronTaskRoutingId(targetSessionId)
        ) {
          res.status(400).json({
            code: 'invalid_sub_session_target',
            error: `\`targetSessionId\` must be a non-empty string of at most ${MAX_CRON_TASK_ROUTING_ID_LENGTH} characters without control characters`,
          });
          return;
        }
        const launcher = (
          req.app.locals as {
            subSessionLauncherFor?: (
              runtime: WorkspaceRuntime,
            ) => SubSessionLauncher | undefined;
          }
        ).subSessionLauncherFor?.(runtime);
        if (!launcher) {
          res.status(501).json({
            code: 'sub_session_send_unavailable',
            error: 'This session cannot start sub-sessions.',
          });
          return;
        }
        let result: Awaited<ReturnType<SubSessionLauncher['launchForPerson']>>;
        try {
          result = await launcher.launchForPerson({
            callerSessionId: sessionId,
            prompt: prompt.trim(),
            ...(typeof workspace === 'string' ? { workspace } : {}),
            ...(typeof targetSessionId === 'string'
              ? { sessionId: targetSessionId }
              : {}),
          });
        } catch (error) {
          // The launcher refuses with plain errors (untrusted or unknown
          // workspace, an unknown target, caps), written for the person.
          // Typed errors keep their usual status.
          if (!(error instanceof Error) || error.constructor !== Error) {
            throw error;
          }
          res.status(409).json({
            code: 'sub_session_send_refused',
            error: error.message,
          });
          return;
        }
        res.status(202).json({
          sessionId: result.sessionId,
          ...(result.workspaceCwd !== undefined
            ? { workspaceCwd: result.workspaceCwd }
            : {}),
          ...(result.taskId !== undefined ? { taskId: result.taskId } : {}),
        });
      },
      { rejectStandalone: true },
    ),
  );

  app.post(
    '/session/:id/cd',
    mutate(),
    withOwnerMutableSession(
      'POST /session/:id/cd',
      async (req, res, sessionId, runtime) => {
        if (isInternalWorkspaceRuntime(runtime)) {
          logSessionRoutingFailure(
            'POST /session/:id/cd',
            'non_primary_session_route_not_supported',
            {
              sessionId,
              workspaceId: runtime.workspaceId,
              workspaceCwd: runtime.workspaceCwd,
            },
          );
          sendNonPrimarySessionRouteUnsupported(
            res,
            'POST /session/:id/cd',
            sessionId,
            runtime,
          );
          return;
        }
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
          {
            path: targetPath,
            ...(!runtime.primary
              ? { allowedRoots: [runtime.workspaceCwd] }
              : {}),
          },
          clientId !== undefined ? { clientId } : undefined,
        );
        runtime.generationGuard?.assertOpen();
        res.status(200).json(result);
      },
      { cwdBound: 'always', rejectStandalone: true },
    ),
  );

  const retirementPath = '/session/:id/retirements/:operationId';
  const retirementId = z.string().uuid();
  const retirementRuntimes = () =>
    workspaceRegistry
      .listAll()
      .filter(
        (runtime) =>
          runtime.trusted &&
          !isInternalWorkspaceRuntime(runtime) &&
          !runtime.routeFileSystemFactory.sshWorkspace &&
          runtime.bridge.getSessionRetirement !== undefined,
      );
  const sendRetirement = (
    res: Response,
    receipt: NonNullable<
      ReturnType<NonNullable<AcpSessionBridge['getSessionRetirement']>>
    >,
  ) =>
    res
      .set('Cache-Control', 'no-store')
      .status(receipt.state === 'retired' ? 200 : 202)
      .json(receipt);
  app.get(retirementPath, (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const operation = retirementId.safeParse(req.params['operationId']);
    if (!operation.success) {
      res.status(400).json({ code: 'invalid_session_retirement' });
      return;
    }
    const route = 'GET /session/:id/retirements/:operationId';
    try {
      const receipts = retirementRuntimes().flatMap(({ bridge }) => {
        const receipt = bridge.getSessionRetirement?.(
          sessionId,
          operation.data,
        );
        return receipt ? [receipt] : [];
      });
      if (receipts.length === 1 && receipts[0])
        sendRetirement(res, receipts[0]);
      else if (receipts.length > 1)
        res.status(409).json({ code: 'session_retire_identity_conflict' });
      else res.status(404).json({ code: 'session_retire_receipt_unavailable' });
    } catch (error) {
      sendBridgeError(res, error, { route, sessionId });
    }
  });

  app.put(retirementPath, mutate(), async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const operation = retirementId.safeParse(req.params['operationId']);
    const expected = retirementId.safeParse(
      safeBody(req)['expectedEventEpoch'],
    );
    if (!operation.success || !expected.success) {
      res.status(400).json({ code: 'invalid_session_retirement' });
      return;
    }
    const identity = {
      sessionId,
      eventEpoch: expected.data,
      operationId: operation.data,
    };
    const route = 'PUT /session/:id/retirements/:operationId';
    try {
      const existing = retirementRuntimes().flatMap((runtime) => {
        const receipt = runtime.bridge.getSessionRetirement?.(sessionId);
        return receipt ? [{ runtime, receipt }] : [];
      });
      const recorded = existing[0];
      if (recorded) {
        if (
          existing.length !== 1 ||
          recorded.receipt.operationId !== identity.operationId ||
          recorded.receipt.eventEpoch !== identity.eventEpoch
        ) {
          res
            .status(409)
            .json({ ...identity, code: 'session_retire_identity_conflict' });
          return;
        }
        if (!recorded.receipt.awaitingFenceSync) {
          sendRetirement(res, recorded.receipt);
          return;
        }
      }
      const runtime =
        recorded?.runtime ??
        (await resolveOwnerSessionRuntime(sessionId, res, route))?.runtime;
      if (!runtime) return;
      setDaemonTelemetryWorkspace(res, runtime.workspaceCwd);
      if (
        !retirementRuntimes().includes(runtime) ||
        !runtime.bridge.retireSessionIfIdle
      ) {
        res
          .status(409)
          .json({ ...identity, code: 'session_retire_unavailable' });
        return;
      }
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      runtime.generationGuard?.assertOpen();
      const receipt = await runtime.bridge.retireSessionIfIdle(
        identity,
        clientId === undefined ? undefined : { clientId },
      );
      invalidateSessionListsAndMarkCatalog(runtime, ['active', 'archived']);
      sendRetirement(res, receipt);
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
      if (
        code === 'session_retire_busy' ||
        code === 'session_retire_unavailable' ||
        code === 'session_retire_epoch_mismatch' ||
        code === 'session_retire_identity_conflict'
      ) {
        res.status(409).json({
          ...identity,
          code,
          ...(code === 'session_retire_busy'
            ? { definitivelyNotStarted: true }
            : {}),
        });
      } else sendBridgeError(res, error, { route, sessionId });
    }
  });

  app.get(
    '/session/:id/status',
    withOwnerReadSession(
      'GET /session/:id/status',
      async (_req, res, sessionId, runtime) => {
        const service = createWorkspaceRuntimeSessionService(runtime);
        // Bridge entries are re-created without prs on daemon restart/reload,
        // so hydrate the persisted binding history before reading the summary;
        // seedSessionPrs no-ops when bindings already exist, so live state is
        // never clobbered. Best-effort: an unreadable sidecar omits bindings.
        try {
          const hydratedPrs = await readSessionPrs(
            service.getPrSessionPathForArchiveState(sessionId, 'active'),
          );
          if (hydratedPrs && hydratedPrs.length > 0) {
            runtime.bridge.seedSessionPrs?.(sessionId, hydratedPrs);
          }
        } catch {
          // An unreadable sidecar omits the bindings, not the summary.
        }
        const summary = { ...runtime.bridge.getSessionSummary(sessionId) };
        try {
          summary.lastUserPromptAt =
            await service.getLastUserPromptAt(sessionId);
        } catch {
          // An unreadable transcript omits the optional field, not the summary.
          summary.lastUserPromptAt = undefined;
        }
        runtime.generationGuard?.assertOpen();
        res.status(200).json({
          ...summary,
          ...(runtime.bridge.retireSessionIfIdle
            ? {
                sessionId,
                eventEpoch: runtime.bridge.getSessionEventEpoch(sessionId),
              }
            : {}),
        });
      },
    ),
  );

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
    const compactedReplayMode = parseReplayMode(
      req.query,
      res,
      'compactedReplayMode',
    );
    if (compactedReplayMode === null) return;
    const limit = parseTranscriptLimitQuery(req.query['limit'], res);
    if (limit === null) return;
    const cursor = parseTranscriptCursorQuery(req.query['cursor'], res);
    if (cursor === null) return;
    const direction = parseTranscriptDirectionQuery(
      req.query['direction'],
      res,
    );
    if (direction === null) return;
    const beforeRecordId = parseTranscriptRecordBoundaryQuery(
      req.query['beforeRecordId'],
      res,
    );
    if (beforeRecordId === null) return;
    const atRecordId = parseTranscriptTurnAnchorQuery(
      req.query['atRecordId'],
      res,
    );
    if (atRecordId === null) return;
    const snapshot = parseTranscriptSnapshotQuery(req.query['snapshot'], res);
    if (snapshot === null) return;
    if (
      (direction !== undefined &&
        (cursor !== undefined ||
          beforeRecordId !== undefined ||
          atRecordId !== undefined ||
          snapshot !== undefined)) ||
      (cursor !== undefined &&
        (beforeRecordId !== undefined ||
          atRecordId !== undefined ||
          snapshot !== undefined)) ||
      (atRecordId !== undefined &&
        (beforeRecordId !== undefined || snapshot === undefined)) ||
      (snapshot !== undefined &&
        atRecordId === undefined &&
        beforeRecordId === undefined)
    ) {
      res.status(400).json({
        error: 'Invalid transcript cursor and anchor combination',
        code: 'invalid_transcript_cursor',
      });
      return;
    }
    if (
      (cursor !== undefined && workspaceTranscriptCursorExceedsLimit(cursor)) ||
      (snapshot !== undefined &&
        workspaceTranscriptCursorExceedsLimit(snapshot))
    ) {
      res.status(400).json({
        error: 'Transcript cursor or snapshot exceeds the maximum size',
        code: 'invalid_transcript_cursor',
      });
      return;
    }

    try {
      const result = await runWithoutDebugLogSession(() =>
        archiveCoordinator.runSharedMany([sessionId], async () => {
          const runtime = await resolveTranscriptSessionRuntime(
            res,
            route,
            sessionId,
            cursor !== undefined || snapshot !== undefined,
          );
          if (!runtime) return undefined;
          const assertRuntimeGenerationOpen =
            captureRuntimeGenerationAssertion(runtime);
          assertRuntimeGenerationOpen?.();
          // Read daemon-local so the index cache survives ACP child exits
          // (session switch, idle TTL, child respawn) instead of rebuilding
          // in a fresh child on every cold reopen. undefined readerCodec =>
          // the reader's persisted per-workspace key, the same key the ACP
          // child signs cursors with, so cursors issued by either side stay
          // interchangeable. Ownership is enforced by the resolution above.
          return readDaemonLocalTranscriptPage(
            runtime,
            sessionId,
            { limit, cursor, direction, beforeRecordId, atRecordId, snapshot },
            undefined,
            (state) =>
              encodeSessionTranscriptCursor(state, runtime.workspaceCwd),
            assertRuntimeGenerationOpen,
            false,
          );
        }),
      );
      if (result === undefined) return;
      const serialized = serializeWorkspaceTranscriptResponse(
        compactedReplayMode === 'summary'
          ? { ...result, events: summarizeReplay(result.events) }
          : result,
        sessionId,
      );
      res
        .status(200)
        .set('Cache-Control', 'no-store')
        .type('application/json')
        .send(serialized);
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
    const compactedReplayMode = parseReplayMode(
      req.query,
      res,
      'compactedReplayMode',
    );
    if (compactedReplayMode === null) return;
    const limit = parseTranscriptLimitQuery(req.query['limit'], res);
    if (limit === null) return;
    const cursor = parseTranscriptCursorQuery(req.query['cursor'], res);
    if (cursor === null) return;
    const direction = parseTranscriptDirectionQuery(
      req.query['direction'],
      res,
    );
    if (direction === null) return;
    const beforeRecordId = parseTranscriptRecordBoundaryQuery(
      req.query['beforeRecordId'],
      res,
    );
    if (beforeRecordId === null) return;
    const atRecordId = parseTranscriptTurnAnchorQuery(
      req.query['atRecordId'],
      res,
    );
    if (atRecordId === null) return;
    const snapshot = parseTranscriptSnapshotQuery(req.query['snapshot'], res);
    if (snapshot === null) return;
    if (
      (direction !== undefined &&
        (cursor !== undefined ||
          beforeRecordId !== undefined ||
          atRecordId !== undefined ||
          snapshot !== undefined)) ||
      (cursor !== undefined &&
        (beforeRecordId !== undefined ||
          atRecordId !== undefined ||
          snapshot !== undefined)) ||
      (atRecordId !== undefined &&
        (beforeRecordId !== undefined || snapshot === undefined)) ||
      (snapshot !== undefined &&
        atRecordId === undefined &&
        beforeRecordId === undefined)
    ) {
      res.status(400).json({
        error: 'Invalid transcript cursor and anchor combination',
        code: 'invalid_transcript_cursor',
      });
      return;
    }
    if (
      (cursor !== undefined && workspaceTranscriptCursorExceedsLimit(cursor)) ||
      (snapshot !== undefined &&
        workspaceTranscriptCursorExceedsLimit(snapshot))
    ) {
      res.status(400).json({
        error: 'Transcript cursor or snapshot exceeds the maximum size',
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
          const codec = getTranscriptCursorCodec(runtime);
          return readDaemonLocalTranscriptPage(
            runtime,
            sessionId,
            { limit, cursor, direction, beforeRecordId, atRecordId, snapshot },
            codec,
            (state) => codec.encode(state),
            assertRuntimeGenerationOpen,
          );
        }),
      );
      if (result === undefined) return;
      const serialized = serializeWorkspaceTranscriptResponse(
        compactedReplayMode === 'summary'
          ? { ...result, events: summarizeReplay(result.events) }
          : result,
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

  app.get('/workspaces/:workspace/session/:id/tool-calls', async (req, res) => {
    const route = 'GET /workspaces/:workspace/session/:id/tool-calls';
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const qualifiedTarget = resolveQualifiedSessionTarget(req, res, {
      allowUntrustedSecondary: true,
    });
    if (!qualifiedTarget) return;
    const turnId = req.query['turnId'];
    if (typeof turnId !== 'string' || !turnId.trim() || turnId.length > 200) {
      res.status(400).json({
        error: '`turnId` must be a non-empty persisted turn record id',
        code: 'invalid_turn_anchor',
      });
      return;
    }
    try {
      const result = await runWithoutDebugLogSession(() =>
        archiveCoordinator.runSharedMany([sessionId], async () => {
          const runtime =
            qualifiedTarget.kind === 'ordinary'
              ? qualifiedTarget.runtime
              : await resolveQualifiedSessionRuntime(
                  req,
                  res,
                  route,
                  [sessionId],
                  'active',
                );
          if (!runtime) return undefined;
          const assertRuntimeGenerationOpen =
            captureRuntimeGenerationAssertion(runtime);
          assertRuntimeGenerationOpen?.();
          return runWithWorkspaceRuntimeStorage(runtime, async () => {
            await assertSessionLoadable(
              runtime.workspaceCwd,
              sessionId,
              runtime.sessionRuntimeBaseDir,
              {
                allowActiveConflict: true,
              },
            );
            try {
              runtime.bridge.getSessionSummary(sessionId);
              if (runtime.bridge.flushSessionTranscript) {
                await runtime.bridge.flushSessionTranscript(sessionId);
              } else {
                await runtime.bridge.getSessionTranscriptPage({
                  sessionId,
                  direction: 'backward',
                  limit: 1,
                });
              }
            } catch (error) {
              if (!(error instanceof SessionNotFoundError)) throw error;
            }
            const codec = getTranscriptCursorCodec(runtime);
            const reader = new SessionTranscriptReader(
              runtime.workspaceCwd,
              codec,
            );
            const hasActivePrompt = () => {
              try {
                return runtime.bridge.getSessionSummary(sessionId)
                  .hasActivePrompt;
              } catch (error) {
                if (error instanceof SessionNotFoundError) return false;
                throw error;
              }
            };
            let events;
            try {
              events = await readSessionToolCalls({
                sessionId,
                turnId,
                reader,
                codec,
                hasActivePrompt,
              });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
              const location =
                await createWorkspaceRuntimeSessionService(
                  runtime,
                ).getSessionLocation(sessionId);
              if (location === 'archived')
                throw new SessionArchivedError(sessionId);
              if (location === 'conflict')
                throw new SessionConflictError(sessionId);
              throw new SessionNotFoundError(sessionId);
            }
            assertRuntimeGenerationOpen?.();
            return {
              v: 1 as const,
              sessionId,
              turnId,
              events: events.map((event) =>
                redactSdkSurfaceEvent(event, runtime.trusted),
              ),
            };
          });
        }),
      );
      if (result === undefined) return;
      res
        .status(200)
        .set('Cache-Control', 'no-store')
        .type('application/json')
        .send(serializeWorkspaceTranscriptResponse(result, sessionId));
    } catch (error) {
      if (error instanceof SessionToolCallsLimitError) {
        res.status(413).json({
          error: error.message,
          code: 'tool_calls_limit_exceeded',
          sessionId,
        });
        return;
      }
      if (error instanceof SessionToolCallsReplayError) {
        res.status(500).json({
          error: error.message,
          code: 'tool_calls_replay_incomplete',
          sessionId,
        });
        return;
      }
      sendBridgeError(res, error, { route, sessionId });
    }
  });

  for (const route of [
    '/session/:id/turns/:promptId/hooks',
    '/workspaces/:workspace/session/:id/turns/:promptId/hooks',
  ]) {
    app.get(route, async (req, res) => {
      const routeName = `GET ${route}`;
      const sessionId = requireSessionId(req, res);
      if (sessionId === null) return;
      const promptId = req.params['promptId'];
      if (typeof promptId !== 'string' || !promptId.trim()) {
        res.status(400).json({
          code: 'invalid_prompt_id',
          error: 'A history prompt ID is required',
        });
        return;
      }
      const qualified = route.startsWith('/workspaces/');
      const target = qualified
        ? resolveQualifiedSessionTarget(req, res, {
            allowUntrustedSecondary: true,
          })
        : undefined;
      if (qualified && !target) return;
      const limit = parseTranscriptLimitQuery(req.query['limit'], res);
      if (limit === null) return;
      const snapshot = parseTranscriptSnapshotQuery(req.query['snapshot'], res);
      if (snapshot === null) return;
      const start = parseTranscriptStartQuery(req.query['start'], res);
      if (start === null) return;
      if (
        (start !== undefined && snapshot === undefined) ||
        (snapshot !== undefined &&
          workspaceTranscriptCursorExceedsLimit(snapshot))
      ) {
        res.status(400).json({
          code: 'invalid_transcript_cursor',
          error: 'Invalid hook page snapshot or start',
        });
        return;
      }
      try {
        const result = await runWithoutDebugLogSession(() =>
          archiveCoordinator.runSharedMany([sessionId], async () => {
            const runtime = qualified
              ? target?.kind === 'ordinary'
                ? target.runtime
                : await resolveQualifiedSessionRuntime(
                    req,
                    res,
                    routeName,
                    [sessionId],
                    'active',
                  )
              : await resolveTranscriptSessionRuntime(
                  res,
                  routeName,
                  sessionId,
                  snapshot !== undefined,
                );
            if (!runtime) return undefined;
            const assertOpen = captureRuntimeGenerationAssertion(runtime);
            assertOpen?.();
            return runWithWorkspaceRuntimeStorage(runtime, async () => {
              if (snapshot === undefined) {
                await assertSessionLoadable(
                  runtime.workspaceCwd,
                  sessionId,
                  runtime.sessionRuntimeBaseDir,
                  { allowActiveConflict: true },
                );
                try {
                  runtime.bridge.getSessionSummary(sessionId);
                  if (runtime.bridge.flushSessionTranscript)
                    await runtime.bridge.flushSessionTranscript(sessionId);
                  else
                    await runtime.bridge.getSessionTranscriptPage({
                      sessionId,
                      direction: 'backward',
                      limit: 1,
                    });
                } catch (error) {
                  if (!(error instanceof SessionNotFoundError)) throw error;
                }
                assertOpen?.();
              }
              try {
                const page = await new SessionTranscriptReader(
                  runtime.workspaceCwd,
                  getTranscriptCursorCodec(runtime),
                ).readTurnHooksPage(sessionId, promptId, {
                  ...(snapshot !== undefined ? { snapshot } : {}),
                  ...(start !== undefined ? { start } : {}),
                  ...(limit !== undefined ? { limit } : {}),
                });
                assertOpen?.();
                if (!page)
                  res.status(404).json({
                    code: 'turn_not_found',
                    error: 'History turn not found',
                    sessionId,
                  });
                return page;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                  throw error;
                if (snapshot !== undefined)
                  throw new SessionTranscriptSnapshotUnavailableError(
                    sessionId,
                  );
                const location =
                  await createWorkspaceRuntimeSessionService(
                    runtime,
                  ).getSessionLocation(sessionId);
                if (location === 'archived')
                  throw new SessionArchivedError(sessionId);
                if (location === 'conflict')
                  throw new SessionConflictError(sessionId);
                throw new SessionNotFoundError(sessionId);
              }
            });
          }),
        );
        if (result === undefined) return;
        res
          .status(200)
          .set('Cache-Control', 'no-store')
          .type('application/json')
          .send(serializeWorkspaceTranscriptResponse(result, sessionId));
      } catch (error) {
        sendBridgeError(res, error, { route: routeName, sessionId });
      }
    });
  }

  app.get('/session/:id/turn-index', async (req, res) => {
    const route = 'GET /session/:id/turn-index';
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const limit = parseTranscriptLimitQuery(req.query['limit'], res);
    if (limit === null) return;
    const snapshot = parseTranscriptSnapshotQuery(req.query['snapshot'], res);
    if (snapshot === null) return;
    const start = parseTranscriptStartQuery(req.query['start'], res);
    if (start === null) return;
    if (start !== undefined && snapshot === undefined) {
      res.status(400).json({
        error: '`start` requires `snapshot`',
        code: 'invalid_transcript_cursor',
      });
      return;
    }
    if (
      snapshot !== undefined &&
      workspaceTranscriptCursorExceedsLimit(snapshot)
    ) {
      res.status(400).json({
        error: '`snapshot` exceeds the maximum size',
        code: 'invalid_transcript_cursor',
      });
      return;
    }

    try {
      const result = await runWithoutDebugLogSession(() =>
        archiveCoordinator.runSharedMany([sessionId], async () => {
          const runtime = await resolveTranscriptSessionRuntime(
            res,
            route,
            sessionId,
            snapshot !== undefined,
          );
          if (!runtime) return undefined;
          const assertRuntimeGenerationOpen =
            captureRuntimeGenerationAssertion(runtime);
          assertRuntimeGenerationOpen?.();
          // Read daemon-local so turn navigation's anchor snapshot survives
          // ACP child exit, the same reason as the default transcript route.
          // undefined codec => the persisted per-workspace key, matching the
          // default transcript route that consumes this snapshot. Resolution
          // already asserted loadability, so skip the redundant re-check.
          return runWithWorkspaceRuntimeStorage(runtime, async () => {
            // Mirror the child handler's live-first-page flush barrier: a
            // snapshot-less read must drain the recorder so a just-accepted
            // turn is not omitted from the index and its anchor snapshot. Stay
            // behind the liveness check so a cold session does not ensure a
            // child (which would undo the cold-start win); the workspace-
            // qualified turn-index route carries no such barrier (no-bridge).
            if (snapshot === undefined) {
              let live = false;
              try {
                runtime.bridge.getSessionSummary(sessionId);
                live = true;
              } catch (error) {
                if (!(error instanceof SessionNotFoundError)) throw error;
              }
              if (live) {
                try {
                  await runtime.bridge.flushSessionTranscript?.(sessionId);
                } catch (error) {
                  if (!(error instanceof SessionNotFoundError)) throw error;
                }
              }
            }
            try {
              const page = await new SessionTranscriptReader(
                runtime.workspaceCwd,
              ).readTurnIndexPage(sessionId, {
                ...(snapshot !== undefined ? { snapshot } : {}),
                ...(start !== undefined ? { start } : {}),
                ...(limit !== undefined ? { limit } : {}),
              });
              assertRuntimeGenerationOpen?.();
              return page;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
              }
              if (snapshot !== undefined) {
                throw new SessionTranscriptSnapshotUnavailableError(sessionId);
              }
              const service = createWorkspaceRuntimeSessionService(runtime);
              const location = await service.getSessionLocation(sessionId);
              if (location === 'archived') {
                throw new SessionArchivedError(sessionId);
              }
              if (location === 'conflict') {
                throw new SessionConflictError(sessionId);
              }
              throw new SessionNotFoundError(sessionId);
            }
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

  app.get('/workspaces/:workspace/session/:id/turn-index', async (req, res) => {
    const route = 'GET /workspaces/:workspace/session/:id/turn-index';
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
    const snapshot = parseTranscriptSnapshotQuery(req.query['snapshot'], res);
    if (snapshot === null) return;
    const start = parseTranscriptStartQuery(req.query['start'], res);
    if (start === null) return;
    if (start !== undefined && snapshot === undefined) {
      res.status(400).json({
        error: '`start` requires `snapshot`',
        code: 'invalid_transcript_cursor',
      });
      return;
    }
    if (
      snapshot !== undefined &&
      workspaceTranscriptCursorExceedsLimit(snapshot)
    ) {
      res.status(400).json({
        error: '`snapshot` exceeds the maximum size',
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
            if (snapshot === undefined) {
              await assertSessionLoadable(
                runtime.workspaceCwd,
                sessionId,
                runtime.sessionRuntimeBaseDir,
                { allowActiveConflict: true },
              );
            }
            try {
              const page = await new SessionTranscriptReader(
                runtime.workspaceCwd,
                getTranscriptCursorCodec(runtime),
              ).readTurnIndexPage(sessionId, {
                ...(snapshot !== undefined ? { snapshot } : {}),
                ...(start !== undefined ? { start } : {}),
                ...(limit !== undefined ? { limit } : {}),
              });
              assertRuntimeGenerationOpen?.();
              return page;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
              }
              if (snapshot !== undefined) {
                throw new SessionTranscriptSnapshotUnavailableError(sessionId);
              }
              const service = createWorkspaceRuntimeSessionService(runtime);
              const location = await service.getSessionLocation(sessionId);
              if (location === 'archived') {
                throw new SessionArchivedError(sessionId);
              }
              if (location === 'conflict') {
                throw new SessionConflictError(sessionId);
              }
              throw new SessionNotFoundError(sessionId);
            }
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
    async (req, res, next) => {
      const sessionId = req.params['id'];
      const key = sessionId
        ? parseVirtualSubagentSessionId(sessionId)
        : undefined;
      if (!sessionId || !key) {
        next();
        return;
      }
      try {
        const runtime = await resolveSubagentSessionRuntime(
          res,
          'GET /session/:id/context',
          key.parentSessionId,
        );
        if (!runtime) return;
        await runOwnerRuntimeActivity(runtime, async () => {
          res.status(200).json({
            v: 1,
            sessionId,
            workspaceCwd: runtime.workspaceCwd,
            state: {},
          });
        });
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'GET /session/:id/context',
          sessionId,
        });
      }
    },
    withOwnerReadSession(
      'GET /session/:id/context',
      async (_req, res, sessionId, runtime) => {
        const status = await runtime.bridge.getSessionContextStatus(sessionId);
        res
          .status(200)
          .json(
            runtime.trusted
              ? status
              : redactWorkflowModeFromSessionState(status),
          );
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
          .set('Cache-Control', 'no-store')
          .json(await runtime.bridge.getSessionStatsStatus(sessionId));
      },
    ),
  );

  app.get(
    '/session/:id/supported-commands',
    async (req, res, next) => {
      const sessionId = req.params['id'];
      const key = sessionId
        ? parseVirtualSubagentSessionId(sessionId)
        : undefined;
      if (!sessionId || !key) {
        next();
        return;
      }
      try {
        const runtime = await resolveSubagentSessionRuntime(
          res,
          'GET /session/:id/supported-commands',
          key.parentSessionId,
        );
        if (!runtime) return;
        await runOwnerRuntimeActivity(runtime, async () => {
          res.status(200).json({
            v: 1,
            sessionId,
            availableCommands: [],
            availableSkills: [],
          });
        });
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'GET /session/:id/supported-commands',
          sessionId,
        });
      }
    },
    withOwnerReadSession(
      'GET /session/:id/supported-commands',
      async (_req, res, sessionId, runtime) => {
        const status =
          await runtime.bridge.getSessionSupportedCommandsStatus(sessionId);
        res
          .status(200)
          .json(
            runtime.trusted
              ? status
              : redactWorkflowsFromSupportedCommands(status),
          );
      },
    ),
  );

  app.get(
    '/session/:id/tasks',
    withOwnerReadSession(
      'GET /session/:id/tasks',
      async (req, res, sessionId, runtime) => {
        const status = await runtime.bridge.getSessionTasksStatus(sessionId, {
          // Same fail-closed shape as the workflow control surfaces:
          // opting in here leaks strictly more than the redacted
          // supported-commands surface on an untrusted workspace.
          includeWorkflows:
            runtime.trusted && req.query['includeWorkflows'] === 'true',
        });
        if (req.query['includeSubSessions'] !== 'true') {
          res.status(200).json(status);
          return;
        }
        // The daemon, not the child, reports these launches back, so it
        // lists them here beside the child's own tasks.
        const launcher = (
          req.app.locals as {
            subSessionLauncherFor?: (
              runtime: WorkspaceRuntime,
            ) => SubSessionLauncher | undefined;
          }
        ).subSessionLauncherFor?.(runtime);
        res.status(200).json({
          ...status,
          subSessions: (launcher?.listOutgoing(sessionId) ?? []).map(
            (task) => ({
              kind: 'session',
              ...task,
              runtimeMs: Math.max(
                0,
                (task.endTime ?? status.now) - task.startTime,
              ),
            }),
          ),
        });
      },
    ),
  );

  app.get(
    '/session/:id/tasks/:taskId/runtime',
    withOwnerReadSession(
      'GET /session/:id/tasks/:taskId/runtime',
      async (req, res, sessionId, runtime) => {
        const taskId = req.params['taskId'];
        if (!taskId) {
          res.status(400).json({
            error: '`taskId` route parameter is required',
          });
          return;
        }
        res
          .status(200)
          .json(await runtime.bridge.getSessionTaskRuntime(sessionId, taskId));
      },
    ),
  );

  app.get(
    '/session/:id/agents',
    withOwnerReadSession(
      'GET /session/:id/agents',
      async (_req, res, sessionId, runtime) => {
        res
          .status(200)
          .json(await runtime.bridge.getSessionAgentsStatus(sessionId));
      },
    ),
  );

  app.get(
    '/session/:id/agent-trace',
    withOwnerReadSession(
      'GET /session/:id/agent-trace',
      async (req, res, sessionId, runtime) => {
        const rootAgentId = req.query['rootAgentId'];
        if (
          rootAgentId !== undefined &&
          (typeof rootAgentId !== 'string' ||
            rootAgentId.length === 0 ||
            rootAgentId.length > MAX_VIRTUAL_SESSION_ID_PART_LENGTH)
        ) {
          res.status(400).json({
            error: '`rootAgentId` must be a non-empty agent id',
            code: 'invalid_root_agent_id',
          });
          return;
        }
        res
          .status(200)
          .json(
            await runtime.bridge.getSessionAgentTrace(sessionId, rootAgentId),
          );
      },
    ),
  );

  app.get(
    '/session/:id/saved-workflows/:name',
    withOwnerReadSession(
      'GET /session/:id/saved-workflows/:name',
      async (req, res, sessionId, runtime) => {
        const name = req.params['name'];
        if (!name) {
          res.status(400).json({
            error: '`name` route parameter is required',
          });
          return;
        }
        // An untrusted workspace fails closed with the same envelope the
        // child returns for an unknown name, mirroring the supported-commands
        // redaction rather than leaking a distinguishable error.
        res
          .status(200)
          .json(
            runtime.trusted
              ? await runtime.bridge.getSessionSavedWorkflow(sessionId, name)
              : { v: 1, sessionId, name, workflow: null },
          );
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

  app.post(
    '/session/:id/mcp-app/tools/call',
    mutate({ strict: true }),
    withOwnerMutableSession(
      'POST /session/:id/mcp-app/tools/call',
      async (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        if (!clientId) {
          res
            .status(403)
            .json({ error: 'MCP App calls require a session-bound client id' });
          return;
        }
        const body = safeBody(req);
        const { serverName, resourceUri, name, arguments: args } = body;
        if (
          typeof serverName !== 'string' ||
          !serverName ||
          typeof resourceUri !== 'string' ||
          !resourceUri.startsWith('ui://') ||
          typeof name !== 'string' ||
          !name ||
          !args ||
          typeof args !== 'object' ||
          Array.isArray(args)
        ) {
          res.status(400).json({ error: 'Invalid MCP App tool call' });
          return;
        }
        const abort = new AbortController();
        const onClose = () => {
          if (!res.writableEnded) abort.abort();
        };
        res.once('close', onClose);
        try {
          res.json(
            await runtime.bridge.callMcpAppTool(
              sessionId,
              {
                serverName,
                resourceUri,
                name,
                arguments: args as Record<string, unknown>,
              },
              abort.signal,
              { clientId },
            ),
          );
        } finally {
          res.off('close', onClose);
        }
      },
      { cwdBound: 'always' },
    ),
  );

  // Generated UI view state. Reads and writes go to the session's live owner
  // and never fall back to another runtime; a card id outside the minted
  // grammar is rejected before it reaches the agent.
  const generatedUiStateRequest = (
    req: Request,
    res: Response,
  ): { clientId: string; cardId: string } | undefined => {
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return undefined;
    if (!clientId) {
      res
        .status(403)
        .json({ error: 'View state requires a session-bound client id' });
      return undefined;
    }
    const cardId = req.params['cardId'];
    if (!cardId || !GENERATED_UI_CARD_ID_PATTERN.test(cardId)) {
      res
        .status(400)
        .json({ error: 'Invalid card id', code: 'invalid_card_id' });
      return undefined;
    }
    return { clientId, cardId };
  };

  app.get(
    '/session/:id/generated-ui/state/:cardId',
    withOwnerReadSession(
      'GET /session/:id/generated-ui/state/:cardId',
      async (req, res, sessionId, runtime) => {
        const request = generatedUiStateRequest(req, res);
        if (!request) return;
        try {
          res
            .status(200)
            .json(
              await runtime.bridge.getGeneratedUiState(
                sessionId,
                request.cardId,
                { clientId: request.clientId },
              ),
            );
        } catch (err) {
          sendBridgeError(res, err, {
            route: 'GET /session/:id/generated-ui/state/:cardId',
            sessionId,
          });
        }
      },
      { cwdBound: true },
    ),
  );

  app.put(
    '/session/:id/generated-ui/state/:cardId',
    mutate({ strict: true }),
    withOwnerMutableSession(
      'PUT /session/:id/generated-ui/state/:cardId',
      async (req, res, sessionId, runtime) => {
        const request = generatedUiStateRequest(req, res);
        if (!request) return;
        const body = safeBody(req);
        const baseRevision = body['baseRevision'];
        if (
          !Number.isSafeInteger(baseRevision) ||
          (baseRevision as number) < 0 ||
          !Object.hasOwn(body, 'value')
        ) {
          res.status(400).json({
            error: 'Expected a non-negative baseRevision and a value',
            code: 'invalid_state',
          });
          return;
        }
        try {
          const result = await runtime.bridge.setGeneratedUiState(
            sessionId,
            request.cardId,
            { baseRevision: baseRevision as number, value: body['value'] },
            { clientId: request.clientId },
          );
          const status =
            result.outcome === 'saved'
              ? 200
              : result.outcome === 'stale'
                ? 409
                : 413;
          res.status(status).json(result);
        } catch (err) {
          sendBridgeError(res, err, {
            route: 'PUT /session/:id/generated-ui/state/:cardId',
            sessionId,
          });
        }
      },
      { cwdBound: 'always' },
    ),
  );

  app.get(
    '/session/:id/resources',
    withOwnerReadSession(
      'GET /session/:id/resources',
      async (_req, res, sessionId, runtime) => {
        res
          .status(200)
          .json(await runtime.bridge.getSessionResourcesStatus(sessionId));
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
    '/session/:id/sources',
    withOwnerReadSession(
      'GET /session/:id/sources',
      async (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        res
          .status(200)
          .json(
            await runtime.bridge.getSessionSources(
              sessionId,
              clientId !== undefined ? { clientId } : undefined,
            ),
          );
      },
    ),
  );

  app.post(
    '/session/:id/sources',
    mutate({ strict: true }),
    withOwnerMutableSession(
      'POST /session/:id/sources',
      async (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        if (clientId === undefined) {
          res.status(403).json({
            error: 'Source mutations require a session-bound client id',
            code: 'client_id_required',
          });
          return;
        }
        const result = await runtime.bridge.upsertSessionSource(
          sessionId,
          req.body as SessionSourceInput,
          { clientId },
        );
        res.status(200).json(result);
      },
    ),
  );

  app.delete(
    '/session/:id/sources/:sourceId',
    mutate({ strict: true }),
    withOwnerMutableSession(
      'DELETE /session/:id/sources/:sourceId',
      async (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        if (clientId === undefined) {
          res.status(403).json({
            error: 'Source mutations require a session-bound client id',
            code: 'client_id_required',
          });
          return;
        }
        const result = await runtime.bridge.removeSessionSource(
          sessionId,
          req.params['sourceId']!,
          { clientId },
        );
        res.status(200).json(result);
      },
    ),
  );

  const artifactSessionId = z
    .string()
    .min(1)
    .max(256)
    .refine((id) => id.trim().length > 0)
    .transform(normalizeSessionIdForLookup);
  const artifactQuery = z
    .object({
      sessionIds: z.array(artifactSessionId).min(1).max(100),
    })
    .strict();
  const artifactDeletion = z
    .object({
      artifacts: z
        .array(
          z
            .object({
              sessionId: artifactSessionId,
              artifactId: z
                .string()
                .min(1)
                .max(200)
                .refine((id) => id.trim().length > 0),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict();

  for (const operation of ['all', 'query', 'delete'] as const) {
    const route =
      '/workspaces/:workspace/artifact-library' +
      (operation === 'all' ? '' : `/${operation}`);
    const handler: RequestHandler = async (req, res) => {
      const selected = new Map<string, Set<string>>();
      if (operation === 'query') {
        const parsed = artifactQuery.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            code: 'invalid_artifact_library_request',
            error: 'Expected 1–100 sessionIds.',
          });
          return;
        }
        for (const id of parsed.data.sessionIds) selected.set(id, new Set());
      } else if (operation === 'delete') {
        const parsed = artifactDeletion.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            code: 'invalid_artifact_library_request',
            error: 'Expected 1–100 artifacts with sessionId and artifactId.',
          });
          return;
        }
        for (const { sessionId, artifactId } of parsed.data.artifacts) {
          const ids = selected.get(sessionId) ?? new Set<string>();
          ids.add(artifactId);
          selected.set(sessionId, ids);
        }
      }
      if (deps.sessionArtifactsPersistenceAvailable === false) {
        res.status(409).json({
          code: 'artifact_library_unavailable',
          error: 'Artifact persistence is unavailable',
        });
        return;
      }
      let stream: ArtifactLibraryStream | undefined;
      try {
        const runtime = await resolveQualifiedSessionRuntime(
          req,
          res,
          route,
          [],
          'any',
        );
        if (!runtime) return;
        const assertOpen = captureRuntimeGenerationAssertion(runtime);
        const cache = artifactCache(runtime);
        const response = await runOwnerRuntimeActivity(runtime, () =>
          runWithWorkspaceRuntimeStorage(runtime, async () => {
            assertOpen?.();
            if (operation === 'all') {
              for (const id of await cache.sessionIds())
                selected.set(id, new Set());
            }
            const readResults: WorkspaceSessionArtifactsEnvelope[] = [];
            const errors: Array<
              ReturnType<typeof artifactLibraryMemberError> & {
                sessionId: string;
              }
            > = [];
            const removed: ArtifactLibraryRemovalResult[] = [];
            const groups = [...selected];
            const processGroup = async ([sessionId, artifactIds]: [
              string,
              Set<string>,
            ]) => {
              const run = async () => {
                assertOpen?.();
                const owner =
                  workspaceRegistry.resolveLiveSessionOwner(sessionId);
                if (owner.kind === 'unavailable')
                  throw new ArtifactLibraryRequestError(
                    503,
                    'workspace_runtime_unavailable',
                    'Session owner is unavailable.',
                  );
                if (owner.kind === 'ambiguous')
                  throw new ArtifactLibraryRequestError(
                    500,
                    'ambiguous_session_owner',
                    'Session has multiple live owners.',
                  );
                if (owner.kind === 'found' && owner.runtime !== runtime)
                  throw new ArtifactLibraryRequestError(
                    409,
                    'session_workspace_conflict',
                    'Session belongs to another workspace.',
                  );
                if (isInternalWorkspaceRuntime(runtime)) {
                  const service = createWorkspaceRuntimeSessionService(runtime);
                  const location = await service.getSessionLocation(sessionId);
                  if (location === 'conflict')
                    throw new SessionConflictError(sessionId);
                  if (
                    !location ||
                    !(await readLoadableLiveConversationMetadata(
                      sessionId,
                      service,
                    ))
                  )
                    throw new SessionNotFoundError(sessionId);
                }
                assertOpen?.();
                if (operation !== 'delete')
                  return { session: await cache.read(sessionId) };
                cache.invalidate(sessionId);
                try {
                  return {
                    removed: await removeWorkspaceLibraryArtifacts(
                      runtime,
                      sessionId,
                      [...artifactIds],
                      () => assertOpen?.(),
                    ),
                  };
                } finally {
                  cache.invalidate(sessionId);
                }
              };
              try {
                const result =
                  operation === 'delete'
                    ? await archiveCoordinator.runExclusiveMany(
                        [sessionId],
                        run,
                      )
                    : await archiveCoordinator.runSharedMany([sessionId], run);
                return { sessionId, artifactIds, result };
              } catch (error) {
                return {
                  sessionId,
                  artifactIds,
                  error: artifactLibraryMemberError(error),
                };
              }
            };
            let succeeded = 0;
            let failed = 0;
            let skipped = 0;
            const consume = async (
              item: Awaited<ReturnType<typeof processGroup>>,
            ) => {
              if (item.error) {
                if (operation === 'delete') {
                  for (const artifactId of item.artifactIds)
                    removed.push({
                      sessionId: item.sessionId,
                      artifactId,
                      error: item.error,
                    });
                } else if (
                  operation !== 'all' ||
                  item.error.code !== 'session_not_found'
                ) {
                  failed++;
                  const error = { sessionId: item.sessionId, ...item.error };
                  if (stream) await stream.send('session_error', error);
                  else errors.push(error);
                } else skipped++;
              } else if (item.result?.session) {
                succeeded++;
                if (stream)
                  await stream.send('session', { ...item.result.session });
                else readResults.push(item.result.session);
              } else if (item.result?.removed) {
                removed.push(...item.result.removed);
              }
            };
            if (operation === 'delete') {
              for (
                let offset = 0;
                offset < groups.length;
                offset += ARTIFACT_LIBRARY_CONCURRENCY
              ) {
                const batch = await Promise.all(
                  groups
                    .slice(offset, offset + ARTIFACT_LIBRARY_CONCURRENCY)
                    .map(processGroup),
                );
                assertOpen?.();
                for (const item of batch) await consume(item);
              }
            } else {
              if (res.destroyed) return;
              res.vary('Accept');
              if (
                req.accepts(['application/json', 'text/event-stream']) ===
                'text/event-stream'
              ) {
                if (
                  !checkSseAdmission({
                    surface: 'artifactLibrary',
                    req,
                    res,
                    caps: deps.sseAdmissionCaps,
                    daemonLog: deps.daemonLog,
                  })
                ) {
                  return;
                }
                countSseStream('artifactLibrary', req, res);
                stream = new ArtifactLibraryStream(res);
                await stream.send('start', { total: groups.length });
              }
              const results: Array<Awaited<ReturnType<typeof processGroup>>> =
                [];
              let next = 0;
              let stopped = false;
              const worker = async () => {
                try {
                  while (
                    !stopped &&
                    !res.destroyed &&
                    !stream?.closed &&
                    next < groups.length
                  ) {
                    assertOpen?.();
                    const index = next++;
                    const item = await processGroup(groups[index]!);
                    assertOpen?.();
                    if (res.destroyed || stream?.closed) return;
                    if (stream) await consume(item);
                    else results[index] = item;
                  }
                } catch (error) {
                  stopped = true;
                  throw error;
                }
              };
              const workers = await Promise.allSettled(
                Array.from(
                  {
                    length: Math.min(
                      ARTIFACT_LIBRARY_CONCURRENCY,
                      groups.length,
                    ),
                  },
                  worker,
                ),
              );
              const rejected = workers.find(
                (result) => result.status === 'rejected',
              );
              if (rejected?.status === 'rejected') throw rejected.reason;
              if (res.destroyed || stream?.closed) return;
              assertOpen?.();
              if (stream) {
                await stream.send('complete', {
                  total: groups.length,
                  succeeded,
                  failed,
                  skipped,
                });
                return;
              }
              for (const item of results) await consume(item);
            }
            assertOpen?.();
            return operation === 'delete'
              ? { v: 1, results: removed }
              : { v: 1, sessions: readResults, errors };
          }),
        );
        // headersSent: an SSE admission refusal inside the closure already
        // answered 503; the JSON fallback must not double-send.
        if (!stream && !res.destroyed && !res.headersSent)
          res.status(200).set('Cache-Control', 'no-store').json(response);
      } catch (error) {
        if (stream) {
          if (!stream.closed)
            await stream
              .send(
                'error',
                error instanceof WorkspaceGenerationClosedError
                  ? {
                      status: 503,
                      code: 'workspace_runtime_unavailable',
                      message: 'Workspace runtime is not active.',
                    }
                  : { ...artifactLibraryMemberError(error) },
              )
              .catch(() => undefined);
        } else if (!res.destroyed) sendBridgeError(res, error, { route });
      } finally {
        stream?.end();
      }
    };
    if (operation === 'all') app.get(route, handler);
    else if (operation === 'delete')
      app.post(route, mutate({ strict: true }), handler);
    else app.post(route, handler);
  }

  // Persisted workspace management neither borrows a session client identity
  // nor loads cold sessions.
  for (const operation of ['read', 'remove'] as const) {
    const route =
      '/workspaces/:workspace/session/:id/artifact-library' +
      (operation === 'remove' ? '/:artifactId' : '');
    const handler: RequestHandler = async (req, res) => {
      const sessionId = requireSessionId(req, res);
      if (sessionId === null) return;
      if (deps.sessionArtifactsPersistenceAvailable === false) {
        res.status(409).json({
          code: 'artifact_library_unavailable',
          error: 'Artifact persistence is unavailable',
        });
        return;
      }
      try {
        const runtime = await resolveQualifiedSessionRuntime(
          req,
          res,
          route,
          [sessionId],
          'any',
        );
        if (!runtime) return;
        const assertOpen = captureRuntimeGenerationAssertion(runtime);
        const run = async () => {
          assertOpen?.();
          const liveOwner =
            workspaceRegistry.resolveLiveSessionOwner(sessionId);
          if (liveOwner.kind === 'unavailable') {
            sendWorkspaceRuntimeUnavailable(res);
            return undefined;
          }
          if (liveOwner.kind === 'ambiguous') {
            sendAmbiguousSessionOwner(
              res,
              route,
              sessionId,
              liveOwner.runtimes,
            );
            return undefined;
          }
          if (liveOwner.kind === 'found' && liveOwner.runtime !== runtime) {
            sendSessionWorkspaceConflict(
              res,
              route,
              sessionId,
              runtime,
              liveOwner.runtime,
            );
            return undefined;
          }
          if (operation === 'remove')
            workspaceArtifactCaches.get(runtime)?.invalidate(sessionId);
          const result = await runWithWorkspaceRuntimeStorage(runtime, () =>
            operation === 'read'
              ? artifactCache(runtime).read(sessionId)
              : removeWorkspaceLibraryArtifact(
                  runtime,
                  sessionId,
                  req.params['artifactId']!,
                  () => assertOpen?.(),
                ),
          );
          assertOpen?.();
          return result;
        };
        const result = await runOwnerRuntimeActivity(runtime, () =>
          operation === 'read'
            ? archiveCoordinator.runSharedMany([sessionId], run)
            : archiveCoordinator.runExclusiveMany([sessionId], run),
        );
        if (result)
          res.status(200).set('Cache-Control', 'no-store').json(result);
      } catch (error) {
        if (sendArtifactValidationError(res, error)) return;
        sendBridgeError(res, error, { route, sessionId });
      }
    };
    if (operation === 'read') app.get(route, handler);
    else app.delete(route, mutate({ strict: true }), handler);
  }

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
      { cwdBound: true },
    ),
  );

  app.get(
    '/session/:id/artifacts/:artifactId/content',
    withOwnerReadSession(
      'GET /session/:id/artifacts/:artifactId/content',
      async (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const { artifacts } = await runtime.bridge.getSessionArtifacts(
          sessionId,
          clientId !== undefined ? { clientId } : undefined,
        );
        const artifact = artifacts.find(
          (item) => item.id === req.params['artifactId'],
        );
        let content: string;
        try {
          if (!artifact) throw new Error('Snapshot not registered');
          content = await readArtifactSnapshot(
            artifact,
            runtime.sessionRuntimeBaseDir,
          );
        } catch {
          res.status(404).json({
            error: 'artifact_snapshot_unavailable',
            message: 'Saved webpage version is missing or has changed.',
          });
          return;
        }
        res
          .status(200)
          .set({
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Disposition': 'attachment; filename="saved-webpage.html"',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, no-store',
          })
          .send(content);
      },
      { cwdBound: true },
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
      { cwdBound: 'always' },
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
        if (
          kind !== 'agent' &&
          kind !== 'shell' &&
          kind !== 'monitor' &&
          kind !== 'workflow'
        ) {
          res.status(400).json({
            error: '`kind` must be "agent", "shell", "monitor", or "workflow"',
          });
          return;
        }
        if (kind === 'workflow' && !runtime.trusted) {
          res.status(200).json({ cancelled: false, reason: 'disabled' });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        res
          .status(200)
          .json(
            await runtime.bridge.cancelSessionTask(
              sessionId,
              taskId,
              kind,
              clientId !== undefined ? { clientId } : undefined,
            ),
          );
      },
    ),
  );

  app.post(
    '/session/:id/tasks/:taskId/workflow-action',
    mutate({ strict: true }),
    withOwnerMutableSession(
      'POST /session/:id/tasks/:taskId/workflow-action',
      async (req, res, sessionId, runtime) => {
        const taskId = req.params['taskId'];
        if (!taskId) {
          res.status(400).json({
            error: '`taskId` route parameter is required',
          });
          return;
        }
        const body = safeBody(req);
        const action = body['action'];
        if (
          action !== 'pause' &&
          action !== 'resume' &&
          action !== 'retry' &&
          action !== 'rerun' &&
          action !== 'delete-history' &&
          action !== 'run-saved' &&
          action !== 'run-script'
        ) {
          res.status(400).json({
            error:
              '`action` must be "pause", "resume", "retry", "rerun", "delete-history", "run-saved", or "run-script"',
          });
          return;
        }
        if (!runtime.trusted) {
          res.status(200).json({ changed: false });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        res
          .status(200)
          .json(
            await runtime.bridge.controlSessionWorkflowTask(
              sessionId,
              taskId,
              action,
              clientId !== undefined ? { clientId } : undefined,
              readServeWorkflowActionInput(body),
            ),
          );
      },
    ),
  );

  app.post(
    '/session/:id/goal',
    mutate({ strict: true }),
    withOwnerMutableSession(
      'POST /session/:id/goal',
      async (req, res, sessionId, runtime) => {
        const request = parseGoalControlRequest(safeBody(req));
        if (!request) {
          res.status(400).json({
            error: 'Invalid Goal control request',
            code: 'invalid_goal_control_request',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        res
          .status(200)
          .json(
            await runtime.bridge.controlSessionGoal(
              sessionId,
              request,
              clientId === undefined ? undefined : { clientId },
            ),
          );
      },
    ),
  );

  app.get(
    '/session/:id/goal',
    withOwnerReadSession(
      'GET /session/:id/goal',
      async (_req, res, sessionId, runtime) => {
        const goal = await runtime.bridge.getSessionGoal(sessionId);
        res.status(200).json({ snapshot: goal.snapshot });
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
          ...(typeof req.body?.confirmCancellation === 'string'
            ? { confirmCancellation: req.body.confirmCancellation }
            : {}),
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
      { cwdBound: 'always' },
    ),
  );

  const attachmentUploadBodyError: ErrorRequestHandler = (
    error,
    _req,
    res,
    next,
  ) => {
    const status =
      error && typeof error === 'object' && 'status' in error
        ? error.status
        : undefined;
    if (status === 400 || status === 413 || status === 415) {
      res.status(status).json({
        error:
          status === 413
            ? 'Attachment upload request body exceeds its limit'
            : 'Invalid attachment upload request body',
        code:
          status === 413
            ? 'attachment_upload_too_large'
            : status === 415
              ? error.type === 'encoding.unsupported'
                ? 'invalid_attachment_upload_encoding'
                : 'invalid_attachment_upload_content_type'
              : 'invalid_attachment_upload_body',
      });
      return;
    }
    next(error);
  };

  app.post(
    '/session/:id/attachment-uploads',
    mutate(),
    express.json({ limit: '4kb', inflate: false }),
    attachmentUploadBodyError,
    withOwnerMutableSession(
      'POST /session/:id/attachment-uploads',
      (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        if (
          typeof body['name'] !== 'string' ||
          typeof body['mimeType'] !== 'string' ||
          !body['mimeType'].trim() ||
          typeof body['size'] !== 'number'
        ) {
          throw new SessionAttachmentUploadError(
            400,
            'invalid_attachment_upload_metadata',
            'name, mimeType, and size are required',
          );
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        try {
          const upload = runtime.bridge.createSessionAttachmentUpload(
            sessionId,
            {
              name: body['name'],
              mimeType: body['mimeType'].trim().toLowerCase(),
              size: body['size'],
            },
            clientId === undefined ? undefined : { clientId },
          );
          res.set('Cache-Control', 'no-store').status(201).json(upload);
        } catch (error) {
          if (error instanceof TypeError || error instanceof RangeError) {
            throw new SessionAttachmentUploadError(
              error instanceof RangeError ? 413 : 400,
              'invalid_attachment_upload_metadata',
              error.message,
            );
          }
          throw error;
        }
      },
    ),
  );

  app.post(
    '/session/:id/attachment-uploads/:uploadId/chunks',
    mutate(),
    express.raw({
      type: '*/*',
      limit: SESSION_ATTACHMENT_CHUNK_BYTES,
      inflate: false,
    }),
    attachmentUploadBodyError,
    withOwnerMutableSession(
      'POST /session/:id/attachment-uploads/:uploadId/chunks',
      (req, res, sessionId, runtime) => {
        if (
          req.headers['content-type']
            ?.split(';', 1)[0]
            ?.trim()
            .toLowerCase() !== 'application/octet-stream'
        ) {
          throw new SessionAttachmentUploadError(
            415,
            'invalid_attachment_upload_content_type',
            'Chunks require application/octet-stream',
          );
        }
        const offset = req.query['offset'];
        if (
          typeof offset !== 'string' ||
          !/^\d+$/.test(offset) ||
          !Number.isSafeInteger(Number(offset)) ||
          !Buffer.isBuffer(req.body)
        ) {
          throw new SessionAttachmentUploadError(
            400,
            'invalid_attachment_upload_chunk',
            'A raw chunk and a non-negative integer offset are required',
          );
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const result = runtime.bridge.appendSessionAttachmentUpload(
          sessionId,
          req.params['uploadId']!,
          Number(offset),
          req.body,
          clientId === undefined ? undefined : { clientId },
        );
        res.set('Cache-Control', 'no-store').status(200).json(result);
      },
    ),
  );

  app.post(
    '/session/:id/attachment-uploads/:uploadId/complete',
    mutate(),
    withOwnerMutableSession(
      'POST /session/:id/attachment-uploads/:uploadId/complete',
      async (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const reference = await runtime.bridge.completeSessionAttachmentUpload(
          sessionId,
          req.params['uploadId']!,
          clientId === undefined ? undefined : { clientId },
          captureRuntimeGenerationAssertion(runtime),
        );
        res.set('Cache-Control', 'no-store').status(200).json(reference);
      },
    ),
  );

  app.delete(
    '/session/:id/attachment-uploads/:uploadId',
    mutate(),
    withOwnerMutableSession(
      'DELETE /session/:id/attachment-uploads/:uploadId',
      (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        runtime.bridge.cancelSessionAttachmentUpload(
          sessionId,
          req.params['uploadId']!,
          clientId === undefined ? undefined : { clientId },
        );
        res.status(204).end();
      },
    ),
  );

  app.post(
    '/session/:id/attachments',
    mutate(),
    express.raw({ type: '*/*', limit: '8mb' }),
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
      'POST /session/:id/attachments',
      async (req, res, sessionId, runtime) => {
        const name = req.query['name'];
        const contentType = req.headers['content-type']
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase();
        if (
          typeof name !== 'string' ||
          !contentType ||
          !Buffer.isBuffer(req.body)
        ) {
          res.status(400).json({
            error:
              'request body, Content-Type, and name query parameter are required',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        if (
          req.body.length === 0 &&
          [
            'image/bmp',
            'image/gif',
            'image/jpeg',
            'image/png',
            'image/webp',
          ].includes(contentType)
        ) {
          res.status(400).json({ error: 'Image attachments cannot be empty' });
          return;
        }
        try {
          const reference = await runtime.bridge.storeSessionAttachment(
            sessionId,
            req.body,
            contentType,
            clientId !== undefined ? { clientId } : undefined,
            name,
          );
          res.status(201).json(reference);
        } catch (error) {
          if (error instanceof RangeError) {
            res.status(413).json({ error: error.message });
            return;
          }
          if (error instanceof TypeError) {
            res.status(400).json({ error: error.message });
            return;
          }
          throw error;
        }
      },
    ),
  );

  app.get(
    '/session/:id/attachments',
    withOwnerReadSession(
      'GET /session/:id/attachments',
      async (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const attachments = await runtime.bridge.listSessionAttachments(
          sessionId,
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json({ attachments });
      },
    ),
  );

  app.get(
    '/session/:id/attachments/:attachmentId',
    withOwnerReadSession(
      'GET /session/:id/attachments/:attachmentId',
      async (req, res, sessionId, runtime) => {
        const attachmentId = req.params['attachmentId'];
        if (!attachmentId) {
          res.status(400).json({ error: '`attachmentId` is required' });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const attachment = await runtime.bridge.readSessionAttachment(
          sessionId,
          attachmentId,
          clientId !== undefined ? { clientId } : undefined,
        );
        if (!attachment) {
          res.status(404).json({ error: 'session attachment not found' });
          return;
        }
        res.setHeader('Content-Type', attachment.mimeType);
        res.setHeader('Content-Length', String(attachment.data.byteLength));
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('Content-Disposition', 'attachment');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.status(200).send(attachment.data);
      },
    ),
  );

  app.delete(
    '/session/:id/attachments/:attachmentId',
    mutate(),
    withOwnerMutableSession(
      'DELETE /session/:id/attachments/:attachmentId',
      async (req, res, sessionId, runtime) => {
        const attachmentId = req.params['attachmentId'];
        if (!attachmentId) {
          res.status(400).json({ error: '`attachmentId` is required' });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const removed = await runtime.bridge.removeSessionAttachment(
          sessionId,
          attachmentId,
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
      async (req, res, sessionId, runtime, onPromptAdmitted) => {
        const body = safeBody(req);
        const eventDetailMode = parseReplayMode(body, res, 'eventDetailMode');
        if (eventDetailMode === null) return;
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
        const rawIdempotencyKey = body['idempotencyKey'];
        let idempotencyKey: string | undefined;
        if (rawIdempotencyKey !== undefined && rawIdempotencyKey !== null) {
          if (
            typeof rawIdempotencyKey !== 'string' ||
            rawIdempotencyKey.length === 0 ||
            rawIdempotencyKey.length > PROMPT_IDEMPOTENCY_KEY_MAX_LENGTH
          ) {
            res.status(400).json({
              error: `\`idempotencyKey\` must be a non-empty string of at most ${PROMPT_IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
              code: 'invalid_idempotency_key',
            });
            return;
          }
          idempotencyKey = rawIdempotencyKey;
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

        const { forwardedBody, classification } = classifyPromptRequest(
          body,
          runtime,
        );

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

        let admission: SessionPromptAdmission;
        let historyRecorded: Promise<void> | undefined;
        const recordInputHistory = () => {
          if (
            historyRecorded ||
            body['suppressInputHistory'] === true ||
            classification.channelPrompt ||
            classification.requestedChannelPrompt
          ) {
            return;
          }
          const historyText = extractPromptHistoryText(
            prompt,
            classification.submittedPrompt,
          );
          if (!historyText) return;
          historyRecorded = runWithWorkspaceRuntimeStorage(runtime, () =>
            appendWorkspaceInputHistory(
              runtime.workspaceCwd,
              'prompt',
              historyText,
            )
              .then(() => undefined)
              .catch((err) => {
                daemonLog?.warn('failed to record workspace input history', {
                  sessionId,
                  kind: 'prompt' satisfies WorkspaceInputHistoryKind,
                  workspaceCwd: runtime.workspaceCwd,
                  error: err instanceof Error ? err.message : String(err),
                });
              }),
          );
        };
        let turnSkillLease: string | undefined;
        let skillDigest: string | undefined;
        let releasePreparation: (() => void) | undefined;
        const releaseLease = async () => {
          if (turnSkillLease)
            await runtime.bridge.updateTurnSkillLease?.(
              sessionId,
              turnSkillLease,
              'release',
            );
        };
        try {
          const pinSkills = body['pinSkills'];
          const requireSessionSkillEffects = body['requireSessionSkillEffects'];
          const expectedDigest = body['expectedSkillDigest'];
          const pinExtensions = body['pinExtensions'];
          const generation = body['expectedExtensionGeneration'];
          if (
            (pinExtensions !== undefined &&
              typeof pinExtensions !== 'boolean') ||
            (pinExtensions === true
              ? pinSkills !== true ||
                typeof generation !== 'number' ||
                !Number.isSafeInteger(generation) ||
                generation < 0
              : generation !== undefined)
          ) {
            res.status(400).json({
              code: 'invalid_turn_extension_options',
              error:
                'pinExtensions requires pinSkills and a nonnegative safe expectedExtensionGeneration',
            });
            return;
          }
          const extensionGeneration =
            typeof generation === 'number' ? generation : undefined;
          delete forwardedBody['pinExtensions'];
          delete forwardedBody['expectedExtensionGeneration'];
          if (
            (pinSkills !== undefined && typeof pinSkills !== 'boolean') ||
            (requireSessionSkillEffects !== undefined &&
              (typeof requireSessionSkillEffects !== 'boolean' ||
                (requireSessionSkillEffects && pinSkills !== true))) ||
            (expectedDigest !== undefined &&
              (pinSkills !== true ||
                typeof expectedDigest !== 'string' ||
                !/^[a-f0-9]{64}$/.test(expectedDigest)))
          ) {
            res.status(400).json({
              error:
                'pinSkills must be boolean. Enable pinSkills for a SHA-256 expectedSkillDigest or requireSessionSkillEffects: true.',
              code: 'invalid_turn_skill_options',
            });
            return;
          }
          delete forwardedBody['pinSkills'];
          delete forwardedBody['requireSessionSkillEffects'];
          delete forwardedBody['expectedSkillDigest'];
          const skillPromptHash =
            pinSkills === true && idempotencyKey !== undefined
              ? crypto
                  .createHash('sha256')
                  .update(JSON.stringify(prompt))
                  .digest('hex')
              : undefined;
          const key =
            idempotencyKey === undefined
              ? undefined
              : JSON.stringify([sessionId, idempotencyKey]);
          // Serialize only same-key preparations. A synchronous admit below
          // publishes its receipt before waiting retries can capture again.
          if (key && !findPromptReceipt(sessionId, idempotencyKey)) {
            for (
              let pending = skillPreparations.get(key);
              pending;
              pending = skillPreparations.get(key)
            ) {
              await pending;
              abort.signal.throwIfAborted();
            }
            if (
              pinSkills === true &&
              !findPromptReceipt(sessionId, idempotencyKey)
            ) {
              const pending = new Promise<void>((resolve) => {
                releasePreparation = () => {
                  skillPreparations.delete(key);
                  resolve();
                };
              });
              skillPreparations.set(key, pending);
            }
          }
          const hasIncompatibleReceipt = () => {
            const previous = findPromptReceipt(sessionId, idempotencyKey);
            if (
              !previous ||
              (pinSkills !== true && previous.skillDigest === undefined) ||
              (previous.skillDigest !== undefined &&
                previous.replayCursor?.eventEpoch ===
                  runtime.bridge.getSessionEventEpoch(sessionId) &&
                previous.extensionGeneration === extensionGeneration &&
                (previous.sessionSkillEffectsChecked === true) ===
                  (requireSessionSkillEffects === true) &&
                previous.skillPromptHash === skillPromptHash &&
                (expectedDigest === undefined ||
                  expectedDigest === previous.skillDigest))
            )
              return false;
            res.status(409).json({
              code: 'turn_skill_receipt_conflict',
              error:
                'The idempotency key belongs to a different prompt or skill revision',
            });
            return true;
          };
          if (hasIncompatibleReceipt()) return;
          // An accepted retry uses its original receipt even after an update.
          if (
            pinSkills === true &&
            !findPromptReceipt(sessionId, idempotencyKey)
          ) {
            if (
              !runtime.trusted ||
              runtime.routeFileSystemFactory.sshWorkspace ||
              !runtime.bridge.updateTurnSkillLease
            ) {
              res.status(409).json({
                code: 'turn_skill_snapshot_unavailable',
                error: 'The session runtime cannot pin skill files',
              });
              return;
            }
            turnSkillLease = crypto.randomUUID();
            const receipt =
              extensionGeneration === undefined
                ? await runtime.bridge.updateTurnSkillLease(
                    sessionId,
                    turnSkillLease,
                    'prepare',
                  )
                : await runtime.bridge.updateTurnSkillLease(
                    sessionId,
                    turnSkillLease,
                    'prepare',
                    undefined,
                    extensionGeneration,
                  );
            if (
              extensionGeneration !== undefined &&
              receipt.extensionGeneration !== extensionGeneration
            ) {
              await releaseLease().catch(() => {});
              res.status(409).json({
                code: receipt.unsupportedExtensionComponent
                  ? 'turn_extension_component_unsupported'
                  : 'turn_extension_generation_unavailable',
                sessionId,
                definitivelyNotStarted: true,
                error:
                  'The session could not reserve the requested extension generation',
              });
              return;
            }
            if (
              requireSessionSkillEffects === true &&
              receipt.sessionSkillEffectsCompatible !== true
            ) {
              await releaseLease().catch(() => {});
              res.status(409).json({
                code: 'turn_skill_session_effects_unavailable',
                sessionId,
                definitivelyNotStarted: true,
                error:
                  receipt.sessionSkillEffectsCompatible === false
                    ? 'A captured skill declares session hooks or allow rules that cannot run in a pinned turn'
                    : 'The runtime did not verify session effects for the captured skills',
              });
              return;
            }
            skillDigest = receipt.digest;
            if (
              !skillDigest ||
              !/^[a-f0-9]{64}$/.test(skillDigest) ||
              (expectedDigest && expectedDigest !== skillDigest)
            ) {
              await releaseLease().catch(() => {});
              res.status(409).json({
                code: 'turn_skill_digest_mismatch',
                error: 'Runtime did not confirm the requested skill revision',
              });
              return;
            }
            abort.signal.throwIfAborted();
            runtime.generationGuard?.assertOpen();
            if (hasIncompatibleReceipt()) {
              await releaseLease().catch(() => {});
              return;
            }
          }
          admission = admitSessionPrompt(
            {
              archiveCoordinator: deps.archiveCoordinator,
              channelDeliveryAuthorizations: deps.channelDeliveryAuthorizations,
              daemonLog,
              promptDeadlineMs,
            },
            {
              runtime,
              sessionId,
              prompt,
              request: forwardedBody,
              turnSkillLease,
              skillDigest,
              skillPromptHash,
              sessionSkillEffectsChecked:
                requireSessionSkillEffects === true ? true : undefined,
              extensionGeneration,
              classification,
              idempotencyKey,
              requestDeadlineMs,
              clientId,
              delivery,
              signal: abort.signal,
              onPromptId: (promptId) =>
                addDaemonRequestAttribute('qwen-code.prompt_id', promptId),
              onPromptAdmitted: () => {
                onPromptAdmitted?.();
                recordInputHistory();
              },
            },
          );
        } catch (err) {
          await releaseLease().catch(() => {});
          res.off('close', onResClose);
          res.off('finish', onResFinish);
          sendBridgeError(res, err, {
            route: 'POST /session/:id/prompt',
            sessionId,
          });
          return;
        } finally {
          releasePreparation?.();
        }
        res.off('close', onResClose);
        if (turnSkillLease) {
          if (admission.deduplicated) await releaseLease().catch(() => {});
          else void admission.settled.then(releaseLease).catch(() => {});
        }
        if (admission.deduplicated) {
          res.off('finish', onResFinish);
          res.status(202).json({
            promptId: admission.promptId,
            lastEventId: admission.lastEventId,
            eventEpoch: admission.eventEpoch,
            deduplicated: true,
            skillDigest: admission.skillDigest,
            sessionSkillEffectsChecked: admission.sessionSkillEffectsChecked,
            extensionGeneration: admission.extensionGeneration,
          });
          return;
        }
        recordInputHistory();
        await historyRecorded;
        res.status(202).json({
          skillDigest: admission.skillDigest,
          sessionSkillEffectsChecked: admission.sessionSkillEffectsChecked,
          extensionGeneration: admission.extensionGeneration,
          promptId: admission.promptId,
          lastEventId: admission.lastEventId,
          eventEpoch: admission.eventEpoch,
        });
      },
      { promptAdmission: true },
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
        if (
          !checkSseAdmission({
            surface: 'generation',
            req,
            res,
            caps: deps.sseAdmissionCaps,
            daemonLog: deps.daemonLog,
            logContext: { sessionId },
          })
        ) {
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

        countSseStream('generation', req, res);
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
    async (req, res, next) => {
      const sessionId = req.params['id'];
      const key = sessionId
        ? parseVirtualSubagentSessionId(sessionId)
        : undefined;
      if (!sessionId || !key) {
        next();
        return;
      }
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      try {
        const runtime = await resolveSubagentSessionRuntime(
          res,
          'POST /session/:id/heartbeat',
          key.parentSessionId,
        );
        if (!runtime) return;
        await runOwnerRuntimeActivity(runtime, async () => {
          res.status(200).json({
            sessionId,
            ...(clientId ? { clientId } : {}),
            lastSeenAt: Date.now(),
          });
        });
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /session/:id/heartbeat',
          sessionId,
        });
      }
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
    async (req, res, next) => {
      const sessionId = req.params['id'];
      const key = sessionId
        ? parseVirtualSubagentSessionId(sessionId)
        : undefined;
      if (!sessionId || !key) {
        next();
        return;
      }
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      try {
        const runtime = await resolveSubagentSessionRuntime(
          res,
          'POST /session/:id/detach',
          key.parentSessionId,
        );
        if (!runtime) return;
        await runOwnerRuntimeActivity(runtime, async () => {
          res.status(204).end();
        });
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /session/:id/detach',
          sessionId,
        });
      }
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
    try {
      const owner = await resolveOwnerSessionRuntime(
        sessionId,
        res,
        'DELETE /session/:id',
      );
      if (!owner) return;
      const { runtime } = owner;
      // ACP session/close can fall back to a shared gate because it has
      // connection-local promptAbort state; REST close does not.
      await runOwnerRuntimeActivity(runtime, () =>
        runWithSessionListInvalidation(runtime, ['active'], () =>
          archiveCoordinator.runExclusiveMany([sessionId], async () =>
            runtime.bridge.closeSession(
              sessionId,
              clientId !== undefined ? { clientId } : undefined,
              { cancelReason: 'user' },
            ),
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
    const resolveConflicts = parseResolveConflicts(req, res);
    if (resolveConflicts === undefined) return;
    const requireIdle = parseRequireIdle(req, res);
    if (requireIdle === undefined) return;
    if (rejectActiveLiveSessionMutation(res, uniqueIds)) return;

    try {
      const operation = await archiveSessions(
        undefined,
        res,
        'POST /sessions/archive',
        uniqueIds,
        resolveConflicts,
        requireIdle,
      );
      if (!operation) return;
      const { result } = operation;
      res.status(200).json({
        archived: result.archived,
        alreadyArchived: result.alreadyArchived,
        resolvedConflicts: result.resolvedConflicts,
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
    const resolveConflicts = parseResolveConflicts(req, res);
    if (resolveConflicts === undefined) return;

    try {
      const operation = await unarchiveSessions(
        undefined,
        res,
        'POST /sessions/unarchive',
        uniqueIds,
        resolveConflicts,
      );
      if (!operation) return;
      const { result } = operation;
      res.status(200).json({
        unarchived: result.unarchived,
        alreadyActive: result.alreadyActive,
        resolvedConflicts: result.resolvedConflicts,
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
      const resolveConflicts = parseResolveConflicts(req, res);
      if (resolveConflicts === undefined) return;
      const requireIdle = parseRequireIdle(req, res);
      if (requireIdle === undefined) return;
      if (rejectActiveLiveSessionMutation(res, uniqueIds)) return;
      try {
        const operation = await archiveSessions(
          req,
          res,
          route,
          uniqueIds,
          resolveConflicts,
          requireIdle,
        );
        if (!operation) return;
        const { result } = operation;
        res.status(200).json({
          archived: result.archived,
          alreadyArchived: result.alreadyArchived,
          resolvedConflicts: result.resolvedConflicts,
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
      const resolveConflicts = parseResolveConflicts(req, res);
      if (resolveConflicts === undefined) return;
      try {
        const operation = await unarchiveSessions(
          req,
          res,
          route,
          uniqueIds,
          resolveConflicts,
        );
        if (!operation) return;
        const { result } = operation;
        res.status(200).json({
          unarchived: result.unarchived,
          alreadyActive: result.alreadyActive,
          resolvedConflicts: result.resolvedConflicts,
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
    // Gate BEFORE runtime resolution (withOwnerMutableSession): a
    // traversal id must be rejected identically on single- and
    // multi-workspace daemons — runtime resolution would 404 it first on a
    // multi-entry registry, making the error contract
    // configuration-dependent.
    (req, res, next) => {
      const raw = req.params['id'];
      if (raw && !isValidSessionId(normalizeSessionIdForLookup(raw))) {
        res.status(400).json({
          error: '`sessionId` must be a valid session id',
          code: 'invalid_session_id',
        });
        return;
      }
      next();
    },
    withOwnerMutableSession(
      'PATCH /session/:id/metadata',
      async (req, res, sessionId, runtime) => {
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
        const pr = parseSessionPrBody(req, res);
        if (pr === null) return;
        const initialDisplayName = body['initialDisplayName'];
        if (
          initialDisplayName !== undefined &&
          rawDisplayName === undefined &&
          pr === undefined
        ) {
          if (typeof initialDisplayName !== 'string') {
            res.status(400).json({
              error: '`initialDisplayName` must be a string',
              code: 'invalid_metadata',
              field: 'initialDisplayName',
            });
            return;
          }
          const effective = runtime.bridge.initializeSessionTitle?.(
            sessionId,
            initialDisplayName.slice(0, 256),
            clientId !== undefined ? { clientId } : undefined,
          );
          invalidateSessionLists(runtime, ['active']);
          res.status(200).json({ sessionId, ...effective });
          return;
        }
        // The null role clear is sidecar semantics (upsertSessionPr); the
        // bridge only knows set-or-preserve, and the persisted list
        // reconciles the live entry right after the upsert anyway.
        const bridgePr =
          pr === undefined
            ? undefined
            : {
                number: pr.number,
                url: pr.url,
                ...(pr.state ? { state: pr.state } : {}),
                ...(pr.role != null ? { role: pr.role } : {}),
              };
        const displayName =
          typeof rawDisplayName === 'string'
            ? rawDisplayName.slice(0, 256)
            : undefined;
        let effective: ReturnType<AcpSessionBridge['updateSessionMetadata']>;
        try {
          const service = createWorkspaceRuntimeSessionService(runtime);
          // Bridge entries are re-created without prs on daemon restart,
          // close/reload, and archive/restore. Hydrate the persisted
          // binding history before the mutation so the
          // `session_metadata_updated` event the bridge publishes carries
          // the full list, not just this daemon lifetime's bindings. The
          // read is best-effort: readSessionPrs rethrows non-ENOENT I/O
          // errors (EISDIR/EACCES/EIO), and an unreadable sidecar must
          // degrade the event's history, not block a pr-less rename.
          let hydratedPrs: Awaited<ReturnType<typeof readSessionPrs>>;
          try {
            hydratedPrs = await readSessionPrs(
              service.getPrSessionPathForArchiveState(sessionId, 'active'),
            );
          } catch {
            hydratedPrs = null;
          }
          if (hydratedPrs && hydratedPrs.length > 0) {
            runtime.bridge.seedSessionPrs?.(sessionId, hydratedPrs);
          }
          // Bridge first: it resolves session liveness, client trust, and
          // metadata content. Persisting the sidecar only after it succeeds
          // keeps a rejected request from leaving a durable binding behind.
          effective = runtime.bridge.updateSessionMetadata(
            sessionId,
            { displayName, ...(bridgePr ? { pr: bridgePr } : {}) },
            clientId !== undefined ? { clientId } : undefined,
          );
          if (pr) {
            const persistedPrs = (
              await upsertSessionPr(
                service.getPrSessionPathForArchiveState(sessionId, 'active'),
                { ...pr, source: 'create' },
              )
            ).map(toSessionPrInfo);
            // Reconcile the live entry to the authoritative persisted
            // list: the bridge merge capped positionally while the
            // sidecar caps by provenance authority — past the cap the
            // two stores evict different entries, and every later event
            // or rename response would serve the diverged list.
            runtime.bridge.setSessionPrs?.(sessionId, persistedPrs);
            effective = { ...effective, prs: persistedPrs };
          }
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
      // The session id is embedded in the sidecar filesystem path; reject
      // anything that is not a session id before it can reach the chats
      // directory.
      if (!isValidSessionId(sessionId)) {
        res.status(400).json({
          error: '`sessionId` must be a valid session id',
          code: 'invalid_session_id',
        });
        return;
      }
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      const rawDisplayName = safeBody(req)['displayName'];
      if (rawDisplayName !== undefined && typeof rawDisplayName !== 'string') {
        res.status(400).json({
          error: '`displayName` must be a string',
          code: 'invalid_metadata',
          field: 'displayName',
        });
        return;
      }
      const pr = parseSessionPrBody(req, res);
      if (pr === null) return;
      // See the primary metadata route: null clears in the sidecar only.
      const bridgePr =
        pr === undefined
          ? undefined
          : {
              number: pr.number,
              url: pr.url,
              ...(pr.state ? { state: pr.state } : {}),
              ...(pr.role != null ? { role: pr.role } : {}),
            };
      if (rawDisplayName === undefined && pr === undefined) {
        res.status(400).json({
          error: 'at least one of `displayName` or `pr` is required',
          code: 'invalid_metadata',
          field: 'displayName',
        });
        return;
      }
      try {
        const displayName =
          typeof rawDisplayName === 'string'
            ? rawDisplayName.slice(0, 256)
            : undefined;
        if (displayName !== undefined) {
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
            let effective: {
              displayName?: string;
              prs?: Array<{
                number: number;
                url: string;
                state?: 'open' | 'merged' | 'closed';
                role?: SessionPrRole;
              }>;
            };
            const service = createWorkspaceRuntimeSessionService(runtime);
            try {
              // Bridge entries are re-created without prs on daemon
              // restart, close/reload, and archive/restore. Hydrate the
              // persisted binding history before the mutation so the
              // `session_metadata_updated` event the bridge publishes
              // carries the full list, not just this daemon lifetime's
              // bindings. The read is best-effort: readSessionPrs rethrows
              // non-ENOENT I/O errors (EISDIR/EACCES/EIO), and an
              // unreadable sidecar must degrade the event's history, not
              // block a pr-less rename.
              let hydratedPrs: Awaited<ReturnType<typeof readSessionPrs>>;
              try {
                hydratedPrs = await readSessionPrs(
                  service.getPrSessionPathForArchiveState(sessionId, 'active'),
                );
              } catch {
                hydratedPrs = null;
              }
              if (hydratedPrs && hydratedPrs.length > 0) {
                runtime.bridge.seedSessionPrs?.(sessionId, hydratedPrs);
              }
              // Bridge first: it resolves client trust and metadata
              // content, and reports non-live sessions. Persisting the
              // sidecar only after it succeeds keeps a rejected request
              // from leaving a durable binding behind — and a live
              // session's sidecar always lives in the active chats dir, so
              // 'active' is known-correct here. Non-live sessions are
              // handled by the fallback below, which persists at the
              // located archive state.
              effective = runtime.bridge.updateSessionMetadata(
                sessionId,
                { displayName, ...(bridgePr ? { pr: bridgePr } : {}) },
                clientId !== undefined ? { clientId } : undefined,
              );
              assertRuntimeGenerationOpen?.();
              if (pr) {
                const persistedPrs = (
                  await upsertSessionPr(
                    service.getPrSessionPathForArchiveState(
                      sessionId,
                      'active',
                    ),
                    { ...pr, source: 'create' },
                  )
                ).map(toSessionPrInfo);
                assertRuntimeGenerationOpen?.();
                // Reconcile the live entry to the authoritative persisted
                // list (see the primary metadata route).
                runtime.bridge.setSessionPrs?.(sessionId, persistedPrs);
                effective = { ...effective, prs: persistedPrs };
              }
            } catch (err) {
              if (!(err instanceof SessionNotFoundError)) throw err;
              const location = await service.getSessionLocation(sessionId);
              assertRuntimeGenerationOpen?.();
              if (location === 'conflict') {
                throw new SessionConflictError(sessionId);
              }
              if (!location) {
                throw new SessionNotFoundError(sessionId);
              }
              effective = {};
              // Persist the PR sidecar BEFORE the rename: the catalog bump
              // below only runs when every write succeeds, so the write most
              // likely to fail (the newer sidecar path) must run first — a
              // failed sidecar write may not strand an already-persisted
              // rename that the error response never announces.
              if (pr) {
                const persisted = await upsertSessionPr(
                  service.getPrSessionPathForArchiveState(sessionId, location),
                  { ...pr, source: 'create' },
                );
                assertRuntimeGenerationOpen?.();
                effective.prs = persisted.map(toSessionPrInfo);
              }
              if (displayName !== undefined) {
                const renamed = await service.renameSession(
                  sessionId,
                  displayName,
                  'manual',
                  location,
                );
                assertRuntimeGenerationOpen?.();
                if (!renamed) {
                  throw new SessionNotFoundError(sessionId);
                }
                effective.displayName = displayName;
              }
              // The persisted mutation is picked up by the next catalog
              // scan, so this fallback must advance the same catalog
              // revision the live update marks — otherwise version-watching
              // clients keep the stale metadata.
              runtime.bridge.markSessionCatalogChanged();
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
        const sortBy = req.query['sortBy'];
        if (
          sortBy !== undefined &&
          sortBy !== 'updatedAt' &&
          sortBy !== 'lastUserPromptAt'
        ) {
          res.status(400).json({
            error: '`sortBy` must be "updatedAt" or "lastUserPromptAt"',
            code: 'invalid_session_sort',
          });
          return;
        }
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
        const rawLiveOnly = req.query['liveOnly'];
        let liveOnly = false;
        if (rawLiveOnly !== undefined) {
          if (rawLiveOnly !== '1') {
            res.status(400).json({
              error: '`liveOnly` must be "1"',
              code: 'invalid_session_live_only',
            });
            return;
          }
          if (
            view !== undefined ||
            archiveState === 'archived' ||
            parentSessionId !== undefined ||
            parsedSource.sourceType !== undefined ||
            sortBy === 'lastUserPromptAt'
          ) {
            res.status(400).json({
              error:
                '`liveOnly` cannot be combined with organized view, archived state, parent, source filters, or question sorting',
              code: 'invalid_session_live_only_filter',
            });
            return;
          }
          liveOnly = true;
        }
        const options: ListWorkspaceSessionsOptions = {
          ...(sortBy !== undefined ? { sortBy } : {}),
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
          if (liveOnly && !runtime.trusted) {
            res.status(403).json({
              error: '`liveOnly` requires a trusted workspace',
              code: 'untrusted_workspace',
            });
            return;
          }
          // Organized/archived views always need the persisted store: organized
          // cursors are opaque (non-numeric) and archived-only workspaces have no
          // active persisted sessions, so the live-only fallback would drop them.
          // Metadata filters gather the whole workspace
          // (persisted + live) to filter completely and paginates with an opaque
          // activity cursor, so the numeric-cursor live fallback can't serve it.
          // `liveOnly` bypasses the persisted store on purpose: its callers need
          // the sessions holding slots, not a page of closed history.
          const usePersisted =
            readOnlySecondary ||
            (!liveOnly &&
              (runtime.primary ||
                view === 'organized' ||
                sortBy === 'lastUserPromptAt' ||
                archiveState === 'archived' ||
                parentSessionId !== undefined ||
                parsedSource.sourceType !== undefined ||
                (cursor !== undefined && cursor !== ''
                  ? isPersistedSessionCursor(cursor)
                  : await hasActivePersistedSessions(
                      runtime,
                      controller.signal,
                    ))));
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
              : listLiveWorkspaceSessionsForResponse(
                  runtime.bridge,
                  key,
                  options,
                  {
                    runtimeBaseDir: runtime.sessionRuntimeBaseDir,
                    signal: controller.signal,
                  },
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

  const SESSION_SEARCH_QUERY_MAX_LENGTH = 200;
  const SESSION_SEARCH_MAX_RESULTS_LIMIT = 50;

  // Content search over persisted session transcripts. Workspace-scoped like
  // the sessions list route above: resolved-runtime only, read-only
  // secondaries search their persisted store, never falls back to primary.
  const searchWorkspaceSessionsHandler =
    (paramName: 'id' | 'workspace'): RequestHandler =>
    async (req, res) => {
      const route =
        paramName === 'workspace'
          ? 'GET /workspaces/:workspace/sessions/search'
          : 'GET /workspace/:id/sessions/search';
      const liveRuntime = await resolveLiveCatalogRuntime(req, res, paramName);
      if (liveRuntime === null) return;
      const runtime =
        liveRuntime ??
        resolveRuntimeForCatalogRoute(req, res, paramName, route);
      if (runtime === null) return;
      const key = runtime.workspaceCwd;
      try {
        const rawQuery = req.query['q'];
        // Cap the trimmed query, consistent with the emptiness check and
        // the matcher — whitespace padding the scan would discard must not
        // count against the limit.
        const trimmedQuery =
          typeof rawQuery === 'string' ? rawQuery.trim() : '';
        if (
          trimmedQuery.length === 0 ||
          trimmedQuery.length > SESSION_SEARCH_QUERY_MAX_LENGTH
        ) {
          res.status(400).json({
            error: `\`q\` must be a non-empty string of at most ${SESSION_SEARCH_QUERY_MAX_LENGTH} characters`,
            code: 'invalid_search_query',
          });
          return;
        }
        let maxResults: number | undefined;
        const rawMaxResults = req.query['maxResults'];
        if (rawMaxResults !== undefined) {
          const parsed =
            typeof rawMaxResults === 'string' && /^\d+$/.test(rawMaxResults)
              ? Number.parseInt(rawMaxResults, 10)
              : Number.NaN;
          if (
            !Number.isSafeInteger(parsed) ||
            parsed < 1 ||
            parsed > SESSION_SEARCH_MAX_RESULTS_LIMIT
          ) {
            res.status(400).json({
              error: `\`maxResults\` must be an integer between 1 and ${SESSION_SEARCH_MAX_RESULTS_LIMIT}`,
              code: 'invalid_search_max_results',
            });
            return;
          }
          maxResults = parsed;
        }
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
          const search = () =>
            runWorkspaceInspectionWithLogPolicy(runtime, () =>
              searchWorkspaceSessionsForResponse(
                key,
                trimmedQuery,
                { ...(maxResults !== undefined ? { maxResults } : {}) },
                {
                  runtimeBaseDir: runtime.sessionRuntimeBaseDir,
                  signal: controller.signal,
                  isSessionRetirementFenced: (id) =>
                    isBridgeSessionRetirementFenced(runtime.bridge, id),
                },
              ),
            );
          const result =
            liveRuntime && deps.conversationRuntimeActivity
              ? await deps.conversationRuntimeActivity.run(search)
              : await search();
          controller.signal.throwIfAborted();
          if (res.destroyed) return;
          res.status(200).json({ results: result.results });
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
        writeStderrLine(
          `qwen serve: failed to search sessions for workspace ${safeLogValue(
            key,
          )}: ${safeLogValue(err instanceof Error ? err.message : String(err))}`,
        );
        res.status(500).json({
          error: 'Failed to search sessions',
          code: 'session_search_failed',
        });
      }
    };

  app.get(
    '/workspace/:id/sessions/search',
    searchWorkspaceSessionsHandler('id'),
  );
  app.get(
    '/workspaces/:workspace/sessions/search',
    searchWorkspaceSessionsHandler('workspace'),
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

  const readWorkspaceLiveState = (runtime: WorkspaceRuntime) => {
    const assertRuntimeOpen = captureRuntimeGenerationAssertion(runtime);
    const bridge = runtime.bridge;
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
      .filter(
        (session) => session.sourceType !== AGENT_HOST_SESSION_SOURCE_TYPE,
      )
      .map((session) => ({
        sessionId: session.sessionId,
        clientCount: session.clientCount,
        hasActivePrompt: session.hasActivePrompt,
        ...(session.activeWorkState !== undefined
          ? { activeWorkState: session.activeWorkState }
          : {}),
        hasRunningBackgroundTasks: session.hasRunningBackgroundTasks,
        ...(session.backgroundTurn
          ? { backgroundTurn: session.backgroundTurn }
          : {}),
        isWaitingForPermission: session.isWaitingForPermission ?? false,
        isWaitingForUserQuestion: session.isWaitingForUserQuestion ?? false,
        hasTurnError: session.hasTurnError ?? false,
        // Bridge-local activity watermark, absent until a running prompt in
        // this bridge publishes its first terminal. Reading it costs nothing
        // extra: the summary is already in memory.
        ...(session.updatedAt !== undefined
          ? { updatedAt: session.updatedAt }
          : {}),
      }));
    assertRuntimeOpen?.();
    lastExposedCatalogVersions.set(bridge, catalogVersion);
    return { v: 1 as const, catalogVersion, sessions };
  };

  app.get('/workspaces/:workspace/sessions/live-state', async (req, res) => {
    const route = 'GET /workspaces/:workspace/sessions/live-state';
    // Strict trust gate: live state is never read from an untrusted
    // runtime, and an unknown selector never falls back to primary.
    const runtime = requireTrustedRuntimeForWorkspaceRoute(req, res, route);
    if (runtime === null) return;
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(readWorkspaceLiveState(runtime));
    } catch (err) {
      sendBridgeError(res, err, { route });
    }
  });

  const liveStateBatchRequest = z
    .object({
      workspaces: z
        .array(z.string().min(1).max(MAX_SELECTOR_CHARS))
        .min(1)
        .max(MAX_BATCH_WORKSPACES),
    })
    .strict();

  app.post('/sessions/live-state', async (req, res) => {
    const parsed = liveStateBatchRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'invalid_session_live_state_batch_request',
        error: 'Invalid session live-state batch request.',
      });
      return;
    }

    const readMember = async (workspace: string) => {
      const entry = resolveWorkspaceEntryBySelector(
        workspaceRegistry,
        workspace,
      );
      if (!entry) {
        return failedBatchMember(
          workspace,
          undefined,
          404,
          'workspace_not_found',
          'Workspace is not registered with this daemon.',
        );
      }
      const unavailable = () =>
        failedBatchMember(
          workspace,
          entry,
          503,
          'workspace_runtime_unavailable',
          'Workspace runtime is not active.',
        );
      const { generation, isCurrent } = captureWorkspaceEntryCurrency(
        workspaceRegistry,
        entry,
      );
      if (!generation || !isCurrent()) return unavailable();
      const runtime = generation.runtime;
      if (!runtime.trusted) {
        logSessionRoutingFailure(
          'POST /sessions/live-state',
          'untrusted_workspace',
          {
            workspaceId: runtime.workspaceId,
            workspaceCwd: runtime.workspaceCwd,
          },
        );
        return failedBatchMember(
          workspace,
          entry,
          403,
          'untrusted_workspace',
          'Workspace is not trusted.',
        );
      }
      try {
        const snapshot = await withDaemonSpan(
          'qwen-code.daemon.session_live_state_batch.member',
          {
            'qwen-code.workspace.hash': hashDaemonWorkspace(
              runtime.workspaceCwd,
            ),
          },
          async () => readWorkspaceLiveState(runtime),
        );
        if (!isCurrent()) return unavailable();
        const member = {
          workspace,
          workspaceId: runtime.workspaceId,
          cwd: runtime.workspaceCwd,
          ...snapshot,
        };
        if (Buffer.byteLength(JSON.stringify(member)) > MAX_MEMBER_BYTES) {
          return failedBatchMember(
            workspace,
            entry,
            413,
            'live_state_response_too_large',
            `Live-state snapshot exceeds ${MAX_MEMBER_BYTES / 1024} KiB.`,
          );
        }
        return member;
      } catch (error) {
        if (isGenerationClosedError(error) || !isCurrent()) {
          return unavailable();
        }
        // The member body stays generic by contract; the raw error exists
        // only here, so losing it would leave a polling client with no
        // server-side trace of which workspace is failing.
        daemonLog?.error(
          error instanceof Error ? error.message : String(error),
          error instanceof Error ? error : undefined,
          {
            route: 'POST /sessions/live-state',
            workspaceId: entry.workspaceId,
          },
        );
        return failedBatchMember(
          workspace,
          entry,
          500,
          'session_live_state_failed',
          'Failed to read workspace session live state.',
        );
      }
    };

    const controller = new AbortController();
    const abort = () => controller.abort();
    const onClose = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', onClose);
    if (req.aborted || res.destroyed) abort();

    const workspaces = [];
    try {
      for (const workspace of parsed.data.workspaces) {
        if (controller.signal.aborted) return;
        workspaces.push(await readMember(workspace));
        // Member reads are synchronous bridge-memory reads chained through
        // microtasks, so without this yield the loop cannot observe a
        // disconnect until every member has been read.
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (controller.signal.aborted) return;
      addDaemonRequestAttribute(
        'qwen-code.daemon.session_live_state_batch.members',
        workspaces.length,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ workspaces });
    } finally {
      req.off('aborted', abort);
      res.off('close', onClose);
    }
  });

  const restartRecoveryBatchRequest = z
    .object({
      workspaces: z
        .array(z.string().min(1).max(MAX_SELECTOR_CHARS))
        .min(1)
        .max(MAX_BATCH_WORKSPACES),
      sinceMs: z.number().int().positive().optional(),
    })
    .strict();

  const hasIntactRecoverySourceTail = (filePath: string): boolean => {
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, 'r');
      const size = fs.fstatSync(fd).size;
      const readStart = Math.max(0, size - 64 * 1024);
      const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, readStart);
      const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
      let continuation = false;
      if (readStart > 0) {
        const peek = Buffer.alloc(1);
        fs.readSync(fd, peek, 0, 1, readStart - 1);
        if (peek[0] !== 0x0a) {
          lines.shift();
          continuation = true;
        }
      }
      let sawRecord = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        if (!parseLineTolerantWithIntegrity(trimmed, filePath).complete) {
          return false;
        }
        sawRecord = true;
      }
      if (continuation && !sawRecord) {
        // Find the clipped record's boundary using at most one earlier window.
        const prefixLength = Math.min(readStart, 64 * 1024);
        const prefixStart = readStart - prefixLength;
        const prefixBuffer = Buffer.alloc(prefixLength);
        fs.readSync(fd, prefixBuffer, 0, prefixLength, prefixStart);
        const boundary = prefixBuffer.lastIndexOf(0x0a);
        if (boundary < 0 && prefixStart > 0) return false;
        return parseLineTolerantWithIntegrity(
          Buffer.concat([prefixBuffer, buffer.subarray(0, bytesRead)])
            .toString('utf8', boundary + 1)
            .trim(),
          filePath,
        ).complete;
      }
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Closing a read-only descriptor must not replace the source verdict.
        }
      }
    }
  };

  const inspectRestartRecoverySession = async (
    runtime: WorkspaceRuntime,
    sessionService: ReturnType<typeof createWorkspaceRuntimeSessionService>,
    sessionId: string,
  ): Promise<{
    loaded: boolean;
    sourceTypes: string[];
    sourceUnknown: boolean;
  }> => {
    const metadata = await sessionService.readCreationMetadataIfReadable(
      sessionId,
      'active',
    );
    const sourceTypes =
      metadata?.sourceType === undefined ? [] : [metadata.sourceType];
    let sourceUnknown = metadata === undefined;
    if (!sourceUnknown && metadata?.sourceType === undefined) {
      const item = await sessionService.getSessionListItem(sessionId, 'active');
      sourceUnknown ||= item === undefined;
      if (item !== undefined) {
        if (item.sourceType !== undefined) {
          sourceTypes.push(item.sourceType);
        }
        sourceUnknown ||= !hasIntactRecoverySourceTail(item.filePath);
      }
    }
    try {
      const liveSource = runtime.bridge.getSessionSummary(sessionId).sourceType;
      if (liveSource !== undefined) sourceTypes.push(liveSource);
      return { loaded: true, sourceTypes, sourceUnknown };
    } catch (error) {
      if (!isSessionNotFoundError(error)) throw error;
      return { loaded: false, sourceTypes, sourceUnknown };
    }
  };

  class HiddenRestartRecoverySessionError extends Error {
    constructor() {
      super('Restart recovery session became hidden before dispatch.');
    }
  }

  app.post('/sessions/recovery', async (req, res) => {
    const route = 'POST /sessions/recovery';
    const parsed = restartRecoveryBatchRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'invalid_restart_recovery_batch_request',
        error: 'Invalid restart recovery batch request.',
      });
      return;
    }

    const now = Date.now();
    const windowMs = Math.min(
      parsed.data.sinceMs ?? DEFAULT_RESTART_RECOVERY_WINDOW_MS,
      MAX_RESTART_RECOVERY_WINDOW_MS,
    );
    const sinceMs = now - windowMs;

    const readMember = async (workspace: string) => {
      const entry = resolveWorkspaceEntryBySelector(
        workspaceRegistry,
        workspace,
      );
      if (!entry) {
        return failedBatchMember(
          workspace,
          undefined,
          404,
          'workspace_not_found',
          'Workspace is not registered with this daemon.',
        );
      }
      const unavailable = () =>
        failedBatchMember(
          workspace,
          entry,
          503,
          'workspace_runtime_unavailable',
          'Workspace runtime is not active.',
        );
      const { generation, isCurrent } = captureWorkspaceEntryCurrency(
        workspaceRegistry,
        entry,
      );
      if (!generation || !isCurrent()) return unavailable();
      const runtime = generation.runtime;
      if (!runtime.trusted) {
        logSessionRoutingFailure(route, 'untrusted_workspace', {
          workspaceId: runtime.workspaceId,
          workspaceCwd: runtime.workspaceCwd,
        });
        return failedBatchMember(
          workspace,
          entry,
          403,
          'untrusted_workspace',
          'Workspace is not trusted.',
        );
      }
      try {
        const sessionService = createWorkspaceRuntimeSessionService(runtime);
        const sessionIds = (
          await sessionService.listAllProjectSessionIds('active')
        ).filter((sessionId) => SESSION_FILE_ID_PATTERN.test(sessionId));
        const result = scanRestartRecoveries({
          sessionService,
          sessionIds,
          sinceMs,
          limit: Number.POSITIVE_INFINITY,
          isSessionLiveActive: (sessionId) => {
            try {
              const summary = runtime.bridge.getSessionSummary(sessionId);
              return (
                summary.hasActivePrompt || (summary.pendingPromptCount ?? 0) > 0
              );
            } catch {
              return false;
            }
          },
        });
        const visibleItems = [];
        for (
          let index = 0;
          index < result.items.length &&
          visibleItems.length <= MAX_RESTART_RECOVERY_ITEMS;
          index += 4
        ) {
          if (controller.signal.aborted) return;
          const candidates = await Promise.all(
            result.items.slice(index, index + 4).map(async (item) => ({
              item,
              ...(await inspectRestartRecoverySession(
                runtime,
                sessionService,
                item.sessionId,
              )),
            })),
          );
          if (controller.signal.aborted) return;
          for (const candidate of candidates) {
            if (
              !candidate.sourceUnknown &&
              !candidate.sourceTypes.some(isHiddenCatalogSource)
            ) {
              visibleItems.push(candidate.item);
            }
          }
        }
        if (!isCurrent()) return unavailable();
        const truncated = visibleItems.length > MAX_RESTART_RECOVERY_ITEMS;
        return {
          workspace,
          workspaceId: runtime.workspaceId,
          cwd: runtime.workspaceCwd,
          v: 1 as const,
          items: visibleItems.slice(0, MAX_RESTART_RECOVERY_ITEMS),
          truncated,
        };
      } catch (error) {
        if (isGenerationClosedError(error) || !isCurrent()) {
          return unavailable();
        }
        daemonLog?.error(
          error instanceof Error ? error.message : String(error),
          error instanceof Error ? error : undefined,
          {
            route,
            workspaceId: entry.workspaceId,
          },
        );
        return failedBatchMember(
          workspace,
          entry,
          500,
          'restart_recovery_failed',
          'Failed to read restart recovery state.',
        );
      }
    };

    const controller = new AbortController();
    const abort = () => controller.abort();
    const onClose = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', onClose);
    if (req.aborted || res.destroyed) abort();

    const workspaces = [];
    try {
      for (const workspace of parsed.data.workspaces) {
        if (controller.signal.aborted) return;
        workspaces.push(await readMember(workspace));
        // The member read is synchronous disk work; yield so a client
        // disconnect is observed between members.
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (controller.signal.aborted) return;
      addDaemonRequestAttribute(
        'qwen-code.daemon.restart_recovery_batch.members',
        workspaces.length,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ workspaces });
    } finally {
      req.off('aborted', abort);
      res.off('close', onClose);
    }
  });

  const restartRecoveryContinueRequest = z
    .object({
      sessions: z
        .array(
          z
            .object({
              workspace: z.string().min(1).max(MAX_SELECTOR_CHARS),
              sessionId: z.string().min(1).max(256),
            })
            .strict(),
        )
        .min(1)
        .max(10),
      confirmToolTurn: z.boolean().optional(),
    })
    .strict();

  app.post(
    '/sessions/recovery/continue',
    mutate({ strict: true }),
    async (req, res) => {
      const route = 'POST /sessions/recovery/continue';
      const parsed = restartRecoveryContinueRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          code: 'invalid_restart_recovery_continue_request',
          error: 'Invalid restart recovery continue request.',
        });
        return;
      }

      const confirmToolTurn = parsed.data.confirmToolTurn === true;

      const continueOne = async (requested: {
        workspace: string;
        sessionId: string;
      }): Promise<Record<string, unknown>> => {
        const base = {
          workspace: requested.workspace,
          sessionId: requested.sessionId,
        };
        const entry = resolveWorkspaceEntryBySelector(
          workspaceRegistry,
          requested.workspace,
        );
        if (!entry) {
          return { ...base, status: 'error', code: 'workspace_not_found' };
        }
        const { generation, isCurrent } = captureWorkspaceEntryCurrency(
          workspaceRegistry,
          entry,
        );
        if (!generation || !isCurrent()) {
          return {
            ...base,
            status: 'error',
            code: 'workspace_runtime_unavailable',
          };
        }
        const runtime = generation.runtime;
        if (!runtime.trusted) {
          logSessionRoutingFailure(route, 'untrusted_workspace', {
            workspaceId: runtime.workspaceId,
            workspaceCwd: runtime.workspaceCwd,
          });
          return { ...base, status: 'error', code: 'untrusted_workspace' };
        }
        if (parseVirtualSubagentSessionId(requested.sessionId)) {
          return {
            ...base,
            status: 'not_continuable',
            code: 'virtual_subagent',
          };
        }
        // The ledger path is derived from this value; reject anything that is
        // not a persisted session id before touching the filesystem.
        if (!SESSION_FILE_ID_PATTERN.test(requested.sessionId)) {
          return {
            ...base,
            status: 'not_continuable',
            code: 'invalid_session_id',
          };
        }

        const continueLocked = async (): Promise<Record<string, unknown>> => {
          if (!isCurrent()) {
            return {
              ...base,
              status: 'error',
              code: 'workspace_runtime_unavailable',
            };
          }
          const sessionService = createWorkspaceRuntimeSessionService(runtime);
          const state = readRestartRecoveryState(
            sessionService.getPromptLedgerPath(requested.sessionId),
          );
          if (state.kind !== 'interrupted') {
            return {
              ...base,
              status: 'not_continuable',
              code: state.kind === 'settled' ? 'already_moved' : 'no_evidence',
            };
          }

          const { sourceTypes, loaded, sourceUnknown } =
            await inspectRestartRecoverySession(
              runtime,
              sessionService,
              requested.sessionId,
            );
          if (!isCurrent()) {
            return {
              ...base,
              status: 'error',
              code: 'workspace_runtime_unavailable',
            };
          }
          if (sourceTypes.some(isHiddenCatalogSource)) {
            return {
              ...base,
              status: 'not_continuable',
              code: 'hidden_session',
            };
          }
          if (sourceUnknown) {
            return {
              ...base,
              status: 'not_continuable',
              code: 'metadata_unreadable',
            };
          }

          let restoreAttachment:
            | { sessionId: string; clientId: string }
            | undefined;
          let restoredSessionId: string | undefined;
          if (!loaded) {
            const outcome = await restoreSessionCore({
              action: 'load',
              runtime,
              workspaceCwd: runtime.workspaceCwd,
              sessionId: requested.sessionId,
              archiveCoordinator,
              requestedSessionIdAdmission,
              assertRuntimeGenerationOpen:
                captureRuntimeGenerationAssertion(runtime),
              daemonLog,
              materializeLiveConversationDirectory:
                deps.materializeLiveConversationDirectory,
              historyPageSize: undefined,
              liveReplayMode: undefined,
              compactedReplayMode: undefined,
              clientId: undefined,
              approvalMode: undefined,
              restoreSource: {},
              isCancelled: () => false,
            });
            if (outcome.kind === 'cancelled') {
              return { ...base, status: 'error', code: 'cancelled' };
            }
            restoredSessionId = outcome.session.sessionId;
            if (outcome.session.sourceType !== undefined) {
              sourceTypes.push(outcome.session.sourceType);
            }
            // The restore attaches a generated client id even when the caller
            // supplied none. A batch owns no client, so the attachment is
            // released when the continuation request returns (accepted or
            // rejected). Dispatch admits the prompt first, so an accepted
            // continuation keeps the session open; detaching before dispatch
            // would let the idle-close path tear down the just-loaded session.
            if (outcome.session.clientId !== undefined) {
              restoreAttachment = {
                sessionId: outcome.session.sessionId,
                clientId: outcome.session.clientId,
              };
            }
          }

          try {
            if (!isCurrent()) {
              return {
                ...base,
                status: 'error',
                code: 'workspace_runtime_unavailable',
              };
            }
            if (sourceTypes.some(isHiddenCatalogSource)) {
              return {
                ...base,
                status: 'not_continuable',
                code: 'hidden_session',
              };
            }
            const context = await runtime.bridge.getSessionContextStatus(
              requested.sessionId,
            );
            const recovery = context.recovery;
            if (!recovery || !recovery.canContinue) {
              return {
                ...base,
                status: 'not_continuable',
                ...(recovery ? { kind: recovery.kind } : {}),
              };
            }
            if (recovery.cancellationConfirmationId) {
              return {
                ...base,
                status: 'confirmation_required',
                kind: recovery.kind,
                code: 'cancellation_confirmation',
              };
            }
            if (recovery.kind === 'interrupted_turn' && !confirmToolTurn) {
              return {
                ...base,
                status: 'confirmation_required',
                kind: recovery.kind,
                code: 'tool_turn',
              };
            }

            const promptId = crypto.randomUUID();
            const assertCanContinue = () => {
              if (!isCurrent()) {
                throw new WorkspaceGenerationClosedError();
              }
              const summary = runtime.bridge.getSessionSummary(
                requested.sessionId,
              );
              if (isHiddenCatalogSource(summary.sourceType)) {
                throw new HiddenRestartRecoverySessionError();
              }
            };
            const result = await runtime.bridge.continueSession(
              requested.sessionId,
              {
                promptId,
                ...(recovery.kind === 'interrupted_prompt' ||
                recovery.kind === 'interrupted_turn'
                  ? { expectedInterruption: recovery.kind }
                  : {}),
                assertCanContinue,
                assertCanDispatch: assertCanContinue,
                requireDispatchAck: true,
              },
            );
            if (!result.accepted) {
              if (
                result.reason === 'interruption_mismatch' &&
                result.interruption === 'interrupted_turn' &&
                !confirmToolTurn
              ) {
                return {
                  ...base,
                  status: 'confirmation_required',
                  kind: result.interruption,
                  code: 'tool_turn',
                };
              }
              return {
                ...base,
                status: 'rejected',
                kind: recovery.kind,
                interruption: result.interruption,
              };
            }
            if (restoredSessionId !== undefined) {
              try {
                // A waking drain can admit its own prompt, so the requested
                // continuation must already be admitted before we notify it.
                deps.onSessionRestored?.({
                  runtime,
                  workspaceCwd: runtime.workspaceCwd,
                  sessionId: restoredSessionId,
                });
              } catch (err) {
                daemonLog?.warn(
                  `session restored hook failed for ${restoredSessionId}: ${String(err)}`,
                );
              }
            }
            return {
              ...base,
              status: 'accepted',
              kind: result.interruption,
              promptId: result.promptId ?? promptId,
              ...(result.lastEventId !== undefined
                ? { lastEventId: result.lastEventId }
                : {}),
              ...(result.eventEpoch !== undefined
                ? { eventEpoch: result.eventEpoch }
                : {}),
            };
          } finally {
            if (restoreAttachment !== undefined) {
              await runtime.bridge
                .detachClient(
                  restoreAttachment.sessionId,
                  restoreAttachment.clientId,
                )
                .catch(() => {});
            }
          }
        };
        try {
          return await archiveCoordinator.runSharedMany(
            [requested.sessionId],
            continueLocked,
          );
        } catch (error) {
          if (isSessionNotFoundError(error)) {
            return { ...base, status: 'error', code: 'session_not_found' };
          }
          if (error instanceof HiddenRestartRecoverySessionError) {
            return {
              ...base,
              status: 'not_continuable',
              code: 'hidden_session',
            };
          }
          if (error instanceof DaemonDrainingError) {
            return { ...base, status: 'error', code: 'daemon_draining' };
          }
          if (error instanceof SessionArchivingError) {
            return { ...base, status: 'error', code: 'session_archiving' };
          }
          if (error instanceof RequestedSessionIdAdmissionError) {
            return { ...base, status: 'error', code: error.code };
          }
          if (isGenerationClosedError(error) || !isCurrent()) {
            return {
              ...base,
              status: 'error',
              code: 'workspace_runtime_unavailable',
            };
          }
          daemonLog?.error(
            error instanceof Error ? error.message : String(error),
            error instanceof Error ? error : undefined,
            {
              route,
              workspaceId: entry.workspaceId,
              sessionId: requested.sessionId,
            },
          );
          return { ...base, status: 'error', code: 'continue_failed' };
        }
      };

      const controller = new AbortController();
      const abort = () => controller.abort();
      const onClose = () => {
        if (!res.writableEnded) abort();
      };
      req.once('aborted', abort);
      res.once('close', onClose);
      if (req.aborted || res.destroyed) abort();

      const results: Array<Record<string, unknown>> = [];
      try {
        for (const requested of parsed.data.sessions) {
          if (controller.signal.aborted) return;
          results.push(await continueOne(requested));
          // Loading and continuing are serial disk/bridge work; yield so a
          // client disconnect is observed between sessions.
          await new Promise((resolve) => setImmediate(resolve));
        }
        if (controller.signal.aborted) return;
        addDaemonRequestAttribute(
          'qwen-code.daemon.restart_recovery_continue_batch.members',
          results.length,
        );
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({ results });
      } finally {
        req.off('aborted', abort);
        res.off('close', onClose);
      }
    },
  );

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
    '/session/:id/feedback',
    mutate(),
    withOwnerMutableSession(
      'POST /session/:id/feedback',
      async (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        const promptId = body['promptId'];
        if (typeof promptId !== 'string' || !promptId) {
          res.status(400).json({
            error: '`promptId` is required and must be a non-empty string',
          });
          return;
        }
        const rating = body['rating'];
        if (rating !== 'up' && rating !== 'down') {
          res.status(400).json({ error: "`rating` must be 'up' or 'down'" });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const response = await runtime.bridge.rateSessionTurn(
          sessionId,
          { promptId, rating },
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
        const persist = body['persist'];
        if (configId !== 'reasoning_effort' && configId !== 'workflow_mode') {
          res.status(400).json({
            error: '`configId` must be reasoning_effort or workflow_mode',
          });
          return;
        }
        if (typeof value !== 'string' || !value) {
          res.status(400).json({
            error: '`value` is required and must be a non-empty string',
          });
          return;
        }
        if (configId === 'workflow_mode') {
          if ((value !== 'on' && value !== 'off') || persist !== undefined) {
            res.status(400).json({
              error:
                'Workflow mode requires on/off and does not accept persist',
            });
            return;
          }
          if (!runtime.trusted) {
            sendUntrustedSessionOwner(
              res,
              'POST /session/:id/config-option',
              sessionId,
              runtime,
            );
            return;
          }
          if (runtime.routeFileSystemFactory.sshWorkspace) {
            res.status(501).json({
              code: 'ssh_workspace_operation_unsupported',
              error: 'Workflow mode is unsupported for SSH workspaces',
            });
            return;
          }
        }
        if (persist !== undefined && typeof persist !== 'boolean') {
          res.status(400).json({
            error: '`persist` must be a boolean when provided',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const assertOpen = captureRuntimeGenerationAssertion(runtime);
        const response = await runtime.bridge.setSessionConfigOption(
          sessionId,
          {
            sessionId,
            configId,
            value,
            ...(persist === true
              ? {
                  _meta: {
                    [PERSIST_REASONING_SELECTION_META_KEY]: true,
                  },
                }
              : {}),
          },
          clientId !== undefined ? { clientId } : undefined,
          assertOpen,
        );
        assertOpen?.();
        res.status(200).json({
          configOptions: runtime.trusted
            ? response.configOptions
            : redactWorkflowModeFromConfigOptions(response).configOptions,
          persisted:
            configId === 'workflow_mode' ||
            response._meta?.[REASONING_SELECTION_PERSISTED_META_KEY] === true,
        });
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

  // A transcript row the client draws, for the session's Mods to rewrite. The
  // child checks the props against the site and builds the row's envelope.
  const modRowInput = z.object({
    component: z.string().min(1).max(64),
    props: z.record(z.string(), z.unknown()),
  });
  app.post(
    '/session/:id/mod-row',
    mutate(),
    withOwnerReadSession(
      'POST /session/:id/mod-row',
      async (req, res, sessionId, runtime) => {
        const parsed = modRowInput.safeParse(safeBody(req));
        if (!parsed.success) {
          res.status(400).json({
            code: 'invalid_mod_row',
            error: 'A row component and its props are required',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        // Guard admission without making an explicit close wait for a render.
        const { answer } = await archiveCoordinator.runSharedMany(
          [sessionId],
          async () => {
            runtime.generationGuard?.assertOpen();
            return {
              answer: runtime.bridge.askSessionModRow(
                sessionId,
                parsed.data,
                clientId !== undefined ? { clientId } : undefined,
              ),
            };
          },
        );
        res.status(200).json(await answer);
      },
    ),
  );

  const btwRequestId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
  const btwStreamInput = z.object({
    question: z.string().max(BTW_MAX_INPUT_LENGTH).trim().min(1),
    requestId: btwRequestId,
    resume: z.boolean().optional(),
  });
  const btwStreamHandler = (method: 'post' | 'delete') =>
    withOwnerMutableSession(
      method === 'post'
        ? 'POST /session/:id/btw/stream'
        : 'DELETE /session/:id/btw/stream/:requestId',
      (req, res, sessionId, runtime) => {
        const parsed =
          method === 'post'
            ? btwStreamInput.safeParse(safeBody(req))
            : btwRequestId.safeParse(req.params['requestId']);
        if (!parsed.success) {
          res.status(400).json({
            code: 'invalid_btw_request',
            error:
              method === 'post'
                ? 'A valid requestId and non-empty question are required'
                : 'A valid requestId is required',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const bridge = runtime.bridge;
        // Session detach can win the race with cancelling its own cached request.
        if (
          typeof parsed.data !== 'string' ||
          !btwStreams.has(bridge, sessionId, clientId, parsed.data)
        ) {
          // Authorize this live-session client without starting model work.
          bridge.getPendingPrompts(
            sessionId,
            clientId !== undefined ? { clientId } : undefined,
          );
        }
        try {
          if (typeof parsed.data === 'string') {
            btwStreams.cancel(bridge, sessionId, clientId, parsed.data);
            res.status(204).end();
            return;
          }
          if (!bridge.generateSessionBtwStream) {
            res.status(501).json({
              code: 'btw_stream_not_supported',
              error: 'Streaming side questions are not supported',
            });
            return;
          }
          const { requestId, question, resume } = parsed.data;
          // Terminal outcomes (409 conflict / 410 expired) must survive
          // saturation: decide them BEFORE the admission gate, which stays
          // immediately before open() so a refusal never starts the bridge
          // side request (issue #17554 review R1-5).
          btwStreams.precheck(
            bridge,
            sessionId,
            clientId,
            requestId,
            question,
            resume === true,
          );
          if (
            !checkSseAdmission({
              surface: 'artifactLibrary',
              req,
              res,
              caps: deps.sseAdmissionCaps,
              daemonLog: deps.daemonLog,
              logContext: { sessionId },
            })
          ) {
            return;
          }
          const request = btwStreams.open(
            bridge,
            sessionId,
            clientId,
            requestId,
            question,
            resume === true,
          );
          countSseStream('artifactLibrary', req, res);
          // The bridge's side request holds generation alive independently of HTTP.
          void streamBtwSnapshots(res, request);
        } catch (error) {
          if (!(error instanceof BtwStreamError)) throw error;
          res
            .status(error.status)
            .json({ code: error.code, error: error.message });
        }
      },
    );
  app.post('/session/:id/btw/stream', mutate(), btwStreamHandler('post'));
  app.delete(
    '/session/:id/btw/stream/:requestId',
    mutate(),
    btwStreamHandler('delete'),
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
  // Returns `{ accepted, messageId?, reason? }`; `reason` is `'session_idle'`
  // when an open session has no prompt admitted to its prompt FIFO and no
  // active Goal turn, which lets a client resubmit as an ordinary prompt
  // instead of reporting a failure. The verdict describes only what can drain
  // a mid-turn message, not everything the session may hold (a session
  // snapshot can still report `hasActivePrompt: true`). Every other rejection
  // cause — closing, attachment budget, mismatched `messageId`, full queue —
  // omits it, and a kept mismatched payload is not a delivery promise: a
  // removed promoted message disappears from snapshots at once — one that had
  // not started is dropped where it stands, one already running is hidden
  // until its aborted turn settles — so the removal response is the only
  // `removed = true` a client ever observes.
  // For a new admission, a `content` reference the session no longer holds
  // (or an invalid one) is declined before the idle/queue verdicts: the
  // bridge throws and the error mapping answers 410/400 with an
  // `{ error, code }` body — no `accepted`, no `reason`. A same-`messageId`
  // retry whose payload matches acks idempotently first, and a closing
  // session is refused reasonless first. Accepted requests are owned by the
  // daemon; rejected requests were not admitted. Synchronous — the bridge
  // only mutates its in-memory session queues.
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
      async (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        const eventDetailMode = parseReplayMode(body, res, 'eventDetailMode');
        if (eventDetailMode === null) return;
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
        let alreadyRecordedMidTurn = false;
        if (typeof messageId === 'string') {
          const previous = runtime.bridge.getMidTurnMessages(
            sessionId,
            clientId !== undefined ? { clientId } : undefined,
          );
          alreadyRecordedMidTurn =
            previous.messages.some(
              (message) => message.messageId === messageId,
            ) ||
            previous.settledMessageIds.includes(messageId) ||
            previous.promotedMessageIds.includes(messageId);
        }
        const result = runtime.bridge.enqueueMidTurnMessage(
          sessionId,
          trimmed,
          clientId !== undefined ? { clientId } : undefined,
          typeof messageId === 'string' ? messageId : undefined,
          {
            rejectIfIdle: true,
            ...(eventDetailMode !== undefined ? { eventDetailMode } : {}),
            ...(mediaBlocks ? { content: mediaBlocks } : {}),
          },
        );
        if (trimmed.length > 0 && result.accepted && !alreadyRecordedMidTurn) {
          await runWithWorkspaceRuntimeStorage(runtime, () =>
            appendWorkspaceInputHistory(
              runtime.workspaceCwd,
              'prompt',
              trimmed,
            ),
          ).catch((err) => {
            daemonLog?.warn('failed to record workspace input history', {
              sessionId,
              kind: 'prompt' satisfies WorkspaceInputHistoryKind,
              workspaceCwd: runtime.workspaceCwd,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
        res.status(200).json(result);
      },
    ),
  );

  // Send now cuts a streaming foreground response or ends its tool-calling
  // turn. Queued messages follow the prompt FIFO when a turn ends.
  app.post(
    '/session/:id/mid-turn-messages/send-now',
    mutate(),
    withOwnerMutableSession(
      'POST /session/:id/mid-turn-messages/send-now',
      (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const result = runtime.bridge.sendMidTurnMessagesNow(
          sessionId,
          clientId !== undefined ? { clientId } : undefined,
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
  app.get(
    '/session/:id/mid-turn-messages',
    withOwnerReadSession(
      'GET /session/:id/mid-turn-messages',
      (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const snapshot = runtime.bridge.getMidTurnMessages(
          sessionId,
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(snapshot);
      },
    ),
  );

  // Pending prompt queue: list and remove.
  app.get(
    '/session/:id/pending-prompts',
    withOwnerReadSession(
      'GET /session/:id/pending-prompts',
      (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const pendingPrompts = runtime.bridge.getPendingPrompts(
          sessionId,
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json({ pendingPrompts });
      },
    ),
  );

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

  // Register `current` before the parameter route so it is not a promptId.
  app.get(
    '/session/:id/turns/current',
    withOwnerReadSession(
      'GET /session/:id/turns/current',
      async (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const status = await runtime.bridge.getSessionTurnStatus(
          sessionId,
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(status);
      },
    ),
  );

  app.get(
    '/session/:id/turns/:promptId',
    withOwnerReadSession(
      'GET /session/:id/turns/:promptId',
      async (req, res, sessionId, runtime) => {
        const promptId = req.params['promptId'];
        if (!promptId) {
          res
            .status(400)
            .json({ error: '`promptId` route parameter is required' });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const status = await runtime.bridge.getSessionTurnStatus(
          sessionId,
          clientId !== undefined ? { clientId } : undefined,
          promptId,
        );
        if (!status) {
          res.status(404).json({
            error: `Prompt ${promptId} not found in session ${sessionId}`,
            code: 'prompt_not_found',
            sessionId,
            promptId,
          });
          return;
        }
        res.status(200).json(status);
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
        const trimmedCommand = command.trim();
        void runWithWorkspaceRuntimeStorage(runtime, () =>
          appendWorkspaceInputHistory(
            runtime.workspaceCwd,
            'shell',
            trimmedCommand,
          ),
        ).catch((err) => {
          daemonLog?.warn('failed to record workspace input history', {
            sessionId,
            kind: 'shell' satisfies WorkspaceInputHistoryKind,
            workspaceCwd: runtime.workspaceCwd,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        const abort = new AbortController();
        const onResClose = () => {
          if (!res.writableEnded) abort.abort();
        };
        res.once('close', onResClose);
        try {
          const result = await runtime.bridge.executeShellCommand(
            sessionId,
            trimmedCommand,
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
      { cwdBound: 'always' },
    ),
  );

  app.get(
    '/session/:id/message-groups',
    withOwnerReadSession(
      'GET /session/:id/message-groups',
      async (_req, res, sessionId, runtime) => {
        res.status(200).json(await runtime.bridge.getMessageGroups(sessionId));
      },
    ),
  );

  app.post(
    '/session/:id/messages/delete',
    mutate({ strict: true }),
    withOwnerMutableSession(
      'POST /session/:id/messages/delete',
      async (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        const snapshot = body['snapshot'];
        const groupIds = body['groupIds'];
        if (
          typeof snapshot !== 'string' ||
          snapshot.length === 0 ||
          !Array.isArray(groupIds) ||
          groupIds.length === 0 ||
          !groupIds.every((id) => typeof id === 'string' && id.length > 0) ||
          new Set(groupIds).size !== groupIds.length
        ) {
          res.status(400).json({
            error: 'A snapshot and distinct non-empty groupIds are required',
            code: 'invalid_message_groups',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        res
          .status(200)
          .json(
            await runtime.bridge.deleteMessageGroups(
              sessionId,
              { snapshot, groupIds },
              clientId !== undefined ? { clientId } : undefined,
            ),
          );
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
      { cwdBound: 'rewind-files' },
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
        const planMode = body['planMode'];
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
        if (
          planMode !== undefined &&
          (typeof planMode !== 'boolean' || mode === 'plan')
        ) {
          res.status(400).json({
            error:
              '`planMode` must be a boolean with a non-plan execution mode',
            code: 'invalid_plan_mode',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const response = await runtime.bridge.setSessionApprovalMode(
          sessionId,
          mode as ApprovalMode,
          {
            persist: persist === true,
            ...(typeof planMode === 'boolean' ? { planMode } : {}),
          },
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
      { cwdBound: 'sync-output-language' },
    ),
  );
  return { resolveSubagentSessionRuntime };
}
