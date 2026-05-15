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
  writeMemoryHeapSnapshot,
} from '../../utils/memoryDiagnostics.js';
import { t } from '../../i18n/index.js';

const MEMORY_SUBCOMMAND = 'memory';
const DOCTOR_SUBCOMMANDS = [MEMORY_SUBCOMMAND] as const;
const HEAP_SNAPSHOT_SENSITIVE_DATA_WARNING =
  'Heap snapshot may contain prompts, file contents, tool results, and other sensitive data. Do not share it publicly without reviewing it first.';

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

      if (abortSignal?.aborted) {
        return;
      }

      if (shouldSampleMemory) {
        const samples = await collectMemoryPressureSamples({
          sampleCount: 3,
          intervalMs: 1000,
        });

        if (abortSignal?.aborted) {
          return;
        }

        report = `${report}\n\n${formatMemoryPressureSamples(samples)}`;
      }

      if (shouldWriteHeapSnapshot) {
        try {
          const heapSnapshotPath = writeMemoryHeapSnapshot();
          report = `${report}\n\nHeap snapshot written: ${heapSnapshotPath}\n${HEAP_SNAPSHOT_SENSITIVE_DATA_WARNING}`;
        } catch (error) {
          messageType = 'error';
          report = `${report}\n\nHeap snapshot failed: ${formatErrorMessage(error)}`;
        }
      }

      if (abortSignal?.aborted) {
        return;
      }

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
