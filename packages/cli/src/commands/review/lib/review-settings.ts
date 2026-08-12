/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { loadSettings } from '../../../config/settings.js';

export interface OperatorReviewSettings {
  attribution: boolean;
  comment: boolean;
  /**
   * The raw `review.effort` value when set — still `'auto'`, and settings
   * loading performs no per-value enum validation, so possibly not a level
   * at all. Callers normalize.
   */
  effort?: string;
}

/**
 * The `review.*` policy settings resolved from operator-controlled scopes
 * only (system defaults → user → system). The workspace scope is excluded
 * because `.qwen/settings.json` is repository-controlled content that the
 * review reads: a repository must not decide, for every reviewer who opens
 * it, whether findings publish (`comment`), whether the posted review names
 * its model (`attribution`), or how deeply the pipeline verifies (`effort`).
 */
export function operatorReviewSettings(): OperatorReviewSettings {
  const review = loadSettings(undefined, { skipWorkspaceSettings: true }).merged
    .review;
  // Settings loading performs no per-value type validation — the inferred
  // `boolean` types do not hold for hand-edited files (`"false"` as a quoted
  // string is the classic mistake), so each value is re-checked here. A
  // non-boolean `attribution` falls back to the schema default (on); a
  // non-boolean `comment` never enables auto-posting.
  return {
    attribution:
      typeof review?.attribution === 'boolean' ? review.attribution : true,
    comment: review?.comment === true,
    effort: typeof review?.effort === 'string' ? review.effort : undefined,
  };
}
