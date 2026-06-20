/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for `ExitWorktreeTool.execute()` — specifically the
 * WorktreeSession sidecar cleanup introduced in Phase C.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EnterWorktreeTool } from './enter-worktree.js';
import { ExitWorktreeTool } from './exit-worktree.js';
import {
  readWorktreeSession,
  writeWorktreeSession,
} from '../services/worktreeSessionService.js';
import { SessionService } from '../services/sessionService.js';
import { GitWorktreeService } from '../services/gitWorktreeService.js';
import { Storage } from '../config/storage.js';
import { writeRuntimeStatus } from '../utils/runtimeStatus.js';
import type { Config } from '../config/config.js';

// Real git invocations + user-global hooks can take 10-20s on slow
// runners; bump per-test and per-hook timeouts. (Phase C #4174.)
describe('ExitWorktreeTool — WorktreeSession sidecar cleanup', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  let repoRoot: string;
  let sessionService: SessionService;
  let sessionId: string;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-exit-sess-'));
    repoRoot = await fs.realpath(raw);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repoRoot });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
      cwd: repoRoot,
    });
    await fs.writeFile(path.join(repoRoot, 'README.md'), 'hi\n');
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
      cwd: repoRoot,
    });

    sessionService = new SessionService(repoRoot);
    Storage.setRuntimeBaseDir(path.join(repoRoot, '.runtime'));
    sessionId = 'session-' + Math.random().toString(36).slice(2, 10);
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  function makeConfig(): Config {
    return {
      getTargetDir: () => repoRoot,
      getSessionId: () => sessionId,
      getSessionService: () => sessionService,
      // Phase D-2: EnterWorktreeTool (used here for setup) reads this
      // setting; return empty so the symlink loop is a no-op.
      getWorktreeSymlinkDirectories: () => [],
    } as unknown as Config;
  }

  async function enterWorktree(slug: string): Promise<void> {
    const enter = new EnterWorktreeTool(makeConfig());
    const result = await enter
      .build({ name: slug })
      .execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
  }

  it('preserves the sidecar after keep so --resume can restore the worktree binding', async () => {
    // Phase C update (PR #4174 review #3259975245): `keep` used to clear
    // the sidecar, but that broke the resume mechanism for kept worktrees.
    // The model/user can still recover the kept worktree on --resume only
    // because the sidecar persists.
    await enterWorktree('keep-preserves-sidecar');
    const sessionPath = sessionService.getWorktreeSessionPath(sessionId);
    const before = await readWorktreeSession(sessionPath);
    expect(before).not.toBeNull();

    const exit = new ExitWorktreeTool(makeConfig());
    const result = await exit
      .build({ name: 'keep-preserves-sidecar', action: 'keep' })
      .execute(new AbortController().signal);
    expect(result.error).toBeUndefined();

    // Sidecar should remain untouched after keep — same slug, same path.
    const after = await readWorktreeSession(sessionPath);
    expect(after).toEqual(before);
  });

  it('clears the sidecar after remove', async () => {
    await enterWorktree('remove-clears-sidecar');
    const sessionPath = sessionService.getWorktreeSessionPath(sessionId);
    expect(await readWorktreeSession(sessionPath)).not.toBeNull();

    // EnterWorktree writes a .qwen-worktree-session marker file inside the
    // worktree, which shows up as untracked. Pass discard_changes to bypass
    // the dirty-state guard so we can exercise the remove → clear path.
    const exit = new ExitWorktreeTool(makeConfig());
    const result = await exit
      .build({
        name: 'remove-clears-sidecar',
        action: 'remove',
        discard_changes: true,
      })
      .execute(new AbortController().signal);
    expect(result.error).toBeUndefined();

    expect(await readWorktreeSession(sessionPath)).toBeNull();
  });

  it('does not clear the sidecar when slug does not match', async () => {
    // Enter "tracked-slug" so the sidecar references it.
    await enterWorktree('tracked-slug');
    const sessionPath = sessionService.getWorktreeSessionPath(sessionId);
    const before = await readWorktreeSession(sessionPath);
    expect(before!.slug).toBe('tracked-slug');

    // Now provision a second worktree out-of-band (without going through
    // the tool, so the sidecar is NOT overwritten).
    const { GitWorktreeService } = await import(
      '../services/gitWorktreeService.js'
    );
    const svc = new GitWorktreeService(repoRoot);
    await svc.createUserWorktree('other-slug');

    // Exit "other-slug". The sidecar still names "tracked-slug" — must
    // remain intact.
    const exit = new ExitWorktreeTool(makeConfig());
    const result = await exit
      .build({ name: 'other-slug', action: 'keep' })
      .execute(new AbortController().signal);
    expect(result.error).toBeUndefined();

    const after = await readWorktreeSession(sessionPath);
    expect(after).not.toBeNull();
    expect(after!.slug).toBe('tracked-slug');
  });

  it('is a no-op when no sidecar exists', async () => {
    // Provision a worktree directly via the service (no sidecar written).
    const { GitWorktreeService } = await import(
      '../services/gitWorktreeService.js'
    );
    const svc = new GitWorktreeService(repoRoot);
    await svc.createUserWorktree('no-sidecar');

    const exit = new ExitWorktreeTool(makeConfig());
    const result = await exit
      .build({ name: 'no-sidecar', action: 'keep' })
      .execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    // No throw is the assertion.
  });

  it('removes a re-attached worktree when the old marker owner is inactive', async () => {
    sessionId = 'old-session';
    await enterWorktree('reattached-stale');
    const wtPath = new GitWorktreeService(repoRoot).getUserWorktreePath(
      'reattached-stale',
    );

    const currentSessionId = 'new-session';
    const currentSessionService = new SessionService(wtPath);
    const currentSessionPath =
      currentSessionService.getWorktreeSessionPath(currentSessionId);
    await writeRuntimeStatus(
      new Storage(wtPath).getRuntimeStatusPath('old-session'),
      {
        sessionId: 'old-session',
        workDir: wtPath,
        pid: 2147483647,
      },
    );
    const originalHeadCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    await writeWorktreeSession(currentSessionPath, {
      slug: 'reattached-stale',
      worktreePath: wtPath,
      worktreeBranch: 'worktree-reattached-stale',
      originalCwd: repoRoot,
      originalBranch: 'main',
      originalHeadCommit,
    });

    const exitConfig = {
      getTargetDir: () => wtPath,
      getSessionId: () => currentSessionId,
      getSessionService: () => currentSessionService,
    } as unknown as Config;
    const result = await new ExitWorktreeTool(exitConfig)
      .build({
        name: 'reattached-stale',
        action: 'remove',
        discard_changes: true,
      })
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    await expect(fs.access(wtPath)).rejects.toBeDefined();
    expect(await readWorktreeSession(currentSessionPath)).toBeNull();
  });

  it('removes a stale-owned worktree when launched from inside it without a sidecar', async () => {
    sessionId = 'old-session';
    await enterWorktree('cwd-stale');
    const wtPath = new GitWorktreeService(repoRoot).getUserWorktreePath(
      'cwd-stale',
    );
    const nestedCwd = path.join(wtPath, 'nested');
    await fs.mkdir(nestedCwd);
    await writeRuntimeStatus(
      new Storage(wtPath).getRuntimeStatusPath('old-session'),
      {
        sessionId: 'old-session',
        workDir: wtPath,
        pid: 2147483647,
      },
    );

    const currentSessionService = new SessionService(wtPath);
    const exitConfig = {
      getTargetDir: () => nestedCwd,
      getSessionId: () => 'new-session',
      getSessionService: () => currentSessionService,
    } as unknown as Config;
    const invocation = new ExitWorktreeTool(exitConfig).build({
      name: 'cwd-stale',
      action: 'remove',
      discard_changes: true,
    });
    const details = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );
    expect(details.type).toBe('exec');
    if (details.type === 'exec') {
      expect(details.command).toContain(`git worktree remove ${wtPath}`);
      expect(details.command).not.toContain(
        path.join(nestedCwd, '.qwen', 'worktrees', 'cwd-stale'),
      );
    }

    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    await expect(fs.access(wtPath)).rejects.toBeDefined();
  });

  it('refuses a re-attached remove when the marker owner runtime is active', async () => {
    sessionId = 'old-session';
    await enterWorktree('reattached-active');
    const wtPath = new GitWorktreeService(repoRoot).getUserWorktreePath(
      'reattached-active',
    );

    await writeRuntimeStatus(
      new Storage(wtPath).getRuntimeStatusPath('old-session'),
      {
        sessionId: 'old-session',
        workDir: wtPath,
        pid: process.pid,
      },
    );

    const currentSessionId = 'new-session';
    const currentSessionService = new SessionService(wtPath);
    const originalHeadCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    await writeWorktreeSession(
      currentSessionService.getWorktreeSessionPath(currentSessionId),
      {
        slug: 'reattached-active',
        worktreePath: wtPath,
        worktreeBranch: 'worktree-reattached-active',
        originalCwd: repoRoot,
        originalBranch: 'main',
        originalHeadCommit,
      },
    );

    const exitConfig = {
      getTargetDir: () => wtPath,
      getSessionId: () => currentSessionId,
      getSessionService: () => currentSessionService,
    } as unknown as Config;
    const result = await new ExitWorktreeTool(exitConfig)
      .build({
        name: 'reattached-active',
        action: 'remove',
        discard_changes: true,
      })
      .execute(new AbortController().signal);

    expect(result.error?.message).toMatch(
      /different session.*owner=old-session/i,
    );
    await expect(fs.access(wtPath)).resolves.toBeUndefined();
  });

  it('refuses a re-attached remove when the owner is active under a repo-subdir relative runtime dir', async () => {
    sessionId = 'old-session';
    await enterWorktree('reattached-relative-active');
    const wtPath = new GitWorktreeService(repoRoot).getUserWorktreePath(
      'reattached-relative-active',
    );

    const packageDir = path.join(repoRoot, 'packages', 'app');
    await fs.mkdir(packageDir, { recursive: true });
    Storage.setRuntimeBaseDir('.qwen', packageDir);
    await writeRuntimeStatus(
      new Storage(packageDir).getRuntimeStatusPath('old-session'),
      {
        sessionId: 'old-session',
        workDir: packageDir,
        pid: process.pid,
      },
    );

    Storage.setRuntimeBaseDir('.qwen', wtPath);
    const currentSessionId = 'new-session';
    const currentSessionService = new SessionService(wtPath);
    const originalHeadCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    await writeWorktreeSession(
      currentSessionService.getWorktreeSessionPath(currentSessionId),
      {
        slug: 'reattached-relative-active',
        worktreePath: wtPath,
        worktreeBranch: 'worktree-reattached-relative-active',
        originalCwd: repoRoot,
        originalBranch: 'main',
        originalHeadCommit,
      },
    );

    const exitConfig = {
      getTargetDir: () => wtPath,
      getSessionId: () => currentSessionId,
      getSessionService: () => currentSessionService,
    } as unknown as Config;
    const result = await new ExitWorktreeTool(exitConfig)
      .build({
        name: 'reattached-relative-active',
        action: 'remove',
        discard_changes: true,
      })
      .execute(new AbortController().signal);

    expect(result.error?.message).toMatch(
      /different session.*owner=old-session/i,
    );
    await expect(fs.access(wtPath)).resolves.toBeUndefined();
  });
});
