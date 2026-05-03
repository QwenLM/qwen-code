/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildBackgroundEntryLabel,
  type BackgroundShellEntry,
  type BackgroundTaskEntry,
  type MonitorEntry,
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
type MonitorTaskEntry = MonitorEntry & { kind: 'monitor' };

type TaskEntry = AgentTaskEntry | ShellTaskEntry | MonitorTaskEntry;

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

  if (entry.kind === 'shell') {
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

  // monitor — append eventCount as a glanceable signal for activity. error
  // (set on `failed` and on auto-stopped `completed`) is included verbatim.
  const events = `${entry.eventCount} event${entry.eventCount === 1 ? '' : 's'}`;
  switch (entry.status) {
    case 'completed':
      return entry.error
        ? `completed (${entry.error}, ${events})`
        : `completed (exit ${entry.exitCode ?? '?'}, ${events})`;
    case 'failed':
      return `failed: ${entry.error ?? 'unknown error'} (${events})`;
    case 'cancelled':
      return `cancelled (${events})`;
    case 'running':
      return `running (${events})`;
    default:
      return `running (${events})`;
  }
}

function taskLabel(entry: TaskEntry): string {
  if (entry.kind === 'agent') {
    return buildBackgroundEntryLabel(entry);
  }
  if (entry.kind === 'shell') {
    return entry.command;
  }
  return entry.description;
}

function taskId(entry: TaskEntry): string {
  switch (entry.kind) {
    case 'agent':
      return entry.agentId;
    case 'shell':
      return entry.shellId;
    case 'monitor':
      return entry.monitorId;
    default: {
      const _exhaustive: never = entry;
      throw new Error(
        `taskId: unknown TaskEntry kind: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

function taskOutputPath(entry: TaskEntry): string | undefined {
  if (entry.kind === 'agent') return entry.outputFile;
  if (entry.kind === 'shell') return entry.outputPath;
  // Monitors stream to the agent via task_notification rather than a
  // file on disk — no output path to surface here.
  return undefined;
}

export const tasksCommand: SlashCommand = {
  name: 'tasks',
  get description() {
    return t('List background tasks (text dump — interactive UI is Ctrl+T)');
  },
  kind: CommandKind.BUILT_IN,
  // Kept on all three modes: the interactive dialog (Ctrl+T) is the
  // richer surface when a TTY is available, but `non_interactive` and
  // `acp` consumers (headless `-p`, IDE bridges, SDK) have no dialog
  // and rely on this text dump as the only way to inspect background
  // task state. See the interactive-mode hint at the top of the output
  // for the soft redirect.
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
    const monitorEntries: MonitorTaskEntry[] = config
      .getMonitorRegistry()
      .getAll()
      .map((entry) => ({ ...entry, kind: 'monitor' as const }));
    const entries = [...agentEntries, ...shellEntries, ...monitorEntries].sort(
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
    const lines: string[] = [];
    // Soft redirect: in interactive mode the dialog (Ctrl+T) is richer
    // (per-entry detail view, live updates, cancel keybinding). Don't
    // show the hint in non_interactive / acp — those consumers have no
    // dialog to point at and the noise just clutters their output.
    if (context.executionMode === 'interactive') {
      lines.push(
        'Tip: Ctrl+T opens the interactive Background tasks dialog with detail view + live updates.',
        '',
      );
    }
    lines.push(`Background tasks (${entries.length} total)`, '');
    for (const entry of entries) {
      const endTime = entry.endTime ?? now;
      const runtime = formatDuration(endTime - entry.startTime, {
        hideTrailingZeros: true,
      });
      const pidPart =
        (entry.kind === 'shell' || entry.kind === 'monitor') &&
        entry.pid !== undefined
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
