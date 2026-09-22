// Force strict mode and setup for ESM
"use strict";
import {
  GenAiOutputAccumulator,
  extractAnthropicContent,
  extractLlmContent,
  extractOpenAiContent,
  stringifyGenAiJson
} from "./chunk-QE36VXWP.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  ROOT_CONTEXT,
  context,
  createContextKey,
  init_esm
} from "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/telemetry/gen-ai-request.ts
init_esbuild_shims();
init_esm();
var debugLogger = createDebugLogger("GEN_AI_EXCHANGE");
var requestObserverKey = createContextKey(
  "qwen-code.gen-ai-request-observer"
);
var DISABLED_OBSERVER = Symbol("disabled-gen-ai-exchange");
function ownValue(record, key) {
  return Object.hasOwn(record, key) ? record[key] : void 0;
}
__name(ownValue, "ownValue");
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
__name(finiteNumber, "finiteNumber");
function safeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : void 0;
}
__name(safeInteger, "safeInteger");
function stopSequences(value, allowSingleString) {
  if (allowSingleString && typeof value === "string") return [value];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    return void 0;
  return [...value];
}
__name(stopSequences, "stopSequences");
function outputBudget(record) {
  const values = ["max_tokens", "max_completion_tokens", "max_new_tokens"].map((key) => ownValue(record, key)).filter((value) => value !== void 0 && value !== null);
  if (values.length === 0) return void 0;
  const integers = values.map(safeInteger);
  if (integers.some((value) => value === void 0)) return void 0;
  const first = integers[0];
  return integers.every((value) => value === first) ? first : void 0;
}
__name(outputBudget, "outputBudget");
function assignNumber(attributes, key, value) {
  const number = finiteNumber(value);
  if (number !== void 0) attributes[key] = number;
}
__name(assignNumber, "assignNumber");
function assignInteger(attributes, key, value) {
  const integer = safeInteger(value);
  if (integer !== void 0) attributes[key] = integer;
}
__name(assignInteger, "assignInteger");
function assignStopSequences(attributes, value, allowSingleString) {
  const sequences = stopSequences(value, allowSingleString);
  if (sequences !== void 0)
    attributes["gen_ai.request.stop_sequences"] = sequences;
}
__name(assignStopSequences, "assignStopSequences");
function extractOpenAiRequestAttributes(request) {
  const record = request;
  const attributes = {};
  const choiceCount = safeInteger(ownValue(record, "n"));
  if (choiceCount !== void 0 && choiceCount !== 1) {
    attributes["gen_ai.request.choice.count"] = choiceCount;
  }
  const maxTokens = outputBudget(record);
  if (maxTokens !== void 0) {
    attributes["gen_ai.request.max_tokens"] = maxTokens;
  }
  assignNumber(
    attributes,
    "gen_ai.request.temperature",
    ownValue(record, "temperature")
  );
  assignNumber(attributes, "gen_ai.request.top_p", ownValue(record, "top_p"));
  assignNumber(
    attributes,
    "gen_ai.request.frequency_penalty",
    ownValue(record, "frequency_penalty")
  );
  assignNumber(
    attributes,
    "gen_ai.request.presence_penalty",
    ownValue(record, "presence_penalty")
  );
  assignStopSequences(attributes, ownValue(record, "stop"), true);
  return attributes;
}
__name(extractOpenAiRequestAttributes, "extractOpenAiRequestAttributes");
function extractAnthropicRequestAttributes(request) {
  const record = request;
  const attributes = {};
  assignInteger(
    attributes,
    "gen_ai.request.max_tokens",
    ownValue(record, "max_tokens")
  );
  assignNumber(
    attributes,
    "gen_ai.request.temperature",
    ownValue(record, "temperature")
  );
  assignNumber(attributes, "gen_ai.request.top_p", ownValue(record, "top_p"));
  assignStopSequences(attributes, ownValue(record, "stop_sequences"), false);
  return attributes;
}
__name(extractAnthropicRequestAttributes, "extractAnthropicRequestAttributes");
function extractLlmRequestAttributes(request) {
  const record = request;
  const config = ownValue(record, "config");
  if (typeof config !== "object" || config === null) return {};
  const configRecord = config;
  const attributes = {};
  const choiceCount = safeInteger(ownValue(configRecord, "candidateCount"));
  if (choiceCount !== void 0 && choiceCount !== 1) {
    attributes["gen_ai.request.choice.count"] = choiceCount;
  }
  assignInteger(
    attributes,
    "gen_ai.request.max_tokens",
    ownValue(configRecord, "maxOutputTokens")
  );
  assignNumber(
    attributes,
    "gen_ai.request.temperature",
    ownValue(configRecord, "temperature")
  );
  assignNumber(
    attributes,
    "gen_ai.request.top_p",
    ownValue(configRecord, "topP")
  );
  assignNumber(
    attributes,
    "gen_ai.request.frequency_penalty",
    ownValue(configRecord, "frequencyPenalty")
  );
  assignNumber(
    attributes,
    "gen_ai.request.presence_penalty",
    ownValue(configRecord, "presencePenalty")
  );
  assignStopSequences(
    attributes,
    ownValue(configRecord, "stopSequences"),
    false
  );
  return attributes;
}
__name(extractLlmRequestAttributes, "extractLlmRequestAttributes");
var GenAiExchangeController = class {
  constructor(span, options, enabled) {
    this.span = span;
    this.options = options;
    this.enabled = enabled;
    this.output = this.newOutput();
  }
  static {
    __name(this, "GenAiExchangeController");
  }
  requestConsumed = false;
  generation = 0;
  finalized = false;
  output;
  responseConversionFailed = false;
  beginRequest(request, extractRequest, extractContent) {
    if (!this.enabled || this.finalized) return void 0;
    const generation = ++this.generation;
    this.output = this.newOutput();
    this.responseConversionFailed = false;
    if (!this.requestConsumed) {
      this.requestConsumed = true;
      const attributes = {};
      try {
        Object.assign(attributes, extractRequest(request));
        if (this.options.captureContent) {
          const content = extractContent(request);
          this.assignJsonAttribute(
            attributes,
            "gen_ai.input.messages",
            content.inputMessages
          );
          this.assignJsonAttribute(
            attributes,
            "gen_ai.system_instructions",
            content.systemInstructions
          );
          this.assignJsonAttribute(
            attributes,
            "gen_ai.tool.definitions",
            content.toolDefinitions
          );
        }
      } catch {
        debugLogger.debug("Failed to convert GenAI request attributes");
      }
      try {
        this.span.setAttributes(attributes);
      } catch {
        debugLogger.debug("Failed to set GenAI request span attributes");
      }
    }
    return { controller: this, generation };
  }
  beginFollowingRequest(handle, request, extractRequest, extractContent) {
    if (handle.controller !== this || handle.generation !== this.generation || this.finalized) {
      return void 0;
    }
    return this.beginRequest(request, extractRequest, extractContent);
  }
  record(handle, update) {
    if (!handle || handle.controller !== this || handle.generation !== this.generation || this.finalized) {
      return;
    }
    try {
      update(this.output);
    } catch {
      this.output.discardContent();
      this.responseConversionFailed = true;
      debugLogger.debug("Failed to convert GenAI response content");
    }
  }
  finalize(success) {
    if (this.finalized) return void 0;
    this.finalized = true;
    let finishReasons;
    try {
      const outputMessages = this.output.finalize(success);
      finishReasons = this.responseConversionFailed ? void 0 : this.output.finishReasons;
      if (outputMessages !== void 0) {
        this.span.setAttribute("gen_ai.output.messages", outputMessages);
      }
    } catch {
      debugLogger.debug("Failed to finalize GenAI response attributes");
    } finally {
      this.output = this.newOutput();
    }
    return finishReasons;
  }
  assignJsonAttribute(attributes, key, value) {
    if (value === void 0) return;
    let serialized;
    try {
      serialized = stringifyGenAiJson(
        value,
        this.options.sensitiveAttributeMaxLength
      );
    } catch {
      debugLogger.debug(`Failed to serialize ${key} span attribute`);
      return;
    }
    if (serialized !== void 0) attributes[key] = serialized;
  }
  newOutput() {
    return new GenAiOutputAccumulator(
      this.options.captureContent,
      this.options.sensitiveAttributeMaxLength
    );
  }
};
function disabledFallbackContext(parent) {
  const fallback = Object.create(parent);
  fallback.getValue = (key) => {
    if (key === requestObserverKey) return DISABLED_OBSERVER;
    try {
      return parent.getValue(key);
    } catch {
      return void 0;
    }
  };
  fallback.setValue = (key, value) => {
    if (key === requestObserverKey) return fallback;
    try {
      return disabledFallbackContext(parent.setValue(key, value));
    } catch {
      return fallback;
    }
  };
  fallback.deleteValue = (key) => {
    if (key === requestObserverKey) return fallback;
    try {
      return disabledFallbackContext(parent.deleteValue(key));
    } catch {
      return fallback;
    }
  };
  return fallback;
}
__name(disabledFallbackContext, "disabledFallbackContext");
function createGenAiExchange(parent, span, options) {
  let enabled = false;
  try {
    enabled = span.isRecording();
  } catch {
    enabled = false;
  }
  const controller = new GenAiExchangeController(span, options, enabled);
  try {
    return {
      context: parent.setValue(
        requestObserverKey,
        enabled ? controller : DISABLED_OBSERVER
      ),
      controller
    };
  } catch {
    return {
      context: parent === ROOT_CONTEXT ? ROOT_CONTEXT : disabledFallbackContext(parent),
      controller
    };
  }
}
__name(createGenAiExchange, "createGenAiExchange");
function activeController(requestContext) {
  let observer;
  try {
    observer = (requestContext ?? context.active()).getValue(
      requestObserverKey
    );
  } catch {
    return void 0;
  }
  return observer instanceof GenAiExchangeController ? observer : void 0;
}
__name(activeController, "activeController");
function reportRequest(request, extractRequest, extractContent, requestContext, previousAttempt) {
  try {
    if (previousAttempt) {
      return previousAttempt.controller.beginFollowingRequest(
        previousAttempt,
        request,
        extractRequest,
        extractContent
      );
    }
    return activeController(requestContext)?.beginRequest(
      request,
      extractRequest,
      extractContent
    );
  } catch {
    return void 0;
  }
}
__name(reportRequest, "reportRequest");
function reportOpenAiRequest(request, requestContext) {
  return reportRequest(
    request,
    extractOpenAiRequestAttributes,
    extractOpenAiContent,
    requestContext
  );
}
__name(reportOpenAiRequest, "reportOpenAiRequest");
function reportAnthropicRequest(request, requestContext) {
  return reportRequest(
    request,
    extractAnthropicRequestAttributes,
    extractAnthropicContent,
    requestContext
  );
}
__name(reportAnthropicRequest, "reportAnthropicRequest");
function reportAnthropicFollowingRequest(request, previousAttempt) {
  if (!previousAttempt) return void 0;
  return reportRequest(
    request,
    extractAnthropicRequestAttributes,
    extractAnthropicContent,
    void 0,
    previousAttempt
  );
}
__name(reportAnthropicFollowingRequest, "reportAnthropicFollowingRequest");
function reportLlmRequest(request, requestContext) {
  return reportRequest(
    request,
    extractLlmRequestAttributes,
    extractLlmContent,
    requestContext
  );
}
__name(reportLlmRequest, "reportLlmRequest");
function reportOpenAiResponse(handle, response) {
  handle?.controller.record(
    handle,
    (output) => output.recordOpenAiResponse(response)
  );
}
__name(reportOpenAiResponse, "reportOpenAiResponse");
function reportOpenAiChunk(handle, chunk) {
  handle?.controller.record(
    handle,
    (output) => output.recordOpenAiChunk(chunk)
  );
}
__name(reportOpenAiChunk, "reportOpenAiChunk");
function reportAnthropicResponse(handle, response) {
  handle?.controller.record(
    handle,
    (output) => output.recordAnthropicResponse(response)
  );
}
__name(reportAnthropicResponse, "reportAnthropicResponse");
function reportAnthropicEvent(handle, event) {
  handle?.controller.record(
    handle,
    (output) => output.recordAnthropicEvent(event)
  );
}
__name(reportAnthropicEvent, "reportAnthropicEvent");
function reportLlmResponse(handle, response) {
  handle?.controller.record(
    handle,
    (output) => output.recordLlmResponse(response)
  );
}
__name(reportLlmResponse, "reportLlmResponse");
function reportLlmChunk(handle, chunk) {
  handle?.controller.record(handle, (output) => output.recordLlmChunk(chunk));
}
__name(reportLlmChunk, "reportLlmChunk");

export {
  createGenAiExchange,
  reportOpenAiRequest,
  reportAnthropicRequest,
  reportAnthropicFollowingRequest,
  reportLlmRequest,
  reportOpenAiResponse,
  reportOpenAiChunk,
  reportAnthropicResponse,
  reportAnthropicEvent,
  reportLlmResponse,
  reportLlmChunk
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
