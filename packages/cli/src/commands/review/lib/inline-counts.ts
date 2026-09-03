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

import {
  FINDING_BASELINES,
  FINDING_DIRECTIONS,
} from '@qwen-code/qwen-code-core/tools/report-findings.js';
import { LEDGER_ID_READBACK } from './ledger.js';

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
 */
export function markerStrippedBody(body: string): string | null {
  const sev = severityOf({ body });
  if (!sev) return null;
  const marker = sev === 'critical' ? CRITICAL_PREFIX : SUGGESTION_PREFIX;
  return body
    .replace(LEADING_INVISIBLE_RE, '')
    .slice(marker.length)
    .replace(LEADING_INVISIBLE_RE, '')
    .replace(/^\s*[:：]?\s*/, '');
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

/**
 * The fix-induced marking, read from the head of the CLAIM — after the id
 * and its separator, never inside the id grammar. Case-insensitive, and
 * tolerant of inner spacing, because it governs only whether a comment
 * counts as first-time work — never which finding it is.
 */
export const FIX_INDUCED_READBACK = /^\(\s*fix-induced\s*\)[:.,-]?\s*/i;

// Built from the core lists, never spelled a fourth time: a value added
// there that this tokeniser did not know would stop the head scan at the
// unknown bracket, hide a carried id behind it, and read the tag as prose.
const HEAD_AXIS_TAG_RE = new RegExp(
  `^\\[(${[...FINDING_DIRECTIONS, ...FINDING_BASELINES].join('|')})\\]\\s*`,
  'i',
);
const HEAD_SOURCE_TAG_RE = /^\[(build|test|probe)\]\s*/i;

/** What a claim line's head slot carries — see `readClaimHead`. */
export interface ClaimHead {
  /** The carried ledger id, wherever in the head slot it sits. */
  id?: string;
  /** The `(fix-induced)` marking — honoured only beside a carried id. */
  fixInduced: boolean;
  /** The axis tags in the slot, lower-cased, in order; duplicates kept. */
  axes: string[];
  /** The deterministic source tag in the slot, lower-cased. */
  source?: 'build' | 'test' | 'probe';
  /** The source tag's verbatim token (trailing whitespace included). */
  sourceText?: string;
  /** The claim past the head slot. */
  title: string;
  /**
   * The line with ONLY the axis tags removed — id, marking, source tag and
   * title all where they were — for the readers that anchor an id at `^`.
   */
  stripped: string;
  /**
   * The line with the id, the marking and the axis tags removed — the
   * source tag and the title where they were: the ledger's title, which
   * keeps a deterministic tag as the finding's own text.
   */
  claim: string;
}

/**
 * The claim line's HEAD SLOT: the contiguous run of machine tokens the
 * posting contract puts before the title — a carried id (`R7-2:`), the
 * `(fix-induced)` marking, the deterministic source tag (`[probe]`) and the
 * two axis tags (`[fails-closed] [new-surface]`, #10291) — in any order,
 * ending at the first token that is none of them.
 *
 * The ONE statement of that grammar. Every reader that anchors on the id or
 * acts on the axes goes through here, so a title that merely QUOTES a tag
 * in its prose — natural when the review target is the review pipeline
 * itself — is never read as a classification, and a tag placed before the
 * id never hides the id from an anchored readback: the axis read and the
 * axis strip share one window, the slot, not the line and not the body.
 */
export function readClaimHead(line: string): ClaimHead {
  let rest = line.trim();
  let id: string | undefined;
  let marked = false;
  const axes: string[] = [];
  let source: ClaimHead['source'];
  let sourceText: string | undefined;
  // Two projections, kept in step token by token: `stripped` keeps every
  // head token but the axis tags, `claim` keeps only the source tag.
  const stripped: string[] = [];
  const claim: string[] = [];
  for (;;) {
    if (id === undefined) {
      const m = LEDGER_ID_READBACK.exec(rest);
      if (m) {
        id = m[1];
        stripped.push(m[0]);
        rest = rest.slice(m[0].length);
        continue;
      }
    }
    // Only ever a marking on a CARRIED id: on a fresh finding there is no
    // entry for the defect to have been induced by, so the token is prose.
    // Anywhere in the slot past the id — a source tag between the two is
    // the one placement the old head-anchored read missed.
    if (id !== undefined) {
      const f = FIX_INDUCED_READBACK.exec(rest);
      if (f) {
        marked = true;
        stripped.push(f[0]);
        rest = rest.slice(f[0].length);
        continue;
      }
    }
    const a = HEAD_AXIS_TAG_RE.exec(rest);
    if (a) {
      axes.push(a[1].toLowerCase());
      rest = rest.slice(a[0].length);
      continue;
    }
    if (source === undefined) {
      const s = HEAD_SOURCE_TAG_RE.exec(rest);
      if (s) {
        source = s[1].toLowerCase() as ClaimHead['source'];
        sourceText = s[0];
        stripped.push(s[0]);
        claim.push(s[0]);
        rest = rest.slice(s[0].length);
        continue;
      }
    }
    break;
  }
  return {
    ...(id === undefined ? {} : { id }),
    fixInduced: marked,
    axes,
    ...(source === undefined ? {} : { source, sourceText }),
    title: rest.trim(),
    stripped: (stripped.join('') + rest).trim(),
    claim: (claim.join('') + rest).trim(),
  };
}
