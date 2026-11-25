/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BUN_CPU_PROFILING_UNSUPPORTED_MESSAGE,
  formatLightweightProfileSample,
  getErrorMessage,
  getOrInitRuntimeProfiler,
  isRunningWithBun,
  parseProfileLogIntervalMs,
  type RuntimeProfiler,
} from '@qwen-code/core';
import { CommandKind, type SlashCommand } from './types.js';

const NODE_PROFILE_USAGE =
  'Usage: /profile [cpu [start|stop]|snapshot|heap-alloc start|heap-alloc stop|status]';
const BUN_PROFILE_USAGE = 'Usage: /profile [snapshot|status]';
const BUN_UNSUPPORTED_STATUS = 'unsupported under Bun';

export const profileCommand: SlashCommand = {
  name: 'profile',
  kind: CommandKind.BUILT_IN,
  isSafeConcurrent: true,
  description: `Inspect or control runtime profiling. ${getProfileUsage()}`,
  autoExecute: true,
  action: async (context) => {
    const args = context.invocation?.args?.trim();

    if (!args) {
      return msg('info', getProfileUsage());
    }

    const profiler = getOrInitRuntimeProfiler();

    try {
      switch (args) {
        case 'cpu': {
          if (
            profiler.isCpuProfilingActive() ||
            profiler.hasPendingCpuProfile()
          ) {
            return await stopCpuProfiling(profiler);
          }

          return await startCpuProfiling(profiler);
        }

        case 'cpu start': {
          return await startCpuProfiling(profiler);
        }

        case 'cpu stop': {
          if (
            !profiler.isCpuProfilingActive() &&
            !profiler.hasPendingCpuProfile()
          ) {
            return msg('warning', 'CPU profiling is not active.');
          }
          return await stopCpuProfiling(profiler);
        }

        case 'snapshot':
        case 'heap': {
          const result = await profiler.takeHeapSnapshot();
          return msg(
            'info',
            `Encrypted heap snapshot saved: ${result.filePath}`,
          );
        }

        case 'heap-alloc start': {
          if (profiler.hasPendingHeapAllocationProfile()) {
            return msg(
              'warning',
              'A stopped heap allocation profile is pending save. Use /profile heap-alloc stop to retry saving it first.',
            );
          }
          if (profiler.isHeapAllocationProfilingActive()) {
            return msg(
              'warning',
              'Heap allocation profiling is already active.',
            );
          }
          await profiler.startHeapAllocationProfiling();
          return msg('info', 'Heap allocation profiling started.');
        }

        case 'heap-alloc stop': {
          if (
            !profiler.isHeapAllocationProfilingActive() &&
            !profiler.hasPendingHeapAllocationProfile()
          ) {
            return msg(
              'warning',
              'Heap allocation profiling is not active.',
            );
          }
          const result = await profiler.stopHeapAllocationProfiling();
          return msg(
            'info',
            `Encrypted heap allocation profile saved: ${result.filePath} (${result.durationMs}ms)`,
          );
        }

        // log start/stop/once: still accepted for backward compat but
        // intentionally hidden from usage strings.
        case 'log stop': {
          if (!profiler.isLightweightLoggingActive()) {
            return msg('warning', 'Lightweight profile logging is not active.');
          }
          profiler.stopLightweightLogging();
          return msg('info', 'Lightweight profile logging stopped.');
        }

        case 'log once': {
          const sample = profiler.recordLightweightSample('manual');
          return msg(
            'info',
            `Lightweight profile sample logged:\n${formatLightweightProfileSample(sample)}`,
          );
        }

        case 'status': {
          const bun = isRunningWithBun();
          const lightweightStatus = profiler.isLightweightLoggingActive()
            ? `active (${profiler.getLightweightLogIntervalMs()}ms)`
            : `inactive (default ${profiler.getLightweightLogIntervalMs()}ms)`;
          const cpuProfilingStatus = bun
            ? BUN_UNSUPPORTED_STATUS
            : formatProfilingState(
                profiler.isCpuProfilingActive(),
                profiler.hasPendingCpuProfile(),
              );
          const heapAllocationProfilingStatus = bun
            ? BUN_UNSUPPORTED_STATUS
            : formatProfilingState(
                profiler.isHeapAllocationProfilingActive(),
                profiler.hasPendingHeapAllocationProfile(),
              );
          return msg(
            'info',
            [
              `Runtime: ${bun ? 'Bun (JSC)' : 'Node.js (V8)'}`,
              `Lightweight log: ${lightweightStatus}`,
              `CPU profiling: ${cpuProfilingStatus}`,
              `Heap allocation profiling: ${heapAllocationProfilingStatus}`,
              `Heap snapshot: ${bun ? 'via Bun.generateHeapSnapshot()' : 'via V8 Inspector'}`,
              `Output dir: ${profiler.getOutputDir()}`,
            ].join('\n'),
          );
        }

        default:
          if (args.startsWith('log start')) {
            const rawInterval = args.slice('log start'.length).trim();
            profiler.startLightweightLogging(
              parseProfileLogIntervalMs(rawInterval || undefined),
            );
            return msg(
              'info',
              `Lightweight profile logging started (${profiler.getLightweightLogIntervalMs()}ms).`,
            );
          }

          return msg('error', getProfileUsage());
      }
    } catch (err) {
      return msg('error', `Profile error: ${getErrorMessage(err)}`);
    }
  },
};

function msg(messageType: 'info' | 'warning' | 'error', content: string) {
  return { type: 'message' as const, messageType, content };
}

function getProfileUsage(): string {
  return isRunningWithBun() ? BUN_PROFILE_USAGE : NODE_PROFILE_USAGE;
}

async function startCpuProfiling(profiler: RuntimeProfiler) {
  if (profiler.hasPendingCpuProfile()) {
    return msg(
      'warning',
      'A stopped CPU profile is pending save. Use /profile cpu stop to retry saving it first.',
    );
  }
  if (profiler.isCpuProfilingActive()) {
    return msg('warning', 'CPU profiling is already active.');
  }
  if (isRunningWithBun()) {
    return msg('warning', BUN_CPU_PROFILING_UNSUPPORTED_MESSAGE);
  }
  await profiler.startCpuProfiling();
  return msg('info', 'CPU profiling started.');
}

async function stopCpuProfiling(profiler: RuntimeProfiler) {
  const result = await profiler.stopCpuProfiling();
  return msg(
    'info',
    `Encrypted CPU profile saved: ${result.filePath} (${result.durationMs}ms)`,
  );
}

function formatProfilingState(active: boolean, pendingSave: boolean): string {
  if (active) {
    return 'active';
  }
  if (pendingSave) {
    return 'pending save';
  }
  return 'inactive';
}
