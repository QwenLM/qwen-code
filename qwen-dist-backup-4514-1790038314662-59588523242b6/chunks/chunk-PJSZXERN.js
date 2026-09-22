// Force strict mode and setup for ESM
"use strict";
import {
  Storage
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/session-attachments-root.ts
init_esbuild_shims();
import { homedir } from "node:os";
import * as path from "node:path";
var SESSION_ATTACHMENTS_ROOT_ENV = "QWEN_SERVE_SESSION_ATTACHMENTS_ROOT";
function defaultSessionAttachmentsRoot(workspace, runtimeBaseDir) {
  return path.join(
    new Storage(workspace, runtimeBaseDir).getProjectTempDir(),
    "attachments"
  );
}
__name(defaultSessionAttachmentsRoot, "defaultSessionAttachmentsRoot");
function resolveConfiguredSessionAttachmentsRoot(configured) {
  const expanded = configured === "~" ? homedir() : configured.startsWith("~/") || configured.startsWith("~\\") ? path.join(
    homedir(),
    ...configured.slice(2).split(/[/\\]+/).filter(Boolean)
  ) : configured;
  return path.resolve(process.cwd(), expanded);
}
__name(resolveConfiguredSessionAttachmentsRoot, "resolveConfiguredSessionAttachmentsRoot");
function sessionAttachmentsRoots(workspace, runtimeBaseDir) {
  const defaultRoot = defaultSessionAttachmentsRoot(workspace, runtimeBaseDir);
  const configured = process.env[SESSION_ATTACHMENTS_ROOT_ENV]?.trim();
  if (!configured) return { root: defaultRoot };
  const projectHash = path.basename(path.dirname(defaultRoot));
  return {
    root: path.join(
      resolveConfiguredSessionAttachmentsRoot(configured),
      projectHash,
      "attachments"
    ),
    fallback: defaultRoot
  };
}
__name(sessionAttachmentsRoots, "sessionAttachmentsRoots");

export {
  SESSION_ATTACHMENTS_ROOT_ENV,
  defaultSessionAttachmentsRoot,
  resolveConfiguredSessionAttachmentsRoot,
  sessionAttachmentsRoots
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
