// Force strict mode and setup for ESM
"use strict";
import {
  EXTERNAL_TOOL_GUARD_TOKEN_ENV,
  containsUnsafeExternalToolGuardControlCharacter,
  isValidExternalToolGuardDenialReason
} from "./chunk-3VUENPWF.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/external-tool-guard-provider.ts
init_esbuild_shims();
import { randomUUID } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
var EXTERNAL_TOOL_GUARD_PROTOCOL_VERSION = 1;
var DEFAULT_EXTERNAL_TOOL_GUARD_TIMEOUT_MS = 3e3;
var MIN_EXTERNAL_TOOL_GUARD_TIMEOUT_MS = 100;
var MAX_EXTERNAL_TOOL_GUARD_TIMEOUT_MS = 3e4;
var MAX_RESPONSE_BYTES = 64 * 1024;
var MAX_REQUEST_BYTES = 1024 * 1024;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord, "isRecord");
function hasExactKeys(value, required, optional = []) {
  const keys = Object.keys(value);
  const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}
__name(hasExactKeys, "hasExactKeys");
function normalizeEndpoint(raw) {
  if (typeof raw !== "string") {
    throw new TypeError(
      "Invalid external tool guard endpoint: expected an absolute loopback HTTP(S) origin."
    );
  }
  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new TypeError(
      "Invalid external tool guard endpoint: expected an absolute loopback HTTP(S) origin."
    );
  }
  const hostname = endpoint.hostname.toLowerCase();
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:" || hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1" && hostname !== "[::1]" || endpoint.username !== "" || endpoint.password !== "" || endpoint.pathname !== "/" || endpoint.search !== "" || endpoint.hash !== "") {
    throw new TypeError(
      "Invalid external tool guard endpoint: expected an origin-only loopback HTTP(S) URL."
    );
  }
  return endpoint;
}
__name(normalizeEndpoint, "normalizeEndpoint");
function normalizeToken(raw) {
  if (typeof raw !== "string" || containsUnsafeExternalToolGuardControlCharacter(raw)) {
    throw new TypeError(
      `Invalid ${EXTERNAL_TOOL_GUARD_TOKEN_ENV}: expected a non-blank token without control characters.`
    );
  }
  const token = raw.trim();
  if (token.length === 0 || token.length > 8192) {
    throw new TypeError(
      `Invalid ${EXTERNAL_TOOL_GUARD_TOKEN_ENV}: expected a non-blank token without control characters.`
    );
  }
  return token;
}
__name(normalizeToken, "normalizeToken");
function normalizeTimeout(timeoutMs) {
  const value = timeoutMs ?? DEFAULT_EXTERNAL_TOOL_GUARD_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < MIN_EXTERNAL_TOOL_GUARD_TIMEOUT_MS || value > MAX_EXTERNAL_TOOL_GUARD_TIMEOUT_MS) {
    throw new TypeError(
      `Invalid external tool guard timeout: expected an integer in [${MIN_EXTERNAL_TOOL_GUARD_TIMEOUT_MS}, ${MAX_EXTERNAL_TOOL_GUARD_TIMEOUT_MS}] ms.`
    );
  }
  return value;
}
__name(normalizeTimeout, "normalizeTimeout");
function validateHandshakeResponse(value, nonce) {
  if (!isRecord(value) || !hasExactKeys(value, ["protocolVersion", "nonce", "capabilities"]) || value["protocolVersion"] !== EXTERNAL_TOOL_GUARD_PROTOCOL_VERSION || value["nonce"] !== nonce || !isRecord(value["capabilities"]) || !hasExactKeys(value["capabilities"], ["prepare"]) || value["capabilities"]["prepare"] !== true) {
    throw new Error("External tool guard handshake response is incompatible.");
  }
}
__name(validateHandshakeResponse, "validateHandshakeResponse");
function validatePrepareResponse(value, requestId) {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["protocolVersion", "requestId", "allowed"],
    ["reason"]
  ) || value["protocolVersion"] !== EXTERNAL_TOOL_GUARD_PROTOCOL_VERSION || value["requestId"] !== requestId || typeof value["allowed"] !== "boolean") {
    throw new Error("External tool guard prepare response is invalid.");
  }
  if (value["allowed"]) {
    if (Object.hasOwn(value, "reason")) {
      throw new Error("External tool guard allow response contains a reason.");
    }
    return { allowed: true };
  }
  if (!Object.hasOwn(value, "reason")) return { allowed: false };
  const reason = value["reason"];
  if (!isValidExternalToolGuardDenialReason(reason)) {
    throw new Error(
      "External tool guard denial response contains an unsafe reason."
    );
  }
  return { allowed: false, reason };
}
__name(validatePrepareResponse, "validatePrepareResponse");
var RequiredExternalToolGuard = class {
  static {
    __name(this, "RequiredExternalToolGuard");
  }
  endpoint;
  token;
  timeoutMs;
  initialized = false;
  constructor(options) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.token = normalizeToken(options.token);
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
  }
  async initialize() {
    const nonce = randomUUID();
    const response = await this.request("/v1/handshake", {
      protocolVersion: EXTERNAL_TOOL_GUARD_PROTOCOL_VERSION,
      nonce,
      client: "qwen-code"
    });
    validateHandshakeResponse(response, nonce);
    this.initialized = true;
  }
  prepare = /* @__PURE__ */ __name(async (request) => {
    if (!this.initialized) {
      throw new Error("External tool guard has not completed its handshake.");
    }
    const requestId = randomUUID();
    const response = await this.request("/v1/prepare", {
      protocolVersion: EXTERNAL_TOOL_GUARD_PROTOCOL_VERSION,
      requestId,
      sessionId: request.sessionId,
      promptId: request.promptId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      arguments: request.arguments
    });
    return validatePrepareResponse(response, requestId);
  }, "prepare");
  request(pathname, value) {
    let body;
    try {
      body = Buffer.from(JSON.stringify(value), "utf8");
    } catch {
      return Promise.reject(
        new Error("External tool guard request is not JSON serializable.")
      );
    }
    if (body.byteLength > MAX_REQUEST_BYTES) {
      return Promise.reject(
        new Error("External tool guard request exceeds the size limit.")
      );
    }
    const transport = this.endpoint.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = /* @__PURE__ */ __name((error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      }, "finish");
      const hostname = this.endpoint.hostname;
      const localhost = hostname.toLowerCase() === "localhost";
      const request = transport.request(
        {
          protocol: this.endpoint.protocol,
          hostname: localhost ? "127.0.0.1" : hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname,
          port: this.endpoint.port || void 0,
          // A security boundary must not inherit a process-global Agent that
          // an embedding or dependency could have replaced with proxy logic.
          agent: false,
          ...localhost && this.endpoint.protocol === "https:" ? { servername: "localhost" } : {},
          method: "POST",
          path: pathname,
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
            accept: "application/json",
            host: this.endpoint.host,
            "content-length": String(body.byteLength)
          }
        },
        (response) => {
          const chunks = [];
          let received = 0;
          response.on("data", (chunk) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
            received += bytes.byteLength;
            if (received > MAX_RESPONSE_BYTES) {
              finish(
                new Error(
                  "External tool guard response exceeds the size limit."
                )
              );
              response.destroy();
              return;
            }
            chunks.push(bytes);
          });
          response.on("end", () => {
            if (response.statusCode !== 200) {
              finish(
                new Error(
                  `External tool guard returned HTTP ${response.statusCode ?? "unknown"}.`
                )
              );
              return;
            }
            const contentType = response.headers["content-type"];
            if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
              finish(
                new Error(
                  "External tool guard returned a non-JSON content type."
                )
              );
              return;
            }
            try {
              finish(
                void 0,
                JSON.parse(Buffer.concat(chunks).toString("utf8"))
              );
            } catch {
              finish(new Error("External tool guard returned malformed JSON."));
            }
          });
          response.on("error", () => {
            finish(new Error("External tool guard response failed."));
          });
          response.on("aborted", () => {
            finish(new Error("External tool guard response was aborted."));
          });
        }
      );
      const timer = setTimeout(() => {
        request.destroy();
        finish(new Error("External tool guard request timed out."));
      }, this.timeoutMs);
      timer.unref();
      request.on("error", () => {
        finish(new Error("External tool guard request failed."));
      });
      request.end(body);
    });
  }
};
export {
  DEFAULT_EXTERNAL_TOOL_GUARD_TIMEOUT_MS,
  EXTERNAL_TOOL_GUARD_PROTOCOL_VERSION,
  MAX_EXTERNAL_TOOL_GUARD_TIMEOUT_MS,
  MIN_EXTERNAL_TOOL_GUARD_TIMEOUT_MS,
  RequiredExternalToolGuard
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
