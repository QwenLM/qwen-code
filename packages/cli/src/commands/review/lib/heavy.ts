/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PathKind } from './diff-plan.js';

/**
 * Heaviness thresholds.
 *
 * Only `source` files qualify. The invariant checklist is about a long-lived
 * stateful object — its fields, timers, collections, error taxonomy. A test
 * file, a lockfile, and a page of prose have none of that, and three whole-file
 * agents on one would be spent for nothing.
 *
 * A file must already have existed at some real size (`HEAVY_MIN_PRE_LINES`) —
 * a brand-new file has `rewriteRatio` 1.0 by definition but is not a *rewrite*,
 * and its chunk agents already own every line of it. On top of that it must be
 * either mostly-new (`HEAVY_REWRITE_RATIO`) or changed in sheer volume
 * (`HEAVY_CHANGED_LINES`), which catches a big edit to a very large file whose
 * ratio stays low.
 */
const HEAVY_MIN_PRE_LINES = 300;
const HEAVY_REWRITE_RATIO = 0.4;
const HEAVY_CHANGED_LINES = 800;

/**
 * Pure heaviness rule, kept free of git so it can be tested on its own.
 *
 * The threshold is compared against the **exact** ratio; only the reported
 * `rewriteRatio` is rounded to 2dp. Rounding first would smear the boundary —
 * 399/1000 rounds to 0.40 and would clear a 0.40 threshold it does not meet.
 */
export function classifyHeavy(input: {
  preLines: number;
  fileLines: number;
  changedLines: number;
  binary: boolean;
  kind: PathKind;
}): { rewriteRatio: number; heavy: boolean } {
  const { preLines, fileLines, changedLines, binary, kind } = input;
  const exactRatio = fileLines > 0 ? changedLines / fileLines : 0;
  const heavy =
    !binary &&
    kind === 'source' &&
    // A deletion clears the volume threshold trivially but has no post-image,
    // and the whole-file invariant agents are told to read exactly that.
    fileLines > 0 &&
    preLines >= HEAVY_MIN_PRE_LINES &&
    (exactRatio >= HEAVY_REWRITE_RATIO || changedLines >= HEAVY_CHANGED_LINES);
  return { rewriteRatio: Math.round(exactRatio * 100) / 100, heavy };
}
