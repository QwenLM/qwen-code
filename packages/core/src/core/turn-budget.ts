/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The output-token target a user sets for one turn.
 *
 * A user who writes `+500k` (or "use 500k tokens") in a message is sizing the
 * whole turn: the main loop and every agent a workflow dispatches draw from
 * the same pool, so a workflow script can scale its fan-out to what is left
 * rather than to a guess. This module owns the two halves of that contract
 * that do not depend on a workflow: reading the directive out of the prompt,
 * and remembering where the turn started so its spend can be measured.
 *
 * The directive is read from what the user typed, not from what the harness
 * or an `@` reference added to it — a `+500k` inside an attached file or a
 * system reminder is somebody else's text.
 */

import type { PartListUnion } from '@google/genai';
import { createDebugLogger } from '../utils/debugLogger.js';
import { partToString } from '../utils/partUtils.js';

const debugLogger = createDebugLogger('TURN_BUDGET');

/**
 * Largest target a directive can set. A fat-fingered `+100b` would otherwise
 * read as "no limit worth checking"; the same ceiling bounds the per-run env
 * cap (`HARD_MAX_TOKENS_CEILING` in `workflow-budget.ts`).
 */
export const MAX_TURN_BUDGET_TOKENS = 100_000_000;

/**
 * Smallest target a directive can set. Below this a match is far more likely
 * to be ordinary prose (`+5k` of something) than a budget, and no workflow
 * could dispatch a single agent inside it anyway.
 */
export const MIN_TURN_BUDGET_TOKENS = 1_000;

/** A token target read out of a user prompt. */
export interface TurnBudgetDirective {
  /** Output tokens, rounded and clamped to `MAX_TURN_BUDGET_TOKENS`. */
  total: number;
  /** The text that set it, as the user wrote it (`+500k`, `use 2m tokens`). */
  text: string;
}

const UNIT_MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
};

/**
 * `+500k`, `+1m`, `+2.5m` — a standalone token (start of text, whitespace or
 * an opening bracket before it; no letter or digit after the unit, so
 * `+5bugs` and `+500km` do not count).
 */
const PLUS_DIRECTIVE = /(?:^|[\s([{])(\+(\d+(?:\.\d+)?)([kmb]))(?![a-z0-9_])/gi;

/** "use 500k tokens", "spend 2 m tokens". */
const PHRASE_DIRECTIVE =
  /\b((?:use|spend)\s+(\d+(?:\.\d+)?)\s*([kmb])\s*tokens?)\b/gi;

/**
 * Parse the first valid token target in `text`, or `null` when there is
 * none. `text` should already be the user's own words — see
 * {@link extractTurnBudgetDirectiveText}. A slash command is never a
 * directive: its arguments belong to the command.
 */
export function parseTurnBudgetDirective(
  text: string,
): TurnBudgetDirective | null {
  if (text.trimStart().startsWith('/')) return null;
  const candidates: Array<{ index: number; directive: TurnBudgetDirective }> =
    [];
  for (const pattern of [PLUS_DIRECTIVE, PHRASE_DIRECTIVE]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const directive = toDirective(match[1]!, match[2]!, match[3]!);
      if (directive) {
        candidates.push({
          index: (match.index ?? 0) + match[0].indexOf(match[1]!),
          directive,
        });
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0]!.directive;
}

function toDirective(
  text: string,
  amount: string,
  unit: string,
): TurnBudgetDirective | null {
  const multiplier = UNIT_MULTIPLIERS[unit.toLowerCase()];
  const value = Number(amount);
  if (multiplier === undefined || !Number.isFinite(value)) return null;
  const total = Math.round(value * multiplier);
  if (total < MIN_TURN_BUDGET_TOKENS) return null;
  if (total > MAX_TURN_BUDGET_TOKENS) {
    debugLogger.warn(
      `Turn budget directive "${text}" exceeds ${MAX_TURN_BUDGET_TOKENS} output tokens; clamping.`,
    );
    return { total: MAX_TURN_BUDGET_TOKENS, text };
  }
  return { total, text };
}

/** Harness reminders prepended to a user message. */
const SYSTEM_REMINDER_BLOCK =
  /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g;
/** `@path` references expanded by `read_many_files`. */
const REFERENCED_FILES_BLOCK =
  /--- Content from referenced files ---[\s\S]*?(?:--- End of content ---|$)/g;
/** `@server:uri` references; the closing marker repeats the opening nonce. */
const MCP_RESOURCE_BLOCK =
  /--- Content from MCP resource .*? \[([^\]\n]+)\] ---[\s\S]*?(?:--- End of MCP resource .*? \[\1\] ---|$)/g;
/** Fenced code blocks, then inline code spans. */
const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`[^`\n]*`/g;

/**
 * The user's own words in a request: every text part joined, with harness
 * reminders, expanded `@` references (files and MCP resources, which ACP may
 * place before the prompt rather than after it) and code removed. Whatever is
 * removed is replaced by a space so the text on either side stays separated.
 */
export function extractTurnBudgetDirectiveText(request: PartListUnion): string {
  return partToString(request)
    .replace(SYSTEM_REMINDER_BLOCK, ' ')
    .replace(REFERENCED_FILES_BLOCK, ' ')
    .replace(MCP_RESOURCE_BLOCK, ' ')
    .replace(FENCED_CODE, ' ')
    .replace(INLINE_CODE, ' ');
}

/** Where a turn started, and what it may spend. */
export interface TurnBudgetSnapshot {
  /** The prompt id of the interaction that opened the turn. */
  readonly promptId: string;
  /** The session whose token ledger the turn is measured against. */
  readonly sessionId: string;
  /** Output-token target from the directive, or `null` when none was set. */
  readonly budget: number | null;
  /** The directive text that set `budget`, for display. */
  readonly directiveText?: string;
  /** The session's output-token total when the turn started. */
  readonly outputTokensAtTurnStart: number;
}

/**
 * The current turn's snapshot for one session. One instance per `Config`;
 * the client writes it when an interaction starts and a workflow reads it
 * once, at launch — a workflow that outlives its turn keeps measuring against
 * the turn it was started in.
 */
export class TurnBudget {
  private snapshot: TurnBudgetSnapshot | null = null;

  beginTurn(snapshot: TurnBudgetSnapshot): void {
    this.snapshot = snapshot;
  }

  /**
   * The turn in progress for `sessionId`, or `null` when no turn has started
   * or the last one belonged to another session (a `/resume` or `/clear`
   * switched the ledger out from under it).
   */
  current(sessionId: string): TurnBudgetSnapshot | null {
    return this.snapshot?.sessionId === sessionId ? this.snapshot : null;
  }

  reset(): void {
    this.snapshot = null;
  }
}
