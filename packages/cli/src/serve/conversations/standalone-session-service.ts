/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  CdWhilePromptActiveError,
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
import { STANDALONE_SESSION_SOURCE_TYPE } from '@qwen-code/acp-bridge/sessionSource';
import {
  readSessionPrs,
  SessionIdCaseConflictError,
  type ApprovalMode,
  type SessionArchiveState,
  type SessionListItem,
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
  isSameConversationPath,
  type ConversationDirectoryIdentity,
} from '../../utils/conversation-directory-identity.js';
import type { RequestedSessionIdAdmission } from '../session-id-admission.js';
import type { SessionArchiveCoordinator } from '../server/session-archive.js';
import { listWorkspaceSessionsForResponse } from '../server/session-list.js';
import {
  createWorkspaceRuntimeSessionService,
  runWithWorkspaceRuntimeStorage,
} from '../workspace-runtime-storage.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import type { ConversationWorkspace } from './conversation-workspace.js';

export type StandaloneSessionServiceErrorCode =
  | 'invalid_request'
  | 'standalone_session_not_found'
  | 'standalone_session_conflict'
  | 'session_archived'
  | 'session_busy'
  | 'standalone_creation_rolled_back'
  | 'standalone_creation_outcome_unknown'
  | 'working_directory_missing'
  | 'working_directory_compromised';

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

export interface CreatedStandaloneChildSession
  extends CreatedStandaloneSession {
  initialPrompt: {
    promptId: string;
    lastEventId: number;
    turn: ReturnType<AcpSessionBridge['sendPrompt']>;
  };
}

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
  >;
  lifecycle: SessionArchiveCoordinator;
  requestedSessionIdAdmission: RequestedSessionIdAdmission;
  invalidateSessionListCache(runtime: WorkspaceRuntime): void;
}

interface CreatingEntry {
  readonly canonicalSessionId: string;
  readonly runtime: WorkspaceRuntime;
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
  retryable = false,
): StandaloneSessionServiceError {
  const messages: Record<StandaloneSessionServiceErrorCode, string> = {
    invalid_request: 'The standalone session request is invalid.',
    standalone_session_not_found: 'The standalone session was not found.',
    standalone_session_conflict:
      'The standalone session id or durable state conflicts with an existing session.',
    session_archived: 'The standalone session is archived.',
    session_busy: 'The standalone session is busy.',
    standalone_creation_rolled_back:
      'Standalone session creation failed before durable source persistence and was rolled back.',
    standalone_creation_outcome_unknown:
      'Standalone session creation could not be safely completed or rolled back.',
    working_directory_missing: 'The standalone working directory is missing.',
    working_directory_compromised:
      'The standalone working directory identity is compromised.',
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
  private readonly creating = new Map<string, CreatingEntry>();
  private readonly directoryStates = new Map<string, DirectoryState>();
  private terminal = false;

  constructor(private readonly options: StandaloneSessionServiceOptions) {}

  freezeForTerminalQuarantine(runtime: WorkspaceRuntime): void {
    this.terminal = true;
    for (const entry of this.creating.values()) {
      if (entry.runtime === runtime) entry.state = 'quarantine-frozen';
    }
  }

  async get(rawSessionId: string): Promise<StandaloneSessionLookup> {
    const { sessionId } = parseRequiredSessionId(rawSessionId);
    if (this.creating.has(sessionId)) {
      return { sessionId, state: 'creating' };
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
          );
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
              normalizeSessionIdForLookup(persisted.parentSessionId ?? '')
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
      return {
        sessions: [...byCanonicalId.values()],
        ...(result.nextCursor !== undefined
          ? { nextCursor: result.nextCursor }
          : {}),
        ...(result.liveMergeFailed ? { liveMergeFailed: true } : {}),
        ...(result.truncated ? { truncated: true } : {}),
      };
    });
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

  restoreLegacyForCompatibility(
    action: 'load' | 'resume',
    rawSessionId: string,
    options: RestoreStandaloneSessionOptions = {},
  ): Promise<RestoredStandaloneSession> {
    return this.restore(action, rawSessionId, options, 'legacy');
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

  private async restore(
    action: 'load' | 'resume',
    rawSessionId: string,
    options: RestoreStandaloneSessionOptions,
    requiredPersistence: 'any' | 'legacy' = 'any',
  ): Promise<RestoredStandaloneSession> {
    const { sessionId } = parseRequiredSessionId(rawSessionId);
    const runtime = await this.options.ensureRuntime();
    let reservation: { release(): void } | undefined;
    try {
      return await this.options.runRuntimeActivity(runtime, async () => {
        this.options.assertRuntimeCurrent(runtime);
        await this.options.workspace.assertExactRoot(runtime.workspaceCwd);
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
            const durable = await this.assertActiveStandaloneSession(
              runtime,
              sessionId,
              requiredPersistence,
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
            return {
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
    const created = await this.createWithInitialPromptInternal(request, prompt);
    return {
      session: created.session,
      projectlessOutputDirectory: created.projectlessOutputDirectory,
      workingDirectory: created.workingDirectory,
    };
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
    return this.createWithInitialPromptInternal(
      request,
      prompt,
      parentSessionId,
      request.promptId,
    );
  }

  private async createWithInitialPromptInternal(
    request: CreateStandaloneSessionRequest,
    prompt: string,
    parentSessionId?: string,
    promptId: string = randomUUID(),
  ): Promise<CreatedStandaloneChildSession> {
    const { sessionId } = parseRequiredSessionId(request.sessionId);
    let entry: CreatingEntry | undefined;
    try {
      const runtime = await this.options.ensureRuntime();
      return await this.options.runRuntimeActivity(runtime, async () => {
        this.options.assertRuntimeCurrent(runtime);
        await this.options.workspace.assertExactRoot(runtime.workspaceCwd);
        this.options.assertRuntimeCurrent(runtime);
        const creatingEntry = this.insertCreating(sessionId, runtime);
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
        const create = (persistedParentSessionId?: string) =>
          this.options.lifecycle.runExclusiveAfterShared(sessionId, () =>
            this.createUnderExclusive(
              runtime,
              sessionId,
              request,
              prompt,
              promptId,
              persistedParentSessionId,
            ),
          );
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
      state: 'running',
    };
    this.creating.set(canonicalSessionId, entry);
    return entry;
  }

  private async createUnderExclusive(
    runtime: WorkspaceRuntime,
    sessionId: string,
    request: CreateStandaloneSessionRequest,
    prompt: string,
    promptId: string,
    parentSessionId?: string,
  ): Promise<CreatedStandaloneChildSession> {
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
        throw serviceError('standalone_creation_rolled_back', sessionId);
      }
      this.beginTerminalQuarantine(runtime);
    }
    this.assertRuntimeCurrentOrQuarantine(runtime);
    if (
      session.attached ||
      session.sessionId !== sessionId ||
      session.sourceType !== STANDALONE_SESSION_SOURCE_TYPE ||
      (parentSessionId !== undefined && session.parentSessionPersisted !== true)
    ) {
      await this.discardUntrustedSpawnResult(runtime.bridge, session);
      this.beginTerminalQuarantine(runtime);
    }
    if (session.sourcePersisted !== true) {
      await this.cleanRollbackBeforePersistence(runtime, sessionId);
      throw serviceError('standalone_creation_rolled_back', sessionId);
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
    let initialPrompt: CreatedStandaloneChildSession['initialPrompt'];
    try {
      await this.bindAndRelease(runtime, sessionId, prepared.identity);
      initialPrompt = await this.admitInitialPrompt(
        runtime.bridge,
        sessionId,
        prompt,
        promptId,
      );
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
      session,
      projectlessOutputDirectory: prepared.identity.canonicalPath,
      workingDirectory: { state: 'ready' },
      initialPrompt,
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
        (requiredPersistence === 'legacy' && source.persistence !== 'legacy')
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
