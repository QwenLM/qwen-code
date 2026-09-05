/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import {
  getStartupContextLength,
  isSystemReminderContent,
} from '../core/environmentContext.js';
import { isClearedMediaPlaceholder } from './microcompaction/microcompact.js';

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
   * entry once serialized; resolving that collision is what prompt identity
   * (`findApiHistoryPromptIndex`) is for.
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
