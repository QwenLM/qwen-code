/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArgumentsCamelCase } from 'yargs';

const loadSettings = vi.fn();
const checkForUpdates = vi.fn();
const getInstallationInfo = vi.fn();
const resolveUpdateCommand = vi.fn(
  (updateCommand: string, latestVersion: string) =>
    updateCommand.replace('@latest', `@${latestVersion}`),
);
const performStandaloneUpdate = vi.fn();
const getPackageJson = vi.fn();
const writeStdoutLine = vi.fn();
const writeStderrLine = vi.fn();

vi.mock('../config/settings.js', () => ({ loadSettings }));
vi.mock('../ui/utils/updateCheck.js', () => ({ checkForUpdates }));
vi.mock('../utils/installationInfo.js', () => ({
  getInstallationInfo,
  resolveUpdateCommand,
}));
vi.mock('../utils/standalone-update.js', () => ({ performStandaloneUpdate }));
vi.mock('../utils/package.js', () => ({ getPackageJson }));
vi.mock('../utils/stdioHelpers.js', () => ({
  writeStdoutLine,
  writeStderrLine,
}));

const { updateCommand } = await import('./update.js');

const updateArgs: ArgumentsCamelCase<object> = {
  _: [],
  $0: 'qwen',
};

function settings(enableAutoUpdate?: boolean) {
  return {
    merged: {
      general: { enableAutoUpdate },
    },
  };
}

describe('update command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    loadSettings.mockReturnValue(settings(undefined));
    checkForUpdates.mockResolvedValue({
      message: 'Update available: 1.2.3',
      update: { latest: '1.2.3' },
    });
    getInstallationInfo.mockReturnValue({
      isStandalone: false,
      updateCommand: 'npm install -g @qwen-code/qwen-code@latest',
    });
  });

  it('prints the package-manager update command even when auto-update is disabled', async () => {
    loadSettings.mockReturnValue(settings(false));

    await updateCommand.handler(updateArgs);

    expect(getInstallationInfo).toHaveBeenCalledWith(expect.any(String), false);
    expect(writeStdoutLine).toHaveBeenCalledWith('Update available: 1.2.3');
    expect(writeStdoutLine).toHaveBeenCalledWith(
      'Run the following to update:',
    );
    expect(writeStdoutLine).toHaveBeenCalledWith(
      '  npm install -g @qwen-code/qwen-code@1.2.3',
    );
  });

  it('sets a non-zero exit code when a standalone update fails', async () => {
    getInstallationInfo.mockReturnValue({
      isStandalone: true,
      standaloneDir: '/tmp/qwen-code',
    });
    performStandaloneUpdate.mockRejectedValue(new Error('boom'));

    await updateCommand.handler(updateArgs);

    expect(performStandaloneUpdate).toHaveBeenCalledWith(
      '/tmp/qwen-code',
      '1.2.3',
    );
    expect(writeStderrLine).toHaveBeenCalledWith('Update failed: boom');
    expect(process.exitCode).toBe(1);
  });

  it('does not print generic fallback when installation info has updateMessage', async () => {
    getInstallationInfo.mockReturnValue({
      isStandalone: false,
      updateMessage: 'Running via npx, update not applicable.',
    });

    await updateCommand.handler(updateArgs);

    expect(writeStdoutLine).toHaveBeenCalledWith(
      'Running via npx, update not applicable.',
    );
    expect(writeStdoutLine).not.toHaveBeenCalledWith(
      'Manual update required. Please reinstall Qwen Code.',
    );
  });

  it('prints success message on standalone update', async () => {
    getInstallationInfo.mockReturnValue({
      isStandalone: true,
      standaloneDir: '/tmp/qwen-code',
    });
    performStandaloneUpdate.mockResolvedValue('done');

    await updateCommand.handler(updateArgs);

    expect(writeStdoutLine).toHaveBeenCalledWith(
      'Update successful! The new version will be used on your next run.',
    );
  });

  it('prints deferred message on standalone update', async () => {
    getInstallationInfo.mockReturnValue({
      isStandalone: true,
      standaloneDir: '/tmp/qwen-code',
    });
    performStandaloneUpdate.mockResolvedValue('deferred');

    await updateCommand.handler(updateArgs);

    expect(writeStdoutLine).toHaveBeenCalledWith(
      'Update downloaded. It will be applied after you exit this session.',
    );
  });

  it('prints the current version when no update is available', async () => {
    checkForUpdates.mockResolvedValue(null);
    getPackageJson.mockResolvedValue({ version: '1.0.0' });

    await updateCommand.handler(updateArgs);

    expect(writeStdoutLine).toHaveBeenCalledWith(
      'Qwen Code 1.0.0 is up to date!',
    );
    expect(getInstallationInfo).not.toHaveBeenCalled();
  });
});
