/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

const checkForUpdatesDetailed = vi.fn();
const relaunchForUpdate = vi.fn();
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
vi.mock('../../utils/processUtils.js', () => ({
  CUSTOM_SANDBOX_IMAGE_ENV_VAR: 'QWEN_CODE_CUSTOM_SANDBOX_IMAGE',
  HOST_UPDATE_RELAUNCH_ENV_VAR: 'QWEN_CODE_HOST_UPDATE_RELAUNCH',
  relaunchForUpdate,
}));
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
    relaunchForUpdate.mockReset();
    delete process.env['QWEN_CODE_CUSTOM_SANDBOX_IMAGE'];
    delete process.env['QWEN_CODE_HOST_UPDATE_RELAUNCH'];
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

  it('hands an interactive update off to the parent process', async () => {
    const commandContext = context('interactive');

    const result = await updateCommand.action!(commandContext, '');

    expect(result).toBeUndefined();
    expect(relaunchForUpdate).toHaveBeenCalledTimes(1);
    expect(
      commandContext.services.settings.merged.general?.enableAutoUpdate,
    ).toBeUndefined();
    expect(getInstallationInfo).toHaveBeenCalledWith('/repo', true);
  });

  it('returns the manual update command in non-interactive mode', async () => {
    const result = await updateCommand.action!(context('non_interactive'), '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Update available: 1.2.3\nRun the following to update:\n  npm install -g @qwen-code/qwen-code@1.2.3',
    });
    expect(relaunchForUpdate).not.toHaveBeenCalled();
  });

  it('returns manual instructions in interactive mode when auto-update is disabled', async () => {
    const commandContext = context('interactive', false);

    const result = await updateCommand.action!(commandContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Update available: 1.2.3\nRun the following to update:\n  npm install -g @qwen-code/qwen-code@1.2.3',
    });
    expect(relaunchForUpdate).not.toHaveBeenCalled();
    expect(
      commandContext.services.settings.merged.general?.enableAutoUpdate,
    ).toBe(false);
  });

  it('does not update standalone installs in interactive mode when auto-update is disabled', async () => {
    getInstallationInfo.mockReturnValue({
      isStandalone: true,
      standaloneDir: '/tmp/qwen-code',
    });

    const result = await updateCommand.action!(
      context('interactive', false),
      '',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Update available: 1.2.3\nManual update required. Please reinstall Qwen Code.',
    });
    expect(relaunchForUpdate).not.toHaveBeenCalled();
    expect(performStandaloneUpdate).not.toHaveBeenCalled();
  });

  it('hands standalone updates off to the parent process', async () => {
    getInstallationInfo.mockReturnValue({
      isStandalone: true,
      standaloneDir: '/tmp/qwen-code',
    });
    const commandContext = context('interactive');

    const result = await updateCommand.action!(commandContext, '');

    expect(result).toBeUndefined();
    expect(relaunchForUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not mutate enableAutoUpdate when relaunching throws', async () => {
    const commandContext = context('interactive');
    relaunchForUpdate.mockImplementation(() => {
      throw new Error('spawn failed');
    });

    await expect(updateCommand.action!(commandContext, '')).rejects.toThrow(
      'spawn failed',
    );
    expect(
      commandContext.services.settings.merged.general?.enableAutoUpdate,
    ).toBeUndefined();
  });

  it('falls back to manual guidance in interactive mode when auto-update cannot act', async () => {
    getInstallationInfo.mockReturnValue({
      isStandalone: false,
    });

    const result = await updateCommand.action!(context('interactive'), '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Update available: 1.2.3\nManual update required. Please reinstall Qwen Code.',
    });
    expect(relaunchForUpdate).not.toHaveBeenCalled();
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

  it('keeps explicitly configured sandbox images user-managed', async () => {
    process.env['QWEN_CODE_CUSTOM_SANDBOX_IMAGE'] =
      'example.com/custom-qwen:1.0.0';

    try {
      const result = await updateCommand.action!(context('interactive'), '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content:
          'Update available: 1.2.3\nThis session uses the custom sandbox image example.com/custom-qwen:1.0.0. Update that image and restart Qwen Code.',
      });
      expect(relaunchForUpdate).not.toHaveBeenCalled();
    } finally {
      delete process.env['QWEN_CODE_CUSTOM_SANDBOX_IMAGE'];
    }
  });

  it('uses the host update capability inside a container', async () => {
    process.env['QWEN_CODE_HOST_UPDATE_RELAUNCH'] = 'true';

    const result = await updateCommand.action!(context('interactive'), '');

    expect(result).toBeUndefined();
    expect(relaunchForUpdate).toHaveBeenCalledTimes(1);
  });

  it('respects disabled auto-update for a supported host installation', async () => {
    process.env['QWEN_CODE_HOST_UPDATE_RELAUNCH'] = 'true';

    const result = await updateCommand.action!(
      context('interactive', false),
      '',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Update available: 1.2.3\nUpdate Qwen Code on the host, then restart the sandbox.',
    });
    expect(relaunchForUpdate).not.toHaveBeenCalled();
  });

  it('shows manual guidance for an unsupported host installation', async () => {
    process.env['QWEN_CODE_HOST_UPDATE_RELAUNCH'] = 'false';

    const result = await updateCommand.action!(context('interactive'), '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Update available: 1.2.3\nUpdate Qwen Code on the host, then restart the sandbox.',
    });
    expect(relaunchForUpdate).not.toHaveBeenCalled();
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
        'Update available: 1.2.3\nDownloading update...\nUpdate successful! The new version will be used on your next run.',
    });
  });

  it('returns deferred message when standalone update is not yet active', async () => {
    getInstallationInfo.mockReturnValue({
      isStandalone: true,
      standaloneDir: '/tmp/qwen-code',
    });
    performStandaloneUpdate.mockResolvedValue('deferred');

    const result = await updateCommand.action!(context('non_interactive'), '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Update available: 1.2.3\nDownloading update...\nUpdate downloaded. It will be applied after you exit this session.',
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
      content: 'Update available: 1.2.3\nUpdate failed: boom',
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

  it('returns an error when the update check is skipped', async () => {
    checkForUpdatesDetailed.mockResolvedValue({
      status: 'skipped',
      reason: 'development mode',
    });

    const result = await updateCommand.action!(context('non_interactive'), '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Unable to check for updates: development mode',
    });
    expect(getInstallationInfo).not.toHaveBeenCalled();
  });
});
