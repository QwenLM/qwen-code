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
import { getAvailableModelsForAuthType } from '../models/availableModels.js';
import { ModelsService } from '../../services/ModelsService.js';
import { AuthType } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

export const modelCommand: SlashCommand = {
  name: 'model',
  get description() {
    return t('Switch the model for this session');
  },
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
  ): Promise<OpenDialogActionReturn | MessageActionReturn> => {
    const { services } = context;
    const { config } = services;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Configuration not available.',
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

    // For OpenAI-compatible auth, fetch models from the API endpoint
    if (authType === AuthType.USE_OPENAI) {
      if (!contentGeneratorConfig.baseUrl || !contentGeneratorConfig.apiKey) {
        return {
          type: 'message',
          messageType: 'error',
          content: t(
            'OpenAI-compatible API configuration incomplete. Please set OPENAI_BASE_URL and OPENAI_API_KEY.',
          ),
        };
      }

      try {
        const modelsService = new ModelsService();
        const dynamicModels = await modelsService.fetchAvailableModels(
          contentGeneratorConfig.baseUrl,
          contentGeneratorConfig.apiKey,
        );

        if (dynamicModels.length === 0) {
          return {
            type: 'message',
            messageType: 'error',
            content: t(
              'No models available from the API endpoint: {{baseUrl}}/v1/models',
              {
                baseUrl: contentGeneratorConfig.baseUrl,
              },
            ),
          };
        }

        // Trigger model selection dialog with dynamically fetched models
        return {
          type: 'dialog',
          dialog: 'model',
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          type: 'message',
          messageType: 'error',
          content: t(
            'Failed to fetch models from API: {{error}}. Ensure OPENAI_BASE_URL is correct and the API is accessible.',
            {
              error: errorMessage,
            },
          ),
        };
      }
    }

    // For Qwen OAuth and other auth types, use static model lists
    const availableModels = getAvailableModelsForAuthType(authType);

    if (availableModels.length === 0) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'No models available for the current authentication type ({{authType}}).',
          {
            authType,
          },
        ),
      };
    }

    // Trigger model selection dialog
    return {
      type: 'dialog',
      dialog: 'model',
    };
  },
};
