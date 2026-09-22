// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/tool-name-utils.ts
init_esbuild_shims();
var MAX_TOOL_NAME_LENGTH = 63;
var PROVIDER_SAFE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
function normalizeToolNameForProvider(name) {
  if (name.length <= MAX_TOOL_NAME_LENGTH && PROVIDER_SAFE_TOOL_NAME.test(name)) {
    return name;
  }
  const normalized = sanitizeToolNameForProvider(name);
  const suffix = `_${stableToolNameHash(name)}`;
  return `${normalized.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
}
__name(normalizeToolNameForProvider, "normalizeToolNameForProvider");
function sanitizeToolNameForProvider(name) {
  const sanitized = name.replace(/[^A-Za-z0-9_-]/g, "_");
  return /^[A-Za-z]/.test(sanitized) ? sanitized : `tool_${sanitized}`;
}
__name(sanitizeToolNameForProvider, "sanitizeToolNameForProvider");
function normalizeMcpToolName(name) {
  return name.startsWith("mcp__") ? normalizeToolNameForProvider(name) : name;
}
__name(normalizeMcpToolName, "normalizeMcpToolName");
function generateLegacyMcpToolName(name) {
  let legacyName = name.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (legacyName.length > MAX_TOOL_NAME_LENGTH) {
    legacyName = legacyName.slice(0, 28) + "___" + legacyName.slice(-32);
  }
  return legacyName;
}
__name(generateLegacyMcpToolName, "generateLegacyMcpToolName");
function stableToolNameHash(name) {
  let hash = 2166136261;
  for (let index = 0; index < name.length; index += 1) {
    hash = Math.imul(hash ^ name.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}
__name(stableToolNameHash, "stableToolNameHash");

export {
  normalizeToolNameForProvider,
  sanitizeToolNameForProvider,
  normalizeMcpToolName,
  generateLegacyMcpToolName
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
