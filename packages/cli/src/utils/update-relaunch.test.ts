/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedSettings } from '../config/settings.js';

const checkForUpdatesDetailed = vi.hoisted(() => vi.fn());
const handleAutoUpdate = vi.hoisted(() => vi.fn());
const getInstallationInfo = vi.hoisted(() => vi.fn());
const performStandaloneUpdate = vi.hoisted(() => vi.fn());
const writeStderrLine = vi.hoisted(() => vi.fn());

vi.mock('../ui/utils/updateCheck.js', () => ({ checkForUpdatesDetailed }));
vi.mock('./handleAutoUpdate.js', () => ({ handleAutoUpdate }));
vi.mock('./installationInfo.js', () => ({ getInstallationInfo }));
vi.mock('./standalone-update.js', () => ({ performStandaloneUpdate }));
vi.mock('./stdioHelpers.js', () => ({ writeStderrLine }));
vi.mock('../i18n/index.js', () => ({ t: (message: string) => message }));

const { updateBeforeRelaunch } = await import('./update-relaunch.js');

describe('updateBeforeRelaunch', () => {
  const settings = {
    merged: { general: { enableAutoUpdate: true } },
  } as LoadedSettings;

  beforeEach(() => {
    vi.clearAllMocks();
    checkForUpdatesDetailed.mockResolvedValue({
      status: 'update',
      info: {
        message: 'Update available',
        update: { latest: '2.0.0' },
      },
    });
    getInstallationInfo.mockReturnValue({
      updateCommand: 'npm install -g @qwen-code/qwen-code@latest',
    });
  });

  it('waits for the package-manager update before reporting success', async () => {
    let finishUpdate!: (success: boolean) => void;
    handleAutoUpdate.mockReturnValue(
      new Promise((resolve) => {
        finishUpdate = resolve;
      }),
    );

    const update = updateBeforeRelaunch(settings, '/repo', false);
    await vi.waitFor(() => expect(handleAutoUpdate).toHaveBeenCalledTimes(1));
    expect(writeStderrLine).toHaveBeenCalledWith('Update available');
    expect(writeStderrLine).not.toHaveBeenCalledWith(
      'Update successful! The new version will be used on your next run.',
    );

    finishUpdate(true);
    await expect(update).resolves.toBe(true);

    expect(writeStderrLine).toHaveBeenCalledWith(
      'Update successful! The new version will be used on your next run.',
    );
  });

  it.each([
    ['explicit update', true, true],
    ['background update-on-exit', false, false],
  ] as const)(
    'reports %s failure and returns %s',
    async (_source, relaunchOnFailure, expected) => {
      handleAutoUpdate.mockResolvedValue(false);

      const update = updateBeforeRelaunch(settings, '/repo', relaunchOnFailure);
      await expect(update).resolves.toBe(expected);

      expect(writeStderrLine).toHaveBeenCalledWith(
        'Automatic update failed. Please try updating manually.',
      );
    },
  );

  it('relaunches the old version when the update check fails', async () => {
    checkForUpdatesDetailed.mockResolvedValue({ status: 'error' });

    await expect(updateBeforeRelaunch(settings, '/repo', true)).resolves.toBe(
      true,
    );
    expect(writeStderrLine).toHaveBeenCalledWith(
      'Failed to check for updates. Please check your network or registry configuration.',
    );
  });

  it('waits for a standalone host update before relaunching', async () => {
    getInstallationInfo.mockReturnValue({
      isStandalone: true,
      standaloneDir: '/qwen',
    });
    let finishUpdate: (result: 'done') => void;
    performStandaloneUpdate.mockReturnValue(
      new Promise((resolve) => {
        finishUpdate = resolve;
      }),
    );

    const update = updateBeforeRelaunch(settings, '/repo', false);
    await vi.waitFor(() =>
      expect(performStandaloneUpdate).toHaveBeenCalledWith('/qwen', '2.0.0'),
    );
    expect(handleAutoUpdate).not.toHaveBeenCalled();

    finishUpdate!('done');
    await expect(update).resolves.toBe(true);
  });

  it('exits the supervisor for a deferred standalone update', async () => {
    getInstallationInfo.mockReturnValue({
      isStandalone: true,
      standaloneDir: '/qwen',
    });
    performStandaloneUpdate.mockResolvedValue('deferred');

    await expect(updateBeforeRelaunch(settings, '/repo', false)).resolves.toBe(
      false,
    );
    expect(writeStderrLine).toHaveBeenCalledWith(
      'Update downloaded. It will be applied after you exit this session.',
    );
  });
});
