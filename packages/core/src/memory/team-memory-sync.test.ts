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

  it('reports pull-failed (not silent) when the branch has diverged', async () => {
    const { bare, repo } = freshRemoteAndClone('alice');
    // Bob advances the remote.
    const bob = makeWorkingClone(bare, 'bob');
    cleanup.push(path.dirname(bob));
    writeTeamMemory(bob, 'reference/grafana.md', 'oncall dashboard');
    git(bob, 'add', '--', '.qwen/team-memory');
    git(bob, 'commit', '-m', 'bob adds reference');
    git(bob, 'push');

    // Alice commits her own team memory WITHOUT pulling first → branches diverge.
    writeTeamMemory(repo, 'feedback/use-real-db.md', 'use real DBs');

    const result = await syncTeamMemory(repo, { message: 'sync' });
    expect(result.committed).toBe(true);
    expect(result.pulled).toBe(false);
    expect(result.pushed).toBe(false);
    // The opted-in user must get a signal, not a silent no-op.
    expect(result.skippedReason).toBe('pull-failed');
  }, 30_000);
});
