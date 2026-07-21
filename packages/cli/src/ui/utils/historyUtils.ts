/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItem, HistoryItemWithoutId } from '../types.js';

/**
 * Items that don't represent meaningful model output. Used by the
 * auto-restore-on-cancel flow to decide whether the just-submitted user
 * prompt can be rewound (no real response was produced) or must stay in
 * the transcript (the user already saw something worth keeping).
 *
 * Mirrors claude-code's `messagesAfterAreOnlySynthetic` (MessageSelector.tsx):
 * thoughts/info/error/etc. are non-meaningful; assistant text and tool runs
 * are meaningful.
 *
 * Every member of the {@link HistoryItemWithoutId} union must appear in
 * exactly one branch — the trailing `_exhaustive: never` line gives a
 * compile-time error when a new history item type is added without
 * being explicitly classified, so auto-restore can't silently break.
 */
export function isSyntheticHistoryItem(
  item: HistoryItem | HistoryItemWithoutId,
): boolean {
  switch (item.type) {
    // Synthetic: system-generated notices that don't represent meaningful
    // model output or user action. Safe to wipe on auto-restore.
    //
    // `gemini_thought` / `gemini_thought_content` are deliberately
    // CLASSIFIED AS SYNTHETIC even though they're visible to the user:
    // (1) Claude Code's auto-restore behavior treats <thinking> output
    // identically — auto-restore fires when the model emitted thoughts
    // but no real `gemini_content` (i.e. the model was still reasoning
    // when the user cancelled);
    // (2) Promoting thoughts to MEANINGFUL would block restore on every
    // cancel-during-thinking case, which is exactly the case where
    // restore is most valuable (user wanted to abandon the in-flight
    // turn before any committed text). The user can still see the
    // thoughts in scrollback if the terminal preserves them; the
    // restore only affects the next ↑-history pull and prompt buffer.
    case 'info':
    case 'error':
    case 'warning':
    case 'success':
    case 'retry_countdown':
    case 'vision_notice':
    case 'notification':
    case 'tool_use_summary':
    case 'gemini_thought':
    case 'gemini_thought_content':
    case 'away_recap':
    case 'insight_progress':
    case 'user_prompt_submit_blocked':
    case 'stop_hook_loop':
    case 'stop_hook_system_message':
      return true;

    // Meaningful: user input, model text, tool runs, slash-command
    // results the user explicitly asked for. Auto-restore must bail
    // when any of these appear after the candidate user prompt.
    case 'user':
    case 'user_shell':
    case 'gemini':
    case 'gemini_content':
    case 'tool_group':
    case 'btw':
    case 'memory_saved':
    case 'about':
    case 'help':
    case 'stats':
    case 'model_stats':
    case 'tool_stats':
    case 'skill_stats':
    case 'quit':
    case 'compression':
    case 'summary':
    case 'extensions_list':
    case 'tools_list':
    case 'skills_list':
    case 'mcp_status':
    case 'context_usage':
    case 'doctor':
    case 'diff_stats':
    case 'arena_agent_complete':
    case 'arena_session_complete':
    case 'goal_status':
      return false;

    default: {
      // Compile-time exhaustiveness — adding a new HistoryItem variant
      // without classifying it here triggers a TS2322 on this line.
      // At runtime any genuinely unknown type defaults to "meaningful"
      // (safe — auto-restore bails rather than wiping content).
      const _exhaustive: never = item;
      void _exhaustive;
      return false;
    }
  }
}

/**
 * Returns true when every item AFTER `fromIndex` is non-meaningful
 * (synthetic). An empty trailing slice also returns true.
 *
 * Used by the cancel handler: if the user hit ESC right after submitting
 * and the model produced nothing real, the prompt+trailing INFO can be
 * rewound and the prompt text restored to the input box — same UX as
 * claude-code (REPL.tsx auto-restore branch).
 */
export function itemsAfterAreOnlySynthetic(
  history: readonly HistoryItem[],
  fromIndex: number,
): boolean {
  for (let i = fromIndex + 1; i < history.length; i++) {
    if (!isSyntheticHistoryItem(history[i])) return false;
  }
  return true;
}

/** Index of the last `user` (real prompt) item, or -1. */
export function findLastUserItemIndex(history: readonly HistoryItem[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item.type === 'user' && item.sentToModel !== false) return i;
  }
  return -1;
}

/** Texts of real (non-steer) user prompts in `history`, oldest-first. */
export function realUserPromptTexts(history: readonly HistoryItem[]): string[] {
  return history
    .filter(
      (item): item is HistoryItem & { type: 'user'; text: string } =>
        item.type === 'user' &&
        item.sentToModel !== false &&
        typeof item.text === 'string' &&
        item.text.trim() !== '',
    )
    .map((item) => item.text);
}

/**
 * Map every thought item to the id of its group's `gemini_thought` head.
 *
 * A "thought" is one `gemini_thought` head followed by zero or more
 * `gemini_thought_content` continuations. Both the head and its continuations
 * map to the head id, so a single click on the head can expand/collapse the
 * whole group as a unit (see the per-thought inline expansion in
 * HistoryItemDisplay).
 */
export function buildThoughtHeadIdMap(
  items: readonly HistoryItem[],
): Map<HistoryItem, number> {
  const map = new Map<HistoryItem, number>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.type !== 'gemini_thought') continue;
    const headId = item.id;
    map.set(item, headId);
    for (let j = i + 1; j < items.length; j++) {
      const next = items[j]!;
      if (next.type !== 'gemini_thought_content') break;
      map.set(next, headId);
    }
  }
  return map;
}
