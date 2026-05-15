/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as v8 from 'node:v8';

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
  const getter = (process as unknown as Record<string, unknown>)[name];
  if (typeof getter !== 'function') {
    return { count: 0, unavailable: true };
  }

  try {
    const entries = (getter as () => unknown[])();
    return {
      count: Array.isArray(entries) ? entries.length : 0,
      unavailable: false,
    };
  } catch {
    return { count: 0, unavailable: true };
  }
}

export function getMemoryDiagnostics(): MemoryDiagnostics {
  let heapStatistics: Record<string, number> | undefined;
  let heapSpaces: Array<Record<string, number | string>> = [];
  let v8Unavailable = false;

  try {
    heapStatistics = v8.getHeapStatistics() as unknown as Record<
      string,
      number
    >;
    heapSpaces = v8.getHeapSpaceStatistics() as unknown as Array<
      Record<string, number | string>
    >;
  } catch {
    v8Unavailable = true;
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
      unavailable: v8Unavailable,
    },
    activeHandles: countProcessInternals('_getActiveHandles'),
    activeRequests: countProcessInternals('_getActiveRequests'),
  };
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
  const heapStatistics = diagnostics.v8.heapStatistics ?? {};
  const heapSizeLimit = asFiniteNumber(heapStatistics['heap_size_limit']);
  const heapPressure =
    heapSizeLimit !== undefined && heapSizeLimit > 0
      ? diagnostics.memory.heapUsed / heapSizeLimit
      : undefined;
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
  const heapIsHigh = heapPressure !== undefined && heapPressure >= 0.85;

  const signals: string[] = [];
  const recommendations: string[] = [];

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
