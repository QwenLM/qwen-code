/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { loadSettings } from '../config/settings.js';
import { checkForUpdates } from '../ui/utils/updateCheck.js';
import {
  getInstallationInfo,
  resolveUpdateCommand,
} from '../utils/installationInfo.js';
import { performStandaloneUpdate } from '../utils/standalone-update.js';
import { getPackageJson } from '../utils/package.js';
import { writeStdoutLine, writeStderrLine } from '../utils/stdioHelpers.js';
import { t } from '../i18n/index.js';

export const updateCommand: CommandModule = {
  command: 'update',
  describe: t('Check for Qwen Code updates and install if available'),
  handler: async () => {
    const cwd = process.cwd();
    const settings = loadSettings(cwd, false);

    const info = await checkForUpdates();

    if (!info) {
      const pkg = await getPackageJson();
      const version = pkg?.version || 'unknown';
      writeStdoutLine(t('Qwen Code {{version}} is up to date!', { version }));
      return;
    }

    writeStdoutLine(info.message);

    const isAutoUpdateEnabled =
      settings.merged.general?.enableAutoUpdate !== false;
    const installationInfo = getInstallationInfo(cwd, isAutoUpdateEnabled);

    if (installationInfo.updateMessage && !installationInfo.updateCommand) {
      writeStdoutLine(installationInfo.updateMessage);
    }

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

    if (installationInfo.updateCommand) {
      const updateCmd = resolveUpdateCommand(
        installationInfo.updateCommand,
        info.update.latest,
      );
      writeStdoutLine(t('Run the following to update:'));
      writeStdoutLine(`  ${updateCmd}`);
    } else {
      if (installationInfo.isStandalone) {
        writeStdoutLine(
          t(
            'Unable to auto-update this standalone installation. Please reinstall from:',
          ),
        );
        writeStdoutLine(
          '  https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/',
        );
      } else {
        writeStdoutLine(
          t('Manual update required. Please reinstall Qwen Code.'),
        );
      }
    }
  },
};
