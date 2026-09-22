// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/errors.ts
init_esbuild_shims();
var MAX_STRINGIFIED_ERROR_MESSAGE_LENGTH = 1e3;
function isNodeError(error) {
  return error instanceof Error && "code" in error;
}
__name(isNodeError, "isNodeError");
function isAbortError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  if (isNodeError(error) && error.code === "ABORT_ERR") {
    return true;
  }
  if (error instanceof Error && error.constructor?.name === "APIUserAbortError") {
    return true;
  }
  return false;
}
__name(isAbortError, "isAbortError");
function describeErrorCause(cause) {
  if (cause == null) return void 0;
  return describeCodedCause(cause, 0, /* @__PURE__ */ new Set()) ?? describeCauseFallback(cause);
}
__name(describeErrorCause, "describeErrorCause");
function describeCauseFallback(cause) {
  if (cause instanceof AggregateError && Array.isArray(cause.errors)) {
    const inner = cause.errors.map((error) => describeSingleError(error)).filter((detail) => Boolean(detail));
    if (inner.length > 0) {
      return [...new Set(inner)].join("; ");
    }
  }
  return describeSingleError(cause);
}
__name(describeCauseFallback, "describeCauseFallback");
function describeCodedCause(cause, depth, visited) {
  if (cause == null || depth >= 8 || typeof cause !== "object" || visited.has(cause)) {
    return void 0;
  }
  visited.add(cause);
  if (cause instanceof AggregateError && Array.isArray(cause.errors)) {
    const inner = cause.errors.map((error) => describeCodedCause(error, depth + 1, visited)).filter((detail) => Boolean(detail));
    if (inner.length > 0) {
      return [...new Set(inner)].join("; ");
    }
  }
  const nested = describeCodedCause(
    cause.cause,
    depth + 1,
    visited
  );
  if (nested) {
    return nested;
  }
  const code = cause.code;
  return typeof code === "string" && code ? describeSingleError(cause) : void 0;
}
__name(describeCodedCause, "describeCodedCause");
function describeSingleError(err) {
  if (err instanceof Error) {
    const code = err.code;
    const codeStr = typeof code === "string" ? code : void 0;
    const msg = err.message?.trim();
    if (msg && codeStr && !msg.includes(codeStr)) {
      return `${codeStr}: ${msg}`;
    }
    return msg || codeStr || (err.name !== "Error" ? err.name : void 0);
  }
  if (err && typeof err === "object" && !Array.isArray(err)) {
    const rec = err;
    const code = rec["code"];
    const codeStr = typeof code === "string" && code ? code : typeof code === "number" ? String(code) : void 0;
    const message = rec["message"];
    const msg = typeof message === "string" && message.trim() ? message.trim() : void 0;
    if (msg && codeStr && !msg.includes(codeStr)) {
      return `${codeStr}: ${msg}`;
    }
    return msg || codeStr;
  }
  const str = String(err);
  return str && str !== "[object Object]" ? str : void 0;
}
__name(describeSingleError, "describeSingleError");
function truncateStringifiedErrorMessage(message) {
  if (message.length <= MAX_STRINGIFIED_ERROR_MESSAGE_LENGTH) {
    return message;
  }
  return `${message.slice(0, MAX_STRINGIFIED_ERROR_MESSAGE_LENGTH - 3)}...`;
}
__name(truncateStringifiedErrorMessage, "truncateStringifiedErrorMessage");
function getErrorMessage(error) {
  if (error instanceof Error) {
    const detail = describeErrorCause(error.cause);
    if (detail && detail !== error.message) {
      return truncateStringifiedErrorMessage(
        `${error.message} (cause: ${detail})`
      );
    }
    return truncateStringifiedErrorMessage(error.message);
  }
  if (error !== null && typeof error === "object" && !Array.isArray(error)) {
    const { message, cause } = error;
    if (typeof message === "string" && message.trim()) {
      const detail = describeErrorCause(cause);
      const result = detail && detail !== message ? `${message} (cause: ${detail})` : message;
      return truncateStringifiedErrorMessage(result);
    }
    try {
      const serialized = JSON.stringify(error);
      return serialized ? truncateStringifiedErrorMessage(serialized) : String(error);
    } catch {
      const detail = describeSingleError(error);
      return detail ? truncateStringifiedErrorMessage(detail) : String(error);
    }
  }
  try {
    return String(error);
  } catch {
    return "Failed to get error details";
  }
}
__name(getErrorMessage, "getErrorMessage");
function getErrorStatus(error) {
  if (typeof error !== "object" || error === null) {
    return void 0;
  }
  const err = error;
  const value = err.status ?? err.statusCode ?? err.response?.status ?? err.error?.code;
  if (typeof value === "number" && value >= 100 && value <= 599) {
    return value;
  }
  if (typeof err.message === "string") {
    const match = err.message.match(/HTTP_STATUS\/(\d{3})\b/);
    if (match) {
      const parsed = Number(match[1]);
      if (parsed >= 100 && parsed <= 599) {
        return parsed;
      }
    }
  }
  return void 0;
}
__name(getErrorStatus, "getErrorStatus");
function getErrorType(error) {
  if (typeof error !== "object" || error === null) {
    return "unknown";
  }
  const constructorName = error instanceof Error && error.constructor.name !== "Error" ? error.constructor.name : void 0;
  const sdkType = error.type;
  const baseType = constructorName ?? sdkType ?? (error instanceof Error ? error.name : "unknown");
  const cause = error instanceof Error ? error.cause : void 0;
  const causeCode = cause && typeof cause === "object" && "code" in cause ? cause.code : void 0;
  return causeCode ? `${baseType}:${causeCode}` : baseType;
}
__name(getErrorType, "getErrorType");
var FatalError = class extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
  static {
    __name(this, "FatalError");
  }
};
var FatalInputError = class extends FatalError {
  static {
    __name(this, "FatalInputError");
  }
  constructor(message) {
    super(message, 42);
  }
};
var FatalSandboxError = class extends FatalError {
  static {
    __name(this, "FatalSandboxError");
  }
  constructor(message) {
    super(message, 44);
  }
};
var FatalConfigError = class extends FatalError {
  static {
    __name(this, "FatalConfigError");
  }
  constructor(message) {
    super(message, 52);
  }
};
var FatalTurnLimitedError = class extends FatalError {
  static {
    __name(this, "FatalTurnLimitedError");
  }
  constructor(message) {
    super(message, 53);
  }
};
var FatalBudgetExceededError = class extends FatalError {
  static {
    __name(this, "FatalBudgetExceededError");
  }
  constructor(message) {
    super(message, 55);
  }
};
var FatalCancellationError = class extends FatalError {
  static {
    __name(this, "FatalCancellationError");
  }
  constructor(message) {
    super(message, 130);
  }
};
var ForbiddenError = class extends Error {
  static {
    __name(this, "ForbiddenError");
  }
  status = 403;
};
var UnauthorizedError = class extends Error {
  static {
    __name(this, "UnauthorizedError");
  }
  status = 401;
};
var BadRequestError = class extends Error {
  static {
    __name(this, "BadRequestError");
  }
  status = 400;
};
function toFriendlyError(error) {
  if (error && typeof error === "object" && "response" in error) {
    const gaxiosError = error;
    const data = parseResponseData(gaxiosError);
    if (data.error && data.error.message && data.error.code) {
      switch (data.error.code) {
        case 400:
          return new BadRequestError(data.error.message);
        case 401:
          return new UnauthorizedError(data.error.message);
        case 403:
          return new ForbiddenError(data.error.message);
        default:
      }
    }
  }
  return error;
}
__name(toFriendlyError, "toFriendlyError");
function parseResponseData(error) {
  if (typeof error.response?.data === "string") {
    return JSON.parse(error.response?.data);
  }
  return error.response?.data;
}
__name(parseResponseData, "parseResponseData");

export {
  isNodeError,
  isAbortError,
  getErrorMessage,
  getErrorStatus,
  getErrorType,
  FatalError,
  FatalInputError,
  FatalSandboxError,
  FatalConfigError,
  FatalTurnLimitedError,
  FatalBudgetExceededError,
  FatalCancellationError,
  UnauthorizedError,
  toFriendlyError
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
