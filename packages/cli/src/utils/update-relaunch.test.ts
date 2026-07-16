/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedSettings } from '../config/settings.js';
import { EventEmitter } from 'node:events';

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
    const updateProcess = new EventEmitter();
    handleAutoUpdate.mockReturnValue(updateProcess);

    const update = updateBeforeRelaunch(settings, '/repo');
    await vi.waitFor(() => expect(handleAutoUpdate).toHaveBeenCalledTimes(1));
    expect(writeStderrLine).toHaveBeenCalledWith('Update available');
    expect(writeStderrLine).not.toHaveBeenCalledWith(
      'Update successful! The new version will be used on your next run.',
    );

    updateProcess.emit('close', 0);
    await expect(update).resolves.toBe(true);

    expect(writeStderrLine).toHaveBeenCalledWith(
      'Update successful! The new version will be used on your next run.',
    );
  });

  it('reports update failure and returns so the old version can relaunch', async () => {
    const updateProcess = new EventEmitter();
    handleAutoUpdate.mockReturnValue(updateProcess);

    const update = updateBeforeRelaunch(settings, '/repo');
    await vi.waitFor(() => expect(handleAutoUpdate).toHaveBeenCalledTimes(1));
    updateProcess.emit('close', 1);
    await expect(update).resolves.toBe(false);

    expect(writeStderrLine).toHaveBeenCalledWith(
      'Automatic update failed. Please try updating manually.',
    );
  });

  it('does not relaunch when the update check fails', async () => {
    checkForUpdatesDetailed.mockResolvedValue({ status: 'error' });

    await expect(updateBeforeRelaunch(settings, '/repo')).resolves.toBe(false);
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

    const update = updateBeforeRelaunch(settings, '/repo');
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

    await expect(updateBeforeRelaunch(settings, '/repo')).resolves.toBe(false);
    expect(writeStderrLine).toHaveBeenCalledWith(
      'Update downloaded. It will be applied after you exit this session.',
    );
  });
});
