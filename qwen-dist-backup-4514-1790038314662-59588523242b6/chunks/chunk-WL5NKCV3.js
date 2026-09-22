// Force strict mode and setup for ESM
"use strict";
import {
  sanitizeProviderBaseUrl
} from "./chunk-Y3Q5OK4D.js";
import {
  resolveModelConfig
} from "./chunk-MRTRBONQ.js";
import {
  resolveModelSelectionAuthType,
  resolveProviderProtocol,
  stripRuntimeSnapshotPrefix,
  tryResolveModelProtocol
} from "./chunk-TLS6QN2S.js";
import {
  MODEL_GENERATION_CONFIG_FIELDS,
  REASONING_EFFORT_TIERS,
  normalizeReasoningEffort
} from "./chunk-KUON6Z6R.js";
import {
  AuthType
} from "./chunk-SBP43AO6.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/modelConfigUtils.ts
init_esbuild_shims();
var AUTH_ENV_MODEL_VARS = {
  ["openai" /* USE_OPENAI */]: ["OPENAI_MODEL", "QWEN_MODEL"],
  ["openai-responses" /* USE_OPENAI_RESPONSES */]: ["OPENAI_MODEL"],
  ["gemini" /* USE_GEMINI */]: ["GEMINI_MODEL"],
  ["vertex-ai" /* USE_VERTEX_AI */]: ["GOOGLE_MODEL"],
  ["anthropic" /* USE_ANTHROPIC */]: ["ANTHROPIC_MODEL"],
  ["qwen-oauth" /* QWEN_OAUTH */]: []
};
function collectProviderModelsForProtocol(modelProviders, providerProtocol, protocol) {
  if (!modelProviders) {
    return [];
  }
  const out = [];
  for (const [providerId, models] of Object.entries(modelProviders)) {
    if (!Array.isArray(models)) {
      continue;
    }
    out.push(
      ...models.filter(
        // tryResolveModelProtocol: one entry with an invalid `wireApi` (a
        // hand-edited settings file surviving a hot reload) must not take
        // down every read that walks the providers map — skip that entry.
        // Startup validation still classifies it as a FatalConfigError.
        (model) => tryResolveModelProtocol(providerId, model, providerProtocol) === protocol
      )
    );
  }
  return out;
}
__name(collectProviderModelsForProtocol, "collectProviderModelsForProtocol");
function findProviderIdForModel(modelProviders, providerProtocol, protocol, modelProvider) {
  if (!modelProviders || !modelProvider) {
    return void 0;
  }
  for (const [providerId, models] of Object.entries(modelProviders)) {
    if (!Array.isArray(models)) {
      continue;
    }
    if (models.includes(modelProvider) && tryResolveModelProtocol(providerId, modelProvider, providerProtocol) === protocol) {
      return providerId;
    }
  }
  return void 0;
}
__name(findProviderIdForModel, "findProviderIdForModel");
function buildSkippedProviderWarnings(modelProviders, providerProtocol) {
  if (!modelProviders) {
    return [];
  }
  const warnings = [];
  const known = Object.values(AuthType).filter((value) => value !== "openai-responses" /* USE_OPENAI_RESPONSES */).join(", ");
  for (const [providerId, models] of Object.entries(modelProviders)) {
    if (!Array.isArray(models) || models.length === 0) {
      continue;
    }
    const protocol = resolveProviderProtocol(providerId, providerProtocol);
    if (protocol === "qwen-oauth" /* QWEN_OAUTH */ && providerId !== "qwen-oauth" /* QWEN_OAUTH */) {
      warnings.push(
        `Warning: modelProviders provider "${providerId}" maps to "qwen-oauth" via providerProtocol, but qwen-oauth uses hard-coded models only; its ${models.length} model(s) are ignored.`
      );
      continue;
    }
    if (protocol !== void 0) {
      continue;
    }
    const mapped = providerProtocol && Object.hasOwn(providerProtocol, providerId) ? providerProtocol[providerId] : void 0;
    warnings.push(
      mapped !== void 0 ? `Warning: providerProtocol["${providerId}"] = "${mapped}" is not a known protocol (expected one of: ${known}); its ${models.length} model(s) are ignored.` : `Warning: modelProviders provider "${providerId}" is not a built-in protocol (${known}) and has no providerProtocol mapping; its ${models.length} model(s) are ignored. Add providerProtocol["${providerId}"] (e.g. "openai") to enable them.`
    );
  }
  return warnings;
}
__name(buildSkippedProviderWarnings, "buildSkippedProviderWarnings");
function getIgnoredTopLevelGenerationConfigFields(settingsGenerationConfig, modelProvider) {
  if (!settingsGenerationConfig || !modelProvider) {
    return [];
  }
  const providerGenerationConfig = modelProvider.generationConfig ?? {};
  return MODEL_GENERATION_CONFIG_FIELDS.filter(
    (field) => Object.hasOwn(settingsGenerationConfig, field) && !Object.hasOwn(providerGenerationConfig, field)
  );
}
__name(getIgnoredTopLevelGenerationConfigFields, "getIgnoredTopLevelGenerationConfigFields");
function buildIgnoredTopLevelGenerationConfigWarning(providerId, modelProvider, ignoredFields) {
  if (ignoredFields.length === 0) {
    return void 0;
  }
  const fieldList = ignoredFields.map((field) => `model.generationConfig.${field}`).join(", ");
  const isSingular = ignoredFields.length === 1;
  const verb = isSingular ? "is" : "are";
  const fieldReference = isSingular ? "this field" : "these fields";
  const pronoun = isSingular ? "it" : "them";
  return `Warning: ${fieldList} ${verb} ignored for provider model "${modelProvider.id}" from modelProviders.${providerId}. Move ${fieldReference} to modelProviders.${providerId}[].generationConfig for that model if you want ${pronoun} to apply.`;
}
__name(buildIgnoredTopLevelGenerationConfigWarning, "buildIgnoredTopLevelGenerationConfigWarning");
function getAuthTypeFromEnv(env = process.env) {
  if (env["QWEN_OAUTH"]) {
    return "qwen-oauth" /* QWEN_OAUTH */;
  }
  if (env["OPENAI_API_KEY"] && (env["OPENAI_MODEL"] || env["QWEN_MODEL"]) && env["OPENAI_BASE_URL"]) {
    return "openai" /* USE_OPENAI */;
  }
  if (env["GEMINI_API_KEY"] && env["GEMINI_MODEL"]) {
    return "gemini" /* USE_GEMINI */;
  }
  if (env["GOOGLE_API_KEY"] && env["GOOGLE_MODEL"]) {
    return "vertex-ai" /* USE_VERTEX_AI */;
  }
  if (env["GOOGLE_CLOUD_PROJECT"] && env["GOOGLE_MODEL"]) {
    return "vertex-ai" /* USE_VERTEX_AI */;
  }
  if (env["ANTHROPIC_API_KEY"] && env["ANTHROPIC_MODEL"] && env["ANTHROPIC_BASE_URL"]) {
    return "anthropic" /* USE_ANTHROPIC */;
  }
  return void 0;
}
__name(getAuthTypeFromEnv, "getAuthTypeFromEnv");
function resolveCliGenerationConfig(inputs) {
  const { argv, settings, selectedAuthType } = inputs;
  const env = inputs.env ?? process.env;
  let resolvedModel;
  let sourceEnvVar;
  let resolvedFromSettings = false;
  if (argv.model) {
    resolvedModel = argv.model;
  } else if (settings.model?.name) {
    resolvedModel = stripRuntimeSnapshotPrefix(settings.model.name);
    resolvedFromSettings = true;
  } else if (selectedAuthType && AUTH_ENV_MODEL_VARS[selectedAuthType]) {
    for (const envVar of AUTH_ENV_MODEL_VARS[selectedAuthType]) {
      if (env[envVar]) {
        resolvedModel = env[envVar];
        sourceEnvVar = envVar;
        break;
      }
    }
  }
  const authType = selectedAuthType && resolvedModel !== void 0 ? resolveModelSelectionAuthType(
    selectedAuthType,
    resolvedModel,
    settings.modelProviders,
    settings.providerProtocol,
    resolvedFromSettings ? settings.model?.baseUrl : void 0
  ) : selectedAuthType;
  let modelProvider;
  let disambiguationWarning;
  if (resolvedModel && authType && settings.modelProviders) {
    const providers = collectProviderModelsForProtocol(
      settings.modelProviders,
      settings.providerProtocol,
      authType
    );
    if (providers.length > 0) {
      const persistedBaseUrl = settings.model?.baseUrl;
      if (resolvedFromSettings && persistedBaseUrl) {
        const exactMatch = providers.find(
          (p) => p.id === resolvedModel && p.baseUrl === persistedBaseUrl
        );
        modelProvider = exactMatch ?? providers.find((p) => p.id === resolvedModel);
        if (!exactMatch && modelProvider) {
          const fallbackBaseUrl = modelProvider.baseUrl === void 0 ? "(default baseUrl)" : sanitizeProviderBaseUrl(modelProvider.baseUrl);
          disambiguationWarning = `Persisted model.baseUrl '${sanitizeProviderBaseUrl(persistedBaseUrl)}' no longer matches any provider for model '${resolvedModel}' (authType '${authType}'); using the first id match ('${fallbackBaseUrl}'). Re-select the model to update it.`;
        }
      } else {
        modelProvider = providers.find((p) => p.id === resolvedModel);
      }
    }
  }
  const allModelEnvVars = Object.values(AUTH_ENV_MODEL_VARS).flat();
  const filteredEnv = { ...env };
  if (sourceEnvVar) {
    for (const envVar of allModelEnvVars) {
      if (envVar !== sourceEnvVar) {
        delete filteredEnv[envVar];
      }
    }
  } else {
    for (const envVar of allModelEnvVars) {
      delete filteredEnv[envVar];
    }
  }
  const configSources = {
    authType,
    cli: {
      model: argv.model,
      apiKey: argv.openaiApiKey,
      baseUrl: argv.openaiBaseUrl
    },
    settings: {
      model: settings.model?.name ? stripRuntimeSnapshotPrefix(settings.model.name) : void 0,
      apiKey: settings.security?.auth?.apiKey,
      baseUrl: settings.security?.auth?.baseUrl,
      generationConfig: settings.model?.generationConfig
    },
    modelProvider,
    env: filteredEnv
  };
  const resolved = resolveModelConfig(configSources);
  const ignoredGenerationConfigWarning = authType && modelProvider ? buildIgnoredTopLevelGenerationConfigWarning(
    findProviderIdForModel(
      settings.modelProviders,
      settings.providerProtocol,
      authType,
      modelProvider
    ) ?? authType,
    modelProvider,
    getIgnoredTopLevelGenerationConfigFields(
      settings.model?.generationConfig,
      modelProvider
    )
  ) : void 0;
  const enableOpenAILogging = (typeof argv.openaiLogging === "undefined" ? settings.model?.enableOpenAILogging : argv.openaiLogging) ?? false;
  const openAILoggingDir = argv.openaiLoggingDir || settings.model?.openAILoggingDir;
  const generationConfig = {
    ...resolved.config,
    enableOpenAILogging,
    openAILoggingDir
  };
  const rawReasoningEffort = settings.model?.reasoningEffort;
  const reasoningDisabled = rawReasoningEffort === "none";
  const reasoningEffort = reasoningDisabled ? void 0 : normalizeReasoningEffort(rawReasoningEffort);
  const invalidReasoningEffortWarning = rawReasoningEffort && !reasoningDisabled && !reasoningEffort ? `Ignoring invalid model.reasoningEffort "${rawReasoningEffort}"; expected one of: none, ${REASONING_EFFORT_TIERS.join(", ")}.` : void 0;
  if (reasoningDisabled && generationConfig.thinkingMandatory !== true) {
    generationConfig.reasoning = false;
  } else if (reasoningEffort && generationConfig.reasoning !== false) {
    generationConfig.reasoning = {
      ...generationConfig.reasoning ?? {},
      effort: reasoningEffort
    };
  }
  return {
    authType,
    model: resolved.config.model || "",
    apiKey: resolved.config.apiKey || "",
    baseUrl: resolved.config.baseUrl || "",
    generationConfig,
    ...modelProvider ? { registryBaseUrl: modelProvider.baseUrl ?? null } : {},
    sources: resolved.sources,
    warnings: [
      ...resolved.warnings,
      ...invalidReasoningEffortWarning ? [invalidReasoningEffortWarning] : [],
      ...disambiguationWarning ? [disambiguationWarning] : [],
      ...ignoredGenerationConfigWarning ? [ignoredGenerationConfigWarning] : [],
      ...buildSkippedProviderWarnings(
        settings.modelProviders,
        settings.providerProtocol
      )
    ]
  };
}
__name(resolveCliGenerationConfig, "resolveCliGenerationConfig");

export {
  collectProviderModelsForProtocol,
  getAuthTypeFromEnv,
  resolveCliGenerationConfig
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
