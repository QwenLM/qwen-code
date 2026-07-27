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
  refreshCache: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  getAutoSkillCuratorStatus: mocks.getStatus,
  runAutoSkillCurator: mocks.run,
  restoreArchivedAutoSkill: mocks.restore,
}));

import { curatorCommand } from './curator-command.js';

describe('curator command', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = {
      services: {
        config: {
          getProjectRoot: () => '/project',
          getSkillManager: () => ({ refreshCache: mocks.refreshCache }),
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
      markedStale: [],
      reactivated: [],
      archived: ['auto-skill-old'],
    });
    const runCommand = curatorCommand.subCommands!.find(
      (command) => command.name === 'run',
    )!;

    const result = await runCommand.action!(context, '--dry-run');

    expect(mocks.run).toHaveBeenCalledWith('/project', { dryRun: true });
    expect(mocks.refreshCache).not.toHaveBeenCalled();
    expect((result as { content: string }).content).toContain('auto-skill-old');
  });

  it('refreshes skill discovery after a live archive', async () => {
    mocks.run.mockResolvedValue({
      dryRun: false,
      checked: 1,
      markedStale: [],
      reactivated: [],
      archived: ['auto-skill-old'],
    });
    const runCommand = curatorCommand.subCommands!.find(
      (command) => command.name === 'run',
    )!;

    await runCommand.action!(context, '');

    expect(mocks.refreshCache).toHaveBeenCalledTimes(1);
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

  it('rejects unsupported run arguments', async () => {
    const runCommand = curatorCommand.subCommands!.find(
      (command) => command.name === 'run',
    )!;

    const result = await runCommand.action!(context, '--days 1');

    expect(mocks.run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
  });
});
