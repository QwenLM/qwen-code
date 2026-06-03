/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lightweight startup performance profiler.
 *
 * Activated by setting QWEN_CODE_PROFILE_STARTUP=1. When enabled, collects
 * high-resolution timestamps at key phases of CLI startup and writes a JSON
 * report to ~/.qwen/startup-perf/ on finalization.
 *
 * Usage (already wired in index.ts / gemini.tsx):
 *   initStartupProfiler()        — call once at process start to record T0
 *   profileCheckpoint('name')    — call at each phase boundary (sequential)
 *   recordStartupEvent('name', attrs?) — record a discrete event (multi-fire allowed)
 *   finalizeStartupProfile(id)   — call after last checkpoint to write report
 *
 * By default profiles only inside the sandbox child process to avoid duplicate
 * reports. Set QWEN_CODE_PROFILE_STARTUP_OUTER=1 to also profile the outer
 * (pre-sandbox) process; outer reports are written with an `outer-` filename
 * prefix to keep them separate from sandbox-child reports.
 *
 * Zero overhead when disabled (single env var check).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

import type { StartupEventAttrs } from '@qwen-code/qwen-code-core';

interface Checkpoint {
  name: string;
  timestamp: number;
  heapUsedMb?: number;
}

export interface StartupPhase {
  name: string;
  startMs: number;
  durationMs: number;
  heapUsedMb?: number;
}

export interface StartupEvent {
  name: string;
  tMs: number;
  heapUsedMb?: number;
  attrs?: StartupEventAttrs;
}

/**
 * Derived phase summary, keyed by phase name. Values are absolute ms from T0.
 * Mirrors the spirit of Claude Code's PHASE_DEFINITIONS for nightly CI thresholds.
 * Only phases for which the underlying checkpoint/event was recorded appear.
 */
export type DerivedPhases = Partial<{
  /** Time from process start to T0 (covers V8 module-eval). */
  module_load: number;
  /** T0 → after_load_settings. */
  settings_time: number;
  /** after_load_settings → after_load_cli_config. */
  config_time: number;
  /** after_load_cli_config → after_initialize_app. */
  init_time: number;
  /** T0 → before_render. */
  pre_render: number;
  /** T0 → first_paint. */
  to_first_paint: number;
  /** T0 → input_enabled. (Real TTI.) */
  to_input_enabled: number;
  /** Duration of `config.initialize()` (interactive only). */
  config_initialize_dur: number;
  /** T0 → mcp_first_tool_registered. */
  mcp_first_tool: number;
  /** T0 → mcp_all_servers_settled. */
  mcp_all_settled: number;
  /** mcp_first_tool_registered → gemini_tools_updated lag. */
  gemini_tools_lag: number;
}>;

export interface StartupReport {
  timestamp: string;
  sessionId: string;
  /** Whether this run was an interactive UI startup. */
  interactiveMode: boolean;
  /** True when the report was produced by the outer (pre-sandbox) process. */
  outerProcess: boolean;
  /** Time from Node.js process start to T0 (initStartupProfiler call), covers module loading. */
  processUptimeAtT0Ms: number;
  totalMs: number;
  phases: StartupPhase[];
  events: StartupEvent[];
  /** True if the events list hit MAX_EVENTS and dropped some entries. */
  eventsTruncated: boolean;
  derivedPhases: DerivedPhases;
  nodeVersion: string;
  platform: string;
  arch: string;
}

let enabled = false;
let captureHeap = false;
let outerProcess = false;
let interactiveMode = false;
let t0 = 0;
let processUptimeAtT0Ms = 0;
let checkpoints: Checkpoint[] = [];
let events: StartupEvent[] = [];
let eventsTruncated = false;
let finalized = false;

// Defense-in-depth cap on the events list. Under normal flow `finalized`
// stops new events shortly after `input_enabled`. This bound only matters in
// pathological paths where finalize is bypassed (e.g. crash before the mount
// effect runs while MCP still emits server-ready events).
const MAX_EVENTS = 1024;

const HEAP_BYTES_TO_MB = 1 / (1024 * 1024);

function snapshotHeapMb(): number | undefined {
  if (!captureHeap) return undefined;
  try {
    return (
      Math.round(process.memoryUsage().heapUsed * HEAP_BYTES_TO_MB * 100) / 100
    );
  } catch {
    return undefined;
  }
}

export function initStartupProfiler(): void {
  // Reset any prior state so the function is idempotent.
  resetStartupProfiler();

  if (process.env['QWEN_CODE_PROFILE_STARTUP'] !== '1') {
    return;
  }

  const inSandboxChild = !!process.env['SANDBOX'];
  const outerOptIn = process.env['QWEN_CODE_PROFILE_STARTUP_OUTER'] === '1';

  // Default behavior is unchanged: only the sandbox child collects.
  // Outer (pre-sandbox) collection requires an explicit opt-in to avoid
  // accidentally producing duplicate reports.
  if (!inSandboxChild && !outerOptIn) {
    return;
  }

  enabled = true;
  outerProcess = !inSandboxChild;
  // Default to capturing heap snapshots at every checkpoint.
  // Disable with QWEN_CODE_PROFILE_STARTUP_NO_HEAP=1 when measuring the
  // Heisenberg overhead of the heap call itself.
  captureHeap = process.env['QWEN_CODE_PROFILE_STARTUP_NO_HEAP'] !== '1';
  finalized = false;
  processUptimeAtT0Ms = Math.round(process.uptime() * 1000 * 100) / 100;
  t0 = performance.now();
  checkpoints = [];
  events = [];
}

export function profileCheckpoint(name: string): void {
  if (!enabled || finalized) return;
  checkpoints.push({
    name,
    timestamp: performance.now(),
    heapUsedMb: snapshotHeapMb(),
  });
}

/**
 * Records a discrete startup event (allowed to fire multiple times).
 * Distinct from `profileCheckpoint` which is sequential and assumed unique.
 *
 * Once {@link finalizeStartupProfile} runs, further events are dropped to
 * keep memory bounded — long-running interactive sessions still call
 * `setTools()` (which emits `gemini_tools_updated`) for each MCP refresh.
 */
export function recordStartupEvent(
  name: string,
  attrs?: StartupEventAttrs,
): void {
  if (!enabled || finalized) return;
  if (events.length >= MAX_EVENTS) {
    eventsTruncated = true;
    return;
  }
  events.push({
    name,
    tMs: Math.round((performance.now() - t0) * 100) / 100,
    heapUsedMb: snapshotHeapMb(),
    ...(attrs ? { attrs } : {}),
  });
}

/**
 * Marks this run as an interactive UI startup. Affects derived phases and
 * is recorded in the report for downstream filtering.
 */
export function setInteractiveMode(value: boolean): void {
  if (!enabled) return;
  interactiveMode = value;
}

function findCheckpointMs(name: string): number | undefined {
  for (const cp of checkpoints) {
    if (cp.name === name) {
      return Math.round((cp.timestamp - t0) * 100) / 100;
    }
  }
  return undefined;
}

function findEventMs(name: string): number | undefined {
  for (const ev of events) {
    if (ev.name === name) return ev.tMs;
  }
  return undefined;
}

function computeDerivedPhases(): DerivedPhases {
  const out: DerivedPhases = {};
  out.module_load = processUptimeAtT0Ms;

  const afterSettings = findCheckpointMs('after_load_settings');
  if (afterSettings !== undefined) out.settings_time = afterSettings;

  const afterCfg = findCheckpointMs('after_load_cli_config');
  if (afterSettings !== undefined && afterCfg !== undefined) {
    out.config_time = Math.round((afterCfg - afterSettings) * 100) / 100;
  }

  const afterInit = findCheckpointMs('after_initialize_app');
  if (afterCfg !== undefined && afterInit !== undefined) {
    out.init_time = Math.round((afterInit - afterCfg) * 100) / 100;
  }

  const beforeRender = findCheckpointMs('before_render');
  if (beforeRender !== undefined) out.pre_render = beforeRender;

  const firstPaint = findCheckpointMs('first_paint');
  if (firstPaint !== undefined) out.to_first_paint = firstPaint;

  const inputEnabled = findCheckpointMs('input_enabled');
  if (inputEnabled !== undefined) out.to_input_enabled = inputEnabled;

  const ciStart = findCheckpointMs('config_initialize_start');
  const ciEnd = findCheckpointMs('config_initialize_end');
  if (ciStart !== undefined && ciEnd !== undefined) {
    out.config_initialize_dur = Math.round((ciEnd - ciStart) * 100) / 100;
  }

  const mcpFirst = findEventMs('mcp_first_tool_registered');
  if (mcpFirst !== undefined) out.mcp_first_tool = mcpFirst;

  const mcpSettled = findEventMs('mcp_all_servers_settled');
  if (mcpSettled !== undefined) out.mcp_all_settled = mcpSettled;

  // gemini_tools_lag = how long after the first MCP server finished
  // discover did the model actually receive an updated tool list. We must
  // pick the FIRST `gemini_tools_updated` event whose timestamp is >=
  // `mcp_first_tool_registered`, because earlier `setTools()` calls fire
  // from `GeminiClient.initialize() -> startChat()` (built-in tools only)
  // and from `SkillTool` post-construction refresh — both happen BEFORE
  // MCP discovery starts under PR-A, so naively taking the first
  // `gemini_tools_updated` would give a misleading negative lag.
  if (mcpFirst !== undefined) {
    for (const ev of events) {
      if (ev.name === 'gemini_tools_updated' && ev.tMs >= mcpFirst) {
        out.gemini_tools_lag = Math.round((ev.tMs - mcpFirst) * 100) / 100;
        break;
      }
    }
  }

  return out;
}

export function getStartupReport(): StartupReport | null {
  if (!enabled || (checkpoints.length === 0 && events.length === 0)) {
    return null;
  }

  const phases: StartupPhase[] = [];
  let prev = t0;

  // Each phase's durationMs is the delta from the previous checkpoint (or T0
  // for the first one). Checkpoints are assumed to be recorded sequentially.
  for (const cp of checkpoints) {
    phases.push({
      name: cp.name,
      startMs: Math.round((prev - t0) * 100) / 100,
      durationMs: Math.round((cp.timestamp - prev) * 100) / 100,
      ...(cp.heapUsedMb !== undefined ? { heapUsedMb: cp.heapUsedMb } : {}),
    });
    prev = cp.timestamp;
  }

  const lastTimestamp =
    checkpoints.length > 0
      ? checkpoints[checkpoints.length - 1]!.timestamp
      : performance.now();

  return {
    timestamp: new Date().toISOString(),
    sessionId: 'unknown',
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
    arch: process.arch,
  };
}

export function finalizeStartupProfile(sessionId?: string): void {
  if (!enabled || finalized) return;
  finalized = true;

  const report = getStartupReport();
  if (!report) return;

  if (sessionId) {
    report.sessionId = sessionId;
  }

  try {
    const dir = path.join(os.homedir(), '.qwen', 'startup-perf');
    fs.mkdirSync(dir, { recursive: true });

    const prefix = report.outerProcess ? 'outer-' : '';
    const filename = `${prefix}${report.timestamp.replace(/[:.]/g, '-')}-${report.sessionId}.json`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, JSON.stringify(report, null, 2), 'utf-8');
    process.stderr.write(`Startup profile written to: ${filepath}\n`);
  } catch {
    process.stderr.write('Warning: Failed to write startup profile report\n');
  }
}

export function resetStartupProfiler(): void {
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

/**
 * Test-only: returns whether profiling is currently active. Used by the
 * cli to short-circuit the cross-package event sink registration.
 */
export function isStartupProfilerEnabled(): boolean {
  return enabled;
}
