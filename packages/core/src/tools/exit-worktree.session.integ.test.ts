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
import { readWorktreeSession } from '../services/worktreeSessionService.js';
import { SessionService } from '../services/sessionService.js';
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
    sessionId = 'session-' + Math.random().toString(36).slice(2, 10);
  });

  afterEach(async () => {
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
});
