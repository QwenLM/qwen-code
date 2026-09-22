// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/channel-worker-prompt-authorization.ts
init_esbuild_shims();
var workspacesByToken = /* @__PURE__ */ new Map();
var CHANNEL_WORKER_PROMPT_AUTHORIZATION_META_KEY = "qwen.daemon.channelPromptAuthorization";
function registerChannelWorkerPromptAuthorization(token, workspaceCwd) {
  workspacesByToken.set(token, workspaceCwd);
}
__name(registerChannelWorkerPromptAuthorization, "registerChannelWorkerPromptAuthorization");
function revokeChannelWorkerPromptAuthorization(token) {
  workspacesByToken.delete(token);
}
__name(revokeChannelWorkerPromptAuthorization, "revokeChannelWorkerPromptAuthorization");
function isChannelWorkerPromptAuthorized(token, workspaceCwd) {
  return typeof token === "string" && workspacesByToken.get(token) === workspaceCwd;
}
__name(isChannelWorkerPromptAuthorized, "isChannelWorkerPromptAuthorized");

export {
  CHANNEL_WORKER_PROMPT_AUTHORIZATION_META_KEY,
  registerChannelWorkerPromptAuthorization,
  revokeChannelWorkerPromptAuthorization,
  isChannelWorkerPromptAuthorized
};
