/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * simple-git 4 strips git-impacting environment variables from the child
 * unless the client names them in `allowEnvironment`. `gitEnv()` deliberately
 * preserves the operator's commit identity, TLS trust anchors and protocol
 * allowlist; the guarded loader must re-allow exactly those keys so a real
 * GitWorktreeService call still spawns when they are set. Real git + real
 * simple-git against a temp repo — the unit suites mock the factory and cannot
 * see the spawn-time guard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitWorktreeService } from './gitWorktreeService.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('GitWorktreeService — gitEnv passthrough under the simple-git 4 env guard', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  let repoParent: string;
  let repoRoot: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-envpass-'));
    repoParent = await fs.realpath(dir);
    repoRoot = path.join(repoParent, 'repo');
    await fs.mkdir(repoRoot);
    git(repoRoot, 'init', '-q', '-b', 'main');
    git(repoRoot, 'config', 'user.email', 't@e.com');
    git(repoRoot, 'config', 'user.name', 't');
    git(repoRoot, 'config', 'commit.gpgsign', 'false');
    // An ambient core.autocrlf=true rewrites the carried file to CRLF and
    // fails the content assertion; pin the fixture to LF.
    git(repoRoot, 'config', 'core.autocrlf', 'false');
    await fs.writeFile(path.join(repoRoot, 'README.md'), 'base\n');
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-q', '-m', 'init', '--no-verify');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(repoParent, { recursive: true, force: true });
  });

  it('reads HEAD with ambient commit identity variables set', async () => {
    vi.stubEnv('GIT_AUTHOR_NAME', 'Operator');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'operator@example.invalid');
    vi.stubEnv('GIT_COMMITTER_NAME', 'Operator');
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'operator@example.invalid');
    const service = new GitWorktreeService(repoRoot);
    await expect(service.getCurrentCommitHash()).resolves.toMatch(
      /^[0-9a-f]{40}$/,
    );
    await expect(service.getCurrentBranch()).resolves.toBe('main');
  });

  it('reads HEAD with a scrubbed GIT_ALLOW_PROTOCOL and TLS anchors set', async () => {
    vi.stubEnv('GIT_ALLOW_PROTOCOL', 'https:ssh');
    vi.stubEnv('GIT_SSL_CAINFO', '/operator/ca.pem');
    vi.stubEnv('GIT_SSL_CAPATH', '/operator/certs');
    const service = new GitWorktreeService(repoRoot);
    await expect(service.getCurrentCommitHash()).resolves.toMatch(
      /^[0-9a-f]{40}$/,
    );
  });

  it('carries dirty state into a worktree with ambient identity set', async () => {
    vi.stubEnv('GIT_AUTHOR_NAME', 'Operator');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'operator@example.invalid');
    vi.stubEnv('GIT_COMMITTER_NAME', 'Operator');
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'operator@example.invalid');
    // A tracked edit makes createUserWorktree({carryDirtyState}) run
    // `stash create` / `stash apply` through simple-git with gitEnv();
    // without the loader's allowEnvironment passthrough the ambient identity
    // keys throw at the spawn-time environment guard before any git runs.
    await fs.writeFile(path.join(repoRoot, 'README.md'), 'dirty\n');
    const service = new GitWorktreeService(repoRoot);
    const created = await service.createUserWorktree('envpass', 'main', {
      carryDirtyState: true,
    });
    expect(created.success).toBe(true);
    const wt = created.worktree!.path;
    // The carried overlay landed: the worktree holds the dirty content, not
    // just the committed base — proof the guarded stash calls actually ran.
    expect(await fs.readFile(path.join(wt, 'README.md'), 'utf8')).toBe(
      'dirty\n',
    );
  });
});
