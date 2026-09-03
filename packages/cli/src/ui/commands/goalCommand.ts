/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GoalControlRequest,
  GoalStateResponse,
  GoalStateCause,
} from '@qwen-code/qwen-code-core/goals/goal-protocol.js';
import type { GoalRuntime } from '@qwen-code/qwen-code-core/goals/goal-runtime.js';
import { emptyGoalSnapshot } from '@qwen-code/qwen-code-core/goals/goal-protocol.js';
import { GoalPersistenceUnavailableError } from '@qwen-code/qwen-code-core/goals/goal-runtime.js';
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

    let runtime: GoalRuntime;
    try {
      runtime = await config.getGoalRuntimeReady();
    } catch (error) {
      // With recording disabled there cannot be persisted Goal state, which
      // makes an empty status authoritative. If persistence exists, recovery
      // may instead have failed while an old Goal record remains, so status
      // and clear must surface that failure rather than report success.
      if (
        error instanceof GoalPersistenceUnavailableError &&
        (operation.kind === 'status' || operation.kind === 'clear') &&
        config.getChatRecordingService() === undefined
      ) {
        return goalControl(operation, { snapshot: emptyGoalSnapshot() });
      }
      return errorMessage(
        error instanceof Error ? error.message : String(error),
      );
    }

    try {
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
