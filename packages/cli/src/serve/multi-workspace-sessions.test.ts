/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
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
import { createServeApp } from './server.js';
import type { WorkspaceFileSystemFactory } from './fs/index.js';
import type { ServeOptions } from './types.js';
import type { DaemonWorkspaceService } from './workspace-service/types.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from './workspace-registry.js';

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
  readonly restoreCalls: Array<{
    action: 'load' | 'resume';
    req: BridgeRestoreSessionRequest;
  }>;
}

function makeSummary(
  sessionId: string,
  workspaceCwd: string,
): BridgeSessionSummary {
  return {
    sessionId,
    workspaceCwd,
    createdAt: '2026-07-08T00:00:00.000Z',
    updatedAt: '2026-07-08T00:01:00.000Z',
    displayName: sessionId,
    clientCount: 1,
    hasActivePrompt: false,
  };
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
  const restoreCalls: FakeBridge['restoreCalls'] = [];
  const bridge = {
    permissionPolicy: 'first-responder' as const,
    spawnCalls,
    promptCalls,
    cancelCalls,
    closeCalls,
    heartbeatCalls,
    detachCalls,
    restoreCalls,
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
      return [...live.values()].filter(
        (summary) => summary.workspaceCwd === cwd,
      );
    },
    getSessionSummary(sessionId: string) {
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
      return { removed: promptId === 'prompt-1' };
    },
    respondToSessionPermission(sessionId: string) {
      if (!live.has(sessionId)) throw new SessionNotFoundError(sessionId);
      return true;
    },
    respondToPermission() {
      return false;
    },
    subscribeEvents(sessionId: string) {
      if (!live.has(sessionId)) throw new SessionNotFoundError(sessionId);
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

function makeHarness(opts?: {
  secondaryTrusted?: boolean;
  secondaryChannelLive?: boolean;
}) {
  const primaryBridge = makeBridge(
    PRIMARY_CWD,
    [makeSummary('primary-session', PRIMARY_CWD)],
    { channelLive: true },
  );
  const secondaryBridge = makeBridge(
    SECONDARY_CWD,
    [makeSummary('secondary-session', SECONDARY_CWD)],
    { channelLive: opts?.secondaryChannelLive ?? true },
  );
  const registry = createWorkspaceRegistry([
    makeRuntime({
      workspaceId: 'primary-id',
      workspaceCwd: PRIMARY_CWD,
      primary: true,
      trusted: true,
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
    { workspaceRegistry: registry },
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
    expect(unknown.primaryBridge.spawnCalls).toEqual([]);
    expect(unknown.secondaryBridge.spawnCalls).toEqual([]);

    const untrusted = makeHarness({ secondaryTrusted: false });
    const untrustedRes = await request(untrusted.app)
      .post('/session')
      .set('Host', host())
      .send({ cwd: SECONDARY_CWD });

    expect(untrustedRes.status).toBe(403);
    expect(untrustedRes.body.code).toBe('untrusted_workspace');
    expect(untrusted.secondaryBridge.spawnCalls).toEqual([]);
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

  it('returns session_not_found instead of falling back to primary on live owner miss', async () => {
    const { app } = makeHarness();
    const res = await request(app)
      .post('/session/missing-session/prompt')
      .set('Host', host())
      .send({ prompt: [{ type: 'text', text: 'hello' }] });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('session_not_found');
  });

  it('keeps persisted load and resume primary-only before touching a bridge', async () => {
    const { app, primaryBridge, secondaryBridge } = makeHarness();

    for (const action of ['load', 'resume'] as const) {
      const res = await request(app)
        .post(`/session/secondary-session/${action}`)
        .set('Host', host())
        .send({ cwd: SECONDARY_CWD });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('workspace_mismatch');
    }

    expect(primaryBridge.restoreCalls).toEqual([]);
    expect(secondaryBridge.restoreCalls).toEqual([]);
  });

  it('lists non-primary workspace sessions live-only by workspace id', async () => {
    const { app } = makeHarness();

    const res = await request(app)
      .get('/workspace/secondary-id/sessions')
      .set('Host', host());

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([
      expect.objectContaining({
        sessionId: 'secondary-session',
        workspaceCwd: SECONDARY_CWD,
      }),
    ]);

    const archived = await request(app)
      .get('/workspace/secondary-id/sessions?archiveState=archived')
      .set('Host', host());
    expect(archived.status).toBe(400);
    expect(archived.body.code).toBe('non_primary_live_sessions_only');

    const unknown = await request(app)
      .get(`/workspace/${encodeURIComponent(UNKNOWN_CWD)}/sessions`)
      .set('Host', host());
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('workspace_mismatch');
  });
});
