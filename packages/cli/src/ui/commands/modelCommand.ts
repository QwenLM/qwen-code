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
  ModelSlashCommandEvent,
  logModelSlashCommand,
  type AvailableModel,
  type Config,
  resolveModelId,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import {
  formatAcpModelId,
  parseAcpModelOption,
} from '../../utils/acpModelUtils.js';
import { qwenOAuthDiscontinuedMessage } from '../utils/qwenOAuthDiscontinuedMessage.js';

function persistSetting(
  settings: LoadedSettings,
  path: string,
  value: unknown,
): void {
  settings.setValue(getPersistScopeForModelSelection(settings), path, value);
}

async function switchMainModel(
  config: Config,
  fallbackAuthType: AuthType,
  modelArg: string,
): Promise<string> {
  const parsed = parseAcpModelOption(modelArg);

  if (parsed.authType) {
    await config.switchModel(
      parsed.authType,
      parsed.modelId,
      parsed.authType !== fallbackAuthType &&
        parsed.authType === AuthType.QWEN_OAUTH
        ? { requireCachedCredentials: true }
        : undefined,
    );
    return parsed.modelId;
  }

  await config.switchModel(fallbackAuthType, modelArg, undefined);
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

function formatUnavailableFastModelMessage(
  modelName: string,
  availableModels: AvailableModel[],
): string {
  const availableModelIds = Array.from(
    new Set(availableModels.map((model) => model.id)),
  );
  const availableModelsLine =
    availableModelIds.length === 0
      ? 'No models are configured.'
      : `Configured models: ${availableModelIds.join(', ')}.`;

  return (
    `Fast model '${modelName}' is not configured for any auth type.\n` +
    `${availableModelsLine}\n` +
    'Configure models in settings.modelProviders or run /model to select an available model.'
  );
}

// Get an array of the available model IDs as strings
function getAvailableModelIds(
  context: CommandContext,
  options: { excludeRuntimeModels?: boolean } = {},
) {
  const { services } = context;
  const { config } = services;
  if (!config) {
    return [];
  }
  const currentAuthType = config.getContentGeneratorConfig()?.authType;
  const availableModels = config.getAllConfiguredModels();
  return Array.from(
    new Set(
      availableModels
        .filter(
          (model) => !options.excludeRuntimeModels || !model.isRuntimeModel,
        )
        .map((model) =>
          model.authType === currentAuthType
            ? model.id
            : formatAcpModelId(model.id, model.authType),
        ),
    ),
  );
}

export const modelCommand: SlashCommand = {
  name: 'model',
  completionPriority: 100,
  get description() {
    return t(
      'Switch the model for this session (--default to persist, --fast for suggestion model).',
    );
  },
  argumentHint: '[--default|--fast] [<model-id>]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  completion: async (context, partialArg) => {
    const leadingTrimmedPartialArg = partialArg.trimStart();
    const trimmedPartialArg = leadingTrimmedPartialArg.trimEnd();
    if (leadingTrimmedPartialArg.startsWith('--default ')) {
      const modelPartial = leadingTrimmedPartialArg
        .slice('--default '.length)
        .trimStart();
      return getAvailableModelIds(context, { excludeRuntimeModels: true })
        .filter((id) => id.startsWith(modelPartial))
        .map((id) => `--default ${id}`);
    }
    if (leadingTrimmedPartialArg.startsWith('--fast ')) {
      const modelPartial = leadingTrimmedPartialArg
        .slice('--fast '.length)
        .trimStart();
      return getAvailableModelIds(context, { excludeRuntimeModels: true })
        .filter((id) => id.startsWith(modelPartial))
        .map((id) => `--fast ${id}`);
    }

    const flagCompletions = [
      {
        value: '--default',
        description: t('Persist the selected model as the default'),
      },
      {
        value: '--fast',
        description: t(
          'Set a lighter model for prompt suggestions and speculative execution',
        ),
      },
    ].filter((completion) => completion.value.startsWith(trimmedPartialArg));

    if (flagCompletions.length > 0) {
      return flagCompletions;
    } else if (trimmedPartialArg) {
      // Include model IDs matching the partial argument
      return getAvailableModelIds(context, {
        excludeRuntimeModels: true,
      }).filter((id) => id.startsWith(trimmedPartialArg));
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
    const argTokens = args.split(/\s+/).filter(Boolean);
    const isDefaultModelCommand = argTokens.includes('--default');
    const isFastModelCommand = argTokens.includes('--fast');
    if (isDefaultModelCommand && isFastModelCommand) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Use either --default or --fast, not both.'),
      };
    }

    if (isFastModelCommand) {
      const modelName =
        argTokens.find(
          (token) => token !== '--fast' && token !== '--default',
        ) ?? '';
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

      const parsedFastModel = parseAcpModelOption(modelName);
      const normalizedFastModel = parsedFastModel.authType
        ? `${parsedFastModel.authType}:${parsedFastModel.modelId}`
        : modelName;
      const selector = (() => {
        try {
          return resolveModelId(normalizedFastModel);
        } catch {
          return undefined;
        }
      })();
      if (!selector) {
        return {
          type: 'message',
          messageType: 'error',
          content: formatUnavailableFastModelMessage(modelName, []),
        };
      }

      const availableModels = selector.authType
        ? config.getAvailableModelsForAuthType(selector.authType)
        : config.getAllConfiguredModels();
      if (!availableModels.some((model) => model.id === selector.modelId)) {
        return {
          type: 'message',
          messageType: 'error',
          content: selector.authType
            ? formatUnavailableModelMessage(
                'Fast model',
                selector.modelId,
                selector.authType,
                availableModels,
              )
            : formatUnavailableFastModelMessage(modelName, availableModels),
        };
      }

      persistSetting(settings, 'fastModel', normalizedFastModel);
      // Sync the runtime Config so forked agents pick up the change immediately
      // without requiring a restart.
      config.setFastModel(normalizedFastModel);
      return {
        type: 'message',
        messageType: 'info',
        content: t('Fast Model') + ': ' + normalizedFastModel,
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

    const modelName = isDefaultModelCommand
      ? (argTokens.find(
          (token) => token !== '--default' && token !== '--fast',
        ) ?? '')
      : (argTokens[0] ?? '');
    if (modelName) {
      if (isDefaultModelCommand && !settings) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Settings service not available.'),
        };
      }
      const parsed = parseAcpModelOption(modelName);
      const targetAuthType = parsed.authType ?? authType;
      if (isDefaultModelCommand && targetAuthType === AuthType.QWEN_OAUTH) {
        return {
          type: 'message',
          messageType: 'error',
          content: qwenOAuthDiscontinuedMessage(),
        };
      }
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
        authType,
        modelName,
      );
      if (isDefaultModelCommand) {
        try {
          const afterConfig = config.getContentGeneratorConfig?.();
          const effectiveAfterConfig =
            afterConfig &&
            (afterConfig.model !== contentGeneratorConfig.model ||
              afterConfig.authType !== contentGeneratorConfig.authType)
              ? afterConfig
              : undefined;
          persistSetting(
            settings,
            'security.auth.selectedType',
            effectiveAfterConfig?.authType ?? targetAuthType,
          );
          persistSetting(
            settings,
            'model.name',
            effectiveAfterConfig?.model ?? parsed.modelId,
          );
        } catch (e) {
          const baseErrorMessage = e instanceof Error ? e.message : String(e);
          return {
            type: 'message',
            messageType: 'error',
            content:
              `Switched to '${effectiveModelName}' for this session, ` +
              `but failed to persist as default.\n\n${baseErrorMessage}`,
          };
        }
      }
      if (typeof config.getUsageStatisticsEnabled === 'function') {
        logModelSlashCommand(
          config,
          new ModelSlashCommandEvent(effectiveModelName),
        );
      }
      return {
        type: 'message',
        messageType: 'info',
        content:
          (isDefaultModelCommand ? t('Default model') : t('Model')) +
          ': ' +
          effectiveModelName +
          (isDefaultModelCommand ? '' : ` (${t('session only')})`),
      };
    }

    if (isDefaultModelCommand) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Usage: /model --default <model-id>'),
      };
    }

    // Non-interactive/ACP: set model if an arg was provided, otherwise show current model
    if (context.executionMode !== 'interactive') {
      // /model with no args — show current model
      const currentModel = config.getModel() ?? 'unknown';
      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'Current model: {{model}}\nUse "/model <model-id>" to switch models (session only), "/model --default <model-id>" to persist, or "/model --fast <model-id>" to set the fast model.',
          { model: currentModel },
        ),
      };
    }

    return {
      type: 'dialog',
      dialog: 'model',
    };
  },
};
