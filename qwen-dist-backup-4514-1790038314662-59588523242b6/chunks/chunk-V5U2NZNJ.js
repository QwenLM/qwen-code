// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/peerMessaging/env.ts
init_esbuild_shims();
var MESSAGING_SOCKET_ENV = "QWEN_CODE_MESSAGING_SOCKET";
var MESSAGING_TOKEN_ENV = "QWEN_CODE_MESSAGING_TOKEN";
function clearInheritedPeerMessagingEnv() {
  delete process.env[MESSAGING_SOCKET_ENV];
  delete process.env[MESSAGING_TOKEN_ENV];
}
__name(clearInheritedPeerMessagingEnv, "clearInheritedPeerMessagingEnv");

export {
  MESSAGING_SOCKET_ENV,
  MESSAGING_TOKEN_ENV,
  clearInheritedPeerMessagingEnv
};
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
