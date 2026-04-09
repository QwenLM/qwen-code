/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  MessageActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

type VibeArgMode = 'on' | 'off' | 'toggle' | 'invalid';

function parseVibeArg(arg: string): VibeArgMode {
  const normalized = arg.trim().toLowerCase();
  if (!normalized) {
    return 'toggle';
  }
  if (normalized === 'on') {
    return 'on';
  }
  if (normalized === 'off') {
    return 'off';
  }
  return 'invalid';
}

export const vibeCommand: SlashCommand = {
  name: 'vibe',
  get description() {
    return t('Toggle Vibe mode safe shell auto-approval (on/off)');
  },
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<MessageActionReturn> => {
    const config = context.services.config;
    if (config === null) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Vibe mode is unavailable in this context.'),
      };
    }

    const parsed = parseVibeArg(args);

    if (parsed === 'invalid') {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Invalid vibe mode "{{arg}}". Valid values: on, off', {
          arg: args.trim(),
        }),
      };
    }

    const currentMode = config.getVibeMode();
    const nextMode = parsed === 'toggle' ? !currentMode : parsed === 'on';

    try {
      config.setVibeMode(nextMode);
    } catch (e) {
      return {
        type: 'message',
        messageType: 'error',
        content: (e as Error).message,
      };
    }

    return {
      type: 'message',
      messageType: 'info',
      content: t('Vibe mode is now {{state}}', {
        state: nextMode ? 'on' : 'off',
      }),
    };
  },
};
