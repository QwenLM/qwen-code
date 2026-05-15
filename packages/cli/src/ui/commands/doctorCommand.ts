/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import type { HistoryItemDoctor, HistoryItemInfo } from '../types.js';
import { runDoctorChecks } from '../../utils/doctorChecks.js';
import {
  formatMemoryDiagnostics,
  getMemoryDiagnostics,
} from '../../utils/memoryDiagnostics.js';
import { t } from '../../i18n/index.js';

export const doctorCommand: SlashCommand = {
  name: 'doctor',
  get description() {
    return t('Run installation and environment diagnostics');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  argumentHint: '[memory]',
  examples: ['/doctor', '/doctor memory'],
  completion: async (_context, partialArg) => {
    const candidates = ['memory'];
    const trimmed = partialArg.trimStart();
    return candidates.filter((candidate) => candidate.startsWith(trimmed));
  },
  action: async (context, args) => {
    const executionMode = context.executionMode ?? 'interactive';
    const abortSignal = context.abortSignal;
    const subCommand = args.trim().toLowerCase();

    if (subCommand === 'memory') {
      const report = formatMemoryDiagnostics(getMemoryDiagnostics());

      if (executionMode === 'interactive') {
        const memoryItem: Omit<HistoryItemInfo, 'id'> = {
          type: 'info',
          text: report,
        };
        context.ui.addItem(memoryItem, Date.now());
        return;
      }

      return {
        type: 'message' as const,
        messageType: 'info' as const,
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
