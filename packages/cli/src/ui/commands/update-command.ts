/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { checkForUpdates } from '../utils/updateCheck.js';
import { handleAutoUpdate } from '../../utils/handleAutoUpdate.js';
import {
  getInstallationInfo,
  resolveUpdateCommand,
} from '../../utils/installationInfo.js';
import { getPackageJson } from '../../utils/package.js';
import { t } from '../../i18n/index.js';

export const updateCommand: SlashCommand = {
  name: 'update',
  get description() {
    return t('Check for Qwen Code updates and install if available');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context) => {
    const settings = context.services.settings;
    const projectRoot = context.services.config?.getProjectRoot();

    const info = await checkForUpdates();

    if (!info) {
      const pkg = await getPackageJson();
      const version = pkg?.version || 'unknown';
      const msg = t('Qwen Code {{version}} is up to date!', { version });
      return {
        type: 'message' as const,
        messageType: 'info' as const,
        content: msg,
      };
    }

    // In interactive mode (TUI), route through handleAutoUpdate which emits
    // events the TUI already listens to (UpdateNotification, etc.).
    const isAutoUpdateEnabled =
      settings.merged.general?.enableAutoUpdate !== false;

    if (
      context.executionMode === 'interactive' &&
      projectRoot &&
      isAutoUpdateEnabled
    ) {
      handleAutoUpdate(info, settings, projectRoot);
      return;
    }

    const installationInfo = getInstallationInfo(
      projectRoot || process.cwd(),
      isAutoUpdateEnabled,
    );
    const lines = [info.message];
    if (installationInfo.updateMessage && !installationInfo.updateCommand) {
      lines.push(installationInfo.updateMessage);
    }
    if (installationInfo.updateCommand) {
      const updateCmd = resolveUpdateCommand(
        installationInfo.updateCommand,
        info.update.latest,
      );
      lines.push(t('Run the following to update:'), `  ${updateCmd}`);
    } else if (!installationInfo.updateMessage) {
      if (installationInfo.isStandalone) {
        lines.push(
          t(
            'Unable to auto-update this standalone installation. Please reinstall from:',
          ),
          '  https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/',
        );
      } else {
        lines.push(t('Manual update required. Please reinstall Qwen Code.'));
      }
    }

    // Non-interactive / ACP mode: report the available update and manual command.
    const msg = lines.join('\n');
    return {
      type: 'message' as const,
      messageType: 'info' as const,
      content: msg,
    };
  },
};
