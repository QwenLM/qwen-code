/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  CdWhilePromptActiveError,
  SessionArchivingError,
  SessionNotFoundError,
  StandaloneSessionSpawnError,
} from '@qwen-code/acp-bridge/bridgeErrors';
import type {
  AcpSessionBridge,
  BridgeConversationDirectoryExpectation,
  BridgeRestoredSession,
  BridgeRestoreSessionRequest,
  BridgeSession,
  BridgeSessionSummary,
  BridgeStandaloneRestoreSessionRequest,
} from '@qwen-code/acp-bridge/bridgeTypes';
import type { ServeWorkspaceProvidersStatus } from '@qwen-code/acp-bridge/status';
import { STANDALONE_SESSION_SOURCE_TYPE } from '@qwen-code/acp-bridge/sessionSource';
import {
  readSessionPrs,
  SessionIdCaseConflictError,
  SessionStorageEntryError,
  SessionTranscriptDurabilityError,
  SessionTranscriptChangedError,
  SessionWriterError,
  SessionWriterLostError,
  SessionWriterUnavailableError,
  type ApprovalMode,
  type SessionArchiveState,
  type SessionListItem,
  type SessionService,
  type SessionWriterLease,
} from '@qwen-code/qwen-code-core';
import {
  parseCallerSuppliedSessionId,
  normalizeSessionIdForLookup,
  type CallerSuppliedSessionIdParseResult,
} from '../../config/session-id.js';
import {
  readLoadableConversationSession,
  type LoadableConversationSession,
} from '../../runtime/live-session-source.js';
import {
  ConversationDirectoryIdentityError,
  isSameConversationPath,
  type ConversationDirectoryIdentity,
} from '../../utils/conversation-directory-identity.js';
import type { RequestedSessionIdAdmission } from '../session-id-admission.js';
import type { SessionArchiveCoordinator } from '../server/session-archive.js';
import {
  exportSessionTranscript,
  type SessionExportFormat,
  type SessionExportResult,
} from '../server/session-export.js';
import { listWorkspaceSessionsForResponse } from '../server/session-list.js';
import {
  createWorkspaceRuntimeSessionService,
  runWithWorkspaceRuntimeStorage,
} from '../workspace-runtime-storage.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import type { ConversationWorkspace } from './conversation-workspace.js';
import { ConversationRuntimeOwnershipError } from './conversation-runtime-errors.js';
import {
  StandaloneDeletionJournalError,
  type StandaloneDeletionJournal,
  type StandaloneDeletionRecordV2,
} from './standalone-deletion-journal.js';

export type StandaloneSessionServiceErrorCode =
  | 'invalid_request'
  | 'standalone_session_not_found'
  | 'standalone_session_conflict'
  | 'standalone_session_operation_failed'
  | 'session_archived'
  | 'session_busy'
  | 'standalone_creation_rolled_back'
  | 'standalone_creation_outcome_unknown'
  | 'working_directory_missing'
  | 'working_directory_compromised'
  | 'deletion_recovery_compromised'
  | 'transcript_deletion_failed'
  | 'transcript_deletion_outcome_unknown'
  | 'working_directory_recovery_failed';

export class StandaloneSessionServiceError extends Error {
  override readonly name = 'StandaloneSessionServiceError';

  constructor(
    readonly code: StandaloneSessionServiceErrorCode,
    readonly sessionId: string | undefined,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface CreateStandaloneSessionRequest {
  sessionId: string;
  modelServiceId?: string;
  approvalMode?: ApprovalMode;
}

export interface CreateStandaloneChildSessionRequest
  extends CreateStandaloneSessionRequest {
  parentSessionId: string;
  promptId: string;
}

export interface CreatedStandaloneSession {
  session: BridgeSession;
  projectlessOutputDirectory: string;
  workingDirectory: { state: 'ready' };
}

export type StandaloneSessionOptions = Omit<
  ServeWorkspaceProvidersStatus,
  'workspaceCwd' | 'acpChannelLive'
>;

export interface StandaloneSessionDirectoryResult {
  sessionId: string;
  projectlessOutputDirectory: string;
  workingDirectory: {
    state: 'ready' | 'recreated';
    warnings?: string[];
  };
}

export interface StandaloneSessionMetadataResult {
  sessionId: string;
  displayName: string;
}

export interface StandaloneBatchError {
  sessionId: string;
  code: StandaloneSessionServiceErrorCode;
  message: string;
}

export interface ArchiveStandaloneSessionsResult {
  archived: string[];
  alreadyArchived: string[];
  notFound: string[];
  errors: StandaloneBatchError[];
}

export interface UnarchiveStandaloneSessionsResult {
  unarchived: string[];
  alreadyActive: string[];
  notFound: string[];
  errors: StandaloneBatchError[];
}

export interface DeleteStandaloneSessionsResult {
  removed: string[];
  notFound: string[];
  errors: StandaloneBatchError[];
  fileCleanupPending: string[];
}

export interface CreatedStandaloneChildSession
  extends CreatedStandaloneSession {
  initialPrompt: {
    promptId: string;
    lastEventId: number;
    turn: ReturnType<AcpSessionBridge['sendPrompt']>;
  };
}

type CreatedStandaloneSessionInternal = CreatedStandaloneSession & {
  initialPrompt?: CreatedStandaloneChildSession['initialPrompt'];
};

export interface StandaloneSessionSummary extends BridgeSessionSummary {
  sessionId: string;
  sourceType: typeof STANDALONE_SESSION_SOURCE_TYPE;
  context: { kind: 'standalone' };
}

export interface StandaloneSessionCreating {
  sessionId: string;
  state: 'creating';
}

export type StandaloneSessionLookup =
  | StandaloneSessionSummary
  | StandaloneSessionCreating;

export interface ListStandaloneSessionsOptions {
  cursor?: string;
  size?: number;
  archiveState?: SessionArchiveState;
  signal?: AbortSignal;
}

export interface ListStandaloneSessionsResult {
  sessions: StandaloneSessionSummary[];
  nextCursor?: string;
  liveMergeFailed?: boolean;
  truncated?: boolean;
}

export type RestoreStandaloneSessionOptions = Pick<
  BridgeRestoreSessionRequest,
  | 'clientId'
  | 'historyPageSize'
  | 'liveReplayMode'
  | 'hideInheritedHistory'
  | 'approvalMode'
>;

export interface RestoredStandaloneSession extends BridgeRestoredSession {
  sourceType: typeof STANDALONE_SESSION_SOURCE_TYPE;
  context: { kind: 'standalone' };
  projectlessOutputDirectory: string;
  workingDirectory: {
    state: 'ready' | 'recreated';
    warnings?: string[];
  };
}

export interface StandaloneSessionServiceOptions {
  ensureRuntime(): Promise<WorkspaceRuntime>;
  assertRuntimeCurrent(runtime: WorkspaceRuntime): void;
  quarantineRuntime(runtime: WorkspaceRuntime): Promise<void>;
  runRuntimeActivity<T>(
    runtime: WorkspaceRuntime,
    operation: () => Promise<T>,
  ): Promise<T>;
  workspace: Pick<
    ConversationWorkspace,
    | 'assertExactRoot'
    | 'prepareStandaloneDirectory'
    | 'inspectStandaloneDirectory'
    | 'ensureStandaloneDirectory'
    | 'inspectStandaloneDeletionPaths'
    | 'createStandaloneDeletionExpectation'
    | 'stageStandaloneDirectory'
    | 'restoreStagedStandaloneDirectory'
    | 'removeStagedStandaloneDirectory'
    | 'confirmStandaloneRootDurability'
  >;
  deletionJournal: StandaloneDeletionJournal;
  lifecycle: SessionArchiveCoordinator;
  requestedSessionIdAdmission: RequestedSessionIdAdmission;
  hasForeignSessionOwner(
    runtime: WorkspaceRuntime,
    sessionId: string,
  ): Promise<boolean>;
  invalidateSessionListCache(runtime: WorkspaceRuntime): void;
}

interface CreatingEntry {
  readonly canonicalSessionId: string;
  readonly runtime: WorkspaceRuntime;
  readonly scope: 'top-level' | 'child';
  state: 'running' | 'quarantine-frozen';
  reservation?: { release(): void };
}

interface DirectoryState {
  pinned: ConversationDirectoryIdentity;
  agentBound?: {
    eventEpoch: string;
    released: boolean;
  };
}

interface PreparedRestoreDirectory {
  identity: ConversationDirectoryIdentity;
  state: 'ready' | 'recreated';
}

type StoredStandaloneState =
  | { kind: 'missing' }
  | { kind: 'conflict' }
  | { kind: 'foreign' }
  | {
      kind: 'standalone';
      storageSessionId: string;
      location: SessionArchiveState;
      source: LoadableConversationSession;
    };

class TerminalQuarantineSignal extends Error {
  constructor(readonly completion: Promise<void>) {
    super('Terminal Conversations runtime quarantine started');
  }
}

function invalidRequest(): StandaloneSessionServiceError {
  return new StandaloneSessionServiceError(
    'invalid_request',
    undefined,
    '`sessionId` must be an RFC UUID v1-v5.',
  );
}

function parseRequiredSessionId(
  value: unknown,
): Extract<CallerSuppliedSessionIdParseResult, { kind: 'valid' }> {
  const parsed = parseCallerSuppliedSessionId(value);
  if (parsed.kind !== 'valid') throw invalidRequest();
  return parsed;
}

function serviceError(
  code: StandaloneSessionServiceErrorCode,
  sessionId: string,
  retryable = code === 'working_directory_missing',
): StandaloneSessionServiceError {
  const messages: Record<StandaloneSessionServiceErrorCode, string> = {
    invalid_request: 'The standalone session request is invalid.',
    standalone_session_not_found: 'The standalone session was not found.',
    standalone_session_conflict:
      'The standalone session id or durable state conflicts with an existing session.',
    standalone_session_operation_failed:
      'The standalone session operation failed.',
    session_archived: 'The standalone session is archived.',
    session_busy: 'The standalone session is busy.',
    standalone_creation_rolled_back:
      'Standalone session creation failed before durable source persistence and was rolled back.',
    standalone_creation_outcome_unknown:
      'Standalone session creation could not be safely completed or rolled back.',
    working_directory_missing: 'The standalone working directory is missing.',
    working_directory_compromised:
      'The standalone working directory identity is compromised.',
    deletion_recovery_compromised:
      'Standalone session deletion recovery is compromised.',
    transcript_deletion_failed:
      'The standalone transcript could not be deleted.',
    transcript_deletion_outcome_unknown:
      'The standalone transcript deletion outcome is unknown.',
    working_directory_recovery_failed:
      'The standalone working directory could not be recovered.',
  };
  return new StandaloneSessionServiceError(
    code,
    sessionId,
    messages[code],
    retryable,
  );
}

function toBridgeExpectation(
  canonicalSessionId: string,
  identity: ConversationDirectoryIdentity,
): BridgeConversationDirectoryExpectation {
  return {
    canonicalSessionId,
    root: {
      canonicalPath: identity.root.canonicalRoot,
      device: identity.root.device,
      inode: identity.root.inode,
    },
    child: {
      name: identity.name,
      canonicalPath: identity.canonicalPath,
      device: identity.device,
      inode: identity.inode,
    },
  };
}

function toStandaloneSummary(
  item: SessionListItem,
  workspaceCwd: string,
  canonicalSessionId: string,
  isArchived: boolean,
  source: LoadableConversationSession,
): StandaloneSessionSummary {
  const displayName = item.customTitle || item.prompt || undefined;
  return {
    sessionId: canonicalSessionId,
    workspaceCwd,
    createdAt: item.startTime,
    updatedAt: new Date(item.mtime).toISOString(),
    ...(displayName ? { displayName } : {}),
    ...(item.customTitle && item.titleSource
      ? { titleSource: item.titleSource }
      : {}),
    sourceType: STANDALONE_SESSION_SOURCE_TYPE,
    context: { kind: 'standalone' },
    ...(source.metadata.parentSessionId !== undefined
      ? {
          parentSessionId: normalizeSessionIdForLookup(
            source.metadata.parentSessionId,
          ),
        }
      : {}),
    clientCount: 0,
    hasActivePrompt: false,
    isArchived,
  };
}

function laterTimestamp(
  first: string | undefined,
  second: string | undefined,
): string | undefined {
  if (!first) return second;
  if (!second) return first;
  return Date.parse(first) >= Date.parse(second) ? first : second;
}

function mergeLiveStandaloneSummary(
  persisted: StandaloneSessionSummary,
  live: BridgeSessionSummary,
): StandaloneSessionSummary {
  const merged: StandaloneSessionSummary = {
    ...persisted,
    ...(live.displayName !== undefined
      ? { displayName: live.displayName }
      : {}),
    updatedAt: laterTimestamp(live.updatedAt, persisted.updatedAt),
    clientCount: live.clientCount,
    hasActivePrompt: live.hasActivePrompt,
    ...(live.isWaitingForPermission !== undefined
      ? { isWaitingForPermission: live.isWaitingForPermission }
      : {}),
    ...(live.isWaitingForUserQuestion !== undefined
      ? { isWaitingForUserQuestion: live.isWaitingForUserQuestion }
      : {}),
    ...(live.pendingInteractionCount !== undefined
      ? { pendingInteractionCount: live.pendingInteractionCount }
      : {}),
    ...(live.hasTurnError !== undefined
      ? { hasTurnError: live.hasTurnError }
      : {}),
    ...(live.turnError ? { turnError: live.turnError } : {}),
    ...(live.pendingInteractions
      ? { pendingInteractions: live.pendingInteractions }
      : {}),
    isArchived: false,
  };
  if (persisted.prs || live.prs) {
    const livePrs = live.prs ?? [];
    merged.prs = [
      ...(persisted.prs ?? []).filter(
        (persistedPr) =>
          !livePrs.some((livePr) => livePr.number === persistedPr.number),
      ),
      ...livePrs,
    ];
  }
  return merged;
}

function isSameDirectoryIdentity(
  first: ConversationDirectoryIdentity,
  second: ConversationDirectoryIdentity,
): boolean {
  return (
    first.storageSessionId === second.storageSessionId &&
    first.name === second.name &&
    first.canonicalPath === second.canonicalPath &&
    first.device === second.device &&
    first.inode === second.inode &&
    first.root.canonicalRoot === second.root.canonicalRoot &&
    first.root.device === second.root.device &&
    first.root.inode === second.root.inode
  );
}

export class StandaloneSessionService {
  private readonly responseCreateRuntimes = new WeakMap<
    CreatedStandaloneSession,
    WorkspaceRuntime
  >();
  private readonly responseRestoreRuntimes = new WeakMap<
    RestoredStandaloneSession,
    WorkspaceRuntime
  >();
  private readonly pendingLifecycleLeaseReleases = new Map<
    string,
    SessionWriterLease
  >();
  private readonly creating = new Map<string, CreatingEntry>();
  private readonly directoryStates = new Map<string, DirectoryState>();
  private readonly reconciliations = new WeakMap<
    WorkspaceRuntime,
    Promise<void>
  >();
  private terminal = false;

  constructor(private readonly options: StandaloneSessionServiceOptions) {}

  async getOptions(): Promise<StandaloneSessionOptions> {
    const runtime = await this.options.ensureRuntime();
    return this.options.runRuntimeActivity(runtime, async () => {
      this.options.assertRuntimeCurrent(runtime);
      await this.options.workspace.assertExactRoot(runtime.workspaceCwd);
      this.options.assertRuntimeCurrent(runtime);
      const status = await runtime.workspaceService.getWorkspaceProvidersStatus(
        {
          route: 'GET /standalone/session-options',
          workspaceCwd: runtime.workspaceCwd,
        },
      );
      this.options.assertRuntimeCurrent(runtime);
      if (status.workspaceCwd !== runtime.workspaceCwd) {
        throw new ConversationRuntimeOwnershipError(
          'conversation_runtime_ownership_compromised',
          false,
        );
      }
      return {
        v: status.v,
        initialized: status.initialized,
        ...(status.current !== undefined ? { current: status.current } : {}),
        ...(status.approvalMode !== undefined
          ? { approvalMode: status.approvalMode }
          : {}),
        providers: status.providers,
        ...(status.errors !== undefined ? { errors: status.errors } : {}),
      };
    });
  }

  freezeForTerminalQuarantine(runtime: WorkspaceRuntime): void {
    this.terminal = true;
    for (const entry of this.creating.values()) {
      if (entry.runtime === runtime) entry.state = 'quarantine-frozen';
    }
  }

  get(rawSessionId: string): Promise<StandaloneSessionLookup> {
    return this.getWithRequiredScope(rawSessionId, 'top-level');
  }

  getForInternalTask(rawSessionId: string): Promise<StandaloneSessionLookup> {
    return this.getWithRequiredScope(rawSessionId, 'any');
  }

  private async getWithRequiredScope(
    rawSessionId: string,
    requiredScope: 'top-level' | 'any',
  ): Promise<StandaloneSessionLookup> {
    const { sessionId } = parseRequiredSessionId(rawSessionId);
    const creating = this.creating.get(sessionId);
    if (
      creating !== undefined &&
      (requiredScope === 'any' || creating.scope === 'top-level')
    ) {
      return { sessionId, state: 'creating' };
    }
    if (creating) {
      throw serviceError('standalone_session_not_found', sessionId);
    }
    const runtime = await this.options.ensureRuntime();
    try {
      return await this.options.runRuntimeActivity(runtime, async () => {
        this.options.assertRuntimeCurrent(runtime);
        await this.options.workspace.assertExactRoot(runtime.workspaceCwd);
        this.options.assertRuntimeCurrent(runtime);
        return this.options.lifecycle.runSharedMany([sessionId], async () => {
          this.options.assertRuntimeCurrent(runtime);
          const persisted = await this.readStandaloneSummary(
            runtime,
            sessionId,
            requiredScope,
          );
          if (await this.options.deletionJournal.hasRecord(sessionId)) {
            throw serviceError('standalone_session_conflict', sessionId, true);
          }
          this.options.assertRuntimeCurrent(runtime);
          if (persisted.isArchived) return persisted;
          let live: BridgeSessionSummary;
          try {
            live = runtime.bridge.getSessionSummary(sessionId);
          } catch (error) {
            if (error instanceof SessionNotFoundError) return persisted;
            throw error;
          }
          if (
            live.sourceType !== STANDALONE_SESSION_SOURCE_TYPE ||
            live.sourceId !== undefined ||
            normalizeSessionIdForLookup(live.parentSessionId ?? '') !==
              normalizeSessionIdForLookup(persisted.parentSessionId ?? '') ||
            live.worktree !== undefined ||
            live.branch !== undefined
          ) {
            throw serviceError('standalone_session_conflict', sessionId);
          }
          this.options.assertRuntimeCurrent(runtime);
          return mergeLiveStandaloneSummary(persisted, live);
        });
      });
    } catch (error) {
      if (error instanceof SessionIdCaseConflictError) {
        throw serviceError('standalone_session_conflict', sessionId);
      }
      throw error;
    }
  }

  async list(
    options: ListStandaloneSessionsOptions = {},
  ): Promise<ListStandaloneSessionsResult> {
    const runtime = await this.options.ensureRuntime();
    return this.options.runRuntimeActivity(runtime, async () => {
      this.options.assertRuntimeCurrent(runtime);
      await this.options.workspace.assertExactRoot(runtime.workspaceCwd);
      this.options.assertRuntimeCurrent(runtime);
      const result = await listWorkspaceSessionsForResponse(
        runtime.bridge,
        runtime.workspaceCwd,
        {
          conversationKind: 'standalone-top-level',
          ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
          ...(options.size !== undefined ? { size: options.size } : {}),
          ...(options.archiveState !== undefined
            ? { archiveState: options.archiveState }
            : {}),
        },
        {
          runtimeBaseDir: runtime.sessionRuntimeBaseDir,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        },
      );
      this.options.assertRuntimeCurrent(runtime);
      const byCanonicalId = new Map<string, StandaloneSessionSummary>();
      const conflictedIds = new Set<string>();
      for (const raw of result.sessions) {
        const parsed = parseCallerSuppliedSessionId(raw.sessionId);
        if (parsed.kind !== 'valid') continue;
        if (
          raw.sourceId !== undefined ||
          raw.parentSessionId !== undefined ||
          raw.worktree !== undefined ||
          raw.branch !== undefined
        ) {
          continue;
        }
        if (conflictedIds.has(parsed.sessionId)) continue;
        if (byCanonicalId.has(parsed.sessionId)) {
          byCanonicalId.delete(parsed.sessionId);
          conflictedIds.add(parsed.sessionId);
          continue;
        }
        const {
          sourceId: _sourceId,
          parentSessionId: _parentSessionId,
          ...summary
        } = raw;
        byCanonicalId.set(parsed.sessionId, {
          ...summary,
          sessionId: parsed.sessionId,
          workspaceCwd: runtime.workspaceCwd,
          sourceType: STANDALONE_SESSION_SOURCE_TYPE,
          context: { kind: 'standalone' },
        });
      }
      const sessions: StandaloneSessionSummary[] = [];
      for (const summary of byCanonicalId.values()) {
        options.signal?.throwIfAborted();
        let stable = false;
        try {
          stable = await this.options.lifecycle.runSharedMany(
            [summary.sessionId],
            async () => {
              options.signal?.throwIfAborted();
              if (
                await this.options.deletionJournal.hasRecord(summary.sessionId)
              ) {
                return false;
              }
              options.signal?.throwIfAborted();
              const durable = await this.inspectStoredStandalone(
                runtime,
                summary.sessionId,
              );
              options.signal?.throwIfAborted();
              return (
                durable.kind === 'standalone' &&
                durable.source.metadata.parentSessionId === undefined &&
                (durable.location === 'archived') ===
                  (summary.isArchived === true)
              );
            },
          );
        } catch (error) {
          if (!(error instanceof SessionArchivingError)) throw error;
        }
        options.signal?.throwIfAborted();
        if (stable) sessions.push(summary);
      }
      return {
        sessions,
        ...(result.nextCursor !== undefined
          ? { nextCursor: result.nextCursor }
          : {}),
        ...(result.liveMergeFailed ? { liveMergeFailed: true } : {}),
        ...(result.truncated ? { truncated: true } : {}),
      };
    });
  }

  async repairDirectory(
    rawSessionId: string,
  ): Promise<StandaloneSessionDirectoryResult> {
    const clientId = randomUUID();
    const restored = await this.restore('resume', rawSessionId, { clientId });
    try {
      await this.cleanupDisconnectedRestore(restored);
    } catch {
      try {
        await this.cleanupDisconnectedRestore(restored);
      } catch {
        throw serviceError(
          'working_directory_recovery_failed',
          restored.sessionId,
          true,
        );
      }
    }
    return {
      sessionId: restored.sessionId,
      projectlessOutputDirectory: restored.projectlessOutputDirectory,
      workingDirectory: restored.workingDirectory,
    };
  }

  async rename(
    rawSessionId: string,
    displayName: string,
    clientId?: string,
  ): Promise<StandaloneSessionMetadataResult> {
    const { sessionId } = parseRequiredSessionId(rawSessionId);
    this.assertDisplayName(displayName);
    const runtime = await this.options.ensureRuntime();
    return this.options.runRuntimeActivity(runtime, async () => {
      this.options.assertRuntimeCurrent(runtime);
      await this.options.workspace.assertExactRoot(runtime.workspaceCwd);
      await this.reconcilePendingDeletions(runtime);
      return this.options.lifecycle.runExclusiveAfterShared(
        sessionId,
        async () => {
          await this.reconcileDeletionUnderExclusive(runtime, sessionId);
          const durable = await this.requireTopLevelStoredStandalone(
            runtime,
            sessionId,
          );
          let live: BridgeSessionSummary | undefined;
          try {
            live = runtime.bridge.getSessionSummary(sessionId);
          } catch (error) {
            if (!(error instanceof SessionNotFoundError)) throw error;
          }
          if (live) {
            this.assertMatchingLiveStandalone(live, durable, sessionId);
            runtime.bridge.updateSessionMetadata(
              sessionId,
              { displayName },
              clientId !== undefined ? { clientId } : undefined,
            );
          } else {
            await runWithWorkspaceRuntimeStorage(runtime, async () => {
              const service = createWorkspaceRuntimeSessionService(runtime);
              const lease = await this.acquireLifecycleLease(
                service,
                durable.storageSessionId,
              );
              try {
                const renamed = await service.renameSessionForLifecycle(
                  durable.storageSessionId,
                  displayName,
                  'manual',
                  durable.location,
                  {
                    assertStorageUnchanged: () =>
                      lease.assertOwnedAndUnchanged(),
                    assertCanMutate: () =>
                      this.options.assertRuntimeCurrent(runtime),
                  },
                );
                if (!renamed) {
                  throw serviceError('standalone_session_not_found', sessionId);
                }
              } catch (error) {
                await this.releaseLifecycleLease(
                  lease,
                  durable.storageSessionId,
                );
                throw error;
              }
              if (
                !(await this.releaseLifecycleLease(
                  lease,
                  durable.storageSessionId,
                ))
              ) {
                throw new SessionWriterUnavailableError();
              }
            });
            runtime.bridge.markSessionCatalogChanged();
          }
          this.options.invalidateSessionListCache(runtime);
          return { sessionId, displayName };
        },
      );
    });
  }

  async export(
    rawSessionId: string,
    format: SessionExportFormat,
  ): Promise<SessionExportResult> {
    const { sessionId } = parseRequiredSessionId(rawSessionId);
    const runtime = await this.options.ensureRuntime();
    return this.options.runRuntimeActivity(runtime, async () => {
      this.options.assertRuntimeCurrent(runtime);
      await this.options.workspace.assertExactRoot(runtime.workspaceCwd);
      return this.options.lifecycle.runSharedMany([sessionId], async () => {
        const durable = await this.requireTopLevelStoredStandalone(
          runtime,
          sessionId,
        );
        if (await this.options.deletionJournal.hasRecord(sessionId)) {
          throw serviceError('standalone_session_conflict', sessionId, true);
        }
        return exportSessionTranscript({
          workspaceCwd: runtime.workspaceCwd,
          sessionId: durable.storageSessionId,
          format,
          archiveState: durable.location,
          runtimeBaseDir: runtime.sessionRuntimeBaseDir,
        });
      });
    });
  }

  archive(rawSessionIds: string[]): Promise<ArchiveStandaloneSessionsResult> {
    const sessionIds = this.parseSessionIds(rawSessionIds);
    return this.archiveMany(sessionIds);
  }

  unarchive(
    rawSessionIds: string[],
  ): Promise<UnarchiveStandaloneSessionsResult> {
    const sessionIds = this.parseSessionIds(rawSessionIds);
    return this.unarchiveMany(sessionIds);
  }

  delete(rawSessionIds: string[]): Promise<DeleteStandaloneSessionsResult> {
    const sessionIds = this.parseSessionIds(rawSessionIds);
    return this.deleteMany(sessionIds);
  }

  async cleanupDisconnectedCreate(
    created: CreatedStandaloneSession,
  ): Promise<void> {
    const runtime = this.responseCreateRuntimes.get(created);
    if (!runtime || created.session.clientId === undefined) {
      throw serviceError(
        'standalone_session_operation_failed',
        created.session.sessionId,
      );
    }
    await runtime.bridge.detachClient(
      created.session.sessionId,
      created.session.clientId,
    );
    this.responseCreateRuntimes.delete(created);
  }

  async cleanupDisconnectedRestore(
    restored: RestoredStandaloneSession,
  ): Promise<void> {
    const runtime = this.responseRestoreRuntimes.get(restored);
    if (!runtime) {
      throw serviceError(
        'standalone_session_operation_failed',
        restored.sessionId,
      );
    }
    await runtime.bridge.detachClient(restored.sessionId, restored.clientId);
    this.responseRestoreRuntimes.delete(restored);
  }

  load(
    rawSessionId: string,
    options: RestoreStandaloneSessionOptions = {},
  ): Promise<RestoredStandaloneSession> {
    return this.restore('load', rawSessionId, options);
  }

  resume(
    rawSessionId: string,
    options: RestoreStandaloneSessionOptions = {},
  ): Promise<RestoredStandaloneSession> {
    return this.restore('resume', rawSessionId, options);
  }

  resumeForInternalTask(
    rawSessionId: string,
    options: RestoreStandaloneSessionOptions = {},
  ): Promise<RestoredStandaloneSession> {
    return this.restore('resume', rawSessionId, options, 'any', 'any');
  }

  restoreLegacyForCompatibility(
    action: 'load' | 'resume',
    rawSessionId: string,
    options: RestoreStandaloneSessionOptions = {},
  ): Promise<RestoredStandaloneSession> {
    return this.restore(action, rawSessionId, options, 'legacy', 'any');
  }

  async assertCwdReadyUnderShared(
    expectedRuntime: WorkspaceRuntime,
    rawSessionId: string,
  ): Promise<string> {
    const { sessionId } = parseRequiredSessionId(rawSessionId);
    this.options.assertRuntimeCurrent(expectedRuntime);
    await this.options.workspace.assertExactRoot(expectedRuntime.workspaceCwd);
    this.options.assertRuntimeCurrent(expectedRuntime);
    const durable = await this.assertActiveStandaloneSession(
      expectedRuntime,
      sessionId,
      'any',
      'any',
    );
    const state = this.directoryStates.get(sessionId);
    if (!state) throw serviceError('working_directory_missing', sessionId);
    await this.assertPinnedDirectory(sessionId, state.pinned);
    this.options.assertRuntimeCurrent(expectedRuntime);
    const summary = expectedRuntime.bridge.getSessionSummary(sessionId);
    if (
      summary.sourceType !== STANDALONE_SESSION_SOURCE_TYPE ||
      summary.sourceId !== undefined ||
      normalizeSessionIdForLookup(summary.parentSessionId ?? '') !==
        normalizeSessionIdForLookup(
          durable.source.metadata.parentSessionId ?? '',
        ) ||
      summary.worktree !== undefined ||
      summary.branch !== undefined
    ) {
      throw serviceError('standalone_session_conflict', sessionId);
    }
    this.options.assertRuntimeCurrent(expectedRuntime);
    const currentCwd = expectedRuntime.bridge.getSessionCurrentCwd(sessionId);
    if (!isSameConversationPath(currentCwd, state.pinned.canonicalPath)) {
      throw serviceError('working_directory_compromised', sessionId);
    }
    this.options.assertRuntimeCurrent(expectedRuntime);
    const eventEpoch = expectedRuntime.bridge.getSessionEventEpoch(sessionId);
    if (!this.isReusableBinding(sessionId, state.pinned, eventEpoch)) {
      throw serviceError('working_directory_missing', sessionId);
    }
    this.options.assertRuntimeCurrent(expectedRuntime);
    return durable.storageSessionId;
  }

  async dispatchPrompt<T>(
    rawSessionId: string,
    dispatch: (
      runtime: WorkspaceRuntime,
      canonicalSessionId: string,
      onPromptAdmitted: () => void,
    ) => Promise<T>,
  ): Promise<T> {
    const { sessionId } = parseRequiredSessionId(rawSessionId);
    const runtime = await this.options.ensureRuntime();
    let result!: Promise<T>;
    await this.options.runRuntimeActivity(runtime, async () => {
      this.options.assertRuntimeCurrent(runtime);
      await this.options.lifecycle.runSharedMany([sessionId], async () => {
        await this.assertCwdReadyUnderShared(runtime, sessionId);
        let resolveAdmission!: () => void;
        const admission = new Promise<void>((resolve) => {
          resolveAdmission = resolve;
        });
        let admitted = false;
        const onPromptAdmitted = () => {
          if (admitted) return;
          admitted = true;
          resolveAdmission();
        };
        result = dispatch(runtime, sessionId, onPromptAdmitted);
        void result.then(resolveAdmission, resolveAdmission);
        await admission;
      });
    });
    return result;
  }

  async continueSession<T>(
    rawSessionId: string,
    dispatch: (
      runtime: WorkspaceRuntime,
      canonicalSessionId: string,
    ) => Promise<T>,
  ): Promise<T> {
    const { sessionId } = parseRequiredSessionId(rawSessionId);
    const runtime = await this.options.ensureRuntime();
    return this.options.runRuntimeActivity(runtime, async () => {
      this.options.assertRuntimeCurrent(runtime);
      return this.options.lifecycle.runSharedMany([sessionId], async () => {
        await this.assertCwdReadyUnderShared(runtime, sessionId);
        this.options.assertRuntimeCurrent(runtime);
        const result = await dispatch(runtime, sessionId);
        this.options.assertRuntimeCurrent(runtime);
        return result;
      });
    });
  }

  private reconcilePendingDeletions(runtime: WorkspaceRuntime): Promise<void> {
    const existing = this.reconciliations.get(runtime);
    if (existing) return existing;
    const pending = (async () => {
      const sessionIds = await this.options.deletionJournal.listSessionIds(32);
      for (const sessionId of sessionIds) {
        try {
          await this.options.lifecycle.runExclusiveAfterShared(
            sessionId,
            async () => {
              await this.reconcileDeletionUnderExclusive(runtime, sessionId);
            },
          );
        } catch {
          // A compromised or temporarily unavailable record is isolated to
          // its UUID. The exact operation for that UUID will surface the
          // structured failure while other sessions remain usable.
        }
      }
    })();
    this.reconciliations.set(runtime, pending);
    const clearPending = () => {
      if (this.reconciliations.get(runtime) === pending) {
        this.reconciliations.delete(runtime);
      }
    };
    void pending.then(clearPending, clearPending);
    return pending;
  }

  private async reconcileDeletionUnderExclusive(
    runtime: WorkspaceRuntime,
    sessionId: string,
    allowCommittedCleanupPending = false,
  ): Promise<'none' | 'rolled-back' | 'committed' | 'cleanup-pending'> {
    this.options.assertRuntimeCurrent(runtime);
    const root = await this.options.workspace.assertExactRoot(
      runtime.workspaceCwd,
    );
    let journal;
    try {
      journal = await this.options.deletionJournal.read(sessionId, root);
    } catch (error) {
      if (error instanceof StandaloneDeletionJournalError) {
        throw serviceError('deletion_recovery_compromised', sessionId);
      }
      throw error;
    }
    if (!journal) return 'none';

    if (await this.options.hasForeignSessionOwner(runtime, sessionId)) {
      throw serviceError('deletion_recovery_compromised', sessionId);
    }

    try {
      runtime.bridge.getSessionSummary(sessionId);
      throw serviceError('deletion_recovery_compromised', sessionId);
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) throw error;
    }

    const record = journal.prepared;
    const expected =
      record.directory.kind === 'present'
        ? await this.options.workspace.createStandaloneDeletionExpectation(
            sessionId,
            record.directory,
          )
        : undefined;
    const paths = await this.options.workspace.inspectStandaloneDeletionPaths(
      sessionId,
      expected,
    );
    if (paths.status === 'compromised') {
      throw serviceError('deletion_recovery_compromised', sessionId);
    }

    return runWithWorkspaceRuntimeStorage(runtime, async () => {
      const service = createWorkspaceRuntimeSessionService(runtime);
      const lease = await this.acquireLifecycleLease(
        service,
        record.storageSessionId,
      );
      const mapRecoveryError = (error: unknown): never => {
        if (error instanceof StandaloneSessionServiceError) throw error;
        if (error instanceof SessionTranscriptDurabilityError) {
          throw serviceError('transcript_deletion_outcome_unknown', sessionId);
        }
        if (
          error instanceof ConversationDirectoryIdentityError ||
          error instanceof SessionStorageEntryError ||
          error instanceof StandaloneDeletionJournalError
        ) {
          throw serviceError('deletion_recovery_compromised', sessionId);
        }
        throw serviceError(
          'working_directory_recovery_failed',
          sessionId,
          true,
        );
      };

      let durable: StoredStandaloneState;
      try {
        durable = await this.inspectStoredStandalone(runtime, sessionId);
        await lease.assertOwnedAndUnchanged();
        if (durable.kind === 'conflict' || durable.kind === 'foreign') {
          throw serviceError('deletion_recovery_compromised', sessionId);
        }
        if (record.version === 1 && durable.kind !== 'standalone') {
          const physical =
            await service.getSessionTranscriptLocationForLifecycle(
              record.storageSessionId,
            );
          if (physical === undefined) {
            throw serviceError(
              'transcript_deletion_outcome_unknown',
              sessionId,
            );
          }
          if (physical !== record.transcriptLocation) {
            throw serviceError('deletion_recovery_compromised', sessionId);
          }
          if (record.directory.kind === 'absent') {
            if (paths.status !== 'absent') {
              throw serviceError('deletion_recovery_compromised', sessionId);
            }
          } else if (paths.status === 'staged') {
            await this.options.workspace.restoreStagedStandaloneDirectory(
              sessionId,
              expected!,
            );
          } else if (paths.status !== 'normal') {
            throw serviceError('deletion_recovery_compromised', sessionId);
          }
          await this.options.workspace.confirmStandaloneRootDurability(root);
          await lease.assertOwnedAndUnchanged();
          if (
            !(await this.releaseLifecycleLease(lease, record.storageSessionId))
          ) {
            throw serviceError(
              'working_directory_recovery_failed',
              sessionId,
              true,
            );
          }
          try {
            await this.options.deletionJournal.clear(sessionId, root);
          } catch (error) {
            return mapRecoveryError(error);
          }
          return 'rolled-back';
        }
        if (durable.kind === 'standalone') {
          if (
            durable.storageSessionId !== record.storageSessionId ||
            durable.location !== record.transcriptLocation ||
            durable.source.metadata.parentSessionId !== undefined
          ) {
            throw serviceError('deletion_recovery_compromised', sessionId);
          }
          if (record.directory.kind === 'absent') {
            if (paths.status !== 'absent') {
              throw serviceError('deletion_recovery_compromised', sessionId);
            }
          } else if (paths.status === 'staged') {
            await this.options.workspace.restoreStagedStandaloneDirectory(
              sessionId,
              expected!,
            );
          } else if (paths.status !== 'normal') {
            throw serviceError('deletion_recovery_compromised', sessionId);
          }
          await this.options.workspace.confirmStandaloneRootDurability(root);
          await lease.assertOwnedAndUnchanged();
        } else {
          if (record.version !== 2) {
            throw serviceError('deletion_recovery_compromised', sessionId);
          }
          const physical =
            await service.getSessionTranscriptLocationForLifecycle(
              record.storageSessionId,
            );
          if (
            physical === 'conflict' ||
            (physical !== undefined && physical !== record.transcriptLocation)
          ) {
            throw serviceError('deletion_recovery_compromised', sessionId);
          }
          if (physical === record.transcriptLocation) {
            const removed = await service.removeSessionTranscriptForLifecycle(
              record.storageSessionId,
              record.transcriptLocation,
              record.transcriptParent,
              {
                assertStorageUnchanged: () => lease.assertOwnedAndUnchanged(),
                assertCanMutate: () =>
                  this.options.assertRuntimeCurrent(runtime),
              },
            );
            if (
              !removed ||
              (await service.getSessionTranscriptLocationForLifecycle(
                record.storageSessionId,
              )) !== undefined
            ) {
              throw serviceError('deletion_recovery_compromised', sessionId);
            }
          }
          await service.confirmSessionTranscriptDeletionForLifecycle(
            record.transcriptLocation,
            record.transcriptParent,
          );
        }
      } catch (error) {
        await this.releaseLifecycleLease(lease, record.storageSessionId);
        return mapRecoveryError(error);
      }

      if (durable.kind === 'standalone') {
        if (
          !(await this.releaseLifecycleLease(lease, record.storageSessionId))
        ) {
          throw serviceError(
            'working_directory_recovery_failed',
            sessionId,
            true,
          );
        }
        try {
          await this.options.deletionJournal.clear(sessionId, root);
        } catch (error) {
          return mapRecoveryError(error);
        }
        return 'rolled-back';
      }

      let cleanupPending = false;
      if (record.directory.kind === 'absent') {
        if (paths.status !== 'absent') {
          await this.releaseLifecycleLease(lease, record.storageSessionId);
          throw serviceError('deletion_recovery_compromised', sessionId);
        }
        try {
          await this.options.workspace.confirmStandaloneRootDurability(root);
        } catch (error) {
          if (error instanceof ConversationDirectoryIdentityError) {
            await this.releaseLifecycleLease(lease, record.storageSessionId);
            throw serviceError('deletion_recovery_compromised', sessionId);
          }
          cleanupPending = true;
        }
      } else if (paths.status === 'staged') {
        try {
          await this.options.workspace.removeStagedStandaloneDirectory(
            sessionId,
            expected!,
          );
        } catch (error) {
          if (error instanceof ConversationDirectoryIdentityError) {
            await this.releaseLifecycleLease(lease, record.storageSessionId);
            throw serviceError('deletion_recovery_compromised', sessionId);
          }
          cleanupPending = true;
        }
      } else if (paths.status !== 'absent') {
        await this.releaseLifecycleLease(lease, record.storageSessionId);
        throw serviceError('deletion_recovery_compromised', sessionId);
      } else {
        try {
          await this.options.workspace.confirmStandaloneRootDurability(root);
        } catch (error) {
          if (error instanceof ConversationDirectoryIdentityError) {
            await this.releaseLifecycleLease(lease, record.storageSessionId);
            throw serviceError('deletion_recovery_compromised', sessionId);
          }
          cleanupPending = true;
        }
      }
      let cleanupOwnershipLost = false;
      try {
        await service.cleanupRemovedSessionStateForLifecycle(
          record.storageSessionId,
          {
            assertCanMutate: () => this.options.assertRuntimeCurrent(runtime),
            assertCleanupOwned: () => {
              this.options.assertRuntimeCurrent(runtime);
              lease.assertCleanupOwned();
            },
          },
        );
      } catch (error) {
        cleanupPending = true;
        cleanupOwnershipLost =
          error instanceof SessionWriterError ||
          error instanceof ConversationRuntimeOwnershipError;
      }
      if (!cleanupOwnershipLost) {
        try {
          await runtime.bridge.deleteSessionAttachments(sessionId, {
            assertCanCommit: () => this.options.assertRuntimeCurrent(runtime),
          });
        } catch {
          cleanupPending = true;
        }
      }
      if (!(await this.releaseLifecycleLease(lease, record.storageSessionId))) {
        cleanupPending = true;
      }
      if (!cleanupPending) {
        try {
          await this.options.deletionJournal.clear(sessionId, root);
        } catch {
          cleanupPending = true;
        }
      }
      this.directoryStates.delete(sessionId);
      runtime.bridge.markSessionCatalogChanged();
      this.options.invalidateSessionListCache(runtime);
      if (cleanupPending) {
        if (allowCommittedCleanupPending) return 'cleanup-pending';
        throw serviceError(
          'working_directory_recovery_failed',
          sessionId,
          true,
        );
      }
      return 'committed';
    });
  }

  private async inspectStoredStandalone(
    runtime: WorkspaceRuntime,
    sessionId: string,
  ): Promise<StoredStandaloneState> {
    try {
      return await runWithWorkspaceRuntimeStorage(runtime, async () => {
        const service = createWorkspaceRuntimeSessionService(runtime);
        const storageSessionId =
          await service.findSessionIdIgnoringCase(sessionId);
        if (storageSessionId === undefined) return { kind: 'missing' };
        const location = await service.getSessionLocation(storageSessionId);
        if (location === 'conflict') return { kind: 'conflict' };
        if (location !== 'active' && location !== 'archived') {
          return { kind: 'missing' };
        }
        const source = await readLoadableConversationSession(
          storageSessionId,
          service,
        );
        if (source?.kind !== 'standalone') return { kind: 'foreign' };
        return {
          kind: 'standalone',
          storageSessionId,
          location,
          source,
        };
      });
    } catch (error) {
      if (error instanceof SessionIdCaseConflictError) {
        return { kind: 'conflict' };
      }
      throw error;
    }
  }

  private async acquireLifecycleLease(
    service: SessionService,
    storageSessionId: string,
  ): Promise<SessionWriterLease> {
    const pendingKey = normalizeSessionIdForLookup(storageSessionId);
    const pending = this.pendingLifecycleLeaseReleases.get(pendingKey);
    if (
      pending &&
      !(await this.releaseLifecycleLease(pending, storageSessionId)) &&
      this.pendingLifecycleLeaseReleases.get(pendingKey) === pending
    ) {
      throw new SessionWriterUnavailableError({
        message: 'A previous session writer lease is still being released.',
      });
    }
    const leaseOptions = {
      processKind: 'daemon' as const,
      reclaimPolicy: 'never' as const,
      takeoverPolicy: 'certified' as const,
    };
    try {
      return await service.acquireSessionWriterLease(
        storageSessionId,
        leaseOptions,
      );
    } catch (error) {
      if (
        !(error instanceof SessionWriterUnavailableError) &&
        !(error instanceof SessionTranscriptChangedError)
      ) {
        throw error;
      }
      return service.acquireSessionMaintenanceLease(
        storageSessionId,
        leaseOptions,
      );
    }
  }

  private async releaseLifecycleLease(
    lease: SessionWriterLease,
    storageSessionId: string,
  ): Promise<boolean> {
    const pendingKey = normalizeSessionIdForLookup(storageSessionId);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await lease.release();
        if (this.pendingLifecycleLeaseReleases.get(pendingKey) === lease) {
          this.pendingLifecycleLeaseReleases.delete(pendingKey);
        }
        return true;
      } catch (error) {
        if (error instanceof SessionWriterLostError) {
          if (this.pendingLifecycleLeaseReleases.get(pendingKey) === lease) {
            this.pendingLifecycleLeaseReleases.delete(pendingKey);
          }
          return false;
        }
        // The lease clears retryable terminal failures itself.
      }
    }
    if (!lease.isReleased || lease.isReleaseDurabilityPending) {
      this.pendingLifecycleLeaseReleases.set(pendingKey, lease);
    } else if (this.pendingLifecycleLeaseReleases.get(pendingKey) === lease) {
      this.pendingLifecycleLeaseReleases.delete(pendingKey);
    }
    return false;
  }

  private parseSessionIds(rawSessionIds: string[]): string[] {
    if (rawSessionIds.length === 0 || rawSessionIds.length > 100) {
      throw invalidRequest();
    }
    const sessionIds: string[] = [];
    const seen = new Set<string>();
    for (const rawSessionId of rawSessionIds) {
      const { sessionId } = parseRequiredSessionId(rawSessionId);
      if (!seen.has(sessionId)) {
        seen.add(sessionId);
        sessionIds.push(sessionId);
      }
    }
    return sessionIds;
  }

  private assertDisplayName(displayName: string): void {
    if (
      typeof displayName !== 'string' ||
      displayName.trim().length === 0 ||
      displayName.length > 256 ||
      /\p{Cc}/u.test(displayName)
    ) {
      throw new StandaloneSessionServiceError(
        'invalid_request',
        undefined,
        '`displayName` must be a non-empty string of at most 256 characters without control characters.',
      );
    }
  }

  private async requireTopLevelStoredStandalone(
    runtime: WorkspaceRuntime,
    sessionId: string,
  ): Promise<Extract<StoredStandaloneState, { kind: 'standalone' }>> {
    const durable = await this.inspectStoredStandalone(runtime, sessionId);
    if (durable.kind === 'missing') {
      throw serviceError('standalone_session_not_found', sessionId);
    }
    if (
      durable.kind !== 'standalone' ||
      durable.storageSessionId.toLowerCase() !== sessionId ||
      durable.source.metadata.parentSessionId !== undefined
    ) {
      throw serviceError('standalone_session_conflict', sessionId);
    }
    return durable;
  }

  private assertMatchingLiveStandalone(
    live: BridgeSessionSummary,
    durable: Extract<StoredStandaloneState, { kind: 'standalone' }>,
    sessionId: string,
  ): void {
    if (
      live.sourceType !== STANDALONE_SESSION_SOURCE_TYPE ||
      live.sourceId !== undefined ||
      live.parentSessionId !== undefined ||
      durable.source.metadata.parentSessionId !== undefined ||
      live.worktree !== undefined ||
      live.branch !== undefined
    ) {
      throw serviceError('standalone_session_conflict', sessionId);
    }
  }

  private async closeLiveStandaloneIfPresent(
    runtime: WorkspaceRuntime,
    durable: Extract<StoredStandaloneState, { kind: 'standalone' }>,
    sessionId: string,
  ): Promise<void> {
    let live: BridgeSessionSummary;
    try {
      live = runtime.bridge.getSessionSummary(sessionId);
    } catch (error) {
      if (error instanceof SessionNotFoundError) return;
      throw error;
    }
    this.assertMatchingLiveStandalone(live, durable, sessionId);
    if (live.hasActivePrompt || live.clientCount > 0) {
      throw serviceError('session_busy', sessionId, true);
    }
    try {
      const closed = await runtime.bridge.killSession(sessionId, {
        requireZeroAttaches: true,
      });
      if (!closed) throw serviceError('session_busy', sessionId, true);
    } catch (error) {
      if (error instanceof StandaloneSessionServiceError) throw error;
      throw serviceError('session_busy', sessionId, true);
    }
    try {
      runtime.bridge.getSessionSummary(sessionId);
      throw serviceError('session_busy', sessionId, true);
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) throw error;
    }
    const directory = this.directoryStates.get(sessionId);
    if (directory) {
      this.directoryStates.set(sessionId, { pinned: directory.pinned });
    }
  }

  private batchError(sessionId: string, error: unknown): StandaloneBatchError {
    if (error instanceof StandaloneSessionServiceError) {
      return { sessionId, code: error.code, message: error.message };
    }
    const mapped = serviceError(
      'standalone_session_operation_failed',
      sessionId,
    );
    return { sessionId, code: mapped.code, message: mapped.message };
  }

  private async reconcileCatalogAfterLifecycleError(
    runtime: WorkspaceRuntime,
    sessionId: string,
    expectedLocation: 'active' | 'archived',
  ): Promise<void> {
    try {
      const durable = await this.inspectStoredStandalone(runtime, sessionId);
      if (
        durable.kind !== 'standalone' ||
        durable.location !== expectedLocation
      ) {
        return;
      }
      runtime.bridge.markSessionCatalogChanged();
      this.options.invalidateSessionListCache(runtime);
    } catch {
      return;
    }
  }

  private async archiveMany(
    sessionIds: string[],
  ): Promise<ArchiveStandaloneSessionsResult> {
    const result: ArchiveStandaloneSessionsResult = {
      archived: [],
      alreadyArchived: [],
      notFound: [],
      errors: [],
    };
    const runtime = await this.options.ensureRuntime();
    await this.options.runRuntimeActivity(runtime, async () => {
      await this.options.workspace.assertExactRoot(runtime.workspaceCwd);
      await this.reconcilePendingDeletions(runtime);
      for (const sessionId of sessionIds) {
        try {
          const outcome = await this.options.lifecycle.runExclusiveAfterShared(
            sessionId,
            async () => {
              await this.reconcileDeletionUnderExclusive(runtime, sessionId);
              const durable = await this.requireTopLevelStoredStandalone(
                runtime,
                sessionId,
              );
              if (durable.location === 'archived') return 'alreadyArchived';
              await this.closeLiveStandaloneIfPresent(
                runtime,
                durable,
                sessionId,
              );
              return runWithWorkspaceRuntimeStorage(runtime, async () => {
                const service = createWorkspaceRuntimeSessionService(runtime);
                const lease = await this.acquireLifecycleLease(
                  service,
                  durable.storageSessionId,
                );
                let archiveOutcome: 'archived' | 'alreadyArchived';
                try {
                  const locked = await this.requireTopLevelStoredStandalone(
                    runtime,
                    sessionId,
                  );
                  if (locked.location === 'archived') {
                    archiveOutcome = 'alreadyArchived';
                  } else {
                    await lease.assertOwnedAndUnchanged();
                    const archived = await service.archiveSessions(
                      [locked.storageSessionId],
                      {
                        knownLocation: 'active',
                        resolveConflicts: false,
                        assertStorageUnchanged: () =>
                          lease.assertOwnedAndUnchanged(),
                        assertCanMutate: () =>
                          this.options.assertRuntimeCurrent(runtime),
                        assertCleanupOwned: () => {
                          this.options.assertRuntimeCurrent(runtime);
                          lease.assertCleanupOwned();
                        },
                      },
                    );
                    if (archived.errors[0]) throw archived.errors[0].error;
                    archiveOutcome =
                      archived.archived.length > 0
                        ? 'archived'
                        : 'alreadyArchived';
                  }
                } catch (error) {
                  await this.releaseLifecycleLease(
                    lease,
                    durable.storageSessionId,
                  );
                  throw error;
                }
                if (
                  !(await this.releaseLifecycleLease(
                    lease,
                    durable.storageSessionId,
                  ))
                ) {
                  throw new SessionWriterUnavailableError();
                }
                return archiveOutcome;
              });
            },
          );
          result[outcome].push(sessionId);
          runtime.bridge.markSessionCatalogChanged();
          this.options.invalidateSessionListCache(runtime);
        } catch (error) {
          await this.reconcileCatalogAfterLifecycleError(
            runtime,
            sessionId,
            'archived',
          );
          if (
            error instanceof StandaloneSessionServiceError &&
            error.code === 'standalone_session_not_found'
          ) {
            result.notFound.push(sessionId);
          } else {
            result.errors.push(this.batchError(sessionId, error));
          }
        }
      }
    });
    return result;
  }

  private async unarchiveMany(
    sessionIds: string[],
  ): Promise<UnarchiveStandaloneSessionsResult> {
    const result: UnarchiveStandaloneSessionsResult = {
      unarchived: [],
      alreadyActive: [],
      notFound: [],
      errors: [],
    };
    const runtime = await this.options.ensureRuntime();
    await this.options.runRuntimeActivity(runtime, async () => {
      await this.options.workspace.assertExactRoot(runtime.workspaceCwd);
      await this.reconcilePendingDeletions(runtime);
      for (const sessionId of sessionIds) {
        try {
          const outcome = await this.options.lifecycle.runExclusiveAfterShared(
            sessionId,
            async () => {
              await this.reconcileDeletionUnderExclusive(runtime, sessionId);
              const durable = await this.requireTopLevelStoredStandalone(
                runtime,
                sessionId,
              );
              if (durable.location === 'active') return 'alreadyActive';
              try {
                runtime.bridge.getSessionSummary(sessionId);
                throw serviceError('standalone_session_conflict', sessionId);
              } catch (error) {
                if (!(error instanceof SessionNotFoundError)) throw error;
              }
              return runWithWorkspaceRuntimeStorage(runtime, async () => {
                const service = createWorkspaceRuntimeSessionService(runtime);
                const lease = await this.acquireLifecycleLease(
                  service,
                  durable.storageSessionId,
                );
                let unarchiveOutcome: 'unarchived' | 'alreadyActive';
                try {
                  const locked = await this.requireTopLevelStoredStandalone(
                    runtime,
                    sessionId,
                  );
                  if (locked.location === 'active') {
                    unarchiveOutcome = 'alreadyActive';
                  } else {
                    await lease.assertOwnedAndUnchanged();
                    const unarchived = await service.unarchiveSessions(
                      [locked.storageSessionId],
                      {
                        knownLocation: 'archived',
                        resolveConflicts: false,
                        assertStorageUnchanged: () =>
                          lease.assertOwnedAndUnchanged(),
                        assertCanMutate: () =>
                          this.options.assertRuntimeCurrent(runtime),
                        assertCleanupOwned: () => {
                          this.options.assertRuntimeCurrent(runtime);
                          lease.assertCleanupOwned();
                        },
                      },
                    );
                    if (unarchived.errors[0]) throw unarchived.errors[0].error;
                    unarchiveOutcome =
                      unarchived.unarchived.length > 0
                        ? 'unarchived'
                        : 'alreadyActive';
                  }
                } catch (error) {
                  await this.releaseLifecycleLease(
                    lease,
                    durable.storageSessionId,
                  );
                  throw error;
                }
                if (
                  !(await this.releaseLifecycleLease(
                    lease,
                    durable.storageSessionId,
                  ))
                ) {
                  throw new SessionWriterUnavailableError();
                }
                return unarchiveOutcome;
              });
            },
          );
          result[outcome].push(sessionId);
          runtime.bridge.markSessionCatalogChanged();
          this.options.invalidateSessionListCache(runtime);
        } catch (error) {
          await this.reconcileCatalogAfterLifecycleError(
            runtime,
            sessionId,
            'active',
          );
          if (
            error instanceof StandaloneSessionServiceError &&
            error.code === 'standalone_session_not_found'
          ) {
            result.notFound.push(sessionId);
          } else {
            result.errors.push(this.batchError(sessionId, error));
          }
        }
      }
    });
    return result;
  }

  private async deleteMany(
    sessionIds: string[],
  ): Promise<DeleteStandaloneSessionsResult> {
    const result: DeleteStandaloneSessionsResult = {
      removed: [],
      notFound: [],
      errors: [],
      fileCleanupPending: [],
    };
    const runtime = await this.options.ensureRuntime();
    await this.options.runRuntimeActivity(runtime, async () => {
      await this.options.workspace.assertExactRoot(runtime.workspaceCwd);
      await this.reconcilePendingDeletions(runtime);
      for (const sessionId of sessionIds) {
        try {
          const outcome = await this.options.lifecycle.runExclusiveAfterShared(
            sessionId,
            () => this.deleteUnderExclusive(runtime, sessionId),
          );
          if (outcome === 'notFound') {
            result.notFound.push(sessionId);
          } else {
            result.removed.push(sessionId);
            if (outcome === 'cleanupPending') {
              result.fileCleanupPending.push(sessionId);
            }
          }
        } catch (error) {
          if (
            error instanceof StandaloneSessionServiceError &&
            error.code === 'standalone_session_not_found'
          ) {
            result.notFound.push(sessionId);
          } else {
            result.errors.push(this.batchError(sessionId, error));
          }
        }
      }
    });
    return result;
  }

  private async deleteUnderExclusive(
    runtime: WorkspaceRuntime,
    sessionId: string,
  ): Promise<'removed' | 'cleanupPending' | 'notFound'> {
    const recovered = await this.reconcileDeletionUnderExclusive(
      runtime,
      sessionId,
      true,
    );
    if (recovered === 'committed') return 'removed';
    if (recovered === 'cleanup-pending') return 'cleanupPending';
    let durable: Extract<StoredStandaloneState, { kind: 'standalone' }>;
    try {
      durable = await this.requireTopLevelStoredStandalone(runtime, sessionId);
    } catch (error) {
      if (
        error instanceof StandaloneSessionServiceError &&
        error.code === 'standalone_session_not_found'
      ) {
        return 'notFound';
      }
      throw error;
    }
    if (await this.options.hasForeignSessionOwner(runtime, sessionId)) {
      throw serviceError('standalone_session_conflict', sessionId);
    }
    await this.closeLiveStandaloneIfPresent(runtime, durable, sessionId);
    const root = await this.options.workspace.assertExactRoot(
      runtime.workspaceCwd,
    );

    return runWithWorkspaceRuntimeStorage(runtime, async () => {
      const service = createWorkspaceRuntimeSessionService(runtime);
      const lease = await this.acquireLifecycleLease(
        service,
        durable.storageSessionId,
      );
      let transcriptCommitted = false;
      let directoryWasStaged = false;
      let cleanupPending = false;
      let leaseReleased = false;
      try {
        const locked = await this.requireTopLevelStoredStandalone(
          runtime,
          sessionId,
        );
        if (
          locked.storageSessionId !== durable.storageSessionId ||
          locked.location !== durable.location
        ) {
          throw serviceError('standalone_session_conflict', sessionId);
        }
        await lease.assertOwnedAndUnchanged();
        const transcriptParent =
          await service.getSessionTranscriptParentIdentityForLifecycle(
            locked.location,
          );
        const pinned = this.directoryStates.get(sessionId)?.pinned;
        const paths =
          await this.options.workspace.inspectStandaloneDeletionPaths(
            sessionId,
            pinned,
          );
        if (paths.status === 'compromised' || paths.status === 'staged') {
          throw serviceError('working_directory_compromised', sessionId);
        }
        const directory: StandaloneDeletionRecordV2['directory'] =
          paths.status === 'normal'
            ? {
                kind: 'present',
                normalName: paths.identity.name,
                stagedName: `${paths.identity.name}.deleting`,
                device: paths.identity.device,
                inode: paths.identity.inode,
                inodeVerifiable: paths.identity.inode !== 0,
              }
            : { kind: 'absent' };
        const prepared: StandaloneDeletionRecordV2 = {
          version: 2,
          phase: 'prepared',
          sessionId,
          storageSessionId: locked.storageSessionId,
          transcriptLocation: locked.location,
          transcriptParent,
          root: {
            canonicalPath: root.canonicalRoot,
            device: root.device,
            inode: root.inode,
            inodeVerifiable: root.inodeVerifiable,
          },
          directory,
        };
        await this.options.deletionJournal.writePrepared(prepared, root);
        if (paths.status === 'normal') {
          try {
            await this.options.workspace.stageStandaloneDirectory(
              sessionId,
              paths.identity,
            );
            directoryWasStaged = true;
            await this.options.deletionJournal.writeStaged(
              { ...prepared, phase: 'staged' },
              root,
            );
          } catch (error) {
            await this.rollbackPreparedDeletion(
              sessionId,
              root,
              paths.identity,
            );
            throw error;
          }
        }

        try {
          transcriptCommitted =
            await service.removeSessionTranscriptForLifecycle(
              locked.storageSessionId,
              locked.location,
              prepared.transcriptParent,
              {
                assertStorageUnchanged: () => lease.assertOwnedAndUnchanged(),
                assertCanMutate: () =>
                  this.options.assertRuntimeCurrent(runtime),
              },
            );
        } catch (error) {
          if (error instanceof SessionTranscriptDurabilityError) {
            throw serviceError(
              'transcript_deletion_outcome_unknown',
              sessionId,
            );
          }
          let physical: SessionArchiveState | 'conflict' | undefined;
          try {
            physical = await service.getSessionTranscriptLocationForLifecycle(
              locked.storageSessionId,
            );
          } catch {
            throw serviceError(
              'transcript_deletion_outcome_unknown',
              sessionId,
            );
          }
          if (physical === locked.location) {
            await this.rollbackPreparedDeletion(
              sessionId,
              root,
              paths.status === 'normal' ? paths.identity : undefined,
            );
            throw serviceError('transcript_deletion_failed', sessionId, true);
          }
          if (physical === undefined) {
            try {
              await service.confirmSessionTranscriptDeletionForLifecycle(
                locked.location,
                prepared.transcriptParent,
              );
            } catch {
              throw serviceError(
                'transcript_deletion_outcome_unknown',
                sessionId,
              );
            }
            transcriptCommitted = true;
          } else {
            throw serviceError(
              'transcript_deletion_outcome_unknown',
              sessionId,
            );
          }
        }
        if (!transcriptCommitted) {
          let physical: SessionArchiveState | 'conflict' | undefined;
          try {
            physical = await service.getSessionTranscriptLocationForLifecycle(
              locked.storageSessionId,
            );
          } catch {
            throw serviceError(
              'transcript_deletion_outcome_unknown',
              sessionId,
            );
          }
          if (physical === undefined) {
            try {
              await service.confirmSessionTranscriptDeletionForLifecycle(
                locked.location,
                prepared.transcriptParent,
              );
            } catch {
              throw serviceError(
                'transcript_deletion_outcome_unknown',
                sessionId,
              );
            }
            transcriptCommitted = true;
          } else if (physical === locked.location) {
            await this.rollbackPreparedDeletion(
              sessionId,
              root,
              paths.status === 'normal' ? paths.identity : undefined,
            );
            throw serviceError('transcript_deletion_failed', sessionId, true);
          } else {
            throw serviceError(
              'transcript_deletion_outcome_unknown',
              sessionId,
            );
          }
        }

        let cleanupOwnershipLost = false;
        try {
          await service.cleanupRemovedSessionStateForLifecycle(
            locked.storageSessionId,
            {
              assertCanMutate: () => this.options.assertRuntimeCurrent(runtime),
              assertCleanupOwned: () => {
                this.options.assertRuntimeCurrent(runtime);
                lease.assertCleanupOwned();
              },
            },
          );
        } catch (error) {
          cleanupPending = true;
          cleanupOwnershipLost =
            error instanceof SessionWriterError ||
            error instanceof ConversationRuntimeOwnershipError;
        }
        if (!cleanupOwnershipLost) {
          try {
            await runtime.bridge.deleteSessionAttachments(sessionId, {
              assertCanCommit: () => this.options.assertRuntimeCurrent(runtime),
            });
          } catch {
            cleanupPending = true;
          }
          if (directoryWasStaged && paths.status === 'normal') {
            try {
              await this.options.workspace.removeStagedStandaloneDirectory(
                sessionId,
                paths.identity,
              );
            } catch {
              cleanupPending = true;
            }
          }
        }
        if (
          !(await this.releaseLifecycleLease(lease, durable.storageSessionId))
        ) {
          cleanupPending = true;
        }
        leaseReleased = true;
        if (!cleanupPending) {
          try {
            await this.options.deletionJournal.clear(sessionId, root);
          } catch {
            cleanupPending = true;
          }
        }
        this.directoryStates.delete(sessionId);
        runtime.bridge.markSessionCatalogChanged();
        this.options.invalidateSessionListCache(runtime);
        return cleanupPending ? 'cleanupPending' : 'removed';
      } finally {
        if (!leaseReleased) {
          await this.releaseLifecycleLease(lease, durable.storageSessionId);
        }
      }
    });
  }

  private async rollbackPreparedDeletion(
    sessionId: string,
    root: ConversationDirectoryIdentity['root'],
    expected?: ConversationDirectoryIdentity,
  ): Promise<void> {
    try {
      if (expected) {
        const paths =
          await this.options.workspace.inspectStandaloneDeletionPaths(
            sessionId,
            expected,
          );
        if (paths.status === 'staged') {
          await this.options.workspace.restoreStagedStandaloneDirectory(
            sessionId,
            expected,
          );
        } else if (paths.status !== 'normal') {
          throw serviceError('deletion_recovery_compromised', sessionId);
        }
      }
      await this.options.workspace.confirmStandaloneRootDurability(root);
      await this.options.deletionJournal.clear(sessionId, root);
    } catch (error) {
      if (error instanceof StandaloneSessionServiceError) throw error;
      throw serviceError('working_directory_recovery_failed', sessionId, true);
    }
  }

  private async restore(
    action: 'load' | 'resume',
    rawSessionId: string,
    options: RestoreStandaloneSessionOptions,
    requiredPersistence: 'any' | 'legacy' = 'any',
    requiredScope: 'top-level' | 'any' = 'top-level',
  ): Promise<RestoredStandaloneSession> {
    const { sessionId } = parseRequiredSessionId(rawSessionId);
    const runtime = await this.options.ensureRuntime();
    let reservation: { release(): void } | undefined;
    try {
      return await this.options.runRuntimeActivity(runtime, async () => {
        this.options.assertRuntimeCurrent(runtime);
        await this.options.workspace.assertExactRoot(runtime.workspaceCwd);
        this.options.assertRuntimeCurrent(runtime);
        await this.reconcilePendingDeletions(runtime);
        this.options.assertRuntimeCurrent(runtime);
        reservation = this.options.requestedSessionIdAdmission.reserveRestore(
          sessionId,
          {
            bridge: runtime.bridge,
            workspaceCwd: runtime.workspaceCwd,
            workspaceId: runtime.workspaceId,
          },
        );
        this.options.assertRuntimeCurrent(runtime);
        return this.options.lifecycle.runExclusiveAfterShared(
          sessionId,
          async () => {
            await this.reconcileDeletionUnderExclusive(runtime, sessionId);
            const durable = await this.assertActiveStandaloneSession(
              runtime,
              sessionId,
              requiredPersistence,
              requiredScope,
            );

            let existing: BridgeSessionSummary | undefined;
            let existingEpoch: string | undefined;
            let existingCurrentCwd: string | undefined;
            try {
              existing = runtime.bridge.getSessionSummary(sessionId);
              this.options.assertRuntimeCurrent(runtime);
              existingEpoch = runtime.bridge.getSessionEventEpoch(sessionId);
              this.options.assertRuntimeCurrent(runtime);
              existingCurrentCwd =
                runtime.bridge.getSessionCurrentCwd(sessionId);
              this.options.assertRuntimeCurrent(runtime);
            } catch (error) {
              if (!(error instanceof SessionNotFoundError)) throw error;
              if (existing) this.beginTerminalQuarantine(runtime);
            }
            const existingIsLegacyStandalone =
              existing !== undefined &&
              requiredPersistence === 'legacy' &&
              existing.sourceId === undefined &&
              (existing.sourceType === undefined ||
                existing.sourceType === 'default') &&
              normalizeSessionIdForLookup(existing.parentSessionId ?? '') ===
                normalizeSessionIdForLookup(
                  durable.source.metadata.parentSessionId ?? '',
                ) &&
              existing.worktree === undefined &&
              existing.branch === undefined;
            if (existing && existingIsLegacyStandalone) {
              if (existing.hasActivePrompt || existing.clientCount > 0) {
                throw serviceError('session_busy', sessionId, true);
              }
              try {
                const closed = await runtime.bridge.killSession(sessionId, {
                  requireZeroAttaches: true,
                });
                this.options.assertRuntimeCurrent(runtime);
                if (!closed) {
                  throw serviceError('session_busy', sessionId, true);
                }
              } catch (error) {
                if (error instanceof StandaloneSessionServiceError) throw error;
                throw serviceError('session_busy', sessionId, true);
              }
              existing = undefined;
              existingEpoch = undefined;
              existingCurrentCwd = undefined;
            }
            if (
              existing &&
              (existing.sourceType !== STANDALONE_SESSION_SOURCE_TYPE ||
                existing.sourceId !== undefined ||
                normalizeSessionIdForLookup(existing.parentSessionId ?? '') !==
                  normalizeSessionIdForLookup(
                    durable.source.metadata.parentSessionId ?? '',
                  ) ||
                existing.worktree !== undefined ||
                existing.branch !== undefined)
            ) {
              throw serviceError('standalone_session_conflict', sessionId);
            }
            const prepared = await this.prepareRestoreDirectory(
              sessionId,
              async () => {
                if (!existing) return;
                if (existing.hasActivePrompt || existing.clientCount > 0) {
                  throw serviceError('session_busy', sessionId, true);
                }
                try {
                  const closed = await runtime.bridge.killSession(sessionId, {
                    requireZeroAttaches: true,
                  });
                  this.options.assertRuntimeCurrent(runtime);
                  if (!closed) {
                    throw serviceError('session_busy', sessionId, true);
                  }
                } catch (error) {
                  if (error instanceof StandaloneSessionServiceError) {
                    throw error;
                  }
                  throw serviceError('session_busy', sessionId, true);
                }
                existing = undefined;
                existingEpoch = undefined;
                existingCurrentCwd = undefined;
              },
            );
            this.options.assertRuntimeCurrent(runtime);
            const reusableBeforeAttach =
              existingEpoch !== undefined &&
              this.isReusableBinding(
                sessionId,
                prepared.identity,
                existingEpoch,
              ) &&
              existingCurrentCwd !== undefined &&
              isSameConversationPath(
                existingCurrentCwd,
                prepared.identity.canonicalPath,
              );
            if (existing?.hasActivePrompt && !reusableBeforeAttach) {
              throw serviceError('session_busy', sessionId, true);
            }

            this.options.assertRuntimeCurrent(runtime);
            const request: BridgeStandaloneRestoreSessionRequest = {
              sessionId,
              workspaceCwd: runtime.workspaceCwd,
              ...(durable.source.metadata.parentSessionId !== undefined
                ? {
                    parentSessionId: normalizeSessionIdForLookup(
                      durable.source.metadata.parentSessionId,
                    ),
                  }
                : {}),
              ...(options.clientId !== undefined
                ? { clientId: options.clientId }
                : {}),
              ...(action === 'load' && options.historyPageSize !== undefined
                ? { historyPageSize: options.historyPageSize }
                : {}),
              ...(action === 'load' && options.liveReplayMode !== undefined
                ? { liveReplayMode: options.liveReplayMode }
                : {}),
              ...(options.hideInheritedHistory !== undefined
                ? { hideInheritedHistory: options.hideInheritedHistory }
                : {}),
              ...(options.approvalMode !== undefined
                ? { approvalMode: options.approvalMode }
                : {}),
              ...(action === 'load' ? { historyReplay: 'response' } : {}),
            };
            const restored = await runtime.bridge.restoreStandaloneSession(
              action,
              request,
            );
            this.assertRuntimeCurrentOrQuarantine(runtime);
            if (
              restored.sessionId !== sessionId ||
              restored.sourceType !== STANDALONE_SESSION_SOURCE_TYPE ||
              restored.sourceId !== undefined ||
              restored.worktree !== undefined ||
              restored.branch !== undefined ||
              (existing === undefined && restored.attached) ||
              (existing !== undefined && !restored.attached)
            ) {
              await this.discardUntrustedSpawnResult(runtime.bridge, restored);
              this.beginTerminalQuarantine(runtime);
            }
            let restoredSummary: BridgeSessionSummary;
            try {
              restoredSummary = runtime.bridge.getSessionSummary(sessionId);
            } catch {
              await this.discardRestoreResult(runtime, sessionId, restored);
              this.beginTerminalQuarantine(runtime);
            }
            const expectedParent = durable.source.metadata.parentSessionId;
            if (
              restoredSummary.sourceType !== STANDALONE_SESSION_SOURCE_TYPE ||
              restoredSummary.sourceId !== undefined ||
              normalizeSessionIdForLookup(
                restoredSummary.parentSessionId ?? '',
              ) !== normalizeSessionIdForLookup(expectedParent ?? '') ||
              restoredSummary.worktree !== undefined ||
              restoredSummary.branch !== undefined
            ) {
              await this.discardRestoreResult(runtime, sessionId, restored);
              this.beginTerminalQuarantine(runtime);
            }
            this.options.assertRuntimeCurrent(runtime);
            const eventEpoch = runtime.bridge.getSessionEventEpoch(sessionId);
            if (existingEpoch !== undefined && existingEpoch !== eventEpoch) {
              await this.discardRestoreResult(runtime, sessionId, restored);
              this.beginTerminalQuarantine(runtime);
            }

            const canReuse =
              restored.attached &&
              this.isReusableBinding(
                sessionId,
                prepared.identity,
                eventEpoch,
              ) &&
              restored.currentCwd !== undefined &&
              isSameConversationPath(
                restored.currentCwd,
                prepared.identity.canonicalPath,
              );
            if (canReuse) {
              try {
                await this.assertPinnedDirectory(sessionId, prepared.identity);
              } catch (error) {
                await this.discardRestoreResult(runtime, sessionId, restored);
                throw error;
              }
            } else {
              if (restored.hasActivePrompt) {
                await this.discardRestoreResult(runtime, sessionId, restored);
                throw serviceError('session_busy', sessionId, true);
              }
              try {
                this.options.assertRuntimeCurrent(runtime);
                await this.bindAndRelease(
                  runtime,
                  sessionId,
                  prepared.identity,
                );
                restored.currentCwd = prepared.identity.canonicalPath;
              } catch (error) {
                if (error instanceof TerminalQuarantineSignal) throw error;
                await this.discardRestoreResult(runtime, sessionId, restored);
                if (error instanceof StandaloneSessionServiceError) {
                  throw error;
                }
                if (error instanceof CdWhilePromptActiveError) {
                  throw serviceError('session_busy', sessionId, true);
                }
                throw serviceError('working_directory_compromised', sessionId);
              }
            }
            this.options.assertRuntimeCurrent(runtime);
            const response: RestoredStandaloneSession = {
              ...restored,
              sessionId,
              workspaceCwd: runtime.workspaceCwd,
              currentCwd: prepared.identity.canonicalPath,
              sourceType: STANDALONE_SESSION_SOURCE_TYPE,
              context: { kind: 'standalone' },
              projectlessOutputDirectory: prepared.identity.canonicalPath,
              workingDirectory: {
                state: prepared.state,
                ...(prepared.state === 'recreated'
                  ? {
                      warnings: [
                        'The previous standalone working directory was missing and was recreated; its files could not be recovered.',
                      ],
                    }
                  : {}),
              },
            };
            this.responseRestoreRuntimes.set(response, runtime);
            return response;
          },
        );
      });
    } catch (error) {
      if (error instanceof TerminalQuarantineSignal) {
        await error.completion.catch(() => undefined);
        throw serviceError('standalone_session_conflict', sessionId);
      }
      if (error instanceof SessionIdCaseConflictError) {
        if (requiredPersistence === 'legacy') throw error;
        throw serviceError('standalone_session_conflict', sessionId);
      }
      throw error;
    } finally {
      reservation?.release();
    }
  }

  async createWithInitialPrompt(
    request: CreateStandaloneSessionRequest,
    prompt: string,
  ): Promise<CreatedStandaloneSession> {
    const created = await this.createInternal(request, prompt);
    return {
      session: created.session,
      projectlessOutputDirectory: created.projectlessOutputDirectory,
      workingDirectory: created.workingDirectory,
    };
  }

  create(
    request: CreateStandaloneSessionRequest,
  ): Promise<CreatedStandaloneSession> {
    return this.createInternal(request);
  }

  async createChildWithInitialPrompt(
    request: CreateStandaloneChildSessionRequest,
    prompt: string,
  ): Promise<CreatedStandaloneChildSession> {
    const { sessionId: parentSessionId } = parseRequiredSessionId(
      request.parentSessionId,
    );
    if (parentSessionId === normalizeSessionIdForLookup(request.sessionId)) {
      throw serviceError('standalone_session_conflict', parentSessionId);
    }
    const created = await this.createInternal(
      request,
      prompt,
      parentSessionId,
      request.promptId,
    );
    if (!created.initialPrompt) {
      throw serviceError(
        'standalone_creation_outcome_unknown',
        normalizeSessionIdForLookup(request.sessionId),
      );
    }
    return { ...created, initialPrompt: created.initialPrompt };
  }

  private async createInternal(
    request: CreateStandaloneSessionRequest,
    prompt?: string,
    parentSessionId?: string,
    promptId: string = randomUUID(),
  ): Promise<CreatedStandaloneSessionInternal> {
    const { sessionId } = parseRequiredSessionId(request.sessionId);
    let entry: CreatingEntry | undefined;
    try {
      const runtime = await this.options.ensureRuntime();
      return await this.options.runRuntimeActivity(runtime, async () => {
        this.options.assertRuntimeCurrent(runtime);
        await this.options.workspace.assertExactRoot(runtime.workspaceCwd);
        this.options.assertRuntimeCurrent(runtime);
        await this.reconcilePendingDeletions(runtime);
        this.options.assertRuntimeCurrent(runtime);
        const creatingEntry = this.insertCreating(
          sessionId,
          runtime,
          parentSessionId === undefined ? 'top-level' : 'child',
        );
        entry = creatingEntry;
        creatingEntry.reservation =
          await this.options.requestedSessionIdAdmission.reserveCreate(
            sessionId,
            {
              bridge: runtime.bridge,
              workspaceCwd: runtime.workspaceCwd,
              workspaceId: runtime.workspaceId,
            },
          );
        this.options.assertRuntimeCurrent(runtime);
        const create = async (persistedParentSessionId?: string) => {
          const created = await this.options.lifecycle.runExclusiveAfterShared(
            sessionId,
            () =>
              this.createUnderExclusive(
                runtime,
                sessionId,
                request,
                prompt,
                promptId,
                persistedParentSessionId,
              ),
          );
          this.responseCreateRuntimes.set(created, runtime);
          return created;
        };
        if (parentSessionId === undefined) return create();
        return this.options.lifecycle.runSharedMany(
          [parentSessionId],
          async () => {
            const persistedParentSessionId =
              await this.assertCwdReadyUnderShared(runtime, parentSessionId);
            const parent = runtime.bridge.getSessionSummary(parentSessionId);
            if (
              parent.sourceType !== STANDALONE_SESSION_SOURCE_TYPE ||
              parent.sourceId !== undefined ||
              parent.parentSessionId !== undefined
            ) {
              throw serviceError(
                'standalone_session_conflict',
                parentSessionId,
              );
            }
            return create(persistedParentSessionId);
          },
        );
      });
    } catch (error) {
      if (error instanceof TerminalQuarantineSignal) {
        await error.completion.catch(() => undefined);
        throw serviceError('standalone_creation_outcome_unknown', sessionId);
      }
      throw error;
    } finally {
      const ownedEntry = entry;
      if (
        ownedEntry &&
        ownedEntry.state !== 'quarantine-frozen' &&
        this.creating.get(sessionId) === ownedEntry
      ) {
        this.creating.delete(sessionId);
        ownedEntry.reservation?.release();
      }
    }
  }

  private insertCreating(
    canonicalSessionId: string,
    runtime: WorkspaceRuntime,
    scope: 'top-level' | 'child',
  ): CreatingEntry {
    if (this.terminal) {
      this.options.assertRuntimeCurrent(runtime);
      throw serviceError(
        'standalone_creation_outcome_unknown',
        canonicalSessionId,
      );
    }
    if (this.creating.has(canonicalSessionId)) {
      throw serviceError(
        'standalone_session_conflict',
        canonicalSessionId,
        true,
      );
    }
    const entry: CreatingEntry = {
      canonicalSessionId,
      runtime,
      scope,
      state: 'running',
    };
    this.creating.set(canonicalSessionId, entry);
    return entry;
  }

  private async createUnderExclusive(
    runtime: WorkspaceRuntime,
    sessionId: string,
    request: CreateStandaloneSessionRequest,
    prompt: string | undefined,
    promptId: string,
    parentSessionId?: string,
  ): Promise<CreatedStandaloneSessionInternal> {
    this.options.assertRuntimeCurrent(runtime);
    await this.reconcileDeletionUnderExclusive(runtime, sessionId);
    this.options.assertRuntimeCurrent(runtime);
    await this.assertPersistedSessionAbsent(runtime, sessionId);
    this.options.assertRuntimeCurrent(runtime);
    const prepared =
      await this.options.workspace.prepareStandaloneDirectory(sessionId);
    this.options.assertRuntimeCurrent(runtime);
    this.directoryStates.set(sessionId, { pinned: prepared.identity });

    let session: BridgeSession;
    try {
      session = await runtime.bridge.spawnStandaloneSession({
        workspaceCwd: runtime.workspaceCwd,
        sessionId,
        ...(parentSessionId !== undefined ? { parentSessionId } : {}),
        ...(request.modelServiceId !== undefined
          ? { modelServiceId: request.modelServiceId }
          : {}),
        ...(request.approvalMode !== undefined
          ? { approvalMode: request.approvalMode }
          : {}),
      });
    } catch (error) {
      if (error instanceof StandaloneSessionSpawnError && !error.dispatched) {
        try {
          await this.assertPersistedSessionAbsent(runtime, sessionId);
        } catch {
          this.beginTerminalQuarantine(runtime);
        }
        throw serviceError('standalone_creation_rolled_back', sessionId, true);
      }
      this.beginTerminalQuarantine(runtime);
    }
    this.assertRuntimeCurrentOrQuarantine(runtime);
    if (
      session.attached ||
      session.sessionId !== sessionId ||
      session.sourceType !== STANDALONE_SESSION_SOURCE_TYPE ||
      session.sourceId !== undefined ||
      session.worktree !== undefined ||
      session.branch !== undefined ||
      (parentSessionId === undefined
        ? session.parentSessionPersisted !== undefined
        : session.parentSessionPersisted !== true)
    ) {
      await this.discardUntrustedSpawnResult(runtime.bridge, session);
      this.beginTerminalQuarantine(runtime);
    }
    if (session.sourcePersisted !== true) {
      await this.cleanRollbackBeforePersistence(runtime, sessionId);
      throw serviceError('standalone_creation_rolled_back', sessionId, true);
    }

    try {
      await this.assertDurableStandaloneSession(
        runtime,
        sessionId,
        parentSessionId,
      );
    } catch (error) {
      if (error instanceof TerminalQuarantineSignal) throw error;
      this.beginTerminalQuarantine(runtime);
    }
    this.assertRuntimeCurrentOrQuarantine(runtime);
    let initialPrompt:
      | CreatedStandaloneChildSession['initialPrompt']
      | undefined;
    try {
      await this.bindAndRelease(runtime, sessionId, prepared.identity);
      if (prompt !== undefined) {
        initialPrompt = await this.admitInitialPrompt(
          runtime.bridge,
          sessionId,
          prompt,
          promptId,
        );
      }
      this.assertRuntimeCurrentOrQuarantine(runtime);
    } catch (error) {
      if (error instanceof TerminalQuarantineSignal) throw error;
      await this.closeOwnedSessionOrQuarantine(runtime, sessionId);
      throw serviceError('standalone_creation_outcome_unknown', sessionId);
    }

    try {
      runtime.bridge.markSessionCatalogChanged();
      this.options.invalidateSessionListCache(runtime);
    } catch {
      // The durable session and admitted prompt are already committed.
    }
    return {
      session: {
        ...session,
        currentCwd: prepared.identity.canonicalPath,
      },
      projectlessOutputDirectory: prepared.identity.canonicalPath,
      workingDirectory: { state: 'ready' },
      ...(initialPrompt ? { initialPrompt } : {}),
    };
  }

  private async bindAndRelease(
    runtime: WorkspaceRuntime,
    sessionId: string,
    pinned: ConversationDirectoryIdentity,
  ): Promise<void> {
    const expectation = toBridgeExpectation(sessionId, pinned);
    const changed = await runtime.bridge.changeSessionCwd(sessionId, {
      path: pinned.canonicalPath,
      allowedRoots: [runtime.workspaceCwd],
      managedRelocation: 'live-conversation',
      conversationDirectoryExpectation: expectation,
    });
    this.assertRuntimeCurrentOrQuarantine(runtime);
    if (!isSameConversationPath(changed.newCwd, pinned.canonicalPath)) {
      throw serviceError('working_directory_compromised', sessionId);
    }
    await this.assertPinnedDirectory(sessionId, pinned);
    this.assertRuntimeCurrentOrQuarantine(runtime);
    const eventEpoch = runtime.bridge.getSessionEventEpoch(sessionId);
    this.assertRuntimeCurrentOrQuarantine(runtime);
    try {
      await runtime.bridge.commitManagedConversationBinding(
        sessionId,
        expectation,
      );
    } catch (error) {
      if (error instanceof TerminalQuarantineSignal) throw error;
      try {
        this.assertRuntimeCurrentOrQuarantine(runtime);
        await runtime.bridge.commitManagedConversationBinding(
          sessionId,
          expectation,
        );
      } catch (retryError) {
        if (retryError instanceof TerminalQuarantineSignal) throw retryError;
        this.beginTerminalQuarantine(runtime);
      }
    }
    this.assertRuntimeCurrentOrQuarantine(runtime);
    await this.assertPinnedDirectory(sessionId, pinned);
    this.assertRuntimeCurrentOrQuarantine(runtime);
    if (runtime.bridge.getSessionEventEpoch(sessionId) !== eventEpoch) {
      this.beginTerminalQuarantine(runtime);
    }
    this.directoryStates.set(sessionId, {
      pinned,
      agentBound: { eventEpoch, released: false },
    });
    try {
      this.assertRuntimeCurrentOrQuarantine(runtime);
      await runtime.bridge.releaseManagedConversationBinding(
        sessionId,
        expectation,
      );
    } catch (error) {
      if (error instanceof TerminalQuarantineSignal) throw error;
      try {
        this.assertRuntimeCurrentOrQuarantine(runtime);
        await runtime.bridge.releaseManagedConversationBinding(
          sessionId,
          expectation,
        );
      } catch (retryError) {
        if (retryError instanceof TerminalQuarantineSignal) throw retryError;
        this.directoryStates.set(sessionId, { pinned });
        this.beginTerminalQuarantine(runtime);
      }
    }
    this.assertRuntimeCurrentOrQuarantine(runtime);
    if (runtime.bridge.getSessionEventEpoch(sessionId) !== eventEpoch) {
      this.directoryStates.set(sessionId, { pinned });
      this.beginTerminalQuarantine(runtime);
    }
    this.directoryStates.set(sessionId, {
      pinned,
      agentBound: { eventEpoch, released: true },
    });
  }

  private async assertPinnedDirectory(
    sessionId: string,
    pinned: ConversationDirectoryIdentity,
  ): Promise<void> {
    const inspected = await this.options.workspace.inspectStandaloneDirectory(
      sessionId,
      pinned,
    );
    if (inspected.status === 'missing') {
      throw serviceError('working_directory_missing', sessionId);
    }
    if (inspected.status === 'compromised') {
      throw serviceError('working_directory_compromised', sessionId);
    }
  }

  private async assertPersistedSessionAbsent(
    runtime: WorkspaceRuntime,
    sessionId: string,
  ): Promise<void> {
    const existing = await runWithWorkspaceRuntimeStorage(runtime, () =>
      createWorkspaceRuntimeSessionService(runtime).findSessionIdIgnoringCase(
        sessionId,
      ),
    );
    if (existing !== undefined) {
      throw serviceError('standalone_session_conflict', sessionId);
    }
  }

  private async assertActiveStandaloneSession(
    runtime: WorkspaceRuntime,
    sessionId: string,
    requiredPersistence: 'any' | 'legacy' = 'any',
    requiredScope: 'top-level' | 'any' = 'top-level',
  ): Promise<{
    storageSessionId: string;
    source: LoadableConversationSession;
  }> {
    const result = await runWithWorkspaceRuntimeStorage(runtime, async () => {
      const service = createWorkspaceRuntimeSessionService(runtime);
      const storageSessionId =
        await service.findSessionIdIgnoringCase(sessionId);
      if (storageSessionId === undefined) return { kind: 'not-found' } as const;
      const location = await service.getSessionLocation(storageSessionId);
      if (location === 'conflict') return { kind: 'conflict' } as const;
      if (location !== 'active' && location !== 'archived') {
        return { kind: 'not-found' } as const;
      }
      const source = await readLoadableConversationSession(
        storageSessionId,
        service,
      );
      if (
        source?.kind !== 'standalone' ||
        (requiredPersistence === 'legacy' && source.persistence !== 'legacy') ||
        (requiredScope === 'top-level' &&
          source.metadata.parentSessionId !== undefined)
      ) {
        return { kind: 'not-found' } as const;
      }
      if (location === 'archived') return { kind: 'archived' } as const;
      return { kind: 'active', storageSessionId, source } as const;
    });
    if (result.kind === 'conflict') {
      throw serviceError('standalone_session_conflict', sessionId);
    }
    if (result.kind === 'archived') {
      throw serviceError('session_archived', sessionId);
    }
    if (result.kind !== 'active') {
      throw serviceError('standalone_session_not_found', sessionId);
    }
    return result;
  }

  private async prepareRestoreDirectory(
    sessionId: string,
    beforeRecreate?: () => Promise<void>,
  ): Promise<PreparedRestoreDirectory> {
    const previous = this.directoryStates.get(sessionId);
    const inspected = await this.options.workspace.inspectStandaloneDirectory(
      sessionId,
      previous?.pinned,
    );
    if (inspected.status === 'compromised') {
      throw serviceError('working_directory_compromised', sessionId);
    }
    if (inspected.status === 'ready') {
      if (!previous) {
        this.directoryStates.set(sessionId, { pinned: inspected.identity });
      }
      return { identity: inspected.identity, state: 'ready' };
    }

    await beforeRecreate?.();
    const ensured = await this.options.workspace.ensureStandaloneDirectory(
      sessionId,
      previous?.pinned,
    );
    if (ensured.status === 'compromised') {
      throw serviceError('working_directory_compromised', sessionId);
    }
    this.directoryStates.set(sessionId, { pinned: ensured.identity });
    return { identity: ensured.identity, state: 'recreated' };
  }

  private isReusableBinding(
    sessionId: string,
    pinned: ConversationDirectoryIdentity,
    eventEpoch: string,
  ): boolean {
    const state = this.directoryStates.get(sessionId);
    return (
      state !== undefined &&
      isSameDirectoryIdentity(state.pinned, pinned) &&
      state.agentBound?.released === true &&
      state.agentBound.eventEpoch === eventEpoch
    );
  }

  private async discardRestoreResult(
    runtime: WorkspaceRuntime,
    sessionId: string,
    session: BridgeRestoredSession,
  ): Promise<void> {
    const state = this.directoryStates.get(sessionId);
    if (state) this.directoryStates.set(sessionId, { pinned: state.pinned });
    try {
      this.options.assertRuntimeCurrent(runtime);
      if (session.attached) {
        await runtime.bridge.detachClient(session.sessionId, session.clientId);
        return;
      }
      const closed = await runtime.bridge.killSession(session.sessionId, {
        requireZeroAttaches: true,
      });
      if (closed) return;
    } catch (error) {
      if (error instanceof TerminalQuarantineSignal) throw error;
    }
    this.beginTerminalQuarantine(runtime);
  }

  private async readStandaloneSummary(
    runtime: WorkspaceRuntime,
    sessionId: string,
    requiredScope: 'top-level' | 'any',
  ): Promise<StandaloneSessionSummary> {
    const durable = await runWithWorkspaceRuntimeStorage(runtime, async () => {
      const service = createWorkspaceRuntimeSessionService(runtime);
      const storageSessionId =
        await service.findSessionIdIgnoringCase(sessionId);
      if (storageSessionId === undefined) return undefined;
      const location = await service.getSessionLocation(storageSessionId);
      if (location === 'conflict') {
        throw serviceError('standalone_session_conflict', sessionId);
      }
      if (location === undefined) return undefined;
      const source = await readLoadableConversationSession(
        storageSessionId,
        service,
      );
      if (source?.kind !== 'standalone') {
        return undefined;
      }
      if (
        requiredScope === 'top-level' &&
        source.metadata.parentSessionId !== undefined
      ) {
        return undefined;
      }
      const item = await service.getSessionListItem(storageSessionId, location);
      if (!item) return undefined;
      let prs: Awaited<ReturnType<typeof readSessionPrs>>;
      try {
        prs = await readSessionPrs(
          service.getPrSessionPathForArchiveState(storageSessionId, location),
        );
      } catch {
        prs = null;
      }
      return { item, location, source, prs };
    });
    if (!durable) {
      throw serviceError('standalone_session_not_found', sessionId);
    }
    if (durable.item.sessionId.toLowerCase() !== sessionId) {
      throw serviceError('standalone_session_conflict', sessionId);
    }
    const summary = toStandaloneSummary(
      durable.item,
      runtime.workspaceCwd,
      sessionId,
      durable.location === 'archived',
      durable.source,
    );
    return durable.prs
      ? {
          ...summary,
          prs: durable.prs.map(({ number, url }) => ({ number, url })),
        }
      : summary;
  }

  private async assertDurableStandaloneSession(
    runtime: WorkspaceRuntime,
    sessionId: string,
    parentSessionId?: string,
  ): Promise<void> {
    const durable = await runWithWorkspaceRuntimeStorage(runtime, async () => {
      const service = createWorkspaceRuntimeSessionService(runtime);
      const storageSessionId =
        await service.findSessionIdIgnoringCase(sessionId);
      if (storageSessionId !== sessionId) return undefined;
      const location = await service.getSessionLocation(storageSessionId);
      if (location !== 'active') return undefined;
      const metadata = await service.readCreationMetadataIfReadable(
        storageSessionId,
        'active',
      );
      return { metadata };
    });
    if (
      durable?.metadata?.sourceType !== STANDALONE_SESSION_SOURCE_TYPE ||
      durable.metadata.sourceId !== undefined ||
      normalizeSessionIdForLookup(durable.metadata.parentSessionId ?? '') !==
        normalizeSessionIdForLookup(parentSessionId ?? '')
    ) {
      this.beginTerminalQuarantine(runtime);
    }
  }

  private async cleanRollbackBeforePersistence(
    runtime: WorkspaceRuntime,
    sessionId: string,
  ): Promise<void> {
    try {
      await this.closeOwnedSessionOrQuarantine(runtime, sessionId);
      const absent = await runWithWorkspaceRuntimeStorage(runtime, async () => {
        const service = createWorkspaceRuntimeSessionService(runtime);
        const removed = await service.removeSession(sessionId);
        if (removed) runtime.bridge.markSessionCatalogChanged();
        return (
          (await service.findSessionIdIgnoringCase(sessionId)) === undefined
        );
      });
      if (!absent) this.beginTerminalQuarantine(runtime);
      this.options.invalidateSessionListCache(runtime);
    } catch (error) {
      if (error instanceof TerminalQuarantineSignal) throw error;
      this.beginTerminalQuarantine(runtime);
    }
  }

  private async closeOwnedSessionOrQuarantine(
    runtime: WorkspaceRuntime,
    sessionId: string,
  ): Promise<void> {
    try {
      const closed = await runtime.bridge.killSession(sessionId, {
        requireZeroAttaches: true,
      });
      if (closed) return;
    } catch {
      // Unknown close outcome requires terminal containment.
    }
    this.beginTerminalQuarantine(runtime);
  }

  private async discardUntrustedSpawnResult(
    bridge: AcpSessionBridge,
    session: BridgeSession,
  ): Promise<void> {
    try {
      if (session.attached) {
        await bridge.detachClient(session.sessionId, session.clientId);
      } else {
        await bridge.killSession(session.sessionId, {
          requireZeroAttaches: true,
        });
      }
    } catch {
      // Terminal quarantine below owns the unknown cleanup outcome.
    }
  }

  private async admitInitialPrompt(
    bridge: AcpSessionBridge,
    sessionId: string,
    prompt: string,
    promptId: string,
  ): Promise<CreatedStandaloneChildSession['initialPrompt']> {
    const lastEventId = bridge.getSessionLastEventId(sessionId);
    let resolveAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      resolveAdmission = resolve;
    });
    let admitted = false;
    const turn = bridge.sendPrompt(
      sessionId,
      { sessionId, prompt: [{ type: 'text', text: prompt }] },
      undefined,
      {
        promptId,
        onPromptAdmitted: () => {
          if (admitted) return;
          admitted = true;
          resolveAdmission();
        },
      },
    );
    void turn.then(resolveAdmission, resolveAdmission);
    await admission;
    if (!admitted) throw new Error('Initial prompt was not admitted');
    return { promptId, lastEventId, turn };
  }

  private beginTerminalQuarantine(runtime: WorkspaceRuntime): never {
    try {
      this.options.assertRuntimeCurrent(runtime);
    } catch (error) {
      this.freezeForTerminalQuarantine(runtime);
      throw new TerminalQuarantineSignal(Promise.reject(error));
    }
    let completion: Promise<void>;
    try {
      completion = this.options.quarantineRuntime(runtime);
    } catch (error) {
      this.freezeForTerminalQuarantine(runtime);
      completion = Promise.reject(error);
    }
    if (!this.terminal) this.freezeForTerminalQuarantine(runtime);
    throw new TerminalQuarantineSignal(completion);
  }

  private assertRuntimeCurrentOrQuarantine(runtime: WorkspaceRuntime): void {
    try {
      this.options.assertRuntimeCurrent(runtime);
    } catch (error) {
      this.freezeForTerminalQuarantine(runtime);
      throw new TerminalQuarantineSignal(Promise.reject(error));
    }
  }
}
