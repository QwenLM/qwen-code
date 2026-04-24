/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import type { HistoryItemDoctor } from '../types.js';
import { runDoctorChecks } from '../../utils/doctorChecks.js';
import { t } from '../../i18n/index.js';

export const doctorCommand: SlashCommand = {
  name: 'doctor',
  get description() {
    return t('Run installation and environment diagnostics');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context) => {
    const executionMode = context.executionMode ?? 'interactive';
    const abortSignal = context.abortSignal;

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
