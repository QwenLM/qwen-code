/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

export const updateCommand: SlashCommand = {
  name: 'update',
  get description() {
    return t('Check for Qwen Code updates and install if available');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context) => {
    const [
      { checkForUpdatesDetailed },
      { handleAutoUpdate },
      { performStandaloneUpdate },
      installationInfo,
    ] = await Promise.all([
      import('../utils/updateCheck.js'),
      import('../../utils/handleAutoUpdate.js'),
      import('../../utils/standalone-update.js'),
      import('../../utils/installationInfo.js'),
    ]);
    const { formatUpdateInstructions, getInstallationInfo } = installationInfo;

    const settings = context.services.settings;
    const projectRoot = context.services.config?.getProjectRoot();

    const updateCheck = await checkForUpdatesDetailed();

    if (updateCheck.status === 'up-to-date') {
      const msg = t('Qwen Code {{version}} is up to date!', {
        version: updateCheck.currentVersion,
      });
      return {
        type: 'message' as const,
        messageType: 'info' as const,
        content: msg,
      };
    }

    if (updateCheck.status === 'error') {
      return {
        type: 'message' as const,
        messageType: 'error' as const,
        content: t(
          'Failed to check for updates. Please check your network or registry configuration.',
        ),
      };
    }

    if (updateCheck.status === 'skipped') {
      return {
        type: 'message' as const,
        messageType: 'error' as const,
        content: t('Unable to check for updates: {{reason}}', {
          reason: updateCheck.reason,
        }),
      };
    }

    const info = updateCheck.info;
    const installInfo = getInstallationInfo(projectRoot || process.cwd(), true);
    const manualInstructions = () => {
      const lines = [
        info.message,
        ...formatUpdateInstructions(installInfo, info.update.latest).map(
          (line) => t(line),
        ),
      ];
      return {
        type: 'message' as const,
        messageType: 'info' as const,
        content: lines.join('\n'),
      };
    };

    if (context.executionMode === 'interactive' && projectRoot) {
      const isAutoUpdateEnabled =
        settings.merged.general?.enableAutoUpdate !== false;
      const canAutoUpdate =
        installInfo.updateCommand ||
        (installInfo.isStandalone && installInfo.standaloneDir);
      if (isAutoUpdateEnabled && canAutoUpdate) {
        handleAutoUpdate(info, settings, projectRoot);
        return;
      }
      return manualInstructions();
    }

    if (installInfo.isStandalone && installInfo.standaloneDir) {
      try {
        const result = await performStandaloneUpdate(
          installInfo.standaloneDir,
          info.update.latest,
        );
        const message =
          result === 'done'
            ? t(
                'Update successful! The new version will be used on your next run.',
              )
            : t(
                'Update downloaded. It will be applied after you exit this session.',
              );
        return {
          type: 'message' as const,
          messageType: 'info' as const,
          content: `${info.message}\n${t('Downloading update...')}\n${message}`,
        };
      } catch (err) {
        const message = t('Update failed: {{error}}', {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          type: 'message' as const,
          messageType: 'error' as const,
          content: `${info.message}\n${message}`,
        };
      }
    }

    // Non-interactive / ACP mode: report the available update and manual command.
    return manualInstructions();
  },
};
