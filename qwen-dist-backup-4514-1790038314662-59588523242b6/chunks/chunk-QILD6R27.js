// Force strict mode and setup for ESM
"use strict";
import {
  isServeFastPathArgv
} from "./chunk-JVEGA3MM.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/startupProfiler.ts
init_esbuild_shims();
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
var enabled = false;
var captureHeap = false;
var outerProcess = false;
var interactiveMode = false;
var t0 = 0;
var processUptimeAtT0Ms = 0;
var checkpoints = [];
var events = [];
var eventsTruncated = false;
var finalized = false;
var MAX_EVENTS = 1024;
var HEAP_BYTES_TO_MB = 1 / (1024 * 1024);
function snapshotHeapMb() {
  if (!captureHeap) return void 0;
  try {
    return Math.round(process.memoryUsage().heapUsed * HEAP_BYTES_TO_MB * 100) / 100;
  } catch {
    return void 0;
  }
}
__name(snapshotHeapMb, "snapshotHeapMb");
function initStartupProfiler() {
  resetStartupProfiler();
  if (process.env["QWEN_CODE_PROFILE_STARTUP"] !== "1") {
    return;
  }
  const inSandboxChild = !!process.env["SANDBOX"];
  const outerOptIn = process.env["QWEN_CODE_PROFILE_STARTUP_OUTER"] === "1";
  const serveCommand = isServeFastPathArgv(process.argv.slice(2));
  if (!inSandboxChild && !outerOptIn && !serveCommand) {
    return;
  }
  enabled = true;
  outerProcess = !inSandboxChild && !serveCommand;
  captureHeap = process.env["QWEN_CODE_PROFILE_STARTUP_NO_HEAP"] !== "1";
  finalized = false;
  processUptimeAtT0Ms = Math.round(process.uptime() * 1e3 * 100) / 100;
  t0 = performance.now();
  checkpoints = [];
  events = [];
}
__name(initStartupProfiler, "initStartupProfiler");
function profileCheckpoint(name) {
  if (!enabled || finalized) return;
  checkpoints.push({
    name,
    timestamp: performance.now(),
    heapUsedMb: snapshotHeapMb()
  });
}
__name(profileCheckpoint, "profileCheckpoint");
function recordStartupEvent(name, attrs) {
  if (!enabled || finalized) return;
  if (events.length >= MAX_EVENTS) {
    eventsTruncated = true;
    return;
  }
  events.push({
    name,
    tMs: Math.round((performance.now() - t0) * 100) / 100,
    heapUsedMb: snapshotHeapMb(),
    ...attrs ? { attrs } : {}
  });
}
__name(recordStartupEvent, "recordStartupEvent");
function setInteractiveMode(value) {
  if (!enabled) return;
  interactiveMode = value;
}
__name(setInteractiveMode, "setInteractiveMode");
function findCheckpointMs(name) {
  for (const cp of checkpoints) {
    if (cp.name === name) {
      return Math.round((cp.timestamp - t0) * 100) / 100;
    }
  }
  return void 0;
}
__name(findCheckpointMs, "findCheckpointMs");
function findEventMs(name) {
  for (const ev of events) {
    if (ev.name === name) return ev.tMs;
  }
  return void 0;
}
__name(findEventMs, "findEventMs");
function computeDerivedPhases() {
  const out = {};
  out.module_load = processUptimeAtT0Ms;
  const afterSettings = findCheckpointMs("after_load_settings");
  if (afterSettings !== void 0) out.settings_time = afterSettings;
  const afterCfg = findCheckpointMs("after_load_cli_config");
  if (afterSettings !== void 0 && afterCfg !== void 0) {
    out.config_time = Math.round((afterCfg - afterSettings) * 100) / 100;
  }
  const afterInit = findCheckpointMs("after_initialize_app");
  if (afterCfg !== void 0 && afterInit !== void 0) {
    out.init_time = Math.round((afterInit - afterCfg) * 100) / 100;
  }
  const beforeRender = findCheckpointMs("before_render");
  if (beforeRender !== void 0) out.pre_render = beforeRender;
  const firstPaint = findCheckpointMs("first_paint");
  if (firstPaint !== void 0) out.to_first_paint = firstPaint;
  const inputEnabled = findCheckpointMs("input_enabled");
  if (inputEnabled !== void 0) out.to_input_enabled = inputEnabled;
  const ciStart = findCheckpointMs("config_initialize_start");
  const ciEnd = findCheckpointMs("config_initialize_end");
  if (ciStart !== void 0 && ciEnd !== void 0) {
    out.config_initialize_dur = Math.round((ciEnd - ciStart) * 100) / 100;
  }
  const mcpFirst = findEventMs("mcp_first_tool_registered");
  if (mcpFirst !== void 0) out.mcp_first_tool = mcpFirst;
  const mcpSettled = findEventMs("mcp_all_servers_settled");
  if (mcpSettled !== void 0) out.mcp_all_settled = mcpSettled;
  if (mcpFirst !== void 0) {
    for (const ev of events) {
      if (ev.name === "gemini_tools_updated" && ev.tMs >= mcpFirst) {
        out.gemini_tools_lag = Math.round((ev.tMs - mcpFirst) * 100) / 100;
        break;
      }
    }
  }
  return out;
}
__name(computeDerivedPhases, "computeDerivedPhases");
function getStartupReport() {
  if (!enabled || checkpoints.length === 0 && events.length === 0) {
    return null;
  }
  const phases = [];
  let prev = t0;
  for (const cp of checkpoints) {
    phases.push({
      name: cp.name,
      startMs: Math.round((prev - t0) * 100) / 100,
      durationMs: Math.round((cp.timestamp - prev) * 100) / 100,
      ...cp.heapUsedMb !== void 0 ? { heapUsedMb: cp.heapUsedMb } : {}
    });
    prev = cp.timestamp;
  }
  const lastTimestamp = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1].timestamp : performance.now();
  return {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    sessionId: "unknown",
    interactiveMode,
    outerProcess,
    processUptimeAtT0Ms,
    totalMs: Math.round((lastTimestamp - t0) * 100) / 100,
    phases,
    events: [...events],
    eventsTruncated,
    derivedPhases: computeDerivedPhases(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch
  };
}
__name(getStartupReport, "getStartupReport");
function finalizeStartupProfile(sessionId) {
  if (!enabled || finalized) return;
  finalized = true;
  const report = getStartupReport();
  if (!report) return;
  if (sessionId) {
    report.sessionId = sessionId;
  }
  try {
    const dir = path.join(os.homedir(), ".qwen", "startup-perf");
    fs.mkdirSync(dir, { recursive: true });
    const prefix = report.outerProcess ? "outer-" : "";
    const filename = `${prefix}${report.timestamp.replace(/[:.]/g, "-")}-${report.sessionId}.json`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, JSON.stringify(report, null, 2), "utf-8");
    process.stderr.write(`Startup profile written to: ${filepath}
`);
  } catch {
    process.stderr.write("Warning: Failed to write startup profile report\n");
  }
}
__name(finalizeStartupProfile, "finalizeStartupProfile");
function resetStartupProfiler() {
  enabled = false;
  captureHeap = false;
  outerProcess = false;
  interactiveMode = false;
  t0 = 0;
  processUptimeAtT0Ms = 0;
  checkpoints = [];
  events = [];
  eventsTruncated = false;
  finalized = false;
}
__name(resetStartupProfiler, "resetStartupProfiler");
function isStartupProfilerEnabled() {
  return enabled;
}
__name(isStartupProfilerEnabled, "isStartupProfilerEnabled");

export {
  initStartupProfiler,
  profileCheckpoint,
  recordStartupEvent,
  setInteractiveMode,
  finalizeStartupProfile,
  isStartupProfilerEnabled
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
