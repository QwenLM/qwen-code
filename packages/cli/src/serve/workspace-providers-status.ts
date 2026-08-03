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
  workspaceTrusted?: boolean;
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
    });
    const modelsConfig = new ModelsConfig({
      initialAuthType: selectedAuthType,
      modelProvidersConfig: settings.modelProviders,
      providerProtocolConfig: settings.providerProtocol,
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
    // Delegate credential stripping to sanitizeProviderBaseUrl, which uses
    // authority-scoped lastIndexOf('@') and port detection instead of the
    // naive indexOf that misidentifies ports and passwords containing '@'.
    // #8136.
    //
    // The URL_LIKE_PATTERN stops at whitespace, but credentials may contain
    // spaces (e.g. "user:sec ret@host"). The old sanitizeProviderWarningSegment
    // handled this by searching the full segment for '@'; we preserve that
    // behavior by first trying to strip credentials from the whole segment,
    // then sanitizing any URL-like substrings in the remainder.
    result += sanitizeSegmentCredentials(segment);

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

/**
 * Strip credentials from a URL-containing segment, handling passwords with
 * spaces (which URL_LIKE_PATTERN cannot match) by searching the full segment
 * for the last '@' within the URL authority, then delegating any remaining
 * URL-like substrings to sanitizeProviderBaseUrl for authority-scoped
 * credential stripping. #8136.
 */
function sanitizeSegmentCredentials(segment: string): string {
  // First, try the full segment as a URL through sanitizeProviderBaseUrl.
  // If the segment contains a space in the userinfo (e.g. "user:sec ret@host"),
  // new URL() will throw and the fallback uses lastIndexOf('@') within the
  // authority scope.
  const sanitized = sanitizeProviderBaseUrl(segment);
  if (sanitized !== segment) {
    return sanitized;
  }

  // Fall back to per-URL-fragment sanitization for segments that contain
  // multiple URLs or non-URL text.
  return segment.replace(URL_LIKE_PATTERN, (url) =>
    sanitizeProviderBaseUrl(url),
  );
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
