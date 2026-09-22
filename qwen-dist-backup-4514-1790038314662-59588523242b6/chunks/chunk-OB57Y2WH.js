// Force strict mode and setup for ESM
"use strict";
import {
  AuthType
} from "./chunk-SBP43AO6.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/modelId.ts
init_esbuild_shims();
var AUTH_TYPES = new Set(Object.values(AuthType));
function resolveModelId(model, context = {}) {
  return resolveModelIdSelector(parseModelIdSelector(model), context);
}
__name(resolveModelId, "resolveModelId");
function buildModelIdContext(config) {
  return {
    currentModel: config.getModel?.(),
    currentAuthType: config.getContentGeneratorConfig?.()?.authType,
    fastModel: config.getFastModel?.(),
    getAvailableModels: /* @__PURE__ */ __name((authTypes) => config.getAllConfiguredModels?.(authTypes) ?? [], "getAvailableModels")
  };
}
__name(buildModelIdContext, "buildModelIdContext");
function parseModelIdSelector(model) {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === "inherit") {
    return { kind: "inherit" };
  }
  if (trimmed === "fast") {
    return { kind: "fast" };
  }
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex === -1) {
    return { kind: "model", modelId: trimmed };
  }
  const maybeAuthType = trimmed.slice(0, colonIndex).trim();
  const modelId = trimmed.slice(colonIndex + 1).trim();
  if (!AUTH_TYPES.has(maybeAuthType)) {
    return { kind: "model", modelId: trimmed };
  }
  if (!modelId) {
    throw new Error(
      "Model selector must include a model ID after the authType"
    );
  }
  return {
    kind: "model",
    authType: maybeAuthType,
    modelId
  };
}
__name(parseModelIdSelector, "parseModelIdSelector");
function resolveAuthTypeForBareModel(modelId, context) {
  if (context.currentAuthType && context.getAvailableModels) {
    const currentModels = context.getAvailableModels([context.currentAuthType]);
    if (currentModels.some((model) => model.id === modelId)) {
      return context.currentAuthType;
    }
  }
  const configuredModel = context.getAvailableModels ? context.getAvailableModels().find((model) => model.id === modelId) : void 0;
  return configuredModel?.authType ?? context.currentAuthType;
}
__name(resolveAuthTypeForBareModel, "resolveAuthTypeForBareModel");
function resolveModelIdSelector(selector, context) {
  if (selector.kind === "model") {
    const authType = selector.authType ?? resolveAuthTypeForBareModel(selector.modelId, context);
    return {
      ...authType ? { authType } : {},
      modelId: selector.modelId
    };
  }
  if (selector.kind === "inherit") {
    return context.currentModel ? {
      ...context.currentAuthType ? { authType: context.currentAuthType } : {},
      modelId: context.currentModel
    } : void 0;
  }
  if (!context.fastModel) {
    return void 0;
  }
  const fastSelector = parseModelIdSelector(context.fastModel);
  if (fastSelector.kind === "fast") {
    return void 0;
  }
  return resolveModelIdSelector(fastSelector, {
    ...context,
    fastModel: void 0
  });
}
__name(resolveModelIdSelector, "resolveModelIdSelector");

export {
  resolveModelId,
  buildModelIdContext
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
