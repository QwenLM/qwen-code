// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/conversations/conversation-runtime-errors.ts
init_esbuild_shims();
var DEFAULT_MESSAGES = {
  conversation_runtime_in_use: "The Conversations runtime is owned by another daemon.",
  conversation_runtime_unavailable: "The Conversations runtime is temporarily unavailable.",
  conversation_root_compromised: "The Conversations root could not be verified.",
  conversation_runtime_ownership_compromised: "The Conversations runtime ownership state could not be verified."
};
var ConversationRuntimeOwnershipError = class extends Error {
  constructor(code, retryable, options) {
    super(DEFAULT_MESSAGES[code], options);
    this.code = code;
    this.retryable = retryable;
    this.name = "ConversationRuntimeOwnershipError";
  }
  static {
    __name(this, "ConversationRuntimeOwnershipError");
  }
  status = 503;
};
function conversationRuntimeInUseError() {
  return new ConversationRuntimeOwnershipError(
    "conversation_runtime_in_use",
    true
  );
}
__name(conversationRuntimeInUseError, "conversationRuntimeInUseError");
function conversationRuntimeUnavailableError(cause) {
  return new ConversationRuntimeOwnershipError(
    "conversation_runtime_unavailable",
    true,
    { cause }
  );
}
__name(conversationRuntimeUnavailableError, "conversationRuntimeUnavailableError");
function conversationRuntimeOwnershipCompromisedError(cause) {
  return new ConversationRuntimeOwnershipError(
    "conversation_runtime_ownership_compromised",
    false,
    { cause }
  );
}
__name(conversationRuntimeOwnershipCompromisedError, "conversationRuntimeOwnershipCompromisedError");
function conversationRootCompromisedError(cause) {
  return new ConversationRuntimeOwnershipError(
    "conversation_root_compromised",
    false,
    { cause }
  );
}
__name(conversationRootCompromisedError, "conversationRootCompromisedError");

// packages/cli/src/serve/live/types.ts
init_esbuild_shims();
var LIVE_HOST_PROTOCOL_VERSION = 9;
var LIVE_HOST_BUNDLE_ID = "com.alibaba.qwen-code.live-host";
var LIVE_INPUT_AUDIO_EPOCH_BYTES = 8;
var LIVE_OUTPUT_AUDIO_EPOCH_BYTES = 8;
var LIVE_OUTPUT_AUDIO_ID_BYTES = 8;
var LIVE_OUTPUT_AUDIO_HEADER_BYTES = LIVE_OUTPUT_AUDIO_EPOCH_BYTES + LIVE_OUTPUT_AUDIO_ID_BYTES;

export {
  ConversationRuntimeOwnershipError,
  conversationRuntimeInUseError,
  conversationRuntimeUnavailableError,
  conversationRuntimeOwnershipCompromisedError,
  conversationRootCompromisedError,
  LIVE_HOST_PROTOCOL_VERSION,
  LIVE_HOST_BUNDLE_ID,
  LIVE_INPUT_AUDIO_EPOCH_BYTES,
  LIVE_OUTPUT_AUDIO_EPOCH_BYTES,
  LIVE_OUTPUT_AUDIO_HEADER_BYTES
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
