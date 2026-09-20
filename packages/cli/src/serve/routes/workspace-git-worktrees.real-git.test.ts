/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The seam between these routes and git itself.
 *
 * `workspace-git-worktrees.test.ts` mocks the whole core git layer to pin the
 * route's decisions, which means it would pass just as well if
 * `removeGitWorktree` did nothing at all. Everything here runs against real
 * temporary repositories with nothing mocked, so each assertion is about what
 * git actually did to the filesystem: a refusal that leaves the checkout in
 * place, a forced removal that deletes it, a stale registration that goes away
 * alone, and the one registration git refuses to remove at any force level —
 * a directory that outlived its gitfile — reaching the prune fallback with its
 * files untouched.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { sendBridgeError } from '../server/error-response.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerWorkspaceQualifiedGitWorktreeRoutes } from './workspace-git-worktrees.js';

/** The wire shape the list route emits, as the tests read it back. */
interface ListedWorktree {
  path: string;
  head: string;
  branch: string | null;
  isMain: boolean;
  isWorkspace: boolean;
  slug?: string;
  prunable?: string;
  locked?: string;
}

const tmpRoots: string[] = [];

/**
 * git with the host's own configuration out of the way.
 *
 * Every repository these tests build configures what it needs. Leaving the
 * machine's `~/.gitconfig` readable would let a test pass here because the
 * author has an identity or a hook path set, and fail on a runner that does
 * not — which is exactly how a commit made in a submodule clone got through.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
}

/** Give a repository the identity and the quiet the fixtures need. */
function configure(dir: string): void {
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  // Neutralize an inherited global core.hooksPath (hook managers installed
  // machine-wide), which would otherwise run somebody else's hooks here.
  git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'hooks'));
}

/** A repository with `.qwen/worktrees/<slug>` checkouts, as the daemon makes. */
function makeRepo(slugs: string[] = []): { repo: string; worktrees: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-wt-routes-'));
  tmpRoots.push(root);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  configure(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const worktrees = slugs.map((slug) => {
    const target = path.join(repo, '.qwen', 'worktrees', slug);
    git(repo, 'worktree', 'add', '-q', target, '-b', `qwen/${slug}`);
    return target;
  });
  return { repo, worktrees };
}

function runtime(
  workspaceCwd: string,
  liveSessions: Array<{ sessionId: string; worktree?: { path: string } }> = [],
  workspaceId = 'primary',
): WorkspaceRuntime {
  return {
    workspaceId,
    workspaceCwd,
    primary: workspaceId === 'primary',
    trusted: true,
    // A real runtime carries the daemon's whole environment, which is what
    // puts git on PATH; a sparse overlay here would not reach git at all.
    env: { mode: 'parent-process', overlayKeys: [], effectiveEnv: process.env },
    bridge: {
      publishWorkspaceEvent: vi.fn(),
      // Bound to one workspace, like the real bridge: any other cwd is `[]`.
      listWorkspaceSessions: (cwd: string) =>
        cwd === workspaceCwd ? liveSessions : [],
    } as unknown as AcpSessionBridge,
  } as unknown as WorkspaceRuntime;
}

function mount(runtimes: WorkspaceRuntime[]) {
  const app = express();
  app.use(express.json());
  registerWorkspaceQualifiedGitWorktreeRoutes(app, {
    workspaceRegistry: createWorkspaceRegistry(runtimes),
    sendBridgeError,
    mutate:
      () =>
      (_req: unknown, _res: unknown, next: () => void): void =>
        next(),
  });
  return app;
}

/** Paths git still has registered, as the route's own listing sees them. */
async function registeredPaths(app: express.Express): Promise<string[]> {
  const response = await request(app).get('/workspaces/primary/git/worktrees');
  expect(response.status).toBe(200);
  return (response.body.worktrees as ListedWorktree[]).map(
    (entry) => entry.path,
  );
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('workspace git worktree routes against real git', () => {
  it('lists the real repository, marking the workspace and managed slugs', async () => {
    const { repo, worktrees } = makeRepo(['swift-fox']);
    const app = mount([runtime(repo)]);

    const response = await request(app).get(
      '/workspaces/primary/git/worktrees',
    );

    expect(response.status).toBe(200);
    expect(response.body.available).toBe(true);
    const entries = response.body.worktrees as ListedWorktree[];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      isMain: true,
      isWorkspace: true,
      branch: 'main',
    });
    expect(entries[0].head).toMatch(/^[0-9a-f]{40}$/);
    expect(entries[1]).toMatchObject({
      isMain: false,
      isWorkspace: false,
      branch: 'qwen/swift-fox',
      slug: 'swift-fox',
    });
    expect(fs.realpathSync(entries[1].path)).toBe(
      fs.realpathSync(worktrees[0]),
    );
  }, 20_000);

  it('reads a real worktree’s counters and refuses an arbitrary path', async () => {
    const { repo, worktrees } = makeRepo(['swift-fox']);
    fs.writeFileSync(path.join(worktrees[0], 'untracked.txt'), 'x\n');
    const app = mount([runtime(repo)]);
    const listed = (await registeredPaths(app))[1];

    const status = await request(app).get(
      `/workspaces/primary/git/worktrees/status?path=${encodeURIComponent(listed)}`,
    );
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      available: true,
      branch: 'qwen/swift-fox',
      untracked: 1,
      staged: 0,
    });

    // A directory that is a real git repository but not one of this
    // repository's worktrees is still refused, so the probe cannot be aimed.
    const other = makeRepo().repo;
    const refused = await request(app).get(
      `/workspaces/primary/git/worktrees/status?path=${encodeURIComponent(other)}`,
    );
    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe('worktree_not_found');
  }, 20_000);

  it('answers for the main worktree, whose `.git` is a directory', async () => {
    // No linked worktree: `.qwen/worktrees/` would itself be untracked and
    // the count is the assertion here.
    const { repo } = makeRepo();
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'x\n');
    const app = mount([runtime(repo)]);
    const main = (await registeredPaths(app))[0];

    const status = await request(app).get(
      `/workspaces/primary/git/worktrees/status?path=${encodeURIComponent(main)}`,
    );

    // The readability gate asks whether `<path>/.git` is a gitfile, which is
    // how git reaches a *linked* worktree. The main worktree is the one entry
    // that legitimately keeps a `.git` directory instead, so it needs the
    // exception — without it the repository's own checkout is the only one
    // the tab cannot show state for.
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      available: true,
      branch: 'main',
      untracked: 1,
    });
  }, 20_000);

  it('carries a lock git recorded without a reason', async () => {
    const { repo, worktrees } = makeRepo(['locked-fox']);
    // `git worktree lock` with no `--reason` records a bare `locked` line, so
    // the reason is the empty string. Presence is the lock; anything that
    // tests this field for truthiness drops the lock altogether.
    git(repo, 'worktree', 'lock', worktrees[0]);
    const app = mount([runtime(repo)]);

    const listed = await request(app).get('/workspaces/primary/git/worktrees');

    expect(listed.status).toBe(200);
    const entry = (listed.body.worktrees as ListedWorktree[])[1];
    expect(entry.locked).toBe('');
  }, 20_000);

  it('refuses a dirty worktree, then deletes it from disk when forced', async () => {
    const { repo, worktrees } = makeRepo(['swift-fox']);
    fs.writeFileSync(path.join(worktrees[0], 'work.txt'), 'in progress\n');
    const app = mount([runtime(repo)]);
    const listed = (await registeredPaths(app))[1];

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'worktree_dirty', changes: 1 });
    // The refusal is the point: the checkout is still there.
    expect(fs.existsSync(worktrees[0])).toBe(true);

    const forced = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed, force: true });
    expect(forced.status).toBe(200);
    expect(fs.existsSync(worktrees[0])).toBe(false);
    expect(await registeredPaths(app)).toHaveLength(1);
    // Removal drops the checkout, never the branch.
    expect(git(repo, 'branch', '--list', 'qwen/swift-fox').trim()).toBe(
      'qwen/swift-fox',
    );
  }, 20_000);

  it('removes a clean worktree without force', async () => {
    const { repo, worktrees } = makeRepo(['swift-fox']);
    const app = mount([runtime(repo)]);
    const listed = (await registeredPaths(app))[1];

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed });

    expect(response.status).toBe(200);
    expect(fs.existsSync(worktrees[0])).toBe(false);
    // git really deleted it, so nothing is claimed about leftovers.
    expect(response.body).toEqual({ removed: true, path: listed });
    expect(await registeredPaths(app)).toHaveLength(1);
  }, 20_000);

  it('drops one stale registration and leaves the repository’s others', async () => {
    const { repo, worktrees } = makeRepo(['gone-a', 'gone-b']);
    fs.rmSync(worktrees[0], { recursive: true, force: true });
    fs.rmSync(worktrees[1], { recursive: true, force: true });
    const app = mount([runtime(repo)]);
    const listed = await registeredPaths(app);
    expect(listed).toHaveLength(3);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed[1] });

    expect(response.status).toBe(200);
    // Repository-wide prune would have taken `gone-b` with it.
    expect(await registeredPaths(app)).toEqual([listed[0], listed[2]]);
  }, 20_000);

  it('clears a registration whose directory outlived its gitfile, keeping the files', async () => {
    const { repo, worktrees } = makeRepo(['orphan']);
    const kept = path.join(worktrees[0], 'kept.txt');
    fs.writeFileSync(kept, 'not mine to delete\n');
    fs.rmSync(path.join(worktrees[0], '.git'));
    const app = mount([runtime(repo)]);
    const listed = await request(app).get('/workspaces/primary/git/worktrees');
    const entry = (listed.body.worktrees as ListedWorktree[])[1];
    expect(entry.prunable).toBeTruthy();

    // `git worktree remove` rejects this at every force level, so the route
    // falls back to prune. Removal is about the registration, never the
    // directory's contents.
    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: entry.path });

    expect(response.status).toBe(200);
    expect(await registeredPaths(app)).toHaveLength(1);
    expect(fs.readFileSync(kept, 'utf8')).toBe('not mine to delete\n');
    // The row is about to disappear from the tab, which on its own reads as
    // "the directory is gone". It is not, and the response says so.
    expect(response.body.directoryRemains).toBe(true);
  }, 20_000);

  it('leaves the repository\u2019s other stale entries alone when it prunes', async () => {
    const { repo, worktrees } = makeRepo(['orphan', 'vanished']);
    // `orphan` keeps its directory and loses its gitfile: git refuses it
    // per-path at every force level, so it is the one that reaches prune.
    fs.rmSync(path.join(worktrees[0], '.git'));
    // `vanished` is stale too, and repository-wide prune would take it — with
    // the admin directory that is the last thing pointing at its commits.
    const survivorHead = git(repo, 'rev-parse', 'qwen/vanished').trim();
    fs.rmSync(worktrees[1], { recursive: true, force: true });
    const app = mount([runtime(repo)]);
    const listed = await registeredPaths(app);
    expect(listed).toHaveLength(3);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed.find((entry) => entry.endsWith('orphan'))! });

    expect(response.status).toBe(200);
    const after = await registeredPaths(app);
    expect(after.some((entry) => entry.endsWith('orphan'))).toBe(false);
    expect(after.some((entry) => entry.endsWith('vanished'))).toBe(true);
    // And the shield is released, not left on the survivor.
    const rows = await request(app).get('/workspaces/primary/git/worktrees');
    const survivor = (rows.body.worktrees as ListedWorktree[]).find((row) =>
      row.path.endsWith('vanished'),
    )!;
    expect(survivor.locked).toBeUndefined();
    expect(survivor.head).toBe(survivorHead);
  }, 20_000);

  it('ignores a stray file in the admin directory', async () => {
    const { repo, worktrees } = makeRepo(['orphan']);
    fs.rmSync(path.join(worktrees[0], '.git'));
    // `git worktree prune -v` names this too ("not a valid directory"), and
    // counting it would fail the removal for a reason that has nothing to do
    // with any worktree.
    fs.writeFileSync(path.join(repo, '.git', 'worktrees', '.DS_Store'), 'x');
    const app = mount([runtime(repo)]);
    const listed = (await registeredPaths(app))[1];

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed });

    expect(response.status).toBe(200);
    expect(await registeredPaths(app)).toHaveLength(1);
  }, 20_000);

  it('refuses rather than pruning past a registration the listing cannot show', async () => {
    const { repo, worktrees } = makeRepo(['orphan', 'hidden']);
    // `orphan` keeps its directory and loses its gitfile: git refuses it
    // per-path, so it reaches the prune fallback.
    fs.rmSync(path.join(worktrees[0], '.git'));
    // `hidden` loses the admin side's gitdir file, which takes it out of
    // `git worktree list` entirely — and out of reach of a lock — while
    // leaving it prunable. Its admin directory holds the only HEAD and
    // reflog for its commits.
    const hiddenAdmin = path.join(repo, '.git', 'worktrees', 'hidden');
    fs.rmSync(path.join(hiddenAdmin, 'gitdir'));
    const app = mount([runtime(repo)]);
    const listed = await registeredPaths(app);
    expect(listed.some((entry) => entry.endsWith('hidden'))).toBe(false);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed.find((entry) => entry.endsWith('orphan'))! });

    // A failed removal is retryable; a bystander's commits are not.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(fs.existsSync(hiddenAdmin)).toBe(true);
  }, 20_000);

  it('never answers for a broken worktree with the main worktree\u2019s state', async () => {
    const { repo, worktrees } = makeRepo(['stranded', 'orphan']);
    // `stranded` is locked, so git does not mark it prunable, and has lost
    // its gitfile, so git cannot reach it either. `orphan` has lost its
    // gitfile without a lock, which is the shape that still reaches the
    // removal path. Meanwhile the MAIN worktree is dirty.
    git(repo, 'worktree', 'lock', worktrees[0], '--reason', 'held');
    fs.rmSync(path.join(worktrees[0], '.git'));
    fs.rmSync(path.join(worktrees[1], '.git'));
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(repo, 'untracked-in-main.txt'), 'x\n');
    const app = mount([runtime(repo)]);
    // git lists linked worktrees in directory order, not creation order.
    const listed = await registeredPaths(app);
    const stranded = listed.find((p) => p.endsWith('stranded'))!;
    const orphan = listed.find((p) => p.endsWith('orphan'))!;

    const status = await request(app).get(
      `/workspaces/primary/git/worktrees/status?path=${encodeURIComponent(stranded)}`,
    );
    expect(status.status).toBe(200);
    // Without the readability guard this reports branch `main` and the main
    // worktree's counters under the stranded worktree's path.
    expect(status.body).toEqual({ v: 1, path: stranded, available: false });

    // The removal path has its own copy of that guard. Without it the probe
    // walks up to the dirty MAIN worktree and refuses this removal over
    // changes that live there — the lock is not what stops it, since this
    // entry carries none.
    const removal = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: orphan });
    expect(removal.status).toBe(200);
    expect(removal.body.code).toBeUndefined();
    expect(fs.existsSync(path.join(repo, 'untracked-in-main.txt'))).toBe(true);
  }, 20_000);

  it('never answers with another repository created in the worktree\u2019s place', async () => {
    const { repo, worktrees } = makeRepo(['salvaged']);
    fs.rmSync(path.join(worktrees[0], '.git'));
    // Someone runs `git init` in what is left of the stranded checkout. Its
    // `.git` is a real directory now, so a naive existence check would probe
    // it and report an unrelated repository's branch as this worktree's.
    git(worktrees[0], 'init', '-q', '-b', 'salvage');
    const app = mount([runtime(repo)]);
    const entry = (await registeredPaths(app))[1];

    const status = await request(app).get(
      `/workspaces/primary/git/worktrees/status?path=${encodeURIComponent(entry)}`,
    );

    expect(status.status).toBe(200);
    expect(status.body).toEqual({ v: 1, path: entry, available: false });
  }, 20_000);

  it('refuses a worktree another workspace is registered at by symlink', async () => {
    const { repo, worktrees } = makeRepo(['swift-fox']);
    // A workspace root reaches the daemon however the user spelled it. git
    // reports realpaths, so comparing the two as strings would miss this and
    // let a forced removal delete another workspace's checkout.
    const link = path.join(path.dirname(repo), 'link-to-fox');
    fs.symlinkSync(worktrees[0], link);
    const app = mount([runtime(repo), runtime(link, [], 'secondary')]);
    const listed = (await registeredPaths(app))[1];

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed, force: true });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('worktree_is_workspace');
    expect(fs.existsSync(worktrees[0])).toBe(true);
    expect(await registeredPaths(app)).toHaveLength(2);
  }, 20_000);

  it('refuses a detached worktree holding commits no ref keeps', async () => {
    const { repo, worktrees } = makeRepo(['adrift']);
    // Commit inside the worktree, then leave its branch behind: the worktree
    // is the only thing pointing at that commit.
    fs.writeFileSync(path.join(worktrees[0], 'work.txt'), 'kept?\n');
    git(worktrees[0], 'add', '.');
    git(worktrees[0], 'commit', '-q', '-m', 'orphan');
    const orphaned = git(worktrees[0], 'rev-parse', 'HEAD').trim();
    git(worktrees[0], 'checkout', '-q', '--detach', 'HEAD');
    git(repo, 'branch', '-D', 'qwen/adrift');
    const app = mount([runtime(repo)]);
    const listed = (await registeredPaths(app))[1];

    // git itself calls the worktree clean.
    const state = await request(app).get(
      `/workspaces/primary/git/worktrees/status?path=${encodeURIComponent(listed)}`,
    );
    expect(state.body).toMatchObject({ staged: 0, unstaged: 0, untracked: 0 });

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed });

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'worktree_unmerged_commits',
      unmergedHead: orphaned,
    });
    expect(fs.existsSync(worktrees[0])).toBe(true);

    const forced = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed, force: true });
    expect(forced.status).toBe(200);
  }, 20_000);

  it('counts untracked files the repository told git to hide', async () => {
    const { repo, worktrees } = makeRepo(['hidden']);
    git(repo, 'config', 'status.showUntrackedFiles', 'no');
    fs.writeFileSync(path.join(worktrees[0], 'unsaved.txt'), 'mine\n');
    const app = mount([runtime(repo)]);
    const listed = (await registeredPaths(app))[1];

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed });

    // git's own check is blinded by the same setting, so this gate is the
    // only thing between the file and a one-click deletion.
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'worktree_dirty', changes: 1 });
    expect(fs.existsSync(path.join(worktrees[0], 'unsaved.txt'))).toBe(true);
  }, 20_000);

  it('never runs a program the repository nominated', async () => {
    const { repo } = makeRepo(['swift-fox']);
    const ran = path.join(repo, 'fsmonitor-ran');
    const hook = path.join(repo, 'fsmonitor.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(ran)}\nexit 0\n`);
    fs.chmodSync(hook, 0o755);
    // A worktree's own repository chooses this, and git runs it on the index
    // refresh a removal's status check triggers.
    git(repo, 'config', 'core.fsmonitor', hook);
    const app = mount([runtime(repo)]);
    const listed = (await registeredPaths(app))[1];

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed });

    expect(response.status).toBe(200);
    expect(fs.existsSync(ran)).toBe(false);
  }, 20_000);

  it('lets a tag keep a detached worktree\u2019s commits', async () => {
    const { repo, worktrees } = makeRepo(['tagged']);
    fs.writeFileSync(path.join(worktrees[0], 'work.txt'), 'kept\n');
    git(worktrees[0], 'add', '.');
    git(worktrees[0], 'commit', '-q', '-m', 'tagged work');
    git(worktrees[0], 'checkout', '-q', '--detach', 'HEAD');
    git(repo, 'tag', 'keepsake', 'qwen/tagged');
    git(repo, 'branch', '-D', 'qwen/tagged');
    const app = mount([runtime(repo)]);
    const listed = (await registeredPaths(app))[1];

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed });

    // A tag keeps them just as a branch would; refusing here would be a
    // warning about a loss that is not going to happen.
    expect(response.status).toBe(200);
  }, 20_000);

  it('refuses a locked worktree until force is given', async () => {
    const { repo, worktrees } = makeRepo(['locked-fox']);
    git(repo, 'worktree', 'lock', '--reason', 'held by a build', worktrees[0]);
    const app = mount([runtime(repo)]);
    const listed = (await registeredPaths(app))[1];

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed });

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'worktree_locked',
      reason: 'held by a build',
    });
    expect(fs.existsSync(worktrees[0])).toBe(true);

    // git clears a lock under `--force --force`, so the second click is not
    // a promise the daemon cannot keep.
    const forced = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed, force: true });

    expect(forced.status).toBe(200);
    expect(fs.existsSync(worktrees[0])).toBe(false);
    expect(await registeredPaths(app)).toHaveLength(1);
  }, 20_000);

  it('never calls an unclearable registration a lock', async () => {
    const { repo, worktrees } = makeRepo(['stuck']);
    git(repo, 'worktree', 'lock', '--reason', 'held', worktrees[0]);
    fs.rmSync(path.join(worktrees[0], '.git'));
    const app = mount([runtime(repo)]);
    const stuck = (await registeredPaths(app)).find((entry) =>
      entry.endsWith('stuck'),
    )!;

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: stuck });

    // A directory that outlived its gitfile is the one shape force never
    // clears, and the lock keeps prune away from it. Reporting a lock here
    // would put a "Remove anyway" button on a refusal it cannot answer.
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.code).not.toBe('worktree_locked');
    expect(refused.body.code).not.toBe('worktree_remove_refused');

    const forced = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: stuck, force: true });

    // Which is the point: it really cannot be removed from here.
    expect(forced.status).toBeGreaterThanOrEqual(400);
    expect(await registeredPaths(app)).toContain(stuck);
  }, 20_000);

  it('prunes a dangling symlink, and says what it left behind', async () => {
    const { repo, worktrees } = makeRepo(['adrift']);
    fs.rmSync(worktrees[0], { recursive: true, force: true });
    fs.symlinkSync(path.join(repo, 'nowhere'), worktrees[0]);
    const app = mount([runtime(repo)]);
    const listed = await request(app).get('/workspaces/primary/git/worktrees');
    const entry = (listed.body.worktrees as ListedWorktree[]).find(
      (row) => !row.isMain,
    )!;
    // Unlocked, so git marks it prunable — a second shape it refuses per-path
    // and clears with prune, alongside a directory that outlived its gitfile.
    expect(entry.prunable).toBeTruthy();

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: entry.path });

    expect(response.status).toBe(200);
    expect(await registeredPaths(app)).toHaveLength(1);
    // The link is still there. `existsSync` follows it and would call the
    // path empty, which is the whole reason this asks `lstat`.
    expect(fs.lstatSync(worktrees[0]).isSymbolicLink()).toBe(true);
    expect(response.body.directoryRemains).toBe(true);
  }, 20_000);

  it('offers no force for a lock whose path is a dangling symlink', async () => {
    const { repo, worktrees } = makeRepo(['adrift']);
    git(repo, 'worktree', 'lock', '--reason', 'hold', worktrees[0]);
    // Nothing resolves at the path any more, but something is still there:
    // git finds the link and fails validating a gitfile through it.
    fs.rmSync(worktrees[0], { recursive: true, force: true });
    fs.symlinkSync(path.join(repo, 'nowhere'), worktrees[0]);
    const app = mount([runtime(repo)]);
    const adrift = (await registeredPaths(app)).find((entry) =>
      entry.endsWith('adrift'),
    )!;

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: adrift });

    expect(refused.body.code).not.toBe('worktree_locked');

    const forced = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: adrift, force: true });

    expect(forced.status).toBeGreaterThanOrEqual(400);
    expect(await registeredPaths(app)).toContain(adrift);
  }, 20_000);

  it('bounds and redacts a lock reason before it reaches a browser', async () => {
    const { repo, worktrees } = makeRepo(['noisy']);
    // `--reason` is written by anyone who can run git here, and it is
    // unbounded. It reaches the tab twice: as the badge's tooltip and, now,
    // as the sentence beside a destructive button.
    const reason = `see ${repo}/secret.txt ${'x'.repeat(4000)}`;
    git(repo, 'worktree', 'lock', '--reason', reason, worktrees[0]);
    const app = mount([runtime(repo)]);

    const listed = await request(app).get('/workspaces/primary/git/worktrees');
    const entry = (listed.body.worktrees as ListedWorktree[]).find(
      (row) => !row.isMain,
    )!;
    expect(entry.locked!.length).toBeLessThanOrEqual(512);
    expect(entry.locked).not.toContain(repo);

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: entry.path });

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('worktree_locked');
    expect(refused.body.reason.length).toBeLessThanOrEqual(512);
    expect(refused.body.reason).not.toContain(repo);
  }, 20_000);

  it('never cuts a lock reason in half an astral character', async () => {
    const { repo, worktrees } = makeRepo(['emoji']);
    // The bound counts UTF-16 units, so this one lands between the halves.
    git(
      repo,
      'worktree',
      'lock',
      '--reason',
      `${'x'.repeat(511)}\u{1F600}tail`,
      worktrees[0],
    );
    const app = mount([runtime(repo)]);

    const listed = await request(app).get('/workspaces/primary/git/worktrees');
    const locked = (listed.body.worktrees as ListedWorktree[]).find(
      (row) => !row.isMain,
    )!.locked!;

    expect(locked.length).toBeLessThanOrEqual(512);
    const last = locked.charCodeAt(locked.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  }, 20_000);

  it('offers force for a clean worktree git refuses over submodules', async () => {
    const { repo } = makeRepo();
    const inner = makeRepo().repo;
    git(
      repo,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      inner,
      'sub',
    );
    git(repo, 'commit', '-q', '-m', 'add submodule');
    const target = path.join(repo, '.qwen', 'worktrees', 'swift-fox');
    git(repo, 'worktree', 'add', '-q', target, '-b', 'qwen/swift-fox');
    git(
      target,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '--init',
      '-q',
    );
    const app = mount([runtime(repo)]);
    const listed = (await registeredPaths(app))[1];

    // Nothing earlier can catch this: git reports the worktree as clean.
    const state = await request(app).get(
      `/workspaces/primary/git/worktrees/status?path=${encodeURIComponent(listed)}`,
    );
    expect(state.body).toMatchObject({
      available: true,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    });

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed });

    expect(refused.status).toBe(409);
    // Named before git is asked, because forcing past git's own sentence
    // takes the submodule's repository with it and git never says so.
    expect(refused.body).toMatchObject({
      code: 'worktree_nested_repository',
      submodules: true,
    });
    expect(fs.existsSync(target)).toBe(true);

    const forced = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed, force: true });

    expect(forced.status).toBe(200);
    expect(fs.existsSync(target)).toBe(false);
  }, 30_000);

  it('names a submodule repository nobody has checked out', async () => {
    const { repo } = makeRepo();
    const inner = makeRepo().repo;
    git(
      repo,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      inner,
      'sub',
    );
    git(repo, 'commit', '-q', '-m', 'add submodule');
    const target = path.join(repo, '.qwen', 'worktrees', 'swift-fox');
    git(repo, 'worktree', 'add', '-q', target, '-b', 'qwen/swift-fox');
    git(
      target,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '--init',
      '-q',
    );
    // The submodule's clone is a third repository: it inherits neither the
    // superproject's configuration nor the origin's, so it needs its own.
    configure(path.join(target, 'sub'));
    // A commit that exists only inside the submodule's own repository, which
    // is what a removal would take with it.
    fs.writeFileSync(path.join(target, 'sub', 'only-here.txt'), 'x\n');
    git(path.join(target, 'sub'), 'add', '.');
    git(path.join(target, 'sub'), 'commit', '-q', '-m', 'only here');
    // Deinitialising empties the submodule's working directory. git stops
    // reporting it — `git submodule status` marks it `-` — while the
    // repository it built stays under the admin directory, so asking the
    // checkout alone answers that there is nothing to lose.
    git(target, 'submodule', 'deinit', '-f', 'sub');
    const modules = path.join(
      repo,
      '.git',
      'worktrees',
      'swift-fox',
      'modules',
      'sub',
    );
    expect(fs.existsSync(modules)).toBe(true);

    const app = mount([runtime(repo)]);
    const listed = (await registeredPaths(app))[1];

    // Clean, so no other gate refuses either.
    const state = await request(app).get(
      `/workspaces/primary/git/worktrees/status?path=${encodeURIComponent(listed)}`,
    );
    expect(state.body).toMatchObject({ staged: 0, unstaged: 0, untracked: 0 });

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed });

    expect(refused.body).toMatchObject({
      code: 'worktree_nested_repository',
      submodules: true,
    });
    expect(fs.existsSync(modules)).toBe(true);

    const forced = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed, force: true });

    // Which is the point of naming it: the second click really does take the
    // repository, and the commit only it held goes with it.
    expect(forced.status).toBe(200);
    expect(fs.existsSync(modules)).toBe(false);
  }, 30_000);

  it('refuses to remove the main worktree of a real repository', async () => {
    const { repo } = makeRepo(['swift-fox']);
    const app = mount([runtime(repo)]);
    const listed = await registeredPaths(app);

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed[0], force: true });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('worktree_is_main');
    expect(fs.existsSync(repo)).toBe(true);
  }, 20_000);

  it('refuses a worktree that hosts a live session until forced', async () => {
    const { repo, worktrees } = makeRepo(['swift-fox']);
    const app = mount([
      runtime(repo, [{ sessionId: 'live', worktree: { path: worktrees[0] } }]),
    ]);
    const listed = (await registeredPaths(app))[1];

    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'worktree_in_use',
      sessions: 1,
    });
    expect(fs.existsSync(worktrees[0])).toBe(true);

    const forced = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: listed, force: true });
    expect(forced.status).toBe(200);
    expect(fs.existsSync(worktrees[0])).toBe(false);
  }, 20_000);

  it('lists a bare repository first and refuses to remove it', async () => {
    const { repo } = makeRepo();
    const root = path.dirname(repo);
    git(root, 'clone', '--bare', '-q', repo, 'bare.git');
    const bare = path.join(root, 'bare.git');
    git(bare, 'worktree', 'add', '-q', path.join(root, 'linked'), '-b', 'side');
    const app = mount([runtime(bare)]);

    const listed = await request(app).get('/workspaces/primary/git/worktrees');
    const entries = listed.body.worktrees as ListedWorktree[];

    // The bare entry is always the first one git prints, which is what marks
    // it main. The route's separate `bare` guard is redundancy on a
    // destructive path, not a second way in.
    expect(entries[0]).toMatchObject({ bare: true, isMain: true });
    expect(entries[1]).toMatchObject({ bare: false, isMain: false });

    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: entries[0].path, force: true });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('worktree_is_main');
  }, 20_000);

  it('reports available:false outside a git repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-wt-norepo-'));
    tmpRoots.push(dir);
    const app = mount([runtime(dir)]);

    const response = await request(app).get(
      '/workspaces/primary/git/worktrees',
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ available: false, worktrees: [] });
  }, 20_000);
});
