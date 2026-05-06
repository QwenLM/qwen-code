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

// Get an array of the available model IDs as strings
function getAvailableModelIds(context: CommandContext) {
  const { services } = context;
  const { config } = services;
  if (!config) {
    return [];
  }
  const availableModels = config.getAvailableModels();
  // Convert AvailableModel[] to string[] on AvailableModel.id
  return availableModels.map((model) => model.id);
}

export const modelCommand: SlashCommand = {
  name: 'model',
  completionPriority: 100,
  get description() {
    return t(
      'Switch the model for this session (--fast for suggestion model, [model-id] to switch immediately).',
    );
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  completion: async (context, partialArg) => {
    if (partialArg && '--fast'.startsWith(partialArg)) {
      return [
        {
          value: '--fast',
          description: t(
            'Set a lighter model for prompt suggestions and speculative execution',
          ),
        },
      ];
    } else if (partialArg.trim()) {
      // Include model IDs matching the partial argument
      return getAvailableModelIds(context).filter((id) =>
        id.startsWith(partialArg.trim()),
      );
    } else {
      return null;
    }
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

    // Handle modelName argument: immediately switch to the provided model
    if (args !== '' && context.executionMode === 'interactive') {
      const modelName = args.trim().split(' ')[0];
      if (modelName) {
        // Use first argument only, avoids later syntax confusion and/or use of model names with spaces
        // Ignore argument if it is empty, e.g. to avoid confusion with trailing whitespace
        if (!settings) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Settings service not available.'),
          };
        }
        await config.setModel(modelName);
        settings.setValue(
          getPersistScopeForModelSelection(settings),
          'model.name',
          modelName,
        );

        if (config.getModelsConfig().hasModel(authType, modelName)) {
          return {
            type: 'message',
            messageType: 'info',
            content: t('Model') + ': ' + modelName,
          };
        } else {
          return {
            type: 'message',
            messageType: 'info',
            content:
              t('Model') + ': ' + modelName + t(' (not in model registry)'),
          };
        }
      }
    }

    // Non-interactive/ACP: set model if an arg was provided, otherwise show current model
    if (context.executionMode !== 'interactive') {
      const modelName = args.trim().split(' ')[0];
      if (modelName.trim()) {
        // /model <model-id> — set the main model
        if (!settings) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Settings service not available.'),
          };
        }
        await config.setModel(modelName);
        settings.setValue(
          getPersistScopeForModelSelection(settings),
          'model.name',
          modelName,
        );
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
