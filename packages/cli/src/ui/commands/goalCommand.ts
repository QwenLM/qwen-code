/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GoalStatus,
  renderFirstTurnTemplate,
  wrapUntrustedObjective,
  isPlanStateBlockedByMode,
  isUnlimitedGoalTurns,
  PLAN_MODE_BLOCKED_MESSAGE,
} from '@qwen-code/core';
import { CommandKind, type CommandContext, type SlashCommand } from './types.js';

type GoalMessageResult = {
  type: 'message';
  messageType: 'info' | 'error';
  content: string;
};

type GoalLocalCommandResult = {
  type: 'local_command_result';
  text: string;
};

type GoalSubmitPromptResult = {
  type: 'submit_prompt';
  content: string;
  isMeta?: boolean;
};

type GoalCommandResult =
  | GoalMessageResult
  | GoalLocalCommandResult
  | GoalSubmitPromptResult;

function messageResult(
  content: string,
  messageType: GoalMessageResult['messageType'] = 'info',
): GoalMessageResult {
  return { type: 'message', messageType, content };
}

function localCommandResult(text: string): GoalLocalCommandResult {
  return { type: 'local_command_result', text };
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function goalMaxTurnsLabel(maxTurns: number | undefined): string | undefined {
  if (maxTurns === undefined) return undefined;
  return isUnlimitedGoalTurns(maxTurns) ? 'unlimited' : String(maxTurns);
}

function goalTurnsProgress(
  turnsUsed: number,
  maxTurns: number | undefined,
): string {
  const maxTurnsLabel = goalMaxTurnsLabel(maxTurns);
  return `${turnsUsed}${maxTurnsLabel ? `/${maxTurnsLabel}` : ''}`;
}

// ── Argument parsing ────────────────────────────────────────────────────────

function parseSetArgs(raw: string): {
  objective: string;
  maxTurns?: number;
  /** Set when --turns was given but its value is not a positive integer. */
  invalidTurnsValue?: string;
} {
  const turnsMatch = raw.match(/--turns\s+(\S+)/);
  let maxTurns: number | undefined;
  let invalidTurnsValue: string | undefined;
  let objective = raw;

  if (turnsMatch) {
    const turnsStr = turnsMatch[1];
    objective = raw.replace(/--turns\s+\S+/, '').trim();

    maxTurns = parseInt(turnsStr, 10);

    if (
      turnsStr !== '-1' &&
      (!Number.isFinite(maxTurns) ||
        maxTurns <= 0 ||
        !Number.isInteger(maxTurns))
    ) {
      maxTurns = undefined;
      invalidTurnsValue = turnsStr;
    }
  }

  // Other --flags (e.g. shell commands pasted into the objective) are folded
  // into the objective text as-is; only --turns is parsed as a command flag.
  return { objective: objective.trim(), maxTurns, invalidTurnsValue };
}

// ── Sub-command helpers ─────────────────────────────────────────────────────

function goalUnavailable(
  messageType: GoalMessageResult['messageType'] = 'error',
): GoalMessageResult {
  return messageResult(
    'Goal is unavailable because the session is not initialized.',
    messageType,
  );
}

/** Goal tools appear/disappear with goal state; refresh the cached schema. */
function invalidateGoalToolSchema(context: CommandContext): void {
  context.services.agentContext?.config
    ?.getToolRegistry()
    .invalidateSchemaCache();
}

// ── Sub-command handlers ────────────────────────────────────────────────────

async function handleSet(
  context: CommandContext,
  args: string,
): Promise<GoalCommandResult> {
  const manager = context.services.agentContext?.config.getGoalManager();
  if (!manager) return goalUnavailable();

  // Backward compat with the removed `set` subcommand: strip a leading
  // "set" token so "/goal set <obj>" keeps working; the objective text stays
  // identical to what the old dispatch produced.
  let effectiveArgs = args;
  const legacySetMatch = args.match(/^set(?:\s+|$)/);
  if (legacySetMatch) {
    effectiveArgs = args.slice(legacySetMatch[0].length);
    context.ui.addItem(
      {
        type: 'info',
        text: 'Note: "/goal set" is deprecated — use "/goal `<objective>`" instead.',
      },
      Date.now(),
    );
  }

  const parsed = parseSetArgs(effectiveArgs);
  if (!parsed.objective) {
    return messageResult(
      'Usage: /goal `<description> [--turns <number>]`',
      'error',
    );
  }

  if (parsed.invalidTurnsValue !== undefined) {
    return messageResult(
      `Invalid --turns value "${parsed.invalidTurnsValue}" — expected a positive integer or -1. Usage: /goal \`<description> [--turns <number>]\``,
      'error',
    );
  }

  try {
    const goal = manager.setGoal({
      objective: parsed.objective,
      maxTurns: parsed.maxTurns,
    });

    // Invalidate tool schema cache so goal tools become visible to the model.
    invalidateGoalToolSchema(context);

    const maxTurnsLabel = goalMaxTurnsLabel(goal.maxTurns);
    const turnsStr =
      maxTurnsLabel !== undefined ? ` | Max turns: ${maxTurnsLabel}` : '';
    context.ui.addItem(
      {
        type: 'info',
        text: `Goal set: ${goal.objective}${turnsStr}`,
      },
      Date.now(),
    );

    const limitStr =
      maxTurnsLabel === undefined
        ? 'none'
        : maxTurnsLabel === 'unlimited'
          ? 'unlimited'
          : `${maxTurnsLabel} turns — when the limit is reached the goal is force-paused automatically`;

    return {
      type: 'submit_prompt' as const,
      isMeta: true,
      content: `${renderFirstTurnTemplate(goal)}

Goal state: turns used ${goalTurnsProgress(goal.turnsUsed, goal.maxTurns)} | turn limit: ${limitStr} | current time: ${new Date().toISOString()}.
The goal is ALREADY registered in the goal system — do NOT call create_goal again. Start working towards this goal now, breaking it down into steps if needed.`,
    };
  } catch (e) {
    return messageResult(
      `Failed to set goal: ${e instanceof Error ? e.message : String(e)}`,
      'error',
    );
  }
}

async function handleStatus(
  context: CommandContext,
): Promise<GoalMessageResult> {
  const manager = context.services.agentContext?.config.getGoalManager();
  if (!manager) return goalUnavailable('info');

  manager.refresh();
  const goal = manager.getGoal();
  if (!goal) {
    return messageResult(
      'No active goal. Use /goal `<description>` to create one.',
    );
  }

  const maxTurnsLabel = goalMaxTurnsLabel(goal.maxTurns);
  const turnsStr = maxTurnsLabel
    ? `${goal.turnsUsed} / ${maxTurnsLabel}`
    : `${goal.turnsUsed}`;

  const lines = [
    `**Goal:** ${goal.objective}`,
    `**Status:** ${goal.status}`,
    `**Turns:** ${turnsStr}`,
    `**Time:** ${formatTime(goal.timeUsedSeconds)}`,
  ];

  return messageResult(lines.join('\n'));
}

async function handleClear(
  context: CommandContext,
): Promise<GoalMessageResult | GoalLocalCommandResult> {
  const manager = context.services.agentContext?.config.getGoalManager();
  if (!manager) return goalUnavailable();

  const cleared = manager.clearGoal({
    reason: 'user',
  });

  if (cleared) {
    // Refresh the tool schema cache after the goal state change.
    invalidateGoalToolSchema(context);
  }

  return cleared
    ? localCommandResult('Goal cleared.')
    : messageResult('No active goal to clear.');
}

async function handlePause(
  context: CommandContext,
): Promise<GoalMessageResult | GoalLocalCommandResult> {
  const manager = context.services.agentContext?.config.getGoalManager();
  if (!manager) return goalUnavailable();

  const paused = await manager.pauseForInterrupt();
  if (!paused) {
    return messageResult('No active goal to pause.');
  }

  // Refresh the tool schema cache after the goal state change. Goal tools
  // stay visible while paused so the model can resume via UpdateGoal
  // (status "active") when the user explicitly asks for it.
  invalidateGoalToolSchema(context);

  return localCommandResult(
    `Goal paused: ${manager.getGoal()?.objective ?? 'unknown'}`,
  );
}

async function handleResume(
  context: CommandContext,
): Promise<GoalCommandResult> {
  const manager = context.services.agentContext?.config.getGoalManager();
  if (!manager) return goalUnavailable();

  manager.refresh();
  const goal = manager.getGoal();

  // No goal at all → nothing to resume
  if (!goal) {
    return messageResult('No paused goal to resume.');
  }

  // Goal is still active (e.g. user pressed Ctrl+C / Esc to interrupt) →
  // re-trigger execution without changing status.
  if (goal.status === GoalStatus.Active) {
    invalidateGoalToolSchema(context);

    context.ui.addItem(
      { type: 'info', text: `Goal resumed: ${goal.objective}` },
      Date.now(),
    );

    return {
      type: 'submit_prompt' as const,
      isMeta: true,
      content: `Goal resumed. ${wrapUntrustedObjective(goal.objective)}

Goal state: turns used ${goalTurnsProgress(goal.turnsUsed, goal.maxTurns)} | current time: ${new Date().toISOString()}.
Continuing work...`,
    };
  }

  // Goal is paused (or blocked — UpdateGoal promises the user can revive a
  // blocked goal with /goal resume) → activate it. This is a user action, so
  // an exhausted turn budget is topped up with a fresh block.
  const activated = await manager.activateAfterResume({
    grantFreshBudget: true,
  });
  if (!activated) {
    return messageResult('No paused goal to resume.');
  }

  // Restore plan state if it was active before the process was killed.
  // Skipped when the active permission mode excludes plan state; this entry
  // point bypasses the tool permission pipeline, so it consults the shared
  // plan-exclusion policy directly.
  const resumedGoalForPlan = manager.getGoal();
  if (resumedGoalForPlan?.planWasActive) {
    const fullConfig = context.services.agentContext?.config;
    if (
      fullConfig &&
      isPlanStateBlockedByMode(fullConfig.getPermissionMode())
    ) {
      context.ui.addItem(
        {
          type: 'info',
          text: `Plan mode was not restored. ${PLAN_MODE_BLOCKED_MESSAGE}`,
        },
        Date.now(),
      );
    } else if (fullConfig) {
      fullConfig.planStateManager.enter();
      fullConfig.notifyPlanStateChanged();
      context.ui.addItem(
        { type: 'info', text: 'Plan mode restored (was active before exit).' },
        Date.now(),
      );
    }
  }

  // Invalidate tool schema cache so goal tools become visible again.
  invalidateGoalToolSchema(context);

  const resumedGoal = manager.getGoal();
  context.ui.addItem(
    {
      type: 'info',
      text: `Goal resumed: ${resumedGoal?.objective ?? 'unknown'}${resumedGoal?.maxTurns !== undefined ? ` | Turns: ${goalTurnsProgress(resumedGoal.turnsUsed, resumedGoal.maxTurns)}` : ''}`,
    },
    Date.now(),
  );

  return {
    type: 'submit_prompt' as const,
    isMeta: true,
    content: `Goal resumed. ${
      resumedGoal
        ? wrapUntrustedObjective(resumedGoal.objective)
        : 'No objective could be restored.'
    }

Goal state: turns used ${goalTurnsProgress(resumedGoal?.turnsUsed ?? 0, resumedGoal?.maxTurns)} | current time: ${new Date().toISOString()}.
Continuing work...`,
  };
}

// ── Command definition ──────────────────────────────────────────────────────

export const goalCommand: SlashCommand = {
  name: 'goal',
  description: 'Set or manage a persistent goal for the current session',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  takesArgs: true,
  argumentHint:
    '<objective> [--turns <number>] | status | clear | pause | resume',
  action: async (ctx, args) =>
    args?.trim() ? handleSet(ctx, args) : handleStatus(ctx),
  subCommands: [
    {
      name: 'status',
      description: 'Show current goal status',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      isSafeConcurrent: true,
      takesArgs: false,
      action: async (ctx) => handleStatus(ctx),
    },
    {
      name: 'clear',
      description: 'Remove the current goal',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      isSafeConcurrent: true,
      takesArgs: false,
      action: async (ctx) => handleClear(ctx),
    },
    {
      name: 'pause',
      description: 'Pause the current goal',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      isSafeConcurrent: true,
      takesArgs: false,
      action: async (ctx) => handlePause(ctx),
    },
    {
      name: 'resume',
      description: 'Resume a paused goal',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      takesArgs: false,
      action: async (ctx) => handleResume(ctx),
    },
  ],
};
