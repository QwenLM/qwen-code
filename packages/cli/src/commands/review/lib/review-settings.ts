/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { loadSettings } from '../../../config/settings.js';
import { writeStderrLineSafe } from '../../../utils/stdioHelpers.js';

/** What every field reads as when the settings cannot be loaded at all. */
const SAFE_DEFAULTS: OperatorReviewSettings = {
  attribution: true,
  comment: false,
  effort: undefined,
  reverseAuditRounds: undefined,
  approachRounds: undefined,
  sandbox: undefined,
};

export interface OperatorReviewSettings {
  attribution: boolean;
  comment: boolean;
  /**
   * The raw `review.effort` value when set — still `'auto'`, and settings
   * loading performs no per-value enum validation, so possibly not a level
   * at all. Callers normalize.
   */
  effort?: string;
  /** The raw `review.severityFloor` value when set — same caveats as effort. */
  severityFloor?: string;
  /**
   * The raw `review.sandbox` value when set — `off` | `auto` | `required`,
   * unvalidated here for the same reason as the two above.
   *
   * Read through THIS loader on purpose: it skips the workspace scope, so a
   * repository cannot ship a `.qwen/settings.json` that switches off the
   * containment which exists to contain that repository's own code.
   */
  sandbox?: string;
  /**
   * The operator's reverse-audit round ceiling, when they set a real one.
   *
   * Only a positive integer survives; `0` (the schema default, meaning "not
   * set"), a fraction, a negative, a string and a `NaN` all read as absent,
   * because the difference between "the operator chose a number" and "the
   * operator chose nothing" is the whole meaning of this field — a garbled
   * value that fell through as `0` would otherwise read as a request for a
   * zero-round audit.
   *
   * Whether the number is *usable* is not decided here: this module reports
   * what the operator asked for, and `reviewBudget` decides what the plan's
   * topology can honour (it may only lower a tier, never raise it).
   */
  reverseAuditRounds?: number;
  /**
   * How many rounds a PR must reach before the review may say the approach
   * itself is the open question, when the operator sets a real number.
   *
   * Only a positive integer survives re-validation; anything else reads as
   * absent and the built-in default applies. Raising it makes the signal
   * later; a large value effectively silences it.
   */
  approachRounds?: number;
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
  // `loadSettings` throws a FatalConfigError when a settings file cannot be
  // READ (or its migration fails) — malformed JSON does not reach that path,
  // it is copied aside and recovered ("Never crash due to a corrupted settings
  // file"). An unreadable file is enough: this is read while a plan is being
  // captured, the review's first step, so the throw would end the whole review
  // over a permissions bit on a file none of these settings had to come from.
  // Degrade to the defaults instead and say so. Most of them are the
  // conservative side outright — attribution on, no auto-posting, no round
  // ceiling — so a review that loses those loses them toward doing more work
  // and writing nothing public. `effort` is the honest exception: dropping an
  // operator's `high` returns the built-in rule, which is medium on a local
  // target, so that one field can degrade to LESS work. It is disclosed on
  // stderr for exactly that reason rather than being silently absorbed.
  let review;
  try {
    review = loadSettings(undefined, { skipWorkspaceSettings: true }).merged
      .review;
  } catch (error) {
    // The SAFE writer, not the throwing one. `process.stderr.write` throws on
    // EPIPE or a closed fd, and this NOTE is incidental to the degrade — a
    // throw here would propagate out of the catch and end the review by the
    // very path added to stop a broken settings file from ending it.
    writeStderrLineSafe(
      `NOTE: review settings could not be loaded (${
        error instanceof Error ? error.message.split('\n')[0] : String(error)
      }); this review uses the defaults — attribution on, no auto-posting, no ` +
        `effort or round-cap override. Fix the settings file to restore them.`,
    );
    return { ...SAFE_DEFAULTS };
  }
  // Settings loading performs no per-value type validation — the inferred
  // `boolean` types do not hold for hand-edited files (`"false"` as a quoted
  // string is the classic mistake), so each value is re-checked here. A
  // non-boolean `attribution` falls back to the schema default (on); a
  // non-boolean `comment` never enables auto-posting.
  const rounds = review?.reverseAuditRounds;
  const approach = review?.approachRounds;
  return {
    attribution:
      typeof review?.attribution === 'boolean' ? review.attribution : true,
    comment: review?.comment === true,
    effort: typeof review?.effort === 'string' ? review.effort : undefined,
    severityFloor:
      typeof review?.severityFloor === 'string'
        ? review.severityFloor
        : undefined,
    sandbox: typeof review?.sandbox === 'string' ? review.sandbox : undefined,
    reverseAuditRounds:
      typeof rounds === 'number' && Number.isInteger(rounds) && rounds > 0
        ? rounds
        : undefined,
    approachRounds:
      typeof approach === 'number' && Number.isInteger(approach) && approach > 0
        ? approach
        : undefined,
  };
}
