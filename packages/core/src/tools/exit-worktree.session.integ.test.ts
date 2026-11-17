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

type ExitParams = Parameters<ExitWorktreeTool['build']>[0];

const removeParams = (name: string): ExitParams => ({
  name,
  action: 'remove',
  discard_changes: true,
});

/** Exit config for a later session ('new-session' by default). */
const exitConfig = (
  targetDir: string,
  sessionService: SessionService,
  sessionId = 'new-session',
): Config =>
  ({
    getTargetDir: () => targetDir,
    getSessionId: () => sessionId,
    getSessionService: () => sessionService,
  }) as unknown as Config;

/** Records an 'old-session' runtime rooted at `dir` whose process is `pid`. */
const writeOldSessionStatus = (dir: string, pid: number) =>
  writeRuntimeStatus(new Storage(dir).getRuntimeStatusPath('old-session'), {
    sessionId: 'old-session',
    workDir: dir,
    pid,
  });

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

  const exit = (params: ExitParams, config = makeConfig()) =>
    new ExitWorktreeTool(config)
      .build(params)
      .execute(new AbortController().signal);

  /** Enters `slug` as 'old-session' and returns the worktree path. */
  async function enterAsOldSession(slug: string): Promise<string> {
    sessionId = 'old-session';
    await enterWorktree(slug);
    return new GitWorktreeService(repoRoot).getUserWorktreePath(slug);
  }

  /** Writes a sidecar re-attaching `slug` to 'new-session'; returns its path. */
  async function reattach(slug: string, wtPath: string, svc: SessionService) {
    const originalHeadCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    const sidecarPath = svc.getWorktreeSessionPath('new-session');
    await writeWorktreeSession(sidecarPath, {
      slug,
      worktreePath: wtPath,
      worktreeBranch: `worktree-${slug}`,
      originalCwd: repoRoot,
      originalBranch: 'main',
      originalHeadCommit,
    });
    return sidecarPath;
  }

  it('preserves the sidecar after keep so --resume can restore the worktree binding', async () => {
    // PR #4174 review #3259975245: `keep` used to clear the sidecar, which
    // broke --resume for kept worktrees; recovery relies on it persisting.
    await enterWorktree('keep-preserves-sidecar');
    const sessionPath = sessionService.getWorktreeSessionPath(sessionId);
    const before = await readWorktreeSession(sessionPath);
    expect(before).not.toBeNull();

    const result = await exit({
      name: 'keep-preserves-sidecar',
      action: 'keep',
    });
    expect(result.error).toBeUndefined();

    // Sidecar should remain untouched after keep — same slug, same path.
    expect(await readWorktreeSession(sessionPath)).toEqual(before);
  });

  it('clears the sidecar after remove', async () => {
    await enterWorktree('remove-clears-sidecar');
    const sessionPath = sessionService.getWorktreeSessionPath(sessionId);
    expect(await readWorktreeSession(sessionPath)).not.toBeNull();

    // EnterWorktree's untracked .qwen-worktree-session marker makes the
    // worktree dirty; discard_changes bypasses that guard to reach clear.
    const result = await exit(removeParams('remove-clears-sidecar'));
    expect(result.error).toBeUndefined();

    expect(await readWorktreeSession(sessionPath)).toBeNull();
  });

  it('does not clear the sidecar when slug does not match', async () => {
    await enterWorktree('tracked-slug');
    const sessionPath = sessionService.getWorktreeSessionPath(sessionId);
    const before = await readWorktreeSession(sessionPath);
    expect(before!.slug).toBe('tracked-slug');

    // Provision a second worktree out-of-band so the sidecar is NOT
    // overwritten, then exit it: the sidecar must still name tracked-slug.
    await new GitWorktreeService(repoRoot).createUserWorktree('other-slug');
    const result = await exit({ name: 'other-slug', action: 'keep' });
    expect(result.error).toBeUndefined();

    const after = await readWorktreeSession(sessionPath);
    expect(after).not.toBeNull();
    expect(after!.slug).toBe('tracked-slug');
  });

  it('is a no-op when no sidecar exists', async () => {
    // Provision a worktree directly via the service (no sidecar written).
    await new GitWorktreeService(repoRoot).createUserWorktree('no-sidecar');

    const result = await exit({ name: 'no-sidecar', action: 'keep' });
    expect(result.error).toBeUndefined();
    // No throw is the assertion.
  });

  it('removes a re-attached worktree when the old marker owner is inactive', async () => {
    const wtPath = await enterAsOldSession('reattached-stale');
    const currentSessionService = new SessionService(wtPath);
    await writeOldSessionStatus(wtPath, 2147483647);
    const sidecarPath = await reattach(
      'reattached-stale',
      wtPath,
      currentSessionService,
    );

    const result = await exit(
      removeParams('reattached-stale'),
      exitConfig(wtPath, currentSessionService),
    );

    expect(result.error).toBeUndefined();
    await expect(fs.access(wtPath)).rejects.toBeDefined();
    expect(await readWorktreeSession(sidecarPath)).toBeNull();
  });

  it('removes a stale-owned worktree when launched from inside it without a sidecar', async () => {
    const wtPath = await enterAsOldSession('cwd-stale');
    const nestedCwd = path.join(wtPath, 'nested');
    await fs.mkdir(nestedCwd);
    await writeOldSessionStatus(wtPath, 2147483647);

    const invocation = new ExitWorktreeTool(
      exitConfig(nestedCwd, new SessionService(wtPath)),
    ).build(removeParams('cwd-stale'));
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
    const wtPath = await enterAsOldSession('reattached-active');
    await writeOldSessionStatus(wtPath, process.pid);
    const currentSessionService = new SessionService(wtPath);
    await reattach('reattached-active', wtPath, currentSessionService);

    const result = await exit(
      removeParams('reattached-active'),
      exitConfig(wtPath, currentSessionService),
    );

    expect(result.error?.message).toMatch(
      /different session.*owner=old-session/i,
    );
    await expect(fs.access(wtPath)).resolves.toBeUndefined();
  });

  it('refuses a re-attached remove when the owner is active under a repo-subdir relative runtime dir', async () => {
    const wtPath = await enterAsOldSession('reattached-relative-active');
    const packageDir = path.join(repoRoot, 'packages', 'app');
    await fs.mkdir(packageDir, { recursive: true });
    Storage.setRuntimeBaseDir('.qwen', packageDir);
    await writeOldSessionStatus(packageDir, process.pid);

    Storage.setRuntimeBaseDir('.qwen', wtPath);
    const currentSessionService = new SessionService(wtPath);
    await reattach('reattached-relative-active', wtPath, currentSessionService);

    const result = await exit(
      removeParams('reattached-relative-active'),
      exitConfig(wtPath, currentSessionService),
    );

    expect(result.error?.message).toMatch(
      /different session.*owner=old-session/i,
    );
    await expect(fs.access(wtPath)).resolves.toBeUndefined();
  });
});
