/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Storage } from '@qwen-code/qwen-code-core';
import {
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
import { createSessionOrganizationService } from './session-organization-helpers.js';

const PRIMARY_CWD = path.resolve(path.sep, 'work', 'primary');
const SECONDARY_CWD = path.resolve(path.sep, 'work', 'secondary');
const UNKNOWN_CWD = path.resolve(path.sep, 'work', 'unknown');

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
}): Promise<void> {
  const chatsDir = path.join(new Storage(input.cwd).getProjectDir(), 'chats');
  await fsp.mkdir(chatsDir, { recursive: true });
  const filePath = path.join(chatsDir, `${input.sessionId}.jsonl`);
  const record = {
    uuid: `${input.sessionId}-user-1`,
    parentUuid: null,
    sessionId: input.sessionId,
    timestamp: input.timestamp,
    type: 'user',
    message: { role: 'user', parts: [{ text: input.prompt }] },
    cwd: input.cwd,
  };
  await fsp.writeFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  await fsp.utimes(filePath, input.mtime, input.mtime);
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

function makeBridge(
  workspaceCwd: string,
  summaries: BridgeSessionSummary[] = [],
  options: { channelLive?: boolean } = {},
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
    get sessionCount() {
      return live.size;
    },
    get activePromptCount() {
      return 0;
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
          eventRingSize: 8000,
          compactedReplayMaxBytes: 4 * 1024 * 1024,
          channelIdleTimeoutMs: 0,
          sessionIdleTimeoutMs: 1_800_000,
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
        attached: false,
        clientId: `client-${spawnCalls.length}`,
      };
    },
    async loadSession(req: BridgeRestoreSessionRequest) {
      restoreCalls.push({ action: 'load', req });
      return {
        sessionId: req.sessionId,
        workspaceCwd: req.workspaceCwd,
        attached: false,
        clientId: 'restore-client',
      };
    },
    async resumeSession(req: BridgeRestoreSessionRequest) {
      restoreCalls.push({ action: 'resume', req });
      return {
        sessionId: req.sessionId,
        workspaceCwd: req.workspaceCwd,
        attached: false,
        clientId: 'restore-client',
      };
    },
    listWorkspaceSessions(cwd: string) {
      listCalls.push(cwd);
      return [...live.values()].filter(
        (summary) => summary.workspaceCwd === cwd,
      );
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
    sendPrompt(
      sessionId: string,
      _req: unknown,
      _signal?: AbortSignal,
      context?: BridgeClientRequestContext,
    ) {
      promptCalls.push({ sessionId, ...(context ? { context } : {}) });
      return Promise.resolve({ stopReason: 'end_turn' });
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
  primary: boolean;
  trusted: boolean;
  bridge: AcpSessionBridge;
}): WorkspaceRuntime {
  return {
    ...input,
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
    flush: vi.fn(async () => {}),
  };
}

function makeHarness(opts?: {
  primaryTrusted?: boolean;
  secondaryTrusted?: boolean;
  secondaryChannelLive?: boolean;
  daemonLog?: DaemonLogger;
  secondarySummaries?: BridgeSessionSummary[];
}) {
  const primaryBridge = makeBridge(
    PRIMARY_CWD,
    [makeSummary('primary-session', PRIMARY_CWD)],
    { channelLive: true },
  );
  const secondaryBridge = makeBridge(
    SECONDARY_CWD,
    opts?.secondarySummaries ?? [
      makeSummary('secondary-session', SECONDARY_CWD),
    ],
    { channelLive: opts?.secondaryChannelLive ?? true },
  );
  const registry = createWorkspaceRegistry([
    makeRuntime({
      workspaceId: 'primary-id',
      workspaceCwd: PRIMARY_CWD,
      primary: true,
      trusted: opts?.primaryTrusted ?? true,
      bridge: primaryBridge,
    }),
    makeRuntime({
      workspaceId: 'secondary-id',
      workspaceCwd: SECONDARY_CWD,
      primary: false,
      trusted: opts?.secondaryTrusted ?? true,
      bridge: secondaryBridge,
    }),
  ]);
  const app = createServeApp(
    { ...baseOpts, workspace: PRIMARY_CWD },
    undefined,
    {
      workspaceRegistry: registry,
      ...(opts?.daemonLog ? { daemonLog: opts.daemonLog } : {}),
    },
  );
  return { app, registry, primaryBridge, secondaryBridge };
}

function host() {
  return `127.0.0.1:${baseOpts.port}`;
}

describe('multi-workspace session dispatch', () => {
  it('advertises workspaces and multi_workspace_sessions only when multiple runtimes are registered', async () => {
    const { app } = makeHarness();
    const res = await request(app).get('/capabilities').set('Host', host());

    expect(res.status).toBe(200);
    expect(res.body.workspaceCwd).toBe(PRIMARY_CWD);
    expect(res.body.features).toContain('multi_workspace_sessions');
    expect(res.body.workspaces).toEqual([
      { id: 'primary-id', cwd: PRIMARY_CWD, primary: true, trusted: true },
      {
        id: 'secondary-id',
        cwd: SECONDARY_CWD,
        primary: false,
        trusted: true,
      },
    ]);
    expect(res.body.limits.maxSessionsPerWorkspace).toBe(20);
    expect(res.body.limits.maxTotalSessions).toBeNull();
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
    ).toEqual(['primary-session', 'secondary-session']);
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
      .get('/session/secondary-session/status')
      .set('Host', host());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('untrusted_workspace');
    expect(res.body.error).toBe('Workspace is not trusted.');
    expect(res.body.sessionId).toBe('secondary-session');
    expect(res.body.workspaceCwd).toBe(SECONDARY_CWD);
    expect(res.body.workspaceId).toBe('secondary-id');
    expect(secondaryBridge.promptCalls).toEqual([]);
  });

  it('dispatches live session routes by owner runtime', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness();

    await request(app)
      .post('/session/secondary-session/prompt')
      .set('Host', host())
      .set('X-Qwen-Client-Id', 'client-2')
      .send({ prompt: [{ type: 'text', text: 'hello' }] })
      .expect(202);
    expect(primaryBridge.promptCalls).toEqual([]);
    expect(secondaryBridge.promptCalls).toMatchObject([
      { sessionId: 'secondary-session', context: { clientId: 'client-2' } },
    ]);

    const status = await request(app)
      .get('/session/secondary-session/status')
      .set('Host', host())
      .expect(200);
    expect(status.body.workspaceCwd).toBe(SECONDARY_CWD);

    await request(app)
      .post('/session/secondary-session/cancel')
      .set('Host', host())
      .send({})
      .expect(204);
    await request(app)
      .post('/session/secondary-session/heartbeat')
      .set('Host', host())
      .send({})
      .expect(200);
    await request(app)
      .post('/session/secondary-session/detach')
      .set('Host', host())
      .send({})
      .expect(204);

    expect(secondaryBridge.cancelCalls).toEqual(['secondary-session']);
    expect(secondaryBridge.heartbeatCalls).toEqual(['secondary-session']);
    expect(secondaryBridge.detachCalls).toEqual(['secondary-session']);
  });

  it('dispatches secondary events, permissions, pending prompts, and close', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness();

    await request(app)
      .get('/session/secondary-session/events?snapshot=1&maxQueued=16')
      .set('Host', host())
      .expect(200);
    expect(primaryBridge.eventsCalls).toEqual([]);
    expect(secondaryBridge.eventsCalls).toEqual([
      expect.objectContaining({ sessionId: 'secondary-session' }),
    ]);

    await request(app)
      .post('/session/secondary-session/permission/perm-1')
      .set('Host', host())
      .set('X-Qwen-Client-Id', 'client-2')
      .send({ outcome: { outcome: 'cancelled' } })
      .expect(200);
    expect(primaryBridge.permissionCalls).toEqual([]);
    expect(secondaryBridge.permissionCalls).toEqual([
      expect.objectContaining({
        sessionId: 'secondary-session',
        requestId: 'perm-1',
      }),
    ]);

    const pending = await request(app)
      .get('/session/secondary-session/pending-prompts')
      .set('Host', host())
      .set('X-Qwen-Client-Id', 'client-2')
      .expect(200);
    expect(pending.body.pendingPrompts).toEqual([
      expect.objectContaining({ promptId: 'prompt-1' }),
    ]);

    await request(app)
      .delete('/session/secondary-session/pending-prompts/prompt-1')
      .set('Host', host())
      .set('X-Qwen-Client-Id', 'client-2')
      .expect(200);
    expect(primaryBridge.pendingPromptCalls).toEqual([]);
    expect(primaryBridge.removePendingPromptCalls).toEqual([]);
    expect(secondaryBridge.pendingPromptCalls).toEqual(['secondary-session']);
    expect(secondaryBridge.removePendingPromptCalls).toEqual([
      { sessionId: 'secondary-session', promptId: 'prompt-1' },
    ]);

    await request(app)
      .delete('/session/secondary-session')
      .set('Host', host())
      .set('X-Qwen-Client-Id', 'client-2')
      .expect(204);
    expect(primaryBridge.closeCalls).toEqual([]);
    expect(secondaryBridge.closeCalls).toEqual(['secondary-session']);
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
        .post(`/session/secondary-session/${action}`)
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
          sessionId: 'secondary-session',
          workspaceCwd: SECONDARY_CWD,
        }),
      },
      {
        action: 'resume',
        req: expect.objectContaining({
          sessionId: 'secondary-session',
          workspaceCwd: SECONDARY_CWD,
        }),
      },
    ]);
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

  it('returns a clear Phase 2a error for non-primary sessions on primary-only routes', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness();

    const res = await request(app)
      .post('/session/secondary-session/branch')
      .set('Host', host())
      .send({ name: 'next' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('non_primary_session_route_not_supported');
    expect(res.body.workspaceCwd).toBe(SECONDARY_CWD);
    expect(primaryBridge.restoreCalls).toEqual([]);
    expect(secondaryBridge.restoreCalls).toEqual([]);
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

  it('rejects archived and organized non-primary session lists for untrusted workspaces', async () => {
    const { app } = makeHarness({ secondaryTrusted: false });

    const archived = await request(app)
      .get('/workspaces/secondary-id/sessions?archiveState=archived')
      .set('Host', host());
    expect(archived.status).toBe(403);
    expect(archived.body.code).toBe('untrusted_workspace');

    const organized = await request(app)
      .get('/workspaces/secondary-id/sessions?view=organized')
      .set('Host', host());
    expect(organized.status).toBe(403);
    expect(organized.body.code).toBe('untrusted_workspace');
  });

  it('returns workspace_mismatch for unknown absolute workspace session lists', async () => {
    const { app } = makeHarness();

    const unknown = await request(app)
      .get(`/workspace/${encodeURIComponent(UNKNOWN_CWD)}/sessions`)
      .set('Host', host());
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('workspace_mismatch');
    expect(unknown.body.workspaceCount).toBe(2);
    expect(unknown.body.boundWorkspace).toBe(PRIMARY_CWD);
    expect(unknown.body.requestedWorkspace).toBe(UNKNOWN_CWD);
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

    const res = await request(app)
      .get('/workspace/not:an:absolute:path/sessions')
      .set('Host', host());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      '`:id` must decode to a workspace id or absolute path',
    );
  });

  it('rejects untrusted non-primary workspace session listing', async () => {
    const daemonLog = makeDaemonLog();
    const { app, secondaryBridge } = makeHarness({
      secondaryTrusted: false,
      daemonLog,
    });

    const res = await request(app)
      .get('/workspaces/secondary-id/sessions')
      .set('Host', host());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('untrusted_workspace');
    expect(res.body.error).toBe('Workspace is not trusted.');
    expect(res.body).not.toHaveProperty('workspaceCwd');
    expect(res.body).not.toHaveProperty('workspaceId');
    expect(secondaryBridge.listCalls).toEqual([]);
    expect(daemonLog.warn).toHaveBeenCalledWith(
      'session routing failed',
      expect.objectContaining({
        route: 'GET /workspaces/:workspace/sessions',
        resolutionKind: 'untrusted_workspace',
        workspaceCwd: SECONDARY_CWD,
      }),
    );
  });

  it('rejects untrusted primary workspace on plural session routes', async () => {
    const daemonLog = makeDaemonLog();
    const { app } = makeHarness({
      primaryTrusted: false,
      daemonLog,
    });

    const res = await request(app)
      .get('/workspaces/primary-id/session-groups')
      .set('Host', host());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('untrusted_workspace');
    expect(res.body.error).toBe('Workspace is not trusted.');
    expect(res.body).not.toHaveProperty('workspaceCwd');
    expect(res.body).not.toHaveProperty('workspaceId');
    expect(daemonLog.warn).toHaveBeenCalledWith(
      'session routing failed',
      expect.objectContaining({
        route: 'GET /workspaces/:workspace/session-groups',
        resolutionKind: 'untrusted_workspace',
        workspaceCwd: PRIMARY_CWD,
      }),
    );
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
      expect(primaryBridge.closeCalls).toEqual([]);
      expect(secondaryBridge.closeCalls).toEqual([archiveId, deleteId]);
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
