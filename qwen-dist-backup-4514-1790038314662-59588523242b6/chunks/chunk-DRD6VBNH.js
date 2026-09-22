// Force strict mode and setup for ESM
"use strict";
import {
  CHANNEL_STARTUP_PROFILE_VERSION
} from "./chunk-RN6A53UJ.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/acp-startup-profiler.ts
init_esbuild_shims();
import { performance } from "node:perf_hooks";
var CONFIG_EVENT_MARKS = {
  config_initialize_extensions_initial_start: "extensionsInitialStart",
  config_initialize_extensions_initial_end: "extensionsInitialEnd",
  config_initialize_hooks_start: "hooksStart",
  config_initialize_hooks_end: "hooksEnd",
  config_initialize_skills_start: "skillsStart",
  config_initialize_skills_end: "skillsEnd",
  config_initialize_extensions_final_start: "extensionsFinalStart",
  config_initialize_extensions_final_end: "extensionsFinalEnd",
  config_initialize_hierarchical_memory_start: "hierarchicalMemoryStart",
  config_initialize_hierarchical_memory_end: "hierarchicalMemoryEnd",
  config_initialize_tool_registry_start: "toolRegistryStart",
  config_initialize_tool_registry_end: "toolRegistryEnd",
  config_initialize_ripgrep_probe_start: "ripgrepProbeStart",
  config_initialize_ripgrep_probe_end: "ripgrepProbeEnd",
  config_initialize_tool_warmup_start: "toolWarmupStart",
  config_initialize_tool_warmup_end: "toolWarmupEnd"
};
var enabled = false;
var frozen = false;
var bootstrapConfigActive = false;
var marks = {};
function roundMs(value) {
  return Math.round(value * 100) / 100;
}
__name(roundMs, "roundMs");
function duration(start, end) {
  const startMs = marks[start];
  const endMs = marks[end];
  return startMs === void 0 || endMs === void 0 || endMs < startMs ? void 0 : roundMs(endMs - startMs);
}
__name(duration, "duration");
function sumDurations(values) {
  return values.every((value) => value !== void 0) ? values.reduce((sum, value) => sum + value, 0) : void 0;
}
__name(sumDurations, "sumDurations");
function initializeAcpStartupProfiler() {
  if (enabled) return;
  enabled = true;
  frozen = false;
  bootstrapConfigActive = false;
  marks = { profilerReady: performance.now() };
}
__name(initializeAcpStartupProfiler, "initializeAcpStartupProfiler");
function isAcpStartupProfilerEnabled() {
  return enabled;
}
__name(isAcpStartupProfilerEnabled, "isAcpStartupProfilerEnabled");
function markAcpStartup(mark) {
  if (!enabled || frozen || marks[mark] !== void 0) return;
  marks[mark] = performance.now();
}
__name(markAcpStartup, "markAcpStartup");
function beginAcpBootstrapConfigProfiling() {
  if (!enabled || frozen) return;
  bootstrapConfigActive = true;
  markAcpStartup("bootstrapConfigInitializationStart");
}
__name(beginAcpBootstrapConfigProfiling, "beginAcpBootstrapConfigProfiling");
function endAcpBootstrapConfigProfiling() {
  if (!enabled || frozen) return;
  markAcpStartup("bootstrapConfigInitializationEnd");
  bootstrapConfigActive = false;
}
__name(endAcpBootstrapConfigProfiling, "endAcpBootstrapConfigProfiling");
function recordAcpConfigStartupEvent(name) {
  if (!enabled || frozen || !bootstrapConfigActive) return;
  const mark = CONFIG_EVENT_MARKS[name];
  if (mark) markAcpStartup(mark);
}
__name(recordAcpConfigStartupEvent, "recordAcpConfigStartupEvent");
function buildAndFreezeAcpStartupProfile() {
  if (!enabled) return void 0;
  const phases = {
    processToProfilerReadyMs: marks.profilerReady === void 0 ? void 0 : roundMs(marks.profilerReady),
    geminiImportMs: duration("geminiImportStart", "geminiImportEnd"),
    argsParseMs: duration("argsParseStart", "argsParseEnd"),
    settingsLoadMs: duration("settingsLoadStart", "settingsLoadEnd"),
    configConstructionMs: duration(
      "configConstructionStart",
      "configConstructionEnd"
    ),
    appInitializationMs: duration(
      "appInitializationStart",
      "appInitializationEnd"
    ),
    acpImportMs: duration("acpImportStart", "acpImportEnd"),
    bootstrapConfigInitializationMs: duration(
      "bootstrapConfigInitializationStart",
      "bootstrapConfigInitializationEnd"
    ),
    transportSetupMs: duration("transportSetupStart", "transportSetupEnd"),
    initializeHandlerMs: duration(
      "initializeHandlerStart",
      "initializeHandlerEnd"
    )
  };
  const config = {
    extensionsInitialMs: duration(
      "extensionsInitialStart",
      "extensionsInitialEnd"
    ),
    hooksMs: duration("hooksStart", "hooksEnd"),
    skillsMs: duration("skillsStart", "skillsEnd"),
    extensionsFinalMs: duration("extensionsFinalStart", "extensionsFinalEnd"),
    hierarchicalMemoryMs: duration(
      "hierarchicalMemoryStart",
      "hierarchicalMemoryEnd"
    ),
    toolRegistryMs: duration("toolRegistryStart", "toolRegistryEnd"),
    ripgrepProbeMs: duration("ripgrepProbeStart", "ripgrepProbeEnd"),
    toolWarmupMs: duration("toolWarmupStart", "toolWarmupEnd")
  };
  const processToResponseMs = marks.responseBuilt === void 0 ? void 0 : roundMs(marks.responseBuilt);
  const topLevelSum = sumDurations([
    phases.processToProfilerReadyMs,
    phases.geminiImportMs,
    phases.argsParseMs,
    phases.settingsLoadMs,
    phases.configConstructionMs,
    phases.appInitializationMs,
    phases.acpImportMs,
    phases.bootstrapConfigInitializationMs,
    phases.transportSetupMs,
    phases.initializeHandlerMs
  ]);
  if (processToResponseMs !== void 0 && topLevelSum !== void 0) {
    phases.unattributedMs = roundMs(
      Math.max(0, processToResponseMs - topLevelSum)
    );
  }
  const configSum = sumDurations([
    config.extensionsInitialMs,
    config.hooksMs,
    config.skillsMs,
    config.extensionsFinalMs,
    config.hierarchicalMemoryMs,
    config.toolRegistryMs,
    config.toolWarmupMs
  ]);
  if (phases.bootstrapConfigInitializationMs !== void 0 && configSum !== void 0) {
    config.otherMs = roundMs(
      Math.max(0, phases.bootstrapConfigInitializationMs - configSum)
    );
  }
  const complete = processToResponseMs !== void 0 && marks.responseBuilt !== void 0 && Object.values(phases).every((value) => value !== void 0) && Object.values(config).every((value) => value !== void 0);
  const profile = {
    v: CHANNEL_STARTUP_PROFILE_VERSION,
    complete,
    phases,
    config,
    ...processToResponseMs === void 0 ? {} : { processToResponseMs },
    ...marks.responseBuilt === void 0 ? {} : {
      responseBuiltAtEpochMs: roundMs(
        performance.timeOrigin + marks.responseBuilt
      )
    }
  };
  frozen = true;
  bootstrapConfigActive = false;
  return profile;
}
__name(buildAndFreezeAcpStartupProfile, "buildAndFreezeAcpStartupProfile");
function resetAcpStartupProfilerForTesting() {
  enabled = false;
  frozen = false;
  bootstrapConfigActive = false;
  marks = {};
}
__name(resetAcpStartupProfilerForTesting, "resetAcpStartupProfilerForTesting");

export {
  initializeAcpStartupProfiler,
  isAcpStartupProfilerEnabled,
  markAcpStartup,
  beginAcpBootstrapConfigProfiling,
  endAcpBootstrapConfigProfiling,
  recordAcpConfigStartupEvent,
  buildAndFreezeAcpStartupProfile,
  resetAcpStartupProfilerForTesting
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
