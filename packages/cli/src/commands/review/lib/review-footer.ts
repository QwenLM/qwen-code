/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The attribution footer every posted review carries, stated once.
//
// `compose-review` composes it into the verdict body and `submit` strips
// forged copies before appending the real one to each inline comment — two
// producers by construction, plus the regex that must match both. They used
// to be side-by-side template literals with nothing asserting they stayed in
// step: a wording edit to one leaves the strip regex unable to match the
// composed footer (duplicates posted) or the summary carrying one version
// while the comments carry another — the exact attribution skew the startup
// version stamp exists to eliminate. Same shape as `inline-counts.ts`, which
// this directory already shares between the same two commands.

/** The attribution marker the strip regex anchors on. */
export const FOOTER_MARKER = 'via Qwen Code /review';

/** The footer naming the reviewing model and the CLI version it ran under. */
export function reviewFooter(modelId: string, cliVersion: string): string {
  return `_— ${modelId} ${FOOTER_MARKER} (v${cliVersion})_`;
}

/**
 * One or more trailing footers, with the whitespace around them.
 *
 * Two invariants keep the match from exploding on the model-authored bodies
 * this regex strips, both against the same failure shape — a forged-footer
 * run the trailing `$` cannot match (footers followed by ordinary text is
 * the natural output of a model looping on the same comment): the leading
 * `\s*` sits OUTSIDE the repeated group, so the whitespace between two
 * footers has exactly one owner instead of being splittable across
 * iterations, and the guarded `[^\n]` cannot consume past another footer's
 * start, so a run of footers joined on ONE line parses exactly one way
 * instead of the 2^(N-1) partitions the engine otherwise enumerates before
 * giving up.
 *
 * The closing `_` is optional because a looping model truncates the forged
 * footer it cuts off mid-character, and an unstripped unclosed copy would
 * post as a duplicate attribution line above the canonical one.
 */
export const REVIEW_FOOTER_RE =
  /\s*(?:_— (?:(?! via Qwen Code \/review)[^\n])* via Qwen Code \/review(?: \(v[^\n)]*\))?_?\s*)+$/;

/** The widest slice `stripReviewFooter` runs the strip regex over. */
const STRIP_TAIL_LIMIT = 8192;

/**
 * Strip trailing footers when present, and nothing else.
 *
 * Bounded twice, because the strip regex opens `\s*` under an unanchored
 * search, which scans quadratically on a long whitespace run — and these
 * bodies are model-written with no length cap (measured ~20 s at 80k
 * characters). The marker guard returns marker-less bodies unchanged without
 * running the regex at all, but it cannot help a body that CONTAINS the
 * marker: a quoted or truncated forged footer is the natural output of the
 * model loop this strip exists for, and the replace still ran the unanchored
 * search over the whole body when no trailing footer matched (probe-measured
 * ~4× per doubling of the whitespace run). So the replace runs only over the
 * last STRIP_TAIL_LIMIT characters — the regex is `$`-anchored, so a match
 * can only live at the tail, and one footer is ~40 characters, which bounds
 * the strip to a few hundred accumulated footers, far past any real
 * re-compose loop. Bounding at the last marker occurrence does NOT work: the
 * whitespace run sits after the last marker line and stays inside that
 * bound. Shared by both strip sites — `compose-review`'s drafted entries and
 * `submit`'s inline comments — because one guard is one guard, and a second
 * copy is how one site eventually forgets it.
 */
export function stripReviewFooter(body: string): string {
  if (!body.includes(FOOTER_MARKER)) return body;
  const tail = body.slice(-STRIP_TAIL_LIMIT);
  const stripped = tail.replace(REVIEW_FOOTER_RE, '');
  return stripped === tail
    ? body
    : body.slice(0, body.length - tail.length) + stripped;
}

/**
 * A modelId the footer can interpolate. The footer is one line, and the
 * strip regex anchors on the marker: a modelId carrying a newline or the
 * marker itself builds a footer the strip cannot remove on a second pass, so
 * a re-compose loop would accumulate attribution lines instead of
 * normalizing to one.
 */
export function isFooterSafeModelId(modelId: string): boolean {
  return !/[\n\r]/.test(modelId) && !modelId.includes(FOOTER_MARKER);
}

/** The shape of a version the footer can carry. */
const FOOTER_VERSION_RE = /^[A-Za-z0-9._+-]+$/;

/**
 * The startup-version stamp, when the footer can carry it. The stamp rides
 * an environment variable any wrapper can set; a value with a newline or a
 * `)` (both stop the strip regex early) would build a footer the strip
 * cannot remove on a second pass. Anything but the shape of a real package
 * version yields undefined so the caller falls back to its own version.
 */
export function footerVersion(stamp: string | undefined): string | undefined {
  return stamp !== undefined && FOOTER_VERSION_RE.test(stamp)
    ? stamp
    : undefined;
}
