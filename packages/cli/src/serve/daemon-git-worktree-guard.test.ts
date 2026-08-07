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
import { createDaemonToolGuard } from './daemon-git-worktree-guard.js';

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'daemon-guard-'));
const workspaceCwd = path.join(temporaryRoot, 'workspace');
const effectiveCwd = path.join(workspaceCwd, 'worktree');
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
    workspaceCwd,
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
      guard(request(`git -C ${outsideRepo} status --short`)),
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
        workspaceCwd: localEffectiveCwd,
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
    const gitfilePath = path.join(insideNested, '.git');
    await writeFile(gitfilePath, `gitdir: ${path.join(outsideRepo, '.git')}\n`);

    const guard = createDaemonToolGuard();
    await expect(
      guard(request('git --git-dir=nested/.git branch -D topic')),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(outsideRepo),
    });
    await expect(
      guard(request(`GIT_DIR=nested/.git sh -c 'git reset --hard'`)),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(outsideRepo),
    });
  });

  it('canonicalizes a symlink named .git before stripping the basename', async () => {
    const linkDir = path.join(insideNested, 'd');
    await mkdir(linkDir, { recursive: true });
    await symlink(path.join(outsideRepo, '.git'), path.join(linkDir, '.git'));

    const guard = createDaemonToolGuard();
    await expect(
      guard(request('git --git-dir=nested/d/.git branch -D topic')),
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

  it('allows dynamic relocations for read-only subcommands', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request('git -C "$OTHER_WORKTREE" status')),
    ).resolves.toEqual({ allowed: true });
  });

  it('does not treat a Git command passed as an argument as executable', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request(`echo git -C ${outsideRepo} reset --hard`)),
    ).resolves.toEqual({ allowed: true });
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

  it.each(['workspaceCwd', 'effectiveCwd'])(
    'fails closed without trusted daemon workspace context (%s)',
    async (field) => {
      const guard = createDaemonToolGuard();
      const call = request('pwd') as unknown as Record<string, unknown>;
      delete call[field];

      await expect(
        guard(call as unknown as ExternalToolGuardPrepareRequest),
      ).rejects.toThrow('trusted workspace context');
    },
  );
});
