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

/** The footer naming the reviewing model and the CLI version it ran under. */
export function reviewFooter(modelId: string, cliVersion: string): string {
  return `_— ${modelId} via Qwen Code /review (v${cliVersion})_`;
}

/**
 * One or more trailing footers, with the whitespace around them.
 *
 * The leading `\s*` sits OUTSIDE the repeated group so each run of
 * whitespace has exactly one owner. With it inside the group, the run
 * between two footers could be split across iterations arbitrarily; when the
 * trailing `$` then failed (a footer run followed by ordinary text — the
 * natural output of a model looping on the same comment) the engine
 * enumerated all those splits before giving up, growing ~27x per footer
 * on the model-authored bodies this regex strips.
 */
export const REVIEW_FOOTER_RE =
  /\s*(?:_— [^\n]* via Qwen Code \/review(?: \(v[^\n)]*\))?_\s*)+$/;
