/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import type {
  BridgeSessionSummary,
  HttpAcpBridge,
} from '@qwen-code/acp-bridge/bridgeTypes';
import type {
  BridgeEvent,
  SessionReplaySnapshot,
} from '@qwen-code/acp-bridge/eventBus';
import {
  SessionArtifactAuthorizationError,
  SessionArtifactValidationError,
} from '@qwen-code/acp-bridge/sessionArtifacts';
import {
  CancelSentinelCollisionError,
  InvalidClientIdError,
  InvalidPermissionOptionError,
  PermissionForbiddenError,
  PermissionPolicyNotImplementedError,
  PromptQueueFullError,
  SessionLimitExceededError,
  SessionShellClientRequiredError,
  SessionShellDisabledError,
  TotalSessionLimitExceededError,
} from '@qwen-code/acp-bridge/bridgeErrors';
import { SessionService, Storage } from '@qwen-code/qwen-code-core';
import {
  resetHomeEnvBootstrapForTesting,
  SettingScope,
  SETTINGS_DIRECTORY_NAME,
} from '../../config/settings.js';
import { WorkspaceVoiceError } from '../../services/voice-service.js';
import {
  SetupGithubError,
  type SetupGithubResult,
} from '../../services/setup-github.js';
import {
  MAX_READ_BYTES,
  type ResolvedPath,
  type WorkspaceFileSystem,
  type WorkspaceFileSystemFactory,
} from '../fs/index.js';
import {
  WorkspacePermissionRulesSessionRequiredError,
  WorkspaceSettingsPartialPersistError,
  type DaemonWorkspaceService,
} from '../workspace-service/types.js';
import { type AcpHttpHandle, mountAcpHttp } from './index.js';
import { CdpTunnelRegistry } from '../cdp-tunnel/cdp-tunnel-registry.js';
import {
  mountWorkspaceMemoryRememberRoutes,
  WorkspaceRememberTaskLane,
} from '../workspace-remember.js';
import {
  MAX_TRUST_REASON_LENGTH,
  MAX_VOICE_MODEL_LENGTH,
} from '../validation-limits.js';

const stdioMocks = vi.hoisted(() => ({
  writeStderrLine: vi.fn(),
}));

const setupGithubMocks = vi.hoisted(() => ({
  setupGithub: vi.fn(),
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: stdioMocks.writeStderrLine,
}));

vi.mock('../../services/setup-github.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../services/setup-github.js')
  >('../../services/setup-github.js');
  return {
    ...actual,
    setupGithub: setupGithubMocks.setupGithub,
  };
});

/**
 * End-to-end transport test: boots a real Express server with the ACP
 * Streamable-HTTP transport mounted over a *fake* bridge, then drives it
 * with a real HTTP client (global fetch + manual SSE parsing). This is
 * the automated form of the design doc's local verification plan — it
 * exercises the actual wire protocol (200/202 conventions, both SSE
 * streams, JSON-RPC framing) without needing a model.
 */

interface PushIterable {
  iterable: AsyncIterable<BridgeEvent>;
  push: (e: Omit<BridgeEvent, 'v'>) => void;
  end: () => void;
}

function pushQueue(signal?: AbortSignal): PushIterable {
  const buf: BridgeEvent[] = [];
  let resolveNext: (() => void) | undefined;
  let done = false;
  let nextId = 1;
  const wake = () => {
    resolveNext?.();
    resolveNext = undefined;
  };
  signal?.addEventListener('abort', () => {
    done = true;
    wake();
  });
  const iterable: AsyncIterable<BridgeEvent> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (buf.length) yield buf.shift()!;
        if (done) return;
        await new Promise<void>((r) => (resolveNext = r));
      }
    },
  };
  return {
    iterable,
    push: (e) => {
      buf.push({ v: 1, id: nextId++, ...e } as BridgeEvent);
      wake();
    },
    end: () => {
      done = true;
      wake();
    },
  };
}

// A controllable fake bridge: tests register what `sendPrompt` should do.
class FakeBridge {
  queues = new Map<string, PushIterable>();
  promptBehavior:
    | ((
        sessionId: string,
        q: PushIterable,
        signal?: AbortSignal,
      ) => Promise<unknown>)
    | undefined;
  lastSetModel: unknown;
  lastSpawnScope: string | undefined;
  closeShouldThrow = false;
  closeError: Error | undefined;
  killed: string[] = [];
  cancelled: string[] = [];
  workspaceEvents: BridgeEvent[] = [];
  knownClientIdSet = new Set<string>();
  /** When set, spawnOrAttach/loadSession await it (to simulate a slow bridge). */
  gate: Promise<void> | undefined;
  /** `attached` value loadSession returns (false = spawned-from-disk). */
  loadAttached = true;
  spawnClientId: string | undefined = 'client-1';
  loadRequests: Array<{
    sessionId: string;
    historyReplay?: string;
    clientId?: string;
  }> = [];
  replaySnapshot: SessionReplaySnapshot | undefined;
  loadState: Record<string, unknown> = { replayed: true };
  loadPartial: true | undefined;
  loadReplayError: string | undefined;

  closedSessions: string[] = [];

  async spawnOrAttach(req: { sessionScope?: string }) {
    this.lastSpawnScope = req?.sessionScope;
    if (this.gate) await this.gate;
    return {
      sessionId: 'sess-1',
      workspaceCwd: '/ws',
      attached: false,
      clientId: this.spawnClientId,
    };
  }
  async killSession(sessionId: string) {
    this.killed.push(sessionId);
    return true;
  }

  loadShouldThrow = false;

  async loadSession(req: {
    sessionId: string;
    historyReplay?: string;
    clientId?: string;
  }) {
    this.loadRequests.push(req);
    if (this.loadShouldThrow) throw new Error('load failed');
    if (this.gate) await this.gate;
    return {
      sessionId: req.sessionId,
      workspaceCwd: '/ws',
      attached: this.loadAttached,
      clientId: 'client-load',
      state: this.loadState,
      ...(this.loadPartial ? { partial: this.loadPartial } : {}),
      ...(this.loadReplayError ? { replayError: this.loadReplayError } : {}),
    };
  }

  getSessionReplaySnapshot(_sessionId: string) {
    return this.replaySnapshot;
  }

  async resumeSession(req: { sessionId: string }) {
    return {
      sessionId: req.sessionId,
      workspaceCwd: '/ws',
      attached: true,
      clientId: 'client-resume',
      state: { resumed: true },
    };
  }

  subscribeThrows = false;
  /** Records every subscribeEvents call so tests can assert the resume cursor. */
  subscribeCalls: Array<{ sessionId: string; lastEventId?: number }> = [];
  /** Parallel to `subscribeCalls`: each subscription's abort signal, so a test
   * can detect when a closed stream's pump has actually stopped server-side. */
  subscribeSignals: Array<AbortSignal | undefined> = [];

  subscribeEvents(
    sessionId: string,
    opts?: { signal?: AbortSignal; lastEventId?: number },
  ) {
    if (this.subscribeThrows) throw new Error('subscribe failed');
    this.subscribeCalls.push({ sessionId, lastEventId: opts?.lastEventId });
    this.subscribeSignals.push(opts?.signal);
    const q = pushQueue(opts?.signal);
    this.queues.set(sessionId, q);
    return q.iterable;
  }

  sendPrompt(sessionId: string, _req: unknown, signal?: AbortSignal) {
    const q = this.queues.get(sessionId);
    if (this.promptBehavior && q) {
      return Promise.resolve(this.promptBehavior(sessionId, q, signal));
    }
    return Promise.resolve({ stopReason: 'end_turn' });
  }

  /**
   * Bus head id the daemon stamps as a deferred reply's WATERMARK (`anchorId`)
   * in `replySession`. Configurable per test so the watermark-ordering path can
   * be exercised end-to-end with a REAL anchor (without this method the daemon's
   * try/catch fell back to `anchorId = undefined`, so every integration test
   * only ever hit the unanchored path).
   */
  sessionLastEventId: number | undefined = undefined;
  getSessionLastEventId(_sessionId: string): number | undefined {
    return this.sessionLastEventId;
  }

  respondToSessionPermission() {
    return true;
  }

  async setSessionModel(_s: string, req: unknown) {
    this.lastSetModel = req;
    return { modelServiceId: 'qwen-max' };
  }

  lastApprovalMode: string | undefined;
  async setSessionApprovalMode(_s: string, mode: string) {
    this.lastApprovalMode = mode;
    return { sessionId: 'sess-1', mode, previous: 'default', persisted: false };
  }

  // Session config options live in the child's session context state.
  async getSessionContextStatus(sessionId: string) {
    return {
      v: 1,
      sessionId,
      workspaceCwd: '/ws',
      state: {
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'qwen-max',
            options: [],
          },
        ],
      },
    };
  }
  async getSessionSupportedCommandsStatus(sessionId: string) {
    return { v: 1, sessionId, availableCommands: [], availableSkills: [] };
  }
  updateSessionMetadata(_s: string, metadata: unknown) {
    return metadata;
  }

  recordHeartbeat() {
    return { sessionId: 'sess-1', lastSeenAt: Date.now() };
  }

  workspaceSessions: BridgeSessionSummary[] = [];

  listWorkspaceSessions() {
    return this.workspaceSessions;
  }

  getSessionSummary(sessionId: string) {
    const summary = this.workspaceSessions.find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (summary) return summary;
    if (sessionId === 'sess-1') {
      return { sessionId, workspaceCwd: '/ws' };
    }
    throw new Error(`Session not found: ${sessionId}`);
  }

  detached: Array<{ sessionId: string; clientId?: string }> = [];

  async cancelSession(sessionId: string) {
    this.cancelled.push(sessionId);
  }
  closeGate: Promise<void> | undefined;
  async closeSession(sessionId: string) {
    this.closedSessions.push(sessionId);
    if (this.closeGate) await this.closeGate;
    if (this.closeError) throw this.closeError;
    if (this.closeShouldThrow) throw new Error('bridge close failed');
  }
  async detachClient(sessionId: string, clientId?: string) {
    this.detached.push({ sessionId, clientId });
  }
  async preheat() {}

  // Wave 1+2 stubs
  async generateSessionRecap(sessionId: string) {
    return { sessionId, recap: 'test recap' };
  }
  async generateSessionBtw(sessionId: string, question: string) {
    return { sessionId, answer: `re: ${question}` };
  }
  shellCalls: Array<{
    sessionId: string;
    command: string;
    signal?: AbortSignal;
    context?: unknown;
  }> = [];
  shellError: unknown;
  async executeShellCommand(
    sessionId: string,
    command: string,
    signal?: AbortSignal,
    context?: unknown,
  ) {
    this.shellCalls.push({
      sessionId,
      command,
      ...(signal !== undefined ? { signal } : {}),
      ...(context !== undefined ? { context } : {}),
    });
    if (this.shellError !== undefined) throw this.shellError;
    return { exitCode: 0, output: `$ ${command}`, aborted: false };
  }
  async getSessionContextUsageStatus(sessionId: string) {
    return { sessionId, used: 100, total: 1000 };
  }
  async getSessionTasksStatus(sessionId: string) {
    return { sessionId, tasks: [] };
  }
  async getSessionLspStatus(sessionId: string) {
    return {
      v: 1,
      sessionId,
      workspaceCwd: '/ws',
      enabled: true,
      configuredServers: 1,
      readyServers: 1,
      failedServers: 0,
      inProgressServers: 0,
      notStartedServers: 0,
      servers: [{ name: 'typescript', status: 'READY', languages: ['ts'] }],
    };
  }
  lastAddedArtifact:
    | {
        sessionId: string;
        artifact: Parameters<HttpAcpBridge['addSessionArtifact']>[1];
        context: Parameters<HttpAcpBridge['addSessionArtifact']>[2];
      }
    | undefined;
  lastArtifactListSessionId: string | undefined;
  lastArtifactListContext:
    | Parameters<HttpAcpBridge['getSessionArtifacts']>[1]
    | undefined;
  lastRemovedArtifact:
    | {
        sessionId: string;
        artifactId: string;
        context: Parameters<HttpAcpBridge['removeSessionArtifact']>[2];
      }
    | undefined;
  async getSessionArtifacts(
    sessionId: string,
    context: Parameters<HttpAcpBridge['getSessionArtifacts']>[1],
  ) {
    this.lastArtifactListSessionId = sessionId;
    this.lastArtifactListContext = context;
    return {
      v: 1,
      sessionId,
      artifacts: [],
      generatedAt: new Date().toISOString(),
      limits: { maxArtifacts: 200 },
    };
  }
  async addSessionArtifact(
    sessionId: string,
    artifact: Parameters<HttpAcpBridge['addSessionArtifact']>[1],
    context: Parameters<HttpAcpBridge['addSessionArtifact']>[2],
  ) {
    this.lastAddedArtifact = { sessionId, artifact, context };
    return { v: 1, sessionId, changes: [] };
  }
  async removeSessionArtifact(
    sessionId: string,
    artifactId: string,
    context: Parameters<HttpAcpBridge['removeSessionArtifact']>[2],
  ) {
    this.lastRemovedArtifact = { sessionId, artifactId, context };
    return {
      v: 1,
      sessionId,
      changes: [{ action: 'removed' as const, artifactId, reason: 'explicit' }],
    };
  }
  async getWorkspaceToolsStatus() {
    return { v: 1, tools: [] };
  }
  async getWorkspaceMcpToolsStatus(serverName: string) {
    return { v: 1, serverName, tools: [] };
  }
  async getWorkspaceMcpResourcesStatus(serverName: string) {
    return { v: 1, serverName, resources: [] };
  }
  runtimeMcpAdds: Array<{
    name: string;
    config: Record<string, unknown>;
    originatorClientId: string;
  }> = [];
  runtimeMcpRemoves: Array<{ name: string; originatorClientId: string }> = [];
  runtimeMcpAddResult: {
    shadowedSettings?: boolean;
    skipped?: boolean;
    reason?: string;
  } = {};
  runtimeMcpAddError: Error | undefined;
  runtimeMcpBeforeAddResolve: (() => Promise<void>) | undefined;
  async addRuntimeMcpServer(
    name: string,
    config: Record<string, unknown>,
    originatorClientId: string,
  ) {
    this.runtimeMcpAdds.push({ name, config, originatorClientId });
    if (this.runtimeMcpAddError) throw this.runtimeMcpAddError;
    await this.runtimeMcpBeforeAddResolve?.();
    return {
      name,
      transport: 'stdio',
      replaced: false,
      shadowedSettings: false,
      toolCount: 0,
      originatorClientId,
      ...this.runtimeMcpAddResult,
    };
  }
  async removeRuntimeMcpServer(name: string, originatorClientId: string) {
    this.runtimeMcpRemoves.push({ name, originatorClientId });
    return {
      name,
      removed: true,
      wasShadowingSettings: false,
      originatorClientId,
    };
  }
  async runWorkspaceMemoryRemember() {
    return { summary: 'remembered', filesTouched: [], touchedScopes: [] };
  }
  async runWorkspaceMemoryForget() {
    return {
      summary: 'forgot',
      removedEntries: [],
      touchedTopics: [],
      touchedScopes: [],
    };
  }
  async runWorkspaceMemoryDream() {
    return { summary: 'dreamed', touchedTopics: [], dedupedEntries: 0 };
  }
  async isWorkspaceMemoryRememberAvailable() {
    return true;
  }
  publishWorkspaceEvent(event: BridgeEvent) {
    this.workspaceEvents.push(event);
  }
  knownClientIds() {
    return new Set(this.knownClientIdSet);
  }
}

function emptyRules() {
  return { allow: [], ask: [], deny: [] };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

// A minimal fake workspace service for dispatch tests.
const fakeWorkspace = {
  async getWorkspaceMcpStatus() {
    return { ok: true, v: 1, workspaceCwd: '/ws' };
  },
  async getWorkspaceSkillsStatus() {
    return { ok: true };
  },
  async getWorkspaceProvidersStatus() {
    return { ok: true };
  },
  async getWorkspaceEnvStatus() {
    return { ok: true };
  },
  async getWorkspacePreflightStatus() {
    return { ok: true };
  },
  async getWorkspaceTrustStatus() {
    return {
      v: 1,
      workspaceCwd: '/ws',
      folderTrustEnabled: true,
      effective: { state: 'trusted', source: 'file' },
      explicitTrustLevel: 'TRUST_FOLDER',
      requiresDaemonRestartForChanges: true,
    };
  },
  async requestWorkspaceTrustChange(_ctx: unknown, request: unknown) {
    return {
      accepted: true,
      ...(request as Record<string, unknown>),
      requiresOperatorAction: true,
    };
  },
  async getWorkspacePermissionsStatus() {
    return {
      v: 1,
      user: { path: '/home/.qwen/settings.json', rules: emptyRules() },
      workspace: { path: '/ws/.qwen/settings.json', rules: emptyRules() },
      merged: emptyRules(),
      isTrusted: true,
    };
  },
  async setWorkspacePermissionRules(_ctx: unknown, request: unknown) {
    const { scope, ruleType, rules } = request as {
      scope: 'user' | 'workspace';
      ruleType: 'allow' | 'ask' | 'deny';
      rules: string[];
    };
    return {
      v: 1,
      user: { path: '/home/.qwen/settings.json', rules: emptyRules() },
      workspace: {
        path: '/ws/.qwen/settings.json',
        rules: {
          ...emptyRules(),
          ...(scope === 'workspace' ? { [ruleType]: rules } : {}),
        },
      },
      merged: {
        ...emptyRules(),
        [ruleType]: rules,
      },
      isTrusted: true,
    };
  },
  async getWorkspaceVoiceStatus() {
    return {
      v: 1,
      workspaceCwd: '/ws',
      enabled: false,
      mode: 'hold',
      language: '',
      voiceModel: null,
      availableVoiceModels: [],
    };
  },
  async setWorkspaceVoiceSettings(_ctx: unknown, request: unknown) {
    const update = request as {
      enabled?: boolean;
      mode?: 'hold' | 'tap';
      language?: string;
      voiceModel?: string;
    };
    return {
      v: 1,
      workspaceCwd: '/ws',
      enabled: update.enabled === true,
      mode: update.mode ?? 'hold',
      language: update.language ?? '',
      voiceModel: update.voiceModel ?? null,
      availableVoiceModels:
        update.voiceModel !== undefined
          ? [{ id: update.voiceModel, transport: 'qwen-asr-chat' }]
          : [],
    };
  },
  async setWorkspaceToolEnabled(
    _ctx: unknown,
    toolName: string,
    enabled: boolean,
  ) {
    return { toolName, enabled };
  },
  async initWorkspace() {
    return { path: '/ws/QWEN.md', action: 'created' as const };
  },
  async restartMcpServer() {
    return { ok: true };
  },
  async reload() {
    return {
      env: { updatedKeys: [], removedKeys: [] },
      changedKeys: [],
      childReloaded: false,
    };
  },
} as unknown as DaemonWorkspaceService;

function makeGlobFsFactory(glob: WorkspaceFileSystem['glob']) {
  return {
    assertCanWrite: () => {},
    forRequest: () =>
      ({
        glob,
      }) as unknown as WorkspaceFileSystem,
  } satisfies WorkspaceFileSystemFactory;
}

function resolvedPath(value: string): ResolvedPath {
  return value as ResolvedPath;
}

function makeFileFsFactory(
  overrides: Partial<Record<keyof WorkspaceFileSystem, unknown>>,
) {
  return {
    assertCanWrite: () => {},
    forRequest: () =>
      ({
        resolve: vi.fn(async (input: string) => resolvedPath(`/ws/${input}`)),
        ...overrides,
      }) as unknown as WorkspaceFileSystem,
  } satisfies WorkspaceFileSystemFactory;
}

// ── SSE client helper ────────────────────────────────────────────────
async function* readSse(
  res: Response,
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  signal.addEventListener('abort', () => void reader.cancel().catch(() => {}));
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (dataLine) yield JSON.parse(dataLine.slice('data: '.length));
    }
  }
}

/**
 * Like `readSse` but yields the RAW frame text (so the `id:` resume-cursor
 * line is visible — `readSse` only keeps the parsed `data:` payload).
 */
async function* readSseRaw(
  res: Response,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  signal.addEventListener('abort', () => void reader.cancel().catch(() => {}));
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      // Skip the `retry:` hint and comment-only heartbeats (no `data:` line).
      if (frame.split('\n').some((l) => l.startsWith('data: '))) yield frame;
    }
  }
}

/** Read the next N RAW data frames (with `id:` lines) from an SSE response. */
async function takeRawFrames(
  res: Response,
  n: number,
  timeoutMs = 2000,
): Promise<string[]> {
  const out: string[] = [];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    for await (const f of readSseRaw(res, ac.signal)) {
      out.push(f);
      if (out.length >= n) break;
    }
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return out;
}

/** Read the next N data frames from an SSE response, then abort. */
async function takeFrames(
  res: Response,
  n: number,
  timeoutMs = 2000,
): Promise<unknown[]> {
  const out: unknown[] = [];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    for await (const f of readSse(res, ac.signal)) {
      out.push(f);
      if (out.length >= n) break;
    }
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return out;
}

function frameReader(res: Response) {
  const ac = new AbortController();
  const iterator = readSse(res, ac.signal)[Symbol.asyncIterator]();
  return {
    async next(timeoutMs = 2000): Promise<unknown> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort();
          reject(new Error('Timed out waiting for SSE frame'));
        }, timeoutMs);
      });
      try {
        const result = await Promise.race([iterator.next(), timeout]);
        if (result.done) throw new Error('SSE stream ended');
        return result.value;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    close(): void {
      ac.abort();
    },
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out waiting for condition');
}

describe('ACP Streamable HTTP transport (over the wire)', () => {
  let server: Server;
  let base: string;
  let bridge: FakeBridge;
  let acpHandle: AcpHttpHandle | undefined;

  beforeEach(async () => {
    stdioMocks.writeStderrLine.mockClear();
    setupGithubMocks.setupGithub.mockReset();
    setupGithubMocks.setupGithub.mockResolvedValue({
      kind: 'github_setup',
      workspaceCwd: '/ws',
      gitRepoRoot: '/ws',
      releaseTag: 'v1.2.3',
      readmeUrl: 'https://github.com/QwenLM/qwen-code-action',
      workflows: [],
      gitignore: { path: '.gitignore', status: 'unchanged' },
      warnings: [],
    });
    bridge = new FakeBridge();
    const app = express();
    app.use(express.json());
    const workspaceRememberLane = new WorkspaceRememberTaskLane(
      bridge as unknown as HttpAcpBridge,
    );
    mountWorkspaceMemoryRememberRoutes(app, {
      bridge: bridge as unknown as HttpAcpBridge,
      lane: workspaceRememberLane,
      mutate: () => (_req, _res, next) => next(),
      parseClientId: (req, res) => {
        const raw = req.get('x-qwen-client-id');
        if (raw === undefined || raw === '') return undefined;
        if (!bridge.knownClientIdSet.has(raw)) {
          res.status(400).json({
            error: `Client id "${raw}" is not registered for this workspace`,
            code: 'invalid_client_id',
            clientId: raw,
          });
          return null;
        }
        return raw;
      },
      safeBody: (req) => {
        const raw = req.body;
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          return Object.create(null) as Record<string, unknown>;
        }
        return raw as Record<string, unknown>;
      },
    });
    acpHandle = mountAcpHttp(app, bridge as unknown as HttpAcpBridge, {
      boundWorkspace: '/ws',
      workspace: fakeWorkspace,
      enabled: true,
      workspaceRememberLane,
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    // Force-close any long-lived SSE sockets a test left open so
    // `server.close()` doesn't hang on them.
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function restartServer(opts: {
    sessionShellCommandEnabled?: boolean;
    nextBridge?: FakeBridge;
    fsFactory?: WorkspaceFileSystemFactory;
    boundWorkspace?: string;
    daemonEnv?: Readonly<NodeJS.ProcessEnv>;
  }): Promise<void> {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    bridge = opts.nextBridge ?? new FakeBridge();
    const boundWorkspace = opts.boundWorkspace ?? '/ws';
    const app = express();
    app.use(express.json());
    mountAcpHttp(app, bridge as unknown as HttpAcpBridge, {
      boundWorkspace,
      workspace: fakeWorkspace,
      enabled: true,
      daemonEnv: opts.daemonEnv,
      fsFactory: opts.fsFactory,
      sessionShellCommandEnabled: opts.sessionShellCommandEnabled,
      workspaceRememberLane: new WorkspaceRememberTaskLane(
        bridge as unknown as HttpAcpBridge,
      ),
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  }

  async function initializeRaw(): Promise<{
    connId: string;
    body: Record<string, unknown>;
  }> {
    const res = await fetch(`${base}/acp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(200);
    const connId = res.headers.get('acp-connection-id');
    expect(connId).toBeTruthy();
    const body = (await res.json()) as Record<string, unknown>;
    return { connId: connId!, body };
  }

  async function initialize(): Promise<string> {
    const { connId, body } = await initializeRaw();
    const result = body['result'] as { protocolVersion: number };
    expect(result.protocolVersion).toBe(1);
    return connId;
  }

  function clientIdForConnection(connId: string): string {
    const clientId = acpHandle?.registry.get(connId)?.clientId;
    expect(clientId).toBeTruthy();
    return clientId!;
  }

  function post(connId: string, msg: unknown) {
    return fetch(`${base}/acp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'acp-connection-id': connId,
      },
      body: JSON.stringify(msg),
    });
  }

  function openStream(connId: string, sessionId?: string) {
    const headers: Record<string, string> = {
      accept: 'text/event-stream',
      'acp-connection-id': connId,
    };
    if (sessionId) headers['acp-session-id'] = sessionId;
    return fetch(`${base}/acp`, { headers });
  }

  // Establish ownership of the fake bridge's session ('sess-1') so the
  // ownership-gated session stream + per-session POSTs are allowed.
  async function newSession(connId: string, id = 99): Promise<void> {
    await post(connId, {
      jsonrpc: '2.0',
      id,
      method: 'session/new',
      params: {},
    });
    await new Promise((r) => setTimeout(r, 30)); // let handle() register ownership
  }

  async function withRuntimeDir<T>(
    fn: (runtimeDir: string) => Promise<T>,
  ): Promise<T> {
    const previousRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    const runtimeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-acp-archive-'),
    );
    process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
    try {
      return await fn(runtimeDir);
    } finally {
      if (previousRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = previousRuntimeDir;
      }
      await fs.rm(runtimeDir, { recursive: true, force: true });
    }
  }

  async function writeStoredSession(
    sessionId: string,
    state: 'active' | 'archived' = 'active',
    parentSessionId?: string,
  ): Promise<void> {
    const chatsDir = path.join(
      new Storage('/ws').getProjectDir(),
      'chats',
      ...(state === 'archived' ? ['archive'] : []),
    );
    await fs.mkdir(chatsDir, { recursive: true });
    const lines = [
      JSON.stringify({
        uuid: `${sessionId}-user-1`,
        parentUuid: null,
        sessionId,
        timestamp: '2026-06-30T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'hello' }] },
        cwd: '/ws',
      }),
    ];
    if (parentSessionId !== undefined) {
      // Mirror ChatRecordingService.recordParentSession: one `parent_session`
      // system record near the head of the transcript that SessionService
      // rehydrates into the summary's parentSessionId.
      lines.push(
        JSON.stringify({
          uuid: `${sessionId}-parent-1`,
          parentUuid: `${sessionId}-user-1`,
          sessionId,
          timestamp: '2026-06-30T00:00:00.000Z',
          type: 'system',
          subtype: 'parent_session',
          systemPayload: { parentSessionId },
          cwd: '/ws',
        }),
      );
    }
    await fs.writeFile(
      path.join(chatsDir, `${sessionId}.jsonl`),
      `${lines.join('\n')}\n`,
      'utf8',
    );
  }

  it('initialize → 200 + Acp-Connection-Id; unknown conn → 404', async () => {
    await initialize();
    const bad = await post('nope', {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
    });
    expect(bad.status).toBe(404);
  });

  it('initialize omits _qwen/session/shell by default', async () => {
    const { body } = await initializeRaw();
    const result = body['result'] as {
      agentCapabilities: {
        _meta: { qwen: { methods: string[] } };
      };
    };
    expect(result.agentCapabilities._meta.qwen.methods).not.toContain(
      '_qwen/session/shell',
    );
  });

  it('initialize advertises image capability at _meta.imageCapability', async () => {
    const { body } = await initializeRaw();
    const result = body['result'] as {
      agentCapabilities: {
        _meta: { imageCapability: Record<string, unknown> };
      };
    };
    expect(result.agentCapabilities._meta.imageCapability).toEqual({
      autoHandlesWrongModel: true,
      maxBytes: 10380902,
      maxImagesPerTurn: 4,
    });
  });

  it('initialize advertises _qwen/workspace/permissions methods', async () => {
    const { body } = await initializeRaw();
    const result = body['result'] as {
      agentCapabilities: {
        _meta: { qwen: { methods: string[] } };
      };
    };
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/workspace/permissions',
    );
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/workspace/permissions/set',
    );
  });

  it('initialize advertises _qwen/workspace/voice methods', async () => {
    const { body } = await initializeRaw();
    const result = body['result'] as {
      agentCapabilities: {
        _meta: { qwen: { methods: string[] } };
      };
    };
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/workspace/voice',
    );
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/workspace/voice/set',
    );
  });

  it('initialize advertises session organization methods', async () => {
    const { body } = await initializeRaw();
    const result = body['result'] as {
      agentCapabilities: {
        _meta: { qwen: { methods: string[] } };
      };
    };
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/session/update_organization',
    );
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/workspace/session_groups/list',
    );
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/workspace/session_groups/create',
    );
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/workspace/session_groups/update',
    );
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/workspace/session_groups/delete',
    );
  });

  it('initialize advertises _qwen/workspace/setup-github', async () => {
    const { body } = await initializeRaw();
    const result = body['result'] as {
      agentCapabilities: {
        _meta: { qwen: { methods: string[] } };
      };
    };
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/workspace/setup-github',
    );
  });

  it('initialize advertises workspace memory remember methods', async () => {
    const { body } = await initializeRaw();
    const result = body['result'] as {
      agentCapabilities: {
        _meta: { qwen: { methods: string[] } };
      };
    };
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/workspace/memory/remember',
    );
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/workspace/memory/remember/get',
    );
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/workspace/memory/forget',
    );
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/workspace/memory/forget/get',
    );
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/workspace/memory/dream',
    );
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/workspace/memory/dream/get',
    );
  });

  it('initialize advertises _qwen/session/shell when enabled', async () => {
    await restartServer({ sessionShellCommandEnabled: true });
    const { body } = await initializeRaw();
    const result = body['result'] as {
      agentCapabilities: {
        _meta: { qwen: { methods: string[] } };
      };
    };
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/session/shell',
    );
    expect(result.agentCapabilities._meta.qwen.methods).not.toContain(
      '_qwen/session/rewind',
    );
  });

  it('initialize advertises _qwen/session/lsp', async () => {
    const { body } = await initializeRaw();
    const result = body['result'] as {
      agentCapabilities: {
        _meta: { qwen: { methods: string[] } };
      };
    };
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/session/lsp',
    );
  });

  it('session/new reply rides the connection-scoped stream', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    // Give the SSE handshake a tick before POSTing.
    await new Promise((r) => setTimeout(r, 50));
    const ack = await post(connId, {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: '/ws' },
    });
    expect(ack.status).toBe(202);
    const [frame] = (await got) as Array<{
      id: number;
      result: { sessionId: string };
    }>;
    expect(frame.id).toBe(2);
    expect(frame.result.sessionId).toBe('sess-1');
  });

  it('maps workspace session admission failures to retryable RPC error data', async () => {
    bridge.spawnOrAttach = async () => {
      throw new SessionLimitExceededError(20);
    };
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    const ack = await post(connId, {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/new',
      params: { cwd: '/ws' },
    });
    expect(ack.status).toBe(202);
    const [frame] = (await got) as Array<{
      id: number;
      error: {
        code: number;
        data: {
          errorKind: string;
          limit: number;
          scope: string;
          retryable: boolean;
        };
      };
    }>;
    expect(frame.id).toBe(3);
    expect(frame.error.code).toBe(-32603);
    expect(frame.error.data).toMatchObject({
      errorKind: 'session_limit_exceeded',
      limit: 20,
      scope: 'workspace',
      retryable: true,
    });
  });

  it('maps total session admission failures to retryable RPC error data', async () => {
    bridge.spawnOrAttach = async () => {
      throw new TotalSessionLimitExceededError(10);
    };
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    const ack = await post(connId, {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/new',
      params: { cwd: '/ws' },
    });
    expect(ack.status).toBe(202);
    const [frame] = (await got) as Array<{
      id: number;
      error: {
        code: number;
        data: {
          errorKind: string;
          limit: number;
          scope: string;
          retryable: boolean;
        };
      };
    }>;
    expect(frame.id).toBe(3);
    expect(frame.error.code).toBe(-32603);
    expect(frame.error.data).toMatchObject({
      errorKind: 'session_limit_exceeded',
      limit: 10,
      scope: 'total',
      retryable: true,
    });
  });

  it('prompt streams session/update then the final result', async () => {
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'session_update',
        data: {
          sessionId: 'sess-1',
          update: { sessionUpdate: 'agent_message_chunk' },
        },
      });
      await new Promise((r) => setTimeout(r, 20));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeFrames(sessStream, 2);
    await new Promise((r) => setTimeout(r, 50));
    const ack = await post(connId, {
      jsonrpc: '2.0',
      id: 5,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] },
    });
    expect(ack.status).toBe(202);
    const frames = (await got) as Array<Record<string, unknown>>;
    expect(frames[0]['method']).toBe('session/update');
    expect(
      (frames[1] as { id: number; result: { stopReason: string } }).id,
    ).toBe(5);
    expect(
      (frames[1] as { result: { stopReason: string } }).result.stopReason,
    ).toBe('end_turn');
  });

  it('live session/update frames carry an SSE `id:` resume cursor', async () => {
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'session_update',
        data: {
          sessionId: 'sess-1',
          update: { sessionUpdate: 'agent_message_chunk' },
        },
      });
      await new Promise((r) => setTimeout(r, 20));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeRawFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 5,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] },
    });
    const frames = await got;
    // `pushQueue` stamps bus ids from 1, so the first session_update is id 1.
    // The frame MUST carry `id: 1` before its `data:` line — that is the
    // cursor an SSE client echoes as `Last-Event-ID` on reconnect.
    expect(frames[0]).toMatch(/(^|\n)id: 1\ndata: /);
    expect(frames[0]).toContain('"method":"session/update"');
  });

  it('GET Last-Event-ID flows to subscribeEvents as the resume cursor', async () => {
    const connId = await initialize();
    await newSession(connId);

    // Reconnect carrying a cursor → subscribeEvents gets lastEventId=42.
    const resumed = await fetch(`${base}/acp`, {
      headers: {
        accept: 'text/event-stream',
        'acp-connection-id': connId,
        'acp-session-id': 'sess-1',
        'last-event-id': '42',
      },
    });
    await waitUntil(() => bridge.subscribeCalls.length >= 1);
    expect(bridge.subscribeCalls.at(-1)).toEqual({
      sessionId: 'sess-1',
      lastEventId: 42,
    });
    await resumed.body?.cancel().catch(() => {});

    // A non-numeric header is rejected (logged) → live-only (undefined).
    const bad = await fetch(`${base}/acp`, {
      headers: {
        accept: 'text/event-stream',
        'acp-connection-id': connId,
        'acp-session-id': 'sess-1',
        'last-event-id': 'not-a-number',
      },
    });
    await waitUntil(() => bridge.subscribeCalls.length >= 2);
    expect(bridge.subscribeCalls.at(-1)).toEqual({
      sessionId: 'sess-1',
      lastEventId: undefined,
    });
    await bad.body?.cancel().catch(() => {});

    // A fresh stream with no header → live-only (undefined), as before.
    const fresh = await openStream(connId, 'sess-1');
    await waitUntil(() => bridge.subscribeCalls.length >= 3);
    expect(bridge.subscribeCalls.at(-1)).toEqual({
      sessionId: 'sess-1',
      lastEventId: undefined,
    });
    await fresh.body?.cancel().catch(() => {});
  });

  it('real close-then-reconnect order keeps ownership (no 403) + prompt alive, resumes via Last-Event-ID', async () => {
    let promptSignal: AbortSignal | undefined;
    bridge.promptBehavior = async (_s, q, signal) => {
      promptSignal = signal;
      q.push({
        type: 'session_update',
        data: {
          sessionId: 'sess-1',
          update: { sessionUpdate: 'agent_message_chunk' },
        },
      });
      // Keep the prompt running across the disconnect + reconnect.
      await new Promise((r) => setTimeout(r, 1000));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const s1 = await openStream(connId, 'sess-1');
    await waitUntil(() => bridge.subscribeCalls.length >= 1); // pump subscribed
    const r1 = frameReader(s1);
    const ack = await post(connId, {
      jsonrpc: '2.0',
      id: 5,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] },
    });
    expect(ack.status).toBe(202);
    await r1.next(); // first content frame (bus id 1)

    // Close the OLD stream FIRST — the real EventSource/proxy order (the
    // existing reconnect tests overlap streams, hiding this).
    r1.close();
    await s1.body?.cancel().catch(() => {});
    // Wait until the daemon has PROCESSED the close (old pump's signal aborted).
    await waitUntil(() => bridge.subscribeSignals[0]?.aborted === true);

    // Detach-with-grace, NOT teardown: the in-flight prompt must survive.
    expect(promptSignal?.aborted).toBe(false);

    // Reconnect carrying the cursor — must be 200 (ownership kept), not 403.
    const s2 = await fetch(`${base}/acp`, {
      headers: {
        accept: 'text/event-stream',
        'acp-connection-id': connId,
        'acp-session-id': 'sess-1',
        'last-event-id': '1',
      },
    });
    expect(s2.status).toBe(200);
    await waitUntil(() => bridge.subscribeCalls.length >= 2);
    expect(bridge.subscribeCalls.at(-1)).toEqual({
      sessionId: 'sess-1',
      lastEventId: 1,
    });
    expect(promptSignal?.aborted).toBe(false); // still alive after reconnect
    await s2.body?.cancel().catch(() => {});
  });

  it('on resume, a reply buffered during the gap is flushed on replay_complete — AFTER replayed content, NOT on the pre-replay state_resync_required frame', async () => {
    // Guards the core §1.8 ordering invariant end-to-end through the pump:
    // the EventBus emits `state_resync_required` BEFORE the replay frames (then
    // `replay_complete` at the end). If the deferred id-less reply were flushed
    // on the resync frame it would land ahead of the replayed content — the
    // truncated-body failure this PR fixes. It must flush on `replay_complete`.
    let openGate: () => void = () => {};
    const gate = new Promise<void>((r) => {
      openGate = r;
    });
    bridge.promptBehavior = async (_s, _q) => {
      // Hold the prompt open across the disconnect; its result is produced
      // only after the gate opens (i.e. during the detach gap) → buffered.
      await gate;
      return { stopReason: 'end_turn' };
    };

    const connId = await initialize();
    await newSession(connId);
    const s1 = await openStream(connId, 'sess-1');
    await waitUntil(() => bridge.subscribeCalls.length >= 1);
    const ack = await post(connId, {
      jsonrpc: '2.0',
      id: 5,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'go' }] },
    });
    expect(ack.status).toBe(202);

    // Close s1 → detach-with-grace (old pump's signal aborts).
    await s1.body?.cancel().catch(() => {});
    await waitUntil(() => bridge.subscribeSignals[0]?.aborted === true);

    // Now release the prompt: its result is sent while detached → buffered as an
    // id-less reply. Settle briefly so it lands in the buffer before reconnect
    // (same in-process settle idiom the harness uses elsewhere).
    openGate();
    await new Promise((r) => setTimeout(r, 50));

    // Reconnect carrying a cursor → the buffered id-less reply is DEFERRED.
    const s2 = await fetch(`${base}/acp`, {
      headers: {
        accept: 'text/event-stream',
        'acp-connection-id': connId,
        'acp-session-id': 'sess-1',
        'last-event-id': '0',
      },
    });
    expect(s2.status).toBe(200);
    await waitUntil(() => bridge.subscribeCalls.length >= 2);

    // Drive the resume sequence the real EventBus would: resync FIRST, then the
    // replayed content, then replay_complete.
    const q2 = bridge.queues.get('sess-1')!;
    q2.push({
      type: 'state_resync_required',
      data: { reason: 'ring_evicted' },
    });
    q2.push({
      type: 'session_update',
      data: {
        sessionId: 'sess-1',
        update: { sessionUpdate: 'agent_message_chunk', text: 'REPLAYED' },
      },
    });
    q2.push({ type: 'replay_complete', data: { replayedCount: 1 } });

    const r2 = frameReader(s2);
    const order: string[] = [];
    try {
      // Read until we've seen the deferred reply (or a safety cap).
      for (let i = 0; i < 8 && !order.includes('reply'); i++) {
        const f = (await r2.next()) as {
          method?: string;
          result?: unknown;
          params?: { kind?: string; update?: { text?: string } };
        };
        if (f.method === undefined && 'result' in f) order.push('reply');
        else if (f.params?.kind === 'state_resync_required')
          order.push('resync');
        else if (f.params?.update?.text === 'REPLAYED') order.push('content');
        else if (f.params?.kind === 'replay_complete')
          order.push('replay_complete');
      }
    } finally {
      r2.close();
    }

    // The reply must arrive AFTER the replayed content (and thus after the
    // pre-replay resync frame) — not flushed early on state_resync_required.
    expect(order).toContain('reply');
    expect(order).toContain('content');
    expect(order.indexOf('content')).toBeLessThan(order.indexOf('reply'));
    expect(order.indexOf('resync')).toBeLessThan(order.indexOf('content'));
  });

  it('on resume, an ANCHORED deferred reply releases mid-replay at its watermark — after the anchor content, BEFORE replay_complete (end-to-end through getSessionLastEventId)', async () => {
    // Exercises the anchored watermark path end-to-end: `replySession` stamps
    // the reply with `anchorId = getSessionLastEventId(sessionId)` (a real
    // number here, not the undefined fallback), so the reply is held until the
    // pump has DELIVERED content through that id — then released MID-replay,
    // before `replay_complete`. This distinguishes the watermark release from
    // the unanchored "release at replay_complete" path (covered above): the
    // reply must land between the anchor content and the replay boundary, and
    // NOT before the content that precedes its watermark.
    bridge.sessionLastEventId = 2; // reply's watermark anchors at bus id 2.
    let openGate: () => void = () => {};
    const gate = new Promise<void>((r) => {
      openGate = r;
    });
    bridge.promptBehavior = async (_s, _q) => {
      await gate; // result produced during the detach gap → buffered.
      return { stopReason: 'end_turn' };
    };

    const connId = await initialize();
    await newSession(connId);
    const s1 = await openStream(connId, 'sess-1');
    await waitUntil(() => bridge.subscribeCalls.length >= 1);
    const ack = await post(connId, {
      jsonrpc: '2.0',
      id: 7,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'go' }] },
    });
    expect(ack.status).toBe(202);

    // Close s1 → detach-with-grace; release the prompt while detached so its
    // reply buffers as a deferred reply WITH anchorId=2.
    await s1.body?.cancel().catch(() => {});
    await waitUntil(() => bridge.subscribeSignals[0]?.aborted === true);
    openGate();
    await new Promise((r) => setTimeout(r, 50));

    // Reconnect carrying a cursor → replay in flight, the reply is DEFERRED.
    const s2 = await fetch(`${base}/acp`, {
      headers: {
        accept: 'text/event-stream',
        'acp-connection-id': connId,
        'acp-session-id': 'sess-1',
        'last-event-id': '0',
      },
    });
    expect(s2.status).toBe(200);
    await waitUntil(() => bridge.subscribeCalls.length >= 2);

    // Clean replay (no eviction): two id-bearing content frames straddling the
    // watermark, then replay_complete. The reply must release on id=2, NOT id=1.
    const q2 = bridge.queues.get('sess-1')!;
    q2.push({
      type: 'session_update',
      id: 1,
      data: {
        sessionId: 'sess-1',
        update: { sessionUpdate: 'agent_message_chunk', text: 'C1' },
      },
    });
    q2.push({
      type: 'session_update',
      id: 2,
      data: {
        sessionId: 'sess-1',
        update: { sessionUpdate: 'agent_message_chunk', text: 'C2' },
      },
    });
    q2.push({ type: 'replay_complete', data: { replayedCount: 2 } });

    const r2 = frameReader(s2);
    const order: string[] = [];
    try {
      // Read past the reply through to the replay boundary so the ordering of
      // reply vs replay_complete is observable (the distinguishing assertion).
      for (let i = 0; i < 12 && !order.includes('replay_complete'); i++) {
        const f = (await r2.next()) as {
          method?: string;
          result?: unknown;
          params?: { kind?: string; update?: { text?: string } };
        };
        if (f.method === undefined && 'result' in f) order.push('reply');
        else if (f.params?.update?.text === 'C1') order.push('c1');
        else if (f.params?.update?.text === 'C2') order.push('c2');
        else if (f.params?.kind === 'replay_complete')
          order.push('replay_complete');
      }
    } finally {
      r2.close();
    }

    // Held through the pre-watermark content (c1), released ON the watermark
    // (c2) MID-replay, and BEFORE the replay boundary — the anchor, not the
    // replay_complete boundary, gated the release.
    expect(order).toContain('reply');
    expect(order).toContain('c1');
    expect(order).toContain('c2');
    expect(order).toContain('replay_complete');
    expect(order.indexOf('c1')).toBeLessThan(order.indexOf('c2'));
    expect(order.indexOf('c2')).toBeLessThan(order.indexOf('reply'));
    expect(order.indexOf('reply')).toBeLessThan(
      order.indexOf('replay_complete'),
    );
  });

  it('GET Last-Event-ID past MAX_SAFE_INTEGER → live-only (undefined)', async () => {
    const connId = await initialize();
    await newSession(connId);
    const overflow = await fetch(`${base}/acp`, {
      headers: {
        accept: 'text/event-stream',
        'acp-connection-id': connId,
        'acp-session-id': 'sess-1',
        'last-event-id': '9007199254740992', // MAX_SAFE_INTEGER + 1
      },
    });
    await waitUntil(() => bridge.subscribeCalls.length >= 1);
    expect(bridge.subscribeCalls.at(-1)).toEqual({
      sessionId: 'sess-1',
      lastEventId: undefined,
    });
    await overflow.body?.cancel().catch(() => {});
  });

  it('a replayed permission_request reuses the pending entry (idempotent, same outbound id)', async () => {
    bridge.promptBehavior = async (_s, q) => {
      const perm = {
        requestId: 'perm-1',
        sessionId: 'sess-1',
        toolCall: { name: 'shell' },
        options: [{ optionId: 'allow', name: 'Allow' }],
      };
      q.push({ type: 'permission_request', data: perm });
      // Simulate a ring replay re-delivering the SAME bridge request (a
      // reconnect whose Last-Event-ID precedes the still-pending permission).
      q.push({ type: 'permission_request', data: perm });
      await new Promise((r) => setTimeout(r, 50));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const sess = await openStream(connId, 'sess-1');
    await waitUntil(() => bridge.subscribeCalls.length >= 1);
    const reader = frameReader(sess);
    await post(connId, {
      jsonrpc: '2.0',
      id: 5,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'go' }] },
    });
    const f1 = (await reader.next()) as { method: string; id: unknown };
    const f2 = (await reader.next()) as { method: string; id: unknown };
    expect(f1.method).toBe('session/request_permission');
    expect(f2.method).toBe('session/request_permission');
    // SAME outbound JSON-RPC id ⇒ one pending entry reused, not a 2nd orphan.
    expect(f1.id).toBe(f2.id);
    reader.close();
  });

  it('permission request round-trips agent→client→agent', async () => {
    let resolvedWith: unknown;
    bridge.respondToSessionPermission = ((
      _s: string,
      _r: string,
      resp: unknown,
    ) => {
      resolvedWith = resp;
      return true;
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-1',
          sessionId: 'sess-1',
          toolCall: { name: 'shell' },
          options: [{ optionId: 'allow', name: 'Allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 30));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const reader = frameReader(sessStream);
    try {
      await new Promise((r) => setTimeout(r, 50));
      await post(connId, {
        jsonrpc: '2.0',
        id: 7,
        method: 'session/prompt',
        params: {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'rm' }],
        },
      });
      const reqFrame = (await reader.next()) as {
        id: number;
        method: string;
        params: { _meta: Record<string, { requestId: string }> };
      };
      expect(reqFrame.method).toBe('session/request_permission');
      expect(reqFrame.params._meta['qwen'].requestId).toBe('perm-1');
      // Client answers with a JSON-RPC response echoing the issued id.
      await post(connId, {
        jsonrpc: '2.0',
        id: reqFrame.id,
        result: { outcome: { outcome: 'selected', optionId: 'allow' } },
      });
      await waitUntil(() => resolvedWith !== undefined);
      expect(resolvedWith).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
    } finally {
      reader.close();
    }
  });

  it('cross-connection permission response resolves for a co-owned session', async () => {
    let resolvedWith: unknown;
    let voteCount = 0;
    bridge.respondToSessionPermission = ((
      sessionId: string,
      requestId: string,
      resp: unknown,
    ) => {
      voteCount += 1;
      resolvedWith = { sessionId, requestId, resp };
      return true;
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-cross',
          sessionId: 'sess-1',
          toolCall: { name: 'shell' },
          options: [{ optionId: 'allow', name: 'Allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 30));
      return { stopReason: 'end_turn' };
    };
    const streamConnId = await initialize();
    await newSession(streamConnId);
    const voterConnId = await initialize();
    await newSession(voterConnId, 100);
    const sessStream = await openStream(streamConnId, 'sess-1');
    const reader = frameReader(sessStream);
    try {
      await post(streamConnId, {
        jsonrpc: '2.0',
        id: 7,
        method: 'session/prompt',
        params: {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'rm' }],
        },
      });
      const reqFrame = (await reader.next()) as { id: string };
      await post(voterConnId, {
        jsonrpc: '2.0',
        id: reqFrame.id,
        result: { outcome: { outcome: 'selected', optionId: 'allow' } },
      });
      await waitUntil(() => resolvedWith !== undefined);
      expect(resolvedWith).toEqual({
        sessionId: 'sess-1',
        requestId: 'perm-cross',
        resp: { outcome: { outcome: 'selected', optionId: 'allow' } },
      });
      expect(voteCount).toBe(1);
      // The resolved entry must be removed so a duplicate vote on the same id
      // can't reach the bridge again — locks down the cross-connection cleanup
      // (dropResolvedPermission) that is the core of this PR.
      await post(voterConnId, {
        jsonrpc: '2.0',
        id: reqFrame.id,
        result: { outcome: { outcome: 'selected', optionId: 'allow' } },
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(voteCount).toBe(1);
    } finally {
      reader.close();
    }
  });

  it('session/permission method resolves cross-connection for a co-owned session', async () => {
    let resolvedWith: unknown;
    let voteCount = 0;
    bridge.respondToSessionPermission = ((
      sessionId: string,
      requestId: string,
      resp: unknown,
    ) => {
      voteCount += 1;
      resolvedWith = { sessionId, requestId, resp };
      return true;
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-cross-method',
          sessionId: 'sess-1',
          toolCall: { name: 'shell' },
          options: [{ optionId: 'allow', name: 'Allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 300));
      return { stopReason: 'end_turn' };
    };
    const streamConnId = await initialize();
    await newSession(streamConnId);
    const voterConnId = await initialize();
    await newSession(voterConnId, 100); // co-owns sess-1
    const sessStream = await openStream(streamConnId, 'sess-1');
    const sessReader = frameReader(sessStream);
    const voterConnStream = await openStream(voterConnId);
    const voterReader = frameReader(voterConnStream);
    try {
      await voterReader.next(); // buffered session/new response on B
      await post(streamConnId, {
        jsonrpc: '2.0',
        id: 7,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'rm' }] },
      });
      await sessReader.next(); // request_permission registers the entry on A
      // Connection B (co-owner) votes via the session/permission method.
      await post(voterConnId, {
        jsonrpc: '2.0',
        id: 41,
        method: 'session/permission',
        params: {
          sessionId: 'sess-1',
          requestId: 'perm-cross-method',
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
      });
      // Ack {} is delivered on B's connection stream.
      const ack = (await voterReader.next()) as {
        id: number;
        result?: unknown;
      };
      expect(ack).toEqual({ jsonrpc: '2.0', id: 41, result: {} });
      expect(resolvedWith).toEqual({
        sessionId: 'sess-1',
        requestId: 'perm-cross-method',
        resp: { outcome: { outcome: 'selected', optionId: 'allow' } },
      });
      expect(voteCount).toBe(1);
      // B has no pending entry of its own (only A streamed the request), so its
      // vote must NOT delete A's sibling entry — under the consensus policy that
      // would drop a still-needed co-owner request. A's entry therefore survives,
      // and a second vote still routes through to the bridge (rather than the
      // handler 404-ing on a wrongly-deleted entry).
      await post(voterConnId, {
        jsonrpc: '2.0',
        id: 42,
        method: 'session/permission',
        params: {
          sessionId: 'sess-1',
          requestId: 'perm-cross-method',
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
      });
      const ack2 = (await voterReader.next()) as {
        id: number;
        result?: unknown;
      };
      expect(ack2).toEqual({ jsonrpc: '2.0', id: 42, result: {} });
      expect(voteCount).toBe(2);
    } finally {
      sessReader.close();
      voterReader.close();
    }
  });

  it('session/permission forwards AskUserQuestion answers and drops unknown fields', async () => {
    let forwarded: unknown;
    bridge.respondToSessionPermission = ((
      _sessionId: string,
      _requestId: string,
      resp: unknown,
    ) => {
      forwarded = resp;
      return true;
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-ans',
          sessionId: 'sess-1',
          toolCall: { name: 'shell' },
          options: [{ optionId: 'allow', name: 'Allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 200));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const connStream = await openStream(connId);
    const connReader = frameReader(connStream);
    const sessStream = await openStream(connId, 'sess-1');
    const sessReader = frameReader(sessStream);
    try {
      await connReader.next(); // buffered session/new response
      await post(connId, {
        jsonrpc: '2.0',
        id: 43,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'rm' }] },
      });
      await sessReader.next(); // request_permission
      await post(connId, {
        jsonrpc: '2.0',
        id: 44,
        method: 'session/permission',
        params: {
          sessionId: 'sess-1',
          requestId: 'perm-ans',
          // Extra outcome sub-field (`force`) and top-level junk (`bogus`) must
          // be stripped; the AskUserQuestion `answers` map must be forwarded.
          outcome: { outcome: 'selected', optionId: 'allow', force: true },
          answers: { q1: 'a1', q2: 'a2' },
          bogus: 'nope',
        },
      });
      const ack = (await connReader.next()) as { id: number; result?: unknown };
      expect(ack).toEqual({ jsonrpc: '2.0', id: 44, result: {} });
      expect(forwarded).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow' },
        answers: { q1: 'a1', q2: 'a2' },
      });
    } finally {
      connReader.close();
      sessReader.close();
    }
  });

  it('session/permission drops a malformed answers payload (non-string values)', async () => {
    let forwarded: unknown;
    bridge.respondToSessionPermission = ((
      _sessionId: string,
      _requestId: string,
      resp: unknown,
    ) => {
      forwarded = resp;
      return true;
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-bad-ans',
          sessionId: 'sess-1',
          toolCall: { name: 'shell' },
          options: [{ optionId: 'allow', name: 'Allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 200));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const connStream = await openStream(connId);
    const connReader = frameReader(connStream);
    const sessStream = await openStream(connId, 'sess-1');
    const sessReader = frameReader(sessStream);
    try {
      await connReader.next(); // buffered session/new response
      await post(connId, {
        jsonrpc: '2.0',
        id: 51,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'rm' }] },
      });
      await sessReader.next(); // request_permission
      await post(connId, {
        jsonrpc: '2.0',
        id: 52,
        method: 'session/permission',
        params: {
          sessionId: 'sess-1',
          requestId: 'perm-bad-ans',
          outcome: { outcome: 'selected', optionId: 'allow' },
          // Non-string value → not an object map of strings → dropped.
          answers: { q1: 42 },
        },
      });
      expect((await connReader.next()) as unknown).toMatchObject({ id: 52 });
      // The vote still lands, but the malformed answers are not forwarded.
      expect(forwarded).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
    } finally {
      connReader.close();
      sessReader.close();
    }
  });

  it('session/permission forwards an object _meta and drops a non-object _meta', async () => {
    const seen: unknown[] = [];
    bridge.respondToSessionPermission = ((
      _sessionId: string,
      _requestId: string,
      resp: unknown,
    ) => {
      seen.push(resp);
      return true;
    }) as never;
    let nextReq = 0;
    bridge.promptBehavior = async (_s, q) => {
      nextReq += 1;
      q.push({
        type: 'permission_request',
        data: {
          requestId: `perm-meta-${nextReq}`,
          sessionId: 'sess-1',
          toolCall: { name: 'shell' },
          options: [{ optionId: 'allow', name: 'Allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 200));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const connStream = await openStream(connId);
    const connReader = frameReader(connStream);
    const sessStream = await openStream(connId, 'sess-1');
    const sessReader = frameReader(sessStream);
    try {
      await connReader.next(); // buffered session/new response
      // Round 1: object _meta is preserved verbatim (nested shape survives).
      await post(connId, {
        jsonrpc: '2.0',
        id: 45,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'a' }] },
      });
      await sessReader.next();
      await post(connId, {
        jsonrpc: '2.0',
        id: 46,
        method: 'session/permission',
        params: {
          sessionId: 'sess-1',
          requestId: 'perm-meta-1',
          outcome: { outcome: 'selected', optionId: 'allow' },
          _meta: { qwen: { trace: 't1' } },
        },
      });
      expect((await connReader.next()) as unknown).toMatchObject({ id: 46 });
      expect(seen.at(-1)).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow' },
        _meta: { qwen: { trace: 't1' } },
      });
      // Round 2: a non-object _meta (string) is dropped, not forwarded.
      await post(connId, {
        jsonrpc: '2.0',
        id: 47,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'b' }] },
      });
      await sessReader.next();
      await post(connId, {
        jsonrpc: '2.0',
        id: 48,
        method: 'session/permission',
        params: {
          sessionId: 'sess-1',
          requestId: 'perm-meta-2',
          outcome: { outcome: 'selected', optionId: 'allow' },
          _meta: 'not-an-object',
        },
      });
      expect((await connReader.next()) as unknown).toMatchObject({ id: 48 });
      expect(seen.at(-1)).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
    } finally {
      connReader.close();
      sessReader.close();
    }
  });

  it('session/permission runs the cancel fallback and rethrows on an unexpected bridge error', async () => {
    const calls: Array<{ requestId: string; resp: unknown }> = [];
    bridge.respondToSessionPermission = ((
      _sessionId: string,
      requestId: string,
      resp: unknown,
    ) => {
      calls.push({ requestId, resp });
      // First call (the vote) throws an unmapped error; the cancel fallback's
      // call (cancelled outcome) is allowed through.
      if (
        (resp as { outcome?: { outcome?: string } })?.outcome?.outcome !==
        'cancelled'
      ) {
        throw new Error('unexpected bridge failure');
      }
      return true;
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-boom',
          sessionId: 'sess-1',
          toolCall: { name: 'shell' },
          options: [{ optionId: 'allow', name: 'Allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 200));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const connStream = await openStream(connId);
    const connReader = frameReader(connStream);
    const sessStream = await openStream(connId, 'sess-1');
    const sessReader = frameReader(sessStream);
    try {
      await connReader.next(); // buffered session/new response
      await post(connId, {
        jsonrpc: '2.0',
        id: 49,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'rm' }] },
      });
      await sessReader.next(); // request_permission
      await post(connId, {
        jsonrpc: '2.0',
        id: 50,
        method: 'session/permission',
        params: {
          sessionId: 'sess-1',
          requestId: 'perm-boom',
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
      });
      const frame = (await connReader.next()) as {
        id: number;
        error: { code: number };
      };
      // Unmapped error → generic INTERNAL_ERROR from the outer dispatcher catch.
      expect(frame.id).toBe(50);
      expect(frame.error.code).toBe(-32603);
      // The cancel fallback ran: the bridge saw a second call carrying the
      // cancelled outcome.
      expect(
        calls.some(
          (c) =>
            (c.resp as { outcome?: { outcome?: string } })?.outcome?.outcome ===
            'cancelled',
        ),
      ).toBe(true);
    } finally {
      connReader.close();
      sessReader.close();
    }
  });

  it('ignores cross-connection permission responses for unowned sessions', async () => {
    const votes: unknown[] = [];
    bridge.respondToSessionPermission = ((
      _sessionId: string,
      _requestId: string,
      resp: unknown,
    ) => {
      votes.push(resp);
      return true;
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-unowned',
          sessionId: 'sess-1',
          toolCall: { name: 'shell' },
          options: [{ optionId: 'allow', name: 'Allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 60));
      return { stopReason: 'end_turn' };
    };
    const streamConnId = await initialize();
    await newSession(streamConnId);
    const voterConnId = await initialize();
    const sessStream = await openStream(streamConnId, 'sess-1');
    const reader = frameReader(sessStream);
    try {
      await post(streamConnId, {
        jsonrpc: '2.0',
        id: 7,
        method: 'session/prompt',
        params: {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'rm' }],
        },
      });
      const reqFrame = (await reader.next()) as { id: string };
      await post(voterConnId, {
        jsonrpc: '2.0',
        id: reqFrame.id,
        result: { outcome: { outcome: 'selected', optionId: 'allow' } },
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(votes).toEqual([]);

      await post(streamConnId, {
        jsonrpc: '2.0',
        id: reqFrame.id,
        result: { outcome: { outcome: 'selected', optionId: 'allow' } },
      });
      await waitUntil(() => votes.length === 1);
    } finally {
      reader.close();
    }
  });

  it('session/permission resolves by bridge request id and replies on the connection stream', async () => {
    let resolvedWith: unknown;
    bridge.respondToSessionPermission = ((
      sessionId: string,
      requestId: string,
      resp: unknown,
    ) => {
      resolvedWith = { sessionId, requestId, resp };
      return true;
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-route',
          sessionId: 'sess-1',
          toolCall: { name: 'shell' },
          options: [{ optionId: 'allow', name: 'Allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 30));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const connStream = await openStream(connId);
    const connReader = frameReader(connStream);
    const sessStream = await openStream(connId, 'sess-1');
    const sessReader = frameReader(sessStream);
    try {
      await connReader.next(); // buffered session/new response
      await post(connId, {
        jsonrpc: '2.0',
        id: 7,
        method: 'session/prompt',
        params: {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'rm' }],
        },
      });
      await sessReader.next();
      await post(connId, {
        jsonrpc: '2.0',
        id: 8,
        method: 'session/permission',
        params: {
          sessionId: 'sess-1',
          requestId: 'perm-route',
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
      });
      const ack = (await connReader.next()) as {
        id: number;
        result?: unknown;
      };
      expect(ack).toEqual({ jsonrpc: '2.0', id: 8, result: {} });
      expect(resolvedWith).toEqual({
        sessionId: 'sess-1',
        requestId: 'perm-route',
        resp: { outcome: { outcome: 'selected', optionId: 'allow' } },
      });
    } finally {
      connReader.close();
      sessReader.close();
    }
  });

  it('session/permission without requestId → INVALID_PARAMS', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 20,
      method: 'session/permission',
      params: { outcome: { outcome: 'selected', optionId: 'allow' } },
    });
    const [frame] = (await got) as Array<{
      id: number;
      error: { code: number; message: string; data?: { httpStatus?: number } };
    }>;
    expect(frame.error.code).toBe(-32602);
    expect(frame.error.message).toContain('`requestId` is required');
    expect(frame.error.data?.httpStatus).toBe(400);
  });

  it.each([
    ['non-object outcome', 'nope'],
    ['unrecognized outcome value', { outcome: 'maybe' }],
    ['selected missing optionId', { outcome: 'selected' }],
    ['selected empty optionId', { outcome: 'selected', optionId: '' }],
    ['selected non-string optionId', { outcome: 'selected', optionId: 123 }],
  ])(
    'session/permission rejects %s → INVALID_PARAMS',
    async (_label, outcome) => {
      const connId = await initialize();
      const connStream = await openStream(connId);
      const got = takeFrames(connStream, 1);
      await new Promise((r) => setTimeout(r, 50));
      await post(connId, {
        jsonrpc: '2.0',
        id: 21,
        method: 'session/permission',
        params: { requestId: 'perm-bad', outcome },
      });
      const [frame] = (await got) as Array<{
        id: number;
        error: {
          code: number;
          message: string;
          data?: { httpStatus?: number };
        };
      }>;
      expect(frame.error.code).toBe(-32602);
      expect(frame.error.message).toContain('`outcome` must be');
      // Carries the same { httpStatus: 400 } envelope as the handler's other
      // error paths, not a bare INVALID_PARAMS from the outer catch.
      expect(frame.error.data?.httpStatus).toBe(400);
    },
  );

  it('session/permission with outcome `cancelled` resolves the bridge', async () => {
    let resolvedWith: unknown;
    bridge.respondToSessionPermission = ((
      sessionId: string,
      requestId: string,
      resp: unknown,
    ) => {
      resolvedWith = { sessionId, requestId, resp };
      return true;
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-cancel',
          sessionId: 'sess-1',
          toolCall: { name: 'shell' },
          options: [{ optionId: 'allow', name: 'Allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 200));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const connStream = await openStream(connId);
    const connReader = frameReader(connStream);
    const sessStream = await openStream(connId, 'sess-1');
    const sessReader = frameReader(sessStream);
    try {
      await connReader.next(); // buffered session/new response
      await post(connId, {
        jsonrpc: '2.0',
        id: 22,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'rm' }] },
      });
      await sessReader.next();
      await post(connId, {
        jsonrpc: '2.0',
        id: 23,
        method: 'session/permission',
        params: {
          sessionId: 'sess-1',
          requestId: 'perm-cancel',
          outcome: { outcome: 'cancelled' },
        },
      });
      const ack = (await connReader.next()) as { id: number; result?: unknown };
      expect(ack).toEqual({ jsonrpc: '2.0', id: 23, result: {} });
      expect(resolvedWith).toEqual({
        sessionId: 'sess-1',
        requestId: 'perm-cancel',
        resp: { outcome: { outcome: 'cancelled' } },
      });
    } finally {
      connReader.close();
      sessReader.close();
    }
  });

  it('session/permission infers sessionId and retains the entry when the bridge rejects the vote', async () => {
    // The bridge mediator has nothing to resolve (already voted/cancelled).
    bridge.respondToSessionPermission = (() => false) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-rej',
          sessionId: 'sess-1',
          toolCall: { name: 'shell' },
          options: [{ optionId: 'allow', name: 'Allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 300));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const connStream = await openStream(connId);
    const connReader = frameReader(connStream);
    const sessStream = await openStream(connId, 'sess-1');
    const sessReader = frameReader(sessStream);
    try {
      await connReader.next(); // buffered session/new response
      await post(connId, {
        jsonrpc: '2.0',
        id: 24,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'rm' }] },
      });
      await sessReader.next();
      // No `sessionId` param: the handler must infer it from the pending
      // entry (the `sessionId === undefined` lookup branch).
      await post(connId, {
        jsonrpc: '2.0',
        id: 25,
        method: 'session/permission',
        params: {
          requestId: 'perm-rej',
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
      });
      const first = (await connReader.next()) as {
        id: number;
        error: {
          code: number;
          message: string;
          data?: { httpStatus?: number };
        };
      };
      expect(first.id).toBe(25);
      expect(first.error.code).toBe(-32602);
      expect(first.error.message).toContain('not accepted');
      expect(first.error.data?.httpStatus).toBe(409);
      // A rejected vote must NOT delete the pending entry. A retry on the same
      // requestId (still no sessionId) must therefore still resolve to the
      // entry and hit the bridge again (409), NOT fall through to the 404
      // "no pending permission request" path.
      await post(connId, {
        jsonrpc: '2.0',
        id: 26,
        method: 'session/permission',
        params: {
          requestId: 'perm-rej',
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
      });
      const second = (await connReader.next()) as {
        id: number;
        error: {
          code: number;
          message: string;
          data?: { httpStatus?: number };
        };
      };
      expect(second.id).toBe(26);
      expect(second.error.data?.httpStatus).toBe(409);
      expect(second.error.message).toContain('not accepted');
    } finally {
      connReader.close();
      sessReader.close();
    }
  });

  it('session/permission rejects a sessionId that does not match the pending requestId', async () => {
    const resolved: unknown[] = [];
    bridge.respondToSessionPermission = ((
      _s: string,
      _r: string,
      resp: unknown,
    ) => {
      resolved.push(resp);
      return true;
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-mismatch',
          sessionId: 'sess-1',
          toolCall: { name: 'shell' },
          options: [{ optionId: 'allow', name: 'Allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 200));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const connStream = await openStream(connId);
    const connReader = frameReader(connStream);
    const sessStream = await openStream(connId, 'sess-1');
    const sessReader = frameReader(sessStream);
    try {
      await connReader.next(); // buffered session/new response
      await post(connId, {
        jsonrpc: '2.0',
        id: 30,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'rm' }] },
      });
      await sessReader.next();
      // requestId belongs to sess-1, but the client claims sess-WRONG.
      await post(connId, {
        jsonrpc: '2.0',
        id: 31,
        method: 'session/permission',
        params: {
          sessionId: 'sess-WRONG',
          requestId: 'perm-mismatch',
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
      });
      const frame = (await connReader.next()) as {
        id: number;
        error: {
          code: number;
          message: string;
          data?: { httpStatus?: number };
        };
      };
      expect(frame.id).toBe(31);
      expect(frame.error.code).toBe(-32602);
      expect(frame.error.data?.httpStatus).toBe(409);
      expect(frame.error.message).toContain('does not belong');
      // The mismatched vote must not have reached the bridge.
      expect(resolved).toEqual([]);
    } finally {
      connReader.close();
      sessReader.close();
    }
  });

  it('session/permission returns 404 when no pending request matches the requestId', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 27,
      method: 'session/permission',
      params: {
        requestId: 'does-not-exist',
        outcome: { outcome: 'selected', optionId: 'allow' },
      },
    });
    const [frame] = (await got) as Array<{
      id: number;
      error: { code: number; message: string; data?: { httpStatus?: number } };
    }>;
    expect(frame.id).toBe(27);
    expect(frame.error.code).toBe(-32602);
    expect(frame.error.data?.httpStatus).toBe(404);
    expect(frame.error.message).toContain('No pending permission request');
  });

  it('session/permission returns 404 (not 409) when requestId misses on an owned session', async () => {
    // Regression: in the scoped route a sessionId is always supplied, so an
    // unknown/stale requestId must still resolve to 404 (which DaemonClient/
    // REST translate to `false`) rather than falling through to the bridge and
    // surfacing its `false` as a thrown 409.
    const connId = await initialize();
    await newSession(connId);
    const connStream = await openStream(connId);
    const connReader = frameReader(connStream);
    try {
      await connReader.next(); // buffered session/new response
      await post(connId, {
        jsonrpc: '2.0',
        id: 32,
        method: 'session/permission',
        params: {
          sessionId: 'sess-1',
          requestId: 'unknown-req',
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
      });
      const frame = (await connReader.next()) as {
        id: number;
        error: {
          code: number;
          message: string;
          data?: { httpStatus?: number };
        };
      };
      expect(frame.id).toBe(32);
      expect(frame.error.data?.httpStatus).toBe(404);
      expect(frame.error.message).toContain('No pending permission request');
    } finally {
      connReader.close();
    }
  });

  it('session/permission maps InvalidPermissionOptionError to a 400 invalid_option_id', async () => {
    bridge.respondToSessionPermission = (() => {
      throw new InvalidPermissionOptionError('perm-opt', 'forged');
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-opt',
          sessionId: 'sess-1',
          toolCall: { name: 'shell' },
          options: [{ optionId: 'allow', name: 'Allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 200));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const connStream = await openStream(connId);
    const connReader = frameReader(connStream);
    const sessStream = await openStream(connId, 'sess-1');
    const sessReader = frameReader(sessStream);
    try {
      await connReader.next(); // buffered session/new response
      await post(connId, {
        jsonrpc: '2.0',
        id: 33,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'rm' }] },
      });
      await sessReader.next(); // request_permission
      await post(connId, {
        jsonrpc: '2.0',
        id: 34,
        method: 'session/permission',
        params: {
          sessionId: 'sess-1',
          requestId: 'perm-opt',
          outcome: { outcome: 'selected', optionId: 'forged' },
        },
      });
      const frame = (await connReader.next()) as {
        id: number;
        error: {
          code: number;
          message: string;
          data?: {
            httpStatus?: number;
            code?: string;
            optionId?: string;
            requestId?: string;
          };
        };
      };
      expect(frame.id).toBe(34);
      expect(frame.error.code).toBe(-32602);
      expect(frame.error.data?.httpStatus).toBe(400);
      expect(frame.error.data?.code).toBe('invalid_option_id');
      expect(frame.error.data?.optionId).toBe('forged');
      expect(frame.error.data?.requestId).toBe('perm-opt');
    } finally {
      connReader.close();
      sessReader.close();
    }
  });

  it('session/permission maps PermissionForbiddenError to a 403 permission_forbidden', async () => {
    bridge.respondToSessionPermission = (() => {
      throw new PermissionForbiddenError(
        'perm-fbd',
        'sess-1',
        'designated_mismatch',
      );
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-fbd',
          sessionId: 'sess-1',
          toolCall: { name: 'shell' },
          options: [{ optionId: 'allow', name: 'Allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 200));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const connStream = await openStream(connId);
    const connReader = frameReader(connStream);
    const sessStream = await openStream(connId, 'sess-1');
    const sessReader = frameReader(sessStream);
    try {
      await connReader.next(); // buffered session/new response
      await post(connId, {
        jsonrpc: '2.0',
        id: 35,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'rm' }] },
      });
      await sessReader.next(); // request_permission
      await post(connId, {
        jsonrpc: '2.0',
        id: 36,
        method: 'session/permission',
        params: {
          sessionId: 'sess-1',
          requestId: 'perm-fbd',
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
      });
      const frame = (await connReader.next()) as {
        id: number;
        error: {
          code: number;
          message: string;
          data?: {
            httpStatus?: number;
            code?: string;
            reason?: string;
            sessionId?: string;
            requestId?: string;
          };
        };
      };
      expect(frame.id).toBe(36);
      expect(frame.error.data?.httpStatus).toBe(403);
      expect(frame.error.data?.code).toBe('permission_forbidden');
      expect(frame.error.data?.reason).toBe('designated_mismatch');
      expect(frame.error.data?.sessionId).toBe('sess-1');
      expect(frame.error.data?.requestId).toBe('perm-fbd');
    } finally {
      connReader.close();
      sessReader.close();
    }
  });

  it.each([
    {
      name: 'PermissionPolicyNotImplementedError to a 501 permission_policy_not_implemented',
      reqId: 'perm-pol',
      makeErr: () => new PermissionPolicyNotImplementedError('future_policy'),
      httpStatus: 501,
      code: 'permission_policy_not_implemented',
      check: (data: Record<string, unknown>) =>
        expect(data['policy']).toBe('future_policy'),
    },
    {
      name: 'CancelSentinelCollisionError to a 500 cancel_sentinel_collision',
      reqId: 'perm-sent',
      makeErr: () =>
        new CancelSentinelCollisionError('perm-sent', '__cancel__'),
      httpStatus: 500,
      code: 'cancel_sentinel_collision',
      check: (data: Record<string, unknown>) => {
        expect(data['requestId']).toBe('perm-sent');
        expect(data['sentinel']).toBe('__cancel__');
      },
    },
  ])('session/permission maps $name', async (tc) => {
    bridge.respondToSessionPermission = (() => {
      throw tc.makeErr();
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: tc.reqId,
          sessionId: 'sess-1',
          toolCall: { name: 'shell' },
          options: [{ optionId: 'allow', name: 'Allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 200));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const connStream = await openStream(connId);
    const connReader = frameReader(connStream);
    const sessStream = await openStream(connId, 'sess-1');
    const sessReader = frameReader(sessStream);
    try {
      await connReader.next(); // buffered session/new response
      await post(connId, {
        jsonrpc: '2.0',
        id: 37,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'rm' }] },
      });
      await sessReader.next(); // request_permission
      await post(connId, {
        jsonrpc: '2.0',
        id: 38,
        method: 'session/permission',
        params: {
          sessionId: 'sess-1',
          requestId: tc.reqId,
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
      });
      const frame = (await connReader.next()) as {
        id: number;
        error: { code: number; data?: Record<string, unknown> };
      };
      expect(frame.id).toBe(38);
      expect(frame.error.data?.['httpStatus']).toBe(tc.httpStatus);
      expect(frame.error.data?.['code']).toBe(tc.code);
      tc.check(frame.error.data ?? {});
    } finally {
      connReader.close();
      sessReader.close();
    }
  });

  it('session/permission rejects a vote from a connection that does not own the session', async () => {
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-unowned-method',
          sessionId: 'sess-1',
          toolCall: { name: 'shell' },
          options: [{ optionId: 'allow', name: 'Allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 200));
      return { stopReason: 'end_turn' };
    };
    const ownerConnId = await initialize();
    await newSession(ownerConnId);
    const voterConnId = await initialize();
    const ownerSess = await openStream(ownerConnId, 'sess-1');
    const ownerReader = frameReader(ownerSess);
    const voterStream = await openStream(voterConnId);
    const voterGot = takeFrames(voterStream, 1);
    try {
      await post(ownerConnId, {
        jsonrpc: '2.0',
        id: 28,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'rm' }] },
      });
      // Wait for the request_permission frame so the pending entry is
      // registered on the owner connection before the unowned vote arrives.
      await ownerReader.next();
      await post(voterConnId, {
        jsonrpc: '2.0',
        id: 29,
        method: 'session/permission',
        params: {
          sessionId: 'sess-1',
          requestId: 'perm-unowned-method',
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
      });
      const [frame] = (await voterGot) as Array<{
        id: number;
        error: {
          code: number;
          message: string;
          data?: { httpStatus?: number };
        };
      }>;
      expect(frame.id).toBe(29);
      expect(frame.error.code).toBe(-32602);
      expect(frame.error.message).toContain('not owned by this connection');
      expect(frame.error.data?.httpStatus).toBe(403);
    } finally {
      ownerReader.close();
    }
  });

  it('standard session/set_config_option (model) routes to the bridge', async () => {
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 9,
      method: 'session/set_config_option',
      params: { sessionId: 'sess-1', configId: 'model', value: 'qwen-max' },
    });
    const [frame] = (await got) as Array<{
      id: number;
      result: { configOptions: unknown };
    }>;
    expect(frame.id).toBe(9);
    expect(bridge.lastSetModel).toMatchObject({ modelId: 'qwen-max' });
  });

  it('session/set_config_option (mode) routes to setSessionApprovalMode', async () => {
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 10,
      method: 'session/set_config_option',
      params: { sessionId: 'sess-1', configId: 'mode', value: 'yolo' },
    });
    await got;
    expect(bridge.lastApprovalMode).toBe('yolo');
  });

  it('_qwen/workspace/mcp introspection reaches the bridge', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 12,
      method: '_qwen/workspace/mcp',
    });
    const [frame] = (await got) as Array<{
      id: number;
      result: { ok: boolean };
    }>;
    expect(frame.id).toBe(12);
    expect(frame.result.ok).toBe(true);
  });

  it('session/list returns REST-compatible session summary fields', async () => {
    bridge.workspaceSessions = [
      {
        sessionId: '11111111-bbbb-cccc-dddd-eeeeeeeeeeee',
        workspaceCwd: '/ws',
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:01:00.000Z',
        displayName: 'Listed Session',
        clientCount: 1,
        hasActivePrompt: false,
        isArchived: false,
      },
    ];

    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 13,
      method: 'session/list',
      params: { workspaceCwd: '/ws' },
    });

    const [frame] = (await got) as Array<{
      id: number;
      result: { sessions: Array<Record<string, unknown>> };
    }>;
    expect(frame.id).toBe(13);
    expect(frame.result.sessions[0]).toMatchObject({
      sessionId: '11111111-bbbb-cccc-dddd-eeeeeeeeeeee',
      workspaceCwd: '/ws',
      cwd: '/ws',
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:01:00.000Z',
      displayName: 'Listed Session',
      title: 'Listed Session',
      clientCount: 1,
      hasActivePrompt: false,
      isArchived: false,
    });
  });

  it('_qwen/sessions/archive rejects invalid batch params', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 14,
      method: '_qwen/sessions/archive',
      params: { sessionIds: 'not-an-array' },
    });

    const [frame] = (await got) as Array<{
      id: number;
      error: { code: number; message: string };
    }>;
    expect(frame.id).toBe(14);
    expect(frame.error.code).toBe(-32602);
    expect(frame.error.message).toContain('sessionIds');
  });

  it('_qwen/sessions/unarchive returns per-id result buckets', async () => {
    const sessionId = '22222222-bbbb-cccc-dddd-eeeeeeeeeeee';
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 15,
      method: '_qwen/sessions/unarchive',
      params: { sessionIds: [sessionId] },
    });

    const [frame] = (await got) as Array<{
      id: number;
      result: {
        unarchived: string[];
        alreadyActive: string[];
        notFound: string[];
        errors: unknown[];
      };
    }>;
    expect(frame.id).toBe(15);
    expect(frame.result).toEqual({
      unarchived: [],
      alreadyActive: [],
      notFound: [sessionId],
      errors: [],
    });
  });

  it('unknown method → JSON-RPC method-not-found on conn stream', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, { jsonrpc: '2.0', id: 11, method: 'bogus/method' });
    const [frame] = (await got) as Array<{
      id: number;
      error: { code: number };
    }>;
    expect(frame.error.code).toBe(-32601);
  });

  it('session stream for an unowned session → 403', async () => {
    const connId = await initialize();
    // No session/new → connection does not own 'sess-1'.
    const res = await openStream(connId, 'sess-1');
    expect(res.status).toBe(403);
  });

  it('prompt for an unowned session → INVALID_PARAMS on conn stream', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 13,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] },
    });
    const [frame] = (await got) as Array<{
      id: number;
      error: { code: number };
    }>;
    expect(frame.error.code).toBe(-32602);
  });

  it('Acp-Session-Id header that disagrees with params.sessionId → INVALID_PARAMS', async () => {
    // Cross-check fires before ownership, so no session/new needed (and
    // skipping it keeps a buffered session/new reply off the conn stream).
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`${base}/acp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'acp-connection-id': connId,
        'acp-session-id': 'sess-1',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 14,
        method: 'session/prompt',
        params: { sessionId: 'OTHER', prompt: [{ type: 'text', text: 'x' }] },
      }),
    });
    const [frame] = (await got) as Array<{
      id: number;
      error: { code: number };
    }>;
    expect(frame.error.code).toBe(-32602);
  });

  it('session/load owns the session + replies state on the conn stream', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 20,
      method: 'session/load',
      params: { sessionId: 'loaded-1' },
    });
    const [frame] = (await got) as Array<{
      id: number;
      result: { replayed: boolean };
    }>;
    expect(frame.id).toBe(20);
    expect(frame.result.replayed).toBe(true);
    // Ownership was granted, so the session stream is now allowed.
    const sess = await openStream(connId, 'loaded-1');
    expect(sess.status).toBe(200);
    await sess.body?.cancel(); // release the long-lived SSE socket
  });

  it('session/load reports partial replay status under qwen _meta', async () => {
    bridge.loadState = {
      replayed: true,
      _meta: { qwen: { existing: 'kept' }, other: { value: 1 } },
    };
    bridge.loadPartial = true;
    bridge.loadReplayError = 'replay boom';
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 20,
      method: 'session/load',
      params: { sessionId: 'loaded-1' },
    });
    const [frame] = (await got) as Array<{
      id: number;
      result: {
        replayed: boolean;
        partial?: boolean;
        replayError?: string;
        _meta?: {
          qwen?: {
            existing?: string;
            sessionLoadReplay?: {
              partial?: boolean;
              replayError?: string;
            };
          };
          other?: { value?: number };
        };
      };
    }>;
    expect(frame.id).toBe(20);
    expect(frame.result).not.toHaveProperty('partial');
    expect(frame.result).not.toHaveProperty('replayError');
    expect(frame.result._meta).toEqual({
      qwen: {
        existing: 'kept',
        sessionLoadReplay: {
          partial: true,
          replayError: 'replay boom',
        },
      },
      other: { value: 1 },
    });
  });

  it('session/load uses response-mode and replays the snapshot on initial session stream attach', async () => {
    bridge.replaySnapshot = {
      lastEventId: 3,
      compactedTurns: [
        {
          v: 1,
          id: 1,
          type: 'session_update',
          data: {
            sessionId: 'loaded-1',
            update: { sessionUpdate: 'user_message_chunk' },
          },
        } as BridgeEvent,
        {
          v: 1,
          id: 2,
          type: 'model_switched',
          data: { modelId: 'qwen3' },
        } as BridgeEvent,
      ],
      liveJournal: [
        {
          v: 1,
          id: 3,
          type: 'session_update',
          data: {
            sessionId: 'loaded-1',
            update: { sessionUpdate: 'agent_message_chunk' },
          },
        } as BridgeEvent,
      ],
    };
    const connId = await initialize();
    const connStream = await openStream(connId);
    const loadReply = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 20,
      method: 'session/load',
      params: { sessionId: 'loaded-1' },
    });
    const [reply] = (await loadReply) as Array<{
      id: number;
      result: { replayed: boolean; compactedReplay?: unknown };
    }>;
    expect(reply).toMatchObject({
      id: 20,
      result: { replayed: true },
    });
    expect(reply.result).not.toHaveProperty('compactedReplay');
    expect(bridge.loadRequests).toHaveLength(1);
    expect(bridge.loadRequests[0]).toMatchObject({
      sessionId: 'loaded-1',
      clientId: clientIdForConnection(connId),
      historyReplay: 'response',
    });

    const sess = await openStream(connId, 'loaded-1');
    const framesPromise = takeFrames(sess, 4, 1000);
    await waitUntil(() => bridge.subscribeCalls.length >= 1);
    expect(bridge.subscribeCalls[0]).toEqual({
      sessionId: 'loaded-1',
      lastEventId: 3,
    });
    bridge.queues.get('loaded-1')!.push({
      type: 'replay_complete',
      data: { replayedCount: 0 },
    });

    const frames = (await framesPromise) as Array<{
      method: string;
      params: {
        update?: { sessionUpdate?: string };
        kind?: string;
      };
    }>;
    expect(frames).toHaveLength(4);
    expect(frames[0]).toMatchObject({
      method: 'session/update',
      params: { update: { sessionUpdate: 'user_message_chunk' } },
    });
    expect(frames[1]).toMatchObject({
      method: '_qwen/notify',
      params: { kind: 'model_switched', data: { modelId: 'qwen3' } },
    });
    expect(frames[2]).toMatchObject({
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk' } },
    });
    expect(frames[3]).toMatchObject({
      method: '_qwen/notify',
      params: { kind: 'replay_complete' },
    });
  });

  it('defers prompt replies until initial load replay completes', async () => {
    bridge.replaySnapshot = {
      lastEventId: 1,
      compactedTurns: [],
      liveJournal: [
        {
          v: 1,
          id: 1,
          type: 'session_update',
          data: {
            sessionId: 'loaded-1',
            update: { sessionUpdate: 'agent_message_chunk' },
          },
        } as BridgeEvent,
      ],
    };
    const connId = await initialize();
    const connStream = await openStream(connId);
    const loadReply = takeFrames(connStream, 1);
    await post(connId, {
      jsonrpc: '2.0',
      id: 20,
      method: 'session/load',
      params: { sessionId: 'loaded-1' },
    });
    await loadReply;

    const sess = await openStream(connId, 'loaded-1');
    const framesPromise = takeFrames(sess, 3, 1000);
    await waitUntil(() => bridge.subscribeCalls.length >= 1);
    await post(connId, {
      jsonrpc: '2.0',
      id: 21,
      method: 'session/prompt',
      params: {
        sessionId: 'loaded-1',
        prompt: [{ type: 'text', text: 'hi' }],
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    bridge.queues.get('loaded-1')!.push({
      type: 'replay_complete',
      data: { replayedCount: 0 },
    });

    const frames = (await framesPromise) as Array<{
      id?: number;
      method?: string;
      params?: { kind?: string; update?: { sessionUpdate?: string } };
      result?: { stopReason?: string };
    }>;
    expect(frames[0]).toMatchObject({
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk' } },
    });
    expect(frames[1]).toMatchObject({
      method: '_qwen/notify',
      params: { kind: 'replay_complete' },
    });
    expect(frames[2]).toMatchObject({
      id: 21,
      result: { stopReason: 'end_turn' },
    });
  });

  it('continues initial load replay from Last-Event-ID after reconnect', async () => {
    bridge.replaySnapshot = {
      lastEventId: 2,
      compactedTurns: [],
      liveJournal: [
        {
          v: 1,
          id: 1,
          type: 'session_update',
          data: {
            sessionId: 'loaded-1',
            update: { sessionUpdate: 'user_message_chunk' },
          },
        } as BridgeEvent,
        {
          v: 1,
          id: 2,
          type: 'session_update',
          data: {
            sessionId: 'loaded-1',
            update: { sessionUpdate: 'agent_message_chunk' },
          },
        } as BridgeEvent,
      ],
    };
    const connId = await initialize();
    const connStream = await openStream(connId);
    const loadReply = takeFrames(connStream, 1);
    await post(connId, {
      jsonrpc: '2.0',
      id: 20,
      method: 'session/load',
      params: { sessionId: 'loaded-1' },
    });
    await loadReply;

    const firstStream = await openStream(connId, 'loaded-1');
    const [firstFrame] = (await takeFrames(firstStream, 1, 1000)) as Array<{
      method: string;
      params: { update?: { sessionUpdate?: string } };
    }>;
    expect(firstFrame).toMatchObject({
      method: 'session/update',
      params: { update: { sessionUpdate: 'user_message_chunk' } },
    });
    const subscribeCountBeforeReconnect = bridge.subscribeCalls.length;

    const resumed = await fetch(`${base}/acp`, {
      headers: {
        accept: 'text/event-stream',
        'acp-connection-id': connId,
        'acp-session-id': 'loaded-1',
        'last-event-id': '1',
      },
    });
    const framesPromise = takeFrames(resumed, 2, 1000);
    await waitUntil(
      () => bridge.subscribeCalls.length > subscribeCountBeforeReconnect,
    );
    expect(bridge.subscribeCalls.at(-1)).toEqual({
      sessionId: 'loaded-1',
      lastEventId: 2,
    });
    bridge.queues.get('loaded-1')!.push({
      type: 'replay_complete',
      data: { replayedCount: 0 },
    });

    const frames = (await framesPromise) as Array<{
      method: string;
      params: { kind?: string; update?: { sessionUpdate?: string } };
    }>;
    expect(frames[0]).toMatchObject({
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk' } },
    });
    expect(frames[1]).toMatchObject({
      method: '_qwen/notify',
      params: { kind: 'replay_complete' },
    });
  });

  it('does not rewind initial replay subscription behind Last-Event-ID', async () => {
    bridge.replaySnapshot = {
      lastEventId: 2,
      compactedTurns: [],
      liveJournal: [
        {
          v: 1,
          id: 1,
          type: 'session_update',
          data: {
            sessionId: 'loaded-1',
            update: { sessionUpdate: 'user_message_chunk' },
          },
        } as BridgeEvent,
        {
          v: 1,
          id: 2,
          type: 'session_update',
          data: {
            sessionId: 'loaded-1',
            update: { sessionUpdate: 'agent_message_chunk' },
          },
        } as BridgeEvent,
      ],
    };
    const connId = await initialize();
    const connStream = await openStream(connId);
    const loadReply = takeFrames(connStream, 1);
    await post(connId, {
      jsonrpc: '2.0',
      id: 20,
      method: 'session/load',
      params: { sessionId: 'loaded-1' },
    });
    await loadReply;

    const resumed = await fetch(`${base}/acp`, {
      headers: {
        accept: 'text/event-stream',
        'acp-connection-id': connId,
        'acp-session-id': 'loaded-1',
        'last-event-id': '5',
      },
    });
    await waitUntil(() => bridge.subscribeCalls.length >= 1);

    expect(bridge.subscribeCalls.at(-1)).toEqual({
      sessionId: 'loaded-1',
      lastEventId: 5,
    });
    await resumed.body?.cancel();
  });

  it('session/resume owns the session + replies state', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 21,
      method: 'session/resume',
      params: { sessionId: 'resumed-1' },
    });
    const [frame] = (await got) as Array<{
      id: number;
      result: { resumed: boolean };
    }>;
    expect(frame.id).toBe(21);
    expect(frame.result.resumed).toBe(true);
  });

  it.each(['session/load', 'session/resume'])(
    '%s rejects archived sessions',
    async (method) => {
      const previousRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
      const runtimeDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'qwen-acp-archive-'),
      );
      process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
      const sessionId = '550e8400-e29b-41d4-a716-446655440123';
      try {
        const chatsDir = path.join(
          new Storage('/ws').getProjectDir(),
          'chats',
          'archive',
        );
        await fs.mkdir(chatsDir, { recursive: true });
        await fs.writeFile(
          path.join(chatsDir, `${sessionId}.jsonl`),
          `${JSON.stringify({
            uuid: `${sessionId}-user-1`,
            parentUuid: null,
            sessionId,
            timestamp: '2026-06-30T00:00:00.000Z',
            type: 'user',
            message: { role: 'user', parts: [{ text: 'archived' }] },
            cwd: '/ws',
          })}\n`,
          'utf8',
        );

        const connId = await initialize();
        const connStream = await openStream(connId);
        const got = takeFrames(connStream, 1);
        await new Promise((r) => setTimeout(r, 50));
        await post(connId, {
          jsonrpc: '2.0',
          id: 211,
          method,
          params: { sessionId },
        });

        const [frame] = (await got) as Array<{
          id: number;
          error: { code: number; data?: { errorKind?: string } };
        }>;
        expect(frame.id).toBe(211);
        expect(frame.error.code).toBe(-32603);
        expect(frame.error.data?.errorKind).toBe('session_archived');
      } finally {
        if (previousRuntimeDir === undefined) {
          delete process.env['QWEN_RUNTIME_DIR'];
        } else {
          process.env['QWEN_RUNTIME_DIR'] = previousRuntimeDir;
        }
        await fs.rm(runtimeDir, { recursive: true, force: true });
      }
    },
  );

  it('session/load rejects active/archive conflicts', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440321';
      await writeStoredSession(sessionId);
      await writeStoredSession(sessionId, 'archived');

      const connId = await initialize();
      const connStream = await openStream(connId);
      const got = takeFrames(connStream, 1);
      await new Promise((r) => setTimeout(r, 50));
      await post(connId, {
        jsonrpc: '2.0',
        id: 212,
        method: 'session/load',
        params: { sessionId },
      });

      const [frame] = (await got) as Array<{
        id: number;
        error: { code: number; data?: { errorKind?: string } };
      }>;
      expect(frame.id).toBe(212);
      expect(frame.error.code).toBe(-32603);
      expect(frame.error.data?.errorKind).toBe('session_conflict');
    });
  });

  it('session/load holds archive gate while restore is in flight', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440124';
      await writeStoredSession(sessionId);
      let loadStarted!: () => void;
      let releaseLoad!: () => void;
      const loadStartedPromise = new Promise<void>((resolve) => {
        loadStarted = resolve;
      });
      const loadReleasedPromise = new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });
      bridge.loadSession = async (req) => {
        loadStarted();
        await loadReleasedPromise;
        return {
          sessionId: req.sessionId,
          workspaceCwd: '/ws',
          attached: true,
          clientId: 'client-load',
          state: { replayed: true },
        };
      };

      const connId = await initialize();
      const stream = await openStream(connId);
      const reader = frameReader(stream);
      await post(connId, {
        jsonrpc: '2.0',
        id: 212,
        method: 'session/load',
        params: { sessionId },
      });
      await loadStartedPromise;

      await post(connId, {
        jsonrpc: '2.0',
        id: 213,
        method: '_qwen/sessions/archive',
        params: { sessionIds: [sessionId] },
      });
      expect(await reader.next()).toMatchObject({
        id: 213,
        error: {
          code: -32603,
          data: { errorKind: 'session_archiving', sessionId },
        },
      });

      releaseLoad();
      expect(await reader.next()).toMatchObject({
        id: 212,
        result: { replayed: true },
      });
      reader.close();
    });
  });

  it.each(['session/load', 'session/resume'] as const)(
    '%s re-seeds the persisted parent lineage into the bridge restore call',
    async (method) => {
      await withRuntimeDir(async () => {
        const sessionId = '550e8400-e29b-41d4-a716-446655440130';
        const parentId = '550e8400-e29b-41d4-a716-446655440131';
        // A restored sub-session carries its parent only on disk; the bridge
        // creates the live entry without it, so the dispatcher must recover it
        // from the transcript and pass it to load/resume.
        await writeStoredSession(sessionId, 'active', parentId);

        let loadParent: unknown = 'unset';
        let resumeParent: unknown = 'unset';
        bridge.loadSession = async (req) => {
          loadParent = (req as { parentSessionId?: string }).parentSessionId;
          return {
            sessionId: req.sessionId,
            workspaceCwd: '/ws',
            attached: true,
            clientId: 'client-load',
            state: { replayed: true },
          };
        };
        bridge.resumeSession = async (req) => {
          resumeParent = (req as { parentSessionId?: string }).parentSessionId;
          return {
            sessionId: req.sessionId,
            workspaceCwd: '/ws',
            attached: true,
            clientId: 'client-resume',
            state: { resumed: true },
          };
        };

        const connId = await initialize();
        const stream = await openStream(connId);
        const reader = frameReader(stream);
        await post(connId, {
          jsonrpc: '2.0',
          id: 214,
          method,
          params: { sessionId },
        });
        expect(await reader.next()).toMatchObject({ id: 214 });
        reader.close();

        if (method === 'session/load') {
          expect(loadParent).toBe(parentId);
        } else {
          expect(resumeParent).toBe(parentId);
        }
      });
    },
  );

  it('session/prompt holds archive gate while prompt is in flight', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440127';
      await writeStoredSession(sessionId);
      let promptStarted!: () => void;
      let releasePrompt!: () => void;
      const promptStartedPromise = new Promise<void>((resolve) => {
        promptStarted = resolve;
      });
      const promptReleasedPromise = new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      bridge.promptBehavior = async () => {
        promptStarted();
        await promptReleasedPromise;
        return { stopReason: 'end_turn' };
      };

      const connId = await initialize();
      const connStream = await openStream(connId);
      const connReader = frameReader(connStream);
      await post(connId, {
        jsonrpc: '2.0',
        id: 217,
        method: 'session/load',
        params: { sessionId },
      });
      expect(await connReader.next()).toMatchObject({ id: 217 });

      const sessionStream = await openStream(connId, sessionId);
      const sessionReader = frameReader(sessionStream);
      await post(connId, {
        jsonrpc: '2.0',
        id: 218,
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [{ type: 'text', text: 'hold archive gate' }],
        },
      });
      await promptStartedPromise;

      await post(connId, {
        jsonrpc: '2.0',
        id: 219,
        method: '_qwen/sessions/archive',
        params: { sessionIds: [sessionId] },
      });
      expect(await connReader.next()).toMatchObject({
        id: 219,
        error: {
          code: -32603,
          data: { errorKind: 'session_archiving', sessionId },
        },
      });
      expect(bridge.closedSessions).toEqual([]);

      releasePrompt();
      expect(await sessionReader.next()).toMatchObject({
        id: 218,
        result: { stopReason: 'end_turn' },
      });
      connReader.close();
      sessionReader.close();
    });
  });

  it('_qwen/session/heartbeat does not wait for archive gate', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440130';
      await writeStoredSession(sessionId);
      let closeStarted!: () => void;
      let releaseClose!: () => void;
      const closeStartedPromise = new Promise<void>((resolve) => {
        closeStarted = resolve;
      });
      const closeReleasedPromise = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      bridge.closeSession = async (sid: string) => {
        bridge.closedSessions.push(sid);
        closeStarted();
        await closeReleasedPromise;
      };

      const connId = await initialize();
      const stream = await openStream(connId);
      const reader = frameReader(stream);
      await post(connId, {
        jsonrpc: '2.0',
        id: 220,
        method: 'session/load',
        params: { sessionId },
      });
      expect(await reader.next()).toMatchObject({ id: 220 });

      await post(connId, {
        jsonrpc: '2.0',
        id: 221,
        method: '_qwen/sessions/archive',
        params: { sessionIds: [sessionId] },
      });
      await closeStartedPromise;

      await post(connId, {
        jsonrpc: '2.0',
        id: 222,
        method: '_qwen/session/heartbeat',
        params: { sessionId },
      });
      expect(await reader.next()).toMatchObject({
        id: 222,
        result: { sessionId: 'sess-1' },
      });

      releaseClose();
      expect(await reader.next()).toMatchObject({
        id: 221,
        result: { archived: [sessionId], errors: [] },
      });
      reader.close();
    });
  });

  it('session/load allows concurrent restores for the same session', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440126';
      await writeStoredSession(sessionId);
      let releaseLoad!: () => void;
      bridge.gate = new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });

      const connId = await initialize();
      const stream = await openStream(connId);
      const got = takeFrames(stream, 2);
      await post(connId, {
        jsonrpc: '2.0',
        id: 214,
        method: 'session/load',
        params: { sessionId },
      });
      await post(connId, {
        jsonrpc: '2.0',
        id: 215,
        method: 'session/load',
        params: { sessionId },
      });

      releaseLoad();
      const frames = (await got) as Array<{
        id: number;
        result?: { replayed?: boolean };
        error?: { data?: { errorKind?: string } };
      }>;
      expect(frames.map((frame) => frame.id).sort()).toEqual([214, 215]);
      expect(frames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 214,
            result: expect.objectContaining({ replayed: true }),
          }),
          expect.objectContaining({
            id: 215,
            result: expect.objectContaining({ replayed: true }),
          }),
        ]),
      );
      expect(frames.some((frame) => frame.error)).toBe(false);
    });
  });

  it('session/close holds archive gate while close is in flight', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440125';
      await writeStoredSession(sessionId);
      const connId = await initialize();
      const stream = await openStream(connId);
      const reader = frameReader(stream);
      await post(connId, {
        jsonrpc: '2.0',
        id: 214,
        method: 'session/load',
        params: { sessionId },
      });
      expect(await reader.next()).toMatchObject({ id: 214 });

      let closeStarted!: () => void;
      let releaseClose!: () => void;
      let secondCloseStarted!: () => void;
      const closeStartedPromise = new Promise<void>((resolve) => {
        closeStarted = resolve;
      });
      const closeReleasedPromise = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      const secondCloseStartedPromise = new Promise<void>((resolve) => {
        secondCloseStarted = resolve;
      });
      let closeCount = 0;
      bridge.closeSession = async (sid: string) => {
        bridge.closedSessions.push(sid);
        closeCount++;
        if (closeCount === 1) {
          closeStarted();
          await closeReleasedPromise;
        } else {
          secondCloseStarted();
        }
      };

      await post(connId, {
        jsonrpc: '2.0',
        id: 215,
        method: 'session/close',
        params: { sessionId },
      });
      await closeStartedPromise;

      await post(connId, {
        jsonrpc: '2.0',
        id: 216,
        method: '_qwen/sessions/archive',
        params: { sessionIds: [sessionId] },
      });
      const archiveFrame = await reader.next();
      const raceResult = await Promise.race([
        secondCloseStartedPromise.then(() => 'second-close-started'),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 25)),
      ]);
      expect(archiveFrame).toMatchObject({
        id: 216,
        error: {
          code: -32603,
          data: { errorKind: 'session_archiving', sessionId },
        },
      });
      expect(raceResult).toBe('blocked');

      releaseClose();
      expect(await reader.next()).toMatchObject({
        id: 215,
        result: {},
      });
      reader.close();
    });
  });

  it('session/close falls back to the shared gate for its own in-flight prompt', async () => {
    let promptStarted!: () => void;
    let promptAborted!: () => void;
    const promptStartedPromise = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    const promptAbortedPromise = new Promise<void>((resolve) => {
      promptAborted = resolve;
    });
    bridge.promptBehavior = async (_s, _q, signal) => {
      promptStarted();
      if (signal === undefined) throw new Error('missing prompt signal');
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            promptAborted();
            resolve();
          },
          { once: true },
        );
      });
      return { stopReason: 'cancelled' };
    };

    const connId = await initialize();
    const connStream = await openStream(connId);
    const connReader = frameReader(connStream);
    await post(connId, {
      jsonrpc: '2.0',
      id: 230,
      method: 'session/new',
      params: {},
    });
    expect(await connReader.next()).toMatchObject({ id: 230 });
    const sessionStream = await openStream(connId, 'sess-1');

    await post(connId, {
      jsonrpc: '2.0',
      id: 231,
      method: 'session/prompt',
      params: {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'hold shared gate' }],
      },
    });
    await promptStartedPromise;

    await post(connId, {
      jsonrpc: '2.0',
      id: 232,
      method: 'session/close',
      params: { sessionId: 'sess-1' },
    });

    await promptAbortedPromise;
    const frames = [await connReader.next(), await connReader.next()];
    expect(frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 231 }),
        expect.objectContaining({ id: 232, result: {} }),
      ]),
    );
    expect(bridge.closedSessions).toEqual(['sess-1']);
    connReader.close();
    await sessionStream.body?.cancel().catch(() => {});
  });

  it('session/close reaches the bridge + replies on the conn stream', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    // 2 frames: the session/new reply (establishes ownership), then close.
    const got = takeFrames(connStream, 2);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 99,
      method: 'session/new',
      params: {},
    });
    await new Promise((r) => setTimeout(r, 30));
    await post(connId, {
      jsonrpc: '2.0',
      id: 22,
      method: 'session/close',
      params: { sessionId: 'sess-1' },
    });
    const frames = (await got) as Array<{ id: number }>;
    expect(frames.map((f) => f.id)).toContain(22);
    expect(bridge.closedSessions).toContain('sess-1');
  });

  it('initialize clamps protocolVersion to [1, 1]', async () => {
    for (const [requested, expected] of [
      [0, 1],
      [-3, 1],
      [99, 1],
      ['bad', 1],
    ] as Array<[unknown, number]>) {
      const res = await fetch(`${base}/acp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: requested },
        }),
      });
      const body = (await res.json()) as {
        result: { protocolVersion: number };
      };
      expect(body.result.protocolVersion).toBe(expected);
    }
  });

  it('session/load failure routes the error to the connection stream', async () => {
    bridge.loadShouldThrow = true;
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 30,
      method: 'session/load',
      params: { sessionId: 'x' },
    });
    const [frame] = (await got) as Array<{
      id: number;
      error: { code: number };
    }>;
    expect(frame.id).toBe(30);
    expect(frame.error.code).toBe(-32603);
  });

  it('connection teardown detaches the session client from the bridge', async () => {
    const connId = await initialize();
    await newSession(connId);
    await fetch(`${base}/acp`, {
      method: 'DELETE',
      headers: { 'acp-connection-id': connId },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.detached.some((d) => d.sessionId === 'sess-1')).toBe(true);
  });

  it('malformed permission response still releases the bridge (cancel fallback)', async () => {
    const votes: Array<{ outcome?: { outcome?: string } }> = [];
    // Emulate the real bridge: throw on a vote with no `outcome`.
    bridge.respondToSessionPermission = ((
      _s: string,
      _r: string,
      resp: unknown,
    ) => {
      const r = resp as { outcome?: { outcome?: string } };
      if (!r?.outcome?.outcome) throw new Error('invalid permission response');
      votes.push(r);
      return true;
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-x',
          sessionId: 'sess-1',
          toolCall: {},
          options: [{ optionId: 'allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 40));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 50,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'x' }] },
    });
    const [reqFrame] = (await got) as Array<{ id: string }>;
    // Client answers with a malformed result (no outcome) → bridge throws →
    // fallback must still cancel so the mediator is released.
    await post(connId, { jsonrpc: '2.0', id: reqFrame.id, result: {} });
    await new Promise((r) => setTimeout(r, 50));
    expect(votes).toContainEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('cross-connection malformed permission result still releases the bridge (cancel fallback)', async () => {
    const votes: Array<{ outcome?: { outcome?: string } }> = [];
    bridge.respondToSessionPermission = ((
      _s: string,
      _r: string,
      resp: unknown,
    ) => {
      const r = resp as { outcome?: { outcome?: string } };
      if (!r?.outcome?.outcome) throw new Error('invalid permission response');
      votes.push(r);
      return true;
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-xc',
          sessionId: 'sess-1',
          toolCall: {},
          options: [{ optionId: 'allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 60));
      return { stopReason: 'end_turn' };
    };
    const streamConnId = await initialize();
    await newSession(streamConnId);
    const voterConnId = await initialize();
    await newSession(voterConnId, 100); // co-owns sess-1
    const sessStream = await openStream(streamConnId, 'sess-1');
    const got = takeFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(streamConnId, {
      jsonrpc: '2.0',
      id: 7,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'x' }] },
    });
    const [reqFrame] = (await got) as Array<{ id: string }>;
    // Connection B (a co-owner) answers connection A's request via the legacy
    // path with a malformed result. parsePermissionResponse — added for this
    // path so co-owners can't bypass the whitelist — throws, and the cancel
    // fallback must still release the mediator.
    await post(voterConnId, { jsonrpc: '2.0', id: reqFrame.id, result: {} });
    await new Promise((r) => setTimeout(r, 50));
    expect(votes).toContainEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('a second concurrent prompt aborts the first', async () => {
    let firstSignal: AbortSignal | undefined;
    bridge.promptBehavior = async (_s, _q, signal) => {
      if (!firstSignal) {
        firstSignal = signal;
        await new Promise<void>((r) =>
          signal?.addEventListener('abort', () => r(), { once: true }),
        );
        return { stopReason: 'cancelled' };
      }
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const drain = takeFrames(sessStream, 2); // both prompt results
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 60,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'a' }] },
    });
    await new Promise((r) => setTimeout(r, 30));
    await post(connId, {
      jsonrpc: '2.0',
      id: 61,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'b' }] },
    });
    await drain;
    expect(firstSignal?.aborted).toBe(true);
  });

  it('subscribeEvents throwing closes the session stream promptly (no zombie)', async () => {
    bridge.subscribeThrows = true;
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    // The guarantee is that the server CLOSES the stream (not a zombie that
    // heartbeats forever). A safety abort at 3s distinguishes "server closed"
    // (loop ends fast) from "zombie" (only our timeout ends it).
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    const start = Date.now();
    try {
      for await (const _f of readSse(sessStream, ac.signal)) {
        // drain
      }
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
    // Server-initiated close arrives well under the 3s safety timeout.
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it('concurrent session/close calls the bridge exactly once (no TOCTOU double-close)', async () => {
    const connId = await initialize();
    await newSession(connId);
    await Promise.all([
      post(connId, {
        jsonrpc: '2.0',
        id: 70,
        method: 'session/close',
        params: { sessionId: 'sess-1' },
      }),
      post(connId, {
        jsonrpc: '2.0',
        id: 71,
        method: 'session/close',
        params: { sessionId: 'sess-1' },
      }),
    ]);
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.closedSessions.filter((s) => s === 'sess-1')).toHaveLength(1);
  });

  it('clean iterator end closes the session stream (no zombie)', async () => {
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    await new Promise((r) => setTimeout(r, 50));
    // Subprocess ends cleanly → bridge event iterator returns done.
    bridge.queues.get('sess-1')?.end();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    const start = Date.now();
    try {
      for await (const _f of readSse(sessStream, ac.signal)) {
        // drain
      }
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it('session-stream reconnect does NOT abort the in-flight prompt', async () => {
    let promptSignal: AbortSignal | undefined;
    bridge.promptBehavior = async (_s, q, signal) => {
      promptSignal = signal;
      q.push({
        type: 'session_update',
        data: { sessionId: 'sess-1', update: {} },
      });
      await new Promise((r) => setTimeout(r, 200));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const s1 = await openStream(connId, 'sess-1');
    await new Promise((r) => setTimeout(r, 40));
    await post(connId, {
      jsonrpc: '2.0',
      id: 80,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] },
    });
    await new Promise((r) => setTimeout(r, 40));
    // Reconnect: install the NEW stream and let it attach FIRST, then drop the
    // old one. This deterministically exercises the invariant under test —
    // the old (now-stale) stream's close must NOT abort the prompt because a
    // newer stream is already the session's current one (install-before-close
    // + identity-guarded onClose). (Attaching s2 before dropping s1 avoids a
    // test-only race between s1.close and s2.attach under full-suite load.)
    const s2 = await openStream(connId, 'sess-1');
    await new Promise((r) => setTimeout(r, 40));
    await s1.body?.cancel();
    await new Promise((r) => setTimeout(r, 40));
    // The prompt must survive the reconnect.
    expect(promptSignal?.aborted).toBe(false);
    await s2.body?.cancel();
  });

  it('prompt response is delivered even if the session closes mid-flight', async () => {
    // Prompt resolves only after we close the session — exercises the
    // binding-gone fallback (reply must ride the connection stream).
    let release: () => void = () => {};
    bridge.promptBehavior = async (_s, _q) => {
      await new Promise<void>((r) => (release = r));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const connStream = await openStream(connId);
    const sessStream = await openStream(connId, 'sess-1');
    // conn stream carries: buffered session/new reply (id 99), the close
    // ack (id 91), AND the fallback prompt reply (id 90).
    const connFrames = takeFrames(connStream, 3);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 90,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] },
    });
    await new Promise((r) => setTimeout(r, 30));
    // Close the session while the prompt is still in flight, then let it resolve.
    await post(connId, {
      jsonrpc: '2.0',
      id: 91,
      method: 'session/close',
      params: { sessionId: 'sess-1' },
    });
    await new Promise((r) => setTimeout(r, 30));
    release();
    const frames = (await connFrames) as Array<{ id: number }>;
    // The prompt's id-90 response must appear (on the conn stream, since the
    // session binding is gone) — not silently dropped.
    expect(frames.map((f) => f.id)).toContain(90);
    await sessStream.body?.cancel();
  });

  it('session/set_config_option rejects empty value (INVALID_PARAMS)', async () => {
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 41,
      method: 'session/set_config_option',
      params: { sessionId: 'sess-1', configId: 'model', value: '' },
    });
    const [frame] = (await got) as Array<{
      id: number;
      error: { code: number };
    }>;
    expect(frame.error.code).toBe(-32602);
  });

  it('session/set_config_option rejects an invalid mode value', async () => {
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 42,
      method: 'session/set_config_option',
      params: { sessionId: 'sess-1', configId: 'mode', value: 'bogus-mode' },
    });
    const [frame] = (await got) as Array<{
      id: number;
      error: { code: number };
    }>;
    expect(frame.error.code).toBe(-32602);
    expect(bridge.lastApprovalMode).toBeUndefined();
  });

  it('session/new always uses thread scope (ACP standard compliance)', async () => {
    // ACP standard: session/new MUST create a new isolated session.
    // sessionScope param is ignored; bridge always gets 'thread'.
    const connId = await initialize();
    await post(connId, {
      jsonrpc: '2.0',
      id: 43,
      method: 'session/new',
      params: { sessionScope: 'single' }, // ignored
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.lastSpawnScope).toBe('thread');

    // Even 'bogus' is ignored (not rejected) — param is simply not read
    const c2 = await initialize();
    await post(c2, {
      jsonrpc: '2.0',
      id: 44,
      method: 'session/new',
      params: { sessionScope: 'bogus' },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.lastSpawnScope).toBe('thread');
  });

  it('session/prompt with empty prompt → INVALID_PARAMS', async () => {
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 45,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [] },
    });
    const [frame] = (await got) as Array<{ error: { code: number } }>;
    expect(frame.error.code).toBe(-32602);
  });

  it('session/prompt queue cap error includes stable JSON-RPC data', async () => {
    bridge.promptBehavior = () => {
      throw new PromptQueueFullError(5, 5, 'sess-1');
    };
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 46,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] },
    });

    const [frame] = (await got) as Array<{
      error: { code: number; data: Record<string, unknown> };
    }>;
    expect(frame.error.code).toBe(-32603);
    expect(frame.error.data).toMatchObject({
      errorKind: 'prompt_queue_full',
      sessionId: 'sess-1',
      limit: 5,
      pendingCount: 5,
    });
  });

  it('session/close runs local cleanup even if the bridge close throws', async () => {
    bridge.closeShouldThrow = true;
    const connId = await initialize();
    await newSession(connId); // creates + owns sess-1
    await new Promise((r) => setTimeout(r, 30));
    await post(connId, {
      jsonrpc: '2.0',
      id: 46,
      method: 'session/close',
      params: { sessionId: 'sess-1' },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.closedSessions).toContain('sess-1'); // bridge was called (then threw)
    // Local teardown ran in `finally` despite the throw → session unowned now.
    const after = await openStream(connId, 'sess-1');
    expect(after.status).toBe(403);
  });

  it('connection cap → 503 on initialize', async () => {
    const app2 = express();
    app2.use(express.json());
    mountAcpHttp(app2, bridge as unknown as HttpAcpBridge, {
      boundWorkspace: '/ws',
      workspace: fakeWorkspace,
      enabled: true,
      maxConnections: 1,
      workspaceRememberLane: new WorkspaceRememberTaskLane(
        bridge as unknown as HttpAcpBridge,
      ),
    });
    const srv = app2.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/acp`;
    const init = (n: number) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: n, method: 'initialize' }),
      });
    const r1 = await init(1);
    expect(r1.status).toBe(200);
    const r2 = await init(2);
    expect(r2.status).toBe(503);
    expect(r2.headers.get('retry-after')).toBe('5');
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it('session/cancel aborts the in-flight prompt and calls the bridge', async () => {
    let promptSignal: AbortSignal | undefined;
    bridge.promptBehavior = async (_s, _q, signal) => {
      promptSignal = signal;
      await new Promise((r) => setTimeout(r, 300));
      return { stopReason: 'cancelled' };
    };
    const connId = await initialize();
    await newSession(connId);
    const sess = await openStream(connId, 'sess-1');
    await new Promise((r) => setTimeout(r, 40));
    await post(connId, {
      jsonrpc: '2.0',
      id: 50,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] },
    });
    await new Promise((r) => setTimeout(r, 40));
    await post(connId, {
      jsonrpc: '2.0',
      id: 51,
      method: 'session/cancel',
      params: { sessionId: 'sess-1' },
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(promptSignal?.aborted).toBe(true);
    expect(bridge.cancelled).toContain('sess-1');
    await sess.body?.cancel();
  });

  it('session/new rejects bad cwd (non-string + relative) → INVALID_PARAMS', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 2);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 60,
      method: 'session/new',
      params: { cwd: 123 },
    });
    await post(connId, {
      jsonrpc: '2.0',
      id: 61,
      method: 'session/new',
      params: { cwd: 'rel/path' },
    });
    const frames = (await got) as Array<{
      id: number;
      error?: { code: number };
    }>;
    for (const f of frames) expect(f.error?.code).toBe(-32602);
  });

  it('session/new orphan: DELETE before spawn resolves removes the persisted session', async () => {
    const removeSession = vi
      .spyOn(SessionService.prototype, 'removeSession')
      .mockResolvedValue(true);
    let release: () => void = () => {};
    bridge.gate = new Promise<void>((r) => (release = r));
    const connId = await initialize();
    await post(connId, {
      jsonrpc: '2.0',
      id: 70,
      method: 'session/new',
      params: {},
    });
    await new Promise((r) => setTimeout(r, 30)); // spawnOrAttach now awaiting the gate
    await fetch(`${base}/acp`, {
      method: 'DELETE',
      headers: { 'acp-connection-id': connId },
    });
    release(); // spawn resolves AFTER destroy
    await new Promise((r) => setTimeout(r, 40));
    expect(bridge.killed).toContain('sess-1');
    expect(removeSession).toHaveBeenCalledWith('sess-1');
    removeSession.mockRestore();
  });

  it('session/load orphan (attached:false) → killSession, not detach', async () => {
    let release: () => void = () => {};
    bridge.gate = new Promise<void>((r) => (release = r));
    bridge.loadAttached = false; // restore SPAWNED from disk → must be killed
    const connId = await initialize();
    await post(connId, {
      jsonrpc: '2.0',
      id: 80,
      method: 'session/load',
      params: { sessionId: 'sess-1' },
    });
    await new Promise((r) => setTimeout(r, 30));
    await fetch(`${base}/acp`, {
      method: 'DELETE',
      headers: { 'acp-connection-id': connId },
    });
    release();
    await new Promise((r) => setTimeout(r, 40));
    expect(bridge.killed).toContain('sess-1');
    expect(bridge.detached.some((d) => d.sessionId === 'sess-1')).toBe(false);
  });

  it('_qwen/* introspection methods reach the bridge (conn-routed)', async () => {
    const connId = await initialize();
    await newSession(connId);
    const connStream = await openStream(connId);
    // 4 frames: buffered session/new reply (id 99) + the 3 below.
    const got = takeFrames(connStream, 4);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 200,
      method: '_qwen/session/context',
      params: { sessionId: 'sess-1' },
    });
    await post(connId, {
      jsonrpc: '2.0',
      id: 201,
      method: '_qwen/session/heartbeat',
      params: { sessionId: 'sess-1' },
    });
    await post(connId, {
      jsonrpc: '2.0',
      id: 202,
      method: '_qwen/workspace/skills',
    });
    const ids = ((await got) as Array<{ id?: number }>).map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining([200, 201, 202]));
  });

  it('_qwen/workspace/set_tool_enabled + restart_mcp_server validate name', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 3);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 210,
      method: '_qwen/workspace/set_tool_enabled',
      params: { toolName: '', enabled: true },
    });
    await post(connId, {
      jsonrpc: '2.0',
      id: 211,
      method: '_qwen/workspace/restart_mcp_server',
      params: { serverName: '' },
    });
    await post(connId, {
      jsonrpc: '2.0',
      id: 212,
      method: '_qwen/workspace/set_tool_enabled',
      params: { toolName: 'shell', enabled: false },
    });
    const frames = (await got) as Array<{
      id: number;
      error?: { code: number };
      result?: unknown;
    }>;
    const byId = Object.fromEntries(frames.map((f) => [f.id, f]));
    expect(byId[210].error?.code).toBe(-32602);
    expect(byId[211].error?.code).toBe(-32602);
    expect(byId[212].result).toBeDefined();
  });

  it('dispatches _qwen/workspace/trust', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 213,
      method: '_qwen/workspace/trust',
      params: {},
    });
    const frames = (await got) as Array<{ id: number; result?: unknown }>;
    expect(frames[0]).toMatchObject({
      id: 213,
      result: {
        v: 1,
        workspaceCwd: '/ws',
        folderTrustEnabled: true,
      },
    });
  });

  it('dispatches _qwen/workspace/trust/request', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 214,
      method: '_qwen/workspace/trust/request',
      params: { desiredState: 'untrusted', reason: 'remote user request' },
    });
    const frames = (await got) as Array<{ id: number; result?: unknown }>;
    expect(frames[0]).toMatchObject({
      id: 214,
      result: {
        accepted: true,
        desiredState: 'untrusted',
        reason: 'remote user request',
        requiresOperatorAction: true,
      },
    });
  });

  it.each([
    {
      params: { desiredState: 'unknown' },
      message: '`desiredState` must be "trusted" or "untrusted"',
    },
    {
      params: {
        desiredState: 'trusted',
        reason: 'x'.repeat(MAX_TRUST_REASON_LENGTH + 1),
      },
      message: `\`reason\` must be a string up to ${MAX_TRUST_REASON_LENGTH} chars`,
    },
  ])(
    'rejects invalid _qwen/workspace/trust/request params: $message',
    async ({ params, message }) => {
      const requestSpy = vi.spyOn(fakeWorkspace, 'requestWorkspaceTrustChange');
      const connId = await initialize();
      const connStream = await openStream(connId);
      const got = takeFrames(connStream, 1);
      await new Promise((r) => setTimeout(r, 50));
      await post(connId, {
        jsonrpc: '2.0',
        id: 215,
        method: '_qwen/workspace/trust/request',
        params,
      });
      const frames = (await got) as Array<{
        id: number;
        error?: { code: number; message: string };
      }>;
      expect(frames[0]).toMatchObject({
        id: 215,
        error: { code: -32602, message },
      });
      expect(requestSpy).not.toHaveBeenCalled();
      requestSpy.mockRestore();
    },
  );

  it('rejects _qwen/workspace/trust/request when folder trust is disabled', async () => {
    const trustSpy = vi
      .spyOn(fakeWorkspace, 'getWorkspaceTrustStatus')
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/ws',
        folderTrustEnabled: false,
        effective: { state: 'trusted', source: 'disabled' },
        explicitTrustLevel: null,
        requiresDaemonRestartForChanges: true,
      });
    const requestSpy = vi.spyOn(fakeWorkspace, 'requestWorkspaceTrustChange');

    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 215,
      method: '_qwen/workspace/trust/request',
      params: { desiredState: 'trusted' },
    });

    const frames = (await got) as Array<{
      id: number;
      error?: { code: number; message: string };
    }>;
    expect(frames[0]).toMatchObject({
      id: 215,
      error: {
        code: -32600,
        message: 'Folder trust is disabled for this workspace',
      },
    });
    expect(requestSpy).not.toHaveBeenCalled();
    trustSpy.mockRestore();
    requestSpy.mockRestore();
  });

  it('dispatches _qwen/workspace/permissions', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 216,
      method: '_qwen/workspace/permissions',
      params: {},
    });
    const frames = (await got) as Array<{ id: number; result?: unknown }>;
    expect(frames[0]).toMatchObject({
      id: 216,
      result: {
        v: 1,
        isTrusted: true,
        workspace: { path: '/ws/.qwen/settings.json' },
      },
    });
  });

  it('dispatches _qwen/workspace/permissions/set', async () => {
    const setSpy = vi.spyOn(fakeWorkspace, 'setWorkspacePermissionRules');
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 217,
      method: '_qwen/workspace/permissions/set',
      params: {
        scope: 'workspace',
        ruleType: 'deny',
        rules: [' Read(.env) ', 'Read(.env)'],
      },
    });
    const frames = (await got) as Array<{ id: number; result?: unknown }>;
    expect(frames[0]).toMatchObject({
      id: 217,
      result: {
        workspace: { rules: { deny: ['Read(.env)'] } },
        merged: { deny: ['Read(.env)'] },
      },
    });
    expect(setSpy).toHaveBeenCalledWith(expect.any(Object), {
      scope: 'workspace',
      ruleType: 'deny',
      rules: ['Read(.env)'],
    });
    setSpy.mockRestore();
  });

  it.each([
    {
      params: {
        scope: 'project',
        ruleType: 'deny',
        rules: ['Read(.env)'],
      },
      message: '`scope` must be "user" or "workspace"',
    },
    {
      params: {
        scope: 'workspace',
        ruleType: 'block',
        rules: ['Read(.env)'],
      },
      message: '`ruleType` must be "allow", "ask", or "deny"',
    },
  ])(
    'rejects invalid _qwen/workspace/permissions/set params: $message',
    async ({ params, message }) => {
      const setSpy = vi.spyOn(fakeWorkspace, 'setWorkspacePermissionRules');
      const connId = await initialize();
      const connStream = await openStream(connId);
      const got = takeFrames(connStream, 1);
      await new Promise((r) => setTimeout(r, 50));
      await post(connId, {
        jsonrpc: '2.0',
        id: 218,
        method: '_qwen/workspace/permissions/set',
        params,
      });
      const frames = (await got) as Array<{
        id: number;
        error?: { code: number; message: string };
      }>;
      expect(frames[0]).toMatchObject({
        id: 218,
        error: { code: -32602, message },
      });
      expect(setSpy).not.toHaveBeenCalled();
      setSpy.mockRestore();
    },
  );

  it('preserves already-stored malformed permission rules through ACP permissions/set', async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-acp-'));
    const workspace = path.join(scratch, 'workspace');
    const home = path.join(scratch, 'home');
    const originalQwenHome = process.env['QWEN_HOME'];
    const setSpy = vi.spyOn(fakeWorkspace, 'setWorkspacePermissionRules');
    try {
      process.env['QWEN_HOME'] = home;
      resetHomeEnvBootstrapForTesting();
      await fs.mkdir(workspace, { recursive: true });
      await writeJson(
        path.join(workspace, SETTINGS_DIRECTORY_NAME, 'settings.json'),
        { permissions: { allow: ['Bash(git *'] } },
      );
      await restartServer({ boundWorkspace: workspace });
      const connId = await initialize();
      const connStream = await openStream(connId);
      const got = takeFrames(connStream, 1);
      await new Promise((r) => setTimeout(r, 50));
      await post(connId, {
        jsonrpc: '2.0',
        id: 218,
        method: '_qwen/workspace/permissions/set',
        params: {
          scope: 'workspace',
          ruleType: 'allow',
          rules: ['Bash(git *', 'Bash(git status)'],
        },
      });
      const frames = (await got) as Array<{ id: number; result?: unknown }>;
      expect(frames[0]).toMatchObject({ id: 218, result: { v: 1 } });
      expect(setSpy).toHaveBeenCalledWith(expect.any(Object), {
        scope: 'workspace',
        ruleType: 'allow',
        rules: ['Bash(git *', 'Bash(git status)'],
      });
    } finally {
      if (originalQwenHome === undefined) {
        delete process.env['QWEN_HOME'];
      } else {
        process.env['QWEN_HOME'] = originalQwenHome;
      }
      resetHomeEnvBootstrapForTesting();
      setSpy.mockRestore();
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  it('maps _qwen/workspace/permissions/set missing live session to INVALID_PARAMS', async () => {
    const setSpy = vi
      .spyOn(fakeWorkspace, 'setWorkspacePermissionRules')
      .mockRejectedValueOnce(
        new WorkspacePermissionRulesSessionRequiredError(),
      );
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 218,
      method: '_qwen/workspace/permissions/set',
      params: {
        scope: 'workspace',
        ruleType: 'deny',
        rules: ['Read(.env)'],
      },
    });
    const frames = (await got) as Array<{
      id: number;
      error?: { code: number; data?: { errorKind?: string } };
    }>;
    expect(frames[0]).toMatchObject({
      id: 218,
      error: {
        code: -32602,
        data: { errorKind: 'permission_session_required' },
      },
    });
    setSpy.mockRestore();
  });

  it('dispatches _qwen/workspace/voice', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 219,
      method: '_qwen/workspace/voice',
      params: {},
    });
    const frames = (await got) as Array<{ id: number; result?: unknown }>;
    expect(frames[0]).toMatchObject({
      id: 219,
      result: {
        v: 1,
        workspaceCwd: '/ws',
        enabled: false,
      },
    });
  });

  it('dispatches _qwen/workspace/voice/set', async () => {
    const setSpy = vi.spyOn(fakeWorkspace, 'setWorkspaceVoiceSettings');
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 219,
      method: '_qwen/workspace/voice/set',
      params: {
        enabled: true,
        mode: 'tap',
        language: ' english ',
        voiceModel: ' qwen3-asr-flash ',
      },
    });
    const frames = (await got) as Array<{ id: number; result?: unknown }>;
    expect(frames[0]).toMatchObject({
      id: 219,
      result: {
        enabled: true,
        mode: 'tap',
        language: 'english',
        voiceModel: 'qwen3-asr-flash',
      },
    });
    expect(setSpy).toHaveBeenCalledWith(expect.any(Object), {
      enabled: true,
      mode: 'tap',
      language: 'english',
      voiceModel: 'qwen3-asr-flash',
    });
    setSpy.mockRestore();
  });

  it('maps _qwen/workspace/voice/set validation errors to invalid params', async () => {
    const setSpy = vi
      .spyOn(fakeWorkspace, 'setWorkspaceVoiceSettings')
      .mockRejectedValueOnce(
        new WorkspaceVoiceError(
          400,
          'unknown_voice_model',
          'Voice model is not configured.',
        ),
      );
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 220,
      method: '_qwen/workspace/voice/set',
      params: { voiceModel: 'missing' },
    });
    const frames = (await got) as Array<{
      id: number;
      error?: { code: number; data?: { errorKind?: string } };
    }>;
    expect(frames[0]).toMatchObject({
      id: 220,
      error: {
        code: -32602,
        data: { errorKind: 'unknown_voice_model' },
      },
    });
    setSpy.mockRestore();
  });

  it('maps _qwen/workspace/voice/set partial persist errors to structured internal errors', async () => {
    const setSpy = vi
      .spyOn(fakeWorkspace, 'setWorkspaceVoiceSettings')
      .mockRejectedValueOnce(
        new WorkspaceSettingsPartialPersistError(
          'batch failed',
          [
            {
              scope: SettingScope.Workspace,
              key: 'voiceModel',
              value: 'qwen3-asr-flash',
            },
          ],
          new Error('disk full'),
        ),
      );
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 223,
      method: '_qwen/workspace/voice/set',
      params: { voiceModel: 'qwen3-asr-flash' },
    });
    const frames = (await got) as Array<{
      id: number;
      error?: {
        code: number;
        message?: string;
        data?: { errorKind?: string; committedKeys?: string[] };
      };
    }>;
    expect(frames[0]).toMatchObject({
      id: 223,
      error: {
        code: -32603,
        message: 'batch failed',
        data: {
          errorKind: 'partial_persist_error',
          committedKeys: ['voiceModel'],
        },
      },
    });
    setSpy.mockRestore();
  });

  it('rejects overlong _qwen/workspace/voice/set voiceModel values', async () => {
    const setSpy = vi.spyOn(fakeWorkspace, 'setWorkspaceVoiceSettings');
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 222,
      method: '_qwen/workspace/voice/set',
      params: { voiceModel: 'x'.repeat(MAX_VOICE_MODEL_LENGTH + 1) },
    });
    const frames = (await got) as Array<{
      id: number;
      error?: { code: number; message?: string };
    }>;
    expect(frames[0]).toMatchObject({
      id: 222,
      error: {
        code: -32602,
        message: `\`voiceModel\` exceeds the ${MAX_VOICE_MODEL_LENGTH}-character limit`,
      },
    });
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it('rejects _qwen/workspace/voice/set with no recognized update fields', async () => {
    const setSpy = vi.spyOn(fakeWorkspace, 'setWorkspaceVoiceSettings');
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 221,
      method: '_qwen/workspace/voice/set',
      params: { enabled_: true },
    });
    const frames = (await got) as Array<{
      id: number;
      error?: { code: number; message?: string };
    }>;
    expect(frames[0]).toMatchObject({
      id: 221,
      error: {
        code: -32602,
        message:
          'At least one of `enabled`, `mode`, `language`, or `voiceModel` must be provided',
      },
    });
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it('dispatches _qwen/workspace/setup-github', async () => {
    await restartServer({
      fsFactory: makeFileFsFactory({}),
      daemonEnv: { HTTPS_PROXY: 'http://runtime-proxy.example:8080' },
    });
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 221,
      method: '_qwen/workspace/setup-github',
      params: { consent: true },
    });
    const frames = (await got) as Array<{ id: number; result?: unknown }>;

    expect(frames[0]).toMatchObject({
      id: 221,
      result: {
        kind: 'github_setup',
        workspaceCwd: '/ws',
        releaseTag: 'v1.2.3',
      },
    });
    expect(setupGithubMocks.setupGithub).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/ws',
        workspaceRoot: '/ws',
        proxy: 'http://runtime-proxy.example:8080',
        abortSignal: expect.any(AbortSignal),
        fileOps: expect.any(Object),
      }),
    );
    expect(bridge.workspaceEvents).toContainEqual(
      expect.objectContaining({
        type: 'github_setup_completed',
        data: expect.objectContaining({ releaseTag: 'v1.2.3' }),
      }),
    );
  });

  it('rejects _qwen/workspace/setup-github without consent', async () => {
    await restartServer({ fsFactory: makeFileFsFactory({}) });
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 222,
      method: '_qwen/workspace/setup-github',
      params: { consent: false },
    });
    const frames = (await got) as Array<{
      id: number;
      error?: { code: number; data?: { errorKind?: string } };
    }>;

    expect(frames[0]).toMatchObject({
      id: 222,
      error: {
        code: -32602,
        data: { errorKind: 'github_setup_consent_required' },
      },
    });
    expect(setupGithubMocks.setupGithub).not.toHaveBeenCalled();
  });

  it('maps _qwen/workspace/setup-github without fsFactory to an internal error', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 222,
      method: '_qwen/workspace/setup-github',
      params: { consent: true },
    });
    const frames = (await got) as Array<{
      id: number;
      error?: { code: number; data?: { errorKind?: string } };
    }>;

    expect(frames[0]).toMatchObject({
      id: 222,
      error: { code: -32603, data: { errorKind: 'internal_error' } },
    });
    expect(setupGithubMocks.setupGithub).not.toHaveBeenCalled();
  });

  it('includes partial setup-github results in ACP errors', async () => {
    await restartServer({ fsFactory: makeFileFsFactory({}) });
    const partial: SetupGithubResult = {
      kind: 'github_setup',
      workspaceCwd: '/ws',
      gitRepoRoot: '/ws',
      releaseTag: 'v1.2.3',
      readmeUrl: 'https://github.com/QwenLM/qwen-code-action',
      workflows: [
        {
          sourcePath: 'qwen-invoke.yml',
          path: '.github/workflows/qwen-invoke.yml',
          status: 'failed',
          error: 'ENOSPC: open /ws/.github/workflows/qwen-invoke.yml',
        },
      ],
      gitignore: { path: '.gitignore', status: 'created' },
      warnings: [],
      partial: true,
    };
    setupGithubMocks.setupGithub.mockRejectedValueOnce(
      new SetupGithubError(
        'github_workflow_write_failed',
        'Unable to write .github/workflows/qwen-invoke.yml.',
        500,
        partial,
      ),
    );

    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 222,
      method: '_qwen/workspace/setup-github',
      params: { consent: true },
    });
    const frames = (await got) as Array<{
      id: number;
      error?: { code: number; data?: unknown };
    }>;
    const sanitizedPartial = {
      ...partial,
      workflows: [
        {
          ...partial.workflows[0],
          error: 'ENOSPC: open <workspace>/.github/workflows/qwen-invoke.yml',
        },
      ],
    };

    expect(frames[0]).toMatchObject({
      id: 222,
      error: {
        code: -32603,
        data: {
          errorKind: 'github_workflow_write_failed',
          partial: true,
          result: sanitizedPartial,
        },
      },
    });
  });

  it('translateEvent: stream_error + client_evicted → _qwen/notify with kind', async () => {
    const connId = await initialize();
    await newSession(connId);
    const sess = await openStream(connId, 'sess-1');
    const got = takeFrames(sess, 2);
    await new Promise((r) => setTimeout(r, 50));
    const q = bridge.queues.get('sess-1');
    q?.push({ type: 'stream_error', data: { error: 'boom' } });
    q?.push({ type: 'client_evicted', data: { reason: 'slow' } });
    const frames = (await got) as Array<{
      method: string;
      params: { kind: string };
    }>;
    expect(frames.every((f) => f.method === '_qwen/notify')).toBe(true);
    const kinds = frames.map((f) => f.params.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['stream_error', 'client_evicted']),
    );
    // (takeFrames already locked + aborted `sess`; afterEach force-closes.)
  });

  it('session/load while a session/close is in-flight → rejected (TOCTOU guard)', async () => {
    let releaseClose: () => void = () => {};
    bridge.closeGate = new Promise<void>((r) => (releaseClose = r));
    const connId = await initialize();
    await newSession(connId);
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 2); // session/new reply + load reject
    await new Promise((r) => setTimeout(r, 50));
    // close is now in flight (awaiting closeGate) → sess-1 is "closing".
    void post(connId, {
      jsonrpc: '2.0',
      id: 300,
      method: 'session/close',
      params: { sessionId: 'sess-1' },
    });
    await new Promise((r) => setTimeout(r, 30));
    await post(connId, {
      jsonrpc: '2.0',
      id: 301,
      method: 'session/load',
      params: { sessionId: 'sess-1' },
    });
    const frames = (await got) as Array<{
      id: number;
      error?: { code: number; message: string };
    }>;
    const loadReply = frames.find((f) => f.id === 301);
    // Transient server-side race → INTERNAL_ERROR (-32603), not INVALID_PARAMS.
    expect(loadReply?.error?.code).toBe(-32603); // "being closed; retry"
    expect(loadReply?.error?.message).toContain('being closed');
    releaseClose();
  });

  it('session/close while load is in-flight → close rejected by archive gate', async () => {
    // The archive coordinator now covers the whole load/restore await, so a
    // same-id close that starts during load is rejected before it can mark the
    // session closing or tear down the just-restored binding.
    let releaseLoad: () => void = () => {};
    const connId = await initialize();
    await newSession(connId); // own sess-1 so session/close passes requireOwned
    // Arm the gates only AFTER ownership is established — otherwise newSession's
    // own spawnOrAttach would block on bridge.gate and never grant ownership.
    bridge.gate = new Promise<void>((r) => (releaseLoad = r));
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 3); // session/new + close reject + load success
    await new Promise((r) => setTimeout(r, 50));
    // Load goes in-flight (awaits bridge.gate); pre-await closingSessions empty.
    void post(connId, {
      jsonrpc: '2.0',
      id: 340,
      method: 'session/load',
      params: { sessionId: 'sess-1' },
    });
    await new Promise((r) => setTimeout(r, 20));
    // Close starts DURING the load → marks sess-1 closing (awaits closeGate).
    void post(connId, {
      jsonrpc: '2.0',
      id: 341,
      method: 'session/close',
      params: { sessionId: 'sess-1' },
    });
    await new Promise((r) => setTimeout(r, 20));
    releaseLoad(); // loadSession resolves after close has been rejected.
    const frames = (await got) as Array<{
      id: number;
      result?: { replayed?: boolean };
      error?: { code: number; message: string; data?: { errorKind?: string } };
    }>;
    const closeReply = frames.find((f) => f.id === 341);
    expect(closeReply?.error?.code).toBe(-32603);
    expect(closeReply?.error?.data?.errorKind).toBe('session_archiving');
    const loadReply = frames.find((f) => f.id === 340);
    expect(loadReply?.result?.replayed).toBe(true);
    expect(bridge.detached.some((d) => d.sessionId === 'sess-1')).toBe(false);
    expect(bridge.killed).not.toContain('sess-1');

    const retryCloseStream = await openStream(connId);
    const retryCloseReader = frameReader(retryCloseStream);
    await post(connId, {
      jsonrpc: '2.0',
      id: 342,
      method: 'session/close',
      params: { sessionId: 'sess-1' },
    });
    expect(await retryCloseReader.next()).toMatchObject({
      id: 342,
      result: {},
    });
    retryCloseReader.close();
    expect(bridge.closedSessions).toEqual(['sess-1']);
  });

  it('double-failure permission vote → pending retained + retried on teardown', async () => {
    // Core R14 invariant: when BOTH the vote and the immediate cancel throw a
    // non-"not found" error, resolveClientResponse must RETAIN the pending
    // entry so connection teardown's abandonPendingForSession can retry the
    // cancel (otherwise the bridge mediator is stuck forever). Retention is
    // observable as a SECOND cancel attempt during teardown.
    const calls: unknown[] = [];
    bridge.respondToSessionPermission = ((
      _s: string,
      _r: string,
      resp: unknown,
    ) => {
      calls.push(resp);
      throw new Error('mediator unavailable'); // vote AND every cancel fail
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-d',
          sessionId: 'sess-1',
          toolCall: {},
          options: [{ optionId: 'allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 100));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const sess = await openStream(connId, 'sess-1');
    const reader = frameReader(sess);
    try {
      await new Promise((r) => setTimeout(r, 50));
      await post(connId, {
        jsonrpc: '2.0',
        id: 350,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'x' }] },
      });
      const reqFrame = (await reader.next()) as { id: string };
      // Vote → respondToSessionPermission throws → immediate cancel ALSO throws.
      await post(connId, {
        jsonrpc: '2.0',
        id: reqFrame.id,
        result: { outcome: { outcome: 'selected', optionId: 'allow' } },
      });
      await waitUntil(
        () =>
          calls.filter((c) => JSON.stringify(c).includes('cancelled')).length >=
          1,
      );
      // Teardown retries the cancel. This only happens if the entry was
      // retained after the immediate cancel failed.
      await fetch(`${base}/acp`, {
        method: 'DELETE',
        headers: { 'acp-connection-id': connId },
      });
      await waitUntil(() => {
        const cancels = calls.filter((c) =>
          JSON.stringify(c).includes('cancelled'),
        );
        return cancels.length >= 2 && calls.length >= 3;
      });
      const cancels = calls.filter((c) =>
        JSON.stringify(c).includes('cancelled'),
      );
      // 1 vote + ≥2 cancels (immediate fail + teardown retry). If the entry
      // were dropped unconditionally after the failed immediate cancel, there
      // would be exactly ONE cancel — so ≥2 is the retention invariant.
      expect(cancels.length).toBeGreaterThanOrEqual(2);
      expect(calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      reader.close();
    }
  });

  it('client error response to a permission request → cancellation', async () => {
    let resolvedWith: unknown;
    bridge.respondToSessionPermission = ((
      _s: string,
      _r: string,
      resp: unknown,
    ) => {
      resolvedWith = resp;
      return true;
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-e',
          sessionId: 'sess-1',
          toolCall: {},
          options: [{ optionId: 'allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 40));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const sess = await openStream(connId, 'sess-1');
    const got = takeFrames(sess, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 310,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'x' }] },
    });
    const [reqFrame] = (await got) as Array<{ id: string }>;
    // Client answers with a JSON-RPC ERROR (not result) → treated as cancel.
    await post(connId, {
      jsonrpc: '2.0',
      id: reqFrame.id,
      error: { code: -32000, message: 'user declined' },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(resolvedWith).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('DELETE without a connection id → 400', async () => {
    const res = await fetch(`${base}/acp`, { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('DELETE tears the connection down (subsequent POST 404)', async () => {
    const connId = await initialize();
    const del = await fetch(`${base}/acp`, {
      method: 'DELETE',
      headers: { 'acp-connection-id': connId },
    });
    expect(del.status).toBe(202);
    const after = await post(connId, {
      jsonrpc: '2.0',
      id: 12,
      method: 'session/new',
    });
    expect(after.status).toBe(404);
  });

  // ── Wave 1+2: new _qwen/* method tests ──────────────────────────

  describe('protocol compliance', () => {
    it('POST non-JSON Content-Type → 415', async () => {
      const res = await fetch(`${base}/acp`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      });
      expect(res.status).toBe(415);
    });

    it('POST batch JSON-RPC array → 501', async () => {
      const res = await fetch(`${base}/acp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'foo' }]),
      });
      expect(res.status).toBe(501);
    });

    it('GET without text/event-stream Accept → 406', async () => {
      const connId = await initialize();
      const res = await fetch(`${base}/acp`, {
        headers: {
          accept: 'application/json',
          'acp-connection-id': connId,
        },
      });
      expect(res.status).toBe(406);
    });

    it('POST missing Acp-Connection-Id → 400', async () => {
      const res = await fetch(`${base}/acp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'session/list',
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('session extension methods', () => {
    it('_qwen/session/recap returns recap', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 50,
        method: '_qwen/session/recap',
        params: { sessionId: 'sess-1' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        result: { sessionId: 'sess-1', recap: 'test recap' },
      });
    });

    it('_qwen/session/btw validates question length', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 51,
        method: '_qwen/session/btw',
        params: { sessionId: 'sess-1', question: '' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/session/btw returns answer', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 52,
        method: '_qwen/session/btw',
        params: { sessionId: 'sess-1', question: 'what?' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        result: { answer: 're: what?' },
      });
    });

    it('_qwen/session/shell returns stable disabled error by default', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 53,
        method: '_qwen/session/shell',
        params: { sessionId: 'sess-1', command: '' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({
        error: {
          code: -32602,
          data: { errorKind: 'session_shell_disabled' },
        },
      });
      expect(bridge.shellCalls).toHaveLength(0);
      expect(
        stdioMocks.writeStderrLine.mock.calls.some(([line]) =>
          line.includes('/acp session/shell session='),
        ),
      ).toBe(false);
      expect(
        stdioMocks.writeStderrLine.mock.calls.some(([line]) =>
          line.includes('/acp dispatch error'),
        ),
      ).toBe(false);
    });

    it('_qwen/session/shell rejects unowned session when enabled', async () => {
      await restartServer({ sessionShellCommandEnabled: true });
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 54,
        method: '_qwen/session/shell',
        params: { sessionId: 'sess-1', command: 'pwd' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
      expect(bridge.shellCalls).toHaveLength(0);
      expect(
        stdioMocks.writeStderrLine.mock.calls.some(([line]) =>
          line.includes('/acp session/shell session='),
        ),
      ).toBe(false);
    });

    it('_qwen/session/shell requires an owned bridge-stamped clientId when enabled', async () => {
      const nextBridge = new FakeBridge();
      nextBridge.spawnClientId = undefined;
      await restartServer({
        sessionShellCommandEnabled: true,
        nextBridge,
      });
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 55,
        method: '_qwen/session/shell',
        params: { sessionId: 'sess-1', command: 'pwd' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        error: {
          code: -32602,
          data: { errorKind: 'client_id_required' },
        },
      });
      expect(bridge.shellCalls).toHaveLength(0);
    });

    it('_qwen/session/shell rejects empty command when enabled', async () => {
      await restartServer({ sessionShellCommandEnabled: true });
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 56,
        method: '_qwen/session/shell',
        params: { sessionId: 'sess-1', command: '' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({ error: { code: -32602 } });
      expect(bridge.shellCalls).toHaveLength(0);
    });

    it('_qwen/session/shell returns result', async () => {
      await restartServer({ sessionShellCommandEnabled: true });
      const connId = await initialize();
      const streamRes = openStream(connId);
      const command = 'ls\nFAKE\r\x1b[31m';
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 57,
        method: '_qwen/session/shell',
        params: { sessionId: 'sess-1', command },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        result: { exitCode: 0, output: `$ ${command}` },
      });
      const shellLog = stdioMocks.writeStderrLine.mock.calls
        .map(([line]) => line)
        .find((line) => line.includes('session/shell'));
      expect(shellLog).toContain('cmd=ls FAKE  [31m');
      expect(shellLog).not.toContain('\n');
      expect(shellLog).not.toContain('\r');
      expect(shellLog).not.toContain('\x1b');
      expect(bridge.shellCalls).toEqual([
        {
          sessionId: 'sess-1',
          command,
          signal: expect.any(AbortSignal),
          context: { clientId: 'client-1', fromLoopback: true },
        },
      ]);
      expect(bridge.shellCalls[0]?.signal?.aborted).toBe(false);
    });

    it('_qwen/session/shell maps bridge shell policy errors to RPC errorKind', async () => {
      await restartServer({ sessionShellCommandEnabled: true });
      bridge.shellError = new SessionShellDisabledError();
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 58,
        method: '_qwen/session/shell',
        params: { sessionId: 'sess-1', command: 'pwd' },
      });
      const disabledFrames = await takeFrames(await streamRes, 2);
      expect(disabledFrames[1]).toMatchObject({
        error: {
          code: -32602,
          data: { errorKind: 'session_shell_disabled' },
        },
      });

      await restartServer({ sessionShellCommandEnabled: true });
      bridge.shellError = new SessionShellClientRequiredError();
      const connId2 = await initialize();
      const streamRes2 = openStream(connId2);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId2, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId2, {
        jsonrpc: '2.0',
        id: 59,
        method: '_qwen/session/shell',
        params: { sessionId: 'sess-1', command: 'pwd' },
      });
      const clientRequiredFrames = await takeFrames(await streamRes2, 2);
      expect(clientRequiredFrames[1]).toMatchObject({
        error: {
          code: -32602,
          data: { errorKind: 'client_id_required' },
        },
      });
    });

    it('_qwen/session/shell preserves InvalidClientIdError invalid params mapping', async () => {
      await restartServer({ sessionShellCommandEnabled: true });
      bridge.shellError = new InvalidClientIdError('sess-1', 'client-2');
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 60,
        method: '_qwen/session/shell',
        params: { sessionId: 'sess-1', command: 'pwd' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/session/shell does not map arbitrary error names as shell policy errors', async () => {
      await restartServer({ sessionShellCommandEnabled: true });
      bridge.shellError = Object.assign(new Error('fake policy'), {
        name: 'SessionShellDisabledError',
      });
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 61,
        method: '_qwen/session/shell',
        params: { sessionId: 'sess-1', command: 'pwd' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        error: {
          code: -32603,
          data: { errorKind: 'internal' },
        },
      });
    });

    it('_qwen/session/detach succeeds', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 55,
        method: '_qwen/session/detach',
        params: { sessionId: 'sess-1' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({ result: { ok: true } });
      expect(bridge.detached.length).toBeGreaterThan(0);
    });

    it('_qwen/session/context_usage returns usage', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 56,
        method: '_qwen/session/context_usage',
        params: { sessionId: 'sess-1' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        result: { sessionId: 'sess-1', used: 100 },
      });
    });

    it('_qwen/session/tasks returns tasks', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 57,
        method: '_qwen/session/tasks',
        params: { sessionId: 'sess-1' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        result: { sessionId: 'sess-1', tasks: [] },
      });
    });

    it('_qwen/session/lsp returns status', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 57,
        method: '_qwen/session/lsp',
        params: { sessionId: 'sess-1' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        result: {
          sessionId: 'sess-1',
          enabled: true,
          configuredServers: 1,
          readyServers: 1,
          servers: [{ name: 'typescript', status: 'READY' }],
        },
      });
    });

    it('_qwen/session/artifacts returns the session artifact snapshot', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 58,
        method: '_qwen/session/artifacts',
        params: { sessionId: 'sess-1' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        result: {
          v: 1,
          sessionId: 'sess-1',
          artifacts: [],
          limits: { maxArtifacts: 200 },
        },
      });
      expect(bridge.lastArtifactListSessionId).toBe('sess-1');
      expect(bridge.lastArtifactListContext).toEqual({
        clientId: 'client-1',
        fromLoopback: true,
      });
    });

    it('_qwen/session/artifacts/add forwards only public artifact fields', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 58,
        method: '_qwen/session/artifacts/add',
        params: {
          sessionId: 'sess-1',
          title: 'Lineage',
          kind: 'link',
          storage: 'external_url',
          url: 'https://example.test/lineage',
          metadata: { table: 'fact_orders' },
          retention: 'ephemeral',
          clientRetained: false,
          source: 'tool',
          trustedPublisher: true,
          clientId: 'forged-client',
          toolName: 'forged-tool',
          hookEventName: 'forged-hook',
        },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        result: { v: 1, sessionId: 'sess-1', changes: [] },
      });
      expect(bridge.lastAddedArtifact?.sessionId).toBe('sess-1');
      expect(bridge.lastAddedArtifact?.artifact).toMatchObject({
        title: 'Lineage',
        kind: 'link',
        storage: 'external_url',
        url: 'https://example.test/lineage',
        metadata: { table: 'fact_orders' },
        retention: 'ephemeral',
        clientRetained: false,
      });
      const artifact = bridge.lastAddedArtifact?.artifact as
        | Record<string, unknown>
        | undefined;
      expect(artifact).not.toHaveProperty('sessionId');
      expect(artifact).not.toHaveProperty('source');
      expect(artifact).not.toHaveProperty('trustedPublisher');
      expect(artifact).not.toHaveProperty('clientId');
      expect(artifact).not.toHaveProperty('toolName');
      expect(artifact).not.toHaveProperty('hookEventName');
      expect(bridge.lastAddedArtifact?.context).toEqual({
        clientId: 'client-1',
        fromLoopback: true,
      });
    });

    it('_qwen/session/artifacts/add maps artifact validation errors to invalid params', async () => {
      bridge.addSessionArtifact = async () => {
        throw new SessionArtifactValidationError(
          'url must use http or https',
          'url',
        );
      };
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 59,
        method: '_qwen/session/artifacts/add',
        params: {
          sessionId: 'sess-1',
          title: 'Bad URL',
          url: 'file:///tmp/report.html',
        },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        error: {
          code: -32602,
          data: { errorKind: 'artifact_validation_failed', field: 'url' },
        },
      });
    });

    it('_qwen/session/artifacts/remove forwards artifact id', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 59,
        method: '_qwen/session/artifacts/remove',
        params: {
          sessionId: 'sess-1',
          artifactId: 'artifact-1',
        },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        result: {
          v: 1,
          sessionId: 'sess-1',
          changes: [
            {
              action: 'removed',
              artifactId: 'artifact-1',
              reason: 'explicit',
            },
          ],
        },
      });
      expect(bridge.lastRemovedArtifact).toMatchObject({
        sessionId: 'sess-1',
        artifactId: 'artifact-1',
        context: {
          clientId: 'client-1',
          fromLoopback: true,
        },
      });
    });

    it('_qwen/session/artifacts/remove rejects missing artifact id', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 60,
        method: '_qwen/session/artifacts/remove',
        params: { sessionId: 'sess-1' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        error: {
          code: -32602,
          message: '`artifactId` is required',
        },
      });
      expect(bridge.lastRemovedArtifact).toBeUndefined();
    });

    it('_qwen/session/artifacts/remove maps artifact authorization errors', async () => {
      bridge.removeSessionArtifact = async () => {
        throw new SessionArtifactAuthorizationError(
          'sess-1',
          'artifact-1',
          'client-owner',
          'client-other',
        );
      };
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 61,
        method: '_qwen/session/artifacts/remove',
        params: { sessionId: 'sess-1', artifactId: 'artifact-1' },
      });

      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        error: {
          code: -32600,
          message: 'artifact artifact-1 is owned by a different client',
          data: {
            errorKind: 'artifact_forbidden',
            sessionId: 'sess-1',
            artifactId: 'artifact-1',
          },
        },
      });
    });

    it('_qwen/session/artifacts/add holds the archive gate while mutating', async () => {
      await withRuntimeDir(async () => {
        const sessionId = '550e8400-e29b-41d4-a716-446655440131';
        await writeStoredSession(sessionId);
        let addStarted!: () => void;
        let releaseAdd!: () => void;
        const addStartedPromise = new Promise<void>((resolve) => {
          addStarted = resolve;
        });
        const addReleasedPromise = new Promise<void>((resolve) => {
          releaseAdd = resolve;
        });
        bridge.addSessionArtifact = async (sessionId, artifact, context) => {
          bridge.lastAddedArtifact = { sessionId, artifact, context };
          addStarted();
          await addReleasedPromise;
          return { v: 1, sessionId, changes: [] };
        };

        const connId = await initialize();
        const stream = await openStream(connId);
        const reader = frameReader(stream);
        await post(connId, {
          jsonrpc: '2.0',
          id: 99,
          method: 'session/load',
          params: { sessionId },
        });
        expect(await reader.next()).toMatchObject({ id: 99 });

        await post(connId, {
          jsonrpc: '2.0',
          id: 60,
          method: '_qwen/session/artifacts/add',
          params: {
            sessionId,
            title: 'Lineage',
            url: 'https://example.test/lineage',
          },
        });
        await addStartedPromise;

        await post(connId, {
          jsonrpc: '2.0',
          id: 61,
          method: '_qwen/sessions/archive',
          params: { sessionIds: [sessionId] },
        });
        expect(await reader.next()).toMatchObject({
          id: 61,
          error: {
            code: -32603,
            data: { errorKind: 'session_archiving', sessionId },
          },
        });

        releaseAdd();
        expect(await reader.next()).toMatchObject({
          id: 60,
          result: { v: 1, sessionId, changes: [] },
        });
        reader.close();
      });
    });

    it('_qwen/session/artifacts/remove holds the archive gate while mutating', async () => {
      await withRuntimeDir(async () => {
        const sessionId = '550e8400-e29b-41d4-a716-446655440132';
        await writeStoredSession(sessionId);
        let removeStarted!: () => void;
        let releaseRemove!: () => void;
        const removeStartedPromise = new Promise<void>((resolve) => {
          removeStarted = resolve;
        });
        const removeReleasedPromise = new Promise<void>((resolve) => {
          releaseRemove = resolve;
        });
        bridge.removeSessionArtifact = async (
          sessionId,
          artifactId,
          context,
        ) => {
          bridge.lastRemovedArtifact = {
            sessionId,
            artifactId,
            context,
          };
          removeStarted();
          await removeReleasedPromise;
          return {
            v: 1,
            sessionId,
            changes: [{ action: 'removed', artifactId, reason: 'explicit' }],
          };
        };

        const connId = await initialize();
        const stream = await openStream(connId);
        const reader = frameReader(stream);
        await post(connId, {
          jsonrpc: '2.0',
          id: 99,
          method: 'session/load',
          params: { sessionId },
        });
        expect(await reader.next()).toMatchObject({ id: 99 });

        await post(connId, {
          jsonrpc: '2.0',
          id: 62,
          method: '_qwen/session/artifacts/remove',
          params: { sessionId, artifactId: 'artifact-1' },
        });
        await removeStartedPromise;

        await post(connId, {
          jsonrpc: '2.0',
          id: 63,
          method: '_qwen/sessions/archive',
          params: { sessionIds: [sessionId] },
        });
        expect(await reader.next()).toMatchObject({
          id: 63,
          error: {
            code: -32603,
            data: { errorKind: 'session_archiving', sessionId },
          },
        });

        releaseRemove();
        expect(await reader.next()).toMatchObject({
          id: 62,
          result: {
            v: 1,
            sessionId,
            changes: [
              {
                action: 'removed',
                artifactId: 'artifact-1',
                reason: 'explicit',
              },
            ],
          },
        });
        reader.close();
      });
    });

    it('session methods reject unowned session', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 58,
        method: '_qwen/session/recap',
        params: { sessionId: 'unknown-session' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });
  });

  describe('workspace methods', () => {
    it('_qwen/workspace/tools returns tools', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 60,
        method: '_qwen/workspace/tools',
        params: {},
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ result: { v: 1, tools: [] } });
    });

    it('session organization methods persist groups and organized list state', async () => {
      await withRuntimeDir(async () => {
        const sessionId = '550e8400-e29b-41d4-a716-446655440010';
        await writeStoredSession(sessionId);
        const connId = await initialize();
        const streamRes = openStream(connId);
        await new Promise((r) => setTimeout(r, 30));
        const reader = frameReader(await streamRes);

        await post(connId, {
          jsonrpc: '2.0',
          id: 70,
          method: '_qwen/workspace/session_groups/create',
          params: {
            workspaceCwd: '/ws',
            name: 'Frontend',
            color: '#12ABEF',
          },
        });
        const createFrame = (await reader.next()) as {
          result: { group: { id: string; name: string; color: string } };
        };
        const group = createFrame.result.group;
        expect(group).toMatchObject({
          name: 'Frontend',
          color: '#12abef',
        });

        await post(connId, {
          jsonrpc: '2.0',
          id: 71,
          method: '_qwen/session/update_organization',
          params: {
            sessionId,
            isPinned: true,
            groupId: group.id,
          },
        });
        expect(await reader.next()).toMatchObject({
          result: {
            sessionId,
            isPinned: true,
            groupId: group.id,
          },
        });

        await post(connId, {
          jsonrpc: '2.0',
          id: 72,
          method: 'session/list',
          params: {
            workspaceCwd: '/ws',
            view: 'organized',
            group: group.id,
            _meta: { size: 20 },
          },
        });
        expect(await reader.next()).toMatchObject({
          result: {
            sessions: [
              {
                sessionId,
                isPinned: true,
                groupId: group.id,
              },
            ],
          },
        });

        await post(connId, {
          jsonrpc: '2.0',
          id: 73,
          method: '_qwen/workspace/session_groups/delete',
          params: { workspaceCwd: '/ws', groupId: group.id },
        });
        expect(await reader.next()).toMatchObject({
          result: { deleted: true },
        });

        await post(connId, {
          jsonrpc: '2.0',
          id: 74,
          method: 'session/list',
          params: {
            workspaceCwd: '/ws',
            view: 'organized',
            group: 'ungrouped',
            _meta: { size: 20 },
          },
        });
        expect(await reader.next()).toMatchObject({
          result: {
            sessions: [
              {
                sessionId,
                isPinned: true,
                groupId: null,
              },
            ],
          },
        });
        reader.close();
      });
    });

    it('_qwen/session/update_organization assigns a color echoed by session/list', async () => {
      await withRuntimeDir(async () => {
        const sessionId = '550e8400-e29b-41d4-a716-446655440011';
        await writeStoredSession(sessionId);
        const connId = await initialize();
        const streamRes = openStream(connId);
        await new Promise((r) => setTimeout(r, 30));
        const reader = frameReader(await streamRes);

        await post(connId, {
          jsonrpc: '2.0',
          id: 80,
          method: '_qwen/session/update_organization',
          params: { sessionId, color: 'purple' },
        });
        expect(await reader.next()).toMatchObject({
          result: { sessionId, color: 'purple', groupId: null },
        });

        await post(connId, {
          jsonrpc: '2.0',
          id: 81,
          method: 'session/list',
          params: {
            workspaceCwd: '/ws',
            view: 'organized',
            group: 'all',
            _meta: { size: 20 },
          },
        });
        expect(await reader.next()).toMatchObject({
          result: {
            sessions: [{ sessionId, color: 'purple', groupId: null }],
          },
        });
        reader.close();
      });
    });

    it('session/list group=ungrouped excludes color-tagged sessions', async () => {
      await withRuntimeDir(async () => {
        const sessionId = '550e8400-e29b-41d4-a716-446655440012';
        await writeStoredSession(sessionId);
        const connId = await initialize();
        const streamRes = openStream(connId);
        await new Promise((r) => setTimeout(r, 30));
        const reader = frameReader(await streamRes);

        // Tag the session with a color and no named group.
        await post(connId, {
          jsonrpc: '2.0',
          id: 82,
          method: '_qwen/session/update_organization',
          params: { sessionId, color: 'red' },
        });
        expect(await reader.next()).toMatchObject({
          result: { sessionId, color: 'red', groupId: null },
        });

        // A color tag is its own sidebar bucket, so the session is not
        // "ungrouped" even though it belongs to no named group. The server
        // filter must agree with that taxonomy for REST/ACP consumers.
        await post(connId, {
          jsonrpc: '2.0',
          id: 83,
          method: 'session/list',
          params: {
            workspaceCwd: '/ws',
            view: 'organized',
            group: 'ungrouped',
            _meta: { size: 20 },
          },
        });
        expect(await reader.next()).toMatchObject({
          result: { sessions: [] },
        });
        reader.close();
      });
    });

    it('session/list group=<id> excludes sessions that also carry a color tag', async () => {
      await withRuntimeDir(async () => {
        const sessionId = '550e8400-e29b-41d4-a716-446655440013';
        await writeStoredSession(sessionId);
        const connId = await initialize();
        const streamRes = openStream(connId);
        await new Promise((r) => setTimeout(r, 30));
        const reader = frameReader(await streamRes);

        await post(connId, {
          jsonrpc: '2.0',
          id: 84,
          method: '_qwen/workspace/session_groups/create',
          params: { workspaceCwd: '/ws', name: 'Frontend', color: 'blue' },
        });
        const createFrame = (await reader.next()) as {
          result: { group: { id: string } };
        };
        const groupId = createFrame.result.group.id;

        // An SDK/API consumer can set both groupId and color in one update —
        // the core store keeps both. The sidebar gives color precedence, so the
        // named-group filter must not surface this session under the group.
        await post(connId, {
          jsonrpc: '2.0',
          id: 85,
          method: '_qwen/session/update_organization',
          params: { sessionId, groupId, color: 'red' },
        });
        expect(await reader.next()).toMatchObject({
          result: { sessionId, groupId, color: 'red' },
        });

        await post(connId, {
          jsonrpc: '2.0',
          id: 86,
          method: 'session/list',
          params: {
            workspaceCwd: '/ws',
            view: 'organized',
            group: groupId,
            _meta: { size: 20 },
          },
        });
        expect(await reader.next()).toMatchObject({
          result: { sessions: [] },
        });
        reader.close();
      });
    });

    it('session/list rejects group filter without organized view', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 75,
        method: 'session/list',
        params: {
          workspaceCwd: '/ws',
          group: 'pinned',
        },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({
        id: 75,
        error: {
          code: -32602,
          message: '`group` requires `view` to be "organized"',
        },
      });
    });

    it('session/list rejects an empty parentSessionId', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 76,
        method: 'session/list',
        params: {
          workspaceCwd: '/ws',
          parentSessionId: '',
        },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({
        id: 76,
        error: {
          code: -32602,
          message: '`parentSessionId` must be a non-empty string',
        },
      });
    });

    it('session/list rejects parentSessionId with the organized view', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 77,
        method: 'session/list',
        params: {
          workspaceCwd: '/ws',
          view: 'organized',
          parentSessionId: 'parent-1',
        },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({
        id: 77,
        error: {
          code: -32602,
          message: '`parentSessionId` is not supported with `view` "organized"',
        },
      });
    });

    it('session/list?parentSessionId returns only that parent’s children, each tagged with parentSessionId', async () => {
      await withRuntimeDir(async () => {
        const parentId = '550e8400-e29b-41d4-a716-446655440020';
        const otherParentId = '550e8400-e29b-41d4-a716-446655440021';
        const childOfParent = '550e8400-e29b-41d4-a716-446655440022';
        const childOfOther = '550e8400-e29b-41d4-a716-446655440023';
        await writeStoredSession(parentId);
        await writeStoredSession(childOfParent, 'active', parentId);
        await writeStoredSession(childOfOther, 'active', otherParentId);

        const connId = await initialize();
        const streamRes = openStream(connId);
        await new Promise((r) => setTimeout(r, 30));
        await post(connId, {
          jsonrpc: '2.0',
          id: 78,
          method: 'session/list',
          params: {
            workspaceCwd: '/ws',
            parentSessionId: parentId,
            _meta: { size: 20 },
          },
        });
        const frames = (await takeFrames(await streamRes, 1)) as Array<{
          id: number;
          result: {
            sessions: Array<{ sessionId: string; parentSessionId?: string }>;
          };
        }>;
        expect(frames[0].id).toBe(78);
        const sessions = frames[0].result.sessions;
        // Only the child of the requested parent surfaces — not the parent
        // itself and not the sibling under a different parent.
        expect(sessions.map((s) => s.sessionId)).toEqual([childOfParent]);
        expect(sessions[0]!.parentSessionId).toBe(parentId);
      });
    });

    it.each([
      {
        params: { isPinned: true },
        message: '`sessionId` is required',
      },
      {
        params: { sessionId: 'session-1', isPinned: 'yes' },
        message: '`isPinned` must be a boolean',
      },
      {
        params: { sessionId: 'session-1', groupId: 1 },
        message: '`groupId` must be a string or null',
      },
      {
        params: { sessionId: 'session-1', color: 'pink' },
        message: '`color` must be a supported color or null',
      },
    ])(
      '_qwen/session/update_organization rejects invalid params: $message',
      async ({ params, message }) => {
        const connId = await initialize();
        const streamRes = openStream(connId);
        await new Promise((r) => setTimeout(r, 30));
        await post(connId, {
          jsonrpc: '2.0',
          id: 76,
          method: '_qwen/session/update_organization',
          params,
        });
        const frames = await takeFrames(await streamRes, 1);
        expect(frames[0]).toMatchObject({
          id: 76,
          error: {
            code: -32602,
            message,
          },
        });
      },
    );

    it('_qwen/workspace/mcp/tools rejects missing serverName', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 61,
        method: '_qwen/workspace/mcp/tools',
        params: {},
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/workspace/mcp/tools returns tools', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 62,
        method: '_qwen/workspace/mcp/tools',
        params: { serverName: 'fs' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({
        result: { serverName: 'fs', tools: [] },
      });
    });

    it('_qwen/workspace/mcp/resources rejects missing serverName', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 64,
        method: '_qwen/workspace/mcp/resources',
        params: {},
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/workspace/mcp/resources returns resources', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 65,
        method: '_qwen/workspace/mcp/resources',
        params: { serverName: 'fs' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({
        result: { serverName: 'fs', resources: [] },
      });
    });

    it('_qwen/workspace/mcp/servers/add rejects missing name', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 63,
        method: '_qwen/workspace/mcp/servers/add',
        params: { config: {} },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/workspace/mcp/servers/remove rejects missing name', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 64,
        method: '_qwen/workspace/mcp/servers/remove',
        params: {},
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/sessions/delete rejects non-array', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 65,
        method: '_qwen/sessions/delete',
        params: { sessionIds: 'not-array' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/sessions/delete rejects >100 ids', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      const ids = Array.from({ length: 101 }, (_, i) => `s${i}`);
      await post(connId, {
        jsonrpc: '2.0',
        id: 66,
        method: '_qwen/sessions/delete',
        params: { sessionIds: ids },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/sessions/delete sanitizes stderr close errors', async () => {
      const lineSep = '\u2028';
      const bidiOverride = '\u202e';
      bridge.closeError = new Error(
        `close\nFAILED\r\x1b[31m${lineSep}${bidiOverride}`,
      );
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 67,
        method: '_qwen/sessions/delete',
        params: { sessionIds: [`sess${lineSep}FAKE\r\x1b[31m`] },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({
        result: { removed: [], notFound: [] },
      });
      const deleteLog = stdioMocks.writeStderrLine.mock.calls
        .map(([line]) => line)
        .find((line) => line.includes('sessions/delete'));
      expect(deleteLog).toContain(
        'closeSession(sess FAK) failed: close FAILED  [31m',
      );
      expect(deleteLog).not.toContain('\n');
      expect(deleteLog).not.toContain('\r');
      expect(deleteLog).not.toContain('\x1b');
      expect(deleteLog).not.toContain(lineSep);
      expect(deleteLog).not.toContain(bidiOverride);
    });

    it('_qwen/sessions/delete sanitizes stderr remove errors', async () => {
      const lineSep = '\u2028';
      const bidiOverride = '\u202e';
      const sessionId = `sess${lineSep}FAKE\r\x1b[31m`;
      const removeError = `remove\nFAILED\r\x1b[31m${lineSep}${bidiOverride}`;
      const removeSessionSpy = vi
        .spyOn(SessionService.prototype, 'removeSession')
        .mockRejectedValueOnce(new Error(removeError));

      try {
        const connId = await initialize();
        const streamRes = openStream(connId);
        await new Promise((r) => setTimeout(r, 30));
        await post(connId, {
          jsonrpc: '2.0',
          id: 68,
          method: '_qwen/sessions/delete',
          params: { sessionIds: [sessionId] },
        });
        const frames = await takeFrames(await streamRes, 1);
        expect(frames[0]).toMatchObject({
          result: {
            removed: [],
            notFound: [],
            errors: [{ sessionId, error: removeError }],
          },
        });
        expect(removeSessionSpy).toHaveBeenCalledWith(sessionId);

        const deleteLog = stdioMocks.writeStderrLine.mock.calls
          .map(([line]) => line)
          .find((line) => line.includes('sessions/delete'));
        expect(deleteLog).toContain(
          'removeSession(sess FAK) failed: remove FAILED  [31m',
        );
        expect(deleteLog).not.toContain('\n');
        expect(deleteLog).not.toContain('\r');
        expect(deleteLog).not.toContain('\x1b');
        expect(deleteLog).not.toContain(lineSep);
        expect(deleteLog).not.toContain(bidiOverride);
      } finally {
        removeSessionSpy.mockRestore();
      }
    });

    it('_qwen/sessions/delete deletes available ids when another id is loading', async () => {
      await withRuntimeDir(async () => {
        const sidOk = '550e8400-e29b-41d4-a716-446655440128';
        const sidBusy = '550e8400-e29b-41d4-a716-446655440129';
        await writeStoredSession(sidOk);
        await writeStoredSession(sidBusy);
        let loadStarted!: () => void;
        let releaseLoad!: () => void;
        const loadStartedPromise = new Promise<void>((resolve) => {
          loadStarted = resolve;
        });
        const loadReleasedPromise = new Promise<void>((resolve) => {
          releaseLoad = resolve;
        });
        bridge.loadSession = async (req) => {
          if (req.sessionId === sidBusy) {
            loadStarted();
            await loadReleasedPromise;
          }
          return {
            sessionId: req.sessionId,
            workspaceCwd: '/ws',
            attached: true,
            clientId: 'client-load',
            state: { replayed: true },
          };
        };

        const connId = await initialize();
        const stream = await openStream(connId);
        const reader = frameReader(stream);
        await post(connId, {
          jsonrpc: '2.0',
          id: 70,
          method: 'session/load',
          params: { sessionId: sidBusy },
        });
        await loadStartedPromise;

        await post(connId, {
          jsonrpc: '2.0',
          id: 71,
          method: '_qwen/sessions/delete',
          params: { sessionIds: [sidOk, sidBusy] },
        });
        expect(await reader.next()).toMatchObject({
          id: 71,
          result: {
            removed: [sidOk],
            notFound: [],
            errors: [expect.objectContaining({ sessionId: sidBusy })],
          },
        });
        expect(bridge.closedSessions).toEqual([sidOk]);

        releaseLoad();
        expect(await reader.next()).toMatchObject({
          id: 70,
          result: { replayed: true },
        });
        reader.close();
      });
    });

    it('_qwen/sessions/delete does not make missing archive ids wait on live close', async () => {
      const sessionId = 'delete-archive-race';
      let firstCloseStarted!: () => void;
      let releaseFirstClose!: () => void;
      let secondCloseStarted!: () => void;
      const firstCloseStartedPromise = new Promise<void>((resolve) => {
        firstCloseStarted = resolve;
      });
      const firstCloseReleasedPromise = new Promise<void>((resolve) => {
        releaseFirstClose = resolve;
      });
      const secondCloseStartedPromise = new Promise<void>((resolve) => {
        secondCloseStarted = resolve;
      });
      let closeCount = 0;
      bridge.closeSession = async (sid: string) => {
        bridge.closedSessions.push(sid);
        closeCount++;
        if (closeCount === 1) {
          firstCloseStarted();
          await firstCloseReleasedPromise;
        } else {
          secondCloseStarted();
        }
      };
      const connId = await initialize();
      const stream = await openStream(connId);
      const reader = frameReader(stream);
      const deletePost = post(connId, {
        jsonrpc: '2.0',
        id: 69,
        method: '_qwen/sessions/delete',
        params: { sessionIds: [sessionId] },
      });
      await deletePost;
      await firstCloseStartedPromise;

      const archivePost = post(connId, {
        jsonrpc: '2.0',
        id: 70,
        method: '_qwen/sessions/archive',
        params: { sessionIds: [sessionId] },
      });
      await archivePost;
      const raceResult = await Promise.race([
        secondCloseStartedPromise.then(() => 'archive-started'),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 25)),
      ]);

      releaseFirstClose();
      try {
        expect(raceResult).toBe('blocked');
        const frames = [await reader.next(), await reader.next()];
        expect(frames).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: 69,
              result: expect.objectContaining({ notFound: [sessionId] }),
            }),
            expect.objectContaining({
              id: 70,
              result: expect.objectContaining({ notFound: [sessionId] }),
            }),
          ]),
        );
      } finally {
        reader.close();
      }
    });

    it('_qwen/sessions/delete returns session_archiving during archive gate', async () => {
      await withRuntimeDir(async () => {
        const sessionId = '550e8400-e29b-41d4-a716-446655440132';
        await writeStoredSession(sessionId);
        let closeStarted!: () => void;
        let releaseClose!: () => void;
        const closeStartedPromise = new Promise<void>((resolve) => {
          closeStarted = resolve;
        });
        const closeReleasedPromise = new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
        bridge.closeSession = async (sid: string) => {
          bridge.closedSessions.push(sid);
          closeStarted();
          await closeReleasedPromise;
        };
        const connId = await initialize();
        const stream = await openStream(connId);
        const reader = frameReader(stream);
        await post(connId, {
          jsonrpc: '2.0',
          id: 72,
          method: '_qwen/sessions/archive',
          params: { sessionIds: [sessionId] },
        });
        await closeStartedPromise;

        await post(connId, {
          jsonrpc: '2.0',
          id: 73,
          method: '_qwen/sessions/delete',
          params: { sessionIds: [sessionId] },
        });
        expect(await reader.next()).toMatchObject({
          id: 73,
          error: {
            data: { errorKind: 'session_archiving', sessionId },
          },
        });

        releaseClose();
        try {
          expect(await reader.next()).toMatchObject({
            id: 72,
            result: expect.objectContaining({ archived: [sessionId] }),
          });
        } finally {
          reader.close();
        }
      });
    });
  });

  describe('auth methods', () => {
    it('_qwen/workspace/auth/status returns empty when no registry', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 70,
        method: '_qwen/workspace/auth/status',
        params: {},
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({
        result: { pendingDeviceFlows: [] },
      });
    });

    it('_qwen/workspace/auth/device_flow/start rejects without registry', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 71,
        method: '_qwen/workspace/auth/device_flow/start',
        params: { providerId: 'test' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32603 } });
    });
  });

  describe('memory methods', () => {
    it('_qwen/workspace/memory/remember queues and polls hidden tasks', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      const reader = frameReader(await streamRes);
      try {
        await post(connId, {
          jsonrpc: '2.0',
          id: 79,
          method: '_qwen/workspace/memory/remember',
          params: { content: 'remember this', contextMode: 'clean' },
        });
        const queued = (await reader.next()) as {
          result: { taskId: string; status: string; contextMode: string };
        };
        expect(queued.result).toMatchObject({
          status: 'queued',
          contextMode: 'clean',
        });

        await new Promise((resolve) => setTimeout(resolve, 30));
        await post(connId, {
          jsonrpc: '2.0',
          id: 80,
          method: '_qwen/workspace/memory/remember/get',
          params: { taskId: queued.result.taskId },
        });
        const completed = (await reader.next()) as {
          result: { status: string; result: { summary: string } };
        };
        expect(completed.result).toMatchObject({
          status: 'completed',
          result: { summary: 'No memory files updated.' },
        });
      } finally {
        reader.close();
      }
    });

    it('_qwen/workspace/memory/forget queues and polls hidden tasks', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      const reader = frameReader(await streamRes);
      try {
        await post(connId, {
          jsonrpc: '2.0',
          id: 82,
          method: '_qwen/workspace/memory/forget',
          params: { query: 'old preference' },
        });
        const queued = (await reader.next()) as {
          result: { taskId: string; status: string };
        };
        expect(queued.result).toMatchObject({
          status: 'queued',
        });

        await new Promise((resolve) => setTimeout(resolve, 30));
        await post(connId, {
          jsonrpc: '2.0',
          id: 83,
          method: '_qwen/workspace/memory/forget/get',
          params: { taskId: queued.result.taskId },
        });
        const completed = (await reader.next()) as {
          result: { status: string; result: { summary: string } };
        };
        expect(completed.result).toMatchObject({
          status: 'completed',
          result: { summary: 'forgot' },
        });
      } finally {
        reader.close();
      }
    });

    it('_qwen/workspace/memory/forget rejects oversized queries', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      const reader = frameReader(await streamRes);
      try {
        await post(connId, {
          jsonrpc: '2.0',
          id: 85,
          method: '_qwen/workspace/memory/forget',
          params: { query: 'x'.repeat(64 * 1024 + 1) },
        });
        const frame = (await reader.next()) as {
          error: { code: number; message: string };
        };
        expect(frame.error.code).toBe(-32602);
        expect(frame.error.message).toContain('`query` exceeds');
      } finally {
        reader.close();
      }
    });

    it('_qwen/workspace/memory/dream queues and polls hidden tasks', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      const reader = frameReader(await streamRes);
      try {
        await post(connId, {
          jsonrpc: '2.0',
          id: 84,
          method: '_qwen/workspace/memory/dream',
          params: {},
        });
        const queued = (await reader.next()) as {
          result: { taskId: string; status: string };
        };
        expect(queued.result).toMatchObject({
          status: 'queued',
        });

        await new Promise((resolve) => setTimeout(resolve, 30));
        await post(connId, {
          jsonrpc: '2.0',
          id: 85,
          method: '_qwen/workspace/memory/dream/get',
          params: { taskId: queued.result.taskId },
        });
        const completed = (await reader.next()) as {
          result: { status: string; result: { summary: string } };
        };
        expect(completed.result).toMatchObject({
          status: 'completed',
          result: { summary: 'dreamed' },
        });
      } finally {
        reader.close();
      }
    });

    it('shares remember task state between REST and ACP transports', async () => {
      const connId = await initialize();
      const clientId = clientIdForConnection(connId);
      bridge.knownClientIdSet.add(clientId);

      const streamRes = openStream(connId);
      const reader = frameReader(await streamRes);
      try {
        const restRes = await fetch(`${base}/workspace/memory/remember`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-qwen-client-id': clientId,
          },
          body: JSON.stringify({
            content: 'remember via rest',
            contextMode: 'workspace',
          }),
        });
        expect(restRes.status).toBe(202);
        const restTask = (await restRes.json()) as {
          taskId: string;
          status: string;
        };
        expect(restTask.status).toBe('queued');

        await new Promise((resolve) => setTimeout(resolve, 30));
        await post(connId, {
          jsonrpc: '2.0',
          id: 81,
          method: '_qwen/workspace/memory/remember/get',
          params: { taskId: restTask.taskId },
        });
        let completed:
          | {
              result: {
                taskId: string;
                status: string;
                result: { summary: string };
              };
            }
          | undefined;
        for (let i = 0; i < 3; i++) {
          const frame = (await reader.next()) as {
            id?: number;
            result?: {
              taskId: string;
              status: string;
              result: { summary: string };
            };
          };
          if (frame.id === 81) {
            completed = frame as typeof completed;
            break;
          }
        }
        expect(completed).toBeDefined();
        expect(completed!.result).toMatchObject({
          taskId: restTask.taskId,
          status: 'completed',
          result: { summary: 'No memory files updated.' },
        });
      } finally {
        reader.close();
      }
    });

    it('_qwen/workspace/memory/write rejects non-string content', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 80,
        method: '_qwen/workspace/memory/write',
        params: { content: 123 },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/workspace/memory/write rejects invalid scope', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 81,
        method: '_qwen/workspace/memory/write',
        params: { content: 'hi', scope: 'invalid' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/workspace/memory/write rejects invalid mode', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 82,
        method: '_qwen/workspace/memory/write',
        params: { content: 'hi', mode: 'invalid' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });
  });

  describe('file methods', () => {
    it('_qwen/file/read rejects without fsFactory (503-equivalent)', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 90,
        method: '_qwen/file/read',
        params: { path: 'test.txt' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32603 } });
    });

    it('_qwen/file/read rejects missing path', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 91,
        method: '_qwen/file/read',
        params: {},
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/file/read forwards valid window parameters', async () => {
      const readText = vi.fn(async () => ({
        content: 'hello',
        meta: { truncated: false },
      }));
      await restartServer({
        fsFactory: makeFileFsFactory({ readText }),
      });
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 92,
        method: '_qwen/file/read',
        params: { path: 'test.txt', maxBytes: 10, line: 2, limit: 1 },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({
        result: { path: 'test.txt', content: 'hello', truncated: false },
      });
      expect(readText).toHaveBeenCalledWith(resolvedPath('/ws/test.txt'), {
        maxBytes: 10,
        line: 2,
        limit: 1,
      });
    });

    it('_qwen/file/read preserves defaults when window parameters are omitted', async () => {
      const readText = vi.fn(async () => ({
        content: 'hello',
        meta: { truncated: false },
      }));
      await restartServer({
        fsFactory: makeFileFsFactory({ readText }),
      });
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 92,
        method: '_qwen/file/read',
        params: { path: 'test.txt' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({
        result: { path: 'test.txt', content: 'hello', truncated: false },
      });
      expect(readText).toHaveBeenCalledWith(resolvedPath('/ws/test.txt'), {
        maxBytes: undefined,
        line: undefined,
        limit: undefined,
      });
    });

    it.each([
      { maxBytes: 0 },
      { maxBytes: MAX_READ_BYTES + 1 },
      { maxBytes: 1.5 },
      { maxBytes: '1' },
      { maxBytes: null },
      { line: 0 },
      { line: Number.MAX_SAFE_INTEGER + 1 },
      { line: 1.5 },
      { line: '2' },
      { line: null },
      { limit: 0 },
      { limit: 2001 },
      { limit: 1.5 },
      { limit: '1' },
      { limit: null },
    ])('_qwen/file/read rejects invalid window params (%j)', async (params) => {
      const readText = vi.fn(async () => ({
        content: 'hello',
        meta: { truncated: false },
      }));
      await restartServer({
        fsFactory: makeFileFsFactory({ readText }),
      });
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 92,
        method: '_qwen/file/read',
        params: { path: 'test.txt', ...params },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
      expect(readText).not.toHaveBeenCalled();
    });

    it('_qwen/file/read_bytes forwards valid window parameters', async () => {
      const readBytesWindow = vi.fn(async () => ({
        buffer: Buffer.from('ell'),
        offset: 1,
        sizeBytes: 5,
        returnedBytes: 3,
        truncated: true,
      }));
      await restartServer({
        fsFactory: makeFileFsFactory({ readBytesWindow }),
      });
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 93,
        method: '_qwen/file/read_bytes',
        params: { path: 'test.txt', offset: 1, maxBytes: 3 },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({
        result: {
          path: 'test.txt',
          offset: 1,
          sizeBytes: 5,
          returnedBytes: 3,
          truncated: true,
        },
      });
      expect(readBytesWindow).toHaveBeenCalledWith(
        resolvedPath('/ws/test.txt'),
        { offset: 1, maxBytes: 3 },
      );
    });

    it('_qwen/file/read_bytes preserves defaults when window parameters are omitted', async () => {
      const readBytesWindow = vi.fn(async () => ({
        buffer: Buffer.from('hello'),
        offset: 0,
        sizeBytes: 5,
        returnedBytes: 5,
        truncated: false,
      }));
      await restartServer({
        fsFactory: makeFileFsFactory({ readBytesWindow }),
      });
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 93,
        method: '_qwen/file/read_bytes',
        params: { path: 'test.txt' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({
        result: {
          path: 'test.txt',
          offset: 0,
          sizeBytes: 5,
          returnedBytes: 5,
          truncated: false,
        },
      });
      expect(readBytesWindow).toHaveBeenCalledWith(
        resolvedPath('/ws/test.txt'),
        { offset: undefined, maxBytes: undefined },
      );
    });

    it.each([
      { offset: -1 },
      { offset: Number.MAX_SAFE_INTEGER + 1 },
      { offset: 1.5 },
      { offset: '1' },
      { offset: null },
      { maxBytes: 0 },
      { maxBytes: MAX_READ_BYTES + 1 },
      { maxBytes: 1.5 },
      { maxBytes: '1' },
      { maxBytes: null },
    ])(
      '_qwen/file/read_bytes rejects invalid window params (%j)',
      async (params) => {
        const readBytesWindow = vi.fn(async () => ({
          buffer: Buffer.from('hello'),
          offset: 0,
          sizeBytes: 5,
          returnedBytes: 5,
          truncated: false,
        }));
        await restartServer({
          fsFactory: makeFileFsFactory({ readBytesWindow }),
        });
        const connId = await initialize();
        const streamRes = openStream(connId);
        await new Promise((r) => setTimeout(r, 30));
        await post(connId, {
          jsonrpc: '2.0',
          id: 93,
          method: '_qwen/file/read_bytes',
          params: { path: 'test.txt', ...params },
        });
        const frames = await takeFrames(await streamRes, 1);
        expect(frames[0]).toMatchObject({ error: { code: -32602 } });
        expect(readBytesWindow).not.toHaveBeenCalled();
      },
    );

    it('_qwen/file/write rejects missing content', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 92,
        method: '_qwen/file/write',
        params: { path: 'test.txt' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/file/edit rejects missing oldText/newText', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 93,
        method: '_qwen/file/edit',
        params: { path: 'test.txt' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/file/glob rejects missing pattern', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 94,
        method: '_qwen/file/glob',
        params: {},
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/file/glob honors a valid maxResults limit', async () => {
      const glob = vi.fn(async () => [
        resolvedPath('a'),
        resolvedPath('b'),
        resolvedPath('c'),
      ]);
      await restartServer({ fsFactory: makeGlobFsFactory(glob) });
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 95,
        method: '_qwen/file/glob',
        params: { pattern: '**/*', maxResults: 2 },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({
        result: {
          pattern: '**/*',
          matches: ['a', 'b'],
          truncated: true,
        },
      });
      expect(glob).toHaveBeenCalledWith('**/*', { maxResults: 3 });
    });

    it('_qwen/file/glob defaults maxResults when omitted', async () => {
      const glob = vi.fn(async () => []);
      await restartServer({ fsFactory: makeGlobFsFactory(glob) });
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 95,
        method: '_qwen/file/glob',
        params: { pattern: '**/*' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({
        result: {
          pattern: '**/*',
          matches: [],
          truncated: false,
        },
      });
      expect(glob).toHaveBeenCalledWith('**/*', { maxResults: 5001 });
    });

    it.each([0, -1, 1.5, 50_001, '2', null])(
      '_qwen/file/glob rejects invalid maxResults (%s)',
      async (maxResults) => {
        const glob = vi.fn(async () => []);
        await restartServer({ fsFactory: makeGlobFsFactory(glob) });
        const connId = await initialize();
        const streamRes = openStream(connId);
        await new Promise((r) => setTimeout(r, 30));
        await post(connId, {
          jsonrpc: '2.0',
          id: 95,
          method: '_qwen/file/glob',
          params: { pattern: '**/*', maxResults },
        });
        const frames = await takeFrames(await streamRes, 1);
        expect(frames[0]).toMatchObject({ error: { code: -32602 } });
        expect(glob).not.toHaveBeenCalled();
      },
    );
  });
});

// ── WebSocket transport security tests ────────────────────────────────
describe('ACP WebSocket transport security', () => {
  let server: Server;
  let port: number;
  let bridge: FakeBridge;
  let previousCdpMcpCommand: string | undefined;

  beforeEach(() => {
    previousCdpMcpCommand = process.env['QWEN_CDP_MCP_COMMAND'];
  });

  async function yieldImmediate(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  function startServer(
    opts: {
      token?: string;
      allowedOrigins?: { allowAny: boolean; origins: Set<string> };
      checkRate?: (key: string, tier: string) => boolean;
      cdpTunnelOverWs?: boolean;
      daemonEnv?: Readonly<NodeJS.ProcessEnv>;
    } = {},
  ) {
    return new Promise<void>((resolve) => {
      bridge = new FakeBridge();
      const app = express();
      app.use(express.json());
      const handle = mountAcpHttp(app, bridge as unknown as HttpAcpBridge, {
        boundWorkspace: '/ws',
        workspace: fakeWorkspace,
        enabled: true,
        daemonEnv: opts.daemonEnv,
        token: opts.token,
        allowedOrigins: opts.allowedOrigins,
        workspaceRememberLane: new WorkspaceRememberTaskLane(
          bridge as unknown as HttpAcpBridge,
        ),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        checkRate: opts.checkRate as any,
        ...(opts.cdpTunnelOverWs
          ? {
              cdpTunnelOverWs: true,
              cdpTunnelRegistry: new CdpTunnelRegistry(),
            }
          : {}),
      });
      const listeningServer = app.listen(0, '127.0.0.1', () => {
        port = (listeningServer.address() as AddressInfo).port;
        handle?.attachServer(listeningServer);
        resolve();
      });
      server = listeningServer;
    });
  }

  afterEach(async () => {
    server?.closeAllConnections?.();
    await new Promise<void>((r) => server?.close(() => r()) ?? r());
    if (previousCdpMcpCommand === undefined) {
      delete process.env['QWEN_CDP_MCP_COMMAND'];
    } else {
      process.env['QWEN_CDP_MCP_COMMAND'] = previousCdpMcpCommand;
    }
  });

  function enableCdpMcpCommand() {
    process.env['QWEN_CDP_MCP_COMMAND'] = process.execPath;
  }

  function wsConnect(
    opts: { headers?: Record<string, string> } = {},
  ): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`, {
        headers: opts.headers,
      });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  function wsConnectRaw(
    host: string,
    origin?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ code: number }> {
    return new Promise((resolve) => {
      const headers: Record<string, string> = { ...extraHeaders };
      if (origin) headers['Origin'] = origin;
      const ws = new WebSocket(`ws://${host}:${port}/acp`, {
        headers,
        handshakeTimeout: 2000,
      });
      ws.once('open', () => {
        ws.close();
        resolve({ code: 101 });
      });
      ws.once('unexpected-response', (_req, res) => {
        resolve({ code: res.statusCode ?? 0 });
      });
      ws.once('error', () => resolve({ code: 0 }));
    });
  }

  function sendRpc(ws: WebSocket, msg: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      ws.send(JSON.stringify(msg));
    });
  }

  function initializeCdpBridge(ws: WebSocket, id = 1): Promise<unknown> {
    return sendRpc(ws, {
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        clientInfo: { name: 'qwen-cdp-bridge', version: '1.0.0' },
      },
    });
  }

  // ── Host allowlist ──────────────────────────────────────────────────
  it('accepts WS upgrade with loopback Host header', async () => {
    await startServer();
    const result = await wsConnectRaw('127.0.0.1', undefined);
    // The Host header will be 127.0.0.1:PORT which is in the allowlist
    expect(result.code).toBe(101);
  });

  // ── CSWSH origin check ─────────────────────────────────────────────
  it('rejects WS upgrade with cross-origin Origin header', async () => {
    await startServer();
    const result = await wsConnectRaw('127.0.0.1', 'https://evil.com');
    expect(result.code).toBe(403);
  });

  it("rejects cross-origin WS upgrade even when allow-origin '*' is configured", async () => {
    await startServer({
      token: 'secret-token-123',
      allowedOrigins: { allowAny: true, origins: new Set() },
    });
    const result = await wsConnectRaw('127.0.0.1', 'https://evil.com', {
      Authorization: 'Bearer secret-token-123',
    });
    expect(result.code).toBe(403);
  });

  it('allows WS upgrade from an explicitly allowlisted extension origin', async () => {
    await startServer({
      token: 'secret-token-123',
      allowedOrigins: {
        allowAny: false,
        origins: new Set(['chrome-extension://abcdefghijklmnop']),
      },
    });
    const result = await wsConnectRaw(
      '127.0.0.1',
      'chrome-extension://abcdefghijklmnop',
      { Authorization: 'Bearer secret-token-123' },
    );
    expect(result.code).toBe(101);
  });

  it('does not register chrome-devtools MCP without an explicit CDP MCP command', async () => {
    delete process.env['QWEN_CDP_MCP_COMMAND'];
    stdioMocks.writeStderrLine.mockClear();
    await startServer({ cdpTunnelOverWs: true });
    const ws = await wsConnect();
    await initializeCdpBridge(ws);

    await yieldImmediate();
    expect(bridge.runtimeMcpAdds).toHaveLength(0);
    expect(bridge.runtimeMcpRemoves).toHaveLength(0);
    expect(stdioMocks.writeStderrLine).toHaveBeenCalledWith(
      'qwen serve: set QWEN_CDP_MCP_COMMAND to enable browser automation MCP (no adapter is bundled)',
    );

    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
  });

  it('treats a whitespace-only CDP MCP command as unset', async () => {
    process.env['QWEN_CDP_MCP_COMMAND'] = '   ';
    stdioMocks.writeStderrLine.mockClear();
    await startServer({ cdpTunnelOverWs: true });
    const ws = await wsConnect();
    await initializeCdpBridge(ws);

    await yieldImmediate();
    expect(bridge.runtimeMcpAdds).toHaveLength(0);
    expect(stdioMocks.writeStderrLine).toHaveBeenCalledWith(
      'qwen serve: set QWEN_CDP_MCP_COMMAND to enable browser automation MCP (no adapter is bundled)',
    );

    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
  });

  it('dynamically registers chrome-devtools MCP for an active CDP bridge', async () => {
    enableCdpMcpCommand();
    await startServer({ cdpTunnelOverWs: true });
    const ws = await wsConnect();
    await initializeCdpBridge(ws);

    await vi.waitFor(() => expect(bridge.runtimeMcpAdds).toHaveLength(1));
    expect(bridge.runtimeMcpAdds[0]).toMatchObject({
      name: 'chrome-devtools',
      originatorClientId: expect.any(String),
    });
    expect(bridge.runtimeMcpAdds[0]?.config).toMatchObject({
      command: process.execPath,
      args: expect.arrayContaining([
        '--wsEndpoint',
        `ws://127.0.0.1:${port}/cdp`,
      ]),
    });

    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
    await vi.waitFor(() => expect(bridge.runtimeMcpRemoves).toHaveLength(1));
    expect(bridge.runtimeMcpRemoves[0]).toMatchObject({
      name: 'chrome-devtools',
      originatorClientId: bridge.runtimeMcpAdds[0]?.originatorClientId,
    });
  });

  it('passes a custom CDP MCP command through to the runtime config', async () => {
    process.env['QWEN_CDP_MCP_COMMAND'] = '/opt/process/cdp-adapter';
    await startServer({
      cdpTunnelOverWs: true,
      daemonEnv: { QWEN_CDP_MCP_COMMAND: '/opt/custom/cdp-adapter' },
    });
    const ws = await wsConnect();
    await initializeCdpBridge(ws);

    await vi.waitFor(() => expect(bridge.runtimeMcpAdds).toHaveLength(1));
    expect(bridge.runtimeMcpAdds[0]?.config).toMatchObject({
      command: '/opt/custom/cdp-adapter',
    });

    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
  });

  it('keeps chrome-devtools MCP registered while a replacement CDP bridge is active', async () => {
    enableCdpMcpCommand();
    await startServer({ cdpTunnelOverWs: true });
    const first = await wsConnect();
    await initializeCdpBridge(first, 1);
    await vi.waitFor(() => expect(bridge.runtimeMcpAdds).toHaveLength(1));

    const second = await wsConnect();
    await initializeCdpBridge(second, 2);

    first.close();
    await new Promise<void>((resolve) => first.once('close', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(bridge.runtimeMcpRemoves).toHaveLength(0);

    second.close();
    await new Promise<void>((resolve) => second.once('close', () => resolve()));
    await vi.waitFor(() => expect(bridge.runtimeMcpRemoves).toHaveLength(1));
    expect(bridge.runtimeMcpRemoves[0]).toMatchObject({
      name: 'chrome-devtools',
      originatorClientId: expect.any(String),
    });
  });

  it('removes chrome-devtools MCP when settings already define it', async () => {
    enableCdpMcpCommand();
    stdioMocks.writeStderrLine.mockClear();
    await startServer({ cdpTunnelOverWs: true });
    bridge.runtimeMcpAddResult = { shadowedSettings: true };
    const ws = await wsConnect();
    await initializeCdpBridge(ws);

    await vi.waitFor(() => expect(bridge.runtimeMcpRemoves).toHaveLength(1));
    expect(bridge.runtimeMcpRemoves[0]).toMatchObject({
      name: 'chrome-devtools',
      originatorClientId: bridge.runtimeMcpAdds[0]?.originatorClientId,
    });
    expect(stdioMocks.writeStderrLine).toHaveBeenCalledWith(
      'qwen serve: chrome-devtools runtime MCP skipped because settings already define it',
    );
    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
  });

  it('retries chrome-devtools MCP registration after a skipped result', async () => {
    enableCdpMcpCommand();
    stdioMocks.writeStderrLine.mockClear();
    await startServer({ cdpTunnelOverWs: true });
    bridge.runtimeMcpAddResult = {
      skipped: true,
      reason: 'budget_exceeded',
    };

    const first = await wsConnect();
    await initializeCdpBridge(first, 1);

    await vi.waitFor(() => expect(bridge.runtimeMcpAdds).toHaveLength(1));
    expect(bridge.runtimeMcpRemoves).toHaveLength(0);
    expect(stdioMocks.writeStderrLine).toHaveBeenCalledWith(
      'qwen serve: chrome-devtools runtime MCP skipped: budget_exceeded',
    );

    bridge.runtimeMcpAddResult = {};
    const second = await wsConnect();
    await initializeCdpBridge(second, 2);

    await vi.waitFor(() => expect(bridge.runtimeMcpAdds).toHaveLength(2));
    second.close();
    await new Promise<void>((resolve) => second.once('close', () => resolve()));
    await vi.waitFor(() => expect(bridge.runtimeMcpRemoves).toHaveLength(1));
    first.close();
    await new Promise<void>((resolve) => first.once('close', () => resolve()));
  });

  it('removes chrome-devtools MCP if the CDP bridge disconnects during registration', async () => {
    enableCdpMcpCommand();
    await startServer({ cdpTunnelOverWs: true });
    let releaseAdd: (() => void) | undefined;
    bridge.runtimeMcpBeforeAddResolve = () =>
      new Promise<void>((resolve) => {
        releaseAdd = resolve;
      });

    const ws = await wsConnect();
    await initializeCdpBridge(ws);
    await vi.waitFor(() => expect(bridge.runtimeMcpAdds).toHaveLength(1));
    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
    releaseAdd?.();

    await vi.waitFor(() => expect(bridge.runtimeMcpRemoves).toHaveLength(1));
    expect(bridge.runtimeMcpRemoves[0]).toMatchObject({
      name: 'chrome-devtools',
      originatorClientId: bridge.runtimeMcpAdds[0]?.originatorClientId,
    });
  });

  it('retries chrome-devtools MCP registration after add failure', async () => {
    enableCdpMcpCommand();
    stdioMocks.writeStderrLine.mockClear();
    await startServer({ cdpTunnelOverWs: true });
    bridge.runtimeMcpAddError = new Error('add failed');
    const first = await wsConnect();
    await initializeCdpBridge(first, 1);

    await vi.waitFor(() => {
      expect(stdioMocks.writeStderrLine).toHaveBeenCalledWith(
        'qwen serve: failed to add chrome-devtools runtime MCP: add failed',
      );
    });

    bridge.runtimeMcpAddError = undefined;
    const second = await wsConnect();
    await initializeCdpBridge(second, 2);

    await vi.waitFor(() => expect(bridge.runtimeMcpAdds).toHaveLength(2));
    second.close();
    await new Promise<void>((resolve) => second.once('close', () => resolve()));
    await vi.waitFor(() => expect(bridge.runtimeMcpRemoves).toHaveLength(1));
    first.close();
    await new Promise<void>((resolve) => first.once('close', () => resolve()));
  });

  it('retries chrome-devtools MCP registration while the ACP channel is unavailable', async () => {
    enableCdpMcpCommand();
    stdioMocks.writeStderrLine.mockClear();
    await startServer({ cdpTunnelOverWs: true });
    bridge.runtimeMcpAddError = Object.assign(new Error('no channel'), {
      data: { errorKind: 'acp_channel_unavailable' },
    });

    const ws = await wsConnect();
    await initializeCdpBridge(ws);

    await vi.waitFor(() => expect(bridge.runtimeMcpAdds).toHaveLength(2), {
      timeout: 1_500,
    });
    bridge.runtimeMcpAddError = undefined;

    await vi.waitFor(() => expect(bridge.runtimeMcpAdds).toHaveLength(3), {
      timeout: 1_500,
    });
    expect(stdioMocks.writeStderrLine).not.toHaveBeenCalledWith(
      expect.stringContaining('failed to add chrome-devtools runtime MCP'),
    );

    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
    await vi.waitFor(() => expect(bridge.runtimeMcpRemoves).toHaveLength(1));
  });

  it('stops retrying chrome-devtools MCP registration after ACP channel retry exhaustion', async () => {
    enableCdpMcpCommand();
    stdioMocks.writeStderrLine.mockClear();
    await startServer({ cdpTunnelOverWs: true });
    bridge.runtimeMcpAddError = Object.assign(new Error('no channel'), {
      data: { errorKind: 'acp_channel_unavailable' },
    });

    const ws = await wsConnect();
    await initializeCdpBridge(ws);

    await vi.waitFor(
      () => {
        expect(stdioMocks.writeStderrLine).toHaveBeenCalledWith(
          'qwen serve: failed to add chrome-devtools runtime MCP: no channel',
        );
      },
      { timeout: 7_000 },
    );
    expect(bridge.runtimeMcpAdds).toHaveLength(21);

    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
  }, 10_000);

  it('skips chrome-devtools MCP registration when /cdp requires auth', async () => {
    enableCdpMcpCommand();
    stdioMocks.writeStderrLine.mockClear();
    await startServer({
      cdpTunnelOverWs: true,
      token: 'secret-token-123',
    });
    const ws = await wsConnect({
      headers: { Authorization: 'Bearer secret-token-123' },
    });
    await initializeCdpBridge(ws);

    expect(bridge.runtimeMcpAdds).toHaveLength(0);
    expect(stdioMocks.writeStderrLine).toHaveBeenCalledWith(
      'qwen serve: chrome-devtools runtime MCP skipped because /cdp requires bearer auth',
    );
    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
  });

  it('rejects WS upgrade with a loopback Origin header on a different port', async () => {
    await startServer();
    const result = await wsConnectRaw('127.0.0.1', 'http://localhost:3000');
    expect(result.code).toBe(403);
  });

  it('allows WS upgrade with a loopback Origin header on the daemon port', async () => {
    await startServer();
    const result = await wsConnectRaw('127.0.0.1', `http://localhost:${port}`);
    expect(result.code).toBe(101);
  });

  // ── Bearer token auth ──────────────────────────────────────────────
  it('rejects WS upgrade without token when token is configured', async () => {
    await startServer({ token: 'secret-token-123' });
    const result = await wsConnectRaw('127.0.0.1');
    expect(result.code).toBe(401);
  });

  it('rejects WS upgrade with wrong token', async () => {
    await startServer({ token: 'secret-token-123' });
    const result = await new Promise<{ code: number }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`, {
        headers: { Authorization: 'Bearer wrong-token' },
        handshakeTimeout: 2000,
      });
      ws.once('open', () => {
        ws.close();
        resolve({ code: 101 });
      });
      ws.once('unexpected-response', (_req, res) =>
        resolve({ code: res.statusCode ?? 0 }),
      );
      ws.once('error', () => resolve({ code: 0 }));
    });
    expect(result.code).toBe(401);
  });

  it('allows WS upgrade with correct token', async () => {
    await startServer({ token: 'secret-token-123' });
    const ws = await wsConnect({
      headers: { Authorization: 'Bearer secret-token-123' },
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  // ── Bearer token via Sec-WebSocket-Protocol (browser clients) ──────
  // Browsers can't set an Authorization header on a WebSocket, so the token
  // rides in a `qwen-bearer.<base64url(token)>` subprotocol that the upgrade
  // listener decodes (extractUpgradeBearer). Matches the web-shell encoder.
  function bearerProto(token: string): string {
    return `qwen-bearer.${Buffer.from(token).toString('base64url')}`;
  }
  // Non-secret marker the web-shell offers alongside the bearer subprotocol so
  // the daemon can select it (never the secret) and the handshake completes.
  const WS_AUTH_SUBPROTOCOL = 'qwen-ws';

  function wsConnectWithSubprotocols(
    protocols: string[],
  ): Promise<{ code: number; protocol: string }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`, protocols, {
        handshakeTimeout: 2000,
      });
      ws.once('open', () => {
        const { protocol } = ws;
        ws.close();
        resolve({ code: 101, protocol });
      });
      ws.once('unexpected-response', (_req, res) =>
        resolve({ code: res.statusCode ?? 0, protocol: '' }),
      );
      ws.once('error', () => resolve({ code: 0, protocol: '' }));
    });
  }

  it('accepts WS upgrade with a valid token in the subprotocol', async () => {
    await startServer({ token: 'secret-token-123' });
    const result = await wsConnectWithSubprotocols([
      WS_AUTH_SUBPROTOCOL,
      bearerProto('secret-token-123'),
    ]);
    expect(result.code).toBe(101);
  });

  it('falls back to bearer subprotocol when Authorization bearer is empty', async () => {
    await startServer({ token: 'secret-token-123' });
    const result = await new Promise<{ code: number }>((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/acp`,
        [WS_AUTH_SUBPROTOCOL, bearerProto('secret-token-123')],
        {
          headers: { Authorization: 'Bearer ' },
          handshakeTimeout: 2000,
        },
      );
      ws.once('open', () => {
        ws.close();
        resolve({ code: 101 });
      });
      ws.once('unexpected-response', (_req, res) =>
        resolve({ code: res.statusCode ?? 0 }),
      );
      ws.once('error', () => resolve({ code: 0 }));
    });
    expect(result.code).toBe(101);
  });

  it('never echoes the secret subprotocol back in the handshake', async () => {
    await startServer({ token: 'secret-token-123' });
    const result = await wsConnectWithSubprotocols([
      WS_AUTH_SUBPROTOCOL,
      bearerProto('secret-token-123'),
    ]);
    expect(result.code).toBe(101);
    // The daemon selects the non-secret marker, never the bearer value.
    expect(result.protocol).toBe(WS_AUTH_SUBPROTOCOL);
    expect(result.protocol).not.toContain('qwen-bearer.');
  });

  it('selects a non-secret subprotocol, never the bearer one', async () => {
    await startServer({ token: 'secret-token-123' });
    const result = await wsConnectWithSubprotocols([
      'acp.v1',
      bearerProto('secret-token-123'),
    ]);
    expect(result.code).toBe(101);
    expect(result.protocol).toBe('acp.v1');
  });

  it('rejects WS upgrade with a wrong token in the subprotocol', async () => {
    await startServer({ token: 'secret-token-123' });
    const result = await wsConnectWithSubprotocols([
      WS_AUTH_SUBPROTOCOL,
      bearerProto('wrong-token'),
    ]);
    expect(result.code).toBe(401);
  });

  it('rejects WS upgrade with a malformed bearer subprotocol', async () => {
    await startServer({ token: 'secret-token-123' });
    // `----` is a valid subprotocol token but decodes to garbage bytes (not the
    // token) — exercises the non-throwing decode + constant-time mismatch path.
    const result = await wsConnectWithSubprotocols([
      WS_AUTH_SUBPROTOCOL,
      'qwen-bearer.----',
    ]);
    expect(result.code).toBe(401);
  });

  it('ignores the subprotocol on a no-token loopback daemon', async () => {
    await startServer();
    const result = await wsConnectWithSubprotocols([
      WS_AUTH_SUBPROTOCOL,
      bearerProto('anything'),
    ]);
    expect(result.code).toBe(101);
  });

  // ── maxPayload ─────────────────────────────────────────────────────
  it('closes WS on oversized frame (>10MB)', async () => {
    await startServer();
    const ws = await wsConnect();
    const closed = new Promise<number>((resolve) => {
      ws.once('close', (code) => resolve(code));
      ws.once('error', () => {});
    });
    try {
      ws.send('x'.repeat(10 * 1024 * 1024 + 1));
    } catch {
      // ws may throw synchronously for oversized payloads
    }
    const code = await closed;
    expect(code).toBe(1009); // 1009 = message too big
  });

  // ── Initialize timeout ─────────────────────────────────────────────
  it('requires initialize as first message', async () => {
    await startServer();
    const ws = await wsConnect();
    const reply = await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: {},
    });
    expect(reply).toMatchObject({ error: { code: -32600 } });
    ws.close();
  });

  // ── Message serialization ──────────────────────────────────────────
  it('serializes concurrent WS messages (no race)', async () => {
    await startServer();
    const ws = await wsConnect();
    // Initialize first
    const initReply = await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    expect(initReply).toMatchObject({ result: { protocolVersion: 1 } });
    // Send two messages rapidly — both should succeed without race
    const replies: unknown[] = [];
    const done = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        replies.push(JSON.parse(data.toString()));
        if (replies.length >= 2) resolve();
      });
    });
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: {},
      }),
    );
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/list',
        params: {},
      }),
    );
    await done;
    const ids = replies.map((r) => (r as { id: number }).id).sort();
    expect(ids).toEqual([2, 3]);
    ws.close();
  });

  // ── Rate limiter ───────────────────────────────────────────────────
  it('enforces rate limits on WS messages', async () => {
    let callCount = 0;
    await startServer({
      checkRate: () => {
        callCount++;
        return callCount <= 2;
      },
    });
    const ws = await wsConnect();
    await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    // First two post-init messages should pass
    const r1 = await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/list',
      params: {},
    });
    expect(r1).toMatchObject({ id: 2 });
    const r2 = await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/list',
      params: {},
    });
    expect(r2).toMatchObject({ id: 3 });
    // Third should be rate-limited
    const r3 = await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 4,
      method: 'session/list',
      params: {},
    });
    expect(r3).toMatchObject({ error: { message: 'Rate limit exceeded' } });
    ws.close();
  });

  it('classifies _qwen/workspace/trust as a WS read method', async () => {
    const tiers: string[] = [];
    await startServer({
      checkRate: (_key, tier) => {
        tiers.push(tier);
        return true;
      },
    });
    const ws = await wsConnect();
    await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    const res = await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 2,
      method: '_qwen/workspace/trust',
      params: {},
    });

    expect(res).toMatchObject({ id: 2, result: { v: 1 } });
    expect(tiers).toEqual(['read']);
    ws.close();
  });

  it('classifies _qwen/workspace/trust/request as a WS mutation method', async () => {
    const tiers: string[] = [];
    await startServer({
      checkRate: (_key, tier) => {
        tiers.push(tier);
        return true;
      },
    });
    const ws = await wsConnect();
    await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    const res = await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 2,
      method: '_qwen/workspace/trust/request',
      params: { desiredState: 'untrusted' },
    });

    expect(res).toMatchObject({
      id: 2,
      result: { accepted: true, desiredState: 'untrusted' },
    });
    expect(tiers).toEqual(['mutation']);
    ws.close();
  });

  it('classifies _qwen/workspace/permissions as a WS read method', async () => {
    const tiers: string[] = [];
    await startServer({
      checkRate: (_key, tier) => {
        tiers.push(tier);
        return true;
      },
    });
    const ws = await wsConnect();
    await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    const res = await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 2,
      method: '_qwen/workspace/permissions',
      params: {},
    });

    expect(res).toMatchObject({ id: 2, result: { v: 1 } });
    expect(tiers).toEqual(['read']);
    ws.close();
  });

  it('classifies _qwen/workspace/permissions/set as a WS mutation method', async () => {
    const tiers: string[] = [];
    await startServer({
      checkRate: (_key, tier) => {
        tiers.push(tier);
        return true;
      },
    });
    const ws = await wsConnect();
    await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    const res = await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 2,
      method: '_qwen/workspace/permissions/set',
      params: {
        scope: 'workspace',
        ruleType: 'deny',
        rules: ['Read(.env)'],
      },
    });

    expect(res).toMatchObject({
      id: 2,
      result: { merged: { deny: ['Read(.env)'] } },
    });
    expect(tiers).toEqual(['mutation']);
    ws.close();
  });

  it('classifies _qwen/workspace/voice as a WS read method', async () => {
    const tiers: string[] = [];
    await startServer({
      checkRate: (_key, tier) => {
        tiers.push(tier);
        return true;
      },
    });
    const ws = await wsConnect();
    await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    const res = await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 2,
      method: '_qwen/workspace/voice',
      params: {},
    });

    expect(res).toMatchObject({ id: 2, result: { v: 1 } });
    expect(tiers).toEqual(['read']);
    ws.close();
  });

  it('classifies _qwen/workspace/voice/set as a WS mutation method', async () => {
    const tiers: string[] = [];
    await startServer({
      checkRate: (_key, tier) => {
        tiers.push(tier);
        return true;
      },
    });
    const ws = await wsConnect();
    await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    const res = await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 2,
      method: '_qwen/workspace/voice/set',
      params: { enabled: false },
    });

    expect(res).toMatchObject({
      id: 2,
      result: { enabled: false },
    });
    expect(tiers).toEqual(['mutation']);
    ws.close();
  });

  it('classifies _qwen/workspace/setup-github as a WS mutation method', async () => {
    const tiers: string[] = [];
    await startServer({
      checkRate: (_key, tier) => {
        tiers.push(tier);
        return true;
      },
    });
    const ws = await wsConnect();
    await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 2,
      method: '_qwen/workspace/setup-github',
      params: { consent: true },
    });

    expect(tiers).toEqual(['mutation']);
    ws.close();
  });
});
