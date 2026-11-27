/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { saveModelPreference } from '../../config/model-preferences.js';
import { t } from '../../i18n/index.js';
import { CommandKind, type SlashCommand } from './types.js';

export const contextWindowCommand: SlashCommand = {
  name: 'context-window',
  get description() {
    return t('Save the context window for the current model.');
  },
  argumentHint: '<tokens|default>',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: (context, actionArgs) => {
    const { config, settings } = context.services;
    const modelKey = config?.getModelPreferenceKey();
    if (
      !config ||
      !settings ||
      !modelKey ||
      context.executionPolicy?.persistModelSelection === false
    ) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Model preferences are not available in this session.'),
      };
    }

    const argument = context.invocation?.args?.trim() || actionArgs.trim();
    const contextWindow = argument === 'default' ? undefined : Number(argument);
    const limit = config.getModelPreferenceContextLimit();
    if (
      contextWindow !== undefined &&
      (!/^\d+$/.test(argument) ||
        !Number.isSafeInteger(contextWindow) ||
        contextWindow < 1 ||
        contextWindow > limit)
    ) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Use /context-window <tokens|default>. The window must be between 1 and {{limit}} tokens.',
          { limit: String(limit) },
        ),
      };
    }

    saveModelPreference(config, settings, modelKey, { contextWindow });
    const effective =
      config.getContentGeneratorConfig()?.contextWindowSize ?? limit;
    return {
      type: 'message',
      messageType: 'info',
      content: t('Context window for {{model}} is {{tokens}} tokens.', {
        model: config.getModel(),
        tokens: String(effective),
      }),
    };
  },
};
