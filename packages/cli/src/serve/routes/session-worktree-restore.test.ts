/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_MODES,
  SESSION_TRANSCRIPT_MAX_LIMIT,
  SessionService,
  createWorktreeSessionMarkerExclusive,
  writeWorktreeSession,
  readWorktreeSessionStrict,
  type ChatRecord,
  type WorktreeSession,
} from '@qwen-code/qwen-code-core';
import {
  SessionNotFoundError,
  type AcpSessionBridge,
} from '../acp-session-bridge.js';
import { sendBridgeError } from '../server/error-response.js';
import { SessionArchiveCoordinator } from '../server/session-archive.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  configureRetention,
  makeRetainedSession,
  makeRetentionRepo,
} from '../../test-utils/worktree-session-retention-fixtures.js';
import { sweepWorktreeRetentionOnce } from '../server/worktree-retention.js';
import { runWithWorkspaceRuntimeStorage } from '../workspace-runtime-storage.js';

const ownershipMocks = vi.hoisted(() => ({
  real: undefined as
    | typeof import('../server/worktree-ownership-op.js').acquireWorktreeOwnershipOp
    | undefined,
  acquire: vi.fn(),
}));

vi.mock('../server/worktree-ownership-op.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../server/worktree-ownership-op.js')>();
  ownershipMocks.real = actual.acquireWorktreeOwnershipOp;
  ownershipMocks.acquire.mockImplementation(actual.acquireWorktreeOwnershipOp);
  return {
    ...actual,
    acquireWorktreeOwnershipOp: ownershipMocks.acquire,
  };
});

const restoreMocks = vi.hoisted(() => ({
  real: undefined as
    | typeof import('../server/session-worktree-restore.js').restoreWorktreeFromSessionSnapshot
    | undefined,
  restore: vi.fn(),
}));

vi.mock('../server/session-worktree-restore.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../server/session-worktree-restore.js')
    >();
  restoreMocks.real = actual.restoreWorktreeFromSessionSnapshot;
  restoreMocks.restore.mockImplementation(
    actual.restoreWorktreeFromSessionSnapshot,
  );
  return {
    ...actual,
    restoreWorktreeFromSessionSnapshot: restoreMocks.restore,
  };
});

import { registerSessionRoutes } from './session.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'worktree-restore-route-'));
  ownershipMocks.acquire.mockClear();
  ownershipMocks.acquire.mockImplementation(ownershipMocks.real!);
  restoreMocks.restore.mockClear();
  restoreMocks.restore.mockImplementation(restoreMocks.real!);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function makeFixture(
  options: {
    primary?: boolean;
    internal?: boolean;
    ssh?: boolean;
    getLoadAdmissionSnapshot?: () => {
      enabled: boolean;
      overloaded: boolean;
      reason: 'cpu_load' | 'event_loop_lag' | 'observation_gap' | null;
      loadRatio: number;
      eventLoopLagP99Ms: number;
      sampledAtMs: number;
    };
  } = {},
) {
  const workspaceDir = realpathSync(mkdirTemp());
  const runtimeBaseDir = path.join(root, randomUUID());
  const service = new SessionService(workspaceDir, { runtimeBaseDir });
  let summary:
    | { hasActivePrompt: boolean; pendingInteractionCount: number }
    | undefined;
  const getSessionSummary = vi.fn(() => {
    if (!summary) throw new SessionNotFoundError('offline');
    return summary;
  });
  const loadSession = vi.fn(
    async (req: { sessionId: string; workspaceCwd: string }) => ({
      sessionId: req.sessionId,
      workspaceCwd: req.workspaceCwd,
      currentCwd: req.workspaceCwd,
      attached: false,
      state: { phase: 'loaded-after-restore' },
      compactedReplay: [],
      liveJournal: [],
    }),
  );
  const changeSessionCwd = vi.fn(
    async (sessionId: string, req: { path: string }) => ({
      sessionId,
      previousCwd: '',
      newCwd: realpathSync(req.path),
      warnings: [],
    }),
  );
  const setSessionWorktree = vi.fn();
  const bridge = {
    getSessionSummary,
    loadSession,
    changeSessionCwd,
    setSessionWorktree,
    killSession: vi.fn(async () => true),
    detachClient: vi.fn(async () => {}),
  } as unknown as AcpSessionBridge;
  const runtime = {
    workspaceId: randomUUID(),
    workspaceCwd: workspaceDir,
    sessionRuntimeBaseDir: runtimeBaseDir,
    primary: options.primary !== false,
    trusted: true,
    bridge,
    routeFileSystemFactory: options.ssh ? { sshWorkspace: {} } : {},
    ...(options.internal ? { provenance: 'live-conversation' } : {}),
  } as unknown as WorkspaceRuntime;
  const runtimes = [runtime];
  if (!runtime.primary) {
    const primaryWorkspaceCwd = path.join(root, 'primary-workspace');
    mkdirSync(primaryWorkspaceCwd, { recursive: true });
    runtimes.unshift({
      ...runtime,
      workspaceId: randomUUID(),
      workspaceCwd: primaryWorkspaceCwd,
      sessionRuntimeBaseDir: `${runtimeBaseDir}-primary-auxiliary`,
      primary: true,
    } as WorkspaceRuntime);
  }
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, {
    boundWorkspace: workspaceDir,
    bridge,
    workspaceRegistry: createWorkspaceRegistry(runtimes),
    archiveCoordinator: new SessionArchiveCoordinator(),
    mutate: () => (_req, _res, next) => next(),
    sendBridgeError,
    sessionShellCommandEnabled: true,
    languageCodes: ['en'],
    ...(options.getLoadAdmissionSnapshot
      ? { getLoadAdmissionSnapshot: options.getLoadAdmissionSnapshot }
      : {}),
  });
  const worktreeDir = path.join(workspaceDir, '.qwen', 'worktrees', 'task');

  return {
    app,
    runtime,
    service,
    getSessionSummary,
    loadSession,
    changeSessionCwd,
    setSessionWorktree,
    worktreeDir,
    busy(): void {
      summary = { hasActivePrompt: true, pendingInteractionCount: 1 };
    },
    idleLive(): void {
      summary = { hasActivePrompt: false, pendingInteractionCount: 0 };
    },
    record(sessionId: string, removed = true): WorktreeSession {
      const sidecar: WorktreeSession = {
        slug: 'task',
        worktreePath: worktreeDir,
        worktreeBranch: '',
        originalCwd: workspaceDir,
        workspaceCwd: workspaceDir,
        originalBranch: 'main',
        originalHeadCommit: 'a'.repeat(40),
        ...(removed
          ? {
              worktreeRemoved: {
                archiveKey: `${sessionId}.1.1.worktree-snapshot.tar.gz`,
              },
            }
          : {}),
      };
      const record: ChatRecord = {
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: new Date(Date.UTC(2026, 0, 1)).toISOString(),
        type: 'user',
        provenance: 'real_user',
        cwd: workspaceDir,
        version: '1.0.0',
        message: { role: 'user', parts: [{ text: 'hello' }] },
      };
      const transcriptPath = service.getSessionTranscriptPath(sessionId);
      mkdirSync(path.dirname(transcriptPath), { recursive: true });
      writeFileSync(transcriptPath, `${JSON.stringify(record)}\n`);
      return sidecar;
    },
    async seed(sessionId: string, removed = true): Promise<WorktreeSession> {
      const sidecar = this.record(sessionId, removed);
      await writeWorktreeSession(
        service.getWorktreeSessionPath(sessionId),
        sidecar,
      );
      return sidecar;
    },
    async markOwner(sessionId: string): Promise<void> {
      mkdirSync(worktreeDir, { recursive: true });
      await createWorktreeSessionMarkerExclusive(worktreeDir, sessionId);
    },
  };
}

function mkdirTemp(): string {
  return mkdtempSync(path.join(root, 'workspace-'));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const invalidRestoreRequests = [
  {
    name: 'historyPageSize',
    body: { historyPageSize: 0 },
    response: {
      error: `\`historyPageSize\` must be between 1 and ${SESSION_TRANSCRIPT_MAX_LIMIT}`,
      code: 'invalid_transcript_limit',
      maxLimit: SESSION_TRANSCRIPT_MAX_LIMIT,
    },
  },
  {
    name: 'approvalMode',
    body: { approvalMode: 'invalid' },
    response: {
      error: '`approvalMode` must be a known approval mode when provided',
      code: 'invalid_approval_mode',
      allowed: APPROVAL_MODES,
    },
  },
  {
    name: 'liveReplayMode',
    body: { liveReplayMode: 'invalid' },
    response: {
      error: '`liveReplayMode` must be `full` or `summary`',
      code: 'invalid_live_replay_mode',
    },
  },
  {
    name: 'compactedReplayMode',
    body: { compactedReplayMode: 'invalid' },
    response: {
      error: '`compactedReplayMode` must be `full` or `summary`',
      code: 'invalid_compacted_replay_mode',
    },
  },
  {
    name: 'reserved source',
    body: { sourceType: 'agent' },
    response: {
      error:
        'The requested session source is reserved for daemon-owned agent sessions.',
      code: 'reserved_session_source',
    },
  },
] as const;

describe('POST /session/:id/worktree-restore', () => {
  it.each(['load', 'resume'] as const)(
    'requires snapshot restoration before ordinary %s without bridge effects',
    async (action) => {
      const fixture = makeFixture();
      const id = randomUUID();
      await fixture.seed(id);

      const response = await request(fixture.app)
        .post(`/session/${id}/${action}`)
        .send({});

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error:
          'This session has a retained worktree. Use /session/:id/worktree-restore before ordinary load or resume.',
        code: 'worktree_restore_unavailable',
        sessionId: id,
      });
      expect(fixture.loadSession).not.toHaveBeenCalled();
      expect(fixture.changeSessionCwd).not.toHaveBeenCalled();
      expect(fixture.setSessionWorktree).not.toHaveBeenCalled();
      expect(restoreMocks.restore).not.toHaveBeenCalled();
      expect(existsSync(fixture.worktreeDir)).toBe(false);
      const preserved = await readWorktreeSessionStrict(
        fixture.service.getWorktreeSessionPath(id),
      );
      expect(preserved.state).toBe('valid');
      if (preserved.state === 'valid') {
        expect(preserved.session.worktreeRemoved?.archiveKey).toBe(
          `${id}.1.1.worktree-snapshot.tar.gz`,
        );
      }
    },
  );

  it.each(invalidRestoreRequests)(
    'rejects invalid $name before either worktree restoration or ordinary load',
    async ({ body, response: expectedBody }) => {
      for (const route of ['worktree-restore', 'load'] as const) {
        const fixture = makeFixture();
        const id = randomUUID();
        const binding = await fixture.seed(id, false);
        await fixture.markOwner(id);
        restoreMocks.restore.mockImplementation(async () => ({
          session: binding,
          branch: '',
          reconstructed: true,
        }));

        const response = await request(fixture.app)
          .post(`/session/${id}/${route}`)
          .send(body);

        expect(response.status).toBe(400);
        expect(response.body).toEqual(expectedBody);
        expect(restoreMocks.restore).not.toHaveBeenCalled();
        expect(fixture.loadSession).not.toHaveBeenCalled();
      }
    },
  );

  it('rejects virtual-subagent and internal sessions before restoring', async () => {
    const fixture = makeFixture();
    const parentId = randomUUID();
    const virtualId = `subagent.${Buffer.from(parentId).toString('base64url')}.${Buffer.from('branch').toString('base64url')}`;
    const virtual = await request(fixture.app)
      .post(`/session/${encodeURIComponent(virtualId)}/worktree-restore`)
      .send({});
    expect(virtual.status).toBe(400);
    expect(virtual.body.code).toBe('unsupported_action');

    const internal = makeFixture({ internal: true });
    const id = randomUUID();
    const response = await request(internal.app)
      .post(`/session/${id}/worktree-restore`)
      .send({ cwd: internal.runtime.workspaceCwd });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('unsupported_action');
    expect(restoreMocks.restore).not.toHaveBeenCalled();
  });

  it('rejects SSH without accepting local restoration authority', async () => {
    const fixture = makeFixture({ ssh: true });
    const response = await request(fixture.app)
      .post(`/session/${randomUUID()}/worktree-restore`)
      .send({ cwd: fixture.runtime.workspaceCwd });
    expect(response.status).toBe(501);
    expect(response.body.code).toBe('ssh_workspace_operation_unsupported');
    expect(restoreMocks.restore).not.toHaveBeenCalled();
  });

  it('keeps a busy session and never starts reconstruction or load', async () => {
    const fixture = makeFixture();
    const id = randomUUID();
    await fixture.seed(id);
    fixture.busy();
    const response = await request(fixture.app)
      .post(`/session/${id}/worktree-restore`)
      .send({});
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('worktree_restore_active');
    expect(restoreMocks.restore).not.toHaveBeenCalled();
    expect(fixture.loadSession).not.toHaveBeenCalled();
  });

  it('maps an unavailable selected snapshot pair to a typed 409', async () => {
    const fixture = makeFixture({ primary: false });
    const id = randomUUID();
    await fixture.seed(id);
    const response = await request(fixture.app)
      .post(`/session/${id}/worktree-restore`)
      .send({ cwd: fixture.runtime.workspaceCwd });
    expect(response.body).toMatchObject({
      code: 'worktree_restore_unavailable',
      error: 'The snapshot pair for this session is unavailable',
      sessionId: id,
    });
    expect(response.status).toBe(409);
  });

  it('holds a restored checkout until ordinary load registers against queued retention', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const state = await makeRetainedSession(target, {
      slug: 'restore-register-race',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const newer = await makeRetainedSession(target, {
      slug: 'restore-register-newer-control',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const liveSessions = new Set<string>();
    const loadSession = vi.fn(
      async (req: { sessionId: string; workspaceCwd: string }) => {
        liveSessions.add(req.sessionId);
        return {
          sessionId: req.sessionId,
          clientId: 'restore-client',
          workspaceCwd: req.workspaceCwd,
          currentCwd: req.workspaceCwd,
          attached: true,
          hasActivePrompt: false,
          compactedReplay: [],
          liveJournal: [],
        };
      },
    );
    const bridge = {
      getSessionSummary: vi.fn((sessionId: string) => {
        if (!liveSessions.has(sessionId)) {
          throw new SessionNotFoundError(sessionId);
        }
        return { hasActivePrompt: false, pendingInteractionCount: 0 };
      }),
      loadSession,
      changeSessionCwd: vi.fn(
        async (sessionId: string, req: { path: string }) => ({
          sessionId,
          previousCwd: '',
          newCwd: realpathSync(req.path),
          warnings: [],
        }),
      ),
      setSessionWorktree: vi.fn(),
      detachClient: vi.fn(async (sessionId: string) => {
        liveSessions.delete(sessionId);
      }),
      killSession: vi.fn(async (sessionId: string) => {
        liveSessions.delete(sessionId);
        return true;
      }),
    } as unknown as AcpSessionBridge;
    Object.assign(target.runtime, {
      bridge,
      routeFileSystemFactory: {},
    });
    const coordinator = new SessionArchiveCoordinator();
    const registry = createWorkspaceRegistry([target.runtime]);
    const sweep = () =>
      runWithWorkspaceRuntimeStorage(target.runtime, () =>
        sweepWorktreeRetentionOnce(target.runtime, registry, coordinator),
      );
    expect(await sweep()).toMatchObject({ removed: [state.id] });
    expect(existsSync(state.worktreePath)).toBe(false);
    expect(existsSync(newer.worktreePath)).toBe(true);

    const app = express();
    app.use(express.json());
    registerSessionRoutes(app, {
      boundWorkspace: target.repo,
      bridge,
      workspaceRegistry: registry,
      archiveCoordinator: coordinator,
      mutate: () => (_req, _res, next) => next(),
      sendBridgeError,
      sessionShellCommandEnabled: true,
      languageCodes: ['en'],
    });
    const restored = deferred();
    const finishRestore = deferred();
    restoreMocks.restore.mockImplementation(async (options) => {
      const result = await restoreMocks.real!(options);
      restored.resolve();
      await finishRestore.promise;
      return result;
    });
    const restoring = request(app)
      .post(`/session/${state.id}/worktree-restore`)
      .send({})
      .then((response) => response);

    let queuedRetention: ReturnType<typeof sweep> | undefined;
    try {
      await restored.promise;
      expect(existsSync(state.worktreePath)).toBe(true);
      // The restore has taken its ownership lock; ordinary load is still
      // barriered, so the next same-path acquisition is the queued sweep.
      const retentionAtOwnershipGate = deferred();
      ownershipMocks.acquire.mockImplementation(async (worktreeKey) => {
        if (worktreeKey === state.worktreePath) {
          retentionAtOwnershipGate.resolve();
        }
        return ownershipMocks.real!(worktreeKey);
      });
      let queuedSettled = false;
      queuedRetention = sweep().then((report) => {
        queuedSettled = true;
        return report;
      });
      await retentionAtOwnershipGate.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(queuedSettled).toBe(false);
      expect(bridge.loadSession).not.toHaveBeenCalled();
      expect(existsSync(state.worktreePath)).toBe(true);
      const heldBinding = await readWorktreeSessionStrict(state.sidecarPath);
      expect(heldBinding.state).toBe('valid');
      if (heldBinding.state === 'valid') {
        expect(heldBinding.session.worktreeRemoved).toBeUndefined();
      }
      await coordinator.runExclusiveMany([newer.id], async () => undefined);

      finishRestore.resolve();
      const response = await restoring;
      expect(response.status).toBe(200);
      expect(response.body.sessionId).toBe(state.id);
      expect(bridge.loadSession).toHaveBeenCalledTimes(1);
      expect(liveSessions.has(state.id)).toBe(true);
      expect(bridge.setSessionWorktree).toHaveBeenCalledWith(
        state.id,
        expect.objectContaining({ path: state.worktreePath }),
      );

      expect((await queuedRetention).removed).toEqual([]);
      expect(existsSync(state.worktreePath)).toBe(true);
      await bridge.detachClient(state.id, 'restore-client');
      expect((await sweep()).removed).toEqual([state.id]);
      expect(existsSync(state.worktreePath)).toBe(false);
      expect(existsSync(newer.worktreePath)).toBe(true);

      loadSession.mockImplementationOnce(async () => {
        throw new Error('load failed after snapshot restoration');
      });
      const failedLoad = await request(app)
        .post(`/session/${state.id}/worktree-restore`)
        .send({});
      expect(failedLoad.status).toBe(500);
      expect(liveSessions.has(state.id)).toBe(false);
      expect(existsSync(state.worktreePath)).toBe(true);
      expect((await sweep()).removed).toEqual([state.id]);
      expect(existsSync(state.worktreePath)).toBe(false);
    } finally {
      finishRestore.resolve();
      await restoring;
      await queuedRetention;
    }
  }, 30_000);

  it.each([true, false])(
    'passes explicit owner evidence to restore and returns load for primary=%s',
    async (primary) => {
      const fixture = makeFixture({ primary });
      const id = randomUUID();
      const binding = await fixture.seed(id, false);
      await fixture.markOwner(id);
      restoreMocks.restore.mockResolvedValueOnce({
        session: binding,
        branch: '',
        reconstructed: true,
      });

      const response = await request(fixture.app)
        .post(`/session/${id}/worktree-restore`)
        .send(primary ? {} : { cwd: fixture.runtime.workspaceCwd });

      expect(response.status).toBe(200);
      expect(response.body.state).toEqual({
        phase: 'loaded-after-restore',
      });
      expect(fixture.loadSession).toHaveBeenCalledTimes(1);
      expect(restoreMocks.restore).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: id,
          runtime: fixture.runtime,
          explicitWorkspaceCwd: !primary,
        }),
      );
    },
  );

  it('refuses a retirement-fenced session with 409 session_retirement_fenced before mutating disk', async () => {
    const fixture = makeFixture({ primary: true });
    const id = randomUUID();
    await fixture.seed(id, true);
    (
      fixture.runtime.bridge as unknown as {
        getSessionRetirement?: (sessionId: string) => unknown;
      }
    ).getSessionRetirement = (candidateId: string) =>
      candidateId.toLowerCase() === id.toLowerCase()
        ? {
            sessionId: id,
            operationId: 'op-retired',
            eventEpoch: 'epoch-1',
            state: 'retired',
          }
        : undefined;

    const response = await request(fixture.app)
      .post(`/session/${id}/worktree-restore`)
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('session_retirement_fenced');
    expect(restoreMocks.restore).not.toHaveBeenCalled();
    expect(fixture.loadSession).not.toHaveBeenCalled();
  });

  it('refuses a cold worktree restore with 503 system_overloaded before mutating disk when overloaded', async () => {
    const fixture = makeFixture({
      primary: true,
      getLoadAdmissionSnapshot: () => ({
        enabled: true,
        overloaded: true,
        reason: 'cpu_load',
        loadRatio: 2.9,
        eventLoopLagP99Ms: 320,
        sampledAtMs: Date.now(),
      }),
    });
    const id = randomUUID();
    const binding = await fixture.seed(id, false);
    await fixture.markOwner(id);
    restoreMocks.restore.mockResolvedValueOnce({
      session: binding,
      branch: '',
      reconstructed: true,
    });

    const response = await request(fixture.app)
      .post(`/session/${id}/worktree-restore`)
      .send({});

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('15');
    expect(response.body.code).toBe('system_overloaded');
    expect(restoreMocks.restore).not.toHaveBeenCalled();
    expect(fixture.loadSession).not.toHaveBeenCalled();
  });

  it('allows an already-live warm session through worktree-restore while overloaded', async () => {
    const fixture = makeFixture({
      primary: true,
      getLoadAdmissionSnapshot: () => ({
        enabled: true,
        overloaded: true,
        reason: 'cpu_load',
        loadRatio: 2.9,
        eventLoopLagP99Ms: 320,
        sampledAtMs: Date.now(),
      }),
    });
    const id = randomUUID();
    const binding = await fixture.seed(id, false);
    await fixture.markOwner(id);
    fixture.idleLive();
    restoreMocks.restore.mockResolvedValueOnce({
      session: binding,
      branch: '',
      reconstructed: false,
    });

    const response = await request(fixture.app)
      .post(`/session/${id}/worktree-restore`)
      .send({});

    expect(response.status).toBe(200);
    expect(restoreMocks.restore).toHaveBeenCalledTimes(1);
    expect(fixture.loadSession).toHaveBeenCalledTimes(1);
  });
});
