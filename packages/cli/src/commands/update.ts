/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { t } from '../i18n/index.js';

export const updateCommand: CommandModule = {
  command: 'update',
  describe: t('Check for Qwen Code updates and install if available'),
  handler: async () => {
    const [
      { loadSettings },
      { checkForUpdatesDetailed },
      installationInfoModule,
      standaloneUpdate,
      stdioHelpers,
    ] = await Promise.all([
      import('../config/settings.js'),
      import('../ui/utils/updateCheck.js'),
      import('../utils/installationInfo.js'),
      import('../utils/standalone-update.js'),
      import('../utils/stdioHelpers.js'),
    ]);

    const { formatUpdateInstructions, getInstallationInfo } =
      installationInfoModule;
    const { performStandaloneUpdate } = standaloneUpdate;
    const { writeStdoutLine, writeStderrLine } = stdioHelpers;

    const cwd = process.cwd();
    const settings = loadSettings(cwd, false);

    const updateCheck = await checkForUpdatesDetailed();

    if (updateCheck.status === 'up-to-date') {
      writeStdoutLine(
        t('Qwen Code {{version}} is up to date!', {
          version: updateCheck.currentVersion,
        }),
      );
      return;
    }

    if (updateCheck.status === 'error') {
      writeStderrLine(
        t('Failed to check for updates: {{error}}', {
          error: updateCheck.error.message,
        }),
      );
      process.exitCode = 1;
      return;
    }

    if (updateCheck.status === 'skipped') {
      writeStderrLine(
        t('Unable to check for updates: {{reason}}', {
          reason: updateCheck.reason,
        }),
      );
      process.exitCode = 1;
      return;
    }

    const info = updateCheck.info;
    writeStdoutLine(info.message);

    const isAutoUpdateEnabled =
      settings.merged.general?.enableAutoUpdate !== false;
    const installationInfo = getInstallationInfo(cwd, isAutoUpdateEnabled);

    if (
      installationInfo.isStandalone &&
      installationInfo.standaloneDir &&
      isAutoUpdateEnabled
    ) {
      try {
        const result = await performStandaloneUpdate(
          installationInfo.standaloneDir,
          info.update.latest,
        );
        if (result === 'done') {
          writeStdoutLine(
            t(
              'Update successful! The new version will be used on your next run.',
            ),
          );
        } else {
          writeStdoutLine(
            t(
              'Update downloaded. It will be applied after you exit this session.',
            ),
          );
        }
      } catch (err) {
        writeStderrLine(
          t('Update failed: {{error}}', {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        process.exitCode = 1;
      }
      return;
    }

    for (const line of formatUpdateInstructions(
      installationInfo,
      info.update.latest,
    )) {
      writeStdoutLine(t(line));
    }
  },
};
