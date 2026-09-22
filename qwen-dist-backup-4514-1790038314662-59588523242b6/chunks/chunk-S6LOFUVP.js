// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/agents/team/identity.ts
init_esbuild_shims();
import { AsyncLocalStorage } from "node:async_hooks";
var teammateIdentityStore = new AsyncLocalStorage();
function getTeammateContext() {
  return teammateIdentityStore.getStore();
}
__name(getTeammateContext, "getTeammateContext");
function isInProcessTeammate() {
  return teammateIdentityStore.getStore() !== void 0;
}
__name(isInProcessTeammate, "isInProcessTeammate");
function getAgentName() {
  return teammateIdentityStore.getStore()?.agentName;
}
__name(getAgentName, "getAgentName");
function getTeamName() {
  return teammateIdentityStore.getStore()?.teamName;
}
__name(getTeamName, "getTeamName");
function resolveActiveTeamName(fallback) {
  return getTeamName() ?? fallback;
}
__name(resolveActiveTeamName, "resolveActiveTeamName");
var isTeammate = isInProcessTeammate;
function runWithTeammateIdentity(identity, fn) {
  return teammateIdentityStore.run(identity, fn);
}
__name(runWithTeammateIdentity, "runWithTeammateIdentity");

export {
  getTeammateContext,
  getAgentName,
  getTeamName,
  resolveActiveTeamName,
  isTeammate,
  runWithTeammateIdentity
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
