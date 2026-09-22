// Force strict mode and setup for ESM
"use strict";
import {
  resolveServeToken
} from "./chunk-F23YN37B.js";
import {
  isLoopbackBind
} from "./chunk-DMEUXLSS.js";
import {
  resolveWebShellDir
} from "./chunk-FBX2SDQ4.js";
import "./chunk-GYTKQYDB.js";
import {
  writeStderrLine
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/open-with-auth.ts
init_esbuild_shims();
import { randomBytes } from "node:crypto";
function applyOpenWithAuth(options) {
  if (!isLoopbackBind(options.hostname)) {
    throw new Error("--open-with-auth requires a loopback --hostname.");
  }
  if (options.serveWebShell === false) {
    throw new Error("--open-with-auth requires the Web Shell; omit --no-web.");
  }
  if (!resolveWebShellDir()) {
    throw new Error("--open-with-auth requires built Web Shell assets.");
  }
  options.requireWebShell = true;
  const configuredToken = resolveServeToken(options.token);
  if (configuredToken) {
    options.token = configuredToken;
    return;
  }
  options.token = randomBytes(32).toString("base64url");
  writeStderrLine(
    "qwen serve: temporary bearer authentication enabled for this Web Shell launch; use an explicit shared token for additional clients."
  );
}
__name(applyOpenWithAuth, "applyOpenWithAuth");
export {
  applyOpenWithAuth
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
