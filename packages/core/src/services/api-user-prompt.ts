/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import {
  getStartupContextLength,
  isSystemReminderContent,
  SYSTEM_REMINDER_OPEN,
  SYSTEM_REMINDER_CLOSE,
} from '../core/environmentContext.js';
import { isClearedMediaPlaceholder } from './microcompaction/microcompact.js';

// Envelope the background registries wrap a notification's `modelText` in
// (agents, monitors, shells, workflows, the dropped-notification tally).
// Same shape `turn-interruption.ts` keys on; see that file for the envelope's
// trust model (role-gated, emitter escaping not uniform).
const TASK_NOTIFICATION_OPEN = '<task-notification>';
const TASK_NOTIFICATION_CLOSE = '</task-notification>';

function isWrappedText(text: string, open: string, close: string): boolean {
  return text.startsWith(open) && text.trimEnd().endsWith(close);
}

/**
 * Whether `content` is a delivered automatic notification turn: every text
 * part is a per-turn `<system-reminder>` or a `<task-notification>` envelope,
 * and at least one part is an envelope.
 *
 * The reminder allowance is what separates this from the cold-projection trim
 * in `turn-interruption.ts`: a DELIVERED ACP notification turn lands in
 * history as one entry (`[...systemReminders, ...notificationParts]`), so
 * requiring bare envelopes only would miss every notification delivered while
 * plan mode / an output style / an active todo chain had a reminder attached.
 *
 * `excludeTextPart`'s any-part semantics cannot substitute here: a mid-turn
 * notification drain merges envelope parts into a GENUINE user message, and
 * that mixed entry must keep its rewind ordinal.
 */
function isDeliveredNotificationTurn(content: Content): boolean {
  let sawEnvelope = false;
  for (const part of content.parts ?? []) {
    if (!('text' in part) || typeof part.text !== 'string') return false;
    if (
      isWrappedText(part.text, TASK_NOTIFICATION_OPEN, TASK_NOTIFICATION_CLOSE)
    ) {
      sawEnvelope = true;
    } else if (
      !isWrappedText(part.text, SYSTEM_REMINDER_OPEN, SYSTEM_REMINDER_CLOSE)
    ) {
      return false;
    }
  }
  return sawEnvelope;
}

/**
 * Options for {@link isApiUserPrompt}.
 *
 * Rewind works by counting user prompts in the model history and cutting at
 * the n-th one. Each rewind surface used to carry its own copy of that
 * classifier, and the copies drifted: the ACP twin grew a todo-stop-guard
 * exclusion the TUI twin never got, and the TUI twin grew a cleared-media
 * exclusion the ACP twin must not have. Drift between them is its own
 * regression class — a boundary counted under one rule and applied under
 * another silently truncates the wrong turn.
 *
 * The two surviving differences are real, so they live here as options rather
 * than as separate implementations: a change to the shared part cannot land on
 * one surface only, and each divergence has to be opted into by name.
 */
export interface ApiUserPromptOptions {
  /**
   * Exclude entries whose only text is a microcompaction media-clear
   * placeholder (`[Old inline media cleared: …]`).
   *
   * TUI rewind sets this: `/compress-fast` rewrites a media-only user entry's
   * inlineData parts into text placeholders, and a media-only entry never
   * produced a visible TUI user turn, so counting it desynchronizes the API
   * prompt count from the UI turn count and truncates one turn early.
   *
   * ACP rewind must NOT set it: ACP maps against per-prompt file-history
   * snapshots, which ARE created for media-only prompts, so a cleared entry
   * still occupies an ordinal on that surface.
   *
   * Matching is on the FULL generated placeholder shape, so a genuine prompt
   * that merely begins with the prefix keeps counting. A prompt whose entire
   * text equals a generated placeholder is indistinguishable from a cleared
   * entry once serialized, and this classifier drops it — a known, still-open
   * limitation, pinned as a loud rewind block by `historyMapping.test.ts`.
   * Disambiguating it durably needs a structural sentinel on cleared parts;
   * the prompt-identity anchoring tracked in #9437 is the intended fix.
   */
  excludeClearedMediaPlaceholders?: boolean;

  /**
   * Exclude entries carrying a text part this predicate accepts.
   *
   * ACP rewind passes its todo-stop-guard classifier: the guard's synthetic
   * continuation prompts are injected as user entries but are not turns a
   * client can rewind to, so counting them would shift every ordinal.
   */
  excludeTextPart?: (text: string) => boolean;

  /**
   * Exclude delivered background-notification turns: user entries whose text
   * parts are all per-turn `<system-reminder>`s or `<task-notification>`
   * envelopes, with at least one envelope (#9608).
   *
   * ACP rewind sets this: the daemon's notification drain sends
   * `[...systemReminders, ...notificationParts]` as one user entry that never
   * produced a client-visible turn or a per-prompt file-history snapshot, so
   * counting it inflates the rewindable count and shifts every cut point
   * after it.
   *
   * The TUI must NOT set it: there, queued notifications ride into history
   * inside the next genuine user message's parts, and such a mixed entry
   * fails the every-part predicate and stays counted — matching the visible
   * UI turn count.
   *
   * Residual, shape-only: a genuine prompt whose entire text IS a bare
   * envelope (the user pasted one) is indistinguishable once serialized and
   * gets dropped — the same accepted limitation `turn-interruption.ts`
   * documents for its shape-based fallback. Dropping fails closed only at the
   * tail, where `findApiRewindCutPoint` walks off the end and rewind refuses
   * to resolve the turn; mid-history every later ordinal shifts down one, so
   * turn N resolves to turn N+1's entry — a silently late boundary that
   * leaves the targeted turn in place. Cron/loop turns carry user-authored
   * prompt text with no envelope, so shape cannot separate them from real
   * prompts; they keep counting pending #9608's marking design call.
   */
  excludeTaskNotifications?: boolean;
}

/**
 * The single classifier for "this API history entry is a user prompt", shared
 * by every rewind surface (TUI, OpenTUI, ACP).
 *
 * A user prompt is a `user` entry that is neither a tool result
 * (`functionResponse`) nor a structural `<system-reminder>` entry. A genuine
 * user turn that merely has a per-turn reminder prepended still has a
 * non-reminder prompt part, so it is NOT excluded.
 */
export function isApiUserPrompt(
  content: Content,
  options?: ApiUserPromptOptions,
): boolean {
  if (content.role !== 'user') return false;
  if (!content.parts || content.parts.length === 0) return false;

  if (content.parts.some((part) => 'functionResponse' in part)) return false;

  // Structural, not real user prompts: the startup prelude and the
  // mid-history MCP added-tool reminders. Counting them would shift the
  // truncation index and silently drop a real turn's context.
  if (isSystemReminderContent(content)) return false;

  if (
    options?.excludeTaskNotifications &&
    isDeliveredNotificationTurn(content)
  ) {
    return false;
  }

  const excludeTextPart = options?.excludeTextPart;
  if (
    excludeTextPart &&
    content.parts.some(
      (part) =>
        'text' in part &&
        typeof part.text === 'string' &&
        excludeTextPart(part.text),
    )
  ) {
    return false;
  }

  return content.parts.some((part) => {
    if (!('text' in part) || !part.text) return false;
    return !(
      options?.excludeClearedMediaPlaceholders &&
      isClearedMediaPlaceholder(part.text)
    );
  });
}

/**
 * Model-history cut point for rewinding to `turnIndex` (0-based): the index of
 * the entry that starts that turn, so truncating to it keeps everything
 * before the turn's prompt.
 *
 * `turnIndex <= 0` returns the end of the startup context — rewinding to the
 * first turn keeps only the prelude. Returns -1 when the history holds fewer
 * user prompts than requested, e.g. the target turn was absorbed by chat
 * compression.
 *
 * Two CLI-side walks are not yet delegated here and are near-twins of this
 * one, so a change to the walk semantics below — `includeCompressed`, a new
 * structural entry kind to skip, the -1 convention — has to be re-applied to
 * both or ink/OpenTUI rewind computes a different boundary than ACP for the
 * same history:
 *
 * - `computeApiTruncationIndex` (`ui/utils/historyMapping.ts`) walks UI items
 *   alongside the API history, so it cannot call this directly.
 * - `rewindApiCutPoint` (`ui/opentui/session-rewind-model.ts`) is 1-based and
 *   returns -1 for `occurrence <= 0`, where this function is 0-based and
 *   returns `startIndex` for `turnIndex <= 0`. They agree on the first turn
 *   only because nothing sits between the startup prelude and the first user
 *   prompt today.
 */
export function findApiRewindCutPoint(
  apiHistory: Content[],
  turnIndex: number,
  options?: ApiUserPromptOptions,
): number {
  const startIndex = getStartupContextLength(apiHistory, {
    includeCompressed: true,
  });
  if (turnIndex <= 0) return startIndex;

  let seen = 0;
  for (let index = startIndex; index < apiHistory.length; index++) {
    if (!isApiUserPrompt(apiHistory[index]!, options)) continue;
    if (seen === turnIndex) return index;
    seen += 1;
  }
  return -1;
}

/**
 * How many user prompts `apiHistory` holds after the startup context — the
 * number of turns a client may rewind to.
 */
export function countApiUserPrompts(
  apiHistory: Content[],
  options?: ApiUserPromptOptions,
): number {
  const startIndex = getStartupContextLength(apiHistory, {
    includeCompressed: true,
  });
  let count = 0;
  for (let index = startIndex; index < apiHistory.length; index++) {
    if (isApiUserPrompt(apiHistory[index]!, options)) count += 1;
  }
  return count;
}
