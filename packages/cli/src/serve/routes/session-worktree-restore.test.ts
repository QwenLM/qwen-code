/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
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
  SessionService,
  createWorktreeSessionMarkerExclusive,
  writeWorktreeSession,
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

describe('POST /session/:id/worktree-restore', () => {
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
});
