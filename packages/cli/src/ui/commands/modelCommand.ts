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
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';

export const modelCommand: SlashCommand = {
  name: 'model',
  completionPriority: 100,
  get description() {
    return t('Switch the model for this session (--fast for suggestion model)');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  completion: async (_context, partialArg) => {
    if (partialArg && '--fast'.startsWith(partialArg)) {
      return [
        {
          value: '--fast',
          description: t(
            'Set a lighter model for prompt suggestions and speculative execution',
          ),
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
        // Open model dialog in fast-model mode (interactive) or return current fast model (non-interactive)
        if (context.executionMode !== 'interactive') {
          const fastModel =
            context.services.settings?.merged?.fastModel ?? 'not set';
          return {
            type: 'message',
            messageType: 'info',
            content: `Current fast model: ${fastModel}\nUse "/model --fast <model-id>" to set fast model.`,
          };
        }
        return {
          type: 'dialog',
          dialog: 'fast-model',
        };
      }
      // Set fast model
      if (!settings) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Settings service not available.'),
        };
      }
      settings.setValue(
        getPersistScopeForModelSelection(settings),
        'fastModel',
        modelName,
      );
      // Sync the runtime Config so forked agents pick up the change immediately
      // without requiring a restart.
      config.setFastModel(modelName);
      return {
        type: 'message',
        messageType: 'info',
        content: t('Fast Model') + ': ' + modelName,
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

    // Non-interactive/ACP: set model if an arg was provided, otherwise show current model
    if (context.executionMode !== 'interactive') {
      const modelName = args.trim();
      if (modelName) {
        // /model <model-id> — set the main model
        if (!settings) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Settings service not available.'),
          };
        }
        settings.setValue(
          getPersistScopeForModelSelection(settings),
          'model.name',
          modelName,
        );
        await config.setModel(modelName);
        return {
          type: 'message',
          messageType: 'info',
          content: t('Model') + ': ' + modelName,
        };
      }
      // /model with no args — show current model
      const currentModel = config.getModel() ?? 'unknown';
      return {
        type: 'message',
        messageType: 'info',
        content: `Current model: ${currentModel}\nUse "/model <model-id>" to switch models or "/model --fast <model-id>" to set the fast model.`,
      };
    }

    return {
      type: 'dialog',
      dialog: 'model',
    };
  },
};
