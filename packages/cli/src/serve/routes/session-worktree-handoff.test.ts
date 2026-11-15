/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
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
  SessionResetPendingError,
  type AcpSessionBridge,
} from '../acp-session-bridge.js';
import { sendBridgeError } from '../server/error-response.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerSessionRoutes } from './session.js';

// Canonicalize: macOS's default TMPDIR is a /var -> /private/var symlink,
// and the routes realpath their targets while plain fixture paths would
// not match.
const tmpRoot = realpathSync(
  mkdtempSync(path.join(tmpdir(), 'session-worktree-handoff-')),
);
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeFixture(opts: { subdir?: string } = {}) {
  const repoRoot = mkdtempSync(path.join(tmpRoot, 'ws-'));
  git(repoRoot, 'init', '-q', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 't@e.com');
  git(repoRoot, 'config', 'user.name', 't');
  git(repoRoot, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoRoot, 'README.md'), 'base\n');
  if (opts.subdir) {
    mkdirSync(path.join(repoRoot, opts.subdir), { recursive: true });
    writeFileSync(path.join(repoRoot, opts.subdir, 'README.md'), 'sub\n');
  }
  // Deliberately no committed `.qwen/` ignore rule: a pristine repo must
  // stay clean through worktree provisioning (the mechanism ignores its
  // own worktrees directory via info/exclude), so the handoff local-clean
  // gate is exercised on the real first-use shape.
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-qm', 'init', '--no-verify');
  const workspaceDir = opts.subdir
    ? path.join(repoRoot, opts.subdir)
    : repoRoot;

  const runtimeBaseDir = mkdtempSync(path.join(tmpRoot, 'rt-'));
  const sessionService = new SessionService(workspaceDir, { runtimeBaseDir });
  const sessionId = randomUUID();
  const summaries = new Map<
    string,
    { hasActivePrompt: boolean; pendingPromptCount?: number }
  >([[sessionId, { hasActivePrompt: false }]]);
  const cdCalls: Array<{ sessionId: string; path: string }> = [];
  const setWorktreeCalls: unknown[][] = [];
  const clearWorktreeCalls: string[] = [];
  const resetPendingCalls: Array<[string, string]> = [];
  const gateOrder: string[] = [];
  // Model the bridge's admission fence: the handoff routes arm it and then
  // relocate with allowWhileResetPending — without the exemption the real
  // bridge refuses every handoff, so the fixture must refuse it too.
  const resetPending = new Set<string>();
  let effectiveCwd = workspaceDir;
  let cdGate: Promise<void> | null = null;
  let cdReject = false;
  const bridge = {
    getSessionSummary: (id: string) => {
      gateOrder.push(`summary:${id}`);
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
      req: { path: string; allowWhileResetPending?: boolean },
    ): Promise<{
      previousCwd: string;
      newCwd: string;
      warnings: string[];
    }> => {
      cdCalls.push({ sessionId: id, path: req.path });
      if (resetPending.has(id) && req.allowWhileResetPending !== true) {
        throw new SessionResetPendingError(id);
      }
      if (cdGate) await cdGate;
      if (cdReject) {
        return {
          previousCwd: effectiveCwd,
          newCwd: `${req.path}-rejected`,
          warnings: [],
        };
      }
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
    setSessionResetPending: (id: string) => {
      resetPendingCalls.push(['set', id]);
      gateOrder.push(`arm:${id}`);
      resetPending.add(id);
      return true;
    },
    clearSessionResetPending: (id: string) => {
      resetPendingCalls.push(['clear', id]);
      resetPending.delete(id);
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
    repoRoot,
    worktreeDir,
    slug,
    service,
    sessionService,
    sessionId,
    app,
    cdCalls,
    setWorktreeCalls,
    clearWorktreeCalls,
    resetPendingCalls,
    gateOrder,
    summaries,
    setCdGate(gate: Promise<void> | null) {
      cdGate = gate;
    },
    setCdReject(reject: boolean) {
      cdReject = reject;
    },
    setEffectiveCwd(cwd: string) {
      effectiveCwd = cwd;
    },
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
    // The "Create branch here" shape: the worktree sits on a named branch
    // the sidecar records, so the handoff skips the promotion block.
    async createBranchedWorktree(branch: string): Promise<void> {
      const result = await service.createUserWorktree(slug, 'main', {
        detached: true,
      });
      if (!result.success) throw new Error(result.error);
      git(worktreeDir, 'checkout', '-q', '-b', branch);
      await createWorktreeSessionMarkerExclusive(worktreeDir, sessionId);
      await writeWorktreeSession(
        sessionService.getWorktreeSessionPath(sessionId),
        {
          slug,
          worktreePath: worktreeDir,
          worktreeBranch: branch,
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

  it('hands a pristine-repo session back to local with an auto branch', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    writeFileSync(path.join(fixture.worktreeDir, 'work.txt'), 'work\n');
    git(fixture.worktreeDir, 'add', 'work.txt');
    git(fixture.worktreeDir, 'commit', '-qm', 'agent work', '--no-verify');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    // The local checkout never had a user edit: provisioning must not
    // count as dirty, and the auto branch must carry the commit back.
    expect(res.status).toBe(200);
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      `worktree-${fixture.slug}`,
    );
    expect(existsSync(path.join(fixture.workspaceDir, 'work.txt'))).toBe(true);
  });

  it('refuses handoff to local while a prompt is active', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    fixture.summaries.set(fixture.sessionId, { hasActivePrompt: true });

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('cd_while_prompt_active');
    expect(fixture.cdCalls).toHaveLength(0);
  });

  it('refuses handoff while a prompt is admitted but not yet active', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    // The attachment-resolution window: admitted (pendingPromptCount > 0)
    // but promptActive still false — hasActivePrompt alone reads quiescent.
    fixture.summaries.set(fixture.sessionId, {
      hasActivePrompt: false,
      pendingPromptCount: 1,
    });

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('cd_while_prompt_active');
    expect(fixture.cdCalls).toHaveLength(0);
  });

  it('refuses handoff to worktree while a prompt is active', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    fixture.summaries.set(fixture.sessionId, { hasActivePrompt: true });

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('cd_while_prompt_active');
    expect(fixture.cdCalls).toHaveLength(0);
  });

  it('refuses handoff to local when the recorded base is missing', async () => {
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
        originalHeadCommit: '',
      },
    );

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_handoff_base_unavailable');
  });

  it('carries work back from a subdirectory workspace', async () => {
    const fixture = makeFixture({ subdir: 'sub' });
    fixture.writeTranscript();

    const toWorktree = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' });
    expect(toWorktree.status).toBe(200);
    const wtPath = toWorktree.body.worktree.path as string;
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('valid');
    if (sidecar.state === 'valid') {
      expect(sidecar.session.originalHeadCommit).toBe(
        git(fixture.repoRoot, 'rev-parse', 'HEAD'),
      );
    }

    writeFileSync(path.join(wtPath, 'sub', 'new.txt'), 'work\n');
    git(wtPath, 'add', 'sub/new.txt');
    git(wtPath, 'commit', '-qm', 'agent work', '--no-verify');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local', name: 'feat/sub' });

    expect(res.status).toBe(200);
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'feat/sub',
    );
    // workspaceDir is already <repo>/sub; the tracked path sub/new.txt
    // lands at <repo>/sub/new.txt = workspaceDir/new.txt.
    expect(existsSync(path.join(fixture.workspaceDir, 'new.txt'))).toBe(true);
  });

  it('carries untracked worktree files back to the local checkout', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    writeFileSync(path.join(fixture.worktreeDir, 'work.txt'), 'work\n');
    git(fixture.worktreeDir, 'add', 'work.txt');
    git(fixture.worktreeDir, 'commit', '-qm', 'agent work', '--no-verify');
    writeFileSync(path.join(fixture.worktreeDir, 'untracked.txt'), 'new\n');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(200);
    expect(existsSync(path.join(fixture.workspaceDir, 'untracked.txt'))).toBe(
      true,
    );
  });

  it('does not promote a branch when the worktree sits at its base', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(200);
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'main',
    );
    expect(git(fixture.workspaceDir, 'branch', '--list', 'worktree-*')).toBe(
      '',
    );
  });

  it('refuses handoff when the local HEAD moved past the base', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    writeFileSync(path.join(fixture.worktreeDir, 'work.txt'), 'work\n');
    git(fixture.worktreeDir, 'add', 'work.txt');
    git(fixture.worktreeDir, 'commit', '-qm', 'agent work', '--no-verify');
    // A clean but moved-ahead local checkout.
    writeFileSync(path.join(fixture.workspaceDir, 'local.txt'), 'local\n');
    git(fixture.workspaceDir, 'add', 'local.txt');
    git(fixture.workspaceDir, 'commit', '-qm', 'local work', '--no-verify');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('local_head_moved');
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'main',
    );
  });

  it('rejects an empty branch name with 400', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local', name: '' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('branch_invalid_name');
  });

  it('rolls the local checkout back when relocation is rejected', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    writeFileSync(path.join(fixture.worktreeDir, 'work.txt'), 'work\n');
    git(fixture.worktreeDir, 'add', 'work.txt');
    git(fixture.worktreeDir, 'commit', '-qm', 'agent work', '--no-verify');
    writeFileSync(path.join(fixture.worktreeDir, 'untracked.txt'), 'new\n');
    fixture.setCdReject(true);

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(500);
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'main',
    );
    expect(git(fixture.workspaceDir, 'status', '--porcelain')).toBe('');
    expect(git(fixture.workspaceDir, 'branch', '--list', 'worktree-*')).toBe(
      '',
    );
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('valid');
    if (sidecar.state === 'valid') {
      expect(sidecar.session.worktreeBranch).toBe('');
    }
  });

  it('rolls back the applied stash when relocation is rejected at base', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    // Tracked dirty change without a commit: no branch is promoted, but
    // the stash still applies to local before the relocation fails.
    writeFileSync(path.join(fixture.worktreeDir, 'README.md'), 'dirty\n');
    fixture.setCdReject(true);

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(500);
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'main',
    );
    expect(git(fixture.workspaceDir, 'status', '--porcelain')).toBe('');
  });

  it('rolls back when the local checkout hook refuses the checkout', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    writeFileSync(path.join(fixture.worktreeDir, 'work.txt'), 'work\n');
    git(fixture.worktreeDir, 'add', 'work.txt');
    git(fixture.worktreeDir, 'commit', '-qm', 'agent work', '--no-verify');
    // A failing post-checkout hook in the local checkout: the checkout
    // itself lands, then the hook errors — the rollback must still
    // restore the original branch and drop the auto-created one.
    // Outside the repo: an untracked hooks dir inside would trip the
    // local-clean gate before the checkout step is reached.
    const hooksDir = path.join(path.dirname(fixture.repoRoot), 'fault-hooks');
    mkdirSync(hooksDir, { recursive: true });
    const hook = path.join(hooksDir, 'post-checkout');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    // --worktree scopes the fault to the main checkout: a plain config
    // write lands in the shared config, which the managed worktree also
    // reads (configureHooksPath writes there), and the creation step
    // would fail before the local checkout is ever touched.
    git(fixture.workspaceDir, 'config', 'extensions.worktreeConfig', 'true');
    git(
      fixture.workspaceDir,
      'config',
      '--worktree',
      'core.hooksPath',
      hooksDir,
    );

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_checkout_failed');
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'main',
    );
    expect(git(fixture.workspaceDir, 'branch', '--list', 'worktree-*')).toBe(
      '',
    );
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('valid');
    if (sidecar.state === 'valid') {
      expect(sidecar.session.worktreeBranch).toBe('');
    }
  });

  it('serializes overlapping handoffs on the ownership lock', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.setCdGate(gate);

    // .then() starts the supertest request (it is lazy until then).
    const first = request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' })
      .then((r) => r);
    // Let the first request reach the gated relocation (poll: the git
    // probes ahead of it can exceed a fixed sleep on a loaded machine).
    const deadline = Date.now() + 10000;
    while (fixture.cdCalls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(fixture.cdCalls).toHaveLength(1);
    const second = request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' })
      .then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The second request must still be waiting on the ownership lock.
    expect(fixture.cdCalls).toHaveLength(1);
    release();
    const firstRes = await first;
    const secondRes = await second;
    expect(firstRes.status).toBe(200);
    // The second request observes the post-handoff state, not a race.
    expect(secondRes.status).toBe(409);
    expect(fixture.cdCalls).toHaveLength(1);
  });

  it('refuses handoff when the worktree branch drifted from the sidecar', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    // The agent branches in place and commits; the sidecar still says ''.
    git(fixture.worktreeDir, 'switch', '-c', 'feat/agent');
    writeFileSync(path.join(fixture.worktreeDir, 'work.txt'), 'work\n');
    git(fixture.worktreeDir, 'add', 'work.txt');
    git(fixture.worktreeDir, 'commit', '-qm', 'agent work', '--no-verify');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_branch_mismatch');
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'main',
    );
  });

  it('migrates legacy daemon residue before the local-clean gate', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    // An upgraded checkout still holds the old daemon-written file.
    writeFileSync(
      path.join(fixture.workspaceDir, '.qwen', '.gitignore'),
      '# Auto-generated by qwen-code.\nworktrees/\n',
    );

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(200);
    expect(
      existsSync(path.join(fixture.workspaceDir, '.qwen', '.gitignore')),
    ).toBe(false);
  });

  it('migrates legacy residue on a pre-PR checkout with no exclude rule', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    // Simulate a worktree created by a pre-PR build: the worktrees exclude
    // rule does not exist, and the legacy file is the only mechanism hiding
    // the managed directory. Removing it without a replacement would leave
    // the worktree untracked and the clean gate would 409 every handoff.
    // (Keep the marker rules: a real pre-PR worktree has no marker at all,
    // and wiping them would make the untracked carry copy the fixture's
    // marker into the local checkout — an artifact, not the upgrade path.)
    const excludeRel = git(
      fixture.workspaceDir,
      'rev-parse',
      '--git-path',
      'info/exclude',
    );
    const excludePath = path.resolve(fixture.workspaceDir, excludeRel);
    const kept = readFileSync(excludePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '/.qwen/worktrees/')
      .join('\n');
    writeFileSync(excludePath, kept);
    writeFileSync(
      path.join(fixture.workspaceDir, '.qwen', '.gitignore'),
      '# Auto-generated by qwen-code.\nworktrees/\n',
    );

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(200);
    expect(
      existsSync(path.join(fixture.workspaceDir, '.qwen', '.gitignore')),
    ).toBe(false);
    expect(git(fixture.workspaceDir, 'status', '--porcelain')).toBe('');
  });

  it('arms the admission barrier for the transfer and clears it after', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    writeFileSync(path.join(fixture.worktreeDir, 'work.txt'), 'work\n');
    git(fixture.worktreeDir, 'add', 'work.txt');
    git(fixture.worktreeDir, 'commit', '-qm', 'agent work', '--no-verify');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(200);
    expect(fixture.resetPendingCalls).toEqual([
      ['set', fixture.sessionId],
      ['clear', fixture.sessionId],
    ]);
  });

  it('clears the admission barrier when the transfer fails', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    fixture.setCdReject(true);

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(500);
    expect(fixture.resetPendingCalls).toEqual([
      ['set', fixture.sessionId],
      ['clear', fixture.sessionId],
    ]);
  });

  it('places the worktree at the workspace root for a cd-into-subdir session', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    const pkgDir = path.join(fixture.workspaceDir, 'pkg');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, 'README.md'), 'pkg\n');
    git(fixture.workspaceDir, 'add', 'pkg');
    git(fixture.workspaceDir, 'commit', '-qm', 'pkg', '--no-verify');
    fixture.setEffectiveCwd(pkgDir);

    const toWorktree = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' });
    expect(toWorktree.status).toBe(200);
    const wtPath = toWorktree.body.worktree.path as string;
    expect(wtPath.startsWith(path.join(fixture.workspaceDir, '.qwen'))).toBe(
      true,
    );
    expect(existsSync(path.join(pkgDir, '.qwen'))).toBe(false);
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('valid');
    if (sidecar.state === 'valid') {
      expect(sidecar.session.originalCwd).toBe(fixture.workspaceDir);
    }

    const toLocal = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });
    expect(toLocal.status).toBe(200);
  });

  it('hands off a worktree that already sits on its recorded branch', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createBranchedWorktree('feat/agent');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(200);
    expect(res.body.worktree).toBeNull();
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'feat/agent',
    );
    // The worktree stays detached at the same commit after releasing the
    // branch to the local checkout.
    expect(git(fixture.worktreeDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'HEAD',
    );
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('missing');
  });

  it('re-attaches the recorded branch when a named-branch handoff fails late', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createBranchedWorktree('feat/agent');
    fixture.setCdReject(true);

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(500);
    // Without the re-attach the worktree stays detached while the sidecar
    // still records feat/agent, and every retry 409s branch_mismatch.
    expect(git(fixture.worktreeDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'feat/agent',
    );
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'main',
    );
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('valid');
    if (sidecar.state === 'valid') {
      expect(sidecar.session.worktreeBranch).toBe('feat/agent');
    }

    fixture.setCdReject(false);
    const retry = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });
    expect(retry.status).toBe(200);
  });

  it('rolls back a failed to=worktree relocation', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    fixture.setCdReject(true);

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' });

    expect(res.status).toBe(500);
    const wtRoot = path.join(fixture.workspaceDir, '.qwen', 'worktrees');
    expect(existsSync(wtRoot) ? readdirSync(wtRoot) : []).toHaveLength(0);
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('missing');

    fixture.setCdReject(false);
    const retry = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' });
    expect(retry.status).toBe(200);
  });

  it('refuses to=worktree over a corrupt sidecar instead of orphaning it', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    const sidecarPath = fixture.sessionService.getWorktreeSessionPath(
      fixture.sessionId,
    );
    mkdirSync(path.dirname(sidecarPath), { recursive: true });
    writeFileSync(sidecarPath, '{', 'utf8');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_reset_invalid_state');
    const wtRoot = path.join(fixture.workspaceDir, '.qwen', 'worktrees');
    expect(existsSync(wtRoot) ? readdirSync(wtRoot) : []).toHaveLength(0);
  });

  it('serializes concurrent to=worktree requests under the ownership lock', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    // Hold the FIRST request inside createUserWorktree — before the sidecar
    // write — so the second request must contend for the ownership lock.
    // (Gating at changeSessionCwd would let the second fail on the
    // sidecar-existence guard without ever touching the lock, and the test
    // would pass with the lock removed.)
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const originalCreate = GitWorktreeService.prototype.createUserWorktree;
    let held = false;
    const createSpy = vi
      .spyOn(GitWorktreeService.prototype, 'createUserWorktree')
      .mockImplementation(async function (
        this: GitWorktreeService,
        ...args: Parameters<typeof originalCreate>
      ) {
        if (!held) {
          held = true;
          await createGate;
        }
        return originalCreate.apply(this, args);
      });

    const first = request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' })
      .then((r) => r);
    await vi.waitFor(() => expect(held).toBe(true));
    const second = request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' })
      .then((r) => r);
    // Give the second request time to reach the lock (with the lock
    // removed it would proceed and create a second worktree here).
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseCreate();

    const [firstRes, secondRes] = await Promise.all([first, second]);
    createSpy.mockRestore();
    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(409);
    expect(secondRes.body.code).toBe('worktree_handoff_unsupported');
    const wtRoot = path.join(fixture.workspaceDir, '.qwen', 'worktrees');
    expect(readdirSync(wtRoot)).toHaveLength(1);
  });

  it('arms the barrier before reading the busy gate on to=worktree', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' });

    expect(res.status).toBe(200);
    // A prompt admitted between the gate read and the arm would slip past
    // both; the arm must come first. Pin the sequence, not just the gate.
    // (An earlier existence-check read may precede the arm; the busy gate
    // is the last summary read before the relocation.)
    const arm = fixture.gateOrder.indexOf(`arm:${fixture.sessionId}`);
    const gateRead = fixture.gateOrder.lastIndexOf(
      `summary:${fixture.sessionId}`,
    );
    expect(arm).toBeGreaterThanOrEqual(0);
    expect(gateRead).toBeGreaterThan(arm);
  });

  it('keeps the recorded base and originalCwd describing one checkout (sibling cwd)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    // A sibling checkout one commit ahead of the workspace root, reachable
    // through /cd. The sidecar records originalCwd = workspace root, so the
    // base must be the ROOT's HEAD — otherwise the return leg compares the
    // root's HEAD against the sibling's and 409s local_head_moved forever.
    const sibling = await fixture.service.createUserWorktree(
      'sibling',
      'main',
      { detached: true },
    );
    expect(sibling.success).toBe(true);
    const siblingPath = sibling.worktree!.path;
    writeFileSync(path.join(siblingPath, 'ahead.txt'), 'ahead\n');
    git(siblingPath, 'add', 'ahead.txt');
    git(siblingPath, 'commit', '-qm', 'sibling work', '--no-verify');
    const rootHead = git(fixture.workspaceDir, 'rev-parse', 'HEAD');
    expect(git(siblingPath, 'rev-parse', 'HEAD')).not.toBe(rootHead);
    fixture.setEffectiveCwd(siblingPath);

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' });

    expect(res.status).toBe(200);
    expect(git(res.body.worktree.path, 'rev-parse', 'HEAD')).toBe(rootHead);
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('valid');
    if (sidecar.state === 'valid') {
      expect(sidecar.session.originalHeadCommit).toBe(rootHead);
      expect(sidecar.session.originalCwd).toBe(fixture.workspaceDir);
    }

    // The return leg must succeed, not 409 local_head_moved.
    const back = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });
    expect(back.status).toBe(200);
    expect(back.body.worktree).toBeNull();
  });

  it('keeps the sidecar naming the auto branch when detach fails mid-promotion', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    // A commit makes the promotion create the auto branch; then detach
    // fails (a concurrent index.lock is enough). The rollback cannot
    // delete a branch the worktree still sits on — it must keep the
    // sidecar naming it, not rewrite '' and wedge every retry.
    writeFileSync(path.join(fixture.worktreeDir, 'work.txt'), 'work\n');
    git(fixture.worktreeDir, 'add', 'work.txt');
    git(fixture.worktreeDir, 'commit', '-qm', 'agent work', '--no-verify');
    const detachSpy = vi
      .spyOn(GitWorktreeService.prototype, 'detachCheckout')
      .mockRejectedValueOnce(new Error('index.lock held'));

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_checkout_failed');
    detachSpy.mockRestore();
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('valid');
    if (sidecar.state === 'valid') {
      expect(sidecar.session.worktreeBranch).toBe('worktree-task');
    }
    expect(git(fixture.worktreeDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'worktree-task',
    );

    // The retry matches the checkout instead of 409ing branch_mismatch.
    const retry = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });
    expect(retry.status).toBe(200);
  });
});
