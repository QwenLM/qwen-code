/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  type Model,
  type QoderListedModel,
  getSupportedContextWindows,
  isDirectConnectionModel,
} from '@qwen-code/core';

import type { SessionModelInfo, SessionModelSource } from './sessionModels.js';

function listedModelSource(model: QoderListedModel): SessionModelSource {
  if (isDirectConnectionModel(model)) return 'user';
  return model.catalogSource === 'organization' ||
    model.catalogSource === 'custom'
    ? model.catalogSource
    : 'system';
}

/** Projects a listed server-provider model; direct-connection secrets are not copied. */
function listedModelToInfo(model: QoderListedModel): SessionModelInfo {
  const efforts = model.capabilities.reasoning.supportedEfforts;
  const enabledEfforts = efforts.filter((effort) => effort !== 'none');
  const windows = model.capabilities.contextWindows.map(
    (window) => window.tokens,
  );
  const defaultEffort = model.defaultModelConfig?.reasoning?.effort;
  const defaultContextWindow = model.defaultModelConfig?.context?.contextWindow;
  const connection = model.connection;
  const info: SessionModelInfo = {
    value: model.key,
    modelId: model.key,
    displayName: model.displayName,
    description: '',
    descriptionEn: '',
    source: listedModelSource(model),
    isDefault: model.isDefault || undefined,
    isEnabled: model.enabled !== false,
    isNew: model.isNew || undefined,
    isReasoning: model.capabilities.reasoning.supported || undefined,
    isVl: model.capabilities.vision || undefined,
  };
  if (model.outerProvider) info.outerProvider = model.outerProvider;
  if (enabledEfforts.length > 0) info.efforts = enabledEfforts;
  if (defaultEffort) info.defaultEffort = defaultEffort;
  if (efforts.includes('none')) info.supportsDisabled = true;
  const availableContextWindows = getSupportedContextWindows({
    availableContextWindows: windows.length > 0 ? windows : undefined,
    maxInputTokens: model.limits.maxContextTokens,
  });
  if (availableContextWindows.length > 0) {
    info.availableContextWindows = availableContextWindows;
  }
  if (defaultContextWindow !== undefined) {
    info.defaultContextWindow = defaultContextWindow;
  }
  info.maxInputTokens = model.limits.maxContextTokens;
  if (model.limits.maxOutputTokens !== undefined) {
    info.maxOutputTokens = model.limits.maxOutputTokens;
  }
  if (model.tags && model.tags.length > 0) info.tags = [...model.tags];
  if (model.strategies && model.strategies.length > 0) {
    info.strategies = [...model.strategies];
  }
  info.format = model.format ?? connection?.format ?? 'openai';
  if (model.serverScene) info.serverScene = model.serverScene;
  if (model.icon) info.icon = model.icon;
  if (connection?.url) info.url = connection.url;
  if (connection?.model) info.model = connection.model;
  if (connection?.provider) info.provider = connection.provider;
  return info;
}

/**
 * Projects a model snapshot onto the session model list: the server models
 * plus direct-connection models listed by the provider. Custom Provider
 * models stay local to the session.
 */
export function projectSessionListedModels(
  models: readonly Model[],
  options: { outerProviders?: readonly string[] } = {},
): SessionModelInfo[] {
  const requestedOuterProviders = options.outerProviders
    ? new Set(options.outerProviders)
    : undefined;
  const out: SessionModelInfo[] = [];
  const seen = new Set<string>();
  for (const model of models as readonly QoderListedModel[]) {
    if (model.source !== 'qoder') continue;
    if (
      model.outerProvider !== undefined &&
      requestedOuterProviders !== undefined &&
      !requestedOuterProviders.has(model.outerProvider)
    ) {
      continue;
    }
    if (seen.has(model.key)) continue;
    seen.add(model.key);
    out.push(listedModelToInfo(model));
  }
  return out;
}

/**
 * Build the full session model list a controller should see from the
 * session's ModelProviderManager snapshot. The output deliberately carries no
 * connection secrets.
 *
 * @param config - Application configuration
 */
export async function buildSessionModelList(
  config: Config,
  options: { outerProviders?: readonly string[] } = {},
): Promise<SessionModelInfo[]> {
  return projectSessionListedModels(
    await config.getModelProviderManager().listModels(),
    options,
  );
}

/**
 * Build a model list for SDK on-demand queries: refreshes the session's
 * ModelProviderManager live (optionally appending external-provider channels)
 * and projects the result like buildSessionModelList(). Errors propagate.
 */
export async function buildLiveSessionModelList(
  config: Config,
  options: { outerProviders?: readonly string[] } = {},
): Promise<SessionModelInfo[]> {
  const models = await config.getModelProviderManager().listModels({
    skipCache: true,
    ...(options.outerProviders?.length
      ? { outerProviders: options.outerProviders }
      : {}),
  });
  return projectSessionListedModels(models, options);
}
