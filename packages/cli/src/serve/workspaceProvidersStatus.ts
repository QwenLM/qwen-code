/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ModelsConfig, tokenLimit } from '@qwen-code/qwen-code-core';
import type { AuthType } from '@qwen-code/qwen-code-core';
import type {
  ServeWorkspaceProviderCurrent,
  ServeWorkspaceProviderModel,
  ServeWorkspaceProviderStatus,
  ServeWorkspaceProvidersStatus,
} from '@qwen-code/acp-bridge/status';
import { STATUS_SCHEMA_VERSION } from '@qwen-code/acp-bridge/status';
import { loadSettings } from '../config/settings.js';
import {
  getAuthTypeFromEnv,
  resolveCliGenerationConfig,
} from '../utils/modelConfigUtils.js';
import type { CliGenerationConfigInputs } from '../utils/modelConfigUtils.js';
import {
  formatAcpModelId,
  parseAcpBaseModelId,
  sanitizeProviderBaseUrl,
} from '../utils/acpModelUtils.js';

export type WorkspaceProvidersStatusProvider = (
  workspaceCwd: string,
  acpChannelLive: boolean,
) => Promise<ServeWorkspaceProvidersStatus>;

export interface WorkspaceProvidersStatusProviderOptions {
  argv?: Partial<CliGenerationConfigInputs['argv']>;
  env?: Record<string, string | undefined>;
}

export function createWorkspaceProvidersStatusProvider(
  options: WorkspaceProvidersStatusProviderOptions = {},
): WorkspaceProvidersStatusProvider {
  return async (workspaceCwd, acpChannelLive) =>
    buildWorkspaceProvidersStatus(workspaceCwd, acpChannelLive, options);
}

function buildWorkspaceProvidersStatus(
  workspaceCwd: string,
  acpChannelLive: boolean,
  options: WorkspaceProvidersStatusProviderOptions,
): ServeWorkspaceProvidersStatus {
  try {
    const loaded = loadSettings(workspaceCwd);
    const settings = loaded.merged;
    const env =
      options.env ?? (process.env as Record<string, string | undefined>);
    const selectedAuthType =
      settings.security?.auth?.selectedType ?? getAuthTypeFromEnv();
    const argv: CliGenerationConfigInputs['argv'] = {
      model: options.argv?.model,
      openaiApiKey: options.argv?.openaiApiKey,
      openaiBaseUrl: options.argv?.openaiBaseUrl,
      openaiLogging: options.argv?.openaiLogging,
      openaiLoggingDir: options.argv?.openaiLoggingDir,
    };
    const resolvedCliConfig = resolveCliGenerationConfig({
      argv,
      settings,
      selectedAuthType,
      env,
    });
    const modelsConfig = new ModelsConfig({
      initialAuthType: selectedAuthType,
      modelProvidersConfig: settings.modelProviders,
      generationConfig: resolvedCliConfig.generationConfig,
      generationConfigSources: resolvedCliConfig.sources,
    });
    const currentAuth = selectedAuthType;
    const currentModelId = (
      resolvedCliConfig.model ||
      modelsConfig.getModel() ||
      ''
    ).trim();
    const hasCurrentModel = currentModelId.length > 0;
    const currentAcpModelId =
      hasCurrentModel && currentAuth
        ? formatAcpModelId(currentModelId, currentAuth)
        : currentModelId || undefined;
    const currentBaseUrl = resolvedCliConfig.baseUrl || undefined;
    const fastModelId =
      typeof settings.fastModel === 'string' && settings.fastModel.length > 0
        ? settings.fastModel
        : undefined;
    const providers = new Map<string, ServeWorkspaceProviderStatus>();

    for (const model of modelsConfig.getAllConfiguredModels()) {
      if (model.isRuntimeModel) continue;
      const authType = String(model.authType);
      let provider = providers.get(authType);
      if (!provider) {
        provider = {
          kind: 'model_provider',
          status: 'ok',
          authType,
          current: false,
          models: [],
        };
        providers.set(authType, provider);
      }

      const effectiveModelId = model.id;
      const modelId = formatAcpModelId(effectiveModelId, model.authType);
      const isCurrent =
        currentAuth === model.authType &&
        hasCurrentModel &&
        matchesCurrentModel(
          currentModelId,
          currentAcpModelId,
          effectiveModelId,
          modelId,
        ) &&
        matchesCurrentBaseUrl(currentBaseUrl, model.baseUrl);
      const providerModel: ServeWorkspaceProviderModel = {
        modelId,
        baseModelId: parseAcpBaseModelId(effectiveModelId),
        name: model.label,
        ...(model.description !== undefined
          ? { description: model.description }
          : {}),
        contextLimit: model.contextWindowSize ?? tokenLimit(effectiveModelId),
        ...(model.modalities !== undefined
          ? { modalities: model.modalities }
          : {}),
        ...(model.baseUrl !== undefined
          ? { baseUrl: sanitizeProviderBaseUrl(model.baseUrl) }
          : {}),
        ...(model.envKey !== undefined ? { envKey: model.envKey } : {}),
        isCurrent,
        isRuntime: false,
      };
      provider.models.push(providerModel);
      if (isCurrent) provider.current = true;
    }

    const current = buildCurrent(
      currentAuth,
      currentAcpModelId,
      currentBaseUrl,
      fastModelId,
    );

    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd,
      initialized: true,
      acpChannelLive,
      ...(current ? { current } : {}),
      providers: [...providers.values()],
      ...(resolvedCliConfig.warnings.length > 0
        ? {
            errors: resolvedCliConfig.warnings.map((warning) => ({
              kind: 'providers',
              status: 'warning' as const,
              error: warning,
            })),
          }
        : {}),
    };
  } catch (error) {
    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd,
      initialized: false,
      acpChannelLive,
      providers: [],
      errors: [
        {
          kind: 'providers',
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

function matchesCurrentModel(
  currentModelId: string,
  currentAcpModelId: string | undefined,
  baseModelId: string,
  acpModelId: string,
): boolean {
  return (
    currentModelId === baseModelId ||
    currentModelId === acpModelId ||
    currentAcpModelId === acpModelId
  );
}

function matchesCurrentBaseUrl(
  currentBaseUrl: string | undefined,
  modelBaseUrl: string | undefined,
): boolean {
  return !currentBaseUrl || currentBaseUrl === modelBaseUrl;
}

function buildCurrent(
  authType: AuthType | undefined,
  modelId: string | undefined,
  baseUrl: string | undefined,
  fastModelId: string | undefined,
): ServeWorkspaceProviderCurrent | undefined {
  if (!authType && !modelId && !baseUrl && !fastModelId) return undefined;
  return {
    ...(authType ? { authType: String(authType) } : {}),
    ...(modelId ? { modelId } : {}),
    ...(baseUrl ? { baseUrl: sanitizeProviderBaseUrl(baseUrl) } : {}),
    ...(fastModelId ? { fastModelId } : {}),
  };
}
