/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { initializeI18n, resolveLanguageSetting, t } from '../i18n/index.js';

interface UpdateArgs {
  targetVersion?: string;
}

export const updateCommand: CommandModule<object, UpdateArgs> = {
  command: 'update',
  get describe() {
    return t('Check for Qwen Code updates and install if available');
  },
  builder: (yargs) =>
    yargs.option('target-version', {
      type: 'string',
      requiresArg: true,
      description: t('Install an exact version without querying npm'),
    }),
  handler: async (argv) => {
    const [
      { loadSettings },
      { checkForUpdatesDetailed, describeUpdateCheckFailure },
      installationInfoModule,
      standaloneUpdate,
      stdioHelpers,
      { updateEventEmitter },
    ] = await Promise.all([
      import('../config/settings.js'),
      import('../ui/utils/updateCheck.js'),
      import('../utils/installationInfo.js'),
      import('../ui/standalone-update.js'),
      import('../utils/stdioHelpers.js'),
      import('../utils/updateEventEmitter.js'),
    ]);

    const { formatUpdateInstructions, getInstallationInfo } =
      installationInfoModule;
    const { performStandaloneUpdate, normalizeVersion } = standaloneUpdate;
    const { writeStdoutLine, writeStderrLine } = stdioHelpers;

    const cwd = process.cwd();
    const settings = loadSettings(cwd, false);
    await initializeI18n(
      resolveLanguageSetting(settings.merged.general?.language as string),
    );

    let targetVersion: string;
    if (argv.targetVersion !== undefined) {
      try {
        targetVersion = normalizeVersion(argv.targetVersion).slice(1);
      } catch (err) {
        writeStderrLine(
          t('Update failed: {{error}}', {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        process.exitCode = 1;
        return;
      }
    } else {
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
          t(
            'Failed to check for updates ({{reason}}). Please check your network or registry configuration.',
            { reason: describeUpdateCheckFailure(updateCheck.error) },
          ),
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

      targetVersion = updateCheck.info.update.latest;
      writeStdoutLine(updateCheck.info.message);
    }

    const installationInfo = getInstallationInfo(cwd, true);

    if (installationInfo.isStandalone && installationInfo.standaloneDir) {
      const handleUpdateInfo = (data: { message: string }) => {
        writeStdoutLine(data.message);
      };
      updateEventEmitter.on('update-info', handleUpdateInfo);
      try {
        writeStdoutLine(t('Downloading update...'));
        const result = await performStandaloneUpdate(
          installationInfo.standaloneDir,
          targetVersion,
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
      } finally {
        updateEventEmitter.off('update-info', handleUpdateInfo);
      }
      return;
    }

    if (argv.targetVersion !== undefined) {
      writeStderrLine(
        t(
          'Exact-version updates require a standalone installation. Install version {{version}} manually using your installation method.',
          { version: targetVersion },
        ),
      );
      process.exitCode = 1;
      return;
    }

    for (const line of formatUpdateInstructions(
      installationInfo,
      targetVersion,
    )) {
      writeStdoutLine(t(line));
    }
  },
};
