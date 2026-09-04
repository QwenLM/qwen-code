/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';
import {
  CHANNEL_STARTUP_PROFILE_VERSION,
  type ChannelStartupProfileV1,
} from '@qwen-code/acp-bridge/bridgeTypes';

export type AcpStartupMark =
  | 'profilerReady'
  | 'geminiImportStart'
  | 'geminiImportEnd'
  | 'argsParseStart'
  | 'argsParseEnd'
  | 'settingsLoadStart'
  | 'settingsLoadEnd'
  | 'configConstructionStart'
  | 'configConstructionEnd'
  | 'appInitializationStart'
  | 'appInitializationEnd'
  | 'acpImportStart'
  | 'acpImportEnd'
  | 'bootstrapConfigInitializationStart'
  | 'bootstrapConfigInitializationEnd'
  | 'transportSetupStart'
  | 'transportSetupEnd'
  | 'initializeHandlerStart'
  | 'initializeHandlerEnd'
  | 'responseBuilt'
  | 'extensionsInitialStart'
  | 'extensionsInitialEnd'
  | 'hooksStart'
  | 'hooksEnd'
  | 'skillsStart'
  | 'skillsEnd'
  | 'extensionsFinalStart'
  | 'extensionsFinalEnd'
  | 'hierarchicalMemoryStart'
  | 'hierarchicalMemoryEnd'
  | 'toolRegistryStart'
  | 'toolRegistryEnd'
  | 'ripgrepProbeStart'
  | 'ripgrepProbeEnd'
  | 'toolWarmupStart'
  | 'toolWarmupEnd';

const CONFIG_EVENT_MARKS = {
  config_initialize_extensions_initial_start: 'extensionsInitialStart',
  config_initialize_extensions_initial_end: 'extensionsInitialEnd',
  config_initialize_hooks_start: 'hooksStart',
  config_initialize_hooks_end: 'hooksEnd',
  config_initialize_skills_start: 'skillsStart',
  config_initialize_skills_end: 'skillsEnd',
  config_initialize_extensions_final_start: 'extensionsFinalStart',
  config_initialize_extensions_final_end: 'extensionsFinalEnd',
  config_initialize_hierarchical_memory_start: 'hierarchicalMemoryStart',
  config_initialize_hierarchical_memory_end: 'hierarchicalMemoryEnd',
  config_initialize_tool_registry_start: 'toolRegistryStart',
  config_initialize_tool_registry_end: 'toolRegistryEnd',
  config_initialize_ripgrep_probe_start: 'ripgrepProbeStart',
  config_initialize_ripgrep_probe_end: 'ripgrepProbeEnd',
  config_initialize_tool_warmup_start: 'toolWarmupStart',
  config_initialize_tool_warmup_end: 'toolWarmupEnd',
} as const satisfies Record<string, AcpStartupMark>;

let enabled = false;
let frozen = false;
let bootstrapConfigActive = false;
let marks: Partial<Record<AcpStartupMark, number>> = {};

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function duration(
  start: AcpStartupMark,
  end: AcpStartupMark,
): number | undefined {
  const startMs = marks[start];
  const endMs = marks[end];
  return startMs === undefined || endMs === undefined || endMs < startMs
    ? undefined
    : roundMs(endMs - startMs);
}

function sumDurations(
  values: ReadonlyArray<number | undefined>,
): number | undefined {
  return values.every((value): value is number => value !== undefined)
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined;
}

export function initializeAcpStartupProfiler(): void {
  if (enabled) return;
  enabled = true;
  frozen = false;
  bootstrapConfigActive = false;
  marks = { profilerReady: performance.now() };
}

export function isAcpStartupProfilerEnabled(): boolean {
  return enabled;
}

export function markAcpStartup(mark: AcpStartupMark): void {
  if (!enabled || frozen || marks[mark] !== undefined) return;
  marks[mark] = performance.now();
}

export function beginAcpBootstrapConfigProfiling(): void {
  if (!enabled || frozen) return;
  bootstrapConfigActive = true;
  markAcpStartup('bootstrapConfigInitializationStart');
}

export function endAcpBootstrapConfigProfiling(): void {
  if (!enabled || frozen) return;
  markAcpStartup('bootstrapConfigInitializationEnd');
  bootstrapConfigActive = false;
}

export function recordAcpConfigStartupEvent(name: string): void {
  if (!enabled || frozen || !bootstrapConfigActive) return;
  const mark = CONFIG_EVENT_MARKS[name as keyof typeof CONFIG_EVENT_MARKS];
  if (mark) markAcpStartup(mark);
}

export function buildAndFreezeAcpStartupProfile():
  | ChannelStartupProfileV1
  | undefined {
  if (!enabled) return undefined;

  const phases: ChannelStartupProfileV1['phases'] = {
    processToProfilerReadyMs:
      marks.profilerReady === undefined
        ? undefined
        : roundMs(marks.profilerReady),
    geminiImportMs: duration('geminiImportStart', 'geminiImportEnd'),
    argsParseMs: duration('argsParseStart', 'argsParseEnd'),
    settingsLoadMs: duration('settingsLoadStart', 'settingsLoadEnd'),
    configConstructionMs: duration(
      'configConstructionStart',
      'configConstructionEnd',
    ),
    appInitializationMs: duration(
      'appInitializationStart',
      'appInitializationEnd',
    ),
    acpImportMs: duration('acpImportStart', 'acpImportEnd'),
    bootstrapConfigInitializationMs: duration(
      'bootstrapConfigInitializationStart',
      'bootstrapConfigInitializationEnd',
    ),
    transportSetupMs: duration('transportSetupStart', 'transportSetupEnd'),
    initializeHandlerMs: duration(
      'initializeHandlerStart',
      'initializeHandlerEnd',
    ),
  };

  const config: ChannelStartupProfileV1['config'] = {
    extensionsInitialMs: duration(
      'extensionsInitialStart',
      'extensionsInitialEnd',
    ),
    hooksMs: duration('hooksStart', 'hooksEnd'),
    skillsMs: duration('skillsStart', 'skillsEnd'),
    extensionsFinalMs: duration('extensionsFinalStart', 'extensionsFinalEnd'),
    hierarchicalMemoryMs: duration(
      'hierarchicalMemoryStart',
      'hierarchicalMemoryEnd',
    ),
    toolRegistryMs: duration('toolRegistryStart', 'toolRegistryEnd'),
    ripgrepProbeMs: duration('ripgrepProbeStart', 'ripgrepProbeEnd'),
    toolWarmupMs: duration('toolWarmupStart', 'toolWarmupEnd'),
  };

  const processToResponseMs =
    marks.responseBuilt === undefined
      ? undefined
      : roundMs(marks.responseBuilt);
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
    phases.initializeHandlerMs,
  ]);
  if (processToResponseMs !== undefined && topLevelSum !== undefined) {
    phases.unattributedMs = roundMs(
      Math.max(0, processToResponseMs - topLevelSum),
    );
  }

  const configSum = sumDurations([
    config.extensionsInitialMs,
    config.hooksMs,
    config.skillsMs,
    config.extensionsFinalMs,
    config.hierarchicalMemoryMs,
    config.toolRegistryMs,
    config.toolWarmupMs,
  ]);
  if (
    phases.bootstrapConfigInitializationMs !== undefined &&
    configSum !== undefined
  ) {
    config.otherMs = roundMs(
      Math.max(0, phases.bootstrapConfigInitializationMs - configSum),
    );
  }

  const complete =
    processToResponseMs !== undefined &&
    marks.responseBuilt !== undefined &&
    Object.values(phases).every((value) => value !== undefined) &&
    Object.values(config).every((value) => value !== undefined);
  const profile: ChannelStartupProfileV1 = {
    v: CHANNEL_STARTUP_PROFILE_VERSION,
    complete,
    phases,
    config,
    ...(processToResponseMs === undefined ? {} : { processToResponseMs }),
    ...(marks.responseBuilt === undefined
      ? {}
      : {
          responseBuiltAtEpochMs: roundMs(
            performance.timeOrigin + marks.responseBuilt,
          ),
        }),
  };

  frozen = true;
  bootstrapConfigActive = false;
  return profile;
}

export function resetAcpStartupProfilerForTesting(): void {
  enabled = false;
  frozen = false;
  bootstrapConfigActive = false;
  marks = {};
}
