/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getDisplayString,
  getErrorMessage,
  parseReasoningEffortLevel,
} from '@qwen-code/core';
import {
  getPreferredContextWindow,
  getPreferredReasoningEffort,
  setModelPreference,
} from '../../utils/modelPreference.js';
import type { ReasoningEffortLevel } from '@qwen-code/core';
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
  formatEffortInline,
  getModelEfforts,
} from '../utils/reasoningEffort.js';
import {
  applyModelOptionsFromPanel,
  createModelOptionsDialog,
  getCurrentModelOptionsModel,
  hasConfigurableModelOptions,
  isUnsupportedSettingsError,
  type CurrentModelOptionsModel,
  type ModelOptionsState,
} from './modelOptionsCommandUtils.js';

const VALID_EFFORT_TEXT =
  'ultracode, disabled, off, none, low, medium, high, xhigh, max';
const AUTO_EFFORT = 'auto';
const ULTRACODE_EFFORT = 'ultracode';

type EffortCommandSelection = ReasoningEffortLevel | undefined;
type ParsedEffortArg =
  | ReasoningEffortLevel
  | typeof AUTO_EFFORT
  | typeof ULTRACODE_EFFORT
  | undefined;

function addEffortCommandResult(
  context: CommandContext,
  text: string,
  severity: LocalCommandResultSeverity = 'info',
): void {
  context.ui.addItem(createLocalCommandResultItem(text, severity));
}

function validateEffort(
  model: CurrentModelOptionsModel,
  effort: ReasoningEffortLevel,
): string | null {
  const supported = getModelEfforts(model);
  if (supported.length === 0) {
    return `Current model "${model.display_name}" does not support reasoning effort.`;
  }
  if (!supported.includes(effort)) {
    return `Current model "${model.display_name}" does not support reasoning effort "${effort}". Supported efforts: ${supported.join(', ')}`;
  }
  return null;
}

function parseEffortArg(effortArg: string | undefined): ParsedEffortArg {
  if (!effortArg) return undefined;
  if (effortArg.toLowerCase() === AUTO_EFFORT) return AUTO_EFFORT;
  if (effortArg.toLowerCase() === ULTRACODE_EFFORT) {
    return ULTRACODE_EFFORT;
  }
  return parseReasoningEffortLevel(effortArg);
}

function formatEffortResult(reasoningEffort: EffortCommandSelection): string {
  return reasoningEffort === undefined
    ? 'default'
    : formatEffortInline(reasoningEffort);
}

export const effortCommand: SlashCommand = {
  name: 'effort',
  description: 'Set reasoning effort for the current model',
  kind: CommandKind.BUILT_IN,
  isSafeConcurrent: true,
  autoExecute: false,
  showCompletionLoading: false,
  argumentHint:
    '[ultracode|auto|low|medium|high|xhigh|max|off] [--session-only]',
  completion: async (context, partialArg) => {
    const currentModel = context.services.agentContext?.config.getModel();
    if (!currentModel) return [];
    const model = await getCurrentModelOptionsModel(context, currentModel);
    const prefix = (partialArg ?? '').toLowerCase();
    const ultracodeAvailable =
      model !== undefined &&
      getModelEfforts(model).includes('xhigh') &&
      context.services.agentContext?.config.isWorkflowToolAvailable();
    return [
      ...(ultracodeAvailable ? [ULTRACODE_EFFORT] : []),
      'auto',
      ...getModelEfforts(model ?? {}),
    ]
      .map((effort) => (effort === 'none' ? 'off' : effort))
      .filter((effort) => !prefix || effort.startsWith(prefix));
  },
  action: async (context: CommandContext, args: string) => {
    const gcConfig = context.services.agentContext?.config;
    if (!gcConfig) {
      addEffortCommandResult(
        context,
        'No active configuration. Cannot set reasoning effort.',
        'error',
      );
      return;
    }

    const currentModel = gcConfig.getModel()?.trim();
    if (!currentModel) {
      addEffortCommandResult(
        context,
        'No current model is configured. Cannot set reasoning effort.',
        'error',
      );
      return;
    }

    const parts = args.trim().split(/\s+/).filter(Boolean);
    const positionalParts = parts.filter((part) => !part.startsWith('--'));
    const effortArg = positionalParts[0];
    if (positionalParts.length > 1) {
      addEffortCommandResult(
        context,
        `Usage: /effort [auto, ${VALID_EFFORT_TEXT}] [--session-only]`,
        'error',
      );
      return;
    }

    const identity = gcConfig.getModelRequestIdentity();
    const sessionId = gcConfig.getSessionId();
    const stillCurrent = () =>
      gcConfig === context.services.agentContext?.config &&
      gcConfig.getModel()?.trim() === currentModel &&
      gcConfig.getModelRequestIdentity() === identity &&
      gcConfig.getSessionId() === sessionId;
    const model = await getCurrentModelOptionsModel(context, currentModel);
    if (!stillCurrent()) return;
    if (!model) {
      addEffortCommandResult(
        context,
        `Current model "${currentModel}" was not found. Use /model to choose an available model first.`,
        'error',
      );
      return;
    }

    if (model.enable === false) {
      addEffortCommandResult(
        context,
        `Current model "${model.display_name}" is not enabled.`,
        'error',
      );
      return;
    }

    const supportedEfforts = getModelEfforts(model);
    const modelId = model.key || currentModel;
    const parsedEffort = parseEffortArg(effortArg);

    const applyOptions = async (
      reasoningEffort: EffortCommandSelection,
      contextWindow: number | undefined,
    ) => {
      const session = context.services.sessionHandle;
      if (session) {
        const ultracodeRequested = gcConfig.getUltracode?.() === true;
        let sessionUltracodeDisabled = false;
        let sessionSettingsUnavailable = !session.applySettings;
        try {
          if (ultracodeRequested && session.applySettings) {
            try {
              await session.applySettings({ ultracode: false });
              sessionUltracodeDisabled = true;
            } catch (error) {
              if (!isUnsupportedSettingsError(error)) throw error;
              sessionSettingsUnavailable = true;
            }
          }
          await session.setModel(modelId, reasoningEffort, contextWindow);
          // Ordinary /effort selections explicitly leave UltraCode. Keep this
          // command-level behavior out of Config.setReasoningEffort(): control
          // requests that only update effort do not implicitly change it.
          gcConfig.setUltracode?.(false);
          addEffortCommandResult(
            context,
            ultracodeRequested && sessionSettingsUnavailable
              ? `Warning: reasoning effort set to ${formatEffortResult(reasoningEffort)} for ${model.display_name}, but this session does not support changing UltraCode.`
              : `Changes apply to this session only; reasoning effort set to ${formatEffortResult(reasoningEffort)} for ${model.display_name} (this session only)`,
          );
        } catch (err) {
          if (sessionUltracodeDisabled) {
            gcConfig.setUltracode?.(false);
          }
          addEffortCommandResult(
            context,
            sessionUltracodeDisabled
              ? `UltraCode was disabled, but the reasoning effort change was rejected: ${getErrorMessage(err)}`
              : `Reasoning effort change rejected: ${getErrorMessage(err)}`,
            'error',
          );
        }
        return;
      }

      const sessionOnly = parts.includes('--session-only');
      const persist = !sessionOnly;
      if (!stillCurrent()) return;
      try {
        await setModelPreference(
          gcConfig,
          { reasoning: { effort: reasoningEffort } },
          { persist },
        );
      } catch (err) {
        if (stillCurrent()) {
          addEffortCommandResult(
            context,
            `Reasoning effort change rejected: ${getErrorMessage(err)}`,
            'error',
          );
        }
        return;
      }
      if (!stillCurrent()) return;
      gcConfig.setUltracode?.(false);
      addEffortCommandResult(
        context,
        `Reasoning effort set to ${formatEffortResult(reasoningEffort)} for ${getDisplayString(undefined, model.display_name || modelId)} (${persist ? 'persisted' : 'this session only'})`,
      );
    };

    const applyEffort = (reasoningEffort: EffortCommandSelection) =>
      applyOptions(
        reasoningEffort,
        getPreferredContextWindow(gcConfig, model.preferenceModel),
      );

    if (effortArg) {
      if (parsedEffort === undefined) {
        addEffortCommandResult(
          context,
          `Invalid reasoning effort "${effortArg}". Valid efforts: auto, ${VALID_EFFORT_TEXT}.`,
          'error',
        );
        return;
      }
      if (parsedEffort === AUTO_EFFORT) {
        await applyEffort(undefined);
        return;
      }
      if (parsedEffort === ULTRACODE_EFFORT) {
        const effortError = validateEffort(model, 'xhigh');
        if (effortError) {
          addEffortCommandResult(context, effortError, 'error');
          return;
        }
        if (!gcConfig.isWorkflowToolAvailable()) {
          addEffortCommandResult(
            context,
            'UltraCode is unavailable because the Workflow tool is not enabled for this session.',
            'error',
          );
          return;
        }

        const session = context.services.sessionHandle;
        if (session) {
          if (session.applySettings) {
            try {
              await session.applySettings({
                ultracode: true,
              });
            } catch (error) {
              if (isUnsupportedSettingsError(error)) {
                await session.setModel(modelId, 'xhigh', undefined);
                gcConfig.setUltracode(true);
                addEffortCommandResult(
                  context,
                  'Warning: UltraCode enabled locally for this session; this session does not support changing UltraCode.',
                );
                return;
              }
              addEffortCommandResult(
                context,
                `UltraCode change rejected: ${getErrorMessage(error)}`,
                'error',
              );
              return;
            }
            gcConfig.setUltracode(true);
            addEffortCommandResult(
              context,
              `UltraCode enabled for ${model.display_name} (xhigh + dynamic workflow orchestration; this session only)`,
            );
            return;
          }

          await session.setModel(modelId, 'xhigh', undefined);
          gcConfig.setUltracode(true);
          addEffortCommandResult(
            context,
            'Warning: UltraCode enabled locally for this session; this session does not support changing UltraCode.',
          );
          return;
        }

        if (!stillCurrent()) return;
        await setModelPreference(gcConfig, {
          reasoning: { effort: 'xhigh' },
        });
        if (!stillCurrent()) return;
        gcConfig.setUltracode(true);
        addEffortCommandResult(
          context,
          `UltraCode enabled for ${getDisplayString(undefined, model.display_name || modelId)} (xhigh + dynamic workflow orchestration; this session only)`,
        );
        return;
      }
      if (supportedEfforts.length === 0) {
        addEffortCommandResult(
          context,
          `Current model "${model.display_name}" does not support reasoning effort.`,
          'error',
        );
        return;
      }
      const effortError = validateEffort(model, parsedEffort);
      if (effortError) {
        addEffortCommandResult(context, effortError, 'error');
        return;
      }
      await applyEffort(parsedEffort);
      return;
    }

    if (!hasConfigurableModelOptions(model)) {
      addEffortCommandResult(
        context,
        `Current model "${model.display_name}" does not have configurable model options.`,
        'error',
      );
      return;
    }

    if (
      gcConfig.getUltracode() &&
      getPreferredReasoningEffort(gcConfig, model.preferenceModel) ===
        'xhigh' &&
      supportedEfforts.includes('xhigh') &&
      gcConfig.isWorkflowToolAvailable()
    ) {
      addEffortCommandResult(
        context,
        `Current effort: UltraCode for ${model.display_name} (xhigh + dynamic workflow orchestration; this session only)`,
      );
    }

    const previous: ModelOptionsState = {
      ultracode: gcConfig.getUltracode?.(),
      reasoningEffort: getPreferredReasoningEffort(
        gcConfig,
        model.preferenceModel,
      ),
      contextWindow: getPreferredContextWindow(gcConfig, model.preferenceModel),
    };
    const sessionOnly = parts.includes('--session-only');

    return createModelOptionsDialog(
      context,
      model,
      'effort',
      previous.reasoningEffort,
      previous.contextWindow,
      (reasoningEffort, contextWindow, ultracode) =>
        applyModelOptionsFromPanel(context, {
          model,
          modelId,
          sessionOnly,
          exitUltracodeOnApply: true,
          previous,
          next: {
            reasoningEffort,
            contextWindow,
            ultracode,
          },
        }),
    );
  },
};
