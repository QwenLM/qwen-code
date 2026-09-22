// Force strict mode and setup for ESM
"use strict";
import {
  ACP_ROUTE_ID_PREFIX
} from "./chunk-Y3Q5OK4D.js";
import {
  getEffectiveReasoning,
  isOpenRouterHostname,
  resolveReasoningForModel
} from "./chunk-TLS6QN2S.js";
import {
  REASONING_EFFORT_TIERS,
  clampReasoningEffort,
  getGptReasoningCapabilities,
  isReasoningEffortPlaceholder,
  parseModelReasoningCapabilities,
  reasoningEffortsForCapability
} from "./chunk-KUON6Z6R.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/acp-integration/model-configuration.ts
init_esbuild_shims();
var MODEL_CONFIGURATIONS = {
  "qwen3.5-plus": {
    reasoning: {
      thinking: true,
      toggleOnly: true
    }
  },
  "qwen3.6-plus": {
    reasoning: {
      thinking: true,
      toggleOnly: true
    }
  },
  "qwen3.6-flash": {
    reasoning: {
      thinking: true,
      toggleOnly: true
    }
  },
  "qwen3.7-plus": {
    reasoning: {
      thinking: true,
      toggleOnly: true
    }
  },
  "qwen3.7-max": {
    reasoning: {
      thinking: true,
      toggleOnly: true
    }
  },
  "qwen3.8-max": {
    reasoning: {
      thinking: true,
      efforts: ["low", "medium", "xhigh"],
      defaultEffort: "xhigh"
    }
  }
};
var REASONING_EFFORT_DEFAULT = "default";
var REASONING_EFFORT_NONE = "none";
var PERSIST_REASONING_SELECTION_META_KEY = "qwenCode/persistReasoningSelection";
var REASONING_SELECTION_PERSISTED_META_KEY = "qwenCode/reasoningSelectionPersisted";
var REASONING_EFFORT_NAMES = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max"
};
function getDefaultReasoningConfig(config, settings) {
  const authType = config.getAuthType?.();
  const model = authType && !config.getActiveRuntimeModelSnapshot?.() ? config.getResolvedModelConfig?.(
    authType,
    config.getModel(),
    config.getCurrentModelRegistryBaseUrl?.() ?? void 0
  ) : void 0;
  if (model) return model.generationConfig.reasoning;
  return settings.merged.model?.generationConfig?.reasoning;
}
__name(getDefaultReasoningConfig, "getDefaultReasoningConfig");
function getGptReasoningOverrideState(generation, configuredReasoning) {
  const capabilities = getGptReasoningCapabilities(generation.model);
  const profile = configuredReasoning?.profile;
  if (!capabilities && !profile || generation.reasoning === false) {
    return void 0;
  }
  if (profile && profile !== "openai-effort" && profile !== "openai-reasoning") {
    return void 0;
  }
  const reasoning = getModelConfiguration(
    generation.model,
    configuredReasoning
  )?.reasoning;
  const defaultEnabled = !reasoning || reasoning.toggleOnly || reasoning.defaultEnabled !== false;
  const efforts = reasoning && !reasoning.toggleOnly ? reasoning.efforts : capabilities?.efforts ?? REASONING_EFFORT_TIERS;
  const raw = { ...generation.samplingParams, ...generation.extra_body };
  const flat = raw["reasoning_effort"];
  const nested = raw["reasoning"];
  const openRouter = profile === "openai-reasoning" || isOpenRouterHostname(generation);
  const removedFlatNone = (generation.thinkingMandatory === true || reasoning?.canDisable === false || capabilities?.thinkingMandatory) && flat === REASONING_EFFORT_NONE;
  if (!openRouter && !isReasoningEffortPlaceholder(flat) && !removedFlatNone) {
    const effort2 = efforts.find((tier) => tier === flat);
    return {
      enabled: flat !== REASONING_EFFORT_NONE,
      ...effort2 ? { effort: effort2 } : {},
      useDefaultEffort: effort2 === void 0,
      blocksTierChange: true
    };
  }
  if (nested === void 0) {
    const suppressedConfiguredTier = openRouter ? !parseModelReasoningCapabilities(configuredReasoning) && !isReasoningEffortPlaceholder(
      generation.samplingParams?.["reasoning_effort"]
    ) && !isReasoningEffortPlaceholder(flat) : removedFlatNone;
    const effort2 = removedFlatNone ? void 0 : efforts.find((tier) => tier === flat);
    return suppressedConfiguredTier ? {
      enabled: removedFlatNone ? defaultEnabled : flat !== REASONING_EFFORT_NONE,
      ...effort2 ? { effort: effort2 } : {},
      useDefaultEffort: effort2 === void 0,
      blocksTierChange: true
    } : void 0;
  }
  if (!openRouter || nested === null) {
    return {
      enabled: defaultEnabled,
      useDefaultEffort: true,
      blocksTierChange: true
    };
  }
  const effort = nested === false ? void 0 : efforts.find((tier) => tier === nested.effort);
  const enabled = nested === false || nested.enabled === false || nested.effort === REASONING_EFFORT_NONE ? false : nested.enabled === true || typeof nested.effort === "string" && nested.effort.length > 0 || (nested.max_tokens ?? 0) > 0 ? true : defaultEnabled;
  return {
    enabled,
    ...effort ? { effort } : {},
    useDefaultEffort: effort === void 0,
    blocksTierChange: true
  };
}
__name(getGptReasoningOverrideState, "getGptReasoningOverrideState");
function resolvePersistedReasoningConfigState(modelId, value, thinkingMandatory = false, reasoning) {
  const gptReasoning = getGptReasoningCapabilities(modelId);
  thinkingMandatory ||= getModelConfiguration(modelId, reasoning)?.reasoning?.canDisable === false;
  let selection = parseReasoningSelection(value);
  if ((reasoning?.profile && !reasoning.toggleOnly || gptReasoning && !parseModelReasoningCapabilities(reasoning)) && selection && selection !== REASONING_EFFORT_NONE && selection !== REASONING_EFFORT_DEFAULT) {
    selection = clampReasoningEffort(
      selection,
      reasoning && !reasoning.toggleOnly ? reasoning.efforts : gptReasoning.efforts
    );
  }
  if (!selection || selection === REASONING_EFFORT_DEFAULT || !isReasoningSelectionSupported(
    modelId,
    selection,
    thinkingMandatory,
    reasoning
  )) {
    return { thinkingMandatory };
  }
  return selection === REASONING_EFFORT_NONE ? { enabled: false, thinkingMandatory } : { enabled: true, effort: selection, thinkingMandatory };
}
__name(resolvePersistedReasoningConfigState, "resolvePersistedReasoningConfigState");
function getModelConfiguration(modelId, reasoning) {
  const configured = parseModelReasoningCapabilities(reasoning);
  const gpt = getGptReasoningCapabilities(modelId);
  return configured ? {
    reasoning: !reasoning?.profile && gpt?.thinkingMandatory ? { ...configured, canDisable: false } : configured
  } : gpt ? {
    reasoning: {
      thinking: true,
      efforts: gpt.efforts,
      defaultEffort: gpt.defaultEffort,
      defaultEnabled: gpt.defaultEnabled,
      ...gpt.thinkingMandatory ? { canDisable: false } : {}
    }
  } : modelId ? MODEL_CONFIGURATIONS[modelId] : void 0;
}
__name(getModelConfiguration, "getModelConfiguration");
function getConfiguredModelReasoning(config, modelId = config.getModel?.(), fallbackToManifest = true) {
  if (!modelId || config.getActiveRuntimeModelSnapshot?.() || config.getModel?.().startsWith(ACP_ROUTE_ID_PREFIX)) {
    return void 0;
  }
  const active = config.getContentGeneratorConfig?.();
  const generation = {
    ...active,
    model: active?.model ?? modelId,
    authType: active?.authType ?? config.getAuthType?.(),
    baseUrl: active?.baseUrl ?? config.getCurrentModelRegistryBaseUrl?.() ?? void 0
  };
  const reasoning = resolveReasoningForModel(config, generation, modelId);
  return reasoning ?? (fallbackToManifest ? getModelConfiguration(modelId)?.reasoning : void 0);
}
__name(getConfiguredModelReasoning, "getConfiguredModelReasoning");
function getReasoningEffortsForConfig(config) {
  const modelId = config.getModel?.();
  return reasoningEffortsForCapability(
    getConfiguredModelReasoning(config, modelId, false)
  );
}
__name(getReasoningEffortsForConfig, "getReasoningEffortsForConfig");
function parseReasoningSelection(value) {
  if (value === REASONING_EFFORT_NONE || value === REASONING_EFFORT_DEFAULT) {
    return value;
  }
  return REASONING_EFFORT_TIERS.find((tier) => tier === value);
}
__name(parseReasoningSelection, "parseReasoningSelection");
function isReasoningSelectionSupported(modelId, selection, thinkingMandatory = false, configuredReasoning) {
  if (!modelId) return false;
  const reasoning = getModelConfiguration(
    modelId,
    configuredReasoning
  )?.reasoning;
  if (!reasoning?.thinking) {
    const normalized = modelId.toLowerCase();
    if (normalized.startsWith("qwen") || normalized === "coder-model")
      return false;
  }
  if (selection === REASONING_EFFORT_DEFAULT) return true;
  if (selection === REASONING_EFFORT_NONE) {
    return reasoning?.canDisable !== false && !thinkingMandatory;
  }
  return reasoning?.thinking ? !reasoning.toggleOnly && reasoning.efforts?.includes(selection) === true : REASONING_EFFORT_TIERS.includes(selection);
}
__name(isReasoningSelectionSupported, "isReasoningSelectionSupported");
function clearReasoningRequestOverrides(generation) {
  if (getGptReasoningCapabilities(generation.model) || getGptReasoningOverrideState(
    generation,
    resolveReasoningForModel(void 0, generation)
  )?.blocksTierChange)
    return;
  for (const source of ["extra_body", "samplingParams"]) {
    const layer = generation[source];
    if (!layer) continue;
    const next = { ...layer };
    delete next["enable_thinking"];
    delete next["reasoning_effort"];
    delete next["thinking_budget"];
    generation[source] = next;
  }
}
__name(clearReasoningRequestOverrides, "clearReasoningRequestOverrides");
function applyReasoningSelection(config, selection, defaultReasoning) {
  const apply = /* @__PURE__ */ __name((generation) => {
    if (!generation) return;
    if (selection === REASONING_EFFORT_NONE) {
      generation.reasoning = false;
      return;
    }
    if (selection === REASONING_EFFORT_DEFAULT) {
      if (defaultReasoning !== void 0) {
        generation.reasoning = defaultReasoning ? { ...defaultReasoning } : false;
        return;
      }
      if (!generation.reasoning) {
        generation.reasoning = void 0;
        return;
      }
      const next = { ...generation.reasoning };
      delete next.effort;
      generation.reasoning = Object.keys(next).length > 0 ? next : void 0;
      return;
    }
    generation.reasoning = {
      ...generation.reasoning || defaultReasoning || {},
      effort: selection
    };
  }, "apply");
  const live = config.getContentGeneratorConfig?.();
  apply(live);
  const modelsConfig = config.getModelsConfig?.();
  const rebuildable = modelsConfig?.getGenerationConfig?.();
  if (rebuildable !== live) apply(rebuildable);
}
__name(applyReasoningSelection, "applyReasoningSelection");
function buildModelReasoningConfigOption(modelId, state = {}, configuredReasoning) {
  const reasoning = getModelConfiguration(
    modelId,
    configuredReasoning
  )?.reasoning;
  if (!reasoning?.thinking) return void 0;
  const canDisable = reasoning.canDisable !== false && state.thinkingMandatory !== true;
  const enabled = state.enabled ?? (state.effort !== void 0 || reasoning.toggleOnly || reasoning.defaultEnabled !== false);
  const effort = state.effort && !reasoning.toggleOnly && (configuredReasoning?.profile || getGptReasoningCapabilities(modelId) && !parseModelReasoningCapabilities(configuredReasoning)) ? clampReasoningEffort(state.effort, reasoning.efforts) : state.effort;
  const currentValue = !enabled && canDisable ? REASONING_EFFORT_NONE : reasoning.toggleOnly ? REASONING_EFFORT_DEFAULT : reasoning.efforts.find((candidate) => candidate === effort) ?? reasoning.defaultEffort ?? REASONING_EFFORT_DEFAULT;
  return {
    id: "reasoning_effort",
    name: "Reasoning effort",
    description: `Thinking and reasoning effort for ${modelId}`,
    category: "thought_level",
    type: "select",
    currentValue,
    options: [
      ...canDisable ? [
        {
          value: REASONING_EFFORT_NONE,
          name: "Thinking off",
          description: "Disable thinking for this session"
        }
      ] : [],
      ...reasoning.toggleOnly ? [
        {
          value: REASONING_EFFORT_DEFAULT,
          name: "Thinking on",
          description: "Use the model or provider thinking default"
        }
      ] : [
        ...reasoning.defaultEffort ? [] : [
          {
            value: REASONING_EFFORT_DEFAULT,
            name: "Default",
            description: "Use the model or provider default"
          }
        ],
        ...reasoning.efforts.map((effort2) => ({
          value: effort2,
          name: REASONING_EFFORT_NAMES[effort2],
          description: "Apply this effort to the next request"
        }))
      ]
    ],
    _meta: {
      "qwenCode/reasoning": reasoning.toggleOnly ? {
        toggleOnly: true,
        ...state.canEnable === false ? { canEnable: false } : {},
        ...canDisable ? {} : { thinkingMandatory: true }
      } : {
        ...state.enableValue ? { enableValue: state.enableValue } : {},
        ...state.canEnable === false ? { canEnable: false } : {},
        ...reasoning.defaultEffort ? { defaultEffort: reasoning.defaultEffort } : {},
        ...canDisable ? {} : { thinkingMandatory: true }
      }
    }
  };
}
__name(buildModelReasoningConfigOption, "buildModelReasoningConfigOption");
function buildModelReasoningConfigPreview(modelId, state = {}, configuredReasoning, generation) {
  const reasoning = getModelConfiguration(
    modelId,
    configuredReasoning
  )?.reasoning;
  if (!reasoning?.thinking) return void 0;
  const effectiveReasoning = state.enabled === false ? false : state.enabled === true ? { effort: state.effort } : generation?.reasoning;
  const override = generation && getGptReasoningOverrideState(
    {
      ...generation,
      reasoning: effectiveReasoning
    },
    configuredReasoning
  );
  if (configuredReasoning?.profile && override?.enabled && override.useDefaultEffort) {
    return void 0;
  }
  const enableOverride = generation && getGptReasoningOverrideState(
    { ...generation, reasoning: void 0 },
    configuredReasoning
  );
  const option = buildModelReasoningConfigOption(
    modelId,
    {
      ...state,
      ...override ? {
        enabled: override.enabled,
        effort: override.useDefaultEffort ? void 0 : override.effort
      } : {},
      ...enableOverride?.blocksTierChange ? {
        ...effectiveReasoning === false ? { enabled: false } : {},
        ...enableOverride.enabled && generation?.reasoning !== false ? { enableValue: REASONING_EFFORT_DEFAULT } : { canEnable: false }
      } : {}
    },
    configuredReasoning
  );
  return option ? [option] : void 0;
}
__name(buildModelReasoningConfigPreview, "buildModelReasoningConfigPreview");
function buildModelReasoningRoutePreview(generation, reasoning, selection, opaqueRoute = false) {
  if (opaqueRoute && !reasoning?.profile) return void 0;
  return buildModelReasoningConfigPreview(
    generation.model,
    {
      enabled: generation.reasoning === false ? false : void 0,
      effort: generation.reasoning ? generation.reasoning.effort : void 0,
      ...resolvePersistedReasoningConfigState(
        generation.model,
        selection,
        generation.thinkingMandatory === true,
        reasoning
      )
    },
    reasoning,
    generation
  );
}
__name(buildModelReasoningRoutePreview, "buildModelReasoningRoutePreview");
function getReasoningForDisplay(config, generation) {
  const resolved = resolveReasoningForModel(config, generation);
  if (!resolved) return generation.reasoning;
  const override = getGptReasoningOverrideState(generation, resolved);
  if (override) return override.enabled ? { effort: override.effort } : false;
  if (config.getReasoningEffortOverride?.()) return generation.reasoning;
  return getEffectiveReasoning(generation, resolved);
}
__name(getReasoningForDisplay, "getReasoningForDisplay");

export {
  REASONING_EFFORT_DEFAULT,
  REASONING_EFFORT_NONE,
  PERSIST_REASONING_SELECTION_META_KEY,
  REASONING_SELECTION_PERSISTED_META_KEY,
  REASONING_EFFORT_NAMES,
  getDefaultReasoningConfig,
  getGptReasoningOverrideState,
  getConfiguredModelReasoning,
  getReasoningEffortsForConfig,
  parseReasoningSelection,
  isReasoningSelectionSupported,
  clearReasoningRequestOverrides,
  applyReasoningSelection,
  buildModelReasoningConfigOption,
  buildModelReasoningRoutePreview,
  getReasoningForDisplay
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
