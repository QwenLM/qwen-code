// Force strict mode and setup for ESM
"use strict";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/telemetry/gen-ai-content.ts
init_esbuild_shims();
var DRAFT_07_TYPES = /* @__PURE__ */ new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string"
]);
var debugLogger = createDebugLogger("GEN_AI_CONTENT");
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
__name(record, "record");
function string(value) {
  return typeof value === "string" ? value : void 0;
}
__name(string, "string");
function jsonValue(value, seen = /* @__PURE__ */ new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : void 0;
  }
  if (typeof value !== "object") return void 0;
  if (seen.has(value)) return void 0;
  seen.add(value);
  try {
    const toJSON = value.toJSON;
    if (typeof toJSON === "function") {
      return jsonValue(toJSON.call(value), seen);
    }
    if (Array.isArray(value)) {
      const result2 = [];
      for (const item of value) {
        const converted = jsonValue(item, seen);
        if (converted === void 0) return void 0;
        result2.push(converted);
      }
      return result2;
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === void 0) continue;
      const converted = jsonValue(item, seen);
      if (converted === void 0) return void 0;
      Object.defineProperty(result, key, {
        value: converted,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return result;
  } finally {
    seen.delete(value);
  }
}
__name(jsonValue, "jsonValue");
function modality(mimeType) {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("audio/")) return "audio";
  if (mimeType?.startsWith("text/") || mimeType?.startsWith("application/")) {
    return "document";
  }
  return void 0;
}
__name(modality, "modality");
function isDataUri(value) {
  return /^data:/i.test(value);
}
__name(isDataUri, "isDataUri");
function dataUriBlob(uri, contentModality, fallbackMimeType) {
  if (!isDataUri(uri)) return void 0;
  const separator = uri.indexOf(",");
  if (separator < 0) return void 0;
  const metadata = uri.slice(5, separator);
  const metadataParts = metadata.split(";");
  if (!metadataParts.slice(1).some((part) => part.toLowerCase() === "base64")) {
    return void 0;
  }
  const mimeType = metadataParts[0] || fallbackMimeType;
  return {
    type: "blob",
    mime_type: mimeType,
    modality: contentModality,
    content: uri.slice(separator + 1)
  };
}
__name(dataUriBlob, "dataUriBlob");
function uriPart(uri, contentModality, mimeType = null) {
  return {
    type: "uri",
    mime_type: mimeType,
    modality: contentModality,
    uri
  };
}
__name(uriPart, "uriPart");
function parseArguments(value) {
  if (typeof value !== "string") return jsonValue(value);
  try {
    return jsonValue(JSON.parse(value));
  } catch {
    return value;
  }
}
__name(parseArguments, "parseArguments");
function genericPart(value) {
  const type = string(value["type"]);
  if (!type) return void 0;
  const converted = jsonValue(value);
  if (!converted || Array.isArray(converted) || typeof converted !== "object") {
    return void 0;
  }
  return { ...converted, type };
}
__name(genericPart, "genericPart");
function openAiPart(value) {
  if (typeof value === "string") {
    return { part: { type: "text", content: value } };
  }
  const item = record(value);
  if (!item) return void 0;
  const type = string(item["type"]);
  if (type === "text" || type === "input_text" || type === "output_text") {
    const content = string(item["text"]) ?? string(item["content"]);
    return content === void 0 ? void 0 : { part: { type: "text", content } };
  }
  if (type === "reasoning" || type === "thinking" || type === "reasoning_content") {
    const content = string(item["text"]) ?? string(item["content"]);
    return content === void 0 ? void 0 : { part: { type: "reasoning", content } };
  }
  if (type === "image_url") {
    const image = record(item["image_url"]);
    const uri = string(image?.["url"]) ?? string(item["image_url"]);
    if (!uri) return void 0;
    const blob = dataUriBlob(uri, "image", null);
    if (isDataUri(uri) && !blob) return void 0;
    return {
      part: blob ?? uriPart(uri, "image")
    };
  }
  if (type === "video_url") {
    const video = record(item["video_url"]);
    const uri = string(video?.["url"]) ?? string(item["video_url"]);
    if (!uri) return void 0;
    const blob = dataUriBlob(uri, "video", null);
    if (isDataUri(uri) && !blob) return void 0;
    return {
      part: blob ?? uriPart(uri, "video")
    };
  }
  if (type === "input_audio") {
    const audio = record(item["input_audio"]);
    const content = string(audio?.["data"]);
    if (content === void 0) return void 0;
    const format = string(audio?.["format"]);
    const mimeType = format === "mp3" ? "audio/mpeg" : format ? `audio/${format}` : null;
    const blob = dataUriBlob(content, "audio", mimeType);
    if (isDataUri(content) && !blob) return void 0;
    return {
      part: blob ?? {
        type: "blob",
        mime_type: mimeType,
        modality: "audio",
        content
      }
    };
  }
  if (type === "file") {
    const file = record(item["file"]);
    const fileId = string(file?.["file_id"]) ?? string(item["file_id"]);
    if (fileId) {
      return {
        part: {
          type: "file",
          mime_type: null,
          modality: "document",
          file_id: fileId
        }
      };
    }
    const fileData = string(file?.["file_data"]) ?? string(item["file_data"]);
    if (!fileData) return void 0;
    const blob = dataUriBlob(fileData, "document", null);
    if (blob) return { part: blob };
    if (isDataUri(fileData)) return void 0;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(fileData)) {
      return { part: uriPart(fileData, "document") };
    }
    return {
      part: {
        type: "blob",
        mime_type: null,
        modality: "document",
        content: fileData
      }
    };
  }
  if (type === "tool_result" || type === "tool_call_response") {
    const response = jsonValue(item["response"] ?? item["content"]);
    if (response === void 0) return void 0;
    return {
      role: "tool",
      part: {
        type: "tool_call_response",
        ...string(item["tool_call_id"]) || string(item["id"]) ? { id: string(item["tool_call_id"]) ?? string(item["id"]) } : {},
        response
      }
    };
  }
  const part = genericPart(item);
  return part ? { part } : void 0;
}
__name(openAiPart, "openAiPart");
function anthropicPart(value) {
  if (typeof value === "string") {
    return { part: { type: "text", content: value } };
  }
  const item = record(value);
  if (!item) return void 0;
  const type = string(item["type"]);
  if (type === "text") {
    const content = string(item["text"]);
    return content === void 0 ? void 0 : { part: { type: "text", content } };
  }
  if (type === "thinking") {
    const content = string(item["thinking"]) ?? string(item["text"]);
    return content === void 0 ? void 0 : { part: { type: "reasoning", content } };
  }
  if (type === "redacted_thinking") {
    const part2 = genericPart(item);
    return part2 ? { part: part2 } : void 0;
  }
  if (type === "tool_use") {
    const name = string(item["name"]);
    if (!name) return void 0;
    const argumentsValue = jsonValue(item["input"]);
    return {
      part: {
        type: "tool_call",
        ...string(item["id"]) ? { id: string(item["id"]) } : {},
        name,
        ...argumentsValue !== void 0 ? { arguments: argumentsValue } : {}
      }
    };
  }
  if (type === "tool_result") {
    const response = jsonValue(item["content"]);
    if (response === void 0) return void 0;
    return {
      role: "tool",
      part: {
        type: "tool_call_response",
        ...string(item["tool_use_id"]) ? { id: string(item["tool_use_id"]) } : {},
        response
      }
    };
  }
  if (type === "image" || type === "document") {
    const source = record(item["source"]);
    const sourceType = string(source?.["type"]);
    const mimeType = string(source?.["media_type"]);
    const data = string(source?.["data"]);
    if (sourceType === "base64" && data !== void 0) {
      return {
        part: {
          type: "blob",
          mime_type: mimeType ?? null,
          modality: type === "image" ? "image" : "document",
          content: data
        }
      };
    }
    const uri = string(source?.["url"]);
    if (uri) {
      return {
        part: {
          type: "uri",
          mime_type: mimeType ?? null,
          modality: type === "image" ? "image" : "document",
          uri
        }
      };
    }
  }
  const part = genericPart(item);
  return part ? { part } : void 0;
}
__name(anthropicPart, "anthropicPart");
function geminiPart(value) {
  if (typeof value === "string") {
    return { part: { type: "text", content: value } };
  }
  const item = record(value);
  if (!item) return void 0;
  const text = string(item["text"]);
  if (text !== void 0) {
    return {
      part: {
        type: item["thought"] === true ? "reasoning" : "text",
        content: text
      }
    };
  }
  const call = record(item["functionCall"]);
  if (call) {
    const name = string(call["name"]);
    if (!name) return void 0;
    const argumentsValue = jsonValue(call["args"]);
    return {
      part: {
        type: "tool_call",
        ...string(call["id"]) ? { id: string(call["id"]) } : {},
        name,
        ...argumentsValue !== void 0 ? { arguments: argumentsValue } : {}
      }
    };
  }
  const response = record(item["functionResponse"]);
  if (response) {
    const responseValue = jsonValue(response["response"]);
    if (responseValue === void 0) return void 0;
    return {
      role: "tool",
      part: {
        type: "tool_call_response",
        ...string(response["id"]) ? { id: string(response["id"]) } : {},
        response: responseValue
      }
    };
  }
  const inlineData = record(item["inlineData"]);
  if (inlineData) {
    const content = string(inlineData["data"]);
    if (content === void 0) return void 0;
    const mimeType = string(inlineData["mimeType"]);
    const contentModality = modality(mimeType);
    if (!contentModality) return void 0;
    return {
      part: {
        type: "blob",
        mime_type: mimeType ?? null,
        modality: contentModality,
        content
      }
    };
  }
  const fileData = record(item["fileData"]);
  if (fileData) {
    const uri = string(fileData["fileUri"]);
    if (!uri) return void 0;
    const mimeType = string(fileData["mimeType"]);
    const contentModality = modality(mimeType);
    if (!contentModality) return void 0;
    return {
      part: {
        type: "uri",
        mime_type: mimeType ?? null,
        modality: contentModality,
        uri
      }
    };
  }
  const explicitType = string(item["type"]);
  const part = explicitType ? genericPart(item) : void 0;
  return part ? { part } : void 0;
}
__name(geminiPart, "geminiPart");
function messages(values, convertPart, roleMap) {
  const items = Array.isArray(values) ? values : [values];
  const result = [];
  for (const value of items) {
    if (typeof value === "string") {
      result.push({
        role: "user",
        parts: [{ type: "text", content: value }]
      });
      continue;
    }
    const message = record(value);
    const rawRole = string(message?.["role"]);
    if (!message || !rawRole) return void 0;
    const role = roleMap(rawRole);
    const content = message["content"] ?? message["parts"];
    const rawParts = content === void 0 || content === null ? [] : Array.isArray(content) ? content : [content];
    let currentRole = role;
    let currentParts = [];
    let emitted = false;
    const flush = /* @__PURE__ */ __name(() => {
      if (currentParts.length === 0) return;
      result.push({
        role: currentRole,
        parts: currentParts,
        ...string(message["name"]) ? { name: string(message["name"]) } : {}
      });
      currentParts = [];
      emitted = true;
    }, "flush");
    const reasoning = string(message["reasoning_content"]) ?? string(message["reasoning"]) ?? string(message["thinking"]);
    if (reasoning !== void 0) {
      currentParts.push({ type: "reasoning", content: reasoning });
    }
    for (const rawPart of rawParts) {
      const converted = convertPart(rawPart);
      if (!converted) return void 0;
      const nextRole = converted.role ?? role;
      if (currentParts.length > 0 && nextRole !== currentRole) flush();
      currentRole = nextRole;
      currentParts.push(converted.part);
    }
    const refusal = string(message["refusal"]);
    if (refusal !== void 0) {
      currentParts.push({ type: "refusal", content: refusal });
    }
    const audio = record(message["audio"]);
    if (audio) {
      const converted = record(jsonValue(audio));
      if (!converted) return void 0;
      currentParts.push({ ...converted, type: "audio" });
    }
    if (Array.isArray(message["tool_calls"])) {
      if (currentParts.length > 0 && currentRole !== role) flush();
      currentRole = role;
      for (const value2 of message["tool_calls"]) {
        const toolCall = record(value2);
        const fn = record(toolCall?.["function"]);
        const name = string(fn?.["name"]);
        if (!toolCall || !fn || !name) return void 0;
        const argumentsValue = parseArguments(fn["arguments"]);
        currentParts.push({
          type: "tool_call",
          ...string(toolCall["id"]) ? { id: string(toolCall["id"]) } : {},
          name,
          ...argumentsValue !== void 0 ? { arguments: argumentsValue } : {}
        });
      }
    }
    if (role === "tool" && currentParts.length > 0 && currentParts.every((part) => part.type === "text")) {
      currentParts = currentParts.map((part) => ({
        type: "tool_call_response",
        ...string(message["tool_call_id"]) ? { id: string(message["tool_call_id"]) } : {},
        response: part["content"] ?? null
      }));
    }
    flush();
    if (!emitted) {
      result.push({
        role,
        parts: [],
        ...string(message["name"]) ? { name: string(message["name"]) } : {}
      });
    }
  }
  return result;
}
__name(messages, "messages");
function systemParts(value, convertPart) {
  if (value === void 0 || value === null) return void 0;
  const content = record(value)?.["parts"] ?? value;
  const values = Array.isArray(content) ? content : [content];
  const result = [];
  for (const item of values) {
    const part = convertPart(item);
    if (!part || part.role) return void 0;
    result.push(part.part);
  }
  return result;
}
__name(systemParts, "systemParts");
function jsonIdentity(value) {
  if (Array.isArray(value)) {
    return `[${value.map(jsonIdentity).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${jsonIdentity(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
__name(jsonIdentity, "jsonIdentity");
function hasUniqueValues(values) {
  return new Set(values.map(jsonIdentity)).size === values.length;
}
__name(hasUniqueValues, "hasUniqueValues");
function isValidRegex(value) {
  try {
    new RegExp(value, "u");
    return true;
  } catch {
    return false;
  }
}
__name(isValidRegex, "isValidRegex");
function isValidUri(value, allowReference) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 32 || code === 127) return false;
  }
  if (/%(?![0-9A-Fa-f]{2})/.test(value)) return false;
  try {
    new URL(value, allowReference ? "https://example.invalid/" : void 0);
    return true;
  } catch {
    return false;
  }
}
__name(isValidUri, "isValidUri");
function normalizeSchema(value) {
  const converted = jsonValue(value);
  if (converted === void 0) return void 0;
  function visitSchema(schema) {
    return typeof schema === "boolean" || schema !== null && !Array.isArray(schema) && typeof schema === "object" && visit(schema);
  }
  __name(visitSchema, "visitSchema");
  function visit(item) {
    const schemaType = item["type"];
    if (typeof schemaType === "string") {
      const lower = schemaType.toLowerCase();
      if (!DRAFT_07_TYPES.has(lower)) return false;
      item["type"] = lower;
    } else if (Array.isArray(schemaType)) {
      if (schemaType.length === 0) return false;
      const normalized = [];
      for (const entry of schemaType) {
        if (typeof entry !== "string") return false;
        const lower = entry.toLowerCase();
        if (!DRAFT_07_TYPES.has(lower)) return false;
        normalized.push(lower);
      }
      if (new Set(normalized).size !== normalized.length) return false;
      item["type"] = normalized;
    } else if (schemaType !== void 0) {
      return false;
    }
    for (const key of [
      "$comment",
      "title",
      "description",
      "format",
      "contentMediaType",
      "contentEncoding"
    ]) {
      if (item[key] !== void 0 && typeof item[key] !== "string")
        return false;
    }
    for (const key of ["readOnly", "uniqueItems"]) {
      if (item[key] !== void 0 && typeof item[key] !== "boolean") {
        return false;
      }
    }
    if (item["$id"] !== void 0 && (typeof item["$id"] !== "string" || !isValidUri(item["$id"], true)) || item["$ref"] !== void 0 && (typeof item["$ref"] !== "string" || !isValidUri(item["$ref"], true)) || item["$schema"] !== void 0 && (typeof item["$schema"] !== "string" || !isValidUri(item["$schema"], false)) || item["pattern"] !== void 0 && (typeof item["pattern"] !== "string" || !isValidRegex(item["pattern"]))) {
      return false;
    }
    if (item["examples"] !== void 0 && !Array.isArray(item["examples"])) {
      return false;
    }
    for (const key of [
      "maximum",
      "exclusiveMaximum",
      "minimum",
      "exclusiveMinimum"
    ]) {
      if (item[key] !== void 0 && typeof item[key] !== "number")
        return false;
    }
    if (item["multipleOf"] !== void 0 && (typeof item["multipleOf"] !== "number" || item["multipleOf"] <= 0)) {
      return false;
    }
    for (const key of [
      "maxLength",
      "minLength",
      "maxItems",
      "minItems",
      "maxProperties",
      "minProperties"
    ]) {
      const count = item[key];
      if (count !== void 0 && (typeof count !== "number" || !Number.isInteger(count) || count < 0)) {
        return false;
      }
    }
    const required = item["required"];
    if (required !== void 0 && (!Array.isArray(required) || !required.every((entry) => typeof entry === "string") || new Set(required).size !== required.length)) {
      return false;
    }
    const enumValues = item["enum"];
    if (enumValues !== void 0 && (!Array.isArray(enumValues) || enumValues.length === 0 || !hasUniqueValues(enumValues))) {
      return false;
    }
    for (const key of ["properties", "patternProperties", "definitions"]) {
      const map = item[key];
      if (map === void 0) continue;
      if (!map || Array.isArray(map) || typeof map !== "object") return false;
      if (key === "patternProperties" && !Object.keys(map).every(isValidRegex)) {
        return false;
      }
      for (const schema of Object.values(map)) {
        if (!visitSchema(schema)) return false;
      }
    }
    for (const key of [
      "additionalProperties",
      "additionalItems",
      "contains",
      "propertyNames",
      "not",
      "if",
      "then",
      "else"
    ]) {
      const schema = item[key];
      if (schema !== void 0 && !visitSchema(schema)) return false;
    }
    const items = item["items"];
    if (items !== void 0) {
      const schemas = Array.isArray(items) ? items : [items];
      if (schemas.length === 0 || !schemas.every(visitSchema)) return false;
    }
    for (const key of ["allOf", "anyOf", "oneOf"]) {
      const schemas = item[key];
      if (schemas === void 0) continue;
      if (!Array.isArray(schemas) || schemas.length === 0 || !schemas.every(visitSchema)) {
        return false;
      }
    }
    const dependencies = item["dependencies"];
    if (dependencies !== void 0) {
      if (!dependencies || Array.isArray(dependencies) || typeof dependencies !== "object") {
        return false;
      }
      for (const dependency of Object.values(dependencies)) {
        if (Array.isArray(dependency)) {
          if (!dependency.every((entry) => typeof entry === "string") || new Set(dependency).size !== dependency.length) {
            return false;
          }
        } else if (!visitSchema(dependency)) {
          return false;
        }
      }
    }
    return true;
  }
  __name(visit, "visit");
  return visitSchema(converted) ? converted : void 0;
}
__name(normalizeSchema, "normalizeSchema");
function definition(type, name, description, parameters) {
  if (typeof type !== "string" || !type || typeof name !== "string" || !name) {
    return void 0;
  }
  return {
    type,
    name,
    ...typeof description === "string" ? { description } : {},
    ...parameters !== void 0 ? { parameters: normalizeSchema(parameters) } : {}
  };
}
__name(definition, "definition");
function compactUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== void 0)
  );
}
__name(compactUndefined, "compactUndefined");
function openAiTools(value) {
  if (!Array.isArray(value)) return void 0;
  const result = [];
  for (const item of value) {
    const tool = record(item);
    if (!tool) return void 0;
    const type = string(tool["type"]);
    const fn = record(tool["function"]);
    const entry = type === "function" && fn ? definition(
      "function",
      fn["name"],
      fn["description"],
      fn["parameters"]
    ) : definition(type, tool["name"], void 0, void 0);
    if (!entry) return void 0;
    result.push(compactUndefined(entry));
  }
  return result;
}
__name(openAiTools, "openAiTools");
function anthropicTools(value) {
  if (!Array.isArray(value)) return void 0;
  const result = [];
  for (const item of value) {
    const tool = record(item);
    const entry = tool ? definition(
      "function",
      tool["name"],
      tool["description"],
      tool["input_schema"]
    ) : void 0;
    if (!entry) return void 0;
    result.push(compactUndefined(entry));
  }
  return result;
}
__name(anthropicTools, "anthropicTools");
function llmTools(value) {
  if (!Array.isArray(value)) return void 0;
  const result = [];
  for (const wrapper of value) {
    const declarations = record(wrapper)?.["functionDeclarations"];
    if (!Array.isArray(declarations)) return void 0;
    for (const item of declarations) {
      const tool = record(item);
      const hasParameters = tool ? Object.hasOwn(tool, "parameters") : false;
      const hasJsonSchema = tool ? Object.hasOwn(tool, "parametersJsonSchema") : false;
      const parameters = hasParameters && hasJsonSchema ? void 0 : hasJsonSchema ? tool?.["parametersJsonSchema"] : tool?.["parameters"];
      const entry = tool ? definition("function", tool["name"], tool["description"], parameters) : void 0;
      if (!entry) return void 0;
      result.push(compactUndefined(entry));
    }
  }
  return result;
}
__name(llmTools, "llmTools");
function extractOpenAiContent(request) {
  const value = request;
  return {
    inputMessages: Object.hasOwn(value, "messages") ? messages(
      value["messages"],
      openAiPart,
      (role) => role === "function" ? "tool" : role
    ) : void 0,
    toolDefinitions: Object.hasOwn(value, "tools") ? openAiTools(value["tools"]) : void 0
  };
}
__name(extractOpenAiContent, "extractOpenAiContent");
function extractAnthropicContent(request) {
  const value = request;
  return {
    inputMessages: Object.hasOwn(value, "messages") ? messages(value["messages"], anthropicPart, (role) => role) : void 0,
    systemInstructions: Object.hasOwn(value, "system") ? systemParts(value["system"], anthropicPart) : void 0,
    toolDefinitions: Object.hasOwn(value, "tools") ? anthropicTools(value["tools"]) : void 0
  };
}
__name(extractAnthropicContent, "extractAnthropicContent");
function extractLlmContent(request) {
  const value = request;
  const config = record(value["config"]);
  return {
    inputMessages: Object.hasOwn(value, "contents") ? messages(
      value["contents"],
      geminiPart,
      (role) => role === "model" ? "assistant" : role
    ) : void 0,
    systemInstructions: config && Object.hasOwn(config, "systemInstruction") ? systemParts(config["systemInstruction"], geminiPart) : void 0,
    toolDefinitions: config && Object.hasOwn(config, "tools") ? llmTools(config["tools"]) : void 0
  };
}
__name(extractLlmContent, "extractLlmContent");
function stringifyGenAiJson(value, maxLength, requireObject = false) {
  const converted = jsonValue(value);
  if (converted === void 0 || requireObject && (converted === null || Array.isArray(converted) || typeof converted !== "object")) {
    return void 0;
  }
  try {
    const serialized = JSON.stringify(converted);
    return serialized.length <= maxLength ? serialized : void 0;
  } catch {
    return void 0;
  }
}
__name(stringifyGenAiJson, "stringifyGenAiJson");
var GenAiOutputAccumulator = class {
  constructor(enabled, maxLength) {
    this.enabled = enabled;
    this.maxLength = maxLength;
  }
  static {
    __name(this, "GenAiOutputAccumulator");
  }
  candidates = /* @__PURE__ */ new Map();
  overflow = false;
  observedResponse = false;
  explicitEmpty = false;
  estimatedLength = 2;
  get finishReasons() {
    const values = [...this.candidates.entries()].sort(([left], [right]) => left - right).map(([, candidate]) => candidate.finishReason).filter((value) => value !== void 0);
    return values.length > 0 ? values : void 0;
  }
  recordOpenAiResponse(response) {
    const choices = response["choices"];
    if (!Array.isArray(choices)) return;
    this.observedResponse = true;
    this.explicitEmpty = choices.length === 0;
    for (const [position, rawChoice] of choices.entries()) {
      const choice = record(rawChoice);
      if (!choice) {
        if (this.enabled) this.markOverflow();
        continue;
      }
      const index = typeof choice["index"] === "number" && Number.isSafeInteger(choice["index"]) ? choice["index"] : position;
      const candidate = this.candidate(index);
      const message = record(choice["message"]);
      if (message && this.enabled) {
        const converted = messages([message], openAiPart, () => "assistant");
        if (converted?.[0]) this.setComplete(index, converted[0]);
        else this.markOverflow();
      } else if (this.enabled) {
        this.markOverflow();
      }
      const finishReason = string(choice["finish_reason"]);
      if (finishReason) candidate.finishReason = finishReason;
    }
  }
  recordOpenAiChunk(chunk) {
    const choices = chunk["choices"];
    if (!Array.isArray(choices)) return;
    this.observedResponse = true;
    if (choices.length === 0 && this.candidates.size === 0) {
      this.explicitEmpty = true;
    }
    for (const [position, rawChoice] of choices.entries()) {
      const choice = record(rawChoice);
      if (!choice) {
        if (this.enabled) this.markOverflow();
        continue;
      }
      const index = typeof choice["index"] === "number" && Number.isSafeInteger(choice["index"]) ? choice["index"] : position;
      const candidate = this.candidate(index);
      const delta = record(choice["delta"]);
      const reasoning = string(delta?.["reasoning_content"]) ?? string(delta?.["reasoning"]) ?? string(delta?.["thinking"]);
      if (reasoning !== void 0) {
        this.append(candidate, "reasoning", "reasoning", reasoning);
      }
      const content = string(delta?.["content"]);
      if (content !== void 0) {
        this.append(candidate, "text", "text", content);
      }
      const refusal = string(delta?.["refusal"]);
      if (refusal !== void 0) {
        this.append(candidate, "refusal", "refusal", refusal);
      }
      const audio = record(delta?.["audio"]);
      if (audio) {
        const converted = record(jsonValue(audio));
        if (converted) {
          this.setValue(candidate, "audio", {
            ...converted,
            type: "audio"
          });
        } else {
          this.markOverflow();
        }
      }
      const toolCalls = delta?.["tool_calls"];
      if (Array.isArray(toolCalls)) {
        for (const [toolPosition, rawToolCall] of toolCalls.entries()) {
          const toolCall = record(rawToolCall);
          if (!toolCall) {
            this.markOverflow();
            continue;
          }
          const toolIndex = typeof toolCall["index"] === "number" && Number.isSafeInteger(toolCall["index"]) ? toolCall["index"] : toolPosition;
          const key = `tool:${toolIndex}`;
          const fn = record(toolCall["function"]);
          const existing = candidate.parts.get(key);
          const part = existing ?? {
            type: "tool_call"
          };
          if (!existing && !this.reserve(JSON.stringify({ type: "tool_call" }).length)) {
            continue;
          }
          const id = string(toolCall["id"]);
          if (id !== void 0 && id !== part.id && !this.reserve(id.length - (part.id?.length ?? 0))) {
            continue;
          }
          const name = string(fn?.["name"]);
          if (name !== void 0 && name !== part.name && !this.reserve(name.length - (part.name?.length ?? 0))) {
            continue;
          }
          part.id = id ?? part.id;
          part.name = name ?? part.name;
          const argumentsFragment = string(fn?.["arguments"]);
          if (argumentsFragment !== void 0) {
            const next = (part.arguments ?? "") + argumentsFragment;
            if (!this.reserve(argumentsFragment.length)) continue;
            part.arguments = next;
          }
          candidate.parts.set(key, part);
        }
      }
      const finishReason = string(choice["finish_reason"]);
      if (finishReason) candidate.finishReason = finishReason;
    }
  }
  recordAnthropicResponse(response) {
    this.observedResponse = true;
    const value = response;
    const candidate = this.candidate(0);
    const content = value["content"];
    if (Array.isArray(content) && this.enabled) {
      const parts = [];
      for (const item of content) {
        const converted = anthropicPart(item);
        if (!converted || converted.role) {
          this.markOverflow();
          break;
        }
        parts.push(converted.part);
      }
      if (!this.overflow) {
        this.setComplete(0, { role: "assistant", parts });
      }
    } else if (this.enabled) {
      this.markOverflow();
    }
    const finishReason = string(value["stop_reason"]);
    if (finishReason) candidate.finishReason = finishReason;
  }
  recordAnthropicEvent(event) {
    const value = event;
    const type = string(value["type"]);
    if (type !== "message_start" && type !== "content_block_start" && type !== "content_block_delta" && type !== "message_delta") {
      return;
    }
    this.observedResponse = true;
    const index = typeof value["index"] === "number" && Number.isSafeInteger(value["index"]) ? value["index"] : 0;
    const candidate = this.candidate(0);
    if (type === "content_block_start") {
      const block = record(value["content_block"]);
      const blockType = string(block?.["type"]);
      if (blockType === "text") {
        this.append(
          candidate,
          `block:${index}`,
          "text",
          string(block?.["text"])
        );
      } else if (blockType === "thinking") {
        this.append(
          candidate,
          `block:${index}`,
          "reasoning",
          string(block?.["thinking"]) ?? string(block?.["data"])
        );
      } else if (blockType === "redacted_thinking" && block) {
        const converted = anthropicPart(block);
        if (converted && !converted.role) {
          this.setValue(candidate, `block:${index}`, converted.part);
        } else {
          this.markOverflow();
        }
      } else if (blockType === "tool_use") {
        if (!this.reserve(JSON.stringify({ type: "tool_call" }).length)) return;
        const id = string(block?.["id"]);
        const name = string(block?.["name"]);
        if (!this.reserve((id?.length ?? 0) + (name?.length ?? 0))) return;
        const hasInput = block ? Object.hasOwn(block, "input") : false;
        const input = hasInput ? jsonValue(block?.["input"]) : void 0;
        if (hasInput && input === void 0) {
          this.markOverflow();
          return;
        }
        const initialArguments = input === void 0 ? void 0 : JSON.stringify(input);
        if (initialArguments !== void 0 && !this.reserve(initialArguments.length)) {
          return;
        }
        candidate.parts.set(`block:${index}`, {
          type: "tool_call",
          id,
          name,
          arguments: initialArguments,
          argumentsFromStart: initialArguments !== void 0
        });
      } else if (blockType && block) {
        const converted = anthropicPart(block);
        if (converted && !converted.role) {
          this.setValue(candidate, `block:${index}`, converted.part);
        } else {
          this.markOverflow();
        }
      }
    } else if (type === "content_block_delta") {
      const delta = record(value["delta"]);
      const deltaType = string(delta?.["type"]);
      if (deltaType === "text_delta") {
        this.append(
          candidate,
          `block:${index}`,
          "text",
          string(delta?.["text"])
        );
      } else if (deltaType === "thinking_delta" || deltaType === "signature_delta") {
        if (deltaType === "thinking_delta") {
          this.append(
            candidate,
            `block:${index}`,
            "reasoning",
            string(delta?.["thinking"])
          );
        }
      } else if (deltaType === "input_json_delta") {
        const part = candidate.parts.get(`block:${index}`);
        const fragment = string(delta?.["partial_json"]);
        if (part?.type === "tool_call" && fragment !== void 0) {
          const replacedLength = part.argumentsFromStart ? part.arguments?.length ?? 0 : 0;
          if (this.reserve(fragment.length - replacedLength)) {
            if (part.argumentsFromStart) {
              part.arguments = "";
              part.argumentsFromStart = false;
            }
            part.arguments = (part.arguments ?? "") + fragment;
          }
        }
      }
    } else if (type === "message_delta") {
      const delta = record(value["delta"]);
      const finishReason = string(delta?.["stop_reason"]);
      if (finishReason) candidate.finishReason = finishReason;
    }
  }
  recordLlmResponse(response) {
    const candidates = response["candidates"];
    if (!Array.isArray(candidates)) return;
    this.observedResponse = true;
    this.explicitEmpty = candidates.length === 0;
    for (const [position, rawCandidate] of candidates.entries()) {
      const candidate = record(rawCandidate);
      if (!candidate) {
        if (this.enabled) this.markOverflow();
        continue;
      }
      const index = typeof candidate["index"] === "number" && Number.isSafeInteger(candidate["index"]) ? candidate["index"] : position;
      const outputCandidate = this.candidate(index);
      const content = record(candidate["content"]);
      if (content && this.enabled) {
        const converted = messages(
          [content],
          geminiPart,
          (role) => role === "model" ? "assistant" : role
        );
        if (converted?.[0]) this.setComplete(index, converted[0]);
        else this.markOverflow();
      } else if (this.enabled) {
        this.setComplete(index, { role: "assistant", parts: [] });
      }
      const finishReason = string(candidate["finishReason"]);
      if (finishReason) outputCandidate.finishReason = finishReason;
    }
  }
  recordLlmChunk(chunk) {
    const candidates = chunk["candidates"];
    if (!Array.isArray(candidates)) return;
    this.observedResponse = true;
    if (candidates.length === 0 && this.candidates.size === 0) {
      this.explicitEmpty = true;
    }
    for (const [position, rawCandidate] of candidates.entries()) {
      const value = record(rawCandidate);
      if (!value) {
        if (this.enabled) this.markOverflow();
        continue;
      }
      const index = typeof value["index"] === "number" && Number.isSafeInteger(value["index"]) ? value["index"] : position;
      const candidate = this.candidate(index);
      const content = record(value["content"]);
      const role = string(content?.["role"]);
      if (role) candidate.role = role === "model" ? "assistant" : role;
      const parts = content?.["parts"];
      if (Array.isArray(parts) && this.enabled && !this.overflow) {
        for (const [partIndex, rawPart] of parts.entries()) {
          const converted = geminiPart(rawPart);
          if (!converted || converted.role) {
            this.markOverflow();
            break;
          }
          const part = converted.part;
          const type = string(part["type"]);
          const key = `part:${partIndex}:${type ?? "unknown"}`;
          if (type === "text" || type === "reasoning") {
            this.append(candidate, key, type, string(part["content"]) ?? "");
          } else {
            this.setValue(candidate, key, part);
          }
        }
      }
      const finishReason = string(value["finishReason"]);
      if (finishReason) candidate.finishReason = finishReason;
    }
  }
  finalize(success) {
    if (!success) {
      for (const candidate of this.candidates.values()) {
        candidate.finishReason ??= "error";
      }
    }
    if (!this.enabled || this.overflow || !this.observedResponse) {
      return void 0;
    }
    if (this.explicitEmpty && this.candidates.size === 0) {
      return stringifyGenAiJson([], this.maxLength);
    }
    const output = [];
    for (const [, candidate] of [...this.candidates.entries()].sort(
      ([left], [right]) => left - right
    )) {
      const finishReason = candidate.finishReason;
      if (!finishReason) {
        debugLogger.debug(
          "Omitting GenAI output messages because a candidate has no finish reason"
        );
        return void 0;
      }
      const parts = [];
      for (const part of candidate.parts.values()) {
        if (part.value) {
          parts.push(part.value);
          continue;
        }
        if (part.type === "tool_call") {
          if (!part.name) return void 0;
          const argumentsValue = part.arguments === void 0 ? void 0 : parseArguments(part.arguments);
          parts.push({
            type: "tool_call",
            ...part.id ? { id: part.id } : {},
            name: part.name,
            ...argumentsValue !== void 0 ? { arguments: argumentsValue } : {}
          });
        } else {
          parts.push({
            type: part.type,
            content: part.content ?? ""
          });
        }
      }
      output.push({
        role: candidate.role,
        parts,
        finish_reason: finishReason
      });
    }
    return stringifyGenAiJson(output, this.maxLength);
  }
  discardContent() {
    this.markOverflow();
  }
  candidate(index) {
    let candidate = this.candidates.get(index);
    if (!candidate) {
      candidate = { role: "assistant", parts: /* @__PURE__ */ new Map() };
      this.candidates.set(index, candidate);
    }
    return candidate;
  }
  setComplete(index, message) {
    const candidate = this.candidate(index);
    candidate.role = string(message["role"]) ?? "assistant";
    candidate.parts.clear();
    const parts = message["parts"];
    if (!Array.isArray(parts)) {
      this.markOverflow();
      return;
    }
    for (const [partIndex, value] of parts.entries()) {
      const part = record(value);
      const type = string(part?.["type"]);
      if (!part || !type) {
        this.markOverflow();
        return;
      }
      if (type === "text" || type === "reasoning") {
        candidate.parts.set(`part:${partIndex}`, {
          type,
          content: string(part["content"]) ?? ""
        });
      } else if (type === "tool_call") {
        candidate.parts.set(`part:${partIndex}`, {
          type: "tool_call",
          id: string(part["id"]),
          name: string(part["name"]),
          arguments: part["arguments"] === void 0 ? void 0 : JSON.stringify(part["arguments"])
        });
      } else {
        candidate.parts.set(`part:${partIndex}`, {
          type,
          value: part
        });
      }
    }
    const serialized = stringifyGenAiJson(message, this.maxLength);
    if (serialized === void 0) this.markOverflow();
  }
  append(candidate, key, type, fragment) {
    if (fragment === void 0 || !this.enabled || this.overflow) return;
    const part = candidate.parts.get(key);
    if (part && part.type !== type) {
      this.markOverflow();
      return;
    }
    const newPartLength = part ? 0 : JSON.stringify({ type, content: "" }).length;
    if (!this.reserve(fragment.length + newPartLength)) return;
    if (part) {
      part.content = (part.content ?? "") + fragment;
    } else {
      candidate.parts.set(key, { type, content: fragment });
    }
  }
  setValue(candidate, key, value) {
    const previous = candidate.parts.get(key)?.value;
    const previousLength = previous ? JSON.stringify(previous).length : 0;
    if (this.reserve(JSON.stringify(value).length - previousLength)) {
      candidate.parts.set(key, { type: value.type, value });
    }
  }
  reserve(length) {
    if (!this.enabled || this.overflow) return false;
    this.estimatedLength += length;
    if (this.estimatedLength <= this.maxLength) return true;
    this.markOverflow();
    return false;
  }
  markOverflow() {
    this.overflow = true;
    for (const candidate of this.candidates.values()) candidate.parts.clear();
  }
};

export {
  extractOpenAiContent,
  extractAnthropicContent,
  extractLlmContent,
  stringifyGenAiJson,
  GenAiOutputAccumulator
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
