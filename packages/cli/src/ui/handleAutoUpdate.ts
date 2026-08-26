/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import semver from 'semver';
import type { UpdateObject } from './utils/updateCheck.js';
import type { LoadedSettings } from '../config/settings.js';
import {
  getHomebrewLatestVersion,
  getInstallationInfo,
  PackageManager,
  resolveUpdateCommand,
} from '../utils/installationInfo.js';
import { updateEventEmitter } from '../utils/updateEventEmitter.js';
import type { HistoryItemWithoutId } from './types.js';
import { MessageType } from './types.js';
import { spawnWrapper } from '../utils/spawnWrapper.js';
import { performStandaloneUpdate } from './standalone-update.js';
import { t } from '../i18n/index.js';
import type { spawn } from 'node:child_process';
import os from 'node:os';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('AUTO_UPDATE');

const UPDATE_SUCCESS_MESSAGE =
  'Update successful! The new version will be used on your next run.';
const UPDATE_FAILED_MESSAGE =
  'Automatic update failed. Please try updating manually.';

export async function handleAutoUpdate(
  info: UpdateObject | null,
  settings: LoadedSettings,
  projectRoot: string,
  spawnFn: typeof spawn = spawnWrapper,
): Promise<boolean | undefined> {
  if (!info) {
    return;
  }

  // enableAutoUpdate is checked in gemini.tsx before calling this function,
  // so if we get here, auto-update is enabled (or undefined, which defaults to enabled).
  const isAutoUpdateEnabled =
    settings.merged.general?.enableAutoUpdate !== false;

  const installationInfo = getInstallationInfo(
    projectRoot,
    isAutoUpdateEnabled,
  );

  if (installationInfo.packageManager === PackageManager.HOMEBREW) {
    const installedVersion = semver.coerce(info.update.current)?.version;
    const brewLatestVersion = semver.coerce(
      (await getHomebrewLatestVersion()) ?? undefined,
    )?.version;
    // The startup check resolves "latest" from the npm registry regardless of
    // installation type, but a Homebrew install can only be updated through
    // Homebrew. While the formula lags npm `latest`, `brew upgrade` is a
    // no-op and this notification would repeat on every startup with no way
    // to clear it (#9493) — notify only when local Homebrew metadata reports
    // something newer than the installed version. When the Homebrew version
    // cannot be determined, fall through and keep the previous behavior.
    if (
      installedVersion &&
      brewLatestVersion &&
      !semver.gt(brewLatestVersion, installedVersion)
    ) {
      return;
    }
  }

  let combinedMessage = info.message;
  if (installationInfo.updateMessage) {
    combinedMessage += `\n${t(installationInfo.updateMessage)}`;
  }

  updateEventEmitter.emit('update-received', {
    message: combinedMessage,
  });

  if (
    installationInfo.isStandalone &&
    installationInfo.standaloneDir &&
    isAutoUpdateEnabled
  ) {
    performStandaloneUpdate(installationInfo.standaloneDir, info.update.latest)
      .then((result) => {
        const message =
          result === 'deferred'
            ? t(
                'Update downloaded. It will be applied after you exit this session.',
              )
            : t(
                'Update successful! The new version will be used on your next run.',
              );
        updateEventEmitter.emit('update-success', { message });
      })
      .catch((err: Error) => {
        updateEventEmitter.emit('update-failed', {
          message: t(
            'Automatic update failed: {{error}}. Re-run the installer to update manually.',
            { error: err.message },
          ),
        });
      });
    return;
  }

  // Don't automatically run the update if auto-update is disabled or no update command
  if (!installationInfo.updateCommand || !isAutoUpdateEnabled) {
    return;
  }
  const updateCommand = resolveUpdateCommand(
    installationInfo.updateCommand,
    info.update.latest,
  );
  const platform = os.platform();
  const isWindows = platform === 'win32';
  const isManagedNpmUpdate =
    installationInfo.packageManager === PackageManager.NPM;
  const command = isManagedNpmUpdate
    ? process.execPath
    : isWindows
      ? 'cmd.exe'
      : 'bash';
  const commandArgs = isManagedNpmUpdate
    ? [process.argv[1]!]
    : isWindows
      ? ['/c', updateCommand]
      : ['-c', updateCommand];
  const updateProcess = spawnFn(command, commandArgs, {
    ...(isManagedNpmUpdate
      ? {
          detached: true,
          env: {
            ...process.env,
            QWEN_CODE_MANAGED_NPM_UPDATE_VERSION: info.update.latest,
          },
          stdio: ['ignore', 'ignore', 'pipe'] as const,
          windowsHide: true,
        }
      : { stdio: ['pipe', 'ignore', 'pipe'] as const }),
  });
  let errorOutput = '';
  updateProcess.stderr?.on('data', (data) => {
    errorOutput += data.toString();
  });

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      try {
        if (error) throw error;
        updateEventEmitter.emit('update-success', {
          message: t(UPDATE_SUCCESS_MESSAGE),
        });
        resolve(true);
      } catch (error) {
        debugLogger.warn('Automatic update failed:', error);
        updateEventEmitter.emit('update-failed', {
          message: t(UPDATE_FAILED_MESSAGE),
        });
        resolve(false);
      }
    };
    updateProcess.once('close', (code) => {
      finish(
        code === 0
          ? undefined
          : new Error(
              `Command failed: ${updateCommand}; stderr: ${errorOutput.trim()}`,
            ),
      );
    });
    updateProcess.once('error', (error) => {
      finish(error);
    });
  });
}

export function setUpdateHandler(
  addItem: (item: HistoryItemWithoutId, timestamp: number) => void,
  setUpdateInfo: (info: UpdateObject | null) => void,
  isIdleRef: { current: boolean } = { current: true },
) {
  let successfullyInstalled = false;
  const pendingNotifications: HistoryItemWithoutId[] = [];

  const addItemOrDefer = (item: HistoryItemWithoutId) => {
    if (isIdleRef.current) {
      addItem(item, Date.now());
    } else {
      pendingNotifications.push(item);
    }
  };

  const handleUpdateReceived = (info: UpdateObject) => {
    setUpdateInfo(info);
    const savedMessage = info.message;
    setTimeout(() => {
      if (!successfullyInstalled) {
        addItemOrDefer({
          type: MessageType.INFO,
          text: savedMessage,
        });
      }
      setUpdateInfo(null);
    }, 60000);
  };

  const handleUpdateFailed = (data?: {
    message?: string;
    severity?: 'error' | 'warning';
  }) => {
    setUpdateInfo(null);
    addItemOrDefer({
      // Background update-check failures are emitted with severity 'warning'
      // (#7049); actual update installation failures stay errors.
      type:
        data?.severity === 'warning' ? MessageType.WARNING : MessageType.ERROR,
      text: data?.message ?? t(UPDATE_FAILED_MESSAGE),
    });
  };

  const handleUpdateSuccess = (data?: { message?: string }) => {
    successfullyInstalled = true;
    setUpdateInfo(null);
    addItemOrDefer({
      type: MessageType.INFO,
      text: data?.message ?? t(UPDATE_SUCCESS_MESSAGE),
    });
  };

  const handleUpdateInfo = (data: { message: string }) => {
    addItemOrDefer({
      type: MessageType.INFO,
      text: data.message,
    });
  };

  updateEventEmitter.on('update-received', handleUpdateReceived);
  updateEventEmitter.on('update-failed', handleUpdateFailed);
  updateEventEmitter.on('update-success', handleUpdateSuccess);
  updateEventEmitter.on('update-info', handleUpdateInfo);

  const cleanup = () => {
    updateEventEmitter.off('update-received', handleUpdateReceived);
    updateEventEmitter.off('update-failed', handleUpdateFailed);
    updateEventEmitter.off('update-success', handleUpdateSuccess);
    updateEventEmitter.off('update-info', handleUpdateInfo);
    pendingNotifications.length = 0;
  };

  const flush = () => {
    while (pendingNotifications.length > 0) {
      const item = pendingNotifications.shift()!;
      addItem(item, Date.now());
    }
  };

  return { cleanup, flush };
}
