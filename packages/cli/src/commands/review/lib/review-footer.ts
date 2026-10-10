/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import MarkdownIt from 'markdown-it';

import { indentColumns, stripSeverityPrefix } from './inline-counts.js';

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
 * recognize earlier posts for dedup and `pr-context` can still promote an
 * unresolved Critical to the re-check section. The marker carries the
 * severity because the visible prefix that carried it is stripped in this
 * mode. Deliberately not added when attribution is on: the footer and the
 * visible prefix already identify and classify those posts.
 */
export const COMMENT_MARKER = '<!-- qwen-review -->';

/** The marker with the finding's severity — the shape `submit` posts. */
export function commentMarker(severity: 'critical' | 'suggestion'): string {
  return `<!-- qwen-review ${severity} -->`;
}

/** The trailing shape `submit` posts on attribution-off comments. */
const POSTED_MARKER_RE = /<!-- qwen-review (?:critical|suggestion) -->$/;

/**
 * The canonical attribution footer as it trails a one-line note — the
 * exact tail `normalizeInlineComments` appends, not "any italic line":
 * `_— <model> via Qwen Code /review (vX)_`. A permissive `_—[^\n]*_`
 * read a comment whose own second paragraph is italic prose as a ruling
 * note (#9940 review, round 31 reverse audit).
 */
const CANONICAL_FOOTER_TAIL =
  '\\r?\\n[ \\t\\r\\n]*_— (?:(?! via Qwen Code /review)[^\\r\\n\\u2028\\u2029])* via Qwen Code /review(?: \\(v[A-Za-z0-9._+-]{0,200}…?\\)?)?_';

/**
 * The trailing marker the thread lifecycle's `R<id> fixed by <what>` reply
 * carries — a NOTE the review bot posts inside a thread, not a finding.
 * Machine-recognisable so the autofix census can skip it (a round that
 * rules findings fixed and approves must not select the PR for a round
 * with nothing to address), and deliberately NOT the posted comment-marker
 * shape: `carriesCommentMarker` stays false on it, so presubmit reads no
 * carried id off the ruling (#9940 review, round 28).
 */
export const FIXED_RULING_MARKER = '<!-- qwen-review-fixed-ruling -->';

/**
 * The ruling note's posted SHAPE, anchored over the WHOLE body: the one
 * `submit` assembles as `${fixedRulingLine(id, by)} ${FIXED_RULING_MARKER}`
 * (the by-less `R<id> fixed` form included), plus the attribution footer
 * `normalizeInlineComments` appends under attribution on and nothing
 * else.
 *
 * Readers must match THIS, never the marker as a substring: the marker
 * string is public, a review of the file that defines it quotes it
 * verbatim, and a substring test demoted such a Critical out of the
 * blocker re-check (#9940 review, round 30). The autofix census applies
 * the same anchored shape from its own workflow-level env.
 *
 * Every whitespace class here is spelled out for the same reason the `by`
 * class is: `\s` is NOT the same set in the two engines — Oniguruma's
 * matches U+0085 and JS's does not, JS's matches U+FEFF and Oniguruma's
 * does not — and a note the census reads as a note while this side reads
 * it as a finding is dropped from the census with the finding inside it
 * (#9940 review, round 31 reverse audit).
 *
 * The `by` clause is spelled as an explicit not-a-line-break class rather
 * than `.`: jq's `[^\n]` admits `\r`, U+2028 and U+2029 while JS's `.`
 * does not, and the census must not DROP a comment this side counts — the
 * two dialects agree only when both name the same line breaks (#9940
 * review, round 31 reverse audit). On THIS side that class is a NO-OP —
 * without `s`, JS's `.` is already exactly it — so nothing here reddens
 * if it is loosened; what it buys is a spelling the census can copy, and
 * the cross-dialect cell over `RULING_CORPUS` is what holds the copy
 * honest. The footer tail names the same set for the same reason, and
 * THERE it is not a no-op: `[^\n]` inside a character class admits all
 * three, and a "footer" carrying a live finding after a `\r` read as a
 * note in both engines.
 *
 * The two whitespace runs after the marker must not OVERLAP. Spelled
 * `[ \t]*(?:tail)?[ \t\r\n]*$`, a run of spaces has no unique split and
 * the match is quadratic: the census dialect ABORTS (`retry-limit-in-match`)
 * and the scan step, running under `set -e`, fails whole. The trailing run
 * therefore starts at a line break (#9940 review, round 31 reverse audit).
 *
 * Anchored over the WHOLE body, not one line. `^` alone is only worth
 * anything while the severity marker leads the body: under
 * `review.attribution: false` the post strips it, and a Critical whose
 * claim line opens by quoting a ruling then matched and demoted itself.
 * Anchoring that LINE at both ends closed the opening quotation but not a
 * comment that quotes the whole note and then states its own finding
 * underneath — the natural way to say "this was ruled fixed last round
 * and is not" — which the census dropped wholesale, the live Critical
 * with it. A real note is the note and, under attribution on, its footer;
 * anything carrying further prose fails closed toward COUNTING (#9940
 * review, round 31).
 */
export const FIXED_RULING_SHAPE_RE = new RegExp(
  `^R\\d+-\\d+ fixed(?: by [^\\r\\n\\u2028\\u2029]*?)? ${FIXED_RULING_MARKER}[ \\t]*(?:${CANONICAL_FOOTER_TAIL}[ \\t]*)?(?:[\\r\\n][ \\t\\r\\n]*)?$`,
);

/** Whether the body ends with the posted marker shape. */
export function carriesCommentMarker(body: string): boolean {
  return POSTED_MARKER_RE.test(body.trimEnd());
}

/**
 * The severity a posted marker carries — read ONLY from the trailing shape
 * `submit` appends. An unanchored read returns a marker quoted or planted
 * mid-body (the string is public; a code sample in the reviewed diff can
 * contain it), which would let the plant choose the severity the classifier
 * sees.
 */
export function commentMarkerSeverity(
  body: string,
): 'critical' | 'suggestion' | null {
  const m = /<!-- qwen-review (critical|suggestion) -->$/.exec(body.trimEnd());
  return m === null ? null : (m[1] as 'critical' | 'suggestion');
}

/**
 * Whether the invisible marker `submit` appends to an attribution-off post
 * would land INSIDE a code fence (or an HTML block) still open at the
 * body's end — rendered as visible code instead of nothing, with the
 * claim vanished into the fence's info string when the delimiter carries
 * one. The attribution-off prefix strip can move a fence delimiter to
 * line-leading position, creating the exposure on a draft whose delimiter
 * sat mid-line, so the check runs on the POST-strip shape, mirroring the
 * fence refusal `ingestEntryList` applies to the body lists.
 */
export function swallowsAppendedMarker(body: string): boolean {
  const lines = scanLines(`${body}\n\n${COMMENT_MARKER}`);
  const last = lines[lines.length - 1];
  return last !== undefined && (last.kind === 'fence' || last.kind === 'html');
}

/**
 * Bare marker LINES removed from a body — used by `submit` before appending
 * the canonical marker, so a marker quoted from the reviewed code (or
 * planted to be mistaken for one) cannot survive next to the real one.
 * Fence- and indentation-aware like `stripForgedFooterLines`. The blockquote
 * allowance runs to any depth: a marker renders as nothing quoted at level
 * two exactly as at level one, and a surviving quoted marker beside the
 * canonical one is the plant this strip exists to remove.
 */
export function stripCommentMarkerLines(body: string): string {
  if (!body.includes('<!-- qwen-review')) return body;
  return mapLinesAware(body, (line) =>
    /^[ \t]{0,3}(?:>[ \t]*)*<!-- qwen-review (?:critical|suggestion)? -->[ \t]*\r?$/.test(
      line,
    )
      ? null
      : line,
  );
}

/**
 * A footer SPAN removed wherever it sits in a (single-line) string — the
 * sanitation for ledger titles, where a forged footer ending the first line
 * of a multi-line entry would otherwise survive the whole-line strips.
 * The version content admits only the shape `footerVersion` validates, and
 * its closing paren is optional — together they cover the looping-model
 * truncation (most mid-character cuts land inside the version parens — the
 * footer's final characters) without letting a cut inside the parens
 * swallow the prose after the span. The trailing `…` is likewise optional:
 * `reviewFooter` caps an interpolation past MODEL_ID_MAX_CHARS at the cap
 * plus that ellipsis, so the canonical capped footer must strip like any
 * forged one.
 *
 * Two branches, tried in order: a span CLOSED by its `_` lets the middle
 * run past an earlier marker phrase, so a doubled-marker span strips whole
 * (the whole-line twin's semantics); the unclosed fallback stops at the
 * first marker, so a truncated span mid-prose cannot swallow the prose
 * after it. In both, the middle cannot cross another span's `_— ` opener.
 */
const FOOTER_SPAN_RE =
  /_— (?:(?:(?!_— )[^\n]){0,400}? via Qwen Code \/review(?: \(v[A-Za-z0-9._+-]{0,200}…?\)?)?_|(?:(?! via Qwen Code \/review)[^\n]){0,400}? via Qwen Code \/review(?: \(v[A-Za-z0-9._+-]{0,200}…?\)?)?_?)[ \t]*/g;

/**
 * The named HTML5 entities decoding to characters the footer's literal
 * anchors carry — `/` of `/review` first among them. Numeric references
 * need no table; these are the named spellings for the same job.
 */
const NAMED_ENTITY_DECODES: ReadonlyMap<string, string> = new Map([
  ['sol', '/'],
  ['num', '#'],
  ['lpar', '('],
  ['rpar', ')'],
  ['period', '.'],
  ['comma', ','],
  ['lowbar', '_'],
  ['excl', '!'],
  ['mdash', '\u2014'],
  ['ndash', '\u2013'],
]);

/** The displayed projection of a string, with an index map back to it. */
interface Projection {
  /** The string the strips match on. */
  text: string;
  /** For each projection char, the original index it starts at. */
  starts: number[];
  /** For each projection char, the exclusive original index after it. */
  ends: number[];
}

/**
 * The projection every footer/marker strip matches on: what GitHub DISPLAYS
 * once the invisible inline constructs are resolved. HTML comments are
 * removed and entity references decoded (they never render), so a forged
 * footer hiding either inside the marker phrase is matched through; code
 * spans are masked in place — inline code renders VISIBLY, never as
 * attribution, so a footer quoted inside one must stay, while a forged
 * footer merely WRAPPING one is matched around the mask. A lone backtick is
 * no code span in CommonMark and stays literal. The strips used to match
 * the raw bytes and disagreed with their own `rendersAsNothing` gate, which
 * projects first — one projection for all of them ends the disagreement.
 *
 * An UNCLOSED comment opener has two readings, and the caller picks. In a
 * multi-line body it runs to the end of the input (`'swallow'`): a
 * line-leading opener opens a comment block GitHub renders as nothing to
 * the end, and the attribution-off line strips rely on that reading to
 * remove a forged footer trailed by junk. On a folded SINGLE line
 * (`'literal'`) there is no later line for a closer to sit on, so
 * CommonMark's inline HTML rule never fires: GitHub escapes the opener to
 * literal text and everything after it renders as prose — swallowing there
 * hid a forged footer the render shows, on the one-line channels whose fold
 * puts a witness block's quoted `<!--` on the footer's own line.
 */
function projectInvisibles(
  input: string,
  unclosedOpener: 'swallow' | 'literal' = 'swallow',
): Projection {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  const push = (chars: string, start: number, end: number): void => {
    for (let k = 0; k < chars.length; k++) {
      starts.push(start);
      ends.push(end);
    }
    text += chars;
  };
  const n = input.length;
  let i = 0;
  while (i < n) {
    const ch = input[i]!;
    if (ch === '`') {
      let runEnd = i;
      while (runEnd < n && input[runEnd] === '`') runEnd++;
      const runLen = runEnd - i;
      // A span closes on the next run of EXACTLY the same length on this
      // line; runs of other lengths inside are its content.
      let closeEnd = -1;
      let j = runEnd;
      while (j < n && input[j] !== '\n') {
        if (input[j] === '`') {
          let k = j;
          while (k < n && input[k] === '`') k++;
          if (k - j === runLen) {
            closeEnd = k;
            break;
          }
          j = k;
        } else {
          j++;
        }
      }
      if (closeEnd === -1) {
        push(input.slice(i, runEnd), i, runEnd);
        i = runEnd;
      } else {
        push('\u0000'.repeat(closeEnd - i), i, closeEnd);
        i = closeEnd;
      }
      continue;
    }
    if (ch === '<' && input.startsWith('<!--', i)) {
      const close = input.indexOf('-->', i + 4);
      if (close === -1 && unclosedOpener === 'literal') {
        push('<!--', i, i + 4);
        i += 4;
        continue;
      }
      i = close === -1 ? n : close + 3;
      continue;
    }
    if (ch === '&') {
      const rest = input.slice(i, i + 40);
      let m = /^&#0*(\d+);/.exec(rest);
      let decoded: string | undefined;
      let len = 0;
      if (m !== null) {
        const cp = Number(m[1]);
        if (cp > 0 && cp <= 0x10ffff) {
          decoded = String.fromCodePoint(cp);
          len = m[0].length;
        }
      } else if ((m = /^&#[xX]0*([0-9a-fA-F]+);/.exec(rest)) !== null) {
        const cp = Number.parseInt(m[1]!, 16);
        if (cp > 0 && cp <= 0x10ffff) {
          decoded = String.fromCodePoint(cp);
          len = m[0].length;
        }
      } else if ((m = /^&([a-z]+);/.exec(rest)) !== null) {
        decoded = NAMED_ENTITY_DECODES.get(m[1]!);
        len = m[0].length;
      }
      if (decoded !== undefined) {
        push(decoded, i, i + len);
        i += len;
        continue;
      }
    }
    push(ch, i, i + 1);
    i++;
  }
  return { text, starts, ends };
}

/**
 * Remove every match `re` finds on the line's displayed projection, cutting
 * the corresponding original spans. `re` must be global and match at least
 * one character.
 */
function stripByProjection(line: string, re: RegExp): string {
  const proj = projectInvisibles(line);
  re.lastIndex = 0;
  const first = re.exec(proj.text);
  if (first === null) return line;
  let out = line.slice(0, proj.starts[first.index]);
  let prev = proj.ends[first.index + first[0].length - 1]!;
  for (;;) {
    const m = re.exec(proj.text);
    if (m === null) break;
    out += line.slice(prev, proj.starts[m.index]);
    prev = proj.ends[m.index + m[0].length - 1]!;
  }
  return out + line.slice(prev);
}

function stripFooterSpanInLine(line: string): string {
  // The projection can only forge the marker phrase out of a literal
  // `/review` or an entity reference — anything else cannot match.
  if (!line.includes('/review') && !line.includes('&')) return line;
  return stripByProjection(line, FOOTER_SPAN_RE);
}

export function stripFooterSpans(text: string): string {
  // `/review`, not FOOTER_MARKER: re-wrapping can split the marker phrase
  // across a soft break, and only `/review` survives every split point
  // short of the word itself — and an entity reference can stand in for
  // any character of it, so an `&` must open the gate too.
  if (!text.includes('/review') && !text.includes('&')) return text;
  // One line by the file's own line-ending model (`LINE_ENDING_RE`): a
  // bare-CR body is multi-line here as everywhere else, or its first
  // line's indentation judged every line (#9940 review, round 28).
  if (!/[\r\n]/.test(text)) {
    // A single line indented four columns is an indented code block — the
    // span in it is quotation, as the multi-line path's line map already
    // treats it (a marker-stripped body whose kept code block is one line
    // arrives here) (#9940 review, audit 5).
    if (indentColumns(text) >= 4) return text;
    const stripped = stripFooterSpanInLine(text);
    if (stripped === text) return text;
    // The line's own indentation stays (four columns is a code block, and
    // the span inside it was quotation); only the space a removed span
    // left behind goes (#9940 review, audit 5).
    const indent = /^[ \t]*/.exec(text)?.[0] ?? '';
    return indent + stripped.slice(indent.length).trim();
  }
  const rejoined = stripSplitFooterSpans(text);
  return mapLinesAware(rejoined, (line) => stripFooterSpanInLine(line));
}

/** Lines GitHub renders as their own blocks — a paragraph run ends at them. */
const RUN_BREAK_RE =
  /^(?:#{1,6}(?:[ \t]|$)|[-*+][ \t]|\d{1,9}[.)][ \t]|(?:\*[ \t]*){3,}$|(?:-[ \t]*){3,}$|(?:_[ \t]*){3,}$)/;

/**
 * A forged footer re-wrapped onto the next line survives the per-line
 * strips — neither half contains the marker — but GitHub renders a soft
 * break inside a paragraph as a space, so the two halves DISPLAY rejoined.
 * Where joining a paragraph's lines reveals a footer span the per-line
 * strip misses, the paragraph goes out on its joined, stripped form:
 * exactly what GitHub would have rendered. Paragraphs are runs of ordinary
 * text lines at ONE blockquote depth; fenced/indented code and HTML blocks
 * keep their literal breaks, a hard break (two trailing spaces or a
 * backslash) ends the run — it renders a line break, not a space — and so
 * do the lines GitHub renders as separate blocks: list items, headings,
 * thematic breaks, and any quote-depth change.
 */
function stripSplitFooterSpans(text: string): string {
  let changed = false;
  const out: string[] = [];
  let para: string[] = [];
  let paraDepth = 0;
  const flush = (): void => {
    if (para.length > 1) {
      const joinedStripped = stripFooterSpanInLine(
        para.map((l) => l.trimEnd()).join(' '),
      );
      // Whitespace-squashed comparison: a span one line already carries
      // strips per-line as well, and differs from the joined strip only in
      // spacing — no split span, no rewrite.
      const squashed = (s: string): string => s.replace(/\s+/g, ' ').trim();
      if (
        squashed(joinedStripped) !==
        squashed(para.map(stripFooterSpanInLine).join(' '))
      ) {
        out.push(joinedStripped);
        changed = true;
        para = [];
        return;
      }
    }
    out.push(...para);
    para = [];
  };
  for (const { line, kind, depth, content } of scanLines(text)) {
    if (
      kind === 'text' &&
      line.trim() !== '' &&
      !/(?:[ \t]{2,}|\\)\r?$/.test(line) &&
      !RUN_BREAK_RE.test(content.trimStart())
    ) {
      if (para.length > 0 && depth !== paraDepth) flush();
      para.push(line);
      paraDepth = depth;
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return changed ? out.join('\n') : text;
}

/**
 * The widest string either footer interpolation carries — the modelId and
 * the CLI version both. The footer rides the body's last-resort tail,
 * which the body budget can only hold as a BOUNDED contributor: an
 * unbounded interpolation emptied the rung-3 cut — and past the budget
 * composed a body GitHub rejects whole, blockers included. Real model
 * names and version stamps are a few dozen characters.
 */
export const MODEL_ID_MAX_CHARS = 200;

/** The footer naming the reviewing model and the CLI version it ran under. */
export function reviewFooter(modelId: string, cliVersion: string): string {
  const name =
    modelId.length <= MODEL_ID_MAX_CHARS
      ? modelId
      : `${modelId.slice(0, MODEL_ID_MAX_CHARS - 1)}…`;
  // The version slot carries only the charset the readers accept. The
  // startup stamp goes through `footerVersion`, but the fallback
  // (`CLI_VERSION`, else the package version) reached this unchecked, and
  // a version like `0.1.0 (nightly)` built a CANONICAL note that neither
  // the ruling-shape matcher nor the census filter recognises — the
  // "ruling note re-posted forever" this module names (#9940 review, round
  // 31 reverse audit). Checked BEFORE the cap, whose ellipsis both readers
  // accept but the charset does not.
  const version = FOOTER_VERSION_RE.test(cliVersion)
    ? cliVersion.length <= MODEL_ID_MAX_CHARS
      ? cliVersion
      : `${cliVersion.slice(0, MODEL_ID_MAX_CHARS - 1)}…`
    : undefined;
  return version === undefined
    ? `_— ${name} ${FOOTER_MARKER}_`
    : `_— ${name} ${FOOTER_MARKER} (v${version})_`;
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
 * post as a duplicate attribution line above the canonical one. The closing
 * paren of the version group is optional for the same reason: most
 * mid-character cuts land inside the parens — the footer's final ~10
 * characters.
 *
 * The version CONTENT is bounded to the shape `footerVersion` validates —
 * FOOTER_SPAN_RE's treatment. An unbounded run made the optional paren eat
 * authored prose after a cut opened inside the parens when the match
 * succeeded, and enumerate exponential whitespace partitions when it
 * failed: the version span both swallowed subsequent footers on a line and
 * split trailing whitespace with the `\s*` after it, so a refusing footer
 * run no longer parsed exactly one way. The capped trailing `…`
 * `reviewFooter` writes for an interpolation past MODEL_ID_MAX_CHARS is
 * admitted — the canonical capped footer must strip like any forged one.
 */
export const REVIEW_FOOTER_RE =
  /\s*(?:_— (?:(?! via Qwen Code \/review)[^\n])* via Qwen Code \/review(?: \(v[A-Za-z0-9._+-]{0,200}…?\)?)?_?\s*)+$/;

/** The widest slice `stripReviewFooter` runs the strip regex over. */
const STRIP_TAIL_LIMIT = 8192;

/**
 * Strip trailing footers when present, and nothing else.
 *
 * Bounded twice, because the strip regex opens `\s*` under an unanchored
 * search, which scans quadratically on a long whitespace run — and these
 * bodies are model-written with no length cap (measured ~20 s at 80k
 * characters). The marker guard returns marker-less bodies unchanged
 * without running the regex at all, but it cannot help a body that CONTAINS
 * the marker: a quoted or truncated forged footer is the natural output of
 * the model loop this strip exists for, and the match still ran the
 * unanchored search over the whole body when no trailing footer matched
 * (probe-measured ~4× per doubling of the whitespace run). So the match
 * runs only over the last STRIP_TAIL_LIMIT characters — the regex is
 * `$`-anchored, so a match can only live at the tail, and one footer is
 * ~40 characters, which bounds the strip to a few hundred accumulated
 * footers, far past any real re-compose loop. Bounding at the last marker
 * occurrence does NOT work: the whitespace run sits after the last marker
 * line and stays inside that bound. Shared by both strip sites —
 * `compose-review`'s drafted entries and `submit`'s inline comments —
 * because one guard is one guard, and a second copy is how one site
 * eventually forgets it. The tail bound is the REGEX's: the blanking ahead
 * of it reads the whole body — a fence's state is only knowable from where
 * it opened — in one linear, block-only parse, a few milliseconds at
 * GitHub's 65,536-character comment cap.
 *
 * The match runs on the displayed projection — a comment or entity inside
 * the marker phrase cannot hide a trailing forged footer (or forge one:
 * the cut maps back to the original bytes) — and the projection of a
 * marker-less tail returns the body byte-identical without the regex.
 * Quoted code is blanked out of the projection first, for the reason
 * `blankQuotedCode` states; a body that cannot project the marker at all
 * returns before paying for that structural scan.
 */
export function stripReviewFooter(body: string): string {
  if (!canProjectFooterMarker(body)) return body;
  return stripTrailingFooter(body, blankQuotedCode(body));
}

/**
 * The trailing strip for ONE folded line — the shape the one-line channels
 * post: `compose-review`'s collapsed deferral titles, reroute records and
 * ingested entries, and `submit`'s relocated claim. A folded line carries
 * no block structure — the collapse flattened it — so a footer on it is
 * never the quotation `stripReviewFooter`'s blanking keeps: a fence
 * delimiter leading the line is posted text, not a code edge, and must
 * not blind the strip. Nor may an unterminated `<!--` the fold carried
 * onto the line: it is literal text on a single line (the projection's
 * `'literal'` reading), and the footer after it renders as prose.
 */
export function stripReviewFooterLine(line: string): string {
  return stripTrailingFooter(line, line, 'literal');
}

/**
 * Whether the string can project the footer marker at all: the projection
 * assembles it only out of literal characters, entity decodes (which need
 * a literal `&`), or a dropped comment joining the halves a literal `<`
 * sits between. `/review`, not FOOTER_MARKER: re-wrapping can split the
 * phrase across a soft break, and only `/review` survives every split
 * point short of the word itself.
 */
function canProjectFooterMarker(s: string): boolean {
  return s.includes('/review') || s.includes('&') || s.includes('<');
}

/**
 * The strip proper. `scanned` is `body` with its quoted code blanked — or
 * `body` itself — and the SAME length, so an index into the projection of
 * its tail is an index into the original bytes the cut slices.
 */
function stripTrailingFooter(
  body: string,
  scanned: string,
  unclosedOpener: 'swallow' | 'literal' = 'swallow',
): string {
  const tail = scanned.slice(-STRIP_TAIL_LIMIT);
  const proj = projectInvisibles(tail, unclosedOpener);
  if (!proj.text.includes(FOOTER_MARKER)) return body;
  const m = REVIEW_FOOTER_RE.exec(proj.text);
  if (m === null) return body;
  const keep = proj.starts[m.index];
  return body.slice(0, body.length - tail.length + keep);
}

/**
 * The body's code lines blanked to same-length NULs — fenced and indented
 * code, fence delimiters included — in the one shape a trailing-anchored
 * strip can use: blanking is length-preserving, so the projection's index
 * map still points into the original bytes.
 *
 * Code content is a quotation. GitHub renders it literally, so it can
 * neither BE attribution nor hide any: unblanked, a `<!--` with no `-->`
 * quoted in a witness block (a review of an HTML marker quotes exactly
 * that) projects as a comment running to the END of the input and takes
 * the real trailing footer out of the projection with it — the strip then
 * sees no footer, leaves the model's own, and the canonical one lands
 * beside it as a second attribution line. The delimiters blank with the
 * content: GitHub renders neither them nor an opener's info string, and a
 * `<!--` lodged in the info string would blind the strip the same way.
 *
 * Scanned from the body's START, not from the tail the strip matches on: a
 * fence's state is only knowable from where it opened, and a tail cut
 * inside one reads its code as ordinary text. The scan is one linear pass,
 * so the tail bound the regex needs is untouched.
 */
function blankQuotedCode(body: string): string {
  const scanned = scanLines(body);
  if (!scanned.some(({ kind }) => kind === 'fence' || kind === 'code')) {
    return body;
  }
  const endings = body.match(LINE_ENDING_RE) ?? [];
  return scanned
    .map(
      ({ line, kind }, i) =>
        (kind === 'fence' || kind === 'code'
          ? '\u0000'.repeat(line.length)
          : line) + (endings[i] ?? ''),
    )
    .join('');
}

/**
 * Every CommonMark line ending — `\n`, `\r\n`, and a bare `\r`. The one
 * spelling for the scan and the blanking: both index lines the parser
 * counted under the same definition (it normalizes all three to one line
 * break), so a second spelling would misalign the two. Carries the `g`
 * flag; `.split()` clones the regex and `.match()` resets `lastIndex`, so
 * both are safe call sites.
 */
const LINE_ENDING_RE = /\r\n?|\n/g;

/**
 * The CommonMark classifier every line-aware strip reads. `html: true` is
 * load-bearing: with raw-HTML blocks parsed as paragraphs instead, a fence
 * delimiter inside `<div>…</div>` would open code state GitHub does not
 * render. Same construction as `audit-layers.ts`. Only `token.type` and
 * `token.map` are read, and the `block` core rule produces both — the
 * inline pass is pure cost, two orders of magnitude on hostile one-line
 * bodies (a 256 KiB run of `[` measured ~1 ms block-only, ~400 ms with the
 * inline pass; linear either way), so it is off. A test bounds the cost.
 */
const BLOCK_PARSER = new MarkdownIt({ html: true });
BLOCK_PARSER.core.ruler.disable(['inline']);

/**
 * The top-level block kinds the CommonMark parser reads off a body, in
 * order, each with the source lines it spans — the skeleton the id stamp
 * compares before and after its insertion, on both projections (#9940
 * review, round 28). Block-only, like every other read of the parser here;
 * container contents are the container's own.
 */
export function blockSkeleton(
  body: string,
): Array<{ kind: string; text: string }> {
  const lines = body.split(LINE_ENDING_RE);
  return BLOCK_PARSER.parse(body, {})
    .filter(
      (t) =>
        t.level === 0 &&
        t.nesting !== -1 &&
        t.type !== 'inline' &&
        t.map !== null,
    )
    .map((t) => ({
      kind: t.type,
      text: lines.slice(t.map![0], t.map![1]).join('\n'),
    }));
}

/** The blockquote prefix a line can carry, at any nesting depth. */
export const QUOTE_PREFIX_RE = /^[ \t]{0,3}(?:>[ \t]*)+/;

/** Structural classes a line falls into. */
type LineKind =
  | 'text' // ordinary line — a strip's map applies
  | 'html' // tag-based HTML-block content — mapped: renders VISIBLY on GitHub
  | 'fence' // fenced-code line, delimiters included — kept (a quotation)
  | 'code'; // indented-code content — kept (a quotation)

interface ScannedLine {
  /** The line as written, blockquote prefix included. */
  line: string;
  kind: LineKind;
  /** The blockquote nesting depth of the line. */
  depth: number;
  /** The line's content after its blockquote prefix. */
  content: string;
}

/**
 * One structural pass over the body, shared by every line-aware strip and
 * the blanking: which lines GitHub renders as code (the quotations the
 * maps keep and the blanking hides), which as visible HTML-block content,
 * and which as ordinary text the maps apply to — classified identically
 * everywhere.
 *
 * The classification is the CommonMark parser's token map, not a hand
 * model of the block grammar. The scan this replaced tracked fences and
 * HTML blocks itself and disagreed with the renderers on lazy continuation
 * (an indented line right after a paragraph line is prose, not code), on
 * list content indents and tab stops, and on fence delimiters inside a
 * raw-HTML block — each disagreement kept a forged footer the render
 * showed, or hid one it rendered as code. A fence token's map covers its
 * delimiters too, so they classify with their content. Blockquotes and
 * list items are the parser's containers: a `> ```` quotation of an earlier
 * round's comment (`quoteBlock` in pr-context) is code at its depth.
 *
 * Tag-based HTML blocks (`<div>`, `<details>`, `<pre>` …) render their
 * content visibly, so it maps like text — the one droppable quotation kind
 * — and is what the marker-exposure gate counts. The raw kinds (a comment,
 * PI, declaration or CDATA block) render nothing; they were never modeled
 * and classify as text, where the projection's own comment handling
 * applies.
 *
 * Blockquote-wrapped lines keep their prefix on `line`, their content on
 * `content`, and their prefix depth on `depth`: the maps match quoted
 * shapes at any depth, and a paragraph run ends where the depth changes.
 *
 * Splits on every CommonMark line ending — `\n`, `\r\n`, and a bare
 * `\r`: the parser normalizes all three to one line break, so its map and
 * this split stay aligned, and the CR twins of these bodies classify like
 * the LF ones.
 */
function scanLines(body: string): ScannedLine[] {
  const lines = body.split(LINE_ENDING_RE);
  const kinds: LineKind[] = new Array<LineKind>(lines.length).fill('text');
  for (const token of BLOCK_PARSER.parse(body, {})) {
    if (token.map === null) continue;
    let kind: LineKind;
    if (token.type === 'fence') kind = 'fence';
    else if (token.type === 'code_block') kind = 'code';
    else if (token.type === 'html_block') {
      // A block opens at its first `<`, past any container prefix. Only a
      // tag opens the visible kind; `<!--`, `<?`, `<!X` and `<![CDATA[`
      // open the render-nothing kinds, which stay text.
      const opener = lines[token.map[0]];
      if (!/^<[A-Za-z/]/.test(opener.slice(Math.max(opener.indexOf('<'), 0)))) {
        continue;
      }
      kind = 'html';
    } else continue;
    for (let l = token.map[0]; l < token.map[1]; l += 1) kinds[l] = kind;
  }
  return lines.map((line, i) => {
    const quote = QUOTE_PREFIX_RE.exec(line);
    const depth = quote === null ? 0 : quote[0].split('>').length - 1;
    const content = quote === null ? line : line.slice(quote[0].length);
    return { line, kind: kinds[i], depth, content };
  });
}

/**
 * Line-map shared by the anywhere-strips: `map` returns the replacement
 * line, or null to drop it. Fenced code (delimiters included) and indented
 * code are quotations — kept verbatim; HTML-block CONTENT renders visibly,
 * so it maps like text. A body where nothing changed is returned
 * byte-identical.
 */
function mapLinesAware(
  body: string,
  map: (line: string) => string | null,
): string {
  let changed = false;
  const out: string[] = [];
  // Junctions into `out` (the index a dropped line's gap lands at) where a
  // line was dropped.
  const drops = new Set<number>();
  // Drops of HTML-block CONTENT lines: the one droppable quotation kind.
  // Their junctions land inside the quotation the scan keeps verbatim (or
  // at its edge), so the collapse must never touch the blank runs around
  // them — those blanks belong to the quotation and render.
  const quotedDrops = new Set<number>();
  for (const { line, kind } of scanLines(body)) {
    if (kind !== 'text' && kind !== 'html') {
      out.push(line);
      continue;
    }
    const mapped = map(line);
    if (mapped === null) {
      changed = true;
      drops.add(out.length);
      if (kind === 'html') quotedDrops.add(out.length);
      continue;
    }
    if (mapped !== line) changed = true;
    out.push(mapped);
  }
  if (!changed) return body;
  if (drops.size === 0) return out.join('\n');
  // A drop collapses the blank run it lands in to at most one blank line
  // (and removes it at the edges); every other run stays byte-identical —
  // a global collapse deleted blank lines inside the fenced/indented code
  // and <pre> quotations this scan keeps verbatim. A run touching a
  // quoted drop stays byte-identical too, for the reason above.
  const runHas = (set: Set<number>, from: number, to: number): boolean => {
    for (let p = from; p <= to; p += 1) {
      if (set.has(p)) return true;
    }
    return false;
  };
  const collapsible = (from: number, to: number): boolean =>
    runHas(drops, from, to) && !runHas(quotedDrops, from, to);
  const nonEmpty: number[] = [];
  out.forEach((l, i) => {
    if (l !== '') nonEmpty.push(i);
  });
  if (nonEmpty.length === 0) return '';
  const pieces: string[] = [];
  const first = nonEmpty[0]!;
  pieces.push(collapsible(0, first) ? '' : '\n'.repeat(first));
  for (let k = 0; k + 1 < nonEmpty.length; k += 1) {
    const a = nonEmpty[k]!;
    const b = nonEmpty[k + 1]!;
    pieces.push(out[a]!);
    pieces.push(
      collapsible(a + 1, b) && b - a > 2 ? '\n\n' : '\n'.repeat(b - a),
    );
  }
  const last = nonEmpty[nonEmpty.length - 1]!;
  pieces.push(out[last]!);
  pieces.push(
    collapsible(last + 1, out.length) ? '' : '\n'.repeat(out.length - 1 - last),
  );
  return pieces.join('');
}

/** A title on its own line, continuing a link reference definition. */
const LINK_REF_TITLE_RE = /^[ \t]*(?:"[^"]*"|'[^']*'|\([^)]*\))[ \t]*$/;

/**
 * How many lines starting at `lines[i]` form one link reference definition
 * — 0 when the line is not one. CommonMark: `[label]:`, then a destination
 * (`<…>` or a run without whitespace or `<`), then at most one quoted or
 * parenthesized title on the same line or the NEXT. A destination followed
 * by bare prose is no definition — CommonMark re-parses it as a VISIBLE
 * paragraph, so dropping it would erase real content.
 */
function linkRefDefLines(lines: string[], i: number): number {
  const m = /^[ \t]{0,3}\[[^\n[\]]+\]:[ \t]*(.*)$/.exec(lines[i]!);
  if (m === null) return 0;
  let rest = m[1]!;
  if (rest.startsWith('<')) {
    const close = rest.indexOf('>');
    if (close === -1) return 0;
    rest = rest.slice(close + 1);
  } else {
    const dest = /^[^\s<]+/.exec(rest);
    if (dest === null) return 0;
    rest = rest.slice(dest[0].length);
  }
  rest = rest.replace(/^[ \t]+/, '');
  if (rest === '') {
    return i + 1 < lines.length && LINK_REF_TITLE_RE.test(lines[i + 1]!)
      ? 2
      : 1;
  }
  return LINK_REF_TITLE_RE.test(rest) ? 1 : 0;
}

/**
 * Whether what remains would render as NOTHING on GitHub. Whitespace,
 * format characters (Cf, e.g. zero-width spaces — `.trim()` does not see
 * them), HTML comments — terminated or not: an unclosed `<!--` runs to the
 * end of the input and swallows the marker this post would append — the
 * sanitizer-dropped raw-HTML blocks (script/style, `<?…?>`, `<!DOCTYPE …>`),
 * the entities decoding to nothing visible (the no-break, space, and
 * named-invisible families), empty elements, void tags, empty links (an
 * empty-alt IMAGE still renders its `<img>`), blockquote-punctuation-only
 * lines, link reference definitions — validated, with a title-continuation
 * line consumed — hollowed fence delimiters, and forged-footer lines are
 * not content. The emptiness gates must project through this before
 * comparing to '', or a scaffolded-but-invisible comment posts, counts
 * toward the verdict, and re-promotes as an unanswerable blocker. This is a
 * judgment projection, not a sanitizer, so it is deliberately fence-blind: a
 * quotation of scaffolding is still not a finding.
 *
 * Two further blind spots are DECISIONS, not gaps, and both were measured
 * against cmark-gfm and an HTML parser before being left alone (#9940
 * review, round 12 reverse audit):
 *
 * FOLDS. A body whose prose sits inside a `<details>` renders as a
 * collapsed triangle — one click from readable, not invisible — and an arm
 * that deleted the fold's content would delete a quoted `` `<details>` ``
 * too, which is the shape a review OF THIS FILE writes. That trade loses a
 * real finding to catch a readable one, so a fold that hides an inline
 * comment's whole text posts, and counts.
 *
 * BLOCK CONTEXT. The `<!` and `<?` arms hide the same span wherever the
 * opener stands, though the renderer does not: mid-line a `<?` without its
 * `?>` forms nothing and its characters are VISIBLE, while at a line's
 * content start it is an HTML block. Splitting the two BY HAND was tried
 * and REVERTED. Measured on a prose-weighted corpus of 30 000 bodies: the
 * split alone traded 121 → 116 bodies wrongly called empty for 1426 → 1730
 * wrongly called visible, and teaching it the container prefixes (so
 * `><?…` reads as a block) then needs the container's EXTENT as well —
 * without that, bodies wrongly called EMPTY went 121 → 3594. (A one-off
 * corpus, not kept: the numbers are the shape of the trade, not a
 * benchmark to re-run.)
 *
 * The parse is not what stops it, and neither is the parser. `BLOCK_PARSER`
 * ABOVE hands every BLOCK token its line span, and this path already pays
 * for a run of it: `stripReviewFooter` opens `canProjectFooterMarker` on a
 * `<`, which every body these arms judge carries by construction, and
 * reaches `scanLines`. So the parse is already in the bill — on the body
 * shapes these arms fire on, adding one costs about what this leg already
 * spends in `stripReviewFooter`, and the two move together across shapes
 * (a directional measurement, not a benchmark: the absolute figures swing
 * more than twentyfold with the body's structure).
 *
 * What stops it is the PROJECTION. `scanLines` flattens `token.map` into a
 * per-line kind and returns `{line, kind, depth, content}` — the extent is
 * discarded, and `depth` counts block-quote markers only, so a list item
 * reads 0. Extent is the exact fact the numbers above say the split needs:
 * a container prefix tells you an opener is at a line's content start, and
 * only the container's END tells you how far the block it opens reaches.
 * So the arms stay position-blind until something here surfaces that, and
 * the price is the `&nbsp;<?x>` miscall pinned in the tests.
 */
/**
 * The `<!` family and `<?`, taken as ONE left-to-right decision.
 *
 * Written as a scan rather than a regex alternation: with no end-of-input
 * alternative the alternation retries at every later `<`, and an entry of
 * repeated unterminated `<![CDATA[` took nineteen seconds at 720 kB — this
 * projection runs TWICE per entry and once per inline comment body, on text
 * a model writes with no length bound (#9940 review, round 31 reverse
 * audit). A terminator absent from one position is absent from every later
 * one, so one failed search per kind is all the scan ever does.
 */
function stripBangSpans(text: string): string {
  let out = '';
  let at = 0;
  let i = text.indexOf('<');
  let noCommentEnd = false;
  let noGt = false;
  while (i !== -1) {
    let end = -1;
    if (text.startsWith('<!-->', i)) end = i + 5;
    else if (text.startsWith('<!--->', i)) end = i + 6;
    else if (text.startsWith('<!--', i)) {
      if (!noCommentEnd) {
        const plain = text.indexOf('-->', i + 4);
        const bang = text.indexOf('--!>', i + 4);
        if (plain === -1 && bang === -1) noCommentEnd = true;
        else if (bang !== -1 && (plain === -1 || bang < plain)) end = bang + 4;
        else end = plain + 3;
      }
    } else if (
      text.startsWith('<?', i) ||
      text.startsWith('<![CDATA[', i) ||
      /^<![A-Z]+[ \t\n\v\f\r]/.test(text.slice(i))
    ) {
      if (!noGt) {
        const gt = text.indexOf('>', i + 2);
        if (gt === -1) noGt = true;
        else end = gt + 1;
      }
    }
    if (end === -1) {
      i = text.indexOf('<', i + 1);
      continue;
    }
    out += text.slice(at, i);
    at = end;
    i = text.indexOf('<', end);
  }
  return out + text.slice(at);
}

/**
 * Characters a reader cannot see: whitespace of every width (`\s` already
 * covers `\p{Zs}`), the format characters, and the C0/C1 controls — a
 * control is never a glyph, and `&#28;`…`&#31;` and `&#133;` were being
 * called visible (#9940 review, round 31 reverse audit).
 */
const INVISIBLE_ONLY_RE = /^[\s\p{Cf}\p{Cc}]*$/u;

/**
 * The HTML5 named references whose value is invisible — derived from the
 * entity table, not curated, so the set cannot drift from what a renderer
 * decodes. Case is significant: `&nbsp;` is a space and `&NBSP;` is the
 * five characters a reader sees.
 */
const INVISIBLE_ENTITY_NAMES = new Set([
  'ApplyFunction',
  'InvisibleComma',
  'InvisibleTimes',
  'MediumSpace',
  'NegativeMediumSpace',
  'NegativeThickSpace',
  'NegativeThinSpace',
  'NegativeVeryThinSpace',
  'NewLine',
  'NoBreak',
  'NonBreakingSpace',
  'Tab',
  'ThickSpace',
  'ThinSpace',
  'VeryThinSpace',
  'ZeroWidthSpace',
  'af',
  'emsp',
  'emsp13',
  'emsp14',
  'ensp',
  'hairsp',
  'ic',
  'it',
  'lrm',
  'nbsp',
  'numsp',
  'puncsp',
  'rlm',
  'shy',
  'thinsp',
  'zwj',
  'zwnj',
]);

/** Whether an entity reference's body decodes to nothing a reader sees. */
function invisibleEntity(ref: string): boolean {
  if (ref[0] !== '#') return INVISIBLE_ENTITY_NAMES.has(ref);
  const code =
    ref[1] === 'x' || ref[1] === 'X'
      ? Number.parseInt(ref.slice(2), 16)
      : Number.parseInt(ref.slice(1), 10);
  // Out of range, NUL and the lone surrogates all decode to U+FFFD, which
  // a reader sees.
  if (!Number.isSafeInteger(code) || code < 1 || code > 0x10ffff) return false;
  if (code >= 0xd800 && code <= 0xdfff) return false;
  return INVISIBLE_ONLY_RE.test(String.fromCodePoint(code));
}

export function rendersAsNothing(text: string): boolean {
  let stripped = text
    // The `<!` family and `<?` are ONE decision, taken left to right,
    // because that is how the HTML tokenizer takes it: at a `<!` it looks
    // for `--` (comment), `[CDATA[` and a DOCTYPE-shaped name, and
    // otherwise opens a BOGUS COMMENT that ends at the first `>`. Four
    // independent global passes take the decision four times and in the
    // wrong order — the comment pass ate the `>` that terminates a
    // declaration standing in FRONT of it, and the entry then read as
    // empty and `rendersAsNothingAtExit` threw the whole compose away.
    //
    // `<!-->` and `<!--->` close on their own dashes (HTML5 "abrupt
    // closing of empty comment") and a comment ALSO closes at `--!>`
    // (HTML5 "comment end bang state"), so what follows any of the three
    // is VISIBLE. A declaration is `<!` + UPPERCASE letters + WHITESPACE —
    // derived exhaustively against cmark-gfm, which is what GitHub runs —
    // so `<!a x>`, `<!A1 x>` and `<!Ax>` are not declarations and the text
    // behind them is visible. A processing instruction and a CDATA section
    // hide only to the first `>`, not to their own `?>` / `]]>`, because
    // the markdown block hands the raw text to an HTML parser and the
    // bogus comment closes there (#9940 review, rounds 10 and 11 reverse
    // audits).
    .replace(/^[\s\S]*$/, stripBangSpans)
    // An opener left with no terminator runs to the END of the document —
    // but only from the START of a line, where it is an HTML BLOCK (types
    // 2, 3, 4 and 5). MID-LINE the same opener is an inline construct the
    // renderer refuses, so the text after it is visible and deleting it
    // threw the compose away (#9940 review, round 11 reverse audit).
    .replace(
      /(?:^|\n) {0,3}<(?:!--|\?|!\[CDATA\[|![A-Z]+[ \t\n\v\f\r])[\s\S]*$/,
      '',
    )
    .replace(/\p{Cf}/gu, '')
    // Invisible entity references, DECIDED rather than listed. The hand
    // table named ten of the thirty-three HTML5 names and twelve of the
    // thirty-three numeric spellings that render nothing, so `&Tab;`,
    // `&NewLine;`, `&#x2028;` and twenty more posted a Critical with no
    // visible content at all — counted toward the verdict and re-promoted
    // as an unanswerable blocker, which is the whole point of this
    // projection (#9940 review, round 31 reverse audit). It also matched
    // case-INSENSITIVELY, and named references are case-sensitive:
    // `&NBSP;` is literal text a reader sees, and deleting it read a
    // visible body as empty.
    .replace(
      // Wider than CommonMark's 7 digits / 6 hex digits: cmark-gfm decodes
      // `&#00000160;` past that bound, and the range check below is what
      // rejects an out-of-range code point.
      /&(#\d{1,10}|#[xX][0-9a-fA-F]{1,9}|[A-Za-z][A-Za-z0-9]{1,31});/g,
      (whole, ref: string) => (invisibleEntity(ref) ? '' : whole),
    )
    // Empty inline links render no pixels; an empty-alt image still
    // renders its <img> — only the link spelling is scaffolding.
    .replace(/\[\]\([^()\n]*\)/g, '')
    // Void tags render nothing.
    .replace(/<(?:br|hr|wbr)\b[^<>\n]*>/gi, '');
  // Empty paired elements — iterated, because hollowing the inside hollows
  // the wrapper. Capped: each pass is linear, and nesting deeper than the
  // cap fails OPEN (the body posts) instead of refusing real content.
  for (let pass = 0; pass < 4; pass += 1) {
    const next = stripped.replace(
      /<([a-z][a-z0-9-]*)[^<>\n]*?>\s*<\/\1\s*>/gi,
      '',
    );
    if (next === stripped) break;
    stripped = next;
  }
  const kept: string[] = [];
  const lines = stripped.split(LINE_ENDING_RE);
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*\r?$/.test(l)) continue;
    if (FORGED_FOOTER_LINE_RE.test(l)) continue;
    // A line of nothing but blockquote punctuation.
    if (/^[ \t]{0,3}(?:>[ \t]*)+$/.test(l)) continue;
    // Link reference definitions never render — a link using one lives
    // elsewhere in the body and still counts as content.
    const consumed = linkRefDefLines(lines, i);
    if (consumed > 0) {
      i += consumed - 1;
      continue;
    }
    kept.push(l);
  }
  return kept.join('').trim() === '';
}

/**
 * Footer-shaped LINES anywhere in the body — the strip for the
 * attribution-off leg. `stripReviewFooter` is trailing-anchored on purpose:
 * a footer followed by ordinary text is the model looping on the same
 * comment, and under attribution-on the canonical footer that follows makes
 * the surviving forged line redundant-but-harmless. Under attribution-off
 * that surviving line is the ONLY attribution the post carries — the exact
 * signal the mode exists to remove — so it goes regardless of position.
 *
 * Whole lines only, matched per line after splitting — on the line's
 * DISPLAYED projection, so an invisible construct inside the marker phrase
 * (an HTML comment, an entity reference) cannot shield it — and matched
 * only after the structural scan: a line inside a code fence or indented as
 * a code block is a quotation (a re-review quoting an earlier round's
 * comment verbatim), not attribution. The closing `_` is optional — a
 * looping model truncates its forged footer mid-character, the case this
 * strip exists for. Lines longer than 400 characters are left alone (a
 * footer line is short; the cap bounds the per-line match). A body with no
 * footer-shaped line is returned byte-identical — no whitespace rewriting.
 */
const FORGED_FOOTER_LINE_RE =
  /^[ \t]{0,3}(?:>[ \t]*)?_— [^\n]{0,400} via Qwen Code \/review(?: \(v[^\n)]{0,200}\)?)?_?[ \t]*\r?$/;

export function stripForgedFooterLines(body: string): string {
  if (!body.includes('/review') && !body.includes('&')) return body;
  return mapLinesAware(body, (line) =>
    FORGED_FOOTER_LINE_RE.test(projectInvisibles(line).text) ? null : line,
  );
}

/**
 * Severity markers at the start of any PARAGRAPH, not just the body's —
 * `stripSeverityPrefix` handles the leading run, but a looping draft can
 * carry a second marker into a later paragraph (the shape a marker-line
 * strip exposes), and a visible `**[Suggestion]**` mid-body contradicts the
 * invisible marker the post carries. The allowance runs to any blockquote
 * depth, matching `stripCommentMarkerLines`: a quoted marker re-recognizes
 * and re-promotes exactly like an unquoted one — but the prefix is
 * captured and restored: only the marker run goes, a quotation stays
 * quoted, or line one of a multi-line quotation re-parents the earlier
 * round's words as this round's own prose. Quoted code is left alone, as
 * with the other strips.
 */
// The whole stacked run, not one marker: a non-global single-marker match
// re-ran the full fixpoint chain per stacked marker — quadratic on
// model-written bodies whose rest defeats the strips' early bailouts.
const PARAGRAPH_MARKER_RE =
  /^([ \t]{0,3}(?:>[ \t]*)*)(?:(?:\*\*\[Critical\]\*\*|\*\*\[Suggestion\]\*\*)[ \t]*[:：]?[ \t]*)+/;

export function stripParagraphMarkers(body: string): string {
  if (!body.includes('**[')) return body;
  return mapLinesAware(body, (line) => {
    const stripped = line.replace(PARAGRAPH_MARKER_RE, '$1');
    return stripped === line ? line : stripped;
  });
}

/**
 * The full attribution-off sanitation, iterated to a fixpoint: forged
 * footer lines, severity prefixes, bare marker lines, and footer spans
 * interleave arbitrarily in a looping model's draft (a marker line between
 * two prefixes stops a single prefix pass; a footer span ahead of a marker
 * defeats a marker-first chain), and only a chain that keeps running until
 * nothing changes posts none of them. Every attribution-off leg — submit's
 * post transform and gate, compose's body lists, the ledger titles — goes
 * through here so the sites cannot drift.
 *
 * Comment grammar is deliberately NOT neutralized in this chain, even
 * though a forged footer wrapped in an HTML comment slips past every strip
 * above (they match the displayed projection, which drops the comment
 * whole). The chain is shared with submit's inline-comment transform,
 * whose contract keeps a quoted marker MENTION verbatim, and with the
 * ledger's id read, which steps over a leading comment as render-nothing
 * residue — a strip here turned both into visible words. The verbatim
 * body exits neutralize the grammar BEFORE calling in (`quotedProse` in
 * compose-review), where the wrapped footer then strips like any other.
 */
export function stripForUnattributedPost(body: string): string {
  let current = body;
  for (;;) {
    const next = stripFooterSpans(
      stripParagraphMarkers(
        stripCommentMarkerLines(
          stripSeverityPrefix(stripForgedFooterLines(current)),
        ),
      ),
    );
    if (next === current) return current;
    current = next;
  }
}

/**
 * A modelId the footer can interpolate. The footer is one line, and the
 * strip regex anchors on the marker: a modelId carrying a newline or the
 * marker itself builds a footer the strip cannot remove on a second pass, so
 * a re-compose loop would accumulate attribution lines instead of
 * normalizing to one.
 */
export function isFooterSafeModelId(modelId: string): boolean {
  // U+2028 and U+2029 too: the readers' footer tail names them (they are
  // display line breaks, and the `by` clause and the census filter both
  // name them), so a modelId carrying one built a CANONICAL ruling note
  // that neither this module's matcher nor the autofix census accepts —
  // the note is re-posted every round and the loop never converges. The
  // writer's gate and the readers' class have to be the same set (#9940
  // review, round 31 reverse audit).
  return (
    !/[\n\r\u2028\u2029]/.test(modelId) && !modelId.includes(FOOTER_MARKER)
  );
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
