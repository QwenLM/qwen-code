/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BackgroundShellEntry } from '@qwen-code/qwen-code-core';
import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { formatDuration } from '../utils/formatters.js';

function statusLabel(entry: BackgroundShellEntry): string {
  switch (entry.status) {
    case 'completed':
      return `completed (exit ${entry.exitCode ?? '?'})`;
    case 'failed':
      return `failed: ${entry.error ?? 'unknown error'}`;
    case 'cancelled':
      return 'cancelled';
    case 'running':
      return 'running';
    default:
      return entry.status;
  }
}

export const tasksCommand: SlashCommand = {
  name: 'tasks',
  get description() {
    return t('List background tasks');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context) => {
    const { config } = context.services;
    if (!config) {
      return {
        type: 'message' as const,
        messageType: 'error' as const,
        content: 'Config not available.',
      };
    }

    const entries = config.getBackgroundShellRegistry().getAll();

    if (entries.length === 0) {
      return {
        type: 'message' as const,
        messageType: 'info' as const,
        content: 'No background shells.',
      };
    }

    const now = Date.now();
    const lines: string[] = [
      `Background shells (${entries.length} total)`,
      '',
    ];
    for (const entry of entries) {
      const endTime = entry.endTime ?? now;
      const runtime = formatDuration(endTime - entry.startTime, {
        hideTrailingZeros: true,
      });
      const pidPart = entry.pid !== undefined ? ` pid=${entry.pid}` : '';
      lines.push(
        `[${entry.shellId}] ${statusLabel(entry)}  ${runtime}${pidPart}  ${entry.command}`,
      );
      lines.push(`            output: ${entry.outputPath}`);
    }

    return {
      type: 'message' as const,
      messageType: 'info' as const,
      content: lines.join('\n'),
    };
  },
};
