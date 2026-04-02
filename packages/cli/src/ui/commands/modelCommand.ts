/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  OpenDialogActionReturn,
  MessageActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { MessageType } from '../types.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';

export const modelCommand: SlashCommand = {
  name: 'model',
  get description() {
    return t('Switch the model for this session');
  },
  kind: CommandKind.BUILT_IN,
  completion: async (_context, partialArg) => {
    if ('--fast'.startsWith(partialArg)) {
      return [
        {
          value: '--fast',
          description: t('Set fast model for background tasks'),
        },
      ];
    }
    return null;
  },
  action: async (
    context: CommandContext,
  ): Promise<OpenDialogActionReturn | MessageActionReturn> => {
    const { services } = context;
    const { config, settings } = services;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Configuration not available.'),
      };
    }

    // Handle --fast flag: /model --fast <modelName>
    const args = context.invocation?.args?.trim() ?? '';
    if (args.startsWith('--fast')) {
      const modelName = args.replace('--fast', '').trim();
      if (!modelName) {
        // Open model dialog in fast-model mode
        return {
          type: 'dialog',
          dialog: 'fast-model',
        };
      }
      // Set fast model
      if (settings) {
        settings.setValue(
          getPersistScopeForModelSelection(settings),
          'fastModel',
          modelName,
        );
        context.ui.addItem(
          {
            type: MessageType.SUCCESS,
            text: t('Fast Model') + ': ' + modelName,
          },
          Date.now(),
        );
      }
      return {
        type: 'message',
        messageType: 'info',
        content: t('Fast model updated.'),
      };
    }

    const contentGeneratorConfig = config.getContentGeneratorConfig();
    if (!contentGeneratorConfig) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Content generator configuration not available.'),
      };
    }

    const authType = contentGeneratorConfig.authType;
    if (!authType) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Authentication type not available.'),
      };
    }

    return {
      type: 'dialog',
      dialog: 'model',
    };
  },
};
