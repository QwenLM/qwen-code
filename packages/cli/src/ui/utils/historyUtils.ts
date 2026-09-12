/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from '@qwen-code/qwen-code-core';
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

    // Steer messages (mid-turn user injections) are typed 'user' but
    // carry sentToModel === false; treat them as synthetic so the
    // cancel handler can still do a full rewind when only a steer
    // follows the real prompt.
    case 'user':
      return item.sentToModel === false;

    // Meaningful: user input, model text, tool runs, slash-command
    // results the user explicitly asked for. Auto-restore must bail
    // when any of these appear after the candidate user prompt.
    case 'user_shell':
    case 'gemini':
    case 'gemini_content':
    case 'tool_group':
    case 'btw':
    case 'advisor':
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
    case 'goal_state':
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
 * Removes the one-shot `<system-reminder>` envelopes the submit path prepends
 * to the model text (recovered background agents, worktree restore, workflow
 * steering — see AppContainer's `handleFinalSubmit`). They are model context,
 * not something the user typed, so every surface that reads a user prompt back
 * to them — the live transcript, the ↑-recall log, the cancel-restore buffer,
 * and the history rebuilt on resume — must show the text without them.
 *
 * Leading-only on purpose: an envelope the user pasted into the middle of
 * their own message stays visible, so a prompt is never partly hidden. An
 * unterminated envelope stops the scan and is left in place rather than
 * swallowed. And when stripping would leave nothing — a prompt that IS only
 * envelope(s), e.g. one the user pasted wholesale — the original text is
 * returned unchanged, so no caller can strip a message out of existence.
 */
export function stripLeadingSystemReminders(text: string): string {
  return splitLeadingSystemReminders(text).rest;
}

/**
 * The strip split into its two halves: `rest` is the display text and
 * `reminders` the exact prefix that was removed ('' when nothing was), so a
 * restore path can re-arm the consumed envelopes for the next submit instead
 * of losing them with the strip.
 */
export function splitLeadingSystemReminders(text: string): {
  reminders: string;
  rest: string;
} {
  let rest = text;
  while (rest.startsWith(SYSTEM_REMINDER_OPEN)) {
    const close = rest.indexOf(
      SYSTEM_REMINDER_CLOSE,
      SYSTEM_REMINDER_OPEN.length,
    );
    if (close === -1) break;
    rest = rest.slice(close + SYSTEM_REMINDER_CLOSE.length).replace(/^\s+/, '');
  }
  if (rest === '' || rest === text) return { reminders: '', rest: text };
  return { reminders: text.slice(0, text.length - rest.length), rest };
}

/**
 * Prepends the armed reminder `envelopes` to `text`, skipping each block
 * that already leads `text`. The re-arm runs after the submit path's
 * injectors, and the one injector that can re-fire (the un-latched
 * workflow-steering notice) would otherwise stack a duplicate copy on every
 * cancel/resubmit cycle. Comparison is per envelope block, so a partially
 * re-fired prefix still re-arms the blocks that did not re-fire.
 */
export function prependMissingSystemReminders(
  envelopes: string,
  text: string,
): string {
  let missing = '';
  let rest = envelopes;
  while (rest.startsWith(SYSTEM_REMINDER_OPEN)) {
    const close = rest.indexOf(
      SYSTEM_REMINDER_CLOSE,
      SYSTEM_REMINDER_OPEN.length,
    );
    if (close === -1) break;
    const blockEnd = close + SYSTEM_REMINDER_CLOSE.length;
    const block = rest.slice(0, blockEnd);
    rest = rest.slice(blockEnd).replace(/^\s+/, '');
    if (!text.startsWith(block)) {
      missing += `${block}\n\n`;
    }
  }
  return missing + text;
}

/**
 * Removes exactly the `<system-reminder>` envelope blocks listed in
 * `reminders` (the producer's own decomposition — see
 * `aggregateUserMessages`) from `text`, first occurrence each, leaving every
 * other block — including a user-authored one — in place. Provenance-driven
 * counterpart to the leading-only shape strip: a mid-string injected
 * envelope is dropped without touching identical-looking user content
 * elsewhere in the text. Each removed block takes the separator that
 * followed it, mirroring how the envelopes were prepended — exactly one
 * `\n\n` (the producer's separator), or a single whitespace char for a
 * hand-shaped envelope. A greedy `\s+` run would also eat the user's own
 * leading indentation on the line after the block.
 */
export function omitSystemReminderBlocks(
  text: string,
  reminders: string,
): string {
  let result = text;
  let rest = reminders;
  while (rest.startsWith(SYSTEM_REMINDER_OPEN)) {
    const close = rest.indexOf(
      SYSTEM_REMINDER_CLOSE,
      SYSTEM_REMINDER_OPEN.length,
    );
    if (close === -1) break;
    const blockEnd = close + SYSTEM_REMINDER_CLOSE.length;
    const block = rest.slice(0, blockEnd);
    rest = rest.slice(blockEnd).replace(/^\s+/, '');
    const at = result.indexOf(block);
    if (at === -1) continue;
    const after = result.slice(at + block.length);
    const separator = after.startsWith('\n\n')
      ? '\n\n'
      : (after.match(/^\s/)?.[0] ?? '');
    result = result.slice(0, at) + after.slice(separator.length);
  }
  return result;
}

/**
 * Whether a recorded user prompt's display text carries a leading
 * `<system-reminder>` run that the record's own model-facing parts carry
 * too. When the writer's provenance was available, `displayText` is the
 * pre-injection typed text, so a leading run in it is user-authored
 * content; when provenance was unavailable (a vim submit), an injected
 * envelope lands in both fields and is indistinguishable from a pasted
 * one — either way the parts carrying the same run mean the record cannot
 * prove the run was injected, so the safe read-back keeps the text rather
 * than deleting user content by shape. Only when the parts lack the run
 * does the strip apply.
 */
export function hasUserAuthoredLeadingReminders(
  displayText: string,
  modelPartsText: string,
): boolean {
  const { reminders } = splitLeadingSystemReminders(displayText);
  return reminders !== '' && modelPartsText.includes(reminders);
}

/**
 * Whether `text` consists solely of whole leading `<system-reminder>`
 * envelopes (plus separating whitespace) — the shape of a prefix the submit
 * path's injectors prepend. Gates producer-provenance adoption: a recovered
 * prefix that is not pure envelopes (an attachment `@ref`, a queue
 * aggregate's leading member) is display content, not a re-armable
 * reminder. False for '' (an empty difference is not an injected prefix) and
 * for unterminated envelopes (a truncated envelope is never armed).
 */
export function isOnlyLeadingSystemReminders(text: string): boolean {
  if (text === '') return false;
  let rest = text;
  while (rest.startsWith(SYSTEM_REMINDER_OPEN)) {
    const close = rest.indexOf(
      SYSTEM_REMINDER_CLOSE,
      SYSTEM_REMINDER_OPEN.length,
    );
    if (close === -1) return false;
    rest = rest.slice(close + SYSTEM_REMINDER_CLOSE.length).replace(/^\s+/, '');
  }
  return rest === '';
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
