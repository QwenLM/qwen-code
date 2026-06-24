/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

const checkForUpdates = vi.fn();
const handleAutoUpdate = vi.fn();
const getInstallationInfo = vi.fn();
const resolveUpdateCommand = vi.fn(
  (updateCommand: string, latestVersion: string) =>
    updateCommand.replace('@latest', `@${latestVersion}`),
);
const getPackageJson = vi.fn();

vi.mock('../utils/updateCheck.js', () => ({ checkForUpdates }));
vi.mock('../../utils/handleAutoUpdate.js', () => ({ handleAutoUpdate }));
vi.mock('../../utils/installationInfo.js', () => ({
  getInstallationInfo,
  resolveUpdateCommand,
}));
vi.mock('../../utils/package.js', () => ({ getPackageJson }));

const { updateCommand } = await import('./update-command.js');

function context(executionMode: 'interactive' | 'non_interactive' | 'acp') {
  return createMockCommandContext({
    executionMode,
    services: {
      settings: {
        merged: { general: {} },
      },
      config: {
        getProjectRoot: () => '/repo',
      },
    },
  });
}

describe('updateCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkForUpdates.mockResolvedValue({
      message: 'Update available: 1.2.3',
      update: { latest: '1.2.3' },
    });
    getInstallationInfo.mockReturnValue({
      isStandalone: false,
      updateCommand: 'npm install -g @qwen-code/qwen-code@latest',
    });
  });

  it('delegates to handleAutoUpdate in interactive mode', async () => {
    const commandContext = context('interactive');

    const result = await updateCommand.action!(commandContext, '');

    expect(result).toBeUndefined();
    expect(handleAutoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Update available: 1.2.3' }),
      commandContext.services.settings,
      '/repo',
    );
  });

  it('returns the manual update command in non-interactive mode', async () => {
    const result = await updateCommand.action!(context('non_interactive'), '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Update available: 1.2.3\nRun the following to update:\n  npm install -g @qwen-code/qwen-code@1.2.3',
    });
    expect(handleAutoUpdate).not.toHaveBeenCalled();
  });

  it('returns the manual update command in ACP mode', async () => {
    const result = await updateCommand.action!(context('acp'), '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Update available: 1.2.3\nRun the following to update:\n  npm install -g @qwen-code/qwen-code@1.2.3',
    });
  });

  it('does not append generic fallback when installation info has updateMessage', async () => {
    getInstallationInfo.mockReturnValue({
      isStandalone: false,
      updateMessage: 'Running via npx, update not applicable.',
    });

    const result = await updateCommand.action!(context('non_interactive'), '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Update available: 1.2.3\nRunning via npx, update not applicable.',
    });
  });

  it('returns standalone reinstall guidance when no update command is available', async () => {
    getInstallationInfo.mockReturnValue({
      isStandalone: true,
    });

    const result = await updateCommand.action!(context('non_interactive'), '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Update available: 1.2.3\nUnable to auto-update this standalone installation. Please reinstall from:\n  https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/',
    });
  });

  it('returns manual reinstall guidance when no update command is available', async () => {
    getInstallationInfo.mockReturnValue({
      isStandalone: false,
    });

    const result = await updateCommand.action!(context('non_interactive'), '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Update available: 1.2.3\nManual update required. Please reinstall Qwen Code.',
    });
  });

  it('returns the current version when no update is available', async () => {
    checkForUpdates.mockResolvedValue(null);
    getPackageJson.mockResolvedValue({ version: '1.0.0' });

    const result = await updateCommand.action!(context('non_interactive'), '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Qwen Code 1.0.0 is up to date!',
    });
  });
});
