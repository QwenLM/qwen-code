/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LoadedSettings } from '../config/settings.js';
import { writeStderrLine } from './stdioHelpers.js';

const UPDATE_CHECK_FAILED_MESSAGE =
  'Failed to check for updates. Please check your network or registry configuration.';
const UPDATE_FAILED_MESSAGE =
  'Automatic update failed. Please try updating manually.';

export async function updateBeforeRelaunch(
  settings: LoadedSettings,
  projectRoot: string,
): Promise<boolean> {
  let translate = (message: string) => message;
  try {
    const [
      { checkForUpdatesDetailed },
      { handleAutoUpdate },
      { getInstallationInfo },
      { performStandaloneUpdate },
      { t },
    ] = await Promise.all([
      import('../ui/utils/updateCheck.js'),
      import('./handleAutoUpdate.js'),
      import('./installationInfo.js'),
      import('./standalone-update.js'),
      import('../i18n/index.js'),
    ]);
    translate = t;
    const result = await checkForUpdatesDetailed();

    if (result.status === 'update') {
      writeStderrLine(result.info.message);
      const installationInfo = getInstallationInfo(projectRoot, true);
      if (installationInfo.isStandalone && installationInfo.standaloneDir) {
        const standaloneResult = await performStandaloneUpdate(
          installationInfo.standaloneDir,
          result.info.update.latest,
        );
        writeStderrLine(
          t(
            standaloneResult === 'deferred'
              ? 'Update downloaded. It will be applied after you exit this session.'
              : 'Update successful! The new version will be used on your next run.',
          ),
        );
        return standaloneResult !== 'deferred';
      }
      if (!installationInfo.updateCommand) {
        writeStderrLine(
          installationInfo.updateMessage ??
            t('Manual update required. Please reinstall Qwen Code.'),
        );
        return true;
      }
      const updateProcess = handleAutoUpdate(
        result.info,
        settings,
        projectRoot,
      );
      const success = updateProcess
        ? await new Promise<boolean>((resolve) => {
            updateProcess.once('close', (code) => resolve(code === 0));
            updateProcess.once('error', () => resolve(false));
          })
        : false;
      writeStderrLine(
        t(
          success
            ? 'Update successful! The new version will be used on your next run.'
            : UPDATE_FAILED_MESSAGE,
        ),
      );
      return true;
    } else if (result.status === 'error') {
      writeStderrLine(t(UPDATE_CHECK_FAILED_MESSAGE));
    }
  } catch {
    writeStderrLine(translate(UPDATE_FAILED_MESSAGE));
  }
  return true;
}
