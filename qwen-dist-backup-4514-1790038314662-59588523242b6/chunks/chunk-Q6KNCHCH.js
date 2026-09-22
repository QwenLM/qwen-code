// Force strict mode and setup for ESM
"use strict";
import {
  publicProviderBaseUrl
} from "./chunk-Y3Q5OK4D.js";
import {
  getWritableScopes
} from "./chunk-DRYBBTI5.js";
import {
  isImageGenerationCapable,
  tryResolveModelProtocol
} from "./chunk-TLS6QN2S.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/model-configuration.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
function modelKey(scope, provider, model, authType) {
  return createHash("sha256").update(
    JSON.stringify([
      scope,
      provider,
      model.id,
      model.baseUrl ?? "",
      authType
    ])
  ).digest("hex");
}
__name(modelKey, "modelKey");
function modelEntries(loaded) {
  const seenProviders = /* @__PURE__ */ new Set();
  return [
    "System" /* System */,
    ...getWritableScopes(loaded),
    "SystemDefaults" /* SystemDefaults */
  ].flatMap((scope) => {
    const providers = loaded.forScope(scope).settings.modelProviders ?? {};
    return Object.entries(providers).flatMap(([provider, models]) => {
      if (seenProviders.has(provider)) return [];
      seenProviders.add(provider);
      if (!Array.isArray(models)) return [];
      return models.flatMap((model, index) => {
        if (!model || typeof model !== "object" || typeof model.id !== "string" || !model.id || model.baseUrl !== void 0 && typeof model.baseUrl !== "string")
          return [];
        const authType = tryResolveModelProtocol(
          provider,
          model,
          loaded.merged.providerProtocol
        );
        if (!authType || authType === "qwen-oauth") return [];
        return [
          {
            scope,
            provider,
            authType,
            model,
            index,
            key: modelKey(scope, provider, model, authType)
          }
        ];
      });
    });
  });
}
__name(modelEntries, "modelEntries");
function findModelConfiguration(loaded, key) {
  const matches = modelEntries(loaded).filter((entry) => entry.key === key);
  return matches.length === 1 && getWritableScopes(loaded).includes(matches[0].scope) ? matches[0] : void 0;
}
__name(findModelConfiguration, "findModelConfiguration");
function findModelConfigurationForDeletion(loaded, target) {
  const candidates = modelEntries(loaded).filter(
    (entry) => entry.authType === target.authType && entry.model.id === target.modelId
  );
  const exact = candidates.filter(
    (entry) => (entry.model.baseUrl ?? void 0) === target.baseUrl
  );
  const matches = target.baseUrl !== void 0 && exact.length ? exact : candidates;
  if (matches.length === 0) return void 0;
  return matches.length === 1 && getWritableScopes(loaded).includes(matches[0].scope) ? matches[0] : "ambiguous";
}
__name(findModelConfigurationForDeletion, "findModelConfigurationForDeletion");
function getModelConfigurationKey(loaded, authType, modelId, baseUrl) {
  const matches = modelEntries(loaded).filter(
    (entry) => entry.authType === authType && entry.model.id === modelId && (entry.model.baseUrl ?? "") === (baseUrl ?? "")
  );
  return matches.length === 1 && getWritableScopes(loaded).includes(matches[0].scope) ? matches[0].key : void 0;
}
__name(getModelConfigurationKey, "getModelConfigurationKey");
function isConversationModelConfiguration(model) {
  return !model.imageOnly && !model.voiceOnly && !model.fastOnly && !model.visionOnly;
}
__name(isConversationModelConfiguration, "isConversationModelConfiguration");
function isImageModelConfiguration(model) {
  if (!isImageGenerationCapable(model) || model.fastOnly || model.voiceOnly || !model.baseUrl || typeof model.envKey !== "string" || !model.envKey.trim())
    return false;
  try {
    const url = new URL(model.baseUrl);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}
__name(isImageModelConfiguration, "isImageModelConfiguration");
function listModelConfigurations(loaded) {
  const entries = modelEntries(loaded);
  const routeKey = /* @__PURE__ */ __name((entry) => JSON.stringify([entry.authType, entry.model.id, entry.model.baseUrl ?? ""]), "routeKey");
  const counts = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const route = routeKey(entry);
    counts.set(route, (counts.get(route) ?? 0) + 1);
  }
  const writableScopes = getWritableScopes(loaded);
  return entries.filter((entry) => writableScopes.includes(entry.scope)).map((entry) => {
    const { model, authType, key } = entry;
    const uniqueRoute = counts.get(routeKey(entry)) === 1;
    let imageModel;
    let advisorModel;
    if (uniqueRoute && isConversationModelConfiguration(model)) {
      if (!model.baseUrl) advisorModel = `${authType}:${model.id}\0`;
      else {
        try {
          const url = new URL(model.baseUrl);
          if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash)
            advisorModel = `${authType}:${model.id}\0${model.baseUrl}`;
        } catch {
        }
      }
    }
    if (uniqueRoute && isImageModelConfiguration(model)) {
      imageModel = `${authType}:${model.id}\0${model.baseUrl}`;
    }
    return {
      key,
      authType,
      modelId: model.id,
      name: model.name,
      baseUrl: model.baseUrl ? publicProviderBaseUrl(model.baseUrl) : void 0,
      envKey: typeof model.envKey === "string" ? model.envKey : void 0,
      contextWindowSize: typeof model.generationConfig?.contextWindowSize === "number" && Number.isInteger(model.generationConfig.contextWindowSize) && model.generationConfig.contextWindowSize > 0 ? model.generationConfig.contextWindowSize : void 0,
      canEditContextWindow: uniqueRoute,
      purpose: model.imageOnly === true ? "image" : model.voiceOnly === true ? "voice" : "chat",
      ...imageModel ? { imageModel } : {},
      ...advisorModel ? { advisorModel } : {}
    };
  });
}
__name(listModelConfigurations, "listModelConfigurations");
function updateModelContextWindow(loaded, key, contextWindowSize, assertGenerationOpen) {
  const match = findModelConfiguration(loaded, key);
  if (!match) return void 0;
  if (getModelConfigurationKey(
    loaded,
    match.authType,
    match.model.id,
    match.model.baseUrl
  ) !== key)
    return void 0;
  const { scope, provider, index } = match;
  const providers = loaded.forScope(scope).originalSettings.modelProviders ?? {};
  const model = providers[provider][index];
  const generationConfig = { ...model.generationConfig };
  if (contextWindowSize === null) delete generationConfig.contextWindowSize;
  else generationConfig.contextWindowSize = contextWindowSize;
  const updated = { ...model, generationConfig };
  if (Object.keys(generationConfig).length === 0)
    delete updated.generationConfig;
  loaded.setValue(
    scope,
    "modelProviders",
    {
      ...providers,
      [provider]: providers[provider].map(
        (entry, i) => i === index ? updated : entry
      )
    },
    assertGenerationOpen,
    { throwOnWriteFailure: true }
  );
  return scope === "Workspace" /* Workspace */ ? "workspace" : "user";
}
__name(updateModelContextWindow, "updateModelContextWindow");

export {
  findModelConfiguration,
  findModelConfigurationForDeletion,
  getModelConfigurationKey,
  isConversationModelConfiguration,
  isImageModelConfiguration,
  listModelConfigurations,
  updateModelContextWindow
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
