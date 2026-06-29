/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

const checkForUpdatesDetailed = vi.fn();
const handleAutoUpdate = vi.fn();
const performStandaloneUpdate = vi.fn();
const getInstallationInfo = vi.fn();
const resolveUpdateCommand = vi.fn(
  (updateCommand: string, latestVersion: string) =>
    updateCommand.replace('@latest', `@${latestVersion}`),
);
const formatUpdateInstructions = vi.fn(
  (
    installationInfo: {
      updateMessage?: string;
      updateCommand?: string;
      isStandalone?: boolean;
    },
    latestVersion: string,
  ) => {
    if (installationInfo.updateMessage && !installationInfo.updateCommand) {
      return [installationInfo.updateMessage];
    }
    if (installationInfo.updateCommand) {
      return [
        'Run the following to update:',
        `  ${resolveUpdateCommand(installationInfo.updateCommand, latestVersion)}`,
      ];
    }
    return ['Manual update required. Please reinstall Qwen Code.'];
  },
);
vi.mock('../utils/updateCheck.js', () => ({ checkForUpdatesDetailed }));
vi.mock('../../utils/handleAutoUpdate.js', () => ({ handleAutoUpdate }));
vi.mock('../../utils/standalone-update.js', () => ({
  performStandaloneUpdate,
}));
vi.mock('../../utils/installationInfo.js', () => ({
  formatUpdateInstructions,
  getInstallationInfo,
  resolveUpdateCommand,
}));
const { updateCommand } = await import('./update-command.js');

function context(
  executionMode: 'interactive' | 'non_interactive' | 'acp',
  enableAutoUpdate?: boolean,
) {
  return createMockCommandContext({
    executionMode,
    services: {
      settings: {
        merged: { general: { enableAutoUpdate } },
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
    checkForUpdatesDetailed.mockResolvedValue({
      status: 'update',
      info: {
        message: 'Update available: 1.2.3',
        update: { latest: '1.2.3' },
      },
    });
    getInstallationInfo.mockReturnValue({
      isStandalone: false,
      updateCommand: 'npm install -g @qwen-code/qwen-code@latest',
    });
  });

  it('delegates to handleAutoUpdate in interactive mode', async () => {
    const commandContext = context('interactive');
    handleAutoUpdate.mockImplementation((_info, settings) => {
      expect(settings.merged.general?.enableAutoUpdate).toBe(true);
    });

    const result = await updateCommand.action!(commandContext, '');

    expect(result).toBeUndefined();
    expect(handleAutoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Update available: 1.2.3' }),
      commandContext.services.settings,
      '/repo',
    );
    expect(
      commandContext.services.settings.merged.general?.enableAutoUpdate,
    ).toBeUndefined();
    expect(getInstallationInfo).not.toHaveBeenCalled();
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

  it('delegates to handleAutoUpdate in interactive mode when auto-update is disabled', async () => {
    const commandContext = context('interactive', false);
    handleAutoUpdate.mockImplementation((_info, settings) => {
      expect(settings.merged.general?.enableAutoUpdate).toBe(true);
    });

    const result = await updateCommand.action!(commandContext, '');

    expect(result).toBeUndefined();
    expect(handleAutoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Update available: 1.2.3' }),
      commandContext.services.settings,
      '/repo',
    );
    expect(
      commandContext.services.settings.merged.general?.enableAutoUpdate,
    ).toBe(false);
    expect(getInstallationInfo).not.toHaveBeenCalled();
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

  it('updates standalone installs in non-interactive mode', async () => {
    getInstallationInfo.mockReturnValue({
      isStandalone: true,
      standaloneDir: '/tmp/qwen-code',
    });
    performStandaloneUpdate.mockResolvedValue('done');

    const result = await updateCommand.action!(context('non_interactive'), '');

    expect(performStandaloneUpdate).toHaveBeenCalledWith(
      '/tmp/qwen-code',
      '1.2.3',
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Update available: 1.2.3\nUpdate successful! The new version will be used on your next run.',
    });
  });

  it('returns an error when standalone update fails in non-interactive mode', async () => {
    getInstallationInfo.mockReturnValue({
      isStandalone: true,
      standaloneDir: '/tmp/qwen-code',
    });
    performStandaloneUpdate.mockRejectedValue(new Error('boom'));

    const result = await updateCommand.action!(context('non_interactive'), '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Update failed: boom',
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
    checkForUpdatesDetailed.mockResolvedValue({
      status: 'up-to-date',
      currentVersion: '1.0.0',
    });

    const result = await updateCommand.action!(context('non_interactive'), '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Qwen Code 1.0.0 is up to date!',
    });
  });

  it('returns an error when the update check fails', async () => {
    checkForUpdatesDetailed.mockResolvedValue({
      status: 'error',
      error: new Error('registry unavailable'),
    });

    const result = await updateCommand.action!(context('non_interactive'), '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        'Failed to check for updates. Please check your network or registry configuration.',
    });
    expect(getInstallationInfo).not.toHaveBeenCalled();
  });
});
