/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginAcpBootstrapConfigProfiling,
  buildAndFreezeAcpStartupProfile,
  endAcpBootstrapConfigProfiling,
  initializeAcpStartupProfiler,
  isAcpStartupProfilerEnabled,
  markAcpStartup,
  recordAcpConfigStartupEvent,
  resetAcpStartupProfilerForTesting,
} from './acp-startup-profiler.js';

const CONFIG_EVENTS = [
  'config_initialize_extensions_initial_start',
  'config_initialize_extensions_initial_end',
  'config_initialize_hooks_start',
  'config_initialize_hooks_end',
  'config_initialize_skills_start',
  'config_initialize_skills_end',
  'config_initialize_extensions_final_start',
  'config_initialize_extensions_final_end',
  'config_initialize_hierarchical_memory_start',
  'config_initialize_hierarchical_memory_end',
  'config_initialize_tool_registry_start',
  'config_initialize_ripgrep_probe_start',
  'config_initialize_ripgrep_probe_end',
  'config_initialize_tool_registry_end',
  'config_initialize_tool_warmup_start',
  'config_initialize_tool_warmup_end',
] as const;

function recordCompleteProfile(): void {
  markAcpStartup('geminiImportStart');
  markAcpStartup('geminiImportEnd');
  markAcpStartup('argsParseStart');
  markAcpStartup('argsParseEnd');
  markAcpStartup('settingsLoadStart');
  markAcpStartup('settingsLoadEnd');
  markAcpStartup('configConstructionStart');
  markAcpStartup('configConstructionEnd');
  markAcpStartup('appInitializationStart');
  markAcpStartup('appInitializationEnd');
  markAcpStartup('acpImportStart');
  markAcpStartup('acpImportEnd');
  beginAcpBootstrapConfigProfiling();
  for (const event of CONFIG_EVENTS) recordAcpConfigStartupEvent(event);
  endAcpBootstrapConfigProfiling();
  markAcpStartup('transportSetupStart');
  markAcpStartup('transportSetupEnd');
  markAcpStartup('initializeHandlerStart');
  markAcpStartup('initializeHandlerEnd');
  markAcpStartup('responseBuilt');
}

describe('ACP startup profiler', () => {
  beforeEach(() => {
    resetAcpStartupProfilerForTesting();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 10;
      return now;
    });
  });

  afterEach(() => {
    resetAcpStartupProfilerForTesting();
    vi.restoreAllMocks();
  });

  it('is disabled until the ACP route initializes it', () => {
    markAcpStartup('argsParseStart');

    expect(isAcpStartupProfilerEnabled()).toBe(false);
    expect(buildAndFreezeAcpStartupProfile()).toBeUndefined();
  });

  it('builds a complete bounded profile with nested Config phases', () => {
    initializeAcpStartupProfiler();
    recordCompleteProfile();

    const profile = buildAndFreezeAcpStartupProfile();

    expect(profile).toMatchObject({
      v: 1,
      complete: true,
      phases: {
        processToProfilerReadyMs: 10,
        geminiImportMs: 10,
        bootstrapConfigInitializationMs: 170,
        transportSetupMs: 10,
        initializeHandlerMs: 10,
      },
      config: {
        extensionsInitialMs: 10,
        hooksMs: 10,
        skillsMs: 10,
        extensionsFinalMs: 10,
        hierarchicalMemoryMs: 10,
        toolRegistryMs: 30,
        ripgrepProbeMs: 10,
        toolWarmupMs: 10,
      },
    });
    expect(profile!.config.otherMs).toBeGreaterThanOrEqual(0);
    expect(profile!.phases.unattributedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(profile).length).toBeLessThan(2048);
  });

  it('keeps the first mark and ignores marks after freezing', () => {
    initializeAcpStartupProfiler();
    markAcpStartup('geminiImportStart');
    markAcpStartup('geminiImportStart');
    markAcpStartup('geminiImportEnd');
    markAcpStartup('responseBuilt');

    const before = buildAndFreezeAcpStartupProfile();
    markAcpStartup('argsParseStart');
    markAcpStartup('argsParseEnd');
    const after = buildAndFreezeAcpStartupProfile();

    expect(before!.phases.geminiImportMs).toBe(10);
    expect(after).toEqual(before);
    expect(after!.phases.argsParseMs).toBeUndefined();
  });

  it('ignores Config events outside the bootstrap window', () => {
    initializeAcpStartupProfiler();
    recordAcpConfigStartupEvent('config_initialize_extensions_initial_start');
    recordAcpConfigStartupEvent('config_initialize_extensions_initial_end');
    markAcpStartup('responseBuilt');

    const profile = buildAndFreezeAcpStartupProfile();

    expect(profile!.complete).toBe(false);
    expect(profile!.config.extensionsInitialMs).toBeUndefined();
  });
});
