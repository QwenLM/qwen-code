// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/runtimeDiagnostics.ts
init_esbuild_shims();
var RUNTIME_PROFILE_ENV = "QWEN_CODE_PROFILE_RUNTIME";
function isRuntimeDiagnosticsEnabled(env = process.env) {
  return env[RUNTIME_PROFILE_ENV] === "1";
}
__name(isRuntimeDiagnosticsEnabled, "isRuntimeDiagnosticsEnabled");
var RuntimeDiagnosticsCollector = class {
  static {
    __name(this, "RuntimeDiagnosticsCollector");
  }
  enabled;
  now;
  startedAt;
  requestIndex = 0;
  openAIWireRequestIndex = 0;
  anthropicWireRequestIndex = 0;
  requests = [];
  openaiWireRequests = [];
  anthropicWireRequests = [];
  tools = createInitialToolDiagnostics();
  constructor(options = {}) {
    this.enabled = options.enabled ?? isRuntimeDiagnosticsEnabled();
    this.now = options.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
    this.startedAt = this.now();
  }
  reset(options = {}) {
    this.enabled = options.enabled ?? isRuntimeDiagnosticsEnabled();
    this.startedAt = this.now();
    this.requestIndex = 0;
    this.openAIWireRequestIndex = 0;
    this.anthropicWireRequestIndex = 0;
    this.requests = [];
    this.openaiWireRequests = [];
    this.anthropicWireRequests = [];
    this.tools = createInitialToolDiagnostics();
  }
  isEnabled() {
    return this.enabled;
  }
  recordGenerateContentRequest(request, options) {
    if (!this.enabled) {
      return;
    }
    this.requestIndex += 1;
    this.requests.push({
      index: this.requestIndex,
      timestamp: this.now(),
      source: options.source,
      model: request.model,
      stream: options.stream,
      serializedBytes: utf8Bytes(toJsonSafeRequest(request)),
      contents: summarizeContents(request.contents),
      systemInstructionBytes: summarizeContentTextBytes(
        request.config?.systemInstruction
      ),
      generationConfigBytes: utf8Bytes(toJsonSafeConfig(request.config)),
      tools: summarizeToolSchemas(request.config?.tools)
    });
  }
  recordOpenAIWireRequest(request) {
    if (!this.enabled) {
      return;
    }
    this.openAIWireRequestIndex += 1;
    this.openaiWireRequests.push({
      index: this.openAIWireRequestIndex,
      timestamp: this.now(),
      ...summarizeOpenAIWireRequest(request)
    });
  }
  recordAnthropicWireRequest(request) {
    if (!this.enabled) {
      return;
    }
    this.anthropicWireRequestIndex += 1;
    this.anthropicWireRequests.push({
      index: this.anthropicWireRequestIndex,
      timestamp: this.now(),
      ...summarizeAnthropicWireRequest(request)
    });
  }
  recordToolUse(name, args) {
    if (!this.enabled) {
      return;
    }
    const argBytes = utf8Bytes(args);
    const tool = this.getToolNameDiagnostics(name);
    tool.uses += 1;
    tool.argBytes += argBytes;
    tool.maxArgBytes = Math.max(tool.maxArgBytes, argBytes);
    this.tools.toolUseCount += 1;
    this.tools.totalToolUseArgBytes += argBytes;
    this.tools.maxToolUseArgBytes = Math.max(
      this.tools.maxToolUseArgBytes,
      argBytes
    );
  }
  recordToolResult(record) {
    if (!this.enabled) {
      return;
    }
    const tool = this.getToolNameDiagnostics(record.name);
    tool.results += 1;
    tool.resultBytes += record.resultBytes;
    tool.maxResultBytes = Math.max(tool.maxResultBytes, record.resultBytes);
    if (record.isError) {
      tool.errors += 1;
      this.tools.toolResultErrorCount += 1;
    }
    this.tools.toolResultCount += 1;
    this.tools.totalToolResultBytes += record.resultBytes;
    this.tools.maxToolResultBytes = Math.max(
      this.tools.maxToolResultBytes,
      record.resultBytes
    );
  }
  snapshot() {
    return {
      enabled: this.enabled,
      startedAt: this.startedAt,
      requests: this.requests.map((request) => ({
        ...request,
        contents: {
          ...request.contents,
          roleCounts: { ...request.contents.roleCounts }
        },
        tools: { ...request.tools }
      })),
      openaiWireRequests: this.openaiWireRequests.map((request) => ({
        ...request,
        messageBytesByRole: { ...request.messageBytesByRole },
        topLevelKeys: [...request.topLevelKeys]
      })),
      anthropicWireRequests: this.anthropicWireRequests.map((request) => ({
        ...request,
        messageBytesByRole: { ...request.messageBytesByRole },
        topLevelKeys: [...request.topLevelKeys]
      })),
      tools: {
        ...this.tools,
        byName: Object.fromEntries(
          Object.entries(this.tools.byName).map(([name, value]) => [
            name,
            { ...value }
          ])
        )
      }
    };
  }
  getToolNameDiagnostics(name) {
    const existing = this.tools.byName[name];
    if (existing) {
      return existing;
    }
    const created = createInitialToolNameDiagnostics();
    this.tools.byName[name] = created;
    return created;
  }
};
var runtimeDiagnostics = new RuntimeDiagnosticsCollector();
function summarizeOpenAIWireRequest(request) {
  const requestRecord = asRecord(request);
  const messages = Array.isArray(requestRecord["messages"]) ? requestRecord["messages"] : [];
  const tools = Array.isArray(requestRecord["tools"]) ? requestRecord["tools"] : [];
  const messageBytesByRole = {};
  for (const message of messages) {
    const messageRecord = asRecord(message);
    const role = typeof messageRecord["role"] === "string" ? messageRecord["role"] : "unknown";
    messageBytesByRole[role] = (messageBytesByRole[role] ?? 0) + utf8Bytes(messageRecord["content"]);
  }
  return {
    model: typeof requestRecord["model"] === "string" ? requestRecord["model"] : "unknown",
    stream: requestRecord["stream"] === true,
    bodyBytes: utf8Bytes(request),
    messageCount: messages.length,
    messageBytesByRole,
    toolsCount: tools.length,
    toolSchemaBytes: utf8Bytes(tools),
    topLevelKeys: Object.keys(requestRecord).sort()
  };
}
__name(summarizeOpenAIWireRequest, "summarizeOpenAIWireRequest");
function summarizeAnthropicWireRequest(request) {
  const requestRecord = asRecord(request);
  const messages = Array.isArray(requestRecord["messages"]) ? requestRecord["messages"] : [];
  const tools = Array.isArray(requestRecord["tools"]) ? requestRecord["tools"] : [];
  const messageBytesByRole = {};
  for (const message of messages) {
    const messageRecord = asRecord(message);
    const role = typeof messageRecord["role"] === "string" ? messageRecord["role"] : "unknown";
    messageBytesByRole[role] = (messageBytesByRole[role] ?? 0) + utf8Bytes(messageRecord["content"]);
  }
  return {
    model: typeof requestRecord["model"] === "string" ? requestRecord["model"] : "unknown",
    stream: requestRecord["stream"] === true,
    bodyBytes: utf8Bytes(request),
    messageCount: messages.length,
    messageBytesByRole,
    systemBytes: utf8Bytes(requestRecord["system"]),
    toolsCount: tools.length,
    toolSchemaBytes: utf8Bytes(tools),
    topLevelKeys: Object.keys(requestRecord).sort()
  };
}
__name(summarizeAnthropicWireRequest, "summarizeAnthropicWireRequest");
function createInitialToolDiagnostics() {
  return {
    toolUseCount: 0,
    toolResultCount: 0,
    toolResultErrorCount: 0,
    totalToolUseArgBytes: 0,
    maxToolUseArgBytes: 0,
    totalToolResultBytes: 0,
    maxToolResultBytes: 0,
    byName: /* @__PURE__ */ Object.create(null)
  };
}
__name(createInitialToolDiagnostics, "createInitialToolDiagnostics");
function createInitialToolNameDiagnostics() {
  return {
    uses: 0,
    argBytes: 0,
    maxArgBytes: 0,
    results: 0,
    errors: 0,
    resultBytes: 0,
    maxResultBytes: 0
  };
}
__name(createInitialToolNameDiagnostics, "createInitialToolNameDiagnostics");
function summarizeContents(contents) {
  const summary = {
    count: 0,
    roleCounts: {},
    partCount: 0,
    textBytes: 0,
    functionCallCount: 0,
    functionCallArgBytes: 0,
    functionResponseCount: 0,
    functionResponseBytes: 0,
    inlineDataCount: 0,
    inlineDataBytes: 0,
    fileDataCount: 0
  };
  const contentItems = Array.isArray(contents) ? contents : contents === void 0 || contents === null ? [] : [contents];
  for (const content of contentItems) {
    summary.count += 1;
    if (typeof content === "string") {
      summary.roleCounts["user"] = (summary.roleCounts["user"] ?? 0) + 1;
      summary.partCount += 1;
      summary.textBytes += utf8Bytes(content);
      continue;
    }
    const contentRecord = asRecord(content);
    const role = typeof contentRecord["role"] === "string" ? contentRecord["role"] : "unknown";
    summary.roleCounts[role] = (summary.roleCounts[role] ?? 0) + 1;
    const parts = Array.isArray(contentRecord["parts"]) ? contentRecord["parts"] : [];
    summarizeParts(parts, summary);
  }
  return summary;
}
__name(summarizeContents, "summarizeContents");
function summarizeContentTextBytes(content) {
  const summary = summarizeContents(content);
  return summary.textBytes;
}
__name(summarizeContentTextBytes, "summarizeContentTextBytes");
function summarizeParts(parts, summary) {
  for (const part of parts) {
    summary.partCount += 1;
    if (typeof part === "string") {
      summary.textBytes += utf8Bytes(part);
      continue;
    }
    const partRecord = asRecord(part);
    if (typeof partRecord["text"] === "string") {
      summary.textBytes += utf8Bytes(partRecord["text"]);
    }
    const functionCall = asOptionalRecord(partRecord["functionCall"]);
    if (functionCall) {
      summary.functionCallCount += 1;
      summary.functionCallArgBytes += utf8Bytes(functionCall["args"]);
    }
    const functionResponse = asOptionalRecord(partRecord["functionResponse"]);
    if (functionResponse) {
      summary.functionResponseCount += 1;
      summary.functionResponseBytes += utf8Bytes(functionResponse["response"]) + utf8Bytes(functionResponse["parts"]);
    }
    const inlineData = asOptionalRecord(partRecord["inlineData"]);
    if (inlineData) {
      summary.inlineDataCount += 1;
      summary.inlineDataBytes += utf8Bytes(inlineData["data"]);
    }
    if (partRecord["fileData"]) {
      summary.fileDataCount += 1;
    }
  }
}
__name(summarizeParts, "summarizeParts");
function summarizeToolSchemas(tools) {
  const toolList = Array.isArray(tools) ? tools : [];
  let functionDeclarationCount = 0;
  for (const tool of toolList) {
    const toolRecord = asRecord(tool);
    const declarations = Array.isArray(toolRecord["functionDeclarations"]) ? toolRecord["functionDeclarations"] : [];
    functionDeclarationCount += declarations.length;
  }
  return {
    count: toolList.length,
    functionDeclarationCount,
    schemaBytes: utf8Bytes(toolList)
  };
}
__name(summarizeToolSchemas, "summarizeToolSchemas");
function toJsonSafeRequest(request) {
  return {
    model: request.model,
    contents: request.contents,
    config: toJsonSafeConfig(request.config)
  };
}
__name(toJsonSafeRequest, "toJsonSafeRequest");
function toJsonSafeConfig(config) {
  if (!config) {
    return void 0;
  }
  const configRecord = asRecord(config);
  const safeConfig = {};
  for (const [key, value] of Object.entries(configRecord)) {
    if (key === "abortSignal") {
      continue;
    }
    safeConfig[key] = value;
  }
  return safeConfig;
}
__name(toJsonSafeConfig, "toJsonSafeConfig");
function utf8Bytes(value) {
  if (value === void 0 || value === null) {
    return 0;
  }
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8");
  }
  return Buffer.byteLength(safeStringify(value), "utf8");
}
__name(utf8Bytes, "utf8Bytes");
function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}
__name(safeStringify, "safeStringify");
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : {};
}
__name(asRecord, "asRecord");
function asOptionalRecord(value) {
  return typeof value === "object" && value !== null ? value : null;
}
__name(asOptionalRecord, "asOptionalRecord");

export {
  runtimeDiagnostics
};
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
