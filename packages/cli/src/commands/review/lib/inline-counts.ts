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
} from '@qwen-code/qwen-code-core';
import { LEDGER_ID_READBACK, canonicalLedgerId } from './ledger.js';

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
//
// The token admits exactly ONE parse per residue run, so a
// `RESIDUE*[:：]` quantification stays linear when the colon is absent —
// otherwise the failed colon makes the engine enumerate every
// decomposition of the run, and `stripSeverityPrefix` (every stamped
// GitHub submit, every attribution-off post) wedges synchronously on a
// draft its own gates accept. Both ambiguities are closed: the comment
// alternative's inner loop cannot cross a `-->` (the lazy
// `[\s\S]*?(?:-->|$)` form let one token stretch across the comments
// after it — #9940 review R14-1), and whitespace and format characters
// share ONE class, because `\s` and `\p{Cf}` overlap — U+FEFF is in
// both, the only such codepoint, and as two alternatives it gave a FEFF
// run the same 2^N decompositions (#9940 review R18-1). The merged class
// accepts the identical codepoint set: a character matches it once or
// not at all.
const INVISIBLE_RESIDUE = String.raw`(?:[\s\p{Cf}]|<!--(?:(?!-->)[\s\S])*(?:-->|$))`;

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
 * The separator a marker can trail: residue, an optional colon, residue
 * again — the acceptance the readback projection (`markerStrippedBody`)
 * applies after each marker, so the two marker-strip fixpoints agree on
 * what a stacked-marker run hides. Residue is consumed only when the
 * colon is present: residue before PLAIN content is model text the post
 * keeps (the stamp lands before it), while residue around a separator
 * colon is machine grammar. A `[ \t]`-only colon stopped at the newline
 * the readback's `\s` colon consumed — a newline-then-colon stacked
 * draft read back as carrying its id while the attribution-off post led
 * with `\n:\n…`, a root no later readback could match (#9940 review).
 */
const MARKER_SEPARATOR_RE = new RegExp(
  String.raw`^(?:${INVISIBLE_RESIDUE}*[:：]${INVISIBLE_RESIDUE}*|[ \t]*)`,
  'u',
);

/**
 * The line breaks inside a run of render-nothing residue that sit OUTSIDE
 * its HTML comments — the breaks the rendered page has. A break inside a
 * comment stays render-invisible (the comment spans it), so it is not a
 * new rendered line. Stated once for every reader that asks "does this
 * residue move the content to a later line": the stamp's skip, the
 * indented-code test below.
 */
export function residueLineBreaks(
  residue: string,
): Array<{ index: number; length: number }> {
  // One ordered walk over both lists — a break-by-span scan was quadratic
  // on a body of thousands of one-line comments (#9940 review, audit).
  const spans = [...residue.matchAll(/<!--[\s\S]*?(?:-->|$)/g)];
  const out: Array<{ index: number; length: number }> = [];
  let i = 0;
  for (const m of residue.matchAll(/\r\n?|\n/g)) {
    while (
      i < spans.length &&
      spans[i]!.index + spans[i]![0].length <= m.index
    ) {
      i++;
    }
    const span = spans[i];
    if (span !== undefined && span.index <= m.index) continue;
    out.push({ index: m.index, length: m[0].length });
  }
  return out;
}

/**
 * The text with every HTML comment replaced by spaces of the same length —
 * positions preserved, so an index found in the masked text addresses the
 * original. For the reads that must not see grammar INSIDE a comment: a
 * severity marker or a separator colon quoted in one is comment content,
 * not a marker or a separator (#9940 review, audit).
 */
export function maskHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => ' '.repeat(m.length));
}

/**
 * The separator after a severity marker, split for the strip: `strip` is
 * how much of `afterLead` (the text after the marker and its leading
 * residue) the strip removes, and `codeKept` says an indented code block
 * follows — the separator colon, a block boundary, then four columns of
 * indentation. There the strip keeps the last line's indentation: the
 * block is the content's structure, not separator grammar, and a strip
 * that swallowed it posted the block's first line as prose (the
 * attribution-off exit) or read it as the claim (the marked leg) while the
 * stamp kept the block (#9940 review, audit). Without the boundary the
 * indented line is a lazy continuation — prose — on every projection, so
 * the whole separator goes.
 */
export function separatorStrip(
  afterMarker: string,
  /**
   * Whether the marker's own line is an HTML block (a comment opens it up
   * to three columns in): that line is no paragraph, so the line after it
   * is never a lazy continuation — an indented one is a code block.
   */
  markerLineIsHtmlBlock = false,
): {
  strip: number;
  codeKept: boolean;
} {
  const separator = MARKER_SEPARATOR_RE.exec(afterMarker)?.[0] ?? '';
  const colonAt = separatorColonAt(separator, markerLineIsHtmlBlock);
  // With no colon the residue before the content is the separator only
  // where it carries a line break: the soft break and the continuation
  // indentation after it go (a lazy continuation folds onto the marker
  // line), while a block boundary and four columns is an indented code
  // block of the content's own, kept. Same-line residue with no colon is
  // model text the post keeps — only spaces and tabs go.
  const run =
    colonAt === -1
      ? (LEADING_INVISIBLE_RE.exec(afterMarker)?.[0] ?? '')
      : separator.slice(colonAt + 1);
  const base = colonAt === -1 ? 0 : colonAt + 1;
  // The run's first line is the COLON's line when a colon precedes it: the
  // marker line's HTML-block-ness seeds the walk only while the colon sits
  // on the marker line; a colon on a later line is that line's visible
  // text — a paragraph line unless a comment leads it (an HTML block that
  // ends on the line carrying its `-->`), and an indented line under a
  // paragraph line is its lazy continuation, not code — so the seed is the
  // walk's own state after the residue before the colon (#9940 review,
  // round 29).
  const boundaryBefore = scanResidue(
    separator.slice(0, base),
    markerLineIsHtmlBlock,
  ).boundary;
  const codeAt = codeBlockStartIn(run, boundaryBefore);
  if (codeAt !== -1) return { strip: base + codeAt, codeKept: true };
  // "Same line" is physical: a comment there that spans a break would,
  // once the marker before it is gone, lead its line as an HTML block that
  // ends on that first line and re-shape the line after it into a block of
  // its own (indented: code) — the residue goes with the rest of the run
  // (#9940 review, round 29 audit).
  if (colonAt === -1 && !/\r\n?|\n/.test(run)) {
    return {
      strip: /^[ \t]*/.exec(afterMarker)?.[0].length ?? 0,
      codeKept: false,
    };
  }
  return { strip: base + residueStripLength(run), codeKept: false };
}

/**
 * Where the separator colon sits in a separator run, or -1: the search runs
 * with comments masked (a colon quoted in one is comment content), and a
 * colon on an indented code line behind a block boundary is code, not the
 * separator — `\n\n    : colon-led` is a code block whose text starts with
 * a colon (#9940 review, audit 5).
 */
export function separatorColonAt(
  separator: string,
  /** Whether the marker's own line is an HTML block — see `separatorStrip`. */
  boundaryBefore = false,
): number {
  const colonAt = maskHtmlComments(separator).search(/[:：]/);
  if (colonAt === -1) return -1;
  // A colon on, or after, an indented code block the residue opened is
  // content — the block's first character, or a paragraph after the block
  // — never the separator (#9940 review, round 28: the same boundary state
  // `codeBlockStartIn` keeps, the marker line's HTML-block-ness included).
  return codeBlockStartIn(separator.slice(0, colonAt), boundaryBefore) === -1
    ? colonAt
    : -1;
}

/**
 * Where an indented code block begins inside a run of residue, or -1: the
 * offset just past a line break that follows a block boundary and leads a
 * line of four or more columns — the residue's own last line (the
 * indentation the content sits on), or an earlier comment LINE at four
 * columns, which is visible code, not render-nothing residue (a quoted
 * `    <!-- qwen-review -->` line vanished from the attribution-off post)
 * (#9940 review, audit 6).
 */
export function codeBlockStartIn(run: string, boundaryBefore = false): number {
  return scanResidue(run, boundaryBefore).codeAt;
}

/**
 * The block structure of a run of residue, walked over its PHYSICAL lines
 * from the state of the line the run starts on: `codeAt` is where an
 * indented code block begins (-1: nowhere), `boundary` whether an indented
 * line after the run's last line would be one.
 *
 * The boundary is the state SINCE the last paragraph line: a line that is
 * neither blank nor an HTML block (a format character or NBSP alone is
 * text) opens a paragraph, and an indented line after it is that
 * paragraph's lazy continuation — a boundary seen earlier does not survive
 * it (#9940 review, round 28). A comment up to three columns in opens an
 * HTML block that runs to the first line containing `-->` — the opener's
 * own line included — and every line of it is the block's; but a comment
 * that opens LATER on a line hides no break: the block that line was, if
 * any, closed on it, and the lines the comment runs on are lines of their
 * own — a paragraph line under an already-closed block, a blank line, a
 * fresh block — which the comment-span view `residueLineBreaks` takes
 * misread as one HTML-block line (#9940 review, round 29 audit).
 */
function scanResidue(
  run: string,
  boundaryBefore: boolean,
): { codeAt: number; boundary: boolean; lastIsCode: boolean } {
  const breaks = [...run.matchAll(/\r\n?|\n/g)];
  // Blank by CommonMark's rule — spaces and tabs only. `trim()` also eats
  // an NBSP or a BOM, and a line of those under a boundary is an indented
  // code line, not a paragraph line (#9940 review, round 29 audit).
  const blank = (line: string) => /^[ \t]*$/.test(line);
  let boundary = boundaryBefore;
  let inBlock = false;
  let inCode = false;
  let codeAt = -1;
  let lastIsCode = false;
  for (let i = 0; i < breaks.length; i++) {
    const start = breaks[i]!.index + breaks[i]![0].length;
    const last = i === breaks.length - 1;
    const segment = run.slice(start, last ? run.length : breaks[i + 1]!.index);
    // The run's last line is the indentation the CONTENT sits on — never
    // blank, whatever follows it.
    const indented = indentColumns(segment) >= 4 && (last || !blank(segment));
    if (inCode) {
      // A code block runs on through indented lines (and blank ones — a
      // boundary that re-opens it, the same state either way); a line under
      // four columns with text ends it.
      if (indented) {
        if (last) lastIsCode = true;
        continue;
      }
      inCode = false;
    }
    if (inBlock) {
      if (segment.includes('-->')) {
        inBlock = false;
        boundary = true;
      }
      continue;
    }
    if (boundary && indented) {
      if (codeAt === -1) codeAt = start;
      inCode = true;
      if (last) lastIsCode = true;
    } else if (!last && blank(segment)) {
      boundary = true;
    } else if (/^ {0,3}<!--/.test(segment)) {
      if (segment.includes('-->')) boundary = true;
      else inBlock = true;
    } else {
      boundary = false;
    }
  }
  return { codeAt, boundary, lastIsCode };
}

/**
 * Whether the line a marker sits on opens as an HTML block: the residue
 * before the marker, on the marker's own line, starts with a comment up to
 * three columns in (#9940 review, audit 6).
 */
export function markerLineOpensHtmlBlock(leading: string): boolean {
  // Physical lines: a comment that opens mid-line hides no break (see
  // `scanResidue`), and the marker's line is an HTML block's when a
  // comment-led line above it is still open on it (#9940 review, round 29
  // audit).
  const lines = leading.split(/\r\n?|\n/);
  let inBlock = false;
  for (const line of lines.slice(0, -1)) {
    if (inBlock) {
      if (line.includes('-->')) inBlock = false;
    } else if (/^ {0,3}<!--/.test(line) && !line.includes('-->')) {
      inBlock = true;
    }
  }
  return inBlock || /^ {0,3}<!--/.test(lines[lines.length - 1]!);
}

/**
 * How much of a separator's residue run the strip removes: all of it, except
 * that after the LAST line break only spaces and tabs go — a format
 * character or NBSP leading the content line is the line's own text (it
 * shields a `#` or `>` from opening a construct), and a comment there is a
 * line-leading HTML block; consuming them re-shaped the line the content
 * renders on (#9940 review, audit 5).
 */
function residueStripLength(run: string): number {
  const breaks = residueLineBreaks(run);
  if (breaks.length === 0) return run.length;
  const last = breaks[breaks.length - 1]!;
  const end = last.index + last.length;
  return end + (/^[ \t]*/.exec(run.slice(end))?.[0].length ?? 0);
}

/**
 * CommonMark's indentation of a line: spaces count one column, a tab
 * advances to the next multiple of four; counting stops at the first other
 * character. Four or more columns is an indented code block. The ONE
 * statement every indentation test applies — a character-counting test
 * (`/^(?: {4,}|\t)/`) disagreed with this on tab-mixed indents such as
 * `  \t`, and the two readback legs disagreed with each other (#9940
 * review, audit). The line model (`scanLines`) still counts characters —
 * its `code` class differs from this only on tab-mixed indents, and only
 * where the gate is more permissive.
 */
export function indentColumns(line: string): number {
  let columns = 0;
  for (const ch of line) {
    if (ch === ' ') columns += 1;
    else if (ch === '\t') columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

/**
 * Whether the content after a run of render-nothing residue begins as an
 * INDENTED CODE BLOCK: the residue puts the content at the start of a
 * rendered line (a break outside comments — or the residue opens the
 * body, `atLineStart`), and the spaces and tabs after that reach four
 * columns before anything visible (`indentColumns`). CommonMark renders
 * that line as an indented code block; no claim lives there, so a code
 * block that happens to start `R1-2:` is not a carried id — read as one, a
 * fresh finding was diverted into R1-2's thread as a re-post (#9940
 * review, audit).
 */
export function codeIndentedAfter(
  residue: string,
  atLineStart: boolean,
): boolean {
  // The residue's last line is the content's; the lines before it are
  // classified by the one walk (`scanResidue`) — from the document start
  // (a boundary; the first line is a line of its own, hence the break put
  // in front of it), or from the state of the paragraph line the residue
  // follows visible text on. A tail of four columns is code only under a
  // boundary or inside a code block a line above opened; under a
  // paragraph line — a format character alone — it is a lazy continuation
  // (#9940 review, round 29 audit).
  return atLineStart
    ? scanResidue(`\n${residue}`, true).lastIsCode
    : scanResidue(residue, false).lastIsCode;
}

/**
 * The claim line of a MARKER-LESS body — the attribution-off posted shape,
 * where the visible marker was stripped and the claim leads the first
 * rendered line — or null when no claim line exists there: the first
 * visible line is indented code. The ONE statement of the bare readback
 * leg, shared by the thread matcher and presubmit's carried-id extractor
 * so the two cannot drift (#9940 review, audit).
 */
export function bareClaimLine(body: string): string | null {
  const lead = LEADING_INVISIBLE_RE.exec(body)?.[0] ?? '';
  // The first rendered line is code when ANY line of the residue is — an
  // indented comment line, or an indented line of format characters — not
  // only when the content's own line is: the marked leg keeps the code
  // block from its first line and reads no claim off it, and the two legs
  // must agree (#9940 review, round 29 audit).
  if (codeBlockStartIn(`\n${lead}`, true) !== -1) return null;
  return body
    .slice(lead.length)
    .split(/\r\n?|\n/)[0]!
    .trim();
}

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
  if (typeof c?.body !== 'string') return null;
  const leading = LEADING_INVISIBLE_RE.exec(c.body)?.[0] ?? '';
  // A marker on an indented code line is code — an earlier comment quoted
  // as a code block, not this one's marker. Decided HERE, in the one
  // predicate every strip, readback and stamp consult, so none of them can
  // read a marker the others do not (#9940 review, audit 4 and 5).
  if (codeIndentedAfter(leading, true)) return null;
  const body = c.body.slice(leading.length);
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
  if (rest === null) return null;
  // The strip keeps the indentation of a content line that opens an
  // indented code block (see `markerStrippedBody`): that line is code,
  // not a claim — the empty claim line, like a marker-only body's.
  if (indentColumns(rest) >= 4) return '';
  return rest.split(/\r\n?|\n/)[0]!.trim();
}

/**
 * The WHOLE body past the severity marker (and the residue-and-colon
 * separator trailing it) — the multi-line form of the readback strip
 * above, and the same ONE statement: `carriedClaimLine` is its first
 * line, and the floor
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
    // At the fixpoint the readback reads past render-nothing residue the
    // post keeps (a same-line comment before the claim renders as nothing
    // either way); a kept code block returned above keeps its indentation.
    if (sev === null) return current.replace(LEADING_INVISIBLE_RE, '');
    const marker = sev === 'critical' ? CRITICAL_PREFIX : SUGGESTION_PREFIX;
    const leading = LEADING_INVISIBLE_RE.exec(current)?.[0] ?? '';
    const afterMarker = current.slice(leading.length + marker.length);
    // The separator after the marker — with or without a colon — goes;
    // an indented code block behind a block boundary keeps its indentation
    // (`separatorStrip`): the block is the content's structure, and
    // `carriedClaimLine` reads no claim off such a line (#9940 review,
    // audit). Kept code is content, not a further marker to strip.
    const { strip, codeKept } = separatorStrip(
      afterMarker,
      markerLineOpensHtmlBlock(leading),
    );
    current = afterMarker.slice(strip);
    if (codeKept) return current;
    // The residue stays between iterations — the NEXT marker's line is
    // classified on it (a comment leading that line makes it an HTML
    // block); stripping it here read the post's kept code block as prose
    // (#9940 review, round 28). The readback reads past render-nothing
    // residue at the fixpoint, below.
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
 * Both severity markers, wherever they sit — the projection the
 * marker-only test applies to a remainder before asking whether anything
 * is left (see `stripSeverityPrefix`).
 */
const MARKERS_RE = new RegExp(
  `${CRITICAL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${SUGGESTION_PREFIX.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  )}`,
  'g',
);

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
 *
 * The separator each marker trails matches the readback's acceptance
 * (`MARKER_SEPARATOR_RE`), so a draft the ledger reads as CARRIED posts
 * leading with the same claim the readback read (#9940 review).
 */
export function stripSeverityPrefix(body: string): string {
  let current = body;
  let stripped = false;
  let kept = false;
  for (;;) {
    // `severityOf` reads no marker off an indented code line — a body that
    // opens with one (an earlier comment quoted as code), or a kept block
    // the strip before left leading (#9940 review, audit 4).
    const severity = severityOf({ body: current });
    if (severity === null) break;
    stripped = true;
    const leading = LEADING_INVISIBLE_RE.exec(current)?.[0] ?? '';
    const prefix =
      severity === 'critical' ? CRITICAL_PREFIX : SUGGESTION_PREFIX;
    const afterMarker = current.slice(leading.length + prefix.length);
    // The separator after the marker goes; an indented code block behind
    // a block boundary keeps its indentation (`separatorStrip`) and is
    // content, not a further marker to strip.
    const { strip, codeKept } = separatorStrip(
      afterMarker,
      markerLineOpensHtmlBlock(leading),
    );
    current = afterMarker.slice(strip);
    if (codeKept) {
      kept = true;
      break;
    }
  }
  // A body that was nothing but markers and residue strips to the empty
  // string. Tested ONCE, at the fixpoint: testing the remainder after every
  // marker scanned the whole body per marker, and a run of twenty thousand
  // stacked markers took nine seconds (#9940 review, audit).
  //
  // A kept code block is visible by construction — a comment on a code
  // line is text — but "visible" is not "content": a body of a marker, a
  // blank line and an INDENTED marker kept the second one and posted a
  // comment whose only content is a bare machine marker rendered as code,
  // with `submit`'s renders-as-nothing refusal disarmed because the
  // remainder was non-empty. Projecting the markers out of the remainder
  // separates the two: a kept block holding real text (a quoted
  // `    <!-- qwen-review -->` line, `    const x = 1;`) still posts
  // (#9940 review, round 30).
  if (stripped && !kept && current.replace(ALL_INVISIBLE_RE, '') === '') {
    return '';
  }
  // The kept block is tested against a NARROWER projection — markers, the
  // separator grammar they trail (`MARKER_SEPARATOR_RE` accepts either
  // colon) and whitespace, never comments: a quoted `    <!-- c -->` line
  // is the code the audit-6 case exists to KEEP HERE, while
  // `\t**[Suggestion]**` and `\t**[Suggestion]**:` are the machine marker
  // this mode removes wearing an indent (#9940 review, round 30). What
  // this strip keeps and what `submit` agrees to post are two questions:
  // its renders-as-nothing gate is comment-blind and refuses a body whose
  // kept block is only a comment anyway. This function owes the readback
  // the truthful projection, not the gate's verdict.
  if (
    stripped &&
    kept &&
    current.replace(MARKERS_RE, '').replace(/[:：\s\p{Cf}]/gu, '') === ''
  ) {
    return '';
  }
  return current;
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
 * counts as first-time work — never which finding it is. The token is
 * stated ONCE, unanchored (`FIX_INDUCED_TOKEN_RE`): the readback anchors
 * it at the head slot, and the stamp removes it from a FRESH claim it
 * would otherwise promote into a marking (#9940 review, round 26).
 */
export const FIX_INDUCED_TOKEN_RE = /\(\s*fix-induced\s*\)[:.,-]?\s*/i;
export const FIX_INDUCED_READBACK = new RegExp(
  `^${FIX_INDUCED_TOKEN_RE.source}`,
  'i',
);

// Built from the core lists, never spelled a fourth time: a value added
// there that this tokeniser did not know would stop the head scan at the
// unknown bracket, hide a carried id behind it, and read the tag as prose.
// `(?!\()` — a bracket run followed by `(` is a markdown LINK, not a tag:
// a claim opening `[regression](https://…) shows the bug` had its link
// text read as an axis tag and stripped from both the claim and the
// ledger title, leaving a title that opens with a bare URL in parens
// (#9940 review, round 30).
const HEAD_AXIS_TAG_RE = new RegExp(
  `^\\[(${[...FINDING_DIRECTIONS, ...FINDING_BASELINES].join('|')})\\](?!\\()\\s*`,
  'i',
);
const HEAD_SOURCE_TAG_RE = /^\[(build|test|probe)\](?!\()\s*/i;

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
        // The one spelling every join compares (#9940 review, audit).
        id = canonicalLedgerId(m[1]!);
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
