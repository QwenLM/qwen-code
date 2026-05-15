/**
 * @license
 * Copyright 2025 Qwen
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

export function formatMemoryDiagnostics(
  diagnostics: MemoryDiagnostics,
): string {
  const heapStatistics = diagnostics.v8.heapStatistics ?? {};
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
  ].join('\n');
}
