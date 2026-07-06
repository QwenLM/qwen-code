/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for `EnterWorktreeTool.execute()` — specifically the
 * WorktreeSession sidecar persistence introduced in Phase C.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EnterWorktreeTool } from './enter-worktree.js';
import { readWorktreeSession } from '../services/worktreeSessionService.js';
import { SessionService } from '../services/sessionService.js';
import type { Config } from '../config/config.js';

// Real git invocations + user-global hooks can take 10-20s on slow
// runners; bump per-test and per-hook timeouts. (Phase C #4174.)
describe('EnterWorktreeTool — WorktreeSession sidecar', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  let repoRoot: string;
  let sessionService: SessionService;
  let sessionId: string;

  beforeEach(async () => {
    // Resolve via realpath so macOS `/var` → `/private/var` symlink
    // matches what `git rev-parse --show-toplevel` returns.
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-enter-sess-'));
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
      // Phase D-2: createUserWorktree reads this for the symlink loop.
      // Return empty so the loop is a no-op in these tests.
      getWorktreeSymlinkDirectories: () => [],
    } as unknown as Config;
  }

  it('writes a WorktreeSession sidecar with all fields after creating worktree', async () => {
    const tool = new EnterWorktreeTool(makeConfig());
    const result = await tool
      .build({ name: 'session-test' })
      .execute(new AbortController().signal);
    expect(result.error).toBeUndefined();

    const sessionPath = sessionService.getWorktreeSessionPath(sessionId);
    const session = await readWorktreeSession(sessionPath);
    expect(session).not.toBeNull();
    expect(session!.slug).toBe('session-test');
    expect(session!.worktreePath).toContain('session-test');
    expect(session!.worktreeBranch).toBe('worktree-session-test');
    // Compare via path.normalize so the assertion holds on Windows,
    // where Node's fs.mkdtemp returns backslash-separated paths but
    // git's rev-parse --show-toplevel (which enter_worktree captures
    // as originalCwd via getRepoTopLevel) returns forward slashes.
    expect(path.normalize(session!.originalCwd)).toBe(path.normalize(repoRoot));
    expect(session!.originalBranch).toBe('main');
    // Full SHA from `git rev-parse HEAD`, not the short form.
    expect(session!.originalHeadCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('overwrites a previous sidecar when entering a new worktree in the same session', async () => {
    const tool = new EnterWorktreeTool(makeConfig());
    await tool.build({ name: 'first' }).execute(new AbortController().signal);
    // Note: in practice the model would have to exit the first worktree
    // before entering a second; here we just verify the write semantics —
    // a fresh `enter_worktree` overwrites any stale sidecar.
    //
    // (The nested-worktree guard in execute() rejects this when cwd is
    //  inside .qwen/worktrees/, but our test cwd is repoRoot, not the
    //  worktree, so the guard doesn't trip.)
    await tool.build({ name: 'second' }).execute(new AbortController().signal);

    const sessionPath = sessionService.getWorktreeSessionPath(sessionId);
    const session = await readWorktreeSession(sessionPath);
    expect(session!.slug).toBe('second');
  });
});
