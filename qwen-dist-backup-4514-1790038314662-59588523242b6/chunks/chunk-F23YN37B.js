// Force strict mode and setup for ESM
"use strict";
import {
  QWEN_SERVER_TOKEN_ENV
} from "./chunk-GYTKQYDB.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/serve-token.ts
init_esbuild_shims();
import { randomBytes } from "node:crypto";
function resolveRemoteServeToken(optionToken, loopback, environmentToken = process.env[QWEN_SERVER_TOKEN_ENV]) {
  const generated = !loopback && optionToken === void 0 && environmentToken === void 0;
  return {
    token: generated ? randomBytes(16).toString("base64url") : resolveServeToken(optionToken, environmentToken),
    generated
  };
}
__name(resolveRemoteServeToken, "resolveRemoteServeToken");
function resolveServeToken(optionToken, environmentToken = process.env[QWEN_SERVER_TOKEN_ENV]) {
  const selected = optionToken ?? environmentToken;
  const trimmed = selected?.trim();
  return trimmed ? trimmed : void 0;
}
__name(resolveServeToken, "resolveServeToken");

export {
  resolveRemoteServeToken,
  resolveServeToken
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
