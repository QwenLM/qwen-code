/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import os from 'node:os';

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
      {
        CUSTOM_SANDBOX_IMAGE_ENV_VAR,
        HOST_UPDATE_RELAUNCH_ENV_VAR,
        canRelaunchForUpdate,
        prepareUpdateRelaunch,
        relaunchForUpdate,
      },
      { performStandaloneUpdate },
      installationInfo,
    ] = await Promise.all([
      import('../utils/updateCheck.js'),
      import('../../utils/processUtils.js'),
      import('../../utils/standalone-update.js'),
      import('../../utils/installationInfo.js'),
    ]);
    const { formatUpdateInstructions, getInstallationInfo } = installationInfo;

    const settings = context.services.settings;
    const config = context.services.config;
    const projectRoot = config?.getProjectRoot();

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
    const updateStandalone = async () => {
      try {
        const result = await performStandaloneUpdate(
          installInfo.standaloneDir!,
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
    };

    if (context.executionMode === 'interactive' && projectRoot && config) {
      const customSandboxImage = process.env[CUSTOM_SANDBOX_IMAGE_ENV_VAR];
      if (customSandboxImage) {
        return {
          type: 'message' as const,
          messageType: 'info' as const,
          content: `${info.message}\n${t(
            'This session uses the custom sandbox image {{image}}. Update that image and restart Qwen Code.',
            { image: customSandboxImage },
          )}`,
        };
      }
      const hostUpdateRelaunch = process.env[HOST_UPDATE_RELAUNCH_ENV_VAR];
      const isAutoUpdateEnabled =
        settings.merged.general?.enableAutoUpdate !== false;
      if (hostUpdateRelaunch === 'true' && isAutoUpdateEnabled) {
        const prepared = await prepareUpdateRelaunch(
          config,
          context.ui.history.some((item) => item.type === 'user'),
          Boolean(config.getQuestion()),
        );
        if (!prepared) return manualInstructions();
        await relaunchForUpdate(prepared.sessionId, prepared.skipInitialPrompt);
        return;
      }
      if (hostUpdateRelaunch !== undefined) {
        return {
          type: 'message' as const,
          messageType: 'info' as const,
          content: `${info.message}\n${t(
            'Update Qwen Code on the host, then restart the sandbox.',
          )}`,
        };
      }
      const canAutoUpdate =
        installInfo.updateCommand ||
        (installInfo.isStandalone && installInfo.standaloneDir);
      if (
        installInfo.isStandalone &&
        installInfo.standaloneDir &&
        os.platform() === 'win32'
      ) {
        return updateStandalone();
      }
      if (isAutoUpdateEnabled && canAutoUpdate && canRelaunchForUpdate()) {
        const prepared = await prepareUpdateRelaunch(
          config,
          context.ui.history.some((item) => item.type === 'user'),
          Boolean(config.getQuestion()),
        );
        if (!prepared) return manualInstructions();
        await relaunchForUpdate(prepared.sessionId, prepared.skipInitialPrompt);
        return;
      }
      return manualInstructions();
    }

    if (installInfo.isStandalone && installInfo.standaloneDir) {
      return updateStandalone();
    }

    // Non-interactive / ACP mode: report the available update and manual command.
    return manualInstructions();
  },
};
