/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Runs the committed guard suite the way the Windows merge lane executes it
// (win32 + cmd.exe, no Git-Bash markers), so a lane-red defect is caught on
// every platform instead of first going red inside the merge queue. The
// spoof must be in place BEFORE the suite module evaluates its runIf
// conditions, hence the dynamic import, and re-armed before every test
// because the suite's own afterEach restores all mocks.

import os from 'node:os';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const savedEnv: Record<string, string | undefined> = {};
for (const key of ['MSYSTEM', 'TERM', 'ComSpec'] as const) {
  savedEnv[key] = process.env[key];
}

process.env['QWEN_DAEMON_GUARD_LANE_SPOOF'] = 'win32-cmd';
vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
vi.spyOn(os, 'platform').mockReturnValue('win32');
for (const key of ['MSYSTEM', 'TERM', 'ComSpec'] as const) {
  delete process.env[key];
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.spyOn(os, 'platform').mockReturnValue('win32');
});

afterAll(() => {
  vi.restoreAllMocks();
  for (const key of ['MSYSTEM', 'TERM', 'ComSpec'] as const) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  delete process.env['QWEN_DAEMON_GUARD_LANE_SPOOF'];
});

await import('./daemon-git-worktree-guard.test.js');

it('harness premise: the lane resolves to win32/cmd', async () => {
  const { getShellConfiguration } = await import('@qwen-code/qwen-code-core');
  expect(process.platform).toBe('win32');
  expect(os.platform()).toBe('win32');
  expect(getShellConfiguration().shell).toBe('cmd');
});

// cmd.exe builtins persist state into every later `&&`-chained command:
// `set`/`setx` mutate the environment, `cd`/`chdir` the working directory,
// `path`/`doskey` change which executable a bare name resolves to, and
// `copy`/`mklink`/… relink paths. Each entrance must reach the analysis the
// same way its POSIX equivalent does — a relocation through any of them is
// a boundary escape, not a cwd-local command.

const fs = await import('node:fs');
const path = await import('node:path');
const { createDaemonToolGuard } = await import(
  './daemon-git-worktree-guard.js'
);

const cmdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-win32-cmd-'));
const cmdWorktree = path.join(cmdRoot, 'workspace', 'worktree');
const cmdOutsideRepo = path.join(cmdRoot, 'outside', 'repo');
fs.mkdirSync(path.join(cmdOutsideRepo, '.git'), { recursive: true });
fs.mkdirSync(cmdWorktree, { recursive: true });

afterAll(() => {
  fs.rmSync(cmdRoot, { recursive: true, force: true });
});

describe('cmd.exe state-persisting builtins fail closed', () => {
  const guard = createDaemonToolGuard();
  const request = (command: string) =>
    ({
      sessionId: 'session-1',
      promptId: 'prompt-1',
      toolCallId: 'call-1',
      toolName: 'run_shell_command',
      arguments: { command },
      effectiveCwd: cmdWorktree,
    }) as never;

  it('denies a relocation persisted through set', async () => {
    await expect(
      guard(request(`set GIT_WORK_TREE=${cmdOutsideRepo}&& git reset --hard`)),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(cmdOutsideRepo),
    });
    await expect(
      guard(request(`set GIT_DIR=${cmdOutsideRepo}\\.git&& git reset --hard`)),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('denies a relocation persisted through setx', async () => {
    await expect(
      guard(
        request(`setx GIT_WORK_TREE ${cmdOutsideRepo} && git reset --hard`),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(cmdOutsideRepo),
    });
  });

  it('keeps an in-boundary set harmless', async () => {
    await expect(
      guard(request(`set GIT_WORK_TREE=${cmdWorktree}&& git reset --hard`)),
    ).resolves.toEqual({ allowed: true });
    await expect(guard(request(`set FOO=1&& git status`))).resolves.toEqual({
      allowed: true,
    });
  });

  it('fails closed on set forms it cannot resolve', async () => {
    await expect(
      guard(request(`set /p X=&& git reset --hard`)),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      guard(request(`set GIT_WORK_TREE=%DYN%&& git reset --hard`)),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('denies a relocation through chdir, including /D', async () => {
    await expect(
      guard(request(`chdir ${cmdOutsideRepo} && git reset --hard`)),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(cmdOutsideRepo),
    });
    await expect(
      guard(request(`chdir /D ${cmdOutsideRepo} && git reset --hard`)),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(cmdOutsideRepo),
    });
  });

  it('denies git after path or doskey rewrote command resolution', async () => {
    await expect(
      guard(request(`path ${cmdOutsideRepo};; && git reset --hard`)),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      guard(request(`doskey git=evil.exe $* && git reset --hard`)),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('denies git after a cmd relink program', async () => {
    await expect(
      guard(
        request(`mklink bait ${cmdOutsideRepo} && git -C bait reset --hard`),
      ),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      guard(request(`copy ${cmdOutsideRepo} bait && git -C bait reset --hard`)),
    ).resolves.toMatchObject({ allowed: false });
  });
});
