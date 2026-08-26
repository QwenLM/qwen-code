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

// Render-nothing residue: whitespace, HTML comments, and Cf runs — what
// the render-nothing projection already removes. Invisible BETWEEN stacked
// markers on the rendered post, so the strip iteration skips it when
// re-classifying; otherwise it hides the second marker from the classifier
// and the loop converges with a bare machine marker intact. Stated once:
// the leading strip, the marker-only test, and the ledger's title read all
// project this same shape.
const INVISIBLE_RESIDUE = String.raw`(?:\s|<!--[\s\S]*?(?:-->|$)|\p{Cf})`;

/** Leading residue — stripped before classifying and re-stripping. */
export const LEADING_INVISIBLE_RE = new RegExp(`^${INVISIBLE_RESIDUE}+`, 'u');

/**
 * The marker-only test's projection: every residue token swept out,
 * globally. A `^…*$` quantification would NOT do — under the end anchor
 * the unterminated-comment alternative backtracks and swallows visible
 * text to reach `$`, reading `<!-- x -->text` as residue-only.
 */
const ALL_INVISIBLE_RE = new RegExp(INVISIBLE_RESIDUE, 'gu');

/**
 * Which severity marker a drafted comment opens with — or null for neither.
 *
 * The ONE statement of the predicate. The counter and the unmarked-scan each
 * restated it at first, and drift between restatements is exactly the
 * bug-class this file's header describes; every caller classifies through
 * here so the two can never disagree about what "marked" means.
 *
 * Classification runs on the same projection the post-time strip matches:
 * leading render-nothing residue is invisible BEFORE the marker on the
 * rendered post, so a gate that classified the raw bytes refused exactly
 * the drafts the strip is written and tested to accept, forcing a pointless
 * re-compose.
 */
export function severityOf(
  c: DraftedComment,
): 'critical' | 'suggestion' | null {
  const body =
    typeof c?.body === 'string' ? c.body.replace(LEADING_INVISIBLE_RE, '') : '';
  if (body.startsWith(CRITICAL_PREFIX)) return 'critical';
  if (body.startsWith(SUGGESTION_PREFIX)) return 'suggestion';
  return null;
}

/**
 * The claim line a marked finding leads with: the severity marker, any
 * colon/whitespace right after it, and every line past the first stripped.
 * Null when the body opens with neither marker — `submit` refuses to post an
 * unmarked finding, so an unmarked body is not a finding and has no claim
 * line to read back.
 *
 * The ONE statement of the readback strip. compose-review's ledger builder
 * and presubmit's carried-id extractor both feed this line to
 * `LEDGER_ID_READBACK`, so the no-marker decision and the slice order can no
 * longer drift between the write side and the read sides — the drift the
 * shared regex removed for the id half (#9212 review).
 *
 * The slice runs on the same projection the classifier admits: leading
 * render-nothing residue is invisible BEFORE the marker on the rendered
 * post, so slicing the raw bytes cut mid-marker; the same residue can sit
 * BETWEEN the marker and the carried id; and the separator admits both
 * colon widths — every shape `severityOf` and `stripSeverityPrefix`
 * accept, and a shape they accept must read back, not garble or null.
 */
export function carriedClaimLine(body: string): string | null {
  const rest = markerStrippedBody(body);
  return rest === null ? null : rest.split('\n')[0].trim();
}

/**
 * The WHOLE body past the severity marker (and any colon/whitespace right
 * after it) — the multi-line form of the readback strip above, and the same
 * ONE statement: `carriedClaimLine` is its first line, and the floor
 * enforcement's moved-record title is its collapsed whole. A second
 * restatement of the marker slice in either consumer is the drift class
 * this file's header exists to prevent. Null when the body opens with
 * neither marker.
 *
 * The strip iterates the WHOLE stacked marker run: a looping model drafts
 * stacked markers, and every strip that decides what POSTS iterates them to
 * a fixpoint (`stripSeverityPrefix`) — a readback that stopped at the first
 * marker hid a carried id behind the second, so the gate saw no re-post
 * while the Aone relocate leg carried the id standing (#9940 review).
 */
export function markerStrippedBody(body: string): string | null {
  if (severityOf({ body }) === null) return null;
  let current = body;
  for (;;) {
    const sev = severityOf({ body: current });
    if (sev === null) return current;
    const marker = sev === 'critical' ? CRITICAL_PREFIX : SUGGESTION_PREFIX;
    current = current
      .replace(LEADING_INVISIBLE_RE, '')
      .slice(marker.length)
      .replace(LEADING_INVISIBLE_RE, '')
      .replace(/^\s*[:：]?\s*/, '');
  }
}

/** How many drafted comments open with each severity marker. */
export function countInlineFindings(comments: readonly DraftedComment[]): {
  criticalsInline: number;
  suggestionsInline: number;
} {
  let criticalsInline = 0;
  let suggestionsInline = 0;
  for (const c of comments) {
    const severity = severityOf(c);
    if (severity === 'critical') criticalsInline++;
    else if (severity === 'suggestion') suggestionsInline++;
  }
  return { criticalsInline, suggestionsInline };
}

/**
 * The body with its leading severity markers removed — the shape an
 * attribution-off (`review.attribution: false`) run POSTS, applied by
 * `submit` after the verdict was counted from the marked payload.
 *
 * Iterative: a looping model can draft stacked markers
 * (`**[Critical]** **[Suggestion]** …`), and stripping only the first posts
 * the second — the bare machine marker the mode exists to remove. The
 * classification delegates to `severityOf` so "marked" keeps its ONE
 * statement. A body that is nothing but markers strips to the empty string;
 * `submit`'s consistency gate refuses exactly that shape before the post
 * transform runs, so an empty result never reaches GitHub.
 */
export function stripSeverityPrefix(body: string): string {
  let current = body;
  for (;;) {
    const severity = severityOf({ body: current });
    if (severity === null) return current;
    const visible = current.replace(LEADING_INVISIBLE_RE, '');
    const prefix =
      severity === 'critical' ? CRITICAL_PREFIX : SUGGESTION_PREFIX;
    const rest = visible
      .trimStart()
      .slice(prefix.length)
      .replace(/^[ \t]*[:：]?[ \t]*/, '');
    if (rest.replace(ALL_INVISIBLE_RE, '') === '') return '';
    current = rest;
  }
}

/**
 * The indices of drafted comments that open with NEITHER severity marker.
 *
 * `countInlineFindings` counts such a comment as nothing at all — which for
 * a verdict computation means a blocker written without its marker weighs zero.
 * Both boundaries refuse these outright instead: `compose-review` because
 * Step 6 is where the draft is still cheap to fix, and `submit` because the
 * skill's own re-compose instruction expects the set to churn after Step 6 —
 * a marker lost in that churn would otherwise reach the one boundary that
 * actually posts, and weigh zero there.
 */
export function unmarkedComments(
  comments: readonly DraftedComment[],
): number[] {
  const out: number[] = [];
  comments.forEach((c, i) => {
    if (severityOf(c) === null) out.push(i);
  });
  return out;
}
