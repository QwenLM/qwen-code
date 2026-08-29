/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { stripSeverityPrefix } from './inline-counts.js';

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
 */
function projectInvisibles(input: string): Projection {
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
  if (!text.includes('\n')) {
    const stripped = stripFooterSpanInLine(text);
    return stripped === text ? text : stripped.trim();
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
  const version =
    cliVersion.length <= MODEL_ID_MAX_CHARS
      ? cliVersion
      : `${cliVersion.slice(0, MODEL_ID_MAX_CHARS - 1)}…`;
  return `_— ${name} ${FOOTER_MARKER} (v${version})_`;
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
 * eventually forgets it.
 *
 * The match runs on the displayed projection — a comment or entity inside
 * the marker phrase cannot hide a trailing forged footer (or forge one:
 * the cut maps back to the original bytes) — and the projection of a
 * marker-less tail returns the body byte-identical without the regex. Code
 * content is blanked before the projection, for the reason `blankQuotedCode`
 * states.
 */
export function stripReviewFooter(body: string): string {
  const tail = blankQuotedCode(body).slice(-STRIP_TAIL_LIMIT);
  const proj = projectInvisibles(tail);
  if (!proj.text.includes(FOOTER_MARKER)) return body;
  const m = REVIEW_FOOTER_RE.exec(proj.text);
  if (m === null) return body;
  const keep = proj.starts[m.index];
  return body.slice(0, body.length - tail.length + keep);
}

/**
 * The body with fenced- and indented-code CONTENT blanked to same-length
 * NULs: the structural scan `scanLines` gives the line-aware strips, in the
 * one shape a trailing-anchored strip can use — blanking is
 * length-preserving, so the projection's index map still points into the
 * original bytes.
 *
 * Code content is a quotation. GitHub renders it literally, so it can
 * neither BE attribution nor hide any: unblanked, a `<!--` with no `-->`
 * quoted in a witness block (a review of an HTML marker quotes exactly
 * that) projects as a comment running to the END of the input and takes the
 * real trailing footer out of the projection with it — the strip then sees
 * no footer, leaves the model's own, and the canonical one lands beside it
 * as a second attribution line.
 *
 * Scanned from the body's START, not from the tail the strip matches on: a
 * fence's state is only knowable from where it opened, and a tail cut
 * inside one reads its code as ordinary text. The scan is one linear pass,
 * so the tail bound the regex needs is untouched.
 */
function blankQuotedCode(body: string): string {
  const kinds = scanLines(body).map(({ kind }) => kind);
  if (!kinds.some((kind) => kind === 'fence' || kind === 'code')) return body;
  const lines = body.split(LINE_ENDING_RE);
  const endings = body.match(LINE_ENDING_RE) ?? [];
  return lines
    .map(
      (line, i) =>
        (kinds[i] === 'fence' || kinds[i] === 'code'
          ? '\u0000'.repeat(line.length)
          : line) + (endings[i] ?? ''),
    )
    .join('');
}

/**
 * Every CommonMark line ending — `\n`, `\r\n`, and a bare `\r`. Shared by
 * `scanLines` and `blankQuotedCode`: the blanking indexes into the scan's
 * lines, so a second spelling would misalign the two.
 */
const LINE_ENDING_RE = /\r\n?|\n/g;

/** The blockquote prefix a line can carry, at any nesting depth. */
const QUOTE_PREFIX_RE = /^[ \t]{0,3}(?:>[ \t]*)+/;

/** Fence delimiter runs (``` or ~~~), openers and closers alike. */
const FENCE_RUN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** A fence CLOSER: same shape, nothing but trailing whitespace after it. */
const FENCE_CLOSE_RE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*\r?$/;

// The CommonMark type-6 block-level tag names, opening or closing.
const HTML_BLOCK_TAG_NAMES =
  '(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)';

/**
 * The simple HTML-block opener the line-map tracks (see `scanLines`): an
 * opening tag, or a CLOSING block-level tag — `</div>` alone on a line
 * starts a blank-line-terminated HTML block exactly as `<div>` does.
 */
const HTML_BLOCK_OPEN_RE = new RegExp(
  `^(?:<[A-Za-z][^>]*>?|</${HTML_BLOCK_TAG_NAMES}[ \\t]*>)[ \\t]*\\r?$`,
  'i',
);

/** The type-1 openers: their blocks end at the closing tag, not a blank line. */
const HTML_TYPE1_OPEN_RE = /^<(pre|script|style|textarea)\b/i;

/** Structural classes a line falls into, in scan order. */
type LineKind =
  | 'text' // ordinary line — a strip's map applies
  | 'htmlOpen' // opens a simple HTML block — kept verbatim
  | 'html' // HTML-block content — mapped: renders VISIBLY on GitHub
  | 'htmlEnd' // the blank line closing an HTML block — kept
  | 'fenceEdge' // a fence opener or closer — kept
  | 'fence' // fenced-code content — kept (a quotation)
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
 * One structural pass over the body, shared by every line-aware strip:
 * markdown constructs under which a footer/marker-shaped line is a
 * QUOTATION, not attribution, classified identically everywhere.
 *
 * Blockquote-wrapped lines classify on their CONTENT, after the `>` prefix
 * — `quoteBlock` in pr-context quotes every earlier comment containing code
 * as `> ``` …`, and a scanner that never sees past the `>` reaches inside
 * quoted code and corrupts it. Fences track their quote depth for the same
 * reason: a shallower depth ends the quoted block carrying the fence. A
 * DEEPER depth inside an open fence does not — a `>`-prefixed line inside a
 * fenced code block is literal code content on GitHub, and the fence stays
 * open past it; the closer must carry the opener's own depth for the same
 * reason.
 *
 * The fence state is the opener's delimiter character and run length:
 * CommonMark closes a fence only on the same character, at least the
 * opener's length, with no info string — a bare boolean inverts parity on
 * nested/mixed quotes, exactly the 'quoting an earlier round' shape these
 * strips exist for. It also never OPENS a backtick fence whose info string
 * carries a backtick — CommonMark forbids that spelling, so the line is
 * ordinary paragraph text (tilde fences may carry one). Lines inside a
 * simple HTML block (`<div>`, `</div>`, … until the next blank line;
 * `<pre>`/`<script>`/`<style>`/`<textarea>` until their closing tag) render
 * VISIBLY on GitHub, so the state only stops a fence-shaped line inside one
 * from toggling fence state — and a `>`-only line is not the blank line
 * that ends such a block.
 *
 * Splits on every CommonMark line ending — `\n`, `\r\n`, and a bare
 * `\r`: GitHub renders all three as a line break, and a `\n`-only scan
 * read the CR twins of these bodies as one line, leaving a forged footer
 * or a hollow fence the LF twin strips or refuses.
 */
function scanLines(body: string): ScannedLine[] {
  let fence: { char: string; len: number; depth: number } | null = null;
  let html: { endRe: RegExp | null } | null = null;
  const out: ScannedLine[] = [];
  for (const line of body.split(LINE_ENDING_RE)) {
    const quote = QUOTE_PREFIX_RE.exec(line);
    const depth = quote === null ? 0 : quote[0].split('>').length - 1;
    const content = quote === null ? line : line.slice(quote[0].length);
    const trimmed = content.trimStart();
    if (html !== null) {
      const closes =
        html.endRe === null ? line.trim() === '' : html.endRe.test(line);
      if (closes && html.endRe === null) {
        html = null;
        out.push({ line, kind: 'htmlEnd', depth, content });
      } else {
        out.push({ line, kind: 'html', depth, content });
        if (closes) html = null;
      }
      continue;
    }
    if (fence !== null && depth < fence.depth) {
      // The quoted block carrying the fence ended; reclassify outside it.
      fence = null;
    }
    if (fence !== null) {
      const close = FENCE_CLOSE_RE.exec(content);
      if (
        close !== null &&
        depth === fence.depth &&
        close[1]![0] === fence.char &&
        close[1]!.length >= fence.len
      ) {
        fence = null;
        out.push({ line, kind: 'fenceEdge', depth, content });
      } else {
        out.push({ line, kind: 'fence', depth, content });
      }
      continue;
    }
    if (HTML_BLOCK_OPEN_RE.test(trimmed)) {
      const t1 = HTML_TYPE1_OPEN_RE.exec(trimmed);
      html =
        t1 === null
          ? { endRe: null }
          : { endRe: new RegExp(`</${t1[1]}\\s*>`, 'i') };
      out.push({ line, kind: 'htmlOpen', depth, content });
      continue;
    }
    const open = FENCE_RUN_RE.exec(content);
    if (open !== null) {
      // A backtick in a BACKTICK fence's info string is no fence at all —
      // the line is ordinary text; tilde fences may carry one.
      if (
        !(open[1]![0] === '`' && content.slice(open[0].length).includes('`'))
      ) {
        fence = { char: open[1]![0]!, len: open[1]!.length, depth };
        out.push({ line, kind: 'fenceEdge', depth, content });
        continue;
      }
    }
    if (/^[ \t]{4}/.test(content)) {
      out.push({ line, kind: 'code', depth, content });
      continue;
    }
    out.push({ line, kind: 'text', depth, content });
  }
  return out;
}

/**
 * Line-map shared by the anywhere-strips: `map` returns the replacement
 * line, or null to drop it. Fenced code, indented code, fence edges, and
 * HTML-block openers/closers are quotations — kept verbatim; HTML-block
 * CONTENT renders visibly, so it maps like text. A body where nothing
 * changed is returned byte-identical.
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
 */
export function rendersAsNothing(text: string): boolean {
  let stripped = text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, '')
    .replace(/<style\b[\s\S]*?(?:<\/style\s*>|$)/gi, '')
    .replace(/<\?[\s\S]*?(?:\?>|$)/g, '')
    .replace(/<![A-Za-z][\s\S]*?(?:>|$)/g, '')
    .replace(/\p{Cf}/gu, '')
    // No-break, space, and invisible named/numeric entity families.
    .replace(
      /&nbsp;|&ensp;|&emsp;|&thinsp;|&shy;|&zwj;|&zwnj;|&lrm;|&rlm;|&zerowidthspace;|&#0*(?:160|173|819[2-9]|820[0-7]|8288|65279);|&#x0*(?:a0|ad|200[0-9a-f]|206[0-4]|feff);/gi,
      '',
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
  const lines = stripped.split(/\r\n?|\n/);
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
