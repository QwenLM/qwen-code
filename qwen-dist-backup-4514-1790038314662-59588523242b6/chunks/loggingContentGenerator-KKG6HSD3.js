// Force strict mode and setup for ESM
"use strict";
import {
  OpenAILogger
} from "./chunk-PU756QJZ.js";
import {
  computeThresholds,
  estimateContentTokens,
  estimateContextTextTokens
} from "./chunk-MRTRBONQ.js";
import "./chunk-GOFAQQZA.js";
import "./chunk-65I7S4Z3.js";
import "./chunk-HEOH7JZY.js";
import "./chunk-TWPJO254.js";
import "./chunk-CQ35AJ4Z.js";
import "./chunk-4YS7RMCB.js";
import "./chunk-PQQV3OBW.js";
import "./chunk-ANKISCKU.js";
import "./chunk-4SZ2636R.js";
import "./chunk-5EZRLTLQ.js";
import "./chunk-QHWCP53L.js";
import "./chunk-C4FISGDN.js";
import "./chunk-O6GEWCJA.js";
import "./chunk-KS6F6LZQ.js";
import "./chunk-6PVPNMXU.js";
import "./chunk-OB57Y2WH.js";
import {
  areSensitiveSpanAttributesEnabled
} from "./chunk-IMV5DBIP.js";
import "./chunk-IWMYX5LB.js";
import "./chunk-QJNDUTOL.js";
import "./chunk-QPTE6BKL.js";
import "./chunk-U6H3XTFA.js";
import "./chunk-ACHCT36C.js";
import "./chunk-CHEIIBT3.js";
import "./chunk-GHG4PQY2.js";
import "./chunk-YVYK3JYU.js";
import "./chunk-Q5N5NEVT.js";
import "./chunk-ADN5KESB.js";
import "./chunk-SK3RZOPS.js";
import "./chunk-EVZT24AF.js";
import "./chunk-ELRMZTPF.js";
import "./chunk-B5WYAQ4I.js";
import "./chunk-JX6XHPTX.js";
import "./chunk-6C3D7BKK.js";
import "./chunk-ZAQM5T2X.js";
import "./chunk-MNU36NGH.js";
import {
  getCustomSystemPrompt
} from "./chunk-B3HGO6BB.js";
import "./chunk-AUFTA63J.js";
import "./chunk-SATGWSS6.js";
import "./chunk-MLXTMF7H.js";
import "./chunk-BQMSZSG6.js";
import {
  OpenAIContentConverter,
  openaiRequestCaptureContext
} from "./chunk-2FQM443D.js";
import "./chunk-CF5KXZZX.js";
import {
  runtimeDiagnostics
} from "./chunk-VNOVK4I7.js";
import {
  createGenAiExchange
} from "./chunk-736AZVPL.js";
import "./chunk-WFNEY5G7.js";
import "./chunk-5FHOPPLZ.js";
import "./chunk-S6LOFUVP.js";
import "./chunk-BKVPLSEI.js";
import "./chunk-WNM6BA7E.js";
import "./chunk-S7UQ3V2H.js";
import "./chunk-QE36VXWP.js";
import "./chunk-2A6RZKP2.js";
import {
  buildSkillLlmContent
} from "./chunk-WDVSRQIQ.js";
import "./chunk-GXNXX7A2.js";
import "./chunk-IITTKFWM.js";
import "./chunk-Z72PLR74.js";
import {
  getGenAiUsageProvenance
} from "./chunk-BA6AXQDA.js";
import "./chunk-NUQ4GK5I.js";
import "./chunk-KP2FHIFR.js";
import "./chunk-TLS6QN2S.js";
import "./chunk-NAVJD2PQ.js";
import "./chunk-KKPIFWTZ.js";
import {
  retryContext
} from "./chunk-NFC4WTY2.js";
import "./chunk-YSD6IY6F.js";
import "./chunk-DJ2GSRLV.js";
import "./chunk-MS4SXNJ6.js";
import "./chunk-GVTAFLWB.js";
import {
  ApiErrorEvent,
  ApiRequestEvent,
  ApiResponseEvent,
  DiscoveredMCPTool,
  isInternalPromptId,
  logApiError,
  logApiRequest,
  logApiResponse,
  subagentIdentityContext,
  subagentNameContext
} from "./chunk-KKGSJZWK.js";
import "./chunk-5ETULJLP.js";
import "./chunk-VGC4I5JJ.js";
import "./chunk-RVT5L74D.js";
import "./chunk-HD7O6WLV.js";
import "./chunk-25FMWESU.js";
import "./chunk-CFMZLE3L.js";
import "./chunk-43QUA4MC.js";
import "./chunk-WZAD4ZNJ.js";
import "./chunk-EKBQJ627.js";
import {
  DEFAULT_TOKEN_LIMIT
} from "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import "./chunk-CA63HYHU.js";
import "./chunk-SBP43AO6.js";
import "./chunk-HHJLM3WQ.js";
import {
  API_CALL_ABORTED_SPAN_STATUS_MESSAGE,
  API_CALL_FAILED_SPAN_STATUS_MESSAGE,
  endLLMRequestSpan,
  isTelemetrySdkInitialized,
  isValidContextUsage,
  startLLMRequestSpanWithContext
} from "./chunk-B3XJFEEH.js";
import "./chunk-74TONY4F.js";
import "./chunk-ZRQGTRHA.js";
import "./chunk-VPGRGNNH.js";
import {
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger,
  getSessionIdFromContext
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorMessage,
  getErrorStatus,
  getErrorType,
  isAbortError
} from "./chunk-S34QJ6IR.js";
import {
  context,
  init_esm
} from "./chunk-TBWQLLFO.js";
import "./chunk-UKMWZ5NS.js";
import "./chunk-75DOP5OR.js";
import "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
import {
  GenerateContentResponse
} from "./chunk-EFT7OMDN.js";
import "./chunk-MATEIJZF.js";
import "./chunk-J5TTWBZK.js";
import "./chunk-RVIGZBIT.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/core/loggingContentGenerator/index.ts
init_esbuild_shims();

// packages/core/src/core/loggingContentGenerator/loggingContentGenerator.ts
init_esbuild_shims();
init_esm();

// packages/core/src/core/loggingContentGenerator/context-usage-snapshot.ts
init_esbuild_shims();
import * as path from "node:path";
function toPart(part) {
  return typeof part === "string" ? { text: part } : part;
}
__name(toPart, "toPart");
function toContent(content) {
  if (Array.isArray(content)) {
    return { role: "user", parts: content.map(toPart) };
  }
  if (typeof content === "string") {
    return { role: "user", parts: [{ text: content }] };
  }
  if ("parts" in content) {
    return {
      ...content,
      parts: content.parts?.filter((part) => part != null).map(toPart) ?? []
    };
  }
  return { role: "user", parts: [toPart(content)] };
}
__name(toContent, "toContent");
function toContents(contents) {
  return Array.isArray(contents) ? contents.map((content) => toContent(content)) : [toContent(contents)];
}
__name(toContents, "toContents");
function requestFunctionDeclarations(request) {
  const declarations = [];
  for (const tool of request.config?.tools ?? []) {
    if (typeof tool === "object" && tool !== null && "tool" in tool) {
      return void 0;
    }
    if (typeof tool === "object" && tool !== null && "functionDeclarations" in tool && Array.isArray(tool.functionDeclarations)) {
      declarations.push(...tool.functionDeclarations);
    }
  }
  return declarations;
}
__name(requestFunctionDeclarations, "requestFunctionDeclarations");
function estimateToolCategories(request, config) {
  let builtinTools = 0;
  let mcpTools = 0;
  let skillTool = 0;
  const registry = config.getToolRegistry();
  const declarations = requestFunctionDeclarations(request);
  if (!declarations) return void 0;
  for (const declaration of declarations) {
    const tokens = estimateContextTextTokens(JSON.stringify(declaration));
    if (declaration.name === ToolNames.SKILL) {
      skillTool += tokens;
    } else if (declaration.name && registry.getTool(declaration.name) instanceof DiscoveredMCPTool) {
      mcpTools += tokens;
    } else {
      builtinTools += tokens;
    }
  }
  return { builtinTools, mcpTools, skillTool };
}
__name(estimateToolCategories, "estimateToolCategories");
function extractMemoryTokens(systemInstruction, config) {
  let remaining = systemInstruction;
  let memoryTokens = 0;
  for (const configured of [
    config.getUserMemory(),
    config.getAutoMemoryPrompt()
  ]) {
    const segment = configured.trim();
    if (!segment) continue;
    const index = remaining.indexOf(segment);
    if (index < 0) continue;
    remaining = remaining.slice(0, index) + remaining.slice(index + segment.length);
    memoryTokens += estimateContextTextTokens(segment);
  }
  return { systemInstruction: remaining, memoryTokens };
}
__name(extractMemoryTokens, "extractMemoryTokens");
function indexLoadedSkillBodies(outputs) {
  const tokensByOutput = /* @__PURE__ */ new Map();
  const outputByHeader = /* @__PURE__ */ new Map();
  for (const output of outputs) {
    if (tokensByOutput.has(output)) continue;
    tokensByOutput.set(output, estimateContextTextTokens(output));
    const lineEnd = output.indexOf("\n");
    const header = lineEnd < 0 ? output : output.slice(0, lineEnd);
    if (!outputByHeader.has(header)) {
      outputByHeader.set(header, output);
    } else if (outputByHeader.get(header) !== output) {
      outputByHeader.set(header, void 0);
    }
  }
  return { tokensByOutput, outputByHeader };
}
__name(indexLoadedSkillBodies, "indexLoadedSkillBodies");
function loadedSkillBodies(config) {
  const skillTool = config.getToolRegistry().getTool(ToolNames.SKILL);
  if (!skillTool || !("getLoadedSkillNames" in skillTool) || typeof skillTool.getLoadedSkillNames !== "function") {
    return indexLoadedSkillBodies([]);
  }
  if ("getLoadedSkillContents" in skillTool && typeof skillTool.getLoadedSkillContents === "function") {
    return indexLoadedSkillBodies(
      skillTool.getLoadedSkillContents()
    );
  }
  const cachedSkills = config.getSkillManager()?.getCachedSkills();
  if (!cachedSkills) return indexLoadedSkillBodies([]);
  const loadedNames = skillTool.getLoadedSkillNames();
  const outputs = [];
  for (const skill of cachedSkills) {
    if (!loadedNames.has(skill.name)) continue;
    outputs.push(
      buildSkillLlmContent(path.dirname(skill.filePath), skill.body)
    );
  }
  return indexLoadedSkillBodies(outputs);
}
__name(loadedSkillBodies, "loadedSkillBodies");
function attributeLoadedSkillBodies(contents, indexedBodies) {
  if (indexedBodies.tokensByOutput.size === 0) {
    return { contents, skillBodyTokens: 0 };
  }
  let skillBodyTokens = 0;
  let contentsChanged = false;
  const attributedContents = contents.map((content) => {
    let partsChanged = false;
    const parts = content.parts?.map((part) => {
      const response = part.functionResponse;
      const output = response?.response?.["output"];
      if (response?.name !== ToolNames.SKILL || typeof output !== "string") {
        return part;
      }
      let matchedOutput = output;
      let tokens = indexedBodies.tokensByOutput.get(output);
      if (tokens === void 0) {
        const lineEnd = output.indexOf("\n");
        const header = lineEnd < 0 ? output : output.slice(0, lineEnd);
        const candidate = indexedBodies.outputByHeader.get(header);
        if (candidate && output.startsWith(`${candidate}
`)) {
          matchedOutput = candidate;
          tokens = indexedBodies.tokensByOutput.get(candidate);
        }
      }
      if (tokens === void 0) return part;
      indexedBodies.tokensByOutput.delete(matchedOutput);
      skillBodyTokens += tokens;
      partsChanged = true;
      return {
        ...part,
        functionResponse: {
          ...response,
          response: {
            ...response.response,
            output: output.slice(matchedOutput.length)
          }
        }
      };
    });
    if (!partsChanged) return content;
    contentsChanged = true;
    return { ...content, parts };
  });
  return {
    contents: contentsChanged ? attributedContents : contents,
    skillBodyTokens
  };
}
__name(attributeLoadedSkillBodies, "attributeLoadedSkillBodies");
function createContextUsageSnapshot(request, config, contextWindowSize) {
  if (!Number.isSafeInteger(contextWindowSize) || contextWindowSize <= 0) {
    return void 0;
  }
  const systemText = getCustomSystemPrompt(request.config?.systemInstruction);
  const memory = extractMemoryTokens(systemText, config);
  const tools = estimateToolCategories(request, config);
  if (!tools) return void 0;
  const contents = toContents(request.contents);
  const attributedSkills = attributeLoadedSkillBodies(
    contents,
    loadedSkillBodies(config)
  );
  const thresholds = computeThresholds(
    contextWindowSize,
    config.getAutoCompactThreshold()
  );
  const snapshot = {
    version: 1,
    window_size_tokens: contextWindowSize,
    breakdown: {
      system_prompt_tokens: estimateContextTextTokens(memory.systemInstruction),
      builtin_tools_tokens: tools.builtinTools,
      mcp_tools_tokens: tools.mcpTools,
      memory_files_tokens: memory.memoryTokens,
      skills_tokens: tools.skillTool + attributedSkills.skillBodyTokens,
      messages_tokens: estimateContentTokens(attributedSkills.contents)
    },
    compaction_reserve_tokens: contextWindowSize - thresholds.auto,
    estimated: true
  };
  return isValidContextUsage(snapshot) ? snapshot : void 0;
}
__name(createContextUsageSnapshot, "createContextUsageSnapshot");

// packages/core/src/core/loggingContentGenerator/streamContentDetection.ts
init_esbuild_shims();
function hasUserVisibleContent(chunk) {
  const parts = chunk.candidates?.[0]?.content?.parts;
  if (!parts || parts.length === 0) return false;
  return parts.some(isUserVisiblePart);
}
__name(hasUserVisibleContent, "hasUserVisibleContent");
function isUserVisiblePart(part) {
  if (part === null || typeof part !== "object") return false;
  const p = part;
  if (typeof p.text === "string" && p.text.length > 0) return true;
  if (p.functionCall !== void 0) return true;
  if (p.inlineData !== void 0) return true;
  if (p.executableCode !== void 0) return true;
  if (p.thought === true) return true;
  return false;
}
__name(isUserVisiblePart, "isUserVisiblePart");

// packages/core/src/telemetry/gen-ai-provider.ts
init_esbuild_shims();
var PROVIDER_BY_ENV_KEY = {
  ANTHROPIC_API_KEY: "anthropic",
  BAILIAN_CODING_PLAN_API_KEY: "dashscope",
  BAILIAN_TOKEN_PLAN_API_KEY: "dashscope",
  DASHSCOPE_API_KEY: "dashscope",
  DEEPSEEK_API_KEY: "deepseek",
  IDEALAB_API_KEY: "dashscope",
  MINIMAX_API_KEY: "minimax",
  MIMO_API_KEY: "mimo",
  MISTRAL_API_KEY: "mistral_ai",
  MODELSCOPE_API_KEY: "modelscope",
  MOONSHOT_API_KEY: "moonshot",
  OPENAI_API_KEY: "openai",
  OPENROUTER_API_KEY: "openrouter",
  REQUESTY_API_KEY: "requesty",
  XAI_API_KEY: "x_ai",
  XIAOMI_MIMO_API_KEY: "mimo",
  ZAI_API_KEY: "z_ai"
};
function isHostOrSubdomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}
__name(isHostOrSubdomain, "isHostOrSubdomain");
function providerFromHostname(hostname) {
  if (isHostOrSubdomain(hostname, "dashscope.aliyuncs.com") || isHostOrSubdomain(hostname, "dashscope-intl.aliyuncs.com") || isHostOrSubdomain(hostname, "dashscope-us.aliyuncs.com") || hostname.startsWith("token-plan.") && isHostOrSubdomain(hostname, "maas.aliyuncs.com") || hostname.endsWith(".alibaba-inc.com") || hostname.endsWith(".aliyun-inc.com")) {
    return "dashscope";
  }
  if (isHostOrSubdomain(hostname, "openai.azure.com") || isHostOrSubdomain(hostname, "services.ai.azure.com")) {
    return "azure.ai.openai";
  }
  if (isHostOrSubdomain(hostname, "deepseek.com")) return "deepseek";
  if (isHostOrSubdomain(hostname, "x.ai")) return "x_ai";
  if (isHostOrSubdomain(hostname, "mistral.ai")) return "mistral_ai";
  if (isHostOrSubdomain(hostname, "moonshot.ai") || isHostOrSubdomain(hostname, "moonshot.cn")) {
    return "moonshot";
  }
  if (isHostOrSubdomain(hostname, "minimax.io") || isHostOrSubdomain(hostname, "minimaxi.com")) {
    return "minimax";
  }
  if (isHostOrSubdomain(hostname, "z.ai") || isHostOrSubdomain(hostname, "bigmodel.cn")) {
    return "z_ai";
  }
  if (isHostOrSubdomain(hostname, "modelscope.cn")) return "modelscope";
  if (isHostOrSubdomain(hostname, "xiaomimimo.com")) return "mimo";
  if (isHostOrSubdomain(hostname, "openrouter.ai")) return "openrouter";
  if (isHostOrSubdomain(hostname, "requesty.ai")) return "requesty";
  if (isHostOrSubdomain(hostname, "anthropic.com")) return "anthropic";
  if (isHostOrSubdomain(hostname, "openai.com")) return "openai";
  return void 0;
}
__name(providerFromHostname, "providerFromHostname");
function parsedUrl(value) {
  if (!value) return void 0;
  try {
    return new URL(value);
  } catch {
    return void 0;
  }
}
__name(parsedUrl, "parsedUrl");
function normalizedEndpoint(value) {
  const url = parsedUrl(value);
  if (!url) return void 0;
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return `${url.protocol}//${url.host}${pathname}${url.search}`;
}
__name(normalizedEndpoint, "normalizedEndpoint");
function resolveGenAiProviderName(config, dashscopeProxyBaseUrl) {
  if (config.authType === "qwen-oauth") return "dashscope";
  const baseUrl = normalizedEndpoint(config.baseUrl);
  const proxyUrl = normalizedEndpoint(dashscopeProxyBaseUrl);
  if (baseUrl && proxyUrl && baseUrl === proxyUrl) return "dashscope";
  const hostname = parsedUrl(config.baseUrl)?.hostname.toLowerCase();
  if (hostname) {
    const provider = providerFromHostname(hostname);
    if (provider) return provider;
  }
  const envProvider = config.apiKeyEnvKey ? PROVIDER_BY_ENV_KEY[config.apiKeyEnvKey.toUpperCase()] : void 0;
  if (envProvider) return envProvider;
  switch (config.authType) {
    case "anthropic":
      return "anthropic";
    case "gemini":
      return "gcp.gemini";
    case "vertex-ai":
      return "gcp.vertex_ai";
    default:
      return "openai";
  }
}
__name(resolveGenAiProviderName, "resolveGenAiProviderName");
function resolveGenAiOperationName(authType) {
  return authType === "gemini" || authType === "vertex-ai" ? "generate_content" : "chat";
}
__name(resolveGenAiOperationName, "resolveGenAiOperationName");
function resolveGenAiOutputType(authType, config) {
  if (authType !== "gemini" && authType !== "vertex-ai") return void 0;
  const mimeType = config?.responseMimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mimeType) {
    if (mimeType === "application/json" || mimeType.endsWith("+json")) {
      return "json";
    }
    if (mimeType.startsWith("text/")) return "text";
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("audio/")) return "speech";
  }
  const modalities = config?.responseModalities;
  if (modalities?.length !== 1) return void 0;
  switch (String(modalities[0]).toUpperCase()) {
    case "TEXT":
      return "text";
    case "IMAGE":
      return "image";
    case "AUDIO":
      return "speech";
    default:
      return void 0;
  }
}
__name(resolveGenAiOutputType, "resolveGenAiOutputType");

// packages/core/src/core/loggingContentGenerator/loggingContentGenerator.ts
function snapshotRetryMetadata() {
  const ctx = retryContext.getStore();
  return {
    attempt: ctx?.attempt ?? 1,
    requestSetupMs: ctx?.requestSetupMs,
    retryTotalDelayMs: ctx?.retryTotalDelayMs
  };
}
__name(snapshotRetryMetadata, "snapshotRetryMetadata");
function bindAsyncGeneratorToContext(stream, scopedContext) {
  return {
    next: /* @__PURE__ */ __name((...args) => context.with(scopedContext, () => stream.next(...args)), "next"),
    return: /* @__PURE__ */ __name((value) => context.with(scopedContext, () => stream.return(value)), "return"),
    throw: /* @__PURE__ */ __name((error) => context.with(scopedContext, () => stream.throw(error)), "throw"),
    [Symbol.asyncIterator]() {
      return this;
    }
  };
}
__name(bindAsyncGeneratorToContext, "bindAsyncGeneratorToContext");
function usageSpanMetadata(usage) {
  const provenance = getGenAiUsageProvenance(usage);
  return {
    inputTokens: usage?.promptTokenCount,
    outputTokens: usage?.candidatesTokenCount,
    cachedInputTokens: usage?.cachedContentTokenCount,
    cachedInputTokensReported: provenance?.cachedInputTokensReported ?? usage?.cachedContentTokenCount !== void 0,
    cacheCreationInputTokens: provenance?.cacheCreationInputTokens
  };
}
__name(usageSpanMetadata, "usageSpanMetadata");
function orderedFinishReasons(response) {
  const reasons = (response.candidates ?? []).map((candidate, position) => ({
    index: candidate.index ?? position,
    reason: candidate.finishReason ? String(candidate.finishReason) : void 0
  })).filter(
    (entry) => entry.reason !== void 0
  ).sort((left, right) => left.index - right.index).map((entry) => entry.reason);
  return reasons.length > 0 ? reasons : void 0;
}
__name(orderedFinishReasons, "orderedFinishReasons");
var debugLogger = createDebugLogger("LOGGING_CONTENT_GENERATOR");
var MAX_RESPONSE_TEXT_LENGTH = 4096;
var RESPONSE_TEXT_TRUNCATION_SUFFIX = "...[truncated]";
var LoggingContentGenerator = class {
  constructor(wrapped, config, generatorConfig) {
    this.wrapped = wrapped;
    this.config = config;
    this.generatorConfig = generatorConfig;
    this.modalities = generatorConfig.modalities;
    this.splitToolMedia = generatorConfig.splitToolMedia;
    this.toolResultContentFormat = generatorConfig.toolResultContentFormat;
    this.generatorAuthType = generatorConfig.authType;
    this.genAiProviderName = resolveGenAiProviderName(
      generatorConfig,
      process.env["DASHSCOPE_PROXY_BASE_URL"]
    );
    this.genAiOperationName = resolveGenAiOperationName(
      generatorConfig.authType
    );
    if (generatorConfig.enableOpenAILogging) {
      this.openaiLogger = new OpenAILogger(
        generatorConfig.openAILoggingDir,
        config.getWorkingDir()
      );
      this.schemaCompliance = generatorConfig.schemaCompliance;
    }
  }
  static {
    __name(this, "LoggingContentGenerator");
  }
  openaiLogger;
  schemaCompliance;
  modalities;
  splitToolMedia;
  toolResultContentFormat;
  generatorAuthType;
  genAiProviderName;
  genAiOperationName;
  getWrapped() {
    return this.wrapped;
  }
  snapshotContextUsage(request, isInternal) {
    if (isInternal || !isTelemetrySdkInitialized()) return void 0;
    try {
      return createContextUsageSnapshot(
        request,
        this.config,
        this.generatorConfig.contextWindowSize ?? DEFAULT_TOKEN_LIMIT
      );
    } catch (error) {
      debugLogger.warn(
        `Failed to snapshot context usage: ${error instanceof Error ? error.message : String(error)}`
      );
      return void 0;
    }
  }
  logApiRequest(contents, model, promptId, sessionId) {
    const requestText = this.config.getTelemetryLogPromptsEnabled() ? JSON.stringify(contents) : void 0;
    logApiRequest(
      this.config,
      new ApiRequestEvent(
        model,
        promptId,
        requestText,
        subagentNameContext.getStore()
      ),
      sessionId
    );
  }
  _logApiResponse(responseId, durationMs, model, prompt_id, sessionId, usageMetadata, responseText, ttftMs) {
    const identity = subagentIdentityContext.getStore();
    logApiResponse(
      this.config,
      new ApiResponseEvent(
        responseId,
        model,
        durationMs,
        prompt_id,
        this.generatorAuthType,
        usageMetadata,
        this.config.getTelemetryLogPromptsEnabled() ? responseText : void 0,
        subagentNameContext.getStore(),
        ttftMs
      ),
      sessionId,
      identity ? {
        id: identity.id,
        type: identity.type,
        taskName: identity.taskName
      } : void 0
    );
  }
  _logApiError(responseId, durationMs, error, model, prompt_id, sessionId) {
    const errorMessage = getErrorMessage(error);
    const errorType = getErrorType(error);
    const errorResponseId = error?.requestID || error?.request_id || responseId;
    const errorStatus = getErrorStatus(error);
    const identity = subagentIdentityContext.getStore();
    logApiError(
      this.config,
      new ApiErrorEvent({
        responseId: errorResponseId,
        model,
        durationMs,
        promptId: prompt_id,
        authType: this.generatorAuthType,
        errorMessage,
        errorType,
        statusCode: errorStatus,
        subagentName: subagentNameContext.getStore()
      }),
      sessionId,
      identity ? {
        id: identity.id,
        type: identity.type,
        taskName: identity.taskName
      } : void 0
    );
  }
  safelyLogApiError(responseId, durationMs, error, model, prompt_id, sessionId, abortSignal) {
    if (abortSignal?.aborted && isAbortError(error)) {
      return;
    }
    try {
      this._logApiError(
        responseId,
        durationMs,
        error,
        model,
        prompt_id,
        sessionId
      );
    } catch (loggingError) {
      debugLogger.warn("Failed to log API error:", loggingError);
    }
  }
  safelyLogApiResponse(responseId, durationMs, model, prompt_id, sessionId, usageMetadata, responseText, ttftMs) {
    try {
      this._logApiResponse(
        responseId,
        durationMs,
        model,
        prompt_id,
        sessionId,
        usageMetadata,
        responseText,
        ttftMs
      );
    } catch (loggingError) {
      debugLogger.warn("Failed to log API response:", loggingError);
    }
  }
  async generateContent(req, userPromptId) {
    const retrySnapshot = snapshotRetryMetadata();
    const isInternal = isInternalPromptId(userPromptId);
    const contextUsage = this.snapshotContextUsage(req, isInternal);
    const ownerSessionId = this.config.getSessionId();
    const ownerUserId = this.config.getTelemetryUserId();
    const { span: llmSpan, context: llmContext } = startLLMRequestSpanWithContext(req.model, userPromptId, {
      operationName: this.genAiOperationName,
      providerName: this.genAiProviderName,
      outputType: resolveGenAiOutputType(this.generatorAuthType, req.config),
      sessionId: ownerSessionId,
      userId: ownerUserId,
      contextUsage
    });
    const requestSessionId = getSessionIdFromContext(llmContext) ?? ownerSessionId;
    const exchange = createGenAiExchange(llmContext, llmSpan, {
      captureContent: !isInternal && this.shouldCollectSensitiveSpanAttributes(),
      sensitiveAttributeMaxLength: this.config.getTelemetrySensitiveSpanAttributeMaxLength()
    });
    const spanContext = exchange.context;
    const startTime = Date.now();
    const session = this.startCaptureSession();
    let responseCompleted = false;
    let abortedBeforeResponseCompletion = req.config?.abortSignal?.aborted ?? false;
    const markResponseAborted = /* @__PURE__ */ __name(() => {
      if (!responseCompleted) abortedBeforeResponseCompletion = true;
    }, "markResponseAborted");
    req.config?.abortSignal?.addEventListener("abort", markResponseAborted, {
      once: true
    });
    try {
      runtimeDiagnostics.recordGenerateContentRequest(req, {
        stream: false,
        source: "generateContent"
      });
      const response = await context.with(spanContext, async () => {
        if (!isInternal) {
          this.logApiRequest(
            this.toContents(req.contents),
            req.model,
            userPromptId,
            requestSessionId
          );
        }
        const result = await session.wrap(
          () => this.wrapped.generateContent(req, userPromptId)
        );
        responseCompleted = true;
        const durationMs = Date.now() - startTime;
        const responseText = isInternal ? void 0 : this.extractResponseText(result, MAX_RESPONSE_TEXT_LENGTH);
        if (!abortedBeforeResponseCompletion) {
          this.safelyLogApiResponse(
            result.responseId ?? "",
            durationMs,
            result.modelVersion || req.model,
            userPromptId,
            requestSessionId,
            result.usageMetadata,
            responseText
          );
          try {
            await this.safelyLogOpenAIInteraction(
              await session.resolve(req),
              result,
              void 0,
              userPromptId
            );
          } catch (loggingError) {
            debugLogger.warn("Failed to log OpenAI interaction:", loggingError);
          }
        }
        return result;
      });
      const cancelled = abortedBeforeResponseCompletion;
      const observedFinishReasons = exchange.controller.finalize(!cancelled);
      endLLMRequestSpan(llmSpan, {
        success: !cancelled,
        cancelled,
        ...usageSpanMetadata(response.usageMetadata),
        durationMs: Date.now() - startTime,
        responseId: response.responseId || void 0,
        responseModel: response.modelVersion || void 0,
        finishReasons: observedFinishReasons ?? orderedFinishReasons(response),
        thoughtsTokenCount: response.usageMetadata?.thoughtsTokenCount,
        subagentName: subagentNameContext.getStore() || void 0,
        error: cancelled ? API_CALL_ABORTED_SPAN_STATUS_MESSAGE : void 0,
        ...retrySnapshot,
        config: this.config
      });
      return response;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const observedFinishReasons = exchange.controller.finalize(false);
      const cancelled = (req.config?.abortSignal?.aborted ?? false) && isAbortError(error);
      endLLMRequestSpan(llmSpan, {
        success: false,
        cancelled,
        durationMs,
        error: cancelled ? API_CALL_ABORTED_SPAN_STATUS_MESSAGE : API_CALL_FAILED_SPAN_STATUS_MESSAGE,
        errorType: cancelled ? void 0 : getErrorType(error),
        errorStatusCode: cancelled ? void 0 : getErrorStatus(error),
        finishReasons: observedFinishReasons,
        subagentName: subagentNameContext.getStore() || void 0,
        ...retrySnapshot,
        config: this.config
      });
      await context.with(spanContext, async () => {
        this.safelyLogApiError(
          "",
          durationMs,
          error,
          req.model,
          userPromptId,
          requestSessionId,
          req.config?.abortSignal
        );
        try {
          await this.safelyLogOpenAIInteraction(
            await session.resolve(req),
            void 0,
            error,
            userPromptId
          );
        } catch (loggingError) {
          debugLogger.warn("Failed to log OpenAI interaction:", loggingError);
        }
      });
      throw error;
    } finally {
      req.config?.abortSignal?.removeEventListener(
        "abort",
        markResponseAborted
      );
    }
  }
  async generateContentStream(req, userPromptId) {
    const retrySnapshot = snapshotRetryMetadata();
    const isInternal = isInternalPromptId(userPromptId);
    const contextUsage = this.snapshotContextUsage(req, isInternal);
    const ownerSessionId = this.config.getSessionId();
    const ownerUserId = this.config.getTelemetryUserId();
    const { span: llmSpan, context: llmContext } = startLLMRequestSpanWithContext(req.model, userPromptId, {
      operationName: this.genAiOperationName,
      providerName: this.genAiProviderName,
      outputType: resolveGenAiOutputType(this.generatorAuthType, req.config),
      sessionId: ownerSessionId,
      userId: ownerUserId,
      contextUsage
    });
    const requestSessionId = getSessionIdFromContext(llmContext) ?? ownerSessionId;
    try {
      llmSpan.setAttribute("gen_ai.request.stream", true);
    } catch {
    }
    const exchange = createGenAiExchange(llmContext, llmSpan, {
      captureContent: !isInternal && this.shouldCollectSensitiveSpanAttributes(),
      sensitiveAttributeMaxLength: this.config.getTelemetrySensitiveSpanAttributeMaxLength()
    });
    const spanContext = exchange.context;
    const startTime = Date.now();
    const session = this.startCaptureSession();
    let streamRequest;
    try {
      runtimeDiagnostics.recordGenerateContentRequest(req, {
        stream: true,
        source: "generateContentStream"
      });
      streamRequest = await context.with(spanContext, async () => {
        if (!isInternal) {
          this.logApiRequest(
            this.toContents(req.contents),
            req.model,
            userPromptId,
            requestSessionId
          );
        }
        return session.wrap(async () => {
          const requestIssuedAtMs2 = performance.now();
          const stream2 = await this.wrapped.generateContentStream(
            req,
            userPromptId
          );
          return { stream: stream2, requestIssuedAtMs: requestIssuedAtMs2 };
        });
      });
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const observedFinishReasons = exchange.controller.finalize(false);
      context.with(
        spanContext,
        () => this.safelyLogApiError(
          "",
          durationMs,
          error,
          req.model,
          userPromptId,
          requestSessionId,
          req.config?.abortSignal
        )
      );
      const cancelled = (req.config?.abortSignal?.aborted ?? false) && isAbortError(error);
      endLLMRequestSpan(llmSpan, {
        success: false,
        cancelled,
        durationMs,
        error: cancelled ? API_CALL_ABORTED_SPAN_STATUS_MESSAGE : API_CALL_FAILED_SPAN_STATUS_MESSAGE,
        errorType: cancelled ? void 0 : getErrorType(error),
        errorStatusCode: cancelled ? void 0 : getErrorStatus(error),
        finishReasons: observedFinishReasons,
        subagentName: subagentNameContext.getStore() || void 0,
        ...retrySnapshot,
        config: this.config
      });
      try {
        await this.safelyLogOpenAIInteraction(
          await session.resolve(req),
          void 0,
          error,
          userPromptId
        );
      } catch (loggingError) {
        debugLogger.warn("Failed to log OpenAI interaction:", loggingError);
      }
      throw error;
    }
    const { stream, requestIssuedAtMs } = streamRequest;
    const openaiRequestPromise = this.openaiLogger ? session.resolve(req).catch((loggingError) => {
      debugLogger.warn("Failed to resolve OpenAI request:", loggingError);
      return void 0;
    }) : void 0;
    return bindAsyncGeneratorToContext(
      this.loggingStreamWrapper(
        stream,
        startTime,
        requestIssuedAtMs,
        userPromptId,
        req.model,
        requestSessionId,
        openaiRequestPromise,
        llmSpan,
        req.config?.abortSignal,
        retrySnapshot,
        exchange.controller
      ),
      spanContext
    );
  }
  startCaptureSession() {
    let captured;
    const skipCapture = !this.openaiLogger;
    return {
      wrap: /* @__PURE__ */ __name((fn) => skipCapture ? fn() : openaiRequestCaptureContext.run((built) => {
        captured = built;
      }, fn), "wrap"),
      resolve: /* @__PURE__ */ __name(async (req) => this.openaiLogger ? captured ?? await this.buildOpenAIRequestForLogging(req) : void 0, "resolve")
    };
  }
  async *loggingStreamWrapper(stream, startTime, requestIssuedAtMs, userPromptId, model, sessionId, openaiRequestPromise, span, abortSignal, retrySnapshot, exchangeController) {
    const isInternal = isInternalPromptId(userPromptId);
    const shouldCollectResponses = !isInternal || !!this.openaiLogger;
    const responses = [];
    let lastResponseForLogging;
    let firstResponseId = "";
    let firstModelVersion = "";
    let lastResponse;
    let lastUsageMetadata;
    const refreshLateUsageMetadata = /* @__PURE__ */ __name(() => {
      if (lastResponse?.usageMetadata) {
        lastUsageMetadata = lastResponse.usageMetadata;
      }
    }, "refreshLateUsageMetadata");
    let errorOccurred = false;
    let streamCompleted = false;
    let abortedBeforeStreamCompletion = abortSignal?.aborted ?? false;
    const markStreamAborted = /* @__PURE__ */ __name(() => {
      if (!streamCompleted) abortedBeforeStreamCompletion = true;
    }, "markStreamAborted");
    abortSignal?.addEventListener("abort", markStreamAborted, { once: true });
    const finishReasons = /* @__PURE__ */ new Map();
    let lastError;
    const subagentName = subagentNameContext.getStore();
    let ttftMs;
    let firstChunkObserved = false;
    let spanEndedByTimeout = false;
    const STREAM_IDLE_TIMEOUT_MS = 5 * 6e4;
    let spanEndTimeout;
    const resetSpanTimeout = span ? () => {
      if (spanEndedByTimeout) return;
      if (spanEndTimeout !== void 0) clearTimeout(spanEndTimeout);
      spanEndTimeout = setTimeout(() => {
        refreshLateUsageMetadata();
        const cancelled = abortedBeforeStreamCompletion && (lastError === void 0 || isAbortError(lastError));
        try {
          span.setAttribute("stream.timed_out", true);
        } catch {
        }
        const observedFinishReasons = exchangeController?.finalize(false);
        endLLMRequestSpan(span, {
          success: false,
          cancelled,
          ...usageSpanMetadata(lastUsageMetadata),
          durationMs: Date.now() - startTime,
          error: cancelled ? API_CALL_ABORTED_SPAN_STATUS_MESSAGE : lastError !== void 0 ? API_CALL_FAILED_SPAN_STATUS_MESSAGE : "Stream span timed out (idle)",
          errorType: lastError !== void 0 && !cancelled ? getErrorType(lastError) : void 0,
          errorStatusCode: lastError !== void 0 && !cancelled ? getErrorStatus(lastError) : void 0,
          responseId: firstResponseId || void 0,
          responseModel: firstModelVersion || void 0,
          finishReasons: observedFinishReasons ?? (finishReasons.size > 0 ? [...finishReasons.entries()].sort(([left], [right]) => left - right).map(([, reason]) => reason) : void 0),
          subagentName: subagentName || void 0,
          ...retrySnapshot,
          config: this.config
        });
        spanEndedByTimeout = true;
        abortSignal?.removeEventListener("abort", markStreamAborted);
      }, STREAM_IDLE_TIMEOUT_MS);
      spanEndTimeout.unref();
    } : void 0;
    resetSpanTimeout?.();
    try {
      for await (const response of stream) {
        if (!firstChunkObserved && !spanEndedByTimeout) {
          firstChunkObserved = true;
          try {
            const timeToFirstChunk = Math.max(0, performance.now() - requestIssuedAtMs) / 1e3;
            if (Number.isFinite(timeToFirstChunk)) {
              span?.setAttribute(
                "gen_ai.response.time_to_first_chunk",
                timeToFirstChunk
              );
            }
          } catch {
          }
        }
        lastResponse = response;
        if (!firstResponseId && response.responseId) {
          firstResponseId = response.responseId;
        }
        if (!firstModelVersion && response.modelVersion) {
          firstModelVersion = response.modelVersion;
        }
        const candidate = response.candidates?.[0];
        if (shouldCollectResponses) {
          lastResponseForLogging = response;
          if ((candidate?.content?.parts?.length ?? 0) > 0 || candidate?.finishReason) {
            responses.push(response);
          }
        }
        if (response.usageMetadata) {
          lastUsageMetadata = response.usageMetadata;
        }
        for (const [position, responseCandidate] of (response.candidates ?? []).entries()) {
          if (responseCandidate.finishReason) {
            finishReasons.set(
              responseCandidate.index ?? position,
              String(responseCandidate.finishReason)
            );
          }
        }
        if (ttftMs === void 0 && hasUserVisibleContent(response)) {
          ttftMs = Date.now() - startTime;
        }
        resetSpanTimeout?.();
        yield response;
      }
      streamCompleted = true;
      refreshLateUsageMetadata();
      if (spanEndTimeout !== void 0) {
        clearTimeout(spanEndTimeout);
        spanEndTimeout = void 0;
      }
      const durationMs = Date.now() - startTime;
      if (lastResponseForLogging && responses.at(-1) !== lastResponseForLogging) {
        responses.push(lastResponseForLogging);
      }
      const consolidatedResponse = shouldCollectResponses ? this.consolidateLlmResponsesForLogging(responses) : void 0;
      if (consolidatedResponse) {
        consolidatedResponse.usageMetadata = lastUsageMetadata;
      }
      const streamResponseText = isInternal ? void 0 : this.extractResponseText(
        consolidatedResponse,
        MAX_RESPONSE_TEXT_LENGTH
      );
      if (!spanEndedByTimeout && !abortedBeforeStreamCompletion) {
        this.safelyLogApiResponse(
          firstResponseId,
          durationMs,
          firstModelVersion || model,
          userPromptId,
          sessionId,
          lastUsageMetadata,
          streamResponseText,
          ttftMs
        );
        const openaiRequest = await openaiRequestPromise;
        await this.safelyLogOpenAIInteraction(
          openaiRequest,
          consolidatedResponse,
          void 0,
          userPromptId
        );
      }
    } catch (error) {
      errorOccurred = true;
      lastError = error;
      if (!spanEndedByTimeout) {
        const durationMs = Date.now() - startTime;
        this.safelyLogApiError(
          firstResponseId,
          durationMs,
          error,
          firstModelVersion || model,
          userPromptId,
          sessionId,
          abortSignal
        );
        const openaiRequest = await openaiRequestPromise;
        await this.safelyLogOpenAIInteraction(
          openaiRequest,
          void 0,
          error,
          userPromptId
        );
      }
      throw error;
    } finally {
      abortSignal?.removeEventListener("abort", markStreamAborted);
      if (spanEndTimeout !== void 0) {
        clearTimeout(spanEndTimeout);
      }
      refreshLateUsageMetadata();
      if (span && !spanEndedByTimeout) {
        const cancelled = abortedBeforeStreamCompletion && (lastError === void 0 || isAbortError(lastError));
        const observedFinishReasons = exchangeController?.finalize(
          !errorOccurred && !cancelled && streamCompleted
        );
        endLLMRequestSpan(span, {
          success: !errorOccurred && !cancelled,
          cancelled,
          ...usageSpanMetadata(lastUsageMetadata),
          ttftMs,
          durationMs: Date.now() - startTime,
          error: cancelled ? API_CALL_ABORTED_SPAN_STATUS_MESSAGE : errorOccurred ? API_CALL_FAILED_SPAN_STATUS_MESSAGE : void 0,
          responseId: firstResponseId || void 0,
          responseModel: firstModelVersion || void 0,
          finishReasons: observedFinishReasons ?? (finishReasons.size > 0 ? [...finishReasons.entries()].sort(([left], [right]) => left - right).map(([, reason]) => reason) : void 0),
          thoughtsTokenCount: lastUsageMetadata?.thoughtsTokenCount,
          subagentName: subagentName || void 0,
          errorType: lastError && !cancelled ? getErrorType(lastError) : void 0,
          errorStatusCode: lastError && !cancelled ? getErrorStatus(lastError) : void 0,
          ...retrySnapshot,
          config: this.config
        });
      }
    }
  }
  async buildOpenAIRequestForLogging(request) {
    if (!this.openaiLogger) {
      return void 0;
    }
    const requestContext = this.createLoggingRequestContext(request.model);
    const messages = OpenAIContentConverter.convertLlmRequestToOpenAI(
      request,
      requestContext,
      {
        cleanOrphanToolCalls: false
      }
    );
    const openaiRequest = {
      model: request.model,
      messages
    };
    if (request.config?.tools) {
      openaiRequest.tools = await OpenAIContentConverter.convertLlmToolsToOpenAI(
        request.config.tools,
        this.schemaCompliance ?? "auto"
      );
    }
    if (request.config?.temperature !== void 0) {
      openaiRequest.temperature = request.config.temperature;
    }
    if (request.config?.topP !== void 0) {
      openaiRequest.top_p = request.config.topP;
    }
    if (request.config?.maxOutputTokens !== void 0) {
      openaiRequest.max_tokens = request.config.maxOutputTokens;
    }
    if (request.config?.presencePenalty !== void 0) {
      openaiRequest.presence_penalty = request.config.presencePenalty;
    }
    if (request.config?.frequencyPenalty !== void 0) {
      openaiRequest.frequency_penalty = request.config.frequencyPenalty;
    }
    return openaiRequest;
  }
  createLoggingRequestContext(model) {
    return {
      model,
      modalities: this.modalities ?? {},
      // Mirror the pipeline default (see pipeline.ts createRequestContext) so the
      // --openai-logging fallback reconstruction reflects the same split as the
      // request actually sent. Opt out via generationConfig.splitToolMedia = false.
      splitToolMedia: this.splitToolMedia ?? true,
      toolResultContentFormat: this.toolResultContentFormat ?? "parts",
      startTime: 0
    };
  }
  async logOpenAIInteraction(openaiRequest, response, error, promptId) {
    if (!this.openaiLogger || !openaiRequest) {
      return;
    }
    const openaiResponse = response ? this.convertLlmResponseToOpenAIForLogging(response, openaiRequest) : void 0;
    await this.openaiLogger.logInteraction(
      openaiRequest,
      openaiResponse,
      error instanceof Error ? error : error ? new Error(String(error)) : void 0,
      promptId
    );
  }
  async safelyLogOpenAIInteraction(openaiRequest, response, error, promptId) {
    try {
      await this.logOpenAIInteraction(openaiRequest, response, error, promptId);
    } catch (loggingError) {
      debugLogger.warn("Failed to log OpenAI interaction:", loggingError);
    }
  }
  convertLlmResponseToOpenAIForLogging(response, openaiRequest) {
    return OpenAIContentConverter.convertLlmResponseToOpenAI(
      response,
      this.createLoggingRequestContext(openaiRequest.model)
    );
  }
  consolidateLlmResponsesForLogging(responses) {
    if (responses.length === 0) {
      return void 0;
    }
    const consolidated = new GenerateContentResponse();
    const combinedParts = [];
    const functionCallIndex = /* @__PURE__ */ new Map();
    let finishReason;
    let usageMetadata;
    for (const response of responses) {
      if (response.usageMetadata) {
        usageMetadata = response.usageMetadata;
      }
      const candidate = response.candidates?.[0];
      if (candidate?.finishReason) {
        finishReason = candidate.finishReason;
      }
      const parts = candidate?.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part === "string") {
          combinedParts.push({ text: part });
          continue;
        }
        if ("text" in part) {
          if (part.text) {
            combinedParts.push({
              text: part.text,
              ...part.thought ? { thought: true } : {},
              ...part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}
            });
          }
          continue;
        }
        if ("functionCall" in part && part.functionCall) {
          const callKey = part.functionCall.id || part.functionCall.name || "tool_call";
          const existingIndex = functionCallIndex.get(callKey);
          const functionPart = { functionCall: part.functionCall };
          if (existingIndex !== void 0) {
            combinedParts[existingIndex] = functionPart;
          } else {
            functionCallIndex.set(callKey, combinedParts.length);
            combinedParts.push(functionPart);
          }
          continue;
        }
        if ("functionResponse" in part && part.functionResponse) {
          combinedParts.push({ functionResponse: part.functionResponse });
          continue;
        }
        combinedParts.push(part);
      }
    }
    const lastResponse = responses[responses.length - 1];
    const lastCandidate = lastResponse.candidates?.[0];
    consolidated.responseId = lastResponse.responseId;
    consolidated.createTime = lastResponse.createTime;
    consolidated.modelVersion = lastResponse.modelVersion;
    consolidated.promptFeedback = lastResponse.promptFeedback;
    consolidated.usageMetadata = usageMetadata;
    consolidated.candidates = [
      {
        content: {
          role: lastCandidate?.content?.role || "model",
          parts: combinedParts
        },
        ...finishReason ? { finishReason } : {},
        index: 0,
        safetyRatings: lastCandidate?.safetyRatings || []
      }
    ];
    return consolidated;
  }
  extractResponseText(response, maxLength) {
    let text = "";
    let truncated = false;
    const maxPrefixLength = Math.max(
      0,
      maxLength - RESPONSE_TEXT_TRUNCATION_SUFFIX.length
    );
    const hasText = this.forEachVisibleResponseText(response, (partText) => {
      if (truncated) {
        return;
      }
      const remaining = maxPrefixLength - text.length;
      if (partText.length <= remaining) {
        text += partText;
        return;
      }
      text += partText.slice(0, Math.max(0, remaining));
      truncated = true;
    });
    if (!hasText) {
      return void 0;
    }
    return truncated ? `${text}${RESPONSE_TEXT_TRUNCATION_SUFFIX}` : text;
  }
  forEachVisibleResponseText(response, onText) {
    const parts = response?.candidates?.[0]?.content?.parts;
    if (!parts?.length) {
      return false;
    }
    let hasText = false;
    for (const part of parts) {
      const text = this.getVisibleResponsePartText(part);
      if (text === void 0) {
        continue;
      }
      hasText = true;
      onText(text);
    }
    return hasText;
  }
  getVisibleResponsePartText(part) {
    if (typeof part === "string") {
      return part;
    }
    if ("text" in part && typeof part.text === "string" && !("thought" in part && part.thought)) {
      return part.text;
    }
    return void 0;
  }
  shouldCollectSensitiveSpanAttributes() {
    return areSensitiveSpanAttributesEnabled(this.config);
  }
  async embedContent(req) {
    return this.wrapped.embedContent(req);
  }
  toContents(contents) {
    if (Array.isArray(contents)) {
      return contents.map((c) => this.toContent(c));
    }
    return [this.toContent(contents)];
  }
  toContent(content) {
    if (Array.isArray(content)) {
      return {
        role: "user",
        parts: this.toParts(content)
      };
    }
    if (typeof content === "string") {
      return {
        role: "user",
        parts: [{ text: content }]
      };
    }
    if ("parts" in content) {
      return {
        ...content,
        parts: content.parts ? this.toParts(content.parts.filter((p) => p != null)) : []
      };
    }
    return {
      role: "user",
      parts: [this.toPart(content)]
    };
  }
  toParts(parts) {
    return parts.map((p) => this.toPart(p));
  }
  toPart(part) {
    if (typeof part === "string") {
      return { text: part };
    }
    if ("thought" in part && part.thought) {
      const thoughtText = `[Thought: ${part.thought}]`;
      const newPart = { ...part };
      delete newPart["thought"];
      const hasApiContent = "functionCall" in newPart || "functionResponse" in newPart || "inlineData" in newPart || "fileData" in newPart;
      if (hasApiContent) {
        return newPart;
      }
      const text = newPart.text;
      const existingText = text ? String(text) : "";
      const combinedText = existingText ? `${existingText}
${thoughtText}` : thoughtText;
      return {
        ...newPart,
        text: combinedText
      };
    }
    return part;
  }
};
export {
  LoggingContentGenerator
};
/**
 * @license
 * Copyright 2026 Qwen Team
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
