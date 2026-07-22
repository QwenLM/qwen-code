/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GoalControlRequest,
  GoalStateResponse,
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
    if (keyword === 'clear') return { kind: 'clear' };
  }
  return { kind: 'set', objective: input };
}

function errorMessage(content: string): MessageActionReturn {
  return { type: 'message', messageType: 'error', content };
}

function goalControl(
  operation: GoalCommandOperation,
  response: GoalStateResponse,
): GoalControlActionReturn {
  return { type: 'goal_control', operation, response };
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
        return goalControl(operation, await runtime.dispatch(request));
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
      return goalControl(operation, await runtime.dispatch(request));
    } catch (error) {
      return errorMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  },
};
