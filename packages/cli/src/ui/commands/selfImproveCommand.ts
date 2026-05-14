/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { type Config } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import type {
  MessageActionReturn,
  OpenDialogActionReturn,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import {
  clearActiveSelfImproveLoop,
  getSelfImproveLoopDir,
  initializeSelfImproveLoopFiles,
  readActiveSelfImproveLoop,
  readSelfImproveConfig,
  readSelfImproveLoopState,
  writeActiveSelfImproveLoop,
  writeSelfImproveLoopState,
  type SelfImproveLoopState,
} from './selfImproveState.js';

const execFileAsync = promisify(execFile);

type IntervalParseResult =
  | { ok: true; cron: string; cadence: string }
  | { ok: false; error: string };

function message(
  messageType: 'info' | 'error',
  content: string,
): MessageActionReturn {
  return { type: 'message', messageType, content };
}

function parseStartArgs(
  args: string,
): { interval: string; prompt: string } | null {
  const match = args.match(/^start\s+--every\s+(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    interval: match[1]!,
    prompt: (match[2] ?? '').trim(),
  };
}

function parseInterval(interval: string): IntervalParseResult {
  const normalized = interval.trim().toLowerCase();
  const match = normalized.match(
    /^(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes|分钟|h|hr|hour|hours|小时|d|day|days|天)$/,
  );
  if (!match) {
    return {
      ok: false,
      error: t('Use intervals like 30m, 2h, 1d, 30 minutes, or 2小时.'),
    };
  }

  const value = Number.parseInt(match[1]!, 10);
  const unit = match[2]!;
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: t('Interval must be greater than zero.') };
  }

  if (['s', 'sec', 'second', 'seconds'].includes(unit)) {
    const minutes = Math.max(1, Math.ceil(value / 60));
    return {
      ok: true,
      cron: `*/${minutes} * * * *`,
      cadence: `${minutes}m`,
    };
  }

  if (['m', 'min', 'minute', 'minutes', '分钟'].includes(unit)) {
    if (value > 59) {
      return {
        ok: false,
        error: t('Minute intervals must be under 60. Use hours instead.'),
      };
    }
    return { ok: true, cron: `*/${value} * * * *`, cadence: `${value}m` };
  }

  if (['h', 'hr', 'hour', 'hours', '小时'].includes(unit)) {
    if (value > 23) {
      return {
        ok: false,
        error: t('Hour intervals must be under 24. Use days instead.'),
      };
    }
    return { ok: true, cron: `7 */${value} * * *`, cadence: `${value}h` };
  }

  return { ok: true, cron: `7 0 */${value} * *`, cadence: `${value}d` };
}

async function getRepoRoot(config: Config): Promise<string> {
  const cwd = config.getWorkingDir() || config.getProjectRoot();
  const { stdout } = await execFileAsync('git', [
    '-C',
    cwd,
    'rev-parse',
    '--show-toplevel',
  ]);
  return stdout.trim();
}

async function getCurrentBranch(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync('git', [
    '-C',
    repoRoot,
    'symbolic-ref',
    '--short',
    'HEAD',
  ]);
  return stdout.trim();
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'loop';
}

function makeLoopId(targetBranch: string): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('-');
  const suffix = Math.random().toString(16).slice(2, 8);
  return `${stamp}-${slugify(targetBranch)}-${suffix}`;
}

function describeSources(state: SelfImproveLoopState): string {
  const enabled: string[] = [];
  if (state.sourceSnapshot.sources.githubIssues) enabled.push('GitHub issues');
  if (state.sourceSnapshot.sources.githubPrs) {
    enabled.push('GitHub PRs / CI / review comments');
  }
  if (state.sourceSnapshot.sources.localSignals) {
    enabled.push('Local repo signals');
  }
  if (state.sourceSnapshot.userContext.trim()) enabled.push('User context');
  return enabled.length === 0 ? 'none configured' : enabled.join(', ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatRunRef(value: unknown): string | null {
  if (value === undefined || value === null) return null;

  if (isRecord(value)) {
    const runId = value['runId'];
    const status = value['status'];
    const runDoc = value['runDoc'];
    const parts: string[] = [];
    if (typeof runId === 'string' && runId.trim()) {
      parts.push(runId);
    }
    if (typeof status === 'string' && status.trim()) {
      parts.push(`(${status})`);
    }
    if (typeof runDoc === 'string' && runDoc.trim()) {
      parts.push(`- ${runDoc}`);
    }
    return parts.length > 0 ? parts.join(' ') : JSON.stringify(value);
  }

  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return null;
}

function buildTickPrompt(state: SelfImproveLoopState): string {
  const loopDir = getSelfImproveLoopDir(state.repoRoot, state.loopId);
  return `You are running one tick of the built-in /self-improve loop.

Loop state:
- Repo root: ${state.repoRoot}
- Loop id: ${state.loopId}
- Loop dir: ${loopDir}
- State file: ${path.join(loopDir, 'state.json')}
- Summary file: ${path.join(loopDir, 'summary.md')}
- Runs dir: ${path.join(loopDir, 'runs')}
- Target branch: ${state.targetBranch}
- Auto-merge: true, local only. Do not push. Do not open PRs.
- Repair budget: 5 test/repair attempts.
- Source snapshot: ${describeSources(state)}
- Start prompt: ${state.prompt || '(none)'}
- User context: ${state.sourceSnapshot.userContext || '(none)'}

Hard rules:
1. Run exactly one small, coherent, locally verifiable improvement.
2. Work in an isolated git worktree created from the target branch.
3. Never overwrite, reset, delete, or discard user uncommitted changes.
4. Commit only after appropriate tests pass.
5. If tests fail, repair and rerun checks up to 5 times before giving up.
6. On success, merge the commit back to the local target branch and delete the worktree.
7. After 5 failed repair attempts, delete the worktree and keep only documentation.
8. Update ${path.join(loopDir, 'summary.md')} and one markdown file under ${path.join(loopDir, 'runs')} for every attempted run.
9. Update ${path.join(loopDir, 'state.json')} as you progress, including currentRun, lastRun, stopRequested, and status.
10. If stopRequested is true when you read the state, do not start a new run; mark the loop stopped if appropriate and stop.

State file schema rules:
- status must be one of: "running", "stopping", "stopped", or "stale".
- Keep status as "running" after a successful tick if the loop should continue.
- currentRun and lastRun must be objects when present:
  {
    "runId": "001-short-slug",
    "status": "implementing | testing | success | failed | blocked | cancelled",
    "worktreePath": "/absolute/path/to/worktree",
    "runDoc": "/absolute/path/to/run.md"
  }
- Do not write primitive values such as numbers or timestamps to currentRun or lastRun.

Task selection guidance:
- If GitHub issues are enabled, use gh to inspect open issues and prefer clear, unclaimed, locally verifiable bugs or small enhancements.
- If GitHub PRs are enabled, inspect relevant current-repo PRs for CI failures, review comments, and requested changes.
- If local repo signals are enabled, inspect TODOs, failing or missing tests, recent churn, .qwen/design, and .qwen/e2e-tests.
- If no sources and no start prompt are configured, do a minimal repository inspection and choose a useful small local task.

Final response format:
Selected task: <one sentence>
Outcome: success | failed | blocked | cancelled
Commit: <hash or none>
Run doc: <path>
Validation: <commands and results>
Risk: <short note>`;
}

async function startSelfImprove(
  config: Config,
  args: string,
): Promise<SlashCommandActionReturn> {
  if (!config.isCronEnabled()) {
    return message(
      'error',
      t(
        'Self-improve start requires Cron/Loop Tools. Enable experimental.cron or QWEN_CODE_ENABLE_CRON=1, then try again.',
      ),
    );
  }

  const parsed = parseStartArgs(args);
  if (!parsed) {
    return message(
      'error',
      t('Usage: /self-improve start --every <interval> [prompt]'),
    );
  }

  const interval = parseInterval(parsed.interval);
  if (!interval.ok) return message('error', interval.error);

  let repoRoot: string;
  let targetBranch: string;
  try {
    repoRoot = await getRepoRoot(config);
    targetBranch = await getCurrentBranch(repoRoot);
  } catch (error) {
    return message(
      'error',
      t(
        'Self-improve must be started from a git repository on a branch: {{error}}',
        {
          error: error instanceof Error ? error.message : String(error),
        },
      ),
    );
  }

  const active = await readActiveSelfImproveLoop(repoRoot);
  if (active) {
    const state = await readSelfImproveLoopState(repoRoot, active.activeLoopId);
    if (state && ['running', 'stopping'].includes(state.status)) {
      return message(
        'error',
        t('A self-improve loop is already active: {{loopId}}', {
          loopId: active.activeLoopId,
        }),
      );
    }
  }

  const sourceSnapshot = await readSelfImproveConfig(repoRoot);
  const loopId = makeLoopId(targetBranch);
  const state: SelfImproveLoopState = {
    version: 1,
    loopId,
    status: 'running',
    sessionScoped: true,
    createdAt: new Date().toISOString(),
    cadence: interval.cadence,
    cron: interval.cron,
    targetBranch,
    repoRoot,
    autoMerge: true,
    stopRequested: false,
    sourceSnapshot,
    prompt: parsed.prompt,
  };

  const scheduler = config.getCronScheduler();
  const cronPrompt = `/self-improve tick ${loopId}`;
  const job = scheduler.create(interval.cron, cronPrompt, true);
  state.cronJobId = job.id;

  await initializeSelfImproveLoopFiles(repoRoot, state);
  await writeActiveSelfImproveLoop(repoRoot, loopId);

  return {
    type: 'submit_prompt',
    content: [{ text: buildTickPrompt(state) }],
  };
}

async function statusSelfImprove(config: Config): Promise<MessageActionReturn> {
  const repoRoot = await getRepoRoot(config);
  const active = await readActiveSelfImproveLoop(repoRoot);
  if (!active) {
    return message('info', t('No active self-improve loop.'));
  }

  const state = await readSelfImproveLoopState(repoRoot, active.activeLoopId);
  if (!state) {
    return message(
      'error',
      t('Active self-improve loop state is missing: {{loopId}}', {
        loopId: active.activeLoopId,
      }),
    );
  }

  const scheduler = config.isCronEnabled() ? config.getCronScheduler() : null;
  const job = scheduler
    ?.list()
    .find((candidate) => candidate.id === state.cronJobId);
  const effectiveStatus =
    state.status === 'running' && !job ? 'stale' : state.status;

  const lines = [
    `Loop: ${state.loopId}`,
    `Status: ${effectiveStatus}`,
    `Cadence: ${state.cadence} (${state.cron})`,
    `Target branch: ${state.targetBranch}`,
    `Sources: ${describeSources(state)}`,
    `Prompt: ${state.prompt || '(none)'}`,
    `Cron job: ${job ? job.id : 'none'}`,
  ];
  const currentRun = formatRunRef(state.currentRun);
  if (currentRun) lines.push(`Current run: ${currentRun}`);
  const lastRun = formatRunRef(state.lastRun);
  if (lastRun) lines.push(`Last run: ${lastRun}`);
  return message('info', lines.join('\n'));
}

async function stopSelfImprove(config: Config): Promise<MessageActionReturn> {
  const repoRoot = await getRepoRoot(config);
  const active = await readActiveSelfImproveLoop(repoRoot);
  if (!active) {
    return message('info', t('No active self-improve loop.'));
  }

  const state = await readSelfImproveLoopState(repoRoot, active.activeLoopId);
  if (!state) {
    await clearActiveSelfImproveLoop(repoRoot);
    return message(
      'info',
      t('Cleared missing self-improve loop pointer: {{loopId}}', {
        loopId: active.activeLoopId,
      }),
    );
  }

  if (state.cronJobId && config.isCronEnabled()) {
    config.getCronScheduler().delete(state.cronJobId);
  }

  const hasActiveRun =
    state.currentRun &&
    !['success', 'failed', 'blocked', 'cancelled'].includes(
      state.currentRun.status,
    );

  state.stopRequested = true;
  state.status = hasActiveRun ? 'stopping' : 'stopped';
  await writeSelfImproveLoopState(repoRoot, state);
  if (!hasActiveRun) {
    await clearActiveSelfImproveLoop(repoRoot);
  }

  return message(
    'info',
    hasActiveRun
      ? t('Stop requested. The current self-improve run may finish naturally.')
      : t('Self-improve loop stopped.'),
  );
}

async function tickSelfImprove(
  config: Config,
  loopId: string,
): Promise<SlashCommandActionReturn> {
  const repoRoot = await getRepoRoot(config);
  const active = await readActiveSelfImproveLoop(repoRoot);
  if (!active || active.activeLoopId !== loopId) {
    return message('info', t('Self-improve tick skipped: loop is not active.'));
  }

  const state = await readSelfImproveLoopState(repoRoot, loopId);
  if (!state) {
    return message('error', t('Self-improve tick skipped: state is missing.'));
  }

  if (state.stopRequested || state.status !== 'running') {
    return message('info', t('Self-improve tick skipped: loop is stopping.'));
  }

  return {
    type: 'submit_prompt',
    content: [{ text: buildTickPrompt(state) }],
  };
}

export const selfImproveCommand: SlashCommand = {
  name: 'self-improve',
  get description() {
    return t('Run a session-scoped repository self-improvement loop');
  },
  argumentHint: 'source|start|status|stop',
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'source',
      get description() {
        return t('Configure default context sources for future loops');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive'] as const,
      action: (context): SlashCommandActionReturn => {
        if (context.executionMode !== 'interactive') {
          return message(
            'error',
            t('/self-improve source is available only in interactive mode.'),
          );
        }
        return {
          type: 'dialog',
          dialog: 'self-improve-source',
        } satisfies OpenDialogActionReturn;
      },
    },
    {
      name: 'start',
      get description() {
        return t('Start a session-scoped self-improvement loop');
      },
      argumentHint: '--every <interval> [prompt]',
      kind: CommandKind.BUILT_IN,
      action: async (context, args): Promise<SlashCommandActionReturn> => {
        const config = context.services.config;
        if (!config) {
          return message('error', t('Config not loaded.'));
        }
        return startSelfImprove(config, `start ${args.trim()}`.trim());
      },
    },
    {
      name: 'status',
      get description() {
        return t('Show the active self-improve loop status');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context): Promise<SlashCommandActionReturn> => {
        const config = context.services.config;
        if (!config) {
          return message('error', t('Config not loaded.'));
        }
        return statusSelfImprove(config);
      },
    },
    {
      name: 'stop',
      get description() {
        return t('Gracefully stop the active self-improve loop');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context): Promise<SlashCommandActionReturn> => {
        const config = context.services.config;
        if (!config) {
          return message('error', t('Config not loaded.'));
        }
        return stopSelfImprove(config);
      },
    },
    {
      name: 'tick',
      hidden: true,
      get description() {
        return t('Run one scheduled self-improve tick');
      },
      argumentHint: '<loop-id>',
      kind: CommandKind.BUILT_IN,
      action: async (context, args): Promise<SlashCommandActionReturn> => {
        const config = context.services.config;
        if (!config) {
          return message('error', t('Config not loaded.'));
        }
        const loopId = args.trim();
        if (!loopId) {
          return message('error', t('Missing self-improve loop id.'));
        }
        return tickSelfImprove(config, loopId);
      },
    },
  ],
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const config = context.services.config;
    if (!config) {
      return message('error', t('Config not loaded.'));
    }

    const trimmed = args.trim();
    if (trimmed === 'source') {
      if (context.executionMode !== 'interactive') {
        return message(
          'error',
          t('/self-improve source is available only in interactive mode.'),
        );
      }
      return {
        type: 'dialog',
        dialog: 'self-improve-source',
      } satisfies OpenDialogActionReturn;
    }

    if (trimmed.startsWith('start')) {
      return startSelfImprove(config, trimmed);
    }

    if (trimmed === 'status') {
      return statusSelfImprove(config);
    }

    if (trimmed === 'stop') {
      return stopSelfImprove(config);
    }

    const tickMatch = trimmed.match(/^tick\s+(\S+)$/);
    if (tickMatch) {
      return tickSelfImprove(config, tickMatch[1]!);
    }

    return message(
      'error',
      [
        t('Usage:'),
        '  /self-improve source',
        '  /self-improve start --every <interval> [prompt]',
        '  /self-improve status',
        '  /self-improve stop',
      ].join('\n'),
    );
  },
};
