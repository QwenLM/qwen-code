// Force strict mode and setup for ESM
"use strict";
import {
  HistoryReplayer,
  JSON_STRING_DELIMITER_BYTES,
  jsonStringJsonByteLength,
  jsonStringPayloadByteLength,
  observeAcpToolResultProjection,
  truncateJsonStringPayload
} from "./chunk-TPIZYLF2.js";
import {
  isA2uiToolMeta
} from "./chunk-7RZUXNH6.js";
import {
  redactLogCredentials
} from "./chunk-M5GB774H.js";
import {
  getResponseText,
  lastHistoryContentFromRecords,
  restorableAskUserQuestionCallIds
} from "./chunk-MRTRBONQ.js";
import {
  parseGoalSnapshotV2,
  parseGoalStateCause
} from "./chunk-IMV5DBIP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/runtime/workspace-remember-errors.ts
init_esbuild_shims();
var MAX_REMEMBER_ERROR_DETAILS_CHARS = 1e3;
var MAX_REMEMBER_ERROR_CAUSE_DEPTH = 50;
var REMEMBER_ERROR_FORMAT_RE = new RegExp("[\\p{Cf}]|\\p{Variation_Selector}", "gu");
var REMEMBER_ERROR_SPACE_SEPARATOR_RE = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/gu;
var REMEMBER_ERROR_CREDENTIAL_SEPARATOR_RE = new RegExp("[\\x00-\\x1f\\x7f-\\x9f\\p{Cf}\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]|\\p{Variation_Selector}", "gu");
var REMEMBER_ERROR_AUTH_SCHEME_INVISIBLE_RE = new RegExp("\\b(Bearer|QQBot)(?:[\\x00-\\x1f\\x7f-\\x9f\\p{Cf}\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]|\\p{Variation_Selector})+(?=[A-Za-z0-9._~+/=-])", "giu");
var REMEMBER_ERROR_AUTH_TOKEN_WITH_SEPARATORS_RE = new RegExp("\\b(Bearer|QQBot)(?:\\s|[\\x00-\\x1f\\x7f-\\x9f\\p{Cf}\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]|\\p{Variation_Selector})+((?:[A-Za-z0-9._~+/=-]+(?:[\\x00-\\x1f\\x7f-\\x9f\\p{Cf}\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]|\\p{Variation_Selector})+)*[A-Za-z0-9._~+/=-]+)", "giu");
var REMEMBER_ERROR_BARE_TOKEN_WITH_SEPARATORS_RE = new RegExp("\\b(?:sk-|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[b]-|xox[p]-)(?:[A-Za-z0-9_-]+(?:[\\x00-\\x1f\\x7f-\\x9f\\p{Cf}\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]|\\p{Variation_Selector})+)*[A-Za-z0-9_-]+", "gu");
var REMEMBER_ERROR_AWS_KEY_WITH_SEPARATORS_RE = new RegExp("\\b(?:AKIA|ASIA)(?:[A-Z0-9]+(?:[\\x00-\\x1f\\x7f-\\x9f\\p{Cf}\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]|\\p{Variation_Selector})+)*[A-Z0-9]+", "gu");
var REMEMBER_ERROR_SECRET_ASSIGNMENT_WITH_SEPARATORS_RE = new RegExp("((?:api[_-]?key|token|secret|password|pwd)[_-]?[=:]\\s*)((?:\\S+(?:[\\x00-\\x1f\\x7f-\\x9f\\p{Cf}\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]|\\p{Variation_Selector})+)*\\S+)", "giu");
var REMEMBER_ERROR_ENV_SECRET_ASSIGNMENT_WITH_SEPARATORS_RE = new RegExp("([A-Z][A-Z0-9]{0,50}(?:_[A-Z0-9]{1,50}){0,10}_(?:KEY|TOKEN|SECRET|PASSWORD)\\s*[=:]\\s*)((?:\\S+(?:[\\x00-\\x1f\\x7f-\\x9f\\p{Cf}\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]|\\p{Variation_Selector})+)*\\S+)", "gu");
var REMEMBER_ERROR_URL_CREDENTIALS_WITH_SEPARATORS_RE = new RegExp("(\\b[a-z][a-z0-9+.-]{0,31}:\\/\\/)([^/@\\s]*(?:[\\x00-\\x1f\\x7f-\\x9f\\p{Cf}\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]|\\p{Variation_Selector})+[^/@\\s]*)@", "giu");
var REMEMBER_ERROR_CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;
var DETAIL_SUPPRESSED_REMEMBER_ERROR_CODES = /* @__PURE__ */ new Set([
  "managed_memory_unavailable"
]);
function createWorkspaceMemoryExtractionErrorLogger(logger) {
  return (target, err) => {
    logger.warn(`Failed to extract workspace memory error ${target}:`, {
      extractionError: err instanceof Error ? err.message : String(err)
    });
  };
}
__name(createWorkspaceMemoryExtractionErrorLogger, "createWorkspaceMemoryExtractionErrorLogger");
function reportRememberErrorExtractionFailure(onExtractionError, target, err) {
  try {
    onExtractionError?.(target, err);
  } catch {
  }
}
__name(reportRememberErrorExtractionFailure, "reportRememberErrorExtractionFailure");
function errorCodeFromRecord(record) {
  if (typeof record["code"] === "string") return record["code"];
  const data = record["data"];
  if (data && typeof data === "object") {
    const dataRecord = data;
    if (typeof dataRecord["errorKind"] === "string") {
      return dataRecord["errorKind"];
    }
    if (typeof dataRecord["code"] === "string") return dataRecord["code"];
  }
  return void 0;
}
__name(errorCodeFromRecord, "errorCodeFromRecord");
function rawRememberErrorCode(err, seen, depth) {
  if (depth > MAX_REMEMBER_ERROR_CAUSE_DEPTH) return void 0;
  if (!err || typeof err !== "object") return void 0;
  if (seen.has(err)) return void 0;
  seen.add(err);
  const record = err;
  const direct = errorCodeFromRecord(record);
  if (direct) return direct;
  const cause = record["cause"];
  if (cause != null) {
    return rawRememberErrorCode(cause, seen, depth + 1);
  }
  return void 0;
}
__name(rawRememberErrorCode, "rawRememberErrorCode");
function extractRememberErrorCode(err, fallback = "remember_failed") {
  return rawRememberErrorCode(err, /* @__PURE__ */ new WeakSet(), 0) ?? fallback;
}
__name(extractRememberErrorCode, "extractRememberErrorCode");
function workspaceMemoryFailureCode(err, fallback = "remember_failed", onExtractionError) {
  try {
    return extractRememberErrorCode(err, fallback);
  } catch (extractionErr) {
    reportRememberErrorExtractionFailure(
      onExtractionError,
      "code",
      extractionErr
    );
    return fallback;
  }
}
__name(workspaceMemoryFailureCode, "workspaceMemoryFailureCode");
function detailFromRecord(record, seen, depth) {
  const data = record["data"];
  if (data && typeof data === "object") {
    const dataRecord = data;
    const details = dataRecord["details"];
    if (typeof details === "string" && details.length > 0) return details;
    const message2 = dataRecord["message"];
    if (typeof message2 === "string" && message2.length > 0) return message2;
  }
  const message = record["message"];
  if (typeof message === "string" && message.length > 0) return message;
  if (typeof data === "string" && data.length > 0) return data;
  const cause = record["cause"];
  if (cause != null) {
    return rawRememberErrorDetails(cause, seen, depth + 1);
  }
  return void 0;
}
__name(detailFromRecord, "detailFromRecord");
function rawRememberErrorDetails(err, seen, depth) {
  if (depth > MAX_REMEMBER_ERROR_CAUSE_DEPTH) return void 0;
  if (typeof err === "string" && err.length > 0) return err;
  if (!err || typeof err !== "object") return void 0;
  if (seen.has(err)) return void 0;
  seen.add(err);
  return detailFromRecord(err, seen, depth);
}
__name(rawRememberErrorDetails, "rawRememberErrorDetails");
function replaceControlChars(details) {
  return details.replace(REMEMBER_ERROR_AUTH_SCHEME_INVISIBLE_RE, "$1 ").replace(REMEMBER_ERROR_FORMAT_RE, "").replace(REMEMBER_ERROR_SPACE_SEPARATOR_RE, " ").replace(REMEMBER_ERROR_CONTROL_RE, " ");
}
__name(replaceControlChars, "replaceControlChars");
function replaceStackControlChars(stack) {
  return stack.replace(REMEMBER_ERROR_AUTH_SCHEME_INVISIBLE_RE, "$1 ").replace(REMEMBER_ERROR_FORMAT_RE, "").replace(REMEMBER_ERROR_SPACE_SEPARATOR_RE, " ").replace(
    REMEMBER_ERROR_CONTROL_RE,
    (char) => char === "\n" || char === "\r" || char === "	" ? char : " "
  );
}
__name(replaceStackControlChars, "replaceStackControlChars");
function collapseCredentialSeparators(text) {
  return text.replace(
    REMEMBER_ERROR_URL_CREDENTIALS_WITH_SEPARATORS_RE,
    (_match, scheme, userinfo) => `${scheme}${userinfo.replace(REMEMBER_ERROR_CREDENTIAL_SEPARATOR_RE, "")}@`
  ).replace(
    REMEMBER_ERROR_AUTH_TOKEN_WITH_SEPARATORS_RE,
    (_match, scheme, token) => `${scheme} ${token.replace(REMEMBER_ERROR_CREDENTIAL_SEPARATOR_RE, "")}`
  ).replace(
    REMEMBER_ERROR_BARE_TOKEN_WITH_SEPARATORS_RE,
    (token) => token.replace(REMEMBER_ERROR_CREDENTIAL_SEPARATOR_RE, "")
  ).replace(
    REMEMBER_ERROR_AWS_KEY_WITH_SEPARATORS_RE,
    (token) => token.replace(REMEMBER_ERROR_CREDENTIAL_SEPARATOR_RE, "")
  ).replace(
    REMEMBER_ERROR_SECRET_ASSIGNMENT_WITH_SEPARATORS_RE,
    (_match, prefix, value) => `${prefix}${value.replace(REMEMBER_ERROR_CREDENTIAL_SEPARATOR_RE, "")}`
  ).replace(
    REMEMBER_ERROR_ENV_SECRET_ASSIGNMENT_WITH_SEPARATORS_RE,
    (_match, prefix, value) => `${prefix}${value.replace(REMEMBER_ERROR_CREDENTIAL_SEPARATOR_RE, "")}`
  );
}
__name(collapseCredentialSeparators, "collapseCredentialSeparators");
function collapseCredentialSeparatorsByStackLine(stack) {
  return stack.split(/(\r\n|\n|\r)/).map(
    (part) => part === "\r\n" || part === "\n" || part === "\r" ? part : collapseCredentialSeparators(part)
  ).join("");
}
__name(collapseCredentialSeparatorsByStackLine, "collapseCredentialSeparatorsByStackLine");
function isHighSurrogate(codeUnit) {
  return codeUnit >= 55296 && codeUnit <= 56319;
}
__name(isHighSurrogate, "isHighSurrogate");
function isLowSurrogate(codeUnit) {
  return codeUnit >= 56320 && codeUnit <= 57343;
}
__name(isLowSurrogate, "isLowSurrogate");
function truncateBeforeDanglingSurrogate(details, cutPoint) {
  const beforeCut = details.charCodeAt(cutPoint - 1);
  const atCut = details.charCodeAt(cutPoint);
  if (isHighSurrogate(beforeCut) && isLowSurrogate(atCut)) {
    return cutPoint - 1;
  }
  return cutPoint;
}
__name(truncateBeforeDanglingSurrogate, "truncateBeforeDanglingSurrogate");
function capRememberErrorText(redacted) {
  if (redacted.length <= MAX_REMEMBER_ERROR_DETAILS_CHARS) return redacted;
  const truncationSuffix = "... [truncated]";
  const cutPoint = truncateBeforeDanglingSurrogate(
    redacted,
    MAX_REMEMBER_ERROR_DETAILS_CHARS - truncationSuffix.length
  );
  return `${redacted.slice(0, cutPoint)}${truncationSuffix}`;
}
__name(capRememberErrorText, "capRememberErrorText");
function redactAndCapRememberErrorText(normalized) {
  const redacted = redactLogCredentials(normalized).trim();
  if (!redacted) return void 0;
  return capRememberErrorText(redacted);
}
__name(redactAndCapRememberErrorText, "redactAndCapRememberErrorText");
function sanitizeRememberErrorDetails(details) {
  return redactAndCapRememberErrorText(
    replaceControlChars(collapseCredentialSeparators(details))
  );
}
__name(sanitizeRememberErrorDetails, "sanitizeRememberErrorDetails");
function sanitizeRememberErrorStack(stack) {
  return redactAndCapRememberErrorText(
    replaceStackControlChars(collapseCredentialSeparatorsByStackLine(stack))
  );
}
__name(sanitizeRememberErrorStack, "sanitizeRememberErrorStack");
function extractRememberErrorDetails(err) {
  const raw = rawRememberErrorDetails(err, /* @__PURE__ */ new WeakSet(), 0);
  if (!raw) return void 0;
  return sanitizeRememberErrorDetails(raw);
}
__name(extractRememberErrorDetails, "extractRememberErrorDetails");
function extractRememberErrorStack(err) {
  if (!(err instanceof Error) || !err.stack) return void 0;
  return sanitizeRememberErrorStack(err.stack);
}
__name(extractRememberErrorStack, "extractRememberErrorStack");
function shouldSuppressRememberErrorDetails(code) {
  return DETAIL_SUPPRESSED_REMEMBER_ERROR_CODES.has(code);
}
__name(shouldSuppressRememberErrorDetails, "shouldSuppressRememberErrorDetails");
function workspaceMemoryFailureDiagnostics(err, onExtractionError) {
  let details;
  let stack;
  try {
    details = extractRememberErrorDetails(err);
  } catch (extractionErr) {
    reportRememberErrorExtractionFailure(
      onExtractionError,
      "details",
      extractionErr
    );
    details = void 0;
  }
  try {
    stack = extractRememberErrorStack(err);
  } catch (extractionErr) {
    reportRememberErrorExtractionFailure(
      onExtractionError,
      "stack",
      extractionErr
    );
    stack = void 0;
  }
  return {
    ...details ? { details } : {},
    debugDetails: details ?? "<details unavailable>",
    ...stack ? { stack } : {}
  };
}
__name(workspaceMemoryFailureDiagnostics, "workspaceMemoryFailureDiagnostics");

// packages/cli/src/runtime/workspace-memory-remember-constants.ts
init_esbuild_shims();
var MAX_REMEMBER_CONTENT_BYTES = 64 * 1024;

// packages/cli/src/runtime/workspace-memory-summaries.ts
init_esbuild_shims();
function formatWorkspaceMemoryForgetSummary(removedEntryCount) {
  return removedEntryCount > 0 ? `Forgot ${removedEntryCount} memory entr${removedEntryCount === 1 ? "y" : "ies"}.` : "No managed auto-memory entries matched.";
}
__name(formatWorkspaceMemoryForgetSummary, "formatWorkspaceMemoryForgetSummary");
function formatWorkspaceMemoryDreamSummary(touchedTopicCount) {
  return touchedTopicCount > 0 ? "Managed auto-memory dream completed." : "No managed auto-memory topics changed.";
}
__name(formatWorkspaceMemoryDreamSummary, "formatWorkspaceMemoryDreamSummary");

// packages/cli/src/config/mcp-server-secrets.ts
init_esbuild_shims();
var REDACTED_MCP_SECRET = "__redacted__";
function recordOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
__name(recordOf, "recordOf");
function redactRecord(record) {
  return record ? Object.fromEntries(
    Object.keys(record).map((key) => [key, REDACTED_MCP_SECRET])
  ) : record;
}
__name(redactRecord, "redactRecord");
function restoreRecord(incoming, prior) {
  if (!incoming) return incoming;
  const priorRecord = recordOf(prior);
  const result = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== REDACTED_MCP_SECRET) {
      result[key] = value;
    } else if (typeof priorRecord[key] === "string") {
      result[key] = priorRecord[key];
    }
  }
  return result;
}
__name(restoreRecord, "restoreRecord");
function redactMcpServerSecrets(server) {
  return {
    ...server,
    env: redactRecord(server.env),
    headers: redactRecord(server.headers),
    ...server.oauth?.clientSecret ? {
      oauth: {
        ...server.oauth,
        clientSecret: REDACTED_MCP_SECRET
      }
    } : {}
  };
}
__name(redactMcpServerSecrets, "redactMcpServerSecrets");
function restoreRedactedMcpSecrets(server, existing) {
  const existingOauth = recordOf(existing["oauth"]);
  const incomingSecret = server.oauth?.clientSecret;
  const restoredSecret = incomingSecret === REDACTED_MCP_SECRET ? existingOauth["clientSecret"] : incomingSecret;
  return {
    ...server,
    env: restoreRecord(server.env, existing["env"]),
    headers: restoreRecord(server.headers, existing["headers"]),
    ...server.oauth ? {
      oauth: {
        ...server.oauth,
        ...typeof restoredSecret === "string" ? { clientSecret: restoredSecret } : { clientSecret: void 0 }
      }
    } : {}
  };
}
__name(restoreRedactedMcpSecrets, "restoreRedactedMcpSecrets");
function redactMcpServersSetting(value) {
  const servers = recordOf(value);
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      const record = recordOf(server);
      return [name, redactMcpServerSecrets(record)];
    })
  );
}
__name(redactMcpServersSetting, "redactMcpServersSetting");
function restoreRedactedMcpServersSetting(value, existing) {
  const servers = recordOf(value);
  const existingServers = recordOf(existing);
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      const record = recordOf(server);
      return [
        name,
        restoreRedactedMcpSecrets(record, recordOf(existingServers[name]))
      ];
    })
  );
}
__name(restoreRedactedMcpServersSetting, "restoreRedactedMcpServersSetting");

// packages/cli/src/runtime/validate-server-name.ts
init_esbuild_shims();
var VALID_SERVER_NAME = /^[A-Za-z0-9_-]+$/;
var RESERVED_SERVER_NAMES = /* @__PURE__ */ new Set([
  "__proto__",
  "constructor",
  "prototype"
]);
function isValidServerName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 256 && VALID_SERVER_NAME.test(name) && !RESERVED_SERVER_NAMES.has(name);
}
__name(isValidServerName, "isValidServerName");

// packages/cli/src/acp-integration/generation.ts
init_esbuild_shims();
var GENERATION_MAX_PROMPT_BYTES = 32 * 1024;
var GENERATION_TIMEOUT_MS = 6e4;
async function executeGeneration(config, requestId, prompt, signal, emit) {
  const fastModel = config.getFastModel();
  const mainModel = config.getModel();
  const client = config.getBaseLlmClient();
  let modelSource = fastModel ? "fast" : "main";
  let resolved;
  if (fastModel) {
    try {
      resolved = await client.resolveForModel(fastModel, { failClosed: true });
    } catch {
      modelSource = "main";
    }
  }
  resolved ??= await client.resolveForModel(mainModel, { failClosed: true });
  const { contentGenerator, model } = resolved;
  await emit({ type: "started", model, modelSource });
  const stream = await contentGenerator.generateContentStream(
    {
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        abortSignal: signal,
        tools: [],
        thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
        temperature: 0.2
      }
    },
    `generation:${requestId}`
  );
  let seq = 0;
  let thinkingEmitted = false;
  let usage;
  for await (const chunk of stream) {
    if (!thinkingEmitted && chunk.candidates?.some(
      (candidate) => candidate.content?.parts?.some((part) => part.thought === true)
    )) {
      thinkingEmitted = true;
      await emit({ type: "thinking" });
    }
    const text = getResponseText(chunk) ?? "";
    if (text) {
      await emit({ type: "delta", seq: seq++, text });
    }
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
  }
  return {
    model,
    modelSource,
    ...usage?.promptTokenCount !== void 0 ? { inputTokens: usage.promptTokenCount } : {},
    ...usage?.candidatesTokenCount !== void 0 ? { outputTokens: usage.candidatesTokenCount } : {}
  };
}
__name(executeGeneration, "executeGeneration");

// packages/cli/src/acp-integration/session/history-replay-page.ts
init_esbuild_shims();
import { Buffer as Buffer2 } from "node:buffer";

// packages/cli/src/acp-integration/session/acp-tool-result-text-projection.ts
init_esbuild_shims();
import { Buffer } from "node:buffer";
var ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET = 65536;
var ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER = "\n[... truncated for ACP transport ...]\n";
var EMPTY_CONTENT_ARRAY_JSON_BYTES = Buffer.byteLength("[]", "utf8");
var EMPTY_TEXT_BLOCK_JSON_BYTES = Buffer.byteLength(
  JSON.stringify(createTextBlock("")),
  "utf8"
);
var JSON_ARRAY_SEPARATOR_BYTES = 1;
var TRUNCATION_MARKER_PAYLOAD_BYTES = jsonStringJsonByteLength(ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER) - JSON_STRING_DELIMITER_BYTES;
var MAX_CANONICAL_TEXT_BLOCKS = Math.floor(
  (ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET - EMPTY_CONTENT_ARRAY_JSON_BYTES + JSON_ARRAY_SEPARATOR_BYTES) / (EMPTY_TEXT_BLOCK_JSON_BYTES + JSON_ARRAY_SEPARATOR_BYTES)
);
function createTextBlock(text) {
  return {
    type: "content",
    content: { type: "text", text }
  };
}
__name(createTextBlock, "createTextBlock");
function isObjectRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isObjectRecord, "isObjectRecord");
function hasExactKeys(value, first, second) {
  const keys = Object.keys(value);
  return keys.length === 2 && Object.hasOwn(value, first) && Object.hasOwn(value, second);
}
__name(hasExactKeys, "hasExactKeys");
function canonicalTextBlocks(value) {
  if (!Array.isArray(value)) return void 0;
  for (const block of value) {
    if (!isObjectRecord(block) || !hasExactKeys(block, "type", "content") || block["type"] !== "content" || !isObjectRecord(block["content"]) || !hasExactKeys(block["content"], "type", "text") || block["content"]["type"] !== "text" || typeof block["content"]["text"] !== "string") {
      return void 0;
    }
  }
  return value;
}
__name(canonicalTextBlocks, "canonicalTextBlocks");
function contentSkeletonBytes(blockCount) {
  if (blockCount === 0) return EMPTY_CONTENT_ARRAY_JSON_BYTES;
  return EMPTY_CONTENT_ARRAY_JSON_BYTES + blockCount * EMPTY_TEXT_BLOCK_JSON_BYTES + (blockCount - 1) * JSON_ARRAY_SEPARATOR_BYTES;
}
__name(contentSkeletonBytes, "contentSkeletonBytes");
function fallbackContent() {
  return [createTextBlock(ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER)];
}
__name(fallbackContent, "fallbackContent");
function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
__name(jsonByteLength, "jsonByteLength");
function allocatePayloadBudgets(payloadBytes, availableBytes) {
  const base = payloadBytes.map(
    (bytes) => Math.min(bytes, TRUNCATION_MARKER_PAYLOAD_BYTES)
  );
  let remaining = availableBytes - base.reduce((sum, bytes) => sum + bytes, 0);
  if (remaining < 0) return void 0;
  const capacities = payloadBytes.map((bytes, index) => ({
    index,
    capacity: bytes - base[index]
  }));
  const sorted = capacities.filter(({ capacity }) => capacity > 0).sort(
    (left, right) => left.capacity === right.capacity ? left.index - right.index : left.capacity - right.capacity
  );
  let active = sorted.length;
  let position = 0;
  let level = 0;
  let remainder = 0;
  while (position < sorted.length && active > 0 && remaining > 0) {
    const nextLevel = sorted[position].capacity;
    const cost = (nextLevel - level) * active;
    if (cost > remaining) {
      level += Math.floor(remaining / active);
      remainder = remaining % active;
      remaining = 0;
      break;
    }
    level = nextLevel;
    remaining -= cost;
    while (position < sorted.length && sorted[position].capacity === nextLevel) {
      position++;
      active--;
    }
  }
  const allocations = base.map(
    (bytes, index) => bytes + Math.min(capacities[index].capacity, level)
  );
  if (remainder > 0) {
    for (const { index, capacity } of capacities) {
      if (remainder === 0) break;
      if (capacity > level) {
        allocations[index]++;
        remainder--;
      }
    }
  }
  return allocations;
}
__name(allocatePayloadBudgets, "allocatePayloadBudgets");
function projectContent(original) {
  if (original.length > MAX_CANONICAL_TEXT_BLOCKS) return fallbackContent();
  const skeletonBytes = contentSkeletonBytes(original.length);
  const availablePayloadBytes = ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET - skeletonBytes;
  let remainingPayloadBytes = availablePayloadBytes;
  let needsProjection = false;
  for (const block of original) {
    const payloadBytes2 = jsonStringPayloadByteLength(
      block.content.text,
      remainingPayloadBytes
    );
    if (payloadBytes2 > remainingPayloadBytes) {
      needsProjection = true;
      break;
    }
    remainingPayloadBytes -= payloadBytes2;
  }
  if (!needsProjection) return original;
  const baseScans = original.map(
    (block) => jsonStringPayloadByteLength(
      block.content.text,
      TRUNCATION_MARKER_PAYLOAD_BYTES
    )
  );
  const basePayloadBytes = baseScans.map(
    (bytes) => Math.min(bytes, TRUNCATION_MARKER_PAYLOAD_BYTES)
  );
  const baseTotal = basePayloadBytes.reduce((sum, bytes) => sum + bytes, 0);
  if (baseTotal > availablePayloadBytes) return fallbackContent();
  const payloadBytes = original.map((block, index) => {
    if (baseScans[index] <= TRUNCATION_MARKER_PAYLOAD_BYTES) {
      return baseScans[index];
    }
    const maximumAllocation = availablePayloadBytes - baseTotal + basePayloadBytes[index];
    const bytes = jsonStringPayloadByteLength(
      block.content.text,
      maximumAllocation
    );
    return bytes <= maximumAllocation ? bytes : maximumAllocation + 1;
  });
  const allocations = allocatePayloadBudgets(
    payloadBytes,
    availablePayloadBytes
  );
  if (!allocations) return fallbackContent();
  const projected = original.map((block, index) => {
    if (payloadBytes[index] <= allocations[index]) return block;
    return createTextBlock(
      truncateJsonStringPayload(
        block.content.text,
        payloadBytes[index],
        allocations[index],
        ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER
      )
    );
  });
  return jsonByteLength(projected) <= ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET ? projected : fallbackContent();
}
__name(projectContent, "projectContent");
function projectRawOutput(value) {
  const payloadBudget = ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET - JSON_STRING_DELIMITER_BYTES;
  const payloadBytes = jsonStringPayloadByteLength(value, payloadBudget);
  if (payloadBytes <= payloadBudget) return value;
  const projected = truncateJsonStringPayload(
    value,
    payloadBytes,
    payloadBudget,
    ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER
  );
  return jsonByteLength(projected) <= ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET ? projected : ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER;
}
__name(projectRawOutput, "projectRawOutput");
function a2uiMeta(meta) {
  if (!meta) return void 0;
  const toolName = typeof meta["toolName"] === "string" ? meta["toolName"] : void 0;
  const serverId = typeof meta["serverId"] === "string" ? meta["serverId"] : void 0;
  return toolName === void 0 && serverId === void 0 ? void 0 : {
    ...toolName === void 0 ? {} : { toolName },
    ...serverId === void 0 ? {} : { serverId }
  };
}
__name(a2uiMeta, "a2uiMeta");
function projectAcpToolResultUpdate(update) {
  const record = update;
  if (record["sessionUpdate"] !== "tool_call_update") return update;
  const meta = isObjectRecord(record["_meta"]) ? record["_meta"] : void 0;
  if (isA2uiToolMeta(a2uiMeta(meta))) return update;
  const content = canonicalTextBlocks(record["content"]);
  const rawOutput = record["rawOutput"];
  if (content?.length === 1 && typeof rawOutput === "string" && rawOutput === content[0].content.text) {
    const projectedContent2 = projectContent(content);
    if (projectedContent2 === content) return update;
    const projectedText = projectedContent2[0].content.text;
    return {
      ...record,
      content: projectedContent2,
      rawOutput: projectedText
    };
  }
  const projectedContent = content ? projectContent(content) : void 0;
  const projectedRawOutput = typeof rawOutput === "string" ? projectRawOutput(rawOutput) : void 0;
  const contentChanged = projectedContent !== void 0 && projectedContent !== content;
  const rawOutputChanged = projectedRawOutput !== void 0 && projectedRawOutput !== rawOutput;
  if (!contentChanged && !rawOutputChanged) return update;
  return {
    ...record,
    ...contentChanged ? { content: projectedContent } : {},
    ...rawOutputChanged ? { rawOutput: projectedRawOutput } : {}
  };
}
__name(projectAcpToolResultUpdate, "projectAcpToolResultUpdate");

// packages/cli/src/acp-integration/session/history-replay-page.ts
var HistoryReplayLimitError = class extends Error {
  constructor(sessionId, reason, observed, limit) {
    super(
      `Transcript replay for session ${sessionId} exceeds the ${reason} limit (${observed}, max ${limit})`
    );
    this.sessionId = sessionId;
    this.reason = reason;
    this.observed = observed;
    this.limit = limit;
    this.name = "HistoryReplayLimitError";
  }
  static {
    __name(this, "HistoryReplayLimitError");
  }
};
function createReplayCumulativeUsage() {
  return {
    promptTokens: 0,
    cachedTokens: 0,
    candidateTokens: 0,
    apiTimeMs: 0
  };
}
__name(createReplayCumulativeUsage, "createReplayCumulativeUsage");
function copyCumulativeUsage(target, source) {
  target.promptTokens = source.promptTokens;
  target.cachedTokens = source.cachedTokens;
  target.candidateTokens = source.candidateTokens;
  target.apiTimeMs = source.apiTimeMs;
}
__name(copyCumulativeUsage, "copyCumulativeUsage");
function isObjectRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isObjectRecord2, "isObjectRecord");
function isCumulativeUsage(value) {
  if (!isObjectRecord2(value)) return false;
  return typeof value["promptTokens"] === "number" && Number.isFinite(value["promptTokens"]) && typeof value["cachedTokens"] === "number" && Number.isFinite(value["cachedTokens"]) && typeof value["candidateTokens"] === "number" && Number.isFinite(value["candidateTokens"]) && typeof value["apiTimeMs"] === "number" && Number.isFinite(value["apiTimeMs"]);
}
__name(isCumulativeUsage, "isCumulativeUsage");
function isPendingReplayToolCall(value) {
  if (!isObjectRecord2(value)) return false;
  return typeof value["callId"] === "string" && typeof value["toolName"] === "string" && (value["timestamp"] === void 0 || typeof value["timestamp"] === "string") && typeof value["recordId"] === "string";
}
__name(isPendingReplayToolCall, "isPendingReplayToolCall");
function isCurrentPendingReplayToolCall(value) {
  if (!isObjectRecord2(value)) return false;
  return typeof value["callId"] === "string" && typeof value["toolName"] === "string" && typeof value["sourceRecordId"] === "string" && (value["sourceTimestamp"] === void 0 || typeof value["sourceTimestamp"] === "string");
}
__name(isCurrentPendingReplayToolCall, "isCurrentPendingReplayToolCall");
function parseTranscriptReplayState(replay, logger) {
  if (!isObjectRecord2(replay)) {
    return {
      pendingToolCalls: [],
      cumulativeUsage: createReplayCumulativeUsage()
    };
  }
  if ("v" in replay && replay["v"] !== 1) {
    throw new TypeError("Unsupported transcript replay state version.");
  }
  const rawPending = replay["pendingToolCalls"];
  const pendingToolCalls = Array.isArray(rawPending) ? rawPending.flatMap((pending) => {
    if (isPendingReplayToolCall(pending)) return [pending];
    if (isCurrentPendingReplayToolCall(pending)) {
      return [
        {
          callId: pending.callId,
          toolName: pending.toolName,
          recordId: pending.sourceRecordId,
          ...pending.sourceTimestamp ? { timestamp: pending.sourceTimestamp } : {}
        }
      ];
    }
    return [];
  }) : [];
  if (logger && Array.isArray(rawPending) && pendingToolCalls.length !== rawPending.length) {
    const dropped = rawPending.length - pendingToolCalls.length;
    logger.warn(
      `[transcript] replay state dropped ${dropped} of ${rawPending.length} malformed pending tool calls`
    );
  }
  const cumulativeUsage = isCumulativeUsage(replay["cumulativeUsage"]) ? { ...replay["cumulativeUsage"] } : createReplayCumulativeUsage();
  const rawGoalState = replay["goalState"];
  const goalState = rawGoalState === void 0 ? void 0 : parseGoalSnapshotV2(rawGoalState);
  if (logger && rawGoalState !== void 0 && !goalState) {
    logger.warn("[transcript] replay state dropped a malformed Goal state");
  }
  const rawGoalCause = replay["goalCause"];
  const goalCause = rawGoalCause === void 0 ? void 0 : parseGoalStateCause(rawGoalCause);
  if (logger && rawGoalCause !== void 0 && !goalCause) {
    logger.warn("[transcript] replay state dropped a malformed Goal cause");
  }
  return {
    pendingToolCalls,
    cumulativeUsage,
    ...goalState ? { goalState } : {},
    ...goalCause ? { goalCause } : {}
  };
}
__name(parseTranscriptReplayState, "parseTranscriptReplayState");
function replayContext(sessionId, updates, cumulativeUsage, config, limits) {
  let activeRecordId = null;
  let serializedUpdateBytes = 2;
  return {
    sessionId,
    sendUpdate: /* @__PURE__ */ __name(async (update) => {
      const projectedUpdate = projectAcpToolResultUpdate(update);
      const updateWithRecordId = (() => {
        if (activeRecordId === null) return projectedUpdate;
        const record = projectedUpdate;
        const meta = isObjectRecord2(record["_meta"]) ? record["_meta"] : {};
        return {
          ...record,
          _meta: { ...meta, "qwen.session.recordId": activeRecordId }
        };
      })();
      const deliveredUpdate = liftSessionUpdateTimestamp(updateWithRecordId);
      observeAcpToolResultProjection(
        update,
        projectedUpdate,
        sessionId,
        deliveredUpdate
      );
      if (limits) {
        const updateCount = updates.length + 1;
        if (updateCount > limits.maxUpdates) {
          throw new HistoryReplayLimitError(
            sessionId,
            "updates",
            updateCount,
            limits.maxUpdates
          );
        }
        serializedUpdateBytes += (updates.length === 0 ? 0 : 1) + Buffer2.byteLength(JSON.stringify(deliveredUpdate), "utf8");
        if (serializedUpdateBytes > limits.maxBytes) {
          throw new HistoryReplayLimitError(
            sessionId,
            "bytes",
            serializedUpdateBytes,
            limits.maxBytes
          );
        }
      }
      updates.push(deliveredUpdate);
    }, "sendUpdate"),
    setActiveRecordId: /* @__PURE__ */ __name((recordId) => {
      activeRecordId = recordId;
    }, "setActiveRecordId"),
    cumulativeUsage,
    ...config ? { config } : {}
  };
}
__name(replayContext, "replayContext");
async function collectHistoryReplayUpdates({
  sessionId,
  config,
  records,
  gaps,
  cumulativeUsage,
  logger,
  replayState,
  goalBootstrap,
  limits,
  suppressRestoreAskUserQuestion,
  finalizeDangling
}) {
  const updates = [];
  try {
    const initial = parseTranscriptReplayState(replayState, logger);
    let skipFinalizeCallIds;
    if (suppressRestoreAskUserQuestion !== true && config?.getRestoreAskUserQuestion?.() === true) {
      const replayClient = config.getLlmClient?.();
      const lastHistoryContent = replayClient?.isInitialized?.() === true ? replayClient.getChat?.()?.peekLastHistoryEntry?.() ?? lastHistoryContentFromRecords(records) : lastHistoryContentFromRecords(records);
      skipFinalizeCallIds = restorableAskUserQuestionCallIds(lastHistoryContent);
    }
    await new HistoryReplayer(
      replayContext(sessionId, updates, cumulativeUsage, config, limits)
    ).replay(records, gaps, {
      ...initial.goalState ? { initialGoalState: initial.goalState } : {},
      ...initial.goalCause ? { initialGoalCause: initial.goalCause } : {},
      ...goalBootstrap ? { goalBootstrap } : {},
      ...skipFinalizeCallIds ? { skipFinalizeCallIds } : {},
      ...finalizeDangling === void 0 ? {} : { finalizeDangling }
    });
  } catch (error) {
    if (error instanceof HistoryReplayLimitError) throw error;
    const replayError = error instanceof Error ? error.message : String(error);
    logger?.warn(
      "[historyReplay] History replay failed for session %s (partial updates: %d):",
      sessionId,
      updates.length,
      error
    );
    return { updates, replayError };
  }
  return { updates };
}
__name(collectHistoryReplayUpdates, "collectHistoryReplayUpdates");
function liftSessionUpdateTimestamp(update) {
  const record = update;
  const meta = record["_meta"];
  const timestamp = isObjectRecord2(meta) ? meta["timestamp"] : void 0;
  return typeof timestamp === "number" || typeof timestamp === "string" ? { ...record, timestamp } : update;
}
__name(liftSessionUpdateTimestamp, "liftSessionUpdateTimestamp");
function readTranscriptSourceRecordIds(update) {
  const value = update;
  const meta = value["_meta"] && typeof value["_meta"] === "object" ? value["_meta"] : void 0;
  const transcript = meta?.["qwenTranscript"] && typeof meta["qwenTranscript"] === "object" ? meta["qwenTranscript"] : void 0;
  const sourceRecordIds = transcript?.["sourceRecordIds"];
  if (!Array.isArray(sourceRecordIds)) return void 0;
  return sourceRecordIds.filter((id) => typeof id === "string");
}
__name(readTranscriptSourceRecordIds, "readTranscriptSourceRecordIds");
async function replayTranscriptRecordPage({
  sessionId,
  page,
  config,
  encodeCursor,
  logger,
  finalizeDangling = true
}) {
  const state = parseTranscriptReplayState(page.replay, logger);
  const updates = [];
  const replayer = new HistoryReplayer(
    replayContext(sessionId, updates, state.cumulativeUsage, config)
  );
  let replayState;
  let replayError;
  try {
    const replayPageState = await replayer.replayPage(page.records, {
      pendingToolCalls: page.direction === "backward" ? [] : state.pendingToolCalls,
      finalizeDangling: finalizeDangling && (page.direction === "backward" || !page.hasMore),
      gaps: page.gaps,
      ...state.goalState ? { goalState: state.goalState } : {},
      ...state.goalCause ? { goalCause: state.goalCause } : {}
    });
    replayState = replayPageState.replay;
  } catch (error) {
    logger?.warn(
      "[historyReplay] Paged history replay failed for session %s (partial updates: %d):",
      sessionId,
      updates.length,
      error
    );
    replayState = replayer.getReplayState();
    replayError = "Replay conversion failed for this page";
  }
  if (page.branchPointsByAssistantUuid) {
    const branchPoints = page.branchPointsByAssistantUuid;
    const lastChunkIndexByRecordId = /* @__PURE__ */ new Map();
    updates.forEach((update, index) => {
      if (update.sessionUpdate !== "agent_message_chunk") return;
      const text = update.content?.text;
      if (typeof text !== "string" || text.length === 0) return;
      for (const recordId of readTranscriptSourceRecordIds(update) ?? []) {
        if (Object.hasOwn(branchPoints, recordId)) {
          lastChunkIndexByRecordId.set(recordId, index);
        }
      }
    });
    const decoratedIndexes = /* @__PURE__ */ new Set();
    for (const [recordId, index] of lastChunkIndexByRecordId) {
      if (decoratedIndexes.has(index)) continue;
      decoratedIndexes.add(index);
      const value = updates[index];
      const meta = value["_meta"] && typeof value["_meta"] === "object" ? value["_meta"] : void 0;
      const transcript = meta?.["qwenTranscript"] && typeof meta["qwenTranscript"] === "object" ? meta["qwenTranscript"] : void 0;
      value["_meta"] = {
        ...meta,
        qwenTranscript: {
          ...transcript,
          branchRecordId: branchPoints[recordId]
        }
      };
    }
  }
  const nextCursor = page.nextCursorState && replayError === void 0 ? encodeCursor({
    ...page.nextCursorState,
    ...page.direction === "backward" ? {} : { replay: replayState }
  }) : void 0;
  return {
    updates,
    ...nextCursor ? { nextCursor } : {},
    hasMore: replayError === void 0 && page.hasMore,
    startTime: page.startTime,
    lastUpdated: page.lastUpdated,
    ...replayError ? { partial: true, replayError } : {}
  };
}
__name(replayTranscriptRecordPage, "replayTranscriptRecordPage");

export {
  createWorkspaceMemoryExtractionErrorLogger,
  extractRememberErrorCode,
  workspaceMemoryFailureCode,
  shouldSuppressRememberErrorDetails,
  workspaceMemoryFailureDiagnostics,
  MAX_REMEMBER_CONTENT_BYTES,
  formatWorkspaceMemoryForgetSummary,
  formatWorkspaceMemoryDreamSummary,
  REDACTED_MCP_SECRET,
  redactMcpServerSecrets,
  restoreRedactedMcpSecrets,
  redactMcpServersSetting,
  restoreRedactedMcpServersSetting,
  isValidServerName,
  GENERATION_MAX_PROMPT_BYTES,
  GENERATION_TIMEOUT_MS,
  executeGeneration,
  projectAcpToolResultUpdate,
  HistoryReplayLimitError,
  createReplayCumulativeUsage,
  copyCumulativeUsage,
  collectHistoryReplayUpdates,
  replayTranscriptRecordPage
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
