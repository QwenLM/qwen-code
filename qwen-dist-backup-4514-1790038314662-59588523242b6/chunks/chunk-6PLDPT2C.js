// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/acp-bridge/src/workspacePaths.ts
init_esbuild_shims();
import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
var WINDOWS_ABSOLUTE_PATH_RE = /^([A-Za-z]):[\\/](.*)$/;
var sandboxMountExistsOverrideForTest;
function translateWindowsWorkspaceForPosixSandbox(p, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const sandboxEnv = "sandboxEnv" in opts ? opts.sandboxEnv : process.env["SANDBOX"];
  const exists = opts.exists ?? sandboxMountExistsOverrideForTest ?? existsSync;
  if (platform === "win32" || !sandboxEnv || sandboxEnv === "sandbox-exec") {
    return p;
  }
  const match = WINDOWS_ABSOLUTE_PATH_RE.exec(p);
  if (!match) return p;
  const translated = `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
  const resolvedTranslated = path.posix.resolve(translated);
  if (resolvedTranslated !== `/${match[1].toLowerCase()}` && !resolvedTranslated.startsWith(`/${match[1].toLowerCase()}/`)) {
    return p;
  }
  return exists(resolvedTranslated) ? translated : p;
}
__name(translateWindowsWorkspaceForPosixSandbox, "translateWindowsWorkspaceForPosixSandbox");
function translateAndCheckAbsoluteWorkspacePath(raw) {
  const translated = translateWindowsWorkspaceForPosixSandbox(raw);
  return path.isAbsolute(translated) ? translated : null;
}
__name(translateAndCheckAbsoluteWorkspacePath, "translateAndCheckAbsoluteWorkspacePath");
function canonicalizeWorkspace(p) {
  const resolved = path.resolve(translateWindowsWorkspaceForPosixSandbox(p));
  try {
    return realpathSync.native(resolved);
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") {
      return resolved;
    }
    throw err;
  }
}
__name(canonicalizeWorkspace, "canonicalizeWorkspace");
function canonicalizeWorkspaces(paths) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const p of paths) {
    const canonical = canonicalizeWorkspace(p);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}
__name(canonicalizeWorkspaces, "canonicalizeWorkspaces");
var MAX_WORKSPACE_PATH_LENGTH = 4096;

export {
  translateAndCheckAbsoluteWorkspacePath,
  canonicalizeWorkspace,
  canonicalizeWorkspaces,
  MAX_WORKSPACE_PATH_LENGTH
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
