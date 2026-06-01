/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext, SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import type { HistoryItemDoctor } from '../types.js';
import { runDoctorChecks } from '../../utils/doctorChecks.js';
import {
  collectMemoryPressureSamples,
  formatMemoryDiagnostics,
  formatMemoryPressureSamples,
  getMemoryDiagnostics,
  isHighHeapPressure,
  writeMemoryHeapSnapshot,
} from '../../utils/memoryDiagnostics.js';
import {
  isCpuProfileRecording,
  startCpuProfile,
  stopCpuProfile,
} from '../../utils/cpuProfiler.js';
import { t } from '../../i18n/index.js';
import {
  collectMemoryDiagnostics,
  type MemoryDiagnostics,
} from '@qwen-code/qwen-code-core';
import { formatMemoryUsage } from '../utils/formatters.js';

const MEMORY_SUBCOMMAND = 'memory';
const CPU_PROFILE_SUBCOMMAND = 'cpu-profile';
const DOCTOR_SUBCOMMANDS = [MEMORY_SUBCOMMAND, CPU_PROFILE_SUBCOMMAND] as const;
function getHeapSnapshotSensitiveDataWarning(): string {
  return t(
    'Heap snapshot may contain prompts, file contents, tool results, and other sensitive data. Do not share it publicly without reviewing it first.',
  );
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatHeapSnapshotErrorMessage(error: unknown): string {
  const message = formatErrorMessage(error);
  return message.startsWith('Heap snapshot')
    ? message
    : `${t('Heap snapshot failed:')} ${message}`;
}

export const doctorCommand: SlashCommand = {
  name: 'doctor',
  get description() {
    return t('Run installation and environment diagnostics');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  argumentHint: '[memory|cpu-profile] [--sample] [--snapshot] [--duration]',
  examples: [
    '/doctor',
    '/doctor memory',
    '/doctor memory --sample',
    '/doctor memory --snapshot',
    '/doctor cpu-profile',
    '/doctor cpu-profile --duration 10',
  ],
  completion: async (_context, partialArg) => {
    const trimmed = partialArg.trimStart();
    return DOCTOR_SUBCOMMANDS.filter((candidate) =>
      candidate.startsWith(trimmed),
    );
  },
  action: async (context, args) => {
    const executionMode = context.executionMode ?? 'interactive';
    const abortSignal = context.abortSignal;
    const subCommandArgs =
      args?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const subCommand = subCommandArgs[0] ?? '';
    const shouldWriteHeapSnapshot = subCommandArgs.includes('--snapshot');
    const shouldSampleMemory = subCommandArgs.includes('--sample');

    if (subCommand === MEMORY_SUBCOMMAND) {
      if (abortSignal?.aborted) {
        return;
      }

      const diagnostics = getMemoryDiagnostics();

      if (abortSignal?.aborted) {
        return;
      }

      let report = formatMemoryDiagnostics(diagnostics);
      let messageType: 'info' | 'error' = 'info';
      let heapSnapshotWritten = false;

      if (abortSignal?.aborted) {
        return;
      }

      if (shouldSampleMemory) {
        const samples = await collectMemoryPressureSamples({
          sampleCount: 3,
          intervalMs: 1000,
          signal: abortSignal,
        });
        report = `${report}\n\n${formatMemoryPressureSamples(samples)}`;

        if (abortSignal?.aborted) {
          if (executionMode === 'interactive') {
            context.ui.addItem(
              {
                type: 'info',
                text: report,
              },
              Date.now(),
            );
            return;
          }

          return {
            type: 'message' as const,
            messageType: 'info' as const,
            content: report,
          };
        }
      }

      if (shouldWriteHeapSnapshot) {
        if (abortSignal?.aborted) {
          return;
        }

        if (executionMode === 'interactive') {
          context.ui.setPendingItem({
            type: 'info',
            text: t('Writing heap snapshot, this may take a moment...'),
          });
        }

        try {
          const latestDiagnostics = shouldSampleMemory
            ? getMemoryDiagnostics()
            : diagnostics;
          if (isHighHeapPressure(latestDiagnostics)) {
            throw new Error(
              t(
                'Heap snapshot skipped: V8 heap pressure is already high, and writing a synchronous heap snapshot could make the process unresponsive or trigger OOM. Restart Qwen Code first if it is unstable, or retry before memory pressure reaches the warning threshold.',
              ),
            );
          }

          const heapSnapshotPath = writeMemoryHeapSnapshot();
          heapSnapshotWritten = true;
          report = `${report}\n\n${t('Heap snapshot written:')} ${heapSnapshotPath}\n${getHeapSnapshotSensitiveDataWarning()}`;
        } catch (error) {
          messageType = 'error';
          report = `${report}\n\n${formatHeapSnapshotErrorMessage(error)}`;
        } finally {
          if (executionMode === 'interactive') {
            context.ui.setPendingItem(null);
          }
        }
      }

      if (
        abortSignal?.aborted &&
        shouldWriteHeapSnapshot &&
        !heapSnapshotWritten
      ) {
        return;
      }

      if (executionMode === 'interactive') {
        context.ui.addItem(
          {
            type: messageType === 'error' ? 'error' : 'info',
            text: report,
          },
          Date.now(),
        );
        return;
      }

      return {
        type: 'message' as const,
        messageType,
        content: report,
      };
    }

    if (subCommand === CPU_PROFILE_SUBCOMMAND) {
      return cpuProfileDoctorAction(context, subCommandArgs.slice(1).join(' '));
    }

    if (executionMode === 'interactive') {
      context.ui.setPendingItem({
        type: 'info',
        text: t('Running diagnostics...'),
      });
    }

    try {
      const checks = await runDoctorChecks(context);

      if (abortSignal?.aborted) {
        return;
      }

      const summary = {
        pass: checks.filter((c) => c.status === 'pass').length,
        warn: checks.filter((c) => c.status === 'warn').length,
        fail: checks.filter((c) => c.status === 'fail').length,
      };

      if (executionMode === 'interactive') {
        const doctorItem: Omit<HistoryItemDoctor, 'id'> = {
          type: 'doctor',
          checks,
          summary,
        };
        context.ui.addItem(doctorItem, Date.now());
        return;
      }

      return {
        type: 'message' as const,
        messageType: (summary.fail > 0 ? 'error' : 'info') as 'error' | 'info',
        content: JSON.stringify({ checks, summary }, null, 2),
      };
    } finally {
      if (executionMode === 'interactive') {
        context.ui.setPendingItem(null);
      }
    }
  },
  subCommands: [
    {
      name: 'memory',
      get description() {
        return t('Show current process memory diagnostics');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      argumentHint: '[--json] [--sample] [--snapshot]',
      action: memoryDoctorAction,
    },
    {
      name: 'cpu-profile',
      get description() {
        return t('Record a CPU profile for Chrome DevTools analysis');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      argumentHint: '[--duration <seconds>]',
      action: cpuProfileDoctorAction,
    },
  ],
};

const MEMORY_USAGE_HINT = '/doctor memory [--json] [--sample] [--snapshot]';

async function memoryDoctorAction(context: CommandContext, args = '') {
  if (context.abortSignal?.aborted) {
    return;
  }

  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const unknown = tokens.filter(
    (token) =>
      token !== '--json' && token !== '--sample' && token !== '--snapshot',
  );
  if (unknown.length > 0) {
    return {
      type: 'message' as const,
      messageType: 'error' as const,
      content: `${t('Unknown argument(s)')}: ${unknown.join(', ')}. ${t('Usage')}: ${MEMORY_USAGE_HINT}`,
    };
  }

  const shouldSampleMemory = tokens.includes('--sample');
  const shouldWriteHeapSnapshot = tokens.includes('--snapshot');
  if (shouldSampleMemory || shouldWriteHeapSnapshot) {
    return doctorCommand.action?.(
      context,
      [MEMORY_SUBCOMMAND, ...tokens.filter((token) => token !== '--json')].join(
        ' ',
      ),
    );
  }

  try {
    const diagnostics = await collectMemoryDiagnostics({
      sessionId: context.services.config?.getSessionId(),
      qwenVersion: context.services.config?.getCliVersion(),
    });

    if (context.abortSignal?.aborted) {
      return;
    }

    return {
      type: 'message' as const,
      messageType:
        diagnostics.analysis.risks.length > 0
          ? ('warning' as const)
          : ('info' as const),
      content: tokens.includes('--json')
        ? JSON.stringify(diagnostics, null, 2)
        : formatCoreDiagnostics(diagnostics),
    };
  } catch (error) {
    if (context.abortSignal?.aborted) {
      return;
    }

    return {
      type: 'message' as const,
      messageType: 'error' as const,
      content: `${t('Failed to collect memory diagnostics')}: ${formatErrorMessage(error)}`,
    };
  }
}

// resourceUsage CPU times are microseconds; convert to seconds for display.
function formatCpuMicroseconds(micros: number): string {
  return `${(micros / 1_000_000).toFixed(2)}s`;
}

function formatHeapSpaces(
  spaces: MemoryDiagnostics['v8HeapSpaces'],
): string | undefined {
  if (!spaces || spaces.length === 0) {
    return undefined;
  }
  const top = [...spaces].sort((a, b) => b.used - a.used).slice(0, 4);
  const lines = top.map(
    (space) =>
      `  - ${space.name}: used ${formatMemoryUsage(space.used)} / size ${formatMemoryUsage(space.size)}`,
  );
  if (spaces.length > top.length) {
    lines.push(`  - … ${spaces.length - top.length} more`);
  }
  return lines.join('\n');
}

function formatSmapsRollup(smapsRollup: string | null): string {
  if (!smapsRollup) {
    return t('unavailable');
  }

  const rssLine = smapsRollup
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .find((line) => line.startsWith('Rss:'));
  if (rssLine) {
    return rssLine;
  }

  const preview = smapsRollup.slice(0, 80).trim().replace(/\s+/g, ' ');
  return `${t('parse error')}: ${preview}`;
}

function formatCoreDiagnostics(diagnostics: MemoryDiagnostics): string {
  const risks =
    diagnostics.analysis.risks.length > 0
      ? diagnostics.analysis.risks
          .map((risk) => `  - ${risk.type}: ${risk.message}`)
          .join('\n')
      : `  ${t('none')}`;

  const lines: string[] = [
    t('Memory Diagnostics'),
    `timestamp: ${diagnostics.timestamp}`,
    `uptimeSeconds: ${diagnostics.uptimeSeconds.toFixed(1)}`,
    `heapUsed: ${formatMemoryUsage(diagnostics.memoryUsage.heapUsed)}`,
    `heapTotal: ${formatMemoryUsage(diagnostics.memoryUsage.heapTotal)}`,
    `rss: ${formatMemoryUsage(diagnostics.memoryUsage.rss)}`,
    `external: ${formatMemoryUsage(diagnostics.memoryUsage.external)}`,
    `arrayBuffers: ${formatMemoryUsage(diagnostics.memoryUsage.arrayBuffers)}`,
    `v8HeapLimit: ${formatMemoryUsage(diagnostics.v8HeapStats.heapSizeLimit)}`,
    `v8MallocedMemory: ${formatMemoryUsage(diagnostics.v8HeapStats.mallocedMemory)}`,
    `v8PeakMallocedMemory: ${formatMemoryUsage(diagnostics.v8HeapStats.peakMallocedMemory)}`,
    `detachedContexts: ${diagnostics.v8HeapStats.detachedContexts}`,
    `nativeContexts: ${diagnostics.v8HeapStats.nativeContexts}`,
    `maxRSS: ${formatMemoryUsage(diagnostics.resourceUsage.maxRSS)}`,
    `userCPUTime: ${formatCpuMicroseconds(diagnostics.resourceUsage.userCPUTime)}`,
    `systemCPUTime: ${formatCpuMicroseconds(diagnostics.resourceUsage.systemCPUTime)}`,
    `activeHandles: ${diagnostics.activeHandles}`,
    `activeRequests: ${diagnostics.activeRequests}`,
    `openFileDescriptors: ${diagnostics.openFileDescriptors ?? t('unavailable')}`,
    `smapsRollup: ${formatSmapsRollup(diagnostics.smapsRollup)}`,
  ];

  const heapSpaces = formatHeapSpaces(diagnostics.v8HeapSpaces);
  if (heapSpaces) {
    lines.push('v8HeapSpaces:', heapSpaces);
  }

  lines.push(
    'risks:',
    risks,
    `recommendation: ${diagnostics.analysis.recommendation}`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// /doctor cpu-profile
// ---------------------------------------------------------------------------

const CPU_PROFILE_USAGE_HINT = '/doctor cpu-profile [--duration <seconds>]';
const DEFAULT_CPU_PROFILE_DURATION_SEC = 30;
const MAX_CPU_PROFILE_DURATION_SEC = 300;

async function cpuProfileDoctorAction(
  context: CommandContext,
  args = '',
): Promise<void | {
  type: 'message';
  messageType: 'info' | 'error';
  content: string;
}> {
  const executionMode = context.executionMode ?? 'interactive';
  const abortSignal = context.abortSignal;

  if (abortSignal?.aborted) return;

  const tokens = args.trim().split(/\s+/).filter(Boolean);

  // Parse --duration flag
  let durationSec = DEFAULT_CPU_PROFILE_DURATION_SEC;
  const durationIdx = tokens.indexOf('--duration');
  if (durationIdx !== -1) {
    const rawVal = tokens[durationIdx + 1];
    const val = rawVal ? parseInt(rawVal, 10) : NaN;
    if (
      !Number.isFinite(val) ||
      val < 1 ||
      val > MAX_CPU_PROFILE_DURATION_SEC
    ) {
      const errorMsg = `${t('Duration must be between 1 and {max} seconds', { max: String(MAX_CPU_PROFILE_DURATION_SEC) })}. ${t('Usage')}: ${CPU_PROFILE_USAGE_HINT}`;
      if (executionMode === 'interactive') {
        context.ui.addItem({ type: 'error', text: errorMsg }, Date.now());
        return;
      }
      return { type: 'message', messageType: 'error', content: errorMsg };
    }
    durationSec = val;
  }

  // Validate unknown arguments
  const knownTokens = new Set(['--duration']);
  const unknown = tokens.filter((token, idx) => {
    if (knownTokens.has(token)) return false;
    // Skip the value after --duration
    if (idx > 0 && tokens[idx - 1] === '--duration') return false;
    return true;
  });
  if (unknown.length > 0) {
    const errorMsg = `${t('Unknown argument(s)')}: ${unknown.join(', ')}. ${t('Usage')}: ${CPU_PROFILE_USAGE_HINT}`;
    if (executionMode === 'interactive') {
      context.ui.addItem({ type: 'error', text: errorMsg }, Date.now());
      return;
    }
    return { type: 'message', messageType: 'error', content: errorMsg };
  }

  // Check if already recording
  if (isCpuProfileRecording()) {
    const errorMsg =
      process.platform === 'win32'
        ? t('CPU profiling is already in progress. Wait for it to complete.')
        : t(
            'CPU profiling is already in progress. Send SIGUSR1 or wait for it to complete.',
          );
    if (executionMode === 'interactive') {
      context.ui.addItem({ type: 'error', text: errorMsg }, Date.now());
      return;
    }
    return { type: 'message', messageType: 'error', content: errorMsg };
  }

  // Start recording
  const startResult = await startCpuProfile();
  if (!startResult.ok) {
    if (executionMode === 'interactive') {
      context.ui.addItem(
        { type: 'error', text: startResult.error },
        Date.now(),
      );
      return;
    }
    return {
      type: 'message',
      messageType: 'error',
      content: startResult.error,
    };
  }

  if (abortSignal?.aborted) {
    const abortResult = await stopCpuProfile();
    if (abortResult.ok) {
      const msg = t('CPU profile aborted early. Profile saved: {path}', {
        path: abortResult.filePath,
      });
      if (executionMode === 'interactive') {
        context.ui.addItem({ type: 'info', text: msg }, Date.now());
      }
    } else {
      const msg = `${t('CPU profile aborted but failed to stop cleanly')}: ${abortResult.error}`;
      if (executionMode === 'interactive') {
        context.ui.addItem({ type: 'error', text: msg }, Date.now());
      }
    }
    return;
  }

  // Show progress in interactive mode
  if (executionMode === 'interactive') {
    context.ui.setPendingItem({
      type: 'info',
      text: t('Recording CPU profile for {duration}s...', {
        duration: String(durationSec),
      }),
    });
  }

  // Wait for duration or abort. Timer is NOT unref'd so non-interactive
  // mode keeps the process alive for the full recording window.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, durationSec * 1000);
    if (abortSignal) {
      abortSignal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }
  });

  if (executionMode === 'interactive') {
    context.ui.setPendingItem(null);
  }

  // Stop and write profile. If profiler is no longer recording (e.g., SIGUSR1
  // stopped it during the wait), treat as success — the profile was already written.
  const stopResult = await stopCpuProfile();
  if (!stopResult.ok) {
    const alreadyStopped = stopResult.error.includes('not recording');
    if (alreadyStopped) {
      const infoMsg =
        process.platform === 'win32'
          ? t(
              'CPU profile was stopped externally. Check ~/.qwen/cpu-profiles/ for the output.',
            )
          : t(
              'CPU profile was stopped externally (e.g., via SIGUSR1). Check ~/.qwen/cpu-profiles/ for the output.',
            );
      if (executionMode === 'interactive') {
        context.ui.addItem({ type: 'info', text: infoMsg }, Date.now());
        return;
      }
      return { type: 'message', messageType: 'info', content: infoMsg };
    }
    if (executionMode === 'interactive') {
      context.ui.addItem({ type: 'error', text: stopResult.error }, Date.now());
      return;
    }
    return { type: 'message', messageType: 'error', content: stopResult.error };
  }

  const successMsg = `${t('CPU profile written:')} ${stopResult.filePath}\n${t('Open in Chrome DevTools → Performance tab → Load profile')}`;
  if (executionMode === 'interactive') {
    context.ui.addItem({ type: 'info', text: successMsg }, Date.now());
    return;
  }
  return { type: 'message', messageType: 'info', content: successMsg };
}
