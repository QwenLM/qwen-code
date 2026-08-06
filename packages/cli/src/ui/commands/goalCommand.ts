/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GoalControlRequest,
  GoalStateResponse,
  GoalStateCause,
  GoalTerminalEvent,
} from '@qwen-code/qwen-code-core';
import {
  getActiveGoal,
  getLastGoalTerminal,
  registerGoalHook,
  unregisterGoalHook,
} from '@qwen-code/qwen-code-core';
import {
  CommandKind,
  type CommandContext,
  type GoalCommandOperation,
  type GoalControlActionReturn,
  type MessageActionReturn,
  type SlashCommand,
  type SlashCommandActionReturn,
  type SubmitPromptActionReturn,
} from './types.js';
import { t } from '../../i18n/index.js';
import { MessageType, type HistoryItemGoalStatus } from '../types.js';
import { installGoalTerminalObserver } from '../utils/restoreGoal.js';
import { formatDuration } from '../utils/formatters.js';

// Mirrored by GOAL_CLEAR_KEYWORDS in
// packages/web-shell/client/utils/goalCondition.ts, whose test reads this
// literal and fails on drift.
const CLEAR_KEYWORDS = new Set([
  'clear',
  'stop',
  'off',
  'reset',
  'none',
  'cancel',
]);

function formatLegacyTurns(count: number): string {
  return `${count} ${count === 1 ? 'turn' : 'turns'}`;
}

function assertNeverTerminalKind(kind: never): never {
  throw new Error(`Unexpected GoalTerminalKind: ${kind}`);
}

function formatLegacyTerminalSummary(event: GoalTerminalEvent): string {
  let title: string;
  switch (event.kind) {
    case 'achieved':
      title = 'Goal achieved';
      break;
    case 'failed':
      title = 'Goal could not be achieved';
      break;
    case 'aborted':
      title = 'Goal aborted';
      break;
    default:
      title = assertNeverTerminalKind(event.kind);
  }
  const stats: string[] = [];
  if (event.iterations > 0) stats.push(formatLegacyTurns(event.iterations));
  if (typeof event.durationMs === 'number') {
    stats.push(formatDuration(event.durationMs, { hideTrailingZeros: true }));
  }
  const subtitle = stats.length > 0 ? ` · ${stats.join(' · ')}` : '';
  const reason = event.lastReason?.trim();
  return `${title}${subtitle}\nGoal: ${event.condition}${reason ? `\nLast check: ${reason}` : ''}`;
}

async function runLegacyGoalCommand(
  context: CommandContext,
  args: string,
  explicitSet = false,
): Promise<SlashCommandActionReturn | void> {
  const { config } = context.services;
  if (!config) return errorMessage('Configuration is not available.');

  const sessionId = config.getSessionId();
  const objective = args.trim();
  if (!objective) {
    const active = getActiveGoal(sessionId);
    if (active) {
      const turns =
        active.iterations === 0
          ? 'not yet evaluated'
          : formatLegacyTurns(active.iterations);
      return {
        type: 'message',
        messageType: 'info',
        content: `Goal active: ${active.condition} (${turns})${
          active.lastReason ? `\nLast check: ${active.lastReason}` : ''
        }`,
      };
    }
    const terminal = getLastGoalTerminal(sessionId);
    return {
      type: 'message',
      messageType: 'info',
      content: terminal
        ? formatLegacyTerminalSummary(terminal)
        : 'No goal set. Usage: `/goal <condition>` (or `/goal clear`).',
    };
  }

  if (!explicitSet && CLEAR_KEYWORDS.has(objective.toLowerCase())) {
    const cleared = unregisterGoalHook(config, sessionId);
    if (!cleared) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'No goal set.',
      };
    }
    const item: Omit<HistoryItemGoalStatus, 'id'> = {
      type: MessageType.GOAL_STATUS,
      kind: 'cleared',
      condition: cleared.condition,
      iterations: cleared.iterations,
      durationMs: Date.now() - cleared.setAt,
    };
    context.ui.addItem(item, Date.now());
    return {
      type: 'message',
      messageType: 'info',
      content: `Goal cleared: ${cleared.condition}`,
    };
  }

  if (!config.isTrustedFolder()) {
    return errorMessage(
      '/goal is only available in trusted workspaces. Trust this folder via `/trust` and try again.',
    );
  }
  if (config.getDisableAllHooks()) {
    return errorMessage(
      '/goal is disabled because hooks are turned off in this session (`disableAllHooks` or bare mode).',
    );
  }
  if (!config.getHookSystem()) {
    return errorMessage(
      'Hook system is not initialized; cannot set a /goal in this session.',
    );
  }

  let registered;
  try {
    registered = registerGoalHook({
      config,
      sessionId,
      condition: objective,
      tokensAtStart: 0,
    });
  } catch (error) {
    return errorMessage(
      `Failed to set goal: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  context.ui.addItem(
    {
      type: MessageType.GOAL_STATUS,
      kind: 'set',
      condition: registered.condition,
      setAt: registered.setAt,
    },
    Date.now(),
  );
  installGoalTerminalObserver({
    sessionId,
    config,
    addItem: context.ui.addItem,
  });
  const result: SubmitPromptActionReturn = {
    type: 'submit_prompt',
    content: [
      {
        text:
          `A session-scoped Stop hook is now active with condition: "${objective
            .replace(/[\r\n]+/g, ' ')
            .replace(/"/g, "'")}". ` +
          'Briefly acknowledge the goal, then immediately start (or continue) working toward it — treat the condition itself as your directive and do not pause to ask the user what to do. The hook will block stopping until the condition holds. It auto-clears once the condition is met — do not tell the user to run `/goal clear` after success; that is only for clearing a goal early.',
      },
    ],
  };
  return result;
}

export type ParsedGoalCommand =
  | GoalCommandOperation
  | { kind: 'error'; message: string };

export function parseGoalCommand(args: string): ParsedGoalCommand {
  let input = args.trim();
  if (/^\/goal(?:\s|$)/i.test(input)) {
    input = input.slice('/goal'.length).trim();
  }
  if (!input) return { kind: 'status' };

  const [head = '', ...tail] = input.split(/\s+/);
  const keyword = head.toLowerCase();
  const objective = tail.join(' ').trim();

  if (keyword === 'set') {
    return objective
      ? { kind: 'set', objective }
      : { kind: 'error', message: '`/goal set` requires an objective.' };
  }
  if (keyword === 'edit') {
    return objective
      ? { kind: 'edit', objective }
      : { kind: 'error', message: '`/goal edit` requires an objective.' };
  }
  if (tail.length === 0) {
    if (keyword === 'pause') return { kind: 'pause' };
    if (keyword === 'resume') return { kind: 'resume' };
    if (CLEAR_KEYWORDS.has(keyword)) return { kind: 'clear' };
  }
  return { kind: 'set', objective: input };
}

function errorMessage(content: string): MessageActionReturn {
  return { type: 'message', messageType: 'error', content };
}

function goalControl(
  operation: GoalCommandOperation,
  response: GoalStateResponse,
  cause?: GoalStateCause,
): GoalControlActionReturn {
  return {
    type: 'goal_control',
    operation,
    response,
    ...(cause ? { cause } : {}),
  };
}

export const goalCommand: SlashCommand = {
  name: 'goal',
  get description() {
    return t('Set or control a session goal');
  },
  argumentHint:
    '[<objective> | set <objective> | edit <objective> | pause | resume | clear]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    if (context.executionMode === 'acp') {
      const operation = parseGoalCommand(args);
      if (operation.kind === 'error') return errorMessage(operation.message);
      if (
        operation.kind !== 'status' &&
        operation.kind !== 'clear' &&
        operation.kind !== 'set'
      ) {
        return errorMessage(
          `'/goal ${operation.kind}' is not available in ACP mode.`,
        );
      }
      const explicitSet = operation.kind === 'set';
      const legacyArgs = explicitSet ? operation.objective : args;
      return (
        (await runLegacyGoalCommand(context, legacyArgs, explicitSet)) ?? {
          type: 'message',
          messageType: 'info',
          content: 'Command executed successfully.',
        }
      );
    }
    const { config } = context.services;
    if (!config) return errorMessage('Configuration is not available.');

    const operation = parseGoalCommand(args);
    if (operation.kind === 'error') return errorMessage(operation.message);

    // Starting or re-driving an autonomous Goal ingests workspace context
    // (QWEN.md, files) without per-tool confirmation, so it requires a trusted
    // workspace — the same boundary the legacy hook path enforces. `status`,
    // `clear`, and `pause` only read or reduce work, so they stay available.
    const requiresTrustedFolder =
      operation.kind === 'set' ||
      operation.kind === 'edit' ||
      operation.kind === 'resume';
    if (requiresTrustedFolder && !config.isTrustedFolder()) {
      return errorMessage(
        '/goal is only available in trusted workspaces. Trust this folder via `/trust` and try again.',
      );
    }

    try {
      const runtime = await config.getGoalRuntimeReady();
      const snapshot = runtime.getSnapshot();
      if (operation.kind === 'status') {
        return goalControl(operation, { snapshot });
      }

      const current = snapshot.goal;
      if (operation.kind === 'set') {
        const request: GoalControlRequest = current
          ? {
              action: 'replace',
              objective: operation.objective,
              expectedGoalId: current.goalId,
              expectedRevision: current.revision,
            }
          : { action: 'create', objective: operation.objective };
        return goalControl(
          operation,
          await runtime.dispatch(request),
          request.action,
        );
      }

      if (!current) {
        if (operation.kind === 'clear') {
          return goalControl(operation, { snapshot });
        }
        return errorMessage(`Cannot ${operation.kind}: no Goal is active.`);
      }

      const version = {
        expectedGoalId: current.goalId,
        expectedRevision: current.revision,
      };
      const request: GoalControlRequest =
        operation.kind === 'edit'
          ? {
              action: 'edit',
              objective: operation.objective,
              ...version,
            }
          : { action: operation.kind, ...version };
      return goalControl(
        operation,
        await runtime.dispatch(request),
        request.action,
      );
    } catch (error) {
      return errorMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  },
};
