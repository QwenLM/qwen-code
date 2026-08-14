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
 * Fence- and indentation-aware like `stripForgedFooterLines`.
 */
export function stripCommentMarkerLines(body: string): string {
  if (!body.includes('<!-- qwen-review')) return body;
  return mapLinesAware(body, (line) =>
    /^[ \t]{0,3}<!-- qwen-review (?:critical|suggestion)? -->[ \t]*\r?$/.test(
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

export function stripFooterSpans(text: string): string {
  return text.includes(FOOTER_MARKER)
    ? text.replace(FOOTER_SPAN_RE, '').trim()
    : text;
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

/**
 * Line-map shared by the anywhere-strips. Tracks the markdown constructs
 * under which a footer/marker-shaped line is a QUOTATION, not attribution:
 * fenced code (``` and ~~~, opened with at most three spaces of indent —
 * at four it is itself indented-code content and does not open a fence) and
 * indented code blocks. Lines inside a simple HTML block (`<div>`, `<pre>`,
 * … until the next blank line) render VISIBLY on GitHub, so they are never
 * a shield against the map — the state exists only to stop a fence-shaped
 * line inside one from toggling fence state. `map` returns the replacement
 * line, or null to drop it; a body where nothing changed is returned
 * byte-identical.
 */
function mapLinesAware(
  body: string,
  map: (line: string) => string | null,
): string {
  let inFence = false;
  let inHtml = false;
  let changed = false;
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trimStart();
    if (inHtml) {
      if (trimmed === '') inHtml = false;
      out.push(line);
      continue;
    }
    if (/^<[A-Za-z][^>]*>?[ \t]*\r?$/.test(trimmed) && !inFence) {
      inHtml = true;
      out.push(line);
      continue;
    }
    if (/^[ \t]{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence || /^[ \t]{4}/.test(line)) {
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
