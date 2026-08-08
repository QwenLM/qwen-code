/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GoalControlRequest,
  GoalStateResponse,
  GoalStateCause,
} from '@qwen-code/qwen-code-core';
import {
  emptyGoalSnapshot,
  GoalPersistenceUnavailableError,
} from '@qwen-code/qwen-code-core';
import {
  CommandKind,
  type CommandContext,
  type GoalCommandOperation,
  type GoalControlActionReturn,
  type MessageActionReturn,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';
import { t } from '../../i18n/index.js';

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
      // A session that cannot persist goals has no goal, which is a
      // describable answer for the operations that only read or reduce
      // state — and the one the sibling `sessionGoalGet`/`sessionGoalClear`
      // ext methods already give. Failing instead is worse here than
      // anywhere else: in ACP an error return throws out of
      // `#processSlashCommandResult`, so a sticky `recoveryError` (or plain
      // `general.chatRecording: false`) would fail the user's whole prompt
      // request, and keep doing so for the rest of the session, while
      // `GET /goals` answers the same question fine. `set`/`edit`/`resume`
      // still fail: those genuinely need persistence.
      if (
        error instanceof GoalPersistenceUnavailableError &&
        (operation.kind === 'status' || operation.kind === 'clear')
      ) {
        return goalControl(operation, { snapshot: emptyGoalSnapshot() });
      }
      return errorMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  },
};
