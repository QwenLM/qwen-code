// Force strict mode and setup for ESM
"use strict";
import {
  DASHSCOPE_PROXY_BASE_URL,
  DEFAULT_DASHSCOPE_BASE_URL,
  DEFAULT_MAX_RETRIES,
  buildSessionAwareFetch,
  getEffectiveReasoning,
  isOpenRouterHostname,
  resolveReasoningForModel,
  resolveRequestTimeout
} from "./chunk-TLS6QN2S.js";
import {
  REASONING_EFFORT_TIERS,
  clampReasoningEffort,
  defaultOutputCeiling,
  getGptReasoningCapabilities,
  hasExplicitOutputLimit,
  isQwenFamilyWireModel,
  isReasoningEffortPlaceholder,
  isTieredEffortWireModel,
  parsePositiveIntegerEnvValue,
  tokenLimit
} from "./chunk-KUON6Z6R.js";
import {
  buildRuntimeFetchOptions
} from "./chunk-SBP43AO6.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  OpenAI
} from "./chunk-UKMWZ5NS.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/core/openaiContentGenerator/provider/default.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("DefaultOpenAICompatibleProvider");
var OPENAI_COMPATIBLE_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh"
];
function isQwen3Model(model) {
  return model.toLowerCase().includes("qwen3");
}
__name(isQwen3Model, "isQwen3Model");
function mirrorReasoningContentToReasoning(message) {
  if (message.role !== "assistant") {
    return message;
  }
  const assistant = message;
  if (typeof assistant.reasoning_content !== "string" || assistant.reasoning_content.length === 0 || typeof assistant.reasoning === "string") {
    return message;
  }
  return {
    ...assistant,
    reasoning: assistant.reasoning_content
  };
}
__name(mirrorReasoningContentToReasoning, "mirrorReasoningContentToReasoning");
var DefaultOpenAICompatibleProvider = class {
  static {
    __name(this, "DefaultOpenAICompatibleProvider");
  }
  contentGeneratorConfig;
  cliConfig;
  /**
   * Latch so an effort-clamp warning fires once per provider lifetime. Shared
   * with subclasses that clamp on their own wire shape (see DashScope) so one
   * provider instance never repeats the notice.
   */
  effortClampWarned = false;
  constructor(contentGeneratorConfig, cliConfig) {
    this.cliConfig = cliConfig;
    this.contentGeneratorConfig = contentGeneratorConfig;
  }
  buildHeaders() {
    const version = this.cliConfig.getCliVersion() || "unknown";
    const userAgent = `QwenCode/${version} (${process.platform}; ${process.arch})`;
    const { customHeaders } = this.contentGeneratorConfig;
    const defaultHeaders = {
      "User-Agent": userAgent
    };
    return customHeaders ? { ...defaultHeaders, ...customHeaders } : defaultHeaders;
  }
  buildClient() {
    const {
      apiKey,
      baseUrl,
      maxRetries = DEFAULT_MAX_RETRIES
    } = this.contentGeneratorConfig;
    const timeout = resolveRequestTimeout(this.contentGeneratorConfig.timeout);
    const defaultHeaders = this.buildHeaders();
    const runtimeOptions = buildRuntimeFetchOptions(
      "openai",
      this.cliConfig.getProxy()
    );
    return new OpenAI({
      apiKey,
      baseURL: baseUrl,
      timeout,
      maxRetries,
      defaultHeaders,
      ...runtimeOptions || {},
      fetch: buildSessionAwareFetch(
        runtimeOptions?.fetch,
        this.cliConfig,
        this.contentGeneratorConfig.customHeaders
      )
    });
  }
  /**
   * Effort tiers this endpoint accepts for `model`. Takes the wire model
   * rather than reading the configured one, because a request may override it
   * (`pipeline.ts` resolves `request.model || contentGeneratorConfig.model`),
   * and a capability answered for the wrong model is how an unaccepted tier
   * reaches the wire. Override in a subclass whose endpoint takes `max`; the
   * clamp calls it through `this`, so a subclass answer applies even on the
   * `super.buildRequest` path.
   */
  supportedReasoningEffortsFor(model) {
    const configured = this.getReasoningCapabilities(model);
    if (!configured?.profile && !getGptReasoningCapabilities(model))
      return OPENAI_COMPATIBLE_EFFORTS;
    if (configured && !configured.toggleOnly) return configured.efforts;
    return getGptReasoningCapabilities(model)?.efforts ?? OPENAI_COMPATIBLE_EFFORTS;
  }
  getReasoningCapabilities(model) {
    return resolveReasoningForModel(
      this.cliConfig,
      this.contentGeneratorConfig,
      model
    );
  }
  /**
   * Cap the pipeline-injected `reasoning.effort` at what this endpoint accepts.
   * The tier is configured once (`/effort`) and persisted, so an unaccepted
   * value is not a one-off rejection: it 400s every later request in the
   * session too.
   *
   * Only the pipeline-injected tier is capped. A `reasoning` object the user
   * put in `samplingParams` ships verbatim. Unrelated GPT sampling options
   * still receive the configured effort and need clamping. `extra_body`
   * merges after this, so both explicit overrides survive unchanged.
   */
  clampConfiguredReasoningEffort(request) {
    if (this.contentGeneratorConfig.samplingParams?.["reasoning"] !== void 0 || this.getReasoningCapabilities(request.model)?.profile) {
      return request;
    }
    const loose = request;
    const reasoning = loose["reasoning"];
    const effort = reasoning?.effort;
    if (typeof effort !== "string" || !REASONING_EFFORT_TIERS.includes(effort)) {
      return request;
    }
    const clamped = clampReasoningEffort(
      effort,
      this.supportedReasoningEffortsFor(
        loose["model"] ?? this.contentGeneratorConfig.model
      )
    );
    if (clamped === effort) {
      return request;
    }
    if (!this.effortClampWarned) {
      debugLogger.warn(
        `reasoning.effort='${effort}' is not accepted by this OpenAI-compatible endpoint; using '${clamped}'.`
      );
      this.effortClampWarned = true;
    }
    return {
      ...loose,
      reasoning: { ...reasoning, effort: clamped }
    };
  }
  buildRequest(request, _userPromptId) {
    const extraBody = this.contentGeneratorConfig.extra_body;
    const requestWithTokenLimits = this.clampConfiguredReasoningEffort(
      this.applyOutputTokenLimit(request)
    );
    const profile = this.getReasoningCapabilities(request.model)?.profile;
    const messages = !profile && isQwen3Model(request.model) || profile === "qwen-chat-template" ? requestWithTokenLimits.messages.map(mirrorReasoningContentToReasoning) : requestWithTokenLimits.messages;
    const result = {
      ...requestWithTokenLimits,
      messages,
      ...extraBody ? extraBody : {}
    };
    this.flattenGptReasoningEffort(result);
    return result;
  }
  flattenGptReasoningEffort(body) {
    if (this.getReasoningCapabilities(body["model"])?.profile || !getGptReasoningCapabilities(body["model"]) || isOpenRouterHostname(this.contentGeneratorConfig) || this.contentGeneratorConfig.samplingParams?.["reasoning"] !== void 0 || this.contentGeneratorConfig.extra_body?.["reasoning"] !== void 0)
      return;
    const reasoning = body["reasoning"];
    if (typeof reasoning?.effort !== "string" || !reasoning.effort) return;
    if (isReasoningEffortPlaceholder(body["reasoning_effort"])) {
      body["reasoning_effort"] = reasoning.effort;
    }
    const { effort: _drop, ...rest } = reasoning;
    if (Object.keys(rest).length > 0) body["reasoning"] = rest;
    else delete body["reasoning"];
  }
  getDefaultGenerationConfig() {
    return {};
  }
  getResponseParsingOptions(model) {
    return {
      contentOnlyThinkingTagLeaks: true,
      ...model && isQwen3Model(model) ? { taggedThinkingTagsAfterReasoning: true } : {}
    };
  }
  /**
   * Apply output token limit to a request's max_tokens parameter.
   *
   * Purpose:
   * Some APIs (e.g., OpenAI-compatible) default to a very small max_tokens value,
   * which can cause responses to be truncated mid-output. This function ensures
   * a reasonable default is set while respecting user configuration.
   *
   * Logic:
   * 1. If user explicitly configured max_tokens:
   *    - For known models (in OUTPUT_PATTERNS): use the user's value, but cap at
   *      model's max output limit to avoid API errors
   *      (input + max_output > contextWindowSize would cause 400 errors on some APIs)
   *    - For unknown models (deployment aliases, self-hosted): respect user's
   *      configured value entirely (backend may support larger limits)
   * 2. If user didn't configure max_tokens:
   *    - Check QWEN_CODE_MAX_OUTPUT_TOKENS env var first
   *    - Otherwise use the model's output limit, clipped to
   *      OUTPUT_TOKEN_CEILING (64K)
   * 3. If model has no specific limit (tokenLimit returns default):
   *    - Use DEFAULT_OUTPUT_TOKEN_LIMIT
   *
   * Examples:
   * - User sets 4K, known model limit 64K → uses 4K (respects user preference)
   * - User sets 100K, known model limit 64K → uses 64K (capped to avoid API error)
   * - User sets 100K, unknown model → uses 100K (respects user, backend may support it)
   * - User not set, model limit 64K → uses 64K
   * - User not set, model limit 4K → uses 4K (model limit is lower)
   * - User not set, env QWEN_CODE_MAX_OUTPUT_TOKENS=16000 -> uses 16K
   *
   * @param request - The chat completion request parameters
   * @returns The request with max_tokens adjusted according to the logic
   */
  applyOutputTokenLimit(request) {
    if (this.contentGeneratorConfig.samplingParams !== void 0) {
      return request;
    }
    const userMaxTokens = request.max_tokens;
    const modelLimit = tokenLimit(request.model, "output");
    const isKnownModel = hasExplicitOutputLimit(request.model);
    let effectiveMaxTokens;
    if (userMaxTokens !== void 0 && userMaxTokens !== null) {
      if (isKnownModel) {
        effectiveMaxTokens = Math.min(userMaxTokens, modelLimit);
      } else {
        effectiveMaxTokens = userMaxTokens;
      }
    } else {
      const envMaxTokens = parsePositiveIntegerEnvValue(
        process.env["QWEN_CODE_MAX_OUTPUT_TOKENS"]
      );
      if (envMaxTokens !== void 0) {
        effectiveMaxTokens = isKnownModel ? Math.min(envMaxTokens, modelLimit) : envMaxTokens;
      } else {
        effectiveMaxTokens = defaultOutputCeiling(request.model);
      }
    }
    return {
      ...request,
      max_tokens: effectiveMaxTokens
    };
  }
};

// packages/core/src/core/openaiContentGenerator/provider/dashscope.ts
init_esbuild_shims();
var debugLogger2 = createDebugLogger("DashScopeOpenAICompatibleProvider");
var DASHSCOPE_TIERED_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh"
];
function selectDashScopeThinkingKnob(model, extraBody, samplingParams, reasoningEffort, tieredModel = isTieredEffortWireModel(model)) {
  if (!tieredModel) {
    return void 0;
  }
  const selectFromLayer = /* @__PURE__ */ __name((source, layer) => {
    if (layer?.["enable_thinking"] === false) {
      return { source, field: "enable_thinking", value: false };
    }
    return selectValueFromLayer(source, layer) ?? selectOnSwitch(source, layer);
  }, "selectFromLayer");
  const selectValueFromLayer = /* @__PURE__ */ __name((source, layer) => {
    if (layer?.["reasoning_effort"] != null) {
      return {
        source,
        field: "reasoning_effort",
        value: layer["reasoning_effort"]
      };
    }
    if (layer?.["thinking_budget"] != null) {
      return {
        source,
        field: "thinking_budget",
        value: layer["thinking_budget"]
      };
    }
    return void 0;
  }, "selectValueFromLayer");
  const selectOnSwitch = /* @__PURE__ */ __name((source, layer) => {
    if (layer?.["enable_thinking"] === true) {
      return { source, field: "enable_thinking", value: true };
    }
    return void 0;
  }, "selectOnSwitch");
  const reasoningSelection = reasoningEffort !== void 0 ? {
    source: "reasoning",
    field: "reasoning_effort",
    value: reasoningEffort
  } : void 0;
  const extraBodySelection = selectFromLayer("extra_body", extraBody);
  if (extraBodySelection?.field === "enable_thinking" && extraBodySelection.value === true) {
    return selectValueFromLayer("samplingParams", samplingParams) ?? reasoningSelection ?? extraBodySelection;
  }
  if (extraBodySelection) {
    return extraBodySelection;
  }
  const samplingSelection = selectFromLayer("samplingParams", samplingParams);
  return samplingSelection?.field === "enable_thinking" && samplingSelection.value === true ? reasoningSelection ?? samplingSelection : samplingSelection ?? reasoningSelection;
}
__name(selectDashScopeThinkingKnob, "selectDashScopeThinkingKnob");
function withoutNullishThinkingKnobs(layer) {
  if (!layer) {
    return void 0;
  }
  const hasNullishEnableThinking = "enable_thinking" in layer && layer["enable_thinking"] == null;
  const hasNullishEffort = "reasoning_effort" in layer && layer["reasoning_effort"] == null;
  const hasNullishBudget = "thinking_budget" in layer && layer["thinking_budget"] == null;
  if (!hasNullishEnableThinking && !hasNullishEffort && !hasNullishBudget) {
    return layer;
  }
  const sanitized = { ...layer };
  if (hasNullishEnableThinking) {
    delete sanitized["enable_thinking"];
  }
  if (hasNullishEffort) {
    delete sanitized["reasoning_effort"];
  }
  if (hasNullishBudget) {
    delete sanitized["thinking_budget"];
  }
  return sanitized;
}
__name(withoutNullishThinkingKnobs, "withoutNullishThinkingKnobs");
var DASHSCOPE_REGIONAL_HOSTS = [
  "dashscope.aliyuncs.com",
  "dashscope-intl.aliyuncs.com",
  "dashscope-us.aliyuncs.com"
];
var DashScopeOpenAICompatibleProvider = class _DashScopeOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  static {
    __name(this, "DashScopeOpenAICompatibleProvider");
  }
  constructor(contentGeneratorConfig, cliConfig) {
    super(contentGeneratorConfig, cliConfig);
  }
  /**
   * Determines whether to use the DashScope-compatible provider.
   * Covers the official regional hosts (DASHSCOPE_REGIONAL_HOSTS),
   * Token Plan endpoints under token-plan.<region>.maas.aliyuncs.com,
   * internal Alibaba domains (*.alibaba-inc.com, *.aliyun-inc.com),
   * Alibaba Cloud API Gateway domains (*.alicloudapi.com),
   * and proxy matches.
   *
   * Note: any *.alibaba-inc.com / *.aliyun-inc.com host is treated as a
   * DashScope-compatible endpoint by design. Keep this generic and avoid
   * embedding individual private gateway hostnames in provider detection.
   */
  static isDashScopeProvider(contentGeneratorConfig) {
    const { authType, baseUrl } = contentGeneratorConfig;
    if (authType === "qwen-oauth" /* QWEN_OAUTH */) return true;
    if (!baseUrl) return true;
    const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    let hostname = null;
    try {
      hostname = new URL(normalizedBaseUrl).hostname.toLowerCase();
    } catch {
      hostname = null;
    }
    const isDashscopeOrigin = hostname !== null && DASHSCOPE_REGIONAL_HOSTS.some(
      (host) => hostname === host || hostname.endsWith("." + host)
    );
    const isTokenPlanOrigin = hostname !== null && hostname.startsWith("token-plan.") && hostname.endsWith(".maas.aliyuncs.com");
    const isInternalOrigin = hostname !== null && (hostname.endsWith(".alibaba-inc.com") || hostname.endsWith(".aliyun-inc.com"));
    const isAliCloudApiOrigin = hostname !== null && hostname.endsWith(".alicloudapi.com");
    const normalizedProxyUrl = DASHSCOPE_PROXY_BASE_URL?.endsWith("/") ? DASHSCOPE_PROXY_BASE_URL.slice(0, -1) : DASHSCOPE_PROXY_BASE_URL;
    const isProxyMatch = Boolean(
      normalizedProxyUrl && normalizedBaseUrl.toLowerCase() === normalizedProxyUrl.toLowerCase()
    );
    if (normalizedProxyUrl && !isDashscopeOrigin && !isTokenPlanOrigin && !isInternalOrigin && !isAliCloudApiOrigin && !isProxyMatch) {
      debugLogger2.debug(
        `DASHSCOPE_PROXY_BASE_URL is configured but the request baseUrl does not match. DashScope headers/cache control will be skipped.`
      );
    }
    if (isInternalOrigin) {
      debugLogger2.debug(
        `DashScope provider activated via internal origin: ${hostname}`
      );
    }
    if (isAliCloudApiOrigin) {
      debugLogger2.debug(
        `DashScope provider activated via alicloudapi origin: ${hostname}`
      );
    }
    return isDashscopeOrigin || isTokenPlanOrigin || isInternalOrigin || isAliCloudApiOrigin || isProxyMatch;
  }
  buildHeaders() {
    const version = this.cliConfig.getCliVersion() || "unknown";
    const userAgent = `QwenCode/${version} (${process.platform}; ${process.arch})`;
    const { authType, customHeaders } = this.contentGeneratorConfig;
    const defaultHeaders = {
      "User-Agent": userAgent,
      "X-DashScope-CacheControl": "enable",
      "X-DashScope-UserAgent": userAgent,
      "X-DashScope-AuthType": authType
    };
    if (this.cliConfig.isOmniEnabled?.()) {
      defaultHeaders["X-DashScope-OssResourceResolve"] = "enable";
    }
    return customHeaders ? { ...defaultHeaders, ...customHeaders } : defaultHeaders;
  }
  buildClient() {
    const {
      apiKey,
      baseUrl = DEFAULT_DASHSCOPE_BASE_URL,
      maxRetries = DEFAULT_MAX_RETRIES
    } = this.contentGeneratorConfig;
    const timeout = resolveRequestTimeout(this.contentGeneratorConfig.timeout);
    const defaultHeaders = this.buildHeaders();
    const runtimeOptions = buildRuntimeFetchOptions(
      "openai",
      this.cliConfig.getProxy()
    );
    return new OpenAI({
      apiKey,
      baseURL: baseUrl,
      timeout,
      maxRetries,
      defaultHeaders,
      ...runtimeOptions || {},
      fetch: buildSessionAwareFetch(
        runtimeOptions?.fetch,
        this.cliConfig,
        this.contentGeneratorConfig.customHeaders
      )
    });
  }
  /**
   * Build and configure the request for DashScope API.
   *
   * This method applies DashScope-specific configurations including:
   * - Cache control for the system message, last tool message (when tools are configured),
   *   and the latest history message — or, when a reattach region trails the
   *   conversation, the last stable block before it
   * - Output token limits based on model capabilities
   * - Vision model specific parameters (vl_high_resolution_images)
   * - Request metadata for session tracking
   *
   * @param request - The original chat completion request parameters
   * @param userPromptId - Unique identifier for the user prompt for session tracking
   * @param reattachBlockCount - Number of trailing blocks in the last message that
   *   belong to the regenerated reattach region; the conversation cache breakpoint
   *   is placed before them. Defaults to 0 (last block of the last message).
   * @returns Configured request with DashScope-specific parameters applied
   */
  buildRequest(request, userPromptId, reattachBlockCount = 0) {
    let messages = request.messages;
    let tools = request.tools;
    const flattenPlainTextForGlm = this.isGlmModel(request.model) && !this.hasFunctionCallingContext(request);
    if (flattenPlainTextForGlm) {
      messages = this.flattenTextContent(messages);
    } else if (this.shouldEnableCacheControl()) {
      const { messages: updatedMessages, tools: updatedTools } = this.addDashScopeCacheControl(
        request,
        request.stream ? "all" : "system_only",
        reattachBlockCount
      );
      messages = updatedMessages;
      tools = updatedTools;
    }
    const requestWithTokenLimits = this.applyOutputTokenLimit(request);
    const isTieredQwenModel = this.isTieredEffortModel(request.model);
    const extraBody = isTieredQwenModel ? withoutNullishThinkingKnobs(this.contentGeneratorConfig.extra_body) : this.contentGeneratorConfig.extra_body;
    const qwenEffortConfig = this.buildQwenEffortConfig(request.model);
    const rawRequestParams = requestWithTokenLimits;
    const requestParams = isTieredQwenModel ? withoutNullishThinkingKnobs(rawRequestParams) : rawRequestParams;
    if ("reasoning_effort" in requestParams && "reasoning_effort" in qwenEffortConfig) {
      qwenEffortConfig["reasoning_effort"] = requestParams["reasoning_effort"];
    }
    const hasQwenEffortConfig = Object.keys(qwenEffortConfig).length > 0;
    const selectedThinkingKnob = isTieredQwenModel ? selectDashScopeThinkingKnob(
      this.resolveWireModel(request.model),
      extraBody,
      requestParams,
      qwenEffortConfig["reasoning_effort"],
      isTieredQwenModel
    ) : void 0;
    if (this.isVisionModel(request.model)) {
      const dashscopeExtras2 = {
        vl_high_resolution_images: true,
        preserve_thinking: true,
        ...qwenEffortConfig
      };
      const visionResult = {
        ...requestParams,
        messages,
        ...tools ? { tools } : {},
        ...this.buildRequestMetadata(request.model, userPromptId),
        ...dashscopeExtras2
      };
      if (hasQwenEffortConfig && "reasoning" in visionResult) {
        delete visionResult["reasoning"];
      }
      return this.mergeExtraBodyAndResolveKnobs(
        hasQwenEffortConfig ? visionResult : this.clampConfiguredReasoningEffort(visionResult),
        extraBody,
        request.model,
        selectedThinkingKnob
      );
    }
    const dashscopeExtras = {
      preserve_thinking: true,
      ...qwenEffortConfig
    };
    const result = {
      ...requestParams,
      // Preserve all original parameters including sampling params and adjusted max_tokens
      messages,
      ...tools ? { tools } : {},
      ...this.buildRequestMetadata(request.model, userPromptId),
      ...dashscopeExtras
    };
    if (hasQwenEffortConfig && "reasoning" in result) {
      delete result["reasoning"];
    }
    return this.mergeExtraBodyAndResolveKnobs(
      hasQwenEffortConfig ? result : this.clampConfiguredReasoningEffort(result),
      extraBody,
      request.model,
      selectedThinkingKnob
    );
  }
  /**
   * Shared tail for the vision and text branches: merge user extra_body
   * last, then resolve thinking-knob conflicts against the wire model.
   */
  mergeExtraBodyAndResolveKnobs(result, extraBody, model, selectedThinkingKnob) {
    const merged = {
      ...result,
      ...extraBody ? extraBody : {}
    };
    const reasoningEffort = merged["reasoning_effort"];
    const dropped = /* @__PURE__ */ new Set();
    if (selectedThinkingKnob?.field === "thinking_budget") {
      if (reasoningEffort !== void 0) {
        dropped.add("reasoning_effort");
      }
      if (merged["enable_thinking"] === false) {
        dropped.add("enable_thinking");
      }
    }
    if (selectedThinkingKnob?.field === "reasoning_effort" && merged["thinking_budget"] !== void 0) {
      dropped.add("thinking_budget");
    }
    for (const key of dropped) {
      delete merged[key];
    }
    for (const key of this.dropConflictingThinkingKnobs(
      model,
      merged,
      selectedThinkingKnob
    )) {
      dropped.add(key);
    }
    this.warnConflictingKnobDrop(model, reasoningEffort, [...dropped]);
    this.flattenGptReasoningEffort(merged);
    return merged;
  }
  getConfiguredReasoning(model) {
    return this.getReasoningCapabilities(model);
  }
  isTieredEffortModel(model) {
    const configured = this.getConfiguredReasoning(model);
    if (configured?.profile) return configured.profile === "dashscope-effort";
    return isTieredEffortWireModel(
      model ?? this.contentGeneratorConfig.model,
      configured
    );
  }
  resolveWireModel(model) {
    return (model ?? this.contentGeneratorConfig.model ?? "").toLowerCase();
  }
  /**
   * Translate the unified reasoning effort into the wire shape the model
   * accepts. The qwen3.8-max family takes the tiered `reasoning_effort`
   * directly; older qwen hybrid models expose only the on/off
   * `enable_thinking` switch, so the effort ladder collapses to on/off
   * there. Gated to qwen-family wire models (mirroring the pipeline's
   * disable gate) so the qwen-specific fields never leak to a non-qwen
   * model sharing the DashScope endpoint.
   */
  buildQwenEffortConfig(model) {
    const configured = this.getConfiguredReasoning(model);
    if (configured?.profile) return {};
    const reasoning = getEffectiveReasoning(
      this.contentGeneratorConfig,
      configured
    );
    if (!reasoning || reasoning.effort === void 0) {
      return {};
    }
    const wireModel = this.resolveWireModel(model);
    if (this.isTieredEffortModel(model)) {
      const configured2 = this.getConfiguredReasoning(model);
      if (configured2 && !configured2.toggleOnly) {
        return configured2.efforts.includes(reasoning.effort) ? { reasoning_effort: reasoning.effort } : {};
      }
      return { reasoning_effort: this.clampTieredEffort(reasoning.effort) };
    }
    if (isQwenFamilyWireModel(wireModel)) {
      return { enable_thinking: true };
    }
    return {};
  }
  /**
   * Preserve the legacy clamp for a route without an explicit capability.
   * Only the unified reasoning.effort preference reaches this fallback;
   * extra_body and samplingParams remain verbatim provider overrides.
   */
  clampTieredEffort(effort) {
    const clamped = clampReasoningEffort(effort, DASHSCOPE_TIERED_EFFORTS);
    if (clamped !== effort && !this.effortClampWarned) {
      debugLogger2.warn(
        `reasoning.effort='${effort}' is not accepted by the DashScope tiered-effort family; using '${clamped}'.`
      );
      this.effortClampWarned = true;
    }
    return clamped;
  }
  /**
   * Resolve thinking knobs that conflict with a shipping `reasoning_effort`.
   * Preset extra_body injects `enable_thinking` for models declared with
   * enableThinking (provider-config.ts), and user extra_body merges last.
   * Only the qwen3.8-max family reads `reasoning_effort` itself — there an
   * effort tier ships alone: an `enable_thinking: true` alongside an effort
   * tier is a second competing knob (the shape the nested-`reasoning` strip
   * in buildRequest exists to prevent), and DashScope rejects
   * `reasoning_effort` combined with `thinking_budget`. The `'none'`
   * disable and a winning `thinking_budget` intentionally keep a co-present
   * `enable_thinking: true`. Explicit same-layer effort/budget pairs retain
   * reasoning_effort, matching the provider's behavior before cross-layer
   * resolution. An explicit `enable_thinking: false` is the documented
   * extra_body escape hatch winning over the config tier, so it is honoured
   * as the family's canonical disable (`reasoning_effort: 'none'`, preserved
   * by the pipeline's disable strip) rather than silently deleted; a
   * higher-priority `enable_thinking: true` conversely keeps the shipping
   * tier. Older qwen
   * hybrids read `enable_thinking` / `thinking_budget`, not
   * `reasoning_effort`, so when an opaque reasoning_effort override
   * conflicts with a meaningful thinking_budget the inert field goes and
   * the knobs the model reads survive. Non-qwen models treat
   * `reasoning_effort` as an opaque sampling override and keep every knob.
   */
  dropConflictingThinkingKnobs(model, merged, selectedThinkingKnob) {
    const wireModel = this.resolveWireModel(model);
    if (!isQwenFamilyWireModel(wireModel)) {
      return [];
    }
    const isTieredEffortModel = this.isTieredEffortModel(model);
    if (isTieredEffortModel && selectedThinkingKnob?.field === "enable_thinking" && selectedThinkingKnob.value === false) {
      merged["reasoning_effort"] = "none";
      const dropped = ["enable_thinking"];
      if (merged["thinking_budget"] !== void 0) {
        dropped.push("thinking_budget");
      }
      for (const key of dropped) {
        delete merged[key];
      }
      return dropped;
    }
    const effort = merged["reasoning_effort"];
    if (typeof effort !== "string") {
      return [];
    }
    if (isTieredEffortModel && effort === "none") {
      if (merged["thinking_budget"] === void 0) {
        return [];
      }
      delete merged["thinking_budget"];
      return ["thinking_budget"];
    }
    if (isTieredEffortModel) {
      if (selectedThinkingKnob?.field === "reasoning_effort" && "enable_thinking" in merged) {
        delete merged["enable_thinking"];
        return ["enable_thinking"];
      }
      return [];
    }
    if (merged["thinking_budget"] === void 0) {
      return [];
    }
    delete merged["reasoning_effort"];
    return ["reasoning_effort"];
  }
  warnConflictingKnobDrop(model, reasoningEffort, dropped) {
    if (dropped.length === 0) {
      return;
    }
    if (!this.conflictingKnobDropWarned) {
      this.conflictingKnobDropWarned = true;
      debugLogger2.warn("DashScope: dropped conflicting thinking knobs", {
        model: this.resolveWireModel(model),
        reasoningEffort,
        dropped
      });
    }
  }
  conflictingKnobDropWarned = false;
  /**
   * DashScope is an aggregating gateway: a non-qwen model (e.g. `ZHIPU/GLM-...`)
   * reached through the same endpoint has its request forwarded to that vendor's
   * own backend, `metadata` object included. Those backends type `metadata` as a
   * string, so the object fails to deserialize and the request is rejected with a
   * flat 400, making the model unusable through Qwen Code. `metadata` is a
   * platform-private tracing field (sessionId / promptId / channel) that only
   * means anything to DashScope's own inference path, so gate it on the wire model
   * the same way `buildQwenEffortConfig` gates the qwen-only thinking knobs, for
   * the same stated reason: qwen-specific fields must not leak to a non-qwen model
   * sharing the endpoint.
   *
   * This is orthogonal to which *origins* count as DashScope-compatible, so the
   * `*.alicloudapi.com` recognition added in #9103 is untouched: a qwen model
   * behind such a gateway still ships metadata.
   */
  buildRequestMetadata(model, userPromptId) {
    if (!this.shouldSendRequestMetadata(model)) {
      return {};
    }
    return this.buildMetadata(userPromptId) || {};
  }
  /**
   * Auto by default: qwen-family wire models only, per the gateway reasoning on
   * {@link buildRequestMetadata}. The client cannot tell a forwarded request from
   * one DashScope serves itself, so an explicit `enableRequestMetadata` wins in
   * both directions: `true` restores the field for a non-qwen model served
   * first-party whose tracing still matters, `false` suppresses it everywhere.
   * Read only from the provider's own config, never the session's. A
   * side-model generator is built with its own per-model config but shares
   * the session `Config`, and a cross-provider agent config deliberately
   * clears this field, so any session fallback would let the main model's
   * value decide a different model's request. On the main route the provider
   * config is the same object the qwen-oauth hot switch mutates in place, so
   * nothing is latched here.
   */
  shouldSendRequestMetadata(model) {
    const configured = this.contentGeneratorConfig.enableRequestMetadata;
    if (typeof configured === "boolean") {
      return configured;
    }
    return isQwenFamilyWireModel(this.resolveWireModel(model));
  }
  buildMetadata(userPromptId) {
    const channel = this.cliConfig.getChannel?.();
    return {
      metadata: {
        sessionId: this.cliConfig.getSessionId?.(),
        promptId: userPromptId,
        ...channel ? { channel } : {}
      }
    };
  }
  getDefaultGenerationConfig() {
    return {};
  }
  /**
   * Add cache control flag to specified message(s) for DashScope providers
   */
  addDashScopeCacheControl(request, cacheControl, reattachBlockCount = 0) {
    const messages = request.messages;
    const systemIndex = messages.findIndex((msg) => msg.role === "system");
    const lastIndex = messages.length - 1;
    const stableBlock = reattachBlockCount > 0 && lastIndex >= 0 ? this.lastStableBlock(messages, reattachBlockCount) : { messageIndex: lastIndex, excludeTail: 0 };
    const updatedMessages = messages.length === 0 ? messages : messages.map((message, index) => {
      const isConversationAnchor = stableBlock?.messageIndex === index && cacheControl === "all";
      const shouldAddCacheControl = Boolean(
        index === systemIndex && systemIndex !== -1 || isConversationAnchor
      );
      if (!shouldAddCacheControl || !("content" in message) || message.content === null || message.content === void 0) {
        return message;
      }
      return {
        ...message,
        content: this.addCacheControlToContent(
          message.content,
          isConversationAnchor && stableBlock ? stableBlock.excludeTail : 0
        )
      };
    });
    const updatedTools = cacheControl === "all" && request.tools?.length ? this.addCacheControlToTools(request.tools) : request.tools;
    return {
      messages: updatedMessages,
      tools: updatedTools
    };
  }
  /**
   * Locate the last block that is not part of the trailing reattach region,
   * walking back through messages as needed. Returns the owning message index
   * plus how many trailing blocks of that message to skip when stamping the
   * conversation `cache_control` breakpoint.
   */
  lastStableBlock(messages, reattachBlockCount) {
    let remaining = reattachBlockCount;
    for (let index = messages.length - 1; index >= 0; index--) {
      const content = messages[index].content;
      const blockCount = typeof content === "string" ? content.length > 0 ? 1 : 0 : Array.isArray(content) ? content.length : 0;
      if (blockCount === 0) continue;
      if (blockCount > remaining) {
        return { messageIndex: index, excludeTail: remaining };
      }
      remaining -= blockCount;
    }
    return void 0;
  }
  addCacheControlToTools(tools) {
    if (tools.length === 0) {
      return tools;
    }
    const updatedTools = [...tools];
    const lastToolIndex = tools.length - 1;
    updatedTools[lastToolIndex] = {
      ...updatedTools[lastToolIndex],
      cache_control: { type: "ephemeral" }
    };
    return updatedTools;
  }
  /**
   * Add cache control to message content, handling both string and array formats
   */
  addCacheControlToContent(content, excludeTail = 0) {
    const contentArray = this.normalizeContentToArray(content);
    return this.addCacheControlToContentArray(contentArray, excludeTail);
  }
  /**
   * Normalize content to array format
   */
  normalizeContentToArray(content) {
    if (typeof content === "string") {
      return [
        {
          type: "text",
          text: content
        }
      ];
    }
    return [...content];
  }
  /**
   * Add cache control to the content array, skipping `excludeTail` trailing
   * blocks (the reattach region) so the breakpoint lands on the last stable
   * block instead of a regenerated trailing image.
   */
  addCacheControlToContentArray(contentArray, excludeTail = 0) {
    if (contentArray.length === 0) {
      return contentArray;
    }
    let targetIndex = contentArray.length - 1 - excludeTail;
    if (targetIndex < 0) {
      return contentArray;
    }
    if (excludeTail > 0) {
      while (targetIndex > 0 && contentArray[targetIndex].type !== "text") {
        targetIndex -= 1;
      }
    }
    const lastItem = contentArray[targetIndex];
    contentArray[targetIndex] = {
      ...lastItem,
      cache_control: { type: "ephemeral" }
    };
    return contentArray;
  }
  /**
   * True for glm-* models (e.g. glm-4.5, glm-5.2). Uses the same `^glm-` prefix
   * convention as the GLM matchers in tokenLimits.ts, keeping model detection
   * consistent across the codebase.
   */
  isGlmModel(model) {
    return !!model && model.toLowerCase().startsWith("glm-");
  }
  /**
   * Whether the request is in "function-calling mode" — it declares `tools`, or
   * its history already contains a tool result / assistant tool_call. glm needs
   * one of these present to parse structured content-part arrays.
   */
  hasFunctionCallingContext(request) {
    if (request.tools && request.tools.length > 0) {
      return true;
    }
    return request.messages.some((message) => {
      if (message.role === "tool") {
        return true;
      }
      if (message.role === "assistant") {
        const toolCalls = message.tool_calls;
        return Array.isArray(toolCalls) && toolCalls.length > 0;
      }
      return false;
    });
  }
  /**
   * Collapse text-only content arrays back to a plain string, leaving
   * media-bearing parts (image/audio/...) as arrays. Used for glm tool-less
   * requests, where the array form would otherwise be dropped server-side.
   * Multiple text parts are joined with a blank line, matching the DeepSeek
   * provider's flattening (separate parts read as separate blocks).
   * Only called on the flatten branch, which skips cache control, so no part
   * here carries a `cache_control` marker.
   */
  flattenTextContent(messages) {
    return messages.map((message) => {
      if (!("content" in message) || !Array.isArray(message.content)) {
        return message;
      }
      const parts = message.content;
      if (parts.length === 0) {
        return message;
      }
      const isTextOnly = parts.every((part) => part && part.type === "text");
      if (!isTextOnly) {
        return message;
      }
      const text = parts.map((part) => part.text ?? "").join("\n\n");
      return {
        ...message,
        content: text
      };
    });
  }
  /**
   * Vision-capable model patterns.
   * Supports exact matches and prefix patterns for easy extension.
   */
  static VISION_MODEL_EXACT_MATCHES = /* @__PURE__ */ new Set(["coder-model"]);
  static VISION_MODEL_PREFIX_PATTERNS = [
    "qwen-vl",
    // qwen-vl-max, qwen-vl-max-latest, etc.
    "qwen3-vl-plus",
    // qwen3-vl-plus variants
    "qwen3.5-plus",
    // qwen3.5-plus (has built-in vision capabilities)
    "qwen3.6-plus",
    // qwen3.6-plus (multimodal)
    "qwen3.7-plus"
    // qwen3.7-plus (multimodal)
  ];
  isVisionModel(model) {
    if (!model) {
      return false;
    }
    const normalized = model.toLowerCase();
    if (_DashScopeOpenAICompatibleProvider.VISION_MODEL_EXACT_MATCHES.has(
      normalized
    )) {
      return true;
    }
    for (const prefix of _DashScopeOpenAICompatibleProvider.VISION_MODEL_PREFIX_PATTERNS) {
      if (normalized.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }
  /**
   * Check if cache control should be disabled based on configuration.
   *
   * @returns true if cache control should be enabled, false otherwise
   */
  shouldEnableCacheControl() {
    return this.cliConfig.getContentGeneratorConfig()?.enableCacheControl !== false;
  }
};

export {
  DefaultOpenAICompatibleProvider,
  selectDashScopeThinkingKnob,
  DASHSCOPE_REGIONAL_HOSTS,
  DashScopeOpenAICompatibleProvider
};
