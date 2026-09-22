// Force strict mode and setup for ESM
"use strict";
import {
  getResponsesMessage
} from "./chunk-Z72PLR74.js";
import {
  extractTextFromContents
} from "./chunk-AYEJOTIU.js";
import {
  safeJsonParse,
  setGenAiUsageProvenance
} from "./chunk-BA6AXQDA.js";
import {
  sanitizeMimeForPlaceholder
} from "./chunk-NUQ4GK5I.js";
import {
  createOpenAIReasoningThoughtPart
} from "./chunk-KP2FHIFR.js";
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_MAX_LIFETIME_MS,
  DISABLED_REQUEST_TIMEOUT_MS,
  MAX_STREAM_GUARD_TIMEOUT_MS,
  QWEN_STREAM_IDLE_TIMEOUT_MS_ENV,
  QWEN_STREAM_MAX_LIFETIME_MS_ENV,
  buildSessionAwareFetch,
  getEffectiveReasoning,
  normalizeOpenAiWireBaseUrl,
  resolveReasoningForModel,
  resolveRequestTimeout
} from "./chunk-TLS6QN2S.js";
import {
  ResponsesHttpError
} from "./chunk-MS4SXNJ6.js";
import {
  reconcileMaxTokens
} from "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import {
  buildRuntimeFetchOptions,
  redactProxyCredentials,
  redactProxyError
} from "./chunk-SBP43AO6.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  FinishReason,
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

// packages/core/src/core/openaiResponsesContentGenerator/index.ts
init_esbuild_shims();

// packages/core/src/core/openaiResponsesContentGenerator/responses-pipeline.ts
init_esbuild_shims();

// packages/core/src/core/openaiResponsesContentGenerator/responses-converter.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("RESPONSES_CONVERTER");
var SUPPORTED_RESPONSE_IMAGE_MIME_TYPES = /* @__PURE__ */ new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
]);
function isSupportedResponseImageMime(mimeType) {
  return mimeType !== void 0 && SUPPORTED_RESPONSE_IMAGE_MIME_TYPES.has(mimeType);
}
__name(isSupportedResponseImageMime, "isSupportedResponseImageMime");
function placeholderMimeType(mimeType) {
  const sanitized = mimeType ? sanitizeMimeForPlaceholder(mimeType) : "";
  return sanitized || "unknown mime type";
}
__name(placeholderMimeType, "placeholderMimeType");
var RESPONSES_ERROR_CODE_TO_STATUS = {
  server_error: 500,
  rate_limit_exceeded: 429
};
function makeResponsesStreamError(message, code, type) {
  const err = new Error(message);
  err.type = type ?? code;
  if (code) {
    err.code = code;
    const status = RESPONSES_ERROR_CODE_TO_STATUS[code];
    if (status !== void 0) err.status = status;
  }
  return err;
}
__name(makeResponsesStreamError, "makeResponsesStreamError");
function encodeReasoningSignature(payload) {
  return JSON.stringify(payload);
}
__name(encodeReasoningSignature, "encodeReasoningSignature");
function decodeReasoningSignature(signature) {
  if (!signature) return void 0;
  try {
    const parsed = JSON.parse(signature);
    if (typeof parsed.id === "string" && typeof parsed.encrypted_content === "string") {
      return { id: parsed.id, encrypted_content: parsed.encrypted_content };
    }
  } catch {
  }
  return void 0;
}
__name(decodeReasoningSignature, "decodeReasoningSignature");
var ResponsesStreamState = class {
  static {
    __name(this, "ResponsesStreamState");
  }
  responseId = null;
  messages = /* @__PURE__ */ new Map();
  updateMessage(index, item) {
    const metadata = this.messages.get(index) ?? { id: item.id };
    if (item.phase === "commentary" || item.phase === "final_answer") {
      metadata.phase = item.phase;
    }
    this.messages.set(index, metadata);
  }
  textPart(data) {
    if (data.output_index !== void 0 && data.item_id && !this.messages.has(data.output_index)) {
      this.updateMessage(data.output_index, { id: data.item_id });
    }
    const metadata = data.output_index === void 0 ? void 0 : this.messages.get(data.output_index);
    const part = { text: data.delta };
    if (metadata) part.responsesMessage = metadata;
    return part;
  }
  funcCallArgs = /* @__PURE__ */ new Map();
  getFunctionCallBuffer(outputIndex) {
    return this.funcCallArgs.get(outputIndex);
  }
  initFunctionCall(outputIndex, _id, callId, name) {
    this.funcCallArgs.set(outputIndex, { id: callId, name, args: "" });
  }
  appendFunctionCallArgs(outputIndex, delta) {
    const buf = this.funcCallArgs.get(outputIndex);
    if (buf) buf.args += delta;
  }
};
function convertResponsesEventToGemini(event, model, state) {
  switch (event.event) {
    case "response.created": {
      const raw = event.data;
      const envelope = raw["response"] ?? raw;
      if (envelope.id) {
        state.responseId = envelope.id;
      }
      return null;
    }
    case "response.in_progress":
      return null;
    case "response.output_item.added": {
      const data = event.data;
      if (data.item.type === "function_call") {
        const fc = data.item;
        state.initFunctionCall(data.output_index, fc.id, fc.call_id, fc.name);
      } else if (data.item.type === "message") {
        state.updateMessage(data.output_index, data.item);
      }
      return null;
    }
    case "response.output_text.delta": {
      const data = event.data;
      return makeChunkResponse(model, state, [state.textPart(data)]);
    }
    case "response.refusal.delta": {
      const data = event.data;
      return makeChunkResponse(model, state, [state.textPart(data)]);
    }
    case "response.refusal.done":
      return null;
    case "response.reasoning_text.delta": {
      const data = event.data;
      return makeChunkResponse(model, state, [
        createOpenAIReasoningThoughtPart(data.delta)
      ]);
    }
    case "response.reasoning_summary_text.delta": {
      const data = event.data;
      return makeChunkResponse(model, state, [
        { text: data.delta, thought: true }
      ]);
    }
    case "response.function_call_arguments.delta": {
      const data = event.data;
      state.appendFunctionCallArgs(data.output_index, data.delta);
      return null;
    }
    case "response.output_item.done": {
      const data = event.data;
      if (data.item.type === "message") {
        state.updateMessage(data.output_index, data.item);
        return null;
      }
      if (data.item.type === "function_call") {
        const fc = data.item;
        const buf = state.getFunctionCallBuffer(data.output_index);
        const id = buf?.id ?? fc.call_id;
        const name = buf?.name ?? fc.name;
        const rawArgs = buf?.args || fc.arguments;
        let args = {};
        try {
          args = JSON.parse(rawArgs);
        } catch {
          const authoritative = fc.arguments && fc.arguments !== rawArgs ? fc.arguments : rawArgs;
          args = safeJsonParse(authoritative, {});
        }
        if (typeof args !== "object" || args === null || Array.isArray(args)) {
          const authoritative = fc.arguments && fc.arguments !== rawArgs ? safeJsonParse(fc.arguments, void 0) : void 0;
          args = authoritative && typeof authoritative === "object" && !Array.isArray(authoritative) ? authoritative : {};
        }
        return makeChunkResponse(model, state, [
          {
            functionCall: {
              id,
              name,
              args
            }
          }
        ]);
      }
      if (data.item.type === "reasoning") {
        const reasoningItem = data.item;
        const encryptedContent = reasoningItem.encrypted_content;
        if (!encryptedContent) return null;
        return makeChunkResponse(model, state, [
          {
            thought: true,
            thoughtSignature: encodeReasoningSignature({
              id: reasoningItem.id,
              encrypted_content: encryptedContent
            })
          }
        ]);
      }
      return null;
    }
    case "response.completed": {
      const raw = event.data;
      const output = (raw["response"] ?? raw).output;
      output?.forEach((item, index) => {
        if (item.type === "message") state.updateMessage(index, item);
      });
      const envelope = raw["response"] ?? raw;
      if (envelope.id) state.responseId = envelope.id;
      return makeFinalResponse(model, state, envelope.usage, "stop");
    }
    case "response.failed": {
      const raw = event.data;
      const envelope = raw["response"] ?? raw;
      const errMsg = envelope.error ? `${envelope.error.code}: ${envelope.error.message}` : "Response failed";
      throw makeResponsesStreamError(
        `Responses API failed: ${errMsg}`,
        envelope.error?.code,
        envelope.error?.type
      );
    }
    case "response.incomplete": {
      const raw = event.data;
      const envelope = raw["response"] ?? raw;
      envelope.output?.forEach((item, index) => {
        if (item.type === "message") state.updateMessage(index, item);
      });
      if (envelope.id) state.responseId = envelope.id;
      return makeFinalResponse(
        model,
        state,
        envelope.usage,
        envelope.incomplete_details?.reason ?? "max_output_tokens"
      );
    }
    case "error": {
      const data = event.data;
      const code = data.error?.code ?? data.code;
      const message = data.error?.message ?? data.message;
      const detail = [code, message].filter(Boolean).join(": ") || data.error?.type || "Unknown error";
      throw makeResponsesStreamError(
        `Responses API error: ${detail}`,
        code,
        data.error?.type
      );
    }
    default:
      return null;
  }
}
__name(convertResponsesEventToGemini, "convertResponsesEventToGemini");
function makeChunkResponse(model, state, parts, finishReason) {
  const candidate = {
    content: { parts, role: "model" },
    index: 0,
    safetyRatings: []
  };
  if (finishReason) {
    candidate.finishReason = mapFinishReason(finishReason);
  }
  const resp = new GenerateContentResponse();
  resp.candidates = [candidate];
  resp.responseId = state.responseId ?? void 0;
  resp.modelVersion = model;
  resp.createTime = Date.now().toString();
  resp.promptFeedback = { safetyRatings: [] };
  return resp;
}
__name(makeChunkResponse, "makeChunkResponse");
function makeFinalResponse(model, state, usage, finishReason) {
  const resp = makeChunkResponse(model, state, [], finishReason);
  if (usage) {
    resp.usageMetadata = {
      promptTokenCount: usage.input_tokens,
      candidatesTokenCount: usage.output_tokens,
      totalTokenCount: usage.total_tokens,
      thoughtsTokenCount: usage.output_tokens_details?.reasoning_tokens ?? 0,
      cachedContentTokenCount: usage.input_tokens_details?.cached_tokens ?? 0
    };
    setGenAiUsageProvenance(resp.usageMetadata, {
      cachedInputTokensReported: typeof usage.input_tokens_details?.cached_tokens === "number"
    });
  }
  return resp;
}
__name(makeFinalResponse, "makeFinalResponse");
function mapFinishReason(reason) {
  const mapping = {
    stop: FinishReason.STOP,
    length: FinishReason.MAX_TOKENS,
    content_filter: FinishReason.SAFETY,
    max_output_tokens: FinishReason.MAX_TOKENS
  };
  return mapping[reason] ?? FinishReason.STOP;
}
__name(mapFinishReason, "mapFinishReason");
function convertGeminiContentsToResponsesInput(request) {
  let instructions;
  const items = [];
  let callIdCounter = 0;
  if (request.config?.systemInstruction) {
    const si = request.config.systemInstruction;
    if (typeof si === "string") {
      instructions = si;
    } else if (typeof si === "object" && "parts" in si && Array.isArray(si.parts)) {
      instructions = si.parts.map((p) => typeof p === "string" ? p : p.text ?? "").join("\n");
    }
  }
  const contents = request.contents;
  if (!contents) return { instructions, input: items };
  const contentArray = Array.isArray(contents) ? contents : typeof contents === "string" ? [{ role: "user", parts: [{ text: contents }] }] : [contents];
  for (const content of contentArray) {
    if (typeof content === "string") {
      items.push({
        type: "message",
        role: "user",
        content
      });
      continue;
    }
    const role = content.role === "model" ? "assistant" : "user";
    const parts = content.parts ?? [];
    let pendingContentParts = [];
    let pendingMessage;
    const pendingToolMediaParts = [];
    const flushPendingMessage = /* @__PURE__ */ __name(() => {
      if (pendingContentParts.length === 0) return;
      const content2 = pendingContentParts.length === 1 && pendingContentParts[0].type === "input_text" ? pendingContentParts[0].text : pendingContentParts;
      items.push({
        type: "message",
        role,
        content: content2,
        ...role === "assistant" && pendingMessage?.phase ? { phase: pendingMessage.phase } : {}
      });
      pendingContentParts = [];
      pendingMessage = void 0;
    }, "flushPendingMessage");
    for (const part of parts) {
      if (typeof part === "string") {
        if (pendingMessage) flushPendingMessage();
        pendingContentParts.push({ type: "input_text", text: part });
        continue;
      }
      if ("thought" in part && part.thought) {
        flushPendingMessage();
        if (role === "assistant") {
          const payload = decodeReasoningSignature(part.thoughtSignature);
          if (payload) {
            items.push({
              type: "reasoning",
              id: payload.id,
              encrypted_content: payload.encrypted_content,
              summary: part.text ? [{ type: "summary_text", text: part.text }] : []
            });
          } else if (part.text) {
            debugLogger.warn(
              "Dropping unreplayable reasoning signature; preserving summary text as a plain message"
            );
            items.push({
              type: "message",
              role: "assistant",
              content: part.text
            });
          }
        }
        continue;
      }
      if ("text" in part && part.text) {
        const metadata = role === "assistant" ? getResponsesMessage(part) : void 0;
        if (pendingMessage?.id !== metadata?.id || pendingMessage?.phase !== metadata?.phase) {
          flushPendingMessage();
        }
        pendingMessage = metadata;
        pendingContentParts.push({ type: "input_text", text: part.text });
      }
      if ("functionCall" in part && part.functionCall) {
        flushPendingMessage();
        const callId = part.functionCall.id || `call_${Date.now()}_${callIdCounter++}`;
        items.push({
          type: "function_call",
          call_id: callId,
          name: part.functionCall.name ?? "",
          arguments: JSON.stringify(part.functionCall.args ?? {})
        });
      }
      if ("functionResponse" in part && part.functionResponse) {
        flushPendingMessage();
        const fr = part.functionResponse;
        const responseRecord = fr.response;
        let output;
        if (typeof fr.response === "string") {
          output = fr.response;
        } else if (typeof responseRecord?.["output"] === "string") {
          output = responseRecord["output"];
        } else if (typeof responseRecord?.["error"] === "string") {
          output = responseRecord["error"];
        } else {
          output = JSON.stringify(fr.response ?? {});
        }
        for (const frPart of fr.parts ?? []) {
          if ("text" in frPart && typeof frPart.text === "string" && frPart.text.length > 0) {
            const text = frPart.text;
            output += (output ? "\n" : "") + text;
          } else if (frPart.inlineData) {
            const mimeType = frPart.inlineData.mimeType;
            if (isSupportedResponseImageMime(mimeType)) {
              pendingToolMediaParts.push({
                type: "input_image",
                image_url: `data:${mimeType};base64,${frPart.inlineData.data}`
              });
            } else {
              const placeholderMime = placeholderMimeType(mimeType);
              debugLogger.warn(
                `Dropping unsupported tool-result inline media type: ${placeholderMime}`
              );
              pendingToolMediaParts.push({
                type: "input_text",
                text: `[Unsupported tool-result media type: ${placeholderMime}]`
              });
            }
          } else if (frPart.fileData) {
            const placeholderMime = placeholderMimeType(
              frPart.fileData.mimeType
            );
            debugLogger.warn(
              `Dropping unsupported tool-result file reference: ${placeholderMime}`
            );
            pendingToolMediaParts.push({
              type: "input_text",
              text: `[Unsupported tool-result file reference: ${placeholderMime}]`
            });
          }
        }
        items.push({
          type: "function_call_output",
          call_id: fr.id || `call_${Date.now()}_${callIdCounter++}`,
          output
        });
      }
      if ("inlineData" in part && part.inlineData && role === "user") {
        const mimeType = part.inlineData.mimeType;
        if (isSupportedResponseImageMime(mimeType)) {
          pendingContentParts.push({
            type: "input_image",
            image_url: `data:${mimeType};base64,${part.inlineData.data}`
          });
        } else {
          pendingContentParts.push({
            type: "input_text",
            text: `[Unsupported inline media type: ${placeholderMimeType(mimeType)}]`
          });
        }
      }
      if ("fileData" in part && part.fileData && role === "user") {
        pendingContentParts.push({
          type: "input_text",
          text: `[Unsupported file reference: ${placeholderMimeType(part.fileData.mimeType)}]`
        });
      }
    }
    flushPendingMessage();
    if (pendingToolMediaParts.length > 0) {
      items.push({
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "(attached media from previous tool call)"
          },
          ...pendingToolMediaParts
        ]
      });
    }
  }
  return { instructions, input: items };
}
__name(convertGeminiContentsToResponsesInput, "convertGeminiContentsToResponsesInput");
function cleanOrphanedFunctionCalls(items) {
  const callIds = /* @__PURE__ */ new Set();
  const outputCallIds = /* @__PURE__ */ new Set();
  for (const item of items) {
    if (typeof item !== "object" || item === null || !("type" in item)) {
      continue;
    }
    if (item.type === "function_call" && "call_id" in item) {
      callIds.add(item.call_id);
    } else if (item.type === "function_call_output" && "call_id" in item) {
      outputCallIds.add(item.call_id);
    }
  }
  return items.filter((item) => {
    if (typeof item !== "object" || item === null || !("type" in item)) {
      return true;
    }
    if (item.type === "function_call" && "call_id" in item) {
      return outputCallIds.has(item.call_id);
    }
    if (item.type === "function_call_output" && "call_id" in item) {
      return callIds.has(item.call_id);
    }
    return true;
  });
}
__name(cleanOrphanedFunctionCalls, "cleanOrphanedFunctionCalls");
function convertGeminiToolsToResponsesTools(request) {
  const tools = request.config?.tools;
  if (!tools || !Array.isArray(tools)) return void 0;
  const result = [];
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) continue;
    const funcDecls = "functionDeclarations" in tool ? tool.functionDeclarations : void 0;
    if (!Array.isArray(funcDecls)) continue;
    for (const func of funcDecls) {
      if (!func.name) continue;
      result.push({
        type: "function",
        name: func.name,
        description: func.description,
        parameters: normalizeResponsesParameters(
          // Prefer parametersJsonSchema (raw JSON Schema, e.g. MCP/extension
          // tools) and fall back to parameters, matching the Chat and
          // Anthropic sibling wires — @google/genai allows both fields at
          // once, and preferring `parameters` here would send a different,
          // potentially lossier schema than the siblings for identical config.
          func.parametersJsonSchema ?? func.parameters
        )
      });
    }
  }
  return result.length > 0 ? result : void 0;
}
__name(convertGeminiToolsToResponsesTools, "convertGeminiToolsToResponsesTools");
function normalizeResponsesParameters(schema) {
  if (schema === void 0) return void 0;
  if (schema === null || typeof schema !== "object") return schema;
  return normalizeResponsesSchemaNode(schema);
}
__name(normalizeResponsesParameters, "normalizeResponsesParameters");
function normalizeResponsesSchemaNode(node) {
  if (Array.isArray(node)) {
    return node.map((item) => normalizeResponsesSchemaNode(item));
  }
  if (!node || typeof node !== "object") return node;
  const out = {
    ...node
  };
  if (out["properties"] && typeof out["properties"] === "object") {
    const props = out["properties"];
    const nextProps = {};
    for (const [k, v] of Object.entries(props)) {
      nextProps[k] = normalizeResponsesSchemaNode(v);
    }
    out["properties"] = nextProps;
  }
  if (out["items"]) {
    out["items"] = normalizeResponsesSchemaNode(out["items"]);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const v = out[key];
    if (Array.isArray(v)) {
      out[key] = v.map((item) => normalizeResponsesSchemaNode(item));
    }
  }
  if (out["type"] === "object" && out["properties"] === void 0) {
    out["properties"] = {};
  }
  return out;
}
__name(normalizeResponsesSchemaNode, "normalizeResponsesSchemaNode");

// packages/core/src/core/openaiResponsesContentGenerator/responses-reasoning-rejection.ts
init_esbuild_shims();
var REJECTION_CODE = "string_above_max_length";
var PARAM_PATTERN = /^input\[(\d+)\]\.id$/;
var PARAM_REFERENCE_PATTERN = /input\[\d+\]\.id/g;
var MAXIMUM_LENGTH_PATTERN = /maximum length \d+/gi;
var SIMPLE_ESCAPES = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "	"
};
var REPAIRABLE_CONTROLS = /* @__PURE__ */ new Set(["\n", "	", "\r"]);
var MAX_BODY_CHARS = 64e3;
var MAX_OBJECT_CANDIDATES = 32;
function parseReasoningIdRejection(status, responseBody) {
  if (status !== 400) return void 0;
  try {
    return classify(responseBody);
  } catch {
    return void 0;
  }
}
__name(parseReasoningIdRejection, "parseReasoningIdRejection");
function classify(responseBody) {
  const text = toEnvelopeText(responseBody);
  if (text === void 0) return void 0;
  const envelope = readEnvelope(text, MAX_OBJECT_CANDIDATES, true);
  if (!envelope) return void 0;
  const error = readErrorMember(envelope.value);
  if (!error) return void 0;
  return matchRejection(error) ?? matchQuotedRejection(error, MAX_OBJECT_CANDIDATES - envelope.objects);
}
__name(classify, "classify");
function matchRejection(error) {
  if (error["code"] !== REJECTION_CODE) return void 0;
  const param = error["param"];
  if (typeof param !== "string") return void 0;
  const named = PARAM_PATTERN.exec(param);
  if (!named) return void 0;
  const index = Number(named[1]);
  if (!Number.isSafeInteger(index) || index < 0) return void 0;
  const message = error["message"];
  return {
    namedIndex: index,
    maxLength: extractMaxLength(
      typeof message === "string" ? message : void 0,
      param
    )
  };
}
__name(matchRejection, "matchRejection");
function matchQuotedRejection(error, budget) {
  const message = error["message"];
  if (typeof message !== "string") return void 0;
  const start = message.indexOf("{");
  if (start < 0) return void 0;
  const quoted = readEnvelope(message.slice(start), budget, false);
  if (!quoted) return void 0;
  const inner = readErrorMember(quoted.value);
  return inner ? matchRejection(inner) : void 0;
}
__name(matchQuotedRejection, "matchQuotedRejection");
function readErrorMember(value) {
  if (!isPlainObject(value)) return void 0;
  const error = value["error"];
  return isPlainObject(error) ? error : void 0;
}
__name(readErrorMember, "readErrorMember");
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isPlainObject, "isPlainObject");
function downgradeRejectedReasoningItems(items, rejection) {
  const named = items[rejection.namedIndex];
  if (!isReasoningItem(named)) return items;
  const { maxLength } = rejection;
  if (maxLength !== null && named.id.length <= maxLength) return items;
  const rewritten = [];
  let changed = false;
  for (const item of items) {
    if (!isReasoningItem(item) || !exceedsMax(item, maxLength)) {
      rewritten.push(item);
      continue;
    }
    changed = true;
    const summary = readSummaryTexts(item);
    if (summary.length === 0) continue;
    rewritten.push({
      type: "message",
      role: "assistant",
      content: summary.join("\n")
    });
  }
  return changed ? rewritten : items;
}
__name(downgradeRejectedReasoningItems, "downgradeRejectedReasoningItems");
function exceedsMax(item, maxLength) {
  return maxLength === null || item.id.length > maxLength;
}
__name(exceedsMax, "exceedsMax");
function isReasoningItem(item) {
  return typeof item === "object" && item !== null && item.type === "reasoning" && typeof item.id === "string";
}
__name(isReasoningItem, "isReasoningItem");
function readSummaryTexts(item) {
  if (!Array.isArray(item.summary)) return [];
  const texts = [];
  for (const entry of item.summary) {
    if (typeof entry === "object" && entry !== null && entry.type === "summary_text" && typeof entry.text === "string" && entry.text.length > 0) {
      texts.push(entry.text);
    }
  }
  return texts;
}
__name(readSummaryTexts, "readSummaryTexts");
function extractMaxLength(message, param) {
  if (!message) return null;
  const references = message.match(PARAM_REFERENCE_PATTERN);
  if (!references || references.length !== 1 || references[0] !== param) {
    return null;
  }
  const maxima = message.match(MAXIMUM_LENGTH_PATTERN);
  if (!maxima || maxima.length !== 1) return null;
  const digits = /\d+/.exec(maxima[0]);
  if (!digits) return null;
  const value = Number(digits[0]);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}
__name(extractMaxLength, "extractMaxLength");
function toEnvelopeText(responseBody) {
  let text;
  if (typeof responseBody === "string") {
    text = responseBody;
  } else if (typeof responseBody === "object" && responseBody !== null && !Array.isArray(responseBody)) {
    try {
      text = JSON.stringify(responseBody);
    } catch {
      return void 0;
    }
    if (typeof text !== "string") return void 0;
  } else {
    return void 0;
  }
  if (text.length > MAX_BODY_CHARS) return void 0;
  let start = 0;
  while (start < text.length && isJsonWhitespace(text[start])) start++;
  return text[start] === "{" ? text.slice(start) : void 0;
}
__name(toEnvelopeText, "toEnvelopeText");
function readEnvelope(text, budget, repairErrorMessage) {
  const normalized = normalizeEnvelope(text, budget, repairErrorMessage);
  if (!normalized) return void 0;
  try {
    return { value: JSON.parse(normalized.json), objects: normalized.objects };
  } catch {
    return void 0;
  }
}
__name(readEnvelope, "readEnvelope");
function normalizeEnvelope(text, budget, repairErrorMessage) {
  const out = [];
  const stack = [];
  let objects = 0;
  let closed = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (closed) {
      if (!isJsonWhitespace(ch)) return void 0;
      i++;
      continue;
    }
    if (ch === '"') {
      const top = stack[stack.length - 1];
      const atKey = top?.object === true && top.atKey;
      const repairable = repairErrorMessage && top?.object === true && !atKey && top.recognizedError && top.key === "message";
      const literal = readStringLiteral(text, i, repairable);
      if (!literal) return void 0;
      if (top?.object && top.atKey) {
        if (top.keys.has(literal.value)) return void 0;
        top.keys.add(literal.value);
        top.atKey = false;
        top.key = literal.value;
      }
      out.push(literal.json);
      i = literal.next;
      continue;
    }
    if (ch === "{" || ch === "[") {
      const object = ch === "{";
      if (object && ++objects > budget) return void 0;
      const parent = stack[stack.length - 1];
      stack.push({
        object,
        keys: /* @__PURE__ */ new Set(),
        recognizedError: object && stack.length === 1 && parent?.object === true && parent.key === "error",
        atKey: object,
        key: void 0
      });
    } else if (ch === "}" || ch === "]") {
      const top = stack.pop();
      if (!top || top.object !== (ch === "}")) return void 0;
      if (stack.length === 0) closed = true;
    } else if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top?.object) {
        top.atKey = true;
        top.key = void 0;
      }
    }
    out.push(ch);
    i++;
  }
  if (!closed || stack.length > 0) return void 0;
  return { json: out.join(""), objects };
}
__name(normalizeEnvelope, "normalizeEnvelope");
function isJsonWhitespace(ch) {
  return ch === " " || ch === "	" || ch === "\n" || ch === "\r";
}
__name(isJsonWhitespace, "isJsonWhitespace");
function readStringLiteral(text, start, repairable) {
  let value = "";
  let json = '"';
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') return { value, json: `${json}"`, next: i + 1 };
    if (ch === "\\") {
      const escape = text[i + 1];
      if (escape === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return void 0;
        value += String.fromCharCode(parseInt(hex, 16));
        json += text.slice(i, i + 6);
        i += 6;
        continue;
      }
      const simple = escape === void 0 ? void 0 : SIMPLE_ESCAPES[escape];
      if (simple === void 0) return void 0;
      value += simple;
      json += `\\${escape}`;
      i += 2;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 32) {
      if (!repairable || !REPAIRABLE_CONTROLS.has(ch)) return void 0;
      value += ch;
      json += `\\u${code.toString(16).padStart(4, "0")}`;
      i++;
      continue;
    }
    value += ch;
    json += ch;
    i++;
  }
  return void 0;
}
__name(readStringLiteral, "readStringLiteral");
function countReasoningItems(items) {
  return items.filter(isReasoningItem).length;
}
__name(countReasoningItems, "countReasoningItems");
function isEncryptedReasoningRejection(status, responseBody) {
  if (status !== 400 || responseBody.length > MAX_BODY_CHARS) return false;
  const text = toEnvelopeText(responseBody.replace(/^data: ?/, ""));
  if (!text) return false;
  const envelope = readEnvelope(text, MAX_OBJECT_CANDIDATES, false);
  if (!envelope || !isPlainObject(envelope.value)) return false;
  const direct = readErrorMember(envelope.value);
  if (direct) return direct["code"] === "invalid_encrypted_content";
  const gateway = envelope.value["routify_response"];
  if (!isPlainObject(gateway) || gateway["success"] !== false || gateway["status"] !== 400)
    return false;
  const error = readErrorMember(gateway["error_detail"]);
  return error?.["code"] === "invalid_encrypted_content";
}
__name(isEncryptedReasoningRejection, "isEncryptedReasoningRejection");
function downgradeEncryptedReasoningItems(items) {
  return downgradeRejectedReasoningItems(items, {
    namedIndex: items.findIndex(isReasoningItem),
    maxLength: null
  });
}
__name(downgradeEncryptedReasoningItems, "downgradeEncryptedReasoningItems");

// packages/core/src/core/openaiResponsesContentGenerator/responses-pipeline.ts
import { createHash } from "node:crypto";
var debugLogger2 = createDebugLogger("RESPONSES_PIPELINE");
var StreamInactivityTimeoutError = class extends Error {
  constructor(idleMs, chunksReceived) {
    super(
      `No stream activity for ${idleMs}ms after ${chunksReceived} chunks. Set ${QWEN_STREAM_IDLE_TIMEOUT_MS_ENV} to increase this window (or 0 to disable it).`
    );
    this.idleMs = idleMs;
    this.chunksReceived = chunksReceived;
    this.name = "StreamInactivityTimeoutError";
  }
  static {
    __name(this, "StreamInactivityTimeoutError");
  }
  code = "ETIMEDOUT";
};
var StreamLifetimeExceededError = class extends Error {
  constructor(maxLifetimeMs, chunksReceived) {
    super(
      `Stream exceeded its ${maxLifetimeMs}ms upstream-wait cap after ${chunksReceived} chunks. Set ${QWEN_STREAM_MAX_LIFETIME_MS_ENV} to increase this window (or 0 to disable it).`
    );
    this.maxLifetimeMs = maxLifetimeMs;
    this.chunksReceived = chunksReceived;
    this.name = "StreamLifetimeExceededError";
  }
  static {
    __name(this, "StreamLifetimeExceededError");
  }
  code = "ETIMEDOUT";
};
var StreamConnectTimeoutError = class extends Error {
  constructor(connectTimeoutMs) {
    super(
      `Responses API connect phase exceeded ${connectTimeoutMs}ms before any response headers arrived. Increase the model request timeout (or set it to 0 to disable this bound).`
    );
    this.connectTimeoutMs = connectTimeoutMs;
    this.name = "StreamConnectTimeoutError";
  }
  static {
    __name(this, "StreamConnectTimeoutError");
  }
  code = "ETIMEDOUT";
};
var ErrorBodyTimeoutError = class extends Error {
  constructor(bodyTimeoutMs, status) {
    super(
      `Responses API error response body (HTTP ${status}) did not complete within ${bodyTimeoutMs}ms. Increase the model request timeout (or set it to 0 to disable this bound).`
    );
    this.bodyTimeoutMs = bodyTimeoutMs;
    this.status = status;
    this.name = "ErrorBodyTimeoutError";
  }
  static {
    __name(this, "ErrorBodyTimeoutError");
  }
  code = "ETIMEDOUT";
};
function newAbortError() {
  const abortErr = new Error("Aborted");
  abortErr.name = "AbortError";
  return abortErr;
}
__name(newAbortError, "newAbortError");
var CLASSIFIABLE_ERROR_BODY_CHARS = 64e3;
var MAX_ERROR_BODY_CHARS = CLASSIFIABLE_ERROR_BODY_CHARS + 1;
function resolveStreamGuardMs(fromConfig, configLabel, envName, defaultMs) {
  if (typeof fromConfig === "number") {
    if (Number.isInteger(fromConfig) && fromConfig <= MAX_STREAM_GUARD_TIMEOUT_MS) {
      return fromConfig;
    }
    console.warn(
      `[qwen-code] Ignoring out-of-range ${configLabel}=${fromConfig} (expected an integer in (-\u221E, ${MAX_STREAM_GUARD_TIMEOUT_MS}]); falling back to ${envName}/default.`
    );
  }
  const raw = process.env[envName];
  const trimmed = raw?.trim();
  if (trimmed) {
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (parsed <= MAX_STREAM_GUARD_TIMEOUT_MS) {
        return parsed;
      }
    }
    console.warn(
      `[qwen-code] Ignoring invalid ${envName}="${raw}" (expected an integer of milliseconds in [0, ${MAX_STREAM_GUARD_TIMEOUT_MS}]); using default ${defaultMs}ms.`
    );
  }
  return defaultMs;
}
__name(resolveStreamGuardMs, "resolveStreamGuardMs");
function resolveStreamIdleTimeoutMs(config) {
  return resolveStreamGuardMs(
    config.streamIdleTimeoutMs,
    "streamIdleTimeoutMs",
    QWEN_STREAM_IDLE_TIMEOUT_MS_ENV,
    DEFAULT_STREAM_IDLE_TIMEOUT_MS
  );
}
__name(resolveStreamIdleTimeoutMs, "resolveStreamIdleTimeoutMs");
function resolveStreamMaxLifetimeMs(config) {
  return resolveStreamGuardMs(
    config.streamMaxLifetimeMs,
    "streamMaxLifetimeMs",
    QWEN_STREAM_MAX_LIFETIME_MS_ENV,
    DEFAULT_STREAM_MAX_LIFETIME_MS
  );
}
__name(resolveStreamMaxLifetimeMs, "resolveStreamMaxLifetimeMs");
var ResponsesPipeline = class {
  static {
    __name(this, "ResponsesPipeline");
  }
  config;
  cliConfig;
  // Resolved once (config field > env > default) so the env read happens per
  // pipeline, not per streaming request.
  streamIdleTimeoutMs;
  // Total-lifetime cap for a single streaming response (accumulated
  // upstream-wait, never reset by chunk arrival). Companion to the idle
  // watchdog -- see StreamLifetimeExceededError / issue #8597.
  streamMaxLifetimeMs;
  // Connect-phase timeout (ms). Honors ContentGeneratorConfig.timeout the same
  // way the embed client does, via resolveRequestTimeout: undefined -> default,
  // `0`/negative -> disabled.
  connectTimeoutMs;
  constructor(config, cliConfig) {
    this.config = config;
    this.cliConfig = cliConfig;
    this.streamIdleTimeoutMs = resolveStreamIdleTimeoutMs(config);
    this.streamMaxLifetimeMs = resolveStreamMaxLifetimeMs(config);
    this.connectTimeoutMs = resolveRequestTimeout(config.timeout);
  }
  async *executeStream(request, userPromptId, signal) {
    yield* await this.connectStream(request, userPromptId, signal);
  }
  /**
   * Eagerly performs the connect phase (fetch + non-2xx handling + content-type
   * guard) and returns a lazy generator over the response body. Callers that
   * wrap the returned promise in retryWithBackoff (index.ts's
   * generateContentStream) then see connection-time HTTP errors -- a 500/502/504
   * or a 429 storm -- surface from the awaited promise and get retried, instead
   * of the errors escaping later during lazy iteration outside the retry
   * wrapper (a lazy `async *` generator resolves its promise before any network
   * I/O runs).
   */
  async connectStream(request, userPromptId, signal) {
    const activeRequest = this.buildRequest(request, userPromptId);
    const reader = await this.connectWithReasoningReplayRecovery(
      activeRequest,
      signal
    );
    return this.iterateBody(reader, new ResponsesStreamState(), signal);
  }
  /**
   * Connect, and if the endpoint explicitly refuses a replayed reasoning item
   * id or encrypted content, send the same request once more with those items
   * downgraded (issue #9452).
   *
   * The first request always goes out exactly as built. Recovery matters
   * because the offending ids live in persisted history: without it, every
   * subsequent send in that session rebuilds the same ids and fails the same
   * way, so the session is permanently wedged against that endpoint.
   */
  async connectWithReasoningReplayRecovery(apiRequest, signal) {
    let retryRequest;
    try {
      return await this.connect(apiRequest, signal);
    } catch (error) {
      retryRequest = this.buildReasoningReplayRetry(apiRequest, error);
      if (!retryRequest) throw error;
    }
    return this.connect(retryRequest, signal);
  }
  /**
   * The retry request, or undefined when the error is not a reasoning replay
   * rejection or nothing in this body would change. Builds a new request
   * object -- the caller's request, the input array, and every item it holds
   * are left untouched.
   */
  buildReasoningReplayRetry(apiRequest, error) {
    if (typeof error !== "object" || error === null) return void 0;
    const { reasoningIdRejection: rejection } = error;
    const encryptedRejected = error.encryptedReasoningRejected;
    const input = rejection ? downgradeRejectedReasoningItems(apiRequest.input, rejection) : encryptedRejected ? downgradeEncryptedReasoningItems(apiRequest.input) : apiRequest.input;
    if (input === apiRequest.input) return void 0;
    const reasoningItems = countReasoningItems(apiRequest.input);
    debugLogger2.debug(
      "Retrying once with downgraded reasoning replay",
      `namedIndex=${rejection?.namedIndex ?? "all"}`,
      `maxLengthReported=${rejection?.maxLength != null}`,
      `reasoningItems=${reasoningItems}`,
      `downgradedItems=${reasoningItems - countReasoningItems(input)}`
    );
    return { ...apiRequest, input };
  }
  async execute(request, userPromptId, signal) {
    const chunks = [];
    for await (const chunk of this.executeStream(
      request,
      userPromptId,
      signal
    )) {
      chunks.push(chunk);
    }
    return mergeStreamResponses(chunks);
  }
  /**
   * Key the OpenAI prefix cache on the SESSION, not the turn.
   *
   * `userPromptId` is `${sessionId}########${counter}` -- it changes on every
   * send, so using it directly gives each turn its own cache namespace and no
   * request in a session can ever hit the prefix cache written by the one
   * before it. Nothing fails when that happens; the cost is silent, which is
   * why it survived until review.
   *
   * Matches the Chat wire's `applyOfficialOpenAIPromptCaching`
   * (openaiContentGenerator/prefix-caching.ts), which keys on
   * `qwen-code:${sessionId}` -- that landed on main in #8418 after this
   * branch forked, so the two wires would otherwise disagree on merge.
   *
   * `Config.getSessionId()` is typed `string`, so the guard below is for the
   * empty-string case only -- falling back to `userPromptId` there keeps a
   * per-request key rather than collapsing every session onto a bare
   * `qwen-code:` prefix.
   */
  buildPromptCacheKey(userPromptId) {
    const sessionId = this.cliConfig.getSessionId();
    return sanitizePromptCacheKey(
      sessionId ? `qwen-code:${sessionId}` : userPromptId
    );
  }
  buildRequest(request, userPromptId) {
    const { instructions, input } = convertGeminiContentsToResponsesInput(request);
    const tools = convertGeminiToolsToResponsesTools(request);
    const reasoning = this.buildReasoning(request);
    const apiRequest = {
      model: this.config.model,
      input: cleanOrphanedFunctionCalls(input),
      instructions,
      tools,
      stream: true,
      prompt_cache_key: this.buildPromptCacheKey(userPromptId),
      // We never reference previous_response_id, so server-side storage of
      // the response buys nothing. The spec pairs reasoning.encrypted_content
      // with store:false as the intended stateless-replay recipe -- set it
      // unconditionally for consistency, not just when reasoning is on.
      store: false
    };
    if (tools && tools.length > 0) {
      apiRequest.tool_choice = "auto";
      apiRequest.parallel_tool_calls = true;
      const fcMode = request.config?.toolConfig?.functionCallingConfig?.mode;
      if (fcMode === "ANY") {
        apiRequest.tool_choice = "required";
      } else if (fcMode === "NONE") {
        apiRequest.tool_choice = "none";
      }
    }
    if (reasoning) {
      apiRequest.reasoning = reasoning;
      apiRequest.include = ["reasoning.encrypted_content"];
    }
    const temperature = this.config.samplingParams?.temperature ?? request.config?.temperature;
    if (temperature != null) {
      apiRequest.temperature = temperature;
    }
    const topP = this.config.samplingParams?.top_p ?? request.config?.topP;
    if (topP != null) {
      apiRequest.top_p = topP;
    }
    const configMaxTokens = this.config.samplingParams?.max_tokens;
    const requestMaxTokens = request.config?.maxOutputTokens;
    const maxOut = reconcileMaxTokens(configMaxTokens, requestMaxTokens) ?? configMaxTokens ?? requestMaxTokens;
    if (maxOut != null) {
      apiRequest.max_output_tokens = maxOut;
    }
    if (this.config.extra_body) {
      const thinkingOptOut = request.config?.thinkingConfig?.includeThoughts === false;
      const requestRecord = apiRequest;
      for (const [key, value] of Object.entries(this.config.extra_body)) {
        if (key === "enable_thinking") continue;
        if (thinkingOptOut && (key === "reasoning" || key === "include")) {
          continue;
        }
        if (!(key in requestRecord) || requestRecord[key] === void 0) {
          requestRecord[key] = value;
        }
      }
    }
    return apiRequest;
  }
  buildReasoning(request) {
    if (request.config?.thinkingConfig?.includeThoughts === false) {
      return void 0;
    }
    const r = this.config.reasoning === void 0 && this.config.extra_body?.["reasoning"] !== void 0 ? void 0 : getEffectiveReasoning(
      this.config,
      resolveReasoningForModel(
        this.cliConfig,
        this.config,
        request.model
      )
    );
    if (r === false) return void 0;
    const legacyEnableThinking = this.config.extra_body?.["enable_thinking"];
    if (r === void 0 && legacyEnableThinking !== true) return void 0;
    const reasoning = {};
    if (r?.effort) {
      reasoning.effort = r.effort;
    } else if (legacyEnableThinking === true) {
      reasoning.effort = "medium";
    }
    if (reasoning.effort) {
      reasoning.summary = "auto";
    }
    return Object.keys(reasoning).length > 0 ? reasoning : void 0;
  }
  /**
   * Connect phase: build and send the request, validate the HTTP response, and
   * return a reader over the SSE body. Eagerly awaited so connection-time
   * failures (non-2xx, missing body, non-SSE content-type, transport errors)
   * reject the promise the caller can wrap in retryWithBackoff.
   */
  async connect(apiRequest, signal) {
    const baseUrl = normalizeOpenAiWireBaseUrl(this.config.baseUrl);
    const url = `${baseUrl}/v1/responses`;
    const version = this.cliConfig.getCliVersion() || "unknown";
    const headers = {
      "content-type": "application/json",
      accept: "text/event-stream",
      // The same stamp the Chat wire sends (openaiContentGenerator/provider/
      // default.ts buildHeaders). This wire assembles its request by hand, so
      // without it the gateway sees the transport's default agent string and
      // cannot attribute the traffic to Qwen Code (issue #11936). Placed
      // before the customHeaders merge below so a user-configured
      // `User-Agent` still overrides it, as it does on every other wire.
      "user-agent": `QwenCode/${version} (${process.platform}; ${process.arch})`
    };
    const apiKey = this.config.apiKey ?? (this.config.apiKeyEnvKey ? process.env[this.config.apiKeyEnvKey] : void 0);
    if (apiKey) {
      headers["authorization"] = `Bearer ${apiKey}`;
    }
    if (this.config.customHeaders) {
      for (const [name, value] of Object.entries(this.config.customHeaders)) {
        headers[name.toLowerCase()] = value;
      }
    }
    const body = JSON.stringify(apiRequest);
    debugLogger2.debug(
      `POST ${redactProxyCredentials(url)}`,
      `bodyBytes=${body.length}`,
      `inputItems=${summarizeInputItemTypes(apiRequest.input)}`
    );
    const connectController = new AbortController();
    if (signal) {
      if (signal.aborted) {
        connectController.abort();
      } else {
        signal.addEventListener("abort", () => connectController.abort(), {
          once: true
        });
      }
    }
    const fetchOpts = {
      method: "POST",
      headers,
      body,
      signal: connectController.signal
    };
    const runtimeOptions = buildRuntimeFetchOptions(
      "openai",
      this.cliConfig.getProxy()
    );
    if (runtimeOptions?.fetchOptions?.dispatcher) {
      fetchOpts.dispatcher = runtimeOptions.fetchOptions.dispatcher;
    }
    const pinnedFetch = runtimeOptions?.fetch ?? fetch;
    const fetchFn = buildSessionAwareFetch(
      pinnedFetch,
      this.cliConfig,
      this.config.customHeaders
    );
    const connectTimeoutMs = this.connectTimeoutMs;
    const timeoutActive = connectTimeoutMs > 0 && connectTimeoutMs < DISABLED_REQUEST_TIMEOUT_MS;
    let response;
    if (timeoutActive) {
      let timer;
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          if (signal?.aborted) {
            const abortErr = new Error("Aborted");
            abortErr.name = "AbortError";
            reject(abortErr);
          } else {
            connectController.abort();
            reject(new StreamConnectTimeoutError(connectTimeoutMs));
          }
        }, connectTimeoutMs);
        timer.unref?.();
      });
      try {
        response = await Promise.race([
          fetchFn(url, fetchOpts),
          timeout
        ]);
      } catch (error) {
        throw redactProxyError(error);
      } finally {
        if (timer !== void 0) clearTimeout(timer);
      }
    } else {
      try {
        response = await fetchFn(url, fetchOpts);
      } catch (error) {
        throw redactProxyError(error);
      }
    }
    if (!response.ok) {
      const errBody = await this.readErrorResponseBody(
        response,
        signal,
        connectController
      );
      const rejection = parseReasoningIdRejection(response.status, errBody);
      let diagnosticBody = errBody.replace(
        /\\+\/?/g,
        (match) => match.endsWith("/") ? "/" : match
      );
      if (errBody.length > CLASSIFIABLE_ERROR_BODY_CHARS) {
        diagnosticBody = diagnosticBody.replace(/\/\/[^/\s]*$/, "//<redacted>");
      }
      diagnosticBody = redactProxyCredentials(diagnosticBody);
      const err = new ResponsesHttpError(
        response.status,
        diagnosticBody,
        response.headers,
        [
          apiKey,
          headers["authorization"],
          headers["authorization"]?.replace(/^Bearer\s+/i, ""),
          headers["api-key"]
        ]
      );
      err.reasoningIdRejection = rejection;
      err.encryptedReasoningRejected = isEncryptedReasoningRejection(
        response.status,
        errBody
      );
      throw redactProxyError(err);
    }
    if (!response.body) {
      throw new Error("Responses API returned no body");
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^\s*text\/event-stream\s*(?:;|$)/i.test(contentType)) {
      throw new Error(
        `Responses API returned non-SSE content-type: ${contentType || "<missing>"}`
      );
    }
    return response.body.getReader();
  }
  /**
   * Read a non-2xx response body under three bounds: the configured request
   * timeout, the caller's AbortSignal, and a character cap.
   *
   * The whole body is kept when it fits inside the cap, because
   * responses-reasoning-rejection.ts classifies from the complete envelope; a
   * body that hits the cap is returned one character over the classifier's
   * own ceiling, so recovery fails closed on it rather than acting on a
   * prefix. The excerpt the surfaced message quotes is capped separately by
   * the caller, and nothing here logs the body.
   *
   * On either bound the body is cancelled and the request aborted, so the
   * socket is freed instead of draining a body nobody will read.
   */
  async readErrorResponseBody(response, signal, requestController) {
    const timeoutMs = this.connectTimeoutMs;
    const bounded = timeoutMs > 0 && timeoutMs < DISABLED_REQUEST_TIMEOUT_MS;
    let rejectTermination;
    const termination = new Promise((_resolve, reject) => {
      rejectTermination = reject;
    });
    termination.catch(() => {
    });
    let timer;
    let onAbort;
    if (signal?.aborted) {
      rejectTermination(newAbortError());
    } else if (signal) {
      onAbort = /* @__PURE__ */ __name(() => rejectTermination(newAbortError()), "onAbort");
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (bounded) {
      timer = setTimeout(() => {
        rejectTermination(
          signal?.aborted ? newAbortError() : new ErrorBodyTimeoutError(timeoutMs, response.status)
        );
      }, timeoutMs);
      timer.unref?.();
    }
    const cleanup = /* @__PURE__ */ __name(() => {
      if (timer !== void 0) clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    }, "cleanup");
    const body = response.body;
    if (!body) {
      try {
        const text2 = await Promise.race([
          Promise.resolve(response.text()).catch(() => ""),
          termination
        ]);
        return text2.slice(0, MAX_ERROR_BODY_CHARS);
      } finally {
        cleanup();
      }
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let completed = false;
    try {
      while (text.length < MAX_ERROR_BODY_CHARS) {
        const readPromise = reader.read();
        let result;
        try {
          result = await Promise.race([readPromise, termination]);
        } catch (error) {
          void Promise.resolve(readPromise).catch(() => {
          });
          throw error;
        }
        if (result.done) {
          completed = true;
          break;
        }
        text += decoder.decode(result.value, { stream: true });
      }
      if (completed) text += decoder.decode();
      return text.slice(0, MAX_ERROR_BODY_CHARS);
    } finally {
      cleanup();
      void reader.cancel().catch(() => {
      });
      if (!completed) requestController.abort();
    }
  }
  /**
   * Body-iteration phase: lazily drain the SSE reader, parse frames, and yield
   * Gemini responses. Two guards wrap each `reader.read()`, mirroring the Chat
   * pipeline: an idle watchdog fails a silent mid-stream stall with a retryable
   * ETIMEDOUT (the timer resets on every chunk, so an actively streaming model
   * is never interrupted; `streamIdleTimeoutMs <= 0` disables it), and a
   * total-lifetime cap on accumulated upstream-wait (NOT reset by chunk
   * arrival) fails a drip-fed stream that keeps resetting the idle timer but
   * never completes (issue #8597; `streamMaxLifetimeMs <= 0` disables it).
   */
  async *iterateBody(reader, streamState, signal) {
    const idleMs = this.streamIdleTimeoutMs;
    const maxLifetimeMs = this.streamMaxLifetimeMs;
    let chunksReceived = 0;
    let upstreamMs = 0;
    const readChunk = /* @__PURE__ */ __name(() => {
      if (idleMs <= 0 && maxLifetimeMs <= 0) return reader.read();
      const remainingLifetimeMs = maxLifetimeMs > 0 ? maxLifetimeMs - upstreamMs : Number.POSITIVE_INFINITY;
      if (remainingLifetimeMs <= 0) {
        if (signal?.aborted) {
          const abortErr = new Error("Aborted");
          abortErr.name = "AbortError";
          return Promise.reject(abortErr);
        }
        return Promise.reject(
          new StreamLifetimeExceededError(maxLifetimeMs, chunksReceived)
        );
      }
      const readPromise = reader.read();
      const awaitedAt = performance.now();
      let timer;
      const timeout = new Promise((_resolve, reject) => {
        const idleIn = idleMs > 0 ? idleMs : Number.POSITIVE_INFINITY;
        const wait = Math.min(idleIn, remainingLifetimeMs);
        timer = setTimeout(
          () => {
            if (signal?.aborted) {
              const abortErr = new Error("Aborted");
              abortErr.name = "AbortError";
              reject(abortErr);
            } else if (remainingLifetimeMs <= idleIn) {
              reject(
                new StreamLifetimeExceededError(maxLifetimeMs, chunksReceived)
              );
            } else {
              reject(new StreamInactivityTimeoutError(idleMs, chunksReceived));
            }
          },
          Math.max(wait, 0)
        );
        timer.unref?.();
      });
      return Promise.race([readPromise, timeout]).then((result) => {
        upstreamMs += performance.now() - awaitedAt;
        return result;
      }).catch((err) => {
        void Promise.resolve(readPromise).catch(() => {
        });
        throw err;
      }).finally(() => {
        if (timer !== void 0) clearTimeout(timer);
      });
    }, "readChunk");
    const convertParsedFrame = /* @__PURE__ */ __name((eventType, data) => {
      const sseEvent = { event: eventType, data };
      return convertResponsesEventToGemini(
        sseEvent,
        this.config.model,
        streamState
      );
    }, "convertParsedFrame");
    const parseSSEFrame = /* @__PURE__ */ __name((eventType, dataStr) => {
      try {
        const data = JSON.parse(dataStr);
        return convertParsedFrame(eventType, data);
      } catch (err) {
        if (err instanceof SyntaxError) {
          debugLogger2.debug(
            `Failed to parse SSE data: ${dataStr.substring(0, 200)}`
          );
          return null;
        }
        throw redactProxyError(err);
      }
    }, "parseSSEFrame");
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEventType = null;
    let dataAccumulator = "";
    try {
      while (true) {
        const { done, value } = await readChunk();
        if (done) break;
        chunksReceived += 1;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEventType = line.slice(6).trim();
            dataAccumulator = "";
            continue;
          }
          if (line.startsWith("data:")) {
            const dataContent = line.slice(5).replace(/^ /, "");
            if (dataContent === "[DONE]") continue;
            if (currentEventType) {
              dataAccumulator += (dataAccumulator ? "\n" : "") + dataContent;
            } else {
              try {
                const data = JSON.parse(dataContent);
                const eventType = data["type"];
                if (eventType) {
                  const geminiResp = convertParsedFrame(eventType, data);
                  if (geminiResp) {
                    yield geminiResp;
                  }
                }
              } catch (err) {
                if (err instanceof SyntaxError) {
                  debugLogger2.debug(
                    `Failed to parse SSE data: ${dataContent.substring(0, 200)}`
                  );
                } else {
                  throw redactProxyError(err);
                }
              }
            }
            continue;
          }
          if (line.trim() === "" && currentEventType && dataAccumulator) {
            const geminiResp = parseSSEFrame(currentEventType, dataAccumulator);
            if (geminiResp) {
              yield geminiResp;
            }
            currentEventType = null;
            dataAccumulator = "";
          } else if (line.trim() === "") {
            currentEventType = null;
            dataAccumulator = "";
          }
        }
      }
      if (buffer.startsWith("data:")) {
        const dataContent = buffer.slice(5).replace(/^ /, "");
        if (dataContent !== "[DONE]") {
          if (currentEventType) {
            dataAccumulator += (dataAccumulator ? "\n" : "") + dataContent;
          } else {
            try {
              const data = JSON.parse(dataContent);
              const eventType = data["type"];
              if (eventType) {
                const geminiResp = convertParsedFrame(eventType, data);
                if (geminiResp) {
                  yield geminiResp;
                }
              }
            } catch (err) {
              if (err instanceof SyntaxError) {
                debugLogger2.debug(
                  `Failed to parse SSE data: ${dataContent.substring(0, 200)}`
                );
              } else {
                throw redactProxyError(err);
              }
            }
          }
        }
      }
      if (currentEventType && dataAccumulator) {
        const geminiResp = parseSSEFrame(currentEventType, dataAccumulator);
        if (geminiResp) {
          yield geminiResp;
        }
      }
    } finally {
      await reader.cancel().catch(() => {
      });
      reader.releaseLock();
    }
  }
};
var PROMPT_CACHE_KEY_MAX_LENGTH = 64;
function sanitizePromptCacheKey(key) {
  if (key.length <= PROMPT_CACHE_KEY_MAX_LENGTH) return key;
  return createHash("sha256").update(key).digest("hex").slice(0, PROMPT_CACHE_KEY_MAX_LENGTH);
}
__name(sanitizePromptCacheKey, "sanitizePromptCacheKey");
function summarizeInputItemTypes(items) {
  const counts = /* @__PURE__ */ new Map();
  for (const item of items) {
    counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  }
  return [...counts.entries()].map(([type, count]) => `${type}=${count}`).join(",");
}
__name(summarizeInputItemTypes, "summarizeInputItemTypes");
function mergeStreamResponses(chunks) {
  if (chunks.length === 0) {
    const empty = new GenerateContentResponse();
    empty.candidates = [];
    return empty;
  }
  if (chunks.length === 1) return chunks[0];
  const allParts = chunks.flatMap(
    (c) => c.candidates?.[0]?.content?.parts ?? []
  );
  const usageChunk = [...chunks].reverse().find((c) => c.usageMetadata);
  const finishChunk = [...chunks].reverse().find((c) => c.candidates?.[0]?.finishReason);
  const finishReason = finishChunk?.candidates?.[0]?.finishReason;
  const merged = new GenerateContentResponse();
  merged.responseId = chunks.find((c) => c.responseId)?.responseId;
  merged.modelVersion = chunks[0]?.modelVersion;
  merged.createTime = chunks[0]?.createTime;
  if (usageChunk?.usageMetadata) {
    merged.usageMetadata = usageChunk.usageMetadata;
  }
  merged.candidates = [
    {
      content: { parts: allParts, role: "model" },
      index: 0,
      safetyRatings: [],
      ...finishReason ? { finishReason } : {}
    }
  ];
  return merged;
}
__name(mergeStreamResponses, "mergeStreamResponses");

// packages/core/src/core/openaiResponsesContentGenerator/index.ts
var debugLogger3 = createDebugLogger("RESPONSES");
var OpenAIResponsesContentGenerator = class {
  static {
    __name(this, "OpenAIResponsesContentGenerator");
  }
  pipeline;
  contentGeneratorConfig;
  cliConfig;
  openaiClient = null;
  constructor(contentGeneratorConfig, cliConfig) {
    this.contentGeneratorConfig = contentGeneratorConfig;
    this.cliConfig = cliConfig;
    this.pipeline = new ResponsesPipeline(contentGeneratorConfig, cliConfig);
  }
  async getOpenAIClient() {
    if (this.openaiClient) return this.openaiClient;
    const OpenAISDK = (await import("./openai-WX26N5OJ.js")).default;
    const apiKey = this.contentGeneratorConfig.apiKey ?? (this.contentGeneratorConfig.apiKeyEnvKey ? process.env[this.contentGeneratorConfig.apiKeyEnvKey] : void 0);
    const runtimeOptions = buildRuntimeFetchOptions(
      "openai",
      this.cliConfig.getProxy()
    );
    const baseURL = this.contentGeneratorConfig.baseUrl ? `${normalizeOpenAiWireBaseUrl(this.contentGeneratorConfig.baseUrl)}/v1` : void 0;
    this.openaiClient = new OpenAISDK({
      apiKey,
      baseURL,
      timeout: resolveRequestTimeout(this.contentGeneratorConfig.timeout),
      maxRetries: this.contentGeneratorConfig.maxRetries ?? DEFAULT_MAX_RETRIES,
      // Mirror the streaming pipeline (responses-pipeline.ts), which
      // applies customHeaders to every request -- without this, headers
      // configured for the streaming path (e.g. a proxy auth header)
      // silently don't reach embedContent's requests.
      ...this.contentGeneratorConfig.customHeaders ? { defaultHeaders: this.contentGeneratorConfig.customHeaders } : {},
      ...runtimeOptions || {},
      // defaultHeaders above is baked in once, so a `${session_id}` in it
      // could only reach the wire literally. The wrapper resolves it per
      // request (and drops it when the consent gate is off), matching what the
      // Chat wire installs on its own client -- issue #11936.
      fetch: buildSessionAwareFetch(
        runtimeOptions?.fetch,
        this.cliConfig,
        this.contentGeneratorConfig.customHeaders
      )
    });
    return this.openaiClient;
  }
  async generateContent(request, userPromptId) {
    return this.pipeline.execute(
      request,
      userPromptId,
      request.config?.abortSignal ?? void 0
    );
  }
  async generateContentStream(request, userPromptId) {
    const signal = request.config?.abortSignal ?? void 0;
    return this.pipeline.connectStream(request, userPromptId, signal);
  }
  async embedContent(request) {
    const text = extractTextFromContents(request.contents);
    const client = await this.getOpenAIClient();
    try {
      const embedding = await client.embeddings.create({
        model: this.contentGeneratorConfig.model.includes("embed") ? this.contentGeneratorConfig.model : "text-embedding-ada-002",
        input: text
      });
      const first = embedding.data[0];
      if (!first) {
        throw new Error("Embedding API returned empty data array");
      }
      return {
        embeddings: [{ values: first.embedding }]
      };
    } catch (error) {
      const redactedError = redactProxyError(error);
      debugLogger3.error("Embedding error:", redactedError);
      throw new Error(
        `Embedding error: ${redactedError instanceof Error ? redactedError.message : String(redactedError)}`
      );
    }
  }
};
function createOpenAIResponsesContentGenerator(contentGeneratorConfig, cliConfig) {
  return new OpenAIResponsesContentGenerator(contentGeneratorConfig, cliConfig);
}
__name(createOpenAIResponsesContentGenerator, "createOpenAIResponsesContentGenerator");
export {
  OpenAIResponsesContentGenerator,
  createOpenAIResponsesContentGenerator
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
