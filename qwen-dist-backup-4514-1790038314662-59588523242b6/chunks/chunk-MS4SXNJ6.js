// Force strict mode and setup for ESM
"use strict";
import {
  redactProxyCredentials
} from "./chunk-SBP43AO6.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/responses-http-error.ts
init_esbuild_shims();
var ResponsesHttpError = class extends Error {
  constructor(status, body, responseHeaders, secrets = []) {
    const sanitize = /* @__PURE__ */ __name((value) => {
      let text = redactProxyCredentials(value);
      for (const secret of secrets) {
        if (secret) text = text.split(secret).join("<redacted>");
      }
      return text;
    }, "sanitize");
    const headers = new Headers();
    for (const name of [
      "x-request-id",
      "retry-after",
      "retry-after-ms",
      "x-should-retry"
    ]) {
      const value = responseHeaders?.get(name);
      if (value) headers.set(name, sanitize(value));
    }
    let envelope;
    try {
      envelope = record(JSON.parse(body));
    } catch {
    }
    const gateway = record(envelope?.["routify_response"]);
    const upstream = record(envelope?.["error"]) ?? record(record(gateway?.["error_detail"])?.["error"]);
    const error = {};
    for (const name of ["message", "code", "type", "param"]) {
      const value = upstream?.[name];
      if (typeof value === "string" || typeof value === "number") {
        error[name] = sanitize(String(value));
      }
    }
    const requestId = headers.get("x-request-id") ?? (string(gateway?.["request_id"]) ? sanitize(String(gateway["request_id"])) : void 0);
    const diagnostic = {
      ...Object.keys(error).length ? { error } : {},
      ...requestId ? { request_id: requestId } : {},
      ...string(gateway?.["trace_id"]) ? { trace_id: sanitize(String(gateway["trace_id"])) } : {},
      ...string(gateway?.["model_name"]) ? { model_name: sanitize(String(gateway["model_name"])) } : {}
    };
    const excerpt = Object.keys(error).length ? JSON.stringify(diagnostic) : sanitize(body).substring(0, 500);
    super(
      `Responses API error ${status}: ${excerpt}` + (!Object.keys(error).length && requestId ? ` (request_id: ${requestId})` : "")
    );
    this.status = status;
    this.name = "ResponsesHttpError";
    this.headers = headers;
    this.requestId = requestId;
    this.error = Object.keys(error).length ? error : void 0;
    this.code = error["code"];
    this.type = error["type"];
    this.param = error["param"];
  }
  static {
    __name(this, "ResponsesHttpError");
  }
  headers;
  requestId;
  code;
  type;
  param;
  error;
  shouldRetry(extraRetryErrorCodes) {
    const directive = this.headers.get("x-should-retry");
    if (directive === "true") return true;
    if (directive === "false") return false;
    return this.status === 408 || this.status === 409 || this.status === 429 || this.status >= 500 && this.status < 600 || (extraRetryErrorCodes?.includes(this.status) ?? false);
  }
};
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
__name(record, "record");
function string(value) {
  return typeof value === "string" && value ? value : void 0;
}
__name(string, "string");

export {
  ResponsesHttpError
};
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
