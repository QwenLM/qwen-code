/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  MessageActionReturn,
  OpenDialogActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import type { ModeDefinition } from '@qwen-code/modes';

export const modeCommand: SlashCommand = {
  name: 'mode',
  get description() {
    return t('Switch between different agent modes');
  },
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<OpenDialogActionReturn | MessageActionReturn> => {
    const { services } = context;
    const { config } = services;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Configuration not available.'),
      };
    }

    // Проверяем, есть ли аргументы (имя режима)
    const modeId = args.trim().toLowerCase();

    if (!modeId) {
      // Без аргументов - показываем список доступных режимов
      return {
        type: 'message',
        messageType: 'info',
        content: formatModeList(context),
      };
    }

    // Пытаемся переключить режим
    try {
      const modeManager = config.getModeManager();
      if (!modeManager) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Mode manager not available.'),
        };
      }

      const newMode = await modeManager.switchMode(modeId);
      const modeInfo = formatModeInfo(newMode);

      return {
        type: 'message',
        messageType: 'info',
        content: modeInfo,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: error instanceof Error ? error.message : String(error),
      };
    }
  },
  completion: async (
    context: CommandContext,
    partialArg: string,
  ): Promise<Array<string | { value: string; label?: string; description?: string }> | null> => {
    const { services } = context;
    const { config } = services;

    if (!config) {
      return null;
    }

    const modeManager = config.getModeManager();
    if (!modeManager) {
      return null;
    }

    const availableModes = modeManager.getAvailableModes();
    const partial = partialArg.toLowerCase();

    return availableModes
      .filter((mode) => mode.id.toLowerCase().startsWith(partial))
      .map((mode) => ({
        value: mode.id,
        label: `${mode.icon || ''} ${mode.name}`,
        description: mode.description,
      }));
  },
  subCommands: [
    {
      name: 'list',
      description: t('List all available modes'),
      kind: CommandKind.BUILT_IN,
      action: (context): MessageActionReturn => ({
        type: 'message',
        messageType: 'info',
        content: formatModeList(context),
      }),
    },
    {
      name: 'current',
      description: t('Show current mode'),
      kind: CommandKind.BUILT_IN,
      action: (context): MessageActionReturn => {
        const { services } = context;
        const { config } = services;

        if (!config) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Configuration not available.'),
          };
        }

        const modeManager = config.getModeManager();
        if (!modeManager) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Mode manager not available.'),
          };
        }

        const currentMode = modeManager.getCurrentMode();
        return {
          type: 'message',
          messageType: 'info',
          content: formatModeInfo(currentMode),
        };
      },
    },
  ],
};

/**
 * Форматирование списка режимов для вывода
 */
function formatModeList(context: CommandContext): string {
  const { services } = context;
  const { config } = services;

  if (!config) {
    return t('Configuration not available.');
  }

  const modeManager = config.getModeManager();
  if (!modeManager) {
    return t('Mode manager not available.');
  }

  const currentMode = modeManager.getCurrentMode();
  const availableModes = modeManager.getAvailableModes();

  const lines: string[] = [
    t('**Available Modes:**'),
    '',
    ...availableModes.map((mode: ModeDefinition) => {
      const isCurrent = mode.id === currentMode.id;
      const prefix = isCurrent ? '👉' : '  ';
      const currentMarker = isCurrent ? ' **(current)**' : '';
      const icon = mode.icon || '  ';
      return `${prefix} ${icon} **${mode.name}** (\`/${mode.id}\`)${currentMarker}`;
    }),
    '',
    t('**Usage:**'),
    t('- `/mode <name>` - Switch to a mode'),
    t('- `/mode list` - Show this list'),
    t('- `/mode current` - Show current mode'),
  ];

  return lines.join('\n');
}

/**
 * Форматирование информации о режиме
 */
function formatModeInfo(mode: ModeDefinition): string {
  const icon = mode.icon || '';
  const allowedTools = mode.allowedTools.join(', ');

  const lines: string[] = [
    `${icon} **${mode.name}** (\`/${mode.id}\`)`,
    '',
    `📋 ${mode.description}`,
    '',
    mode.useCases.length > 0
      ? `**${t('Use Cases:')}**\n${mode.useCases.map((uc) => `• ${uc}`).join('\n')}`
      : '',
    '',
    `**${t('Allowed Tools:')}**\n${allowedTools}`,
    mode.excludedTools && mode.excludedTools.length > 0
      ? `\n**${t('Excluded Tools:')}**\n${mode.excludedTools.join(', ')}`
      : '',
    mode.safetyConstraints.length > 0
      ? `\n**${t('Safety Constraints:')}**\n${mode.safetyConstraints.map((sc) => `⚠️ ${sc}`).join('\n')}`
      : '',
  ];

  return lines.filter((line) => line !== '').join('\n');
}
