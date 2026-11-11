/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  CommandKind,
  type SlashCommand,
} from './types.js';
import {
  createLocalCommandResultItem,
  type LocalCommandResultSeverity,
} from '../utils/localCommandResult.js';
import {
  applyModelOptionsFromPanel,
  createModelOptionsDialog,
  getCurrentModelOptionsModel,
  hasConfigurableModelOptions,
  type ModelOptionsState,
} from './modelOptionsCommandUtils.js';
import {
  getPreferredContextWindow,
  getPreferredReasoningEffort,
} from '../../utils/modelPreference.js';

function addContextWindowCommandResult(
  context: CommandContext,
  text: string,
  severity: LocalCommandResultSeverity = 'info',
): void {
  context.ui.addItem(createLocalCommandResultItem(text, severity));
}

export const contextWindowCommand: SlashCommand = {
  name: 'context-window',
  description: 'Set context window for the current model',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  showCompletionLoading: false,
  argumentHint: '[--session-only]',
  action: async (context: CommandContext, args: string) => {
    const gcConfig = context.services.agentContext?.config;
    if (!gcConfig) {
      addContextWindowCommandResult(
        context,
        'No active configuration. Cannot set context window.',
        'error',
      );
      return;
    }

    const parts = args.trim().split(/\s+/).filter(Boolean);
    const unsupportedParts = parts.filter((part) => part !== '--session-only');
    if (unsupportedParts.length > 0) {
      addContextWindowCommandResult(
        context,
        'Usage: /context-window [--session-only]',
        'error',
      );
      return;
    }

    const currentModel = gcConfig.getModel()?.trim();
    if (!currentModel) {
      addContextWindowCommandResult(
        context,
        'No current model is configured. Cannot set context window.',
        'error',
      );
      return;
    }

    const model = await getCurrentModelOptionsModel(context, currentModel);
    if (!model) {
      addContextWindowCommandResult(
        context,
        `Current model "${currentModel}" was not found. Use /model to choose an available model first.`,
        'error',
      );
      return;
    }

    if (model.enable === false) {
      addContextWindowCommandResult(
        context,
        `Current model "${model.display_name}" is not enabled.`,
        'error',
      );
      return;
    }

    if (!hasConfigurableModelOptions(model)) {
      addContextWindowCommandResult(
        context,
        `Current model "${model.display_name}" does not have configurable model options.`,
        'error',
      );
      return;
    }

    const modelId = model.key || currentModel;
    const sessionOnly = parts.includes('--session-only');
    const previous: ModelOptionsState = {
      ultracode: gcConfig.getUltracode?.(),
      reasoningEffort: getPreferredReasoningEffort(
        gcConfig,
        model.preferenceModel,
      ),
      contextWindow: getPreferredContextWindow(gcConfig, model.preferenceModel),
    };

    return createModelOptionsDialog(
      context,
      model,
      'context-window',
      previous.reasoningEffort,
      previous.contextWindow,
      (reasoningEffort, contextWindow, ultracode) =>
        applyModelOptionsFromPanel(context, {
          model,
          modelId,
          sessionOnly,
          previous,
          next: {
            ultracode,
            reasoningEffort,
            contextWindow,
          },
        }),
    );
  },
};
