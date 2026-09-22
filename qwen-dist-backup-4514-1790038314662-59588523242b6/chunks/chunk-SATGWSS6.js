// Force strict mode and setup for ESM
"use strict";
import {
  DashScopeOpenAICompatibleProvider
} from "./chunk-WNM6BA7E.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/upload-config.ts
init_esbuild_shims();
var QWEN_OAUTH_PLACEHOLDER_API_KEY = "QWEN_OAUTH_DYNAMIC_TOKEN";
var ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
var OmniUploadConfigError = class extends Error {
  static {
    __name(this, "OmniUploadConfigError");
  }
  constructor(message) {
    super(message);
    this.name = "OmniUploadConfigError";
  }
};
function normalizeDedicatedOmniUploadConfig(raw, env = process.env) {
  const configured = raw.baseUrl !== void 0 || raw.apiKeyEnv !== void 0 || raw.model !== void 0;
  if (!configured) return void 0;
  const baseUrl = raw.baseUrl?.trim();
  const apiKeyEnv = raw.apiKeyEnv?.trim();
  const model = raw.model?.trim();
  if (!baseUrl || !apiKeyEnv || !model) {
    throw new OmniUploadConfigError(
      "omni.delivery.upload.baseUrl, apiKeyEnv, and model must all be set when a dedicated upload channel is configured."
    );
  }
  if (!ENV_VAR_NAME_PATTERN.test(apiKeyEnv)) {
    throw new OmniUploadConfigError(
      "omni.delivery.upload.apiKeyEnv must be a valid environment variable name."
    );
  }
  if (!DashScopeOpenAICompatibleProvider.isDashScopeProvider({
    authType: "openai" /* USE_OPENAI */,
    baseUrl
  })) {
    throw new OmniUploadConfigError(
      "omni.delivery.upload.baseUrl must be a DashScope-compatible endpoint."
    );
  }
  const apiKey = env[apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new OmniUploadConfigError(
      `omni.delivery.upload.apiKeyEnv names ${apiKeyEnv}, but that environment variable is not set or is empty.`
    );
  }
  return { baseUrl, apiKey, model };
}
__name(normalizeDedicatedOmniUploadConfig, "normalizeDedicatedOmniUploadConfig");
function resolveLegacyOmniUploadConfig(contentGeneratorConfig, model) {
  if (!contentGeneratorConfig || contentGeneratorConfig.authType === "qwen-oauth" /* QWEN_OAUTH */ || !contentGeneratorConfig.apiKey || contentGeneratorConfig.apiKey === QWEN_OAUTH_PLACEHOLDER_API_KEY || !contentGeneratorConfig.baseUrl || !model || !DashScopeOpenAICompatibleProvider.isDashScopeProvider(
    contentGeneratorConfig
  )) {
    return void 0;
  }
  return {
    baseUrl: contentGeneratorConfig.baseUrl,
    apiKey: contentGeneratorConfig.apiKey,
    model
  };
}
__name(resolveLegacyOmniUploadConfig, "resolveLegacyOmniUploadConfig");
function getEffectiveOmniUploadConfig(config) {
  const dedicated = config.getOmniUploadConfig?.();
  if (dedicated) return dedicated;
  return resolveLegacyOmniUploadConfig(
    config.getContentGeneratorConfig?.(),
    config.getModel?.()
  );
}
__name(getEffectiveOmniUploadConfig, "getEffectiveOmniUploadConfig");
function requireEffectiveOmniUploadConfig(config) {
  const upload = getEffectiveOmniUploadConfig(config);
  if (!upload) {
    throw new OmniUploadConfigError(
      "Omni upload is not configured. Set all of omni.delivery.upload.baseUrl, apiKeyEnv, and model, or use a static DashScope inference configuration."
    );
  }
  return upload;
}
__name(requireEffectiveOmniUploadConfig, "requireEffectiveOmniUploadConfig");

export {
  OmniUploadConfigError,
  normalizeDedicatedOmniUploadConfig,
  getEffectiveOmniUploadConfig,
  requireEffectiveOmniUploadConfig
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
