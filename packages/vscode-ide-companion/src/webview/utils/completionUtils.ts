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
 * @returns true when the item represents the /skills command
 */
export function shouldOpenSkillsSecondaryPicker(item: CompletionItem): boolean {
  return item.type === 'command' && item.id === 'skills';
}
