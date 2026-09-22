// Force strict mode and setup for ESM
"use strict";
import {
  DEFAULT_QWEN_MODEL
} from "./chunk-XZA32HII.js";
import {
  preloadRuntimeFetchModule
} from "./chunk-SBP43AO6.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/models/modelConfigErrors.ts
init_esbuild_shims();
function getDefaultApiKeyEnvVar(authType) {
  switch (authType) {
    case "openai":
    case "openai-responses":
      return "OPENAI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    case "vertex-ai":
      return "GOOGLE_API_KEY";
    default:
      return "API_KEY";
  }
}
__name(getDefaultApiKeyEnvVar, "getDefaultApiKeyEnvVar");
function getDefaultModelEnvVar(authType) {
  switch (authType) {
    case "openai":
    case "openai-responses":
      return "OPENAI_MODEL";
    case "anthropic":
      return "ANTHROPIC_MODEL";
    case "gemini":
      return "GEMINI_MODEL";
    case "vertex-ai":
      return "GOOGLE_MODEL";
    default:
      return "MODEL";
  }
}
__name(getDefaultModelEnvVar, "getDefaultModelEnvVar");
var VERTEX_ADC_HINT = " Alternatively, set GOOGLE_CLOUD_PROJECT to authenticate with Application Default Credentials instead of an API key.";
function adcHint(authType, explicitEnvKey) {
  return authType === "vertex-ai" && !explicitEnvKey ? VERTEX_ADC_HINT : "";
}
__name(adcHint, "adcHint");
var ModelConfigError = class extends Error {
  static {
    __name(this, "ModelConfigError");
  }
  constructor(message) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var StrictMissingCredentialsError = class extends ModelConfigError {
  static {
    __name(this, "StrictMissingCredentialsError");
  }
  code = "STRICT_MISSING_CREDENTIALS";
  constructor(authType, model, envKey) {
    const providerKey = authType || "(unknown)";
    const modelName = model || "(unknown)";
    super(
      `Missing credentials for modelProviders model '${modelName}'. ` + (envKey ? `Current configured envKey: '${envKey}'. Set that environment variable, or update modelProviders.${providerKey}[].envKey.` : `Configure modelProviders.${providerKey}[].envKey and set that environment variable.`) + adcHint(authType, envKey)
    );
  }
};
var StrictMissingModelIdError = class extends ModelConfigError {
  static {
    __name(this, "StrictMissingModelIdError");
  }
  code = "STRICT_MISSING_MODEL_ID";
  constructor(authType) {
    super(
      `Missing model id for strict modelProviders resolution (authType: ${authType}).`
    );
  }
};
var MissingApiKeyError = class extends ModelConfigError {
  static {
    __name(this, "MissingApiKeyError");
  }
  code = "MISSING_API_KEY";
  constructor(params) {
    super(
      `Missing API key for ${params.authType} auth. Current model: '${params.model || "(unknown)"}', baseUrl: '${params.baseUrl || "(default)"}'. Provide an API key via settings (security.auth.apiKey), or set the environment variable '${params.envKey}'.` + adcHint(params.authType, params.explicitEnvKey)
    );
  }
};
var MissingModelError = class extends ModelConfigError {
  static {
    __name(this, "MissingModelError");
  }
  code = "MISSING_MODEL";
  constructor(params) {
    super(
      `Missing model for ${params.authType} auth. Set the environment variable '${params.envKey}'.`
    );
  }
};
var MissingBaseUrlError = class extends ModelConfigError {
  static {
    __name(this, "MissingBaseUrlError");
  }
  code = "MISSING_BASE_URL";
  constructor(params) {
    super(
      `Missing baseUrl for modelProviders model '${params.model || "(unknown)"}'. Configure modelProviders.${params.authType || "(unknown)"}[].baseUrl.`
    );
  }
};
var MissingAnthropicBaseUrlEnvError = class extends ModelConfigError {
  static {
    __name(this, "MissingAnthropicBaseUrlEnvError");
  }
  code = "MISSING_ANTHROPIC_BASE_URL_ENV";
  constructor() {
    super("ANTHROPIC_BASE_URL environment variable not found.");
  }
};

// packages/core/src/config/models.ts
init_esbuild_shims();
var DEFAULT_QWEN_EMBEDDING_MODEL = "text-embedding-v4";
var MAINLINE_CODER_MODEL = "qwen3.7-max";

// packages/core/src/models/constants.ts
init_esbuild_shims();
var MODEL_GENERATION_CONFIG_FIELDS = [
  "samplingParams",
  "timeout",
  "streamIdleTimeoutMs",
  "maxRetries",
  "retryInitialDelayMs",
  "retryMaxDelayMs",
  "retryErrorCodes",
  "enableCacheControl",
  "enableRequestMetadata",
  "forceGlobalCacheScope",
  "cacheRetention",
  "cacheRetentionByBlock",
  "schemaCompliance",
  "reasoning",
  "contextWindowSize",
  "customHeaders",
  "extra_body",
  "thinkingMandatory",
  "modalities",
  "splitToolMedia",
  "toolResultContentFormat"
];
var CREDENTIAL_FIELDS = [
  "model",
  "apiKey",
  "apiKeyEnvKey",
  "baseUrl"
];
var PROVIDER_SOURCED_FIELDS = [
  ...CREDENTIAL_FIELDS,
  ...MODEL_GENERATION_CONFIG_FIELDS
];
var AUTH_ENV_MAPPINGS = {
  openai: {
    apiKey: ["OPENAI_API_KEY"],
    baseUrl: ["OPENAI_BASE_URL"],
    model: ["OPENAI_MODEL", "QWEN_MODEL"]
  },
  "openai-responses": {
    apiKey: ["OPENAI_API_KEY"],
    baseUrl: ["OPENAI_BASE_URL"],
    model: ["OPENAI_MODEL"]
  },
  anthropic: {
    apiKey: ["ANTHROPIC_API_KEY"],
    baseUrl: ["ANTHROPIC_BASE_URL"],
    model: ["ANTHROPIC_MODEL"]
  },
  gemini: {
    apiKey: ["GEMINI_API_KEY"],
    baseUrl: [],
    model: ["GEMINI_MODEL"]
  },
  "vertex-ai": {
    apiKey: ["GOOGLE_API_KEY"],
    baseUrl: [],
    model: ["GOOGLE_MODEL"]
  },
  "qwen-oauth": {
    apiKey: [],
    baseUrl: [],
    model: []
  }
};
var DEFAULT_MODELS = {
  openai: MAINLINE_CODER_MODEL,
  "qwen-oauth": DEFAULT_QWEN_MODEL
};
var QWEN_OAUTH_MODELS = [
  {
    id: "coder-model",
    name: "coder-model",
    description: "Qwen 3.7 Max \u2014 efficient hybrid model with leading coding performance",
    capabilities: { vision: true }
  }
];
var QWEN_OAUTH_ALLOWED_MODELS = QWEN_OAUTH_MODELS.map(
  (model) => model.id
);

// packages/core/src/core/tokenLimits.ts
init_esbuild_shims();
var DEFAULT_TOKEN_LIMIT = 2e5;
var DEFAULT_OUTPUT_TOKEN_LIMIT = 32e3;
var ESCALATED_MAX_TOKENS = 64e3;
var OUTPUT_TOKEN_CEILING = ESCALATED_MAX_TOKENS;
var MIN_CLAMPED_OUTPUT_TOKENS = 4e3;
function outputClampMargin(contextWindowSize) {
  return Math.max(1e4, Math.round(0.05 * contextWindowSize));
}
__name(outputClampMargin, "outputClampMargin");
function clampOutputTokensToWindow(outputCeiling, contextWindowSize, promptTokens) {
  const room = contextWindowSize - promptTokens - outputClampMargin(contextWindowSize);
  return Math.min(outputCeiling, Math.max(MIN_CLAMPED_OUTPUT_TOKENS, room));
}
__name(clampOutputTokensToWindow, "clampOutputTokensToWindow");
function parsePositiveIntegerEnvValue(raw) {
  if (raw === void 0) return void 0;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return void 0;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return void 0;
  return parsed;
}
__name(parsePositiveIntegerEnvValue, "parsePositiveIntegerEnvValue");
var LIMITS = {
  "32k": 32768,
  "64k": 65536,
  "128k": 131072,
  "192k": 196608,
  // MiniMax-M2.5 context window
  "200k": 2e5,
  // vendor-declared decimal, used by OpenAI, Anthropic, etc.
  "256k": 262144,
  "272k": 272e3,
  // vendor-declared decimal, GPT-5.x input (400K total - 128K output)
  "384k": 384e3,
  // vendor-declared decimal, DeepSeek V4 max output
  "400k": 4e5,
  // vendor-declared decimal, used by OpenAI GPT-5.x
  "512k": 524288,
  "1m": 1e6,
  // Output token limits (typically much smaller than input limits)
  "4k": 4096,
  "8k": 8192,
  "16k": 16384
};
function normalize(model) {
  let s = (model ?? "").toLowerCase().trim();
  s = s.replace(/^.*\//, "");
  s = s.split("|").pop() ?? s;
  s = s.replace(
    /:(?:free|beta|extended|thinking|online|nitro|floor|latest|\d+(?:\.\d+)?(?:x\d+)?b(?:-[\w.]+)*)$/,
    ""
  );
  s = s.split(":").pop() ?? s;
  s = s.replace(/\s+/g, "-");
  s = s.replace(/^(claude-[a-z]+-\d+(?:-\d+)?)\.(\d+)(?:\.\d+)*/, "$1-$2");
  s = s.replace(/-preview/g, "");
  if (!s.match(/^qwen-(?:plus|flash|vl-max)-latest$/) && !s.match(/^kimi-k2-\d{4}$/)) {
    s = s.replace(
      /-(?:\d{4,}|\d+x\d+b|v\d+(?:\.\d+)*|(?<=-[^-]+-)\d+(?:\.\d+)+|latest|exp)$/g,
      ""
    );
  }
  s = s.replace(/-(?:\d?bit|int[48]|bf16|fp16|q[45]|quantized)$/g, "");
  return s;
}
__name(normalize, "normalize");
var CLAUDE_OPUS_EXTENDED = /^claude-opus-(?:4-(?:6|7|8)|5)/;
var PATTERNS = [
  // -------------------
  // Google Gemini
  // -------------------
  [/^gemini-3/, LIMITS["1m"]],
  // Gemini 3.x (Pro, Flash, 3.1, etc.): 1M
  [/^gemini-/, LIMITS["1m"]],
  // Gemini fallback (1.5, 2.x): 1M
  // -------------------
  // OpenAI
  // -------------------
  [/^gpt-5/, LIMITS["272k"]],
  // GPT-5.x: 272K input (400K total - 128K output)
  [/^gpt-/, LIMITS["128k"]],
  // GPT fallback (4o, 4.1, etc.): 128K
  [/^o\d/, LIMITS["200k"]],
  // o-series (o3, o4-mini, etc.): 200K
  // -------------------
  // Anthropic Claude
  // -------------------
  [CLAUDE_OPUS_EXTENDED, LIMITS["1m"]],
  // Opus 4.6-4.8, Opus 5.x: 1M
  [/^claude-/, LIMITS["200k"]],
  // All Claude models: 200K
  // -------------------
  // Alibaba / Qwen
  // -------------------
  // Commercial API models (1,000,000 context)
  [/^qwen3-coder-plus/, LIMITS["1m"]],
  [/^qwen3-coder-flash/, LIMITS["1m"]],
  [/^qwen3\.\d/, LIMITS["1m"]],
  [/^qwen-plus-latest$/, LIMITS["1m"]],
  [/^qwen-flash-latest$/, LIMITS["1m"]],
  [/^coder-model$/, LIMITS["1m"]],
  // Commercial API models (256K context)
  [/^qwen3-max/, LIMITS["256k"]],
  // Open-source Qwen3 variants: 256K native
  [/^qwen3-coder-/, LIMITS["256k"]],
  // Qwen fallback (VL, turbo, plus, 2.5, etc.): 256K
  [/^qwen/, LIMITS["256k"]],
  // -------------------
  // DeepSeek
  // -------------------
  [/^deepseek-v4/, LIMITS["1m"]],
  // DeepSeek V4 (flash, pro): 1M
  [/^deepseek/, LIMITS["128k"]],
  // -------------------
  // Zhipu GLM
  // -------------------
  // 1M context is the forward default for new GLM releases (GLM-5.2+, GLM-6.x,
  // and beyond) so they need no future code change. Confirmed 200K families
  // (GLM-5 / 5.0 / 5.1, GLM-4.x and older) are pinned explicitly first.
  [/^glm-5(\.[01])?(-|$)/, 202752],
  // GLM-5 / 5.0 / 5.1: 200K
  [/^glm-(?:[5-9]|\d{2,})/, LIMITS["1m"]],
  // GLM-5.2+, 6.x..9.x, 10.x+: 1M
  [/^glm-/, 202752],
  // GLM <=4.x / non-numeric fallback: 200K
  // -------------------
  // MiniMax
  // -------------------
  [/^minimax-m3/i, LIMITS["1m"]],
  // MiniMax-M3: 1,000,000
  [/^minimax-m2\.5/i, LIMITS["192k"]],
  // MiniMax-M2.5: 196,608
  [/^minimax-/i, LIMITS["200k"]],
  // MiniMax fallback: 200K
  // -------------------
  // Moonshot / Kimi
  // -------------------
  [/^kimi-k3/, LIMITS["1m"]],
  // Kimi K3: 1M
  [/^kimi-/, LIMITS["256k"]],
  // Kimi fallback: 256K
  // -------------------
  // ByteDance Seed-OSS (512K)
  // -------------------
  [/^seed-oss/, LIMITS["512k"]]
];
var OUTPUT_PATTERNS = [
  // Google Gemini
  [/^gemini-3/, LIMITS["64k"]],
  // Gemini 3.x: 64K
  [/^gemini-/, LIMITS["8k"]],
  // Gemini fallback: 8K
  // OpenAI
  [/^gpt-5/, LIMITS["128k"]],
  // GPT-5.x: 128K
  [/^gpt-/, LIMITS["16k"]],
  // GPT fallback: 16K
  [/^o\d/, LIMITS["128k"]],
  // o-series: 128K
  // Anthropic Claude
  [CLAUDE_OPUS_EXTENDED, 128e3],
  // Opus 4.6-4.8, Opus 5.x: 128K
  [/^claude-sonnet-4-6/, LIMITS["64k"]],
  // Sonnet 4.6: 64K
  [/^claude-/, LIMITS["64k"]],
  // Claude fallback: 64K
  // Alibaba / Qwen
  [/^qwen3\.\d/, LIMITS["64k"]],
  [/^coder-model$/, LIMITS["64k"]],
  [/^qwen/, LIMITS["32k"]],
  // Qwen fallback (VL, turbo, plus, etc.): 32K
  // DeepSeek
  [/^deepseek-v4/, LIMITS["384k"]],
  // DeepSeek V4 (flash, pro): 384K
  [/^deepseek-reasoner/, LIMITS["64k"]],
  [/^deepseek-r1/, LIMITS["64k"]],
  [/^deepseek-chat/, LIMITS["8k"]],
  // Zhipu GLM
  [/^glm-5(?:\.\d+)?(?:-|$)/, LIMITS["128k"]],
  [/^glm-4\.7/, LIMITS["16k"]],
  // MiniMax
  [/^minimax-m2\.5/i, LIMITS["64k"]],
  // Kimi
  [/^kimi-k3/, LIMITS["128k"]],
  // Kimi K3: 128K default max output (up to 1M configurable)
  [/^kimi-k2\.5/, LIMITS["32k"]]
];
function findTokenLimit(model, type = "input") {
  const norm = normalize(model);
  const patterns = type === "output" ? OUTPUT_PATTERNS : PATTERNS;
  for (const [regex, limit] of patterns) {
    if (regex.test(norm)) {
      return limit;
    }
  }
  return void 0;
}
__name(findTokenLimit, "findTokenLimit");
function hasExplicitOutputLimit(model) {
  const norm = normalize(model);
  return OUTPUT_PATTERNS.some(([regex]) => regex.test(norm));
}
__name(hasExplicitOutputLimit, "hasExplicitOutputLimit");
function knownTokenLimit(model, type = "input") {
  return findTokenLimit(model, type);
}
__name(knownTokenLimit, "knownTokenLimit");
function tokenLimit(model, type = "input") {
  return knownTokenLimit(model, type) ?? (type === "output" ? DEFAULT_OUTPUT_TOKEN_LIMIT : DEFAULT_TOKEN_LIMIT);
}
__name(tokenLimit, "tokenLimit");
function defaultOutputCeiling(model) {
  const outputLimit = tokenLimit(model, "output");
  if (CLAUDE_OPUS_EXTENDED.test(normalize(model))) {
    return outputLimit;
  }
  return Math.min(outputLimit, OUTPUT_TOKEN_CEILING);
}
__name(defaultOutputCeiling, "defaultOutputCeiling");
function reconcileMaxTokens(configMaxTokens, requestMaxTokens) {
  if (typeof configMaxTokens === "number" && typeof requestMaxTokens === "number") {
    return Math.min(configMaxTokens, requestMaxTokens);
  }
  return void 0;
}
__name(reconcileMaxTokens, "reconcileMaxTokens");

// packages/core/src/core/reasoning-effort.ts
init_esbuild_shims();
var REASONING_EFFORT_TIERS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];
var REASONING_EFFORT_RANKS = {
  low: 20,
  medium: 30,
  high: 40,
  xhigh: 60,
  max: 70
};
function getGptReasoningCapabilities(model) {
  const normalized = normalize(
    (model ?? "").trim().replace(/:batch(?=:|$)/gi, "")
  ).replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/^(gpt-5\.\d+)(?:\.\d+)+(?=-|$)/, "$1");
  switch (normalized) {
    case "gpt-5":
    case "gpt-5-mini":
    case "gpt-5-nano":
    case "gpt-5.1-codex":
      return {
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
        defaultEnabled: true,
        thinkingMandatory: true
      };
    case "gpt-5-pro":
      return {
        efforts: ["high"],
        defaultEffort: "high",
        defaultEnabled: true,
        thinkingMandatory: true
      };
    case "gpt-5.1":
      return {
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
        defaultEnabled: false,
        thinkingMandatory: false
      };
    case "gpt-5.2":
    case "gpt-5.4":
    case "gpt-5.4-mini":
    case "gpt-5.4-nano":
      return {
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
        defaultEnabled: false,
        thinkingMandatory: false
      };
    case "gpt-5.1-codex-max":
    case "gpt-5.2-codex":
    case "gpt-5.3-codex":
      return {
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
        defaultEnabled: true,
        thinkingMandatory: true
      };
    case "gpt-5.2-pro":
    case "gpt-5.4-pro":
      return {
        efforts: ["medium", "high", "xhigh"],
        defaultEffort: "medium",
        defaultEnabled: true,
        thinkingMandatory: true
      };
    case "gpt-5.5":
      return {
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
        defaultEnabled: true,
        thinkingMandatory: false
      };
    case "gpt-5.5-pro":
      return {
        efforts: ["medium", "high", "xhigh"],
        defaultEffort: "high",
        defaultEnabled: true,
        thinkingMandatory: true
      };
    case "gpt-5.6":
    case "gpt-5.6-sol":
    case "gpt-5.6-terra":
    case "gpt-5.6-luna":
      return {
        efforts: REASONING_EFFORT_TIERS,
        defaultEffort: "medium",
        defaultEnabled: true,
        thinkingMandatory: false
      };
    case "gpt-6-astra":
      return {
        efforts: REASONING_EFFORT_TIERS,
        defaultEffort: "medium",
        defaultEnabled: true,
        thinkingMandatory: true
      };
    default:
      return void 0;
  }
}
__name(getGptReasoningCapabilities, "getGptReasoningCapabilities");
function isReasoningEffortPlaceholder(value) {
  return value == null || value === "";
}
__name(isReasoningEffortPlaceholder, "isReasoningEffortPlaceholder");
function normalizeReasoningEffort(raw) {
  if (!raw || typeof raw !== "string") {
    return void 0;
  }
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  switch (key) {
    case "low":
      return "low";
    case "medium":
    case "med":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
    case "extrahigh":
      return "xhigh";
    case "max":
    case "maximum":
      return "max";
    default:
      return void 0;
  }
}
__name(normalizeReasoningEffort, "normalizeReasoningEffort");
function clampReasoningEffort(requested, supported) {
  const set = supported && supported.length > 0 ? supported : REASONING_EFFORT_TIERS;
  if (set.includes(requested)) {
    return requested;
  }
  const requestedRank = REASONING_EFFORT_RANKS[requested];
  const ranked = [...set].sort(
    (a, b) => REASONING_EFFORT_RANKS[a] - REASONING_EFFORT_RANKS[b]
  );
  for (const tier of ranked) {
    if (REASONING_EFFORT_RANKS[tier] >= requestedRank) {
      return tier;
    }
  }
  return ranked[ranked.length - 1];
}
__name(clampReasoningEffort, "clampReasoningEffort");
function applyReasoningEffort(config, effort) {
  config.setReasoningEffort(effort);
  return config.getReasoningEffort() === effort;
}
__name(applyReasoningEffort, "applyReasoningEffort");
function setGeneratorReasoningEffort(cfg, effort) {
  if (!cfg || cfg.reasoning === false) {
    return false;
  }
  const next = {
    ...cfg.reasoning ?? {}
  };
  if (effort) {
    next.effort = effort;
  } else {
    delete next.effort;
  }
  cfg.reasoning = Object.keys(next).length > 0 ? next : void 0;
  return true;
}
__name(setGeneratorReasoningEffort, "setGeneratorReasoningEffort");
function reasoningEffortsForCapability(reasoning) {
  if (!reasoning) return REASONING_EFFORT_TIERS;
  return reasoning.toggleOnly ? [] : reasoning.efforts;
}
__name(reasoningEffortsForCapability, "reasoningEffortsForCapability");
function parseModelReasoningCapabilities(value) {
  if (!value || typeof value !== "object") return void 0;
  const candidate = value;
  if (candidate["thinking"] !== true) return void 0;
  const disableField = candidate["disableField"];
  if (disableField !== "enable_thinking" && disableField !== "reasoning_effort" && disableField !== "thinking") {
    return void 0;
  }
  if ("toggleOnly" in candidate && typeof candidate["toggleOnly"] !== "boolean" || "canDisable" in candidate && candidate["canDisable"] !== false) {
    return void 0;
  }
  if (candidate["toggleOnly"] === true) {
    return candidate;
  }
  const efforts = candidate["efforts"];
  if (!Array.isArray(efforts) || efforts.length === 0 || !efforts.every(
    (effort) => typeof effort === "string" && REASONING_EFFORT_TIERS.includes(effort)
  ) || new Set(efforts).size !== efforts.length) {
    return void 0;
  }
  const defaultEffort = candidate["defaultEffort"];
  if (defaultEffort !== void 0 && !efforts.includes(defaultEffort)) {
    return void 0;
  }
  return candidate;
}
__name(parseModelReasoningCapabilities, "parseModelReasoningCapabilities");

// packages/core/src/core/contentGenerator.ts
init_esbuild_shims();
function setSource(sources, path, source) {
  sources[path] = source;
}
__name(setSource, "setSource");
function getSeedSource(seed, path) {
  return seed?.[path];
}
__name(getSeedSource, "getSeedSource");
function resolveContentGeneratorConfigWithSources(config, authType, generationConfig, seedSources, options) {
  const sources = { ...seedSources || {} };
  const strictModelProvider = options?.strictModelProvider === true;
  const newContentGeneratorConfig = {
    ...generationConfig || {},
    authType,
    reasoningSnapshot: generationConfig?.reasoningSnapshot ?? config?.getReasoningSnapshot?.(),
    reasoningRouteBaseUrl: generationConfig && "reasoningRouteBaseUrl" in generationConfig ? generationConfig.reasoningRouteBaseUrl : config?.getCurrentModelRegistryBaseUrl?.(),
    proxy: config?.getProxy()
  };
  setSource(sources, "authType", {
    kind: "computed",
    detail: "provided by caller"
  });
  if (config?.getProxy()) {
    setSource(sources, "proxy", {
      kind: "computed",
      detail: "Config.getProxy()"
    });
  }
  const seedOrUnknown = /* @__PURE__ */ __name((path) => getSeedSource(seedSources, path) ?? { kind: "unknown" }, "seedOrUnknown");
  for (const field of PROVIDER_SOURCED_FIELDS) {
    if (generationConfig && field in generationConfig && !sources[field]) {
      setSource(sources, field, seedOrUnknown(field));
    }
  }
  const validation = validateModelConfig(
    newContentGeneratorConfig,
    strictModelProvider
  );
  if (!validation.valid) {
    throw new Error(validation.errors.map((e) => e.message).join("\n"));
  }
  return {
    config: newContentGeneratorConfig,
    sources
  };
}
__name(resolveContentGeneratorConfigWithSources, "resolveContentGeneratorConfigWithSources");
var VERTEX_PROJECT_ENV_VAR = "GOOGLE_CLOUD_PROJECT";
function hasVertexProjectConfigured(lookup = (key) => process.env[key]) {
  return !!lookup(VERTEX_PROJECT_ENV_VAR)?.trim();
}
__name(hasVertexProjectConfigured, "hasVertexProjectConfigured");
function usesVertexApplicationDefaultCredentials(config) {
  return config.authType === "vertex-ai" /* USE_VERTEX_AI */ && !config.apiKeyEnvKey && hasVertexProjectConfigured();
}
__name(usesVertexApplicationDefaultCredentials, "usesVertexApplicationDefaultCredentials");
function validateModelConfig(config, isStrictModelProvider = false) {
  const errors = [];
  if (config.authType === "qwen-oauth" /* QWEN_OAUTH */) {
    return { valid: true, errors: [] };
  }
  if (!config.apiKey && !usesVertexApplicationDefaultCredentials(config)) {
    if (isStrictModelProvider) {
      errors.push(
        new StrictMissingCredentialsError(
          config.authType,
          config.model,
          config.apiKeyEnvKey
        )
      );
    } else {
      const envKey = config.apiKeyEnvKey || getDefaultApiKeyEnvVar(config.authType);
      errors.push(
        new MissingApiKeyError({
          authType: config.authType,
          model: config.model,
          baseUrl: config.baseUrl,
          envKey,
          explicitEnvKey: config.apiKeyEnvKey
        })
      );
    }
  }
  if (!config.model) {
    if (isStrictModelProvider) {
      errors.push(new StrictMissingModelIdError(config.authType));
    } else {
      const envKey = getDefaultModelEnvVar(config.authType);
      errors.push(new MissingModelError({ authType: config.authType, envKey }));
    }
  }
  if (config.authType === "anthropic" /* USE_ANTHROPIC */ && !config.baseUrl) {
    if (isStrictModelProvider) {
      errors.push(
        new MissingBaseUrlError({
          authType: config.authType,
          model: config.model
        })
      );
    } else if (config.authType === "anthropic" /* USE_ANTHROPIC */) {
      errors.push(new MissingAnthropicBaseUrlEnvError());
    }
  }
  return { valid: errors.length === 0, errors };
}
__name(validateModelConfig, "validateModelConfig");
function getModuleNotFoundError(error) {
  let current = error;
  while (current instanceof Error) {
    if ("code" in current && current.code === "ERR_MODULE_NOT_FOUND") {
      return current;
    }
    current = current.cause;
  }
  return void 0;
}
__name(getModuleNotFoundError, "getModuleNotFoundError");
function wrapProviderLoadError(error, authType) {
  const moduleNotFoundError = getModuleNotFoundError(error);
  if (!moduleNotFoundError) {
    return error;
  }
  return new Error(
    `Qwen Code was updated in the background and needs to be restarted.
Please exit and restart Qwen Code to use the '${authType}' provider.`,
    { cause: moduleNotFoundError }
  );
}
__name(wrapProviderLoadError, "wrapProviderLoadError");
var LazyContentGenerator = class {
  constructor(loader) {
    this.loader = loader;
  }
  static {
    __name(this, "LazyContentGenerator");
  }
  generatorPromise;
  preloadedOnly = false;
  getGenerator() {
    this.generatorPromise ??= this.loader();
    return this.generatorPromise;
  }
  getGeneratorForUse() {
    this.preloadedOnly = false;
    return this.getGenerator();
  }
  preload() {
    if (!this.generatorPromise) {
      this.preloadedOnly = true;
    }
    return this.getGenerator();
  }
  resetPreload() {
    if (!this.preloadedOnly) return;
    this.preloadedOnly = false;
    this.generatorPromise = void 0;
  }
  async generateContent(request, userPromptId) {
    return (await this.getGeneratorForUse()).generateContent(
      request,
      userPromptId
    );
  }
  async generateContentStream(request, userPromptId) {
    return (await this.getGeneratorForUse()).generateContentStream(
      request,
      userPromptId
    );
  }
  async embedContent(request) {
    return (await this.getGeneratorForUse()).embedContent(request);
  }
};
async function preloadContentGenerator(generator) {
  if (generator instanceof LazyContentGenerator) {
    await generator.preload();
  }
}
__name(preloadContentGenerator, "preloadContentGenerator");
function resetPreloadedContentGenerator(generator) {
  if (generator instanceof LazyContentGenerator) {
    generator.resetPreload();
  }
}
__name(resetPreloadedContentGenerator, "resetPreloadedContentGenerator");
async function createContentGenerator(generatorConfig, config, isInitialAuth) {
  const validation = validateModelConfig(generatorConfig, false);
  if (!validation.valid) {
    throw new Error(validation.errors.map((e) => e.message).join("\n"));
  }
  const authType = generatorConfig.authType;
  if (!authType) {
    throw new Error("ContentGeneratorConfig must have an authType");
  }
  await preloadRuntimeFetchModule();
  let loadBaseGenerator;
  try {
    if (authType === "openai" /* USE_OPENAI */) {
      loadBaseGenerator = /* @__PURE__ */ __name(async () => {
        const { createOpenAIContentGenerator } = await import("./openaiContentGenerator-TC65MOEG.js");
        return createOpenAIContentGenerator(generatorConfig, config);
      }, "loadBaseGenerator");
    } else if (authType === "openai-responses" /* USE_OPENAI_RESPONSES */) {
      loadBaseGenerator = /* @__PURE__ */ __name(async () => {
        const { createOpenAIResponsesContentGenerator } = await import("./openaiResponsesContentGenerator-XJZEZ5LE.js");
        return createOpenAIResponsesContentGenerator(generatorConfig, config);
      }, "loadBaseGenerator");
    } else if (authType === "qwen-oauth" /* QWEN_OAUTH */) {
      const { getQwenOAuthClient: getQwenOauthClient } = await import("./qwenOAuth2-GD3UIYUP.js");
      try {
        const qwenClient = await getQwenOauthClient(
          config,
          isInitialAuth ? { requireCachedCredentials: true } : void 0
        );
        loadBaseGenerator = /* @__PURE__ */ __name(async () => {
          const { QwenContentGenerator } = await import("./qwenContentGenerator-TQ4YER3Q.js");
          return new QwenContentGenerator(qwenClient, generatorConfig, config);
        }, "loadBaseGenerator");
      } catch (error) {
        if (getModuleNotFoundError(error)) {
          throw error;
        }
        throw new Error(error instanceof Error ? error.message : String(error));
      }
    } else if (authType === "anthropic" /* USE_ANTHROPIC */) {
      loadBaseGenerator = /* @__PURE__ */ __name(async () => {
        const { createAnthropicContentGenerator } = await import("./anthropicContentGenerator-APZU4YXT.js");
        return createAnthropicContentGenerator(generatorConfig, config);
      }, "loadBaseGenerator");
    } else if (authType === "gemini" /* USE_GEMINI */ || authType === "vertex-ai" /* USE_VERTEX_AI */) {
      loadBaseGenerator = /* @__PURE__ */ __name(async () => {
        const { createLlmContentGenerator } = await import("./llm-content-generator-PGOLGFJW.js");
        return createLlmContentGenerator(generatorConfig, config);
      }, "loadBaseGenerator");
    } else {
      throw new Error(
        `Error creating contentGenerator: Unsupported authType: ${authType}`
      );
    }
  } catch (error) {
    throw wrapProviderLoadError(error, authType);
  }
  return new LazyContentGenerator(async () => {
    try {
      const [baseGenerator, { LoggingContentGenerator }] = await Promise.all([
        loadBaseGenerator(),
        import("./loggingContentGenerator-KKG6HSD3.js")
      ]);
      return new LoggingContentGenerator(
        baseGenerator,
        config,
        generatorConfig
      );
    } catch (error) {
      throw wrapProviderLoadError(error, authType);
    }
  });
}
__name(createContentGenerator, "createContentGenerator");

// packages/core/src/core/modalityDefaults.ts
init_esbuild_shims();
var FULL_MULTIMODAL = {
  image: true,
  pdf: true,
  audio: true,
  video: true
};
var MODALITY_PATTERNS = [
  // -------------------
  // Google Gemini — full multimodal
  // -------------------
  [/^gemini-3/, FULL_MULTIMODAL],
  [/^gemini-/, FULL_MULTIMODAL],
  // -------------------
  // OpenAI — image by default for all gpt/o-series models
  // -------------------
  [/^gpt-5/, { image: true }],
  [/^gpt-/, { image: true }],
  [/^o\d/, { image: true }],
  // -------------------
  // Anthropic Claude — image + pdf
  // -------------------
  [/^claude-/, { image: true, pdf: true }],
  // -------------------
  // Alibaba / Qwen
  // -------------------
  // Qwen Omni models: full multimodal (image + audio + video) — the omni
  // harness targets these. Must precede the qwen3.x-plus/qwen fallbacks:
  // "qwen3.5-omni-plus" would otherwise match /^qwen/ and be text-only.
  [/^qwen\d*\.?\d*-omni/, FULL_MULTIMODAL],
  [/^qwen-omni/, FULL_MULTIMODAL],
  // Qwen Plus models: image + video support
  [/^qwen3\.5-plus/, { image: true, video: true }],
  [/^qwen3\.6-plus/, { image: true, video: true }],
  [/^qwen3\.7-plus/, { image: true, video: true }],
  // Qwen 3.8 series: flash/plus support image + video; max supports image only
  [/^qwen3\.8-flash/, { image: true, video: true }],
  [/^qwen3\.8-plus/, { image: true, video: true }],
  [/^qwen3\.8-max/, { image: true }],
  [/^coder-model$/, { image: true, video: true }],
  // Qwen VL (vision-language) models: image + video
  [/^qwen-vl-/, { image: true, video: true }],
  [/^qwen3-vl-/, { image: true, video: true }],
  // Qwen coder / text models: text-only
  [/^qwen3-coder-/, {}],
  // Qwen3.6-35B-A3B (local quant variants) — image + video
  [/^qwen3\.6-35b/, { image: true, video: true }],
  [/^qwen/, {}],
  // -------------------
  // DeepSeek — text-only, except explicit vision variants
  // (QwenLM/qwen-code#10270)
  // -------------------
  [/^deepseek-.*vision/, { image: true }],
  [/^deepseek/, {}],
  // -------------------
  // Zhipu GLM — v-suffix ids are vision models; others are text-only
  // (QwenLM/qwen-code#10270)
  // -------------------
  [/^glm-[0-9.]+v/, { image: true }],
  // glm-5.3-flash natively integrates vision input (no v suffix)
  [/^glm-5\.3-flash/, { image: true }],
  [/^glm-5(?:-|$)/, {}],
  [/^glm-/, {}],
  // -------------------
  // MiniMax — M3 supports image + video input; older models default to text-only
  // -------------------
  [/^minimax-m3/i, { image: true, video: true }],
  [/^minimax-/, {}],
  // -------------------
  // Moonshot / Kimi
  // -------------------
  [/^kimi-k3/, { image: true, video: true }],
  [/^kimi-k2\./, { image: true, video: true }],
  [/^kimi-/, {}],
  // -------------------
  // ByteDance Doubao — Seed-series and *-vision / *-vl models accept image
  // input; other Doubao models (pro / lite / text) are text-only.
  // (QwenLM/qwen-code#4876)
  // -------------------
  // seedance (text→video) and seedream (text→image) are generation models with
  // text-only input — exclude them before the multimodal Seed chat series.
  [/^doubao-seed(ance|ream)/, {}],
  [/^doubao-seed/, { image: true }],
  [/^doubao-.*(vision|vl)/, { image: true }],
  [/^doubao/, {}]
];
function defaultModalities(model) {
  const norm = normalize(model);
  for (const [regex, modalities] of MODALITY_PATTERNS) {
    if (regex.test(norm)) {
      return { ...modalities };
    }
  }
  return {};
}
__name(defaultModalities, "defaultModalities");
function isQwenFamilyWireModel(model) {
  if (!model) {
    return false;
  }
  const normalized = model.toLowerCase();
  return normalized.startsWith("qwen") || normalized === "coder-model";
}
__name(isQwenFamilyWireModel, "isQwenFamilyWireModel");
function isTieredEffortWireModel(model, configuredReasoning) {
  if (!model) {
    return false;
  }
  const reasoning = parseModelReasoningCapabilities(configuredReasoning);
  if (reasoning) {
    return isQwenFamilyWireModel(model) && !reasoning.toggleOnly && reasoning.disableField === "reasoning_effort";
  }
  return model.toLowerCase().startsWith("qwen3.8-max");
}
__name(isTieredEffortWireModel, "isTieredEffortWireModel");

export {
  getDefaultApiKeyEnvVar,
  VERTEX_ADC_HINT,
  DEFAULT_QWEN_EMBEDDING_MODEL,
  MAINLINE_CODER_MODEL,
  MODEL_GENERATION_CONFIG_FIELDS,
  PROVIDER_SOURCED_FIELDS,
  AUTH_ENV_MAPPINGS,
  DEFAULT_MODELS,
  QWEN_OAUTH_MODELS,
  QWEN_OAUTH_ALLOWED_MODELS,
  DEFAULT_TOKEN_LIMIT,
  OUTPUT_TOKEN_CEILING,
  clampOutputTokensToWindow,
  parsePositiveIntegerEnvValue,
  normalize,
  hasExplicitOutputLimit,
  knownTokenLimit,
  tokenLimit,
  defaultOutputCeiling,
  reconcileMaxTokens,
  REASONING_EFFORT_TIERS,
  getGptReasoningCapabilities,
  isReasoningEffortPlaceholder,
  normalizeReasoningEffort,
  clampReasoningEffort,
  applyReasoningEffort,
  setGeneratorReasoningEffort,
  reasoningEffortsForCapability,
  parseModelReasoningCapabilities,
  defaultModalities,
  isQwenFamilyWireModel,
  isTieredEffortWireModel,
  resolveContentGeneratorConfigWithSources,
  hasVertexProjectConfigured,
  preloadContentGenerator,
  resetPreloadedContentGenerator,
  createContentGenerator
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
