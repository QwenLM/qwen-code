/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commitIsReachable,
  dryRunGitWorktreePrune,
  listGitWorktrees,
  lockGitWorktree,
  pruneGitWorktrees,
  removeGitWorktree,
  unlockGitWorktree,
  worktreeAdminHoldsModules,
  worktreeHoldsSubmodules,
} from '@qwen-code/qwen-code-core/utils/git-worktrees.js';
import { getGitWorkingTreeStatus } from '@qwen-code/qwen-code-core/utils/gitDiff.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { sendBridgeError } from '../server/error-response.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  PRUNE_GUARD_REASON,
  registerWorkspaceQualifiedGitWorktreeRoutes,
} from './workspace-git-worktrees.js';

// Spread over the real module rather than replacing it: `realpathOrSelf` is
// a pure path helper the route compares paths with, and a stub for it would
// make every comparison here agree with itself for the wrong reason.
vi.mock('@qwen-code/qwen-code-core/utils/git-worktrees.js', async (real) => ({
  ...(await real<
    typeof import('@qwen-code/qwen-code-core/utils/git-worktrees.js')
  >()),
  commitIsReachable: vi.fn(),
  listGitWorktrees: vi.fn(),
  lockGitWorktree: vi.fn(),
  pruneGitWorktrees: vi.fn(),
  dryRunGitWorktreePrune: vi.fn(),
  removeGitWorktree: vi.fn(),
  unlockGitWorktree: vi.fn(),
  worktreeAdminHoldsModules: vi.fn(),
  worktreeHoldsSubmodules: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/utils/gitDiff.js', () => ({
  getGitWorkingTreeStatus: vi.fn(),
}));

const listMock = vi.mocked(listGitWorktrees);
const pruneMock = vi.mocked(pruneGitWorktrees);
const removeMock = vi.mocked(removeGitWorktree);
const lockMock = vi.mocked(lockGitWorktree);
const unlockMock = vi.mocked(unlockGitWorktree);
const reachableMock = vi.mocked(commitIsReachable);
const submodulesMock = vi.mocked(worktreeHoldsSubmodules);
const adminModulesMock = vi.mocked(worktreeAdminHoldsModules);
const dryRunMock = vi.mocked(dryRunGitWorktreePrune);
const statusMock = vi.mocked(getGitWorkingTreeStatus);

const mutateOptions: Array<{ strict?: boolean } | undefined> = [];
const passthroughMutate = (opts?: { strict?: boolean }) => {
  mutateOptions.push(opts);
  return ((_req: unknown, _res: unknown, next: () => void) => next()) as never;
};

// The route asks the filesystem whether a listed worktree still has a
// `.git` to read before probing its state, so the fixture paths have to be
// real even though every git command is mocked.
const ROOT = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-wt-routes-mocked-')),
);
const LINKED_PATH = path.join(ROOT, '.qwen', 'worktrees', 'swift-fox');

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const MAIN = {
  path: ROOT,
  head: 'a'.repeat(40),
  branch: 'main',
  detached: false,
  bare: false,
  isMain: true,
};
const LINKED = {
  path: LINKED_PATH,
  head: 'b'.repeat(40),
  branch: 'qwen/swift-fox',
  detached: false,
  bare: false,
  isMain: false,
};
const OUTSIDE = {
  path: '/elsewhere/scratch',
  head: 'c'.repeat(40),
  branch: null,
  detached: true,
  bare: false,
  isMain: false,
};

const CLEAN = {
  branch: 'qwen/swift-fox',
  detached: false,
  hasUpstream: false,
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  stashCount: 0,
};

function runtime(
  workspaceId: string,
  workspaceCwd: string,
  trusted: boolean,
  liveSessions: Array<{
    sessionId: string;
    worktree?: { path: string };
  }> = [],
  // `live-conversation` provenance is what the registry calls internal, and
  // internal entries are the ones `listEntries` / `list` leave out.
  internal = false,
): WorkspaceRuntime {
  return {
    workspaceId,
    workspaceCwd,
    primary: workspaceId === 'primary',
    trusted,
    ...(internal ? { provenance: 'live-conversation' } : {}),
    env: { mode: 'parent-process', overlayKeys: [], effectiveEnv: {} },
    bridge: {
      publishWorkspaceEvent: vi.fn(),
      // The real bridge is bound to one workspace and answers `[]` for any
      // other cwd, so the fake has to honour its argument — otherwise a
      // caller that asks the wrong bridge the wrong question still gets
      // sessions back here while getting nothing in production.
      listWorkspaceSessions: (cwd: string) =>
        cwd === workspaceCwd ? liveSessions : [],
    } as unknown as AcpSessionBridge,
  } as unknown as WorkspaceRuntime;
}

function registry(runtimes: WorkspaceRuntime[]): WorkspaceRegistry {
  return createWorkspaceRegistry(runtimes);
}

function mountWithRegistry(runtimes: WorkspaceRuntime[]) {
  const workspaceRegistry = registry(runtimes);
  const app = express();
  app.use(express.json());
  registerWorkspaceQualifiedGitWorktreeRoutes(app, {
    workspaceRegistry,
    sendBridgeError,
    mutate: passthroughMutate,
  });
  return { app, workspaceRegistry };
}

function mount(runtimes: WorkspaceRuntime[]) {
  return mountWithRegistry(runtimes).app;
}

describe('workspace git worktree routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutateOptions.length = 0;
    // Rebuilt rather than topped up: a test that leaves a `.git` *directory*
    // behind would make every later one fail writing the gitfile.
    fs.rmSync(LINKED_PATH, { recursive: true, force: true });
    fs.mkdirSync(LINKED_PATH, { recursive: true });
    fs.writeFileSync(path.join(LINKED_PATH, '.git'), 'gitdir: /somewhere\n');
    listMock.mockResolvedValue([MAIN, LINKED, OUTSIDE]);
    statusMock.mockResolvedValue(CLEAN);
    // git deletes the checkout as part of a successful removal, so the fake
    // has to as well: the route reports whether the directory outlived the
    // registration, and a fake that never deletes would make every success
    // look like a removal git could not finish.
    removeMock.mockImplementation(async (_cwd, target) => {
      fs.rmSync(target, { recursive: true, force: true });
    });
    lockMock.mockResolvedValue(undefined);
    unlockMock.mockResolvedValue(undefined);
    // Detached entries are the exception, so the default is "some ref has it".
    reachableMock.mockResolvedValue(true);
    submodulesMock.mockResolvedValue(false);
    adminModulesMock.mockResolvedValue(false);
    // Shielded, so git says it would drop only the entry that was asked for,
    // and names it as that entry rather than merely counting one.
    dryRunMock.mockResolvedValue([
      { id: 'swift-fox', worktreePath: LINKED_PATH },
    ]);
    pruneMock.mockResolvedValue(undefined);
  });

  it('lists worktrees of the selected workspace with workspace and slug marks', async () => {
    const app = mount([
      runtime('primary', '/work/other', true),
      runtime('secondary', ROOT, true),
    ]);
    const response = await request(app).get(
      '/workspaces/secondary/git/worktrees',
    );
    expect(response.status).toBe(200);
    expect(listMock).toHaveBeenCalledWith(ROOT, {});
    expect(response.body).toEqual({
      v: 1,
      workspaceCwd: ROOT,
      available: true,
      worktrees: [
        { ...MAIN, isWorkspace: true },
        { ...LINKED, isWorkspace: false, slug: 'swift-fox' },
        { ...OUTSIDE, isWorkspace: false },
      ],
    });
  });

  it('reports available:false when git cannot list the repository', async () => {
    listMock.mockRejectedValue(new Error('not a git repository'));
    const app = mount([runtime('primary', ROOT, true)]);
    const response = await request(app).get(
      '/workspaces/primary/git/worktrees',
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      v: 1,
      workspaceCwd: ROOT,
      available: false,
      worktrees: [],
    });
  });

  it('refuses an untrusted workspace', async () => {
    const app = mount([runtime('primary', ROOT, false)]);
    const response = await request(app).get(
      '/workspaces/primary/git/worktrees',
    );
    expect(response.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('runs the destructive route behind the strict mutation gate', async () => {
    mount([runtime('primary', ROOT, true)]);
    // The strict gate is what demands an explicit mutation token; registering
    // without it would let a plain request delete a worktree.
    expect(mutateOptions).toEqual([{ strict: true }]);
  });

  it('refuses an untrusted workspace on the status and remove routes', async () => {
    const app = mount([runtime('primary', ROOT, false)]);

    const status = await request(app).get(
      `/workspaces/primary/git/worktrees/status?path=${encodeURIComponent(LINKED.path)}`,
    );
    expect(status.status).toBe(403);

    const removal = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });
    expect(removal.status).toBe(403);

    // Neither route reached git at all.
    expect(listMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('answers runtime-unavailable when the generation closes mid-flight', async () => {
    // Open when the handler starts, closed by the time git answers: the
    // workspace was replaced while the listing ran.
    const assertOpen = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw Object.assign(new Error('generation closed'), {
          code: 'workspace_generation_closed',
        });
      });
    const guarded = {
      ...runtime('primary', ROOT, true),
      generationGuard: { assertOpen },
    } as unknown as WorkspaceRuntime;
    const app = mount([guarded]);

    const listing = await request(app).get('/workspaces/primary/git/worktrees');
    expect(listing.status).toBe(503);
    expect(listing.body.code).toBe('workspace_runtime_unavailable');
    expect(listing.body.worktrees).toBeUndefined();
  });

  it('returns the working-tree status of a listed worktree only', async () => {
    statusMock.mockResolvedValue({
      ...CLEAN,
      staged: 1,
      unstaged: 2,
      untracked: 3,
      conflicted: 4,
      ahead: 5,
      behind: 6,
    });
    const app = mount([runtime('primary', ROOT, true)]);
    const ok = await request(app).get(
      `/workspaces/primary/git/worktrees/status?path=${encodeURIComponent(LINKED.path)}`,
    );
    expect(ok.status).toBe(200);
    // Every forwarded field, with a distinct value each: against an all-zero
    // fixture any of them could be forwarded as a constant unnoticed.
    expect(ok.body).toEqual({
      v: 1,
      path: LINKED.path,
      available: true,
      branch: 'qwen/swift-fox',
      detached: false,
      staged: 1,
      unstaged: 2,
      untracked: 3,
      conflicted: 4,
      ahead: 5,
      behind: 6,
    });
    // Working-tree state goes stale the moment anything writes to the
    // checkout, so it is never a cacheable answer.
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(statusMock).toHaveBeenCalledWith(LINKED.path);

    const unknown = await request(app).get(
      '/workspaces/primary/git/worktrees/status?path=%2Fnot%2Fa%2Fworktree',
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('worktree_not_found');
    expect(statusMock).toHaveBeenCalledTimes(1);

    const missing = await request(app).get(
      '/workspaces/primary/git/worktrees/status',
    );
    expect(missing.status).toBe(400);
  });

  it('removes a clean, idle linked worktree', async () => {
    const app = mount([runtime('primary', ROOT, true)]);
    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ removed: true, path: LINKED.path });
    expect(removeMock).toHaveBeenCalledWith(
      ROOT,
      LINKED.path,
      { force: false },
      {},
    );
  });

  it('never removes the main worktree or a registered workspace', async () => {
    const app = mount([
      runtime('primary', ROOT, true),
      runtime('secondary', OUTSIDE.path, true),
    ]);
    const main = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: MAIN.path, force: true });
    expect(main.status).toBe(409);
    expect(main.body.code).toBe('worktree_is_main');

    const workspace = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: OUTSIDE.path, force: true });
    expect(workspace.status).toBe(409);
    expect(workspace.body.code).toBe('worktree_is_workspace');
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('refuses a dirty worktree until force is given, then force-removes it', async () => {
    statusMock.mockResolvedValue({ ...CLEAN, unstaged: 2, untracked: 1 });
    const app = mount([runtime('primary', ROOT, true)]);
    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'worktree_dirty', changes: 3 });
    expect(removeMock).not.toHaveBeenCalled();

    const forced = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path, force: true });
    expect(forced.status).toBe(200);
    expect(removeMock).toHaveBeenCalledWith(
      ROOT,
      LINKED.path,
      { force: true },
      {},
    );
  });

  it('refuses a worktree with live sessions until force is given', async () => {
    const app = mount([
      runtime('primary', ROOT, true, [
        { sessionId: 's1', worktree: { path: LINKED.path } },
        {
          sessionId: 's2',
          worktree: { path: '/work/main/.qwen/worktrees/other' },
        },
        { sessionId: 's3' },
      ]),
    ]);
    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'worktree_in_use',
      sessions: 1,
    });
    // Clean, so there is nothing else to warn about.
    expect(refused.body.changes).toBeUndefined();

    const forced = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path, force: true });
    expect(forced.status).toBe(200);
  });

  it('counts a session that belongs to another registered workspace', async () => {
    // The worktree is not itself a registered workspace, so the
    // `worktree_is_workspace` refusal does not fire; only the cross-runtime
    // session count stands between the request and a live session losing its
    // checkout.
    const app = mount([
      runtime('primary', ROOT, true, []),
      runtime('secondary', '/work/other', true, [
        { sessionId: 'elsewhere', worktree: { path: LINKED.path } },
      ]),
    ]);
    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'worktree_in_use',
      sessions: 1,
    });
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('counts a session in a workspace that is draining', async () => {
    // A draining workspace still holds its bridge and its live sessions; it
    // just stops being `active`, which is what hides it from `listAll`.
    const draining = runtime('secondary', '/work/other', true, [
      { sessionId: 'draining', worktree: { path: LINKED.path } },
    ]);
    const { app, workspaceRegistry } = mountWithRegistry([
      runtime('primary', ROOT, true),
      draining,
    ]);
    expect(workspaceRegistry.beginDrain(draining)).toBe(true);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'worktree_in_use',
      sessions: 1,
    });
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('counts a session an internal runtime hosts, and refuses its root', async () => {
    const hosting = mount([
      runtime('primary', ROOT, true),
      runtime(
        'scratch',
        '/work/scratch',
        true,
        [{ sessionId: 'internal', worktree: { path: LINKED.path } }],
        true,
      ),
    ]);
    const inUse = await request(hosting)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });
    expect(inUse.status).toBe(409);
    expect(inUse.body).toMatchObject({ code: 'worktree_in_use', sessions: 1 });

    const rooted = mount([
      runtime('primary', ROOT, true),
      runtime('scratch', OUTSIDE.path, true, [], true),
    ]);
    const isWorkspace = await request(rooted)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: OUTSIDE.path, force: true });
    expect(isWorkspace.status).toBe(409);
    expect(isWorkspace.body.code).toBe('worktree_is_workspace');
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('does not probe a worktree whose gitfile is gone, prunable or not', async () => {
    // git never marks a locked worktree prunable, so the listing still looks
    // healthy while `<path>/.git` is gone. Probing would walk up and answer
    // about the main worktree.
    fs.rmSync(path.join(LINKED_PATH, '.git'));
    const locked = { ...LINKED, locked: 'held' };
    listMock.mockResolvedValue([MAIN, locked]);
    const app = mount([runtime('primary', ROOT, true)]);

    const status = await request(app).get(
      `/workspaces/primary/git/worktrees/status?path=${encodeURIComponent(LINKED_PATH)}`,
    );
    expect(status.status).toBe(200);
    expect(status.body).toEqual({
      v: 1,
      path: LINKED_PATH,
      available: false,
    });

    // This is the one shape `--force --force` never clears: the directory
    // outlived its gitfile, and the lock keeps prune away from it. Calling
    // that a lock would offer a second click with nowhere to land, so git's
    // own refusal is what comes back — and the working tree is never asked,
    // because the answer would be the main worktree's.
    removeMock.mockRejectedValue(
      new Error(
        "fatal: validation failed, cannot remove working tree: '.git' does not exist",
      ),
    );
    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED_PATH });

    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.code).not.toBe('worktree_locked');
    expect(refused.body.code).not.toBe('worktree_remove_refused');
    expect(refused.body.code).not.toBe('worktree_dirty');
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('removes a stale registration by path, without a working-tree probe', async () => {
    // A listed prunable entry never has a `<path>/.git` — that is what makes
    // git call it prunable in the first place.
    fs.rmSync(path.join(LINKED_PATH, '.git'));
    listMock.mockResolvedValue([
      MAIN,
      { ...LINKED, prunable: 'gitdir file points to non-existent location' },
    ]);
    const app = mount([runtime('primary', ROOT, true)]);
    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });
    expect(response.status).toBe(200);
    // Per-path, so the repository's other stale registrations survive; and no
    // status probe, because a missing directory has no working tree to read.
    expect(removeMock).toHaveBeenCalledWith(
      ROOT,
      LINKED.path,
      { force: false },
      {},
    );
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('falls back to prune only when git refuses a stale registration', async () => {
    const stale = {
      ...LINKED,
      prunable: 'gitdir file points to non-existent location',
    };
    fs.rmSync(path.join(LINKED_PATH, '.git'));
    // The listing the request reads; the one it re-reads when the removal
    // fails (still there, so this is a real refusal); the one it reads to
    // find the other stale registrations to shield; and the one after the
    // prune (gone).
    listMock
      .mockResolvedValueOnce([MAIN, stale])
      .mockResolvedValueOnce([MAIN, stale])
      .mockResolvedValueOnce([MAIN, stale])
      .mockResolvedValueOnce([MAIN, stale])
      .mockResolvedValueOnce([MAIN]);
    // git rejects a registration whose directory outlived its gitfile at every
    // force level; prune is the only command that clears it.
    removeMock.mockRejectedValue(
      new Error(
        "fatal: validation failed, cannot remove working tree: '.git' does not exist",
      ),
    );
    const app = mount([runtime('primary', ROOT, true)]);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(response.status).toBe(200);
    // Prune clears registrations and deletes no files, so whatever outlived
    // the gitfile is still on disk and the response says so.
    expect(response.body).toEqual({
      removed: true,
      path: LINKED.path,
      directoryRemains: true,
    });
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(pruneMock).toHaveBeenCalledWith(ROOT, {});
    // Nothing else was stale, so nothing needed shielding.
    expect(lockMock).not.toHaveBeenCalled();
  });

  it('refuses rather than pruning past a bystander it could not shield', async () => {
    const stale = {
      ...LINKED,
      prunable: 'gitdir file points to non-existent location',
    };
    const bystander = {
      ...LINKED,
      path: path.join(ROOT, 'other'),
      prunable: 'gitdir file points to non-existent location',
    };
    fs.rmSync(path.join(LINKED_PATH, '.git'));
    listMock.mockResolvedValue([MAIN, stale, bystander]);
    removeMock.mockRejectedValue(new Error('fatal: validation failed'));
    lockMock.mockRejectedValue(new Error('fatal: could not open for writing'));
    const app = mount([runtime('primary', ROOT, true)]);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    // A failed removal is something the user can retry; a bystander's
    // commits are not. And the error is about the worktree they asked for.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(pruneMock).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).toContain('validation failed');
  });

  it('shields a registration that goes stale while it is locking', async () => {
    const stale = {
      ...LINKED,
      prunable: 'gitdir file points to non-existent location',
    };
    const latecomer = {
      ...LINKED,
      path: path.join(ROOT, 'latecomer'),
      prunable: 'gitdir file points to non-existent location',
    };
    fs.rmSync(path.join(LINKED_PATH, '.git'));
    listMock
      // The request's listing; the re-list after git refuses; the first
      // shield pass, where a second registration has gone stale since; the
      // second pass, where locking it has taken away its prunable mark; and
      // the listing after the prune.
      .mockResolvedValueOnce([MAIN, stale])
      // The request's listing; the re-list after git refuses; the first
      // shield pass, where a second registration has gone stale since; the
      // second pass, where locking it has taken away its prunable mark; and
      // the listing after the prune.
      .mockResolvedValueOnce([MAIN, stale])
      .mockResolvedValueOnce([MAIN, stale])
      .mockResolvedValueOnce([MAIN, stale, latecomer])
      .mockResolvedValueOnce([MAIN, stale])
      .mockResolvedValueOnce([MAIN]);
    removeMock.mockRejectedValue(new Error('fatal: validation failed'));
    const app = mount([runtime('primary', ROOT, true)]);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(response.status).toBe(200);
    expect(lockMock).toHaveBeenCalledWith(
      ROOT,
      latecomer.path,
      expect.stringContaining('qwen-code'),
      {},
    );
    expect(unlockMock).toHaveBeenCalledWith(ROOT, latecomer.path, {});
  });

  it('releases a shield lock it left behind instead of refusing on it', async () => {
    // The reason this route writes when it shields, left by a removal that
    // died in between. git refuses such an entry at every force level and
    // prune skips it, so it is stuck until this recognises it.
    const stranded = {
      ...LINKED,
      locked: 'qwen-code: held while pruning another worktree',
    };
    listMock.mockResolvedValue([MAIN, stranded]);
    const app = mount([runtime('primary', ROOT, true)]);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(unlockMock).toHaveBeenCalledWith(ROOT, LINKED.path, {});
    expect(response.status).toBe(200);
  });

  it('clears a stale entry its own shield lock stranded, in one click', async () => {
    // The lock is exactly what stops git marking the entry prunable, so the
    // listing this request read says it is not — and the fallback that would
    // clear it is keyed on that mark. Releasing the lock without re-reading
    // leaves the user with git's raw refusal and a second click to make.
    const guarded = {
      ...LINKED,
      locked: 'qwen-code: held while pruning another worktree',
    };
    const stale = {
      ...LINKED,
      prunable: 'gitdir file points to non-existent location',
    };
    fs.rmSync(path.join(LINKED_PATH, '.git'));
    listMock
      .mockResolvedValueOnce([MAIN, guarded])
      .mockResolvedValueOnce([MAIN, guarded])
      .mockResolvedValueOnce([MAIN, stale])
      .mockResolvedValueOnce([MAIN, stale])
      .mockResolvedValueOnce([MAIN, stale])
      .mockResolvedValueOnce([MAIN]);
    removeMock.mockRejectedValue(new Error('fatal: validation failed'));
    const app = mount([runtime('primary', ROOT, true)]);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(unlockMock).toHaveBeenCalledWith(ROOT, LINKED.path, {});
    expect(pruneMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });

  it('asks git what the prune would take before letting it run', async () => {
    const stale = {
      ...LINKED,
      prunable: 'gitdir file points to non-existent location',
    };
    fs.rmSync(path.join(LINKED_PATH, '.git'));
    listMock
      .mockResolvedValueOnce([MAIN, stale])
      .mockResolvedValueOnce([MAIN, stale])
      .mockResolvedValueOnce([MAIN, stale])
      .mockResolvedValueOnce([MAIN, stale])
      .mockResolvedValueOnce([MAIN]);
    removeMock.mockRejectedValue(new Error('fatal: validation failed'));
    const app = mount([runtime('primary', ROOT, true)]);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    // The listing is not the set prune drops, so the authorisation has to
    // come from git rather than from what the route can see.
    expect(dryRunMock).toHaveBeenCalledWith(ROOT, {});
    expect(dryRunMock.mock.invocationCallOrder[0]).toBeLessThan(
      pruneMock.mock.invocationCallOrder[0],
    );
    expect(response.status).toBe(200);
  });

  it('releases its own shield lock on a forced removal too', async () => {
    const guarded = {
      ...LINKED,
      locked: 'qwen-code: held while pruning another worktree',
    };
    listMock
      .mockResolvedValueOnce([MAIN, guarded])
      .mockResolvedValueOnce([MAIN, guarded])
      .mockResolvedValueOnce([MAIN, LINKED]);
    const app = mount([runtime('primary', ROOT, true)]);

    const forced = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path, force: true });

    // Forcing skips every refusal, but the lock is this route's own litter
    // and git would refuse the removal until it goes.
    expect(unlockMock).toHaveBeenCalledWith(ROOT, LINKED.path, {});
    expect(forced.status).toBe(200);
  });

  it('names a nested repository on a refusal git never made', async () => {
    // The submodule probe used to hang off git's own refusal, so a worktree
    // stopped by one of this route's gates lost its nested repository to the
    // second click without a word.
    submodulesMock.mockResolvedValue(true);
    statusMock.mockResolvedValue({ ...CLEAN, untracked: 2 });
    listMock.mockResolvedValue([MAIN, LINKED]);
    const app = mount([runtime('primary', ROOT, true)]);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(refused.body).toMatchObject({
      code: 'worktree_dirty',
      changes: 2,
      submodules: true,
    });
  });

  it('warns when it cannot tell whether a commit is kept', async () => {
    const detached = { ...LINKED, branch: null, detached: true };
    listMock.mockResolvedValue([MAIN, detached]);
    reachableMock.mockRejectedValue(new Error('fatal: bad object'));
    const app = mount([runtime('primary', ROOT, true)]);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    // Not knowing is a reason to ask, not a reason to go ahead.
    expect(refused.body).toMatchObject({ code: 'worktree_unmerged_commits' });
  });

  it('reports git\u2019s refusal when the prune fallback did not clear the entry', async () => {
    const stale = {
      ...LINKED,
      prunable: 'gitdir file points to non-existent location',
    };
    fs.rmSync(path.join(LINKED_PATH, '.git'));
    // Still listed after the prune — git skips a worktree that has been
    // locked since the request read the listing.
    listMock.mockResolvedValue([MAIN, stale]);
    removeMock.mockRejectedValue(new Error('fatal: validation failed'));
    const app = mount([runtime('primary', ROOT, true)]);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(pruneMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.removed).toBeUndefined();
  });

  it('never prunes to paper over a removal git refused for another reason', async () => {
    removeMock.mockRejectedValue(new Error('fatal: is a locked working tree'));
    const app = mount([runtime('primary', ROOT, true)]);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(pruneMock).not.toHaveBeenCalled();
  });

  it('counts every live session in the worktree, not just one', async () => {
    const app = mount([
      runtime('primary', ROOT, true, [
        { sessionId: 's1', worktree: { path: LINKED_PATH } },
        { sessionId: 's2', worktree: { path: LINKED_PATH } },
      ]),
      runtime('secondary', '/work/other', true, [
        { sessionId: 's3', worktree: { path: LINKED_PATH } },
      ]),
    ]);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED_PATH });

    expect(refused.body).toMatchObject({
      code: 'worktree_in_use',
      sessions: 3,
    });
  });

  it('refuses a locked worktree until force is given', async () => {
    listMock.mockResolvedValue([
      MAIN,
      { ...LINKED, locked: 'held by a build' },
    ]);
    const app = mount([runtime('primary', ROOT, true)]);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'worktree_locked',
      reason: 'held by a build',
    });
    // Answered from the listing: git is never asked to refuse it.
    expect(removeMock).not.toHaveBeenCalled();
    expect(refused.body.changes).toBeUndefined();

    const forced = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path, force: true });

    expect(forced.status).toBe(200);
    expect(removeMock).toHaveBeenCalledWith(
      ROOT,
      LINKED.path,
      { force: true },
      {},
    );
  });

  it('names the uncommitted work a lock or a session would hide', async () => {
    // The second click overrides every refusal at once, so a refusal that
    // only names the lock or the session sends the user past uncommitted
    // work it never mentioned.
    statusMock.mockResolvedValue({ ...CLEAN, unstaged: 2, untracked: 1 });
    const locked = { ...LINKED, locked: 'held by a build' };
    listMock.mockResolvedValue([MAIN, locked]);

    const lockedApp = mount([runtime('primary', ROOT, true)]);
    const byLock = await request(lockedApp)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(byLock.status).toBe(409);
    expect(byLock.body).toMatchObject({
      code: 'worktree_locked',
      reason: 'held by a build',
      changes: 3,
    });

    listMock.mockResolvedValue([MAIN, LINKED]);
    const busyApp = mount([
      runtime('primary', ROOT, true, [
        { sessionId: 's1', worktree: { path: LINKED.path } },
      ]),
    ]);
    const bySession = await request(busyApp)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(bySession.status).toBe(409);
    expect(bySession.body).toMatchObject({
      code: 'worktree_in_use',
      sessions: 1,
      changes: 3,
    });
  });

  it('still offers force for a lock whose directory is gone entirely', async () => {
    // Nothing left for git to validate, so `--force --force` clears this one
    // even though it is locked — and git never marks a locked entry
    // prunable, so the fallback is not what saves it.
    fs.rmSync(LINKED_PATH, { recursive: true, force: true });
    listMock.mockResolvedValue([MAIN, { ...LINKED, locked: 'held' }]);
    const app = mount([runtime('primary', ROOT, true)]);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('worktree_locked');

    const forced = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path, force: true });

    expect(forced.status).toBe(200);
    expect(pruneMock).not.toHaveBeenCalled();
  });

  it('reports the sessions first when a worktree is locked as well', async () => {
    // Forcing past a lock destroys nothing — the lock is bookkeeping, and the
    // row carries its badge. Forcing past a session strands a checkout, so
    // that is the refusal the user has to read.
    listMock.mockResolvedValue([MAIN, { ...LINKED, locked: 'held' }]);
    const app = mount([
      runtime('primary', ROOT, true, [
        { sessionId: 's1', worktree: { path: LINKED.path } },
        { sessionId: 's2', worktree: { path: LINKED.path } },
      ]),
    ]);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'worktree_in_use',
      sessions: 2,
    });
  });

  it('never reads "cannot look" as "nothing is there"', async () => {
    // A self-referencing symlink in the path makes every `stat` and `lstat`
    // fail with ELOOP rather than ENOENT — the same shape as an unreadable
    // parent directory, without depending on who the tests run as.
    const loop = path.join(ROOT, 'loop');
    fs.rmSync(loop, { recursive: true, force: true });
    fs.symlinkSync(loop, loop);
    const trapped = path.join(loop, 'wt');
    const entry = { ...LINKED, path: trapped, locked: 'on removable media' };
    listMock.mockResolvedValue([MAIN, entry]);
    // git drops the registration and deletes nothing, which is what it does
    // when it cannot reach the checkout.
    removeMock.mockResolvedValue(undefined);
    const app = mount([runtime('primary', ROOT, true)]);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: trapped });

    // Not being able to count the work is not the same as there being none,
    // and this refusal is the only thing the user reads before forcing.
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'worktree_locked',
      statusUnknown: true,
    });

    const forced = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: trapped, force: true });

    // The checkout is still out there. Saying nothing would let the row
    // vanish and read as "the directory went".
    expect(forced.status).toBe(200);
    expect(forced.body.directoryRemains).toBe(true);
  });

  it('never lets an unreadable working tree hide a session or a lock', async () => {
    // Not being able to count the uncommitted work is a warning, not a
    // refusal of its own. Returning it here would send the user past a live
    // session the confirmation never named.
    statusMock.mockResolvedValue(null);
    listMock.mockResolvedValue([MAIN, LINKED]);
    const busy = mount([
      runtime('primary', ROOT, true, [
        { sessionId: 's1', worktree: { path: LINKED.path } },
      ]),
    ]);

    const bySession = await request(busy)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(bySession.status).toBe(409);
    expect(bySession.body).toMatchObject({
      code: 'worktree_in_use',
      sessions: 1,
      statusUnknown: true,
    });

    listMock.mockResolvedValue([MAIN, { ...LINKED, locked: 'held' }]);
    const lockedApp = mount([runtime('primary', ROOT, true)]);
    const byLock = await request(lockedApp)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(byLock.body).toMatchObject({
      code: 'worktree_locked',
      reason: 'held',
      statusUnknown: true,
    });

    // With nothing else to refuse on, it is the refusal.
    listMock.mockResolvedValue([MAIN, LINKED]);
    const alone = mount([runtime('primary', ROOT, true)]);
    const byStatus = await request(alone)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(byStatus.status).toBe(409);
    expect(byStatus.body.code).toBe('worktree_status_unknown');
  });

  it('refuses a detached worktree whose commits no ref keeps', async () => {
    const detached = { ...LINKED, branch: null, detached: true };
    listMock.mockResolvedValue([MAIN, detached]);
    reachableMock.mockResolvedValue(false);
    const app = mount([runtime('primary', ROOT, true)]);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    // Nothing on disk is dirty, so no counter sees this; the commits simply
    // stop being reachable when the entry goes.
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'worktree_unmerged_commits',
      unmergedHead: detached.head,
    });
    expect(reachableMock).toHaveBeenCalledWith(ROOT, detached.head, {});
    expect(removeMock).not.toHaveBeenCalled();

    // A branch keeps them, so there is nothing to warn about.
    reachableMock.mockResolvedValue(true);
    const allowed = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });
    expect(allowed.status).toBe(200);
  });

  it('carries an unfinished operation and lost commits on any refusal', async () => {
    // Moving either field out of the shared payload and into the branch that
    // names it is invisible to a test that only ever drives that branch.
    const detached = { ...LINKED, branch: null, detached: true };
    listMock.mockResolvedValue([MAIN, detached]);
    reachableMock.mockResolvedValue(false);
    statusMock.mockResolvedValue({ ...CLEAN, operation: 'rebase' });
    const app = mount([
      runtime('primary', ROOT, true, [
        { sessionId: 's1', worktree: { path: LINKED.path } },
      ]),
    ]);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(refused.body).toMatchObject({
      code: 'worktree_in_use',
      sessions: 1,
      operation: 'rebase',
      unmergedHead: detached.head,
    });
  });

  it('never prunes when git would take a different worktree', async () => {
    const stale = {
      ...LINKED,
      prunable: 'gitdir file points to non-existent location',
    };
    fs.rmSync(path.join(LINKED_PATH, '.git'));
    listMock.mockResolvedValue([MAIN, stale]);
    removeMock.mockRejectedValue(new Error('fatal: validation failed'));
    // One entry, but not this one: a count alone would let the prune take a
    // bystander and report it as this removal.
    dryRunMock.mockResolvedValue([
      { id: 'someone-else', worktreePath: path.join(ROOT, 'someone-else') },
    ]);
    const app = mount([runtime('primary', ROOT, true)]);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(pruneMock).not.toHaveBeenCalled();
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a worktree a registered workspace sits inside', async () => {
    // Removing the worktree takes the workspace with it, exactly as it would
    // if the workspace were the worktree's own root.
    const inside = path.join(LINKED_PATH, 'nested', 'project');
    const app = mount([
      runtime('primary', ROOT, true),
      runtime('secondary', inside, true),
    ]);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path, force: true });

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('worktree_is_workspace');
    // Which workspace: the request named the worktree, and a workspace
    // rooted somewhere below it is not something the caller can work back to
    // from that.
    expect(refused.body.workspaceCwd).toBe(inside);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('never reports a removal to a generation that closed under it', async () => {
    // Open when the work starts, closed by the time git is done: six
    // subprocesses is plenty of time for the workspace to be replaced.
    const assertOpen = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw Object.assign(new Error('generation closed'), {
          code: 'workspace_generation_closed',
        });
      });
    const guarded = {
      ...runtime('primary', ROOT, true),
      generationGuard: { assertOpen },
    } as unknown as WorkspaceRuntime;
    const app = mount([guarded]);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('workspace_runtime_unavailable');
    expect(response.body.removed).toBeUndefined();
  });

  it('never turns a prune it finished into a failure it did not', async () => {
    const stale = {
      ...LINKED,
      prunable: 'gitdir file points to non-existent location',
    };
    const bystander = {
      ...LINKED,
      path: path.join(ROOT, 'other'),
      prunable: 'gitdir file points to non-existent location',
    };
    fs.rmSync(path.join(LINKED_PATH, '.git'));
    listMock
      .mockResolvedValueOnce([MAIN, stale, bystander])
      .mockResolvedValueOnce([MAIN, stale, bystander])
      .mockResolvedValueOnce([MAIN, stale, bystander])
      .mockResolvedValueOnce([MAIN, stale, bystander])
      .mockResolvedValueOnce([MAIN, stale])
      .mockResolvedValueOnce([MAIN]);
    removeMock.mockRejectedValue(new Error('fatal: validation failed'));
    // Releasing the shield is cleanup, and a rejection here would replace an
    // outcome that already happened — the retry would then answer 404.
    unlockMock.mockRejectedValue(new Error('fatal: could not unlock'));
    const app = mount([runtime('primary', ROOT, true)]);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(pruneMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });

  it('carries the rest even when the unmerged refusal is the one that wins', async () => {
    // Two kinds of loss at once: the commits nothing keeps, and a working
    // tree that could not be read at all. Reporting only the first sends the
    // user past the second without a word.
    const detached = { ...LINKED, branch: null, detached: true };
    listMock.mockResolvedValue([MAIN, detached]);
    reachableMock.mockResolvedValue(false);
    statusMock.mockResolvedValue(null);
    const app = mount([runtime('primary', ROOT, true)]);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(refused.body).toMatchObject({
      code: 'worktree_unmerged_commits',
      unmergedHead: detached.head,
      statusUnknown: true,
    });
  });

  it('never asks about reachability for a worktree on a branch', async () => {
    listMock.mockResolvedValue([MAIN, LINKED]);
    const app = mount([runtime('primary', ROOT, true)]);

    await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    // The branch is what keeps them; the walk would be pure cost.
    expect(reachableMock).not.toHaveBeenCalled();
  });

  it('refuses an unfinished rebase that leaves every counter at zero', async () => {
    statusMock.mockResolvedValue({ ...CLEAN, operation: 'rebase' });
    listMock.mockResolvedValue([MAIN, LINKED]);
    const app = mount([runtime('primary', ROOT, true)]);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'worktree_operation_in_progress',
      operation: 'rebase',
    });

    const forced = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path, force: true });
    expect(forced.status).toBe(200);
  });

  it('asks git for untracked files the repository hides', async () => {
    listMock.mockResolvedValue([MAIN, LINKED]);
    const app = mount([runtime('primary', ROOT, true)]);

    await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    // `status.showUntrackedFiles = no` blinds git's own safety check too, so
    // this gate has to override it or the files are destroyed unannounced.
    expect(statusMock).toHaveBeenCalledWith(LINKED.path, {
      countHiddenUntracked: true,
    });
  });

  it('says a nested repository goes with the removal it is refusing', async () => {
    listMock.mockResolvedValue([MAIN, LINKED]);
    submodulesMock.mockResolvedValue(true);
    const app = mount([runtime('primary', ROOT, true)]);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    // Refused before git is asked: its own sentence names submodules without
    // saying what forcing past it takes, and this one does.
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'worktree_nested_repository',
      submodules: true,
    });
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('warns about a nested repository no checkout is left to ask about', async () => {
    // With no gitfile there is nothing to run `git submodule status` in, so
    // the admin side is the only thing left that can answer — and it is the
    // side the repository is on.
    fs.rmSync(path.join(LINKED_PATH, '.git'));
    listMock.mockResolvedValue([
      MAIN,
      { ...LINKED, prunable: 'gitdir file points to non-existent location' },
    ]);
    adminModulesMock.mockResolvedValue(true);
    const app = mount([runtime('primary', ROOT, true)]);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('worktree_nested_repository');
    expect(submodulesMock).not.toHaveBeenCalled();
  });

  it('counts staged and conflicted work, not only what is unstaged', async () => {
    // Every kind of uncommitted work a forced removal would discard has to
    // reach the count, or a worktree whose only changes are staged — or in
    // conflict — is removed on the first click with no confirmation at all.
    for (const field of [
      'staged',
      'conflicted',
      'unstaged',
      'untracked',
    ] as const) {
      vi.clearAllMocks();
      listMock.mockResolvedValue([MAIN, LINKED]);
      removeMock.mockResolvedValue(undefined);
      statusMock.mockResolvedValue({ ...CLEAN, [field]: 2 });
      const app = mount([runtime('primary', ROOT, true)]);

      const refused = await request(app)
        .post('/workspaces/primary/git/worktrees/remove')
        .send({ path: LINKED.path });

      // The field travels with the assertion, so a failure names the kind
      // of change that slipped through.
      expect([field, refused.status, refused.body.code]).toEqual([
        field,
        409,
        'worktree_dirty',
      ]);
      expect([field, refused.body.changes]).toEqual([field, 2]);
      expect([field, removeMock.mock.calls.length]).toEqual([field, 0]);
    }
  });

  it('refuses a lock git recorded without a reason, and names none', async () => {
    // A bare `locked` line means an empty reason, which is a lock all the
    // same. Reporting `reason: ""` would render as a lock with a blank
    // explanation.
    listMock.mockResolvedValue([MAIN, { ...LINKED, locked: '' }]);
    const app = mount([runtime('primary', ROOT, true)]);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('worktree_locked');
    expect(refused.body.reason).toBeUndefined();
  });

  it('offers force when git refused a removal that changed nothing', async () => {
    // git calls a worktree holding initialised submodules clean and still
    // refuses to remove it without force, so nothing earlier can catch this.
    listMock.mockResolvedValue([MAIN, LINKED]);
    removeMock.mockRejectedValue(
      Object.assign(new Error('Command failed: git worktree remove'), {
        stderr:
          'fatal: working trees containing submodules cannot be moved or removed\n',
      }),
    );
    const app = mount([runtime('primary', ROOT, true)]);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('worktree_remove_refused');
    expect(refused.body.detail).toContain('containing submodules');
    expect(pruneMock).not.toHaveBeenCalled();

    // git's prose goes into the confirmation body, so it is bounded like
    // every other git sentence a client is shown.
    removeMock.mockRejectedValue(
      Object.assign(new Error('Command failed: git worktree remove'), {
        stderr: `fatal: ${'verbose '.repeat(400)}`,
      }),
    );
    const long = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(long.body.code).toBe('worktree_remove_refused');
    expect(long.body.detail.length).toBeLessThanOrEqual(512);

    // And the bound counts UTF-16 units, so it must not leave half of an
    // astral character behind.
    removeMock.mockRejectedValue(
      Object.assign(new Error('Command failed: git worktree remove'), {
        // 'fatal: ' is 7 units, so the pair straddles the 512th.
        stderr: `fatal: ${'x'.repeat(504)}\u{1F600}tail`,
      }),
    );
    const astral = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    const detail: string = astral.body.detail;
    const last = detail.charCodeAt(detail.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it('never offers force twice for the same refusal', async () => {
    listMock.mockResolvedValue([MAIN, LINKED]);
    removeMock.mockRejectedValue(
      Object.assign(new Error('Command failed: git worktree remove'), {
        stderr:
          'fatal: working trees containing submodules cannot be moved or removed\n',
      }),
    );
    const app = mount([runtime('primary', ROOT, true)]);

    const forced = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path, force: true });

    // Forcing already failed, so a second click would spend itself on the
    // same refusal: git's own failure is what the user gets.
    expect(forced.status).toBeGreaterThanOrEqual(400);
    expect(forced.body.code).not.toBe('worktree_remove_refused');
  });

  it('never offers force for a registration git cannot validate', async () => {
    // Someone ran `git init` where the worktree was: git refuses this at
    // every force level, so a second click could only fail again.
    fs.rmSync(path.join(LINKED_PATH, '.git'));
    fs.mkdirSync(path.join(LINKED_PATH, '.git'));
    listMock.mockResolvedValue([MAIN, LINKED]);
    removeMock.mockRejectedValue(
      new Error(
        "fatal: validation failed, cannot remove working tree: '.git' is not a .git file, error code 10",
      ),
    );
    const app = mount([runtime('primary', ROOT, true)]);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.code).not.toBe('worktree_remove_refused');
    expect(pruneMock).not.toHaveBeenCalled();
  });

  it('refuses when the working tree cannot be read at all', async () => {
    statusMock.mockResolvedValue(null);
    const app = mount([runtime('primary', ROOT, true)]);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED_PATH });

    // Unreadable is not assumed clean: refuse, and let the user decide.
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('worktree_status_unknown');
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('treats anything but a true boolean as not forced', async () => {
    statusMock.mockResolvedValue({ ...CLEAN, untracked: 1 });
    const app = mount([runtime('primary', ROOT, true)]);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED_PATH, force: 'yes' });

    // A truthy string is not consent to discard uncommitted work.
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('worktree_dirty');
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('treats a dropped registration as done even when git reports failure', async () => {
    // git deletes the checkout and drops the registration as two steps and a
    // failed deletion does not stop the drop, so a rejection can still leave
    // the registration gone and the directory on disk.
    listMock
      .mockResolvedValueOnce([MAIN, LINKED])
      .mockResolvedValueOnce([MAIN]);
    removeMock.mockRejectedValue(
      new Error("error: failed to delete '/x': Permission denied"),
    );
    const app = mount([runtime('primary', ROOT, true)]);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED_PATH });

    expect(response.status).toBe(200);
    // Reported, because the confirmation the user answered promised the
    // directory would go and it is still there.
    expect(response.body).toEqual({
      removed: true,
      path: LINKED_PATH,
      directoryRemains: true,
    });
    expect(fs.existsSync(LINKED_PATH)).toBe(true);
    expect(pruneMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown path and a missing body path', async () => {
    const app = mount([runtime('primary', ROOT, true)]);
    const unknown = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: '/not/listed' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('worktree_not_found');

    const missing = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({});
    expect(missing.status).toBe(400);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('names a nested repository the checkout no longer shows', async () => {
    // A deinitialised submodule keeps its repository under the worktree's
    // admin directory while `git submodule status` stops reporting it, so
    // asking the checkout alone answers that there is nothing to lose — and
    // git removes it without a word on the second click.
    submodulesMock.mockResolvedValue(false);
    adminModulesMock.mockResolvedValue(true);
    const app = mount([runtime('primary', ROOT, true)]);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED_PATH });

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'worktree_nested_repository',
      submodules: true,
    });
    expect(removeMock).not.toHaveBeenCalled();
    // Asked about the worktree the request named, in the repository the
    // route is serving.
    expect(adminModulesMock).toHaveBeenCalledWith(ROOT, LINKED_PATH, {});
  });

  it('does not invent a nested repository when the probe fails', async () => {
    // The probe is a stat of somebody else's directory and can fail on its
    // own. Reading that as "there is a nested repository" would refuse a
    // removal over something nobody saw — so a failure is not evidence, and
    // the gates that did answer are what decide.
    adminModulesMock.mockRejectedValue(new Error('EACCES: permission denied'));
    submodulesMock.mockRejectedValue(new Error('EACCES: permission denied'));
    const app = mount([runtime('primary', ROOT, true)]);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED_PATH });

    expect(response.status).toBe(200);
    expect(removeMock).toHaveBeenCalled();
  });

  it('never asks a stranded worktree about its submodules', async () => {
    // `git submodule status` resolves the repository by walking up, so in a
    // worktree whose gitfile is gone it answers about the main worktree —
    // and this entry would be refused over somebody else's repository.
    fs.rmSync(path.join(LINKED_PATH, '.git'));
    listMock.mockResolvedValue([
      MAIN,
      { ...LINKED, prunable: 'gitdir file points to non-existent location' },
    ]);
    adminModulesMock.mockResolvedValue(false);
    const app = mount([runtime('primary', ROOT, true)]);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(response.status).toBe(200);
    expect(submodulesMock).not.toHaveBeenCalled();
  });

  it('answers a git failure it meets before the removal, redacted', async () => {
    // The shield lock this route left behind is released inside the
    // repository's turn, and computing that turn's key costs a listing of
    // its own. Its failure is a git failure like any other here — not
    // whatever the framework makes of an unhandled rejection.
    listMock
      .mockResolvedValueOnce([MAIN, { ...LINKED, locked: PRUNE_GUARD_REASON }])
      .mockRejectedValue(
        new Error(`fatal: not a git repository: '${ROOT}/.git'`),
      );
    const app = mount([runtime('primary', ROOT, true)]);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.code ?? response.body.error).toBeTruthy();
    expect(JSON.stringify(response.body)).not.toContain('at Object.');
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('prunes one repository one removal at a time, across its workspaces', async () => {
    // `git worktree prune` is repository-wide, and the shield that narrows it
    // to one path only holds while nothing else is locking or unlocking
    // underneath it. Two workspaces of one repository are two different
    // `workspaceCwd`s and one prune, so the turn has to be keyed on the
    // repository — and the map that holds those turns has to keep the newest
    // one rather than the one that happened to finish.
    const SECOND = path.join(ROOT, 'second-workspace');
    const THIRD = path.join(ROOT, 'third-workspace');
    const stale = [
      { cwd: ROOT, entry: { ...LINKED, path: path.join(ROOT, 'stale-a') } },
      { cwd: SECOND, entry: { ...LINKED, path: path.join(ROOT, 'stale-b') } },
      { cwd: THIRD, entry: { ...LINKED, path: path.join(ROOT, 'stale-c') } },
    ];
    const gone = new Set<string>();
    const mineFor = (cwd: string) =>
      stale.find((one) => one.cwd === cwd)!.entry;
    // Every workspace lists the same repository — git names the main worktree
    // first from any of them — and each sees only its own stale entry, so no
    // shield is needed and the prune is the only shared thing left.
    listMock.mockImplementation(async (cwd: string) => {
      const mine = mineFor(cwd);
      return gone.has(mine.path)
        ? [MAIN]
        : [MAIN, { ...mine, prunable: 'gitdir file points to non-existent' }];
    });
    dryRunMock.mockImplementation(async (cwd: string) => [
      { id: 'stale', worktreePath: mineFor(cwd).path },
    ]);
    removeMock.mockRejectedValue(
      new Error('fatal: validation failed, cannot remove working tree'),
    );
    let running = 0;
    let peak = 0;
    pruneMock.mockImplementation(async (cwd: string) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      gone.add(mineFor(cwd).path);
      running -= 1;
    });
    const app = mount([
      runtime('primary', ROOT, true),
      runtime('second', SECOND, true),
      runtime('third', THIRD, true),
    ]);

    const answers = await Promise.all(
      stale.map((one, index) =>
        request(app)
          .post(
            `/workspaces/${['primary', 'second', 'third'][index]}/git/worktrees/remove`,
          )
          .send({ path: one.entry.path }),
      ),
    );

    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
    expect(pruneMock).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
  });

  it('keeps the turn that is waiting, not the one that finished', async () => {
    const waitUntil = async (done: () => boolean) => {
      for (let tries = 0; tries < 200 && !done(); tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(done()).toBe(true);
    };
    // The turn map drops a repository's row once nothing is queued behind
    // it. "Nothing is queued" has to mean the row is still the one this turn
    // put there: a removal that settles while another is running would
    // otherwise drop that one's row, and the next arrival starts a second
    // prune of the same repository beside it.
    const SECOND = path.join(ROOT, 'second-workspace');
    const THIRD = path.join(ROOT, 'third-workspace');
    const ids = ['primary', 'second', 'third'] as const;
    const cwds = [ROOT, SECOND, THIRD];
    const stale = cwds.map((cwd, index) => ({
      cwd,
      entry: { ...LINKED, path: path.join(ROOT, `stale-${index}`) },
    }));
    const gone = new Set<string>();
    const mineFor = (cwd: string) =>
      stale.find((one) => one.cwd === cwd)!.entry;
    listMock.mockImplementation(async (cwd: string) => {
      const mine = mineFor(cwd);
      return gone.has(mine.path)
        ? [MAIN]
        : [MAIN, { ...mine, prunable: 'gitdir file does not exist' }];
    });
    dryRunMock.mockImplementation(async (cwd: string) => [
      { id: 'stale', worktreePath: mineFor(cwd).path },
    ]);
    removeMock.mockRejectedValue(new Error('fatal: validation failed'));

    // Registered before anything runs: a gate created after its prune has
    // already entered would never be opened.
    const entered = new Map<string, () => void>();
    const enteredAt = new Map<string, Promise<void>>();
    const release = new Map<string, () => void>();
    for (const cwd of cwds) {
      enteredAt.set(
        cwd,
        new Promise<void>((resolve) => entered.set(cwd, resolve)),
      );
    }
    let running = 0;
    let peak = 0;
    const trace: string[] = [];
    pruneMock.mockImplementation(async (cwd: string) => {
      running += 1;
      peak = Math.max(peak, running);
      trace.push(`enter:${cwd}`);
      await new Promise<void>((resolve) => {
        release.set(cwd, resolve);
        entered.get(cwd)?.();
      });
      gone.add(mineFor(cwd).path);
      trace.push(`exit:${cwd}`);
      running -= 1;
    });
    const app = mount(ids.map((id, index) => runtime(id, cwds[index], true)));
    // `.then` is what sends a supertest request; holding the builder would
    // leave it unsent and every gate below waiting on it.
    const remove = (index: number) =>
      request(app)
        .post(`/workspaces/${ids[index]}/git/worktrees/remove`)
        .send({ path: stale[index].entry.path })
        .then((answer) => answer);

    const first = remove(0);
    await enteredAt.get(ROOT);
    // Queued behind the first, and — this is the point — still queued when
    // the first settles. `removeGitWorktree` is the last thing the route
    // does before taking its turn, so waiting for that call is how the test
    // knows the second removal has reached the queue rather than merely
    // been sent.
    const second = remove(1);
    await waitUntil(() =>
      removeMock.mock.calls.some((call) => call[1] === stale[1].entry.path),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    release.get(ROOT)!();
    expect((await first).status).toBe(200);
    await enteredAt.get(SECOND);

    // Arrives while the second is still pruning: with the row dropped by the
    // first's settle, this one starts its own prune beside it.
    const third = remove(2);
    await waitUntil(() =>
      removeMock.mock.calls.some((call) => call[1] === stale[2].entry.path),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    release.get(SECOND)!();
    expect((await second).status).toBe(200);
    await enteredAt.get(THIRD);
    release.get(THIRD)!();
    expect((await third).status).toBe(200);

    expect(pruneMock).toHaveBeenCalledTimes(3);
    expect([peak, trace.length]).toEqual([1, 6]);
  });
});
