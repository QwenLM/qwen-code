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
const FOOTER_MARKER = 'via Qwen Code /review';

/**
 * The footer naming the reviewing model and the CLI version it ran under.
 *
 * The guard lives HERE, not at one of the two call sites: `submit`
 * interpolates the footer into inline comments before `compose-review`
 * validates the state, so a check that only the compose path runs is an
 * ordering fact two hops away from the interpolation it protects.
 */
export function reviewFooter(modelId: string, cliVersion: string): string {
  if (!isFooterSafeModelId(modelId)) {
    throw new TypeError(
      'review footer: modelId is interpolated into the footer verbatim — ' +
        'it must be a single line of at most 200 characters that does not ' +
        'contain the footer marker',
    );
  }
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
 * Both character tokens are BOUNDED — 200 chars before the marker, 100
 * inside the version, the caps `CANONICAL_LGTM_RE` applies to the same two
 * parts. An unbounded `[^\n]` had the engine backtracking from every `_— `
 * to the end of the line — quadratic in body length on `_— `-littered
 * bodies even with no footer anywhere (measured ~5 s at 130 KB); the bound
 * caps that work per start position. The residual is a failed match over a
 * run of REAL footers followed by text: quadratic in the footer count,
 * because each footer's start re-matches the tail before failing — bounded
 * to seconds by GitHub's ~65 KB comment cap, never exponential.
 *
 * The closing `_` is optional because a looping model truncates the forged
 * footer it cuts off mid-character, and an unstripped unclosed copy would
 * post as a duplicate attribution line above the canonical one; the
 * version's closing paren is optional for the same reason. A forged version
 * that carries its own `)` still escapes — the clause stops at the first
 * paren — but a canonical one cannot, because both call sites route their
 * version through `footerVersion`, which refuses it.
 */
export const REVIEW_FOOTER_RE =
  /\s*(?:_— (?:(?! via Qwen Code \/review)[^\n]){0,200} via Qwen Code \/review(?: \(v[^\n)]{0,100}\)?)?_?\s*)+$/;

/**
 * A modelId the footer can interpolate. The footer is one line, and the
 * strip regex anchors on the marker: a modelId carrying a newline or the
 * marker itself builds a footer the strip cannot remove on a second pass, so
 * a re-compose loop would accumulate attribution lines instead of
 * normalizing to one. The 200-char cap is where the strip regex and
 * `CANONICAL_LGTM_RE` stop matching the model part — a longer modelId
 * builds a footer neither can remove or filter.
 */
export function isFooterSafeModelId(modelId: string): boolean {
  return (
    modelId.length <= 200 &&
    !/[\n\r]/.test(modelId) &&
    !modelId.includes(FOOTER_MARKER)
  );
}

/**
 * The shape of a version the footer can carry, bounded to 100 chars like
 * the version part of the strip regex and `CANONICAL_LGTM_RE`.
 *
 * The stamp rides an environment variable any wrapper can set; a value with
 * a newline or a `)` (both stop the strip regex early) would build a footer
 * the strip cannot remove on a second pass. Anything but the shape of a real
 * package version yields undefined so the caller falls back to its own
 * version.
 */
const FOOTER_VERSION_RE = /^[A-Za-z0-9._+-]{1,100}$/;

/**
 * The startup-version stamp, when the footer can carry it.
 */
export function footerVersion(stamp: string | undefined): string | undefined {
  return stamp !== undefined && FOOTER_VERSION_RE.test(stamp)
    ? stamp
    : undefined;
}

/**
 * The strip, as the one shared entry point: bodies without the marker
 * return untouched — the regex never runs on them — and everything else
 * goes through `REVIEW_FOOTER_RE`. Both strip sites used to carry their
 * own `.replace`; the fast path belongs to the shape's owner.
 */
export function stripReviewFooters(body: string): string {
  return body.includes(FOOTER_MARKER)
    ? body.replace(REVIEW_FOOTER_RE, '')
    : body;
}
