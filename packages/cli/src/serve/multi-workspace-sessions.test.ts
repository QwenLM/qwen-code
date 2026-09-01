/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
  SessionService,
  SessionTranscriptChangedError,
  Storage,
  createDebugLogger,
  readSessionPrs,
  resetDebugLoggingState,
  setDebugLogSession,
} from '@qwen-code/qwen-code-core';
import {
  InvalidRewindTargetError,
  SessionBusyError,
  SessionNotFoundError,
  type AcpSessionBridge,
  type BridgeClientRequestContext,
  type BridgeDaemonStatusSnapshot,
  type BridgeRestoreSessionRequest,
  type BridgeSessionSummary,
  type BridgeSpawnRequest,
} from './acp-session-bridge.js';
import { ClientMcpSenderRegistry } from './acp-http/client-mcp-sender-registry.js';
import type { DaemonLogger } from './daemon-logger.js';
import { createServeApp } from './server.js';
import type { WorkspaceFileSystemFactory } from './fs/index.js';
import type { ServeOptions } from './types.js';
import type { DaemonWorkspaceService } from './workspace-service/types.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from './workspace-registry.js';
import type { WorkspaceRuntimeProvenance } from './managed-scratch-workspace.js';
import type { ConversationWorkspace } from './conversations/conversation-workspace.js';
import { LIVE_SESSION_SOURCE_PREFIX } from '../runtime/live-session-source.js';
import { createSessionOrganizationService } from './session-organization-helpers.js';
import {
  serializeWorkspaceTranscriptResponseForTesting,
  workspaceTranscriptCursorExceedsLimitForTesting,
} from './routes/session.js';
import { SessionArchiveCoordinator } from './server/session-archive.js';

const PRIMARY_CWD = path.resolve(path.sep, 'work', 'primary');
const SECONDARY_CWD = path.resolve(path.sep, 'work', 'secondary');
const UNKNOWN_CWD = path.resolve(path.sep, 'work', 'unknown');
const TEST_TOKEN = 'test-token';
const TEST_AUTHORIZATION = `Bearer ${TEST_TOKEN}`;
const LIVE_COLD_LOAD_ID = '550e8400-e29b-41d4-a716-446655440101';
const LIVE_COLD_RESUME_ID = '550e8400-e29b-41d4-a716-446655440102';
const LIVE_PROJECTLESS_TASK_ID = '750e8400-e29b-71d4-a716-446655440103';
const LIVE_ACTIVE_LOAD_ID = '550e8400-e29b-41d4-a716-446655440104';
const LIVE_ACTIVE_RESUME_ID = '550e8400-e29b-41d4-a716-446655440105';
const LIVE_COLD_REJECTED_ID = '550e8400-e29b-41d4-a716-446655440106';
const LIVE_COLD_ATTACHED_ID = '550e8400-e29b-41d4-a716-446655440107';
const LIVE_COLD_REAP_REJECTED_ID = '550e8400-e29b-41d4-a716-446655440108';
const LIVE_INVALID_CHILD_ID = '550e8400-e29b-41d4-a716-446655440109';

const baseOpts: ServeOptions = {
  hostname: '127.0.0.1',
  port: 4170,
  mode: 'http-bridge',
};

interface FakeBridge extends AcpSessionBridge {
  readonly spawnCalls: BridgeSpawnRequest[];
  readonly promptCalls: Array<{
    sessionId: string;
    context?: BridgeClientRequestContext;
  }>;
  readonly cancelCalls: string[];
  readonly closeCalls: string[];
  readonly heartbeatCalls: string[];
  readonly detachCalls: string[];
  readonly eventsCalls: Array<{ sessionId: string; options?: unknown }>;
  readonly permissionCalls: Array<{
    sessionId: string;
    requestId: string;
    response: unknown;
    context?: unknown;
  }>;
  readonly pendingPromptCalls: string[];
  readonly removePendingPromptCalls: Array<{
    sessionId: string;
    promptId: string;
  }>;
  readonly restoreCalls: Array<{
    action: 'load' | 'resume';
    req: BridgeRestoreSessionRequest;
  }>;
  readonly listCalls: string[];
  readonly summaryCalls: string[];
  readonly setModelCalls: Array<{
    sessionId: string;
    req: { modelId?: unknown; sessionId?: unknown };
    context?: BridgeClientRequestContext;
  }>;
  readonly setApprovalModeCalls: Array<{
    sessionId: string;
    mode: string;
    opts: { persist?: boolean };
    context?: BridgeClientRequestContext;
  }>;
  readonly metadataCalls: Array<{
    sessionId: string;
    metadata: { displayName?: string };
    context?: BridgeClientRequestContext;
  }>;
  readonly recapCalls: Array<{
    sessionId: string;
    context?: BridgeClientRequestContext;
  }>;
  readonly btwCalls: Array<{
    sessionId: string;
    question: string;
    signal?: AbortSignal;
    context?: BridgeClientRequestContext;
  }>;
  readonly midTurnMessageCalls: Array<{
    sessionId: string;
    message: string;
    context?: BridgeClientRequestContext;
  }>;
  readonly getMidTurnMessagesCalls: Array<{
    sessionId: string;
    context?: BridgeClientRequestContext;
  }>;
  readonly removeMidTurnMessageCalls: Array<{
    sessionId: string;
    messageId: string;
    context?: BridgeClientRequestContext;
  }>;
  readonly taskCancelCalls: Array<{
    sessionId: string;
    taskId: string;
    taskKind: 'agent' | 'shell' | 'monitor' | 'workflow';
  }>;
  readonly goalClearCalls: string[];
  readonly continueCalls: Array<{
    sessionId: string;
    context?: BridgeClientRequestContext;
  }>;
  readonly languageCalls: Array<{
    sessionId: string;
    params: Parameters<AcpSessionBridge['setSessionLanguage']>[1];
    context?: BridgeClientRequestContext;
  }>;
  readonly addArtifactCalls: Array<{
    sessionId: string;
    artifact: Parameters<AcpSessionBridge['addSessionArtifact']>[1];
    context?: BridgeClientRequestContext;
  }>;
  readonly removeArtifactCalls: Array<{
    sessionId: string;
    artifactId: string;
    context?: BridgeClientRequestContext;
  }>;
  readonly rewindSnapshotCalls: string[];
  readonly rewindCalls: Array<{
    sessionId: string;
    req: Parameters<AcpSessionBridge['rewindSession']>[1];
    context?: BridgeClientRequestContext;
  }>;
  readonly shellCalls: Array<{
    sessionId: string;
    command: string;
    signal?: AbortSignal;
    context?: BridgeClientRequestContext;
  }>;
  readonly primaryOnlyMutationCalls: Array<{
    route: 'branch' | 'side-task' | 'fork' | 'cd';
    sessionId: string;
  }>;
  readonly cwdChangeCalls: Array<{
    sessionId: string;
    request: Parameters<AcpSessionBridge['changeSessionCwd']>[1];
  }>;
  readonly killCalls: string[];
  readonly operationLog: string[];
}

function makeSummary(
  sessionId: string,
  workspaceCwd: string,
  overrides: Partial<BridgeSessionSummary> = {},
): BridgeSessionSummary {
  return {
    sessionId,
    workspaceCwd,
    createdAt: '2026-07-08T00:00:00.000Z',
    updatedAt: '2026-07-08T00:01:00.000Z',
    displayName: sessionId,
    clientCount: 1,
    hasActivePrompt: false,
    ...overrides,
  };
}

async function writeStoredSession(input: {
  sessionId: string;
  cwd: string;
  timestamp: string;
  prompt: string;
  mtime: Date;
  parentSessionId?: string;
  sourceType?: string;
  sourceId?: string;
}): Promise<void> {
  const chatsDir = path.join(new Storage(input.cwd).getProjectDir(), 'chats');
  await fsp.mkdir(chatsDir, { recursive: true });
  const filePath = path.join(chatsDir, `${input.sessionId}.jsonl`);
  const records: Array<Record<string, unknown>> = [
    {
      uuid: `${input.sessionId}-user-1`,
      parentUuid: null,
      sessionId: input.sessionId,
      timestamp: input.timestamp,
      type: 'user',
      message: { role: 'user', parts: [{ text: input.prompt }] },
      cwd: input.cwd,
    },
  ];
  if (input.parentSessionId !== undefined) {
    records.push({
      uuid: `${input.sessionId}-parent-1`,
      parentUuid: `${input.sessionId}-user-1`,
      sessionId: input.sessionId,
      timestamp: input.timestamp,
      type: 'system',
      subtype: 'parent_session',
      systemPayload: { parentSessionId: input.parentSessionId },
      cwd: input.cwd,
    });
  }
  if (input.sourceType !== undefined) {
    records.push({
      uuid: `${input.sessionId}-source-1`,
      parentUuid:
        input.parentSessionId === undefined
          ? `${input.sessionId}-user-1`
          : `${input.sessionId}-parent-1`,
      sessionId: input.sessionId,
      timestamp: input.timestamp,
      type: 'system',
      subtype: 'session_source',
      systemPayload: {
        sourceType: input.sourceType,
        ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
      },
      cwd: input.cwd,
    });
  }
  await fsp.writeFile(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
  await fsp.utimes(filePath, input.mtime, input.mtime);
}

async function archiveStoredSession(
  cwd: string,
  sessionId: string,
): Promise<void> {
  const chatsDir = path.join(new Storage(cwd).getProjectDir(), 'chats');
  const archiveDir = path.join(chatsDir, 'archive');
  await fsp.mkdir(archiveDir, { recursive: true });
  await fsp.rename(
    path.join(chatsDir, `${sessionId}.jsonl`),
    path.join(archiveDir, `${sessionId}.jsonl`),
  );
}

async function writeLifecycleFixture(input: {
  sessionId: string;
  shape: 'empty' | 'damaged' | 'orphan';
  state: 'active' | 'archived';
}): Promise<{
  activePath: string;
  archivedPath: string;
  contents: Buffer;
}> {
  const chatsDir = path.join(
    new Storage(SECONDARY_CWD).getProjectDir(),
    'chats',
  );
  const activePath = path.join(chatsDir, `${input.sessionId}.jsonl`);
  const archivedPath = path.join(
    chatsDir,
    'archive',
    `${input.sessionId}.jsonl`,
  );
  if (input.shape === 'orphan') {
    await writeStoredSession({
      sessionId: input.sessionId,
      cwd: SECONDARY_CWD,
      timestamp: '2026-07-08T00:00:00.000Z',
      // Unique per session id: the qualified and unqualified rows share this
      // fixture and, for the unarchive case, land in the same project one
      // after the other. An identical prompt would derive an identical
      // display name, tripping the (correct, separately tested) unarchive
      // title-collision guard and appending an unrelated custom_title
      // record that this test's byte-exact comparison doesn't expect.
      prompt: `orphan lifecycle fixture ${input.sessionId}`,
      mtime: new Date('2026-07-08T00:00:00.000Z'),
      parentSessionId: '00000000-0000-4000-8000-000000000000',
    });
  } else {
    await fsp.mkdir(chatsDir, { recursive: true });
    await fsp.writeFile(
      activePath,
      input.shape === 'empty' ? '' : '{"uuid":"torn-head"',
    );
  }
  if (input.state === 'archived') {
    await archiveStoredSession(SECONDARY_CWD, input.sessionId);
  }
  return {
    activePath,
    archivedPath,
    contents: await fsp.readFile(
      input.state === 'active' ? activePath : archivedPath,
    ),
  };
}

async function withRuntimeDir<T>(fn: () => Promise<T>): Promise<T> {
  const previousRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
  const runtimeDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'qwen-multi-workspace-sessions-'),
  );
  process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
  try {
    return await fn();
  } finally {
    if (previousRuntimeDir === undefined) {
      delete process.env['QWEN_RUNTIME_DIR'];
    } else {
      process.env['QWEN_RUNTIME_DIR'] = previousRuntimeDir;
    }
    await fsp.rm(runtimeDir, { recursive: true, force: true });
  }
}

async function withStoredLiveCoordinators<T>(
  sessionIds: readonly string[],
  fn: (runtimeDir: string) => Promise<T>,
): Promise<T> {
  return withRuntimeDir(async () => {
    const runtimeDir = Storage.getRuntimeBaseDir();
    for (const sessionId of sessionIds) {
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'live coordinator',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
        sourceType: 'default',
        sourceId: `${LIVE_SESSION_SOURCE_PREFIX}${sessionId}`,
      });
    }
    return fn(runtimeDir);
  });
}

async function withStoredProjectlessLiveTasks<T>(
  sessionIds: readonly string[],
  fn: (runtimeDir: string) => Promise<T>,
): Promise<T> {
  return withRuntimeDir(async () => {
    const runtimeDir = Storage.getRuntimeBaseDir();
    for (const sessionId of sessionIds) {
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'projectless Live task',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
        sourceType: 'default',
      });
    }
    return fn(runtimeDir);
  });
}

async function withStoredLiveWorkers<T>(
  sessionIds: readonly string[],
  fn: (runtimeDir: string) => Promise<T>,
): Promise<T> {
  return withRuntimeDir(async () => {
    const runtimeDir = Storage.getRuntimeBaseDir();
    for (const [index, sessionId] of sessionIds.entries()) {
      const parentSessionId = `00000000-0000-4000-8000-${String(
        index + 1,
      ).padStart(12, '0')}`;
      await writeStoredSession({
        sessionId: parentSessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'live coordinator',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
        sourceType: 'default',
        sourceId: `${LIVE_SESSION_SOURCE_PREFIX}${parentSessionId}`,
      });
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:01.000Z',
        prompt: 'live worker',
        mtime: new Date('2026-07-08T00:00:01.000Z'),
        parentSessionId,
      });
    }
    return fn(runtimeDir);
  });
}

function makeBridge(
  workspaceCwd: string,
  summaries: BridgeSessionSummary[] = [],
  options: {
    channelLive?: boolean;
    rewindImpl?: AcpSessionBridge['rewindSession'];
    shellImpl?: AcpSessionBridge['executeShellCommand'];
    changeSessionCwdImpl?: AcpSessionBridge['changeSessionCwd'];
    operationLog?: string[];
    restoreAttached?: boolean;
    restoreHasActivePrompt?: boolean;
    restoreCurrentCwd?: string;
    killSessionResult?: boolean;
  } = {},
): FakeBridge {
  const live = new Map(
    summaries.map((summary) => [summary.sessionId, summary]),
  );
  const spawnCalls: BridgeSpawnRequest[] = [];
  const promptCalls: FakeBridge['promptCalls'] = [];
  const cancelCalls: string[] = [];
  const closeCalls: string[] = [];
  const heartbeatCalls: string[] = [];
  const detachCalls: string[] = [];
  const eventsCalls: FakeBridge['eventsCalls'] = [];
  const permissionCalls: FakeBridge['permissionCalls'] = [];
  const pendingPromptCalls: string[] = [];
  const removePendingPromptCalls: FakeBridge['removePendingPromptCalls'] = [];
  const restoreCalls: FakeBridge['restoreCalls'] = [];
  const listCalls: string[] = [];
  const summaryCalls: string[] = [];
  const setModelCalls: FakeBridge['setModelCalls'] = [];
  const setApprovalModeCalls: FakeBridge['setApprovalModeCalls'] = [];
  const metadataCalls: FakeBridge['metadataCalls'] = [];
  const recapCalls: FakeBridge['recapCalls'] = [];
  const btwCalls: FakeBridge['btwCalls'] = [];
  const midTurnMessageCalls: FakeBridge['midTurnMessageCalls'] = [];
  const getMidTurnMessagesCalls: FakeBridge['getMidTurnMessagesCalls'] = [];
  const removeMidTurnMessageCalls: FakeBridge['removeMidTurnMessageCalls'] = [];
  const taskCancelCalls: FakeBridge['taskCancelCalls'] = [];
  const goalClearCalls: string[] = [];
  const continueCalls: FakeBridge['continueCalls'] = [];
  const languageCalls: FakeBridge['languageCalls'] = [];
  const addArtifactCalls: FakeBridge['addArtifactCalls'] = [];
  const removeArtifactCalls: FakeBridge['removeArtifactCalls'] = [];
  const rewindSnapshotCalls: string[] = [];
  const rewindCalls: FakeBridge['rewindCalls'] = [];
  const shellCalls: FakeBridge['shellCalls'] = [];
  const primaryOnlyMutationCalls: FakeBridge['primaryOnlyMutationCalls'] = [];
  const cwdChangeCalls: FakeBridge['cwdChangeCalls'] = [];
  const killCalls: string[] = [];
  const operationLog = options.operationLog ?? [];
  let catalogRevision = 0;
  const catalogGeneration = `fake-catalog-gen-${workspaceCwd}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const bridge = {
    permissionPolicy: 'first-responder' as const,
    spawnCalls,
    promptCalls,
    cancelCalls,
    closeCalls,
    heartbeatCalls,
    detachCalls,
    eventsCalls,
    permissionCalls,
    pendingPromptCalls,
    removePendingPromptCalls,
    restoreCalls,
    listCalls,
    summaryCalls,
    setModelCalls,
    setApprovalModeCalls,
    metadataCalls,
    recapCalls,
    btwCalls,
    midTurnMessageCalls,
    getMidTurnMessagesCalls,
    removeMidTurnMessageCalls,
    taskCancelCalls,
    goalClearCalls,
    continueCalls,
    languageCalls,
    addArtifactCalls,
    removeArtifactCalls,
    rewindSnapshotCalls,
    rewindCalls,
    shellCalls,
    primaryOnlyMutationCalls,
    cwdChangeCalls,
    killCalls,
    operationLog,
    get sessionCount() {
      return live.size;
    },
    get activePromptCount() {
      return 0;
    },
    get activeWork() {
      return false;
    },
    get activeWorkCoverage() {
      return {
        total: 0,
        covered: 0,
        onNegotiatedChannel: 0,
        oldestCoveredReportAt: null,
      };
    },
    get pendingPromptTotal() {
      return 0;
    },
    get lastActivityAt() {
      return null;
    },
    getDaemonStatusSnapshot(): BridgeDaemonStatusSnapshot {
      return {
        limits: {
          maxSessions: 20,
          maxPendingPromptsPerSession: 5,
          eventRingSize: 8_000,
          compactedReplayMaxBytes: 4 * 1024 * 1024,
          maxJournalEvents: 10_000,
          maxJournalBytes: 8 * 1024 * 1024,
          journalGrowth: null,
          channelIdleTimeoutMs: 0,
          sessionIdleTimeoutMs: 1_800_000,
          sessionPromptSettledCloseGraceMs: 0,
        },
        sessionCount: live.size,
        pendingPermissionCount: 0,
        channelLive: options.channelLive ?? false,
        permissionPolicy: 'first-responder',
        sessions: [...live.values()].map((summary) => ({
          sessionId: summary.sessionId,
          workspaceCwd: summary.workspaceCwd,
          createdAt: summary.createdAt,
          displayName: summary.displayName,
          clientCount: summary.clientCount,
          subscriberCount: 0,
          attachCount: summary.clientCount,
          pendingPromptCount: 0,
          pendingPermissionCount: 0,
          hasActivePrompt: summary.hasActivePrompt,
          lastEventId: 0,
          maxJournalEvents: 10_000,
          maxJournalBytes: 8 * 1024 * 1024,
        })),
      };
    },
    async spawnOrAttach(req: BridgeSpawnRequest) {
      spawnCalls.push(req);
      const sessionId = `${workspaceCwd}-spawned-${spawnCalls.length}`;
      const summary = makeSummary(sessionId, req.workspaceCwd);
      live.set(sessionId, summary);
      return {
        sessionId,
        workspaceCwd: req.workspaceCwd,
        attached: options.restoreAttached ?? false,
        clientId: `client-${spawnCalls.length}`,
      };
    },
    async loadSession(req: BridgeRestoreSessionRequest) {
      operationLog.push(`load:${req.sessionId}`);
      restoreCalls.push({ action: 'load', req });
      return {
        sessionId: req.sessionId,
        workspaceCwd: req.workspaceCwd,
        attached: options.restoreAttached ?? false,
        clientId: 'restore-client',
        hasActivePrompt: options.restoreHasActivePrompt ?? false,
        ...(options.restoreCurrentCwd !== undefined
          ? { currentCwd: options.restoreCurrentCwd }
          : {}),
      };
    },
    async resumeSession(req: BridgeRestoreSessionRequest) {
      operationLog.push(`resume:${req.sessionId}`);
      restoreCalls.push({ action: 'resume', req });
      return {
        sessionId: req.sessionId,
        workspaceCwd: req.workspaceCwd,
        attached: options.restoreAttached ?? false,
        clientId: 'restore-client',
        hasActivePrompt: options.restoreHasActivePrompt ?? false,
        ...(options.restoreCurrentCwd !== undefined
          ? { currentCwd: options.restoreCurrentCwd }
          : {}),
      };
    },
    listWorkspaceSessions(cwd: string) {
      listCalls.push(cwd);
      return [...live.values()].filter(
        (summary) => summary.workspaceCwd === cwd,
      );
    },
    getSessionCatalogVersion() {
      return { generation: catalogGeneration, revision: catalogRevision };
    },
    markSessionCatalogChanged() {
      catalogRevision += 1;
    },
    getSessionSummary(sessionId: string) {
      summaryCalls.push(sessionId);
      const summary = live.get(sessionId);
      if (!summary) throw new SessionNotFoundError(sessionId);
      return summary;
    },
    getSessionLastEventId() {
      return 41;
    },
    getSessionEventEpoch() {
      return 'fake-epoch';
    },
    sendPrompt(
      sessionId: string,
      _req: unknown,
      _signal?: AbortSignal,
      context?: BridgeClientRequestContext,
    ) {
      promptCalls.push({ sessionId, ...(context ? { context } : {}) });
      return Promise.resolve({ stopReason: 'end_turn' });
    },
    async setSessionModel(
      sessionId: string,
      req: { modelId?: unknown; sessionId?: unknown },
      context?: BridgeClientRequestContext,
    ) {
      setModelCalls.push({ sessionId, req, ...(context ? { context } : {}) });
      return { sessionId, modelId: req.modelId, _meta: { applied: true } };
    },
    async setSessionApprovalMode(
      sessionId: string,
      mode: string,
      opts: { persist?: boolean },
      context?: BridgeClientRequestContext,
    ) {
      setApprovalModeCalls.push({
        sessionId,
        mode,
        opts,
        ...(context ? { context } : {}),
      });
      return {
        sessionId,
        mode,
        previous: 'default',
        persisted: opts?.persist === true,
      };
    },
    updateSessionMetadata(
      sessionId: string,
      metadata: {
        displayName?: string;
        pr?: { number: number; url: string };
      },
      context?: BridgeClientRequestContext,
    ) {
      metadataCalls.push({
        sessionId,
        metadata,
        ...(context ? { context } : {}),
      });
      return {
        displayName: `${workspaceCwd}:${metadata.displayName ?? ''}`,
        ...(metadata.pr ? { prs: [metadata.pr] } : {}),
      };
    },
    async generateSessionRecap(
      sessionId: string,
      context?: BridgeClientRequestContext,
    ) {
      recapCalls.push({ sessionId, ...(context ? { context } : {}) });
      return { sessionId, recap: `${workspaceCwd}:recap` };
    },
    async generateSessionBtw(
      sessionId: string,
      question: string,
      signal?: AbortSignal,
      context?: BridgeClientRequestContext,
    ) {
      btwCalls.push({
        sessionId,
        question,
        ...(signal ? { signal } : {}),
        ...(context ? { context } : {}),
      });
      return { sessionId, answer: `${workspaceCwd}:answer` };
    },
    enqueueMidTurnMessage(
      sessionId: string,
      message: string,
      context?: BridgeClientRequestContext,
    ) {
      midTurnMessageCalls.push({
        sessionId,
        message,
        ...(context ? { context } : {}),
      });
      return {
        accepted: workspaceCwd === SECONDARY_CWD,
        ...(workspaceCwd === SECONDARY_CWD
          ? { messageId: 'mid-secondary' }
          : {}),
      };
    },
    getMidTurnMessages(
      sessionId: string,
      context?: BridgeClientRequestContext,
    ) {
      getMidTurnMessagesCalls.push({
        sessionId,
        ...(context ? { context } : {}),
      });
      return {
        messages: [],
        settledMessageIds: [],
        promotedMessageIds: [],
      };
    },
    removeMidTurnMessage(
      sessionId: string,
      messageId: string,
      context?: BridgeClientRequestContext,
    ) {
      removeMidTurnMessageCalls.push({
        sessionId,
        messageId,
        ...(context ? { context } : {}),
      });
      return { removed: workspaceCwd === SECONDARY_CWD };
    },
    async cancelSessionTask(
      sessionId: string,
      taskId: string,
      taskKind: 'agent' | 'shell' | 'monitor' | 'workflow',
    ) {
      taskCancelCalls.push({ sessionId, taskId, taskKind });
      return { cancelled: workspaceCwd === SECONDARY_CWD };
    },
    async controlSessionWorkflowTask(
      _sessionId: string,
      _taskId: string,
      action:
        | 'pause'
        | 'resume'
        | 'retry'
        | 'rerun'
        | 'delete-history'
        | 'run-saved',
    ) {
      return {
        changed: workspaceCwd === SECONDARY_CWD,
        status: action === 'pause' ? 'pausing' : 'running',
      };
    },
    async clearSessionGoal(sessionId: string) {
      goalClearCalls.push(sessionId);
      return {
        cleared: workspaceCwd === SECONDARY_CWD,
        condition: workspaceCwd,
      };
    },
    async continueSession(
      sessionId: string,
      context?: BridgeClientRequestContext,
    ) {
      continueCalls.push({
        sessionId,
        ...(context ? { context } : {}),
      });
      return {
        accepted: true,
        interruption: 'interrupted_turn' as const,
        promptId: context?.promptId,
        lastEventId: 42,
      };
    },
    async setSessionLanguage(
      sessionId: string,
      params: Parameters<AcpSessionBridge['setSessionLanguage']>[1],
      context?: BridgeClientRequestContext,
    ) {
      languageCalls.push({
        sessionId,
        params,
        ...(context ? { context } : {}),
      });
      return {
        language: params.language,
        outputLanguage: params.syncOutputLanguage ? params.language : null,
        refreshed: params.syncOutputLanguage,
      };
    },
    async addSessionArtifact(
      sessionId: string,
      artifact: Parameters<AcpSessionBridge['addSessionArtifact']>[1],
      context?: BridgeClientRequestContext,
    ) {
      addArtifactCalls.push({
        sessionId,
        artifact,
        ...(context ? { context } : {}),
      });
      return { v: 1 as const, sessionId, changes: [] };
    },
    async removeSessionArtifact(
      sessionId: string,
      artifactId: string,
      context?: BridgeClientRequestContext,
    ) {
      removeArtifactCalls.push({
        sessionId,
        artifactId,
        ...(context ? { context } : {}),
      });
      return { v: 1 as const, sessionId, changes: [] };
    },
    async getRewindSnapshots(sessionId: string) {
      rewindSnapshotCalls.push(sessionId);
      return {
        snapshots: [
          {
            promptId: `${workspaceCwd}-prompt`,
            turnIndex: 0,
            timestamp: '2026-07-08T00:00:00.000Z',
            diffStats: {
              filesChanged: 1,
              insertions: 1,
              deletions: 0,
            },
          },
        ],
      };
    },
    async rewindSession(
      sessionId: string,
      req: Parameters<AcpSessionBridge['rewindSession']>[1],
      context?: BridgeClientRequestContext,
    ) {
      rewindCalls.push({
        sessionId,
        req,
        ...(context ? { context } : {}),
      });
      if (options.rewindImpl) {
        return options.rewindImpl(sessionId, req, context);
      }
      return {
        rewound: true,
        targetTurnIndex: 0,
        filesChanged: req.rewindFiles === false ? [] : ['tracked.txt'],
        filesFailed: [],
      };
    },
    async executeShellCommand(
      sessionId: string,
      command: string,
      signal?: AbortSignal,
      context?: BridgeClientRequestContext,
    ) {
      shellCalls.push({
        sessionId,
        command,
        ...(signal ? { signal } : {}),
        ...(context ? { context } : {}),
      });
      if (options.shellImpl) {
        return options.shellImpl(sessionId, command, signal, context);
      }
      return { exitCode: 0, output: workspaceCwd, aborted: false };
    },
    async branchSession(sessionId: string) {
      primaryOnlyMutationCalls.push({ route: 'branch', sessionId });
      return {
        sessionId: `${sessionId}-branch`,
        workspaceCwd,
        attached: false,
        clientId: 'branch-client',
        state: {},
        displayName: 'Branch',
        forkedFrom: { sessionId, displayName: 'Source' },
      };
    },
    async createSideTaskSession(sessionId: string) {
      primaryOnlyMutationCalls.push({ route: 'side-task', sessionId });
      return {
        sessionId: `${sessionId}-side-task`,
        workspaceCwd,
        attached: false,
        clientId: 'side-task-client',
        state: {},
        displayName: 'Side task',
        parentSessionId: sessionId,
      };
    },
    async launchSessionForkAgent(sessionId: string, directive: string) {
      primaryOnlyMutationCalls.push({ route: 'fork', sessionId });
      return { sessionId, description: directive, launched: true };
    },
    async changeSessionCwd(
      sessionId: string,
      req: Parameters<AcpSessionBridge['changeSessionCwd']>[1],
      context?: BridgeClientRequestContext,
    ) {
      if (options.changeSessionCwdImpl) {
        operationLog.push(`change:${sessionId}`);
        cwdChangeCalls.push({ sessionId, request: req });
        return options.changeSessionCwdImpl(sessionId, req, context);
      }
      primaryOnlyMutationCalls.push({ route: 'cd', sessionId });
      throw new Error('Unexpected changeSessionCwd call');
    },
    async killSession(sessionId: string) {
      operationLog.push(`kill:${sessionId}`);
      killCalls.push(sessionId);
      const killed = options.killSessionResult ?? true;
      if (killed) live.delete(sessionId);
      return killed;
    },
    async cancelSession(sessionId: string) {
      cancelCalls.push(sessionId);
    },
    recordHeartbeat(sessionId: string) {
      heartbeatCalls.push(sessionId);
      return { sessionId, lastSeenAt: 1_782_921_600_000 };
    },
    async detachClient(sessionId: string) {
      detachCalls.push(sessionId);
    },
    async closeSession(sessionId: string) {
      closeCalls.push(sessionId);
      live.delete(sessionId);
    },
    async deleteSessionAttachments() {},
    getPendingPrompts(sessionId: string) {
      if (!live.has(sessionId)) throw new SessionNotFoundError(sessionId);
      pendingPromptCalls.push(sessionId);
      return [
        {
          promptId: 'prompt-1',
          text: 'queued',
          queuedAt: 1,
          state: 'queued' as const,
        },
      ];
    },
    removePendingPrompt(sessionId: string, promptId: string) {
      if (!live.has(sessionId)) throw new SessionNotFoundError(sessionId);
      removePendingPromptCalls.push({ sessionId, promptId });
      return { removed: promptId === 'prompt-1' };
    },
    respondToSessionPermission(
      sessionId: string,
      requestId: string,
      response: unknown,
      context?: unknown,
    ) {
      if (!live.has(sessionId)) throw new SessionNotFoundError(sessionId);
      permissionCalls.push({ sessionId, requestId, response, context });
      return true;
    },
    respondToPermission() {
      return false;
    },
    subscribeEvents(sessionId: string, options?: unknown) {
      if (!live.has(sessionId)) throw new SessionNotFoundError(sessionId);
      eventsCalls.push({ sessionId, options });
      return (async function* () {})();
    },
    isChannelLive() {
      return options.channelLive ?? false;
    },
    knownClientIds() {
      return new Set<string>();
    },
    async shutdown() {},
    killAllSync() {},
    async preheat() {},
  };
  return bridge as unknown as FakeBridge;
}

function makeRuntime(input: {
  workspaceId: string;
  workspaceCwd: string;
  displayName?: string;
  primary: boolean;
  trusted: boolean;
  bridge: AcpSessionBridge;
  provenance?: WorkspaceRuntimeProvenance;
  sessionRuntimeBaseDir?: string;
}): WorkspaceRuntime {
  return {
    ...input,
    sessionRuntimeBaseDir:
      input.sessionRuntimeBaseDir ?? Storage.getRuntimeBaseDir(),
    env: { mode: 'parent-process', overlayKeys: [] },
    workspaceService: {} as DaemonWorkspaceService,
    routeFileSystemFactory: {
      forRequest: vi.fn(() => ({})),
    } as unknown as WorkspaceFileSystemFactory,
    clientMcpSenderRegistry: new ClientMcpSenderRegistry(),
  };
}

function makeDaemonLog(): DaemonLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    raw: vi.fn(),
    getLogPath: () => '',
    getDaemonId: () => 'test-daemon',
    getStatus: () => ({
      runId: '00000000000000000000000000000000',
      mode: 'stderr-only',
      health: 'ok',
      issues: [],
      droppedRecords: 0,
      droppedBytes: 0,
    }),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function makeHarness(opts?: {
  primaryTrusted?: boolean;
  secondaryTrusted?: boolean;
  secondaryChannelLive?: boolean;
  daemonLog?: DaemonLogger;
  primarySummaries?: BridgeSessionSummary[];
  secondarySummaries?: BridgeSessionSummary[];
  token?: string;
  secondaryRewindImpl?: AcpSessionBridge['rewindSession'];
  secondaryShellImpl?: AcpSessionBridge['executeShellCommand'];
  secondaryChangeSessionCwdImpl?: AcpSessionBridge['changeSessionCwd'];
  secondaryOperationLog?: string[];
  secondaryRestoreAttached?: boolean;
  secondaryRestoreHasActivePrompt?: boolean;
  secondaryRestoreCurrentCwd?: string;
  secondaryKillSessionResult?: boolean;
  secondaryProvenance?: WorkspaceRuntimeProvenance;
  liveConversationWorkspace?: ConversationWorkspace;
  serveOptions?: Partial<ServeOptions>;
  primaryRuntimeBaseDir?: string;
  secondaryRuntimeBaseDir?: string;
}) {
  const primaryBridge = makeBridge(
    PRIMARY_CWD,
    opts?.primarySummaries ?? [
      makeSummary('11111111-1111-4111-a111-111111111111', PRIMARY_CWD),
    ],
    { channelLive: true },
  );
  const secondaryBridge = makeBridge(
    SECONDARY_CWD,
    opts?.secondarySummaries ?? [
      makeSummary('22222222-2222-4222-a222-222222222222', SECONDARY_CWD),
    ],
    {
      channelLive: opts?.secondaryChannelLive ?? true,
      ...(opts?.secondaryRewindImpl
        ? { rewindImpl: opts.secondaryRewindImpl }
        : {}),
      ...(opts?.secondaryShellImpl
        ? { shellImpl: opts.secondaryShellImpl }
        : {}),
      ...(opts?.secondaryChangeSessionCwdImpl
        ? { changeSessionCwdImpl: opts.secondaryChangeSessionCwdImpl }
        : {}),
      ...(opts?.secondaryOperationLog
        ? { operationLog: opts.secondaryOperationLog }
        : {}),
      ...(opts?.secondaryRestoreAttached !== undefined
        ? { restoreAttached: opts.secondaryRestoreAttached }
        : {}),
      ...(opts?.secondaryRestoreHasActivePrompt !== undefined
        ? { restoreHasActivePrompt: opts.secondaryRestoreHasActivePrompt }
        : {}),
      ...(opts?.secondaryRestoreCurrentCwd !== undefined
        ? { restoreCurrentCwd: opts.secondaryRestoreCurrentCwd }
        : {}),
      ...(opts?.secondaryKillSessionResult !== undefined
        ? { killSessionResult: opts.secondaryKillSessionResult }
        : {}),
    },
  );
  const registry = createWorkspaceRegistry([
    makeRuntime({
      workspaceId: 'primary-id',
      workspaceCwd: PRIMARY_CWD,
      primary: true,
      trusted: opts?.primaryTrusted ?? true,
      bridge: primaryBridge,
      ...(opts?.primaryRuntimeBaseDir
        ? { sessionRuntimeBaseDir: opts.primaryRuntimeBaseDir }
        : {}),
    }),
    makeRuntime({
      workspaceId: 'secondary-id',
      workspaceCwd: SECONDARY_CWD,
      displayName: 'Secondary workspace',
      primary: false,
      trusted: opts?.secondaryTrusted ?? true,
      bridge: secondaryBridge,
      ...(opts?.secondaryProvenance
        ? { provenance: opts.secondaryProvenance }
        : {}),
      ...(opts?.secondaryRuntimeBaseDir
        ? { sessionRuntimeBaseDir: opts.secondaryRuntimeBaseDir }
        : {}),
    }),
  ]);
  const app = createServeApp(
    {
      ...baseOpts,
      workspace: PRIMARY_CWD,
      ...(opts?.token !== undefined ? { token: opts.token } : {}),
      ...opts?.serveOptions,
    },
    undefined,
    {
      workspaceRegistry: registry,
      daemonEnv: {},
      ...(opts?.daemonLog ? { daemonLog: opts.daemonLog } : {}),
      ...(opts?.liveConversationWorkspace
        ? { liveConversationWorkspace: opts.liveConversationWorkspace }
        : {}),
    },
  );
  return { app, registry, primaryBridge, secondaryBridge };
}

function host() {
  return `127.0.0.1:${baseOpts.port}`;
}

describe('multi-workspace session dispatch', () => {
  let previousRuntimeDir: string | undefined;
  let testRuntimeDir: string;

  beforeEach(async () => {
    previousRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    testRuntimeDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-multi-workspace-test-'),
    );
    process.env['QWEN_RUNTIME_DIR'] = testRuntimeDir;
  });

  afterEach(async () => {
    if (previousRuntimeDir === undefined) {
      delete process.env['QWEN_RUNTIME_DIR'];
    } else {
      process.env['QWEN_RUNTIME_DIR'] = previousRuntimeDir;
    }
    await fsp.rm(testRuntimeDir, { recursive: true, force: true });
  });

  it('advertises workspaces and multi_workspace_sessions only when multiple runtimes are registered', async () => {
    const { app } = makeHarness();
    const res = await request(app).get('/capabilities').set('Host', host());

    expect(res.status).toBe(200);
    expect(res.body.workspaceCwd).toBe(PRIMARY_CWD);
    expect(res.body.features).toContain('multi_workspace_sessions');
    expect(res.body.features).toContain('multi_workspace_session_rewind');
    expect(res.body.features).not.toContain('multi_workspace_session_shell');
    expect(res.body.features).toContain('workspace_persisted_transcript');
    expect(res.body.features).toContain('workspace_session_export');
    expect(res.body.features).toContain('workspace_archived_session_export');
    expect(res.body.features).toContain('workspace_display_name');
    expect(res.body.workspaces).toEqual([
      {
        id: 'primary-id',
        cwd: PRIMARY_CWD,
        primary: true,
        trusted: true,
        workflowsEnabled: false,
      },
      {
        id: 'secondary-id',
        cwd: SECONDARY_CWD,
        displayName: 'Secondary workspace',
        primary: false,
        trusted: true,
        workflowsEnabled: false,
      },
    ]);
    expect(res.body.limits.maxSessionsPerWorkspace).toBe(32);
    expect(res.body.limits.maxTotalSessions).toBeNull();
  });

  it('advertises multi-workspace shell on trusted loopback when explicitly enabled', async () => {
    const { app } = makeHarness({
      serveOptions: { enableSessionShell: true },
    });
    const res = await request(app).get('/capabilities').set('Host', host());

    expect(res.status).toBe(200);
    expect(res.body.features).toContain('session_shell_command');
    expect(res.body.features).toContain('multi_workspace_session_shell');
  });

  it('aggregates daemon status session count and exposes workspace metadata', async () => {
    const { app } = makeHarness();
    const res = await request(app).get('/daemon/status').set('Host', host());

    expect(res.status).toBe(200);
    expect(res.body.daemon.workspaceCwd).toBe(PRIMARY_CWD);
    expect(res.body.workspaces).toEqual([
      { id: 'primary-id', cwd: PRIMARY_CWD, primary: true, trusted: true },
      {
        id: 'secondary-id',
        cwd: SECONDARY_CWD,
        displayName: 'Secondary workspace',
        primary: false,
        trusted: true,
      },
    ]);
    expect(res.body.runtime.sessions.active).toBe(2);
    expect(res.body.runtime.channel.live).toBe(true);

    const full = await request(app)
      .get('/daemon/status?detail=full')
      .set('Host', host());
    expect(full.status).toBe(200);
    expect(
      full.body.full.sessions
        .map((session: { sessionId: string }) => session.sessionId)
        .sort(),
    ).toEqual([
      '11111111-1111-4111-a111-111111111111',
      '22222222-2222-4222-a222-222222222222',
    ]);
  });

  it('rolls up secondary runtime channel issues in daemon status', async () => {
    const { app } = makeHarness({ secondaryChannelLive: false });
    const res = await request(app).get('/daemon/status').set('Host', host());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('error');
    expect(res.body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'acp_channel_down',
          severity: 'error',
        }),
      ]),
    );
  });

  it('creates a session on the runtime matching the explicit cwd', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness();
    const res = await request(app)
      .post('/session')
      .set('Host', host())
      .send({ cwd: SECONDARY_CWD });

    expect(res.status).toBe(200);
    expect(primaryBridge.spawnCalls).toEqual([]);
    expect(secondaryBridge.spawnCalls).toHaveLength(1);
    expect(secondaryBridge.spawnCalls[0]).toMatchObject({
      workspaceCwd: SECONDARY_CWD,
    });
    expect(res.body.workspaceCwd).toBe(SECONDARY_CWD);
  });

  it('returns retryable unavailable for explicit session creation on a transitioning workspace', async () => {
    const { app, registry, primaryBridge, secondaryBridge } = makeHarness();
    const secondaryEntry = registry.getEntryByWorkspaceId('secondary-id');
    expect(secondaryEntry).toBeDefined();
    registry.beginReplacement(secondaryEntry!, 'policy-2');

    const res = await request(app)
      .post('/session')
      .set('Host', host())
      .send({ cwd: SECONDARY_CWD });

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body).toEqual({
      error: 'Workspace runtime is not active.',
      code: 'workspace_runtime_unavailable',
      workspaceCwd: SECONDARY_CWD,
      workspaceId: 'secondary-id',
    });
    expect(primaryBridge.spawnCalls).toEqual([]);
    expect(secondaryBridge.spawnCalls).toEqual([]);
  });

  it('applies a creation-time approvalMode on the owning non-primary runtime', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness();
    const res = await request(app)
      .post('/session')
      .set('Host', host())
      .send({ cwd: SECONDARY_CWD, approvalMode: 'yolo' });

    expect(res.status).toBe(200);
    expect(primaryBridge.spawnCalls).toEqual([]);
    expect(secondaryBridge.spawnCalls).toHaveLength(1);
    // The approval mode rides along with creation on the non-primary runtime,
    // so no follow-up primary-only approval-mode round-trip is required.
    expect(secondaryBridge.spawnCalls[0]).toMatchObject({
      workspaceCwd: SECONDARY_CWD,
      approvalMode: 'yolo',
    });
  });

  it('rejects unknown and untrusted workspace session creation before touching a bridge', async () => {
    const unknown = makeHarness();
    const unknownRes = await request(unknown.app)
      .post('/session')
      .set('Host', host())
      .send({ cwd: UNKNOWN_CWD });

    expect(unknownRes.status).toBe(400);
    expect(unknownRes.body.code).toBe('workspace_mismatch');
    expect(unknownRes.body.workspaceCount).toBe(2);
    expect(unknownRes.body.boundWorkspace).toBe(PRIMARY_CWD);
    expect(unknownRes.body.requestedWorkspace).toBe(UNKNOWN_CWD);
    expect(unknown.primaryBridge.spawnCalls).toEqual([]);
    expect(unknown.secondaryBridge.spawnCalls).toEqual([]);

    const daemonLog = makeDaemonLog();
    const untrusted = makeHarness({ secondaryTrusted: false, daemonLog });
    const untrustedRes = await request(untrusted.app)
      .post('/session')
      .set('Host', host())
      .send({ cwd: SECONDARY_CWD });

    expect(untrustedRes.status).toBe(403);
    expect(untrustedRes.body.code).toBe('untrusted_workspace');
    expect(untrustedRes.body.error).toBe('Workspace is not trusted.');
    expect(untrustedRes.body.workspaceCwd).toBe(SECONDARY_CWD);
    expect(untrustedRes.body.workspaceId).toBe('secondary-id');
    expect(untrusted.secondaryBridge.spawnCalls).toEqual([]);
    expect(daemonLog.warn).toHaveBeenCalledWith(
      'session routing failed',
      expect.objectContaining({
        route: 'POST /session',
        resolutionKind: 'untrusted_workspace',
        workspaceCwd: SECONDARY_CWD,
      }),
    );
  });

  it('revalidates runtime trust before dispatching live secondary session routes', async () => {
    const { app, secondaryBridge } = makeHarness({ secondaryTrusted: false });

    const res = await request(app)
      .get('/session/22222222-2222-4222-a222-222222222222/status')
      .set('Host', host());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('untrusted_workspace');
    expect(res.body.error).toBe('Workspace is not trusted.');
    expect(res.body.sessionId).toBe('22222222-2222-4222-a222-222222222222');
    expect(res.body.workspaceCwd).toBe(SECONDARY_CWD);
    expect(res.body.workspaceId).toBe('secondary-id');
    expect(secondaryBridge.promptCalls).toEqual([]);
  });

  it('dispatches live session routes by owner runtime', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness();

    await request(app)
      .post('/session/22222222-2222-4222-a222-222222222222/prompt')
      .set('Host', host())
      .set('X-Qwen-Client-Id', 'client-2')
      .send({ prompt: [{ type: 'text', text: 'hello' }] })
      .expect(202);
    expect(primaryBridge.promptCalls).toEqual([]);
    expect(secondaryBridge.promptCalls).toMatchObject([
      {
        sessionId: '22222222-2222-4222-a222-222222222222',
        context: { clientId: 'client-2' },
      },
    ]);

    const status = await request(app)
      .get('/session/22222222-2222-4222-a222-222222222222/status')
      .set('Host', host())
      .expect(200);
    expect(status.body.workspaceCwd).toBe(SECONDARY_CWD);

    await request(app)
      .post('/session/22222222-2222-4222-a222-222222222222/cancel')
      .set('Host', host())
      .send({})
      .expect(204);
    await request(app)
      .post('/session/22222222-2222-4222-a222-222222222222/heartbeat')
      .set('Host', host())
      .send({})
      .expect(200);
    await request(app)
      .post('/session/22222222-2222-4222-a222-222222222222/detach')
      .set('Host', host())
      .send({})
      .expect(204);

    expect(secondaryBridge.cancelCalls).toEqual([
      '22222222-2222-4222-a222-222222222222',
    ]);
    expect(secondaryBridge.heartbeatCalls).toEqual([
      '22222222-2222-4222-a222-222222222222',
    ]);
    expect(secondaryBridge.detachCalls).toEqual([
      '22222222-2222-4222-a222-222222222222',
    ]);
  });

  it('routes trusted-loopback secondary rewind and shell only to the owner bridge', async () => {
    const daemonLog = makeDaemonLog();
    const { app, primaryBridge, secondaryBridge } = makeHarness({
      daemonLog,
      serveOptions: { enableSessionShell: true },
    });
    const local = (test: request.Test) => test.set('Host', host());

    const snapshots = await local(
      request(app).get(
        '/session/22222222-2222-4222-a222-222222222222/rewind/snapshots',
      ),
    );
    expect(snapshots.status).toBe(200);
    expect(snapshots.body.snapshots[0].promptId).toBe(
      `${SECONDARY_CWD}-prompt`,
    );

    const rewind = await local(
      request(app).post('/session/22222222-2222-4222-a222-222222222222/rewind'),
    )
      .set('X-Qwen-Client-Id', 'client-2')
      .send({ promptId: 'secondary-prompt', rewindFiles: true });
    expect(rewind.status).toBe(200);
    expect(rewind.body.filesChanged).toEqual(['tracked.txt']);

    const shell = await local(
      request(app).post('/session/22222222-2222-4222-a222-222222222222/shell'),
    )
      .set('X-Qwen-Client-Id', 'client-2')
      .send({ command: ' pwd ' });
    expect(shell.status).toBe(200);
    expect(shell.body.output).toBe(SECONDARY_CWD);

    expect(primaryBridge.rewindSnapshotCalls).toEqual([]);
    expect(primaryBridge.rewindCalls).toEqual([]);
    expect(primaryBridge.shellCalls).toEqual([]);
    expect(secondaryBridge.rewindSnapshotCalls).toEqual([
      '22222222-2222-4222-a222-222222222222',
    ]);
    expect(secondaryBridge.rewindCalls).toEqual([
      {
        sessionId: '22222222-2222-4222-a222-222222222222',
        req: { promptId: 'secondary-prompt', rewindFiles: true },
        context: { clientId: 'client-2' },
      },
    ]);
    expect(secondaryBridge.shellCalls).toEqual([
      {
        sessionId: '22222222-2222-4222-a222-222222222222',
        command: 'pwd',
        signal: expect.any(AbortSignal),
        context: { clientId: 'client-2' },
      },
    ]);
    expect(daemonLog.info).toHaveBeenCalledWith('rewind snapshots loaded', {
      sessionId: '22222222-2222-4222-a222-222222222222',
      snapshotCount: 1,
      workspaceId: 'secondary-id',
      workspaceCwd: SECONDARY_CWD,
    });
    expect(daemonLog.info).toHaveBeenCalledWith('session rewind completed', {
      sessionId: '22222222-2222-4222-a222-222222222222',
      promptId: 'secondary-prompt',
      rewindFiles: true,
      rewound: true,
      filesChangedCount: 1,
      filesFailedCount: 0,
      workspaceId: 'secondary-id',
      workspaceCwd: SECONDARY_CWD,
    });
    expect(daemonLog.info).toHaveBeenCalledWith('shell command completed', {
      sessionId: '22222222-2222-4222-a222-222222222222',
      clientId: 'client-2',
      exitCode: 0,
      workspaceId: 'secondary-id',
      workspaceCwd: SECONDARY_CWD,
    });
  });

  it('preserves rewindFiles defaults and rejects non-boolean values', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness({
      serveOptions: { token: 'secret' },
    });
    const rewind = (body: Record<string, unknown>) =>
      request(app)
        .post('/session/22222222-2222-4222-a222-222222222222/rewind')
        .set('Host', host())
        .set('Authorization', 'Bearer secret')
        .send(body);

    for (const [body, expected] of [
      [{ promptId: 'omitted' }, true],
      [{ promptId: 'true', rewindFiles: true }, true],
      [{ promptId: 'false', rewindFiles: false }, false],
    ] as const) {
      await rewind(body).expect(200);
      expect(secondaryBridge.rewindCalls.at(-1)?.req.rewindFiles).toBe(
        expected,
      );
    }

    for (const rewindFiles of ['false', 0, null]) {
      const response = await rewind({ promptId: 'invalid', rewindFiles });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_rewind_files_flag');
    }

    for (const body of [{}, { promptId: '' }]) {
      const response = await rewind(body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('missing_prompt_id');
    }

    expect(primaryBridge.rewindCalls).toEqual([]);
    expect(secondaryBridge.rewindCalls).toHaveLength(3);
  });

  it('fails closed for unknown, untrusted, and ambiguous rewind owners', async () => {
    const unknown = makeHarness();
    const unknownRes = await request(unknown.app)
      .get('/session/missing/rewind/snapshots')
      .set('Host', host());
    expect(unknownRes.status).toBe(404);
    expect(unknownRes.body.code).toBe('session_not_found');

    const untrusted = makeHarness({ secondaryTrusted: false });
    const untrustedRes = await request(untrusted.app)
      .get('/session/22222222-2222-4222-a222-222222222222/rewind/snapshots')
      .set('Host', host());
    expect(untrustedRes.status).toBe(403);
    expect(untrustedRes.body.code).toBe('untrusted_workspace');
    expect(untrusted.secondaryBridge.rewindSnapshotCalls).toEqual([]);

    const duplicate = makeSummary('duplicate-session', PRIMARY_CWD);
    const ambiguous = makeHarness({
      primarySummaries: [duplicate],
      secondarySummaries: [makeSummary('duplicate-session', SECONDARY_CWD)],
    });
    const ambiguousRes = await request(ambiguous.app)
      .get('/session/duplicate-session/rewind/snapshots')
      .set('Host', host());
    expect(ambiguousRes.status).toBe(500);
    expect(ambiguousRes.body.code).toBe('ambiguous_session_owner');
    expect(ambiguous.primaryBridge.rewindSnapshotCalls).toEqual([]);
    expect(ambiguous.secondaryBridge.rewindSnapshotCalls).toEqual([]);
  });

  it('rejects untrusted secondary rewind and shell before bridge execution', async () => {
    const { app, secondaryBridge } = makeHarness({
      secondaryTrusted: false,
      serveOptions: { token: 'secret', enableSessionShell: true },
    });
    const auth = (test: request.Test) =>
      test.set('Host', host()).set('Authorization', 'Bearer secret');

    const rewind = await auth(
      request(app).post('/session/22222222-2222-4222-a222-222222222222/rewind'),
    ).send({ promptId: 'secondary-prompt' });
    expect(rewind.status).toBe(403);
    expect(rewind.body.code).toBe('untrusted_workspace');

    const shell = await auth(
      request(app).post('/session/22222222-2222-4222-a222-222222222222/shell'),
    )
      .set('X-Qwen-Client-Id', 'client-2')
      .send({ command: 'pwd' });
    expect(shell.status).toBe(403);
    expect(shell.body.code).toBe('untrusted_workspace');
    expect(secondaryBridge.rewindCalls).toEqual([]);
    expect(secondaryBridge.shellCalls).toEqual([]);
  });

  it('aborts only the owning secondary shell when the HTTP client disconnects', async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markAborted: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    let secondarySignal: AbortSignal | undefined;
    const { app, primaryBridge, secondaryBridge } = makeHarness({
      serveOptions: { token: 'secret', enableSessionShell: true },
      secondaryShellImpl: async (_sessionId, _command, signal) => {
        secondarySignal = signal;
        markStarted?.();
        await new Promise<void>((resolve) => {
          signal?.addEventListener(
            'abort',
            () => {
              markAborted?.();
              resolve();
            },
            { once: true },
          );
        });
        return { exitCode: null, output: '', aborted: true };
      },
    });
    const pending = request(app)
      .post('/session/22222222-2222-4222-a222-222222222222/shell')
      .set('Host', host())
      .set('Authorization', 'Bearer secret')
      .set('X-Qwen-Client-Id', 'client-2')
      .send({ command: 'sleep 10' });
    const response = pending.then(
      () => undefined,
      () => undefined,
    );

    await started;
    pending.abort();
    await Promise.all([response, aborted]);

    expect(secondarySignal?.aborted).toBe(true);
    expect(primaryBridge.shellCalls).toEqual([]);
    expect(secondaryBridge.shellCalls).toHaveLength(1);
  });

  it('preserves strict shell validation order for a secondary owner', async () => {
    const disabled = makeHarness({ serveOptions: { token: 'secret' } });
    const disabledResponse = await request(disabled.app)
      .post('/session/22222222-2222-4222-a222-222222222222/shell')
      .set('Host', host())
      .set('Authorization', 'Bearer secret')
      .send({ command: '' });
    expect(disabledResponse.status).toBe(403);
    expect(disabledResponse.body.code).toBe('session_shell_disabled');

    const enabled = makeHarness({
      serveOptions: { token: 'secret', enableSessionShell: true },
    });
    const tokenRequired = await request(enabled.app)
      .post('/session/22222222-2222-4222-a222-222222222222/shell')
      .set('Host', host())
      .send({ command: 'pwd' });
    expect(tokenRequired.status).toBe(401);
    expect(tokenRequired.body.error).toBe('Unauthorized');

    const clientRequired = await request(enabled.app)
      .post('/session/22222222-2222-4222-a222-222222222222/shell')
      .set('Host', host())
      .set('Authorization', 'Bearer secret')
      .send({ command: '' });
    expect(clientRequired.status).toBe(403);
    expect(clientRequired.body.code).toBe('client_id_required');

    const emptyCommand = await request(enabled.app)
      .post('/session/22222222-2222-4222-a222-222222222222/shell')
      .set('Host', host())
      .set('Authorization', 'Bearer secret')
      .set('X-Qwen-Client-Id', 'client-2')
      .send({ command: '   ' });
    expect(emptyCommand.status).toBe(400);

    expect(disabled.secondaryBridge.shellCalls).toEqual([]);
    expect(enabled.primaryBridge.shellCalls).toEqual([]);
    expect(enabled.secondaryBridge.shellCalls).toEqual([]);
  });

  it('keeps primary rewind and shell behavior when multiple runtimes exist', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness({
      serveOptions: { token: 'secret', enableSessionShell: true },
    });

    await request(app)
      .get('/session/11111111-1111-4111-a111-111111111111/rewind/snapshots')
      .set('Host', host())
      .set('Authorization', 'Bearer secret')
      .expect(200);
    await request(app)
      .post('/session/11111111-1111-4111-a111-111111111111/rewind')
      .set('Host', host())
      .set('Authorization', 'Bearer secret')
      .send({ promptId: 'primary-prompt', rewindFiles: false })
      .expect(200);
    await request(app)
      .post('/session/11111111-1111-4111-a111-111111111111/shell')
      .set('Host', host())
      .set('Authorization', 'Bearer secret')
      .set('X-Qwen-Client-Id', 'client-1')
      .send({ command: 'pwd' })
      .expect(200);

    expect(primaryBridge.rewindSnapshotCalls).toEqual([
      '11111111-1111-4111-a111-111111111111',
    ]);
    expect(primaryBridge.rewindCalls).toHaveLength(1);
    expect(primaryBridge.shellCalls).toHaveLength(1);
    expect(secondaryBridge.rewindSnapshotCalls).toEqual([]);
    expect(secondaryBridge.rewindCalls).toEqual([]);
    expect(secondaryBridge.shellCalls).toEqual([]);
  });

  it('keeps rewind and shell behavior in a single-workspace daemon', async () => {
    const bridge = makeBridge(PRIMARY_CWD, [
      makeSummary('11111111-1111-4111-a111-111111111111', PRIMARY_CWD),
    ]);
    const app = createServeApp(
      {
        ...baseOpts,
        workspace: PRIMARY_CWD,
        token: 'secret',
        enableSessionShell: true,
      },
      undefined,
      { bridge },
    );
    const auth = (test: request.Test) =>
      test.set('Host', host()).set('Authorization', 'Bearer secret');

    const capabilities = await auth(request(app).get('/capabilities'));
    expect(capabilities.body.features).not.toContain(
      'multi_workspace_session_rewind',
    );
    expect(capabilities.body.features).not.toContain(
      'multi_workspace_session_shell',
    );

    await auth(
      request(app).get(
        '/session/11111111-1111-4111-a111-111111111111/rewind/snapshots',
      ),
    ).expect(200);
    await auth(
      request(app).post('/session/11111111-1111-4111-a111-111111111111/rewind'),
    )
      .send({ promptId: 'primary-prompt', rewindFiles: false })
      .expect(200);
    await auth(
      request(app).post('/session/11111111-1111-4111-a111-111111111111/shell'),
    )
      .set('X-Qwen-Client-Id', 'client-1')
      .send({ command: 'pwd' })
      .expect(200);

    expect(bridge.rewindSnapshotCalls).toEqual([
      '11111111-1111-4111-a111-111111111111',
    ]);
    expect(bridge.rewindCalls).toHaveLength(1);
    expect(bridge.shellCalls).toHaveLength(1);
  });

  it('preserves rewind busy, invalid-target, and partial-restore contracts', async () => {
    const postRewind = (
      app: ReturnType<typeof createServeApp>,
      promptId: string,
    ) =>
      request(app)
        .post('/session/22222222-2222-4222-a222-222222222222/rewind')
        .set('Host', host())
        .set('Authorization', 'Bearer secret')
        .send({ promptId });

    const busy = makeHarness({
      serveOptions: { token: 'secret' },
      secondaryRewindImpl: async (sessionId) => {
        throw new SessionBusyError(sessionId);
      },
    });
    const busyResponse = await postRewind(busy.app, 'busy');
    expect(busyResponse.status).toBe(409);
    expect(busyResponse.body.code).toBe('session_busy');
    expect(busyResponse.headers['retry-after']).toBe('5');

    const invalid = makeHarness({
      serveOptions: { token: 'secret' },
      secondaryRewindImpl: async (sessionId) => {
        throw new InvalidRewindTargetError(sessionId);
      },
    });
    const invalidResponse = await postRewind(invalid.app, 'invalid');
    expect(invalidResponse.status).toBe(400);
    expect(invalidResponse.body.code).toBe('invalid_rewind_target');

    const partial = makeHarness({
      serveOptions: { token: 'secret' },
      secondaryRewindImpl: async () => ({
        rewound: false,
        targetTurnIndex: 1,
        filesChanged: ['restored.txt'],
        filesFailed: ['failed.txt'],
      }),
    });
    const partialResponse = await postRewind(partial.app, 'partial');
    expect(partialResponse.status).toBe(200);
    expect(partialResponse.body).toEqual({
      rewound: false,
      targetTurnIndex: 1,
      filesChanged: ['restored.txt'],
      filesFailed: ['failed.txt'],
    });
  });

  it('dispatches secondary events, permissions, pending prompts, and close', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness();

    await request(app)
      .get(
        '/session/22222222-2222-4222-a222-222222222222/events?snapshot=1&maxQueued=16',
      )
      .set('Host', host())
      .expect(200);
    expect(primaryBridge.eventsCalls).toEqual([]);
    expect(secondaryBridge.eventsCalls).toEqual([
      expect.objectContaining({
        sessionId: '22222222-2222-4222-a222-222222222222',
      }),
    ]);

    await request(app)
      .post('/session/22222222-2222-4222-a222-222222222222/permission/perm-1')
      .set('Host', host())
      .set('X-Qwen-Client-Id', 'client-2')
      .send({ outcome: { outcome: 'cancelled' } })
      .expect(200);
    expect(primaryBridge.permissionCalls).toEqual([]);
    expect(secondaryBridge.permissionCalls).toEqual([
      expect.objectContaining({
        sessionId: '22222222-2222-4222-a222-222222222222',
        requestId: 'perm-1',
      }),
    ]);

    const pending = await request(app)
      .get('/session/22222222-2222-4222-a222-222222222222/pending-prompts')
      .set('Host', host())
      .set('X-Qwen-Client-Id', 'client-2')
      .expect(200);
    expect(pending.body.pendingPrompts).toEqual([
      expect.objectContaining({ promptId: 'prompt-1' }),
    ]);

    await request(app)
      .delete(
        '/session/22222222-2222-4222-a222-222222222222/pending-prompts/prompt-1',
      )
      .set('Host', host())
      .set('X-Qwen-Client-Id', 'client-2')
      .expect(200);
    expect(primaryBridge.pendingPromptCalls).toEqual([]);
    expect(primaryBridge.removePendingPromptCalls).toEqual([]);
    expect(secondaryBridge.pendingPromptCalls).toEqual([
      '22222222-2222-4222-a222-222222222222',
    ]);
    expect(secondaryBridge.removePendingPromptCalls).toEqual([
      {
        sessionId: '22222222-2222-4222-a222-222222222222',
        promptId: 'prompt-1',
      },
    ]);

    await request(app)
      .delete('/session/22222222-2222-4222-a222-222222222222')
      .set('Host', host())
      .set('X-Qwen-Client-Id', 'client-2')
      .expect(204);
    expect(primaryBridge.closeCalls).toEqual([]);
    expect(secondaryBridge.closeCalls).toEqual([
      '22222222-2222-4222-a222-222222222222',
    ]);
  });

  it('returns session_not_found instead of falling back to primary on live owner miss', async () => {
    const { app } = makeHarness();
    const res = await request(app)
      .post('/session/missing-session/prompt')
      .set('Host', host())
      .send({ prompt: [{ type: 'text', text: 'hello' }] });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('session_not_found');
  });

  it('logs live session owner misses for session, SSE, and permission routes', async () => {
    const daemonLog = makeDaemonLog();
    const { app } = makeHarness({ daemonLog });

    await request(app)
      .post('/session/missing-session/prompt')
      .set('Host', host())
      .send({ prompt: [{ type: 'text', text: 'hello' }] })
      .expect(404);
    await request(app)
      .get('/session/missing-session/events')
      .set('Host', host())
      .expect(404);
    await request(app)
      .post('/session/missing-session/permission/perm-1')
      .set('Host', host())
      .send({ outcome: { outcome: 'cancelled' } })
      .expect(404);

    expect(daemonLog.warn).toHaveBeenCalledWith(
      'session routing failed',
      expect.objectContaining({
        route: 'POST /session/:id/prompt',
        resolutionKind: 'not_found',
        sessionId: 'missing-session',
      }),
    );
    expect(daemonLog.warn).toHaveBeenCalledWith(
      'session routing failed',
      expect.objectContaining({
        route: 'GET /session/:id/events',
        resolutionKind: 'not_found',
        sessionId: 'missing-session',
      }),
    );
    expect(daemonLog.warn).toHaveBeenCalledWith(
      'session routing failed',
      expect.objectContaining({
        route: 'POST /session/:id/permission/:requestId',
        resolutionKind: 'not_found',
        sessionId: 'missing-session',
        requestId: 'perm-1',
      }),
    );
  });

  it('dispatches trusted non-primary persisted load and resume', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness();

    for (const action of ['load', 'resume'] as const) {
      const res = await request(app)
        .post(`/session/22222222-2222-4222-a222-222222222222/${action}`)
        .set('Host', host())
        .send({ cwd: SECONDARY_CWD });

      expect(res.status).toBe(200);
      expect(res.body.workspaceCwd).toBe(SECONDARY_CWD);
    }

    expect(primaryBridge.restoreCalls).toEqual([]);
    expect(secondaryBridge.restoreCalls).toEqual([
      {
        action: 'load',
        req: expect.objectContaining({
          sessionId: '22222222-2222-4222-a222-222222222222',
          workspaceCwd: SECONDARY_CWD,
        }),
      },
      {
        action: 'resume',
        req: expect.objectContaining({
          sessionId: '22222222-2222-4222-a222-222222222222',
          workspaceCwd: SECONDARY_CWD,
        }),
      },
    ]);
    expect(secondaryBridge.cwdChangeCalls).toEqual([]);
  });

  it('restores cold Live load and resume sessions into their server-derived conversation directories', async () => {
    await withStoredLiveCoordinators(
      [LIVE_COLD_LOAD_ID, LIVE_COLD_RESUME_ID],
      async (runtimeDir) => {
        const operationLog: string[] = [];
        const materializeConversationDirectory = vi.fn(
          async (sessionId: string) => {
            operationLog.push(`materialize:${sessionId}`);
            return path.join(SECONDARY_CWD, `conversation-${sessionId}`);
          },
        );
        const { app, secondaryBridge } = makeHarness({
          secondaryProvenance: 'live-conversation',
          secondaryOperationLog: operationLog,
          secondaryChangeSessionCwdImpl: async (sessionId, req) => ({
            sessionId,
            previousCwd: SECONDARY_CWD,
            newCwd: req.path,
            warnings: [],
          }),
          liveConversationWorkspace: {
            materializeConversationDirectory,
          } as unknown as ConversationWorkspace,
          secondaryRuntimeBaseDir: runtimeDir,
        });

        for (const { action, sessionId } of [
          { action: 'load', sessionId: LIVE_COLD_LOAD_ID },
          { action: 'resume', sessionId: LIVE_COLD_RESUME_ID },
        ] as const) {
          const response = await request(app)
            .post(`/session/${sessionId}/${action}`)
            .set('Host', host())
            .send({ cwd: SECONDARY_CWD });

          expect(response.status).toBe(200);
          expect(response.body.workspaceCwd).toBe(SECONDARY_CWD);
        }

        expect(operationLog).toEqual([
          `materialize:${LIVE_COLD_LOAD_ID}`,
          `load:${LIVE_COLD_LOAD_ID}`,
          `change:${LIVE_COLD_LOAD_ID}`,
          `materialize:${LIVE_COLD_RESUME_ID}`,
          `resume:${LIVE_COLD_RESUME_ID}`,
          `change:${LIVE_COLD_RESUME_ID}`,
        ]);
        expect(secondaryBridge.cwdChangeCalls).toEqual([
          {
            sessionId: LIVE_COLD_LOAD_ID,
            request: {
              path: path.join(
                SECONDARY_CWD,
                `conversation-${LIVE_COLD_LOAD_ID}`,
              ),
              allowedRoots: [SECONDARY_CWD],
              managedRelocation: 'live-conversation',
            },
          },
          {
            sessionId: LIVE_COLD_RESUME_ID,
            request: {
              path: path.join(
                SECONDARY_CWD,
                `conversation-${LIVE_COLD_RESUME_ID}`,
              ),
              allowedRoots: [SECONDARY_CWD],
              managedRelocation: 'live-conversation',
            },
          },
        ]);
        expect(materializeConversationDirectory).toHaveBeenCalledTimes(2);
      },
    );
  });

  it('loads a projectless task created from Live in the Conversations runtime', async () => {
    await withStoredProjectlessLiveTasks(
      [LIVE_PROJECTLESS_TASK_ID],
      async (runtimeDir) => {
        const materializeConversationDirectory = vi.fn(
          async (sessionId: string) =>
            path.join(SECONDARY_CWD, `conversation-${sessionId}`),
        );
        const { app, secondaryBridge } = makeHarness({
          secondaryProvenance: 'live-conversation',
          secondaryChangeSessionCwdImpl: async (sessionId, req) => ({
            sessionId,
            previousCwd: SECONDARY_CWD,
            newCwd: req.path,
            warnings: [],
          }),
          liveConversationWorkspace: {
            materializeConversationDirectory,
          } as unknown as ConversationWorkspace,
          secondaryRuntimeBaseDir: runtimeDir,
        });

        const response = await request(app)
          .post(`/session/${LIVE_PROJECTLESS_TASK_ID}/load`)
          .set('Host', host())
          .send({ cwd: SECONDARY_CWD });

        expect(response.status).toBe(200);
        expect(secondaryBridge.restoreCalls).toEqual([
          {
            action: 'load',
            req: expect.objectContaining({
              sessionId: LIVE_PROJECTLESS_TASK_ID,
              workspaceCwd: SECONDARY_CWD,
              sourceType: 'default',
            }),
          },
        ]);
        expect(materializeConversationDirectory).toHaveBeenCalledWith(
          LIVE_PROJECTLESS_TASK_ID,
        );
      },
    );
  });

  it('reads exact active/archive conflicts from the active copy in an internal workspace', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440111';
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'archived internal copy',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
        sourceType: 'default',
        sourceId: `${LIVE_SESSION_SOURCE_PREFIX}${sessionId}`,
      });
      await archiveStoredSession(SECONDARY_CWD, sessionId);
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:01:00.000Z',
        prompt: 'active internal copy',
        mtime: new Date('2026-07-08T00:01:00.000Z'),
        sourceType: 'default',
        sourceId: `${LIVE_SESSION_SOURCE_PREFIX}${sessionId}`,
      });
      const { app } = makeHarness({
        secondaryProvenance: 'live-conversation',
        secondaryRuntimeBaseDir: Storage.getRuntimeBaseDir(),
      });

      const transcript = await request(app)
        .get(`/workspaces/secondary-id/session/${sessionId}/transcript`)
        .set('Host', host());
      const exported = await request(app)
        .get(`/workspaces/secondary-id/session/${sessionId}/export?format=json`)
        .set('Host', host());
      const archive = await request(app)
        .post('/workspaces/secondary-id/sessions/archive')
        .set('Host', host())
        .send({ sessionIds: [sessionId] });

      expect(transcript.status).toBe(200);
      expect(JSON.stringify(transcript.body)).toContain('active internal copy');
      expect(JSON.stringify(transcript.body)).not.toContain(
        'archived internal copy',
      );
      expect(exported.status).toBe(200);
      expect(exported.text).toContain('active internal copy');
      expect(exported.text).not.toContain('archived internal copy');
      expect(archive.status).toBe(200);
      expect(archive.body).toMatchObject({
        archived: [],
        alreadyArchived: [],
        resolvedConflicts: [],
        notFound: [],
        errors: [
          {
            sessionId,
            error: `Session "${sessionId}" exists in both active and archived directories. Retry with resolveConflicts: true to keep one copy.`,
          },
        ],
      });
    });
  });

  it.each([
    ['empty', 'delete', '201'],
    ['empty', 'archive', '202'],
    ['empty', 'unarchive', '203'],
    ['damaged', 'delete', '204'],
    ['damaged', 'archive', '205'],
    ['damaged', 'unarchive', '206'],
    ['orphan', 'delete', '207'],
    ['orphan', 'archive', '208'],
    ['orphan', 'unarchive', '209'],
  ] as const)(
    'maintains %s transcripts through %s in qualified and owner-routed batches',
    async (shape, action, suffix) => {
      await withRuntimeDir(async () => {
        const state = action === 'unarchive' ? 'archived' : 'active';
        const qualifiedId = `550e8400-e29b-41d4-a716-446655440${suffix}`;
        const unqualifiedId = `550e8400-e29b-41d4-a716-446655441${suffix}`;
        const qualifiedFixture = await writeLifecycleFixture({
          sessionId: qualifiedId,
          shape,
          state,
        });
        const unqualifiedFixture = await writeLifecycleFixture({
          sessionId: unqualifiedId,
          shape,
          state,
        });
        const { app } = makeHarness({
          secondaryProvenance: 'live-conversation',
          secondaryRuntimeBaseDir: Storage.getRuntimeBaseDir(),
          secondarySummaries: [],
        });

        const qualified = await request(app)
          .post(`/workspaces/secondary-id/sessions/${action}`)
          .set('Host', host())
          .send({ sessionIds: [qualifiedId] });
        const unqualified = await request(app)
          .post(`/sessions/${action}`)
          .set('Host', host())
          .send({ sessionIds: [unqualifiedId] });

        expect(qualified.status).toBe(200);
        expect(unqualified.status).toBe(200);
        const successKey =
          action === 'delete'
            ? 'removed'
            : action === 'archive'
              ? 'archived'
              : 'unarchived';
        expect(qualified.body).toMatchObject({
          [successKey]: [qualifiedId],
          notFound: [],
          errors: [],
        });
        expect(unqualified.body).toMatchObject({
          [successKey]: [unqualifiedId],
          notFound: [],
          errors: [],
        });

        for (const [sessionId, fixture] of [
          [qualifiedId, qualifiedFixture],
          [unqualifiedId, unqualifiedFixture],
        ] as const) {
          if (action === 'delete') {
            await expect(fsp.stat(fixture.activePath)).rejects.toMatchObject({
              code: 'ENOENT',
            });
            await expect(fsp.stat(fixture.archivedPath)).rejects.toMatchObject({
              code: 'ENOENT',
            });
            continue;
          }
          const targetPath =
            action === 'archive' ? fixture.archivedPath : fixture.activePath;
          const sourcePath =
            action === 'archive' ? fixture.activePath : fixture.archivedPath;
          await expect(fsp.readFile(targetPath)).resolves.toEqual(
            fixture.contents,
          );
          await expect(fsp.stat(sourcePath)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          expect(path.basename(targetPath)).toBe(`${sessionId}.jsonl`);
        }
      });
    },
  );

  it.each([
    ['qualified', '/workspaces/secondary-id/sessions/archive'],
    ['owner-routed', '/sessions/archive'],
  ])(
    'keeps non-regular lifecycle failures scoped to their %s batch item',
    async (_kind, route) => {
      await withRuntimeDir(async () => {
        const healthyId = '550e8400-e29b-41d4-a716-446655440211';
        const invalidId = '550e8400-e29b-41d4-a716-446655440212';
        const healthy = await writeLifecycleFixture({
          sessionId: healthyId,
          shape: 'orphan',
          state: 'active',
        });
        const invalidPath = path.join(
          path.dirname(healthy.activePath),
          `${invalidId}.jsonl`,
        );
        await fsp.mkdir(invalidPath);
        const { app } = makeHarness({
          secondaryProvenance: 'live-conversation',
          secondaryRuntimeBaseDir: Storage.getRuntimeBaseDir(),
          secondarySummaries: [],
        });

        const response = await request(app)
          .post(route)
          .set('Host', host())
          .send({ sessionIds: [healthyId, invalidId] });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
          archived: [healthyId],
          notFound: [],
          errors: [
            {
              sessionId: invalidId,
              error: 'Session operation failed.',
            },
          ],
        });
        await expect(fsp.stat(healthy.activePath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(fsp.readFile(healthy.archivedPath)).resolves.toEqual(
          healthy.contents,
        );
        expect((await fsp.lstat(invalidPath)).isDirectory()).toBe(true);
      });
    },
  );

  it.each([
    [
      'filesystem',
      'qualified',
      '/workspaces/secondary-id/sessions/archive',
      () => Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    ],
    [
      'filesystem',
      'owner-routed',
      '/sessions/archive',
      () => Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    ],
    [
      'transcript-change',
      'qualified',
      '/workspaces/secondary-id/sessions/archive',
      () => new SessionTranscriptChangedError(),
    ],
    [
      'transcript-change',
      'owner-routed',
      '/sessions/archive',
      () => new SessionTranscriptChangedError(),
    ],
  ])(
    'keeps %s classifier failures scoped to their %s batch item',
    async (_failureKind, _routeKind, route, createError) => {
      await withRuntimeDir(async () => {
        const healthyId = '550e8400-e29b-41d4-a716-446655440217';
        const invalidId = '550e8400-e29b-41d4-a716-446655440218';
        const healthy = await writeLifecycleFixture({
          sessionId: healthyId,
          shape: 'orphan',
          state: 'active',
        });
        const invalid = await writeLifecycleFixture({
          sessionId: invalidId,
          shape: 'orphan',
          state: 'active',
        });
        const originalClassifier =
          SessionService.prototype.getMaintainableSessionLocation;
        const classifier = vi
          .spyOn(SessionService.prototype, 'getMaintainableSessionLocation')
          .mockImplementation(async function (this: SessionService, sessionId) {
            if (
              this.getProjectRoot() === SECONDARY_CWD &&
              sessionId === invalidId
            ) {
              throw createError();
            }
            return originalClassifier.call(this, sessionId);
          });
        const { app } = makeHarness({
          secondaryProvenance: 'live-conversation',
          secondaryRuntimeBaseDir: Storage.getRuntimeBaseDir(),
          secondarySummaries: [],
        });

        const response = await (async () => {
          try {
            return await request(app)
              .post(route)
              .set('Host', host())
              .send({ sessionIds: [healthyId, invalidId] });
          } finally {
            classifier.mockRestore();
          }
        })();

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
          archived: [healthyId],
          notFound: [],
          errors: [
            {
              sessionId: invalidId,
              error: 'Session operation failed.',
            },
          ],
        });
        await expect(fsp.stat(healthy.activePath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(fsp.readFile(healthy.archivedPath)).resolves.toEqual(
          healthy.contents,
        );
        await expect(fsp.readFile(invalid.activePath)).resolves.toEqual(
          invalid.contents,
        );
        await expect(fsp.stat(invalid.archivedPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      });
    },
  );

  it('does not fall back to primary for mixed foreign and local internal storage', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440215';
      const fixture = await writeLifecycleFixture({
        sessionId,
        shape: 'orphan',
        state: 'archived',
      });
      const foreignActive = `${JSON.stringify({
        sessionId,
        cwd: PRIMARY_CWD,
        uuid: 'foreign-u1',
        parentUuid: null,
        timestamp: '2026-07-08T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'foreign' }] },
      })}\n`;
      await fsp.writeFile(fixture.activePath, foreignActive);
      const { app, primaryBridge, secondaryBridge } = makeHarness({
        secondaryProvenance: 'live-conversation',
        secondaryRuntimeBaseDir: Storage.getRuntimeBaseDir(),
        secondarySummaries: [],
      });

      const response = await request(app)
        .post('/sessions/archive')
        .set('Host', host())
        .send({ sessionIds: [sessionId], resolveConflicts: true });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        archived: [],
        notFound: [],
        errors: [
          {
            sessionId,
            error: 'Session operation failed.',
          },
        ],
      });
      expect(primaryBridge.closeCalls).toEqual([]);
      expect(secondaryBridge.closeCalls).toEqual([sessionId]);
      await expect(fsp.readFile(fixture.activePath, 'utf8')).resolves.toBe(
        foreignActive,
      );
      await expect(fsp.readFile(fixture.archivedPath)).resolves.toEqual(
        fixture.contents,
      );
    });
  });

  it.each([
    ['qualified', '/workspaces/secondary-id/sessions/archive'],
    ['owner-routed', '/sessions/archive'],
  ])(
    'keeps indeterminate lifecycle ownership scoped to its %s batch item',
    async (_kind, route) => {
      await withRuntimeDir(async () => {
        const healthyId = '550e8400-e29b-41d4-a716-446655440213';
        const invalidId = '550e8400-e29b-41d4-a716-446655440214';
        const healthy = await writeLifecycleFixture({
          sessionId: healthyId,
          shape: 'orphan',
          state: 'active',
        });
        const invalidPath = path.join(
          path.dirname(healthy.activePath),
          `${invalidId}.jsonl`,
        );
        await fsp.writeFile(
          invalidPath,
          `{"sessionId":"${invalidId}","filler":"${'x'.repeat(2 * 1024 * 1024)}`,
        );
        const { app } = makeHarness({
          secondaryProvenance: 'live-conversation',
          secondaryRuntimeBaseDir: Storage.getRuntimeBaseDir(),
          secondarySummaries: [],
        });

        const response = await request(app)
          .post(route)
          .set('Host', host())
          .send({ sessionIds: [healthyId, invalidId] });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
          archived: [healthyId],
          notFound: [],
          errors: [
            {
              sessionId: invalidId,
              error: 'Session operation failed.',
            },
          ],
        });
        await expect(fsp.stat(healthy.activePath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(fsp.readFile(healthy.archivedPath)).resolves.toEqual(
          healthy.contents,
        );
        await expect(fsp.stat(invalidPath)).resolves.toBeDefined();
      });
    },
  );

  it('keeps the private directory canonical when restoring a mixed-case transcript', async () => {
    const storageSessionId = LIVE_PROJECTLESS_TASK_ID.toUpperCase();
    await withStoredProjectlessLiveTasks(
      [storageSessionId],
      async (runtimeDir) => {
        const materializeConversationDirectory = vi.fn(
          async (sessionId: string) =>
            path.join(SECONDARY_CWD, `conversation-${sessionId}`),
        );
        const { app } = makeHarness({
          secondaryProvenance: 'live-conversation',
          secondaryChangeSessionCwdImpl: async (sessionId, req) => ({
            sessionId,
            previousCwd: SECONDARY_CWD,
            newCwd: req.path,
            warnings: [],
          }),
          liveConversationWorkspace: {
            materializeConversationDirectory,
          } as unknown as ConversationWorkspace,
          secondaryRuntimeBaseDir: runtimeDir,
        });

        const response = await request(app)
          .post(`/session/${LIVE_PROJECTLESS_TASK_ID}/load`)
          .set('Host', host())
          .send({ cwd: SECONDARY_CWD });

        expect(response.status).toBe(200);
        // Storage keeps the persisted spelling, but the directory follows the
        // live entry the bridge registers under the canonical id — otherwise a
        // later Live call would materialize a second, empty directory.
        expect(materializeConversationDirectory).toHaveBeenCalledWith(
          LIVE_PROJECTLESS_TASK_ID,
        );
        expect(materializeConversationDirectory).not.toHaveBeenCalledWith(
          storageSessionId,
        );
      },
    );
  });

  it('rejects an unqualified batch mutation when a Live session id collides with an ordinary transcript', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440110';
      const runtimeDir = Storage.getRuntimeBaseDir();
      const storedAt = new Date('2026-07-08T00:00:00.000Z');
      await writeStoredSession({
        sessionId,
        cwd: PRIMARY_CWD,
        timestamp: storedAt.toISOString(),
        prompt: 'ordinary collision',
        mtime: storedAt,
      });
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: storedAt.toISOString(),
        prompt: 'Live collision',
        mtime: storedAt,
        sourceType: 'default',
        sourceId: `${LIVE_SESSION_SOURCE_PREFIX}${sessionId}`,
      });
      const { app } = makeHarness({
        secondaryProvenance: 'live-conversation',
        secondaryRuntimeBaseDir: runtimeDir,
      });

      const response = await request(app)
        .post('/sessions/archive')
        .set('Host', host())
        .send({ sessionIds: [sessionId] });

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        code: 'ambiguous_session_owner',
        sessionId,
      });
      expect(response.body).not.toHaveProperty('workspaceIds');
      await expect(
        new SessionService(PRIMARY_CWD).getSessionLocation(sessionId),
      ).resolves.toBe('active');
      await expect(
        new SessionService(SECONDARY_CWD).getSessionLocation(sessionId),
      ).resolves.toBe('active');
    });
  });

  it('rejects an internal physical-only owner that collides with an ordinary live-only owner', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440111';
      const fixture = await writeLifecycleFixture({
        sessionId,
        shape: 'damaged',
        state: 'active',
      });
      const { app } = makeHarness({
        primarySummaries: [makeSummary(sessionId, PRIMARY_CWD)],
        secondarySummaries: [],
        secondaryProvenance: 'live-conversation',
        secondaryRuntimeBaseDir: Storage.getRuntimeBaseDir(),
      });

      const response = await request(app)
        .post('/sessions/archive')
        .set('Host', host())
        .send({ sessionIds: [sessionId] });

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        code: 'ambiguous_session_owner',
        sessionId,
      });
      await expect(fsp.readFile(fixture.activePath)).resolves.toEqual(
        fixture.contents,
      );
      await expect(fsp.stat(fixture.archivedPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('rejects a cross-workspace lifecycle batch independently of id order', async () => {
    await withRuntimeDir(async () => {
      const ordinaryId = '550e8400-e29b-41d4-a716-446655440113';
      const internalId = '550e8400-e29b-41d4-a716-446655440114';
      const fixture = await writeLifecycleFixture({
        sessionId: internalId,
        shape: 'damaged',
        state: 'active',
      });
      const { app } = makeHarness({
        primarySummaries: [makeSummary(ordinaryId, PRIMARY_CWD)],
        secondarySummaries: [],
        secondaryProvenance: 'live-conversation',
        secondaryRuntimeBaseDir: Storage.getRuntimeBaseDir(),
      });

      for (const sessionIds of [
        [ordinaryId, internalId],
        [internalId, ordinaryId],
      ]) {
        const response = await request(app)
          .post('/sessions/archive')
          .set('Host', host())
          .send({ sessionIds });

        expect(response.status).toBe(409);
        expect(response.body.code).toBe('session_workspace_conflict');
      }
      await expect(fsp.readFile(fixture.activePath)).resolves.toEqual(
        fixture.contents,
      );
      await expect(fsp.stat(fixture.archivedPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('rejects an internal physical-only owner when an ordinary persisted owner is transitioning', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440112';
      await writeStoredSession({
        sessionId,
        cwd: PRIMARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'transitioning ordinary collision',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      const fixture = await writeLifecycleFixture({
        sessionId,
        shape: 'damaged',
        state: 'active',
      });
      const { app, registry } = makeHarness({
        primarySummaries: [],
        secondarySummaries: [],
        secondaryProvenance: 'live-conversation',
        secondaryRuntimeBaseDir: Storage.getRuntimeBaseDir(),
      });
      expect(registry.beginReplacement(registry.primaryEntry, 'policy-2')).toBe(
        true,
      );

      const response = await request(app)
        .post('/sessions/archive')
        .set('Host', host())
        .send({ sessionIds: [sessionId] });

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('workspace_runtime_unavailable');
      await expect(fsp.readFile(fixture.activePath)).resolves.toEqual(
        fixture.contents,
      );
      await expect(fsp.stat(fixture.archivedPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('rejects an ordinary batch when the primary generation changes under the lifecycle lock', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440210';
      await writeStoredSession({
        sessionId,
        cwd: PRIMARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'primary generation target',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      const { app, registry, primaryBridge } = makeHarness({
        primarySummaries: [],
      });
      const replacementBridge = makeBridge(PRIMARY_CWD, []);
      const replacement = makeRuntime({
        workspaceId: 'primary-id',
        workspaceCwd: PRIMARY_CWD,
        primary: true,
        trusted: true,
        bridge: replacementBridge,
      });
      const runExclusive = vi
        .spyOn(SessionArchiveCoordinator.prototype, 'runExclusiveMany')
        .mockImplementationOnce(async (_ids, run) => {
          expect(
            registry.beginReplacement(registry.primaryEntry, 'policy-2'),
          ).toBe(true);
          registry.activateReplacement(
            registry.primaryEntry,
            replacement,
            'policy-2',
          );
          return run();
        });

      try {
        const response = await request(app)
          .post('/sessions/archive')
          .set('Host', host())
          .send({ sessionIds: [sessionId] });

        expect(response.status).toBe(503);
        expect(response.body.code).toBe('workspace_runtime_unavailable');
        expect(primaryBridge.closeCalls).toEqual([]);
        expect(replacementBridge.closeCalls).toEqual([]);
        await expect(
          new SessionService(PRIMARY_CWD).getSessionLocation(sessionId),
        ).resolves.toBe('active');
      } finally {
        runExclusive.mockRestore();
      }
    });
  });

  it('opens attached active Live workers without waiting for cwd relocation', async () => {
    await withStoredLiveWorkers(
      [LIVE_ACTIVE_LOAD_ID, LIVE_ACTIVE_RESUME_ID],
      async (runtimeDir) => {
        const materializeConversationDirectory = vi.fn(
          async (sessionId: string) =>
            path.join(SECONDARY_CWD, `conversation-${sessionId}`),
        );
        for (const { action, sessionId } of [
          { action: 'load', sessionId: LIVE_ACTIVE_LOAD_ID },
          { action: 'resume', sessionId: LIVE_ACTIVE_RESUME_ID },
        ] as const) {
          const { app, secondaryBridge } = makeHarness({
            secondaryProvenance: 'live-conversation',
            secondaryRestoreAttached: true,
            secondaryRestoreHasActivePrompt: true,
            secondaryRestoreCurrentCwd: path.join(
              SECONDARY_CWD,
              `conversation-${sessionId}`,
            ),
            liveConversationWorkspace: {
              materializeConversationDirectory,
            } as unknown as ConversationWorkspace,
            secondaryRuntimeBaseDir: runtimeDir,
          });

          const response = await request(app)
            .post(`/session/${sessionId}/${action}`)
            .set('Host', host())
            .send({ cwd: SECONDARY_CWD });
          expect(response.status).toBe(200);
          expect(response.body).toMatchObject({
            attached: true,
            hasActivePrompt: true,
          });
          expect(secondaryBridge.cwdChangeCalls).toEqual([]);
        }
        expect(materializeConversationDirectory).toHaveBeenCalledTimes(2);
      },
    );
  });

  it('fails closed and rolls back a cold Live restore when conversation relocation is rejected', async () => {
    await withStoredLiveCoordinators(
      [LIVE_COLD_REJECTED_ID],
      async (runtimeDir) => {
        const operationLog: string[] = [];
        const { app, secondaryBridge } = makeHarness({
          secondaryProvenance: 'live-conversation',
          secondaryOperationLog: operationLog,
          secondaryChangeSessionCwdImpl: async (sessionId, req) => ({
            sessionId,
            previousCwd: SECONDARY_CWD,
            newCwd: `${req.path}-rejected`,
            warnings: [],
          }),
          liveConversationWorkspace: {
            materializeConversationDirectory: async (sessionId: string) => {
              operationLog.push(`materialize:${sessionId}`);
              return path.join(SECONDARY_CWD, `conversation-${sessionId}`);
            },
          } as unknown as ConversationWorkspace,
          secondaryRuntimeBaseDir: runtimeDir,
        });

        const response = await request(app)
          .post(`/session/${LIVE_COLD_REJECTED_ID}/resume`)
          .set('Host', host())
          .send({ cwd: SECONDARY_CWD });

        expect(response.status).toBe(500);
        expect(secondaryBridge.killCalls).toEqual([LIVE_COLD_REJECTED_ID]);
        expect(operationLog).toEqual([
          `materialize:${LIVE_COLD_REJECTED_ID}`,
          `resume:${LIVE_COLD_REJECTED_ID}`,
          `change:${LIVE_COLD_REJECTED_ID}`,
          `kill:${LIVE_COLD_REJECTED_ID}`,
        ]);
        expect(secondaryBridge.closeCalls).toEqual([]);
        expect(secondaryBridge.detachCalls).toEqual([]);
      },
    );
  });

  it('only detaches its lease when an attached cold Live restore relocation is rejected', async () => {
    await withStoredLiveCoordinators(
      [LIVE_COLD_ATTACHED_ID],
      async (runtimeDir) => {
        const { app, secondaryBridge } = makeHarness({
          secondaryProvenance: 'live-conversation',
          secondaryRestoreAttached: true,
          secondaryChangeSessionCwdImpl: async (sessionId, req) => ({
            sessionId,
            previousCwd: SECONDARY_CWD,
            newCwd: `${req.path}-rejected`,
            warnings: [],
          }),
          liveConversationWorkspace: {
            materializeConversationDirectory: async (sessionId: string) =>
              path.join(SECONDARY_CWD, `conversation-${sessionId}`),
          } as unknown as ConversationWorkspace,
          secondaryRuntimeBaseDir: runtimeDir,
        });

        const response = await request(app)
          .post(`/session/${LIVE_COLD_ATTACHED_ID}/resume`)
          .set('Host', host())
          .send({ cwd: SECONDARY_CWD });

        expect(response.status).toBe(500);
        expect(secondaryBridge.detachCalls).toEqual([LIVE_COLD_ATTACHED_ID]);
        expect(secondaryBridge.killCalls).toEqual([]);
        expect(secondaryBridge.closeCalls).toEqual([]);
      },
    );
  });

  it('does not force-close a cold Live restore when zero-attach reap is rejected', async () => {
    await withStoredLiveCoordinators(
      [LIVE_COLD_REAP_REJECTED_ID],
      async (runtimeDir) => {
        const { app, secondaryBridge } = makeHarness({
          secondaryProvenance: 'live-conversation',
          secondaryKillSessionResult: false,
          secondaryChangeSessionCwdImpl: async (sessionId, req) => ({
            sessionId,
            previousCwd: SECONDARY_CWD,
            newCwd: `${req.path}-rejected`,
            warnings: [],
          }),
          liveConversationWorkspace: {
            materializeConversationDirectory: async (sessionId: string) =>
              path.join(SECONDARY_CWD, `conversation-${sessionId}`),
          } as unknown as ConversationWorkspace,
          secondaryRuntimeBaseDir: runtimeDir,
        });

        const response = await request(app)
          .post(`/session/${LIVE_COLD_REAP_REJECTED_ID}/resume`)
          .set('Host', host())
          .send({ cwd: SECONDARY_CWD });

        expect(response.status).toBe(500);
        expect(secondaryBridge.killCalls).toEqual([LIVE_COLD_REAP_REJECTED_ID]);
        expect(secondaryBridge.closeCalls).toEqual([]);
      },
    );
  });

  it('does not restore a cold Live session when conversation workspace validation fails', async () => {
    await withStoredLiveCoordinators(
      [LIVE_INVALID_CHILD_ID],
      async (runtimeDir) => {
        const { app, secondaryBridge } = makeHarness({
          secondaryProvenance: 'live-conversation',
          secondaryChangeSessionCwdImpl: async (sessionId, req) => ({
            sessionId,
            previousCwd: SECONDARY_CWD,
            newCwd: req.path,
            warnings: [],
          }),
          liveConversationWorkspace: {
            materializeConversationDirectory: async () => {
              throw new Error(
                'Live conversation child was replaced by a symlink.',
              );
            },
          } as unknown as ConversationWorkspace,
          secondaryRuntimeBaseDir: runtimeDir,
        });

        const response = await request(app)
          .post(`/session/${LIVE_INVALID_CHILD_ID}/load`)
          .set('Host', host())
          .send({ cwd: SECONDARY_CWD });

        expect(response.status).toBe(500);
        expect(secondaryBridge.restoreCalls).toEqual([]);
        expect(secondaryBridge.cwdChangeCalls).toEqual([]);
        expect(secondaryBridge.killCalls).toEqual([]);
      },
    );
  });

  it('rejects unknown and untrusted restore cwd before touching a bridge', async () => {
    const unknown = makeHarness();
    const unknownRes = await request(unknown.app)
      .post('/session/unknown-restore/load')
      .set('Host', host())
      .send({ cwd: UNKNOWN_CWD });

    expect(unknownRes.status).toBe(400);
    expect(unknownRes.body.code).toBe('workspace_mismatch');
    expect(unknownRes.body.workspaceCount).toBe(2);
    expect(unknownRes.body.boundWorkspace).toBe(PRIMARY_CWD);
    expect(unknownRes.body.requestedWorkspace).toBe(UNKNOWN_CWD);
    expect(unknown.primaryBridge.restoreCalls).toEqual([]);
    expect(unknown.secondaryBridge.restoreCalls).toEqual([]);

    const daemonLog = makeDaemonLog();
    const untrusted = makeHarness({ secondaryTrusted: false, daemonLog });
    const untrustedRes = await request(untrusted.app)
      .post('/session/untrusted-restore/resume')
      .set('Host', host())
      .send({ cwd: SECONDARY_CWD });

    expect(untrustedRes.status).toBe(403);
    expect(untrustedRes.body.code).toBe('untrusted_workspace');
    expect(untrustedRes.body.error).toBe('Workspace is not trusted.');
    expect(untrustedRes.body.workspaceCwd).toBe(SECONDARY_CWD);
    expect(untrustedRes.body.workspaceId).toBe('secondary-id');
    expect(untrusted.primaryBridge.restoreCalls).toEqual([]);
    expect(untrusted.secondaryBridge.restoreCalls).toEqual([]);
    expect(daemonLog.warn).toHaveBeenCalledWith(
      'session routing failed',
      expect.objectContaining({
        route: 'POST /session/:id/resume',
        resolutionKind: 'untrusted_workspace',
        workspaceCwd: SECONDARY_CWD,
      }),
    );
  });

  it.each([
    {
      suffix: 'branch',
      route: 'POST /session/:id/branch',
      body: { name: 'next' },
    },
    {
      suffix: 'fork',
      route: 'POST /session/:id/fork',
      body: { directive: 'review this' },
    },
    {
      suffix: 'cd',
      route: 'POST /session/:id/cd',
      body: { path: path.resolve(path.sep, 'work', 'next') },
    },
  ])(
    'rejects $route for a non-primary live-session owner',
    async ({ suffix, route, body }) => {
      const daemonLog = makeDaemonLog();
      const { app, primaryBridge, secondaryBridge } = makeHarness({
        daemonLog,
      });

      const res = await request(app)
        .post(`/session/22222222-2222-4222-a222-222222222222/${suffix}`)
        .set('Host', host())
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: `Route "${route}" is only available for primary workspace sessions.`,
        code: 'non_primary_session_route_not_supported',
        sessionId: '22222222-2222-4222-a222-222222222222',
        workspaceId: 'secondary-id',
        workspaceCwd: SECONDARY_CWD,
        route,
      });
      expect(primaryBridge.primaryOnlyMutationCalls).toEqual([]);
      expect(secondaryBridge.primaryOnlyMutationCalls).toEqual([]);
      expect(daemonLog.warn).toHaveBeenCalledWith('session routing failed', {
        route,
        resolutionKind: 'non_primary_session_route_not_supported',
        sessionId: '22222222-2222-4222-a222-222222222222',
        workspaceId: 'secondary-id',
        workspaceCwd: SECONDARY_CWD,
      });
    },
  );

  it('does not expose the Conversations runtime identity in an unsupported session route response', async () => {
    const { app } = makeHarness({
      secondaryProvenance: 'live-conversation',
    });

    const response = await request(app)
      .post('/session/22222222-2222-4222-a222-222222222222/cd')
      .set('Host', host())
      .send({ path: path.resolve(path.sep, 'work', 'next') });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error:
        'Route "POST /session/:id/cd" is only available for primary workspace sessions.',
      code: 'non_primary_session_route_not_supported',
      sessionId: '22222222-2222-4222-a222-222222222222',
      route: 'POST /session/:id/cd',
    });
  });

  it.each([
    {
      suffix: 'branch',
      body: { name: 'next' },
      expectedStatus: 201,
      mutation: 'branch',
    },
    {
      suffix: 'side-task',
      body: { name: 'research' },
      expectedStatus: 201,
      mutation: 'side-task',
    },
    {
      suffix: 'fork',
      body: { directive: 'review this' },
      expectedStatus: 202,
      mutation: 'fork',
    },
  ] as const)(
    'routes an internal owner session $suffix operation to its bridge',
    async ({ suffix, body, expectedStatus, mutation }) => {
      const { app, primaryBridge, secondaryBridge } = makeHarness({
        secondaryProvenance: 'live-conversation',
      });

      const response = await request(app)
        .post(`/session/22222222-2222-4222-a222-222222222222/${suffix}`)
        .set('Host', host())
        .send(body);

      expect(response.status).toBe(expectedStatus);
      expect(primaryBridge.primaryOnlyMutationCalls).toEqual([]);
      expect(secondaryBridge.primaryOnlyMutationCalls).toEqual([
        { route: mutation, sessionId: '22222222-2222-4222-a222-222222222222' },
      ]);
    },
  );

  it('routes POST /session/:id/model to the owning non-primary workspace bridge', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness();

    const res = await request(app)
      .post('/session/22222222-2222-4222-a222-222222222222/model')
      .set('Host', host())
      .set('X-Qwen-Client-Id', 'client-1')
      .send({ modelId: 'qwen3-coder' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ _meta: { applied: true } });
    expect(secondaryBridge.setModelCalls).toHaveLength(1);
    expect(secondaryBridge.setModelCalls[0]?.sessionId).toBe(
      '22222222-2222-4222-a222-222222222222',
    );
    expect(secondaryBridge.setModelCalls[0]?.req.modelId).toBe('qwen3-coder');
    expect(secondaryBridge.setModelCalls[0]?.context).toEqual({
      clientId: 'client-1',
    });
    // Owner-scoped: the mutation must land on the secondary bridge only, never
    // the primary one.
    expect(primaryBridge.setModelCalls).toEqual([]);
  });

  it('routes POST /session/:id/approval-mode to the owning non-primary workspace bridge', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness();

    const res = await request(app)
      .post('/session/22222222-2222-4222-a222-222222222222/approval-mode')
      .set('Host', host())
      .send({ mode: 'yolo', persist: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sessionId: '22222222-2222-4222-a222-222222222222',
      mode: 'yolo',
      persisted: true,
    });
    expect(secondaryBridge.setApprovalModeCalls).toHaveLength(1);
    expect(secondaryBridge.setApprovalModeCalls[0]).toMatchObject({
      sessionId: '22222222-2222-4222-a222-222222222222',
      mode: 'yolo',
      opts: { persist: true },
    });
    expect(primaryBridge.setApprovalModeCalls).toEqual([]);
  });

  it('still rejects model/approval-mode mutations on an untrusted non-primary session', async () => {
    // Opening these routes to non-primary owners must not bypass the trust
    // gate: an untrusted workspace runtime is refused before the bridge runs.
    const { app, secondaryBridge } = makeHarness({ secondaryTrusted: false });

    const modelRes = await request(app)
      .post('/session/22222222-2222-4222-a222-222222222222/model')
      .set('Host', host())
      .send({ modelId: 'qwen3-coder' });
    expect(modelRes.status).toBe(403);
    expect(modelRes.body.code).toBe('untrusted_workspace');
    expect(secondaryBridge.setModelCalls).toEqual([]);

    const approvalRes = await request(app)
      .post('/session/22222222-2222-4222-a222-222222222222/approval-mode')
      .set('Host', host())
      .send({ mode: 'yolo' });
    expect(approvalRes.status).toBe(403);
    expect(approvalRes.body.code).toBe('untrusted_workspace');
    expect(secondaryBridge.setApprovalModeCalls).toEqual([]);
  });

  it('routes owner-local actions to the owning non-primary workspace bridge', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness({
      token: TEST_TOKEN,
    });

    const metadataRes = await request(app)
      .patch('/session/22222222-2222-4222-a222-222222222222/metadata')
      .set('Host', host())
      .set('Authorization', TEST_AUTHORIZATION)
      .set('X-Qwen-Client-Id', 'secondary-client')
      .send({ displayName: 'renamed' });
    expect(metadataRes.status).toBe(200);
    expect(metadataRes.body).toEqual({
      sessionId: '22222222-2222-4222-a222-222222222222',
      displayName: `${SECONDARY_CWD}:renamed`,
    });

    const recapRes = await request(app)
      .post('/session/22222222-2222-4222-a222-222222222222/recap')
      .set('Host', host())
      .set('Authorization', TEST_AUTHORIZATION)
      .set('X-Qwen-Client-Id', 'secondary-client')
      .send({});
    expect(recapRes.status).toBe(200);
    expect(recapRes.body).toEqual({
      sessionId: '22222222-2222-4222-a222-222222222222',
      recap: `${SECONDARY_CWD}:recap`,
    });

    const btwRes = await request(app)
      .post('/session/22222222-2222-4222-a222-222222222222/btw')
      .set('Host', host())
      .set('Authorization', TEST_AUTHORIZATION)
      .set('X-Qwen-Client-Id', 'secondary-client')
      .send({ question: '  why?  ' });
    expect(btwRes.status).toBe(200);
    expect(btwRes.body).toEqual({
      sessionId: '22222222-2222-4222-a222-222222222222',
      answer: `${SECONDARY_CWD}:answer`,
    });

    const midTurnRes = await request(app)
      .post('/session/22222222-2222-4222-a222-222222222222/mid-turn-message')
      .set('Host', host())
      .set('Authorization', TEST_AUTHORIZATION)
      .set('X-Qwen-Client-Id', 'secondary-client')
      .send({ message: '  remember this  ' });
    expect(midTurnRes.status).toBe(200);
    expect(midTurnRes.body).toEqual({
      accepted: true,
      messageId: 'mid-secondary',
    });

    const removeMidTurnRes = await request(app)
      .delete(
        '/session/22222222-2222-4222-a222-222222222222/mid-turn-messages/mid-secondary',
      )
      .set('Host', host())
      .set('Authorization', TEST_AUTHORIZATION)
      .set('X-Qwen-Client-Id', 'secondary-client');
    expect(removeMidTurnRes.status).toBe(200);
    expect(removeMidTurnRes.body).toEqual({ removed: true });

    const taskCancelRes = await request(app)
      .post('/session/22222222-2222-4222-a222-222222222222/tasks/task-1/cancel')
      .set('Host', host())
      .set('Authorization', TEST_AUTHORIZATION)
      .send({ kind: 'shell' });
    expect(taskCancelRes.status).toBe(200);
    expect(taskCancelRes.body).toEqual({ cancelled: true });

    const goalClearRes = await request(app)
      .post('/session/22222222-2222-4222-a222-222222222222/goal/clear')
      .set('Host', host())
      .set('Authorization', TEST_AUTHORIZATION)
      .send({});
    expect(goalClearRes.status).toBe(200);
    expect(goalClearRes.body).toEqual({
      cleared: true,
      condition: SECONDARY_CWD,
    });

    expect(secondaryBridge.metadataCalls).toEqual([
      {
        sessionId: '22222222-2222-4222-a222-222222222222',
        metadata: { displayName: 'renamed' },
        context: { clientId: 'secondary-client' },
      },
    ]);
    expect(secondaryBridge.recapCalls).toEqual([
      {
        sessionId: '22222222-2222-4222-a222-222222222222',
        context: { clientId: 'secondary-client' },
      },
    ]);
    expect(secondaryBridge.btwCalls).toEqual([
      expect.objectContaining({
        sessionId: '22222222-2222-4222-a222-222222222222',
        question: 'why?',
        signal: expect.any(AbortSignal),
        context: { clientId: 'secondary-client' },
      }),
    ]);
    expect(secondaryBridge.btwCalls[0]?.signal?.aborted).toBe(false);
    expect(secondaryBridge.midTurnMessageCalls).toEqual([
      {
        sessionId: '22222222-2222-4222-a222-222222222222',
        message: 'remember this',
        context: { clientId: 'secondary-client' },
      },
    ]);
    expect(secondaryBridge.removeMidTurnMessageCalls).toEqual([
      {
        sessionId: '22222222-2222-4222-a222-222222222222',
        messageId: 'mid-secondary',
        context: { clientId: 'secondary-client' },
      },
    ]);
    expect(secondaryBridge.taskCancelCalls).toEqual([
      {
        sessionId: '22222222-2222-4222-a222-222222222222',
        taskId: 'task-1',
        taskKind: 'shell',
      },
    ]);
    expect(secondaryBridge.goalClearCalls).toEqual([
      '22222222-2222-4222-a222-222222222222',
    ]);

    for (const calls of [
      primaryBridge.metadataCalls,
      primaryBridge.recapCalls,
      primaryBridge.btwCalls,
      primaryBridge.midTurnMessageCalls,
      primaryBridge.removeMidTurnMessageCalls,
      primaryBridge.taskCancelCalls,
      primaryBridge.goalClearCalls,
    ]) {
      expect(calls).toEqual([]);
    }
  });

  it('persists a cross-workspace pr sidecar in the OWNING workspace chats dir', async () => {
    // A primary-route metadata PATCH against a secondary-owned session must
    // write the sidecar under the SECONDARY runtime — landing it under the
    // primary would hide the binding from the owning workspace's listing.
    const { app, secondaryBridge } = makeHarness({ token: TEST_TOKEN });
    const pr = { number: 9517, url: 'https://github.com/o/r/pull/9517' };
    const secondaryPath = new SessionService(
      SECONDARY_CWD,
    ).getPrSessionPathForArchiveState(
      '22222222-2222-4222-a222-222222222222',
      'active',
    );
    const primaryPath = new SessionService(
      PRIMARY_CWD,
    ).getPrSessionPathForArchiveState(
      '22222222-2222-4222-a222-222222222222',
      'active',
    );
    await fsp.rm(secondaryPath, { force: true });
    await fsp.rm(primaryPath, { force: true });

    try {
      const res = await request(app)
        .patch('/session/22222222-2222-4222-a222-222222222222/metadata')
        .set('Host', host())
        .set('Authorization', TEST_AUTHORIZATION)
        .set('X-Qwen-Client-Id', 'secondary-client')
        .send({ pr });
      expect(res.status).toBe(200);
      expect(res.body.prs).toEqual([pr]);
      expect(secondaryBridge.metadataCalls[0]?.metadata).toEqual({ pr });

      const persisted = await readSessionPrs(secondaryPath);
      expect(persisted?.map((entry) => entry.number)).toEqual([9517]);
      await expect(fsp.access(primaryPath)).rejects.toThrow();
    } finally {
      await fsp.rm(secondaryPath, { force: true });
    }
  });

  it('routes continue, language, and artifact mutations to the owning non-primary bridge', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness({
      token: TEST_TOKEN,
    });
    const auth = (test: request.Test) =>
      test.set('Host', host()).set('Authorization', TEST_AUTHORIZATION);

    const firstContinue = await auth(
      request(app).post(
        '/session/22222222-2222-4222-a222-222222222222/continue',
      ),
    )
      .set('X-Qwen-Client-Id', 'secondary-client')
      .send({});
    const secondContinue = await auth(
      request(app).post(
        '/session/22222222-2222-4222-a222-222222222222/continue',
      ),
    )
      .set('X-Qwen-Client-Id', 'secondary-client')
      .send({});
    expect(firstContinue.status).toBe(200);
    expect(secondContinue.status).toBe(200);
    expect(firstContinue.body.promptId).toEqual(expect.any(String));
    expect(secondContinue.body.promptId).toEqual(expect.any(String));
    expect(firstContinue.body.promptId).not.toBe('');
    expect(secondContinue.body.promptId).not.toBe('');
    expect(secondContinue.body.promptId).not.toBe(firstContinue.body.promptId);

    const language = await auth(
      request(app).post(
        '/session/22222222-2222-4222-a222-222222222222/language',
      ),
    )
      .set('X-Qwen-Client-Id', 'secondary-client')
      .send({ language: 'zh', syncOutputLanguage: true });
    expect(language.status).toBe(200);
    expect(language.body).toEqual({
      language: 'zh',
      outputLanguage: 'zh',
      refreshed: true,
    });

    const addArtifact = await auth(
      request(app).post(
        '/session/22222222-2222-4222-a222-222222222222/artifacts',
      ),
    )
      .set('X-Qwen-Client-Id', 'secondary-client')
      .send({
        title: 'Secondary artifact',
        url: 'https://example.com/secondary',
        retention: 'ephemeral',
      });
    expect(addArtifact.status).toBe(200);
    expect(addArtifact.body).toMatchObject({
      v: 1,
      sessionId: '22222222-2222-4222-a222-222222222222',
    });

    const removeArtifact = await auth(
      request(app).delete(
        '/session/22222222-2222-4222-a222-222222222222/artifacts/artifact-secondary',
      ),
    ).set('X-Qwen-Client-Id', 'secondary-client');
    expect(removeArtifact.status).toBe(200);
    expect(removeArtifact.body).toMatchObject({
      v: 1,
      sessionId: '22222222-2222-4222-a222-222222222222',
    });

    expect(secondaryBridge.continueCalls).toHaveLength(2);
    for (const call of secondaryBridge.continueCalls) {
      expect(call).toMatchObject({
        sessionId: '22222222-2222-4222-a222-222222222222',
        context: {
          clientId: 'secondary-client',
          promptId: expect.any(String),
        },
      });
    }
    expect(secondaryBridge.languageCalls).toEqual([
      {
        sessionId: '22222222-2222-4222-a222-222222222222',
        params: { language: 'zh', syncOutputLanguage: true },
        context: { clientId: 'secondary-client' },
      },
    ]);
    expect(secondaryBridge.addArtifactCalls).toEqual([
      expect.objectContaining({
        sessionId: '22222222-2222-4222-a222-222222222222',
        artifact: expect.objectContaining({
          title: 'Secondary artifact',
          url: 'https://example.com/secondary',
          retention: 'ephemeral',
        }),
        context: { clientId: 'secondary-client' },
      }),
    ]);
    expect(secondaryBridge.removeArtifactCalls).toEqual([
      {
        sessionId: '22222222-2222-4222-a222-222222222222',
        artifactId: 'artifact-secondary',
        context: { clientId: 'secondary-client' },
      },
    ]);
    expect(primaryBridge.continueCalls).toEqual([]);
    expect(primaryBridge.languageCalls).toEqual([]);
    expect(primaryBridge.addArtifactCalls).toEqual([]);
    expect(primaryBridge.removeArtifactCalls).toEqual([]);
  });

  it('executes strict and non-strict secondary mutations on trusted loopback', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness();

    const responses = await Promise.all([
      request(app)
        .post('/session/22222222-2222-4222-a222-222222222222/continue')
        .set('Host', host())
        .send({}),
      request(app)
        .post('/session/22222222-2222-4222-a222-222222222222/artifacts')
        .set('Host', host())
        .set('X-Qwen-Client-Id', 'secondary-client')
        .send({ title: 'blocked', url: 'https://example.com/blocked' }),
      request(app)
        .delete(
          '/session/22222222-2222-4222-a222-222222222222/artifacts/artifact-secondary',
        )
        .set('Host', host())
        .set('X-Qwen-Client-Id', 'secondary-client'),
    ]);
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);

    const language = await request(app)
      .post('/session/22222222-2222-4222-a222-222222222222/language')
      .set('Host', host())
      .send({ language: 'zh' });
    expect(language.status).toBe(200);
    expect(secondaryBridge.languageCalls).toEqual([
      {
        sessionId: '22222222-2222-4222-a222-222222222222',
        params: { language: 'zh', syncOutputLanguage: false },
      },
    ]);
    expect(primaryBridge.continueCalls).toEqual([]);
    expect(primaryBridge.addArtifactCalls).toEqual([]);
    expect(primaryBridge.removeArtifactCalls).toEqual([]);
    expect(secondaryBridge.continueCalls).toHaveLength(1);
    expect(secondaryBridge.addArtifactCalls).toHaveLength(1);
    expect(secondaryBridge.removeArtifactCalls).toHaveLength(1);
  });

  it('denies secondary continuation in a non-trusted tokenless embed', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness({
      serveOptions: { hostname: '0.0.0.0' },
    });
    const res = await request(app)
      .post('/session/22222222-2222-4222-a222-222222222222/continue')
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('token_required');
    expect(primaryBridge.continueCalls).toEqual([]);
    expect(secondaryBridge.continueCalls).toEqual([]);
  });

  it('rejects remaining mutations for an untrusted non-primary owner', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness({
      secondaryTrusted: false,
      token: TEST_TOKEN,
    });
    const auth = (test: request.Test) =>
      test.set('Host', host()).set('Authorization', TEST_AUTHORIZATION);

    const responses = await Promise.all([
      auth(
        request(app).post(
          '/session/22222222-2222-4222-a222-222222222222/continue',
        ),
      ).send({}),
      auth(
        request(app).post(
          '/session/22222222-2222-4222-a222-222222222222/language',
        ),
      ).send({
        language: 'zh',
      }),
      auth(
        request(app).post(
          '/session/22222222-2222-4222-a222-222222222222/artifacts',
        ),
      )
        .set('X-Qwen-Client-Id', 'secondary-client')
        .send({ title: 'blocked', url: 'https://example.com/blocked' }),
      auth(
        request(app).delete(
          '/session/22222222-2222-4222-a222-222222222222/artifacts/artifact-secondary',
        ),
      ).set('X-Qwen-Client-Id', 'secondary-client'),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      403, 403, 403, 403,
    ]);
    for (const response of responses) {
      expect(response.body.code).toBe('untrusted_workspace');
    }
    for (const bridge of [primaryBridge, secondaryBridge]) {
      expect(bridge.continueCalls).toEqual([]);
      expect(bridge.languageCalls).toEqual([]);
      expect(bridge.addArtifactCalls).toEqual([]);
      expect(bridge.removeArtifactCalls).toEqual([]);
      expect(bridge.removeMidTurnMessageCalls).toEqual([]);
    }
  });

  it('fails closed for missing and ambiguous remaining mutation owners', async () => {
    const missing = makeHarness({ token: TEST_TOKEN });
    const auth = (test: request.Test) =>
      test.set('Host', host()).set('Authorization', TEST_AUTHORIZATION);
    const missingResponses = await Promise.all([
      auth(request(missing.app).post('/session/missing/continue')).send({}),
      auth(request(missing.app).post('/session/missing/language')).send({
        language: 'zh',
      }),
      auth(request(missing.app).post('/session/missing/artifacts'))
        .set('X-Qwen-Client-Id', 'secondary-client')
        .send({ title: 'missing', url: 'https://example.com/missing' }),
      auth(
        request(missing.app).delete('/session/missing/artifacts/artifact-1'),
      ).set('X-Qwen-Client-Id', 'secondary-client'),
      auth(
        request(missing.app).delete(
          '/session/missing/mid-turn-messages/mid-missing',
        ),
      ).set('X-Qwen-Client-Id', 'secondary-client'),
    ]);
    expect(missingResponses.map((response) => response.status)).toEqual([
      404, 404, 404, 404, 404,
    ]);
    for (const response of missingResponses) {
      expect(response.body.code).toBe('session_not_found');
    }
    for (const bridge of [missing.primaryBridge, missing.secondaryBridge]) {
      expect(bridge.continueCalls).toEqual([]);
      expect(bridge.languageCalls).toEqual([]);
      expect(bridge.addArtifactCalls).toEqual([]);
      expect(bridge.removeArtifactCalls).toEqual([]);
      expect(bridge.removeMidTurnMessageCalls).toEqual([]);
    }

    const duplicate = makeSummary('duplicate-session', PRIMARY_CWD);
    const ambiguous = makeHarness({
      token: TEST_TOKEN,
      primarySummaries: [duplicate],
      secondarySummaries: [makeSummary('duplicate-session', SECONDARY_CWD)],
    });
    const ambiguousResponses = await Promise.all([
      auth(
        request(ambiguous.app).post('/session/duplicate-session/language'),
      ).send({ language: 'zh' }),
      auth(
        request(ambiguous.app).post('/session/duplicate-session/continue'),
      ).send({}),
      auth(
        request(ambiguous.app).delete(
          '/session/duplicate-session/mid-turn-messages/mid-duplicate',
        ),
      ),
    ]);
    expect(ambiguousResponses.map((response) => response.status)).toEqual([
      500, 500, 500,
    ]);
    for (const response of ambiguousResponses) {
      expect(response.body.code).toBe('ambiguous_session_owner');
    }
    expect(ambiguous.primaryBridge.languageCalls).toEqual([]);
    expect(ambiguous.secondaryBridge.languageCalls).toEqual([]);
    expect(ambiguous.primaryBridge.continueCalls).toEqual([]);
    expect(ambiguous.secondaryBridge.continueCalls).toEqual([]);
    expect(ambiguous.primaryBridge.removeMidTurnMessageCalls).toEqual([]);
    expect(ambiguous.secondaryBridge.removeMidTurnMessageCalls).toEqual([]);
  });

  it('preserves primary routing for remaining mutations', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness({
      token: TEST_TOKEN,
    });
    const auth = (test: request.Test) =>
      test.set('Host', host()).set('Authorization', TEST_AUTHORIZATION);

    const responses = await Promise.all([
      auth(
        request(app).post(
          '/session/11111111-1111-4111-a111-111111111111/continue',
        ),
      )
        .set('X-Qwen-Client-Id', 'primary-client')
        .send({}),
      auth(
        request(app).post(
          '/session/11111111-1111-4111-a111-111111111111/language',
        ),
      )
        .set('X-Qwen-Client-Id', 'primary-client')
        .send({ language: 'en', syncOutputLanguage: true }),
      auth(
        request(app).post(
          '/session/11111111-1111-4111-a111-111111111111/artifacts',
        ),
      )
        .set('X-Qwen-Client-Id', 'primary-client')
        .send({
          title: 'Primary artifact',
          url: 'https://example.com/primary',
        }),
      auth(
        request(app).delete(
          '/session/11111111-1111-4111-a111-111111111111/artifacts/artifact-primary',
        ),
      ).set('X-Qwen-Client-Id', 'primary-client'),
    ]);
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 200,
    ]);
    expect(primaryBridge.continueCalls).toEqual([
      {
        sessionId: '11111111-1111-4111-a111-111111111111',
        context: {
          clientId: 'primary-client',
          promptId: expect.any(String),
        },
      },
    ]);
    expect(primaryBridge.languageCalls).toEqual([
      {
        sessionId: '11111111-1111-4111-a111-111111111111',
        params: { language: 'en', syncOutputLanguage: true },
        context: { clientId: 'primary-client' },
      },
    ]);
    expect(primaryBridge.addArtifactCalls).toEqual([
      expect.objectContaining({
        sessionId: '11111111-1111-4111-a111-111111111111',
        artifact: expect.objectContaining({
          title: 'Primary artifact',
          url: 'https://example.com/primary',
        }),
        context: { clientId: 'primary-client' },
      }),
    ]);
    expect(primaryBridge.removeArtifactCalls).toEqual([
      {
        sessionId: '11111111-1111-4111-a111-111111111111',
        artifactId: 'artifact-primary',
        context: { clientId: 'primary-client' },
      },
    ]);
    expect(secondaryBridge.continueCalls).toEqual([]);
    expect(secondaryBridge.languageCalls).toEqual([]);
    expect(secondaryBridge.addArtifactCalls).toEqual([]);
    expect(secondaryBridge.removeArtifactCalls).toEqual([]);
  });

  it('preserves primary routing for owner-local actions', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness({
      token: TEST_TOKEN,
    });

    const res = await request(app)
      .patch('/session/11111111-1111-4111-a111-111111111111/metadata')
      .set('Host', host())
      .set('Authorization', TEST_AUTHORIZATION)
      .send({ displayName: 'primary renamed' });

    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe(`${PRIMARY_CWD}:primary renamed`);
    expect(primaryBridge.metadataCalls).toEqual([
      {
        sessionId: '11111111-1111-4111-a111-111111111111',
        metadata: { displayName: 'primary renamed' },
      },
    ]);
    expect(secondaryBridge.metadataCalls).toEqual([]);
  });

  it('keeps strict owner-local actions behind bearer authentication', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness({
      token: TEST_TOKEN,
    });

    const responses = await Promise.all([
      request(app)
        .patch('/session/22222222-2222-4222-a222-222222222222/metadata')
        .set('Host', host())
        .send({ displayName: 'unauthorized' }),
      request(app)
        .post(
          '/session/22222222-2222-4222-a222-222222222222/tasks/task-1/cancel',
        )
        .set('Host', host())
        .send({ kind: 'shell' }),
      request(app)
        .post('/session/22222222-2222-4222-a222-222222222222/goal/clear')
        .set('Host', host())
        .send({}),
      request(app)
        .delete(
          '/session/22222222-2222-4222-a222-222222222222/mid-turn-messages/mid-1',
        )
        .set('Host', host()),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      401, 401, 401, 401,
    ]);
    expect(primaryBridge.metadataCalls).toEqual([]);
    expect(secondaryBridge.metadataCalls).toEqual([]);
    expect(primaryBridge.taskCancelCalls).toEqual([]);
    expect(secondaryBridge.taskCancelCalls).toEqual([]);
    expect(primaryBridge.goalClearCalls).toEqual([]);
    expect(secondaryBridge.goalClearCalls).toEqual([]);
    expect(primaryBridge.removeMidTurnMessageCalls).toEqual([]);
    expect(secondaryBridge.removeMidTurnMessageCalls).toEqual([]);
  });

  it('rejects invalid secondary owner-local inputs before bridge actions', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness({
      token: TEST_TOKEN,
    });

    const responses = await Promise.all([
      request(app)
        .patch('/session/22222222-2222-4222-a222-222222222222/metadata')
        .set('Host', host())
        .set('Authorization', TEST_AUTHORIZATION)
        .send({ displayName: 42 }),
      request(app)
        .post('/session/22222222-2222-4222-a222-222222222222/btw')
        .set('Host', host())
        .set('Authorization', TEST_AUTHORIZATION)
        .send({ question: '   ' }),
      request(app)
        .post('/session/22222222-2222-4222-a222-222222222222/mid-turn-message')
        .set('Host', host())
        .set('Authorization', TEST_AUTHORIZATION)
        .send({ message: '   ' }),
      request(app)
        .post(
          '/session/22222222-2222-4222-a222-222222222222/tasks/task-1/cancel',
        )
        .set('Host', host())
        .set('Authorization', TEST_AUTHORIZATION)
        .send({ kind: 'invalid' }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      400, 400, 400, 400,
    ]);
    for (const bridge of [primaryBridge, secondaryBridge]) {
      expect(bridge.metadataCalls).toEqual([]);
      expect(bridge.btwCalls).toEqual([]);
      expect(bridge.midTurnMessageCalls).toEqual([]);
      expect(bridge.taskCancelCalls).toEqual([]);
    }
  });

  it('rejects all owner-local actions for an untrusted non-primary owner', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness({
      secondaryTrusted: false,
      token: TEST_TOKEN,
    });

    const responses = await Promise.all([
      request(app)
        .patch('/session/22222222-2222-4222-a222-222222222222/metadata')
        .set('Host', host())
        .set('Authorization', TEST_AUTHORIZATION)
        .send({ displayName: 'blocked' }),
      request(app)
        .post('/session/22222222-2222-4222-a222-222222222222/recap')
        .set('Host', host())
        .set('Authorization', TEST_AUTHORIZATION)
        .send({}),
      request(app)
        .post('/session/22222222-2222-4222-a222-222222222222/btw')
        .set('Host', host())
        .set('Authorization', TEST_AUTHORIZATION)
        .send({ question: 'blocked?' }),
      request(app)
        .post('/session/22222222-2222-4222-a222-222222222222/mid-turn-message')
        .set('Host', host())
        .set('Authorization', TEST_AUTHORIZATION)
        .send({ message: 'blocked' }),
      request(app)
        .get('/session/22222222-2222-4222-a222-222222222222/mid-turn-messages')
        .set('Host', host())
        .set('Authorization', TEST_AUTHORIZATION),
      request(app)
        .post(
          '/session/22222222-2222-4222-a222-222222222222/tasks/task-1/cancel',
        )
        .set('Host', host())
        .set('Authorization', TEST_AUTHORIZATION)
        .send({ kind: 'agent' }),
      request(app)
        .delete(
          '/session/22222222-2222-4222-a222-222222222222/mid-turn-messages/mid-blocked',
        )
        .set('Host', host())
        .set('Authorization', TEST_AUTHORIZATION),
      request(app)
        .post('/session/22222222-2222-4222-a222-222222222222/goal/clear')
        .set('Host', host())
        .set('Authorization', TEST_AUTHORIZATION)
        .send({}),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      403, 403, 403, 403, 403, 403, 403, 403,
    ]);
    for (const response of responses) {
      expect(response.body.code).toBe('untrusted_workspace');
    }
    for (const bridge of [primaryBridge, secondaryBridge]) {
      expect(bridge.metadataCalls).toEqual([]);
      expect(bridge.recapCalls).toEqual([]);
      expect(bridge.btwCalls).toEqual([]);
      expect(bridge.midTurnMessageCalls).toEqual([]);
      expect(bridge.getMidTurnMessagesCalls).toEqual([]);
      expect(bridge.removeMidTurnMessageCalls).toEqual([]);
      expect(bridge.taskCancelCalls).toEqual([]);
      expect(bridge.goalClearCalls).toEqual([]);
    }
  });

  it('lists active persisted and live non-primary workspace sessions by workspace id', async () => {
    await withRuntimeDir(async () => {
      const storedOnlyId = '550e8400-e29b-41d4-a716-446655440101';
      const liveAndStoredId = '550e8400-e29b-41d4-a716-446655440102';
      await writeStoredSession({
        sessionId: storedOnlyId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'secondary stored only prompt',
        mtime: new Date('2026-07-08T00:04:00.000Z'),
      });
      await writeStoredSession({
        sessionId: liveAndStoredId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:01:00.000Z',
        prompt: 'secondary stored live prompt',
        mtime: new Date('2026-07-08T00:05:00.000Z'),
      });
      const { app } = makeHarness({
        secondarySummaries: [
          makeSummary(liveAndStoredId, SECONDARY_CWD, {
            displayName: 'secondary live title',
          }),
        ],
      });

      const res = await request(app)
        .get('/workspace/secondary-id/sessions')
        .set('Host', host());

      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(2);
      expect(res.body.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: liveAndStoredId,
            workspaceCwd: SECONDARY_CWD,
            displayName: 'secondary live title',
            clientCount: 1,
            hasActivePrompt: false,
          }),
          expect.objectContaining({
            sessionId: storedOnlyId,
            workspaceCwd: SECONDARY_CWD,
            displayName: 'secondary stored only prompt',
            clientCount: 0,
            hasActivePrompt: false,
          }),
        ]),
      );
    });
  });

  it('rejects a group filter without the organized view for non-primary workspaces', async () => {
    const { app } = makeHarness();

    const group = await request(app)
      .get('/workspace/secondary-id/sessions?group=pinned')
      .set('Host', host());
    expect(group.status).toBe(400);
    expect(group.body.code).toBe('invalid_session_group_filter');
  });

  it('lists archived non-primary workspace sessions for trusted workspaces', async () => {
    await withRuntimeDir(async () => {
      const archivedId = '550e8400-e29b-41d4-a716-446655440130';
      await writeStoredSession({
        sessionId: archivedId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:20:00.000Z',
        prompt: 'secondary archived target',
        mtime: new Date('2026-07-08T00:20:00.000Z'),
      });
      const { app } = makeHarness({ secondarySummaries: [] });

      await request(app)
        .post('/workspaces/secondary-id/sessions/archive')
        .set('Host', host())
        .send({ sessionIds: [archivedId] })
        .expect(200);

      const active = await request(app)
        .get('/workspaces/secondary-id/sessions')
        .set('Host', host())
        .expect(200);
      expect(
        active.body.sessions.map((s: { sessionId: string }) => s.sessionId),
      ).not.toContain(archivedId);

      const archived = await request(app)
        .get('/workspaces/secondary-id/sessions?archiveState=archived')
        .set('Host', host())
        .expect(200);
      expect(
        archived.body.sessions.map((s: { sessionId: string }) => s.sessionId),
      ).toEqual([archivedId]);
      expect(archived.body.sessions[0]).toMatchObject({
        sessionId: archivedId,
        workspaceCwd: SECONDARY_CWD,
        isArchived: true,
      });
    });
  });

  it('lists organized non-primary workspace sessions with pinned first for trusted workspaces', async () => {
    await withRuntimeDir(async () => {
      const pinnedOlderId = '550e8400-e29b-41d4-a716-446655440131';
      const plainNewerId = '550e8400-e29b-41d4-a716-446655440132';
      await writeStoredSession({
        sessionId: pinnedOlderId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'secondary older pinned',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      await writeStoredSession({
        sessionId: plainNewerId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T01:00:00.000Z',
        prompt: 'secondary newer unpinned',
        mtime: new Date('2026-07-08T01:00:00.000Z'),
      });
      await createSessionOrganizationService(
        SECONDARY_CWD,
      ).updateSessionOrganization(pinnedOlderId, { isPinned: true });
      const { app } = makeHarness({ secondarySummaries: [] });

      const organized = await request(app)
        .get('/workspaces/secondary-id/sessions?view=organized&group=all')
        .set('Host', host())
        .expect(200);
      expect(
        organized.body.sessions.map((s: { sessionId: string }) => s.sessionId),
      ).toEqual([pinnedOlderId, plainNewerId]);
      expect(organized.body.sessions[0]).toMatchObject({
        sessionId: pinnedOlderId,
        isPinned: true,
      });
    });
  });

  it('lists organized archived non-primary sessions pinned first without merging live sessions', async () => {
    await withRuntimeDir(async () => {
      const pinnedArchivedId = '550e8400-e29b-41d4-a716-446655440140';
      const plainArchivedId = '550e8400-e29b-41d4-a716-446655440141';
      const liveOnlyId = '550e8400-e29b-41d4-a716-446655440142';
      await writeStoredSession({
        sessionId: pinnedArchivedId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'secondary pinned archived',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      await writeStoredSession({
        sessionId: plainArchivedId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T01:00:00.000Z',
        prompt: 'secondary plain archived',
        mtime: new Date('2026-07-08T01:00:00.000Z'),
      });
      const { app } = makeHarness({
        secondarySummaries: [makeSummary(liveOnlyId, SECONDARY_CWD)],
      });

      await request(app)
        .post('/workspaces/secondary-id/sessions/archive')
        .set('Host', host())
        .send({ sessionIds: [pinnedArchivedId, plainArchivedId] })
        .expect(200);
      await createSessionOrganizationService(
        SECONDARY_CWD,
      ).updateSessionOrganization(pinnedArchivedId, { isPinned: true });

      const organized = await request(app)
        .get(
          '/workspaces/secondary-id/sessions?view=organized&archiveState=archived&group=all',
        )
        .set('Host', host())
        .expect(200);
      const ids = organized.body.sessions.map(
        (s: { sessionId: string }) => s.sessionId,
      );
      expect(ids).toEqual([pinnedArchivedId, plainArchivedId]);
      expect(ids).not.toContain(liveOnlyId);
      expect(organized.body.sessions[0]).toMatchObject({
        sessionId: pinnedArchivedId,
        isPinned: true,
        isArchived: true,
      });
    });
  });

  it('paginates organized non-primary sessions across an opaque cursor round-trip', async () => {
    await withRuntimeDir(async () => {
      const newestId = '550e8400-e29b-41d4-a716-446655440150';
      const middleId = '550e8400-e29b-41d4-a716-446655440151';
      const oldestId = '550e8400-e29b-41d4-a716-446655440152';
      await writeStoredSession({
        sessionId: newestId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T03:00:00.000Z',
        prompt: 'secondary newest',
        mtime: new Date('2026-07-08T03:00:00.000Z'),
      });
      await writeStoredSession({
        sessionId: middleId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T02:00:00.000Z',
        prompt: 'secondary middle',
        mtime: new Date('2026-07-08T02:00:00.000Z'),
      });
      await writeStoredSession({
        sessionId: oldestId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T01:00:00.000Z',
        prompt: 'secondary oldest',
        mtime: new Date('2026-07-08T01:00:00.000Z'),
      });
      const { app } = makeHarness({ secondarySummaries: [] });

      const firstPage = await request(app)
        .get(
          '/workspaces/secondary-id/sessions?view=organized&group=all&size=2',
        )
        .set('Host', host())
        .expect(200);
      expect(
        firstPage.body.sessions.map((s: { sessionId: string }) => s.sessionId),
      ).toEqual([newestId, middleId]);
      expect(firstPage.body.nextCursor).toEqual(expect.any(String));

      const secondPage = await request(app)
        .get(
          `/workspaces/secondary-id/sessions?view=organized&group=all&size=2&cursor=${encodeURIComponent(
            firstPage.body.nextCursor as string,
          )}`,
        )
        .set('Host', host())
        .expect(200);
      expect(
        secondPage.body.sessions.map((s: { sessionId: string }) => s.sessionId),
      ).toEqual([oldestId]);
      expect(secondPage.body.nextCursor).toBeUndefined();
    });
  });

  it('lists archived and organized persisted sessions for an untrusted secondary without live merge', async () => {
    await withRuntimeDir(async () => {
      const activeId = '550e8400-e29b-41d4-a716-446655440160';
      const archivedId = '550e8400-e29b-41d4-a716-446655440161';
      const liveOnlyId = '550e8400-e29b-41d4-a716-446655440162';
      await writeStoredSession({
        sessionId: activeId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T01:00:00.000Z',
        prompt: 'untrusted active persisted',
        mtime: new Date('2026-07-08T01:00:00.000Z'),
      });
      await writeStoredSession({
        sessionId: archivedId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'untrusted archived persisted',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      await archiveStoredSession(SECONDARY_CWD, archivedId);
      const organizationService =
        createSessionOrganizationService(SECONDARY_CWD);
      const group = await organizationService.createGroup({
        name: 'Persisted group',
        color: 'blue',
      });
      await organizationService.updateSessionOrganization(activeId, {
        isPinned: true,
        groupId: group.id,
      });
      const { app, secondaryBridge } = makeHarness({
        secondaryTrusted: false,
        secondarySummaries: [makeSummary(liveOnlyId, SECONDARY_CWD)],
      });

      const archived = await request(app)
        .get('/workspaces/secondary-id/sessions?archiveState=archived')
        .set('Host', host())
        .expect(200);
      expect(
        archived.body.sessions.map((s: { sessionId: string }) => s.sessionId),
      ).toEqual([archivedId]);

      const organized = await request(app)
        .get('/workspaces/secondary-id/sessions?view=organized&group=pinned')
        .set('Host', host())
        .expect(200);
      expect(
        organized.body.sessions.map((s: { sessionId: string }) => s.sessionId),
      ).toEqual([activeId]);
      const namedGroup = await request(app)
        .get(
          `/workspaces/secondary-id/sessions?view=organized&group=${group.id}`,
        )
        .set('Host', host())
        .expect(200);
      expect(
        namedGroup.body.sessions.map((s: { sessionId: string }) => s.sessionId),
      ).toEqual([activeId]);
      expect(secondaryBridge.listCalls).toEqual([]);
    });
  });

  it('returns workspace_mismatch for unknown absolute workspace catalogs', async () => {
    const { app } = makeHarness();

    for (const selector of [UNKNOWN_CWD, path.join(PRIMARY_CWD, 'nested')]) {
      for (const route of [
        `/workspace/${encodeURIComponent(selector)}/sessions`,
        `/workspace/${encodeURIComponent(selector)}/session-groups`,
      ]) {
        const unknown = await request(app).get(route).set('Host', host());
        expect(unknown.status).toBe(400);
        expect(unknown.body.code).toBe('workspace_mismatch');
        expect(unknown.body.workspaceCount).toBe(2);
        expect(unknown.body.boundWorkspace).toBe(PRIMARY_CWD);
        expect(unknown.body.requestedWorkspace).toBe(selector);
      }

      for (const route of [
        `/workspaces/${encodeURIComponent(selector)}/sessions`,
        `/workspaces/${encodeURIComponent(selector)}/session-groups`,
      ]) {
        const unknown = await request(app).get(route).set('Host', host());
        expect(unknown.status).toBe(400);
        expect(unknown.body).toEqual({
          error:
            'Workspace mismatch: the requested workspace is not registered with this daemon.',
          code: 'workspace_mismatch',
          workspaceCount: 2,
        });
      }
    }
  });

  it('lists active persisted non-primary sessions by encoded workspace cwd', async () => {
    await withRuntimeDir(async () => {
      const storedId = '550e8400-e29b-41d4-a716-446655440103';
      await writeStoredSession({
        sessionId: storedId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'secondary stored by cwd',
        mtime: new Date('2026-07-08T00:04:00.000Z'),
      });
      const { app } = makeHarness({ secondarySummaries: [] });

      const res = await request(app)
        .get(`/workspaces/${encodeURIComponent(SECONDARY_CWD)}/sessions`)
        .set('Host', host());

      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual([
        expect.objectContaining({
          sessionId: storedId,
          workspaceCwd: SECONDARY_CWD,
          displayName: 'secondary stored by cwd',
        }),
      ]);
    });
  });

  it('pages active persisted non-primary workspace sessions with numeric cursors', async () => {
    await withRuntimeDir(async () => {
      const newestId = '550e8400-e29b-41d4-a716-446655440104';
      const middleId = '550e8400-e29b-41d4-a716-446655440105';
      const oldestId = '550e8400-e29b-41d4-a716-446655440106';
      await writeStoredSession({
        sessionId: newestId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:03:00.000Z',
        prompt: 'secondary newest',
        mtime: new Date('2026-07-08T00:03:00.000Z'),
      });
      await writeStoredSession({
        sessionId: middleId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:02:00.000Z',
        prompt: 'secondary middle',
        mtime: new Date('2026-07-08T00:02:00.000Z'),
      });
      await writeStoredSession({
        sessionId: oldestId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:01:00.000Z',
        prompt: 'secondary oldest',
        mtime: new Date('2026-07-08T00:01:00.000Z'),
      });
      const { app } = makeHarness({ secondarySummaries: [] });

      const first = await request(app)
        .get('/workspace/secondary-id/sessions?size=2')
        .set('Host', host())
        .expect(200);
      expect(
        first.body.sessions.map(
          (session: { sessionId: string }) => session.sessionId,
        ),
      ).toEqual([newestId, middleId]);
      expect(first.body.nextCursor).toEqual(expect.any(String));

      const second = await request(app)
        .get(
          `/workspace/secondary-id/sessions?size=2&cursor=${encodeURIComponent(
            first.body.nextCursor as string,
          )}`,
        )
        .set('Host', host())
        .expect(200);
      expect(
        second.body.sessions.map(
          (session: { sessionId: string }) => session.sessionId,
        ),
      ).toEqual([oldestId]);
      expect(second.body.nextCursor).toBeUndefined();
    });
  });

  it('falls back to live-only listing when persisted probing fails', async () => {
    await withRuntimeDir(async () => {
      const chatsDir = path.join(
        new Storage(SECONDARY_CWD).getProjectDir(),
        'chats',
      );
      await fsp.mkdir(chatsDir, { recursive: true });
      await fsp.chmod(chatsDir, 0o000);
      try {
        const { app } = makeHarness({
          secondarySummaries: [
            makeSummary('secondary-live-fallback', SECONDARY_CWD),
          ],
        });

        const res = await request(app)
          .get('/workspace/secondary-id/sessions')
          .set('Host', host())
          .expect(200);
        expect(res.body.sessions).toEqual([
          expect.objectContaining({
            sessionId: 'secondary-live-fallback',
            workspaceCwd: SECONDARY_CWD,
          }),
        ]);
      } finally {
        await fsp.chmod(chatsDir, 0o700);
      }
    });
  });

  it('preserves the legacy invalid workspace selector message', async () => {
    const { app } = makeHarness();

    for (const route of [
      '/workspace/not:an:absolute:path/sessions',
      '/workspace/not:an:absolute:path/session-groups',
    ]) {
      const res = await request(app).get(route).set('Host', host());

      expect(res.status).toBe(400);
      expect(res.body.error).toBe(
        '`:id` must decode to a workspace id or absolute path',
      );
    }
  });

  it('lists only persisted sessions for an untrusted secondary by id and encoded cwd without writing storage', async () => {
    await withRuntimeDir(async () => {
      const storedId = '550e8400-e29b-41d4-a716-446655440170';
      const liveOnlyId = '550e8400-e29b-41d4-a716-446655440171';
      await writeStoredSession({
        sessionId: storedId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'untrusted persisted session',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      const chatsDir = path.join(
        new Storage(SECONDARY_CWD).getProjectDir(),
        'chats',
      );
      const storedPath = path.join(chatsDir, `${storedId}.jsonl`);
      const beforeEntries = await fsp.readdir(chatsDir);
      const beforeContent = await fsp.readFile(storedPath, 'utf8');
      const { app, secondaryBridge } = makeHarness({
        secondaryTrusted: false,
        secondarySummaries: [makeSummary(liveOnlyId, SECONDARY_CWD)],
      });

      for (const route of [
        '/workspaces/secondary-id/sessions',
        `/workspaces/${encodeURIComponent(SECONDARY_CWD)}/sessions`,
        '/workspace/secondary-id/sessions',
        `/workspace/${encodeURIComponent(SECONDARY_CWD)}/sessions`,
      ]) {
        const res = await request(app)
          .get(route)
          .set('Host', host())
          .expect(200);
        expect(
          res.body.sessions.map((s: { sessionId: string }) => s.sessionId),
        ).toEqual([storedId]);
      }
      expect(secondaryBridge.listCalls).toEqual([]);
      expect(await fsp.readdir(chatsDir)).toEqual(beforeEntries);
      expect(await fsp.readFile(storedPath, 'utf8')).toBe(beforeContent);
    });
  });

  it('chains untrusted transcript pages without bridge or cursor-key writes', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440270';
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'first page',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      const transcriptPath = path.join(
        new Storage(SECONDARY_CWD).getProjectDir(),
        'chats',
        `${sessionId}.jsonl`,
      );
      await fsp.appendFile(
        transcriptPath,
        [
          {
            uuid: `${sessionId}-assistant-1`,
            parentUuid: `${sessionId}-user-1`,
            sessionId,
            timestamp: '2026-07-08T00:01:00.000Z',
            type: 'assistant',
            message: { role: 'model', parts: [{ text: 'first answer' }] },
            cwd: SECONDARY_CWD,
          },
          {
            uuid: `${sessionId}-user-2`,
            parentUuid: `${sessionId}-assistant-1`,
            sessionId,
            timestamp: '2026-07-08T00:02:00.000Z',
            type: 'user',
            message: { role: 'user', parts: [{ text: 'second question' }] },
            cwd: SECONDARY_CWD,
          },
          {
            uuid: `${sessionId}-assistant-2`,
            parentUuid: `${sessionId}-user-2`,
            sessionId,
            timestamp: '2026-07-08T00:03:00.000Z',
            type: 'assistant',
            message: { role: 'model', parts: [{ text: 'second answer' }] },
            cwd: SECONDARY_CWD,
          },
        ]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
        'utf8',
      );
      await writeStoredSession({
        sessionId,
        cwd: PRIMARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'same id in primary',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      const chatsDir = path.dirname(transcriptPath);
      const beforeEntries = await fsp.readdir(chatsDir);
      const beforeContent = await fsp.readFile(transcriptPath);
      const beforeMtimeMs = (await fsp.stat(transcriptPath)).mtimeMs;
      const { app, primaryBridge, secondaryBridge } = makeHarness({
        secondaryTrusted: false,
      });

      const first = await request(app)
        .get(`/workspaces/secondary-id/session/${sessionId}/transcript?limit=2`)
        .set('Host', host())
        .expect(200);
      expect(
        first.body.events.map(
          (event: {
            data: { sessionUpdate: string; content?: { text?: string } };
          }) => [event.data.sessionUpdate, event.data.content?.text],
        ),
      ).toEqual([
        ['user_message_chunk', 'first page'],
        ['agent_message_chunk', 'first answer'],
      ]);
      expect(first.body.hasMore).toBe(true);
      expect(first.body.nextCursor).toEqual(expect.any(String));

      const crossWorkspace = await request(app)
        .get(
          `/workspaces/primary-id/session/${sessionId}/transcript?cursor=${encodeURIComponent(
            first.body.nextCursor as string,
          )}`,
        )
        .set('Host', host());
      expect(crossWorkspace.status).toBe(400);
      expect(crossWorkspace.body.code).toBe('invalid_transcript_cursor');
      expect(crossWorkspace.body.sessionId).toBe(sessionId);

      const second = await request(app)
        .get(
          `/workspaces/${encodeURIComponent(SECONDARY_CWD)}/session/${sessionId}/transcript?limit=2&cursor=${encodeURIComponent(
            first.body.nextCursor as string,
          )}`,
        )
        .set('Host', host())
        .expect(200);
      expect(
        second.body.events.map(
          (event: {
            data: { sessionUpdate: string; content?: { text?: string } };
          }) => [event.data.sessionUpdate, event.data.content?.text],
        ),
      ).toEqual([
        ['user_message_chunk', 'second question'],
        ['agent_message_chunk', 'second answer'],
      ]);
      expect(second.body.hasMore).toBe(false);
      expect(second.body.nextCursor).toBeUndefined();
      expect(primaryBridge.spawnCalls).toEqual([]);
      expect(primaryBridge.restoreCalls).toEqual([]);
      expect(secondaryBridge.spawnCalls).toEqual([]);
      expect(secondaryBridge.restoreCalls).toEqual([]);
      await expect(
        fsp.stat(
          path.join(
            new Storage(SECONDARY_CWD).getProjectDir(),
            'session-transcript-cursor-key',
          ),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fsp.readdir(chatsDir)).toEqual(beforeEntries);
      expect(await fsp.readFile(transcriptPath)).toEqual(beforeContent);
      expect((await fsp.stat(transcriptPath)).mtimeMs).toBe(beforeMtimeMs);

      const restarted = makeHarness({ secondaryTrusted: false });
      const expired = await request(restarted.app)
        .get(
          `/workspaces/secondary-id/session/${sessionId}/transcript?cursor=${encodeURIComponent(
            first.body.nextCursor as string,
          )}`,
        )
        .set('Host', host());
      expect(expired.status).toBe(400);
      expect(expired.body.code).toBe('invalid_transcript_cursor');
      expect(expired.body.sessionId).toBe(sessionId);
    });
  });

  it('rejects an oversized untrusted transcript record without starting the bridge', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440276';
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'x'.repeat(33 * 1024 * 1024),
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      const { app, secondaryBridge } = makeHarness({
        secondaryTrusted: false,
      });

      const response = await request(app)
        .get(`/workspaces/secondary-id/session/${sessionId}/transcript`)
        .set('Host', host());

      expect(response.status).toBe(413);
      expect(response.body).toMatchObject({
        code: 'transcript_page_too_large',
        sessionId,
        maxBytes: 32 * 1024 * 1024,
      });
      expect(response.body.pageBytes).toBeGreaterThan(
        response.body.maxBytes as number,
      );
      expect(secondaryBridge.spawnCalls).toEqual([]);
      expect(secondaryBridge.restoreCalls).toEqual([]);
    });
  });

  it('serves workspace-qualified turn index and anchored transcript without starting the bridge', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440282';
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'secondary navigation prompt',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      const { app, primaryBridge, secondaryBridge } = makeHarness({
        secondaryTrusted: false,
      });

      const index = await request(app)
        .get(`/workspaces/secondary-id/session/${sessionId}/turn-index`)
        .set('Host', host())
        .expect(200);
      expect(index.body).toMatchObject({
        totalTurns: 1,
        start: 0,
        turns: [
          {
            ordinal: 0,
            kind: 'prompt',
            label: 'secondary navigation prompt',
          },
        ],
      });

      const turnId = index.body.turns[0].turnId as string;
      const snapshot = index.body.snapshot as string;
      const outOfRange = await request(app)
        .get(
          `/workspaces/secondary-id/session/${sessionId}/turn-index?snapshot=${encodeURIComponent(snapshot)}&start=2`,
        )
        .set('Host', host());
      expect(outOfRange.status).toBe(400);
      expect(outOfRange.body.code).toBe('invalid_transcript_cursor');
      const anchored = await request(app)
        .get(
          `/workspaces/secondary-id/session/${sessionId}/transcript?atRecordId=${encodeURIComponent(turnId)}&snapshot=${encodeURIComponent(snapshot)}`,
        )
        .set('Host', host())
        .expect(200);
      expect(anchored.body.targetRecordId).toBe(turnId);
      expect(anchored.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              sessionUpdate: 'user_message_chunk',
            }),
          }),
        ]),
      );
      expect(primaryBridge.spawnCalls).toEqual([]);
      expect(primaryBridge.restoreCalls).toEqual([]);
      expect(secondaryBridge.spawnCalls).toEqual([]);
      expect(secondaryBridge.restoreCalls).toEqual([]);
    });
  });

  it('does not finalize a dangling tool call while its workspace session prompt is active', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440280';
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'read while active',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      const transcriptPath = path.join(
        new Storage(SECONDARY_CWD).getProjectDir(),
        'chats',
        `${sessionId}.jsonl`,
      );
      await fsp.appendFile(
        transcriptPath,
        `${JSON.stringify({
          uuid: `${sessionId}-assistant-1`,
          parentUuid: `${sessionId}-user-1`,
          sessionId,
          timestamp: '2026-07-08T00:01:00.000Z',
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'active-tool-call',
                  name: 'read_file',
                  args: { path: '/workspace/file.txt' },
                },
              },
            ],
          },
          cwd: SECONDARY_CWD,
        })}\n`,
        'utf8',
      );
      const summary = makeSummary(sessionId, SECONDARY_CWD, {
        hasActivePrompt: true,
      });
      const { app, primaryBridge, secondaryBridge } = makeHarness({
        secondarySummaries: [summary],
      });

      const active = await request(app)
        .get(`/workspaces/secondary-id/session/${sessionId}/transcript`)
        .set('Host', host())
        .expect(200);
      expect(
        active.body.events
          .map((event: { data: Record<string, unknown> }) => event.data)
          .filter(
            (event: Record<string, unknown>) =>
              event['toolCallId'] === 'active-tool-call',
          ),
      ).toEqual([
        expect.objectContaining({
          sessionUpdate: 'tool_call',
          status: 'in_progress',
        }),
      ]);

      summary.hasActivePrompt = false;
      const idle = await request(app)
        .get(`/workspaces/secondary-id/session/${sessionId}/transcript`)
        .set('Host', host())
        .expect(200);
      expect(
        idle.body.events
          .map((event: { data: Record<string, unknown> }) => event.data)
          .filter(
            (event: Record<string, unknown>) =>
              event['toolCallId'] === 'active-tool-call',
          ),
      ).toEqual([
        expect.objectContaining({
          sessionUpdate: 'tool_call',
          status: 'in_progress',
        }),
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          status: 'failed',
        }),
      ]);
      expect(primaryBridge.summaryCalls).toEqual([]);
      expect(secondaryBridge.summaryCalls).toEqual([
        sessionId,
        sessionId,
        sessionId,
        sessionId,
      ]);
    });
  });

  it('serves an indivisible record that exceeds the reader page budget', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440281';
      const prompt = 'x'.repeat(5 * 1024 * 1024);
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt,
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      const { app, secondaryBridge } = makeHarness({
        secondaryTrusted: false,
      });

      const response = await request(app)
        .get(`/workspaces/secondary-id/session/${sessionId}/transcript`)
        .set('Host', host());

      // A single record cannot be split, so it rides over the 4 MiB reader
      // budget (hard ceiling remains the 32 MiB serialization cap).
      expect(response.status).toBe(200);
      expect(
        response.body.events.some(
          (event: { data?: { content?: { text?: string } } }) =>
            event.data?.content?.text?.length === prompt.length,
        ),
      ).toBe(true);
      expect(secondaryBridge.spawnCalls).toEqual([]);
      expect(secondaryBridge.restoreCalls).toEqual([]);
    });
  });

  it('enforces the workspace transcript cursor byte boundary', () => {
    expect(
      workspaceTranscriptCursorExceedsLimitForTesting(
        'a'.repeat(64 * 1024 + 1),
      ),
    ).toBe(true);
    expect(
      workspaceTranscriptCursorExceedsLimitForTesting('a'.repeat(64 * 1024)),
    ).toBe(false);
  });

  it('rejects workspace transcript responses over the serialized byte budget', () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440279';

    expect(() =>
      serializeWorkspaceTranscriptResponseForTesting(
        { events: ['response too large'] },
        sessionId,
        8,
      ),
    ).toThrowError(
      expect.objectContaining({
        name: 'SessionTranscriptPageTooLargeError',
        sessionId,
        maxBytes: 8,
      }),
    );
  });

  it('stops pagination when replay state would produce an oversized cursor', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440278';
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'pending tools',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      const transcriptPath = path.join(
        new Storage(SECONDARY_CWD).getProjectDir(),
        'chats',
        `${sessionId}.jsonl`,
      );
      let parentUuid = `${sessionId}-user-1`;
      const records: Array<Record<string, unknown>> = [];
      for (let index = 0; index < 500; index++) {
        const uuid = `pending-tool-${index}`;
        records.push({
          uuid,
          parentUuid,
          sessionId,
          timestamp: new Date(Date.UTC(2026, 6, 8, 0, 0, index)).toISOString(),
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: `pending-call-${index}-${'x'.repeat(96)}`,
                  name: 'run_shell_command',
                  args: { command: 'true' },
                },
              },
            ],
          },
          cwd: SECONDARY_CWD,
        });
        parentUuid = uuid;
      }
      await fsp.appendFile(
        transcriptPath,
        `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
        'utf8',
      );
      const { app, secondaryBridge } = makeHarness({
        secondaryTrusted: false,
      });

      const response = await request(app)
        .get(
          `/workspaces/secondary-id/session/${sessionId}/transcript?limit=500`,
        )
        .set('Host', host())
        .expect(200);

      expect(response.body.partial).toBe(true);
      expect(response.body.replayError).toBe(
        'Transcript pagination state exceeds the safe limit',
      );
      expect(response.body.hasMore).toBe(false);
      expect(response.body.nextCursor).toBeUndefined();
      expect(Array.isArray(response.body.events)).toBe(true);
      expect(response.body.events.length).toBeGreaterThan(0);
      expect(secondaryBridge.spawnCalls).toEqual([]);
      expect(secondaryBridge.restoreCalls).toEqual([]);
    });
  });

  it('fails closed for mismatched persisted transcript records', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440271';
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'wrong owner',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      const transcriptPath = path.join(
        new Storage(SECONDARY_CWD).getProjectDir(),
        'chats',
        `${sessionId}.jsonl`,
      );
      const content = await fsp.readFile(transcriptPath, 'utf8');
      await fsp.writeFile(
        transcriptPath,
        content.replace(
          `"sessionId":"${sessionId}"`,
          '"sessionId":"550e8400-e29b-41d4-a716-446655440999"',
        ),
        'utf8',
      );
      const { app } = makeHarness({ secondaryTrusted: false });

      const res = await request(app)
        .get(`/workspaces/secondary-id/session/${sessionId}/transcript`)
        .set('Host', host());

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('transcript_snapshot_unavailable');
    });
  });

  it('suppresses file-backed debug logging during untrusted transcript reads', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440274';
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'no debug writes',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      const previousDebugLogFile = process.env['QWEN_DEBUG_LOG_FILE'];
      const debugSessionId = '550e8400-e29b-41d4-a716-446655440275';
      const debugLogPath = Storage.getDebugLogPath(debugSessionId);
      process.env['QWEN_DEBUG_LOG_FILE'] = '1';
      resetDebugLoggingState();
      setDebugLogSession({ getSessionId: () => debugSessionId });
      try {
        const { app } = makeHarness({ secondaryTrusted: false });
        await request(app)
          .get(`/workspaces/secondary-id/session/${sessionId}/transcript`)
          .set('Host', host())
          .expect(200);
        await expect(fsp.stat(debugLogPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        setDebugLogSession(null);
        resetDebugLoggingState();
        if (previousDebugLogFile === undefined) {
          delete process.env['QWEN_DEBUG_LOG_FILE'];
        } else {
          process.env['QWEN_DEBUG_LOG_FILE'] = previousDebugLogFile;
        }
      }
    });
  });

  it('keeps archived and untrusted-primary transcript boundaries', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440272';
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'archived',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      await archiveStoredSession(SECONDARY_CWD, sessionId);
      const secondary = makeHarness({ secondaryTrusted: false });
      const archived = await request(secondary.app)
        .get(`/workspaces/secondary-id/session/${sessionId}/transcript`)
        .set('Host', host());
      expect(archived.status).toBe(409);
      expect(archived.body.code).toBe('session_archived');

      const primary = makeHarness({ primaryTrusted: false });
      const forbidden = await request(primary.app)
        .get(`/workspaces/primary-id/session/${sessionId}/transcript`)
        .set('Host', host());
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe('untrusted_workspace');
    });
  });

  it('serves trusted runtimes and rejects missing or unknown transcript targets', async () => {
    await withRuntimeDir(async () => {
      const primarySessionId = '550e8400-e29b-41d4-a716-446655440276';
      const secondarySessionId = '550e8400-e29b-41d4-a716-446655440277';
      for (const [sessionId, cwd] of [
        [primarySessionId, PRIMARY_CWD],
        [secondarySessionId, SECONDARY_CWD],
      ] as const) {
        await writeStoredSession({
          sessionId,
          cwd,
          timestamp: '2026-07-08T00:00:00.000Z',
          prompt: `trusted ${sessionId}`,
          mtime: new Date('2026-07-08T00:00:00.000Z'),
        });
      }
      const { app } = makeHarness();

      await request(app)
        .get(`/workspaces/primary-id/session/${primarySessionId}/transcript`)
        .set('Host', host())
        .expect(200);
      await request(app)
        .get(
          `/workspaces/secondary-id/session/${secondarySessionId}/transcript`,
        )
        .set('Host', host())
        .expect(200);

      const missing = await request(app)
        .get(
          '/workspaces/secondary-id/session/550e8400-e29b-41d4-a716-446655440278/transcript',
        )
        .set('Host', host());
      expect(missing.status).toBe(404);

      const unknown = await request(app)
        .get(
          `/workspaces/${encodeURIComponent(UNKNOWN_CWD)}/session/${secondarySessionId}/transcript`,
        )
        .set('Host', host());
      expect(unknown.status).toBe(400);
      expect(unknown.body.code).toBe('workspace_mismatch');

      const unknownWithInvalidLimit = await request(app)
        .get(
          `/workspaces/${encodeURIComponent(UNKNOWN_CWD)}/session/${secondarySessionId}/transcript?limit=501`,
        )
        .set('Host', host());
      expect(unknownWithInvalidLimit.status).toBe(400);
      expect(unknownWithInvalidLimit.body.code).toBe('workspace_mismatch');

      const invalidLimit = await request(app)
        .get(
          `/workspaces/secondary-id/session/${secondarySessionId}/transcript?limit=501`,
        )
        .set('Host', host());
      expect(invalidLimit.status).toBe(400);
      expect(invalidLimit.body.code).toBe('invalid_transcript_limit');
    });
  });

  it('returns empty untrusted catalogs without creating storage', async () => {
    await withRuntimeDir(async () => {
      const projectDir = new Storage(SECONDARY_CWD).getProjectDir();
      const { app, secondaryBridge } = makeHarness({
        secondaryTrusted: false,
      });

      await expect(fsp.stat(projectDir)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const sessions = await request(app)
        .get('/workspaces/secondary-id/sessions?view=organized')
        .set('Host', host())
        .expect(200);
      expect(sessions.body.sessions).toEqual([]);
      const groups = await request(app)
        .get('/workspaces/secondary-id/session-groups')
        .set('Host', host())
        .expect(200);
      expect(groups.body.groups).toEqual([]);
      expect(secondaryBridge.listCalls).toEqual([]);
      await expect(fsp.stat(projectDir)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('does not repair malformed untrusted catalog storage', async () => {
    await withRuntimeDir(async () => {
      const previousDebugLogFile = process.env['QWEN_DEBUG_LOG_FILE'];
      const storage = new Storage(SECONDARY_CWD);
      const chatsDir = path.join(storage.getProjectDir(), 'chats');
      const malformedSessionPath = path.join(
        chatsDir,
        '550e8400-e29b-41d4-a716-446655440190.jsonl',
      );
      const organizationPath = path.join(
        storage.getProjectDir(),
        'session-organization.v1.json',
      );
      await fsp.mkdir(chatsDir, { recursive: true });
      await fsp.writeFile(malformedSessionPath, '{not-json}\n', 'utf8');
      await fsp.writeFile(organizationPath, '{not-json}\n', 'utf8');
      const beforeEntries = await fsp.readdir(storage.getProjectDir());
      const beforeSession = await fsp.readFile(malformedSessionPath, 'utf8');
      const beforeOrganization = await fsp.readFile(organizationPath, 'utf8');
      const { app, secondaryBridge } = makeHarness({
        secondaryTrusted: false,
      });
      const debugSessionId = '550e8400-e29b-41d4-a716-446655440191';
      const debugLogPath = Storage.getDebugLogPath(debugSessionId);
      process.env['QWEN_DEBUG_LOG_FILE'] = '1';
      resetDebugLoggingState();
      setDebugLogSession({ getSessionId: () => debugSessionId });

      try {
        const sessions = await request(app)
          .get('/workspaces/secondary-id/sessions?view=organized')
          .set('Host', host())
          .expect(200);
        expect(sessions.body.sessions).toEqual([]);
        const groups = await request(app)
          .get('/workspaces/secondary-id/session-groups')
          .set('Host', host())
          .expect(200);
        expect(groups.body.groups).toEqual([]);
        expect(secondaryBridge.listCalls).toEqual([]);
        expect(await fsp.readdir(storage.getProjectDir())).toEqual(
          beforeEntries,
        );
        expect(await fsp.readFile(malformedSessionPath, 'utf8')).toBe(
          beforeSession,
        );
        expect(await fsp.readFile(organizationPath, 'utf8')).toBe(
          beforeOrganization,
        );

        createDebugLogger('TEST').info('debug sentinel');
        await vi.waitFor(async () => {
          expect(await fsp.readFile(debugLogPath, 'utf8')).toContain(
            'debug sentinel',
          );
        });
        expect(await fsp.readFile(debugLogPath, 'utf8')).not.toContain(
          'Failed to parse line',
        );
      } finally {
        setDebugLogSession(null);
        resetDebugLoggingState();
        if (previousDebugLogFile === undefined) {
          delete process.env['QWEN_DEBUG_LOG_FILE'];
        } else {
          process.env['QWEN_DEBUG_LOG_FILE'] = previousDebugLogFile;
        }
      }
    });
  });

  it('paginates persisted child sessions for an untrusted secondary without live merge', async () => {
    await withRuntimeDir(async () => {
      const parentSessionId = '550e8400-e29b-41d4-a716-446655440180';
      const childIds = [
        '550e8400-e29b-41d4-a716-446655440181',
        '550e8400-e29b-41d4-a716-446655440182',
      ];
      for (const [index, sessionId] of childIds.entries()) {
        await writeStoredSession({
          sessionId,
          cwd: SECONDARY_CWD,
          timestamp: `2026-07-08T00:0${index}:00.000Z`,
          prompt: `child ${index}`,
          mtime: new Date(`2026-07-08T00:0${index}:00.000Z`),
          parentSessionId,
        });
      }
      const { app, secondaryBridge } = makeHarness({
        secondaryTrusted: false,
      });

      const first = await request(app)
        .get(
          `/workspaces/secondary-id/sessions?parentSessionId=${parentSessionId}&size=1`,
        )
        .set('Host', host())
        .expect(200);
      expect(first.body.sessions).toHaveLength(1);
      expect(first.body.nextCursor).toEqual(expect.any(String));

      const second = await request(app)
        .get(
          `/workspaces/secondary-id/sessions?parentSessionId=${parentSessionId}&size=1&cursor=${encodeURIComponent(
            first.body.nextCursor as string,
          )}`,
        )
        .set('Host', host())
        .expect(200);
      expect(second.body.sessions).toHaveLength(1);
      expect(second.body.sessions[0].sessionId).not.toBe(
        first.body.sessions[0].sessionId,
      );
      expect(second.body.nextCursor).toBeUndefined();
      expect(secondaryBridge.listCalls).toEqual([]);
    });
  });

  it('paginates the default persisted catalog for an untrusted secondary', async () => {
    await withRuntimeDir(async () => {
      const sessionIds = [
        '550e8400-e29b-41d4-a716-446655440192',
        '550e8400-e29b-41d4-a716-446655440193',
      ];
      for (const [index, sessionId] of sessionIds.entries()) {
        await writeStoredSession({
          sessionId,
          cwd: SECONDARY_CWD,
          timestamp: `2026-07-08T00:0${index}:00.000Z`,
          prompt: `default page ${index}`,
          mtime: new Date(`2026-07-08T00:0${index}:00.000Z`),
        });
      }
      const { app, secondaryBridge } = makeHarness({
        secondaryTrusted: false,
        secondarySummaries: [
          makeSummary('550e8400-e29b-41d4-a716-446655440194', SECONDARY_CWD),
        ],
      });

      const first = await request(app)
        .get('/workspaces/secondary-id/sessions?size=1')
        .set('Host', host())
        .expect(200);
      expect(
        first.body.sessions.map(
          (session: { sessionId: string }) => session.sessionId,
        ),
      ).toEqual([sessionIds[1]]);
      expect(first.body.nextCursor).toEqual(expect.any(String));

      const second = await request(app)
        .get(
          `/workspaces/secondary-id/sessions?size=1&cursor=${encodeURIComponent(
            first.body.nextCursor as string,
          )}`,
        )
        .set('Host', host())
        .expect(200);
      expect(
        second.body.sessions.map(
          (session: { sessionId: string }) => session.sessionId,
        ),
      ).toEqual([sessionIds[0]]);
      expect(second.body.nextCursor).toBeUndefined();
      expect(secondaryBridge.listCalls).toEqual([]);
    });
  });

  it('exports the selected trusted workspace without falling back or starting ACP', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440280';
      await writeStoredSession({
        sessionId,
        cwd: PRIMARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'primary export marker',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:01:00.000Z',
        prompt: 'secondary export marker',
        mtime: new Date('2026-07-08T00:01:00.000Z'),
      });
      const { app, primaryBridge, secondaryBridge } = makeHarness();

      const secondary = await request(app)
        .get(`/workspaces/secondary-id/session/${sessionId}/export`)
        .set('Host', host())
        .expect(200);
      expect(secondary.headers['content-type']).toContain('text/html');
      expect(secondary.headers['cache-control']).toBe('no-store');
      expect(secondary.headers['x-content-type-options']).toBe('nosniff');
      expect(secondary.headers['content-disposition']).toMatch(
        /^attachment; filename="qwen-code-export-.+\.html"$/,
      );
      expect(secondary.text).toContain('secondary export marker');
      expect(secondary.text).not.toContain('primary export marker');

      const primary = await request(app)
        .get(`/session/${sessionId}/export?format=md`)
        .set('Host', host())
        .expect(200);
      expect(primary.text).toContain('primary export marker');
      expect(primary.text).not.toContain('secondary export marker');

      expect(primaryBridge.spawnCalls).toEqual([]);
      expect(primaryBridge.restoreCalls).toEqual([]);
      expect(primaryBridge.summaryCalls).toEqual([]);
      expect(secondaryBridge.spawnCalls).toEqual([]);
      expect(secondaryBridge.restoreCalls).toEqual([]);
      expect(secondaryBridge.summaryCalls).toEqual([]);
    });
  });

  it.each([
    ['md', 'text/markdown', 'secondary md export'],
    ['json', 'application/json', 'secondary json export'],
    ['jsonl', 'application/jsonl', 'secondary jsonl export'],
  ])(
    'exports secondary sessions as %s through an encoded cwd selector',
    async (format, mimeType, marker) => {
      await withRuntimeDir(async () => {
        const sessionId = `550e8400-e29b-41d4-a716-${format.padEnd(12, '0')}`;
        await writeStoredSession({
          sessionId,
          cwd: SECONDARY_CWD,
          timestamp: '2026-07-08T00:00:00.000Z',
          prompt: marker,
          mtime: new Date('2026-07-08T00:00:00.000Z'),
        });
        const { app } = makeHarness();

        const response = await request(app)
          .get(
            `/workspaces/${encodeURIComponent(SECONDARY_CWD)}/session/${sessionId}/export?format=${format}`,
          )
          .set('Host', host())
          .expect(200);

        expect(response.headers['content-type']).toContain(mimeType);
        expect(response.headers['content-disposition']).toContain(
          `.${format}"`,
        );
        const content =
          format === 'json' ? JSON.stringify(response.body) : response.text;
        expect(content).toContain(marker);
      });
    },
  );

  it('enforces workspace, trust, format, and active-session export boundaries', async () => {
    await withRuntimeDir(async () => {
      const primaryOnlyId = '550e8400-e29b-41d4-a716-446655440281';
      const archivedId = '550e8400-e29b-41d4-a716-446655440282';
      const conflictId = '550e8400-e29b-41d4-a716-446655440284';
      await writeStoredSession({
        sessionId: primaryOnlyId,
        cwd: PRIMARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'primary only',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      await writeStoredSession({
        sessionId: archivedId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:01:00.000Z',
        prompt: 'archived secondary',
        mtime: new Date('2026-07-08T00:01:00.000Z'),
      });
      await archiveStoredSession(SECONDARY_CWD, archivedId);
      await writeStoredSession({
        sessionId: conflictId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:02:00.000Z',
        prompt: 'conflicting secondary',
        mtime: new Date('2026-07-08T00:02:00.000Z'),
      });
      const secondaryChatsDir = path.join(
        new Storage(SECONDARY_CWD).getProjectDir(),
        'chats',
      );
      await fsp.mkdir(path.join(secondaryChatsDir, 'archive'), {
        recursive: true,
      });
      await fsp.copyFile(
        path.join(secondaryChatsDir, `${conflictId}.jsonl`),
        path.join(secondaryChatsDir, 'archive', `${conflictId}.jsonl`),
      );
      const trusted = makeHarness();

      const missing = await request(trusted.app)
        .get(`/workspaces/secondary-id/session/${primaryOnlyId}/export`)
        .set('Host', host());
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('session_not_found');

      const archived = await request(trusted.app)
        .get(`/workspaces/secondary-id/session/${archivedId}/export`)
        .set('Host', host());
      expect(archived.status).toBe(409);
      expect(archived.body.code).toBe('session_archived');

      const conflict = await request(trusted.app)
        .get(`/workspaces/secondary-id/session/${conflictId}/export`)
        .set('Host', host());
      expect(conflict.status).toBe(200);
      expect(conflict.text).toContain('conflicting secondary');

      const invalidFormat = await request(trusted.app)
        .get(
          `/workspaces/secondary-id/session/${primaryOnlyId}/export?format=pdf`,
        )
        .set('Host', host());
      expect(invalidFormat.status).toBe(400);
      expect(invalidFormat.body).toMatchObject({
        code: 'invalid_export_format',
        format: 'pdf',
        allowedFormats: ['html', 'md', 'json', 'jsonl'],
      });

      const unknown = await request(trusted.app)
        .get(
          `/workspaces/missing-id/session/${primaryOnlyId}/export?format=pdf`,
        )
        .set('Host', host());
      expect(unknown.status).toBe(400);
      expect(unknown.body.code).toBe('workspace_mismatch');

      const untrustedSecondary = makeHarness({ secondaryTrusted: false });
      const forbiddenSecondary = await request(untrustedSecondary.app)
        .get(
          `/workspaces/secondary-id/session/${primaryOnlyId}/export?format=pdf`,
        )
        .set('Host', host());
      expect(forbiddenSecondary.status).toBe(403);
      expect(forbiddenSecondary.body.code).toBe('untrusted_workspace');

      const untrustedPrimary = makeHarness({ primaryTrusted: false });
      const forbiddenPrimary = await request(untrustedPrimary.app)
        .get(
          `/workspaces/primary-id/session/${primaryOnlyId}/export?format=pdf`,
        )
        .set('Host', host());
      expect(forbiddenPrimary.status).toBe(403);
      expect(forbiddenPrimary.body.code).toBe('untrusted_workspace');
    });
  });

  it('preserves ordinary batch conflict results while an internal runtime is active', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440283';
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'secondary export lock marker',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      let loadStarted!: () => void;
      let releaseLoad!: () => void;
      const loadStartedPromise = new Promise<void>((resolve) => {
        loadStarted = resolve;
      });
      const loadReleasedPromise = new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });
      const originalLoadSession = SessionService.prototype.loadSession;
      const loadSpy = vi
        .spyOn(SessionService.prototype, 'loadSession')
        .mockImplementation(async function (this: SessionService, id) {
          const result = await originalLoadSession.call(this, id);
          if (id === sessionId) {
            loadStarted();
            await loadReleasedPromise;
          }
          return result;
        });
      const { app, registry } = makeHarness({ secondarySummaries: [] });
      const conversationCwd = path.join(SECONDARY_CWD, '.conversations');
      registry.add(
        makeRuntime({
          workspaceId: 'conversations-id',
          workspaceCwd: conversationCwd,
          primary: false,
          trusted: true,
          provenance: 'live-conversation',
          bridge: makeBridge(conversationCwd, []),
        }),
      );
      const exportPromise = request(app)
        .get(`/workspaces/secondary-id/session/${sessionId}/export`)
        .set('Host', host())
        .then((response) => response);

      try {
        await loadStartedPromise;
        const archive = await request(app)
          .post('/workspaces/secondary-id/sessions/archive')
          .set('Host', host())
          .send({ sessionIds: [sessionId] });
        expect(archive.status).toBe(200);
        expect(archive.body).toMatchObject({
          archived: [],
          errors: [
            {
              sessionId,
              error: expect.stringContaining('is being archived or unarchived'),
            },
          ],
        });

        const remove = await request(app)
          .post('/workspaces/secondary-id/sessions/delete')
          .set('Host', host())
          .send({ sessionIds: [sessionId] });
        expect(remove.status).toBe(200);
        expect(remove.body.removed).toEqual([]);
        expect(remove.body.errors).toEqual([
          {
            sessionId,
            error: expect.stringContaining('is being archived or unarchived'),
          },
        ]);

        releaseLoad();
        const exported = await exportPromise;
        expect(exported.status).toBe(200);
        expect(exported.text).toContain('secondary export lock marker');
      } finally {
        releaseLoad();
        loadSpy.mockRestore();
        await Promise.allSettled([exportPromise]);
      }
    });
  });

  it('exports only the selected workspace archived transcript in every format', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440285';
      await writeStoredSession({
        sessionId,
        cwd: PRIMARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'primary active collision marker',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      const archivedMarker = `secondary archived collision marker ${'x'.repeat(
        128 * 1024,
      )}`;
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:01:00.000Z',
        prompt: archivedMarker,
        mtime: new Date('2026-07-08T00:01:00.000Z'),
      });
      await archiveStoredSession(SECONDARY_CWD, sessionId);
      const { app, primaryBridge, secondaryBridge } = makeHarness();

      for (const [format, mimeType] of [
        ['html', 'text/html'],
        ['md', 'text/markdown'],
        ['json', 'application/json'],
        ['jsonl', 'application/jsonl'],
      ] as const) {
        const response = await request(app)
          .get(
            `/workspaces/${encodeURIComponent(SECONDARY_CWD)}/session/${sessionId}/archive/export?format=${format}`,
          )
          .set('Host', host())
          .expect(200);

        expect(response.headers['content-type']).toContain(mimeType);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['content-disposition']).toContain(
          `.${format}"`,
        );
        expect(response.text).toContain('secondary archived collision marker');
        expect(response.text).not.toContain('primary active collision marker');
      }

      expect(primaryBridge.spawnCalls).toEqual([]);
      expect(primaryBridge.restoreCalls).toEqual([]);
      expect(primaryBridge.summaryCalls).toEqual([]);
      expect(secondaryBridge.spawnCalls).toEqual([]);
      expect(secondaryBridge.restoreCalls).toEqual([]);
      expect(secondaryBridge.summaryCalls).toEqual([]);
      expect(secondaryBridge.closeCalls).toEqual([]);
    });
  });

  it('enforces archived export state, selector, trust, and format boundaries', async () => {
    await withRuntimeDir(async () => {
      const activeId = '550e8400-e29b-41d4-a716-446655440286';
      const missingId = '550e8400-e29b-41d4-a716-446655440287';
      const conflictId = '550e8400-e29b-41d4-a716-446655440288';
      await writeStoredSession({
        sessionId: activeId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'active secondary',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      await writeStoredSession({
        sessionId: missingId,
        cwd: PRIMARY_CWD,
        timestamp: '2026-07-08T00:01:00.000Z',
        prompt: 'other workspace only',
        mtime: new Date('2026-07-08T00:01:00.000Z'),
      });
      await writeStoredSession({
        sessionId: conflictId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:02:00.000Z',
        prompt: 'conflicting secondary',
        mtime: new Date('2026-07-08T00:02:00.000Z'),
      });
      const chatsDir = path.join(
        new Storage(SECONDARY_CWD).getProjectDir(),
        'chats',
      );
      await fsp.mkdir(path.join(chatsDir, 'archive'), { recursive: true });
      await fsp.copyFile(
        path.join(chatsDir, `${conflictId}.jsonl`),
        path.join(chatsDir, 'archive', `${conflictId}.jsonl`),
      );
      const trusted = makeHarness();

      const active = await request(trusted.app)
        .get(`/workspaces/secondary-id/session/${activeId}/archive/export`)
        .set('Host', host());
      expect(active.status).toBe(409);
      expect(active.body).toMatchObject({
        code: 'session_not_archived',
        sessionId: activeId,
      });

      const missing = await request(trusted.app)
        .get(`/workspaces/secondary-id/session/${missingId}/archive/export`)
        .set('Host', host());
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({
        code: 'session_not_found',
        sessionId: missingId,
      });

      const conflict = await request(trusted.app)
        .get(`/workspaces/secondary-id/session/${conflictId}/archive/export`)
        .set('Host', host());
      expect(conflict.status).toBe(409);
      expect(conflict.body).toMatchObject({
        code: 'session_conflict',
        sessionId: conflictId,
      });

      const invalidFormat = await request(trusted.app)
        .get(
          `/workspaces/secondary-id/session/${conflictId}/archive/export?format=pdf`,
        )
        .set('Host', host());
      expect(invalidFormat.status).toBe(400);
      expect(invalidFormat.body.code).toBe('invalid_export_format');

      const unknown = await request(trusted.app)
        .get(
          `/workspaces/missing-id/session/${missingId}/archive/export?format=pdf`,
        )
        .set('Host', host());
      expect(unknown.status).toBe(400);
      expect(unknown.body.code).toBe('workspace_mismatch');

      const untrusted = makeHarness({ secondaryTrusted: false });
      const forbidden = await request(untrusted.app)
        .get(
          `/workspaces/secondary-id/session/${missingId}/archive/export?format=pdf`,
        )
        .set('Host', host());
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe('untrusted_workspace');
    });
  });

  it('rejects archived exports above the persisted source size limit', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440291';
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'oversized archived export',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      await archiveStoredSession(SECONDARY_CWD, sessionId);
      const archivedPath = path.join(
        new Storage(SECONDARY_CWD).getProjectDir(),
        'chats',
        'archive',
        `${sessionId}.jsonl`,
      );
      await fsp.truncate(archivedPath, SESSION_TRANSCRIPT_MAX_INDEX_BYTES + 1);
      const { app } = makeHarness({ secondarySummaries: [] });

      const response = await request(app)
        .get(`/workspaces/secondary-id/session/${sessionId}/archive/export`)
        .set('Host', host());

      expect(response.status).toBe(413);
      expect(response.body).toMatchObject({
        code: 'transcript_too_large',
        sessionId,
        snapshotSize: SESSION_TRANSCRIPT_MAX_INDEX_BYTES + 1,
        maxBytes: SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
      });
    });
  });

  it('reports unarchive and delete conflicts while archived export is in flight', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440289';
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'archived export lock marker',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      await archiveStoredSession(SECONDARY_CWD, sessionId);
      let loadStarted!: () => void;
      let releaseLoad!: () => void;
      const loadStartedPromise = new Promise<void>((resolve) => {
        loadStarted = resolve;
      });
      const loadReleasedPromise = new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });
      const originalLoad = SessionService.prototype.loadArchivedSession;
      const loadSpy = vi
        .spyOn(SessionService.prototype, 'loadArchivedSession')
        .mockImplementation(async function (this: SessionService, id, opts) {
          const result = await originalLoad.call(this, id, opts);
          if (id === sessionId) {
            loadStarted();
            await loadReleasedPromise;
          }
          return result;
        });
      const { app } = makeHarness({ secondarySummaries: [] });
      const exportPromise = request(app)
        .get(`/workspaces/secondary-id/session/${sessionId}/archive/export`)
        .set('Host', host())
        .then((response) => response);

      try {
        await loadStartedPromise;
        const unarchive = await request(app)
          .post('/workspaces/secondary-id/sessions/unarchive')
          .set('Host', host())
          .send({ sessionIds: [sessionId] });
        expect(unarchive.status).toBe(200);
        expect(unarchive.body).toMatchObject({
          unarchived: [],
          errors: [
            {
              sessionId,
              error: expect.stringContaining('is being archived or unarchived'),
            },
          ],
        });

        const remove = await request(app)
          .post('/workspaces/secondary-id/sessions/delete')
          .set('Host', host())
          .send({ sessionIds: [sessionId] });
        expect(remove.status).toBe(200);
        expect(remove.body.removed).toEqual([]);
        expect(remove.body.errors).toEqual([
          {
            sessionId,
            error: expect.stringContaining('is being archived or unarchived'),
          },
        ]);
        await expect(
          new SessionService(SECONDARY_CWD).getSessionLocation(sessionId),
        ).resolves.toBe('archived');

        releaseLoad();
        const exported = await exportPromise;
        expect(exported.status).toBe(200);
        expect(exported.text).toContain('archived export lock marker');
      } finally {
        releaseLoad();
        loadSpy.mockRestore();
        await Promise.allSettled([exportPromise]);
      }
    });
  });

  it('returns session_archiving while unarchive holds the exclusive lease', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440290';
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'exclusive transition marker',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      await archiveStoredSession(SECONDARY_CWD, sessionId);
      let unarchiveStarted!: () => void;
      let releaseUnarchive!: () => void;
      const unarchiveStartedPromise = new Promise<void>((resolve) => {
        unarchiveStarted = resolve;
      });
      const unarchiveReleasedPromise = new Promise<void>((resolve) => {
        releaseUnarchive = resolve;
      });
      const originalUnarchive = SessionService.prototype.unarchiveSessions;
      const unarchiveSpy = vi
        .spyOn(SessionService.prototype, 'unarchiveSessions')
        .mockImplementation(async function (this: SessionService, ids, opts) {
          if (ids.includes(sessionId)) {
            unarchiveStarted();
            await unarchiveReleasedPromise;
          }
          return originalUnarchive.call(this, ids, opts);
        });
      const { app } = makeHarness({ secondarySummaries: [] });
      const unarchivePromise = request(app)
        .post('/workspaces/secondary-id/sessions/unarchive')
        .set('Host', host())
        .send({ sessionIds: [sessionId] })
        .then((response) => response);

      try {
        await unarchiveStartedPromise;
        const exported = await request(app)
          .get(`/workspaces/secondary-id/session/${sessionId}/archive/export`)
          .set('Host', host());
        expect(exported.status).toBe(409);
        expect(exported.headers['retry-after']).toBe('5');
        expect(exported.body).toMatchObject({
          code: 'session_archiving',
          sessionId,
        });

        releaseUnarchive();
        const unarchived = await unarchivePromise;
        expect(unarchived.status).toBe(200);
        expect(unarchived.body.unarchived).toEqual([sessionId]);
      } finally {
        releaseUnarchive();
        unarchiveSpy.mockRestore();
        await Promise.allSettled([unarchivePromise]);
      }
    });
  });

  it('lists session groups for an untrusted secondary while mutations stay blocked', async () => {
    await withRuntimeDir(async () => {
      const service = createSessionOrganizationService(SECONDARY_CWD);
      const group = await service.createGroup({
        name: 'Read only group',
        color: 'blue',
      });
      const before = await fsp.readFile(service.getStorePath(), 'utf8');
      const { app } = makeHarness({ secondaryTrusted: false });

      for (const route of [
        '/workspaces/secondary-id/session-groups',
        `/workspaces/${encodeURIComponent(SECONDARY_CWD)}/session-groups`,
        '/workspace/secondary-id/session-groups',
        `/workspace/${encodeURIComponent(SECONDARY_CWD)}/session-groups`,
      ]) {
        const res = await request(app)
          .get(route)
          .set('Host', host())
          .expect(200);
        expect(
          (res.body.groups as Array<{ id: string }>).map((item) => item.id),
        ).toContain(group.id);
      }
      expect(await fsp.readFile(service.getStorePath(), 'utf8')).toBe(before);

      await request(app)
        .post('/workspaces/secondary-id/session-groups')
        .set('Host', host())
        .send({ name: 'Blocked', color: 'red' })
        .expect(403);
      await request(app)
        .patch(`/workspaces/secondary-id/session-groups/${group.id}`)
        .set('Host', host())
        .send({ name: 'Blocked' })
        .expect(403);
      await request(app)
        .delete(`/workspaces/secondary-id/session-groups/${group.id}`)
        .set('Host', host())
        .expect(403);

      await request(app)
        .post('/workspace/secondary-id/session-groups')
        .set('Host', host())
        .send({ name: 'Blocked', color: 'red' })
        .expect(400);
      await request(app)
        .patch(`/workspace/secondary-id/session-groups/${group.id}`)
        .set('Host', host())
        .send({ name: 'Blocked' })
        .expect(400);
      await request(app)
        .delete(`/workspace/secondary-id/session-groups/${group.id}`)
        .set('Host', host())
        .expect(400);
      expect(await fsp.readFile(service.getStorePath(), 'utf8')).toBe(before);
    });
  });

  it('rejects untrusted primary workspace on plural session routes', async () => {
    const daemonLog = makeDaemonLog();
    const { app } = makeHarness({
      primaryTrusted: false,
      daemonLog,
    });

    for (const [route, routeLabel] of [
      [
        '/workspaces/primary-id/sessions',
        'GET /workspaces/:workspace/sessions',
      ],
      [
        '/workspaces/primary-id/session-groups',
        'GET /workspaces/:workspace/session-groups',
      ],
    ] as const) {
      const res = await request(app).get(route).set('Host', host());

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('untrusted_workspace');
      expect(res.body.error).toBe('Workspace is not trusted.');
      expect(res.body).not.toHaveProperty('workspaceCwd');
      expect(res.body).not.toHaveProperty('workspaceId');
      expect(daemonLog.warn).toHaveBeenCalledWith(
        'session routing failed',
        expect.objectContaining({
          route: routeLabel,
          resolutionKind: 'untrusted_workspace',
          workspaceCwd: PRIMARY_CWD,
        }),
      );
    }

    await request(app)
      .get('/workspace/primary-id/sessions')
      .set('Host', host())
      .expect(200);
    await request(app)
      .get('/workspace/primary-id/session-groups')
      .set('Host', host())
      .expect(200);
  });

  it('updates a persisted secondary session by encoded cwd without touching the primary sidecar', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440160';
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:30:00.000Z',
        prompt: 'secondary pin target',
        mtime: new Date('2026-07-08T00:30:00.000Z'),
      });
      const { app } = makeHarness({ secondarySummaries: [] });
      const createdGroup = await request(app)
        .post('/workspaces/secondary-id/session-groups')
        .set('Host', host())
        .send({ name: 'Secondary Work', color: 'blue' })
        .expect(201);
      const groupId = createdGroup.body.group.id as string;

      const updated = await request(app)
        .patch(
          `/workspaces/${encodeURIComponent(SECONDARY_CWD)}/session/${sessionId}/organization`,
        )
        .set('Host', host())
        .send({ isPinned: true, groupId });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({
        sessionId,
        isPinned: true,
        groupId,
      });

      const pinned = await request(app)
        .get('/workspaces/secondary-id/sessions?view=organized&group=pinned')
        .set('Host', host())
        .expect(200);
      expect(pinned.body.sessions).toEqual([
        expect.objectContaining({
          sessionId,
          isPinned: true,
          groupId,
        }),
      ]);

      const grouped = await request(app)
        .get(
          `/workspaces/secondary-id/sessions?view=organized&group=${encodeURIComponent(groupId)}`,
        )
        .set('Host', host())
        .expect(200);
      expect(grouped.body.sessions).toEqual([
        expect.objectContaining({ sessionId, groupId }),
      ]);

      const colored = await request(app)
        .patch(`/workspaces/secondary-id/session/${sessionId}/organization`)
        .set('Host', host())
        .send({ color: 'purple' });
      expect(colored.status).toBe(200);
      expect(colored.body).toMatchObject({
        sessionId,
        groupId,
        color: 'purple',
      });

      const organized = await request(app)
        .get('/workspaces/secondary-id/sessions?view=organized&group=all')
        .set('Host', host())
        .expect(200);
      expect(organized.body.sessions).toEqual([
        expect.objectContaining({ sessionId, groupId, color: 'purple' }),
      ]);

      const ungrouped = await request(app)
        .patch(`/workspaces/secondary-id/session/${sessionId}/organization`)
        .set('Host', host())
        .send({ groupId: null })
        .expect(200);
      expect(ungrouped.body).toMatchObject({
        sessionId,
        groupId: null,
        color: 'purple',
      });

      const clearedColor = await request(app)
        .patch(`/workspaces/secondary-id/session/${sessionId}/organization`)
        .set('Host', host())
        .send({ color: null })
        .expect(200);
      expect(clearedColor.body).toMatchObject({
        sessionId,
        groupId: null,
        color: null,
      });

      const secondarySnapshot =
        await createSessionOrganizationService(SECONDARY_CWD).readSnapshot();
      const primarySnapshot =
        await createSessionOrganizationService(PRIMARY_CWD).readSnapshot();
      expect(secondarySnapshot.sessions.get(sessionId)).toMatchObject({
        isPinned: true,
        groupId: null,
        color: null,
      });
      expect(primarySnapshot.sessions.has(sessionId)).toBe(false);
    });
  });

  it('updates a live-only secondary session organization through the target bridge fallback', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440161';
      const missingSessionId = '550e8400-e29b-41d4-a716-446655440163';
      const { app } = makeHarness({
        secondarySummaries: [makeSummary(sessionId, SECONDARY_CWD)],
      });

      const missing = await request(app)
        .patch(
          `/workspaces/secondary-id/session/${missingSessionId}/organization`,
        )
        .set('Host', host())
        .send({ isPinned: 'yes' });
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({
        error: `No session with id "${missingSessionId}"`,
        sessionId: missingSessionId,
      });

      const updated = await request(app)
        .patch(`/workspaces/secondary-id/session/${sessionId}/organization`)
        .set('Host', host())
        .send({ isPinned: true });
      expect(updated.status).toBe(200);

      const pinned = await request(app)
        .get('/workspaces/secondary-id/sessions?view=organized&group=pinned')
        .set('Host', host())
        .expect(200);
      expect(pinned.body.sessions).toEqual([
        expect.objectContaining({
          sessionId,
          workspaceCwd: SECONDARY_CWD,
          isPinned: true,
        }),
      ]);
    });
  });

  it('rejects organization updates for an untrusted secondary workspace', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440162';
      const { app, secondaryBridge } = makeHarness({
        secondaryTrusted: false,
        secondarySummaries: [makeSummary(sessionId, SECONDARY_CWD)],
      });

      const res = await request(app)
        .patch(`/workspaces/secondary-id/session/${sessionId}/organization`)
        .set('Host', host())
        .send({ isPinned: 'yes' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('untrusted_workspace');
      const secondarySnapshot =
        await createSessionOrganizationService(SECONDARY_CWD).readSnapshot();
      expect(secondarySnapshot.sessions.has(sessionId)).toBe(false);
      expect(secondaryBridge.summaryCalls).toEqual([]);
    });
  });

  it('updates an archived secondary session without changing its archive state', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440164';
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:40:00.000Z',
        prompt: 'secondary archived organization target',
        mtime: new Date('2026-07-08T00:40:00.000Z'),
      });
      const { app } = makeHarness({ secondarySummaries: [] });

      await request(app)
        .post('/workspaces/secondary-id/sessions/archive')
        .set('Host', host())
        .send({ sessionIds: [sessionId] })
        .expect(200);

      const updated = await request(app)
        .patch(`/workspaces/secondary-id/session/${sessionId}/organization`)
        .set('Host', host())
        .send({ isPinned: true, color: 'green' })
        .expect(200);
      expect(updated.body).toMatchObject({
        sessionId,
        isPinned: true,
        color: 'green',
      });

      const archived = await request(app)
        .get(
          '/workspaces/secondary-id/sessions?view=organized&archiveState=archived&group=pinned',
        )
        .set('Host', host())
        .expect(200);
      expect(archived.body.sessions).toEqual([
        expect.objectContaining({
          sessionId,
          isArchived: true,
          isPinned: true,
          color: 'green',
        }),
      ]);
    });
  });

  it('does not fall back across workspaces for organization updates', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440165';
      await writeStoredSession({
        sessionId,
        cwd: PRIMARY_CWD,
        timestamp: '2026-07-08T00:50:00.000Z',
        prompt: 'primary-only organization target',
        mtime: new Date('2026-07-08T00:50:00.000Z'),
      });
      const { app, primaryBridge, secondaryBridge } = makeHarness({
        secondarySummaries: [],
      });

      const res = await request(app)
        .patch(`/workspaces/secondary-id/session/${sessionId}/organization`)
        .set('Host', host())
        .send({ isPinned: true });

      expect(res.status).toBe(404);
      expect(primaryBridge.summaryCalls).toEqual([]);
      expect(secondaryBridge.summaryCalls).toEqual([sessionId]);
      const primarySnapshot =
        await createSessionOrganizationService(PRIMARY_CWD).readSnapshot();
      const secondarySnapshot =
        await createSessionOrganizationService(SECONDARY_CWD).readSnapshot();
      expect(primarySnapshot.sessions.has(sessionId)).toBe(false);
      expect(secondarySnapshot.sessions.has(sessionId)).toBe(false);
    });
  });

  it('rejects an unknown organization workspace selector before probing bridges', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness();

    const res = await request(app)
      .patch(
        '/workspaces/missing-id/session/550e8400-e29b-41d4-a716-446655440166/organization',
      )
      .set('Host', host())
      .send({ isPinned: 'yes' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('workspace_mismatch');
    expect(primaryBridge.summaryCalls).toEqual([]);
    expect(secondaryBridge.summaryCalls).toEqual([]);
  });

  it('keeps organization validation and store errors scoped to the selected workspace', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440167';
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T01:00:00.000Z',
        prompt: 'secondary validation target',
        mtime: new Date('2026-07-08T01:00:00.000Z'),
      });
      const { app } = makeHarness({ secondarySummaries: [] });
      const primaryGroup = await request(app)
        .post('/workspaces/primary-id/session-groups')
        .set('Host', host())
        .send({ name: 'Primary Only', color: 'orange' })
        .expect(201);
      const primaryGroupId = primaryGroup.body.group.id as string;

      const wrongGroup = await request(app)
        .patch(`/workspaces/secondary-id/session/${sessionId}/organization`)
        .set('Host', host())
        .send({ groupId: primaryGroupId });
      expect(wrongGroup.status).toBe(404);
      expect(wrongGroup.body.code).toBe('group_not_found');

      const invalid = await request(app)
        .patch(`/workspaces/secondary-id/session/${sessionId}/organization`)
        .set('Host', host())
        .send({ isPinned: 'yes' });
      expect(invalid.status).toBe(400);
      expect(invalid.body.code).toBe('invalid_session_organization');

      const empty = await request(app)
        .patch(`/workspaces/secondary-id/session/${sessionId}/organization`)
        .set('Host', host())
        .send({});
      expect(empty.status).toBe(200);
      expect(empty.body).toMatchObject({ sessionId, isPinned: false });

      const secondaryService = createSessionOrganizationService(SECONDARY_CWD);
      await fsp.mkdir(path.dirname(secondaryService.getStorePath()), {
        recursive: true,
      });
      await fsp.writeFile(secondaryService.getStorePath(), '{broken', 'utf8');
      const unreadable = await request(app)
        .patch(`/workspaces/secondary-id/session/${sessionId}/organization`)
        .set('Host', host())
        .send({ color: 'red' });
      expect(unreadable.status).toBe(500);
      expect(unreadable.body.code).toBe(
        'session_organization_store_unreadable',
      );

      const primarySnapshot =
        await createSessionOrganizationService(PRIMARY_CWD).readSnapshot();
      expect(primarySnapshot.sessions.has(sessionId)).toBe(false);
    });
  });

  it('routes plural batch archive, unarchive, and delete to the selected workspace', async () => {
    await withRuntimeDir(async () => {
      const archiveId = '550e8400-e29b-41d4-a716-446655440120';
      const deleteId = '550e8400-e29b-41d4-a716-446655440121';
      await writeStoredSession({
        sessionId: archiveId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:10:00.000Z',
        prompt: 'secondary archive target',
        mtime: new Date('2026-07-08T00:10:00.000Z'),
      });
      await writeStoredSession({
        sessionId: deleteId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:11:00.000Z',
        prompt: 'secondary delete target',
        mtime: new Date('2026-07-08T00:11:00.000Z'),
      });
      const { app, primaryBridge, secondaryBridge } = makeHarness({
        secondarySummaries: [],
      });
      const list = (archiveState: 'active' | 'archived') =>
        request(app)
          .get(
            `/workspaces/secondary-id/sessions?view=organized&archiveState=${archiveState}&group=all`,
          )
          .set('Host', host());
      const listedIds = async (archiveState: 'active' | 'archived') =>
        (await list(archiveState)).body.sessions.map(
          (session: { sessionId: string }) => session.sessionId,
        );

      expect(await listedIds('active')).toEqual([deleteId, archiveId]);
      expect(await listedIds('archived')).toEqual([]);

      const archived = await request(app)
        .post('/workspaces/secondary-id/sessions/archive')
        .set('Host', host())
        .send({ sessionIds: [archiveId] })
        .expect(200);
      expect(archived.body).toMatchObject({
        archived: [archiveId],
        alreadyArchived: [],
        notFound: [],
        errors: [],
      });
      expect(await listedIds('active')).toEqual([deleteId]);
      expect(await listedIds('archived')).toEqual([archiveId]);

      const unarchived = await request(app)
        .post('/workspaces/secondary-id/sessions/unarchive')
        .set('Host', host())
        .send({ sessionIds: [archiveId] })
        .expect(200);
      expect(unarchived.body).toMatchObject({
        unarchived: [archiveId],
        alreadyActive: [],
        notFound: [],
        errors: [],
      });
      expect(await listedIds('active')).toEqual([deleteId, archiveId]);
      expect(await listedIds('archived')).toEqual([]);

      const deleted = await request(app)
        .post('/workspaces/secondary-id/sessions/delete')
        .set('Host', host())
        .send({ sessionIds: [deleteId] })
        .expect(200);
      expect(deleted.body).toMatchObject({
        removed: [deleteId],
        notFound: [],
        errors: [],
      });
      expect(await listedIds('active')).toEqual([archiveId]);
      expect(await listedIds('archived')).toEqual([]);
      expect(primaryBridge.closeCalls).toEqual([]);
      expect(secondaryBridge.closeCalls).toEqual([archiveId, deleteId]);
    });
  });

  it('archives and unarchives only the selected workspace when session ids collide', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440122';
      await writeStoredSession({
        sessionId,
        cwd: PRIMARY_CWD,
        timestamp: '2026-07-08T00:12:00.000Z',
        prompt: 'primary collision target',
        mtime: new Date('2026-07-08T00:12:00.000Z'),
      });
      await writeStoredSession({
        sessionId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:13:00.000Z',
        prompt: 'secondary collision target',
        mtime: new Date('2026-07-08T00:13:00.000Z'),
      });
      const primaryChatsDir = path.join(
        new Storage(PRIMARY_CWD).getProjectDir(),
        'chats',
      );
      const secondaryChatsDir = path.join(
        new Storage(SECONDARY_CWD).getProjectDir(),
        'chats',
      );
      const primaryActivePath = path.join(
        primaryChatsDir,
        `${sessionId}.jsonl`,
      );
      const primaryArchivedPath = path.join(
        primaryChatsDir,
        'archive',
        `${sessionId}.jsonl`,
      );
      const secondaryActivePath = path.join(
        secondaryChatsDir,
        `${sessionId}.jsonl`,
      );
      const secondaryArchivedPath = path.join(
        secondaryChatsDir,
        'archive',
        `${sessionId}.jsonl`,
      );
      const { app, primaryBridge, secondaryBridge } = makeHarness({
        primarySummaries: [],
        secondarySummaries: [],
      });

      const archived = await request(app)
        .post('/workspaces/secondary-id/sessions/archive')
        .set('Host', host())
        .send({ sessionIds: [sessionId] })
        .expect(200);
      expect(archived.body).toMatchObject({
        archived: [sessionId],
        alreadyArchived: [],
        notFound: [],
        errors: [],
      });
      await expect(fsp.readFile(primaryActivePath, 'utf8')).resolves.toContain(
        'primary collision target',
      );
      await expect(fsp.stat(primaryArchivedPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(
        fsp.readFile(secondaryArchivedPath, 'utf8'),
      ).resolves.toContain('secondary collision target');
      await expect(fsp.stat(secondaryActivePath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(primaryBridge.closeCalls).toEqual([]);
      expect(secondaryBridge.closeCalls).toEqual([sessionId]);

      const unarchived = await request(app)
        .post('/workspaces/secondary-id/sessions/unarchive')
        .set('Host', host())
        .send({ sessionIds: [sessionId] })
        .expect(200);
      expect(unarchived.body).toMatchObject({
        unarchived: [sessionId],
        alreadyActive: [],
        notFound: [],
        errors: [],
      });
      await expect(fsp.readFile(primaryActivePath, 'utf8')).resolves.toContain(
        'primary collision target',
      );
      await expect(fsp.stat(primaryArchivedPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(
        fsp.readFile(secondaryActivePath, 'utf8'),
      ).resolves.toContain('secondary collision target');
      await expect(fsp.stat(secondaryArchivedPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(primaryBridge.closeCalls).toEqual([]);
      expect(secondaryBridge.closeCalls).toEqual([sessionId]);
    });
  });

  it('keeps secondary maintenance inside its fixed runtime root', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440123';
      const runtimeRoot = Storage.getRuntimeBaseDir();
      const primaryRuntimeBaseDir = path.join(runtimeRoot, 'primary-runtime');
      const secondaryRuntimeBaseDir = path.join(
        runtimeRoot,
        'secondary-runtime',
      );
      await Storage.runWithResolvedRuntimeBaseDir(primaryRuntimeBaseDir, () =>
        writeStoredSession({
          sessionId,
          cwd: PRIMARY_CWD,
          timestamp: '2026-07-08T00:14:00.000Z',
          prompt: 'primary fixed-root target',
          mtime: new Date('2026-07-08T00:14:00.000Z'),
        }),
      );
      await Storage.runWithResolvedRuntimeBaseDir(secondaryRuntimeBaseDir, () =>
        writeStoredSession({
          sessionId,
          cwd: SECONDARY_CWD,
          timestamp: '2026-07-08T00:15:00.000Z',
          prompt: 'secondary fixed-root target',
          mtime: new Date('2026-07-08T00:15:00.000Z'),
        }),
      );
      const primaryService = new SessionService(PRIMARY_CWD, {
        runtimeBaseDir: primaryRuntimeBaseDir,
      });
      const primaryLease = await primaryService.acquireSessionWriterLease(
        sessionId,
        {
          processKind: 'daemon',
          reclaimPolicy: 'never',
        },
      );

      try {
        const { app } = makeHarness({
          primaryRuntimeBaseDir,
          secondaryRuntimeBaseDir,
          primarySummaries: [],
          secondarySummaries: [],
        });
        const archived = await request(app)
          .post('/workspaces/secondary-id/sessions/archive')
          .set('Host', host())
          .send({ sessionIds: [sessionId] })
          .expect(200);

        expect(archived.body).toMatchObject({
          archived: [sessionId],
          errors: [],
        });
        await expect(
          primaryService.getSessionLocation(sessionId),
        ).resolves.toBe('active');
        await expect(
          new SessionService(SECONDARY_CWD, {
            runtimeBaseDir: secondaryRuntimeBaseDir,
          }).getSessionLocation(sessionId),
        ).resolves.toBe('archived');
      } finally {
        await primaryLease.release();
      }
    });
  });

  it('routes plural session group CRUD to the selected workspace', async () => {
    await withRuntimeDir(async () => {
      const { app } = makeHarness();

      const created = await request(app)
        .post('/workspaces/secondary-id/session-groups')
        .set('Host', host())
        .send({ name: 'Secondary Group', color: 'blue' })
        .expect(201);
      expect(created.body.group).toMatchObject({
        name: 'Secondary Group',
        color: 'blue',
      });
      const groupId = created.body.group.id as string;

      const secondaryList = await request(app)
        .get('/workspaces/secondary-id/session-groups')
        .set('Host', host())
        .expect(200);
      expect(
        (secondaryList.body.groups as Array<{ id: string }>).map(
          (group) => group.id,
        ),
      ).toContain(groupId);

      const primaryList = await request(app)
        .get('/workspaces/primary-id/session-groups')
        .set('Host', host())
        .expect(200);
      expect(
        (primaryList.body.groups as Array<{ id: string }>).map(
          (group) => group.id,
        ),
      ).not.toContain(groupId);

      const updated = await request(app)
        .patch(`/workspaces/secondary-id/session-groups/${groupId}`)
        .set('Host', host())
        .send({ name: 'Secondary Renamed', order: 10 })
        .expect(200);
      expect(updated.body.group).toMatchObject({
        id: groupId,
        name: 'Secondary Renamed',
        order: 10,
      });

      const deleted = await request(app)
        .delete(`/workspaces/secondary-id/session-groups/${groupId}`)
        .set('Host', host())
        .expect(200);
      expect(deleted.body).toEqual({ deleted: true });
    });
  });

  it('pages live non-primary workspace sessions with a stable cursor', async () => {
    const { app } = makeHarness({
      secondarySummaries: [
        makeSummary('secondary-b', SECONDARY_CWD, {
          updatedAt: '2026-07-08T00:03:00.000Z',
        }),
        makeSummary('secondary-a', SECONDARY_CWD, {
          updatedAt: '2026-07-08T00:03:00.000Z',
        }),
        makeSummary('secondary-c', SECONDARY_CWD, {
          updatedAt: '2026-07-08T00:02:00.000Z',
        }),
      ],
    });

    const first = await request(app)
      .get('/workspace/secondary-id/sessions?size=2')
      .set('Host', host())
      .expect(200);
    expect(
      first.body.sessions.map(
        (session: { sessionId: string }) => session.sessionId,
      ),
    ).toEqual(['secondary-a', 'secondary-b']);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await request(app)
      .get(
        `/workspace/secondary-id/sessions?size=2&cursor=${encodeURIComponent(
          first.body.nextCursor as string,
        )}`,
      )
      .set('Host', host())
      .expect(200);
    expect(
      second.body.sessions.map(
        (session: { sessionId: string }) => session.sessionId,
      ),
    ).toEqual(['secondary-c']);
    expect(second.body.nextCursor).toBeUndefined();
  });

  it('keeps live cursor pagination stable when persisted sessions appear mid-page', async () => {
    await withRuntimeDir(async () => {
      const { app } = makeHarness({
        secondarySummaries: [
          makeSummary('secondary-b', SECONDARY_CWD, {
            updatedAt: '2026-07-08T00:03:00.000Z',
          }),
          makeSummary('secondary-a', SECONDARY_CWD, {
            updatedAt: '2026-07-08T00:03:00.000Z',
          }),
          makeSummary('secondary-c', SECONDARY_CWD, {
            updatedAt: '2026-07-08T00:02:00.000Z',
          }),
        ],
      });

      const first = await request(app)
        .get('/workspace/secondary-id/sessions?size=2')
        .set('Host', host())
        .expect(200);
      expect(
        first.body.sessions.map(
          (session: { sessionId: string }) => session.sessionId,
        ),
      ).toEqual(['secondary-a', 'secondary-b']);
      expect(first.body.nextCursor).toEqual(expect.any(String));

      await writeStoredSession({
        sessionId: '550e8400-e29b-41d4-a716-446655440107',
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:04:00.000Z',
        prompt: 'secondary persisted appeared mid-page',
        mtime: new Date('2026-07-08T00:04:00.000Z'),
      });

      const second = await request(app)
        .get(
          `/workspace/secondary-id/sessions?size=2&cursor=${encodeURIComponent(
            first.body.nextCursor as string,
          )}`,
        )
        .set('Host', host())
        .expect(200);
      expect(
        second.body.sessions.map(
          (session: { sessionId: string }) => session.sessionId,
        ),
      ).toEqual(['secondary-c']);
      expect(second.body.nextCursor).toBeUndefined();
    });
  });
});

describe('workspace session live-state route', () => {
  const liveStatePath = (selector: string) =>
    `/workspaces/${selector}/sessions/live-state`;

  it('returns the exact v1 shape with projected volatile fields and no-store', async () => {
    const { app } = makeHarness({
      primarySummaries: [
        makeSummary('11111111-1111-4111-a111-111111111111', PRIMARY_CWD, {
          displayName: 'Visible name',
          updatedAt: '2026-07-08T00:02:00.000Z',
          clientCount: 2,
          hasActivePrompt: true,
          isWaitingForPermission: true,
          isWaitingForUserQuestion: false,
          pendingInteractionCount: 1,
          hasTurnError: true,
        }),
      ],
    });

    const res = await request(app)
      .get(liveStatePath('primary-id'))
      .set('Host', host())
      .expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.v).toBe(1);
    expect(res.body.catalogVersion).toEqual({
      generation: expect.any(String),
      revision: expect.any(Number),
    });
    // Exactly the volatile overlay plus the activity watermark — the static
    // catalog field (displayName) and the deliberately excluded volatile
    // extras (pendingInteractionCount, hasTurnError) all stay out.
    expect(res.body.sessions).toEqual([
      {
        sessionId: '11111111-1111-4111-a111-111111111111',
        clientCount: 2,
        hasActivePrompt: true,
        isWaitingForPermission: true,
        isWaitingForUserQuestion: false,
        updatedAt: '2026-07-08T00:02:00.000Z',
      },
    ]);
  });

  it('omits updatedAt when the bridge summary has no activity watermark', async () => {
    // A live entry that has not settled a running turn in this bridge (fresh
    // spawn, restore) legitimately carries no watermark. The key must be
    // absent rather than null so old clients decode the response unchanged.
    const { app } = makeHarness({
      primarySummaries: [
        makeSummary('11111111-1111-4111-a111-111111111111', PRIMARY_CWD, {
          updatedAt: undefined,
        }),
      ],
    });

    const res = await request(app)
      .get(liveStatePath('primary-id'))
      .set('Host', host())
      .expect(200);

    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0]).not.toHaveProperty('updatedAt');
  });

  it('defaults both wait flags to false when the bridge omits them', async () => {
    // BridgeSessionSummary types both wait flags optional; a bridge that omits
    // them must not serialize a missing key where the SDK snapshot promises a
    // boolean.
    const { app } = makeHarness({
      primarySummaries: [
        makeSummary('11111111-1111-4111-a111-111111111111', PRIMARY_CWD),
      ],
    });

    const res = await request(app)
      .get(liveStatePath('primary-id'))
      .set('Host', host())
      .expect(200);

    expect(res.body.sessions).toEqual([
      {
        sessionId: '11111111-1111-4111-a111-111111111111',
        clientCount: 1,
        hasActivePrompt: false,
        isWaitingForPermission: false,
        isWaitingForUserQuestion: false,
        updatedAt: '2026-07-08T00:01:00.000Z',
      },
    ]);
  });

  it('returns an empty complete snapshot for an empty live runtime', async () => {
    const { app } = makeHarness({ primarySummaries: [] });
    const res = await request(app)
      .get(liveStatePath('primary-id'))
      .set('Host', host())
      .expect(200);
    expect(res.body.sessions).toEqual([]);
    expect(res.body.catalogVersion.revision).toBe(0);
  });

  it('reads only the selected workspace bridge for trusted selectors', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness({
      primarySummaries: [
        makeSummary('11111111-1111-4111-a111-111111111111', PRIMARY_CWD, {
          updatedAt: '2026-07-08T00:05:00.000Z',
        }),
      ],
      secondarySummaries: [
        makeSummary('secondary-a', SECONDARY_CWD),
        makeSummary('secondary-b', SECONDARY_CWD, {
          hasActivePrompt: true,
          updatedAt: '2026-07-08T00:03:00.000Z',
        }),
      ],
    });

    const res = await request(app)
      .get(liveStatePath('secondary-id'))
      .set('Host', host())
      .expect(200);

    expect(
      res.body.sessions.map((s: { sessionId: string }) => s.sessionId).sort(),
    ).toEqual(['secondary-a', 'secondary-b']);
    // The watermark comes from the selected bridge only; the primary's value
    // must not leak into a secondary response.
    expect(
      res.body.sessions.find(
        (s: { sessionId: string }) => s.sessionId === 'secondary-b',
      ).updatedAt,
    ).toBe('2026-07-08T00:03:00.000Z');
    expect(secondaryBridge.listCalls).toEqual([SECONDARY_CWD]);
    expect(primaryBridge.listCalls).toEqual([]);
  });

  it('rejects an untrusted runtime with 403 before any bridge read', async () => {
    const { app, secondaryBridge } = makeHarness({
      secondaryTrusted: false,
      secondarySummaries: [
        makeSummary('22222222-2222-4222-a222-222222222222', SECONDARY_CWD),
      ],
    });

    const res = await request(app)
      .get(liveStatePath('secondary-id'))
      .set('Host', host())
      .expect(403);
    expect(res.body.code).toBe('untrusted_workspace');
    expect(secondaryBridge.listCalls).toEqual([]);
  });

  it('rejects an unknown selector with 400 and never falls back to primary', async () => {
    const { app, primaryBridge } = makeHarness();
    const res = await request(app)
      .get(liveStatePath('not%3Aa%3Aselector'))
      .set('Host', host())
      .expect(400);
    expect(res.body.code).toBe('workspace_mismatch');
    expect(primaryBridge.listCalls).toEqual([]);
  });

  it('keeps the 503 semantics for a transitioning runtime generation', async () => {
    const { app, registry } = makeHarness();
    const entry = registry.getEntryByWorkspaceId('secondary-id');
    expect(entry).toBeDefined();
    registry.beginReplacement(entry!, 'policy-2');

    const res = await request(app)
      .get(liveStatePath('secondary-id'))
      .set('Host', host())
      .expect(503);
    expect(res.body.code).toBe('workspace_runtime_unavailable');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('exposes a new version only after invalidating both catalog cache scopes', async () => {
    await withRuntimeDir(async () => {
      const activeOne = '550e8400-e29b-41d4-a716-446655440201';
      const archivedOne = '550e8400-e29b-41d4-a716-446655440202';
      await writeStoredSession({
        sessionId: activeOne,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'active one',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      await writeStoredSession({
        sessionId: archivedOne,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:01:00.000Z',
        prompt: 'archived one',
        mtime: new Date('2026-07-08T01:01:00.000Z'),
      });
      await archiveStoredSession(SECONDARY_CWD, archivedOne);
      const { app, secondaryBridge } = makeHarness({
        secondarySummaries: [],
      });

      const organized = (query: string) =>
        request(app)
          .get(`/workspaces/secondary-id/sessions?view=organized${query}`)
          .set('Host', host())
          .expect(200);
      const ids = (body: { sessions: Array<{ sessionId: string }> }) =>
        body.sessions.map((s) => s.sessionId);

      // Pin the bridge's first live-state exposure BEFORE the caches fill,
      // so the invalidation asserted below can only come from the
      // version-comparison arm — never the first-exposure arm.
      await request(app)
        .get(liveStatePath('secondary-id'))
        .set('Host', host())
        .expect(200);

      // Populate both cache scopes inside the two-second TTL.
      expect(ids((await organized('')).body)).toEqual([activeOne]);
      expect(ids((await organized('&archiveState=archived')).body)).toEqual([
        archivedOne,
      ]);

      // A daemon-observed mutation lands and advances the catalog clock.
      const activeTwo = '550e8400-e29b-41d4-a716-446655440203';
      const archivedTwo = '550e8400-e29b-41d4-a716-446655440204';
      await writeStoredSession({
        sessionId: activeTwo,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:02:00.000Z',
        prompt: 'active two',
        mtime: new Date('2026-07-08T00:02:00.000Z'),
      });
      await writeStoredSession({
        sessionId: archivedTwo,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:03:00.000Z',
        prompt: 'archived two',
        mtime: new Date('2026-07-08T01:03:00.000Z'),
      });
      await archiveStoredSession(SECONDARY_CWD, archivedTwo);
      secondaryBridge.markSessionCatalogChanged();

      // The live-state exposure invalidates both scopes before answering.
      const live = await request(app)
        .get(liveStatePath('secondary-id'))
        .set('Host', host())
        .expect(200);
      expect(live.body.catalogVersion.revision).toBe(1);
      expect(ids((await organized('')).body).sort()).toEqual([
        activeOne,
        activeTwo,
      ]);
      expect(
        ids((await organized('&archiveState=archived')).body).sort(),
      ).toEqual([archivedOne, archivedTwo]);

      // An unchanged high-frequency poll must not invalidate again: a third
      // direct write stays hidden behind the still-fresh cache generation.
      const activeThree = '550e8400-e29b-41d4-a716-446655440205';
      await writeStoredSession({
        sessionId: activeThree,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:04:00.000Z',
        prompt: 'active three',
        mtime: new Date('2026-07-08T00:04:00.000Z'),
      });
      await request(app)
        .get(liveStatePath('secondary-id'))
        .set('Host', host())
        .expect(200);
      expect(ids((await organized('')).body).sort()).toEqual([
        activeOne,
        activeTwo,
      ]);
    });
  });

  it('invalidates both organized cache scopes on the first live-state exposure, revision unchanged', async () => {
    await withRuntimeDir(async () => {
      const activeOne = '550e8400-e29b-41d4-a716-446655440211';
      const archivedOne = '550e8400-e29b-41d4-a716-446655440212';
      await writeStoredSession({
        sessionId: activeOne,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'active one',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      await writeStoredSession({
        sessionId: archivedOne,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:01:00.000Z',
        prompt: 'archived one',
        mtime: new Date('2026-07-08T01:01:00.000Z'),
      });
      await archiveStoredSession(SECONDARY_CWD, archivedOne);
      const { app, secondaryBridge } = makeHarness({
        secondarySummaries: [],
      });

      const organized = (query: string) =>
        request(app)
          .get(`/workspaces/secondary-id/sessions?view=organized${query}`)
          .set('Host', host())
          .expect(200);
      const ids = (body: { sessions: Array<{ sessionId: string }> }) =>
        body.sessions.map((s) => s.sessionId);

      // Deliberately fill both organized scopes BEFORE any live-state request:
      // the invalidation asserted below can only come from the first-exposure
      // arm (no lastExposed entry for this bridge yet), not version comparison.
      expect(ids((await organized('')).body)).toEqual([activeOne]);
      expect(ids((await organized('&archiveState=archived')).body)).toEqual([
        archivedOne,
      ]);

      // A direct write lands WITHOUT advancing the catalog clock.
      const activeTwo = '550e8400-e29b-41d4-a716-446655440213';
      const archivedTwo = '550e8400-e29b-41d4-a716-446655440214';
      await writeStoredSession({
        sessionId: activeTwo,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:02:00.000Z',
        prompt: 'active two',
        mtime: new Date('2026-07-08T00:02:00.000Z'),
      });
      await writeStoredSession({
        sessionId: archivedTwo,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:03:00.000Z',
        prompt: 'archived two',
        mtime: new Date('2026-07-08T01:03:00.000Z'),
      });
      await archiveStoredSession(SECONDARY_CWD, archivedTwo);

      // The revision is unchanged, yet the first exposure must still
      // invalidate both scopes before answering.
      const live = await request(app)
        .get(liveStatePath('secondary-id'))
        .set('Host', host())
        .expect(200);
      expect(live.body.catalogVersion.revision).toBe(0);
      expect(secondaryBridge.getSessionCatalogVersion().revision).toBe(0);
      expect(ids((await organized('')).body).sort()).toEqual([
        activeOne,
        activeTwo,
      ]);
      expect(
        ids((await organized('&archiveState=archived')).body).sort(),
      ).toEqual([archivedOne, archivedTwo]);
    });
  });

  it('advances the version for REST archive, organization, and group writes with exact no-op semantics', async () => {
    await withRuntimeDir(async () => {
      const storedId = '550e8400-e29b-41d4-a716-446655440210';
      await writeStoredSession({
        sessionId: storedId,
        cwd: SECONDARY_CWD,
        timestamp: '2026-07-08T00:00:00.000Z',
        prompt: 'mutation target',
        mtime: new Date('2026-07-08T00:00:00.000Z'),
      });
      const { app, primaryBridge, secondaryBridge } = makeHarness({
        secondarySummaries: [],
      });
      const revision = () =>
        secondaryBridge.getSessionCatalogVersion().revision;
      const primaryRevision = () =>
        primaryBridge.getSessionCatalogVersion().revision;

      const v0 = revision();
      await request(app)
        .patch(`/workspaces/secondary-id/session/${storedId}/organization`)
        .set('Host', host())
        .send({ isPinned: true })
        .expect(200);
      const v1 = revision();
      expect(v1).toBeGreaterThan(v0);

      await request(app)
        .post('/workspaces/secondary-id/session-groups')
        .set('Host', host())
        .send({ name: 'group-a', color: 'red' })
        .expect(201);
      const v2 = revision();
      expect(v2).toBeGreaterThan(v1);

      // A group delete that reports `deleted: false` changes nothing.
      await request(app)
        .delete('/workspaces/secondary-id/session-groups/missing-group')
        .set('Host', host())
        .expect(200);
      expect(revision()).toBe(v2);

      const groups = await request(app)
        .get('/workspaces/secondary-id/session-groups')
        .set('Host', host())
        .expect(200);
      const groupId = groups.body.groups[0]?.id as string;
      expect(groupId).toBeTruthy();
      await request(app)
        .delete(`/workspaces/secondary-id/session-groups/${groupId}`)
        .set('Host', host())
        .expect(200);
      const v3 = revision();
      expect(v3).toBeGreaterThan(v2);

      await request(app)
        .post('/workspaces/secondary-id/sessions/archive')
        .set('Host', host())
        .send({ sessionIds: [storedId] })
        .expect(200);
      expect(revision()).toBeGreaterThan(v3);

      // The plural group update marks too.
      const recreated = await request(app)
        .post('/workspaces/secondary-id/session-groups')
        .set('Host', host())
        .send({ name: 'group-b', color: 'blue' })
        .expect(201);
      const v4 = revision();
      await request(app)
        .patch(
          `/workspaces/secondary-id/session-groups/${recreated.body.group.id}`,
        )
        .set('Host', host())
        .send({ name: 'group-b-renamed' })
        .expect(200);
      expect(revision()).toBeGreaterThan(v4);

      // Legacy singular group routes mark the primary runtime's clock.
      const p0 = primaryRevision();
      const legacyCreated = await request(app)
        .post('/workspace/primary-id/session-groups')
        .set('Host', host())
        .send({ name: 'legacy-group', color: 'red' })
        .expect(201);
      const p1 = primaryRevision();
      expect(p1).toBeGreaterThan(p0);
      await request(app)
        .patch(
          `/workspace/primary-id/session-groups/${legacyCreated.body.group.id}`,
        )
        .set('Host', host())
        .send({ color: 'blue' })
        .expect(200);
      const p2 = primaryRevision();
      expect(p2).toBeGreaterThan(p1);
      await request(app)
        .delete(
          `/workspace/primary-id/session-groups/${legacyCreated.body.group.id}`,
        )
        .set('Host', host())
        .expect(200);
      expect(primaryRevision()).toBeGreaterThan(p2);
    });
  });

  it('does not mark the version from the metadata route — the bridge owns exact rename semantics', async () => {
    // `mutate({ strict: true })` on this route requires a bearer token.
    const { app, primaryBridge } = makeHarness({ token: 'secret' });
    const v0 = primaryBridge.getSessionCatalogVersion().revision;
    await request(app)
      .patch('/session/11111111-1111-4111-a111-111111111111/metadata')
      .set('Host', host())
      .set('Authorization', 'Bearer secret')
      .send({ displayName: 'Renamed' })
      .expect(200);
    // The fake bridge never marks on its own, so any revision change here
    // would be an unconditional route-layer mark — which must not exist.
    expect(primaryBridge.getSessionCatalogVersion().revision).toBe(v0);
    expect(primaryBridge.metadataCalls).toHaveLength(1);
  });
});
