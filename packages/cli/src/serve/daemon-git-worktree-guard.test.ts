/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ToolNames } from '@qwen-code/qwen-code-core';
import type { ExternalToolGuardPrepareRequest } from '@qwen-code/acp-bridge/bridgeOptions';
import { createDaemonToolGuard } from './daemon-git-worktree-guard.js';

const workspaceCwd = path.resolve('workspace', 'project');
const effectiveCwd = path.join(workspaceCwd, 'worktree');
const outsideRepo = path.join(path.parse(effectiveCwd).root, 'outside', 'repo');

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

  it('allows mutating Git commands inside the effective working directory', async () => {
    const guard = createDaemonToolGuard();

    await expect(guard(request('git -C nested reset --hard'))).resolves.toEqual(
      { allowed: true },
    );
  });

  it('resolves relative targets from the explicit shell directory', async () => {
    const guard = createDaemonToolGuard();
    const nested = path.join(effectiveCwd, 'nested');

    await expect(
      guard(request('git -C .. reset --hard', { directory: nested })),
    ).resolves.toEqual({ allowed: true });
    await expect(
      guard(
        request(`git -C ${path.relative(nested, outsideRepo)} reset --hard`, {
          directory: nested,
        }),
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

  it('does not treat a Git command passed as an argument as executable', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request(`echo git -C ${outsideRepo} reset --hard`)),
    ).resolves.toEqual({ allowed: true });
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
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), 'daemon-guard-'),
    );
    const localEffectiveCwd = path.join(temporaryRoot, 'worktree');
    const localOutsideRepo = path.join(temporaryRoot, 'outside');
    const linkedOutsideRepo = path.join(localEffectiveCwd, 'linked-outside');
    await Promise.all([
      mkdir(localEffectiveCwd, { recursive: true }),
      mkdir(localOutsideRepo, { recursive: true }),
    ]);
    await symlink(localOutsideRepo, linkedOutsideRepo);

    try {
      const guard = createDaemonToolGuard();
      await expect(
        guard({
          ...request('git -C linked-outside/missing reset --hard'),
          workspaceCwd: localEffectiveCwd,
          effectiveCwd: localEffectiveCwd,
        }),
      ).resolves.toMatchObject({ allowed: false });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
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

  it('preserves external-provider nested executor restrictions only when configured', async () => {
    const call = {
      ...request('pwd'),
      toolName: ToolNames.AGENT,
      arguments: {},
    };

    await expect(createDaemonToolGuard()(call)).resolves.toEqual({
      allowed: true,
    });
    await expect(
      createDaemonToolGuard(vi.fn().mockResolvedValue({ allowed: true }))(call),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('nested or delegated'),
    });
  });

  it('fails closed without trusted daemon workspace context', async () => {
    const guard = createDaemonToolGuard();
    const call = request('pwd') as unknown as Record<string, unknown>;
    delete call['effectiveCwd'];

    await expect(
      guard(call as unknown as ExternalToolGuardPrepareRequest),
    ).rejects.toThrow('trusted workspace context');
  });
});
