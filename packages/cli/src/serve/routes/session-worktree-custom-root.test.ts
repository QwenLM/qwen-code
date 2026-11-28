/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SessionService,
  readWorktreeSessionStrict,
} from '@qwen-code/qwen-code-core';
import { type AcpSessionBridge } from '../acp-session-bridge.js';
import { sendBridgeError } from '../server/error-response.js';
import {
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerSessionRoutes } from './session.js';
import { registerWorkspaceQualifiedGitWorktreeRoutes } from './workspace-git-worktrees.js';

const tmpRoot = realpathSync(
  mkdtempSync(path.join(tmpdir(), 'session-worktree-custom-root-')),
);
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'],
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim();
}

function makeFixture(worktreeSettings?: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpRoot, 'case-'));
  const home = path.join(dir, 'home');
  const repoRoot = path.join(dir, 'repo');
  const runtimeBaseDir = path.join(dir, 'storage');
  mkdirSync(home, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, 'init', '-q', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 't@e.com');
  git(repoRoot, 'config', 'user.name', 't');
  git(repoRoot, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoRoot, 'README.md'), 'base\n');
  git(repoRoot, 'add', 'README.md');
  git(repoRoot, 'commit', '-q', '-m', 'init', '--no-verify');

  if (worktreeSettings !== undefined) {
    mkdirSync(path.join(repoRoot, '.qwen'), { recursive: true });
    writeFileSync(
      path.join(repoRoot, '.qwen', 'settings.json'),
      JSON.stringify({ worktree: worktreeSettings }),
    );
    git(repoRoot, 'add', '.qwen/settings.json');
    git(repoRoot, 'commit', '-q', '-m', 'configure worktree', '--no-verify');
  }

  const sessionService = new SessionService(repoRoot, { runtimeBaseDir });
  const sessions = new Map<
    string,
    {
      sessionId: string;
      effectiveCwd: string;
      worktree?: { slug: string; path: string; branch: string };
      clientCount: number;
    }
  >();
  const cdCalls: Array<{
    sessionId: string;
    path: string;
    allowedRoots?: string[];
  }> = [];

  const bridge = {
    spawnOrAttach: async () => {
      const sessionId = randomUUID();
      sessions.set(sessionId, {
        sessionId,
        effectiveCwd: repoRoot,
        clientCount: 1,
      });
      return {
        sessionId,
        clientId: randomUUID(),
        attached: false,
        currentCwd: repoRoot,
        workspaceCwd: repoRoot,
      };
    },
    getSessionSummary: (id: string) => {
      const s = sessions.get(id);
      if (!s) throw new Error(`Session not found: ${id}`);
      return {
        sessionId: s.sessionId,
        workspaceCwd: repoRoot,
        hasActivePrompt: false,
        activePromptId: undefined,
        worktree: s.worktree,
      };
    },
    getSessionExecutionSnapshot: (id: string) => {
      const s = sessions.get(id);
      if (!s) throw new Error(`Session not found: ${id}`);
      return {
        sessionId: s.sessionId,
        workspaceCwd: repoRoot,
        effectiveCwd: s.effectiveCwd,
        worktree: s.worktree,
      };
    },
    listWorkspaceSessions: () => [...sessions.values()],
    hasAdmittedPrompt: () => false,
    changeSessionCwd: async (
      id: string,
      req: { path: string; allowedRoots?: string[] },
    ) => {
      cdCalls.push({
        sessionId: id,
        path: req.path,
        allowedRoots: req.allowedRoots,
      });
      const s = sessions.get(id)!;
      const previousCwd = s.effectiveCwd;
      const landed = realpathSync(req.path);
      s.effectiveCwd = landed;
      return { previousCwd, newCwd: landed, warnings: [] };
    },
    setSessionWorktree: (
      id: string,
      wt: { slug: string; path: string; branch: string },
    ) => {
      const s = sessions.get(id);
      if (s) s.worktree = wt;
    },
    clearSessionWorktree: (id: string) => {
      const s = sessions.get(id);
      if (s) s.worktree = undefined;
    },
    setSessionBaseCommit: () => {},
    setSessionResetPending: () => true,
    clearSessionResetPending: () => {},
    isWorktreePathLive: () => false,
  } as unknown as AcpSessionBridge;

  const runtime = {
    workspaceId: 'primary',
    workspaceCwd: repoRoot,
    primary: true,
    trusted: true,
    removable: false,
    sessionRuntimeBaseDir: runtimeBaseDir,
    generationGuard: createWorkspaceGenerationGuard(),
    routeFileSystemFactory: { sshWorkspace: false },
    env: {
      mode: 'parent-process',
      overlayKeys: [],
      effectiveEnv: {
        PATH: process.env['PATH'],
        HOME: home,
        USERPROFILE: home,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
    bridge,
  } as unknown as WorkspaceRuntime;

  const app = express();
  app.use(express.json());
  const registry = createWorkspaceRegistry([runtime]);
  registerSessionRoutes(app, {
    boundWorkspace: repoRoot,
    bridge,
    workspaceRegistry: registry,
    archiveCoordinator: {
      runSharedMany: async (_ids: string[], fn: () => Promise<unknown>) =>
        await fn(),
    } as Parameters<typeof registerSessionRoutes>[1]['archiveCoordinator'],
    mutate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    sendBridgeError,
    sessionShellCommandEnabled: true,
    languageCodes: ['en'],
  });
  registerWorkspaceQualifiedGitWorktreeRoutes(app, {
    workspaceRegistry: registry,
    mutate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    sendBridgeError,
  });

  return { dir, repoRoot, app, sessions, cdCalls, sessionService };
}

describe('HTTP routes with custom worktree.root', () => {
  it('creates a worktree under custom worktree.root on POST /session, lists it as managed, and hands off to local and back', async () => {
    const fixture = makeFixture({ root: '.worktrees' });

    const created = await request(fixture.app)
      .post('/session')
      .send({ worktree: { slug: 'p7-http' } });
    expect(created.status).toBe(200);
    const sessionId = created.body.sessionId as string;
    const expectedPath = path.join(fixture.repoRoot, '.worktrees', 'p7-http');
    expect(created.body.worktree.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(
      existsSync(path.join(fixture.repoRoot, '.qwen', 'worktrees', 'p7-http')),
    ).toBe(false);
    expect(fixture.cdCalls[0]?.allowedRoots).toContain(
      path.join(fixture.repoRoot, '.worktrees'),
    );

    // Sidecar persisted with custom worktree path.
    const sidecar = await readWorktreeSessionStrict(
      fixture.sessionService.getWorktreeSessionPath(sessionId),
    );
    expect(sidecar.state).toBe('valid');
    if (sidecar.state === 'valid') {
      expect(sidecar.session.worktreePath).toBe(expectedPath);
    }

    // GET /workspaces/:workspace/git/worktrees reports it as managed.
    const listed = await request(fixture.app).get(
      '/workspaces/primary/git/worktrees',
    );
    expect(listed.status).toBe(200);
    const listedEntry = (
      listed.body.worktrees as Array<{ path: string; slug?: string }>
    ).find((w) => realpathSync(w.path) === expectedPath);
    expect(listedEntry?.slug).toBe('p7-http');

    // Handoff to local relocates the session back to the workspace root and
    // clears the worktree sidecar.
    const toLocal = await request(fixture.app)
      .post(`/session/${sessionId}/worktree-handoff`)
      .send({ to: 'local' });
    expect(toLocal.status).toBe(200);
    expect(toLocal.body.worktree).toBeNull();
    expect(toLocal.body.currentCwd).toBe(fixture.repoRoot);
    const clearedSidecar = await readWorktreeSessionStrict(
      fixture.sessionService.getWorktreeSessionPath(sessionId),
    );
    expect(clearedSidecar.state).toBe('missing');

    // Handoff back to worktree creates the new checkout under .worktrees/.
    const toWorktree = await request(fixture.app)
      .post(`/session/${sessionId}/worktree-handoff`)
      .send({ to: 'worktree' });
    expect(toWorktree.status).toBe(200);
    const newWtPath = toWorktree.body.worktree.path as string;
    expect(path.dirname(newWtPath)).toBe(
      path.join(fixture.repoRoot, '.worktrees'),
    );
    expect(existsSync(newWtPath)).toBe(true);
  });

  it('rejects POST /session and handoff with 400 invalid_worktree_root when worktree.root is invalid', async () => {
    const fixture = makeFixture({ root: '../escape' });

    const created = await request(fixture.app)
      .post('/session')
      .send({ worktree: {} });
    expect(created.status).toBe(400);
    expect(created.body.code).toBe('invalid_worktree_root');
    expect(fixture.sessions.size).toBe(0);

    // Plain (non-worktree) session still starts, and handoff to worktree fails closed with 400.
    const plain = await request(fixture.app).post('/session').send({});
    expect(plain.status).toBe(200);
    const handoff = await request(fixture.app)
      .post(`/session/${plain.body.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' });
    expect(handoff.status).toBe(400);
    expect(handoff.body.code).toBe('invalid_worktree_root');
  });

  it('rejects POST /session with 400 invalid_worktree_root when custom worktree.root symlinks outside the repository', async () => {
    const fixture = makeFixture({ root: '.worktrees' });
    const outside = path.join(fixture.dir, 'outside');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(fixture.repoRoot, '.worktrees'));

    const created = await request(fixture.app)
      .post('/session')
      .send({ worktree: {} });
    expect(created.status).toBe(400);
    expect(created.body.code).toBe('invalid_worktree_root');
    expect(readdirSync(outside)).toEqual([]);
  });
});
