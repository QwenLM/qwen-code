/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApprovalMode,
  APPROVAL_MODES,
  createDebugLogger,
  ModelsConfig,
  tokenLimit,
} from '@qwen-code/qwen-code-core';
import {
  captureReasoningSnapshot,
  resolveReasoningForModel,
} from '@qwen-code/qwen-code-core/core/reasoning-overrides.js';
import type {
  AuthType,
  ContentGeneratorConfig,
} from '@qwen-code/qwen-code-core';
import { resolveModelConfig } from '@qwen-code/qwen-code-core/models/modelConfigResolver.js';
import type {
  ServeWorkspaceProviderCurrent,
  ServeWorkspaceProviderModel,
  ServeWorkspaceProviderStatus,
  ServeWorkspaceProvidersStatus,
} from '@qwen-code/acp-bridge/status';
import { STATUS_SCHEMA_VERSION } from '@qwen-code/acp-bridge/status';
import { loadSettings } from '../config/settings.js';
import { filterModelEntriesForDisplay } from '../utils/model-display-order.js';
import type { LoadedSettings, Settings } from '../config/settings.js';
import {
  getModelPreferenceKey,
  type ModelPreference,
} from '@qwen-code/qwen-code-core/models/model-preferences.js';
import {
  isReasoningEffortPlaceholder,
  normalizeReasoningEffort,
  type ReasoningEffort,
} from '@qwen-code/qwen-code-core/core/reasoning-effort.js';
import {
  getAuthTypeFromEnv,
  resolveCliGenerationConfig,
} from '../utils/modelConfigUtils.js';
import type { CliGenerationConfigInputs } from '../utils/modelConfigUtils.js';
import {
  ACP_ROUTE_ID_PREFIX,
  buildAcpModelOptions,
  getCurrentAcpModelId,
  parseAcpBaseModelId,
  sanitizeProviderBaseUrl,
} from '../utils/acpModelUtils.js';
import { publicAuxModelSelectorValue } from '../utils/aux-model-selector.js';
import {
  buildModelReasoningRoutePreview,
  getGptReasoningOverrideState,
} from '../acp-integration/model-configuration.js';
import { snapshotProcessEnv } from './env-snapshot.js';
import { getModelConfigurationKey } from './model-configuration.js';

const debugLogger = createDebugLogger('WORKSPACE_PROVIDERS_STATUS');

export type WorkspaceProvidersStatusProvider = (
  workspaceCwd: string,
  acpChannelLive: boolean,
) => Promise<ServeWorkspaceProvidersStatus>;

export interface WorkspaceProvidersStatusProviderOptions {
  argv?: Partial<CliGenerationConfigInputs['argv']>;
  env?: Record<string, string | undefined>;
  workspaceTrusted?: boolean;
}

export function createWorkspaceProvidersStatusProvider(
  options: WorkspaceProvidersStatusProviderOptions = {},
): WorkspaceProvidersStatusProvider {
  return async (workspaceCwd, acpChannelLive) =>
    buildWorkspaceProvidersStatus(workspaceCwd, acpChannelLive, options);
}

export interface WorkspacePreferenceModel {
  key: string;
  modelId: string;
  authType: string;
  name: string;
  provider?: string;
  isCurrent: boolean;
  contextLimit: number;
  reasoning?: {
    canEnable: boolean;
    canDisable: boolean;
    efforts: ReasoningEffort[];
    effortEnablesThinking: boolean;
  };
  resolveReasoning: (
    preference: ModelPreference['reasoning'],
    fallback: string | undefined,
  ) => ModelPreference['reasoning'];
}

export function listWorkspacePreferenceModels(
  workspaceCwd: string,
  loaded: LoadedSettings,
  env: Record<string, string | undefined>,
): WorkspacePreferenceModel[] {
  const models = new Map<string, WorkspacePreferenceModel>();
  const status = buildWorkspaceProvidersStatus(
    workspaceCwd,
    false,
    { env },
    loaded,
    (generation, name, isCurrent, opaqueRoute) => {
      const enforcedAuth = loaded.merged.security?.auth?.enforcedType;
      if (
        !generation.authType ||
        (enforcedAuth && generation.authType !== enforcedAuth)
      )
        return;
      const key = getModelPreferenceKey(
        generation.authType,
        generation.model,
        generation.baseUrl,
      );
      if (models.has(key) && !isCurrent) return;
      const capabilities = resolveReasoningForModel(undefined, generation);
      const preview = (
        fallback?: string,
        preference?: ModelPreference['reasoning'],
      ) =>
        buildModelReasoningRoutePreview(
          generation,
          capabilities,
          fallback,
          opaqueRoute,
          preference,
        )?.[0];
      const option = preview();
      const override = getGptReasoningOverrideState(
        { ...generation, reasoning: undefined },
        capabilities,
      );
      const pinnedTier =
        override?.blocksTierChange ||
        !isReasoningEffortPlaceholder(
          generation.extra_body?.['reasoning_effort'] ??
            generation.samplingParams?.['reasoning_effort'],
        );
      const metadata = option?._meta?.['qwenCode/reasoning'] as
        | {
            canEnable?: boolean;
            thinkingMandatory?: boolean;
            defaultEffort?: ReasoningEffort;
          }
        | undefined;
      const choices =
        option?.options.flatMap((choice) =>
          'value' in choice
            ? [choice.value]
            : choice.options.map(({ value }) => value),
        ) ?? [];
      const efforts = (pinnedTier ? [] : choices).flatMap((choice) => {
        const effort = normalizeReasoningEffort(choice);
        return effort ? [effort] : [];
      });
      const contextLimit =
        generation.contextWindowSize &&
        Number.isSafeInteger(generation.contextWindowSize) &&
        generation.contextWindowSize > 0
          ? generation.contextWindowSize
          : tokenLimit(generation.model, 'input');
      const provider = URL.canParse(generation.baseUrl ?? '')
        ? new URL(generation.baseUrl!).host
        : undefined;
      models.set(key, {
        key,
        modelId: generation.model,
        authType: generation.authType,
        name,
        ...(provider ? { provider } : {}),
        isCurrent,
        contextLimit,
        resolveReasoning: (preference, fallback) => {
          if (!option) return undefined;
          const current = preview(fallback, preference) ?? option;
          const effort = preference?.effort;
          return {
            enabled: current.currentValue !== 'none',
            effort:
              effort && efforts.includes(effort)
                ? effort
                : (normalizeReasoningEffort(current.currentValue) ??
                  normalizeReasoningEffort(option.currentValue) ??
                  metadata?.defaultEffort),
          };
        },
        ...(option
          ? {
              reasoning: {
                canEnable:
                  metadata?.canEnable !== false && override?.enabled !== false,
                canDisable: choices.includes('none'),
                efforts,
                effortEnablesThinking:
                  generation.reasoning !== false && override?.enabled !== false,
              },
            }
          : {}),
      });
    },
  );
  if (!status.initialized) {
    const detail = status.errors?.[0]?.error;
    throw new Error(
      detail
        ? `Unable to resolve model catalog: ${detail}`
        : 'Unable to resolve model catalog',
    );
  }
  const rows = [...models.values()];
  const counts = new Map<string, number>();
  const label = (model: WorkspacePreferenceModel) =>
    JSON.stringify([model.name, model.provider ?? model.authType]);
  for (const model of rows) {
    const id = label(model);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const model of rows) {
    if ((counts.get(label(model)) ?? 0) > 1) {
      model.provider = `${model.provider ?? model.authType} · ${model.key.slice(-6)}`;
    }
  }
  return rows;
}

function buildWorkspaceProvidersStatus(
  workspaceCwd: string,
  acpChannelLive: boolean,
  options: WorkspaceProvidersStatusProviderOptions,
  loadedSettings?: LoadedSettings,
  collectPreferenceModel?: (
    generation: ContentGeneratorConfig,
    name: string,
    isCurrent: boolean,
    opaqueRoute: boolean,
  ) => void,
): ServeWorkspaceProvidersStatus {
  try {
    const loaded =
      loadedSettings ??
      loadSettings(
        workspaceCwd,
        options.env
          ? {
              skipLoadEnvironment: true,
              skipWorkspaceSettings: options.workspaceTrusted === false,
              workspaceTrusted: options.workspaceTrusted,
            }
          : {
              consumeCorruptionEnvVars: true,
              skipLoadEnvironment: options.workspaceTrusted === false,
              skipWorkspaceSettings: options.workspaceTrusted === false,
              workspaceTrusted: options.workspaceTrusted,
            },
      );
    const settings = loaded.merged;
    const env = options.env ?? snapshotProcessEnv();
    const selectedAuthType =
      settings.security?.auth?.selectedType ?? getAuthTypeFromEnv(env);
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
      deferReasoningEffort: collectPreferenceModel !== undefined,
    });
    const modelsConfig = new ModelsConfig({
      initialAuthType: resolvedCliConfig.authType,
      modelProvidersConfig: settings.modelProviders,
      providerProtocolConfig: settings.providerProtocol,
      generationConfig: resolvedCliConfig.generationConfig,
      generationConfigSources: resolvedCliConfig.sources,
      initialRegistryBaseUrl: resolvedCliConfig.registryBaseUrl,
    });
    const currentAuth = resolvedCliConfig.authType;
    let currentModelId = (
      resolvedCliConfig.model ||
      modelsConfig.getModel() ||
      ''
    ).trim();
    const requestedModelId = currentModelId;
    if (
      currentAuth &&
      !modelsConfig.getResolvedModel(currentAuth, currentModelId)
    ) {
      modelsConfig.syncAfterAuthRefresh(currentAuth, currentModelId);
      currentModelId = (modelsConfig.getModel() || '').trim();
    }
    const usedFallback = currentModelId !== requestedModelId;
    const hasCurrentModel = currentModelId.length > 0;
    const modelCameFromSettings =
      !argv.model && settings.model?.name?.trim() === currentModelId;
    const currentBaseUrl = usedFallback
      ? modelsConfig.getGenerationConfig().baseUrl
      : modelCameFromSettings && settings.model?.baseUrl !== undefined
        ? settings.model.baseUrl || undefined
        : resolvedCliConfig.sources['baseUrl']
          ? resolvedCliConfig.baseUrl || undefined
          : undefined;
    const currentRegistryBaseUrl =
      collectPreferenceModel || usedFallback
        ? modelsConfig.getCurrentRegistryBaseUrl()
        : modelCameFromSettings && currentAuth
          ? settings.model?.baseUrl !== undefined
            ? settings.model.baseUrl || null
            : (modelsConfig.getResolvedModel(currentAuth, currentModelId)
                ?.registryBaseUrl ?? null)
          : undefined;
    const models = modelsConfig.getAllConfiguredModels();
    const modelOptions = buildAcpModelOptions(models);
    const reasoningSnapshot = captureReasoningSnapshot(models);
    const currentAcpModelId = hasCurrentModel
      ? getCurrentAcpModelId(
          modelOptions,
          currentModelId,
          currentAuth,
          currentRegistryBaseUrl,
        )
      : undefined;
    const fastModelId =
      typeof settings.fastModel === 'string' && settings.fastModel.length > 0
        ? settings.fastModel
        : undefined;
    const visionModelId =
      typeof settings.visionModel === 'string' &&
      settings.visionModel.length > 0
        ? settings.visionModel
        : undefined;
    const approvalMode = resolveApprovalMode(settings);
    const providers = new Map<string, ServeWorkspaceProviderStatus>();
    for (const option of filterModelEntriesForDisplay(modelOptions)) {
      const { model, effectiveModelId, modelId } = option;
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

      const isCurrent =
        currentAuth === model.authType && currentAcpModelId === modelId;
      const resolved = modelsConfig.getResolvedModel(
        model.authType,
        model.id,
        model.registryBaseUrl ?? null,
      );
      const generation: ContentGeneratorConfig = {
        ...resolved?.generationConfig,
        model: model.id,
        authType: model.authType,
        baseUrl: resolved?.baseUrl,
        reasoningSnapshot,
        reasoningRouteBaseUrl: model.registryBaseUrl ?? null,
      };
      const opaqueRoute = modelId.startsWith(ACP_ROUTE_ID_PREFIX);
      if (collectPreferenceModel) {
        if (!model.visionOnly) {
          const baseUrl =
            model.registryBaseUrl ??
            resolveModelConfig({
              authType: model.authType,
              cli: { baseUrl: argv.openaiBaseUrl },
              settings: { baseUrl: settings.security?.auth?.baseUrl },
              env,
            }).config.baseUrl ??
            generation.baseUrl;
          collectPreferenceModel(
            { ...generation, baseUrl },
            model.label,
            isCurrent,
            opaqueRoute,
          );
        }
        continue;
      }
      const preference = getModelPreferenceKey(
        model.authType,
        model.id,
        generation.baseUrl,
      );
      const configOptions = buildModelReasoningRoutePreview(
        generation,
        resolveReasoningForModel(undefined, generation),
        settings.model?.reasoningEffort,
        opaqueRoute,
        settings.model?.preferences?.[preference]?.reasoning,
      );
      const configurationKey = getModelConfigurationKey(
        loaded,
        authType,
        model.id,
        model.registryBaseUrl,
      );
      const providerModel: ServeWorkspaceProviderModel = {
        ...(configurationKey ? { configurationKey } : {}),
        modelId,
        baseModelId: parseAcpBaseModelId(effectiveModelId),
        name: model.label,
        ...(model.description !== undefined
          ? { description: model.description }
          : {}),
        // A non-positive contextWindowSize is meaningless (the SDK rejects it
        // on the wire); treat it as unset and fall back to the estimate.
        contextLimit:
          model.contextWindowSize !== undefined && model.contextWindowSize > 0
            ? model.contextWindowSize
            : tokenLimit(effectiveModelId),
        ...(model.modalities !== undefined
          ? { modalities: model.modalities }
          : {}),
        ...(model.baseUrl !== undefined
          ? { baseUrl: sanitizeProviderBaseUrl(model.baseUrl) }
          : {}),
        ...(model.envKey !== undefined ? { envKey: model.envKey } : {}),
        isCurrent,
        isRuntime: false,
        ...(configOptions ? { configOptions } : {}),
      };
      provider.models.push(providerModel);
      if (isCurrent) provider.current = true;
    }

    if (
      collectPreferenceModel &&
      currentAuth &&
      currentModelId &&
      currentRegistryBaseUrl === undefined
    ) {
      collectPreferenceModel(
        {
          ...modelsConfig.getGenerationConfig(),
          authType: currentAuth,
          model: currentModelId,
          reasoningSnapshot,
          reasoningRouteBaseUrl: null,
        },
        currentModelId,
        true,
        false,
      );
    }

    const current = buildCurrent(
      currentAuth,
      currentAcpModelId,
      currentBaseUrl,
      fastModelId,
      visionModelId,
    );

    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd,
      initialized: true,
      acpChannelLive,
      ...(current ? { current } : {}),
      approvalMode,
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

function resolveApprovalMode(settings: Settings): ApprovalMode {
  const value = settings.tools?.approvalMode;
  if (typeof value !== 'string') return ApprovalMode.AUTO;

  const normalized = value.trim().toLowerCase().replaceAll('_', '-');
  const mode = normalized === 'autoedit' ? ApprovalMode.AUTO_EDIT : normalized;
  if ((APPROVAL_MODES as readonly string[]).includes(mode)) {
    return mode as ApprovalMode;
  }

  if (value.trim().length > 0) {
    debugLogger.warn(
      `[workspace-providers-status] unrecognized approvalMode "${value}", falling back to auto`,
    );
  }
  return ApprovalMode.AUTO;
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
  visionModelId: string | undefined,
): ServeWorkspaceProviderCurrent | undefined {
  if (!authType && !modelId && !baseUrl && !fastModelId && !visionModelId)
    return undefined;
  return {
    ...(authType ? { authType: String(authType) } : {}),
    ...(modelId ? { modelId } : {}),
    ...(baseUrl ? { baseUrl: sanitizeProviderBaseUrl(baseUrl) } : {}),
    // The aux selectors persist as `authType:id\0baseUrl`; publish the
    // credential-stripped form like the neighbouring baseUrl field.
    ...(fastModelId
      ? { fastModelId: publicAuxModelSelectorValue(fastModelId) }
      : {}),
    ...(visionModelId
      ? { visionModelId: publicAuxModelSelectorValue(visionModelId) }
      : {}),
  };
}
