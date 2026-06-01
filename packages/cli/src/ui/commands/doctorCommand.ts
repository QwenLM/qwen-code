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
import { rollbackStandaloneUpdate } from '../../utils/standalone-update.js';
import { getInstallationInfo } from '../../utils/installationInfo.js';
import { t } from '../../i18n/index.js';
import {
  collectMemoryDiagnostics,
  type MemoryDiagnostics,
} from '@qwen-code/qwen-code-core';
import { formatMemoryUsage } from '../utils/formatters.js';

const MEMORY_SUBCOMMAND = 'memory';
const ROLLBACK_SUBCOMMAND = 'rollback';
const DOCTOR_SUBCOMMANDS = [MEMORY_SUBCOMMAND, ROLLBACK_SUBCOMMAND] as const;
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
  argumentHint: '[memory|rollback] [--sample] [--snapshot]',
  examples: [
    '/doctor',
    '/doctor memory',
    '/doctor memory --sample',
    '/doctor memory --snapshot',
    '/doctor rollback',
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

    if (subCommand === ROLLBACK_SUBCOMMAND) {
      if (executionMode === 'acp') {
        return {
          type: 'message' as const,
          messageType: 'error' as const,
          content: t('Rollback is not available in ACP mode.'),
        };
      }
      return rollbackDoctorAction(context);
    }

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
      name: 'rollback',
      get description() {
        return t('Roll back a standalone update to the previous version');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive'] as const,
      action: rollbackDoctorAction,
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

function rollbackDoctorAction(context: CommandContext) {
  const installInfo = getInstallationInfo(process.cwd(), false);
  if (!installInfo.isStandalone || !installInfo.standaloneDir) {
    const msg = t('Rollback is only available for standalone installations.');
    if (context.executionMode === 'interactive') {
      context.ui.addItem({ type: 'info', text: msg }, Date.now());
      return;
    }
    return {
      type: 'message' as const,
      messageType: 'info' as const,
      content: msg,
    };
  }

  if (process.platform === 'win32') {
    const winMsg = t(
      'Rollback on Windows requires manual intervention. Rename qwen-code.old to qwen-code in your installation directory.',
    );
    if (context.executionMode === 'interactive') {
      context.ui.addItem({ type: 'info', text: winMsg }, Date.now());
      return;
    }
    return {
      type: 'message' as const,
      messageType: 'info' as const,
      content: winMsg,
    };
  }

  const result = rollbackStandaloneUpdate(installInfo.standaloneDir);
  let msg: string;
  let messageType: 'info' | 'error';
  if (result.ok) {
    msg = t(
      'Rollback successful. Restart your terminal to use the previous version.',
    );
    messageType = 'info';
  } else {
    msg = t(`Rollback failed: ${result.detail}`);
    messageType = 'error';
  }

  if (context.executionMode === 'interactive') {
    context.ui.addItem({ type: messageType, text: msg }, Date.now());
    return;
  }
  return {
    type: 'message' as const,
    messageType: messageType as 'info' | 'error',
    content: msg,
  };
}
