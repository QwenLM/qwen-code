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
import type { Settings } from '../config/settings.js';
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
    const currentBaseUrl = resolvedCliConfig.sources['baseUrl']
      ? resolvedCliConfig.baseUrl || undefined
      : undefined;
    const fastModelId =
      typeof settings.fastModel === 'string' && settings.fastModel.length > 0
        ? settings.fastModel
        : undefined;
    const providers = new Map<string, ServeWorkspaceProviderStatus>();
    const explicitModelBaseUrls = buildExplicitModelBaseUrls(
      settings.modelProviders,
    );

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
        matchesCurrentBaseUrl(
          currentBaseUrl,
          model.baseUrl,
          model.baseUrl !== undefined &&
            explicitModelBaseUrls.has(
              modelBaseUrlKey(authType, effectiveModelId, model.baseUrl),
            ),
        );
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
              error: sanitizeProviderWarning(warning),
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
          error: sanitizeProviderWarning(
            error instanceof Error ? error.message : String(error),
          ),
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
  modelHasExplicitBaseUrl: boolean,
): boolean {
  if (!currentBaseUrl) return !modelHasExplicitBaseUrl;
  return currentBaseUrl === modelBaseUrl;
}

function buildExplicitModelBaseUrls(
  modelProviders: Settings['modelProviders'],
): Set<string> {
  const baseUrls = new Set<string>();
  if (!modelProviders) return baseUrls;

  for (const [authType, providerConfig] of Object.entries(modelProviders)) {
    const models = readProviderModels(providerConfig);
    for (const model of models) {
      if (
        typeof model.id === 'string' &&
        typeof model.baseUrl === 'string' &&
        model.baseUrl.length > 0
      ) {
        baseUrls.add(modelBaseUrlKey(authType, model.id, model.baseUrl));
      }
    }
  }
  return baseUrls;
}

type ProviderModelBaseUrlConfig = {
  id?: unknown;
  baseUrl?: unknown;
};

function readProviderModels(
  providerConfig: unknown,
): ProviderModelBaseUrlConfig[] {
  if (Array.isArray(providerConfig)) {
    return providerConfig.filter(isProviderModelBaseUrlConfig);
  }
  if (typeof providerConfig !== 'object' || providerConfig === null) {
    return [];
  }

  const { models } = providerConfig as { models?: unknown };
  return Array.isArray(models)
    ? models.filter(isProviderModelBaseUrlConfig)
    : [];
}

function isProviderModelBaseUrlConfig(
  value: unknown,
): value is ProviderModelBaseUrlConfig {
  return typeof value === 'object' && value !== null;
}

function modelBaseUrlKey(
  authType: string,
  modelId: string,
  baseUrl: string,
): string {
  return `${authType}\0${modelId}\0${baseUrl}`;
}

const URL_LIKE_PATTERN = /\b[A-Za-z][A-Za-z\d+.-]*:\/\/[^\s'"`<>]+/g;
const URL_START_PATTERN = /\b[A-Za-z][A-Za-z\d+.-]*:\/\//g;

function sanitizeProviderWarning(warning: string): string {
  let result = '';
  let index = 0;
  let next = findNextUrlStart(warning, index);

  while (next) {
    result += warning.slice(index, next.index);

    const segmentEnd = findUrlSegmentEnd(warning, next.index, next.marker);
    const segment = warning.slice(next.index, segmentEnd);
    result += sanitizeProviderWarningSegment(segment, next.marker.length);

    index = segmentEnd;
    next = findNextUrlStart(warning, index);
  }

  return result + warning.slice(index);
}

function findNextUrlStart(
  value: string,
  from: number,
): { index: number; marker: string } | undefined {
  URL_START_PATTERN.lastIndex = from;
  const match = URL_START_PATTERN.exec(value);
  return match ? { index: match.index, marker: match[0] } : undefined;
}

function findUrlSegmentEnd(
  value: string,
  start: number,
  marker: string,
): number {
  const afterMarker = start + marker.length;
  const carriageReturn = value.indexOf('\r', afterMarker);
  const lineFeed = value.indexOf('\n', afterMarker);
  let lineEnd = value.length;
  if (carriageReturn !== -1) lineEnd = Math.min(lineEnd, carriageReturn);
  if (lineFeed !== -1) lineEnd = Math.min(lineEnd, lineFeed);

  const nextUrl = findNextUrlStart(value, afterMarker);

  return Math.min(lineEnd, nextUrl?.index ?? value.length);
}

function sanitizeProviderWarningSegment(
  segment: string,
  markerLength: number,
): string {
  const at = segment.indexOf('@', markerLength);
  if (
    at !== -1 &&
    hasCredentialPrefix(segment, markerLength, at) &&
    segment[at + 1] !== undefined &&
    /[A-Za-z0-9.[\]-]/.test(segment[at + 1])
  ) {
    return `${segment.slice(0, markerLength)}${segment.slice(at + 1)}`;
  }

  return segment.replace(URL_LIKE_PATTERN, (url) =>
    sanitizeProviderBaseUrl(url),
  );
}

function hasCredentialPrefix(
  segment: string,
  markerLength: number,
  at: number,
): boolean {
  const colon = segment.indexOf(':', markerLength);
  if (colon === -1 || colon > at) return false;
  const username = segment.slice(markerLength, colon);
  return !/[/?#\s'"`<>]/.test(username);
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
