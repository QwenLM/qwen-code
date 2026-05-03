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
import { escapeAnsiCtrlCodes } from '../utils/textUtils.js';

type AgentTaskEntry = BackgroundTaskEntry & {
  kind: 'agent';
  resumeBlockedReason?: string;
};

type ShellTaskEntry = BackgroundShellEntry & { kind: 'shell' };
type MonitorTaskEntry = MonitorEntry & { kind: 'monitor' };

type TaskEntry = AgentTaskEntry | ShellTaskEntry | MonitorTaskEntry;

function statusLabel(entry: TaskEntry): string {
  switch (entry.kind) {
    case 'agent':
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
    case 'shell':
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
    case 'monitor': {
      // Append eventCount as a glanceable signal for activity. error (set
      // on `failed` and on auto-stopped `completed`) is included verbatim.
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
    default: {
      const _exhaustive: never = entry;
      throw new Error(
        `statusLabel: unknown TaskEntry kind: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

function taskLabel(entry: TaskEntry): string {
  switch (entry.kind) {
    case 'agent':
      return buildBackgroundEntryLabel(entry);
    case 'shell':
      return entry.command;
    case 'monitor':
      return entry.description;
    default: {
      const _exhaustive: never = entry;
      throw new Error(
        `taskLabel: unknown TaskEntry kind: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
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
  switch (entry.kind) {
    case 'agent':
      return entry.outputFile;
    case 'shell':
      return entry.outputPath;
    case 'monitor':
      // Monitors stream to the agent via task_notification rather than a
      // file on disk — no output path to surface here.
      return undefined;
    default: {
      const _exhaustive: never = entry;
      throw new Error(
        `taskOutputPath: unknown TaskEntry kind: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

export const tasksCommand: SlashCommand = {
  name: 'tasks',
  get description() {
    return t(
      'List background tasks (text dump — interactive dialog opens via the footer pill)',
    );
  },
  kind: CommandKind.BUILT_IN,
  // Kept on all three modes: the interactive dialog (reachable via ↓ +
  // Enter on the footer Background tasks pill) is the richer surface
  // when a TTY is available, but `non_interactive` and `acp` consumers
  // (headless `-p`, IDE bridges, SDK) have no dialog and rely on this
  // text dump as the only way to inspect background task state. See the
  // interactive-mode hint at the top of the output for the soft redirect.
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
    // Soft redirect: in interactive mode the dialog is richer (per-entry
    // detail view, live updates, cancel keybinding). Don't show the hint
    // in non_interactive / acp — those consumers have no dialog to point
    // at and the noise just clutters their output. The wording avoids
    // pinning a single-key path because Down may pass through the Arena
    // agent tab bar first when subagents are present (`InputPrompt`
    // focus chain: agent tab bar → bg pill); calling it "the footer
    // Background tasks pill" lets the user reach it however the focus
    // chain routes them today.
    if (context.executionMode === 'interactive') {
      lines.push(
        t(
          'Tip: focus the Background tasks pill in the footer (use ↓ from an empty composer) and press Enter for the interactive dialog with detail view + live updates.',
        ),
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

    // Defense in depth: registry entries carry user-supplied / process-
    // supplied strings (description, command, error from spawn / settle).
    // A maliciously-crafted value containing raw ANSI escape sequences
    // (CSI / OSC / SGR — anything starting with ESC, the kind matched
    // by `ansi-regex`) could otherwise reach the terminal verbatim and
    // corrupt display. `escapeAnsiCtrlCodes` is scoped to those
    // sequences only — it does NOT escape isolated C0/C1 control bytes
    // like BEL, BS, or VT; if those become a concern we'd need to
    // layer `node:util`'s `stripVTControlCharacters` on top. For the
    // common case (no escape sequences present) the helper is a no-op
    // and returns the original string. Wrapping the joined output once
    // covers every field — including any future kind's fields —
    // without per-site sanitization sprawl.
    return {
      type: 'message' as const,
      messageType: 'info' as const,
      content: escapeAnsiCtrlCodes(lines.join('\n')),
    };
  },
};
