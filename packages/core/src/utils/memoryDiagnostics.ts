/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdir, readFile } from 'node:fs/promises';
import process from 'node:process';
import v8 from 'node:v8';

export interface MemoryDiagnostics {
  timestamp: string;
  sessionId?: string;
  qwenVersion?: string;
  uptimeSeconds: number;
  memoryUsage: NodeJS.MemoryUsage;
  v8HeapStats: V8HeapStats;
  v8HeapSpaces?: V8HeapSpaceStats[];
  resourceUsage: MemoryResourceUsage;
  activeHandles: number;
  activeRequests: number;
  openFileDescriptors?: number;
  smapsRollup?: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  analysis: MemoryDiagnosticsAnalysis;
}

export interface V8HeapStats {
  heapSizeLimit: number;
  totalHeapSize: number;
  usedHeapSize: number;
  mallocedMemory: number;
  peakMallocedMemory: number;
  detachedContexts: number;
  nativeContexts: number;
}

export interface V8HeapSpaceStats {
  name: string;
  size: number;
  used: number;
  available: number;
}

export interface MemoryResourceUsage {
  maxRSS: number;
  userCPUTime: number;
  systemCPUTime: number;
}

export interface MemoryDiagnosticsAnalysis {
  risks: MemoryRisk[];
  recommendation: string;
}

export interface MemoryRisk {
  type:
    | 'heap-pressure'
    | 'detached-contexts'
    | 'active-handles'
    | 'active-requests'
    | 'fd-leak'
    | 'native-memory-pressure';
  message: string;
}

export interface MemoryDiagnosticsOptions {
  now?: () => Date;
  sessionId?: string;
  qwenVersion?: string;
  memoryUsage?: () => NodeJS.MemoryUsage;
  heapStatistics?: () => v8.HeapInfo;
  heapSpaceStatistics?: () => v8.HeapSpaceInfo[];
  resourceUsage?: () => NodeJS.ResourceUsage;
  uptimeSeconds?: () => number;
  activeHandles?: () => number;
  activeRequests?: () => number;
  openFileDescriptors?: () => Promise<number>;
  smapsRollup?: () => Promise<string>;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
}

interface ProcessInternals {
  _getActiveHandles?: () => unknown[];
  _getActiveRequests?: () => unknown[];
}

export async function collectMemoryDiagnostics(
  options: MemoryDiagnosticsOptions = {},
): Promise<MemoryDiagnostics> {
  const now = options.now ?? (() => new Date());
  const platform = options.platform ?? process.platform;
  const memoryUsage = options.memoryUsage?.() ?? process.memoryUsage();
  const heapStatistics = options.heapStatistics?.() ?? v8.getHeapStatistics();
  const resourceUsage = options.resourceUsage?.() ?? process.resourceUsage();
  const uptimeSeconds = options.uptimeSeconds?.() ?? process.uptime();
  const openFileDescriptors = await optionalProbe(
    options.openFileDescriptors ?? countOpenFileDescriptors,
  );
  const smapsRollup = await optionalProbe(
    options.smapsRollup ?? readProcSmapsRollup,
  );
  const v8HeapSpaces = mapHeapSpaces(
    await optionalSyncProbe(
      options.heapSpaceStatistics ?? (() => v8.getHeapSpaceStatistics()),
    ),
  );

  // process.resourceUsage().maxRSS is in kilobytes on Linux but bytes on
  // macOS/Windows. Normalise to bytes for a consistent diagnostic unit.
  const maxRSSBytes =
    platform === 'linux' ? resourceUsage.maxRSS * 1024 : resourceUsage.maxRSS;

  const diagnostics: MemoryDiagnostics = {
    timestamp: now().toISOString(),
    sessionId: options.sessionId,
    qwenVersion: options.qwenVersion,
    uptimeSeconds,
    memoryUsage,
    v8HeapStats: mapHeapStats(heapStatistics),
    v8HeapSpaces,
    resourceUsage: {
      maxRSS: maxRSSBytes,
      userCPUTime: resourceUsage.userCPUTime,
      systemCPUTime: resourceUsage.systemCPUTime,
    },
    activeHandles: getActiveHandlesCount(options.activeHandles),
    activeRequests: getActiveRequestsCount(options.activeRequests),
    openFileDescriptors,
    smapsRollup,
    platform,
    nodeVersion: options.nodeVersion ?? process.version,
    analysis: {
      risks: [],
      recommendation: '',
    },
  };

  diagnostics.analysis = analyzeMemoryDiagnostics(diagnostics);
  return diagnostics;
}

function mapHeapStats(heapInfo: v8.HeapInfo): V8HeapStats {
  return {
    heapSizeLimit: heapInfo.heap_size_limit,
    totalHeapSize: heapInfo.total_heap_size,
    usedHeapSize: heapInfo.used_heap_size,
    mallocedMemory: heapInfo.malloced_memory,
    peakMallocedMemory: heapInfo.peak_malloced_memory,
    detachedContexts: heapInfo.number_of_detached_contexts,
    nativeContexts: heapInfo.number_of_native_contexts,
  };
}

function mapHeapSpaces(
  heapSpaces: v8.HeapSpaceInfo[] | undefined,
): V8HeapSpaceStats[] | undefined {
  return heapSpaces?.map((space) => ({
    name: space.space_name,
    size: space.space_size,
    used: space.space_used_size,
    available: space.space_available_size,
  }));
}

function getActiveHandlesCount(probe?: () => number): number {
  if (probe) {
    return probe();
  }
  const internals = process as unknown as ProcessInternals;
  return internals._getActiveHandles?.().length ?? 0;
}

function getActiveRequestsCount(probe?: () => number): number {
  if (probe) {
    return probe();
  }
  const internals = process as unknown as ProcessInternals;
  return internals._getActiveRequests?.().length ?? 0;
}

async function countOpenFileDescriptors(): Promise<number> {
  return (await readdir('/proc/self/fd')).length;
}

async function readProcSmapsRollup(): Promise<string> {
  return readFile('/proc/self/smaps_rollup', 'utf8');
}

async function optionalProbe<T>(
  probe: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await probe();
  } catch {
    return undefined;
  }
}

async function optionalSyncProbe<T>(probe: () => T): Promise<T | undefined> {
  try {
    return probe();
  } catch {
    return undefined;
  }
}

function analyzeMemoryDiagnostics(
  diagnostics: MemoryDiagnostics,
): MemoryDiagnosticsAnalysis {
  const risks: MemoryRisk[] = [];
  const heapRatio =
    diagnostics.v8HeapStats.heapSizeLimit > 0
      ? diagnostics.memoryUsage.heapUsed / diagnostics.v8HeapStats.heapSizeLimit
      : 0;

  if (heapRatio >= 0.75) {
    risks.push({
      type: 'heap-pressure',
      message: `Heap usage is ${(heapRatio * 100).toFixed(1)}% of the V8 limit.`,
    });
  }

  if (diagnostics.v8HeapStats.detachedContexts > 0) {
    risks.push({
      type: 'detached-contexts',
      message: `${diagnostics.v8HeapStats.detachedContexts} detached V8 context(s) detected.`,
    });
  }

  if (diagnostics.activeHandles > 100) {
    risks.push({
      type: 'active-handles',
      message: `${diagnostics.activeHandles} active handle(s) detected.`,
    });
  }

  if (diagnostics.activeRequests > 100) {
    risks.push({
      type: 'active-requests',
      message: `${diagnostics.activeRequests} active request(s) detected.`,
    });
  }

  if (
    diagnostics.openFileDescriptors !== undefined &&
    diagnostics.openFileDescriptors > 500
  ) {
    risks.push({
      type: 'fd-leak',
      message: `${diagnostics.openFileDescriptors} open file descriptor(s) detected.`,
    });
  }

  const nativeMemory =
    diagnostics.memoryUsage.rss - diagnostics.memoryUsage.heapUsed;
  if (nativeMemory > diagnostics.memoryUsage.heapUsed * 2) {
    risks.push({
      type: 'native-memory-pressure',
      message: `Native memory (${nativeMemory} bytes) is more than 2× heap used (${diagnostics.memoryUsage.heapUsed} bytes).`,
    });
  }

  return {
    risks,
    recommendation:
      risks.length > 0
        ? `WARNING: ${risks.length} potential leak indicator(s) found.`
        : 'No obvious leak indicators. Check heap snapshot for retained objects.',
  };
}
