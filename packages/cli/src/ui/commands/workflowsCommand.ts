/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WorkflowTask } from '@qwen-code/qwen-code-core';
import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { formatDuration } from '../utils/formatters.js';

/**
 * Format one workflow run as a one-line summary used by both the
 * top-level listing and the per-run detail view.
 */
function rowLine(entry: WorkflowTask, now: number): string {
  const endTime = entry.endTime ?? now;
  const runtime = formatDuration(endTime - entry.startTime, {
    hideTrailingZeros: true,
  });
  const label = entry.meta?.name ?? entry.runId;
  const phase = entry.currentPhase ? ` · ${entry.currentPhase}` : '';
  const counts =
    entry.agentsDispatched > 0
      ? ` · ${entry.agentsCompleted}/${entry.agentsDispatched} agents`
      : '';
  const phaseCount =
    entry.phases.length > 0
      ? ` · ${entry.phases.length} ${entry.phases.length === 1 ? 'phase' : 'phases'}`
      : '';
  // P5: budget chip — `tokens/cap` when capped, plain `tokens` otherwise.
  // Skipped on the listing row when nothing is spent AND no cap; the
  // detail view (`detailLines`) always renders both fields so an
  // operator inspecting one run sees the cap state regardless.
  const budgetChip =
    entry.tokensSpent > 0 || entry.tokenBudgetTotal !== null
      ? entry.tokenBudgetTotal !== null
        ? ` · ${entry.tokensSpent}/${entry.tokenBudgetTotal}t`
        : ` · ${entry.tokensSpent}t`
      : '';
  const errorTail =
    entry.status === 'failed' && entry.error
      ? ` — ${entry.error.slice(0, 80)}`
      : '';
  return `  ${entry.runId.padEnd(20)} ${entry.status.padEnd(10)} ${runtime.padStart(8)}  ${label}${phase}${counts}${phaseCount}${budgetChip}${errorTail}`;
}

function detailLines(entry: WorkflowTask, now: number): string[] {
  const lines: string[] = [];
  const endTime = entry.endTime ?? now;
  const runtime = formatDuration(endTime - entry.startTime, {
    hideTrailingZeros: true,
  });

  lines.push(`Workflow ${entry.runId}`);
  if (entry.meta?.name) {
    lines.push(`  name        : ${entry.meta.name}`);
  }
  if (entry.meta?.description) {
    lines.push(`  description : ${entry.meta.description}`);
  }
  if (entry.meta?.whenToUse) {
    lines.push(`  whenToUse   : ${entry.meta.whenToUse}`);
  }
  lines.push(`  status      : ${entry.status}`);
  lines.push(`  runtime     : ${runtime}`);
  if (entry.currentPhase) {
    lines.push(`  currentPhase: ${entry.currentPhase}`);
  }
  lines.push(
    `  agents      : ${entry.agentsCompleted}/${entry.agentsDispatched}`,
  );
  // P5: surface budget + token usage. `tokens` shows actual usage even
  // when no cap is set (operators care about uncapped runs too); `cap`
  // is the env override or `(no cap)` when null.
  lines.push(`  tokens      : ${entry.tokensSpent}`);
  lines.push(
    `  cap         : ${entry.tokenBudgetTotal !== null ? entry.tokenBudgetTotal : '(no cap)'}`,
  );
  if (entry.error) {
    lines.push(`  error       : ${entry.error}`);
  }
  if (entry.phases.length > 0) {
    lines.push('');
    lines.push(`  Phases (${entry.phases.length})`);
    for (const phase of entry.phases) {
      const phaseTokens = entry.perPhaseTokens.get(phase) ?? 0;
      const chip = phaseTokens > 0 ? ` · ${phaseTokens}t` : '';
      lines.push(`    · ${phase}${chip}`);
    }
  }
  if (entry.recentLogs.length > 0) {
    lines.push('');
    lines.push(`  Logs (last ${entry.recentLogs.length})`);
    for (const line of entry.recentLogs) {
      lines.push(`    ${line}`);
    }
  }
  return lines;
}

export const workflowsCommand: SlashCommand = {
  name: 'workflows',
  get description() {
    return t(
      'List active and completed workflow runs (text dump — interactive dialog opens via the footer pill)',
    );
  },
  get argumentHint() {
    return t('[runId]');
  },
  kind: CommandKind.BUILT_IN,
  // Same triple-mode coverage as `/tasks`: the dialog is richer in
  // interactive mode but headless / acp consumers need the text dump
  // as their only inspection path.
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context, args) => {
    const { config } = context.services;
    if (!config) {
      return {
        type: 'message' as const,
        messageType: 'error' as const,
        content: 'Config not available.',
      };
    }
    const registry = config.getWorkflowRunRegistry();
    const allEntries = registry.list();

    // Targeted detail view: `/workflows wf_abc123` opens the detail
    // dump for that run if it exists. Reject early on unknown runId so
    // the user sees a clear error instead of an empty listing.
    const trimmedArgs = (args ?? '').trim();
    if (trimmedArgs.length > 0) {
      const target = registry.get(trimmedArgs);
      if (!target) {
        return {
          type: 'message' as const,
          messageType: 'error' as const,
          content: `Unknown workflow runId: ${trimmedArgs}`,
        };
      }
      return {
        type: 'message' as const,
        messageType: 'info' as const,
        content: detailLines(target, Date.now()).join('\n'),
      };
    }

    if (allEntries.length === 0) {
      return {
        type: 'message' as const,
        messageType: 'info' as const,
        content: 'No workflow runs recorded yet.',
      };
    }

    const now = Date.now();
    // Order: running first (oldest startTime first inside the bucket so
    // long-runners stay visible), then terminal by endTime DESC. Mirrors
    // the dialog's two-bucket sort.
    const running = allEntries
      .filter((e) => e.status === 'running')
      .sort((a, b) => a.startTime - b.startTime);
    const terminal = allEntries
      .filter((e) => e.status !== 'running')
      .sort((a, b) => (b.endTime ?? 0) - (a.endTime ?? 0));

    const lines: string[] = [];
    if (context.executionMode === 'interactive') {
      lines.push(
        t(
          'Tip: use `/workflows <runId>` for the per-run detail view (name, description, phase tree, recent logs).',
        ),
        '',
      );
    }
    lines.push(
      `Workflow runs (${allEntries.length} total · ${running.length} running)`,
      '',
    );
    if (running.length > 0) {
      lines.push('Active');
      for (const entry of running) lines.push(rowLine(entry, now));
      lines.push('');
    }
    if (terminal.length > 0) {
      lines.push('Recent');
      for (const entry of terminal) lines.push(rowLine(entry, now));
    }

    return {
      type: 'message' as const,
      messageType: 'info' as const,
      content: lines.join('\n'),
    };
  },
};
