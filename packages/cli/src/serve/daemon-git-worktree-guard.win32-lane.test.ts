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
// In-boundary directories the containment proofs resolve through: a plain
// child, plus children named like cmd relink programs (`copy`/`xcopy`), so
// a relink INTO such a name is a recorded destination, not skipped.
fs.mkdirSync(path.join(cmdWorktree, 'nested'), { recursive: true });
fs.mkdirSync(path.join(cmdWorktree, 'copy'), { recursive: true });
fs.mkdirSync(path.join(cmdWorktree, 'xcopy'), { recursive: true });

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

  it('fails closed after setx, which never touches this session', async () => {
    // setx writes the registry for FUTURE sessions; %GIT_WORK_TREE% in the
    // running cmd is untouched. Recording a relocation would fabricate state
    // the executed chain never sees, so only denial can follow it.
    await expect(
      guard(
        request(`setx GIT_WORK_TREE ${cmdOutsideRepo} && git reset --hard`),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('dynamic repository location'),
    });
    await expect(
      guard(request(`setx GIT_WORK_TREE ${cmdWorktree} && git reset --hard`)),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('dynamic repository location'),
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
    // The paired %...% dies at the cmd rewrite gate, before the set arm —
    // pin that reason so the assertion cannot pass at an earlier gate.
    await expect(
      guard(request(`set GIT_WORK_TREE=%DYN%&& git reset --hard`)),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('cmd.exe rewrite syntax'),
    });
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
    // Gate-clean operand: the earlier `;;` spelling died at the unmodelled-
    // syntax gate on `;` and never reached the `path` arm it is named for.
    // The unresolved state the arm records poisons the chained git run.
    await expect(
      guard(request(`path ${cmdOutsideRepo} && git reset --hard`)),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('dynamic repository location'),
    });
    // This run mentions git through the macro definition itself, so the
    // unresolved state the arm records denies it on the spot.
    await expect(
      guard(request(`doskey git=evil.exe $* && git reset --hard`)),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('unrecognized program'),
    });
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

// cmd.exe environment variable names are case-insensitive: `git_work_tree`
// and `GIT_WORK_TREE` are one variable, and git.exe reads the uppercase
// spelling. The recorded-assignment machinery must fold the key before
// matching, or a lowercase spelling slips past every set it is checked
// against while cmd hands git the relocated environment anyway.

describe('cmd.exe env assignments are case-insensitive', () => {
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

  it('denies lowercase and mixed-case GIT_WORK_TREE spellings', async () => {
    await expect(
      guard(request(`set git_work_tree=${cmdOutsideRepo}&& git reset --hard`)),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(cmdOutsideRepo),
    });
    await expect(
      guard(request(`set Git_Work_Tree=${cmdOutsideRepo}&& git reset --hard`)),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(cmdOutsideRepo),
    });
  });

  it('denies lowercase GIT_DIR and GIT_* spellings alike', async () => {
    // The `...\.git` value carries a git word, so the recorded relocation
    // denies the set run itself rather than the chained one.
    await expect(
      guard(request(`set git_dir=${cmdOutsideRepo}\\.git&& git reset --hard`)),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('unrecognized program'),
    });
    // Keys that mark the run unresolved are matched through the same sets.
    await expect(
      guard(request(`set git_exec_path=${cmdOutsideRepo}&& git reset --hard`)),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      guard(request(`set path=${cmdOutsideRepo}&& git reset --hard`)),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      guard(request(`set git_config_key_0=core.pager&& git reset --hard`)),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('keeps case-folding off shapes that stay in boundary', async () => {
    await expect(
      guard(request(`set git_work_tree=${cmdWorktree}&& git reset --hard`)),
    ).resolves.toEqual({ allowed: true });
  });
});

// cmd.exe's CD/CHDIR/PUSHD take their operand with no delimiter: `cd..`,
// `cd\dir`, `cd/d X`. The POSIX word split reads those as one foreign
// program word (`cd..`) or splits them on the backslash (`cd\dir` reports
// the program word `dir`), so the move cmd.exe really makes is never
// tracked and the following git is validated against the wrong directory.

describe('cmd.exe delimiter-less cd forms are tracked', () => {
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

  it('denies git after a delimiter-less climb out of the boundary', async () => {
    for (const climb of ['cd..', 'chdir..', 'pushd..']) {
      await expect(
        guard(request(`${climb}&& git reset --hard`)),
      ).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining(
          'outside the session working directory',
        ),
      });
    }
  });

  it('denies a relocation through the fused /D switch', async () => {
    await expect(
      guard(request(`cd/d ${cmdOutsideRepo}&& git reset --hard`)),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(cmdOutsideRepo),
    });
  });

  it('keeps an in-boundary delimiter-less cd harmless', async () => {
    await expect(
      guard(request(`cd nested && git reset --hard`)),
    ).resolves.toEqual({ allowed: true });
  });
});

// A relink DESTINATION may be named like a relink program (`mv <outside>
// copy`): skipping operands by program name hides exactly the target the
// later containment proof has to check. Only the program word itself is
// skipped; cmd `/FLAG` operands are switches, never paths, on the
// windows-native lanes.

describe('cmd.exe relink destinations stay tracked', () => {
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

  it('denies git through a destination named like a relink program', async () => {
    await expect(
      guard(request(`mv ${cmdOutsideRepo} copy && git -C copy reset --hard`)),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('dynamic repository location'),
    });
    await expect(
      guard(
        request(`cp -r ${cmdOutsideRepo} xcopy && git -C xcopy reset --hard`),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('dynamic repository location'),
    });
  });

  it('does not record cmd switches as relinked paths', async () => {
    // `/MIR` is a robocopy switch. Pre-fix it was resolved against the
    // tracked cwd and recorded as a relinked path, which turned the later
    // `git -C` into a dynamic-relocation denial instead of the ordinary
    // outside-boundary one its target earns on its own.
    await expect(
      guard(
        request(
          `robocopy ${cmdOutsideRepo} bait /MIR && git -C /MIR reset --hard`,
        ),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      // Pre-fix the `/MIR` switch was resolved and recorded as a relinked
      // path, so the later `-C /MIR` matched it and drew the dynamic-
      // relocation denial. With the switch unrecorded, `/MIR` is judged on
      // its own (unresolvable) merits and the reason names it, in the lane's
      // own path spelling (`/MIR` on POSIX, backslashed on win32).
      reason: expect.stringMatching(/[/\\]MIR/),
    });
  });
});
