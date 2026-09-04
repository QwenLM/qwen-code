/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';
import v8 from 'node:v8';
import { createDebugLogger } from './debugLogger.js';
import { formatMemoryUsage } from './formatters.js';

const RSS_HEAP_GAP_RATIO = 10;
const RSS_HEAP_GAP_MIN_BYTES = 256 * 1024 * 1024;
// Native pressure can look extreme during early startup when heap is tiny.
// Require an absolute floor before the ratio check so cold processes don't
// flag spurious risks.
const NATIVE_MEMORY_PRESSURE_MIN_BYTES = 64 * 1024 * 1024;
const ACTIVE_HANDLES_THRESHOLD = 256;
const ACTIVE_REQUESTS_THRESHOLD = 100;
const OPEN_FD_THRESHOLD = 500;
const debugLogger = createDebugLogger('MEMORY_DIAGNOSTICS');
const execFileAsync = promisify(execFile);

export interface MemoryDiagnostics {
  timestamp: string;
  sessionId?: string;
  qwenVersion?: string;
  uptimeSeconds: number;
  memoryUsage: NodeJS.MemoryUsage;
  v8HeapStats: V8HeapStats;
  v8HeapSpaces: V8HeapSpaceStats[] | null;
  resourceUsage: MemoryResourceUsage;
  processTree: ProcessTreeMemoryUsage | null;
  activeHandles: number;
  activeRequests: number;
  openFileDescriptors: number | null;
  smapsRollup: string | null;
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
  /** Normalized bytes. Node/resourceUsage reports maxRSS in KiB. */
  maxRSS: number;
  maxRSSRaw: number;
  maxRSSUnit: 'KiB';
  userCPUTime: number;
  systemCPUTime: number;
}

export interface ProcessTreeMemoryUsage {
  rootPid: number;
  processCount: number;
  rootRSS: number;
  treeRSS: number;
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
    | 'native-memory-pressure'
    | 'rss-heap-gap';
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
  processTree?: () => Promise<ProcessTreeMemoryUsage>;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
}

// `_getActiveHandles` / `_getActiveRequests` are undocumented Node internals.
// They've been stable for years but are not part of the public API and could
// change in a future Node release. Both call sites guard with try/catch and
// fall back to 0, so a removal degrades gracefully.
interface ProcessInternals {
  _getActiveHandles?: () => unknown;
  _getActiveRequests?: () => unknown;
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
  const [openFileDescriptors, smapsRollup, heapSpaceStatistics, processTree] =
    await Promise.all([
      optionalProbe(
        'openFileDescriptors',
        options.openFileDescriptors ?? countOpenFileDescriptors,
      ),
      optionalProbe('smapsRollup', options.smapsRollup ?? readProcSmapsRollup),
      optionalSyncProbe(
        'heapSpaceStatistics',
        options.heapSpaceStatistics ?? (() => v8.getHeapSpaceStatistics()),
      ),
      optionalProbe(
        'processTree',
        options.processTree ?? (() => collectProcessTreeMemoryUsage(platform)),
      ),
    ]);
  const v8HeapSpaces = mapHeapSpaces(heapSpaceStatistics);

  const maxRSSRaw = resourceUsage.maxRSS;
  const maxRSSBytes = normalizeMaxRSSBytes(maxRSSRaw);

  const diagnostics = {
    timestamp: now().toISOString(),
    sessionId: options.sessionId,
    qwenVersion: options.qwenVersion,
    uptimeSeconds,
    memoryUsage,
    v8HeapStats: mapHeapStats(heapStatistics),
    v8HeapSpaces,
    resourceUsage: {
      maxRSS: maxRSSBytes,
      maxRSSRaw,
      maxRSSUnit: 'KiB' as const,
      userCPUTime: resourceUsage.userCPUTime,
      systemCPUTime: resourceUsage.systemCPUTime,
    },
    processTree,
    activeHandles: getProcessInternalCount(
      'activeHandles',
      '_getActiveHandles',
      options.activeHandles,
    ),
    activeRequests: getProcessInternalCount(
      'activeRequests',
      '_getActiveRequests',
      options.activeRequests,
    ),
    openFileDescriptors,
    smapsRollup,
    platform,
    nodeVersion: options.nodeVersion ?? process.version,
  } satisfies Omit<MemoryDiagnostics, 'analysis'>;

  return {
    ...diagnostics,
    analysis: analyzeMemoryDiagnostics(diagnostics),
  };
}

function normalizeMaxRSSBytes(maxRSSKiB: number): number {
  return maxRSSKiB * 1024;
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
  heapSpaces: v8.HeapSpaceInfo[] | null,
): V8HeapSpaceStats[] | null {
  if (!heapSpaces) {
    return null;
  }
  return heapSpaces.map((space) => ({
    name: space.space_name,
    size: space.space_size,
    used: space.space_used_size,
    available: space.space_available_size,
  }));
}

function getProcessInternalCount(
  name: 'activeHandles' | 'activeRequests',
  internalMethod: '_getActiveHandles' | '_getActiveRequests',
  probe?: () => number,
): number {
  try {
    if (probe) {
      return probe();
    }
    const internals = process as unknown as ProcessInternals;
    const internalProbe = internals[internalMethod];
    if (typeof internalProbe !== 'function') {
      logProbeFailure(name, new Error(`${internalMethod} is unavailable`));
      return 0;
    }

    const result = internalProbe();
    if (!Array.isArray(result)) {
      logProbeFailure(
        name,
        new Error(`${internalMethod} returned a non-array result`),
      );
      return 0;
    }

    return result.length;
  } catch (error) {
    logProbeFailure(name, error);
    return 0;
  }
}

async function countOpenFileDescriptors(): Promise<number> {
  return (await readdir('/proc/self/fd')).length;
}

async function readProcSmapsRollup(): Promise<string> {
  return readFile('/proc/self/smaps_rollup', 'utf8');
}

async function collectProcessTreeMemoryUsage(
  platform: NodeJS.Platform,
): Promise<ProcessTreeMemoryUsage> {
  if (platform === 'win32') {
    throw new Error('process tree RSS probe is unavailable on win32');
  }

  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss='], {
    maxBuffer: 1024 * 1024,
    timeout: 5000,
  });
  const rows = parsePsRows(stdout);
  const rootPid = process.pid;
  const rowsByPid = new Map(rows.map((row) => [row.pid, row]));
  const childrenByParent = new Map<number, PsRow[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid);
    if (children) {
      children.push(row);
    } else {
      childrenByParent.set(row.ppid, [row]);
    }
  }

  const queue = [rootPid];
  const seen = new Set<number>();
  let rootRSS = 0;
  let treeRSS = 0;
  let processCount = 0;
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    const row = rowsByPid.get(pid);
    if (row) {
      const rssBytes = row.rssKiB * 1024;
      if (pid === rootPid) {
        rootRSS = rssBytes;
      }
      treeRSS += rssBytes;
      processCount += 1;
    }
    for (const child of childrenByParent.get(pid) ?? []) {
      queue.push(child.pid);
    }
  }

  return {
    rootPid,
    processCount,
    rootRSS,
    treeRSS,
  };
}

interface PsRow {
  pid: number;
  ppid: number;
  rssKiB: number;
}

function parsePsRows(output: string): PsRow[] {
  return output
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [pid, ppid, rssKiB] = line.trim().split(/\s+/).map(Number);
      return { pid, ppid, rssKiB };
    })
    .filter(
      (row) =>
        Number.isFinite(row.pid) &&
        Number.isFinite(row.ppid) &&
        Number.isFinite(row.rssKiB),
    );
}

async function optionalProbe<T>(
  name: string,
  probe: () => Promise<T>,
): Promise<T | null> {
  try {
    return await probe();
  } catch (error) {
    logProbeFailure(name, error);
    return null;
  }
}

async function optionalSyncProbe<T>(
  name: string,
  probe: () => T,
): Promise<T | null> {
  try {
    return probe();
  } catch (error) {
    logProbeFailure(name, error);
    return null;
  }
}

function logProbeFailure(name: string, error: unknown): void {
  debugLogger.debug(`memory diagnostics probe failed: ${name}`, error);
}

function analyzeMemoryDiagnostics(
  diagnostics: Omit<MemoryDiagnostics, 'analysis'>,
): MemoryDiagnosticsAnalysis {
  const risks: MemoryRisk[] = [];
  const heapRatio =
    diagnostics.v8HeapStats.heapSizeLimit > 0
      ? diagnostics.v8HeapStats.usedHeapSize /
        diagnostics.v8HeapStats.heapSizeLimit
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

  if (diagnostics.activeHandles > ACTIVE_HANDLES_THRESHOLD) {
    risks.push({
      type: 'active-handles',
      message: `${diagnostics.activeHandles} active handle(s) detected.`,
    });
  }

  if (diagnostics.activeRequests > ACTIVE_REQUESTS_THRESHOLD) {
    risks.push({
      type: 'active-requests',
      message: `${diagnostics.activeRequests} active request(s) detected.`,
    });
  }

  if (
    diagnostics.openFileDescriptors !== null &&
    diagnostics.openFileDescriptors > OPEN_FD_THRESHOLD
  ) {
    risks.push({
      type: 'fd-leak',
      message: `${diagnostics.openFileDescriptors} open file descriptor(s) detected.`,
    });
  }

  // Use mallocedMemory instead of rss - heapUsed. RSS includes normal process
  // overhead such as code segments, shared libraries, stacks, and mapped files,
  // which creates false positives on healthy Node.js processes. Also gate on
  // an absolute floor so tiny startup heaps don't trip the 2× ratio.
  const nativeMemory = diagnostics.v8HeapStats.mallocedMemory;
  if (
    nativeMemory >= NATIVE_MEMORY_PRESSURE_MIN_BYTES &&
    nativeMemory > diagnostics.memoryUsage.heapUsed * 2
  ) {
    risks.push({
      type: 'native-memory-pressure',
      message: `V8 native malloced memory (${formatMemoryUsage(nativeMemory)}) is more than 2× heap used (${formatMemoryUsage(diagnostics.memoryUsage.heapUsed)}).`,
    });
  }

  if (
    diagnostics.memoryUsage.heapUsed > 0 &&
    diagnostics.memoryUsage.rss >= RSS_HEAP_GAP_MIN_BYTES &&
    diagnostics.memoryUsage.rss >
      diagnostics.memoryUsage.heapUsed * RSS_HEAP_GAP_RATIO
  ) {
    risks.push({
      type: 'rss-heap-gap',
      message: `RSS (${formatMemoryUsage(diagnostics.memoryUsage.rss)}) is more than ${RSS_HEAP_GAP_RATIO}× heap used (${formatMemoryUsage(diagnostics.memoryUsage.heapUsed)}). Check native addons, libuv buffers, mapped files, or retained tool output.`,
    });
  }

  return {
    risks,
    recommendation:
      risks.length > 0
        ? `${risks.length} potential leak indicator(s) found.`
        : 'No obvious leak indicators detected.',
  };
}
