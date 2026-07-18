/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The inline finding counts, derived from the drafted comments — never accepted
// as numbers.
//
// A count handed over beside the thing it counts is a count that can disagree
// with it, and both directions have now happened on real runs: `submit` once
// took `criticalsInline` as a number and a run posted "Suggestions are inline"
// beside an empty comments array; then `compose-review` kept taking the numbers
// after `submit` stopped, and a dogfooded report-only run — which never reaches
// `submit`'s recount — moved its one Critical from the body list to an inline
// comment, dropped the count on the way, and `compose-review` printed
// `Verdict: Approve` over a Critical the report itself listed. One counting
// function, fed by the comments array both callers already hold.

/** The severity prefixes the skill mandates on every posted inline comment. */
export const CRITICAL_PREFIX = '**[Critical]**';
export const SUGGESTION_PREFIX = '**[Suggestion]**';

/** A drafted inline comment, as far as counting needs it. */
export interface DraftedComment {
  body?: unknown;
}

/** How many drafted comments open with each severity marker. */
export function countInlineFindings(comments: readonly DraftedComment[]): {
  criticalsInline: number;
  suggestionsInline: number;
} {
  let criticalsInline = 0;
  let suggestionsInline = 0;
  for (const c of comments) {
    const body = typeof c?.body === 'string' ? c.body.trimStart() : '';
    if (body.startsWith(CRITICAL_PREFIX)) criticalsInline++;
    else if (body.startsWith(SUGGESTION_PREFIX)) suggestionsInline++;
  }
  return { criticalsInline, suggestionsInline };
}

/**
 * The indices of drafted comments that open with NEITHER severity marker.
 *
 * `countInlineFindings` counts such a comment as nothing at all — which for a
 * verdict computation means a blocker written without its marker weighs zero.
 * The composer refuses these outright instead: at Step 6 the draft is still
 * cheap to fix, and a marker-less body is either a drafting mistake or a
 * finding trying to weigh less than it is.
 */
export function unmarkedComments(
  comments: readonly DraftedComment[],
): number[] {
  const out: number[] = [];
  comments.forEach((c, i) => {
    const body = typeof c?.body === 'string' ? c.body.trimStart() : '';
    if (
      !body.startsWith(CRITICAL_PREFIX) &&
      !body.startsWith(SUGGESTION_PREFIX)
    ) {
      out.push(i);
    }
  });
  return out;
}
