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
import {
  AuthType,
  type AvailableModel,
  type Config,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { parseAcpModelOption } from '../../utils/acpModelUtils.js';

function persistSetting(
  settings: LoadedSettings,
  path: string,
  value: unknown,
): void {
  settings.setValue(getPersistScopeForModelSelection(settings), path, value);
}

async function switchMainModel(
  config: Config,
  settings: LoadedSettings,
  currentAuthType: AuthType,
  modelArg: string,
): Promise<string> {
  const parsed = parseAcpModelOption(modelArg);

  if (parsed.authType) {
    await config.switchModel(
      parsed.authType,
      parsed.modelId,
      parsed.authType !== currentAuthType &&
        parsed.authType === AuthType.QWEN_OAUTH
        ? { requireCachedCredentials: true }
        : undefined,
    );
    persistSetting(settings, 'security.auth.selectedType', parsed.authType);
    persistSetting(settings, 'model.name', parsed.modelId);
    return parsed.modelId;
  }

  await config.switchModel(currentAuthType, modelArg, undefined);
  persistSetting(settings, 'model.name', modelArg);
  return modelArg;
}

function formatUnavailableModelMessage(
  kind: 'Model' | 'Fast model',
  modelName: string,
  authType: AuthType,
  availableModels: AvailableModel[],
): string {
  const availableModelIds = Array.from(
    new Set(availableModels.map((model) => model.id)),
  );
  const availableModelsLine =
    availableModelIds.length === 0
      ? `No models are configured for auth type '${authType}'.`
      : `Available models for '${authType}': ${availableModelIds.join(', ')}.`;

  return (
    `${kind} '${modelName}' is not available for auth type '${authType}'.\n` +
    `${availableModelsLine}\n` +
    'Configure models in settings.modelProviders or run /model to select an available model.'
  );
}

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
  argumentHint: '[--fast] [<model-id>]',
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
    actionArgs: string,
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
    const args = context.invocation?.args?.trim() || actionArgs.trim();
    const isFastModelCommand = args === '--fast' || args.startsWith('--fast ');
    if (isFastModelCommand) {
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

      const contentGeneratorConfig = config.getContentGeneratorConfig();
      const authType = contentGeneratorConfig?.authType;
      if (!authType) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Authentication type not available.'),
        };
      }

      const availableModels = config.getAvailableModelsForAuthType(authType);
      if (!availableModels.some((model) => model.id === modelName)) {
        return {
          type: 'message',
          messageType: 'error',
          content: formatUnavailableModelMessage(
            'Fast model',
            modelName,
            authType,
            availableModels,
          ),
        };
      }

      persistSetting(settings, 'fastModel', modelName);
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

    const modelName = args.trim().split(/\s+/)[0] ?? '';
    if (modelName) {
      if (!settings) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Settings service not available.'),
        };
      }
      const parsed = parseAcpModelOption(modelName);
      const targetAuthType = parsed.authType ?? authType;
      const availableModels =
        config.getAvailableModelsForAuthType(targetAuthType);
      if (!availableModels.some((model) => model.id === parsed.modelId)) {
        return {
          type: 'message',
          messageType: 'error',
          content: formatUnavailableModelMessage(
            'Model',
            parsed.modelId,
            targetAuthType,
            availableModels,
          ),
        };
      }
      const effectiveModelName = await switchMainModel(
        config,
        settings,
        authType,
        modelName,
      );
      return {
        type: 'message',
        messageType: 'info',
        content: t('Model') + ': ' + effectiveModelName,
      };
    }

    // Non-interactive/ACP: set model if an arg was provided, otherwise show current model
    if (context.executionMode !== 'interactive') {
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
