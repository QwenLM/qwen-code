/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import {
  GitWorktreeService,
  SessionService,
  createWorktreeSessionMarkerExclusive,
  readWorktreeSessionStrict,
  writeWorktreeSession,
  type ChatRecord,
} from '@qwen-code/qwen-code-core';
import {
  SessionNotFoundError,
  type AcpSessionBridge,
} from '../acp-session-bridge.js';
import { sendBridgeError } from '../server/error-response.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerSessionRoutes } from './session.js';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'session-worktree-branch-'));
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeFixture() {
  const workspaceDir = path.join(tmpRoot, randomUUID());
  mkdirSync(workspaceDir, { recursive: true });
  git(workspaceDir, 'init', '-q', '-b', 'main');
  git(workspaceDir, 'config', 'user.email', 't@e.com');
  git(workspaceDir, 'config', 'user.name', 't');
  git(workspaceDir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(workspaceDir, 'README.md'), 'base\n');
  git(workspaceDir, 'add', '.');
  git(workspaceDir, 'commit', '-qm', 'init', '--no-verify');

  const slug = 'task';
  const service = new GitWorktreeService(workspaceDir);
  const worktreeDir = path.join(workspaceDir, '.qwen', 'worktrees', slug);

  const runtimeBaseDir = path.join(tmpRoot, randomUUID());
  const sessionService = new SessionService(workspaceDir, { runtimeBaseDir });
  const summaries = new Map<string, { hasActivePrompt: boolean }>();
  const setSessionWorktreeCalls: unknown[][] = [];
  const bridge = {
    getSessionSummary: (sessionId: string) => {
      const summary = summaries.get(sessionId);
      if (!summary) throw new SessionNotFoundError(sessionId);
      return summary;
    },
    setSessionWorktree: (...args: unknown[]) => {
      setSessionWorktreeCalls.push(args);
    },
    markSessionCatalogChanged: () => {},
    deleteSessionAttachments: async () => {},
  } as unknown as AcpSessionBridge;
  const runtime = {
    workspaceId: randomUUID(),
    workspaceCwd: workspaceDir,
    sessionRuntimeBaseDir: runtimeBaseDir,
    primary: true,
    trusted: true,
    bridge,
  } as WorkspaceRuntime;
  const app = express();
  app.use(express.json());
  const registry = createWorkspaceRegistry([runtime]);
  registerSessionRoutes(app, {
    boundWorkspace: workspaceDir,
    bridge,
    workspaceRegistry: registry,
    archiveCoordinator: {
      runSharedMany: async (
        _sessionIds: string[],
        fn: () => Promise<unknown>,
      ) => await fn(),
    } as Parameters<typeof registerSessionRoutes>[1]['archiveCoordinator'],
    mutate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    sendBridgeError,
    sessionShellCommandEnabled: true,
    languageCodes: ['en'],
  });

  const sessionId = randomUUID();
  summaries.set(sessionId, { hasActivePrompt: false });

  return {
    workspaceDir,
    worktreeDir,
    slug,
    service,
    sessionService,
    app,
    sessionId,
    setSessionWorktreeCalls,
    async createDetachedWorktree(): Promise<void> {
      const result = await service.createUserWorktree(slug, 'main', {
        detached: true,
      });
      if (!result.success) throw new Error(result.error);
    },
    async writeSidecar(worktreeBranch: string): Promise<void> {
      await writeWorktreeSession(
        sessionService.getWorktreeSessionPath(sessionId),
        {
          slug,
          worktreePath: worktreeDir,
          worktreeBranch,
          originalCwd: workspaceDir,
          workspaceCwd: workspaceDir,
          originalBranch: 'main',
          originalHeadCommit: git(workspaceDir, 'rev-parse', 'HEAD'),
        },
      );
    },
    writeTranscript(): void {
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
      const transcriptPath = sessionService.getSessionTranscriptPath(sessionId);
      mkdirSync(path.dirname(transcriptPath), { recursive: true });
      writeFileSync(transcriptPath, `${JSON.stringify(record)}\n`, 'utf8');
    },
    createMarker(): Promise<unknown> {
      return createWorktreeSessionMarkerExclusive(worktreeDir, sessionId);
    },
    readSidecar() {
      return readWorktreeSessionStrict(
        sessionService.getWorktreeSessionPath(sessionId),
      );
    },
  };
}

describe('POST /session/:id/worktree-branch', () => {
  it('branches the detached worktree and updates sidecar + bridge metadata', async () => {
    const fixture = makeFixture();
    await fixture.createDetachedWorktree();
    await fixture.writeSidecar('');
    fixture.writeTranscript();
    await fixture.createMarker();

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-branch`)
      .send({ name: 'feat/from-detached' });

    expect(res.status).toBe(200);
    expect(res.body.worktree).toEqual({
      slug: fixture.slug,
      path: fixture.worktreeDir,
      branch: 'feat/from-detached',
    });
    expect(git(fixture.worktreeDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'feat/from-detached',
    );
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('valid');
    if (sidecar.state === 'valid') {
      expect(sidecar.session.worktreeBranch).toBe('feat/from-detached');
    }
    expect(fixture.setSessionWorktreeCalls).toHaveLength(1);
    expect(fixture.setSessionWorktreeCalls[0]).toEqual([
      fixture.sessionId,
      {
        slug: fixture.slug,
        path: fixture.worktreeDir,
        branch: 'feat/from-detached',
      },
    ]);
  });

  it('branches a freshly created session with no transcript yet', async () => {
    const fixture = makeFixture();
    await fixture.createDetachedWorktree();
    await fixture.writeSidecar('');
    // No transcript record: the live bridge summary resolves the session
    // (the user branches before sending the first prompt).
    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-branch`)
      .send({ name: 'feat/fresh' });

    expect(res.status).toBe(200);
    expect(res.body.worktree.branch).toBe('feat/fresh');
  });

  it('rejects an invalid branch name with 400', async () => {
    const fixture = makeFixture();
    await fixture.createDetachedWorktree();
    await fixture.writeSidecar('');
    fixture.writeTranscript();

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-branch`)
      .send({ name: 'bad name' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('branch_invalid_name');
  });

  it('refuses a session without a managed worktree with 409', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-branch`)
      .send({ name: 'feat/x' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_branch_unsupported');
  });

  it('refuses a worktree that already has a branch with 409', async () => {
    const fixture = makeFixture();
    await fixture.createDetachedWorktree();
    await fixture.writeSidecar('worktree-task');
    fixture.writeTranscript();

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-branch`)
      .send({ name: 'feat/x' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_already_branched');
  });

  it('refuses a branch name that already exists with 409', async () => {
    const fixture = makeFixture();
    await fixture.createDetachedWorktree();
    await fixture.writeSidecar('');
    fixture.writeTranscript();
    git(fixture.workspaceDir, 'branch', 'feat/taken');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-branch`)
      .send({ name: 'feat/taken' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('branch_already_exists');
  });

  it('answers 404 for an unknown session', async () => {
    const fixture = makeFixture();

    const res = await request(fixture.app)
      .post(`/session/${randomUUID()}/worktree-branch`)
      .send({ name: 'feat/x' });

    expect(res.status).toBe(404);
  });
});
