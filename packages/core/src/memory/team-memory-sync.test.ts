/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncTeamMemory } from './team-memory-sync.js';
import { clearAutoMemoryRootCache, getTeamAutoMemoryRoot } from './paths.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function makeWorkingClone(bareRemote: string, label: string): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `qwen-sync-${label}-`));
  git(parent, 'clone', bareRemote, 'repo');
  const repo = path.join(parent, 'repo');
  git(repo, 'config', 'user.email', `${label}@example.com`);
  git(repo, 'config', 'user.name', label);
  return repo;
}

function writeTeamMemory(repo: string, rel: string, body: string): void {
  const file = path.join(getTeamAutoMemoryRoot(repo), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `---\nname: ${rel}\ndescription: ${body}\ntype: feedback\n---\n${body}`,
  );
}

describe('syncTeamMemory', () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    clearAutoMemoryRootCache();
  });

  afterEach(() => {
    clearAutoMemoryRootCache();
    for (const dir of cleanup.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshRemoteAndClone(label: string): { bare: string; repo: string } {
    const bareParent = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-sync-bare-'),
    );
    cleanup.push(bareParent);
    const bare = path.join(bareParent, 'remote.git');
    git(bareParent, 'init', '--bare', '--initial-branch=main', 'remote.git');
    const repo = makeWorkingClone(bare, label);
    cleanup.push(path.dirname(repo));
    // Seed an initial commit so `main` exists with an upstream.
    fs.writeFileSync(path.join(repo, 'README.md'), 'seed');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'seed');
    git(repo, 'push', '-u', 'origin', 'main');
    return { bare, repo };
  }

  it('skips when the path is not a git repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-sync-nogit-'));
    cleanup.push(dir);
    const result = await syncTeamMemory(dir, { message: 'sync' });
    expect(result.skippedReason).toBe('not-a-git-repo');
    expect(result.committed).toBe(false);
  });

  it('commits local team memory and pushes it to the remote', async () => {
    const { bare, repo } = freshRemoteAndClone('alice');
    writeTeamMemory(repo, 'feedback/use-real-db.md', 'use real DBs');

    const result = await syncTeamMemory(repo, { message: 'sync team memory' });
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);

    // A fresh clone of the remote now contains the pushed memory file.
    const verify = makeWorkingClone(bare, 'verify');
    cleanup.push(path.dirname(verify));
    expect(
      fs.existsSync(
        path.join(getTeamAutoMemoryRoot(verify), 'feedback/use-real-db.md'),
      ),
    ).toBe(true);
  }, 30_000);

  it('attributes the commit to opts.author when provided', async () => {
    const { repo } = freshRemoteAndClone('alice');
    writeTeamMemory(repo, 'feedback/x.md', 'note');

    await syncTeamMemory(repo, {
      message: 'sync',
      author: { name: 'bob', email: 'bob@team.dev' },
    });

    // The commit AUTHOR is bob even though the repo's git user is alice.
    expect(git(repo, 'log', '-1', '--format=%an <%ae>').trim()).toBe(
      'bob <bob@team.dev>',
    );
  }, 30_000);

  it('fast-forward-pulls team memory another collaborator pushed', async () => {
    const { bare, repo } = freshRemoteAndClone('alice');
    // Bob clones, adds a team memory, and pushes it.
    const bob = makeWorkingClone(bare, 'bob');
    cleanup.push(path.dirname(bob));
    writeTeamMemory(bob, 'reference/grafana.md', 'oncall dashboard');
    git(bob, 'add', '--', '.qwen/team-memory');
    git(bob, 'commit', '-m', 'bob adds reference');
    git(bob, 'push');

    // Alice's repo has no local team memory yet, so the pull fast-forwards.
    const result = await syncTeamMemory(repo, { message: 'sync' });
    expect(result.pulled).toBe(true);
    expect(
      fs.existsSync(
        path.join(getTeamAutoMemoryRoot(repo), 'reference/grafana.md'),
      ),
    ).toBe(true);
  }, 30_000);

  it('reconciles a second writer instead of diverging (commit lands on top)', async () => {
    const { bare, repo } = freshRemoteAndClone('alice');
    // Bob advances the remote with his own team memory file.
    const bob = makeWorkingClone(bare, 'bob');
    cleanup.push(path.dirname(bob));
    writeTeamMemory(bob, 'reference/grafana.md', 'oncall dashboard');
    git(bob, 'add', '--', '.qwen/team-memory');
    git(bob, 'commit', '-m', 'bob adds reference');
    git(bob, 'push');

    // Alice has a local (uncommitted) team memory change. Reconcile-first pulls
    // bob's commit, then commits alice's change on top — no divergence, no wedge.
    writeTeamMemory(repo, 'feedback/use-real-db.md', 'use real DBs');

    const result = await syncTeamMemory(repo, { message: 'sync' });
    expect(result.pulled).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.skippedReason).toBeUndefined();

    // A fresh clone now has BOTH collaborators' files.
    const verify = makeWorkingClone(bare, 'verify');
    cleanup.push(path.dirname(verify));
    const teamDir = getTeamAutoMemoryRoot(verify);
    expect(fs.existsSync(path.join(teamDir, 'reference/grafana.md'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(teamDir, 'feedback/use-real-db.md'))).toBe(
      true,
    );
  }, 30_000);

  it('reports pull-failed (not silent) when the branch has truly diverged', async () => {
    const { bare, repo } = freshRemoteAndClone('alice');
    // Bob advances the remote.
    const bob = makeWorkingClone(bare, 'bob');
    cleanup.push(path.dirname(bob));
    writeTeamMemory(bob, 'reference/grafana.md', 'oncall dashboard');
    git(bob, 'add', '--', '.qwen/team-memory');
    git(bob, 'commit', '-m', 'bob adds reference');
    git(bob, 'push');

    // Alice already has her own unpushed commit on the old base, so the branches
    // genuinely diverge (each side has a commit the other lacks).
    fs.writeFileSync(path.join(repo, 'alice-local.txt'), 'diverging work');
    git(repo, 'add', 'alice-local.txt');
    git(repo, 'commit', '-m', 'alice diverges');

    // A new team memory change then triggers the sync; reconcile-first refuses.
    writeTeamMemory(repo, 'feedback/use-real-db.md', 'use real DBs');

    const result = await syncTeamMemory(repo, { message: 'sync' });
    expect(result.pulled).toBe(false);
    expect(result.pushed).toBe(false);
    // Reconcile failed before the commit, so nothing was committed this cycle.
    expect(result.committed).toBe(false);
    // The opted-in user must get a signal, not a silent no-op.
    expect(result.skippedReason).toBe('pull-failed');
  }, 30_000);

  it('commits locally but skips push when there is no upstream', async () => {
    // A git repo with a commit but no remote / no upstream configured.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-sync-noup-'));
    cleanup.push(parent);
    const repo = path.join(parent, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '--initial-branch=main');
    git(repo, 'config', 'user.email', 'solo@example.com');
    git(repo, 'config', 'user.name', 'solo');
    fs.writeFileSync(path.join(repo, 'README.md'), 'seed');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'seed');

    writeTeamMemory(repo, 'feedback/x.md', 'note');
    const result = await syncTeamMemory(repo, { message: 'sync' });
    // Local changes are still persisted, but nothing is pushed without upstream.
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.skippedReason).toBe('no-upstream');
  });

  it('skips cleanly on a detached HEAD instead of orphaning a commit', async () => {
    const { repo } = freshRemoteAndClone('alice');
    // Detach HEAD onto the current commit — there is no branch to advance, so a
    // commit here would be orphaned (unreachable, never pushable).
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'checkout', '--detach', head);

    writeTeamMemory(repo, 'feedback/x.md', 'note');
    const result = await syncTeamMemory(repo, { message: 'sync' });

    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.skippedReason).toBe('detached-head');
    // HEAD is unmoved: the team change is left uncommitted, not stranded on top.
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(head);
  }, 30_000);

  it('unstages the team path when the commit fails (e.g. a failing hook)', async () => {
    const { repo } = freshRemoteAndClone('alice');
    // A pre-commit hook that always fails forces the commit step to error out.
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);

    writeTeamMemory(repo, 'feedback/x.md', 'note');
    const result = await syncTeamMemory(repo, { message: 'sync' });

    expect(result.committed).toBe(false);
    // The team path must NOT be left staged, or the user's next manual commit
    // would sweep it in.
    expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('');
  }, 30_000);

  it('does not push commits the sync did not create (branch already ahead)', async () => {
    const { bare, repo } = freshRemoteAndClone('alice');
    // Alice has an unrelated local commit that was never pushed.
    fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'local only');
    git(repo, 'add', 'unrelated.txt');
    git(repo, 'commit', '-m', 'unrelated local work');

    // A team memory change then triggers the sync.
    writeTeamMemory(repo, 'feedback/x.md', 'note');
    const result = await syncTeamMemory(repo, { message: 'sync' });

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.skippedReason).toBe('local-ahead');

    // The remote must NOT have received the unrelated commit (an unqualified
    // push would have published it).
    const verify = makeWorkingClone(bare, 'verify');
    cleanup.push(path.dirname(verify));
    expect(fs.existsSync(path.join(verify, 'unrelated.txt'))).toBe(false);
  }, 30_000);
});
