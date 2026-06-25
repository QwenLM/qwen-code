/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WorkflowTask, WorkflowSnapshot } from '@qwen-code/qwen-code-core';
import { listWorkflowSnapshots } from '@qwen-code/qwen-code-core';
import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { formatDuration, formatTokenCount } from '../utils/formatters.js';

/**
 * P7b: adapt a persisted snapshot to the `WorkflowTask` shape the row /
 * detail formatters expect. The dialog-only fields (`abortController`,
 * `outputFile`, etc.) are filled with inert values — a snapshot is always
 * terminal, so the controls that read those fields are never reached.
 */
function snapshotToTask(s: WorkflowSnapshot): WorkflowTask {
  return {
    id: s.runId,
    kind: 'workflow',
    runId: s.runId,
    description: s.meta?.name ?? s.runId,
    meta: s.meta,
    status: s.status,
    currentPhase: null,
    phases: s.phases ?? [],
    agentsDispatched: s.agentsDispatched ?? 0,
    agentsCompleted: s.agentsCompleted ?? 0,
    recentLogs: s.recentLogs ?? [],
    tokensSpent: s.tokensSpent ?? 0,
    tokenBudgetTotal: s.tokenBudgetTotal ?? null,
    perPhaseTokens: new Map(s.perPhaseTokens ?? []),
    script: s.script ?? '',
    scriptPath: s.scriptPath,
    result: s.result,
    error: s.error,
    startTime: s.startTime,
    endTime: s.endTime,
    outputFile: '',
    outputOffset: 0,
    notified: true,
    abortController: new AbortController(),
  } as WorkflowTask;
}

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
  // P5 R1 (#7): use `formatTokenCount` so large counts render as
  // `1.2k / 50k` instead of raw integers, matching the formatting used
  // by `statusLinePresets` and other token-bearing UI surfaces.
  const budgetChip =
    entry.tokensSpent > 0 || entry.tokenBudgetTotal !== null
      ? entry.tokenBudgetTotal !== null
        ? ` · ${formatTokenCount(entry.tokensSpent)}/${formatTokenCount(entry.tokenBudgetTotal)}t`
        : ` · ${formatTokenCount(entry.tokensSpent)}t`
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
  // P5 R1 (#7): apply `formatTokenCount` for consistency with `statusLinePresets`.
  lines.push(`  tokens      : ${formatTokenCount(entry.tokensSpent)}`);
  lines.push(
    `  cap         : ${entry.tokenBudgetTotal !== null ? formatTokenCount(entry.tokenBudgetTotal) : '(no cap)'}`,
  );
  if (entry.error) {
    lines.push(`  error       : ${entry.error}`);
  }
  if (entry.phases.length > 0) {
    lines.push('');
    lines.push(`  Phases (${entry.phases.length})`);
    for (const phase of entry.phases) {
      const phaseTokens = entry.perPhaseTokens.get(phase) ?? 0;
      const chip =
        phaseTokens > 0 ? ` · ${formatTokenCount(phaseTokens)}t` : '';
      lines.push(`    · ${phase}${chip}`);
    }
    // P5 R1 (#6): surface null-sentinel attribution — tokens spent BEFORE
    // the first `phase()` call accumulate under the `null` key. Without
    // this branch the entire pre-phase spend was invisible in the dump.
    const prePhaseTokens = entry.perPhaseTokens.get(null) ?? 0;
    if (prePhaseTokens > 0) {
      lines.push(`    · (no phase) · ${formatTokenCount(prePhaseTokens)}t`);
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
      let target = registry.get(trimmedArgs);
      if (!target) {
        // Fall back to a persisted snapshot — the run may predate this CLI
        // process (the in-memory registry dies with the process, the
        // snapshot on disk does not).
        const snapshot = (await listWorkflowSnapshots(config)).find(
          (s) => s.runId === trimmedArgs,
        );
        if (snapshot) target = snapshotToTask(snapshot);
      }
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

    // Merge persisted snapshots (runs from earlier CLI processes) into the
    // listing. In-memory registry entries win on a runId collision — they
    // carry live status, while a snapshot is a frozen terminal projection.
    const snapshots = await listWorkflowSnapshots(config);
    const liveRunIds = new Set(allEntries.map((e) => e.runId));
    const snapshotTasks = snapshots
      .filter((s) => !liveRunIds.has(s.runId))
      .map(snapshotToTask);

    if (allEntries.length === 0 && snapshotTasks.length === 0) {
      return {
        type: 'message' as const,
        messageType: 'info' as const,
        content: 'No workflow runs recorded yet.',
      };
    }

    const now = Date.now();
    // Order: running first (oldest startTime first inside the bucket so
    // long-runners stay visible), then terminal by endTime DESC. Mirrors
    // the dialog's two-bucket sort. Snapshots are always terminal, so they
    // only ever join the second bucket.
    const running = allEntries
      .filter((e) => e.status === 'running')
      .sort((a, b) => a.startTime - b.startTime);
    const terminal = [
      ...allEntries.filter((e) => e.status !== 'running'),
      ...snapshotTasks,
    ].sort((a, b) => (b.endTime ?? 0) - (a.endTime ?? 0));

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
      `Workflow runs (${running.length + terminal.length} total · ${running.length} running)`,
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
