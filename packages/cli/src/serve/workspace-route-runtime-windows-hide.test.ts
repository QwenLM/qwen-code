/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRuntime } from './workspace-registry.js';
import { resolveSessionManagedGitCwd } from './workspace-route-runtime.js';
import { recordedExecFileCalls } from '../test-utils/exec-file-recorder.js';
import {
  setupManagedWorktreeFixture,
  createManagedWorktreeSession,
} from '../test-utils/managed-worktree-fixture.js';

// The worktree-session poll shape the Web Shell actually sends
// (`GET /workspaces/:workspace/git?cwd=<worktree path>&sessionId=<id>`)
// resolves the requested cwd through the direct `execFileAsync('git', …)`
// call sites in `workspace-route-runtime.ts` (`resolveSessionManagedGitCwd`,
// `resolveGitCommonDir`, `resolveAbsoluteGitDir`); the plain contained-
// subdirectory shape additionally reaches `isLinkedWorktreeOrUnknown` and
// its combined `--git-common-dir --absolute-git-dir` probe. Each of the four
// sites must pass `windowsHide: true`: a detached daemon on Windows
// raises a visible console window per console-subsystem child otherwise
// (#17266). The shared recorder mock delegates to the real implementation,
// so the real-git fixtures in this file keep running unchanged.
vi.mock('node:child_process', () =>
  import('../test-utils/exec-file-recorder.js').then((m) =>
    m.createExecFileMockModule(),
  ),
);

describe('resolveSessionManagedGitCwd spawn options (worktree poll shape)', () => {
  let repo = '';
  let runtimeBase = '';
  const sessionId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    recordedExecFileCalls.length = 0;
    ({ repo, runtimeBase } = setupManagedWorktreeFixture());
  });

  afterEach(() => {
    // Skip teardown when the fixture failed: it cleans up after its own
    // failed setup, and these bindings were never assigned.
    if (repo === '' || runtimeBase === '') {
      return;
    }
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(runtimeBase, { recursive: true, force: true });
  });

  it('hides the console window of every git spawn on the worktree-session poll path', async () => {
    const { worktree, runtime } = createManagedWorktreeSession(
      repo,
      runtimeBase,
      sessionId,
    );

    // The exact request shape the Web Shell sends for worktree sessions.
    const pollRequest = {
      query: { cwd: worktree, sessionId },
    } as unknown as Request;
    expect(await resolveSessionManagedGitCwd(pollRequest, runtime)).toBe(
      fs.realpathSync(worktree),
    );

    // Completeness anchors: the happy path must have exercised the three
    // rev-parse shapes this poll shape spawns (`--show-toplevel` from
    // `resolveSessionManagedGitCwd`, `--git-common-dir` from
    // `resolveGitCommonDir`, `--absolute-git-dir` from
    // `resolveAbsoluteGitDir`), so the assertion below is not vacuous.
    // `isLinkedWorktreeOrUnknown` is deliberately not on this shape's path
    // (the managed-worktree location bypasses it); the sibling test below
    // pins its combined invocation.
    const gitSpawns = recordedExecFileCalls.filter(
      (call) => call.file === 'git',
    );
    expect(gitSpawns.length).toBeGreaterThan(0);
    const argLists = gitSpawns.map((call) => call.args);
    expect(argLists).toContainEqual(['rev-parse', '--show-toplevel']);
    expect(argLists).toContainEqual(['rev-parse', '--git-common-dir']);
    expect(argLists).toContainEqual(['rev-parse', '--absolute-git-dir']);

    for (const call of gitSpawns) {
      expect(
        call.options['windowsHide'],
        `git ${call.args.join(' ')} must pass windowsHide: true`,
      ).toBe(true);
    }
  });

  it('hides the console window of the linked-worktree probe on the contained-subdirectory poll path', async () => {
    const subdir = path.join(repo, 'packages', 'app');
    fs.mkdirSync(subdir, { recursive: true });
    const runtime = {
      workspaceId: 'primary',
      workspaceCwd: repo,
      sessionRuntimeBaseDir: runtimeBase,
      primary: true,
      trusted: true,
      env: { mode: 'parent-process', overlayKeys: [] },
    } as unknown as WorkspaceRuntime;

    // A plain contained subdirectory (inside the workspace, outside the
    // managed `.qwen/worktrees` root) resolves through
    // `isLinkedWorktreeOrUnknown`, whose combined probe is one of the four
    // windowsHide sites under test.
    const pollRequest = {
      query: { cwd: subdir },
    } as unknown as Request;
    expect(await resolveSessionManagedGitCwd(pollRequest, runtime)).toBe(
      fs.realpathSync(subdir),
    );

    const gitSpawns = recordedExecFileCalls.filter(
      (call) => call.file === 'git',
    );
    expect(gitSpawns.length).toBeGreaterThan(0);
    const argLists = gitSpawns.map((call) => call.args);
    expect(argLists).toContainEqual([
      'rev-parse',
      '--git-common-dir',
      '--absolute-git-dir',
    ]);

    for (const call of gitSpawns) {
      expect(
        call.options['windowsHide'],
        `git ${call.args.join(' ')} must pass windowsHide: true`,
      ).toBe(true);
    }
  });
});
