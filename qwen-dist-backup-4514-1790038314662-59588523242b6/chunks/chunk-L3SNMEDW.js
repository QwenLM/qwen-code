// Force strict mode and setup for ESM
"use strict";
import {
  redactLogCredentials
} from "./chunk-M5GB774H.js";
import {
  sanitizeLogText
} from "./chunk-PZRXWQUA.js";
import {
  stripAnsi
} from "./chunk-TWPJO254.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/channel-worker-diagnostics.ts
init_esbuild_shims();
var WORKER_LOG_INVISIBLE_RE = new RegExp("[\\p{Cf}\\u2028\\u2029]|\\p{Variation_Selector}", "gu");
var WORKER_LOG_CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
__name(escapeRegExp, "escapeRegExp");
function sensitiveEnvValues(env) {
  const sensitiveKey = /(^|_)(TOKEN|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|PASSWORD|PASSWD|PASSPHRASE|BASIC_AUTH|AUTH_TOKEN|AUTHORIZATION|SESSION_SECRET|SESSION_TOKEN|SESSION_KEY|SESSION_COOKIE|DSN|CONNECTION_STRING)($|_)/i;
  return Object.entries(env).filter(([key, value]) => sensitiveKey.test(key) && value !== void 0).flatMap(([, value]) => {
    const lines = value.split("\n").filter((line) => line.length >= 4);
    return lines.length > 0 ? [value, ...lines] : [value];
  }).filter((value) => value.length >= 4);
}
__name(sensitiveEnvValues, "sensitiveEnvValues");
function normalizeWorkerDiagnostic(value) {
  return stripAnsi(value).replace(WORKER_LOG_INVISIBLE_RE, "").replace(WORKER_LOG_CONTROL_RE, "");
}
__name(normalizeWorkerDiagnostic, "normalizeWorkerDiagnostic");
function createWorkerDiagnosticRedactor(opts) {
  const secretPatterns = [
    ...new Set(
      [
        ...opts.daemonToken ? [opts.daemonToken] : [],
        ...sensitiveEnvValues(opts.workerEnv)
      ].flatMap((secret) => [
        normalizeWorkerDiagnostic(secret),
        normalizeWorkerDiagnostic(secret.replace(/\t/gu, " "))
      ]).filter((secret) => secret.length >= 4)
    )
  ].sort((left, right) => right.length - left.length).map((secret) => new RegExp(escapeRegExp(secret), "g"));
  return (value) => {
    let redacted = value;
    for (const secretPattern of secretPatterns) {
      redacted = redacted.replace(secretPattern, "<redacted>");
    }
    return redactLogCredentials(redacted);
  };
}
__name(createWorkerDiagnosticRedactor, "createWorkerDiagnosticRedactor");
function sanitizeWorkerDiagnostic(value, maxLength, opts) {
  const normalized = normalizeWorkerDiagnostic(value);
  const redacted = createWorkerDiagnosticRedactor(opts)(normalized);
  return sanitizeLogText(redacted, maxLength);
}
__name(sanitizeWorkerDiagnostic, "sanitizeWorkerDiagnostic");

export {
  normalizeWorkerDiagnostic,
  createWorkerDiagnosticRedactor,
  sanitizeWorkerDiagnostic
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
