// Force strict mode and setup for ESM
"use strict";
import {
  buildModelReasoningRoutePreview
} from "./chunk-BKF7NYFD.js";
import {
  snapshotProcessEnv
} from "./chunk-E3OBB2PK.js";
import {
  STATUS_SCHEMA_VERSION
} from "./chunk-SIUR4U2P.js";
import {
  getAuthTypeFromEnv,
  resolveCliGenerationConfig
} from "./chunk-WL5NKCV3.js";
import {
  getModelConfigurationKey
} from "./chunk-Q6KNCHCH.js";
import {
  ACP_ROUTE_ID_PREFIX,
  buildAcpModelOptions,
  getCurrentAcpModelId,
  parseAcpBaseModelId,
  sanitizeProviderBaseUrl
} from "./chunk-Y3Q5OK4D.js";
import {
  loadSettings
} from "./chunk-DRYBBTI5.js";
import {
  APPROVAL_MODES
} from "./chunk-JX6XHPTX.js";
import {
  ModelsConfig,
  resolveReasoningCapabilities
} from "./chunk-TLS6QN2S.js";
import {
  tokenLimit
} from "./chunk-KUON6Z6R.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/workspace-providers-status.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("WORKSPACE_PROVIDERS_STATUS");
function createWorkspaceProvidersStatusProvider(options = {}) {
  return async (workspaceCwd, acpChannelLive) => buildWorkspaceProvidersStatus(workspaceCwd, acpChannelLive, options);
}
__name(createWorkspaceProvidersStatusProvider, "createWorkspaceProvidersStatusProvider");
function buildWorkspaceProvidersStatus(workspaceCwd, acpChannelLive, options) {
  try {
    const loaded = loadSettings(
      workspaceCwd,
      options.env ? {
        skipLoadEnvironment: true,
        skipWorkspaceSettings: options.workspaceTrusted === false,
        workspaceTrusted: options.workspaceTrusted
      } : {
        consumeCorruptionEnvVars: true,
        skipLoadEnvironment: options.workspaceTrusted === false,
        skipWorkspaceSettings: options.workspaceTrusted === false,
        workspaceTrusted: options.workspaceTrusted
      }
    );
    const settings = loaded.merged;
    const env = options.env ?? snapshotProcessEnv();
    const selectedAuthType = settings.security?.auth?.selectedType ?? getAuthTypeFromEnv(env);
    const argv = {
      model: options.argv?.model,
      openaiApiKey: options.argv?.openaiApiKey,
      openaiBaseUrl: options.argv?.openaiBaseUrl,
      openaiLogging: options.argv?.openaiLogging,
      openaiLoggingDir: options.argv?.openaiLoggingDir
    };
    const resolvedCliConfig = resolveCliGenerationConfig({
      argv,
      settings,
      selectedAuthType,
      env
    });
    const modelsConfig = new ModelsConfig({
      initialAuthType: resolvedCliConfig.authType,
      modelProvidersConfig: settings.modelProviders,
      providerProtocolConfig: settings.providerProtocol,
      generationConfig: resolvedCliConfig.generationConfig,
      generationConfigSources: resolvedCliConfig.sources
    });
    const currentAuth = resolvedCliConfig.authType;
    const currentModelId = (resolvedCliConfig.model || modelsConfig.getModel() || "").trim();
    const hasCurrentModel = currentModelId.length > 0;
    const modelCameFromSettings = !argv.model && settings.model?.name?.trim() === currentModelId;
    const currentBaseUrl = modelCameFromSettings && settings.model?.baseUrl !== void 0 ? settings.model.baseUrl || void 0 : resolvedCliConfig.sources["baseUrl"] ? resolvedCliConfig.baseUrl || void 0 : void 0;
    const currentRegistryBaseUrl = modelCameFromSettings && currentAuth ? settings.model?.baseUrl !== void 0 ? settings.model.baseUrl || null : modelsConfig.getResolvedModel(currentAuth, currentModelId)?.registryBaseUrl ?? null : void 0;
    const modelOptions = buildAcpModelOptions(
      modelsConfig.getAllConfiguredModels()
    );
    const currentAcpModelId = hasCurrentModel ? getCurrentAcpModelId(
      modelOptions,
      currentModelId,
      currentAuth,
      currentRegistryBaseUrl
    ) : void 0;
    const fastModelId = typeof settings.fastModel === "string" && settings.fastModel.length > 0 ? settings.fastModel : void 0;
    const visionModelId = typeof settings.visionModel === "string" && settings.visionModel.length > 0 ? settings.visionModel : void 0;
    const approvalMode = resolveApprovalMode(settings);
    const providers = /* @__PURE__ */ new Map();
    for (const option of modelOptions) {
      const { model, effectiveModelId, modelId } = option;
      if (model.isRuntimeModel) continue;
      const authType = String(model.authType);
      let provider = providers.get(authType);
      if (!provider) {
        provider = {
          kind: "model_provider",
          status: "ok",
          authType,
          current: false,
          models: []
        };
        providers.set(authType, provider);
      }
      const isCurrent = currentAuth === model.authType && currentAcpModelId === modelId;
      const resolved = modelsConfig.getResolvedModel(
        model.authType,
        model.id,
        model.registryBaseUrl
      );
      const generation = {
        ...resolved?.generationConfig,
        model: model.id,
        authType: model.authType,
        baseUrl: resolved?.baseUrl
      };
      const configOptions = buildModelReasoningRoutePreview(
        generation,
        resolveReasoningCapabilities(generation, model.capabilities?.reasoning),
        settings.model?.reasoningEffort,
        modelId.startsWith(ACP_ROUTE_ID_PREFIX)
      );
      const configurationKey = getModelConfigurationKey(
        loaded,
        authType,
        model.id,
        model.registryBaseUrl
      );
      const providerModel = {
        ...configurationKey ? { configurationKey } : {},
        modelId,
        baseModelId: parseAcpBaseModelId(effectiveModelId),
        name: model.label,
        ...model.description !== void 0 ? { description: model.description } : {},
        // A non-positive contextWindowSize is meaningless (the SDK rejects it
        // on the wire); treat it as unset and fall back to the estimate.
        contextLimit: model.contextWindowSize !== void 0 && model.contextWindowSize > 0 ? model.contextWindowSize : tokenLimit(effectiveModelId),
        ...model.modalities !== void 0 ? { modalities: model.modalities } : {},
        ...model.baseUrl !== void 0 ? { baseUrl: sanitizeProviderBaseUrl(model.baseUrl) } : {},
        ...model.envKey !== void 0 ? { envKey: model.envKey } : {},
        isCurrent,
        isRuntime: false,
        ...configOptions ? { configOptions } : {}
      };
      provider.models.push(providerModel);
      if (isCurrent) provider.current = true;
    }
    const current = buildCurrent(
      currentAuth,
      currentAcpModelId,
      currentBaseUrl,
      fastModelId,
      visionModelId
    );
    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd,
      initialized: true,
      acpChannelLive,
      ...current ? { current } : {},
      approvalMode,
      providers: [...providers.values()],
      ...resolvedCliConfig.warnings.length > 0 ? {
        errors: resolvedCliConfig.warnings.map((warning) => ({
          kind: "providers",
          status: "warning",
          error: sanitizeProviderWarning(warning)
        }))
      } : {}
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
          kind: "providers",
          status: "error",
          error: sanitizeProviderWarning(
            error instanceof Error ? error.message : String(error)
          )
        }
      ]
    };
  }
}
__name(buildWorkspaceProvidersStatus, "buildWorkspaceProvidersStatus");
function resolveApprovalMode(settings) {
  const value = settings.tools?.approvalMode;
  if (typeof value !== "string") return "auto" /* AUTO */;
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  const mode = normalized === "autoedit" ? "auto-edit" /* AUTO_EDIT */ : normalized;
  if (APPROVAL_MODES.includes(mode)) {
    return mode;
  }
  if (value.trim().length > 0) {
    debugLogger.warn(
      `[workspace-providers-status] unrecognized approvalMode "${value}", falling back to auto`
    );
  }
  return "auto" /* AUTO */;
}
__name(resolveApprovalMode, "resolveApprovalMode");
var URL_LIKE_PATTERN = /\b[A-Za-z][A-Za-z\d+.-]*:\/\/[^\s'"`<>]+/g;
var URL_START_PATTERN = /\b[A-Za-z][A-Za-z\d+.-]*:\/\//g;
function sanitizeProviderWarning(warning) {
  let result = "";
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
__name(sanitizeProviderWarning, "sanitizeProviderWarning");
function findNextUrlStart(value, from) {
  URL_START_PATTERN.lastIndex = from;
  const match = URL_START_PATTERN.exec(value);
  return match ? { index: match.index, marker: match[0] } : void 0;
}
__name(findNextUrlStart, "findNextUrlStart");
function findUrlSegmentEnd(value, start, marker) {
  const afterMarker = start + marker.length;
  const carriageReturn = value.indexOf("\r", afterMarker);
  const lineFeed = value.indexOf("\n", afterMarker);
  let lineEnd = value.length;
  if (carriageReturn !== -1) lineEnd = Math.min(lineEnd, carriageReturn);
  if (lineFeed !== -1) lineEnd = Math.min(lineEnd, lineFeed);
  const nextUrl = findNextUrlStart(value, afterMarker);
  return Math.min(lineEnd, nextUrl?.index ?? value.length);
}
__name(findUrlSegmentEnd, "findUrlSegmentEnd");
function sanitizeProviderWarningSegment(segment, markerLength) {
  const at = segment.indexOf("@", markerLength);
  if (at !== -1 && hasCredentialPrefix(segment, markerLength, at) && segment[at + 1] !== void 0 && /[A-Za-z0-9.[\]-]/.test(segment[at + 1])) {
    return `${segment.slice(0, markerLength)}${segment.slice(at + 1)}`;
  }
  return segment.replace(
    URL_LIKE_PATTERN,
    (url) => sanitizeProviderBaseUrl(url)
  );
}
__name(sanitizeProviderWarningSegment, "sanitizeProviderWarningSegment");
function hasCredentialPrefix(segment, markerLength, at) {
  const colon = segment.indexOf(":", markerLength);
  if (colon === -1 || colon > at) return false;
  const username = segment.slice(markerLength, colon);
  return !/[/?#\s'"`<>]/.test(username);
}
__name(hasCredentialPrefix, "hasCredentialPrefix");
function buildCurrent(authType, modelId, baseUrl, fastModelId, visionModelId) {
  if (!authType && !modelId && !baseUrl && !fastModelId && !visionModelId)
    return void 0;
  return {
    ...authType ? { authType: String(authType) } : {},
    ...modelId ? { modelId } : {},
    ...baseUrl ? { baseUrl: sanitizeProviderBaseUrl(baseUrl) } : {},
    ...fastModelId ? { fastModelId } : {},
    ...visionModelId ? { visionModelId } : {}
  };
}
__name(buildCurrent, "buildCurrent");

export {
  createWorkspaceProvidersStatusProvider
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
