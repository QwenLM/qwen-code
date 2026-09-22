// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/services/tool-write-origin.ts
init_esbuild_shims();
var TOOL_WRITE_ORIGIN_META_KEY = "qwen-code/tool-write-origin";
var TOOL_WRITE_ORIGINS = [
  "write_file",
  "edit",
  "notebook_edit",
  "shell_sed_edit"
];
var TOOL_WRITE_ORIGIN_SET = new Set(TOOL_WRITE_ORIGINS);
function buildToolWriteOriginMeta(meta, source) {
  const sanitized = { ...meta };
  delete sanitized[TOOL_WRITE_ORIGIN_META_KEY];
  if (source !== void 0) {
    sanitized[TOOL_WRITE_ORIGIN_META_KEY] = { version: 1, source };
  }
  return Object.keys(sanitized).length > 0 ? sanitized : void 0;
}
__name(buildToolWriteOriginMeta, "buildToolWriteOriginMeta");
function parseToolWriteOriginMeta(meta) {
  const marker = meta?.[TOOL_WRITE_ORIGIN_META_KEY];
  if (typeof marker !== "object" || marker === null || Array.isArray(marker)) {
    return void 0;
  }
  const keys = Object.keys(marker);
  if (keys.length !== 2 || !Object.hasOwn(marker, "version") || !Object.hasOwn(marker, "source")) {
    return void 0;
  }
  const record = marker;
  return record["version"] === 1 && typeof record["source"] === "string" && TOOL_WRITE_ORIGIN_SET.has(record["source"]) ? record["source"] : void 0;
}
__name(parseToolWriteOriginMeta, "parseToolWriteOriginMeta");

export {
  buildToolWriteOriginMeta,
  parseToolWriteOriginMeta
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
