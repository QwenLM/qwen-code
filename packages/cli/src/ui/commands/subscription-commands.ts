/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { getQwenSubscriptionPlansUrl } from '@qwen-code/qwen-code-core/qwen/oauth-config.js';
import { openBrowserSecurely } from '@qwen-code/qwen-code-core/utils/secure-browser-launcher.js';
import { t } from '../../i18n/index.js';
import { CommandKind, type SlashCommand } from './types.js';

export const upgradeCommand: SlashCommand = {
  name: 'upgrade',
  get description() {
    return t('Open Qwen subscription plans');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'],
  action: async (context) => {
    const url = getQwenSubscriptionPlansUrl();
    if (!context.services.config?.isBrowserLaunchSuppressed()) {
      try {
        await openBrowserSecurely(url);
      } catch {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Could not open your browser. Visit {{url}}', { url }),
        };
      }
    }
    return {
      type: 'message',
      messageType: 'info',
      content: t('Qwen subscription plans: {{url}}', { url }),
    };
  },
};
