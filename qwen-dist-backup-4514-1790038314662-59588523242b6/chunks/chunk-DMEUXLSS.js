// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/loopback-binds.ts
init_esbuild_shims();
var LOOPBACK_BINDS = /* @__PURE__ */ new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]"
]);
function isIpv4Loopback(hostname) {
  const octets = hostname.split(".");
  if (octets.length !== 4) return false;
  const [first, ...rest] = octets;
  return first === "127" && rest.every((octet) => {
    if (!/^\d+$/.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}
__name(isIpv4Loopback, "isIpv4Loopback");
function isLoopbackBind(hostname) {
  const normalized = hostname.toLowerCase();
  return LOOPBACK_BINDS.has(normalized) || isIpv4Loopback(normalized);
}
__name(isLoopbackBind, "isLoopbackBind");
function isLoopbackAddress(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === "::1" || normalized === "[::1]" || isIpv4Loopback(normalized);
}
__name(isLoopbackAddress, "isLoopbackAddress");
function formatHostForAuthority(hostname) {
  const normalized = hostname.toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized;
  }
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}
__name(formatHostForAuthority, "formatHostForAuthority");

export {
  isLoopbackBind,
  isLoopbackAddress,
  formatHostForAuthority
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
