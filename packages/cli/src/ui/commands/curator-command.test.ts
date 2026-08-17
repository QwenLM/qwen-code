/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from './types.js';

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  run: vi.fn(),
  restore: vi.fn(),
  setPinned: vi.fn(),
  refreshCache: vi.fn(),
  isSafeMode: vi.fn(),
  isTrustedFolder: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  getAutoSkillCuratorStatus: mocks.getStatus,
  runAutoSkillCurator: mocks.run,
  restoreArchivedAutoSkill: mocks.restore,
  setAutoSkillPinned: mocks.setPinned,
}));

import { curatorCommand } from './curator-command.js';

describe('curator command', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.isSafeMode.mockReturnValue(false);
    mocks.isTrustedFolder.mockReturnValue(true);
    context = {
      services: {
        config: {
          getProjectRoot: () => '/project',
          getSkillManager: () => ({ refreshCache: mocks.refreshCache }),
          isSafeMode: mocks.isSafeMode,
          isTrustedFolder: mocks.isTrustedFolder,
        },
      },
    } as unknown as CommandContext;
    mocks.getStatus.mockResolvedValue({
      lastRunAt: undefined,
      active: [],
      stale: [
        {
          directoryName: 'auto-skill-old',
          skillName: 'old',
          state: 'stale',
          lastActivityAt: '2026-01-01T00:00:00.000Z',
          useCount: 0,
          pinned: false,
        },
      ],
      archived: [],
    });
  });

  it('shows status from the bare parent command', async () => {
    const result = await curatorCommand.action!(context, '');

    expect(mocks.getStatus).toHaveBeenCalledWith('/project');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
    });
    expect((result as { content: string }).content).toContain('auto-skill-old');
  });

  it('runs a non-mutating preview', async () => {
    mocks.run.mockResolvedValue({
      dryRun: true,
      checked: 1,
      seeded: [],
      markedStale: [],
      reactivated: [],
      archived: ['auto-skill-old'],
      skippedCollisions: ['auto-skill-collision'],
      skippedErrors: [],
    });
    const runCommand = curatorCommand.subCommands!.find(
      (command) => command.name === 'run',
    )!;

    const result = await runCommand.action!(context, '--dry-run');

    expect(mocks.run).toHaveBeenCalledWith('/project', { dryRun: true });
    expect(mocks.refreshCache).not.toHaveBeenCalled();
    expect((result as { content: string }).content).toContain(
      'Archive candidates:\n  auto-skill-old',
    );
    expect((result as { content: string }).content).toContain(
      'Skipped archive collisions:\n  auto-skill-collision',
    );
  });

  it('refreshes skill discovery after a live archive', async () => {
    mocks.run.mockResolvedValue({
      dryRun: false,
      checked: 1,
      seeded: [],
      markedStale: [],
      reactivated: [],
      archived: ['auto-skill-old'],
      skippedCollisions: [],
      skippedErrors: [],
    });
    const runCommand = curatorCommand.subCommands!.find(
      (command) => command.name === 'run',
    )!;

    await runCommand.action!(context, '');

    expect(mocks.refreshCache).toHaveBeenCalledTimes(1);
  });

  it('does not refresh skill discovery when a live run archives nothing', async () => {
    mocks.run.mockResolvedValue({
      dryRun: false,
      checked: 1,
      seeded: [],
      markedStale: [],
      reactivated: [],
      archived: [],
      skippedCollisions: [],
      skippedErrors: [],
    });
    const runCommand = curatorCommand.subCommands!.find(
      (command) => command.name === 'run',
    )!;

    const result = await runCommand.action!(context, '');

    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    expect(mocks.refreshCache).not.toHaveBeenCalled();
  });

  it('keeps a successful live run successful when cache refresh fails', async () => {
    mocks.run.mockResolvedValue({
      dryRun: false,
      checked: 1,
      seeded: [],
      markedStale: [],
      reactivated: [],
      archived: ['auto-skill-old'],
      skippedCollisions: [],
      skippedErrors: [],
    });
    mocks.refreshCache.mockRejectedValue(new Error('refresh exploded'));
    const runCommand = curatorCommand.subCommands!.find(
      (command) => command.name === 'run',
    )!;

    const result = await runCommand.action!(context, '');

    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    expect((result as { content: string }).content).toContain(
      'Archived skills:\n  auto-skill-old',
    );
  });

  it('restores an archived directory and refreshes skill discovery', async () => {
    const restoreCommand = curatorCommand.subCommands!.find(
      (command) => command.name === 'restore',
    )!;

    const result = await restoreCommand.action!(context, 'auto-skill-old');

    expect(mocks.restore).toHaveBeenCalledWith('/project', 'auto-skill-old');
    expect(mocks.refreshCache).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
  });

  it('keeps a successful restore successful when cache refresh fails', async () => {
    mocks.refreshCache.mockRejectedValue(new Error('refresh exploded'));
    const restoreCommand = curatorCommand.subCommands!.find(
      (command) => command.name === 'restore',
    )!;

    const result = await restoreCommand.action!(context, 'auto-skill-old');

    expect(mocks.restore).toHaveBeenCalledWith('/project', 'auto-skill-old');
    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    expect((result as { content: string }).content).toContain(
      'Restored auto-skill: auto-skill-old',
    );
  });

  it('pins and unpins a managed auto-skill', async () => {
    const pinCommand = curatorCommand.subCommands!.find(
      (command) => command.name === 'pin',
    )!;
    const unpinCommand = curatorCommand.subCommands!.find(
      (command) => command.name === 'unpin',
    )!;

    await pinCommand.action!(context, 'auto-skill-old');
    await unpinCommand.action!(context, 'auto-skill-old');

    expect(mocks.setPinned).toHaveBeenNthCalledWith(
      1,
      '/project',
      'auto-skill-old',
      true,
    );
    expect(mocks.setPinned).toHaveBeenNthCalledWith(
      2,
      '/project',
      'auto-skill-old',
      false,
    );
  });

  it('reports an error when reading status fails', async () => {
    mocks.getStatus.mockRejectedValue(new Error('state unreadable'));

    const result = await curatorCommand.action!(context, '');

    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect((result as { content: string }).content).toContain(
      'state unreadable',
    );
  });

  it('reports an error and skips refresh when a live run fails', async () => {
    mocks.run.mockRejectedValue(new Error('run exploded'));
    const runCommand = curatorCommand.subCommands!.find(
      (command) => command.name === 'run',
    )!;

    const result = await runCommand.action!(context, '');

    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect((result as { content: string }).content).toContain('run exploded');
    expect(mocks.refreshCache).not.toHaveBeenCalled();
  });

  it('reports an error and skips refresh when restore fails', async () => {
    mocks.restore.mockRejectedValue(new Error('restore exploded'));
    const restoreCommand = curatorCommand.subCommands!.find(
      (command) => command.name === 'restore',
    )!;

    const result = await restoreCommand.action!(context, 'auto-skill-old');

    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect((result as { content: string }).content).toContain(
      'restore exploded',
    );
    expect(mocks.refreshCache).not.toHaveBeenCalled();
  });

  it('reports an error when pinning fails', async () => {
    mocks.setPinned.mockRejectedValue(new Error('pin exploded'));
    const pinCommand = curatorCommand.subCommands!.find(
      (command) => command.name === 'pin',
    )!;

    const result = await pinCommand.action!(context, 'auto-skill-old');

    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect((result as { content: string }).content).toContain('pin exploded');
  });

  it('rejects unsupported run arguments', async () => {
    const runCommand = curatorCommand.subCommands!.find(
      (command) => command.name === 'run',
    )!;

    const result = await runCommand.action!(context, '--days 1');

    expect(mocks.run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
  });

  it.each([
    ['safe mode', true, true],
    ['an untrusted workspace', false, false],
  ])(
    'blocks mutations but preserves read-only commands in %s',
    async (_name, safeMode, trustedFolder) => {
      mocks.isSafeMode.mockReturnValue(safeMode);
      mocks.isTrustedFolder.mockReturnValue(trustedFolder);
      mocks.run.mockResolvedValue({
        dryRun: true,
        checked: 0,
        seeded: [],
        markedStale: [],
        reactivated: [],
        archived: [],
        skippedCollisions: [],
        skippedErrors: [],
      });
      const runCommand = curatorCommand.subCommands!.find(
        (command) => command.name === 'run',
      )!;
      const pinCommand = curatorCommand.subCommands!.find(
        (command) => command.name === 'pin',
      )!;
      const unpinCommand = curatorCommand.subCommands!.find(
        (command) => command.name === 'unpin',
      )!;
      const restoreCommand = curatorCommand.subCommands!.find(
        (command) => command.name === 'restore',
      )!;

      const statusResult = await curatorCommand.action!(context, '');
      const previewResult = await runCommand.action!(context, '--dry-run');
      const blockedResults = await Promise.all([
        runCommand.action!(context, ''),
        pinCommand.action!(context, 'auto-skill-old'),
        unpinCommand.action!(context, 'auto-skill-old'),
        restoreCommand.action!(context, 'auto-skill-old'),
      ]);

      expect(statusResult).toMatchObject({
        type: 'message',
        messageType: 'info',
      });
      expect(previewResult).toMatchObject({
        type: 'message',
        messageType: 'info',
      });
      expect(mocks.run).toHaveBeenCalledTimes(1);
      expect(mocks.run).toHaveBeenCalledWith('/project', { dryRun: true });
      expect(mocks.setPinned).not.toHaveBeenCalled();
      expect(mocks.restore).not.toHaveBeenCalled();
      expect(mocks.refreshCache).not.toHaveBeenCalled();
      for (const result of blockedResults) {
        expect(result).toMatchObject({
          type: 'message',
          messageType: 'error',
        });
      }
    },
  );
});
