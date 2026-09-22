// Force strict mode and setup for ESM
"use strict";
import {
  StreamInactivityTimeoutError,
  StreamLifetimeExceededError,
  parseToolCallArguments,
  resolveStreamIdleTimeoutMs,
  resolveStreamMaxLifetimeMs,
  withStreamGuards
} from "./chunk-ACDUHDYG.js";
import {
  OpenAIContentConverter,
  TaggedThinkingParser,
  openaiRequestCaptureContext
} from "./chunk-2FQM443D.js";
import {
  runtimeDiagnostics
} from "./chunk-VNOVK4I7.js";
import {
  reportOpenAiChunk,
  reportOpenAiRequest,
  reportOpenAiResponse
} from "./chunk-736AZVPL.js";
import {
  applyOfficialOpenAIPromptCaching,
  isOfficialOpenAIEndpoint,
  trailingReattachPartCount
} from "./chunk-WFNEY5G7.js";
import {
  getCurrentAgentId
} from "./chunk-5FHOPPLZ.js";
import {
  DashScopeOpenAICompatibleProvider,
  DefaultOpenAICompatibleProvider
} from "./chunk-WNM6BA7E.js";
import {
  InvalidStreamError,
  getToolCallPreparations,
  markFlushedToolCallPark
} from "./chunk-S7UQ3V2H.js";
import {
  isInForkExecution
} from "./chunk-2A6RZKP2.js";
import {
  extractTextFromContents
} from "./chunk-AYEJOTIU.js";
import {
  safeJsonParse
} from "./chunk-BA6AXQDA.js";
import {
  getEffectiveReasoning,
  isOpenRouterHostname,
  resolveReasoningForModel
} from "./chunk-TLS6QN2S.js";
import {
  getRateLimitErrorDetails,
  getTransportCode
} from "./chunk-YSD6IY6F.js";
import {
  createChildAbortController
} from "./chunk-DJ2GSRLV.js";
import {
  ProtocolTagSanitizedEvent,
  logProtocolTagSanitized
} from "./chunk-KKGSJZWK.js";
import {
  REASONING_EFFORT_TIERS,
  getGptReasoningCapabilities,
  isQwenFamilyWireModel,
  isReasoningEffortPlaceholder,
  isTieredEffortWireModel,
  reconcileMaxTokens
} from "./chunk-KUON6Z6R.js";
import {
  redactProxyError
} from "./chunk-SBP43AO6.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorMessage,
  getErrorStatus,
  getErrorType,
  isAbortError
} from "./chunk-S34QJ6IR.js";
import {
  GenerateContentResponse
} from "./chunk-EFT7OMDN.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/core/openaiContentGenerator/index.ts
init_esbuild_shims();

// packages/core/src/core/openaiContentGenerator/openaiContentGenerator.ts
init_esbuild_shims();

// packages/core/src/core/openaiContentGenerator/provider/index.ts
init_esbuild_shims();

// packages/core/src/core/openaiContentGenerator/provider/modelscope.ts
init_esbuild_shims();
var ModelScopeOpenAICompatibleProvider = class extends DefaultOpenAICompatibleProvider {
  static {
    __name(this, "ModelScopeOpenAICompatibleProvider");
  }
  /**
   * Checks if the configuration is for ModelScope.
   */
  static isModelScopeProvider(config) {
    const baseUrl = config.baseUrl ?? "";
    if (!baseUrl) return false;
    try {
      const hostname = new URL(baseUrl).hostname.toLowerCase();
      return hostname === "modelscope.cn" || hostname.endsWith(".modelscope.cn");
    } catch {
      return false;
    }
  }
  /**
   * ModelScope does not support `stream_options` when `stream` is false.
   * This method removes `stream_options` if `stream` is not true.
   */
  buildRequest(request, userPromptId) {
    const newRequest = super.buildRequest(request, userPromptId);
    if (!newRequest.stream) {
      delete newRequest.stream_options;
    }
    return newRequest;
  }
};

// packages/core/src/core/openaiContentGenerator/provider/deepseek.ts
init_esbuild_shims();

// packages/core/src/core/openaiContentGenerator/provider/utils.ts
init_esbuild_shims();
function ensureReasoningContentOnAssistantMessage(message) {
  if (message.role !== "assistant") {
    return message;
  }
  const assistant = message;
  if (typeof assistant.reasoning_content === "string") {
    return message;
  }
  return {
    ...assistant,
    reasoning_content: ""
  };
}
__name(ensureReasoningContentOnAssistantMessage, "ensureReasoningContentOnAssistantMessage");
function stripReasoningContent(message) {
  if (!("reasoning_content" in message)) {
    return message;
  }
  const next = { ...message };
  delete next["reasoning_content"];
  return next;
}
__name(stripReasoningContent, "stripReasoningContent");

// packages/core/src/core/openaiContentGenerator/provider/deepseek.ts
function isDeepSeekHostname(contentGeneratorConfig) {
  const baseUrl = contentGeneratorConfig.baseUrl ?? "";
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "api.deepseek.com" || hostname.endsWith(".api.deepseek.com");
  } catch {
    return false;
  }
}
__name(isDeepSeekHostname, "isDeepSeekHostname");
function isDeepSeekProvider(contentGeneratorConfig) {
  if (isDeepSeekHostname(contentGeneratorConfig)) return true;
  const model = contentGeneratorConfig.model ?? "";
  return model.toLowerCase().includes("deepseek");
}
__name(isDeepSeekProvider, "isDeepSeekProvider");
var DeepSeekOpenAICompatibleProvider = class extends DefaultOpenAICompatibleProvider {
  static {
    __name(this, "DeepSeekOpenAICompatibleProvider");
  }
  constructor(contentGeneratorConfig, cliConfig) {
    super(contentGeneratorConfig, cliConfig);
  }
  /**
   * Backward-compatible static delegates for the free `isDeepSeek*`
   * helpers. New call sites should import the free functions directly to
   * avoid coupling to this class.
   */
  static isDeepSeekProvider = isDeepSeekProvider;
  static isDeepSeekHostname = isDeepSeekHostname;
  /**
   * The full ladder, including `max`, only on a verified DeepSeek host.
   * `isDeepSeekProvider` also routes here on a `deepseek` substring in the
   * model name, which says nothing about what the endpoint accepts, so the
   * capability follows the rule the module comment above already states: a
   * decision about the wire shape DeepSeek's own API exposes uses
   * `isDeepSeekHostname`. Elsewhere the generic ceiling applies.
   */
  supportedReasoningEffortsFor(model) {
    return !this.getReasoningCapabilities(model)?.profile && isDeepSeekHostname(this.contentGeneratorConfig) ? REASONING_EFFORT_TIERS : super.supportedReasoningEffortsFor(model);
  }
  /**
   * Text-only DeepSeek APIs require message content to be a plain string, not
   * an array of content parts. Flatten text-only request arrays into joined
   * strings; non-text parts (image_url, audio, …) are replaced with an
   * `[Unsupported content type: <type>]` placeholder so the request still goes
   * through with a textual breadcrumb rather than silently dropping the part
   * or raising mid-conversation. Models that explicitly declare image input
   * retain multipart content for compatible gateways. Also translate the
   * standard `reasoning.effort` config into DeepSeek's flat `reasoning_effort`
   * body parameter — but only on actual DeepSeek hostnames, since the model-name
   * fallback above can match self-hosted/strict OpenAI-compat backends that
   * don't accept the DeepSeek extension.
   */
  buildRequest(request, userPromptId) {
    const baseRequest = super.buildRequest(request, userPromptId);
    const profile = this.getReasoningCapabilities(request.model)?.profile;
    const reshaped = (!profile || this.contentGeneratorConfig.samplingParams?.["reasoning"] !== void 0 || this.contentGeneratorConfig.extra_body?.["reasoning"] !== void 0) && isDeepSeekHostname(this.contentGeneratorConfig) ? translateReasoningEffort(baseRequest) : baseRequest;
    if (!reshaped.messages?.length) {
      return reshaped;
    }
    const messages = reshaped.messages.map((message) => {
      const content = this.contentGeneratorConfig.modalities?.image ? message : flattenContentParts(message);
      return isDeepSeekHostname(this.contentGeneratorConfig) || !profile || profile === "deepseek-openai" ? ensureReasoningContentOnAssistantMessage(content) : content;
    });
    return {
      ...reshaped,
      messages
    };
  }
  getDefaultGenerationConfig() {
    return {};
  }
};
function flattenContentParts(message) {
  if (!("content" in message)) {
    return message;
  }
  const { content } = message;
  if (typeof content === "string" || content === null || content === void 0) {
    return message;
  }
  if (!Array.isArray(content)) {
    return message;
  }
  const text = content.map((part) => {
    if (typeof part === "string") {
      return part;
    }
    if (part.type === "text") {
      return part.text ?? "";
    }
    return `[Unsupported content type: ${part.type}]`;
  }).join("\n\n");
  return {
    ...message,
    content: text
  };
}
__name(flattenContentParts, "flattenContentParts");
function translateReasoningEffort(request) {
  const r = request;
  const nested = r["reasoning"];
  const nestedEffort = nested?.effort;
  if (typeof nestedEffort !== "string" || !nestedEffort) {
    return request;
  }
  const next = { ...r };
  if (typeof next["reasoning_effort"] !== "string" || !next["reasoning_effort"]) {
    let normalized = nestedEffort;
    if (normalized === "low" || normalized === "medium") normalized = "high";
    else if (normalized === "xhigh") normalized = "max";
    next["reasoning_effort"] = normalized;
  }
  if (nested && Object.keys(nested).length === 1) {
    delete next["reasoning"];
  } else if (nested) {
    const { effort: _drop, ...rest } = nested;
    next["reasoning"] = rest;
  }
  return next;
}
__name(translateReasoningEffort, "translateReasoningEffort");

// packages/core/src/core/openaiContentGenerator/provider/zai.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("ZAI");
function isZaiHostname(contentGeneratorConfig) {
  const baseUrl = contentGeneratorConfig.baseUrl;
  if (!baseUrl) {
    return false;
  }
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "z.ai" || hostname.endsWith(".z.ai") || hostname === "bigmodel.cn" || hostname.endsWith(".bigmodel.cn");
  } catch {
    return false;
  }
}
__name(isZaiHostname, "isZaiHostname");
function isZaiProvider(contentGeneratorConfig) {
  if (isZaiHostname(contentGeneratorConfig)) {
    return true;
  }
  const model = contentGeneratorConfig.model ?? "";
  return model.toLowerCase().startsWith("glm-");
}
__name(isZaiProvider, "isZaiProvider");
function isGlmTieredEffortModel(model) {
  if (!model) {
    return false;
  }
  const parsed = /^glm-(\d+)(?:\.(\d+))?/.exec(model.toLowerCase());
  if (!parsed) {
    return false;
  }
  const major = Number(parsed[1]);
  const minor = Number(parsed[2] ?? 0);
  return major > 5 || major === 5 && minor >= 2;
}
__name(isGlmTieredEffortModel, "isGlmTieredEffortModel");
var ZaiOpenAICompatibleProvider = class extends DefaultOpenAICompatibleProvider {
  static {
    __name(this, "ZaiOpenAICompatibleProvider");
  }
  static isZaiProvider = isZaiProvider;
  static isZaiHostname = isZaiHostname;
  // Latch so the skipped-flatten warning fires once per provider lifetime.
  nonZaiHostnameFlattenWarned = false;
  /**
   * The full ladder, including `max`, only on a verified Z.ai host running a
   * GLM-5.2+ model. Both halves matter: `isZaiProvider` also routes here on a
   * bare `glm-*` model name, which says nothing about what an arbitrary
   * self-hosted backend accepts, and older GLM ids predate the tiered field.
   * Anything else keeps the generic ceiling, matching the hostname gate the
   * wire reshape below already uses.
   */
  supportedReasoningEffortsFor(model) {
    return isZaiHostname(this.contentGeneratorConfig) && isGlmTieredEffortModel(model ?? this.contentGeneratorConfig.model) ? REASONING_EFFORT_TIERS : super.supportedReasoningEffortsFor(model);
  }
  buildRequest(request, userPromptId) {
    const baseRequest = super.buildRequest(request, userPromptId);
    if (isZaiHostname(this.contentGeneratorConfig)) {
      return flattenReasoningEffort(baseRequest);
    }
    const reasoning = baseRequest["reasoning"];
    if (reasoning?.effort && !baseRequest["reasoning_effort"] && !this.nonZaiHostnameFlattenWarned) {
      debugLogger.warn(
        `GLM model '${this.contentGeneratorConfig.model ?? "unknown"}' on a non-Z.ai hostname; leaving nested reasoning.effort='${String(
          reasoning.effort
        )}' unflattened (reasoning_effort reshape is hostname-gated).`
      );
      this.nonZaiHostnameFlattenWarned = true;
    }
    return baseRequest;
  }
};
function flattenReasoningEffort(request) {
  const r = request;
  const nested = r["reasoning"];
  const effort = nested?.effort;
  if (typeof effort !== "string" || !effort) {
    return request;
  }
  const next = { ...r };
  if (typeof next["reasoning_effort"] !== "string" || !next["reasoning_effort"]) {
    next["reasoning_effort"] = effort;
  }
  if (nested && Object.keys(nested).length === 1) {
    delete next["reasoning"];
  } else if (nested) {
    const { effort: _drop, ...rest } = nested;
    next["reasoning"] = rest;
  }
  return next;
}
__name(flattenReasoningEffort, "flattenReasoningEffort");

// packages/core/src/core/openaiContentGenerator/provider/minimax.ts
init_esbuild_shims();
var MINIMAX_KNOWN_HOSTS = ["api.minimaxi.com", "api.minimax.io"];
var MINIMAX_HOST_SUFFIXES = [".minimaxi.com", ".minimax.io"];
var MiniMaxOpenAICompatibleProvider = class extends DefaultOpenAICompatibleProvider {
  static {
    __name(this, "MiniMaxOpenAICompatibleProvider");
  }
  static isMiniMaxProvider(config) {
    if (!config.baseUrl) return false;
    try {
      const hostname = new URL(config.baseUrl).hostname.toLowerCase();
      if (MINIMAX_KNOWN_HOSTS.includes(hostname)) {
        return true;
      }
      return MINIMAX_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
    } catch {
      return false;
    }
  }
  /**
   * MiniMax rejects a function tool that carries no `parameters` at all
   * (#11834: `400 invalid params, function parameters is empty (2013)`), so
   * zero-argument tools get an empty object schema injected here.
   *
   * This deliberately reverses the converter's invariant one layer down:
   * converter.ts sets `parameters = undefined` for parameterless tools
   * (#11431), because the default-provider endpoints #10080 was written for
   * (llama.cpp, LM Studio, vLLM) reject the empty-object shape. Keep this
   * MiniMax-scoped: do not hoist it into DefaultOpenAICompatibleProvider,
   * and do not move it into the converter ahead of
   * `relaxSchemaForFunctionCalling`, which strips empty `properties` and
   * would emit the bare `{"type":"object"}` that #11410 reports as a 400.
   */
  buildRequest(request, userPromptId) {
    const baseRequest = super.buildRequest(request, userPromptId);
    baseRequest.tools = baseRequest.tools?.map(
      (tool) => tool.function.parameters === void 0 ? {
        ...tool,
        function: {
          ...tool.function,
          parameters: { type: "object", properties: {} }
        }
      } : tool
    );
    return baseRequest;
  }
  getResponseParsingOptions() {
    return { taggedThinkingTags: true };
  }
};

// packages/core/src/core/openaiContentGenerator/provider/mistral.ts
init_esbuild_shims();
var MISTRAL_API_HOST = "api.mistral.ai";
var MISTRAL_MODEL_MARKERS = [
  "mistral",
  "mixtral",
  "codestral",
  "ministral",
  "pixtral",
  "magistral",
  "devstral"
];
function isMistralHostname(config) {
  const baseUrl = config.baseUrl ?? "";
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === MISTRAL_API_HOST || hostname.endsWith(`.${MISTRAL_API_HOST}`);
  } catch {
    return false;
  }
}
__name(isMistralHostname, "isMistralHostname");
function isMistralProvider(config) {
  if (isMistralHostname(config)) return true;
  const model = config.model?.toLowerCase() ?? "";
  return MISTRAL_MODEL_MARKERS.some((marker) => model.includes(marker));
}
__name(isMistralProvider, "isMistralProvider");
var MistralOpenAICompatibleProvider = class extends DefaultOpenAICompatibleProvider {
  static {
    __name(this, "MistralOpenAICompatibleProvider");
  }
  static isMistralProvider = isMistralProvider;
  buildRequest(request, userPromptId) {
    const baseRequest = super.buildRequest(request, userPromptId);
    if (!isMistralHostname(this.contentGeneratorConfig) && this.getReasoningCapabilities(request.model)?.profile === "deepseek-openai")
      return baseRequest;
    return {
      ...baseRequest,
      messages: baseRequest.messages.map(stripReasoningContent)
    };
  }
};

// packages/core/src/core/openaiContentGenerator/provider/cerebras.ts
init_esbuild_shims();
var CEREBRAS_API_HOST = "api.cerebras.ai";
function isCerebrasProvider(config) {
  const baseUrl = config.baseUrl ?? "";
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === CEREBRAS_API_HOST || hostname.endsWith(`.${CEREBRAS_API_HOST}`);
  } catch {
    return false;
  }
}
__name(isCerebrasProvider, "isCerebrasProvider");
var CerebrasOpenAICompatibleProvider = class extends DefaultOpenAICompatibleProvider {
  static {
    __name(this, "CerebrasOpenAICompatibleProvider");
  }
  static isCerebrasProvider = isCerebrasProvider;
  buildRequest(request, userPromptId) {
    const baseRequest = super.buildRequest(request, userPromptId);
    return {
      ...baseRequest,
      messages: baseRequest.messages.map(stripReasoningContent)
    };
  }
};

// packages/core/src/core/openaiContentGenerator/provider/fireworks.ts
init_esbuild_shims();
var FIREWORKS_API_HOST = "api.fireworks.ai";
function isFireworksProvider(config) {
  const baseUrl = config.baseUrl ?? "";
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === FIREWORKS_API_HOST || hostname.endsWith(`.${FIREWORKS_API_HOST}`);
  } catch {
    return false;
  }
}
__name(isFireworksProvider, "isFireworksProvider");
var FireworksOpenAICompatibleProvider = class extends DefaultOpenAICompatibleProvider {
  static {
    __name(this, "FireworksOpenAICompatibleProvider");
  }
  static isFireworksProvider = isFireworksProvider;
  buildRequest(request, userPromptId) {
    const baseRequest = super.buildRequest(request, userPromptId);
    return {
      ...baseRequest,
      messages: baseRequest.messages.map(unmirrorReasoningField)
    };
  }
};
function unmirrorReasoningField(message) {
  if (message.role !== "assistant") {
    return message;
  }
  const assistant = message;
  if (assistant.reasoning !== assistant.reasoning_content) {
    return message;
  }
  if (typeof assistant.reasoning !== "string") {
    return message;
  }
  const { reasoning: _drop, ...rest } = assistant;
  return rest;
}
__name(unmirrorReasoningField, "unmirrorReasoningField");

// packages/core/src/core/openaiContentGenerator/provider/mimo.ts
init_esbuild_shims();
function isMiMoProvider(contentGeneratorConfig) {
  const baseUrl = contentGeneratorConfig.baseUrl ?? "";
  if (baseUrl) {
    try {
      const hostname = new URL(baseUrl).hostname.toLowerCase();
      if (hostname === "xiaomimimo.com" || hostname.endsWith(".xiaomimimo.com")) {
        return true;
      }
    } catch {
    }
  }
  const model = contentGeneratorConfig.model ?? "";
  return model.toLowerCase().startsWith("mimo-");
}
__name(isMiMoProvider, "isMiMoProvider");
var MiMoOpenAICompatibleProvider = class extends DefaultOpenAICompatibleProvider {
  static {
    __name(this, "MiMoOpenAICompatibleProvider");
  }
  constructor(contentGeneratorConfig, cliConfig) {
    super(contentGeneratorConfig, cliConfig);
  }
  static isMiMoProvider = isMiMoProvider;
  buildRequest(request, userPromptId) {
    const baseRequest = super.buildRequest(request, userPromptId);
    if (this.getReasoningCapabilities(request.model)?.profile && !isMiMoProvider({ ...this.contentGeneratorConfig, model: "" }) || !baseRequest.messages?.length) {
      return baseRequest;
    }
    return {
      ...baseRequest,
      messages: baseRequest.messages.map(
        ensureReasoningContentOnAssistantMessage
      )
    };
  }
  getRequestContextOverrides() {
    return {
      splitToolMedia: this.contentGeneratorConfig.splitToolMedia ?? true
    };
  }
};

// packages/core/src/core/openaiContentGenerator/pipeline.ts
init_esbuild_shims();

// packages/core/src/core/openaiContentGenerator/streamingToolCallParser.ts
init_esbuild_shims();
var debugLogger2 = createDebugLogger("STREAMING_TOOL_CALL_PARSER");
var StreamingToolCallParser = class {
  static {
    __name(this, "StreamingToolCallParser");
  }
  /** Accumulated buffer containing all received chunks for each tool call index */
  buffers = /* @__PURE__ */ new Map();
  /** Current nesting depth in JSON structure for each tool call index */
  depths = /* @__PURE__ */ new Map();
  /** Whether we're currently inside a string literal for each tool call index */
  inStrings = /* @__PURE__ */ new Map();
  /** Whether the next character should be treated as escaped for each tool call index */
  escapes = /* @__PURE__ */ new Map();
  /** Metadata for each tool call index */
  toolCallMeta = /* @__PURE__ */ new Map();
  namelessToolCallIndices = /* @__PURE__ */ new Set();
  /** Map from tool call ID to actual index used for storage */
  idToIndexMap = /* @__PURE__ */ new Map();
  /**
   * Maps a provider index to the actual slot it was remapped to on collision.
   * Two readers consume it: an id that arrives after its name/args adopts the
   * slot, and later id-less continuation chunks at the same provider index are
   * routed to it.
   */
  pendingIndexRemaps = /* @__PURE__ */ new Map();
  /** Counter for generating new indices when collisions occur */
  nextAvailableIndex = 0;
  conflictingToolCallIdentity = false;
  invalidToolCallIndex = false;
  /**
   * Processes a new chunk of tool call data and attempts to parse complete JSON objects
   *
   * Handles the core problems of streaming tool call parsing:
   * - Resolves index collisions when the same index is reused for different tool calls
   * - Routes chunks without IDs to the correct incomplete tool call
   * - Tracks JSON parsing state (depth, string boundaries, escapes) per tool call
   * - Attempts parsing only when JSON structure is complete (depth = 0)
   * - Repairs common issues like unclosed strings
   *
   * @param index - Tool call index from streaming response (may collide with existing calls)
   * @param chunk - String chunk that may be empty, partial JSON, or complete data
   * @param id - Optional tool call ID for collision detection and chunk routing
   * @param name - Optional function name stored as metadata
   * @returns ToolCallParseResult with completion status, parsed value, and repair info
   */
  addChunk(index, chunk, id, name) {
    const validName = name?.trim() || void 0;
    if (!Number.isSafeInteger(index) || index < 0) {
      this.conflictingToolCallIdentity = true;
      this.invalidToolCallIndex = true;
      return {
        complete: false,
        error: new Error(`Invalid tool call index: ${index}`)
      };
    }
    if (!id && !validName && !chunk.trim()) {
      const depth2 = this.depths.get(index) ?? 0;
      const inString2 = this.inStrings.get(index) ?? false;
      if (!this.buffers.has(index) || depth2 === 0 && !inString2) {
        return { complete: false };
      }
    }
    let actualIndex = index;
    const isKnownId = Boolean(id && this.idToIndexMap.has(id));
    const existingName = this.toolCallMeta.get(index)?.name;
    const isNameOnlyDelta = Boolean(
      validName && chunk.length === 0 && (!existingName || existingName === validName)
    );
    if (id) {
      if (this.idToIndexMap.has(id)) {
        actualIndex = this.idToIndexMap.get(id);
      } else if (this.pendingIndexRemaps.has(index) && !this.toolCallMeta.get(this.pendingIndexRemaps.get(index))?.id) {
        actualIndex = this.pendingIndexRemaps.get(index);
        this.idToIndexMap.set(id, actualIndex);
      } else {
        if (this.buffers.has(index)) {
          const existingBuffer = this.buffers.get(index);
          const existingDepth = this.depths.get(index);
          const existingMeta = this.toolCallMeta.get(index);
          if (existingMeta?.id && existingMeta.id !== id) {
            let existingComplete = existingDepth === 0;
            if (existingComplete && existingBuffer.trim()) {
              try {
                JSON.parse(existingBuffer);
              } catch {
                existingComplete = false;
              }
            }
            if (existingComplete) {
              actualIndex = 0;
              while (this.buffers.has(actualIndex)) actualIndex += 1;
              if (!existingMeta.name) {
                this.conflictingToolCallIdentity = true;
              }
            } else {
              this.conflictingToolCallIdentity = true;
            }
          }
        }
        this.idToIndexMap.set(id, actualIndex);
      }
    } else if (!isNameOnlyDelta) {
      if (this.pendingIndexRemaps.has(index)) {
        actualIndex = this.pendingIndexRemaps.get(index);
        const existingBuffer = this.buffers.get(actualIndex);
        const existingDepth = this.depths.get(actualIndex);
        if (existingDepth === 0 && existingBuffer.trim()) {
          try {
            JSON.parse(existingBuffer);
            actualIndex = this.findMostRecentIncompleteIndex();
          } catch {
          }
        }
      } else if (this.buffers.has(index)) {
        const existingBuffer = this.buffers.get(index);
        const existingDepth = this.depths.get(index);
        if (existingDepth > 0 || !existingBuffer.trim()) {
          actualIndex = index;
        } else {
          try {
            JSON.parse(existingBuffer);
            actualIndex = this.findMostRecentIncompleteIndex();
          } catch {
            actualIndex = index;
          }
        }
      }
    }
    if (!this.buffers.has(actualIndex)) {
      this.buffers.set(actualIndex, "");
      this.depths.set(actualIndex, 0);
      this.inStrings.set(actualIndex, false);
      this.escapes.set(actualIndex, false);
      this.toolCallMeta.set(actualIndex, {});
    }
    const currentBuffer = this.buffers.get(actualIndex);
    const currentDepth = this.depths.get(actualIndex);
    const meta = this.toolCallMeta.get(actualIndex);
    if (chunk.length === 0 && (id || validName)) {
      if (id) meta.id = id;
      if (validName && !meta.name) meta.name = validName;
      if (!meta.name && meta.id) {
        this.namelessToolCallIndices.add(actualIndex);
      } else {
        this.namelessToolCallIndices.delete(actualIndex);
      }
      if (actualIndex !== index) {
        this.pendingIndexRemaps.set(index, actualIndex);
      }
      return { actualIndex, complete: false };
    }
    if (isKnownId && currentDepth === 0) {
      if (currentBuffer.trim()) {
        try {
          JSON.parse(currentBuffer);
          debugLogger2.debug(
            `Ignoring replay chunk for completed toolCall id=${id}`
          );
          return { actualIndex, complete: false };
        } catch {
        }
      }
    }
    const identityChanged = Boolean(id && meta.id && meta.id !== id);
    if (id) meta.id = id;
    if (validName) {
      if (!identityChanged && meta.name && meta.name !== validName) {
        this.conflictingToolCallIdentity = true;
      } else {
        meta.name = validName;
      }
    }
    if (actualIndex !== index) {
      this.pendingIndexRemaps.set(index, actualIndex);
    }
    const currentInString = this.inStrings.get(actualIndex);
    const currentEscape = this.escapes.get(actualIndex);
    const newBuffer = currentBuffer + chunk;
    this.buffers.set(actualIndex, newBuffer);
    if (!meta.name && (meta.id || /\S/.test(newBuffer))) {
      this.namelessToolCallIndices.add(actualIndex);
    } else {
      this.namelessToolCallIndices.delete(actualIndex);
    }
    let depth = currentDepth;
    let inString = currentInString;
    let escape = currentEscape;
    for (const char of chunk) {
      if (!inString) {
        if (char === "{" || char === "[") depth++;
        else if (char === "}" || char === "]") depth--;
      }
      if (char === '"' && !escape) {
        inString = !inString;
      }
      escape = char === "\\" && !escape;
    }
    this.depths.set(actualIndex, depth);
    this.inStrings.set(actualIndex, inString);
    this.escapes.set(actualIndex, escape);
    if (depth === 0 && newBuffer.trim().length > 0) {
      try {
        const parsed = JSON.parse(newBuffer);
        return { actualIndex, complete: true, value: parsed };
      } catch (e) {
        if (inString) {
          try {
            const repaired = JSON.parse(newBuffer + '"');
            return {
              actualIndex,
              complete: true,
              value: repaired,
              repaired: true
            };
          } catch {
          }
        }
        return {
          actualIndex,
          complete: false,
          error: e instanceof Error ? e : new Error(String(e))
        };
      }
    }
    return { actualIndex, complete: false };
  }
  /**
   * Gets the current tool call metadata for a specific index
   *
   * @param index - The tool call index
   * @returns Object containing id and name if available
   */
  getToolCallMeta(index) {
    return this.toolCallMeta.get(index) || {};
  }
  hasNamelessToolCall() {
    return this.namelessToolCallIndices.size > 0;
  }
  hasConflictingToolCallIdentity() {
    return this.conflictingToolCallIdentity;
  }
  hasInvalidToolCallIndex() {
    return this.invalidToolCallIndex;
  }
  hasInvalidToolCallArguments() {
    for (const [index, buffer] of this.buffers.entries()) {
      if (!this.toolCallMeta.get(index)?.name || buffer.length === 0) continue;
      if (!parseToolCallArguments(buffer).ok) return true;
    }
    return false;
  }
  /**
   * Gets all completed tool calls that are ready to be emitted
   *
   * Attempts to parse accumulated buffers using multiple strategies:
   * 1. Standard JSON.parse()
   * 2. Auto-close unclosed strings and retry
   * 3. Fallback to safeJsonParse for malformed data
   *
   * Only returns tool calls with name metadata. An empty buffer yields
   * empty arguments ({}), matching the non-streaming path for no-argument
   * tools. Should be called when streaming is complete (finish_reason is
   * present).
   *
   * @returns Array of completed tool calls with their metadata and parsed arguments
   */
  getCompletedToolCalls() {
    const completed = [];
    const emittedIds = /* @__PURE__ */ new Set();
    for (const [index, buffer] of this.buffers.entries()) {
      const meta = this.toolCallMeta.get(index);
      if (meta?.name) {
        if (meta.id) {
          if (emittedIds.has(meta.id)) {
            continue;
          }
          emittedIds.add(meta.id);
        }
        let args = {};
        if (buffer.trim()) {
          try {
            args = JSON.parse(buffer);
          } catch {
            const inString = this.inStrings.get(index);
            if (inString) {
              try {
                args = JSON.parse(buffer + '"');
              } catch {
                args = safeJsonParse(buffer, {});
              }
            } else {
              args = safeJsonParse(buffer, {});
            }
          }
          if (typeof args !== "object" || args === null || Array.isArray(args)) {
            debugLogger2.debug(
              `Collapsing non-object arguments for tool call ${meta.name} (id=${meta.id}) at index ${index}; buffer likely polluted by a misrouted fragment`
            );
            args = {};
          }
        } else {
          debugLogger2.debug(
            `Emitting no-argument tool call ${meta.name} (id=${meta.id}) at index ${index} with empty buffer`
          );
        }
        completed.push({
          id: meta.id,
          name: meta.name,
          args,
          index
        });
      }
    }
    return completed;
  }
  /**
   * Finds the next available index for a new tool call
   *
   * Scans indices starting from nextAvailableIndex to find one that's safe to use.
   * Reuses indices never claimed by a named tool call or with incomplete
   * parsing states. Skips indices with complete tool call data — including
   * no-argument calls with empty buffers — to prevent overwriting.
   *
   * @returns The next available index safe for storing a new tool call
   */
  findNextAvailableIndex() {
    while (this.buffers.has(this.nextAvailableIndex)) {
      const buffer = this.buffers.get(this.nextAvailableIndex);
      const depth = this.depths.get(this.nextAvailableIndex);
      const meta = this.toolCallMeta.get(this.nextAvailableIndex);
      if (!meta?.name || depth > 0 || !meta?.id) {
        return this.nextAvailableIndex;
      }
      if (buffer.trim()) {
        try {
          JSON.parse(buffer);
        } catch {
          return this.nextAvailableIndex;
        }
      }
      this.nextAvailableIndex++;
    }
    return this.nextAvailableIndex++;
  }
  /**
   * Finds the most recent incomplete tool call index
   *
   * Used when continuation chunks arrive without IDs. Scans existing tool calls
   * to find the highest index with incomplete parsing state (depth > 0, empty
   * buffer with no name metadata yet, or unparseable JSON). Falls back to
   * creating a new index if none found.
   *
   * @returns The index of the most recent incomplete tool call, or a new available index
   */
  findMostRecentIncompleteIndex() {
    let maxIndex = -1;
    for (const [index, buffer] of this.buffers.entries()) {
      const depth = this.depths.get(index);
      const meta = this.toolCallMeta.get(index);
      if (meta?.id && (depth > 0 || !buffer.trim() && !meta?.name)) {
        maxIndex = Math.max(maxIndex, index);
      } else if (buffer.trim()) {
        try {
          JSON.parse(buffer);
        } catch {
          maxIndex = Math.max(maxIndex, index);
        }
      }
    }
    return maxIndex >= 0 ? maxIndex : this.findNextAvailableIndex();
  }
  /**
   * Resets the parser state for a specific tool call index
   *
   * @param index - The tool call index to reset
   */
  resetIndex(index) {
    this.buffers.set(index, "");
    this.depths.set(index, 0);
    this.inStrings.set(index, false);
    this.escapes.set(index, false);
    this.toolCallMeta.set(index, {});
    this.namelessToolCallIndices.delete(index);
    for (const [providerIndex, actualIndex] of this.pendingIndexRemaps) {
      if (providerIndex === index || actualIndex === index) {
        this.pendingIndexRemaps.delete(providerIndex);
      }
    }
  }
  /**
   * Resets the entire parser state for processing a new stream
   *
   * Clears all accumulated buffers, parsing states, metadata, and counters.
   * Allows the parser to be reused for multiple independent streams without
   * data leakage between sessions.
   */
  reset() {
    this.buffers.clear();
    this.depths.clear();
    this.inStrings.clear();
    this.escapes.clear();
    this.toolCallMeta.clear();
    this.namelessToolCallIndices.clear();
    this.idToIndexMap.clear();
    this.pendingIndexRemaps.clear();
    this.nextAvailableIndex = 0;
    this.conflictingToolCallIdentity = false;
    this.invalidToolCallIndex = false;
  }
  /**
   * Gets the current accumulated buffer content for a specific index
   *
   * @param index - The tool call index to retrieve buffer for
   * @returns The current buffer content for the specified index (empty string if not found)
   */
  getBuffer(index) {
    return this.buffers.get(index) || "";
  }
  /**
   * Gets the current parsing state information for a specific index
   *
   * @param index - The tool call index to get state information for
   * @returns Object containing current parsing state (depth, inString, escape)
   */
  getState(index) {
    return {
      depth: this.depths.get(index) || 0,
      inString: this.inStrings.get(index) || false,
      escape: this.escapes.get(index) || false
    };
  }
  /**
   * Checks whether any buffered tool call has incomplete JSON at stream end.
   *
   * A tool call is considered incomplete when its JSON parsing state indicates
   * the buffer was truncated mid-stream:
   * - depth > 0: unclosed braces/brackets remain
   * - inString === true: still inside a string literal
   *
   * This is critical for detecting output truncation that the LLM provider
   * may not report correctly via finish_reason (e.g. reporting "stop" or
   * "tool_calls" instead of "length" when output was actually cut off).
   *
   * @returns true if at least one tool call buffer has incomplete JSON
   */
  hasIncompleteToolCalls() {
    for (const [index] of this.buffers.entries()) {
      const meta = this.toolCallMeta.get(index);
      if (!meta?.name) continue;
      const depth = this.depths.get(index) || 0;
      const inString = this.inStrings.get(index) || false;
      if (depth > 0 || inString) {
        return true;
      }
    }
    return false;
  }
};

// packages/core/src/core/openaiContentGenerator/pipeline.ts
var debugLogger3 = createDebugLogger("OPENAI_PIPELINE");
var OPENAI_STRICT_SCHEMA_KEYS = /* @__PURE__ */ new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "description",
  "enum"
]);
var OPENAI_STRICT_UNSUPPORTED_SCHEMA_KEYS = /* @__PURE__ */ new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems"
]);
function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return void 0;
  }
  return value;
}
__name(asObject, "asObject");
function profileReasoning(profile, reasoning) {
  if (reasoning === void 0) return {};
  const enabled = reasoning !== false;
  const effort = reasoning && reasoning.effort;
  switch (profile) {
    case "openai-reasoning":
      return { reasoning: enabled ? reasoning : { enabled: false } };
    case "openai-effort":
    case "dashscope-effort":
      return effort || !enabled ? { reasoning_effort: enabled ? effort : "none" } : {};
    case "deepseek-openai":
      return {
        thinking: { type: enabled ? "enabled" : "disabled" },
        ...effort ? { reasoning_effort: effort } : {}
      };
    case "dashscope-thinking":
      return { enable_thinking: enabled };
    case "qwen-chat-template":
      return { chat_template_kwargs: { enable_thinking: enabled } };
    default:
      return {};
  }
}
__name(profileReasoning, "profileReasoning");
function applyConfiguredReasoningEffort(request, capabilities) {
  if (capabilities?.profile) {
    const loose2 = request;
    const { reasoning: reasoning2, ...rest2 } = loose2;
    const { effort: _effort, ...siblings } = asObject(reasoning2) ?? {};
    return {
      ...Object.keys(siblings).length ? { reasoning: siblings } : {},
      ...profileReasoning(
        capabilities.profile,
        reasoning2
      ),
      ...rest2
    };
  }
  if (!capabilities || capabilities.toggleOnly || !Array.isArray(capabilities.efforts)) {
    return request;
  }
  const loose = request;
  const reasoning = asObject(loose["reasoning"]);
  if (!reasoning || !("effort" in reasoning)) return request;
  const effort = capabilities.efforts.find(
    (candidate) => candidate === reasoning["effort"]
  );
  if (effort && getGptReasoningCapabilities(loose["model"]))
    return request;
  const { effort: _drop, ...rest } = reasoning;
  const next = { ...loose };
  if (Object.keys(rest).length > 0) next["reasoning"] = rest;
  else delete next["reasoning"];
  if (effort && next["reasoning_effort"] === void 0) {
    next["reasoning_effort"] = effort;
  }
  return next;
}
__name(applyConfiguredReasoningEffort, "applyConfiguredReasoningEffort");
function normalizeSchemaType(value) {
  if (typeof value !== "string") return void 0;
  const normalized = value.toLowerCase();
  return [
    "object",
    "array",
    "string",
    "number",
    "integer",
    "boolean",
    "null"
  ].includes(normalized) ? normalized : void 0;
}
__name(normalizeSchemaType, "normalizeSchemaType");
function normalizeOpenAIStrictSchema(schema) {
  const source = asObject(schema);
  if (!source) return void 0;
  const type = normalizeSchemaType(source["type"]);
  if (!type) return void 0;
  const normalized = { type };
  for (const [key, value] of Object.entries(source)) {
    if (key === "type" || OPENAI_STRICT_UNSUPPORTED_SCHEMA_KEYS.has(key) || !OPENAI_STRICT_SCHEMA_KEYS.has(key)) {
      continue;
    }
    normalized[key] = value;
  }
  if (type === "object") {
    const properties = asObject(source["properties"]);
    if (!properties) return void 0;
    const normalizedProperties = {};
    for (const [key, value] of Object.entries(properties)) {
      const property = normalizeOpenAIStrictSchema(value);
      if (!property) return void 0;
      normalizedProperties[key] = property;
    }
    const propertyKeys = Object.keys(normalizedProperties);
    const required = source["required"];
    if (!Array.isArray(required) || !propertyKeys.every((key) => required.includes(key)) || required.length !== propertyKeys.length) {
      return void 0;
    }
    normalized["properties"] = normalizedProperties;
    normalized["required"] = required;
    normalized["additionalProperties"] = false;
  }
  if (type === "array") {
    const items = normalizeOpenAIStrictSchema(source["items"]);
    if (!items) return void 0;
    normalized["items"] = items;
  }
  return normalized;
}
__name(normalizeOpenAIStrictSchema, "normalizeOpenAIStrictSchema");
function isRequiredThinkingError(error) {
  if (getErrorStatus(error) !== 400) return false;
  const providerMessage = getRateLimitErrorDetails(error).providerMessage;
  const message = `${getErrorMessage(error)} ${providerMessage ?? ""}`;
  return message.includes("enable_thinking") && /(?:restricted to|must be) true\b/i.test(message);
}
__name(isRequiredThinkingError, "isRequiredThinkingError");
function wireRequestHasMediaContent(wireRequest) {
  const messages = wireRequest?.["messages"];
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    const content = message.content;
    return Array.isArray(content) && content.some((part) => {
      const type = part.type;
      return type === "image_url" || type === "input_audio" || type === "video_url" || type === "file";
    });
  });
}
__name(wireRequestHasMediaContent, "wireRequestHasMediaContent");
var StreamContentError = class extends Error {
  static {
    __name(this, "StreamContentError");
  }
  constructor(message) {
    super(message);
    this.name = "StreamContentError";
  }
};
var NON_SSE_BODY_PREFIX_LIMIT = 512;
function isSSECompatibleContentType(contentType) {
  if (!contentType) return true;
  const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return mediaType === "text/event-stream" || mediaType === "application/x-ndjson" || mediaType === "application/stream+json";
}
__name(isSSECompatibleContentType, "isSSECompatibleContentType");
function hasNonThoughtCandidateParts(response) {
  return Boolean(
    response.candidates?.some(
      (candidate) => candidate.content?.parts?.some((part) => !part.thought)
    )
  );
}
__name(hasNonThoughtCandidateParts, "hasNonThoughtCandidateParts");
var NonSSEResponseError = class extends Error {
  constructor(contentType, httpStatus, bodyPrefix, requestId) {
    const preview = bodyPrefix.length > 0 ? ` Body prefix: ${bodyPrefix}` : "";
    super(
      `Streaming request received a non-SSE response (HTTP ${httpStatus}, Content-Type: ${contentType || "unknown"}).${preview}`
    );
    this.contentType = contentType;
    this.httpStatus = httpStatus;
    this.bodyPrefix = bodyPrefix;
    this.requestId = requestId;
    this.name = "NonSSEResponseError";
    this.status = httpStatus;
    this.request_id = requestId;
  }
  static {
    __name(this, "NonSSEResponseError");
  }
  status;
  request_id;
};
var PROVIDER_OUTPUT_BUDGET_KEYS = ["max_completion_tokens", "max_new_tokens"];
function hasProviderOutputBudgetKey(samplingParams) {
  return PROVIDER_OUTPUT_BUDGET_KEYS.some(
    (key) => samplingParams[key] !== void 0
  );
}
__name(hasProviderOutputBudgetKey, "hasProviderOutputBudgetKey");
function clampProviderOutputBudgetKeys(samplingParams, requestMaxTokens) {
  if (typeof requestMaxTokens !== "number") return samplingParams;
  for (const key of PROVIDER_OUTPUT_BUDGET_KEYS) {
    const value = samplingParams[key];
    if (typeof value === "number" && value > requestMaxTokens) {
      samplingParams[key] = requestMaxTokens;
    }
  }
  return samplingParams;
}
__name(clampProviderOutputBudgetKeys, "clampProviderOutputBudgetKeys");
var ContentGenerationPipeline = class {
  constructor(config) {
    this.config = config;
    this.contentGeneratorConfig = config.contentGeneratorConfig;
    this.client = this.config.provider.buildClient();
    this.streamIdleTimeoutMs = resolveStreamIdleTimeoutMs(
      this.contentGeneratorConfig
    );
    this.streamMaxLifetimeMs = resolveStreamMaxLifetimeMs(
      this.contentGeneratorConfig
    );
  }
  static {
    __name(this, "ContentGenerationPipeline");
  }
  client;
  contentGeneratorConfig;
  requiredThinkingModels = /* @__PURE__ */ new Set();
  // Resolved once (config field > env > default) so the env read + any
  // invalid-value warning happen per pipeline, not per streaming request.
  streamIdleTimeoutMs;
  streamMaxLifetimeMs;
  async execute(request, userPromptId) {
    return this.executeWithErrorHandling(
      request,
      userPromptId,
      false,
      async (openaiRequest, context, telemetryAttempt) => {
        const parentSignal = request.config?.abortSignal;
        const perRequestAc = parentSignal ? createChildAbortController(parentSignal) : void 0;
        try {
          const openaiResponse = await this.client.chat.completions.create(
            openaiRequest,
            {
              signal: perRequestAc?.signal
            }
          );
          reportOpenAiResponse(telemetryAttempt, openaiResponse);
          const llmResponse = OpenAIContentConverter.convertOpenAIResponseToLlm(
            openaiResponse,
            context
          );
          return llmResponse;
        } finally {
          perRequestAc?.abort();
        }
      }
    );
  }
  async executeStream(request, userPromptId) {
    return this.executeWithErrorHandling(
      request,
      userPromptId,
      true,
      async (openaiRequest, context, telemetryAttempt) => {
        const parentSignal = request.config?.abortSignal;
        const perRequestAc = createChildAbortController(parentSignal);
        let stream;
        try {
          const createPromise = this.client.chat.completions.create(
            openaiRequest,
            { signal: perRequestAc.signal }
          );
          if (typeof createPromise.withResponse === "function") {
            const {
              data,
              response: httpResponse,
              request_id
            } = await createPromise.withResponse();
            stream = data;
            const contentType = httpResponse.headers.get("content-type") ?? null;
            if (!isSSECompatibleContentType(contentType)) {
              let bodyPrefix = "";
              try {
                if (httpResponse.body) {
                  const reader = httpResponse.body.getReader();
                  const { value } = await reader.read();
                  reader.releaseLock();
                  if (value) {
                    bodyPrefix = new TextDecoder().decode(value).slice(0, NON_SSE_BODY_PREFIX_LIMIT);
                  }
                }
              } catch {
              }
              throw new NonSSEResponseError(
                contentType,
                httpResponse.status,
                bodyPrefix,
                request_id
              );
            }
          } else {
            stream = await createPromise;
          }
        } catch (e) {
          perRequestAc.abort();
          throw e;
        }
        const idleMs = this.streamIdleTimeoutMs;
        const maxLifetimeMs = this.streamMaxLifetimeMs;
        const guarded = idleMs > 0 || maxLifetimeMs > 0 ? withStreamGuards(
          stream,
          idleMs,
          maxLifetimeMs,
          () => perRequestAc.abort(),
          parentSignal
        ) : stream;
        const innerStream = this.processStreamWithLogging(
          guarded,
          context,
          request,
          openaiRequest,
          userPromptId,
          telemetryAttempt
        );
        async function* drainThenCleanup() {
          try {
            yield* innerStream;
          } finally {
            perRequestAc.abort();
          }
        }
        __name(drainThenCleanup, "drainThenCleanup");
        return drainThenCleanup();
      }
    );
  }
  /**
   * Stage 2: Process OpenAI stream with conversion and logging
   * This method handles the complete stream processing pipeline:
   * 1. Convert OpenAI chunks to Gemini format while preserving original chunks
   * 2. Filter empty responses
   * 3. Handle chunk merging for providers that send finishReason and usageMetadata separately
   * 4. Handle success/error logging
   */
  async *processStreamWithLogging(stream, context, request, openaiRequest, userPromptId, telemetryAttempt) {
    let pendingFinishResponse = null;
    let finishYielded = false;
    let contentYielded = request.continuationInFlight === true;
    let pendingFinishProtocolTagSanitized;
    const logPendingProtocolTagSanitized = /* @__PURE__ */ __name((response, sanitization) => {
      if (!sanitization) return;
      const event = new ProtocolTagSanitizedEvent({
        model: context.model,
        promptId: userPromptId,
        responseId: response.responseId,
        tagName: sanitization.tagName,
        toolCallCount: sanitization.toolCallCount
      });
      debugLogger3.warn("Sanitized a model protocol tag", {
        model: event.model,
        promptId: event.prompt_id,
        responseId: event.response_id,
        tagName: event.tag_name,
        toolCallCount: event.tool_call_count
      });
      logProtocolTagSanitized(this.config.cliConfig, event);
    }, "logPendingProtocolTagSanitized");
    try {
      for await (const chunk of stream) {
        reportOpenAiChunk(telemetryAttempt, chunk);
        if (chunk.choices?.[0]?.finish_reason === "error_finish") {
          const errorContent = chunk.choices?.[0]?.delta?.content?.trim() || "Unknown stream error";
          throw new StreamContentError(errorContent);
        }
        const response = OpenAIContentConverter.convertOpenAIChunkToLlm(
          chunk,
          context
        );
        const sanitization = context.protocolTagSanitized;
        if (sanitization) {
          context.protocolTagSanitized = void 0;
        }
        if ((response.candidates?.[0]?.content?.parts?.length ?? 0) === 0 && !response.candidates?.[0]?.finishReason && !response.usageMetadata && // Preparation-only responses must reach ACP before arguments complete.
        getToolCallPreparations(response).length === 0) {
          continue;
        }
        if (pendingFinishProtocolTagSanitized && pendingFinishResponse && !response.candidates?.[0]?.finishReason && response.candidates?.some(
          (candidate) => (candidate.content?.parts?.length ?? 0) > 0
        )) {
          throw new InvalidStreamError(
            "Model response continued after a finish reason.",
            "PROTOCOL_TAG_LEAK"
          );
        }
        if (finishYielded) {
          if (response.usageMetadata) {
            const pending = pendingFinishResponse;
            if (pending) {
              pending.usageMetadata = response.usageMetadata;
            }
          }
          continue;
        }
        if (!pendingFinishResponse && response.candidates?.[0]?.finishReason && sanitization) {
          pendingFinishProtocolTagSanitized = sanitization;
        }
        const shouldYield = this.handleChunkMerging(
          response,
          pendingFinishResponse,
          (mergedResponse) => {
            pendingFinishResponse = mergedResponse;
          }
        );
        if (shouldYield) {
          if (pendingFinishResponse) {
            logPendingProtocolTagSanitized(
              pendingFinishResponse,
              pendingFinishProtocolTagSanitized
            );
            finishYielded = true;
            yield pendingFinishResponse;
          } else {
            contentYielded ||= hasNonThoughtCandidateParts(response);
            logPendingProtocolTagSanitized(response, sanitization);
            yield response;
          }
        }
      }
      if (context.pendingThinkingTagCandidate && !context.pendingThinkingTagCandidate.closingTagName && !/\S/.test(context.pendingThinkingTagCandidate.text)) {
        const pendingParts = context.pendingUntrustedResponseParts;
        context.pendingThinkingTagCandidate = void 0;
        context.pendingUntrustedResponseParts = void 0;
        if (pendingParts?.length) {
          const response = new GenerateContentResponse();
          response.candidates = [
            {
              content: { parts: pendingParts, role: "model" },
              index: 0
            }
          ];
          contentYielded ||= hasNonThoughtCandidateParts(response);
          yield response;
        }
      } else if (context.pendingThinkingTagCandidate || context.responseParsingOptions?.taggedThinkingTagsAfterReasoning && context.taggedThinkingParser?.hasUnclosedThought()) {
        throw new InvalidStreamError(
          "Model response leaked thinking tags.",
          "PROTOCOL_TAG_LEAK"
        );
      }
      if (pendingFinishResponse && !finishYielded) {
        logPendingProtocolTagSanitized(
          pendingFinishResponse,
          pendingFinishProtocolTagSanitized
        );
        finishYielded = true;
        yield pendingFinishResponse;
      }
    } catch (error) {
      await this.invalidateOmniOssCacheOnError(openaiRequest, error);
      if (error instanceof InvalidStreamError) {
        throw error;
      }
      const parked = pendingFinishResponse;
      const parkedHasToolCall = parked?.candidates?.some(
        (candidate) => candidate.content?.parts?.some((part) => part.functionCall)
      );
      if (pendingFinishResponse && !finishYielded && // A cancellation is not a stream failure to recover from: synthesising
      // a delivery here hands the consumer a finish it was never shown, and
      // cancellation persistence keeps whatever the consumer received.
      // Spelled exactly as the PROTOCOL_TAG_LEAK branch below spells it, so
      // one catch does not hold two notions of "aborted".
      request.config?.abortSignal?.aborted !== true && (!parkedHasToolCall || contentYielded)) {
        logPendingProtocolTagSanitized(
          pendingFinishResponse,
          pendingFinishProtocolTagSanitized
        );
        if (parkedHasToolCall) {
          markFlushedToolCallPark(pendingFinishResponse);
        }
        yield pendingFinishResponse;
        finishYielded = true;
      }
      if (error instanceof StreamContentError) {
        throw redactProxyError(error);
      }
      if (error instanceof StreamInactivityTimeoutError || error instanceof StreamLifetimeExceededError) {
        const isLifetime = error instanceof StreamLifetimeExceededError;
        debugLogger3.warn(
          isLifetime ? "OpenAI stream lifetime cap exceeded" : "OpenAI stream inactivity timeout",
          {
            chunksReceived: error.chunksReceived,
            // Wall clock, labelled apart from the cap so the two numbers in
            // the log reconcile the same way the error message does.
            wallClockMs: error.streamLifetimeMs,
            ...isLifetime ? {
              maxLifetimeMs: error.maxLifetimeMs
            } : { idleMs: error.idleMs }
          }
        );
        throw redactProxyError(error);
      }
      if (context.pendingThinkingTagCandidate?.closingTagName && request.config?.abortSignal?.aborted !== true) {
        context.pendingThinkingTagCandidate = void 0;
        context.pendingUntrustedResponseParts = void 0;
        throw new InvalidStreamError(
          "Model response leaked thinking tags.",
          "PROTOCOL_TAG_LEAK"
        );
      }
      await this.handleError(error, context, request);
    }
  }
  /**
   * Handle chunk merging for providers that send finishReason and usageMetadata separately.
   *
   * Strategy: When we encounter a finishReason chunk, we hold it and merge all subsequent
   * chunks into it until the stream ends. This ensures the final chunk contains both
   * finishReason and the most up-to-date usage information from any provider pattern.
   *
   * @param response Current Gemini response
   * @param pendingFinishResponse Finish response currently held for merging
   * @param setPendingFinish Callback to set pending finish response
   * @returns true if the response should be yielded, false if it should be held for merging
   */
  handleChunkMerging(response, pendingFinishResponse, setPendingFinish) {
    const isFinishChunk = response.candidates?.[0]?.finishReason;
    if (isFinishChunk) {
      if (pendingFinishResponse) {
        if (response.usageMetadata) {
          pendingFinishResponse.usageMetadata = response.usageMetadata;
        }
        if (response.modelVersion) {
          pendingFinishResponse.modelVersion = response.modelVersion;
        }
        setPendingFinish(pendingFinishResponse);
      } else {
        setPendingFinish(response);
      }
      return false;
    } else if (pendingFinishResponse) {
      const mergedResponse = new GenerateContentResponse();
      mergedResponse.candidates = pendingFinishResponse.candidates;
      if (response.usageMetadata) {
        mergedResponse.usageMetadata = response.usageMetadata;
      } else {
        mergedResponse.usageMetadata = pendingFinishResponse.usageMetadata;
      }
      mergedResponse.responseId = response.responseId || pendingFinishResponse.responseId;
      mergedResponse.createTime = response.createTime || pendingFinishResponse.createTime;
      mergedResponse.modelVersion = response.modelVersion || pendingFinishResponse.modelVersion;
      mergedResponse.promptFeedback = response.promptFeedback || pendingFinishResponse.promptFeedback;
      setPendingFinish(mergedResponse);
      return true;
    }
    return true;
  }
  async buildRequest(request, userPromptId, context, isStreaming) {
    const reasoningCapabilities = resolveReasoningForModel(
      this.config.cliConfig,
      this.contentGeneratorConfig,
      context.model
    );
    const convertedMessages = OpenAIContentConverter.convertLlmRequestToOpenAI(
      request,
      context
    );
    const messages = reasoningCapabilities?.profile === "deepseek-openai" ? convertedMessages.map(ensureReasoningContentOnAssistantMessage) : convertedMessages;
    let baseRequest = {
      model: context.model,
      messages,
      ...this.buildGenerateContentConfig(request),
      ...this.buildResponseFormat(request)
    };
    if (isStreaming) {
      baseRequest.stream = true;
      baseRequest.stream_options = { include_usage: true };
    } else {
      baseRequest.stream = false;
    }
    const effectiveReasoning = getEffectiveReasoning(
      this.contentGeneratorConfig,
      reasoningCapabilities
    );
    if (reasoningCapabilities && !("reasoning" in baseRequest) && effectiveReasoning && request.config?.thinkingConfig?.includeThoughts !== false) {
      baseRequest = {
        ...baseRequest,
        reasoning: effectiveReasoning
      };
    }
    if (this.contentGeneratorConfig.samplingParams?.["reasoning"] === void 0 && (!reasoningCapabilities?.profile || this.contentGeneratorConfig.extra_body?.["reasoning"] === void 0) && (reasoningCapabilities?.profile || !isOpenRouterHostname(this.contentGeneratorConfig))) {
      baseRequest = applyConfiguredReasoningEffort(
        baseRequest,
        reasoningCapabilities
      );
    }
    if (request.config?.tools && request.config.tools.length > 0) {
      baseRequest.tools = await OpenAIContentConverter.convertLlmToolsToOpenAI(
        request.config.tools,
        this.contentGeneratorConfig.schemaCompliance ?? "auto"
      );
      const fcMode = request.config?.toolConfig?.functionCallingConfig?.mode;
      if (fcMode === "ANY") {
        baseRequest["tool_choice"] = "required";
      } else if (fcMode === "NONE") {
        baseRequest["tool_choice"] = "none";
      }
    }
    let providerRequest = this.config.provider.buildRequest(
      baseRequest,
      userPromptId,
      trailingReattachPartCount(request.contents)
    );
    if (this.contentGeneratorConfig.enableCacheControl !== false && isOfficialOpenAIEndpoint(this.contentGeneratorConfig)) {
      providerRequest = applyOfficialOpenAIPromptCaching(
        providerRequest,
        this.config.cliConfig.getSessionId?.(),
        request.promptCacheSharing === true,
        isInForkExecution() ? void 0 : getCurrentAgentId() ?? void 0
      );
    }
    const model = (context.model ?? "").toLowerCase();
    const isDashScope = DashScopeOpenAICompatibleProvider.isDashScopeProvider(
      this.contentGeneratorConfig
    );
    const explicitThinkingMandatory = reasoningCapabilities?.canDisable === false || this.requiresThinking(model);
    const profile = reasoningCapabilities?.profile;
    const thinkingMandatory = explicitThinkingMandatory || !profile && getGptReasoningCapabilities(model)?.thinkingMandatory === true;
    const reasoningDisabled = request.config?.thinkingConfig?.includeThoughts === false || this.contentGeneratorConfig.reasoning === false;
    if ((profile === "openai-effort" || profile === "dashscope-effort") && isReasoningEffortPlaceholder(providerRequest.reasoning_effort) && effectiveReasoning && this.contentGeneratorConfig.samplingParams?.["reasoning"] === void 0 && this.contentGeneratorConfig.extra_body?.["reasoning"] === void 0)
      providerRequest.reasoning_effort = effectiveReasoning.effort;
    if (reasoningDisabled && profile) {
      const typed2 = providerRequest;
      if (!thinkingMandatory || request.config?.thinkingConfig?.includeThoughts === false) {
        delete typed2["reasoning"];
        delete typed2["reasoning_effort"];
      }
      if (!thinkingMandatory) {
        if (isDashScope && profile === "dashscope-effort") {
          delete typed2["thinking_budget"];
          delete typed2["enable_thinking"];
        }
        const template = asObject(typed2["chat_template_kwargs"]);
        Object.assign(typed2, profileReasoning(profile, false));
        if (profile === "qwen-chat-template") {
          delete typed2["enable_thinking"];
          typed2["chat_template_kwargs"] = {
            ...template,
            enable_thinking: false
          };
        } else if (reasoningCapabilities?.disableField === "enable_thinking") {
          delete typed2["reasoning_effort"];
          typed2["enable_thinking"] = false;
        }
      }
    } else if (reasoningDisabled) {
      const typed2 = providerRequest;
      if (!thinkingMandatory && isQwenFamilyWireModel(model)) {
        if (isDashScope) {
          if (isTieredEffortWireModel(model)) {
            delete typed2["enable_thinking"];
            delete typed2["thinking_budget"];
            typed2["reasoning_effort"] = "none";
          } else {
            typed2["enable_thinking"] = false;
          }
        } else {
          delete typed2["enable_thinking"];
          const existing = typed2["chat_template_kwargs"] ?? {};
          typed2["chat_template_kwargs"] = {
            ...existing,
            enable_thinking: false
          };
        }
      }
      if (!thinkingMandatory) {
        if (reasoningCapabilities?.disableField === "reasoning_effort") {
          delete typed2["enable_thinking"];
          delete typed2["thinking_budget"];
          typed2["reasoning_effort"] = "none";
        } else if (reasoningCapabilities?.disableField === "enable_thinking") {
          typed2["enable_thinking"] = false;
        }
      }
      if ("reasoning" in typed2) {
        delete typed2["reasoning"];
      }
      if ("reasoning_effort" in typed2 && typed2["reasoning_effort"] !== "none") {
        delete typed2["reasoning_effort"];
      }
      const gptReasoning = getGptReasoningCapabilities(model);
      if (gptReasoning && !reasoningCapabilities && !gptReasoning.thinkingMandatory && !thinkingMandatory && !isOpenRouterHostname(this.contentGeneratorConfig)) {
        typed2["reasoning_effort"] = "none";
      }
      if (isDeepSeekHostname(this.contentGeneratorConfig) || reasoningCapabilities?.disableField === "thinking") {
        typed2["thinking"] = { type: "disabled" };
      }
      if (!thinkingMandatory && isOpenRouterHostname(this.contentGeneratorConfig)) {
        typed2["reasoning"] = { enabled: false };
      }
    }
    if (thinkingMandatory) {
      const typed2 = providerRequest;
      if (typed2["enable_thinking"] === false) {
        delete typed2["enable_thinking"];
      }
      if (typed2["reasoning_effort"] === "none") {
        delete typed2["reasoning_effort"];
      }
      const thinking = asObject(typed2["thinking"]);
      if (thinking?.["type"] === "disabled") {
        const remaining = { ...thinking };
        delete remaining["type"];
        if (Object.keys(remaining).length > 0) typed2["thinking"] = remaining;
        else delete typed2["thinking"];
      }
      const chatTemplateKwargs = typed2["chat_template_kwargs"];
      if (chatTemplateKwargs?.["enable_thinking"] === false) {
        const remaining = { ...chatTemplateKwargs };
        delete remaining["enable_thinking"];
        if (Object.keys(remaining).length > 0) {
          typed2["chat_template_kwargs"] = remaining;
        } else {
          delete typed2["chat_template_kwargs"];
        }
      }
    }
    const typed = providerRequest;
    const reasoningEffort = typed["reasoning_effort"];
    const thinkingBudget = typed["thinking_budget"];
    if (isDashScope && typed["tool_choice"] === "required" && (explicitThinkingMandatory || isQwenFamilyWireModel(model) && (typed["enable_thinking"] === true || thinkingBudget != null && typed["enable_thinking"] !== false || typeof reasoningEffort === "string" && reasoningEffort !== "none"))) {
      debugLogger3.debug(
        "DashScope: dropping tool_choice=required while thinking is enabled",
        { model, reasoningEffort, thinkingBudget, explicitThinkingMandatory }
      );
      delete typed["tool_choice"];
    }
    return providerRequest;
  }
  buildResponseFormat(request) {
    if (!isOfficialOpenAIEndpoint(this.contentGeneratorConfig)) return {};
    if (request.config?.responseMimeType !== "application/json") return {};
    const schema = request.config.responseJsonSchema ?? request.config.responseSchema;
    if (!schema) return { response_format: { type: "json_object" } };
    const strictSchema = normalizeOpenAIStrictSchema(schema);
    if (!strictSchema) return { response_format: { type: "json_object" } };
    return {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "response",
          schema: strictSchema,
          strict: true
        }
      }
    };
  }
  requiresThinking(model) {
    const normalizedModel = model.toLowerCase();
    return this.requiredThinkingModels.has(normalizedModel) || this.contentGeneratorConfig.thinkingMandatory === true && normalizedModel === (this.contentGeneratorConfig.model ?? "").toLowerCase();
  }
  buildGenerateContentConfig(request) {
    const defaultSamplingParams = this.config.provider.getDefaultGenerationConfig();
    const configSamplingParams = this.contentGeneratorConfig.samplingParams;
    const getParameterValue = /* @__PURE__ */ __name((configKey, requestKey) => {
      const configValue = configSamplingParams?.[configKey];
      const requestValue = requestKey ? request.config?.[requestKey] : void 0;
      const defaultValue = requestKey ? defaultSamplingParams[requestKey] : void 0;
      if (configValue !== void 0) return configValue;
      if (requestValue !== void 0) return requestValue;
      return defaultValue;
    }, "getParameterValue");
    const addParameterIfDefined = /* @__PURE__ */ __name((key, configKey, requestKey) => {
      const value = getParameterValue(configKey, requestKey);
      return value !== void 0 ? { [key]: value } : {};
    }, "addParameterIfDefined");
    if (configSamplingParams !== void 0) {
      const rawEffort = {
        ...configSamplingParams,
        ...this.contentGeneratorConfig.extra_body
      }["reasoning_effort"];
      const samplingParams = getGptReasoningCapabilities(
        request.model || this.contentGeneratorConfig.model
      ) && configSamplingParams["reasoning"] === void 0 && (isReasoningEffortPlaceholder(
        configSamplingParams["reasoning_effort"]
      ) || isReasoningEffortPlaceholder(rawEffort)) ? { ...this.buildReasoningConfig(request), ...configSamplingParams } : configSamplingParams;
      const requestMaxTokens = request.config?.maxOutputTokens;
      const maxTokens = reconcileMaxTokens(configSamplingParams.max_tokens, requestMaxTokens) ?? configSamplingParams.max_tokens ?? (hasProviderOutputBudgetKey(configSamplingParams) ? void 0 : requestMaxTokens);
      return clampProviderOutputBudgetKeys(
        maxTokens !== void 0 ? { ...samplingParams, max_tokens: maxTokens } : { ...samplingParams },
        requestMaxTokens
      );
    }
    const params = {
      // Parameters with request fallback but no defaults
      ...addParameterIfDefined("temperature", "temperature", "temperature"),
      ...addParameterIfDefined("top_p", "top_p", "topP"),
      // Max tokens (special case: different property names)
      ...addParameterIfDefined("max_tokens", "max_tokens", "maxOutputTokens"),
      // Config-only parameters (no request fallback)
      ...addParameterIfDefined("top_k", "top_k", "topK"),
      ...addParameterIfDefined("repetition_penalty", "repetition_penalty"),
      ...addParameterIfDefined(
        "presence_penalty",
        "presence_penalty",
        "presencePenalty"
      ),
      ...addParameterIfDefined(
        "frequency_penalty",
        "frequency_penalty",
        "frequencyPenalty"
      ),
      ...this.buildReasoningConfig(request)
    };
    return params;
  }
  buildReasoningConfig(request) {
    if (request.config?.thinkingConfig?.includeThoughts === false) {
      return {};
    }
    const reasoning = getEffectiveReasoning(
      this.contentGeneratorConfig,
      resolveReasoningForModel(
        this.config.cliConfig,
        this.contentGeneratorConfig,
        request.model
      )
    );
    if (reasoning === false || reasoning === void 0) {
      return {};
    }
    return { reasoning };
  }
  /**
   * Common error handling wrapper for execute methods
   */
  async executeWithErrorHandling(request, userPromptId, isStreaming, executor) {
    const context = this.createRequestContext(request, isStreaming);
    let openaiRequest;
    const executeAttempt = /* @__PURE__ */ __name(async (attemptContext = context) => {
      openaiRequest = await this.buildRequest(
        request,
        userPromptId,
        attemptContext,
        isStreaming
      );
      openaiRequestCaptureContext.getStore()?.(openaiRequest);
      runtimeDiagnostics.recordOpenAIWireRequest(openaiRequest);
      const telemetryAttempt = reportOpenAiRequest(openaiRequest);
      return executor(openaiRequest, attemptContext, telemetryAttempt);
    }, "executeAttempt");
    try {
      return await executeAttempt();
    } catch (error) {
      await this.invalidateOmniOssCacheOnError(openaiRequest, error);
      const model = context.model.toLowerCase();
      const wireRequest = openaiRequest;
      const chatTemplateKwargs = wireRequest?.["chat_template_kwargs"];
      if ((wireRequest?.["enable_thinking"] === false || chatTemplateKwargs?.["enable_thinking"] === false || // The tier-native family's disable shape (reasoning_effort:
      // 'none') replaces enable_thinking: false on the wire; recognise
      // it so runtime learning still fires there.
      wireRequest?.["reasoning_effort"] === "none") && request.config?.abortSignal?.aborted !== true && isRequiredThinkingError(error)) {
        this.requiredThinkingModels.add(model);
        debugLogger3.warn("Retrying with required thinking enabled", {
          model,
          originalError: getErrorMessage(error)
        });
        try {
          return await executeAttempt();
        } catch (retryError) {
          return await this.handleError(retryError, context, request);
        }
      }
      if (request.config?.abortSignal?.aborted !== true && getErrorStatus(error) === 400 && wireRequestHasMediaContent(wireRequest)) {
        debugLogger3.warn(
          "Media-bearing request rejected with 400; retrying once with media degraded to placeholders",
          { model, originalError: getErrorMessage(error) }
        );
        try {
          return await executeAttempt({ ...context, modalities: {} });
        } catch (retryError) {
          return await this.handleError(retryError, context, request);
        }
      }
      return await this.handleError(error, context, request);
    }
  }
  /**
   * Shared error handling logic for both executeWithErrorHandling and processStreamWithLogging
   * This centralizes the common error processing steps to avoid duplication
   */
  /**
   * Upload-cache invalidation for failed oss deliveries. Never throws
   * (internal try/catch), so callers can await it without masking the
   * original error.
   */
  async invalidateOmniOssCacheOnError(openaiRequest, error) {
    try {
      if (!this.config.cliConfig.isOmniEnabled?.()) return;
      if (getErrorStatus(error) === 429) return;
      const message = getErrorMessage(error);
      if (!/oss:\/\//i.test(message) && !(/download/i.test(message) && /resource|media/i.test(message))) {
        return;
      }
      const urls = /* @__PURE__ */ new Set();
      for (const m of openaiRequest?.messages ?? []) {
        const content = m.content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          const p = part;
          for (const u of [
            p.image_url?.url,
            p.video_url?.url,
            p.input_audio?.data
          ]) {
            if (typeof u === "string" && u.startsWith("oss://")) urls.add(u);
          }
        }
      }
      if (urls.size === 0) return;
      const { OmniUploadCache } = await import("./upload-cache-5YULQVZZ.js");
      const { OmniObjectStore } = await import("./storage-VZECDJNX.js");
      const store = new OmniObjectStore(
        this.config.cliConfig.storage.getQwenDir()
      );
      const cache = new OmniUploadCache(store.getOmniRootDir());
      for (const u of urls) await cache.invalidateByUrl(u);
    } catch {
    }
  }
  async handleError(error, context, request) {
    this.config.errorHandler.handle(redactProxyError(error), context, request);
  }
  /**
   * Create request context with common properties
   */
  createRequestContext(request, isStreaming) {
    const effectiveModel = request.model || this.contentGeneratorConfig.model;
    const providerOverrides = this.config.provider.getRequestContextOverrides?.() ?? {};
    const toolCallParser = isStreaming ? new StreamingToolCallParser() : void 0;
    const responseParsingOptions = this.config.provider.getResponseParsingOptions?.(effectiveModel);
    const taggedThinkingParser = isStreaming && responseParsingOptions?.taggedThinkingTags ? new TaggedThinkingParser() : void 0;
    return {
      model: effectiveModel,
      modalities: this.contentGeneratorConfig.modalities ?? {},
      startTime: Date.now(),
      splitToolMedia: providerOverrides.splitToolMedia ?? this.contentGeneratorConfig.splitToolMedia ?? // Default true: the OpenAI Chat Completions spec only permits text on
      // `role: "tool"` messages, so tool-returned media (e.g. an image read
      // by read_file) embedded there is silently dropped or rejected by
      // strict providers (doubao / new-api / LM Studio) and the model never
      // sees it (QwenLM/qwen-code#4876). Splitting it into a follow-up user
      // message is spec-compliant and safe for permissive providers too.
      // Opt out via generationConfig.splitToolMedia = false.
      true,
      toolResultContentFormat: providerOverrides.toolResultContentFormat ?? this.contentGeneratorConfig.toolResultContentFormat ?? "parts",
      ...toolCallParser ? { toolCallParser } : {},
      ...responseParsingOptions ? { responseParsingOptions } : {},
      ...taggedThinkingParser ? { taggedThinkingParser } : {}
    };
  }
};

// packages/core/src/core/openaiContentGenerator/errorHandler.ts
init_esbuild_shims();
var debugLogger4 = createDebugLogger("OPENAI_ERROR");
var EnhancedErrorHandler = class {
  constructor(shouldSuppressLogging = () => false) {
    this.shouldSuppressLogging = shouldSuppressLogging;
  }
  static {
    __name(this, "EnhancedErrorHandler");
  }
  handle(error, context, request) {
    const redactedError = redactProxyError(error);
    const isTimeoutError = this.isTimeoutError(redactedError);
    const errorMessage = this.buildErrorMessage(
      redactedError,
      context,
      isTimeoutError
    );
    if (!this.shouldSuppressErrorLogging(redactedError, request)) {
      debugLogger4.error(
        "OpenAI API Error:",
        errorMessage,
        this.buildDiagnostics(redactedError, context)
      );
    }
    if (isTimeoutError) {
      const timeoutError = new Error(
        `${errorMessage}

${this.getTimeoutTroubleshootingTips()}`,
        { cause: redactedError }
      );
      const status = getErrorStatus(redactedError);
      const transportCode = getTransportCode(redactedError);
      throw Object.assign(timeoutError, {
        ...status !== void 0 ? { status } : {},
        ...status === void 0 && transportCode === void 0 ? { code: "ETIMEDOUT" } : {}
      });
    }
    throw redactedError;
  }
  shouldSuppressErrorLogging(error, request) {
    return this.shouldSuppressLogging(error, request);
  }
  isTimeoutError(error) {
    if (!error) return false;
    const errorMessage = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    const errorCode = error?.code;
    const errorType = error?.type;
    return errorMessage.includes("timeout") || errorMessage.includes("timed out") || errorMessage.includes("connection timeout") || errorMessage.includes("request timeout") || errorMessage.includes("read timeout") || errorMessage.includes("etimedout") || errorMessage.includes("esockettimedout") || errorCode === "ETIMEDOUT" || errorCode === "ESOCKETTIMEDOUT" || errorType === "timeout" || errorMessage.includes("request timed out") || errorMessage.includes("deadline exceeded");
  }
  buildErrorMessage(error, context, isTimeoutError) {
    const durationSeconds = Math.round((Date.now() - context.startTime) / 1e3);
    if (isTimeoutError) {
      return `Request timeout after ${durationSeconds}s. Try reducing input length or increasing timeout in config.`;
    }
    return error instanceof Error ? getErrorMessage(error) : String(error);
  }
  buildDiagnostics(error, context) {
    const details = getRateLimitErrorDetails(error);
    const requestId = this.getRequestId(error) ?? details.requestId;
    const statusCode = getErrorStatus(error);
    return {
      model: context.model,
      durationMs: Date.now() - context.startTime,
      errorType: getErrorType(error),
      ...statusCode !== void 0 ? { statusCode } : {},
      ...details.providerCode !== void 0 ? { providerCode: details.providerCode } : {},
      ...details.providerMessage !== void 0 ? { providerMessage: details.providerMessage } : {},
      ...requestId !== void 0 ? { requestId } : {},
      ...details.transport !== "unknown" ? { transport: details.transport } : {}
    };
  }
  getRequestId(error) {
    if (!error || typeof error !== "object") return void 0;
    const source = error;
    for (const value of [
      source.requestID,
      source.request_id,
      source.response_id
    ]) {
      if (typeof value === "string" && value) {
        return value;
      }
    }
    return void 0;
  }
  getTimeoutTroubleshootingTips() {
    const tips = [
      "- Reduce input length or complexity",
      "- Increase timeout in config: contentGenerator.timeout",
      "- Check network connectivity"
    ];
    return `Troubleshooting tips:
${tips.join("\n")}`;
  }
};

// packages/core/src/core/openaiContentGenerator/openaiContentGenerator.ts
var debugLogger5 = createDebugLogger("OPENAI");
var OpenAIContentGenerator = class {
  static {
    __name(this, "OpenAIContentGenerator");
  }
  pipeline;
  constructor(contentGeneratorConfig, cliConfig, provider) {
    const pipelineConfig = {
      cliConfig,
      provider,
      contentGeneratorConfig,
      errorHandler: new EnhancedErrorHandler(
        (error, request) => this.shouldSuppressErrorLogging(error, request)
      )
    };
    this.pipeline = new ContentGenerationPipeline(pipelineConfig);
  }
  /**
   * Hook for subclasses to customize error handling behavior
   * @param error The error that occurred
   * @param request The original request
   * @returns true if error logging should be suppressed, false otherwise
   */
  shouldSuppressErrorLogging(error, request) {
    if (isAbortError(error) && request.config?.abortSignal?.aborted) {
      return true;
    }
    return false;
  }
  async generateContent(request, userPromptId) {
    return this.pipeline.execute(request, userPromptId);
  }
  async generateContentStream(request, userPromptId) {
    return this.pipeline.executeStream(request, userPromptId);
  }
  async embedContent(request) {
    const text = extractTextFromContents(request.contents);
    try {
      const embedding = await this.pipeline.client.embeddings.create({
        model: "text-embedding-ada-002",
        // Default embedding model
        input: text
      });
      return {
        embeddings: [
          {
            values: embedding.data[0].embedding
          }
        ]
      };
    } catch (error) {
      const redactedError = redactProxyError(error);
      debugLogger5.error("OpenAI API Embedding Error:", redactedError);
      throw new Error(
        `OpenAI API error: ${redactedError instanceof Error ? redactedError.message : String(redactedError)}`
      );
    }
  }
};

// packages/core/src/core/openaiContentGenerator/index.ts
function createOpenAIContentGenerator(contentGeneratorConfig, cliConfig) {
  const provider = determineProvider(contentGeneratorConfig, cliConfig);
  return new OpenAIContentGenerator(
    contentGeneratorConfig,
    cliConfig,
    provider
  );
}
__name(createOpenAIContentGenerator, "createOpenAIContentGenerator");
function determineProvider(contentGeneratorConfig, cliConfig) {
  const config = contentGeneratorConfig || cliConfig.getContentGeneratorConfig();
  if (DashScopeOpenAICompatibleProvider.isDashScopeProvider(config)) {
    return new DashScopeOpenAICompatibleProvider(
      contentGeneratorConfig,
      cliConfig
    );
  }
  if (DeepSeekOpenAICompatibleProvider.isDeepSeekProvider(config)) {
    return new DeepSeekOpenAICompatibleProvider(
      contentGeneratorConfig,
      cliConfig
    );
  }
  if (ZaiOpenAICompatibleProvider.isZaiProvider(config)) {
    return new ZaiOpenAICompatibleProvider(contentGeneratorConfig, cliConfig);
  }
  if (MiMoOpenAICompatibleProvider.isMiMoProvider(config)) {
    return new MiMoOpenAICompatibleProvider(contentGeneratorConfig, cliConfig);
  }
  if (ModelScopeOpenAICompatibleProvider.isModelScopeProvider(config)) {
    return new ModelScopeOpenAICompatibleProvider(
      contentGeneratorConfig,
      cliConfig
    );
  }
  if (MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(config)) {
    return new MiniMaxOpenAICompatibleProvider(
      contentGeneratorConfig,
      cliConfig
    );
  }
  if (MistralOpenAICompatibleProvider.isMistralProvider(config)) {
    return new MistralOpenAICompatibleProvider(
      contentGeneratorConfig,
      cliConfig
    );
  }
  if (CerebrasOpenAICompatibleProvider.isCerebrasProvider(config)) {
    return new CerebrasOpenAICompatibleProvider(
      contentGeneratorConfig,
      cliConfig
    );
  }
  if (FireworksOpenAICompatibleProvider.isFireworksProvider(config)) {
    return new FireworksOpenAICompatibleProvider(
      contentGeneratorConfig,
      cliConfig
    );
  }
  return new DefaultOpenAICompatibleProvider(contentGeneratorConfig, cliConfig);
}
__name(determineProvider, "determineProvider");

export {
  DeepSeekOpenAICompatibleProvider,
  MiniMaxOpenAICompatibleProvider,
  MistralOpenAICompatibleProvider,
  CerebrasOpenAICompatibleProvider,
  FireworksOpenAICompatibleProvider,
  MiMoOpenAICompatibleProvider,
  ContentGenerationPipeline,
  EnhancedErrorHandler,
  OpenAIContentGenerator,
  createOpenAIContentGenerator,
  determineProvider
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
