// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/web-shell-resolver.ts
init_esbuild_shims();
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
var BUNDLE_CHUNK_DIR = "chunks";
function resolveBundleDirFastPath(importMetaUrl) {
  const moduleDir = path.dirname(fileURLToPath(importMetaUrl));
  return path.basename(moduleDir) === BUNDLE_CHUNK_DIR ? path.dirname(moduleDir) : moduleDir;
}
__name(resolveBundleDirFastPath, "resolveBundleDirFastPath");
function resolveWebShellDir() {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const hasShell = /* @__PURE__ */ __name((dir2) => existsSync(path.join(dir2, "index.html")) && existsSync(path.join(dir2, "assets")), "hasShell");
  const bundled = path.join(
    resolveBundleDirFastPath(import.meta.url),
    "web-shell"
  );
  if (hasShell(bundled)) return bundled;
  let dir = selfDir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "packages", "web-shell", "dist");
    if (hasShell(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return void 0;
}
__name(resolveWebShellDir, "resolveWebShellDir");

export {
  resolveWebShellDir
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
