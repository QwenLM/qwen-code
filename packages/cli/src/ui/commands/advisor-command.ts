/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { SettingScope } from '../../config/settings.js';
import {
  checkAdvisorModelAvailability,
  isAdvisorModelEligible,
} from '../../config/advisor-model.js';

function unavailableModelMessage(
  modelName: string,
  availableModelIds: string[],
): string {
  const configured =
    availableModelIds.length > 0
      ? `Configured models: ${availableModelIds.join(', ')}.`
      : 'No models are configured.';
  return [
    `Advisor model '${modelName}' is not configured.`,
    configured,
    'Configure models in settings.modelProviders, or run /advisor without arguments to choose a model.',
  ].join('\n');
}

async function setAdvisorModel(
  context: CommandContext,
  model: string | undefined,
): Promise<SlashCommandActionReturn> {
  if (context.executionPolicy?.persistModelSelection === false) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('This model selection is not available in this session.'),
    };
  }

  const { config, settings } = context.services;
  if (!config || !settings) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Advisor configuration is unavailable.'),
    };
  }

  if (model) {
    const availability = checkAdvisorModelAvailability(config, model);
    if (!availability.available) {
      return {
        type: 'message',
        messageType: 'error',
        content: unavailableModelMessage(model, availability.availableModelIds),
      };
    }
  }

  settings.setValue(SettingScope.User, 'advisorModel', model ?? '');
  await config.setAdvisorModel(model);
  return {
    type: 'message',
    messageType: 'info',
    content: model
      ? t('Advisor set to {{model}}', { model })
      : t('Advisor disabled'),
  };
}

export const advisorCommand: SlashCommand = {
  name: 'advisor',
  get description() {
    return t('Configure the Advisor model');
  },
  argumentHint: '[<model-id>|off]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'acp'] as const,
  completion: async (context, partialArg) => {
    const prefix = partialArg.trim();
    const off =
      prefix === '' || 'off'.startsWith(prefix)
        ? [{ value: 'off', description: t('Disable Advisor') }]
        : [];
    if (!context.services.config) return off;
    return [
      ...off,
      ...context.services.config
        .getAllConfiguredModels()
        .filter((model) => isAdvisorModelEligible(model))
        .map((model) => model.id)
        .filter((id) => id.startsWith(prefix)),
    ];
  },
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    const value = context.invocation?.args?.trim() || args.trim();
    if (!value) {
      if (context.executionMode !== 'interactive') {
        return {
          type: 'message',
          messageType: 'info',
          content: 'Use /advisor <model-id> or /advisor off.',
        };
      }
      return { type: 'dialog', dialog: 'advisor-model' };
    }

    return setAdvisorModel(
      context,
      value.toLowerCase() === 'off' ? undefined : value,
    );
  },
};
