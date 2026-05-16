/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type CommandContext,
  type MessageActionReturn,
  type SlashCommand,
  type SlashCommandActionReturn,
  type SubmitPromptActionReturn,
} from './types.js';
import {
  getActiveGoal,
  getLastGoalTerminal,
  registerGoalHook,
  unregisterGoalHook,
  type GoalTerminalEvent,
} from '@qwen-code/qwen-code-core';
import { MessageType, type HistoryItemGoalStatus } from '../types.js';
import { installGoalTerminalObserver } from '../utils/restoreGoal.js';
import { formatDuration } from '../utils/formatters.js';
import { t } from '../../i18n/index.js';

const CLEAR_KEYWORDS = new Set([
  'clear',
  'stop',
  'off',
  'reset',
  'none',
  'cancel',
]);

const MAX_GOAL_LENGTH = 4000;

// Keep the surrounding `"…"` quote structure intact: collapse newlines so the
// condition stays on one line, and downgrade embedded double-quotes to single
// quotes so they don't visually close the wrapping quote.
function sanitizeConditionForPrompt(condition: string): string {
  return condition.replace(/[\r\n]+/g, ' ').replace(/"/g, "'");
}

const goalInstructionPrompt = (condition: string): string =>
  `A session-scoped Stop hook is now active with condition: "${sanitizeConditionForPrompt(condition)}". ` +
  `Briefly acknowledge the goal, then immediately start (or continue) working ` +
  `toward it — treat the condition itself as your directive and do not pause to ` +
  `ask the user what to do. The hook will block stopping until the condition ` +
  `holds. It auto-clears once the condition is met — do not tell the user to ` +
  `run \`/goal clear\` after success; that's only for clearing a goal early.`;

const formatTurns = (n: number) => `${n} ${n === 1 ? 'turn' : 'turns'}`;

function formatTerminalSummary(event: GoalTerminalEvent): string {
  // Mirrors GoalStatusMessage: empty-`/goal` after completion surfaces the
  // most recent terminal event, including the judge's `lastReason` (when
  // present) so this view matches the inline `Goal achieved / aborted`
  // history card.
  const title = event.kind === 'achieved' ? 'Goal achieved' : 'Goal aborted';
  const stats: string[] = [];
  if (event.iterations > 0) stats.push(formatTurns(event.iterations));
  if (typeof event.durationMs === 'number')
    stats.push(formatDuration(event.durationMs, { hideTrailingZeros: true }));
  const subtitle = stats.length > 0 ? ` · ${stats.join(' · ')}` : '';
  const reason = event.lastReason?.trim();
  const reasonLine = reason ? `\nLast check: ${reason}` : '';
  return `${title}${subtitle}\nGoal: ${event.condition}${reasonLine}`;
}

function infoMessage(content: string): MessageActionReturn {
  return { type: 'message', messageType: 'info', content };
}

function errorMessage(content: string): MessageActionReturn {
  return { type: 'message', messageType: 'error', content };
}

export const goalCommand: SlashCommand = {
  name: 'goal',
  get description() {
    return t('Set a goal — keep working until the condition is met');
  },
  argumentHint: '[<condition> | clear]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn | void> => {
    const { config } = context.services;
    if (!config) {
      return errorMessage('Configuration is not available.');
    }
    const sessionId = config.getSessionId();
    const q = args.trim();

    // ── Branch 1: empty arg → show current status ─────────────────────────
    if (q === '') {
      const active = getActiveGoal(sessionId);
      if (active) {
        const turns =
          active.iterations === 0
            ? 'not yet evaluated'
            : formatTurns(active.iterations);
        const lastReason = active.lastReason
          ? `\nLast check: ${active.lastReason}`
          : '';
        return infoMessage(
          `Goal active: ${active.condition} (${turns})${lastReason}`,
        );
      }
      // No active goal — surface a summary of the most recent terminal goal
      // for this session, matching Claude Code's behavior of rendering the
      // "Goal achieved" card on empty /goal after completion. Only achieved /
      // aborted entries flow through `getLastGoalTerminal`; user-initiated
      // `/goal clear` does not populate it.
      const last = getLastGoalTerminal(sessionId);
      if (last) {
        return infoMessage(formatTerminalSummary(last));
      }
      return infoMessage(
        'No goal set. Usage: `/goal <condition>` (or `/goal clear`).',
      );
    }

    // ── Branch 2: clear keyword ──────────────────────────────────────────
    //
    // Strict alignment with Claude Code 2.1.140 `woH`: when an active goal
    // exists, drop the Stop hook + emit a `cleared` history sentinel; when
    // no active goal exists, this is a no-op that just returns "No goal
    // set". Claude does NOT wipe the cached "Goal achieved" summary on
    // clear — subsequent empty `/goal` may still surface the most recent
    // achievement via `findLastTerminalGoal`. That's intentional: the
    // `cleared` history item is a sentinel `findLastTerminalGoal` skips,
    // and the previous non-sentinel achievement remains visible.
    if (CLEAR_KEYWORDS.has(q.toLowerCase())) {
      const cleared = unregisterGoalHook(config, sessionId);
      if (!cleared) {
        return infoMessage('No goal set.');
      }
      const clearedItem: Omit<HistoryItemGoalStatus, 'id'> = {
        type: MessageType.GOAL_STATUS,
        kind: 'cleared',
        condition: cleared.condition,
        iterations: cleared.iterations,
        durationMs: Date.now() - cleared.setAt,
      };
      context.ui.addItem(clearedItem, Date.now());
      return;
    }

    // ── Branch 3: length cap ─────────────────────────────────────────────
    if (q.length > MAX_GOAL_LENGTH) {
      return errorMessage(
        `Goal condition is limited to ${MAX_GOAL_LENGTH} characters (got ${q.length}).`,
      );
    }

    // ── Branch 4: gates ──────────────────────────────────────────────────
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

    // ── Branch 5: register hook + emit set card + kick off first turn ────
    let registered;
    try {
      registered = registerGoalHook({
        config,
        sessionId,
        condition: q,
        tokensAtStart: 0,
      });
    } catch (err) {
      return errorMessage(
        `Failed to set goal: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const setItem: Omit<HistoryItemGoalStatus, 'id'> = {
      type: MessageType.GOAL_STATUS,
      kind: 'set',
      condition: registered.condition,
    };
    context.ui.addItem(setItem, Date.now());

    // Bridge core-side hook outcomes back into CLI history. The addItem ref
    // is stable across turns (useCallback in useHistoryManager), so capturing
    // it here is safe even though the observer fires from a later turn's
    // Stop hook callback. The core side clears the observer on terminal /
    // unregister so we don't accumulate stale closures across goals.
    installGoalTerminalObserver({
      sessionId,
      config,
      addItem: context.ui.addItem,
    });

    const result: SubmitPromptActionReturn = {
      type: 'submit_prompt',
      content: [{ text: goalInstructionPrompt(q) }],
    };
    return result;
  },
};
