/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Utility helpers for the /skills secondary completion picker.
 */

import type { CompletionItem } from '../../types/completionItemTypes.js';

/**
 * Prefix used to distinguish skill completion items from other commands.
 * For example, a skill named "code-review" gets item id "skill:code-review".
 */
export const SKILL_ITEM_ID_PREFIX = 'skill:';

/**
 * Check whether the current completion query is targeting the secondary
 * skills picker (i.e. the user typed "/skills " followed by optional text).
 *
 * @param query - The text after the "/" trigger character
 * @returns true when the query matches the "skills <filter>" pattern
 */
export function isSkillsSecondaryQuery(query: string): boolean {
  return /^skills\s+/i.test(query);
}

/**
 * Determine whether selecting this completion item should open the
 * secondary skills picker instead of sending the command immediately.
 *
 * @param item - The completion item the user selected
 * @param availableSkills - Skills advertised by the backend for the picker
 * @returns true when the item represents the /skills command and there are
 * available skills to show
 */
export function shouldOpenSkillsSecondaryPicker(
  item: CompletionItem,
  availableSkills: string[],
): boolean {
  return (
    item.type === 'command' &&
    item.id === 'skills' &&
    availableSkills.length > 0
  );
}

/**
 * Resolve which completion trigger (`@` or `/`), if any, is active immediately
 * before the cursor.
 *
 * A trigger only counts at a word boundary — the start of the input, or right
 * after a space/newline. A valid `@` takes precedence over `/` so that
 * path-like queries stay part of an `@` mention (e.g. `@src/components/Button`
 * is a single mention, not a slash command). Crucially, an `@` that is NOT at
 * a word boundary — for example inside an email like `foo@bar.com` — is not a
 * trigger at all, so we fall through and still evaluate a later `/`. Without
 * this, typing `foo@bar.com /he` would let the unrelated `@` suppress the
 * slash-command menu entirely.
 *
 * @param text - The full input text
 * @param cursorPosition - Cursor offset into `text` (already clamped to length)
 * @returns The active trigger's character, position, and the query following
 * it, or `null` when there is no valid trigger before the cursor.
 */
export function resolveCompletionTrigger(
  text: string,
  cursorPosition: number,
): { char: '@' | '/'; pos: number; query: string } | null {
  const textBeforeCursor = text.substring(0, cursorPosition);
  const lastAtMatch = textBeforeCursor.lastIndexOf('@');
  const lastSlashMatch = textBeforeCursor.lastIndexOf('/');

  const isAtWordBoundary = (pos: number): boolean =>
    pos === 0 || text[pos - 1] === ' ' || text[pos - 1] === '\n';

  let pos = -1;
  let char: '@' | '/' | null = null;
  if (lastAtMatch >= 0 && isAtWordBoundary(lastAtMatch)) {
    pos = lastAtMatch;
    char = '@';
  } else if (lastSlashMatch >= 0 && isAtWordBoundary(lastSlashMatch)) {
    pos = lastSlashMatch;
    char = '/';
  }

  if (pos < 0 || !char) {
    return null;
  }

  return { char, pos, query: text.substring(pos + 1, cursorPosition) };
}
