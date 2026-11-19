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
  statSync,
  symlinkSync,
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
  WorktreeDirtyCarryConflictError,
  createWorktreeSessionMarkerExclusive,
  readWorktreeSessionStrict,
  writeWorktreeSession,
  type ChatRecord,
} from '@qwen-code/qwen-code-core';
import {
  BridgeTimeoutError,
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

// Whether the host filesystem folds final sigma (ς, U+03C2) to sigma (σ,
// U+03C3) as one path — true on macOS's default case-insensitive volumes, false
// on Linux. Gates the Sigma-alias route regression to where the alias is real.
const fsFoldsFinalSigma = (() => {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(tmpdir(), 'qwen-sigma-probe-'));
    writeFileSync(path.join(dir, '\u03c2.env'), '');
    const a = statSync(path.join(dir, '\u03c2.env'));
    const b = statSync(path.join(dir, '\u03c3.env'));
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  } finally {
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    }
  }
})();

function makeFixture(
  opts: { subdir?: string; symlinkWorkspace?: boolean } = {},
) {
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
  let workspaceDir = opts.subdir ? path.join(repoRoot, opts.subdir) : repoRoot;
  if (opts.symlinkWorkspace) {
    // A symlinked workspace root (macOS /var → /private/var shape): the
    // service returns the raw join while the real bridge reports the
    // realpath'd cwd. The fixture's bridge models that canonicalization.
    const link = path.join(tmpRoot, `ws-link-${randomUUID()}`);
    symlinkSync(workspaceDir, link);
    workspaceDir = link;
  }

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
  // Live sessions the bridge reports for the workspace. The handing-off
  // session is seeded as a WORKTREE session below (excluded by the occupancy
  // predicate); a test can add a client-attached non-worktree occupant.
  const workspaceSessions: Array<{
    sessionId: string;
    sourceType?: string;
    worktree?: { path: string };
    clientCount: number;
  }> = [];
  let effectiveCwd = workspaceDir;
  let cdGate: Promise<void> | null = null;
  let cdReject = false;
  let cdLandThenReject = false;
  let cdTimeoutThenLand = false;
  let cdTimeoutAfterLand = false;
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
      if (cdTimeoutThenLand) {
        // A caller-facing timeout that does NOT abort the underlying cd:
        // the route's await rejects now, but the queued cd lands later and
        // updates effectiveCwd AFTER the catch reads it (the real race the
        // observed-state rollback must not delete the checkout for).
        const landed = opts.symlinkWorkspace
          ? realpathSync(req.path)
          : req.path;
        setTimeout(() => {
          effectiveCwd = landed;
        }, 0);
        throw new BridgeTimeoutError('changeSessionCwd', 30_000);
      }
      if (cdTimeoutAfterLand) {
        // The queued cd already landed (effectiveCwd updated) before the
        // caller-facing timeout rejects: the catch observes the new cwd.
        effectiveCwd = opts.symlinkWorkspace
          ? realpathSync(req.path)
          : req.path;
        throw new BridgeTimeoutError('changeSessionCwd', 30_000);
      }
      const previousCwd = effectiveCwd;
      // The real agent canonicalizes the requested path (fs.realpath)
      // before reporting newCwd; model that under a symlinked workspace.
      const landedCwd = opts.symlinkWorkspace
        ? realpathSync(req.path)
        : req.path;
      if (cdLandThenReject) {
        // A caller-facing timeout: the queued cd lands the session in the
        // target directory, but the route's await still rejects.
        effectiveCwd = landedCwd;
        return {
          previousCwd,
          newCwd: `${req.path}-rejected`,
          warnings: [],
        };
      }
      effectiveCwd = landedCwd;
      return { previousCwd, newCwd: landedCwd, warnings: [] };
    },
    setSessionWorktree: (...args: unknown[]) => {
      setWorktreeCalls.push(args);
      const id = args[0] as string;
      const wt = args[1] as { path: string } | undefined;
      const s = workspaceSessions.find((x) => x.sessionId === id);
      if (s) s.worktree = wt ? { path: wt.path } : undefined;
    },
    clearSessionWorktree: (id: string) => {
      clearWorktreeCalls.push(id);
      // A handed-off session becomes a local (non-worktree) occupant, which
      // the occupancy guard must see for a concurrent second handoff (R11-1).
      const s = workspaceSessions.find((x) => x.sessionId === id);
      if (s) s.worktree = undefined;
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
    listWorkspaceSessions: (_cwd: string) => workspaceSessions,
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
  // The handing-off session itself occupies the workspace as a WORKTREE
  // session: the occupancy predicate must exempt it (it runs in its own cwd).
  workspaceSessions.push({
    sessionId,
    worktree: { path: worktreeDir },
    clientCount: 1,
  });

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
    setCdLandThenReject(landThenReject: boolean) {
      cdLandThenReject = landThenReject;
    },
    setCdTimeoutThenLand(timeoutThenLand: boolean) {
      cdTimeoutThenLand = timeoutThenLand;
    },
    setCdTimeoutAfterLand(timeoutAfterLand: boolean) {
      cdTimeoutAfterLand = timeoutAfterLand;
    },
    setEffectiveCwd(cwd: string) {
      effectiveCwd = cwd;
    },
    // Add a live session the bridge reports for the workspace (e.g. a
    // client-attached non-worktree occupant that must block a handoff).
    addWorkspaceSession(session: {
      sessionId: string;
      sourceType?: string;
      worktree?: { path: string };
      clientCount: number;
    }) {
      workspaceSessions.push(session);
    },
    // Simulate a fence armed by ANOTHER operation (e.g. a refused reset):
    // added to the set without a 'set' call from this request, so the test
    // can assert a refusing handoff never clears it.
    seedResetPending(id: string) {
      resetPending.add(id);
    },
    isResetPending(id: string) {
      return resetPending.has(id);
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
    // A concurrent transfer may hold this session's fence; the "already has
    // a managed worktree" 409 exits before arming, so it must not release a
    // fence this request never armed (R8-1).
    fixture.seedResetPending(fixture.sessionId);

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_handoff_unsupported');
    expect(fixture.resetPendingCalls).not.toContainEqual([
      'clear',
      fixture.sessionId,
    ]);
    expect(fixture.isResetPending(fixture.sessionId)).toBe(true);
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
    // A refused reset deliberately leaves this fence armed to stop the
    // superseded session writing into the replacement's checkout. This
    // handoff refuses BEFORE arming its own fence, so it must not release
    // the one the reset is holding (R8-1).
    fixture.seedResetPending(fixture.sessionId);

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_reset_invalid_state');
    expect(fixture.resetPendingCalls).not.toContainEqual([
      'clear',
      fixture.sessionId,
    ]);
    expect(fixture.isResetPending(fixture.sessionId)).toBe(true);
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

  it('refuses handoff to local when another client-attached session occupies the workspace (R9-1)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    // A commit makes the worktree eligible for promotion — a HEAD move of
    // the shared local checkout.
    writeFileSync(path.join(fixture.worktreeDir, 'work.txt'), 'work\n');
    git(fixture.worktreeDir, 'add', 'work.txt');
    git(fixture.worktreeDir, 'commit', '-qm', 'agent work', '--no-verify');
    const localHeadBefore = git(fixture.workspaceDir, 'rev-parse', 'HEAD');
    // A second live client-attached session without a worktree occupies the
    // same local checkout (the branch route refuses this shape too).
    fixture.addWorkspaceSession({ sessionId: 'occupant', clientCount: 1 });

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local', name: 'feat/handed-off' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_workspace_occupied');
    expect(res.body.existingSessionId).toBe('occupant');
    // The shared checkout's HEAD must not move.
    expect(git(fixture.workspaceDir, 'rev-parse', 'HEAD')).toBe(
      localHeadBefore,
    );
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'main',
    );
    expect(fixture.cdCalls).toHaveLength(0);
  });

  it('allows handoff when the other workspace sessions are detached or in a worktree (R9-1)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    writeFileSync(path.join(fixture.worktreeDir, 'work.txt'), 'work\n');
    git(fixture.worktreeDir, 'add', 'work.txt');
    git(fixture.worktreeDir, 'commit', '-qm', 'agent work', '--no-verify');
    // A detached session (no attached client) and a worktree session both
    // run outside the shared checkout's HEAD move and must not block.
    fixture.addWorkspaceSession({ sessionId: 'detached', clientCount: 0 });
    fixture.addWorkspaceSession({
      sessionId: 'other-worktree',
      worktree: {
        path: path.join(fixture.workspaceDir, '.qwen', 'worktrees', 'other'),
      },
      clientCount: 1,
    });

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local', name: 'feat/ok' });

    expect(res.status).toBe(200);
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'feat/ok',
    );
  });

  it('does not rewind the local checkout when the worktree HEAD is behind its base (R9-4)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    // Advance main to a second commit so HEAD~1 exists; the worktree is
    // created at that tip (its recorded base), then the agent checks out the
    // OLDER commit without committing — a detached HEAD behind the base.
    writeFileSync(path.join(fixture.workspaceDir, 'second.txt'), 'second\n');
    git(fixture.workspaceDir, 'add', 'second.txt');
    git(fixture.workspaceDir, 'commit', '-qm', 'second', '--no-verify');
    const base = git(fixture.workspaceDir, 'rev-parse', 'HEAD');
    const older = git(fixture.workspaceDir, 'rev-parse', 'HEAD~1');
    await fixture.createDetachedWorktree();
    git(fixture.worktreeDir, 'checkout', '-q', '--detach', older);

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    // Snapshot-only: the behind-base HEAD is an ancestor, not work moved past
    // the base, so no branch is promoted and the user's checkout stays put.
    expect(res.status).toBe(200);
    expect(res.body.worktree).toBeNull();
    expect(git(fixture.workspaceDir, 'rev-parse', 'HEAD')).toBe(base);
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'main',
    );
    expect(git(fixture.workspaceDir, 'branch', '--list', 'worktree-*')).toBe(
      '',
    );
  });

  it('refuses a recorded branch whose tip is behind the base (R10-1)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    writeFileSync(path.join(fixture.workspaceDir, 'second.txt'), 'second\n');
    git(fixture.workspaceDir, 'add', 'second.txt');
    git(fixture.workspaceDir, 'commit', '-qm', 'second', '--no-verify');
    const base = git(fixture.workspaceDir, 'rev-parse', 'HEAD');
    await fixture.createDetachedWorktree();
    // Reset behind the base, then record a branch ("Create branch here"). The
    // behind-base guard must apply to the recorded-branch shape too, not just
    // the detached promotion.
    git(fixture.worktreeDir, 'reset', '--hard', 'HEAD~1');
    const branchRes = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-branch`)
      .send({ name: 'feat/behind' });
    expect(branchRes.status).toBe(200);

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_head_behind_base');
    expect(git(fixture.workspaceDir, 'rev-parse', 'HEAD')).toBe(base);
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'main',
    );
  });

  it('refuses when the recorded base object is unreadable (R11-14)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    const head = git(fixture.worktreeDir, 'rev-parse', 'HEAD');
    // A syntactically valid but absent base SHA (a pruned sibling's tip): the
    // ancestry probe cannot answer and must fail closed, not promote.
    await writeWorktreeSession(
      fixture.sessionService.getWorktreeSessionPath(fixture.sessionId),
      {
        slug: fixture.slug,
        worktreePath: fixture.worktreeDir,
        worktreeBranch: '',
        originalCwd: fixture.workspaceDir,
        workspaceCwd: fixture.workspaceDir,
        originalBranch: 'main',
        originalHeadCommit: head,
        worktreeBase: '0123456789abcdef0123456789abcdef01234567',
      },
    );

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_handoff_base_unavailable');
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'main',
    );
  });

  it('refuses a divergent-base handoff whose checkout would rewind local work (R11-6)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    const base = git(fixture.workspaceDir, 'rev-parse', 'HEAD');
    // Agent commits in the worktree (a child of the base, not of the local
    // commit below); the user then commits locally, diverging from it.
    writeFileSync(path.join(fixture.worktreeDir, 'agent.txt'), 'agent\n');
    git(fixture.worktreeDir, 'add', 'agent.txt');
    git(fixture.worktreeDir, 'commit', '-qm', 'agent', '--no-verify');
    writeFileSync(path.join(fixture.workspaceDir, 'local.txt'), 'local\n');
    git(fixture.workspaceDir, 'add', 'local.txt');
    git(fixture.workspaceDir, 'commit', '-qm', 'local', '--no-verify');
    const localHead = git(fixture.workspaceDir, 'rev-parse', 'HEAD');
    // The branch-route shape records originalHeadCommit=localHead (so the
    // moved-ahead gate sees localHead===gateBase) and worktreeBase=base.
    await writeWorktreeSession(
      fixture.sessionService.getWorktreeSessionPath(fixture.sessionId),
      {
        slug: fixture.slug,
        worktreePath: fixture.worktreeDir,
        worktreeBranch: '',
        originalCwd: fixture.workspaceDir,
        workspaceCwd: fixture.workspaceDir,
        originalBranch: 'main',
        originalHeadCommit: localHead,
        worktreeBase: base,
      },
    );

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('local_head_moved');
    expect(git(fixture.workspaceDir, 'rev-parse', 'HEAD')).toBe(localHead);
    expect(existsSync(path.join(fixture.workspaceDir, 'local.txt'))).toBe(true);
  });

  it('carries a tracked file deleted into a directory on handoff to local (R11-10)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    writeFileSync(path.join(fixture.workspaceDir, 'docs'), 'tracked-doc\n');
    git(fixture.workspaceDir, 'add', 'docs');
    git(fixture.workspaceDir, 'commit', '-qm', 'docs', '--no-verify');
    await fixture.createDetachedWorktree();
    // Agent: rm docs && mkdir docs && write docs/plan.md (left untracked).
    rmSync(path.join(fixture.worktreeDir, 'docs'));
    mkdirSync(path.join(fixture.worktreeDir, 'docs'));
    writeFileSync(path.join(fixture.worktreeDir, 'docs', 'plan.md'), 'plan\n');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(200);
    expect(
      statSync(path.join(fixture.workspaceDir, 'docs')).isDirectory(),
    ).toBe(true);
    expect(
      readFileSync(path.join(fixture.workspaceDir, 'docs', 'plan.md'), 'utf8'),
    ).toBe('plan\n');
  });

  it('refuses a handoff whose checkout would overwrite a local ignored file', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    writeFileSync(
      path.join(fixture.workspaceDir, '.gitignore'),
      'secret.env\n',
    );
    git(fixture.workspaceDir, 'add', '.gitignore');
    git(fixture.workspaceDir, 'commit', '-qm', 'ignore', '--no-verify');
    await fixture.createDetachedWorktree();
    // The worktree force-adds and commits secret.env, so the promoted branch
    // tracks it; the local checkout has its own ignored copy.
    writeFileSync(
      path.join(fixture.worktreeDir, 'secret.env'),
      'AGENT_TEMPLATE\n',
    );
    git(fixture.worktreeDir, 'add', '-f', 'secret.env');
    git(fixture.worktreeDir, 'commit', '-qm', 'agent secret', '--no-verify');
    writeFileSync(
      path.join(fixture.workspaceDir, 'secret.env'),
      'LOCAL_UNIQUE_SECRET\n',
    );

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    // The clean gate cannot see the ignored file; the checkout must refuse to
    // overwrite it rather than destroy unrecoverable local content.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_checkout_failed');
    expect(
      readFileSync(path.join(fixture.workspaceDir, 'secret.env'), 'utf8'),
    ).toBe('LOCAL_UNIQUE_SECRET\n');
  });

  it('refuses a file-to-directory carry that would clobber a local commit', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    // Worktree (still at the base): delete README.md into a directory.
    rmSync(path.join(fixture.worktreeDir, 'README.md'));
    mkdirSync(path.join(fixture.worktreeDir, 'README.md'));
    writeFileSync(
      path.join(fixture.worktreeDir, 'README.md', 'agent.txt'),
      'agent\n',
    );
    // The user commits new README.md content locally (ahead of the base).
    writeFileSync(
      path.join(fixture.workspaceDir, 'README.md'),
      'LOCAL_NEW_CONTENT\n',
    );
    git(fixture.workspaceDir, 'add', 'README.md');
    git(fixture.workspaceDir, 'commit', '-qm', 'local readme', '--no-verify');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    // The stash omits the file->directory deletion, so the supplemental
    // removal must apply the same conflict rule as the snapshot apply.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_snapshot_conflict');
    expect(
      readFileSync(path.join(fixture.workspaceDir, 'README.md'), 'utf8'),
    ).toBe('LOCAL_NEW_CONTENT\n');
  });

  it('refuses a snapshot apply that would overwrite a local ignored file at base (R12-2)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    writeFileSync(
      path.join(fixture.workspaceDir, '.gitignore'),
      'secret.env\n',
    );
    git(fixture.workspaceDir, 'add', '.gitignore');
    git(fixture.workspaceDir, 'commit', '-qm', 'ignore', '--no-verify');
    await fixture.createDetachedWorktree();
    // The worktree force-adds secret.env but does NOT commit it: HEAD stays
    // at the base (branch '', head === base), so no branch checkout runs and
    // --no-overwrite-ignore never fires. The staged file rides the stash
    // snapshot, whose apply would silently replace the local ignored copy.
    writeFileSync(
      path.join(fixture.worktreeDir, 'secret.env'),
      'AGENT_TEMPLATE\n',
    );
    git(fixture.worktreeDir, 'add', '-f', 'secret.env');
    writeFileSync(
      path.join(fixture.workspaceDir, 'secret.env'),
      'LOCAL_UNIQUE_SECRET\n',
    );

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_snapshot_conflict');
    expect(
      readFileSync(path.join(fixture.workspaceDir, 'secret.env'), 'utf8'),
    ).toBe('LOCAL_UNIQUE_SECRET\n');
  });

  it('refuses a snapshot apply that would overwrite an ignored file in a subdirectory workspace (R15-1)', async () => {
    const fixture = makeFixture({ subdir: 'app' });
    fixture.writeTranscript();
    writeFileSync(path.join(fixture.repoRoot, '.gitignore'), 'secret.env\n');
    git(fixture.repoRoot, 'add', '.gitignore');
    git(fixture.repoRoot, 'commit', '-qm', 'ignore', '--no-verify');
    await fixture.createDetachedWorktree();
    // The snapshot's path is repository-relative (app/secret.env) while the
    // local checkout is the app/ subdirectory: enumerating ignored files from
    // the subdir would miss it and let the apply overwrite the local copy.
    writeFileSync(
      path.join(fixture.worktreeDir, 'app', 'secret.env'),
      'AGENT_TEMPLATE\n',
    );
    git(fixture.worktreeDir, 'add', '-f', 'app/secret.env');
    writeFileSync(
      path.join(fixture.workspaceDir, 'secret.env'),
      'LOCAL_UNIQUE_SECRET\n',
    );

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_snapshot_conflict');
    expect(
      readFileSync(path.join(fixture.workspaceDir, 'secret.env'), 'utf8'),
    ).toBe('LOCAL_UNIQUE_SECRET\n');
  });

  it('refuses a snapshot file that would replace an ignored directory (R15-2)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    writeFileSync(path.join(fixture.workspaceDir, '.gitignore'), 'secret\n');
    git(fixture.workspaceDir, 'add', '.gitignore');
    git(fixture.workspaceDir, 'commit', '-qm', 'ignore', '--no-verify');
    await fixture.createDetachedWorktree();
    // The worktree carries a regular file `secret`; the local checkout holds
    // ignored content at secret/unique.txt. Applying would replace the
    // directory and destroy unique.txt (exact-path equality alone misses it).
    writeFileSync(path.join(fixture.worktreeDir, 'secret'), 'AGENT_FILE\n');
    git(fixture.worktreeDir, 'add', '-f', 'secret');
    mkdirSync(path.join(fixture.workspaceDir, 'secret'));
    writeFileSync(
      path.join(fixture.workspaceDir, 'secret', 'unique.txt'),
      'LOCAL_UNIQUE\n',
    );

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_snapshot_conflict');
    expect(
      readFileSync(
        path.join(fixture.workspaceDir, 'secret', 'unique.txt'),
        'utf8',
      ),
    ).toBe('LOCAL_UNIQUE\n');
  });

  it('refuses a case-aliased snapshot overwrite on a case-insensitive target (R15-3)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    writeFileSync(
      path.join(fixture.workspaceDir, '.gitignore'),
      'secret.env\n',
    );
    git(fixture.workspaceDir, 'add', '.gitignore');
    git(fixture.workspaceDir, 'commit', '-qm', 'ignore', '--no-verify');
    await fixture.createDetachedWorktree();
    writeFileSync(
      path.join(fixture.worktreeDir, 'SECRET.env'),
      'AGENT_TEMPLATE\n',
    );
    git(fixture.worktreeDir, 'add', '-f', 'SECRET.env');
    // Force core.ignorecase to exercise the case-folding path on a
    // case-sensitive host: SECRET.env and secret.env name one file on a
    // case-insensitive filesystem.
    git(fixture.repoRoot, 'config', 'core.ignorecase', 'true');
    writeFileSync(
      path.join(fixture.workspaceDir, 'secret.env'),
      'LOCAL_UNIQUE_SECRET\n',
    );

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_snapshot_conflict');
    expect(
      readFileSync(path.join(fixture.workspaceDir, 'secret.env'), 'utf8'),
    ).toBe('LOCAL_UNIQUE_SECRET\n');
  });

  it('refuses a snapshot directory that would replace an ignored local file (R16-1)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    writeFileSync(path.join(fixture.workspaceDir, '.gitignore'), 'secret\n');
    git(fixture.workspaceDir, 'add', '.gitignore');
    git(fixture.workspaceDir, 'commit', '-qm', 'ignore', '--no-verify');
    await fixture.createDetachedWorktree();
    // The worktree carries secret/agent.txt; the local holds an ignored regular
    // FILE secret. Applying would replace the file with a directory.
    mkdirSync(path.join(fixture.worktreeDir, 'secret'));
    writeFileSync(
      path.join(fixture.worktreeDir, 'secret', 'agent.txt'),
      'agent\n',
    );
    git(fixture.worktreeDir, 'add', '-f', 'secret/agent.txt');
    writeFileSync(path.join(fixture.workspaceDir, 'secret'), 'LOCAL_UNIQUE\n');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_snapshot_conflict');
    expect(
      readFileSync(path.join(fixture.workspaceDir, 'secret'), 'utf8'),
    ).toBe('LOCAL_UNIQUE\n');
    expect(statSync(path.join(fixture.workspaceDir, 'secret')).isFile()).toBe(
      true,
    );
  });

  it('refuses a Unicode-equivalent snapshot path (R16-2)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    const nfc = 'caf\u00e9.env';
    const nfd = 'cafe\u0301.env';
    writeFileSync(path.join(fixture.workspaceDir, '.gitignore'), nfc + '\n');
    git(fixture.workspaceDir, 'add', '.gitignore');
    git(fixture.workspaceDir, 'commit', '-qm', 'ignore', '--no-verify');
    await fixture.createDetachedWorktree();
    writeFileSync(path.join(fixture.worktreeDir, nfd), 'AGENT_TEMPLATE\n');
    git(fixture.worktreeDir, 'add', '-f', nfd);
    writeFileSync(path.join(fixture.workspaceDir, nfc), 'LOCAL_UNIQUE\n');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_snapshot_conflict');
    expect(readFileSync(path.join(fixture.workspaceDir, nfc), 'utf8')).toBe(
      'LOCAL_UNIQUE\n',
    );
  });

  it.skipIf(!fsFoldsFinalSigma)(
    'refuses a final-sigma case alias on a case-insensitive filesystem (R17-1)',
    async () => {
      const fixture = makeFixture();
      fixture.writeTranscript();
      const finalSigma = '\u03c2.env';
      const sigma = '\u03c3.env';
      writeFileSync(path.join(fixture.workspaceDir, '.gitignore'), '*.env\n');
      git(fixture.workspaceDir, 'add', '.gitignore');
      git(fixture.workspaceDir, 'commit', '-qm', 'ignore', '--no-verify');
      await fixture.createDetachedWorktree();
      writeFileSync(path.join(fixture.worktreeDir, sigma), 'AGENT_TEMPLATE\n');
      git(fixture.worktreeDir, 'add', '-f', sigma);
      writeFileSync(
        path.join(fixture.workspaceDir, finalSigma),
        'LOCAL_UNIQUE\n',
      );

      const res = await request(fixture.app)
        .post(`/session/${fixture.sessionId}/worktree-handoff`)
        .send({ to: 'local' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('handoff_snapshot_conflict');
      expect(
        readFileSync(path.join(fixture.workspaceDir, finalSigma), 'utf8'),
      ).toBe('LOCAL_UNIQUE\n');
    },
  );

  it.skipIf(!fsFoldsFinalSigma)(
    'refuses a snapshot file aliasing an ignored directory (R18-1 macOS)',
    async () => {
      const fixture = makeFixture();
      fixture.writeTranscript();
      const finalSigmaDir = '\u03c2.secret';
      const sigmaFile = '\u03c3.secret';
      writeFileSync(
        path.join(fixture.workspaceDir, '.gitignore'),
        '*.secret\n',
      );
      git(fixture.workspaceDir, 'add', '.gitignore');
      git(fixture.workspaceDir, 'commit', '-qm', 'ignore', '--no-verify');
      await fixture.createDetachedWorktree();
      writeFileSync(path.join(fixture.worktreeDir, sigmaFile), 'AGENT_FILE\n');
      git(fixture.worktreeDir, 'add', '-f', sigmaFile);
      mkdirSync(path.join(fixture.workspaceDir, finalSigmaDir));
      writeFileSync(
        path.join(fixture.workspaceDir, finalSigmaDir, 'unique.txt'),
        'LOCAL_UNIQUE\n',
      );

      const res = await request(fixture.app)
        .post(`/session/${fixture.sessionId}/worktree-handoff`)
        .send({ to: 'local' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('handoff_snapshot_conflict');
      expect(
        readFileSync(
          path.join(fixture.workspaceDir, finalSigmaDir, 'unique.txt'),
          'utf8',
        ),
      ).toBe('LOCAL_UNIQUE\n');
    },
  );

  it('fails closed when the local checkout is not the bound workspace (R9-1)', async () => {
    // Daemon bound to a subdirectory; a branch-route-shaped sidecar records
    // originalCwd as the repo top. listWorkspaceSessions cannot answer for the
    // repo top, so the occupancy guard must fail closed rather than proceed.
    const fixture = makeFixture({ subdir: 'sub' });
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    await writeWorktreeSession(
      fixture.sessionService.getWorktreeSessionPath(fixture.sessionId),
      {
        slug: fixture.slug,
        worktreePath: fixture.worktreeDir,
        worktreeBranch: '',
        originalCwd: fixture.repoRoot,
        workspaceCwd: fixture.workspaceDir,
        originalBranch: 'main',
        originalHeadCommit: git(fixture.repoRoot, 'rev-parse', 'HEAD'),
      },
    );

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    // No occupant is even needed: the guard cannot enumerate the repo-top
    // checkout's occupants from a subdirectory-bound daemon, so it must fail
    // closed rather than proceed on an empty (unanswerable) session list.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_workspace_occupied');
    expect(git(fixture.repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'main',
    );
  });

  it('serializes two concurrent handoffs into one checkout (R11-1)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    writeFileSync(path.join(fixture.worktreeDir, 'a.txt'), 'a\n');
    git(fixture.worktreeDir, 'add', 'a.txt');
    git(fixture.worktreeDir, 'commit', '-qm', 'a', '--no-verify');

    // A second session in its OWN worktree of the same workspace (a different
    // realTarget lock key), also handing off to local.
    const session2 = randomUUID();
    const slug2 = 'task2';
    const r2 = await fixture.service.createUserWorktree(slug2, 'main', {
      detached: true,
    });
    expect(r2.success).toBe(true);
    const wt2 = r2.worktree!.path;
    writeFileSync(path.join(wt2, 'b.txt'), 'b\n');
    git(wt2, 'add', 'b.txt');
    git(wt2, 'commit', '-qm', 'b', '--no-verify');
    await createWorktreeSessionMarkerExclusive(wt2, session2);
    await writeWorktreeSession(
      fixture.sessionService.getWorktreeSessionPath(session2),
      {
        slug: slug2,
        worktreePath: wt2,
        worktreeBranch: '',
        originalCwd: fixture.workspaceDir,
        workspaceCwd: fixture.workspaceDir,
        originalBranch: 'main',
        originalHeadCommit: git(fixture.workspaceDir, 'rev-parse', 'HEAD'),
      },
    );
    fixture.summaries.set(session2, { hasActivePrompt: false });
    fixture.addWorkspaceSession({
      sessionId: session2,
      worktree: { path: wt2 },
      clientCount: 1,
    });

    const [resA, resB] = await Promise.all([
      request(fixture.app)
        .post(`/session/${fixture.sessionId}/worktree-handoff`)
        .send({ to: 'local', name: 'feat/a' }),
      request(fixture.app)
        .post(`/session/${session2}/worktree-handoff`)
        .send({ to: 'local', name: 'feat/b' }),
    ]);

    // The local-checkout lock serializes them: exactly one lands, the other
    // sees the winner now occupying the checkout and refuses.
    expect([resA.status, resB.status].sort()).toEqual([200, 409]);
    const refused = resA.status === 409 ? resA : resB;
    expect(refused.body.code).toBe('handoff_workspace_occupied');
    // Only the winner's branch was checked out; no interleaved double-move.
    expect(fixture.cdCalls).toHaveLength(1);
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

  it('maps an in-progress merge to 409 on handoff to worktree (R13-2)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    const spy = vi
      .spyOn(GitWorktreeService.prototype, 'createUserWorktree')
      .mockResolvedValueOnce({
        success: false,
        code: 'worktree_merge_in_progress',
        error:
          'The workspace has an in-progress merge or rebase (unmerged files).',
      });
    try {
      const res = await request(fixture.app)
        .post(`/session/${fixture.sessionId}/worktree-handoff`)
        .send({ to: 'worktree' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('worktree_merge_in_progress');
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses handoff to local when the snapshot capture fails silently (R13-1)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    const spy = vi
      .spyOn(GitWorktreeService.prototype, 'createStashSnapshot')
      .mockRejectedValueOnce(new Error('git exited with code 1'));
    try {
      const res = await request(fixture.app)
        .post(`/session/${fixture.sessionId}/worktree-handoff`)
        .send({ to: 'local' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('handoff_carry_failed');
    } finally {
      spy.mockRestore();
    }
  });

  it('surfaces restoreFailed in the conflict refusal detail (6903276958)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    // Dirty the worktree so a non-empty snapshot is captured and the apply
    // path (not the clean-tree skip) runs.
    writeFileSync(path.join(fixture.worktreeDir, 'README.md'), 'dirty\n');
    // A conflict whose own restore failed: rollback force-restores the
    // checkout, so the refusal must not claim a clean restore the service
    // could not make.
    const spy = vi
      .spyOn(GitWorktreeService.prototype, 'applyStashSnapshot')
      .mockRejectedValueOnce(
        new WorktreeDirtyCarryConflictError('conflict', {
          conflict: true,
          restoreFailed: true,
        }),
      );
    try {
      const res = await request(fixture.app)
        .post(`/session/${fixture.sessionId}/worktree-handoff`)
        .send({ to: 'local' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('handoff_snapshot_conflict');
      expect(res.body.detail).toContain('force-restored by rollback');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not claim a restore when rollback force-checkout also fails (round-9 S18)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    writeFileSync(path.join(fixture.worktreeDir, 'README.md'), 'dirty\n');
    // Compound fault: the apply's own restore failed (restoreFailed) AND the
    // same held lock fails rollback's force-checkout. The checkout still holds
    // conflict markers, so the refusal must not claim a restore that never
    // happened.
    const applySpy = vi
      .spyOn(GitWorktreeService.prototype, 'applyStashSnapshot')
      .mockRejectedValueOnce(
        new WorktreeDirtyCarryConflictError('conflict', {
          conflict: true,
          restoreFailed: true,
        }),
      );
    const checkoutSpy = vi
      .spyOn(GitWorktreeService.prototype, 'forceCheckoutBranch')
      .mockRejectedValueOnce(new Error('index lock held'));
    try {
      const res = await request(fixture.app)
        .post(`/session/${fixture.sessionId}/worktree-handoff`)
        .send({ to: 'local' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('handoff_snapshot_conflict');
      expect(res.body.detail).toContain('could not be restored');
      expect(res.body.detail).not.toContain('force-restored by rollback');
    } finally {
      applySpy.mockRestore();
      checkoutSpy.mockRestore();
    }
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

  it('refuses a moved-ahead local checkout when a branch would be checked out (R5-1)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    writeFileSync(path.join(fixture.worktreeDir, 'work.txt'), 'work\n');
    git(fixture.worktreeDir, 'add', 'work.txt');
    git(fixture.worktreeDir, 'commit', '-qm', 'agent work', '--no-verify');
    // A clean local checkout that committed ahead of the base. The
    // worktree has commits, so the handoff would promote a branch and
    // check it out locally — which deletes the user's own ahead-of-base
    // commit from the working tree. The descendant acceptance covers the
    // snapshot-only path, not this combination (R5-1).
    writeFileSync(path.join(fixture.workspaceDir, 'local.txt'), 'local\n');
    git(fixture.workspaceDir, 'add', 'local.txt');
    git(fixture.workspaceDir, 'commit', '-qm', 'local work', '--no-verify');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('local_head_moved');
    // The user's commit survives on disk and on main; no branch switch.
    expect(existsSync(path.join(fixture.workspaceDir, 'local.txt'))).toBe(true);
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'main',
    );
    expect(git(fixture.workspaceDir, 'branch', '--list', 'worktree-*')).toBe(
      '',
    );
    // The sidecar still names the worktree, so a retry after merging the
    // local work matches the checkout.
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('valid');
  });

  it('refuses a moved-ahead local checkout for a named worktree branch (R5-1)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    // "Create branch here": the worktree sits on a named branch the
    // handoff would check out locally even without any new commits.
    await fixture.createBranchedWorktree('feat/in-place');
    writeFileSync(path.join(fixture.workspaceDir, 'local.txt'), 'local\n');
    git(fixture.workspaceDir, 'add', 'local.txt');
    git(fixture.workspaceDir, 'commit', '-qm', 'local work', '--no-verify');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('local_head_moved');
    expect(existsSync(path.join(fixture.workspaceDir, 'local.txt'))).toBe(true);
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
      // to=worktree bases the worktree at the workspace HEAD, so the
      // creation base equals the gate base here.
      expect(sidecar.session.worktreeBase).toBe(rootHead);
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

  it('hands back to local after the local checkout committed ahead', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    // The user commits locally while the agent works in the worktree —
    // the normal reason to use one. A descendant base is reconcilable.
    writeFileSync(path.join(fixture.workspaceDir, 'local.txt'), 'local\n');
    git(fixture.workspaceDir, 'add', 'local.txt');
    git(fixture.workspaceDir, 'commit', '-qm', 'local work', '--no-verify');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(200);
    expect(res.body.worktree).toBeNull();
  });

  it('refuses handoff when the local checkout diverged from the base', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    // An unrelated root commit: not a descendant of the recorded base.
    git(fixture.workspaceDir, 'checkout', '-q', '--orphan', 'unrelated');
    git(
      fixture.workspaceDir,
      'commit',
      '--allow-empty',
      '-qm',
      'unrelated',
      '--no-verify',
    );

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('local_head_moved');
  });

  it('keeps the checkout when a caller-facing timeout still landed the cd', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    fixture.setCdLandThenReject(true);

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' });

    // The queued cd landed the session in the worktree even though the
    // route's await rejected: the checkout and sidecar must survive.
    expect(res.status).toBe(200);
    expect(existsSync(res.body.worktree.path)).toBe(true);
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('valid');
  });

  it('keeps the checkout under a symlinked workspace when the bridge reports the canonical cwd (R6)', async () => {
    // The service returns the raw join (symlink/.qwen/worktrees/<slug>)
    // while the bridge reports the realpath'd cwd. Comparing the observed
    // cwd against the RAW worktree path would roll back the checkout the
    // session now lives in.
    const fixture = makeFixture({ symlinkWorkspace: true });
    fixture.writeTranscript();
    fixture.setCdLandThenReject(true);

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' });

    expect(res.status).toBe(200);
    expect(existsSync(res.body.worktree.path)).toBe(true);
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('valid');
  });

  it('keeps the checkout when a caller-facing timeout lands the cd AFTER the catch reads the cwd (R7)', async () => {
    // withTimeout only ends the caller's wait; the queued cd keeps running
    // and updates effectiveCwd later. The catch reads a STALE cwd (still the
    // local checkout), so an observed-state rollback would delete the
    // worktree the session is about to inhabit. An undetermined timeout must
    // keep the checkout + sidecar, not roll back.
    const fixture = makeFixture();
    fixture.writeTranscript();
    fixture.setCdTimeoutThenLand(true);

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' });

    // The timeout surfaces as an error, but the checkout and sidecar
    // survive for the late-landing cd (no rollback on an undetermined cd).
    expect(res.status).toBeGreaterThanOrEqual(400);
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('valid');
    if (sidecar.state === 'valid') {
      expect(existsSync(sidecar.session.worktreePath)).toBe(true);
    }
    // Let the queued cd land; the session's home must still exist.
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (sidecar.state === 'valid') {
      expect(existsSync(sidecar.session.worktreePath)).toBe(true);
    }
  });

  it('hands back a branch-route sidecar whose base names the repo top', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    // The branch route creates a NAMED worktree at the source checkout's
    // commit but records originalCwd = repo top with the repo top's HEAD
    // as the base. The worktree sits at a different commit than the root.
    const result = await fixture.service.createUserWorktree(
      fixture.slug,
      'main',
    );
    expect(result.success).toBe(true);
    git(fixture.worktreeDir, 'checkout', '-q', 'worktree-task');
    writeFileSync(path.join(fixture.worktreeDir, 'agent.txt'), 'work\n');
    git(fixture.worktreeDir, 'add', 'agent.txt');
    git(fixture.worktreeDir, 'commit', '-qm', 'agent work', '--no-verify');
    await createWorktreeSessionMarkerExclusive(
      fixture.worktreeDir,
      fixture.sessionId,
    );
    const rootHead = git(fixture.workspaceDir, 'rev-parse', 'HEAD');
    await writeWorktreeSession(
      fixture.sessionService.getWorktreeSessionPath(fixture.sessionId),
      {
        slug: fixture.slug,
        worktreePath: fixture.worktreeDir,
        worktreeBranch: 'worktree-task',
        originalCwd: fixture.workspaceDir,
        workspaceCwd: fixture.workspaceDir,
        originalBranch: 'main',
        originalHeadCommit: rootHead,
      },
    );

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    // The local never moved; the base describes the repo top, so the gate
    // must pass (pre-fix it compared the root HEAD to the worktree commit).
    expect(res.status).toBe(200);
    expect(res.body.worktree).toBeNull();
  });

  it('carries a large dirty overlay into the worktree (no journal bound)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    const filler = 'x'.repeat(60);
    for (let i = 0; i < 600; i++) {
      writeFileSync(
        path.join(
          fixture.workspaceDir,
          `bulk-${String(i).padStart(4, '0')}-${filler}.txt`,
        ),
        'bulk\n',
      );
    }

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' });

    expect(res.status).toBe(200);
    // The handoff writes no journal: the >32KiB overlay must be carried,
    // not silently dropped.
    expect(
      existsSync(path.join(res.body.worktree.path, `bulk-0000-${filler}.txt`)),
    ).toBe(true);
  });

  it('persists carriedEntries in the sidecar after a carry handoff (R2-2)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    writeFileSync(
      path.join(fixture.workspaceDir, 'README.md'),
      'dirty-tracked\n',
    );
    git(fixture.workspaceDir, 'add', 'README.md');
    writeFileSync(path.join(fixture.workspaceDir, 'note.txt'), 'untracked\n');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'worktree' });

    expect(res.status).toBe(200);
    // The R9-6 exemption depends on this persistence: removing the writer
    // would leave the sidecar without the overlay and strand the checkout.
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('valid');
    if (sidecar.state === 'valid') {
      expect(sidecar.session.carriedFrom).toBe(fixture.workspaceDir);
      const entries = sidecar.session.carriedEntries ?? [];
      const paths = entries.map((e) => e.path);
      expect(paths).toContain('README.md');
      expect(paths).toContain('note.txt');
      for (const e of entries) {
        expect(typeof e.executable).toBe('boolean');
        expect(e.hash === null || typeof e.hash === 'string').toBe(true);
      }
    }
  });

  it('refuses a conflicting snapshot with handoff_snapshot_conflict and restores the local checkout', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    // The worktree's dirty change and the local descendant commit touch
    // the same lines: the 3-way snapshot apply conflicts. The handoff
    // must refuse (not relocate into conflict markers) and leave the
    // local checkout at its committed state.
    writeFileSync(
      path.join(fixture.worktreeDir, 'README.md'),
      'worktree-dirty\n',
    );
    writeFileSync(
      path.join(fixture.workspaceDir, 'README.md'),
      'local-committed\n',
    );
    git(fixture.workspaceDir, 'add', 'README.md');
    git(fixture.workspaceDir, 'commit', '-qm', 'local work', '--no-verify');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_snapshot_conflict');
    expect(
      readFileSync(path.join(fixture.workspaceDir, 'README.md'), 'utf8'),
    ).toBe('local-committed\n');
    expect(git(fixture.workspaceDir, 'status', '--porcelain')).toBe('');
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'main',
    );
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('valid');
  });

  it('rollback preserves a pre-existing destination file the carry did not create (R6-1)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    // The local checkout commits an ignore rule AFTER the worktree was
    // created (a descendant commit), then holds secret.env untracked and
    // ignored — invisible to the clean gate. The worktree's base tree has
    // no .gitignore, so the file is untracked-and-LISTED there. The carry
    // must skip the pre-existing destination: the rollback removes the
    // paths the carry reports, and its force-checkout restore cannot bring
    // back an ignored file (it is not in any tree). fresh.txt does not
    // exist locally and must still be rolled back after creation.
    writeFileSync(
      path.join(fixture.workspaceDir, '.gitignore'),
      'secret.env\n',
    );
    git(fixture.workspaceDir, 'add', '.gitignore');
    git(fixture.workspaceDir, 'commit', '-qm', 'ignore rule', '--no-verify');
    writeFileSync(
      path.join(fixture.workspaceDir, 'secret.env'),
      'REAL-LOCAL\n',
    );
    writeFileSync(
      path.join(fixture.worktreeDir, 'secret.env'),
      'FROM-WORKTREE\n',
    );
    writeFileSync(path.join(fixture.worktreeDir, 'fresh.txt'), 'new\n');
    fixture.setCdReject(true);

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(500);
    // The pre-existing file survives with its original content; an
    // overwrite-then-rmSync carry would have deleted it silently.
    expect(existsSync(path.join(fixture.workspaceDir, 'secret.env'))).toBe(
      true,
    );
    expect(
      readFileSync(path.join(fixture.workspaceDir, 'secret.env'), 'utf8'),
    ).toBe('REAL-LOCAL\n');
    // The file the carry DID create is rolled back.
    expect(existsSync(path.join(fixture.workspaceDir, 'fresh.txt'))).toBe(
      false,
    );
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'main',
    );
  });

  it('keeps the local branch when a divergent-base worktree has no commits (R5-4)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    // The branch-route shape: the worktree was created at a sibling
    // checkout's HEAD (one commit ahead of the repo top) and recorded
    // originalHeadCommit = repo top HEAD, worktreeBase = sibling HEAD.
    // With no commits of its own it must NOT promote a branch: the
    // promotion test reads worktreeBase, not originalHeadCommit.
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
    const siblingHead = git(siblingPath, 'rev-parse', 'HEAD');
    const rootHead = git(fixture.workspaceDir, 'rev-parse', 'HEAD');
    expect(siblingHead).not.toBe(rootHead);
    const created = await fixture.service.createUserWorktree(
      fixture.slug,
      siblingHead,
      { detached: true },
    );
    expect(created.success).toBe(true);
    await createWorktreeSessionMarkerExclusive(
      fixture.worktreeDir,
      fixture.sessionId,
    );
    await writeWorktreeSession(
      fixture.sessionService.getWorktreeSessionPath(fixture.sessionId),
      {
        slug: fixture.slug,
        worktreePath: fixture.worktreeDir,
        worktreeBranch: '',
        originalCwd: fixture.workspaceDir,
        workspaceCwd: fixture.workspaceDir,
        originalBranch: 'main',
        originalHeadCommit: rootHead,
        worktreeBase: siblingHead,
      },
    );

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(200);
    expect(res.body.worktree).toBeNull();
    // No promotion, no branch switch: the local checkout keeps its files.
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'main',
    );
    expect(git(fixture.workspaceDir, 'branch', '--list', 'worktree-*')).toBe(
      '',
    );
    expect(existsSync(path.join(fixture.workspaceDir, 'ahead.txt'))).toBe(
      false,
    );
  });

  it('to=local finishes the transfer when a timeout lands the cd in local (R7-7)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    writeFileSync(path.join(fixture.worktreeDir, 'work.txt'), 'work\n');
    git(fixture.worktreeDir, 'add', 'work.txt');
    git(fixture.worktreeDir, 'commit', '-qm', 'agent work', '--no-verify');
    fixture.setEffectiveCwd(fixture.worktreeDir);
    // The queued cd lands (effectiveCwd = local) before the timeout rejects.
    fixture.setCdTimeoutAfterLand(true);

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    // The transfer completes instead of rolling back the carried work.
    expect(res.status).toBe(200);
    expect(res.body.worktree).toBeNull();
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'worktree-task',
    );
    expect(existsSync(path.join(fixture.workspaceDir, 'work.txt'))).toBe(true);
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('missing');
  });

  it('to=local keeps the checkout and sidecar when a timeout leaves the cd undetermined (R7-7)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    writeFileSync(path.join(fixture.worktreeDir, 'work.txt'), 'work\n');
    git(fixture.worktreeDir, 'add', 'work.txt');
    git(fixture.worktreeDir, 'commit', '-qm', 'agent work', '--no-verify');
    // Session still in the worktree; the cd lands only AFTER the catch reads.
    fixture.setEffectiveCwd(fixture.worktreeDir);
    fixture.setCdTimeoutThenLand(true);

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    // No destructive rollback: the promoted branch and carried work survive,
    // and the sidecar still names the worktree.
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'worktree-task',
    );
    expect(existsSync(path.join(fixture.workspaceDir, 'work.txt'))).toBe(true);
    const sidecar = await fixture.readSidecar();
    expect(sidecar.state).toBe('valid');
  });

  it('refuses a branch handoff when the recorded base is empty (legacy sidecar) (R7-9)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    // A named-branch worktree (a branch would be checked out) whose legacy
    // sidecar carries an empty originalHeadCommit, skipping the local-HEAD
    // gate. The branch checkout must fail closed, not move the local checkout
    // without verifying its HEAD.
    const result = await fixture.service.createUserWorktree(
      fixture.slug,
      'main',
    );
    expect(result.success).toBe(true);
    await createWorktreeSessionMarkerExclusive(
      fixture.worktreeDir,
      fixture.sessionId,
    );
    await writeWorktreeSession(
      fixture.sessionService.getWorktreeSessionPath(fixture.sessionId),
      {
        slug: fixture.slug,
        worktreePath: fixture.worktreeDir,
        worktreeBranch: 'worktree-task',
        originalCwd: fixture.workspaceDir,
        workspaceCwd: fixture.workspaceDir,
        originalBranch: 'main',
        originalHeadCommit: '',
      },
    );
    // The user commits locally ahead of the (unrecorded) base.
    writeFileSync(path.join(fixture.workspaceDir, 'local.txt'), 'local\n');
    git(fixture.workspaceDir, 'add', 'local.txt');
    git(fixture.workspaceDir, 'commit', '-qm', 'local work', '--no-verify');

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_handoff_base_unavailable');
    expect(git(fixture.workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'main',
    );
    expect(existsSync(path.join(fixture.workspaceDir, 'local.txt'))).toBe(true);
  });

  it('types an environment carry failure as handoff_carry_failed, not a conflict (R9)', async () => {
    const fixture = makeFixture();
    fixture.writeTranscript();
    await fixture.createDetachedWorktree();
    writeFileSync(path.join(fixture.worktreeDir, 'README.md'), 'dirty\n');
    // An environment failure (unwritable index) is not content to resolve;
    // it must not be presented as handoff_snapshot_conflict.
    const spy = vi
      .spyOn(GitWorktreeService.prototype, 'applyStashSnapshot')
      .mockRejectedValueOnce(
        new WorktreeDirtyCarryConflictError('could not write index', {
          conflict: false,
        }),
      );

    const res = await request(fixture.app)
      .post(`/session/${fixture.sessionId}/worktree-handoff`)
      .send({ to: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_carry_failed');
    spy.mockRestore();
  });
});
