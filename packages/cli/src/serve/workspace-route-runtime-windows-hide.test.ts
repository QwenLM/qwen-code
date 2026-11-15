/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRuntime } from './workspace-registry.js';
import { resolveSessionManagedGitCwd } from './workspace-route-runtime.js';
import { createWorkspaceRuntimeSessionService } from './workspace-runtime-storage.js';

// The worktree-session poll shape the Web Shell actually sends
// (`GET /workspaces/:workspace/git?cwd=<worktree path>&sessionId=<id>`)
// resolves the requested cwd through the direct `execFileAsync('git', …)`
// call sites in `workspace-route-runtime.ts` (`resolveSessionManagedGitCwd`,
// `resolveGitCommonDir`, `resolveAbsoluteGitDir`); the plain contained-
// subdirectory shape additionally reaches `isLinkedWorktreeOrUnknown` and
// its combined `--git-common-dir --absolute-git-dir` probe. Each of the four
// sites must pass `windowsHide: true`: a detached daemon on Windows
// raises a visible console window per console-subsystem child otherwise
// (#17266). The wrapper records the options of each `execFile` call and
// delegates to the real implementation, so the real-git fixtures in this
// file keep running unchanged (`execFileSync` stays the real one via the
// `...actual` spread).
const { recordedExecFileCalls } = vi.hoisted(() => {
  const recordedExecFileCalls: Array<{
    file: string;
    args: readonly string[];
    options: Record<string, unknown>;
  }> = [];
  return { recordedExecFileCalls };
});
vi.mock('node:child_process', async () => {
  const actual =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
  const { promisify: promisifyActual } =
    await vi.importActual<typeof import('node:util')>('node:util');
  const wrappedExecFile = ((
    file: string,
    args: readonly string[],
    options: unknown,
    callback: unknown,
  ) => {
    const hasOptions = typeof options === 'object' && options !== null;
    const callOptions = (hasOptions ? options : {}) as Record<string, unknown>;
    const callCallback = (hasOptions ? callback : options) as (
      ...callArgs: never[]
    ) => void;
    recordedExecFileCalls.push({ file, args, options: callOptions });
    return hasOptions
      ? actual.execFile(
          file,
          args,
          callOptions as Parameters<typeof actual.execFile>[2],
          callCallback as never,
        )
      : actual.execFile(file, args, callCallback as never);
  }) as unknown as typeof actual.execFile;
  // The module under test consumes `promisify(execFile)`. Node's real
  // `execFile` carries a `util.promisify.custom` implementation (rejecting
  // with the error, resolving `{stdout, stderr}`); a plain wrapper loses it
  // and generic promisification changes the resolution shape. Keep the real
  // semantics by delegating the custom path to `promisify(actual.execFile)`
  // while recording the options of every promisified call too.
  Object.defineProperty(wrappedExecFile, promisifyActual.custom, {
    value: (
      file: string,
      args: readonly string[],
      options: Record<string, unknown>,
    ) => {
      recordedExecFileCalls.push({
        file,
        args,
        options: options ?? {},
      });
      return promisifyActual(actual.execFile)(file, args, options);
    },
  });
  return {
    ...actual,
    default: { ...actual, execFile: wrappedExecFile },
    execFile: wrappedExecFile,
  };
});

describe('resolveSessionManagedGitCwd spawn options (worktree poll shape)', () => {
  let repo: string;
  let runtimeBase: string;
  const sessionId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    recordedExecFileCalls.length = 0;
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-git-cwd-hide-'));
    runtimeBase = fs.mkdtempSync(
      path.join(os.tmpdir(), 'managed-git-runtime-hide-'),
    );
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repo,
    });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
    execFileSync(
      'git',
      ['config', 'core.hooksPath', path.join(runtimeBase, 'empty-hooks')],
      { cwd: repo },
    );
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(runtimeBase, { recursive: true, force: true });
  });

  it('hides the console window of every git spawn on the worktree-session poll path', async () => {
    const worktree = path.join(repo, '.qwen', 'worktrees', 'branch-a');
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    execFileSync(
      'git',
      ['worktree', 'add', '-q', '-b', 'worktree-branch-a', worktree, 'HEAD'],
      { cwd: repo },
    );
    fs.writeFileSync(path.join(worktree, '.qwen-session'), sessionId);
    const runtime = {
      workspaceId: 'primary',
      workspaceCwd: repo,
      sessionRuntimeBaseDir: runtimeBase,
      primary: true,
      trusted: true,
      env: { mode: 'parent-process', overlayKeys: [] },
      bridge: {
        getSessionExecutionSnapshot: () => ({
          workspaceCwd: repo,
          effectiveCwd: worktree,
          worktree: {
            slug: 'branch-a',
            path: worktree,
            branch: 'worktree-branch-a',
          },
        }),
      },
    } as unknown as WorkspaceRuntime;
    const sidecarPath =
      createWorkspaceRuntimeSessionService(runtime).getWorktreeSessionPath(
        sessionId,
      );
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    fs.writeFileSync(
      sidecarPath,
      JSON.stringify({
        slug: 'branch-a',
        worktreePath: worktree,
        worktreeBranch: 'worktree-branch-a',
        originalCwd: repo,
        originalBranch: 'main',
        originalHeadCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repo,
          encoding: 'utf8',
        }).trim(),
      }),
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
