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
  rmSync,
  writeFileSync,
} from 'node:fs';
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

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'session-worktree-handoff-'));
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeFixture() {
  const workspaceDir = mkdtempSync(path.join(tmpRoot, 'ws-'));
  git(workspaceDir, 'init', '-q', '-b', 'main');
  git(workspaceDir, 'config', 'user.email', 't@e.com');
  git(workspaceDir, 'config', 'user.name', 't');
  git(workspaceDir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(workspaceDir, 'README.md'), 'base\n');
  // Real repos ignore the CLI metadata tree; without this the mechanism's
  // own .qwen/ would read as a dirty local checkout.
  writeFileSync(path.join(workspaceDir, '.gitignore'), '.qwen/\n');
  git(workspaceDir, 'add', '.');
  git(workspaceDir, 'commit', '-qm', 'init', '--no-verify');

  const runtimeBaseDir = mkdtempSync(path.join(tmpRoot, 'rt-'));
  const sessionService = new SessionService(workspaceDir, { runtimeBaseDir });
  const sessionId = randomUUID();
  const summaries = new Map<string, { hasActivePrompt: boolean }>([
    [sessionId, { hasActivePrompt: false }],
  ]);
  const cdCalls: Array<{ sessionId: string; path: string }> = [];
  const setWorktreeCalls: unknown[][] = [];
  const clearWorktreeCalls: string[] = [];
  let effectiveCwd = workspaceDir;
  const bridge = {
    getSessionSummary: (id: string) => {
      const summary = summaries.get(id);
      if (!summary) throw new SessionNotFoundError(id);
      return summary;
    },
    getSessionExecutionSnapshot: (_id: string) => ({
      workspaceCwd: workspaceDir,
      effectiveCwd,
      worktree: undefined,
    }),
    changeSessionCwd: async (
      id: string,
      req: { path: string },
    ): Promise<{
      previousCwd: string;
      newCwd: string;
      warnings: string[];
    }> => {
      cdCalls.push({ sessionId: id, path: req.path });
      const previousCwd = effectiveCwd;
      effectiveCwd = req.path;
      return { previousCwd, newCwd: req.path, warnings: [] };
    },
    setSessionWorktree: (...args: unknown[]) => {
      setWorktreeCalls.push(args);
    },
    clearSessionWorktree: (id: string) => {
      clearWorktreeCalls.push(id);
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
      runSharedMany: async (_ids: string[], fn: () => Promise<unknown>) =>
        await fn(),
    } as Parameters<typeof registerSessionRoutes>[1]['archiveCoordinator'],
    mutate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    sendBridgeError,
    sessionShellCommandEnabled: true,
    languageCodes: ['en'],
  });

  const service = new GitWorktreeService(workspaceDir);
  const slug = 'task';
  const worktreeDir = path.join(workspaceDir, '.qwen', 'worktrees', slug);

  return {
    workspaceDir,
    worktreeDir,
    slug,
    service,
    sessionService,
    sessionId,
    app,
    cdCalls,
    setWorktreeCalls,
    clearWorktreeCalls,
    async createDetachedWorktree(): Promise<void> {
      const result = await service.createUserWorktree(slug, 'main', {
        detached: true,
      });
      if (!result.success) throw new Error(result.error);
      await createWorktreeSessionMarkerExclusive(worktreeDir, sessionId);
      await writeWorktreeSession(
        sessionService.getWorktreeSessionPath(sessionId),
        {
          slug,
          worktreePath: worktreeDir,
          worktreeBranch: '',
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
    readSidecar() {
      return readWorktreeSessionStrict(
        sessionService.getWorktreeSessionPath(sessionId),
      );
    },
  };
}

describe('POST /session/:id/worktree-handoff', () => {
  it('moves a local session into a detached worktree with its dirty state', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    writeFileSync(path.join(fixture.workspaceDir, 'README.md'), 'dirty\n');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' });

    expect(res.status).toBe(200);
    expect(res.body.worktree.branch).toBe('');
    expect(res.body.currentCwd).toBe(res.body.worktree.path);
    expect(fixture.cdCalls).toHaveLength(1);
    expect(fixture.cdCalls[0].path).toBe(res.body.worktree.path);
    expect(fixture.setWorktreeCalls).toHaveLength(1);
    expect(
      await import('node:fs/promises').then((fs) =>
        fs.readFile(path.join(res.body.worktree.path, 'README.md'), 'utf8'),
      ),
    ).toBe('dirty\n');
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('valid');
  });

  it('refuses to move a session that already has a worktree', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_handoff_unsupported');
  });

  it('hands a worktree session back to local, carrying commits and dirty state', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    // A commit and a tracked dirty change inside the worktree.
    writeFileSync(path.join(fixture.worktreeDir, 'work.txt'), 'work\n');
    git(fixture.worktreeDir, 'add', 'work.txt');
    git(fixture.worktreeDir, 'commit', '-qm', 'session work', '--no-verify');
    writeFileSync(path.join(fixture.worktreeDir, 'README.md'), 'dirty\n');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local', name: 'feat/handed-off' });

    expect(res.status).toBe(200);
    expect(res.body.worktree).toBeNull();
    expect(res.body.currentCwd).toBe(fixture.workspaceDir);
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'feat/handed-off',
    );
    expect(existsSync(path.join(fixture.workspaceDir, 'work.txt'))).toBe(true);
    expect(
      await import('node:fs/promises').then((fs) =>
        fs.readFile(path.join(fixture.workspaceDir, 'README.md'), 'utf8'),
      ),
    ).toBe('dirty\n');
    expect(fixture.clearWorktreeCalls).toEqual([fixture.sessionId]);
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('missing');
  });

  it('refuses handoff to a dirty local checkout', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    writeFileSync(
      path.join(fixture.workspaceDir, 'README.md'),
      'local-dirty\n',
    );

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('local_checkout_dirty');
  });

  it('refuses handoff to local for a session without a worktree', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_handoff_unsupported');
  });

  it('rejects an invalid target with 400', async () => {
    const fixture = makeFixture();

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'elsewhere' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_handoff_target');
  });

  it('refuses an occupied auto branch name with the typed 409', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    // A commit makes the worktree eligible for auto branch promotion.
    writeFileSync(path.join(fixture.worktreeDir, 'work.txt'), 'work\n');
    git(fixture.worktreeDir, 'add', 'work.txt');
    git(fixture.worktreeDir, 'commit', '-qm', 'agent work', '--no-verify');
    // Occupy the auto name worktree-<slug>.
    git(fixture.workspaceDir, 'branch', `worktree-${fixture.slug}`);

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('branch_already_exists');
  });

  it('refuses handoff to local for a superseded sidecar', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    await writeWorktreeSession(
      fixture.sessionService.getWorktreeSessionPath(fixture.sessionId),
      {
        slug: fixture.slug,
        worktreePath: fixture.worktreeDir,
        worktreeBranch: '',
        originalCwd: fixture.workspaceDir,
        workspaceCwd: fixture.workspaceDir,
        originalBranch: 'main',
        originalHeadCommit: git(fixture.workspaceDir, 'rev-parse', 'HEAD'),
        supersededBy: randomUUID(),
      },
    );

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_reset_invalid_state');
  });
});
