// Force strict mode and setup for ESM
"use strict";
import {
  normalizeSessionIdForLookup
} from "./chunk-ZEZKIS2K.js";
import {
  MAX_WORKSPACE_PATH_LENGTH,
  translateAndCheckAbsoluteWorkspacePath
} from "./chunk-6PLDPT2C.js";
import {
  writeStderrLine
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/server/request-helpers.ts
init_esbuild_shims();
function sendJsonBodyParserError(res, err) {
  if (err instanceof SyntaxError && "status" in err && err.status === 400) {
    res.status(400).json({ error: "Invalid JSON in request body" });
    return true;
  }
  if (err && typeof err === "object" && "status" in err && err.status === 413) {
    res.status(413).json({ error: "Request body too large (max 10 MB)" });
    return true;
  }
  return false;
}
__name(sendJsonBodyParserError, "sendJsonBodyParserError");
var PROTOTYPE_POLLUTION_KEYS = /* @__PURE__ */ new Set([
  "__proto__",
  "constructor",
  "prototype"
]);
var CLIENT_ID_HEADER = "x-qwen-client-id";
var MAX_CLIENT_ID_LENGTH = 128;
var MAX_TOOL_NAME_LENGTH = 256;
var MAX_SKILL_NAME_LENGTH = 256;
var MAX_SERVER_NAME_LENGTH = 256;
var CLIENT_ID_RE = /^[A-Za-z0-9._:-]+$/;
var INVALID_PERMISSION_OUTCOME_ERROR = '`outcome` must be `{ outcome: "cancelled" }` or `{ outcome: "selected", optionId: string }`';
var deferredRuntimeTimingKey = Symbol(
  "deferredRuntimeRequestTiming"
);
function setDeferredRuntimeRequestTiming(req, timing) {
  req[deferredRuntimeTimingKey] = timing;
}
__name(setDeferredRuntimeRequestTiming, "setDeferredRuntimeRequestTiming");
function getDeferredRuntimeRequestTiming(req) {
  return req[deferredRuntimeTimingKey];
}
__name(getDeferredRuntimeRequestTiming, "getDeferredRuntimeRequestTiming");
function safeBody(req) {
  const raw = req.body;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return /* @__PURE__ */ Object.create(null);
  }
  const out = /* @__PURE__ */ Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}
__name(safeBody, "safeBody");
function parseOptionalWorkspaceCwd(body, boundWorkspace, res) {
  const hasCwd = "cwd" in body;
  if (hasCwd && typeof body["cwd"] !== "string") {
    res.status(400).json({ error: "`cwd` must be a string absolute path when provided" });
    return void 0;
  }
  if (hasCwd && body["cwd"].length > MAX_WORKSPACE_PATH_LENGTH) {
    res.status(400).json({
      error: `\`cwd\` exceeds the ${MAX_WORKSPACE_PATH_LENGTH}-character limit`
    });
    return void 0;
  }
  const cwd = translateAndCheckAbsoluteWorkspacePath(
    hasCwd ? body["cwd"] : boundWorkspace
  );
  if (cwd === null) {
    res.status(400).json({ error: "`cwd` must be an absolute path when provided" });
    return void 0;
  }
  return cwd;
}
__name(parseOptionalWorkspaceCwd, "parseOptionalWorkspaceCwd");
function requireSessionId(req, res) {
  const sessionId = req.params["id"];
  if (!sessionId) {
    res.status(400).json({ error: "`sessionId` route parameter is required" });
    return null;
  }
  return normalizeSessionIdForLookup(sessionId);
}
__name(requireSessionId, "requireSessionId");
function parseClientIdHeader(req, res) {
  const raw = req.get(CLIENT_ID_HEADER);
  if (raw === void 0 || raw === "") return void 0;
  if (raw.length > MAX_CLIENT_ID_LENGTH || !CLIENT_ID_RE.test(raw)) {
    res.status(400).json({
      error: "`X-Qwen-Client-Id` must be a non-empty token of 128 characters or fewer",
      code: "invalid_client_id"
    });
    return null;
  }
  return raw;
}
__name(parseClientIdHeader, "parseClientIdHeader");
function detectFromLoopback(req) {
  const addr = req.socket?.remoteAddress;
  if (typeof addr !== "string") return false;
  if (addr === "::1") return true;
  if (addr.startsWith("127.")) return true;
  if (addr.startsWith("::ffff:127.")) return true;
  return false;
}
__name(detectFromLoopback, "detectFromLoopback");
function validateMcpRuntimeServerName(name, res) {
  if (typeof name !== "string" || name.length === 0) {
    res.status(400).json({
      error: "Server name is required and must be a non-empty string",
      code: "invalid_server_name"
    });
    return false;
  }
  if (name.length > MAX_SERVER_NAME_LENGTH) {
    res.status(400).json({
      error: `Server name exceeds ${MAX_SERVER_NAME_LENGTH}-character limit`,
      code: "invalid_server_name"
    });
    return false;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    res.status(400).json({
      error: "Server name must contain only alphanumeric characters, underscores, and hyphens",
      code: "invalid_server_name"
    });
    return false;
  }
  if (name === "__proto__" || name === "constructor" || name === "prototype") {
    res.status(400).json({
      error: "Server name must not be a reserved JS property name",
      code: "invalid_server_name"
    });
    return false;
  }
  return true;
}
__name(validateMcpRuntimeServerName, "validateMcpRuntimeServerName");
function parseAndValidateWorkspaceClientId(req, res, bridge) {
  const raw = parseClientIdHeader(req, res);
  if (raw === null || raw === void 0) return raw;
  const bridges = Array.isArray(bridge) ? bridge : [bridge];
  if (!bridges.some((candidate) => candidate.knownClientIds().has(raw))) {
    res.status(400).json({
      error: `Client id "${raw}" is not registered for this workspace`,
      code: "invalid_client_id",
      clientId: raw
    });
    return null;
  }
  return raw;
}
__name(parseAndValidateWorkspaceClientId, "parseAndValidateWorkspaceClientId");
function createBuildWorkspaceCtx(boundWorkspace) {
  return (route, clientId) => ({
    originatorClientId: clientId,
    route,
    workspaceCwd: boundWorkspace
  });
}
__name(createBuildWorkspaceCtx, "createBuildWorkspaceCtx");
function parsePermissionVoteBody(req, res) {
  const body = safeBody(req);
  const outcome = body["outcome"];
  if (!isValidOutcome(outcome)) {
    res.status(400).json({ error: INVALID_PERMISSION_OUTCOME_ERROR });
    return void 0;
  }
  return {
    ...body,
    outcome
  };
}
__name(parsePermissionVoteBody, "parsePermissionVoteBody");
function isValidOutcome(raw) {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw;
  if (obj["outcome"] === "cancelled") return true;
  return obj["outcome"] === "selected" && typeof obj["optionId"] === "string" && obj["optionId"].length > 0;
}
__name(isValidOutcome, "isValidOutcome");
var MIN_QUERY_MAX_QUEUED = 16;
var MAX_QUERY_MAX_QUEUED = 2048;
function parseMaxQueuedQuery(raw, res) {
  if (raw === void 0) return void 0;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    writeStderrLine(
      `qwen serve: rejected ?maxQueued ${safeLogValue(raw)} (not a decimal integer)`
    );
    res.status(400).json({
      error: "`maxQueued` must be a decimal integer",
      code: "invalid_max_queued"
    });
    return null;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_QUERY_MAX_QUEUED || n > MAX_QUERY_MAX_QUEUED) {
    writeStderrLine(
      `qwen serve: rejected ?maxQueued ${safeLogValue(raw)} (outside [${MIN_QUERY_MAX_QUEUED}, ${MAX_QUERY_MAX_QUEUED}])`
    );
    res.status(400).json({
      error: `\`maxQueued\` must be in [${MIN_QUERY_MAX_QUEUED}, ${MAX_QUERY_MAX_QUEUED}]`,
      code: "invalid_max_queued"
    });
    return null;
  }
  return n;
}
__name(parseMaxQueuedQuery, "parseMaxQueuedQuery");
function safeLogValue(raw) {
  return JSON.stringify(String(raw)).slice(0, 82);
}
__name(safeLogValue, "safeLogValue");
function parseLastEventId(raw) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    if (typeof raw === "string" && raw.length > 0) {
      writeStderrLine(
        `qwen serve: rejected Last-Event-ID ${safeLogValue(raw)} (not a decimal integer)`
      );
    }
    return void 0;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) {
    writeStderrLine(
      `qwen serve: rejected Last-Event-ID ${safeLogValue(raw)} (exceeds Number.MAX_SAFE_INTEGER)`
    );
    return void 0;
  }
  return n;
}
__name(parseLastEventId, "parseLastEventId");

export {
  sendJsonBodyParserError,
  CLIENT_ID_HEADER,
  MAX_CLIENT_ID_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  MAX_SKILL_NAME_LENGTH,
  MAX_SERVER_NAME_LENGTH,
  CLIENT_ID_RE,
  setDeferredRuntimeRequestTiming,
  getDeferredRuntimeRequestTiming,
  safeBody,
  parseOptionalWorkspaceCwd,
  requireSessionId,
  parseClientIdHeader,
  detectFromLoopback,
  validateMcpRuntimeServerName,
  parseAndValidateWorkspaceClientId,
  createBuildWorkspaceCtx,
  parsePermissionVoteBody,
  parseMaxQueuedQuery,
  safeLogValue,
  parseLastEventId
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
