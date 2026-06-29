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

    if (context.executionMode === 'interactive' && projectRoot) {
      const previousEnableAutoUpdate =
        settings.merged.general?.enableAutoUpdate;
      settings.merged.general ??= {};
      settings.merged.general.enableAutoUpdate = true;
      try {
        handleAutoUpdate(info, settings, projectRoot);
      } finally {
        settings.merged.general.enableAutoUpdate = previousEnableAutoUpdate;
      }
      return;
    }

    const installInfo = getInstallationInfo(projectRoot || process.cwd(), true);

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
          content: `${info.message}\n${message}`,
        };
      } catch (err) {
        return {
          type: 'message' as const,
          messageType: 'error' as const,
          content: t('Update failed: {{error}}', {
            error: err instanceof Error ? err.message : String(err),
          }),
        };
      }
    }

    const lines = [
      info.message,
      ...formatUpdateInstructions(installInfo, info.update.latest).map((line) =>
        t(line),
      ),
    ];

    // Non-interactive / ACP mode: report the available update and manual command.
    const msg = lines.join('\n');
    return {
      type: 'message' as const,
      messageType: 'info' as const,
      content: msg,
    };
  },
};
