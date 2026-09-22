// Force strict mode and setup for ESM
"use strict";
import {
  reportLlmChunk,
  reportLlmRequest,
  reportLlmResponse
} from "./chunk-736AZVPL.js";
import "./chunk-QE36VXWP.js";
import {
  isResponsesReasoningSignature
} from "./chunk-KP2FHIFR.js";
import {
  buildSessionIdHeaders,
  expandDynamicHeaders,
  getEffectiveReasoning,
  hasDynamicPlaceholder,
  resolveReasoningForModel,
  warnIfDynamicHeadersDisabled
} from "./chunk-TLS6QN2S.js";
import {
  InstallationManager
} from "./chunk-EKBQJ627.js";
import "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import "./chunk-CA63HYHU.js";
import "./chunk-SBP43AO6.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  GoogleGenAI
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

// packages/core/src/core/llm-content-generator/index.ts
init_esbuild_shims();

// packages/core/src/core/llm-content-generator/llm-content-generator.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("GEMINI");
function observeLlmStream(stream, telemetryAttempt) {
  const iterator = stream[Symbol.asyncIterator]();
  return {
    async next() {
      const result = await iterator.next();
      if (!result.done) reportLlmChunk(telemetryAttempt, result.value);
      return result;
    },
    async return(value) {
      if (iterator.return) return iterator.return(value);
      return { done: true, value };
    },
    async throw(error) {
      if (iterator.throw) return iterator.throw(error);
      await iterator.return?.();
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    }
  };
}
__name(observeLlmStream, "observeLlmStream");
var LlmContentGenerator = class {
  static {
    __name(this, "LlmContentGenerator");
  }
  googleGenAI;
  clientBaseUrl;
  contentGeneratorConfig;
  cliConfig;
  // Latch so the effort-clamp warning fires once per generator lifetime
  // instead of on every request that needs the downgrade.
  effortClampWarned = false;
  constructor(options, contentGeneratorConfig, cliConfig) {
    const allCustomHeaders = contentGeneratorConfig?.customHeaders;
    if (cliConfig) warnIfDynamicHeadersDisabled(allCustomHeaders, cliConfig);
    const staticEntries = Object.entries(allCustomHeaders ?? {}).filter(
      ([, value]) => typeof value !== "string" || !hasDynamicPlaceholder(value)
    );
    const customHeaders = staticEntries.length > 0 ? Object.fromEntries(staticEntries) : void 0;
    const finalOptions = customHeaders ? (() => {
      const baseHttpOptions = options.httpOptions;
      const baseHeaders = baseHttpOptions?.headers ?? {};
      return {
        ...options,
        httpOptions: {
          ...baseHttpOptions ?? {},
          headers: {
            ...baseHeaders,
            ...customHeaders
          }
        }
      };
    })() : options;
    this.googleGenAI = new GoogleGenAI(finalOptions);
    this.clientBaseUrl = finalOptions.httpOptions?.baseUrl;
    this.contentGeneratorConfig = contentGeneratorConfig;
    this.cliConfig = cliConfig;
  }
  buildHttpOptions(httpOptions) {
    if (!this.cliConfig) return httpOptions;
    const dynamicHeaders = expandDynamicHeaders(
      this.contentGeneratorConfig?.customHeaders,
      this.cliConfig
    );
    const destination = httpOptions?.baseUrl ?? this.clientBaseUrl;
    const sessionHeaders = destination ? buildSessionIdHeaders(this.cliConfig, destination) : {};
    if (Object.keys(sessionHeaders).length === 0 && Object.keys(dynamicHeaders).length === 0) {
      return httpOptions;
    }
    return {
      ...httpOptions,
      headers: {
        ...httpOptions?.headers,
        ...dynamicHeaders,
        ...sessionHeaders
      }
    };
  }
  buildGenerateContentConfig(request) {
    const configSamplingParams = this.contentGeneratorConfig?.samplingParams;
    const requestConfig = request.config || {};
    const httpOptions = this.buildHttpOptions(requestConfig.httpOptions);
    const getParameterValue = /* @__PURE__ */ __name((configValue, requestKey, defaultValue) => {
      const requestValue = requestConfig[requestKey];
      if (configValue !== void 0) return configValue;
      if (requestValue !== void 0) return requestValue;
      return defaultValue;
    }, "getParameterValue");
    return {
      ...requestConfig,
      ...httpOptions ? { httpOptions } : {},
      temperature: getParameterValue(
        configSamplingParams?.temperature,
        "temperature",
        1
      ),
      topP: getParameterValue(
        configSamplingParams?.top_p,
        "topP",
        0.95
      ),
      topK: getParameterValue(configSamplingParams?.top_k, "topK", 64),
      maxOutputTokens: configSamplingParams?.max_tokens !== void 0 && requestConfig.maxOutputTokens !== void 0 ? Math.min(
        configSamplingParams.max_tokens,
        requestConfig.maxOutputTokens
      ) : configSamplingParams?.max_tokens ?? requestConfig.maxOutputTokens,
      presencePenalty: getParameterValue(
        configSamplingParams?.presence_penalty,
        "presencePenalty"
      ),
      frequencyPenalty: getParameterValue(
        configSamplingParams?.frequency_penalty,
        "frequencyPenalty"
      ),
      thinkingConfig: getParameterValue(
        this.buildThinkingConfig(request.model, requestConfig.thinkingConfig),
        "thinkingConfig",
        {
          includeThoughts: true,
          thinkingLevel: "THINKING_LEVEL_UNSPECIFIED"
        }
      )
    };
  }
  buildThinkingConfig(model, requestThinking) {
    const generation = this.contentGeneratorConfig;
    const resolved = generation && this.cliConfig ? resolveReasoningForModel(this.cliConfig, generation, model) : void 0;
    if (resolved && requestThinking?.includeThoughts === false)
      return requestThinking;
    const reasoning = generation ? getEffectiveReasoning(generation, resolved) : void 0;
    if (reasoning === false) {
      return { includeThoughts: false };
    }
    if (reasoning) {
      let thinkingLevel;
      switch (reasoning.effort) {
        case "low":
          thinkingLevel = "LOW";
          break;
        case "medium":
          thinkingLevel = "MEDIUM";
          break;
        case "high":
          thinkingLevel = "HIGH";
          break;
        case "xhigh":
        case "max":
          if (!this.effortClampWarned) {
            debugLogger.warn(
              `reasoning.effort='${reasoning.effort}' is not supported by Gemini; clamping to 'HIGH'.`
            );
            this.effortClampWarned = true;
          }
          thinkingLevel = "HIGH";
          break;
        case void 0:
          thinkingLevel = "THINKING_LEVEL_UNSPECIFIED";
          break;
        default: {
          const _exhaustive = reasoning.effort;
          void _exhaustive;
          thinkingLevel = "THINKING_LEVEL_UNSPECIFIED";
          break;
        }
      }
      return {
        includeThoughts: true,
        thinkingLevel
      };
    }
    return void 0;
  }
  async generateContent(request, _userPromptId) {
    const finalRequest = {
      ...request,
      contents: this.stripUnsupportedFields(request.contents),
      config: this.buildGenerateContentConfig(request)
    };
    const telemetryAttempt = reportLlmRequest(finalRequest);
    const response = await this.googleGenAI.models.generateContent(finalRequest);
    reportLlmResponse(telemetryAttempt, response);
    return response;
  }
  async generateContentStream(request, _userPromptId) {
    const finalRequest = {
      ...request,
      contents: this.stripUnsupportedFields(request.contents),
      config: this.buildGenerateContentConfig(request)
    };
    const telemetryAttempt = reportLlmRequest(finalRequest);
    const stream = await this.googleGenAI.models.generateContentStream(finalRequest);
    return observeLlmStream(stream, telemetryAttempt);
  }
  /**
   * Strip fields not supported by Gemini API (e.g., displayName in inlineData/fileData)
   */
  stripUnsupportedFields(contents) {
    if (!contents) return contents;
    if (typeof contents === "string") return contents;
    if (Array.isArray(contents)) {
      return contents.map(
        (content) => this.stripContentFields(content)
      );
    }
    return this.stripContentFields(
      contents
    );
  }
  stripContentFields(content) {
    if (typeof content === "string") {
      return content;
    }
    if (!("role" in content) && !("parts" in content)) {
      return this.stripPartFields(content);
    }
    const contentObj = content;
    if (!contentObj.parts) return contentObj;
    return {
      ...contentObj,
      parts: contentObj.parts.map((part) => this.stripPartFields(part))
    };
  }
  stripPartFields(part) {
    if (typeof part === "string") {
      return part;
    }
    const result = { ...part };
    delete result.partMetadata;
    if (result.inlineData) {
      const { displayName: _, ...inlineDataWithoutDisplayName } = result.inlineData;
      result.inlineData = inlineDataWithoutDisplayName;
    }
    if (result.fileData) {
      const { displayName: _, ...fileDataWithoutDisplayName } = result.fileData;
      result.fileData = fileDataWithoutDisplayName;
    }
    if (isResponsesReasoningSignature(result.thoughtSignature)) {
      delete result.thoughtSignature;
    }
    if (result.functionResponse?.parts) {
      const processedParts = result.functionResponse.parts.map((p) => {
        const converted = this.convertUnsupportedMediaToText(p);
        return this.stripPartFields(converted);
      });
      result.functionResponse = {
        ...result.functionResponse,
        parts: processedParts
      };
    }
    return result;
  }
  /**
   * Convert unsupported media types (audio, video) to explanatory text for Gemini API
   */
  convertUnsupportedMediaToText(part) {
    if (typeof part === "string") return part;
    const inlineMimeType = part.inlineData?.mimeType || "";
    const fileMimeType = part.fileData?.mimeType || "";
    if (inlineMimeType.startsWith("audio/") || inlineMimeType.startsWith("video/")) {
      const displayName = part.inlineData?.displayName;
      const displayNameText = displayName ? ` (${displayName})` : "";
      return {
        text: `Unsupported media type for Gemini: ${inlineMimeType}${displayNameText}.`
      };
    }
    if (fileMimeType.startsWith("audio/") || fileMimeType.startsWith("video/")) {
      const displayName = part.fileData?.displayName;
      const displayNameText = displayName ? ` (${displayName})` : "";
      return {
        text: `Unsupported media type for Gemini: ${fileMimeType}${displayNameText}.`
      };
    }
    return part;
  }
  async embedContent(request) {
    const httpOptions = this.buildHttpOptions(request.config?.httpOptions);
    return this.googleGenAI.models.embedContent({
      ...request,
      ...httpOptions ? { config: { ...request.config, httpOptions } } : {}
    });
  }
};

// packages/core/src/core/llm-content-generator/index.ts
function createLlmContentGenerator(config, gcConfig) {
  const version = "0.24.0";
  const userAgent = config.userAgent || `QwenCode/${version} (${process.platform}; ${process.arch})`;
  const baseHeaders = {
    "User-Agent": userAgent
  };
  let headers = { ...baseHeaders };
  if (gcConfig?.getUsageStatisticsEnabled()) {
    const installationManager = new InstallationManager();
    const installationId = installationManager.getInstallationId();
    headers = {
      ...headers,
      "x-gemini-api-privileged-user-id": `${installationId}`
    };
  }
  const httpOptions = config.baseUrl ? {
    headers,
    baseUrl: config.baseUrl
  } : { headers };
  const llmContentGenerator = new LlmContentGenerator(
    {
      apiKey: config.apiKey === "" ? void 0 : config.apiKey,
      // Derive Vertex mode from the auth type rather than leaving it to the
      // GOOGLE_GENAI_USE_VERTEXAI side effect: only the CLI pre-flight check
      // writes that variable, and the session boot paths that skip it would
      // otherwise build a client pointed at the Gemini API endpoint. Left
      // undefined for the other auth types so the SDK keeps its own env
      // fallback for them.
      vertexai: config.vertexai ?? (config.authType === "vertex-ai" /* USE_VERTEX_AI */ ? true : void 0),
      httpOptions
    },
    config,
    gcConfig
  );
  return llmContentGenerator;
}
__name(createLlmContentGenerator, "createLlmContentGenerator");
export {
  LlmContentGenerator,
  createLlmContentGenerator
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
