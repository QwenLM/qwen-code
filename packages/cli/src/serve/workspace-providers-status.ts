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
import type { AuthType, CredentialProvider } from '@qwen-code/qwen-code-core';
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
  buildAcpModelOptions,
  getCurrentAcpModelId,
  parseAcpBaseModelId,
  sanitizeProviderBaseUrl,
} from '../utils/acpModelUtils.js';
import { snapshotProcessEnv } from './env-snapshot.js';

const debugLogger = createDebugLogger('WORKSPACE_PROVIDERS_STATUS');

export type WorkspaceProvidersStatusProvider = (
  workspaceCwd: string,
  acpChannelLive: boolean,
) => Promise<ServeWorkspaceProvidersStatus>;

export interface WorkspaceProvidersStatusProviderOptions {
  argv?: Partial<CliGenerationConfigInputs['argv']>;
  env?: Record<string, string | undefined>;
  /**
   * Store-backed credential provider for daemon-owned ModelsConfig. Reads
   * QWEN_CUSTOM_API_KEY_* from the in-process store (not the scrubbed
   * process.env). Omitted in non-daemon (CLI) contexts.
   */
  credentialProvider?: CredentialProvider;
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
    const loaded = loadSettings(
      workspaceCwd,
      options.env ? { skipLoadEnvironment: true } : true,
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
    });
    const modelsConfig = new ModelsConfig({
      initialAuthType: selectedAuthType,
      modelProvidersConfig: settings.modelProviders,
      providerProtocolConfig: settings.providerProtocol,
      credentialProvider: options.credentialProvider,
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
    const modelCameFromSettings =
      !argv.model && settings.model?.name?.trim() === currentModelId;
    const currentBaseUrl =
      modelCameFromSettings && settings.model?.baseUrl !== undefined
        ? settings.model.baseUrl || undefined
        : resolvedCliConfig.sources['baseUrl']
          ? resolvedCliConfig.baseUrl || undefined
          : undefined;
    const currentRegistryBaseUrl =
      modelCameFromSettings && currentAuth
        ? settings.model?.baseUrl !== undefined
          ? settings.model.baseUrl || null
          : (modelsConfig.getResolvedModel(currentAuth, currentModelId)
              ?.registryBaseUrl ?? null)
        : undefined;
    const modelOptions = buildAcpModelOptions(
      modelsConfig.getAllConfiguredModels(),
    );
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
    for (const option of modelOptions) {
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
    ...(fastModelId ? { fastModelId } : {}),
    ...(visionModelId ? { visionModelId } : {}),
  };
}
