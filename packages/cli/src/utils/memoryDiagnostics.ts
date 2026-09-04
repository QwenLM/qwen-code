/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as v8 from 'node:v8';

export const HIGH_HEAP_PRESSURE_THRESHOLD = 0.85;

export interface MemoryDiagnostics {
  generatedAt: string;
  process: {
    pid: number;
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
    uptimeSeconds: number;
  };
  memory: NodeJS.MemoryUsage;
  v8: {
    heapStatistics?: Record<string, number>;
    heapSpaces: Array<Record<string, number | string>>;
    unavailable?: boolean;
  };
  activeHandles: {
    count: number;
    unavailable: boolean;
  };
  activeRequests: {
    count: number;
    unavailable: boolean;
  };
}

function countProcessInternals(
  name: '_getActiveHandles' | '_getActiveRequests',
) {
  // These process methods are undocumented Node.js internals. They provide
  // useful diagnostic counts, but may change across Node.js major versions; if
  // unavailable or unstable, report `unavailable` instead of failing /doctor.
  // Node.js 22 marks them deprecated (DEP0175), so this remains limited to the
  // explicit /doctor memory diagnostic path.
  const getter = (process as unknown as Record<string, unknown>)[name];
  if (typeof getter !== 'function') {
    return { count: 0, unavailable: true };
  }

  try {
    const entries = (getter as () => unknown[])();
    if (!Array.isArray(entries)) {
      return { count: 0, unavailable: true };
    }

    return {
      count: entries.length,
      unavailable: false,
    };
  } catch {
    return { count: 0, unavailable: true };
  }
}

export function getMemoryDiagnostics(): MemoryDiagnostics {
  let heapStatistics: Record<string, number> | undefined;
  let heapSpaces: Array<Record<string, number | string>> = [];

  try {
    heapStatistics = v8.getHeapStatistics() as unknown as Record<
      string,
      number
    >;
  } catch {
    heapStatistics = undefined;
  }

  try {
    heapSpaces = v8.getHeapSpaceStatistics() as unknown as Array<
      Record<string, number | string>
    >;
  } catch {
    heapSpaces = [];
  }

  return {
    generatedAt: new Date().toISOString(),
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptimeSeconds: process.uptime(),
    },
    memory: process.memoryUsage(),
    v8: {
      heapStatistics,
      heapSpaces,
      unavailable: heapStatistics === undefined,
    },
    activeHandles: countProcessInternals('_getActiveHandles'),
    activeRequests: countProcessInternals('_getActiveRequests'),
  };
}

export interface WriteMemoryHeapSnapshotOptions {
  outputDir?: string;
  now?: Date;
  writeSnapshot?: (filePath: string) => string;
  estimateSnapshotBytes?: () => number;
  getAvailableBytes?: (dir: string) => number;
  minFreeBytesAfterSnapshot?: number;
  maxSnapshots?: number;
  rateLimitMs?: number;
}

export interface MemoryPressureSample {
  index: number;
  timestamp: string;
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface CollectMemoryPressureSamplesOptions {
  sampleCount?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  now?: () => Date;
  memoryUsage?: () => NodeJS.MemoryUsage;
  wait?: (ms: number) => Promise<void>;
}

function defaultHeapSnapshotDir(): string {
  return path.join(os.homedir(), '.qwen', 'memory-snapshots');
}

function formatSnapshotTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function estimateHeapSnapshotBytes(): number {
  // Conservative 3x estimate: V8 heap snapshots include metadata, edges, and
  // string tables in addition to live heap bytes.
  const overheadFactor = 3;
  try {
    const heapStats = v8.getHeapStatistics();
    return (
      Math.max(heapStats.total_heap_size, process.memoryUsage().heapTotal) *
      overheadFactor
    );
  } catch {
    return process.memoryUsage().heapTotal * overheadFactor;
  }
}

function getAvailableBytes(outputDir: string): number {
  try {
    const stats = fs.statfsSync(outputDir);
    return stats.bavail * stats.bsize;
  } catch (error) {
    throw new Error(
      `Unable to check available disk space for heap snapshot: ${formatErrorMessage(
        error,
      )}`,
    );
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanupOldHeapSnapshots(
  outputDir: string,
  maxSnapshots: number,
): void {
  if (maxSnapshots < 1) return;

  const snapshots = fs
    .readdirSync(outputDir)
    .filter(
      (name) =>
        name.startsWith('qwen-code-heap-') && name.endsWith('.heapsnapshot'),
    )
    .map((name) => path.join(outputDir, name))
    .sort((a, b) => {
      const mtimeDelta = getSnapshotMtimeMs(b) - getSnapshotMtimeMs(a);
      if (mtimeDelta !== 0) return mtimeDelta;

      return (
        extractHeapSnapshotTimestamp(b).localeCompare(
          extractHeapSnapshotTimestamp(a),
        ) || path.basename(b).localeCompare(path.basename(a))
      );
    });

  for (const filePath of snapshots.slice(maxSnapshots)) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Cleanup is best effort; one stuck file should not block the rest.
    }
  }
}

function getSnapshotMtimeMs(filePath: string): number {
  try {
    return fs.lstatSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function extractHeapSnapshotTimestamp(filePath: string): string {
  return (
    path
      .basename(filePath)
      .match(/^qwen-code-heap-\d+-(.+)\.heapsnapshot$/)?.[1] ?? ''
  );
}

const lastHeapSnapshotWriteByDir = new Map<string, number>();

export function clearHeapSnapshotRateLimit(): void {
  lastHeapSnapshotWriteByDir.clear();
}

function enforceHeapSnapshotRateLimit(
  outputDir: string,
  now: Date,
  rateLimitMs: number,
): void {
  if (rateLimitMs <= 0) return;

  const key = path.resolve(outputDir);
  const nowMs = now.getTime();
  const lastWriteMs = lastHeapSnapshotWriteByDir.get(key);
  if (lastWriteMs !== undefined && nowMs - lastWriteMs < rateLimitMs) {
    const waitSeconds = Math.ceil((rateLimitMs - (nowMs - lastWriteMs)) / 1000);
    throw new Error(
      `Heap snapshot rate limit: wait ${waitSeconds}s before writing another snapshot in this directory.`,
    );
  }
}

function recordHeapSnapshotWrite(outputDir: string, now: Date): void {
  lastHeapSnapshotWriteByDir.set(path.resolve(outputDir), now.getTime());
}

export function writeMemoryHeapSnapshot({
  outputDir = defaultHeapSnapshotDir(),
  now = new Date(),
  writeSnapshot = v8.writeHeapSnapshot,
  estimateSnapshotBytes:
    estimateSnapshotBytesOption = estimateHeapSnapshotBytes,
  getAvailableBytes: getAvailableBytesOption = getAvailableBytes,
  minFreeBytesAfterSnapshot = 512 * 1024 * 1024,
  maxSnapshots = 5,
  rateLimitMs = 60_000,
}: WriteMemoryHeapSnapshotOptions = {}): string {
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(outputDir, 0o700);
  } catch {
    // Best-effort hardening; keep diagnostics usable on filesystems that do
    // not support POSIX chmod semantics.
  }

  enforceHeapSnapshotRateLimit(outputDir, now, rateLimitMs);

  const estimatedSnapshotBytes = estimateSnapshotBytesOption();
  const availableBytes = getAvailableBytesOption(outputDir);
  if (availableBytes - estimatedSnapshotBytes < minFreeBytesAfterSnapshot) {
    throw new Error(
      'Insufficient free disk space for heap snapshot; skipping to avoid filling the disk.',
    );
  }

  const filePath = path.join(
    outputDir,
    `qwen-code-heap-${process.pid}-${formatSnapshotTimestamp(now)}.heapsnapshot`,
  );

  let writtenPath: string;
  try {
    writtenPath = writeSnapshot(filePath);
  } catch (error) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best-effort cleanup for partial snapshots after a failed write.
    }
    throw error;
  }

  try {
    fs.chmodSync(writtenPath, 0o600);
  } catch {
    // Best-effort hardening; the report warns that snapshots are sensitive.
  }
  recordHeapSnapshotWrite(outputDir, now);
  try {
    cleanupOldHeapSnapshots(outputDir, maxSnapshots);
  } catch {
    // Snapshot was already written successfully; cleanup is best-effort.
  }
  return writtenPath;
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSampleCount(sampleCount: number): number {
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) {
    return 3;
  }

  return Math.max(1, Math.floor(sampleCount));
}

export async function collectMemoryPressureSamples({
  sampleCount = 3,
  intervalMs = 1000,
  signal,
  now = () => new Date(),
  memoryUsage = process.memoryUsage,
  wait = defaultWait,
}: CollectMemoryPressureSamplesOptions = {}): Promise<MemoryPressureSample[]> {
  const count = normalizeSampleCount(sampleCount);
  const samples: MemoryPressureSample[] = [];

  for (let index = 1; index <= count; index++) {
    if (signal?.aborted) {
      break;
    }

    const memory = memoryUsage();
    samples.push({
      index,
      timestamp: now().toISOString(),
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
    });

    if (index < count && !signal?.aborted) {
      await wait(intervalMs);
    }
  }

  return samples;
}

function formatBytes(value: unknown): string {
  // Report binary mebibytes (MiB) because Node/V8 memory APIs return byte
  // counts and binary units avoid ambiguity when comparing heap limits.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'unavailable';
  }

  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function formatActiveCount(value: {
  count: number;
  unavailable: boolean;
}): string {
  return value.unavailable ? 'unavailable' : String(value.count);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return 'unavailable';
  }

  return `${(value * 100).toFixed(1)}%`;
}

type MemoryInsightStatus = 'ok' | 'warn';

interface MemoryInsights {
  status: MemoryInsightStatus;
  heapPressure?: number;
  rssHeapGapBytes?: number;
  signals: string[];
  recommendations: string[];
}

function buildMemoryInsights(diagnostics: MemoryDiagnostics): MemoryInsights {
  const heapPressure = getHeapPressure(diagnostics);
  const heapIsHigh = isHighHeapPressure(diagnostics);
  const rssHeapGapBytes = Math.max(
    0,
    diagnostics.memory.rss - diagnostics.memory.heapTotal,
  );
  const externalAndBuffers =
    diagnostics.memory.external + diagnostics.memory.arrayBuffers;
  const nonHeapGapIsHigh =
    rssHeapGapBytes >= 256 * 1024 * 1024 &&
    diagnostics.memory.rss >= diagnostics.memory.heapTotal * 2;
  const externalMemoryIsHigh =
    externalAndBuffers >= 256 * 1024 * 1024 &&
    externalAndBuffers >= diagnostics.memory.rss * 0.3;

  const signals: string[] = [];
  const recommendations: string[] = [];

  if (diagnostics.v8.unavailable) {
    signals.push(
      'V8 heap statistics are unavailable; heap pressure assessment may be incomplete.',
    );
    recommendations.push(
      'Re-run /doctor memory after restarting Qwen Code; if V8 diagnostics remain unavailable, include this report when filing an issue.',
    );
  }

  if (heapIsHigh) {
    signals.push(
      'V8 heap usage is high; the process is close to its configured heap limit.',
    );
    recommendations.push(
      'If the CLI is sluggish or near OOM, restart Qwen Code to recover memory, then capture a heap snapshot before the next restart to identify retained objects.',
    );
  }

  if (nonHeapGapIsHigh || externalMemoryIsHigh) {
    signals.push(
      'Non-heap memory is high; investigate large tool results, buffers, or native allocations.',
    );
    recommendations.push(
      'Compare RSS against heap usage over time; if RSS grows while heap stays flat, inspect external buffers, tool-result payloads, and native dependencies before increasing the V8 heap limit.',
    );
  }

  if (
    diagnostics.activeHandles.count >= 1000 &&
    !diagnostics.activeHandles.unavailable
  ) {
    signals.push(
      'Active handle count is high; long-lived timers, sockets, or file watchers may be accumulating.',
    );
    recommendations.push(
      'Check recently enabled MCP servers, watchers, or streaming sessions for resources that are not being closed.',
    );
  }

  return {
    status: signals.length > 0 ? 'warn' : 'ok',
    heapPressure,
    rssHeapGapBytes,
    signals,
    recommendations,
  };
}

export function getHeapPressure(
  diagnostics: MemoryDiagnostics,
): number | undefined {
  const heapStatistics = diagnostics.v8.heapStatistics ?? {};
  const heapSizeLimit = asFiniteNumber(heapStatistics['heap_size_limit']);
  return heapSizeLimit !== undefined && heapSizeLimit > 0
    ? diagnostics.memory.heapUsed / heapSizeLimit
    : undefined;
}

export function isHighHeapPressure(diagnostics: MemoryDiagnostics): boolean {
  const heapPressure = getHeapPressure(diagnostics);
  return (
    heapPressure !== undefined && heapPressure >= HIGH_HEAP_PRESSURE_THRESHOLD
  );
}

export function formatMemoryPressureSamples(
  samples: MemoryPressureSample[],
): string {
  const first = samples[0];
  const last = samples.at(-1);
  const rssDelta =
    first && last && samples.length > 1 ? last.rss - first.rss : undefined;
  const heapUsedDelta =
    first && last && samples.length > 1
      ? last.heapUsed - first.heapUsed
      : undefined;
  const sampleLines = samples.map(
    (sample) =>
      `  #${sample.index} ${sample.timestamp}: RSS ${formatBytes(
        sample.rss,
      )}, heap used ${formatBytes(sample.heapUsed)}, external ${formatBytes(
        sample.external,
      )}, array buffers ${formatBytes(sample.arrayBuffers)}`,
  );

  return [
    'Memory pressure samples',
    `  Sample count: ${samples.length}`,
    `  RSS delta: ${formatBytes(rssDelta)}`,
    `  Heap used delta: ${formatBytes(heapUsedDelta)}`,
    ...sampleLines,
  ].join('\n');
}

export function formatMemoryDiagnostics(
  diagnostics: MemoryDiagnostics,
): string {
  const heapStatistics = diagnostics.v8.heapStatistics ?? {};
  const insights = buildMemoryInsights(diagnostics);
  const heapSpaceLines = diagnostics.v8.heapSpaces.map((space) => {
    const name = String(space['space_name'] ?? 'unknown_space');
    return `  - ${name}: ${formatBytes(space['space_used_size'])} / ${formatBytes(
      space['space_size'],
    )}`;
  });

  return [
    'Memory diagnostics',
    `Generated: ${diagnostics.generatedAt}`,
    '',
    'Process',
    `  PID: ${diagnostics.process.pid}`,
    `  Node.js: ${diagnostics.process.nodeVersion}`,
    `  Platform: ${diagnostics.process.platform} ${diagnostics.process.arch}`,
    `  Uptime: ${diagnostics.process.uptimeSeconds.toFixed(1)}s`,
    '',
    'Memory usage',
    `  RSS: ${formatBytes(diagnostics.memory.rss)}`,
    `  Heap used / total: ${formatBytes(
      diagnostics.memory.heapUsed,
    )} / ${formatBytes(diagnostics.memory.heapTotal)}`,
    `  External: ${formatBytes(diagnostics.memory.external)}`,
    `  Array buffers: ${formatBytes(diagnostics.memory.arrayBuffers)}`,
    '',
    'V8 heap',
    `  Heap size limit: ${formatBytes(heapStatistics['heap_size_limit'])}`,
    `  Total available: ${formatBytes(heapStatistics['total_available_size'])}`,
    `  Total heap size executable: ${formatBytes(
      heapStatistics['total_heap_size_executable'],
    )}`,
    `  Used heap size: ${formatBytes(heapStatistics['used_heap_size'])}`,
    '  Heap spaces:',
    ...(heapSpaceLines.length > 0 ? heapSpaceLines : ['  - unavailable']),
    '',
    'Runtime internals',
    `  Active handles: ${formatActiveCount(diagnostics.activeHandles)}`,
    `  Active requests: ${formatActiveCount(diagnostics.activeRequests)}`,
    '',
    'Assessment',
    `  Status: ${insights.status}`,
    `  Heap pressure: ${formatPercent(insights.heapPressure)}`,
    `  RSS / heap-total gap: ${formatBytes(insights.rssHeapGapBytes)}`,
    '  Signals:',
    ...(insights.signals.length > 0
      ? insights.signals.map((signal) => `  - ${signal}`)
      : ['  - No immediate memory pressure signals detected.']),
    '  Recommendations:',
    ...(insights.recommendations.length > 0
      ? insights.recommendations.map(
          (recommendation) => `  - ${recommendation}`,
        )
      : [
          '  - Re-run /doctor memory when memory grows, before restarting, to compare snapshots.',
        ]),
  ].join('\n');
}
