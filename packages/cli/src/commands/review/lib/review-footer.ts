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

/**
 * The invisible marker every attribution-OFF inline comment carries instead
 * of the footer. Renders as nothing on GitHub; it is the one signal that
 * survives the prefix strip and the footer removal, so `presubmit` can still
 * recognize earlier posts for dedup — from ANY account, not just the
 * reviewing one. Deliberately not added when attribution is on: the footer
 * already identifies those posts, and a second marker is noise.
 */
export const COMMENT_MARKER = '<!-- qwen-review -->';

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

/**
 * Strip trailing footers when present, and nothing else.
 *
 * Guarded on the marker: the strip regex opens `\s*` under an unanchored
 * search, which scans quadratically on a long whitespace run in a body that
 * carries no footer at all — and these bodies are model-written with no
 * length cap (measured ~20 s at 80k characters). A body without the marker
 * cannot match the regex, so it returns unchanged without running it. Shared
 * by both strip sites — `compose-review`'s drafted entries and `submit`'s
 * inline comments — because one guard is one guard, and a second copy is how
 * one site eventually forgets it.
 */
export function stripReviewFooter(body: string): string {
  return body.includes(FOOTER_MARKER)
    ? body.replace(REVIEW_FOOTER_RE, '')
    : body;
}

/**
 * Footer-shaped LINES anywhere in the body — the strip for the
 * attribution-off leg. `stripReviewFooter` is trailing-anchored on purpose:
 * a footer followed by ordinary text is the model looping on the same
 * comment, and under attribution-on the canonical footer that follows makes
 * the surviving forged line redundant-but-harmless. Under attribution-off
 * that surviving line is the ONLY attribution the post carries — the exact
 * signal the mode exists to remove — so it goes regardless of position.
 * Whole lines only: the marker substring inside ordinary prose is not a
 * footer. Linear by construction: the literal `_— ` prefix bounds the
 * engine's start positions and `[^\n]` cannot cross a line.
 */
const FORGED_FOOTER_LINE_RE =
  /\n?[ \t]*_— [^\n]* via Qwen Code \/review(?: \(v[^\n)]*\))?_[ \t]*(?=\n|$)/g;

export function stripForgedFooterLines(body: string): string {
  if (!body.includes(FOOTER_MARKER)) return body;
  return body
    .replace(FORGED_FOOTER_LINE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
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
