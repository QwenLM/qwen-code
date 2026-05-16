/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from './types.js';
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
import { t } from '../../i18n/index.js';

const MEMORY_SUBCOMMAND = 'memory';
const DOCTOR_SUBCOMMANDS = [MEMORY_SUBCOMMAND] as const;
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
  argumentHint: '[memory] [--sample] [--snapshot]',
  examples: [
    '/doctor',
    '/doctor memory',
    '/doctor memory --sample',
    '/doctor memory --snapshot',
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
};
