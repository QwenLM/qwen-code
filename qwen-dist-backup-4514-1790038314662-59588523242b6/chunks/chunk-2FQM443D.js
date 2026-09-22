// Force strict mode and setup for ESM
"use strict";
import {
  convertSchema,
  relaxSchemaForFunctionCalling
} from "./chunk-CF5KXZZX.js";
import {
  isDisclosureText
} from "./chunk-BKVPLSEI.js";
import {
  InvalidStreamError,
  setToolCallPreparations
} from "./chunk-S7UQ3V2H.js";
import {
  safeJsonParse,
  setGenAiUsageProvenance
} from "./chunk-BA6AXQDA.js";
import {
  createOpenAIReasoningThoughtPart
} from "./chunk-KP2FHIFR.js";
import {
  TOKEN_ESTIMATE_UNITS_PER_TOKEN,
  estimateTextTokenUnits,
  estimateTextTokens
} from "./chunk-25FMWESU.js";
import {
  normalizeMcpToolName
} from "./chunk-WZAD4ZNJ.js";
import {
  SchemaValidator
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  FinishReason,
  GenerateContentResponse
} from "./chunk-EFT7OMDN.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/core/openaiContentGenerator/converter.ts
init_esbuild_shims();

// packages/core/src/core/openaiContentGenerator/taggedThinkingParser.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("TAGGED_THINKING_PARSER");
var OPEN_TAGS = ["<think>", "<thinking>"];
var CLOSE_TAGS = ["</think>", "</thinking>"];
var MAX_TAG_LENGTH = Math.max(
  ...OPEN_TAGS.map((t) => t.length),
  ...CLOSE_TAGS.map((t) => t.length)
);
function appendPart(parts, text, mode) {
  if (!text) return;
  parts.push(mode === "thought" ? { text, thought: true } : { text });
}
__name(appendPart, "appendPart");
function isPrefixOfAnyTag(lower, offset, tags) {
  const remainingLen = lower.length - offset;
  if (remainingLen <= 0) return false;
  if (remainingLen > MAX_TAG_LENGTH) return false;
  return tags.some(
    (tag) => tag.startsWith(lower.slice(offset, offset + remainingLen))
  );
}
__name(isPrefixOfAnyTag, "isPrefixOfAnyTag");
function findMatchingTag(lower, offset, tags) {
  return tags.find((tag) => lower.startsWith(tag, offset));
}
__name(findMatchingTag, "findMatchingTag");
var TaggedThinkingParser = class {
  static {
    __name(this, "TaggedThinkingParser");
  }
  mode = "text";
  buffer = "";
  hasUnclosedThought() {
    return this.mode === "thought";
  }
  parse(chunk, final = false) {
    this.buffer += chunk;
    const lower = this.buffer.toLowerCase();
    const parts = [];
    let segment = "";
    let index = 0;
    while (index < this.buffer.length) {
      const activeTags = this.mode === "text" ? OPEN_TAGS : CLOSE_TAGS;
      const matchedTag = findMatchingTag(lower, index, activeTags);
      if (matchedTag) {
        debugLogger.debug(
          `taggedThinking: detected tag "${matchedTag}" at offset ${index}`
        );
        appendPart(parts, segment, this.mode);
        segment = "";
        this.mode = this.mode === "text" ? "thought" : "text";
        index += matchedTag.length;
        continue;
      }
      if (!final && isPrefixOfAnyTag(lower, index, activeTags)) {
        break;
      }
      segment += this.buffer[index];
      index += 1;
    }
    if (index < this.buffer.length) {
      appendPart(parts, segment, this.mode);
      this.buffer = this.buffer.slice(index);
      debugLogger.debug(
        `taggedThinking: emitted ${parts.length} part(s), buffered ${this.buffer.length} char(s)`
      );
      return parts;
    }
    this.buffer = "";
    if (this.mode === "thought" && segment) {
      debugLogger.warn(
        `taggedThinking: flushing ${segment.length} chars of unclosed thought on stream end`
      );
    }
    appendPart(parts, segment, this.mode);
    debugLogger.debug(
      `taggedThinking: emitted ${parts.length} part(s), flush complete`
    );
    return parts;
  }
};
function parseTaggedThinkingText(text) {
  return new TaggedThinkingParser().parse(text, true);
}
__name(parseTaggedThinkingText, "parseTaggedThinkingText");

// packages/core/src/core/openaiContentGenerator/image-budget.ts
init_esbuild_shims();
var DEFAULT_MAX_REQUEST_IMAGES = 250;
var EVICTED_IMAGE_PLACEHOLDER = "[\u5DF2\u6DD8\u6C70\u8F83\u65E9\u7684\u5173\u952E\u5E27\u4EE5\u63A7\u5236\u5355\u6B21\u8BF7\u6C42\u7684\u56FE\u7247\u6570\u91CF\uFF1B\u5982\u9700\u91CD\u770B\u8BE5\u753B\u9762\u8BF7\u91CD\u65B0\u62BD\u5E27\u6216\u5207\u7247]";
function isImagePart(part) {
  return typeof part === "object" && part !== null && part.type === "image_url";
}
__name(isImagePart, "isImagePart");
function evictOldestImagesBeyondCap(messages, cap = DEFAULT_MAX_REQUEST_IMAGES) {
  if (cap < 0) return 0;
  let total = 0;
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isImagePart(part)) total++;
      }
    }
  }
  if (total <= cap) return 0;
  let toEvict = total - cap;
  let evicted = 0;
  for (const message of messages) {
    if (toEvict === 0) break;
    if (!Array.isArray(message.content)) continue;
    const content = message.content;
    for (let i = 0; i < content.length && toEvict > 0; i++) {
      if (isImagePart(content[i])) {
        content[i] = { type: "text", text: EVICTED_IMAGE_PLACEHOLDER };
        toEvict--;
        evicted++;
      }
    }
  }
  return evicted;
}
__name(evictOldestImagesBeyondCap, "evictOldestImagesBeyondCap");

// packages/core/src/core/openaiContentGenerator/converter.ts
var debugLogger2 = createDebugLogger("CONVERTER");
var SPLIT_TOOL_MEDIA_TEXT = "(attached media from previous tool call)";
var CUMULATIVE_DELTA_EXACT_REPEAT_MIN_LENGTH = 64;
var CUMULATIVE_DETECTION_WINDOW_BYTES = 1024;
function normalizeStreamingTextDelta(rawDelta, state) {
  if (rawDelta.length === 0) {
    return "";
  }
  if (state.emittedText.length === 0) {
    state.emittedText = rawDelta;
    state.emittedLength = rawDelta.length;
    return rawDelta;
  }
  if (state.cumulativeMode) {
    if (rawDelta.startsWith(state.emittedText)) {
      const suffix = rawDelta.slice(state.emittedText.length);
      state.emittedText = rawDelta;
      state.emittedLength = rawDelta.length;
      return suffix;
    }
    if (state.emittedText.startsWith(rawDelta)) {
      debugLogger2.debug(
        `normalizeStreamingTextDelta: cumulative rewind suppression (emitted=${state.emittedText.length}b, chunk=${rawDelta.length}b)`
      );
      return "";
    }
    debugLogger2.debug(
      "normalizeStreamingTextDelta: exiting cumulative mode (chunk does not match prior accumulated text)"
    );
    state.cumulativeMode = false;
    state.emittedText = rawDelta;
    state.emittedLength += rawDelta.length;
    return rawDelta;
  }
  if (rawDelta.length > state.emittedText.length && rawDelta.startsWith(state.emittedText)) {
    const baselineLen = state.emittedText.length;
    const baselineFrozenAtCap = baselineLen >= CUMULATIVE_DETECTION_WINDOW_BYTES && state.emittedLength > baselineLen;
    const sliceFrom = baselineFrozenAtCap ? state.emittedLength : baselineLen;
    if (rawDelta.length > sliceFrom) {
      const suffix = rawDelta.slice(sliceFrom);
      state.emittedText = rawDelta;
      state.emittedLength = rawDelta.length;
      state.cumulativeMode = true;
      debugLogger2.debug(
        `normalizeStreamingTextDelta: entered cumulative mode (prefix overlap, baseline=${baselineLen}b sliceFrom=${sliceFrom}b -> curr=${rawDelta.length}b)`
      );
      return suffix;
    }
  }
  if (rawDelta === state.emittedText) {
    if (rawDelta.length >= CUMULATIVE_DELTA_EXACT_REPEAT_MIN_LENGTH) {
      state.cumulativeMode = true;
      debugLogger2.debug(
        `normalizeStreamingTextDelta: entered cumulative mode (exact repeat, ${rawDelta.length}b)`
      );
      return "";
    }
    state.emittedLength += rawDelta.length;
    return rawDelta;
  }
  if (state.emittedText.length < CUMULATIVE_DETECTION_WINDOW_BYTES) {
    state.emittedText += rawDelta;
  }
  state.emittedLength += rawDelta.length;
  return rawDelta;
}
__name(normalizeStreamingTextDelta, "normalizeStreamingTextDelta");
function convertLlmToolParametersToOpenAI(parameters) {
  if (!parameters || typeof parameters !== "object") {
    return parameters;
  }
  const converted = JSON.parse(JSON.stringify(parameters));
  const convertTypes = /* @__PURE__ */ __name((obj) => {
    if (typeof obj !== "object" || obj === null) {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(convertTypes);
    }
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "object" && value !== null) {
        result[key] = convertTypes(value);
      } else if (key === "type" && typeof value === "string") {
        const lowerValue = value.toLowerCase();
        if (lowerValue === "integer") {
          result[key] = "integer";
        } else if (lowerValue === "number") {
          result[key] = "number";
        } else {
          result[key] = lowerValue;
        }
      } else if (key === "minimum" || key === "maximum" || key === "multipleOf") {
        if (typeof value === "string" && !isNaN(Number(value))) {
          result[key] = Number(value);
        } else {
          result[key] = value;
        }
      } else if (key === "minLength" || key === "maxLength" || key === "minItems" || key === "maxItems") {
        const numberValue = typeof value === "string" ? Number(value) : NaN;
        if (typeof value === "string" && value.trim() !== "" && Number.isInteger(numberValue)) {
          result[key] = numberValue;
        } else {
          result[key] = value;
        }
      } else {
        result[key] = value;
      }
    }
    return result;
  }, "convertTypes");
  return convertTypes(converted);
}
__name(convertLlmToolParametersToOpenAI, "convertLlmToolParametersToOpenAI");
var grammarSchemaValidationCache = /* @__PURE__ */ new WeakMap();
var PARAMETERLESS_SCHEMA_KEYS = /* @__PURE__ */ new Set([
  "$comment",
  "$schema",
  "additionalProperties",
  "deprecated",
  "description",
  "examples",
  "properties",
  "readOnly",
  "title",
  "type",
  "writeOnly"
]);
function isStrictlyValidSchema(schema) {
  const cached = grammarSchemaValidationCache.get(schema);
  if (cached !== void 0) {
    return cached;
  }
  const valid = SchemaValidator.compileStrict(schema) === null;
  grammarSchemaValidationCache.set(schema, valid);
  return valid;
}
__name(isStrictlyValidSchema, "isStrictlyValidSchema");
async function convertLlmToolsToOpenAI(llmTools, schemaCompliance = "auto") {
  const openAITools = [];
  for (const tool of llmTools) {
    let actualTool;
    if ("tool" in tool) {
      actualTool = await tool.tool();
    } else {
      actualTool = tool;
    }
    if (actualTool.functionDeclarations) {
      for (const func of actualTool.functionDeclarations) {
        if (func.name) {
          let parameters;
          if (func.parametersJsonSchema) {
            const paramsCopy = {
              ...func.parametersJsonSchema
            };
            parameters = paramsCopy;
          } else if (func.parameters) {
            parameters = convertLlmToolParametersToOpenAI(
              func.parameters
            );
          }
          if (parameters) {
            const sourceSchema = typeof func.parametersJsonSchema === "object" && func.parametersJsonSchema !== null && !Array.isArray(func.parametersJsonSchema) ? func.parametersJsonSchema : void 0;
            const canValidateLocally = sourceSchema !== void 0 && !("$id" in sourceSchema) && isStrictlyValidSchema(sourceSchema);
            const sourceProperties = sourceSchema?.["properties"];
            const sourceAdditionalProperties = sourceSchema?.["additionalProperties"];
            const hasEmptyProperties = typeof sourceProperties === "object" && sourceProperties !== null && !Array.isArray(sourceProperties) && Object.keys(sourceProperties).length === 0;
            const declaresEmptyArgumentList = sourceSchema !== void 0 && (hasEmptyProperties && (sourceAdditionalProperties === false || sourceAdditionalProperties === void 0) || sourceProperties === void 0 && sourceAdditionalProperties === false) && Object.keys(sourceSchema).every(
              (key) => PARAMETERLESS_SCHEMA_KEYS.has(key)
            );
            parameters = convertSchema(parameters, schemaCompliance);
            parameters = relaxSchemaForFunctionCalling(
              parameters,
              canValidateLocally
            );
            if (canValidateLocally && declaresEmptyArgumentList && parameters["type"] === "object" && Object.keys(parameters).every(
              (key) => PARAMETERLESS_SCHEMA_KEYS.has(key)
            )) {
              parameters = void 0;
            }
          }
          openAITools.push({
            type: "function",
            function: {
              name: func.name,
              description: func.description ?? "",
              parameters
            }
          });
        }
      }
    }
  }
  return openAITools;
}
__name(convertLlmToolsToOpenAI, "convertLlmToolsToOpenAI");
function convertLlmRequestToOpenAI(request, requestContext, options = { cleanOrphanToolCalls: true }) {
  let messages = [];
  addSystemInstructionMessage(request, messages);
  processContents(request.contents, messages, requestContext);
  messages = mergeConsecutiveAssistantMessages(messages);
  if (options.cleanOrphanToolCalls) {
    messages = cleanOrphanedToolCalls(messages);
    messages = mergeConsecutiveAssistantMessages(messages);
  }
  evictOldestImagesBeyondCap(messages);
  return messages;
}
__name(convertLlmRequestToOpenAI, "convertLlmRequestToOpenAI");
function convertLlmResponseToOpenAI(response, requestContext) {
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const thoughtParts = [];
  const contentParts = [];
  const toolCalls = [];
  let toolCallIndex = 0;
  for (const part of parts) {
    if (typeof part === "string") {
      contentParts.push(part);
    } else if ("text" in part && part.text) {
      if ("thought" in part && part.thought) {
        thoughtParts.push(part.text);
      } else {
        contentParts.push(part.text);
      }
    } else if ("functionCall" in part && part.functionCall) {
      toolCalls.push({
        id: part.functionCall.id || `call_${toolCallIndex}`,
        type: "function",
        function: {
          name: part.functionCall.name || "",
          arguments: JSON.stringify(part.functionCall.args || {})
        }
      });
      toolCallIndex += 1;
    }
  }
  const message = {
    role: "assistant",
    content: contentParts.join("") || null,
    refusal: null
  };
  const reasoningContent = thoughtParts.join("");
  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  const finishReason = mapLlmFinishReasonToOpenAI(candidate?.finishReason);
  const usageMetadata = response.usageMetadata;
  const usage = {
    prompt_tokens: usageMetadata?.promptTokenCount || 0,
    completion_tokens: usageMetadata?.candidatesTokenCount || 0,
    total_tokens: usageMetadata?.totalTokenCount || 0
  };
  if (usageMetadata?.cachedContentTokenCount !== void 0) {
    usage.prompt_tokens_details = {
      cached_tokens: usageMetadata.cachedContentTokenCount
    };
  }
  const createdMs = response.createTime ? Number(response.createTime) : Date.now();
  const createdSeconds = Number.isFinite(createdMs) ? Math.floor(createdMs / 1e3) : Math.floor(Date.now() / 1e3);
  return {
    id: response.responseId || `gemini-${Date.now()}`,
    object: "chat.completion",
    created: createdSeconds,
    model: response.modelVersion || requestContext.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
        logprobs: null
      }
    ],
    usage
  };
}
__name(convertLlmResponseToOpenAI, "convertLlmResponseToOpenAI");
function addSystemInstructionMessage(request, messages) {
  if (!request.config?.systemInstruction) return;
  const systemText = extractTextFromContentUnion(
    request.config.systemInstruction
  );
  if (systemText) {
    messages.push({
      role: "system",
      content: systemText
    });
  }
}
__name(addSystemInstructionMessage, "addSystemInstructionMessage");
function processContents(contents, messages, requestContext) {
  if (Array.isArray(contents)) {
    for (const content of contents) {
      processContent(content, messages, requestContext);
    }
  } else if (contents) {
    processContent(contents, messages, requestContext);
  }
}
__name(processContents, "processContents");
function processContent(content, messages, requestContext) {
  if (typeof content === "string") {
    messages.push({ role: "user", content });
    return;
  }
  if (!isContentObject(content)) return;
  const parts = content.parts || [];
  const role = content.role === "model" ? "assistant" : "user";
  const contentParts = [];
  const reasoningParts = [];
  const toolCalls = [];
  let toolCallIndex = 0;
  const emittedFunctionCallIds = /* @__PURE__ */ new Set();
  const emittedFunctionResponseIds = /* @__PURE__ */ new Set();
  const accumulatedSplitMedia = [];
  for (const part of parts) {
    if (typeof part === "string") {
      contentParts.push({ type: "text", text: part });
      continue;
    }
    if ("text" in part && "thought" in part && part.thought) {
      if (role === "assistant" && part.text) {
        reasoningParts.push(part.text);
      }
    }
    if ("text" in part && part.text && !("thought" in part && part.thought)) {
      contentParts.push({ type: "text", text: part.text });
    }
    const mediaPart = createMediaContentPart(part, requestContext);
    if (mediaPart && role === "user") {
      contentParts.push(mediaPart);
    }
    if ("functionCall" in part && part.functionCall && role === "assistant") {
      const callId = part.functionCall.id;
      if (callId) {
        if (emittedFunctionCallIds.has(callId)) {
          debugLogger2.debug(
            `Dropping duplicate functionCall id=${callId} while converting content`
          );
          continue;
        }
        emittedFunctionCallIds.add(callId);
      }
      toolCalls.push({
        id: callId || `call_${toolCallIndex}`,
        type: "function",
        function: {
          name: normalizeMcpToolName(part.functionCall.name || ""),
          arguments: JSON.stringify(part.functionCall.args || {})
        }
      });
      toolCallIndex += 1;
    }
    if (part.functionResponse && role === "user") {
      const responseId = part.functionResponse.id;
      if (responseId) {
        if (emittedFunctionResponseIds.has(responseId)) {
          continue;
        }
        emittedFunctionResponseIds.add(responseId);
      }
      const toolMessage = createToolMessage(
        part.functionResponse,
        requestContext
      );
      if (toolMessage) {
        if (requestContext.splitToolMedia && Array.isArray(toolMessage.content)) {
          const mediaParts = [];
          const textParts = [];
          let prev;
          for (const cp of toolMessage.content) {
            if (cp && (cp.type === "image_url" || cp.type === "input_audio" || cp.type === "video_url" || cp.type === "file")) {
              if (prev?.type === "text" && isDisclosureText(prev.text)) {
                textParts.pop();
                mediaParts.push(prev);
              }
              mediaParts.push(cp);
            } else if (cp && cp.type === "text") {
              textParts.push(cp);
            }
            prev = cp;
          }
          if (mediaParts.length > 0) {
            const textOnly = textParts.map((p) => p.text).join("\n");
            toolMessage.content = textOnly || "[media attached in following user message]";
            accumulatedSplitMedia.push(...mediaParts);
          }
        }
        if (requestContext.toolResultContentFormat === "string" && Array.isArray(toolMessage.content)) {
          const toolContent = toolMessage.content;
          if (toolContent.every(
            (cp) => cp?.type === "text"
          )) {
            toolMessage.content = toolContent.map((cp) => cp.text).join("\n");
          }
        }
        messages.push(toolMessage);
      }
    }
  }
  if (accumulatedSplitMedia.length > 0) {
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: SPLIT_TOOL_MEDIA_TEXT
        },
        ...accumulatedSplitMedia
      ]
    });
  }
  if (role === "assistant") {
    if (contentParts.length === 0 && toolCalls.length === 0 && reasoningParts.length === 0) {
      return;
    }
    const assistantTextContent = contentParts.filter(
      (part) => part.type === "text"
    ).map((part) => part.text).join("");
    const assistantMessage = {
      role: "assistant",
      // When there is reasoning content but no text, use "" instead of null.
      // Some OpenAI-compatible providers (e.g. Ollama) reject content: null
      // when reasoning_content is present, returning HTTP 400.
      // For tool-call-only messages we keep null to stay spec-compliant.
      content: assistantTextContent || (reasoningParts.length > 0 ? "" : null)
    };
    if (toolCalls.length > 0) {
      assistantMessage.tool_calls = toolCalls;
    }
    const reasoningContent = reasoningParts.join("");
    if (reasoningContent) {
      assistantMessage.reasoning_content = reasoningContent;
    }
    messages.push(assistantMessage);
    return;
  }
  if (contentParts.length > 0) {
    messages.push({
      role: "user",
      content: contentParts
    });
  }
}
__name(processContent, "processContent");
function extractFunctionResponseContent(response) {
  if (response === null || response === void 0) {
    return "";
  }
  if (typeof response === "string") {
    return response;
  }
  if (typeof response === "object") {
    const responseObject = response;
    const output = responseObject["output"];
    if (typeof output === "string") {
      return output;
    }
    const error = responseObject["error"];
    if (typeof error === "string") {
      return error;
    }
  }
  try {
    const serialized = JSON.stringify(response);
    return serialized ?? String(response);
  } catch {
    return String(response);
  }
}
__name(extractFunctionResponseContent, "extractFunctionResponseContent");
function createToolMessage(response, requestContext) {
  const textContent = extractFunctionResponseContent(response.response);
  const contentParts = [];
  if (textContent) {
    contentParts.push({ type: "text", text: textContent });
  }
  for (const part of response.parts || []) {
    if ("text" in part && typeof part.text === "string") {
      if (part.text.length > 0) {
        contentParts.push({ type: "text", text: part.text });
      }
      continue;
    }
    const mediaPart = createMediaContentPart(part, requestContext);
    if (mediaPart) {
      contentParts.push(mediaPart);
    }
  }
  if (contentParts.length === 0) {
    return {
      role: "tool",
      tool_call_id: response.id || "",
      content: ""
    };
  }
  return {
    role: "tool",
    tool_call_id: response.id || "",
    content: contentParts
  };
}
__name(createToolMessage, "createToolMessage");
function createMediaContentPart(part, requestContext) {
  const { modalities } = requestContext;
  if (part.inlineData?.mimeType && part.inlineData?.data) {
    const mimeType = part.inlineData.mimeType;
    const mediaType = getMediaType(mimeType);
    const displayName = part.inlineData.displayName || mimeType;
    if (mediaType === "image") {
      if (!modalities.image) {
        return unsupportedModalityPlaceholder(
          "image",
          displayName,
          requestContext
        );
      }
      const dataUrl = `data:${mimeType};base64,${part.inlineData.data}`;
      return {
        type: "image_url",
        image_url: { url: dataUrl }
      };
    }
    if (mimeType === "application/pdf") {
      if (!modalities.pdf) {
        return unsupportedModalityPlaceholder(
          "pdf",
          displayName,
          requestContext
        );
      }
      const filename = part.inlineData.displayName || "document.pdf";
      return {
        type: "file",
        file: {
          filename,
          file_data: `data:${mimeType};base64,${part.inlineData.data}`
        }
      };
    }
    if (mediaType === "audio") {
      if (!modalities.audio) {
        return unsupportedModalityPlaceholder(
          "audio",
          displayName,
          requestContext
        );
      }
      const format = getAudioFormat(mimeType);
      if (format) {
        return {
          type: "input_audio",
          input_audio: {
            data: `data:${mimeType};base64,${part.inlineData.data}`,
            // DashScope accepts flac/ogg/m4a beyond the OpenAI SDK's
            // wav|mp3 union; the request wire format is identical.
            format
          }
        };
      }
    }
    if (mediaType === "video") {
      if (!modalities.video) {
        return unsupportedModalityPlaceholder(
          "video",
          displayName,
          requestContext
        );
      }
      return {
        type: "video_url",
        video_url: {
          url: `data:${mimeType};base64,${part.inlineData.data}`
        }
      };
    }
    return {
      type: "text",
      text: `Unsupported inline media type: ${mimeType} (${displayName}).`
    };
  }
  if (part.fileData?.mimeType && part.fileData?.fileUri) {
    const filename = part.fileData.displayName || "file";
    const fileUri = part.fileData.fileUri;
    const mimeType = part.fileData.mimeType;
    const mediaType = getMediaType(mimeType);
    if (mediaType === "image") {
      if (!modalities.image) {
        return unsupportedModalityPlaceholder(
          "image",
          filename,
          requestContext
        );
      }
      return {
        type: "image_url",
        image_url: { url: fileUri }
      };
    }
    if (mimeType === "application/pdf") {
      if (!modalities.pdf) {
        return unsupportedModalityPlaceholder("pdf", filename, requestContext);
      }
      return {
        type: "file",
        file: {
          filename,
          file_data: fileUri
        }
      };
    }
    if (mediaType === "video") {
      if (!modalities.video) {
        return unsupportedModalityPlaceholder(
          "video",
          filename,
          requestContext
        );
      }
      return {
        type: "video_url",
        video_url: {
          url: fileUri
        }
      };
    }
    if (mediaType === "audio") {
      if (!modalities.audio) {
        return unsupportedModalityPlaceholder(
          "audio",
          filename,
          requestContext
        );
      }
      const format = getAudioFormat(mimeType);
      if (format) {
        return {
          type: "input_audio",
          input_audio: {
            data: fileUri,
            // See inline branch: DashScope accepts a wider format set
            // than the OpenAI SDK union.
            format
          }
        };
      }
    }
    const displayNameStr = part.fileData.displayName ? ` (${part.fileData.displayName})` : "";
    return {
      type: "text",
      text: `Unsupported file media type: ${mimeType}${displayNameStr}.`
    };
  }
  return null;
}
__name(createMediaContentPart, "createMediaContentPart");
function unsupportedModalityPlaceholder(modality, displayName, requestContext) {
  debugLogger2.warn(
    `Model '${requestContext.model}' does not support ${modality} input. Replacing with text placeholder: ${displayName}`
  );
  let hint;
  if (modality === "pdf") {
    hint = "This model does not support PDF input directly. The read_file tool cannot extract PDF content either. To extract text from the PDF file, try using skills if applicable, or guide user to install pdf skill by running this slash command:\n/extensions install https://github.com/anthropics/skills:document-skills";
  } else {
    hint = `This model does not support ${modality} input. The read_file tool cannot process this type of file either. To handle this file, try using skills if applicable, or any tools installed at system wide, or let the user know you cannot process this type of file.`;
  }
  return {
    type: "text",
    text: `[Unsupported ${modality} file: "${displayName}". ${hint}]`
  };
}
__name(unsupportedModalityPlaceholder, "unsupportedModalityPlaceholder");
function getMediaType(mimeType) {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}
__name(getMediaType, "getMediaType");
function getAudioFormat(mimeType) {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mp3") || mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("flac")) return "flac";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType === "audio/mp4" || mimeType.includes("m4a")) return "m4a";
  return null;
}
__name(getAudioFormat, "getAudioFormat");
function isContentObject(content) {
  return typeof content === "object" && content !== null && "role" in content && "parts" in content && Array.isArray(content["parts"]);
}
__name(isContentObject, "isContentObject");
function extractTextFromContentUnion(contentUnion) {
  if (typeof contentUnion === "string") {
    return contentUnion;
  }
  if (Array.isArray(contentUnion)) {
    return contentUnion.map((item) => extractTextFromContentUnion(item)).filter(Boolean).join("\n");
  }
  if (typeof contentUnion === "object" && contentUnion !== null) {
    if ("parts" in contentUnion) {
      const content = contentUnion;
      return content.parts?.map((part) => {
        if (typeof part === "string") return part;
        if ("text" in part) return part.text || "";
        return "";
      }).filter(Boolean).join("\n") || "";
    }
  }
  return "";
}
__name(extractTextFromContentUnion, "extractTextFromContentUnion");
function convertOpenAITextToParts(text, requestContext, final = true) {
  if (!requestContext.responseParsingOptions?.taggedThinkingTags && !requestContext.taggedThinkingParser) {
    return text ? [{ text }] : [];
  }
  if (requestContext.taggedThinkingParser) {
    return requestContext.taggedThinkingParser.parse(text, final);
  }
  return parseTaggedThinkingText(text);
}
__name(convertOpenAITextToParts, "convertOpenAITextToParts");
function hasThoughtPart(parts) {
  return parts.some((part) => part.thought === true);
}
__name(hasThoughtPart, "hasThoughtPart");
var THINKING_TAG_PATTERN = /<\/?think(?:ing)?\s*>/i;
var CLOSING_THINKING_TAG_PATTERN = /\n[^\S\r\n]*<\/think(?:ing)?[^\S\r\n]*>/i;
var LEADING_CLOSING_THINKING_TAG_PATTERN = /^[^\S\r\n]*<\/think(?:ing)?[^\S\r\n]*>/i;
var LEADING_THINKING_TAG_PATTERN = /^\s*<\/?think(?:ing)?\s*>/i;
var STANDALONE_CLOSING_THINKING_TAG_PATTERN = /^\s*<\/(think|thinking)\s*>\s*$/i;
var STANDALONE_OPENING_THINKING_TAG_PATTERN = /^\s*<(think|thinking)\s*>\s*$/i;
var MAX_THINKING_TAG_CANDIDATE_LENGTH = 128;
function canBeStandaloneThinkingTagPrefix(text) {
  const candidate = text.trimStart().toLowerCase();
  if (!candidate) return true;
  return ["<think", "<thinking", "</think", "</thinking"].some((tag) => {
    if (tag.startsWith(candidate)) return true;
    if (!candidate.startsWith(tag)) return false;
    return /^\s*(?:>\s*)?$/.test(candidate.slice(tag.length));
  });
}
__name(canBeStandaloneThinkingTagPrefix, "canBeStandaloneThinkingTagPrefix");
function classifyContentOnlyThinkingTagPrefix(text, streamFinished) {
  const candidate = text.trimStart().toLowerCase();
  if (!candidate) return "clean";
  const consumeTag = /* @__PURE__ */ __name((value, closing) => {
    const match = LEADING_THINKING_TAG_PATTERN.exec(value)?.[0];
    if (match) {
      return match.trimStart().startsWith("</") === closing ? match.length : void 0;
    }
    if (!canBeStandaloneThinkingTagPrefix(value)) return void 0;
    if (!value || value === "<") return null;
    return closing === value.startsWith("</") ? null : void 0;
  }, "consumeTag");
  let rest = candidate;
  for (const closing of [false, true, false]) {
    const tagLength = consumeTag(rest, closing);
    if (tagLength === null) return "pending";
    if (tagLength === void 0) {
      if (!closing) return "clean";
      break;
    }
    rest = rest.slice(tagLength).trimStart();
    if (closing && !rest) return "clean";
    if (closing === false && /\S/.test(rest) && !/<\/think(?:ing)?\s*>/i.test(rest)) {
      return streamFinished ? "leaked" : "pending";
    }
  }
  let depth = 1;
  let hasNestedOpening = false;
  for (; ; ) {
    const nextTag = THINKING_TAG_PATTERN.exec(rest);
    if (!nextTag) break;
    const closing = nextTag[0].startsWith("</");
    depth += closing ? -1 : 1;
    if (depth === 0) return "clean";
    hasNestedOpening ||= !closing;
    rest = rest.slice(nextTag.index + nextTag[0].length);
  }
  if (!hasNestedOpening) return "pending";
  return streamFinished ? "leaked" : "suspicious";
}
__name(classifyContentOnlyThinkingTagPrefix, "classifyContentOnlyThinkingTagPrefix");
function throwProtocolTagLeak(requestContext) {
  requestContext.pendingThinkingTagCandidate = void 0;
  requestContext.pendingUntrustedResponseParts = void 0;
  throw new InvalidStreamError(
    "Model response leaked thinking tags.",
    "PROTOCOL_TAG_LEAK"
  );
}
__name(throwProtocolTagLeak, "throwProtocolTagLeak");
function convertOpenAIResponseToLlm(openaiResponse, requestContext) {
  const choice = openaiResponse.choices?.[0];
  const message = choice?.message;
  const reasoningText = message?.reasoning_content ?? message?.reasoning;
  const response = new GenerateContentResponse();
  if (choice) {
    const parts = [];
    const textParts = choice.message.content ? convertOpenAITextToParts(choice.message.content, requestContext) : [];
    if (reasoningText && !hasThoughtPart(textParts)) {
      parts.push(createOpenAIReasoningThoughtPart(reasoningText));
    }
    parts.push(...textParts);
    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        if (toolCall.function) {
          let args = {};
          if (toolCall.function.arguments) {
            args = safeJsonParse(toolCall.function.arguments, {});
          }
          parts.push({
            functionCall: {
              id: toolCall.id,
              name: toolCall.function.name,
              args
            }
          });
        }
      }
    }
    response.candidates = [
      {
        content: {
          parts,
          role: "model"
        },
        finishReason: mapOpenAIFinishReasonToLlm(
          choice.finish_reason || "stop"
        ),
        index: 0,
        safetyRatings: []
      }
    ];
  } else {
    response.candidates = [];
  }
  response.responseId = openaiResponse.id;
  response.createTime = openaiResponse.created ? openaiResponse.created.toString() : (/* @__PURE__ */ new Date()).getTime().toString();
  response.modelVersion = openaiResponse.model || void 0;
  response.promptFeedback = { safetyRatings: [] };
  if (openaiResponse.usage) {
    const usage = openaiResponse.usage;
    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || 0;
    const extendedUsage = usage;
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? extendedUsage.cached_tokens ?? 0;
    const cachedInputTokensReported = typeof usage.prompt_tokens_details?.cached_tokens === "number" || typeof extendedUsage.cached_tokens === "number";
    const providerReasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
    let thinkingTokens = providerReasoningTokens;
    if (thinkingTokens == null) {
      const estimatedThinkingTokens = estimateTextTokens(reasoningText ?? "");
      thinkingTokens = completionTokens > 0 ? Math.min(estimatedThinkingTokens, completionTokens) : estimatedThinkingTokens;
      if (thinkingTokens > 0) {
        debugLogger2.debug(
          `convertOpenAIResponseToLlm: reasoning_tokens absent; estimated ${thinkingTokens} from text`
        );
      }
    }
    const hasTokenBreakdown = totalTokens === 0 || promptTokens !== 0 || completionTokens !== 0;
    response.usageMetadata = {
      ...hasTokenBreakdown ? {
        promptTokenCount: promptTokens,
        candidatesTokenCount: completionTokens
      } : {},
      totalTokenCount: totalTokens,
      cachedContentTokenCount: cachedTokens,
      thoughtsTokenCount: thinkingTokens
    };
    setGenAiUsageProvenance(response.usageMetadata, {
      cachedInputTokensReported
    });
  }
  return response;
}
__name(convertOpenAIResponseToLlm, "convertOpenAIResponseToLlm");
function convertOpenAIChunkToLlm(chunk, requestContext) {
  const choice = chunk.choices?.[0];
  const response = new GenerateContentResponse();
  const preparations = [];
  const toolCallParser = requestContext.toolCallParser;
  if (!toolCallParser) {
    throw new Error(
      "convertOpenAIChunkToLlm requires requestContext.toolCallParser \u2014 attach a fresh StreamingToolCallParser at stream start."
    );
  }
  if (choice) {
    let parts = [];
    let contentParts = [];
    const reasoningText = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
    if (typeof choice.delta?.content === "string") {
      const rawContent = choice.delta.content;
      const replayState = requestContext.textDeltaState;
      const replayedTaggedThinkingSnapshot = requestContext.responseParsingOptions?.taggedThinkingTagsAfterReasoning === true && requestContext.taggedThinkingParser !== void 0 && replayState !== void 0 && (replayState.emittedText === rawContent || rawContent.length === replayState.emittedLength && rawContent.startsWith(replayState.emittedText)) && THINKING_TAG_PATTERN.test(rawContent);
      if (replayedTaggedThinkingSnapshot) {
        replayState.emittedText = rawContent;
        replayState.emittedLength = rawContent.length;
        replayState.cumulativeMode = true;
      }
      const normalizedContent = replayedTaggedThinkingSnapshot ? "" : normalizeStreamingTextDelta(
        rawContent,
        requestContext.textDeltaState ??= {
          emittedText: "",
          emittedLength: 0,
          cumulativeMode: false
        }
      );
      const taggedThinkingCandidate = (requestContext.pendingThinkingTagCandidate?.text ?? "") + normalizedContent;
      if (requestContext.responseParsingOptions?.taggedThinkingTagsAfterReasoning && (requestContext.hasStructuredReasoningContent || reasoningText) && LEADING_THINKING_TAG_PATTERN.test(taggedThinkingCandidate) && !taggedThinkingCandidate.trimStart().startsWith("</")) {
        requestContext.taggedThinkingParser ??= new TaggedThinkingParser();
        requestContext.pendingThinkingTagCandidate = void 0;
        contentParts = requestContext.taggedThinkingParser.parse(
          taggedThinkingCandidate,
          Boolean(choice.finish_reason)
        );
      } else if (normalizedContent || choice.finish_reason) {
        contentParts = convertOpenAITextToParts(
          normalizedContent,
          requestContext,
          Boolean(choice.finish_reason)
        );
      }
    } else if (choice.finish_reason) {
      contentParts = convertOpenAITextToParts("", requestContext, true);
    }
    if (choice.finish_reason && requestContext.responseParsingOptions?.taggedThinkingTagsAfterReasoning && requestContext.taggedThinkingParser?.hasUnclosedThought()) {
      throwProtocolTagLeak(requestContext);
    }
    if (hasThoughtPart(contentParts)) {
      requestContext.hasTaggedThinkingThought = true;
      requestContext.pendingReasoningText = void 0;
      debugLogger2.debug(
        "convertOpenAIChunkToLlm: tagged thinking content emitted a thought; dropping buffered reasoning"
      );
      if (requestContext.pendingContentParts?.length) {
        debugLogger2.debug(
          `convertOpenAIChunkToLlm: flushing ${requestContext.pendingContentParts.length} buffered content part(s) before tagged content`
        );
        parts.push(...requestContext.pendingContentParts);
        requestContext.pendingContentParts = void 0;
      }
    }
    if (reasoningText && (!requestContext.responseParsingOptions?.taggedThinkingTags || !requestContext.hasTaggedThinkingThought)) {
      const reasoningDeltaState = requestContext.reasoningDeltaState ??= {
        emittedText: "",
        emittedLength: 0,
        cumulativeMode: false
      };
      const normalizedReasoningText = normalizeStreamingTextDelta(
        reasoningText,
        reasoningDeltaState
      );
      if (normalizedReasoningText) {
        reasoningDeltaState.emittedTokenUnits = (reasoningDeltaState.emittedTokenUnits ?? 0) + estimateTextTokenUnits(normalizedReasoningText);
        requestContext.hasStructuredReasoningContent = true;
        if (THINKING_TAG_PATTERN.test(normalizedReasoningText)) {
          requestContext.hasThinkingTagInReasoning = true;
        }
      }
      if (normalizedReasoningText && !requestContext.responseParsingOptions?.taggedThinkingTags) {
        parts.push(createOpenAIReasoningThoughtPart(normalizedReasoningText));
      } else if (normalizedReasoningText && !requestContext.hasTaggedThinkingThought) {
        requestContext.pendingReasoningText = (requestContext.pendingReasoningText ?? "") + normalizedReasoningText;
        debugLogger2.debug(
          `convertOpenAIChunkToLlm: buffered reasoning text (${requestContext.pendingReasoningText.length} chars) for tagged stream`
        );
      }
    }
    if (requestContext.responseParsingOptions?.taggedThinkingTags && !requestContext.hasTaggedThinkingThought && requestContext.pendingReasoningText && contentParts.length) {
      requestContext.pendingContentParts = [
        ...requestContext.pendingContentParts ?? [],
        ...contentParts
      ];
      debugLogger2.debug(
        `convertOpenAIChunkToLlm: buffered ${contentParts.length} content part(s) behind pending reasoning`
      );
      contentParts = [];
    }
    if (choice.finish_reason && requestContext.responseParsingOptions?.taggedThinkingTags && !requestContext.hasTaggedThinkingThought && requestContext.pendingReasoningText) {
      debugLogger2.debug(
        "convertOpenAIChunkToLlm: flushing buffered reasoning for tagged stream with no tagged thought"
      );
      parts.push(
        createOpenAIReasoningThoughtPart(requestContext.pendingReasoningText)
      );
      requestContext.pendingReasoningText = void 0;
    }
    if (choice.finish_reason && requestContext.pendingContentParts?.length) {
      debugLogger2.debug(
        `convertOpenAIChunkToLlm: flushing ${requestContext.pendingContentParts.length} buffered content part(s) on stream finish`
      );
      parts.push(...requestContext.pendingContentParts);
      requestContext.pendingContentParts = void 0;
    }
    parts.push(...contentParts);
    if (choice.delta?.tool_calls) {
      for (const toolCall of choice.delta.tool_calls) {
        const index = toolCall.index ?? 0;
        const parseResult = toolCall.function?.arguments ? toolCallParser.addChunk(
          index,
          toolCall.function.arguments,
          toolCall.id,
          toolCall.function.name
        ) : toolCallParser.addChunk(
          index,
          "",
          // Empty chunk for metadata-only updates
          toolCall.id,
          toolCall.function?.name
        );
        const { id: callId, name: toolName } = toolCallParser.getToolCallMeta(
          parseResult.actualIndex ?? index
        );
        if (callId && toolName) {
          const emitted = requestContext.preparedToolCallIds ??= /* @__PURE__ */ new Set();
          if (!emitted.has(callId)) {
            emitted.add(callId);
            preparations.push({ callId, toolName });
          }
        }
      }
    }
    const getVisibleText = /* @__PURE__ */ __name((part) => part.thought !== true && typeof part.text === "string" ? part.text : "", "getVisibleText");
    let visibleText = parts.map(getVisibleText).join("");
    const pendingTagCandidate = requestContext.pendingThinkingTagCandidate;
    const replayedTagPrefix = !pendingTagCandidate?.closingTagName && /\S/.test(pendingTagCandidate?.text ?? "") && pendingTagCandidate?.text === visibleText;
    const replayedClosingTag = STANDALONE_CLOSING_THINKING_TAG_PATTERN.exec(
      visibleText
    )?.[1]?.toLowerCase();
    if (replayedTagPrefix || pendingTagCandidate?.closingTagName && pendingTagCandidate.closingTagName === replayedClosingTag) {
      parts = parts.filter((part) => !getVisibleText(part));
      visibleText = "";
    }
    const combinedCandidateText = (pendingTagCandidate?.text ?? "") + visibleText;
    const hasStructuredReasoning = requestContext.hasStructuredReasoningContent === true;
    const detectContentOnlyThinkingTagLeaks = requestContext.responseParsingOptions?.contentOnlyThinkingTagLeaks === true;
    const contentOnlyThinkingState = hasStructuredReasoning || requestContext.hasVisibleContent === true || !detectContentOnlyThinkingTagLeaks ? "clean" : classifyContentOnlyThinkingTagPrefix(
      combinedCandidateText,
      Boolean(choice.finish_reason)
    );
    const canStartTagCandidate = requestContext.hasVisibleContent !== true && visibleText.length > 0 && (hasStructuredReasoning && canBeStandaloneThinkingTagPrefix(combinedCandidateText) || contentOnlyThinkingState !== "clean");
    if (pendingTagCandidate || canStartTagCandidate) {
      const closingTag = STANDALONE_CLOSING_THINKING_TAG_PATTERN.exec(
        combinedCandidateText
      )?.[1]?.toLowerCase();
      const closingTagName = closingTag === "think" || closingTag === "thinking" ? closingTag : void 0;
      const openingTag = STANDALONE_OPENING_THINKING_TAG_PATTERN.test(
        combinedCandidateText
      );
      const isPossibleTag = canBeStandaloneThinkingTagPrefix(combinedCandidateText) || contentOnlyThinkingState === "pending" || contentOnlyThinkingState === "suspicious";
      const finishedWhitespaceCandidate = Boolean(choice.finish_reason) && !closingTagName && !/\S/.test(combinedCandidateText);
      const confirmedOpeningTagCandidate = LEADING_THINKING_TAG_PATTERN.test(combinedCandidateText) && !combinedCandidateText.trimStart().startsWith("</");
      const releaseContentOnlyCandidate = contentOnlyThinkingState === "pending" && !confirmedOpeningTagCandidate && (Boolean(choice.finish_reason) || combinedCandidateText.trimStart().length > MAX_THINKING_TAG_CANDIDATE_LENGTH);
      if (contentOnlyThinkingState === "leaked") {
        throwProtocolTagLeak(requestContext);
      }
      if (openingTag && hasStructuredReasoning) {
        throwProtocolTagLeak(requestContext);
      }
      if (pendingTagCandidate?.closingTagName && !closingTagName) {
        throwProtocolTagLeak(requestContext);
      }
      if (finishedWhitespaceCandidate || releaseContentOnlyCandidate) {
        parts = parts.filter((part) => !getVisibleText(part));
        if (combinedCandidateText) {
          parts.push({ text: combinedCandidateText });
        }
        visibleText = combinedCandidateText;
        requestContext.pendingThinkingTagCandidate = void 0;
      } else if (isPossibleTag) {
        if (!confirmedOpeningTagCandidate && !closingTagName && combinedCandidateText.trimStart().length > MAX_THINKING_TAG_CANDIDATE_LENGTH) {
          throwProtocolTagLeak(requestContext);
        }
        requestContext.pendingThinkingTagCandidate = closingTagName ? { text: `</${closingTagName}>`, closingTagName } : { text: combinedCandidateText };
        parts = parts.filter((part) => !getVisibleText(part));
        visibleText = "";
        if (choice.finish_reason && !closingTagName) {
          throwProtocolTagLeak(requestContext);
        }
      } else if (pendingTagCandidate) {
        parts = parts.filter((part) => !getVisibleText(part));
        parts.push({ text: combinedCandidateText });
        visibleText = combinedCandidateText;
        requestContext.pendingThinkingTagCandidate = void 0;
      }
    }
    const leakedThinkingTag = requestContext.hasStructuredReasoningContent === true && (requestContext.hasVisibleContent !== true && LEADING_THINKING_TAG_PATTERN.test(visibleText) || requestContext.hasThinkingTagInReasoning === true && (CLOSING_THINKING_TAG_PATTERN.test(visibleText) || requestContext.atVisibleLineStart === true && LEADING_CLOSING_THINKING_TAG_PATTERN.test(visibleText)));
    if (/\S/.test(visibleText)) {
      requestContext.hasVisibleContent = true;
    }
    if (visibleText && requestContext.hasThinkingTagInReasoning === true) {
      const lastLineBreak = visibleText.lastIndexOf("\n");
      const lineSuffix = visibleText.slice(lastLineBreak + 1);
      requestContext.atVisibleLineStart = (lastLineBreak >= 0 || requestContext.atVisibleLineStart === true) && /^[^\S\r\n]*$/.test(lineSuffix);
    }
    if (leakedThinkingTag) {
      throwProtocolTagLeak(requestContext);
    }
    const toolCallWithoutName = toolCallParser.hasNamelessToolCall();
    const completedToolCalls = choice.finish_reason ? toolCallParser.getCompletedToolCalls() : [];
    const toolCallsTruncated = choice.finish_reason ? toolCallParser.hasIncompleteToolCalls() : false;
    if (choice.finish_reason && requestContext.pendingThinkingTagCandidate?.closingTagName) {
      if (requestContext.hasThinkingTagInReasoning === true || choice.finish_reason !== "tool_calls" || completedToolCalls.length === 0 || toolCallWithoutName || toolCallParser.hasConflictingToolCallIdentity() || toolCallsTruncated || toolCallParser.hasInvalidToolCallArguments()) {
        throwProtocolTagLeak(requestContext);
      }
      requestContext.protocolTagSanitized = {
        tagName: requestContext.pendingThinkingTagCandidate.closingTagName,
        toolCallCount: completedToolCalls.length
      };
      requestContext.pendingThinkingTagCandidate = void 0;
    }
    if (choice.finish_reason && (toolCallParser.hasInvalidToolCallIndex() || toolCallWithoutName || choice.finish_reason === "tool_calls" && completedToolCalls.length === 0)) {
      requestContext.pendingUntrustedResponseParts = void 0;
      throw new InvalidStreamError(
        "Model response contained a malformed tool call.",
        "MALFORMED_TOOL_CALL"
      );
    }
    const shouldHoldParts = !choice.finish_reason && (toolCallWithoutName || requestContext.hasThinkingTagInReasoning === true || requestContext.pendingThinkingTagCandidate !== void 0);
    if (shouldHoldParts) {
      (requestContext.pendingUntrustedResponseParts ??= []).push(...parts);
      parts.length = 0;
    } else if (requestContext.pendingUntrustedResponseParts) {
      parts = requestContext.pendingUntrustedResponseParts.concat(parts);
      requestContext.pendingUntrustedResponseParts = void 0;
    }
    if (choice.finish_reason) {
      for (const toolCall of completedToolCalls) {
        if (toolCall.name) {
          parts.push({
            functionCall: {
              id: toolCall.id || `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
              name: toolCall.name,
              args: toolCall.args
            }
          });
        }
      }
    }
    const effectiveFinishReason = toolCallsTruncated && choice.finish_reason !== "length" ? "length" : choice.finish_reason;
    const candidate = {
      content: {
        parts,
        role: "model"
      },
      index: 0,
      safetyRatings: []
    };
    if (effectiveFinishReason) {
      candidate.finishReason = mapOpenAIFinishReasonToLlm(
        effectiveFinishReason
      );
    }
    response.candidates = [candidate];
  } else {
    response.candidates = [];
  }
  response.responseId = chunk.id;
  response.createTime = chunk.created ? chunk.created.toString() : (/* @__PURE__ */ new Date()).getTime().toString();
  response.modelVersion = chunk.model || void 0;
  response.promptFeedback = { safetyRatings: [] };
  if (chunk.usage) {
    const usage = chunk.usage;
    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || 0;
    const providerReasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
    const estimatedThinkingTokens = Math.ceil(
      (requestContext.reasoningDeltaState?.emittedTokenUnits ?? 0) / TOKEN_ESTIMATE_UNITS_PER_TOKEN
    );
    const thinkingTokens = providerReasoningTokens ?? (completionTokens > 0 ? Math.min(estimatedThinkingTokens, completionTokens) : estimatedThinkingTokens);
    if (providerReasoningTokens == null && estimatedThinkingTokens > 0) {
      debugLogger2.debug(
        `convertOpenAIChunkToLlm: reasoning_tokens absent; estimated ${thinkingTokens} from streamed text`
      );
    }
    const extendedUsage = usage;
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? extendedUsage.cached_tokens ?? 0;
    const cachedInputTokensReported = typeof usage.prompt_tokens_details?.cached_tokens === "number" || typeof extendedUsage.cached_tokens === "number";
    const hasTokenBreakdown = totalTokens === 0 || promptTokens !== 0 || completionTokens !== 0;
    response.usageMetadata = {
      ...hasTokenBreakdown ? {
        promptTokenCount: promptTokens,
        candidatesTokenCount: completionTokens
      } : {},
      thoughtsTokenCount: thinkingTokens,
      totalTokenCount: totalTokens,
      cachedContentTokenCount: cachedTokens
    };
    setGenAiUsageProvenance(response.usageMetadata, {
      cachedInputTokensReported
    });
  }
  if (preparations.length > 0) {
    setToolCallPreparations(response, preparations);
  }
  return response;
}
__name(convertOpenAIChunkToLlm, "convertOpenAIChunkToLlm");
function mapOpenAIFinishReasonToLlm(openaiReason) {
  if (typeof openaiReason !== "string") {
    return FinishReason.FINISH_REASON_UNSPECIFIED;
  }
  const mapping = {
    stop: FinishReason.STOP,
    length: FinishReason.MAX_TOKENS,
    max_tokens: FinishReason.MAX_TOKENS,
    content_filter: FinishReason.SAFETY,
    function_call: FinishReason.STOP,
    tool_calls: FinishReason.STOP
  };
  return mapping[openaiReason.toLowerCase()] || FinishReason.FINISH_REASON_UNSPECIFIED;
}
__name(mapOpenAIFinishReasonToLlm, "mapOpenAIFinishReasonToLlm");
function mapLlmFinishReasonToOpenAI(llmReason) {
  if (!llmReason) {
    return "stop";
  }
  switch (llmReason) {
    case FinishReason.STOP:
      return "stop";
    case FinishReason.MAX_TOKENS:
      return "length";
    case FinishReason.SAFETY:
    case FinishReason.RECITATION:
    case FinishReason.BLOCKLIST:
    case FinishReason.PROHIBITED_CONTENT:
    case FinishReason.SPII:
    case FinishReason.IMAGE_SAFETY:
    case FinishReason.IMAGE_RECITATION:
    case FinishReason.IMAGE_PROHIBITED_CONTENT:
    case FinishReason.IMAGE_OTHER:
      return "content_filter";
    case FinishReason.NO_IMAGE:
      return "stop";
    default:
      return "stop";
  }
}
__name(mapLlmFinishReasonToOpenAI, "mapLlmFinishReasonToOpenAI");
function hasToolCalls(message) {
  return message.role === "assistant" && "tool_calls" in message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}
__name(hasToolCalls, "hasToolCalls");
function isSplitToolMediaMessage(message) {
  if (message.role !== "user" || !("content" in message) || !Array.isArray(message.content)) {
    return false;
  }
  const firstPart = message.content[0];
  return firstPart?.type === "text" && firstPart.text === SPLIT_TOOL_MEDIA_TEXT;
}
__name(isSplitToolMediaMessage, "isSplitToolMediaMessage");
function cleanOrphanedToolCalls(messages) {
  const cleaned = [];
  const validToolCallsByAssistant = /* @__PURE__ */ new Map();
  const validToolResponseIndexesByAssistant = /* @__PURE__ */ new Map();
  const splitMediaIndexesByAssistant = /* @__PURE__ */ new Map();
  const emittedWithAssistant = /* @__PURE__ */ new Set();
  const survivingToolCallIds = /* @__PURE__ */ new Set();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (hasToolCalls(message)) {
      const candidateToolCalls = [];
      const candidateToolCallIds = /* @__PURE__ */ new Set();
      for (const toolCall of message.tool_calls) {
        const id = toolCall.id;
        if (!id || survivingToolCallIds.has(id)) {
          continue;
        }
        if (candidateToolCallIds.has(id)) {
          continue;
        }
        candidateToolCallIds.add(id);
        candidateToolCalls.push(toolCall);
      }
      const adjacentToolResponseIds = /* @__PURE__ */ new Set();
      const toolResponseIndexes = [];
      const splitMediaIndexes = [];
      let lastToolResponseMatchesAssistant = false;
      for (let nextIndex = index + 1; nextIndex < messages.length; nextIndex += 1) {
        const nextMessage = messages[nextIndex];
        if (nextMessage.role === "tool" && "tool_call_id" in nextMessage) {
          if (!nextMessage.tool_call_id) {
            lastToolResponseMatchesAssistant = false;
            continue;
          }
          if (candidateToolCallIds.has(nextMessage.tool_call_id) && !adjacentToolResponseIds.has(nextMessage.tool_call_id)) {
            adjacentToolResponseIds.add(nextMessage.tool_call_id);
            toolResponseIndexes.push(nextIndex);
            lastToolResponseMatchesAssistant = true;
          } else {
            lastToolResponseMatchesAssistant = false;
          }
          continue;
        }
        if (isSplitToolMediaMessage(nextMessage)) {
          if (lastToolResponseMatchesAssistant) {
            splitMediaIndexes.push(nextIndex);
          }
          continue;
        }
        if (nextMessage.role === "assistant" && !hasToolCalls(nextMessage)) {
          continue;
        }
        break;
      }
      const validToolCalls = candidateToolCalls.filter(
        (toolCall) => adjacentToolResponseIds.has(toolCall.id)
      );
      for (const toolCall of validToolCalls) {
        survivingToolCallIds.add(toolCall.id);
      }
      validToolCallsByAssistant.set(index, validToolCalls);
      validToolResponseIndexesByAssistant.set(index, toolResponseIndexes);
      splitMediaIndexesByAssistant.set(index, splitMediaIndexes);
    }
  }
  for (let index = 0; index < messages.length; index += 1) {
    if (emittedWithAssistant.has(index)) {
      continue;
    }
    const message = messages[index];
    if (hasToolCalls(message)) {
      const reasoningContent = message.reasoning_content;
      const validToolCalls = validToolCallsByAssistant.get(index) ?? [];
      if (validToolCalls.length > 0) {
        const cleanedMessage = { ...message };
        cleanedMessage.tool_calls = validToolCalls;
        cleaned.push(cleanedMessage);
        for (const toolResponseIndex of validToolResponseIndexesByAssistant.get(
          index
        ) ?? []) {
          const toolResponse = messages[toolResponseIndex];
          if (toolResponse) {
            cleaned.push(toolResponse);
            emittedWithAssistant.add(toolResponseIndex);
          }
        }
        for (const splitMediaIndex of splitMediaIndexesByAssistant.get(index) ?? []) {
          const splitMediaMessage = messages[splitMediaIndex];
          if (splitMediaMessage) {
            cleaned.push(splitMediaMessage);
            emittedWithAssistant.add(splitMediaIndex);
          }
        }
      } else if (typeof message.content === "string" && message.content.trim() || reasoningContent) {
        const cleanedMessage = { ...message };
        delete cleanedMessage.tool_calls;
        cleaned.push(cleanedMessage);
      } else {
        debugLogger2.debug(
          `cleanOrphanedToolCalls: dropping assistant with ${message.tool_calls.length} orphaned tool call(s) and no text/reasoning content`
        );
      }
    } else if (message.role === "tool" && "tool_call_id" in message) {
      debugLogger2.debug(
        `cleanOrphanedToolCalls: dropping orphaned tool response ${message.tool_call_id || "<empty>"}`
      );
    } else if (isSplitToolMediaMessage(message)) {
      debugLogger2.debug(
        "cleanOrphanedToolCalls: dropping orphaned split tool media message"
      );
    } else {
      cleaned.push(message);
    }
  }
  return cleaned;
}
__name(cleanOrphanedToolCalls, "cleanOrphanedToolCalls");
function mergeConsecutiveAssistantMessages(messages) {
  const merged = [];
  for (const message of messages) {
    if (message.role === "assistant" && merged.length > 0) {
      const lastMessage = merged[merged.length - 1];
      if (lastMessage.role === "assistant") {
        const lastToolCalls = "tool_calls" in lastMessage ? lastMessage.tool_calls || [] : [];
        const currentToolCalls = "tool_calls" in message ? message.tool_calls || [] : [];
        const lastContent = lastMessage.content;
        const currentContent = message.content;
        const useArrayFormat = Array.isArray(lastContent) || Array.isArray(currentContent);
        let combinedContent;
        if (useArrayFormat) {
          const lastParts = Array.isArray(lastContent) ? lastContent : typeof lastContent === "string" && lastContent ? [{ type: "text", text: lastContent }] : [];
          const currentParts = Array.isArray(currentContent) ? currentContent : typeof currentContent === "string" && currentContent ? [{ type: "text", text: currentContent }] : [];
          combinedContent = [
            ...lastParts,
            ...currentParts
          ];
        } else {
          const lastText = typeof lastContent === "string" ? lastContent : "";
          const currentText = typeof currentContent === "string" ? currentContent : "";
          const mergedText = [lastText, currentText].filter(Boolean).join("");
          combinedContent = mergedText || null;
        }
        const combinedToolCalls = [...lastToolCalls, ...currentToolCalls];
        lastMessage.content = combinedContent || null;
        if (combinedToolCalls.length > 0) {
          lastMessage.tool_calls = combinedToolCalls;
        }
        const lastReasoning = lastMessage.reasoning_content;
        const currentReasoning = message.reasoning_content;
        const combinedReasoning = [lastReasoning, currentReasoning].filter(Boolean).join("");
        if (combinedReasoning) {
          lastMessage.reasoning_content = combinedReasoning;
        }
        continue;
      }
    }
    merged.push(message);
  }
  return merged;
}
__name(mergeConsecutiveAssistantMessages, "mergeConsecutiveAssistantMessages");
var OpenAIContentConverter = {
  convertLlmToolParametersToOpenAI,
  convertLlmToolsToOpenAI,
  convertLlmRequestToOpenAI,
  convertLlmResponseToOpenAI,
  convertOpenAIResponseToLlm,
  convertOpenAIChunkToLlm
};

// packages/core/src/core/openaiContentGenerator/requestCaptureContext.ts
init_esbuild_shims();
import { AsyncLocalStorage } from "node:async_hooks";
var openaiRequestCaptureContext = new AsyncLocalStorage();

export {
  TaggedThinkingParser,
  OpenAIContentConverter,
  openaiRequestCaptureContext
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
