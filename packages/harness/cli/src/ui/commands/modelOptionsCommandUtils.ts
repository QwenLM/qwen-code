/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  QODER_PROVIDER_ID,
  getErrorMessage,
  isCustomProviderModel,
  parseContextWindowConfig,
  parseReasoningEffortLevel,
  runLogger,
  tokenLimit,
  type Model,
  type ReasoningEffortLevel,
} from '@qwen-code/core';
import { createLocalCommandResultItem } from '../utils/localCommandResult.js';
import { setModelPreference } from '../../utils/modelPreference.js';
import {
  type EffortCapableModel,
  ModelOptionsSelector,
} from '../components/ModelSelector.js';
import type { SessionModelInfo } from '../../session/sessionModels.js';
import {
  formatContextWindowValueLabel,
  getModelContextWindows,
  type ContextWindowCapableModel,
} from '../utils/contextWindow.js';
import {
  formatEffortInline,
  getModelEfforts,
} from '../utils/reasoningEffort.js';
import {
  type CommandContext,
  type OpenCustomDialogActionReturn,
} from './types.js';

export type ModelOptionsFocusKey = 'context-window' | 'effort';

export type CurrentModelOptionsModel = EffortCapableModel & {
  enable?: boolean;
  preferenceModel?: Model;
} & ContextWindowCapableModel;

function findSessionModel(
  models: readonly SessionModelInfo[] | undefined,
  modelName: string,
): SessionModelInfo | undefined {
  if (!models) return undefined;
  const normalizedName = modelName.toLowerCase();
  return models.find(
    (model) =>
      model.modelId === modelName ||
      model.value === modelName ||
      model.displayName === modelName ||
      model.modelId.toLowerCase() === normalizedName ||
      model.value?.toLowerCase() === normalizedName ||
      model.displayName.toLowerCase() === normalizedName,
  );
}

export function sessionModelToOptionsModel(
  model: SessionModelInfo,
): CurrentModelOptionsModel {
  const parsedContextConfig = parseContextWindowConfig(model.context_config);
  const contextWindows =
    parsedContextConfig?.windows ?? model.availableContextWindows ?? [];
  const defaultContextWindow =
    parsedContextConfig?.defaultWindow ?? model.defaultContextWindow;
  const supportedEfforts = (model.efforts ?? []).flatMap((value) => {
    const effort = parseReasoningEffortLevel(value);
    return effort ? [effort] : [];
  });
  if (model.supportsDisabled && !supportedEfforts.includes('none')) {
    supportedEfforts.push('none');
  }
  const defaultEffort = parseReasoningEffortLevel(model.defaultEffort);
  // 远端目录是 worker 模型能力的权威来源；仅用于 controller 偏好投影，
  // 不从本地目录借用同名模型，也不用于本地选模或推理。
  const preferenceModel: Model = {
    source:
      model.source === 'custom'
        ? (model.provider ?? model.modelId.split('/')[0]!)
        : QODER_PROVIDER_ID,
    key: model.modelId,
    displayName: model.displayName,
    enabled: model.isEnabled,
    isDefault: model.isDefault,
    capabilities: {
      tools: true,
      vision: model.isVl === true,
      reasoning: {
        supported:
          model.isReasoning === true ||
          supportedEfforts.some((effort) => effort !== 'none'),
        supportedEfforts,
      },
      contextWindows: contextWindows.map((tokens) => ({ tokens })),
    },
    limits: {
      maxContextTokens:
        model.maxInputTokens ?? contextWindows.at(-1) ?? tokenLimit(undefined),
      maxOutputTokens: model.maxOutputTokens,
    },
    defaultModelConfig: {
      reasoning: { effort: defaultEffort },
      context: { contextWindow: defaultContextWindow },
    },
  };
  return {
    preferenceModel,
    key: model.modelId,
    display_name: model.displayName,
    enable: model.isEnabled,
    efforts: model.efforts,
    defaultEffort: model.defaultEffort,
    supportsDisabled: model.supportsDisabled,
    availableContextWindows:
      parsedContextConfig?.windows ?? model.availableContextWindows,
    defaultContextWindow:
      parsedContextConfig?.defaultWindow ?? model.defaultContextWindow,
    maxInputTokens: model.maxInputTokens,
  };
}

export async function getCurrentModelOptionsModel(
  context: CommandContext,
  currentModel: string,
): Promise<CurrentModelOptionsModel | undefined> {
  const session = context.services.sessionHandle;
  if (session !== undefined) {
    const sessionModel = findSessionModel(
      session.getState().models,
      currentModel,
    );
    if (sessionModel) return sessionModelToOptionsModel(sessionModel);
  }

  const config = context.services.agentContext?.config;
  if (!config) return undefined;
  const identity = config.getModelRequestIdentity();
  const sessionId = config.getSessionId();
  const listed = await config
    .getModelProviderManager()
    .getModel(currentModel)
    .catch((error: unknown) => {
      runLogger.debug('[model-options] 模型查询失败:', error);
      return undefined;
    });
  if (
    config !== context.services.agentContext?.config ||
    currentModel !== config.getModel() ||
    identity !== config.getModelRequestIdentity() ||
    sessionId !== config.getSessionId()
  )
    return undefined;
  return listed ? listedModelToOptionsModel(listed) : undefined;
}

function listedModelToOptionsModel(model: Model): CurrentModelOptionsModel {
  const efforts = model.capabilities.reasoning.supportedEfforts;
  const windows = model.capabilities.contextWindows.map(
    (window) => window.tokens,
  );
  return {
    key: model.key,
    preferenceModel: model,
    display_name: model.displayName,
    ...(isCustomProviderModel(model) ? { source: 'custom' } : {}),
    enable: model.enabled !== false,
    efforts: efforts.filter((effort) => effort !== 'none'),
    supportsDisabled: efforts.includes('none'),
    defaultEffort: model.defaultModelConfig?.reasoning?.effort,
    ...(windows.length > 0 ? { availableContextWindows: windows } : {}),
    defaultContextWindow: model.defaultModelConfig?.context?.contextWindow,
    maxInputTokens: model.limits.maxContextTokens,
  };
}

export function hasConfigurableModelOptions(
  model: CurrentModelOptionsModel,
): boolean {
  return (
    getModelEfforts(model).length > 0 ||
    getModelContextWindows(model).length > 1
  );
}

export interface ModelOptionsState {
  /** Undefined preserves the current request when the option is unavailable. */
  ultracode?: boolean;
  reasoningEffort: ReasoningEffortLevel | undefined;
  contextWindow: number | undefined;
}

function formatEffortValue(effort: ReasoningEffortLevel | undefined): string {
  return effort === undefined ? 'default' : formatEffortInline(effort);
}

function formatContextWindowValue(contextWindow: number | undefined): string {
  return contextWindow === undefined
    ? 'default'
    : formatContextWindowValueLabel(contextWindow);
}

/**
 * Describes which model options actually changed between two states. The model
 * options panel applies effort and context window together, so a result
 * message based on the invoking command alone (e.g. always "Reasoning effort
 * set to ...") is wrong when the user adjusts a different setting. This
 * compares previous vs. next and reports only what moved.
 */
export function summarizeModelOptionChanges(
  model: CurrentModelOptionsModel,
  previous: ModelOptionsState,
  next: ModelOptionsState,
): string[] {
  const changes: string[] = [];
  const entersUltracode =
    next.ultracode === true && previous.ultracode !== true;
  if (entersUltracode) {
    changes.push('thinking effort to Ultracode');
  }

  // Only report dimensions the model can actually adjust — a model without an
  // effort row never really "changes" effort even if the stored value differs
  // from the panel's undefined default.
  if (
    !entersUltracode &&
    getModelEfforts(model).length > 0 &&
    (previous.reasoningEffort !== next.reasoningEffort ||
      (previous.ultracode === true && next.ultracode === false))
  ) {
    changes.push(
      `thinking effort to ${formatEffortValue(next.reasoningEffort)}`,
    );
  }

  if (
    getModelContextWindows(model).length > 1 &&
    previous.contextWindow !== next.contextWindow
  ) {
    changes.push(
      `context window to ${formatContextWindowValue(next.contextWindow)}`,
    );
  }

  return changes;
}

/**
 * Builds the result message shown after applying model options from the panel.
 * `persistenceLabel` is the parenthetical, e.g. "persisted" or
 * "this session only".
 */
export function formatModelOptionsResult(
  model: CurrentModelOptionsModel,
  previous: ModelOptionsState,
  next: ModelOptionsState,
  persistenceLabel: string,
  ultracodeDisabled = false,
): string {
  const changes = summarizeModelOptionChanges(model, previous, next);
  if (changes.length === 0) {
    if (ultracodeDisabled) {
      return `UltraCode disabled for ${model.display_name} (this session only)`;
    }
    return `No model settings changed for ${model.display_name}.`;
  }
  const suffix = ultracodeDisabled
    ? `${persistenceLabel}; UltraCode off for this session`
    : persistenceLabel;
  return `Updated ${model.display_name}: ${changes.join(', ')} (${suffix})`;
}

/**
 * Persists the options selected in the model options panel (remote or local)
 * and reports exactly which settings changed. Shared by /effort and
 * /context-window so the result message matches what the user adjusted,
 * regardless of which command opened the panel.
 */
export async function applyModelOptionsFromPanel(
  context: CommandContext,
  params: {
    model: CurrentModelOptionsModel;
    modelId: string;
    sessionOnly: boolean;
    previous: ModelOptionsState;
    next: ModelOptionsState;
    /** Preserve the existing effort-panel apply behavior. */
    exitUltracodeOnApply?: boolean;
  },
): Promise<void> {
  const { model, modelId, sessionOnly, previous, next } = params;
  const addResult = (text: string, severity: 'info' | 'error' = 'info') =>
    context.ui.addItem(createLocalCommandResultItem(text, severity));

  const session = context.services.sessionHandle;
  const effortChanged = previous.reasoningEffort !== next.reasoningEffort;
  if (session) {
    const exitsUltracode =
      effortChanged || params.exitUltracodeOnApply === true;
    const shouldDisableUltracode =
      exitsUltracode &&
      context.services.agentContext?.config.getUltracode?.() === true;
    let sessionUltracodeDisabled = false;
    let sessionSettingsUnavailable = !session.applySettings;
    try {
      if (shouldDisableUltracode && session.applySettings) {
        try {
          await session.applySettings({ ultracode: false });
          sessionUltracodeDisabled = true;
        } catch (error) {
          if (!isUnsupportedSettingsError(error)) throw error;
          sessionSettingsUnavailable = true;
        }
      }
      await session.setModel(modelId, next.reasoningEffort, next.contextWindow);
      if (exitsUltracode) {
        context.services.agentContext?.config.setUltracode?.(false);
      }
      const settingsWarning =
        shouldDisableUltracode && sessionSettingsUnavailable
          ? ' Warning: this session does not support changing UltraCode.'
          : '';
      addResult(
        `Changes apply to this session only; ${formatModelOptionsResult(
          model,
          previous,
          next,
          'this session only',
          sessionUltracodeDisabled,
        )}${settingsWarning}`,
      );
    } catch (err) {
      if (sessionUltracodeDisabled) {
        context.services.agentContext?.config.setUltracode?.(false);
      }
      addResult(
        sessionUltracodeDisabled
          ? `UltraCode was disabled, but the model settings change was rejected: ${getErrorMessage(err)}`
          : `Model settings change rejected: ${getErrorMessage(err)}`,
        'error',
      );
    }
    return;
  }

  const contextWindowChanged = previous.contextWindow !== next.contextWindow;
  const enablesUltracode = next.ultracode === true;
  const exitsUltracode =
    !enablesUltracode && (effortChanged || next.ultracode === false);
  const gcConfig = context.services.agentContext?.config;
  if (!gcConfig || gcConfig.getModel() !== modelId) {
    addResult('当前模型已变化，未更新模型设置。', 'error');
    return;
  }
  const identity = gcConfig.getModelRequestIdentity();
  const sessionId = gcConfig.getSessionId();
  const stillCurrent = () =>
    gcConfig === context.services.agentContext?.config &&
    gcConfig.getModel() === modelId &&
    gcConfig.getModelRequestIdentity() === identity &&
    gcConfig.getSessionId() === sessionId;
  let listed: Model | undefined;
  try {
    listed = await gcConfig.getModelProviderManager().getModel(modelId);
  } catch (error) {
    runLogger.debug('[model-options] 模型查询失败:', error);
    if (stillCurrent()) addResult('模型查询失败，未更新模型设置。', 'error');
    return;
  }
  if (!stillCurrent()) return;
  if (
    enablesUltracode &&
    (next.reasoningEffort !== 'xhigh' ||
      !getModelEfforts(model).includes('xhigh') ||
      listed?.key !== model.key ||
      !gcConfig.isUltracodeAvailable(listed))
  ) {
    addResult(
      'Ultracode is unavailable: the current model must support xhigh and the Workflow tool must be enabled. No model settings changed.',
      'error',
    );
    return;
  }
  const ultracodeRequested =
    context.services.agentContext?.config.getUltracode?.() === true;
  const shouldDisableUltracode = exitsUltracode && ultracodeRequested;

  const persist = !sessionOnly;
  const target = listed ?? modelId;
  // UltraCode 的 xhigh 只在本会话生效，其余字段按 persist 落盘；未变化的字段不写。
  try {
    if (
      effortChanged ||
      (previous.ultracode === true && next.ultracode === false)
    ) {
      await setModelPreference(
        gcConfig,
        { reasoning: { effort: next.reasoningEffort } },
        { model: target, persist: !enablesUltracode && persist },
      );
    }
    if (!stillCurrent()) return;
    if (contextWindowChanged) {
      await setModelPreference(
        gcConfig,
        { context: { contextWindow: next.contextWindow } },
        { model: target, persist },
      );
    }
  } catch (error) {
    if (stillCurrent()) {
      addResult(
        `Model settings change rejected: ${getErrorMessage(error)}`,
        'error',
      );
    }
    return;
  }
  if (!stillCurrent()) return;
  if (enablesUltracode) {
    gcConfig.setUltracode(true);
  }
  if (exitsUltracode) {
    gcConfig.setUltracode(false);
  }
  addResult(
    formatModelOptionsResult(
      model,
      previous,
      next,
      enablesUltracode
        ? persist && contextWindowChanged
          ? 'Ultracode this session only; other changed settings persisted'
          : 'this session only'
        : persist
          ? 'persisted'
          : 'this session only',
      shouldDisableUltracode,
    ),
  );
}

export function isUnsupportedSettingsError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.message === 'Session settings are not supported'
  );
}

export function createModelOptionsDialog(
  context: CommandContext,
  model: CurrentModelOptionsModel,
  initialFocusKey: ModelOptionsFocusKey,
  currentReasoningEffort: ReasoningEffortLevel | undefined,
  currentContextWindow: number | undefined,
  onSelect: (
    reasoningEffort: ReasoningEffortLevel | undefined,
    contextWindow: number | undefined,
    ultracode?: boolean,
  ) => void | Promise<void>,
): OpenCustomDialogActionReturn {
  const hasSessionBinding = context.services.sessionHandle !== undefined;
  const config = context.services.agentContext?.config;
  const identity = config?.getModelRequestIdentity();
  const sessionId = config?.getSessionId();
  const modelKey = config?.getModel();
  const ultracodeAvailable =
    !hasSessionBinding &&
    getModelEfforts(model).includes('xhigh') &&
    config?.isWorkflowToolAvailable() === true;
  return {
    type: 'custom_dialog',
    component: React.createElement(ModelOptionsSelector, {
      model,
      currentReasoningEffort,
      currentUltracode:
        ultracodeAvailable &&
        config?.getUltracode() === true &&
        currentReasoningEffort === 'xhigh',
      ultracodeAvailable,
      currentContextWindow,
      initialFocusKey,
      onSelect: async (
        reasoningEffort: ReasoningEffortLevel | undefined,
        contextWindow: number | undefined,
        ultracode?: boolean,
      ) => {
        try {
          if (
            !hasSessionBinding &&
            (config !== context.services.agentContext?.config ||
              config?.getModelRequestIdentity() !== identity ||
              config?.getSessionId() !== sessionId ||
              config?.getModel() !== modelKey)
          )
            return;
          await onSelect(
            reasoningEffort,
            contextWindow,
            hasSessionBinding ? undefined : ultracode,
          );
        } finally {
          context.ui.removeComponent();
        }
      },
      onCancel: () => context.ui.removeComponent(),
    }),
  };
}
