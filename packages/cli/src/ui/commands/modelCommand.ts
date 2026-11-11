/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  getDisplayString,
  parseReasoningEffortLevel,
  isCustomProviderModel,
  runLogger,
} from '@qwen-code/core';
import type {
  Config,
  Model,
  ModelConfig,
  ReasoningEffortLevel,
} from '@qwen-code/core';
import {
  getPreferredContextWindow,
  getPreferredReasoningEffort,
  setModelPreference,
} from '../../utils/modelPreference.js';
import {
  type CommandContext,
  CommandKind,
  type SlashCommand,
} from './types.js';
import {
  type EffortCapableModel,
  ModelSelector,
} from '../components/ModelSelector.js';
import {
  createLocalCommandResultItem,
  type LocalCommandResultSeverity,
} from '../utils/localCommandResult.js';
import {
  formatEffortCommandSuffix,
  getModelEfforts,
} from '../utils/reasoningEffort.js';
import { formatContextWindowCommandSuffix } from '../utils/contextWindow.js';

const modelChangeRevisions = new WeakMap<Config, number>();

async function setModelAndLog(
  context: CommandContext,
  config: Config,
  modelId: string,
  persist: boolean,
  reasoningEffort?: ReasoningEffortLevel,
  contextWindow?: number,
): Promise<boolean> {
  const revision = (modelChangeRevisions.get(config) ?? 0) + 1;
  modelChangeRevisions.set(config, revision);
  const identity = config.getModelRequestIdentity();
  const sessionId = config.getSessionId();
  const assertCurrent = () => {
    if (
      context.services.agentContext?.config !== config ||
      modelChangeRevisions.get(config) !== revision ||
      config.getModel() !== modelId ||
      config.getModelRequestIdentity() !== identity ||
      config.getSessionId() !== sessionId
    )
      throw new Error('会话目标已变化，模型更新已取消。');
  };
  const saved = await config.setModel(modelId, !persist);
  assertCurrent();
  // setModel restores the target model's per-model preferences. Only override
  // them when the caller explicitly supplied a value (e.g. `/model X high` or a
  // dialog with effort controls); passing undefined must NOT wipe the restored
  // effort/context-window.
  const patch: ModelConfig = {
    ...(reasoningEffort !== undefined
      ? { reasoning: { effort: reasoningEffort } }
      : {}),
    ...(contextWindow !== undefined ? { context: { contextWindow } } : {}),
  };
  if (patch.reasoning || patch.context) {
    await setModelPreference(config, patch, { model: modelId, persist });
    assertCurrent();
  }
  return saved;
}

function addModelCommandResult(
  context: CommandContext,
  text: string,
  severity: LocalCommandResultSeverity = 'info',
): void {
  context.ui.addItem(createLocalCommandResultItem(text, severity));
}

function parseEffortArg(
  effortArg: string | undefined,
): ReasoningEffortLevel | undefined {
  return effortArg ? parseReasoningEffortLevel(effortArg) : undefined;
}

function validateModelEffort(
  entry: Pick<
    EffortCapableModel,
    'efforts' | 'display_name' | 'supports_disabled' | 'supportsDisabled'
  >,
  effort: ReasoningEffortLevel | undefined,
): string | null {
  if (effort === undefined) return null;
  const supported = getModelEfforts(entry);
  if (supported.length === 0) {
    return `Model "${entry.display_name}" does not support reasoning effort.`;
  }
  if (!supported.includes(effort)) {
    return `Model "${entry.display_name}" does not support reasoning effort "${effort}". Supported efforts: ${supported.join(', ')}`;
  }
  return null;
}

type LocalModel = EffortCapableModel & { display_name: string };

async function getLocalModels(config: Config): Promise<LocalModel[]> {
  return (await config.getModelProviderManager().listModels())
    .filter(isCustomProviderModel)
    .map((model) => ({
      key: model.key,
      display_name: model.displayName,
      efforts: model.capabilities.reasoning.supportedEfforts.filter(
        (effort) => effort !== 'none',
      ),
      supportsDisabled:
        model.capabilities.reasoning.supportedEfforts.includes('none'),
    }));
}

/** Completion covers every selectable model, including account providers. */
async function getCompletionModels(
  config: Config,
): Promise<Array<Pick<LocalModel, 'key' | 'display_name'>>> {
  return (await config.getModelProviderManager().listModels()).map((model) => ({
    key: model.key,
    display_name: model.displayName,
  }));
}

function findLocalModel(
  models: readonly LocalModel[],
  modelName: string,
): LocalModel | undefined {
  const normalizedName = modelName.toLowerCase();
  return models.find(
    (model) =>
      model.key.toLowerCase() === normalizedName ||
      model.display_name.toLowerCase() === normalizedName,
  );
}

function formatModelSelectionSuffix(
  reasoningEffort?: ReasoningEffortLevel,
  contextWindow?: number,
): string {
  return `${formatEffortCommandSuffix(reasoningEffort)}${formatContextWindowCommandSuffix(contextWindow)}`;
}

export const modelCommand: SlashCommand = {
  name: 'model',
  description: 'Set or manage model configuration',
  kind: CommandKind.BUILT_IN,
  isSafeConcurrent: true,
  autoExecute: false,
  showCompletionLoading: false,
  completion: async (context, partialArg) => {
    const config = context.services.agentContext?.config;
    if (!config) return [];
    const prefix = (partialArg ?? '').toLowerCase();
    const identity = config.getModelRequestIdentity();
    const sessionId = config.getSessionId();
    const models = await getCompletionModels(config);
    if (
      context.services.agentContext?.config !== config ||
      identity !== config.getModelRequestIdentity() ||
      sessionId !== config.getSessionId()
    )
      return [];
    const labelCounts = new Map<string, number>();
    for (const model of models) {
      const label = model.display_name || model.key;
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
    return models
      .filter(
        (model) =>
          !prefix ||
          model.key.toLowerCase().startsWith(prefix) ||
          model.display_name.toLowerCase().startsWith(prefix),
      )
      .map((model) => {
        const label = model.display_name || model.key;
        return {
          label,
          value: model.key,
          ...((labelCounts.get(label) ?? 0) > 1
            ? { description: model.key }
            : {}),
        };
      });
  },
  action: async (context: CommandContext, args: string) => {
    const gcConfig = context.services.agentContext?.config;
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const positionalParts = parts.filter((part) => !part.startsWith('--'));

    if (positionalParts.length > 0) {
      const suppliedName = positionalParts.join(' ');
      // Default to persisting the selection so the choice survives restarts.
      // `--session-only` opts out (apply for this process only).
      // `--persist` is kept as a no-op flag for backward compatibility.
      const sessionOnly = parts.includes('--session-only');
      const persist = !sessionOnly;

      if (!gcConfig) {
        addModelCommandResult(
          context,
          'No active configuration. Cannot set model.',
          'error',
        );
        return;
      }

      const identity = gcConfig.getModelRequestIdentity();
      const sessionId = gcConfig.getSessionId();
      const previousModel = gcConfig.getModel();
      const revision = (modelChangeRevisions.get(gcConfig) ?? 0) + 1;
      modelChangeRevisions.set(gcConfig, revision);
      const models = await getLocalModels(gcConfig);
      if (
        context.services.agentContext?.config !== gcConfig ||
        identity !== gcConfig.getModelRequestIdentity() ||
        sessionId !== gcConfig.getSessionId() ||
        previousModel !== gcConfig.getModel() ||
        revision !== modelChangeRevisions.get(gcConfig)
      )
        return;

      // Prefer the complete positional input so display names with spaces work.
      // If its final word is a valid effort, interpret that word as the optional
      // effort argument and resolve the preceding words as the model identity.
      let entry = findLocalModel(models, suppliedName);
      let parsedEffort: ReasoningEffortLevel | undefined;
      if (!entry && positionalParts.length > 1) {
        const effortArg = positionalParts.at(-1);
        const candidateEffort = parseEffortArg(effortArg);
        if (candidateEffort !== undefined) {
          entry = findLocalModel(
            models,
            positionalParts.slice(0, -1).join(' '),
          );
          parsedEffort = entry ? candidateEffort : undefined;
        }
      }

      let providerModel: Model | undefined;
      if (!entry) {
        const findProviderModel = async (
          name: string,
        ): Promise<Model | undefined> => {
          const normalized = name.toLowerCase();
          return (
            await gcConfig.getModelProviderManager().listModels()
          ).find(
            (model) =>
              model.key.toLowerCase() === normalized ||
              model.displayName.toLowerCase() === normalized,
          );
        };
        providerModel = await findProviderModel(suppliedName);
        if (!providerModel && positionalParts.length > 1) {
          const effortArg = positionalParts.at(-1);
          const candidateEffort = parseEffortArg(effortArg);
          if (candidateEffort !== undefined) {
            providerModel = await findProviderModel(
              positionalParts.slice(0, -1).join(' '),
            );
            parsedEffort = providerModel ? candidateEffort : undefined;
          }
        }
      }
      if (!entry && !providerModel) {
        addModelCommandResult(
          context,
          `Model "${suppliedName}" not found. Use /model to see available models.`,
          'error',
        );
        return;
      }
      const effortEntry =
        entry ?? {
          display_name: providerModel!.displayName,
          efforts: providerModel!.capabilities.reasoning.supportedEfforts,
        };
      const effortError = validateModelEffort(effortEntry, parsedEffort);
      if (effortError) {
        addModelCommandResult(context, effortError, 'error');
        return;
      }

      const canonicalKey = entry?.key ?? providerModel!.key;
      const displayName = entry?.display_name ?? providerModel!.displayName;
      const persistTag = persist ? 'persisted' : 'this session only';
      const addSuccessResult = (
        reasoningEffort?: ReasoningEffortLevel,
        contextWindow?: number,
      ) => {
        addModelCommandResult(
          context,
          `Model set to ${displayName}${formatModelSelectionSuffix(reasoningEffort, contextWindow)} (${persistTag})`,
        );
      };
      const applyLocalModel = async (
        reasoningEffort?: ReasoningEffortLevel,
        contextWindow?: number,
      ) => {
        const saved = await setModelAndLog(
          context,
          gcConfig,
          canonicalKey,
          persist,
          reasoningEffort,
          contextWindow,
        );
        if (!saved) {
          addModelCommandResult(
            context,
            `Model set to ${displayName} for this session only. Failed to save the preferred model; retry to persist it.`,
            'error',
          );
          return;
        }
        addSuccessResult(reasoningEffort, contextWindow);
      };
      // Naming a model switches to it directly using default settings. Use
      // /effort or /context-window afterwards to adjust options.
      await applyLocalModel(parsedEffort, undefined);
      return;
    }

    // No args: open the model selector dialog.
    const currentModel = gcConfig?.getModel();

    if (!gcConfig) {
      addModelCommandResult(
        context,
        'No active configuration. Cannot manage local models.',
        'error',
      );
      return;
    }

    const identity = gcConfig.getModelRequestIdentity();
    const sessionId = gcConfig.getSessionId();
    const revision = (modelChangeRevisions.get(gcConfig) ?? 0) + 1;
    modelChangeRevisions.set(gcConfig, revision);
    let dialogClosed = false;
    const isCurrent = () =>
      !dialogClosed &&
      context.services.agentContext?.config === gcConfig &&
      identity === gcConfig.getModelRequestIdentity() &&
      sessionId === gcConfig.getSessionId() &&
      currentModel === gcConfig.getModel() &&
      revision === modelChangeRevisions.get(gcConfig);
    const listedModels = await gcConfig.getModelProviderManager().listModels();
    if (!isCurrent()) return;
    const currentEntry = listedModels.find(
      (model) => model.key === currentModel,
    );
    return {
      type: 'custom_dialog',
      component: React.createElement(ModelSelector, {
        config: gcConfig,
        listedModels,
        currentModel,
        currentReasoningEffort: getPreferredReasoningEffort(
          gcConfig,
          currentEntry,
        ),
        currentContextWindow: getPreferredContextWindow(gcConfig, currentEntry),
        // Lets each row open on what the user last chose for that model
        // rather than the model's default. The picker never sees Config or
        // the raw preference shape.
        readModelPreference: (modelId: string) => {
          const listed = listedModels.find((model) => model.key === modelId);
          try {
            return {
              effort: getPreferredReasoningEffort(gcConfig, listed),
              contextWindow: getPreferredContextWindow(gcConfig, listed),
            };
          } catch (error) {
            // Deleting a provider can leave its row visible until the list refreshes.
            runLogger.debug('[ui] Model preference unavailable', error);
            return {};
          }
        },
        onSelect: async (
          modelId: string,
          reasoningEffort?: ReasoningEffortLevel,
          contextWindow?: number,
          options?: {
            persist?: boolean;
            otherModelPreferences?: Record<
              string,
              { effort?: ReasoningEffortLevel; contextWindow?: number }
            >;
          },
        ) => {
          if (!isCurrent()) return;
          if (!gcConfig) {
            addModelCommandResult(
              context,
              'No active configuration. Cannot set model.',
              'error',
            );
            return;
          }
          // Enter persists the choice so it survives restarts; `s` applies it
          // to this session only.
          const persist = options?.persist ?? true;
          const selectionRevision = revision + 1;
          modelChangeRevisions.set(gcConfig, selectionRevision);
          // Other rows the user tuned in the picker, written before the switch.
          try {
            const alsoUpdated: string[] = [];
            for (const [otherModelId, patch] of Object.entries(
              options?.otherModelPreferences ?? {},
            )) {
              if (
                context.services.agentContext?.config !== gcConfig ||
                gcConfig.getModel() !== currentModel ||
                gcConfig.getModelRequestIdentity() !== identity ||
                gcConfig.getSessionId() !== sessionId ||
                selectionRevision !== modelChangeRevisions.get(gcConfig)
              )
                return;
              const otherPatch: ModelConfig = {
                ...(patch.effort !== undefined
                  ? { reasoning: { effort: patch.effort } }
                  : {}),
                ...(patch.contextWindow !== undefined
                  ? { context: { contextWindow: patch.contextWindow } }
                  : {}),
              };
              const applied =
                (otherPatch.reasoning !== undefined ||
                  otherPatch.context !== undefined) &&
                (await setModelPreference(gcConfig, otherPatch, {
                  model:
                    listedModels.find((model) => model.key === otherModelId) ??
                    otherModelId,
                  persist,
                }));
              if (
                context.services.agentContext?.config !== gcConfig ||
                gcConfig.getModel() !== currentModel ||
                gcConfig.getModelRequestIdentity() !== identity ||
                gcConfig.getSessionId() !== sessionId ||
                selectionRevision !== modelChangeRevisions.get(gcConfig)
              )
                return;
              if (applied) {
                alsoUpdated.push(
                  `${getDisplayString(
                    listedModels.find((model) => model.key === otherModelId),
                    otherModelId,
                  )}${formatModelSelectionSuffix(patch.effort, patch.contextWindow)}`,
                );
              }
            }
            const saved = await setModelAndLog(
              context,
              gcConfig,
              modelId,
              persist,
              reasoningEffort,
              contextWindow,
            );
            if (!saved) {
              addModelCommandResult(
                context,
                `Model set to ${getDisplayString(
                  listedModels.find((model) => model.key === modelId),
                  modelId,
                )} for this session only. Failed to save the preferred model; retry to persist it.`,
                'error',
              );
              return;
            }
            addModelCommandResult(
              context,
              // The scope tag goes last so it covers every model the line names.
              `Model set to ${getDisplayString(
                listedModels.find((model) => model.key === modelId),
                modelId,
              )}${formatModelSelectionSuffix(reasoningEffort, contextWindow)}${alsoUpdated.length > 0 ? ` · Also updated: ${alsoUpdated.join(', ')}` : ''} (${persist ? 'persisted' : 'this session only'})`,
            );
          } catch (error) {
            addModelCommandResult(
              context,
              `Model change rejected: ${error instanceof Error ? error.message : String(error)}`,
              'error',
            );
          }
        },
        onClose: () => {
          dialogClosed = true;
          context.ui.removeComponent();
        },
      }),
    };
  },
};
