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
 * Bounded; the optional closing `_` and closing paren cover the looping-
 * model truncation (most mid-character cuts land inside the version parens
 * — they are the footer's final characters).
 */
const FOOTER_SPAN_RE =
  /_— [^\n]{0,400}? via Qwen Code \/review(?: \(v[^\n)]{0,200}\)?)?_?[ \t]*/g;

/** Runs of backticks, for the code-span scan below. */
const BACKTICK_RUN_RE = /`+/g;

/**
 * FOOTER_SPAN_RE applied only OUTSIDE backtick code spans: inline code
 * renders visibly on GitHub — never as attribution — and excising the
 * quoted footer template out of a finding about this very machinery leaves
 * empty backticks where the evidence was. A backtick run closes on the next
 * run of EXACTLY the same length (runs of other lengths inside are the
 * span's content); a run with no closer is literal text, not a shield.
 */
function stripFooterSpanInLine(line: string): string {
  if (!line.includes(FOOTER_MARKER)) return line;
  let out = '';
  let pos = 0;
  for (;;) {
    BACKTICK_RUN_RE.lastIndex = pos;
    const open = BACKTICK_RUN_RE.exec(line);
    if (open === null) {
      return out + line.slice(pos).replace(FOOTER_SPAN_RE, '');
    }
    out += line.slice(pos, open.index).replace(FOOTER_SPAN_RE, '');
    const openLen = open[0].length;
    let closeEnd = -1;
    for (;;) {
      const run = BACKTICK_RUN_RE.exec(line);
      if (run === null) break;
      if (run[0].length === openLen) {
        closeEnd = run.index + run[0].length;
        break;
      }
    }
    if (closeEnd === -1) {
      out += open[0];
      pos = open.index + openLen;
      continue;
    }
    out += line.slice(open.index, closeEnd);
    pos = closeEnd;
  }
}

export function stripFooterSpans(text: string): string {
  // `/review`, not FOOTER_MARKER: re-wrapping can split the marker phrase
  // across a soft break, and only `/review` survives every split point
  // short of the word itself.
  if (!text.includes('/review')) return text;
  if (!text.includes('\n')) {
    if (!text.includes(FOOTER_MARKER)) return text;
    const stripped = stripFooterSpanInLine(text);
    return stripped === text ? text : stripped.trim();
  }
  const rejoined = stripSplitFooterSpans(text);
  return mapLinesAware(rejoined, (line) => stripFooterSpanInLine(line));
}

/**
 * A forged footer re-wrapped onto the next line survives the per-line
 * strips — neither half contains the marker — but GitHub renders a soft
 * break inside a paragraph as a space, so the two halves DISPLAY rejoined.
 * Where joining a paragraph's lines reveals a footer span the per-line
 * strip misses, the paragraph goes out on its joined, stripped form:
 * exactly what GitHub would have rendered. Paragraphs are runs of ordinary
 * text lines; fenced/indented code and HTML blocks keep their literal
 * breaks, and a hard break (two trailing spaces or a backslash) ends the
 * run — it renders a line break, not a space.
 */
function stripSplitFooterSpans(text: string): string {
  let changed = false;
  const out: string[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length > 1) {
      const joinedStripped = stripFooterSpanInLine(para.join(' '));
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
  for (const { line, kind } of scanLines(text)) {
    if (
      kind === 'text' &&
      line.trim() !== '' &&
      !/(?:[ \t]{2,}|\\)$/.test(line)
    ) {
      para.push(line);
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return changed ? out.join('\n') : text;
}

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
 * post as a duplicate attribution line above the canonical one. The closing
 * paren of the version group is optional for the same reason: most
 * mid-character cuts land inside the parens — the footer's final ~10
 * characters.
 */
export const REVIEW_FOOTER_RE =
  /\s*(?:_— (?:(?! via Qwen Code \/review)[^\n])* via Qwen Code \/review(?: \(v[^\n)]*\)?)?_?\s*)+$/;

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

/** The blockquote prefix a line can carry, at any nesting depth. */
const QUOTE_PREFIX_RE = /^[ \t]{0,3}(?:>[ \t]*)+/;

/** Fence delimiter runs (``` or ~~~), openers and closers alike. */
const FENCE_RUN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** A fence CLOSER: same shape, nothing but trailing whitespace after it. */
const FENCE_CLOSE_RE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*\r?$/;

/** The simple HTML-block opener the line-map tracks (see `scanLines`). */
const HTML_BLOCK_OPEN_RE = /^<[A-Za-z][^>]*>?[ \t]*\r?$/;

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
 * reason: a depth change ends the quoted block carrying the fence.
 *
 * The fence state is the opener's delimiter character and run length:
 * CommonMark closes a fence only on the same character, at least the
 * opener's length, with no info string — a bare boolean inverts parity on
 * nested/mixed quotes, exactly the 'quoting an earlier round' shape these
 * strips exist for. Lines inside a simple HTML block (`<div>`, `<pre>`, …
 * until the next blank line) render VISIBLY on GitHub, so the state only
 * stops a fence-shaped line inside one from toggling fence state.
 */
function scanLines(body: string): ScannedLine[] {
  let fence: { char: string; len: number; depth: number } | null = null;
  let inHtml = false;
  const out: ScannedLine[] = [];
  for (const line of body.split('\n')) {
    const quote = QUOTE_PREFIX_RE.exec(line);
    const depth = quote === null ? 0 : quote[0].split('>').length - 1;
    const content = quote === null ? line : line.slice(quote[0].length);
    const trimmed = content.trimStart();
    if (inHtml) {
      if (trimmed === '') {
        inHtml = false;
        out.push({ line, kind: 'htmlEnd' });
      } else {
        out.push({ line, kind: 'html' });
      }
      continue;
    }
    if (fence !== null && depth !== fence.depth) {
      // The quoted block carrying the fence ended; reclassify outside it.
      fence = null;
    }
    if (fence !== null) {
      const close = FENCE_CLOSE_RE.exec(content);
      if (
        close !== null &&
        close[1]![0] === fence.char &&
        close[1]!.length >= fence.len
      ) {
        fence = null;
        out.push({ line, kind: 'fenceEdge' });
      } else {
        out.push({ line, kind: 'fence' });
      }
      continue;
    }
    if (HTML_BLOCK_OPEN_RE.test(trimmed)) {
      inHtml = true;
      out.push({ line, kind: 'htmlOpen' });
      continue;
    }
    const open = FENCE_RUN_RE.exec(content);
    if (open !== null) {
      fence = { char: open[1]![0]!, len: open[1]!.length, depth };
      out.push({ line, kind: 'fenceEdge' });
      continue;
    }
    if (/^[ \t]{4}/.test(content)) {
      out.push({ line, kind: 'code' });
      continue;
    }
    out.push({ line, kind: 'text' });
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
  for (const { line, kind } of scanLines(body)) {
    if (kind !== 'text' && kind !== 'html') {
      out.push(line);
      continue;
    }
    const mapped = map(line);
    if (mapped === null) {
      changed = true;
      continue;
    }
    if (mapped !== line) changed = true;
    out.push(mapped);
  }
  if (!changed) return body;
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .trimEnd();
}

/**
 * Whether what remains would render as NOTHING on GitHub. Whitespace,
 * format characters (Cf, e.g. zero-width spaces — `.trim()` does not see
 * them), HTML comments — terminated or not: an unclosed `<!--` runs to the
 * end of the input and swallows the marker this post would append — the
 * sanitizer-dropped raw-HTML blocks (script/style, `<?…?>`, `<!DOCTYPE …>`),
 * the entities decoding to nothing visible, empty elements, void tags,
 * empty links, blockquote-punctuation-only lines, link reference
 * definitions, hollowed fence delimiters, and forged-footer lines are not
 * content. The emptiness gates must project through this before comparing
 * to '', or a scaffolded-but-invisible comment posts, counts toward the
 * verdict, and re-promotes as an unanswerable blocker. This is a judgment
 * projection, not a sanitizer, so it is deliberately fence-blind: a
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
    // No-break and zero-width entity forms.
    .replace(
      /&nbsp;|&#0*160;|&#x0*a0;|&#0*(?:820[3-7]|8288|65279);|&#x0*(?:200[b-f]|206[0-4]|feff);/gi,
      '',
    )
    // Empty inline links and images render no pixels.
    .replace(/!?\[\]\([^()\n]*\)/g, '')
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
  stripped = stripped
    .split('\n')
    .filter((l) => !/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*\r?$/.test(l))
    .filter((l) => !FORGED_FOOTER_LINE_RE.test(l))
    // A line of nothing but blockquote punctuation.
    .filter((l) => !/^[ \t]{0,3}(?:>[ \t]*)+$/.test(l))
    // Link reference definitions never render — a link using one lives
    // elsewhere in the body and still counts as content.
    .filter((l) => !/^[ \t]{0,3}\[[^\n[\]]+\]:[ \t]*\S/.test(l))
    .join('')
    .trim();
  return stripped === '';
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
 * Whole lines only, matched per line after splitting: the marker substring
 * inside ordinary prose is not a footer, a footer-shaped span with text
 * after it on the same line is not one either, and a line inside a code
 * fence or indented as a code block is a quotation (a re-review quoting an
 * earlier round's comment verbatim), not attribution. The closing `_` is
 * optional — a looping model truncates its forged footer mid-character,
 * the case this strip exists for. Lines longer than 400 characters are
 * left alone (a footer line is short; the cap bounds the per-line match).
 * A body with no footer-shaped line is returned byte-identical — no
 * whitespace rewriting.
 */
const FORGED_FOOTER_LINE_RE =
  /^[ \t]{0,3}(?:>[ \t]*)?_— [^\n]{0,400} via Qwen Code \/review(?: \(v[^\n)]{0,200}\)?)?_?[ \t]*\r?$/;

export function stripForgedFooterLines(body: string): string {
  if (!body.includes(FOOTER_MARKER)) return body;
  return mapLinesAware(body, (line) =>
    FORGED_FOOTER_LINE_RE.test(line) ? null : line,
  );
}

/**
 * Severity markers at the start of any PARAGRAPH, not just the body's —
 * `stripSeverityPrefix` handles the leading run, but a looping draft can
 * carry a second marker into a later paragraph (the shape a marker-line
 * strip exposes), and a visible `**[Suggestion]**` mid-body contradicts the
 * invisible marker the post carries. Quoted code is left alone, as with
 * the other strips.
 */
const PARAGRAPH_MARKER_RE =
  /^[ \t]{0,3}(?:>[ \t]*)?(?:\*\*\[Critical\]\*\*|\*\*\[Suggestion\]\*\*)[ \t]*:?[ \t]*/;

export function stripParagraphMarkers(body: string): string {
  if (!body.includes('**[')) return body;
  return mapLinesAware(body, (line) => {
    const stripped = line.replace(PARAGRAPH_MARKER_RE, '');
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
