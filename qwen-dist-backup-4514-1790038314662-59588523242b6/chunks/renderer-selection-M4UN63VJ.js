// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/opentui/renderer-selection.ts
init_esbuild_shims();
var TUI_RENDERER_ENV_VAR = "QWEN_TUI_RENDERER";
var TUI_RENDERER_STRICT_ENV_VAR = "QWEN_TUI_RENDERER_STRICT";
var OPEN_TUI_RENDERER_VALUE = "opentui";
var MIN_BUN_VERSION = "1.3.0";
var MIN_NODE_VERSION = "26.4.0";
function parseVersion(version) {
  const cleaned = version.trim().replace(/^v/i, "");
  const segments = [];
  for (const part of cleaned.split(".")) {
    const match = /^(\d+)/.exec(part);
    if (!match) break;
    segments.push(Number(match[1]));
  }
  return segments;
}
__name(parseVersion, "parseVersion");
function compareVersions(a, b) {
  const as = parseVersion(a);
  const bs = parseVersion(b);
  const length = Math.max(as.length, bs.length);
  for (let i = 0; i < length; i++) {
    const left = as[i] ?? 0;
    const right = bs[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  const aPre = a.includes("-");
  const bPre = b.includes("-");
  if (aPre !== bPre) return aPre ? -1 : 1;
  return 0;
}
__name(compareVersions, "compareVersions");
function isOpenTuiRuntimeSupported(probe = {
  bun: process.versions["bun"],
  node: process.versions["node"]
}) {
  if (probe.bun) {
    return compareVersions(probe.bun, MIN_BUN_VERSION) >= 0;
  }
  if (probe.node) {
    return compareVersions(probe.node, MIN_NODE_VERSION) >= 0;
  }
  return false;
}
__name(isOpenTuiRuntimeSupported, "isOpenTuiRuntimeSupported");
function selectTuiRenderer(envValue = process.env[TUI_RENDERER_ENV_VAR], probe, env = process.env) {
  const requested = envValue?.trim().toLowerCase();
  const strictValue = env[TUI_RENDERER_STRICT_ENV_VAR]?.trim().toLowerCase();
  const strict = strictValue === "1" || strictValue === "true";
  if (requested !== OPEN_TUI_RENDERER_VALUE) {
    return {
      renderer: "ink",
      reason: requested ? `${TUI_RENDERER_ENV_VAR}=${envValue} is not "${OPEN_TUI_RENDERER_VALUE}"` : `${TUI_RENDERER_ENV_VAR} is not set`,
      strict
    };
  }
  if (!isOpenTuiRuntimeSupported(probe)) {
    if (strict) {
      throw new Error(
        `${TUI_RENDERER_ENV_VAR}=${OPEN_TUI_RENDERER_VALUE} was requested, but this runtime cannot initialize the OpenTUI native FFI (needs Bun >= ${MIN_BUN_VERSION} or Node >= ${MIN_NODE_VERSION}) and ${TUI_RENDERER_STRICT_ENV_VAR} forbids the silent ink fallback`
      );
    }
    return {
      renderer: "ink",
      reason: `OpenTUI requested but the runtime cannot initialize its native FFI (needs Bun >= ${MIN_BUN_VERSION} or Node >= ${MIN_NODE_VERSION})`,
      strict
    };
  }
  return {
    renderer: "opentui",
    reason: `${TUI_RENDERER_ENV_VAR}=${OPEN_TUI_RENDERER_VALUE} on a supported runtime`,
    strict
  };
}
__name(selectTuiRenderer, "selectTuiRenderer");
export {
  OPEN_TUI_RENDERER_VALUE,
  TUI_RENDERER_ENV_VAR,
  TUI_RENDERER_STRICT_ENV_VAR,
  compareVersions,
  isOpenTuiRuntimeSupported,
  parseVersion,
  selectTuiRenderer
};
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
