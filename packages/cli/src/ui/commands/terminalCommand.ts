/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { SettingScope } from '../../config/settings.js';
import { t } from '../../i18n/index.js';

export const terminalCommand: SlashCommand = {
  name: 'terminal',
  get description() {
    return t('manage dedicated terminal for shell command display');
  },
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'enable',
      get description() {
        return t('enable dedicated terminal');
      },
      kind: CommandKind.BUILT_IN,
      action: (context: CommandContext): SlashCommandActionReturn => {
        context.services.settings.setValue(
          SettingScope.User,
          'ide.dedicatedTerminal',
          true,
        );
        return {
          type: 'message',
          messageType: 'info',
          content: t(
            'Dedicated terminal enabled. Shell commands will be displayed in a dedicated terminal.',
          ),
        } as const;
      },
    },
    {
      name: 'disable',
      get description() {
        return t('disable dedicated terminal');
      },
      kind: CommandKind.BUILT_IN,
      action: (context: CommandContext): SlashCommandActionReturn => {
        context.services.settings.setValue(
          SettingScope.User,
          'ide.dedicatedTerminal',
          false,
        );
        return {
          type: 'message',
          messageType: 'error',
          content: t(
            'Dedicated terminal disabled. Shell commands will no longer be displayed in a dedicated terminal.',
          ),
        } as const;
      },
    },
    {
      name: 'status',
      get description() {
        return t('check dedicated terminal status');
      },
      kind: CommandKind.BUILT_IN,
      action: (context: CommandContext): SlashCommandActionReturn => {
        const enabled =
          context.services.settings.merged?.['ide']?.['dedicatedTerminal'] ??
          true;
        return {
          type: 'message',
          messageType: 'info',
          content: enabled
            ? t('Dedicated terminal is currently enabled.')
            : t('Dedicated terminal is currently disabled.'),
        } as const;
      },
    },
  ],
};
