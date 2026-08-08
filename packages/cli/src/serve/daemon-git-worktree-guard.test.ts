/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ToolNames } from '@qwen-code/qwen-code-core';
import type { ExternalToolGuardPrepareRequest } from '@qwen-code/acp-bridge/bridgeOptions';
import { SHELL_EXECUTING_TOOL_NAMES } from '@qwen-code/acp-bridge/externalToolGuard';
import { createDaemonToolGuard } from './daemon-git-worktree-guard.js';

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'daemon-guard-'));
const effectiveCwd = path.join(temporaryRoot, 'workspace', 'worktree');
const insideNested = path.join(effectiveCwd, 'nested');
const outsideRepo = path.join(temporaryRoot, 'outside', 'repo');
mkdirSync(path.join(outsideRepo, '.git'), { recursive: true });
mkdirSync(insideNested, { recursive: true });

function request(
  command: string,
  extraArguments: Record<string, unknown> = {},
): ExternalToolGuardPrepareRequest {
  return {
    sessionId: 'session-1',
    promptId: 'prompt-1',
    toolCallId: 'call-1',
    toolName: 'run_shell_command',
    arguments: { command, ...extraArguments },
    effectiveCwd,
  } as ExternalToolGuardPrepareRequest;
}

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('createDaemonToolGuard', () => {
  it.each([
    () => `git -C ${outsideRepo} reset --hard`,
    () => `git -C${outsideRepo} checkout -- .`,
    () =>
      `git --work-tree=${outsideRepo} --git-dir=${path.join(outsideRepo, '.git')} clean -fd`,
    () => `git --git-dir ${path.join(outsideRepo, '.git')} commit -m x`,
    () => `git --namespace foo -C ${outsideRepo} reset --hard`,
    () => `git --super-prefix=foo --work-tree=${outsideRepo} clean -fd`,
    // `grep` runs the target repo's diff.<driver>.textconv programs and
    // `status` refreshes the target index + runs its core.fsmonitor.
    () => `git -C ${outsideRepo} grep --textconv pattern`,
    () => `git -C ${outsideRepo} status --porcelain`,
  ])('denies relocated mutating Git command %#', async (buildCommand) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(buildCommand()))).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(outsideRepo),
    });
  });

  it('allows relocated read-only Git commands', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request(`git -C ${outsideRepo} rev-parse HEAD`)),
    ).resolves.toEqual({ allowed: true });
  });

  it.each([
    `git -C ${outsideRepo} diff`,
    `git -C ${outsideRepo} log -p`,
    `git -C ${outsideRepo} show --output=${path.join(outsideRepo, 'out.txt')} HEAD`,
  ])(
    'denies relocated Git subcommands that can execute target-repo config or write files',
    async (command) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(command))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.each([
    `git -C ${outsideRepo} branch -D topic`,
    `git -C ${outsideRepo} remote add origin example.invalid/repo`,
  ])(
    'denies relocated Git subcommands that can mutate state',
    async (command) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(command))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it('denies dynamic repository relocation for mutating commands', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request('git -C "$OTHER_WORKTREE" reset --hard')),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('dynamic repository location'),
    });
  });

  it.each([
    'git -C `echo /outside/repo` reset --hard',
    'git -C ~/repos/other-checkout reset --hard',
    "git $'-C' /outside/repo reset --hard",
    "$'git' -C /outside/repo reset --hard",
    'git $(echo -C) /outside/repo reset --hard',
    'git -C /outside/repo* reset --hard',
  ])('denies shell-expansion relocation forms %#', async (command) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(command))).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('dynamic repository location'),
    });
  });

  it.each([
    // A trailing comment must not hide the relocation from the guard.
    () => `git -C ${outsideRepo} reset --hard # note`,
    // Git treats an empty `-C` as a no-op and applies the next relocation.
    () => `git -C "" -C ${outsideRepo} reset --hard`,
  ])('denies relocations masked by token edge cases %#', async (command) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(command()))).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(outsideRepo),
    });
  });

  it.each(['git -C', 'git --git-dir', 'git --work-tree='])(
    'fails closed on a dangling relocation option',
    async (command) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(command))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it('allows mutating Git commands inside the effective working directory', async () => {
    const guard = createDaemonToolGuard();

    await expect(guard(request('git -C nested reset --hard'))).resolves.toEqual(
      { allowed: true },
    );
  });

  it('resolves relative targets from the explicit shell directory', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request('git -C .. reset --hard', { directory: insideNested })),
    ).resolves.toEqual({ allowed: true });
    await expect(
      guard(
        request(
          `git -C ${path.relative(insideNested, outsideRepo)} reset --hard`,
          {
            directory: insideNested,
          },
        ),
      ),
    ).resolves.toMatchObject({ allowed: false });
  });

  it.each([
    `pwd && git -C ${outsideRepo} reset --hard; true`,
    `X=1 git -C ${outsideRepo} reset --hard`,
    `env X=1 git -C ${outsideRepo} reset --hard`,
    `command git -C ${outsideRepo} reset --hard`,
    `pwd\ngit -C ${outsideRepo} reset --hard`,
  ])(
    'denies a relocated mutation inside shell command forms',
    async (command) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(command))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.each([
    () => `sh -c 'git -C ${outsideRepo} reset --hard'`,
    () => `bash -c "git -C ${outsideRepo} reset --hard"`,
    () => `bash -lc 'git -C ${outsideRepo} reset --hard'`,
    () => `eval 'git -C ${outsideRepo} reset --hard'`,
    () => `sudo git -C ${outsideRepo} reset --hard`,
    () => `nohup git -C ${outsideRepo} reset --hard`,
    () => `timeout 5 git -C ${outsideRepo} reset --hard`,
    () => `exec git -C ${outsideRepo} reset --hard`,
    () => `/usr/bin/git -C ${outsideRepo} reset --hard`,
    () => `./bin/git -C ${outsideRepo} reset --hard`,
    () => `{ git -C ${outsideRepo} reset --hard; }`,
    () => `! git -C ${outsideRepo} reset --hard`,
    () => `env -S 'git -C ${outsideRepo} reset --hard'`,
  ])(
    'denies a relocated mutation through wrapper invocations %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.each([
    () => `cd ${outsideRepo} && git reset --hard`,
    () => `pushd ${outsideRepo} && git reset --hard`,
    () => `(cd ${outsideRepo} && git reset --hard)`,
    () => `eval 'cd ${outsideRepo}' && git reset --hard`,
    () => 'cd && git reset --hard',
    () => 'cd - && git reset --hard',
    () => 'popd && git reset --hard',
  ])(
    'denies mutations after a cwd-shifting builtin %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.each([
    () => `if true; then git -C ${outsideRepo} reset --hard; fi`,
    () => `if true; then cd ${outsideRepo} && git reset --hard; fi`,
    () => `for i in 1; do git -C ${outsideRepo} reset --hard; done`,
    () => `while true; do git -C ${outsideRepo} reset --hard; break; done`,
    () => `until false; do git -C ${outsideRepo} reset --hard; done`,
    () =>
      `if false; then pwd; elif true; then git -C ${outsideRepo} reset --hard; fi`,
    () => `time git -C ${outsideRepo} reset --hard`,
    () => `coproc git -C ${outsideRepo} reset --hard`,
  ])(
    'denies relocated mutations hidden behind shell keywords %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.each([() => 'bash -c "$CMD"', () => 'sh -c "$CMD" arg'])(
    'fails closed on undecidable shell payloads %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('could not be resolved'),
      });
    },
  );

  // A substitution body runs before the command it is embedded in, so it is
  // analysed on its own instead of being folded into an opaque token.
  it.each([
    () => `echo $(git -C ${outsideRepo} reset --hard)`,
    () => `echo "$(cd ${outsideRepo} && git reset --hard)"`,
    () => `FOO=$(cd ${outsideRepo} && git reset --hard)`,
    () => `echo \`cd ${outsideRepo} && git reset --hard\``,
    () => `echo \${x:-$(git -C ${outsideRepo} reset --hard)}`,
    () => `echo $(( $(git -C ${outsideRepo} reset --hard) + 1 ))`,
    () => `sh -c "$(echo git -C ${outsideRepo} reset --hard)"`,
    () => `eval "$(echo git -C ${outsideRepo} reset --hard)"`,
  ])(
    'denies a relocated mutation inside a command substitution %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it('allows command substitutions that stay inside the boundary', async () => {
    const guard = createDaemonToolGuard();

    await expect(guard(request('echo $(date)'))).resolves.toEqual({
      allowed: true,
    });
    await expect(guard(request('echo $(git rev-parse HEAD)'))).resolves.toEqual(
      { allowed: true },
    );
    await expect(
      guard(request('echo $(cd nested && git commit -m x)')),
    ).resolves.toEqual({ allowed: true });
  });

  it('fails closed on an unterminated command substitution', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request(`echo $(git -C ${outsideRepo} reset --hard`)),
    ).resolves.toMatchObject({ allowed: false });
  });

  it.each([
    () => `bash -c'git -C ${outsideRepo} reset --hard'`,
    () => `bash -lc'git -C ${outsideRepo} reset --hard'`,
  ])(
    'denies relocated mutations fused into the -c flag token %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.each([
    () => `cd ${outsideRepo} && sh -c 'git reset --hard'`,
    () => `cd ${outsideRepo} && bash -c 'git clean -fd'`,
    () => `cd ${outsideRepo} && eval 'git reset --hard'`,
    () => `cd ${outsideRepo}; sh -c 'git reset --hard'`,
    () => `cd ${outsideRepo} && sh -c 'cd nested && git reset --hard'`,
  ])(
    'keeps the entry cwd as the containment basis inside shell wrappers %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it('still allows wrapper payloads that stay inside the entry cwd', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request(`cd ${effectiveCwd} && sh -c 'git reset --hard'`)),
    ).resolves.toEqual({ allowed: true });
  });

  it.each([
    () => `git -c core.fsmonitor=/tmp/evil.sh -C ${outsideRepo} status`,
    () => `git -c alias.x='!evil' -C ${outsideRepo} status`,
  ])(
    'inspects command-executing -c config even for read-only subcommands %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('dynamic repository location'),
      });
    },
  );

  it.each([
    () => `git --exec-path -C ${outsideRepo} reset --hard`,
    () => `git --list-cmds -C ${outsideRepo} reset --hard`,
  ])(
    'does not let --exec-path/--list-cmds swallow the relocation token %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it('denies a model-supplied directory outside the effective working directory', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request('git reset --hard', { directory: outsideRepo })),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(outsideRepo),
    });
    await expect(
      guard(
        request('git reset --hard', {
          directory: path.relative(effectiveCwd, outsideRepo),
        }),
      ),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      guard(request('git reset --hard', { directory: insideNested })),
    ).resolves.toEqual({ allowed: true });
  });

  it('keeps subshell cwd shifts from leaking into later commands', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request(`sh -c 'cd ${outsideRepo}'; git reset --hard`)),
    ).resolves.toEqual({ allowed: true });
    await expect(
      guard(request(`cd ${effectiveCwd} && git reset --hard`)),
    ).resolves.toEqual({ allowed: true });
  });

  it.each([
    () => `git -C \\
${outsideRepo} reset --hard`,
    () => `g\\
it -C ${outsideRepo} reset --hard`,
  ])(
    'joins backslash continuations before parsing %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining(outsideRepo),
      });
    },
  );

  it.each([
    () => `GIT_DIR=${path.join(outsideRepo, '.git')} git reset --hard`,
    () => `GIT_WORK_TREE=${outsideRepo} git reset --hard`,
    () => `GIT_COMMON_DIR=${path.join(outsideRepo, '.git')} git reset --hard`,
    () => `env GIT_DIR=${path.join(outsideRepo, '.git')} git reset --hard`,
    () => `env -C ${outsideRepo} git reset --hard`,
    () => `env --chdir=${outsideRepo} git reset --hard`,
    () => `env -u GIT_DIR git -C ${outsideRepo} reset --hard`,
    () => `sudo -D ${outsideRepo} git reset --hard`,
  ])(
    'denies repository relocation through environment forms %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.each([
    `git --git-dir=../evil/.git -C .. branch X`,
    `git -C .. --git-dir=../evil/.git branch X`,
    `git --work-tree=../evil -C .. reset --hard`,
  ])(
    'resolves relative git-dir and work-tree against the final -C cwd',
    async (command) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(command))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.each([
    `git -c alias.pwn='!git -C ${outsideRepo} branch pwned' pwn`,
    'git -c core.editor=evil-command commit',
    'git --config-env core.pager=evil-command log --follow',
    'git -c filter.evil.clean=evil-command add file',
  ])(
    'denies mutating subcommands with command-valued -c config',
    async (command) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(command))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('dynamic repository location'),
      });
    },
  );

  it('allows harmless -c config on mutations inside the boundary', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request('git -c user.name=Qwen commit --allow-empty')),
    ).resolves.toEqual({ allowed: true });
  });

  it('fails closed on commands that cannot be parsed', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request('git -C ${UNBALANCED reset --hard')),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('could not be parsed'),
    });
  });

  it('follows chained -C targets using Git semantics', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request(`git -C nested -C ${outsideRepo} reset --hard`)),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      guard(
        request(
          `git -C ${outsideRepo} -C ${path.relative(outsideRepo, effectiveCwd)} reset --hard`,
        ),
      ),
    ).resolves.toEqual({ allowed: true });
  });

  it('checks work-tree and git-dir targets independently', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(
        request(
          `git --work-tree=${effectiveCwd} --git-dir=${path.join(outsideRepo, '.git')} reset --hard`,
        ),
      ),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('resolves a missing target through its nearest existing symlink ancestor', async () => {
    const localEffectiveCwd = path.join(temporaryRoot, 'sym-cwd');
    const localOutsideRepo = path.join(temporaryRoot, 'sym-outside');
    const linkedOutsideRepo = path.join(localEffectiveCwd, 'linked-outside');
    await Promise.all([
      mkdir(localEffectiveCwd, { recursive: true }),
      mkdir(localOutsideRepo, { recursive: true }),
    ]);
    await symlink(localOutsideRepo, linkedOutsideRepo);

    const guard = createDaemonToolGuard();
    await expect(
      guard({
        ...request('git -C linked-outside/missing reset --hard'),
        effectiveCwd: localEffectiveCwd,
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('denies relocated mutations whose target does not exist at decision time', async () => {
    const guard = createDaemonToolGuard();

    // The command itself can create an outward symlink before git runs, so
    // a target that is missing now cannot be proven safe.
    await expect(
      guard(request(`ln -s ${outsideRepo} link && git -C link reset --hard`)),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('unresolvable repository location'),
    });
  });

  it('follows gitfile redirects before the containment check', async () => {
    // Per-test fixture: the redirect file persists for the rest of the run
    // and would change how later tests resolve targets under a shared basis.
    const localEffectiveCwd = path.join(temporaryRoot, 'gitfile-cwd');
    const localNested = path.join(localEffectiveCwd, 'nested');
    await mkdir(localNested, { recursive: true });
    await writeFile(
      path.join(localNested, '.git'),
      `gitdir: ${path.join(outsideRepo, '.git')}\n`,
    );
    const localRequest = (
      command: string,
    ): ExternalToolGuardPrepareRequest => ({
      ...request(command),
      effectiveCwd: localEffectiveCwd,
    });

    const guard = createDaemonToolGuard();
    await expect(
      guard(localRequest('git --git-dir=nested/.git branch -D topic')),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(outsideRepo),
    });
    await expect(
      guard(localRequest(`GIT_DIR=nested/.git sh -c 'git reset --hard'`)),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(outsideRepo),
    });
  });

  it('canonicalizes a symlink named .git before stripping the basename', async () => {
    const localEffectiveCwd = path.join(temporaryRoot, 'symgit-cwd');
    const localNestedD = path.join(localEffectiveCwd, 'nested', 'd');
    await mkdir(localNestedD, { recursive: true });
    await symlink(
      path.join(outsideRepo, '.git'),
      path.join(localNestedD, '.git'),
    );
    const localRequest = (
      command: string,
    ): ExternalToolGuardPrepareRequest => ({
      ...request(command),
      effectiveCwd: localEffectiveCwd,
    });

    const guard = createDaemonToolGuard();
    await expect(
      guard(localRequest('git --git-dir=nested/d/.git branch -D topic')),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(outsideRepo),
    });
  });

  it('resolves per-worktree admin directories to the linked worktree', async () => {
    const adminDir = path.join(effectiveCwd, '.git', 'worktrees', 'wt1');
    const outsideCheckout = path.join(temporaryRoot, 'outside-checkout');
    await Promise.all([
      mkdir(adminDir, { recursive: true }),
      mkdir(outsideCheckout, { recursive: true }),
    ]);
    await writeFile(
      path.join(outsideCheckout, '.git'),
      `gitdir: ${adminDir}\n`,
    );
    await writeFile(
      path.join(adminDir, 'gitdir'),
      `${path.join(outsideCheckout, '.git')}\n`,
    );

    const guard = createDaemonToolGuard();
    await expect(
      guard(request('git --git-dir=.git/worktrees/wt1 reset --hard')),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(outsideCheckout),
    });
  });

  it('allows per-worktree admin directories whose checkout stays inside', async () => {
    const adminDir = path.join(effectiveCwd, '.git', 'worktrees', 'wt2');
    const insideCheckout = path.join(effectiveCwd, 'wt2-checkout');
    await Promise.all([
      mkdir(adminDir, { recursive: true }),
      mkdir(insideCheckout, { recursive: true }),
    ]);
    await writeFile(path.join(insideCheckout, '.git'), `gitdir: ${adminDir}\n`);
    await writeFile(
      path.join(adminDir, 'gitdir'),
      `${path.join(insideCheckout, '.git')}\n`,
    );

    const guard = createDaemonToolGuard();
    await expect(
      guard(request('git --git-dir=.git/worktrees/wt2 reset --hard')),
    ).resolves.toEqual({ allowed: true });
  });

  it('clamps long paths and strips control characters in denial reasons', async () => {
    const guard = createDaemonToolGuard();
    const longTarget = path.join(outsideRepo, 'x'.repeat(200), 'y'.repeat(200));

    const longDenial = await guard(
      request(`git -C ${longTarget} reset --hard`),
    );
    expect(longDenial).toMatchObject({ allowed: false });
    const longReason = (longDenial as { reason: string }).reason;
    expect(longReason.length).toBeLessThanOrEqual(500);
    expect(longReason).toContain('…');

    const tabTarget = path.join(temporaryRoot, 'tab\tdir');
    await mkdir(path.join(tabTarget, '.git'), { recursive: true });
    const controlDenial = await guard(
      request(`git -C '${tabTarget}' reset --hard`),
    );
    expect(controlDenial).toMatchObject({ allowed: false });
    const controlReason = (controlDenial as { reason: string }).reason;
    expect(controlReason.length).toBeLessThanOrEqual(500);
    // eslint-disable-next-line no-control-regex -- asserting control chars are stripped
    expect(controlReason).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('denies dynamic relocations even for read-only subcommands', async () => {
    const guard = createDaemonToolGuard();

    // `status` would run the target repository's core.fsmonitor, so the
    // unresolved/dangerous-config check precedes the read-only allowance.
    await expect(
      guard(request('git -C "$OTHER_WORKTREE" rev-parse')),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('dynamic repository location'),
    });
  });

  it.each([
    () => `echo git -C ${outsideRepo} reset --hard`,
    () => `nice git -C ${outsideRepo} reset --hard`,
    () => `nice -n 5 git -C ${outsideRepo} reset --hard`,
    () => `stdbuf -o0 git -C ${outsideRepo} reset --hard`,
    () => `setsid git -C ${outsideRepo} reset --hard`,
    () => `flock /tmp/daemon-guard-lock git -C ${outsideRepo} reset --hard`,
    () => `xargs -I{} git -C ${outsideRepo} reset --hard`,
    () => `su -c 'git -C ${outsideRepo} reset --hard'`,
    () => `find . -exec git -C ${outsideRepo} reset --hard ;`,
  ])(
    'fails closed when an unrecognized program may run a relocated Git command %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('unrecognized program'),
      });
    },
  );

  it('allows commands that mention Git without a relocation marker', async () => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(`echo 'git status'`))).resolves.toEqual({
      allowed: true,
    });
    await expect(guard(request(`grep -rn 'git reset' src`))).resolves.toEqual({
      allowed: true,
    });
  });

  // An unrecognized program word hides what runs, so a git mention only
  // survives while the shell is provably still inside the boundary.
  it.each([
    () => `cd ${outsideRepo} && nice git reset --hard`,
    () => `cd ${outsideRepo} && ionice -c3 git reset --hard`,
    () => `cd ${outsideRepo} && echo x | xargs -I{} git reset --hard`,
    () => `cd ${outsideRepo} && find . -maxdepth 0 -exec git reset --hard ;`,
    () => `cd ${outsideRepo} && stdbuf -o0 git reset --hard`,
    () => 'cd - && nice git reset --hard',
  ])(
    'denies an unrecognized program running Git after a cwd shift %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it('allows an unrecognized program running Git inside the boundary', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request('cd nested && nice git status')),
    ).resolves.toEqual({ allowed: true });
    await expect(guard(request('nice git status'))).resolves.toEqual({
      allowed: true,
    });
  });

  // `export`/`declare -x`/`set -a` put a GIT_* relocation in the environment
  // of every later command, so it outlives the run that declared it.
  it.each([
    () => `export GIT_WORK_TREE=${outsideRepo} && git reset --hard`,
    () => `export GIT_WORK_TREE=${outsideRepo} ; git reset --hard`,
    () => `export GIT_DIR=${path.join(outsideRepo, '.git')} && git commit -m x`,
    () => `declare -x GIT_WORK_TREE=${outsideRepo} && git reset --hard`,
    () => `typeset -x GIT_WORK_TREE=${outsideRepo} && git reset --hard`,
    () => `readonly GIT_WORK_TREE=${outsideRepo} && git reset --hard`,
    () => `set -a && GIT_WORK_TREE=${outsideRepo} && git reset --hard`,
    () => `set -o allexport; GIT_WORK_TREE=${outsideRepo}; git reset --hard`,
    () => `export GIT_WORK_TREE=${outsideRepo} && sh -c 'git reset --hard'`,
    () => `export GIT_WORK_TREE=$OTHER && git reset --hard`,
  ])(
    'denies a mutation after an exported Git relocation %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it('leaves unexported and unrelated assignments alone', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request('export FOO=bar && git commit -m x')),
    ).resolves.toEqual({ allowed: true });
    await expect(
      guard(request(`export GIT_WORK_TREE=${insideNested} && git commit -m x`)),
    ).resolves.toEqual({ allowed: true });
    // Without `export` (or `set -a`) the assignment stays shell-local and
    // never reaches the git process.
    await expect(
      guard(request(`GIT_WORK_TREE=${outsideRepo}; echo done`)),
    ).resolves.toEqual({ allowed: true });
  });

  it.each([
    () => `builtin cd ${outsideRepo} && git reset --hard`,
    () => `builtin cd -P ${outsideRepo} && git reset --hard`,
  ])('denies a mutation after `builtin cd` %#', async (buildCommand) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(buildCommand()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  // `cd -P <dir>` must not resolve containment against `<cwd>/-P`: that
  // basis is inside the boundary whenever such a directory exists.
  it.each([
    () => `cd -P ${outsideRepo} && git reset --hard`,
    () => `cd -L ${outsideRepo} && git reset --hard`,
    () => `cd -eP ${outsideRepo} && git reset --hard`,
    () => `cd -- ${outsideRepo} && git reset --hard`,
  ])(
    'denies a mutation after an option-carrying cd %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it('keeps an option-carrying cd inside the boundary allowed', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request('cd -P nested && git commit -m x')),
    ).resolves.toEqual({ allowed: true });
    await expect(
      guard(request('cd -- nested && git commit -m x')),
    ).resolves.toEqual({ allowed: true });
  });

  // The relocated read-only allowance covers subcommands that neither write
  // files nor run target-repository programs — flags can revoke both.
  it.each([
    () => `git -C ${outsideRepo} cat-file --textconv --path=f.txt HEAD:f.txt`,
    () => `git -C ${outsideRepo} cat-file --filters --path=f.txt HEAD:f.txt`,
    () => `git -C ${outsideRepo} rev-parse --output=${outsideRepo}/o.txt HEAD`,
    () => `git -C ${outsideRepo} ls-files --output ${outsideRepo}/o.txt`,
  ])(
    'denies a relocated read-only subcommand carrying a disqualifying flag %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining(outsideRepo),
      });
    },
  );

  it('still allows the plain relocated read-only subcommands', async () => {
    const guard = createDaemonToolGuard();

    for (const command of [
      `git -C ${outsideRepo} cat-file -p HEAD:f.txt`,
      `git -C ${outsideRepo} describe --tags`,
      `git -C ${outsideRepo} ls-files`,
      `git -C ${outsideRepo} rev-parse HEAD`,
    ]) {
      await expect(guard(request(command))).resolves.toEqual({ allowed: true });
    }
  });

  // `monitor` runs its `command` through the same shell as the shell tool.
  it('applies the built-in policy to the monitor tool', async () => {
    const guard = createDaemonToolGuard();
    const monitorCall = (command: string) =>
      ({
        ...request(command),
        toolName: ToolNames.MONITOR,
      }) as ExternalToolGuardPrepareRequest;

    await expect(
      guard(monitorCall(`git -C ${outsideRepo} reset --hard`)),
    ).resolves.toMatchObject({ allowed: false });
    await expect(guard(monitorCall('git status'))).resolves.toEqual({
      allowed: true,
    });
  });

  // A quoted payload can relocate through `cd` instead of a Git flag, and an
  // unrecognized program word hides which of them runs.
  it.each([
    () => `su -c 'cd ${outsideRepo} && git reset --hard'`,
    () => `xargs -I{} sh -c 'cd ${outsideRepo} && git reset --hard'`,
    // `executableBaseName` lowercases, so an uppercase program word resolves
    // to the same binary on a case-insensitive filesystem.
    () => `cd ${outsideRepo} && nice GIT reset --hard`,
  ])(
    'denies a relocated mutation concealed in an unrecognized program %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  // A program word the daemon cannot read is as opaque as an unrecognized one.
  it.each([
    () => `cd ${outsideRepo} && $CMD git reset --hard`,
    () => `cd ${outsideRepo} && command $CMD git reset --hard`,
  ])(
    'denies a dynamic program running Git after a cwd shift %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.each([
    // `export NAME` with no `=` exports an earlier shell-local assignment.
    () =>
      `GIT_WORK_TREE=${outsideRepo}; export GIT_WORK_TREE; git reset --hard`,
    () =>
      `GIT_DIR=${path.join(outsideRepo, '.git')}\nexport GIT_DIR\ngit commit -m x`,
    // `eval` runs in the current shell, so its exports outlive the payload.
    () => `eval 'export GIT_WORK_TREE=${outsideRepo}' && git reset --hard`,
    () => `eval 'set -a' && GIT_WORK_TREE=${outsideRepo} && git reset --hard`,
    // `set -o $OPT` can request allexport without naming it.
    () => `set -o $OPT && GIT_WORK_TREE=${outsideRepo} && git reset --hard`,
    // `+=` appends to an unknown previous value.
    () =>
      `GIT_WORK_TREE+=${outsideRepo} && export GIT_WORK_TREE && git reset --hard`,
  ])(
    'denies a mutation after a deferred or unresolvable export %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it('keeps shell-local assignments shell-local', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request(`GIT_WORK_TREE=${outsideRepo}; echo done`)),
    ).resolves.toEqual({ allowed: true });
    await expect(
      guard(request('FOO=bar; export FOO; git commit -m x')),
    ).resolves.toEqual({ allowed: true });
  });

  // Config keys are case-insensitive and several beyond the alias set run a
  // program of the target repository's choosing.
  it.each([
    () => `git -c core.sshCommand='touch /tmp/x' -C ${outsideRepo} rev-parse`,
    () => `git -c CORE.SSHCOMMAND='touch /tmp/x' -C ${outsideRepo} rev-parse`,
    () => `git -c diff.d.textconv='touch /tmp/x' -C ${outsideRepo} rev-parse`,
    () => `git -c merge.d.driver='touch /tmp/x' -C ${outsideRepo} rev-parse`,
    () => `git -c sequence.editor='touch /tmp/x' -C ${outsideRepo} rev-parse`,
  ])(
    'denies relocated commands carrying command-executing config %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  // An unmodelled value-taking global option makes its value look like the
  // subcommand, which ends option parsing and hides the relocation after it.
  it.each([
    () => `git --shallow-file /tmp/shallow -C ${outsideRepo} reset --hard`,
    () => `git --attr-source HEAD -C ${outsideRepo} reset --hard`,
  ])(
    'parses relocations after value-taking global options %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining(outsideRepo),
      });
    },
  );

  it.each([
    () => 'env -S "$CMD"',
    () => `env -S'git -C ${outsideRepo} reset --hard'`,
    () => `env -iS'git -C ${outsideRepo} reset --hard'`,
  ])('handles env -S payload forms %#', async (buildCommand) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(buildCommand()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  // The shell-executing set pins ToolNames literals in acp-bridge, which
  // cannot import core; a rename must fail here.
  it('matches the ToolNames constants for shell-executing tools', () => {
    expect(SHELL_EXECUTING_TOOL_NAMES).toEqual(
      new Set([ToolNames.SHELL, ToolNames.MONITOR]),
    );
  });

  it('short-circuits the external provider after a built-in denial', async () => {
    const externalGuard = vi.fn().mockResolvedValue({ allowed: true });
    const guard = createDaemonToolGuard(externalGuard);

    await expect(
      guard(request(`git -C ${outsideRepo} reset --hard`)),
    ).resolves.toMatchObject({ allowed: false });
    expect(externalGuard).not.toHaveBeenCalled();
  });

  it('forwards allowed calls to the external provider unchanged', async () => {
    const externalGuard = vi.fn().mockResolvedValue({ allowed: true });
    const guard = createDaemonToolGuard(externalGuard);
    const call = request('pwd');

    await expect(guard(call)).resolves.toEqual({ allowed: true });
    expect(externalGuard).toHaveBeenCalledWith(call);
  });

  it('returns an external provider denial for an otherwise allowed call', async () => {
    const providerDenial = {
      allowed: false,
      reason: 'Provider policy denied this invocation.',
    };
    const externalGuard = vi.fn().mockResolvedValue(providerDenial);
    const guard = createDaemonToolGuard(externalGuard);

    await expect(guard(request('pwd'))).resolves.toEqual(providerDenial);
    expect(externalGuard).toHaveBeenCalledOnce();
  });

  it.each([
    ToolNames.AGENT,
    ToolNames.WORKFLOW,
    ToolNames.CREATE_SUB_SESSION,
    ToolNames.SEND_MESSAGE,
  ])(
    'preserves external-provider nested executor restrictions only when configured (%s)',
    async (toolName) => {
      const call = {
        ...request('pwd'),
        toolName,
        arguments: {},
      };

      await expect(createDaemonToolGuard()(call)).resolves.toEqual({
        allowed: true,
      });
      await expect(
        createDaemonToolGuard(vi.fn().mockResolvedValue({ allowed: true }))(
          call,
        ),
      ).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('nested or delegated'),
      });
    },
  );

  // The unsupported-tool set intentionally pins ToolNames string literals so
  // this module keeps its import footprint; a rename must fail here.
  it('matches the ToolNames constants for nested executor tools', () => {
    const unsupported = new Set([
      'agent',
      'workflow',
      'create_sub_session',
      'send_message',
    ]);
    expect(unsupported).toEqual(
      new Set([
        ToolNames.AGENT,
        ToolNames.WORKFLOW,
        ToolNames.CREATE_SUB_SESSION,
        ToolNames.SEND_MESSAGE,
      ]),
    );
  });

  it('fails closed without the trusted effective working directory', async () => {
    const guard = createDaemonToolGuard();
    const call = request('pwd') as unknown as Record<string, unknown>;
    delete call['effectiveCwd'];

    await expect(
      guard(call as unknown as ExternalToolGuardPrepareRequest),
    ).rejects.toThrow('trusted workspace context');
  });

  it('applies the built-in policy to prompt-less shell checks', async () => {
    const guard = createDaemonToolGuard();

    const allowed = request('pwd') as unknown as Record<string, unknown>;
    delete allowed['promptId'];
    await expect(
      guard(allowed as unknown as ExternalToolGuardPrepareRequest),
    ).resolves.toEqual({ allowed: true });

    const denied = request(
      `git -C ${outsideRepo} reset --hard`,
    ) as unknown as Record<string, unknown>;
    delete denied['promptId'];
    await expect(
      guard(denied as unknown as ExternalToolGuardPrepareRequest),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('refuses to consult the external provider without a prompt binding', async () => {
    const externalGuard = vi.fn().mockResolvedValue({ allowed: true });
    const guard = createDaemonToolGuard(externalGuard);
    const call = request('pwd') as unknown as Record<string, unknown>;
    delete call['promptId'];

    await expect(
      guard(call as unknown as ExternalToolGuardPrepareRequest),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('without an active prompt binding'),
    });
    expect(externalGuard).not.toHaveBeenCalled();
  });
});
