/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { checkForUpdates } from '../utils/updateCheck.js';
import { handleAutoUpdate } from '../../utils/handleAutoUpdate.js';
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

    if (settings.merged.general?.enableAutoUpdate === false) {
      const msg = t(
        'Auto-update is disabled. Enable it in settings to use this command.',
      );
      return {
        type: 'message' as const,
        messageType: 'info' as const,
        content: msg,
      };
    }

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
    if (context.executionMode === 'interactive' && projectRoot) {
      handleAutoUpdate(info, settings, projectRoot);
      return;
    }

    // Non-interactive / ACP mode: just report the available update.
    const msg = info.message;
    return {
      type: 'message' as const,
      messageType: 'info' as const,
      content: msg,
    };
  },
};
