/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UpdateObject } from '../ui/utils/updateCheck.js';
import type { LoadedSettings } from '../config/settings.js';
import {
  getNpmCliPath,
  getInstallationInfo,
  PackageManager,
  resolveUpdateCommand,
} from './installationInfo.js';
import { updateEventEmitter } from './updateEventEmitter.js';
import type { HistoryItemWithoutId } from '../ui/types.js';
import { MessageType } from '../ui/types.js';
import { spawnWrapper } from './spawnWrapper.js';
import { performStandaloneUpdate } from './standalone-update.js';
import { t } from '../i18n/index.js';
import type { spawn } from 'node:child_process';
import os from 'node:os';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('AUTO_UPDATE');

const UPDATE_SUCCESS_MESSAGE =
  'Update successful! Please restart Qwen Code to use the new version. ' +
  'Switching model providers before restarting may not work correctly.';
const UPDATE_FAILED_MESSAGE =
  'Automatic update failed. Please try updating manually.';

export function handleAutoUpdate(
  info: UpdateObject | null,
  settings: LoadedSettings,
  projectRoot: string,
  spawnFn: typeof spawn = spawnWrapper,
) {
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

  let combinedMessage = info.message;
  if (installationInfo.updateMessage) {
    combinedMessage += `\n${installationInfo.updateMessage}`;
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
  const command =
    installationInfo.packageManager === PackageManager.NPM
      ? process.execPath
      : isWindows
        ? 'cmd.exe'
        : 'bash';
  const commandArgs =
    installationInfo.packageManager === PackageManager.NPM
      ? [
          getNpmCliPath(process.execPath, platform),
          ...updateCommand.split(' ').slice(1),
        ]
      : isWindows
        ? ['/c', updateCommand]
        : ['-c', updateCommand];
  const updateProcess = spawnFn(command, commandArgs, {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let errorOutput = '';
  updateProcess.stderr.on('data', (data) => {
    errorOutput += data.toString();
  });

  updateProcess.on('close', (code) => {
    if (code === 0) {
      updateEventEmitter.emit('update-success', {
        message: t(UPDATE_SUCCESS_MESSAGE),
      });
    } else {
      debugLogger.warn(
        `Automatic update command failed: ${updateCommand}; stderr: ${errorOutput.trim()}`,
      );
      updateEventEmitter.emit('update-failed', {
        message: t(UPDATE_FAILED_MESSAGE),
      });
    }
  });

  updateProcess.on('error', (err) => {
    debugLogger.warn('Automatic update command failed to start:', err);
    updateEventEmitter.emit('update-failed', {
      message: t(UPDATE_FAILED_MESSAGE),
    });
  });
  return updateProcess;
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

  const handleUpdateFailed = (data?: { message?: string }) => {
    setUpdateInfo(null);
    addItemOrDefer({
      type: MessageType.ERROR,
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
