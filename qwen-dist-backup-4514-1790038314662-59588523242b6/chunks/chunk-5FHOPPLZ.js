// Force strict mode and setup for ESM
"use strict";
import {
  isTeammate
} from "./chunk-S6LOFUVP.js";
import {
  isInForkExecution
} from "./chunk-2A6RZKP2.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/agents/runtime/agent-context.ts
init_esbuild_shims();
import { AsyncLocalStorage } from "node:async_hooks";
var storage = new AsyncLocalStorage();
function runWithAgentContext(agentId, fn, depthOverride) {
  const current = storage.getStore() ?? {};
  const depth = depthOverride ?? (current.depth ?? -1) + 1;
  return storage.run({ ...current, agentId, depth }, fn);
}
__name(runWithAgentContext, "runWithAgentContext");
function runWithRuntimeContentGenerator(view, fn) {
  const current = storage.getStore() ?? {};
  return storage.run({ ...current, runtimeView: view }, fn);
}
__name(runWithRuntimeContentGenerator, "runWithRuntimeContentGenerator");
function getCurrentAgentId() {
  return storage.getStore()?.agentId ?? null;
}
__name(getCurrentAgentId, "getCurrentAgentId");
function getCurrentAgentDepth() {
  return storage.getStore()?.depth ?? 0;
}
__name(getCurrentAgentDepth, "getCurrentAgentDepth");
function getRuntimeContentGenerator() {
  return storage.getStore()?.runtimeView;
}
__name(getRuntimeContentGenerator, "getRuntimeContentGenerator");
function runOutsideAgentContext(fn) {
  return storage.exit(fn);
}
__name(runOutsideAgentContext, "runOutsideAgentContext");
function isTopLevelSession() {
  return getCurrentAgentId() === null;
}
__name(isTopLevelSession, "isTopLevelSession");
function childLaunchDepth() {
  return getCurrentAgentId() !== null ? getCurrentAgentDepth() + 1 : 0;
}
__name(childLaunchDepth, "childLaunchDepth");
function canSpawnNestedAgent(maxDepth) {
  return childLaunchDepth() + 1 <= maxDepth;
}
__name(canSpawnNestedAgent, "canSpawnNestedAgent");
function spawnBlockReason(maxDepth) {
  if (!canSpawnNestedAgent(maxDepth)) return "depth";
  if (isTeammate()) return "teammate";
  if (isInForkExecution()) return "fork";
  return null;
}
__name(spawnBlockReason, "spawnBlockReason");

export {
  runWithAgentContext,
  runWithRuntimeContentGenerator,
  getCurrentAgentId,
  getCurrentAgentDepth,
  getRuntimeContentGenerator,
  runOutsideAgentContext,
  isTopLevelSession,
  childLaunchDepth,
  spawnBlockReason
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
