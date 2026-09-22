// Force strict mode and setup for ESM
"use strict";
import {
  external_exports
} from "./chunk-CQ35AJ4Z.js";
import {
  AuthType
} from "./chunk-SBP43AO6.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/acpModelUtils.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
var ACP_ROUTE_ID_PREFIX = "qwen-route:v1:";
function publicProviderBaseUrl(baseUrl) {
  if (!/^https?:\/\//i.test(baseUrl.trim())) return void 0;
  try {
    const url = new URL(baseUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return void 0;
  }
}
__name(publicProviderBaseUrl, "publicProviderBaseUrl");
function getRouteEndpointIdentity(baseUrl) {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return sanitizeProviderBaseUrl(baseUrl).split(/[?#]/, 1)[0] ?? null;
  }
}
__name(getRouteEndpointIdentity, "getRouteEndpointIdentity");
function formatAcpModelId(modelId, authType) {
  return `${modelId}(${authType})`;
}
__name(formatAcpModelId, "formatAcpModelId");
function buildAcpModelOptions(models) {
  const candidates = models.filter(
    (model) => model.fastOnly !== true && model.voiceOnly !== true && model.imageOnly !== true
  ).map((model) => {
    const effectiveModelId = model.isRuntimeModel && model.runtimeSnapshotId ? model.runtimeSnapshotId : model.id;
    return {
      model,
      effectiveModelId,
      legacyModelId: formatAcpModelId(effectiveModelId, model.authType)
    };
  });
  const counts = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    counts.set(
      candidate.legacyModelId,
      (counts.get(candidate.legacyModelId) ?? 0) + 1
    );
  }
  const discriminators = /* @__PURE__ */ new Set();
  return candidates.map(({ model, effectiveModelId, legacyModelId }) => {
    const discriminator = [
      legacyModelId,
      model.label,
      model.envKey ?? null,
      model.registryBaseUrl === void 0,
      getRouteEndpointIdentity(model.registryBaseUrl ?? model.baseUrl)
    ];
    const discriminatorKey = JSON.stringify(discriminator);
    if (counts.get(legacyModelId) !== 1 && discriminators.has(discriminatorKey)) {
      throw new Error(
        `ACP model routes for "${legacyModelId}" need distinct names, envKey values, or public endpoints.`
      );
    }
    discriminators.add(discriminatorKey);
    return {
      model,
      effectiveModelId,
      modelId: counts.get(legacyModelId) === 1 ? legacyModelId : `${ACP_ROUTE_ID_PREFIX}${createHash("sha256").update(discriminatorKey).digest("base64url").slice(0, 16)}`
    };
  });
}
__name(buildAcpModelOptions, "buildAcpModelOptions");
function resolveAcpModelOption(input, models) {
  const matched = buildAcpModelOptions(models).find(
    (option) => option.modelId === input.trim()
  );
  if (!matched) return null;
  return {
    modelId: matched.effectiveModelId,
    authType: matched.model.authType,
    ...matched.model.registryBaseUrl !== void 0 ? { baseUrl: matched.model.registryBaseUrl } : {},
    ...!matched.model.isRuntimeModel ? { registryBaseUrl: matched.model.registryBaseUrl ?? null } : {},
    isRuntime: matched.model.isRuntimeModel === true
  };
}
__name(resolveAcpModelOption, "resolveAcpModelOption");
function getCurrentAcpModelId(options, modelId, authType, registryBaseUrl) {
  if (!modelId || !authType) return modelId;
  const matching = options.filter(
    (option) => option.effectiveModelId === modelId && option.model.authType === authType
  );
  if (matching[0]?.model.isRuntimeModel) return matching[0].modelId;
  if (registryBaseUrl !== void 0) {
    const exact = matching.find(
      (option) => (option.model.registryBaseUrl ?? null) === registryBaseUrl
    );
    return exact?.modelId ?? modelId;
  }
  return matching.length === 1 ? matching[0].modelId : formatAcpModelId(modelId, authType);
}
__name(getCurrentAcpModelId, "getCurrentAcpModelId");
function sanitizeProviderBaseUrl(baseUrl) {
  const scheme = baseUrl.match(/^[A-Za-z][A-Za-z\d+.-]*:\/\//);
  if (!scheme) {
    return baseUrl;
  }
  const authorityStart = scheme[0].length;
  const stripAt = /* @__PURE__ */ __name((at) => `${baseUrl.slice(0, authorityStart)}${baseUrl.slice(at + 1)}`, "stripAt");
  const authorityEnd = findAuthorityEnd(baseUrl, authorityStart);
  const authorityAt = baseUrl.slice(authorityStart, authorityEnd).lastIndexOf("@");
  const authorityAtIndex = authorityAt === -1 ? -1 : authorityStart + authorityAt;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.username || parsed.password) {
      return authorityAtIndex >= authorityStart ? stripAt(authorityAtIndex) : baseUrl;
    }
    return baseUrl;
  } catch {
    if (authorityAtIndex >= authorityStart) {
      return stripAt(authorityAtIndex);
    }
    const fallbackAt = findUnescapedUserInfoFallbackAt(
      baseUrl,
      authorityStart,
      authorityEnd
    );
    return fallbackAt === -1 ? baseUrl : stripAt(fallbackAt);
  }
}
__name(sanitizeProviderBaseUrl, "sanitizeProviderBaseUrl");
function findUnescapedUserInfoFallbackAt(baseUrl, authorityStart, authorityEnd) {
  const at = baseUrl.lastIndexOf("@");
  if (at < authorityStart || authorityEnd >= at) {
    return -1;
  }
  const colon = baseUrl.indexOf(":", authorityStart);
  if (colon === -1 || colon > authorityEnd) {
    return -1;
  }
  const portCandidate = baseUrl.slice(colon + 1, authorityEnd);
  return /^\d+$/.test(portCandidate) ? -1 : at;
}
__name(findUnescapedUserInfoFallbackAt, "findUnescapedUserInfoFallbackAt");
function findAuthorityEnd(baseUrl, authorityStart) {
  const slash = baseUrl.indexOf("/", authorityStart);
  const query = baseUrl.indexOf("?", authorityStart);
  const hash = baseUrl.indexOf("#", authorityStart);
  let end = baseUrl.length;
  if (slash !== -1) end = Math.min(end, slash);
  if (query !== -1) end = Math.min(end, query);
  if (hash !== -1) end = Math.min(end, hash);
  return end;
}
__name(findAuthorityEnd, "findAuthorityEnd");
function parseAcpBaseModelId(value) {
  const trimmed = value.trim();
  const closeIdx = trimmed.lastIndexOf(")");
  const openIdx = trimmed.lastIndexOf("(");
  if (openIdx >= 0 && closeIdx === trimmed.length - 1 && openIdx < closeIdx) {
    return trimmed.slice(0, openIdx);
  }
  return trimmed;
}
__name(parseAcpBaseModelId, "parseAcpBaseModelId");
function parseAcpModelOption(input) {
  const trimmed = input.trim();
  const closeIdx = trimmed.lastIndexOf(")");
  const openIdx = trimmed.lastIndexOf("(");
  if (openIdx >= 0 && closeIdx === trimmed.length - 1 && openIdx < closeIdx) {
    const maybeModelId = trimmed.slice(0, openIdx);
    const maybeAuthType = trimmed.slice(openIdx + 1, closeIdx);
    const parsedAuthType = external_exports.nativeEnum(AuthType).safeParse(maybeAuthType);
    if (parsedAuthType.success) {
      return { modelId: maybeModelId, authType: parsedAuthType.data };
    }
  }
  return { modelId: trimmed };
}
__name(parseAcpModelOption, "parseAcpModelOption");
function isInlineModelOverrideAllowed(config, modelId) {
  const contentGeneratorConfig = config.getContentGeneratorConfig();
  const authType = contentGeneratorConfig?.authType;
  if (!authType) {
    return false;
  }
  const activeBaseUrl = contentGeneratorConfig.baseUrl;
  const activeEnvKey = contentGeneratorConfig.apiKeyEnvKey;
  return config.getAvailableModelsForAuthType(authType).filter((m) => !m.fastOnly && !m.voiceOnly && !m.imageOnly).some(
    (m) => m.id === modelId && (m.baseUrl ?? void 0) === (activeBaseUrl ?? void 0) && (m.envKey ?? void 0) === (activeEnvKey ?? void 0)
  );
}
__name(isInlineModelOverrideAllowed, "isInlineModelOverrideAllowed");

export {
  ACP_ROUTE_ID_PREFIX,
  publicProviderBaseUrl,
  buildAcpModelOptions,
  resolveAcpModelOption,
  getCurrentAcpModelId,
  sanitizeProviderBaseUrl,
  parseAcpBaseModelId,
  parseAcpModelOption,
  isInlineModelOverrideAllowed
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
