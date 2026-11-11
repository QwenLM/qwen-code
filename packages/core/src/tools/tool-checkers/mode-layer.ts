/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a checker cannot resolve on mode's behalf.
 *
 * Mode semantics live in one place — the session permission manager's mode
 * definitions. The only mode-related fact a checker states is that its prompt is
 * the tool itself: no mode may silently skip it, because what the dialog collects
 * has no other source. This helper is that shared predicate.
 */

import { isManagedAsk, type ToolPermissionResult } from './rule-precedence.js';

/** Shown when a mode that never prompts has to refuse instead. */
export const DONT_ASK_REJECT_MESSAGE =
  'This action needs approval, and the "Don\'t ask" permission mode does not prompt. Switch modes to approve it.';

/**
 * Whether the tool or a managed rule requires a person to answer.
 * The check states this in its attribution; mode changes cannot supply an answer.
 */
export function isUnskippable(
  ask: Extract<ToolPermissionResult, { kind: 'ask' }>,
): boolean {
  return ask.reason.attribution.type === 'interaction' || isManagedAsk(ask);
}
