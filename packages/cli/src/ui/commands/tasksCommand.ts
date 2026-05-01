/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildBackgroundEntryLabel,
  type BackgroundShellEntry,
  type BackgroundTaskEntry,
} from '@qwen-code/qwen-code-core';
import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { formatDuration } from '../utils/formatters.js';

type AgentTaskEntry = BackgroundTaskEntry & {
  kind: 'agent';
  resumeBlockedReason?: string;
};

type ShellTaskEntry = BackgroundShellEntry & { kind: 'shell' };

type TaskEntry = AgentTaskEntry | ShellTaskEntry;

function statusLabel(entry: TaskEntry): string {
  if (entry.kind === 'agent') {
    switch (entry.status) {
      case 'completed':
        return 'completed';
      case 'failed':
        return `failed: ${entry.error ?? 'unknown error'}`;
      case 'cancelled':
        return 'cancelled';
      case 'paused':
        return entry.resumeBlockedReason
          ? `paused (resume blocked): ${entry.resumeBlockedReason}`
          : 'paused';
      case 'running':
      default:
        return 'running';
    }
  }

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
      return 'running';
  }
}

function taskLabel(entry: TaskEntry): string {
  if (entry.kind === 'agent') {
    return buildBackgroundEntryLabel(entry);
  }
  return entry.command;
}

function taskId(entry: TaskEntry): string {
  return entry.kind === 'agent' ? entry.agentId : entry.shellId;
}

function taskOutputPath(entry: TaskEntry): string | undefined {
  return entry.kind === 'agent' ? entry.outputFile : entry.outputPath;
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

    const agentEntries: AgentTaskEntry[] = config
      .getBackgroundTaskRegistry()
      .getAll()
      .map((entry) => ({ ...entry, kind: 'agent' as const }));
    const shellEntries: ShellTaskEntry[] = config
      .getBackgroundShellRegistry()
      .getAll()
      .map((entry) => ({ ...entry, kind: 'shell' as const }));
    const entries = [...agentEntries, ...shellEntries].sort(
      (a, b) => a.startTime - b.startTime,
    );

    if (entries.length === 0) {
      return {
        type: 'message' as const,
        messageType: 'info' as const,
        content: 'No background tasks.',
      };
    }

    const now = Date.now();
    const lines: string[] = [`Background tasks (${entries.length} total)`, ''];
    for (const entry of entries) {
      const endTime = entry.endTime ?? now;
      const runtime = formatDuration(endTime - entry.startTime, {
        hideTrailingZeros: true,
      });
      const pidPart =
        entry.kind === 'shell' && entry.pid !== undefined
          ? ` pid=${entry.pid}`
          : '';
      lines.push(
        `[${taskId(entry)}] ${statusLabel(entry)}  ${runtime}${pidPart}  ${taskLabel(entry)}`,
      );
      const outputPath = taskOutputPath(entry);
      if (outputPath) {
        lines.push(`            output: ${outputPath}`);
      }
    }

    return {
      type: 'message' as const,
      messageType: 'info' as const,
      content: lines.join('\n'),
    };
  },
};
