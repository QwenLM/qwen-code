/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Resolve a review finding's location from a **code snippet** instead of
// trusting a line number the model counted out by hand.
//
// The old contract asked each review agent for `<file>:<line>`. A line number
// is not something an agent reads; it is something it *derives*, by counting
// hunk headers and `+` lines across a diff it is paging through 25 000
// characters at a time. Agents miscount. GitHub then answers the whole Create
// Review call with a 422 — all-or-nothing, so one bad anchor sank every finding
// in the review, Criticals included — and the recovery path dropped the
// offender: an unanchorable Suggestion was discarded from the PR outright.
// Findings that were *correct about the code* were being thrown away because
// the model was wrong about arithmetic.
//
// So the agent now quotes the line instead of numbering it — a verbatim copy of
// what it is commenting on, which is the one thing it demonstrably has in front
// of it — and the number is computed here, from the diff, by consecutive-line
// matching. It is the same move `compose-review` made for the verdict: the part
// a model reasons about badly becomes the part a subcommand computes.
//
// Because every candidate line is collected from **inside a hunk**, a resolved
// anchor is a valid GitHub anchor by construction. The 422 class this module
// replaces cannot be reached from a `resolved` result.

import { parseDiff, type DiffFile } from './diff-plan.js';

/** One line of the post-change side of a file, as the diff renders it. */
export interface NewSideLine {
  /** 1-based line number in the post-change file. */
  newLine: number;
  /** The line's text, diff marker stripped. */
  text: string;
  /** True for a `+` line; false for an unchanged context line in the hunk. */
  added: boolean;
}

/**
 * How hard we had to work to match. Reported so the caller can see how much
 * the resolution leaned on normalisation rather than on the diff's own text.
 */
export type MatchTier =
  /** Byte-identical to added lines. What a well-formed anchor hits. */
  | 'exact-added'
  /** Byte-identical, but landed on context lines the hunk carries. */
  | 'exact-context'
  /** Matched only after normalising indentation. */
  | 'loose-added'
  | 'loose-context'
  /**
   * Matched as a fragment INSIDE a longer hunk line, not as the whole line —
   * the shape a file whose paragraphs are single multi-KB lines produces.
   */
  | 'substring-added'
  | 'substring-context';

export interface AnchorResolution {
  status: 'resolved' | 'unmatched';
  /**
   * The line to anchor a GitHub comment on: the **last** line of the matched
   * range. GitHub's inline comments hang off the end of a multi-line range
   * (`start_line` .. `line`), so a single-line anchor has `line === startLine`.
   */
  line?: number;
  startLine?: number;
  /** How many places in the file the snippet matched. >1 means it was ambiguous. */
  matchCount?: number;
  tier?: MatchTier;
  /**
   * True when the snippet matched more than once and the winner was picked by
   * proximity to the agent's claimed line (or, with no claim, by first-wins).
   * A caller that wants to be strict can treat this as "ask for a longer anchor".
   */
  ambiguous?: boolean;
  /**
   * How far the agent's claimed line was from where the snippet actually
   * starts. Non-zero means it miscounted. Useful to log, not to gate on.
   *
   * Measured against `startLine`, **not** `line`. An agent names the first line
   * of the code it is talking about; `line` is the *last* line of the match,
   * because that is where GitHub hangs a multi-line comment. Comparing the
   * claim to `line` scores a perfectly-counted three-line anchor as "off by
   * two" — which is not an agent error at all, it is the anchor's own length.
   * Measured that way, a dogfood run on PR #6754 reported 8 of 12 findings as
   * "corrected" when all 12 agents had in fact been exactly right.
   */
  drift?: number;
  /** Why an `unmatched` result did not resolve. */
  reason?: string;
}

/**
 * Extract the post-change lines a file's hunks render, with their real line
 * numbers.
 *
 * Deliberately re-walks the hunk bodies rather than teaching `parseDiff` to
 * collect text: `parseDiff` underwrites the chunk plan's tiling guarantee — the
 * thing that lets the review assert every line was assigned to some agent — and
 * that is not a function to grow a second reason to change. All the delicate
 * work (path quoting, `--- `/`+++ ` sequences appearing inside a hunk body) has
 * already happened by the time we have `file.hunks`; the body walk below needs
 * none of it.
 */
export function collectNewSideLines(
  diffText: string,
  file: DiffFile,
): NewSideLine[] {
  const lines = diffText.split('\n');
  const out: NewSideLine[] = [];

  for (const hunk of file.hunks) {
    // A pure-deletion hunk (`@@ -3,4 +2,0 @@`) occupies no new-side line, so
    // there is nothing in it to anchor to — and GitHub 422s an attempt.
    if (hunk.newCount === 0) continue;

    let newCursor = hunk.newStart;
    // `diffStart` is the `@@` header itself; the body is what follows.
    for (let n = hunk.diffStart + 1; n <= hunk.diffEnd; n++) {
      const raw = lines[n - 1];
      if (raw === undefined) break;

      if (raw.startsWith('+')) {
        out.push({ newLine: newCursor, text: raw.slice(1), added: true });
        newCursor++;
      } else if (raw.startsWith('-')) {
        // Removed: exists only on the old side. No new-side line number, and
        // nothing a right-side comment can hang off.
      } else if (raw.startsWith(' ') || raw === '') {
        // Context. Present on the new side, not written by this diff — and
        // still a legal GitHub anchor, because it is rendered inside the hunk.
        // (`diff.suppressBlankEmpty` decides whether a blank context line
        // arrives as a lone space or as an empty record; accept both.)
        out.push({
          newLine: newCursor,
          text: raw.startsWith(' ') ? raw.slice(1) : '',
          added: false,
        });
        newCursor++;
      }
      // Anything else — `\ No newline at end of file` — is not a line of the
      // file and must not advance the cursor.
    }
  }
  return out;
}

/** Trailing whitespace is not signal; an editor or a formatter may add it. */
function normalizeExact(s: string): string {
  return s.replace(/\s+$/, '');
}

/** Indentation-insensitive: the last resort before giving up. */
function normalizeLoose(s: string): string {
  return s.trim();
}

/**
 * Split an anchor into comparable lines, dropping blank lines at either end.
 *
 * An agent that quotes from a diff sometimes copies the `+` markers with it.
 * That is not a mistake worth failing over, but neither is it safe to strip a
 * leading `+` unconditionally — `+ 1` is a real line of code in plenty of
 * languages. So a marker-stripped reading is offered as a *second* candidate,
 * tried only if the faithful one matches nothing, and only when **every**
 * non-blank line carries a marker (one line starting with `+` is code; all of
 * them starting with `+` is a copied diff).
 */
function anchorVariants(anchor: string): string[][] {
  const lines = anchor.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) return [];

  // The faithful reading always goes first, so a snippet that IS in the diff
  // verbatim can never be mangled by a marker interpretation below it.
  const variants = [lines];

  const meaningful = lines.filter((l) => l.trim() !== '');
  if (meaningful.length > 0 && meaningful.every((l) => /^\+/.test(l))) {
    variants.push(lines.map((l) => (l.startsWith('+') ? l.slice(1) : l)));
  }

  // A whole hunk region copied verbatim: `+` lines interleaved with ` ` context
  // and `-` deletions. "Copy VERBATIM from the diff" invites exactly this, and
  // the reading above rejects it (not every line starts with `+`), so it used to
  // match no tier at all — the marker column survives even the loose trim.
  //
  // The new side of a diff region *is* its `+` and ` ` lines with the marker
  // column removed and the `-` lines dropped, and those lines are consecutive in
  // the post-change file by construction, so this reconstruction is exact rather
  // than fuzzy. Requiring one `+` keeps it away from ordinary indented code,
  // every line of which begins with a space and would otherwise have its first
  // character eaten.
  // Git's `\ No newline at end of file` is metadata, not a line of the file, and
  // a region copied verbatim from the end of a diff brings it along. It carries
  // no marker column, so it used to disqualify the whole region from the
  // hunk-region reading and an otherwise unique anchor came back unmatched.
  const NO_NEWLINE = /^\\ No newline at end of file$/;
  const marked = lines.filter((l) => l !== '' && !NO_NEWLINE.test(l));
  if (
    marked.length > 0 &&
    marked.every((l) => /^[+\- ]/.test(l)) &&
    marked.some((l) => l.startsWith('+'))
  ) {
    variants.push(
      lines
        .filter((l) => !l.startsWith('-') && !NO_NEWLINE.test(l))
        .map((l) => l.slice(1)),
    );
  }
  return variants;
}

/**
 * Every start index at which `needle` matches `hay` as a **consecutive** run.
 *
 * Consecutive in the post-change file, not merely in the array: a candidate run
 * whose line numbers jump (the gap between two hunks) is not a contiguous
 * snippet of the file and must not match one.
 */
function matchRuns(
  hay: NewSideLine[],
  needle: string[],
  norm: (s: string) => string,
): number[] {
  const starts: number[] = [];
  if (needle.length === 0 || hay.length < needle.length) return starts;

  const normNeedle = needle.map(norm);
  for (let i = 0; i + normNeedle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < normNeedle.length; j++) {
      const cell = hay[i + j];
      if (norm(cell.text) !== normNeedle[j]) {
        ok = false;
        break;
      }
      if (j > 0 && cell.newLine !== hay[i + j - 1].newLine + 1) {
        ok = false;
        break;
      }
    }
    if (ok) starts.push(i);
  }
  return starts;
}

/** One place the snippet could go. */
interface Candidate {
  startLine: number;
  line: number;
  /**
   * True when the run **contains** a `+` line.
   *
   * Not "every line is added". A two-line anchor spanning a context line and the
   * added line under it is exactly what a finding about a changed line looks
   * like, and `every` called that run "context" — indistinguishable from a
   * wholly-unchanged duplicate elsewhere in the file. The added-preference then
   * could not tell them apart and gave up. What matters is which candidate
   * touches the diff.
   */
  added: boolean;
}

/**
 * Every place `needle` fits, under one normalisation, across the whole hunk.
 *
 * Added and context lines are searched **together**, not in separate passes.
 * Searching added-only first and returning on the first hit reports
 * `matchCount: 1, ambiguous: false` for a snippet that also sits on a context
 * line elsewhere — which is not a tie broken, it is a tie the resolver never
 * saw. When the agent's claim points at the context copy, that "unambiguous"
 * answer is the wrong line, reported with full confidence.
 */
function candidatesFor(
  hay: NewSideLine[],
  needle: string[],
  norm: (s: string) => string,
): Candidate[] {
  return matchRuns(hay, needle, norm).map((i) => {
    const run = hay.slice(i, i + needle.length);
    return {
      startLine: run[0].newLine,
      line: run[run.length - 1].newLine,
      added: run.some((l) => l.added),
    };
  });
}

/**
 * Pick one candidate, or null when the choice cannot be made honestly.
 *
 * With a claimed line, nearest-to-the-claim wins: the claim and the snippet are
 * independent signals, and together they are far stronger than either alone.
 *
 * With **no** claim and more than one candidate, an added line beats a context
 * line — an anchor is supposed to quote added code. If that still leaves more
 * than one, there is nothing left to choose with, and guessing would post a
 * comment on code the finding is not about. Return null and let the caller
 * report it unmatched: an unmatched finding is loud and recoverable, a
 * confidently wrong anchor is neither.
 */
function pick(cands: Candidate[], claimedLine?: number): Candidate | null {
  if (cands.length === 1) return cands[0];

  if (claimedLine !== undefined) {
    // Nearest to the claim — but only if exactly one candidate *is* nearest.
    // A `reduce` that keeps the incumbent on a tie silently prefers the earlier
    // one, and "earlier" is not a reason: with matches at 10 and 12 and a claim
    // of 11, nothing distinguishes them, and answering 10 with a straight face
    // attaches a blocker to whichever occurrence happened to come first.
    const dist = (c: Candidate) => Math.abs(c.startLine - claimedLine);
    // A loop, not `Math.min(...)`. The spread turns every candidate into a
    // function argument, and a diff with enough repeated lines — a minified
    // bundle, a generated table — crosses the engine's argument limit and throws
    // a RangeError that takes the whole anchor batch down with it. Measured on
    // Node 22: fine at 125 000 candidates, RangeError at 200 000.
    let best = Infinity;
    for (const c of cands) best = Math.min(best, dist(c));
    const nearest = cands.filter((c) => dist(c) === best);
    return nearest.length === 1 ? nearest[0] : null;
  }

  const added = cands.filter((c) => c.added);
  return added.length === 1 ? added[0] : null;
}

/**
 * Short fragments sit inside half the lines a diff renders — `}`, `return;` —
 * so the containment tiers take only snippets long enough that a hit says
 * something: past the one-token class, where a match starts to name a place.
 */
const MIN_SUBSTRING_LENGTH = 12;

/** Whitespace runs collapsed to one space — the loose reading of containment. */
function normalizeCollapsed(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * The last tier: a single-line snippet matched as a fragment INSIDE a hunk
 * line, reported at the containing line. A file whose paragraphs are single
 * multi-KB lines — SKILL.md is one — defeats every whole-line tier above,
 * because the quote is in the diff, just not the WHOLE of any line; there the
 * natural anchor is a mid-line fragment, and containment is what places it.
 *
 * A multi-line snippet cannot sit inside one line. With `midLineOnly`, a
 * candidate whose line equals the fragment modulo surrounding whitespace is
 * dropped: that shape is an indentation guess stacked on a marker guess, the
 * stack the whole-line tiers refuse. `resolveAnchor` sets it when retrying
 * the marker-stripped reading. Same safety shape as the whole-line
 * tiers — a hit on several lines is decided by the claimed line or refused,
 * and the whitespace-collapsed reading earns its place only when it is the
 * ONLY place the fragment could go. A resolved fragment sits inside a hunk by
 * construction, exactly like a whole-line resolution, so it is a valid GitHub
 * anchor; it is weaker evidence about WHICH line, and the tier says so.
 */
function substringResolution(
  hay: NewSideLine[],
  needleLines: string[],
  claimedLine?: number,
  midLineOnly = false,
): AnchorResolution | null {
  if (needleLines.length !== 1) return null;
  const needle = normalizeExact(needleLines[0]);
  const collapsed = normalizeCollapsed(needle);
  // A marker-stripped reading can reduce to nothing — a bare `+` quoting an
  // added blank line. `''.includes('')` is true of every line, so an empty
  // needle would "sit inside" every hunk and prescribe a longer stretch of a
  // line it does not sit in; report nothing and let the caller fall through
  // to the honest absence reason.
  if (collapsed.length === 0) return null;

  const sitsInside = (l: NewSideLine): boolean =>
    l.text.includes(needle) || normalizeCollapsed(l.text).includes(collapsed);
  // A containing line that EQUALS the fragment modulo whitespace is not
  // mid-line containment — it is the indentation guess stacked on the marker
  // guess the whole-line tiers refuse. With `midLineOnly`, every reading
  // below drops such a line.
  const lineGuess = (l: NewSideLine): boolean =>
    midLineOnly && normalizeCollapsed(l.text) === collapsed;
  // When that filter — not absence — is what refused the reading, say so:
  // the quote IS in the hunk, and the generic absence reason would claim
  // otherwise and key the recovery to re-attribution.
  const indentationRefusal: AnchorResolution | null = hay.some(lineGuess)
    ? {
        status: 'unmatched',
        reason:
          'the marker-stripped reading matches a hunk line only after its ' +
          'indentation is normalised — quote the line verbatim, with its ' +
          'indentation',
      }
    : null;
  // A containing line equal to the fragment modulo whitespace keeps the
  // equal-line reading alive — the agent may have meant THAT line and dropped
  // its indentation. Resolving to a different containment line while it is a
  // candidate would choose between the two readings with nothing to choose:
  // the confident misplacement this tier exists to refuse. The refusal
  // outranks any remaining containment candidate.
  if (indentationRefusal) return indentationRefusal;

  // The floor measures what the collapsed matching pass actually runs on: a
  // padded quote is longer than its collapsed core, and the core is what
  // that weakest reading matches with.
  if (collapsed.length < MIN_SUBSTRING_LENGTH) {
    // Too short to place — but when it IS inside a hunk line, say so: the
    // generic absence reason would claim the quote appears nowhere (false
    // here) and key the recovery to re-attribution, when the only remedy is
    // a longer fragment.
    if (hay.some((l) => !lineGuess(l) && sitsInside(l))) {
      return {
        status: 'unmatched',
        reason:
          'the snippet sits inside a hunk line but is shorter than ' +
          `${MIN_SUBSTRING_LENGTH} characters — too short to place a line ` +
          'reliably; quote a longer stretch of the line it sits in',
      };
    }
    return indentationRefusal;
  }

  const norms: Array<[boolean, (s: string) => string]> = [
    [true, (s) => s],
    [false, normalizeCollapsed],
  ];
  for (const [exact, norm] of norms) {
    const normNeedle = norm(needle);
    // One candidate per LINE: a fragment repeated inside one line places the
    // comment on that line either way, and counting the repetitions would
    // report an ambiguity the resolver does not actually have.
    const cands: Candidate[] = hay
      .filter((l) => norm(l.text).includes(normNeedle))
      .filter((l) => !lineGuess(l))
      .map((l) => ({ startLine: l.newLine, line: l.newLine, added: l.added }));
    if (cands.length === 0) continue;

    if (!exact && cands.length > 1) {
      return {
        status: 'unmatched',
        reason:
          'the snippet sits inside more than one hunk line only after its ' +
          'whitespace is normalised — quote a longer fragment so the line is ' +
          'unambiguous',
      };
    }

    const best = pick(cands, claimedLine);
    if (!best) {
      return {
        status: 'unmatched',
        reason:
          'the snippet sits inside more than one hunk line and nothing ' +
          'distinguishes them — quote a longer fragment so it is unique, or ' +
          'give the line number you mean so the nearest match can be chosen',
      };
    }

    return {
      status: 'resolved',
      line: best.line,
      startLine: best.startLine,
      matchCount: cands.length,
      tier: best.added ? 'substring-added' : 'substring-context',
      ambiguous: cands.length > 1,
      ...(claimedLine !== undefined
        ? { drift: Math.abs(best.startLine - claimedLine) }
        : {}),
    };
  }
  return indentationRefusal;
}

/**
 * Resolve one anchor snippet to a line range in the post-change file.
 *
 * `claimedLine` is the number the agent reported. It is never trusted as the
 * answer — it is used only to break a tie when the snippet genuinely appears
 * more than once (`}` on its own, a repeated `await tick()`), where "the one
 * nearest where the agent thought it was" beats "the first one in the file".
 */
export function resolveAnchor(
  newSideLines: NewSideLine[],
  anchor: string,
  claimedLine?: number,
): AnchorResolution {
  const variants = anchorVariants(anchor);
  if (variants.length === 0) {
    return { status: 'unmatched', reason: 'anchor is empty' };
  }

  for (const [vi, needle] of variants.entries()) {
    // Indentation-insensitive matching is offered only to the **faithful**
    // reading of the snippet. The marker interpretations below it (`vi > 0`) are
    // already a guess about what the agent meant to type; letting a guess match
    // loosely stacks two of them, and the result — a statement matched at the
    // wrong nesting level in Python or YAML, then posted as a blocker — looks
    // exactly like a confident answer.
    const norms: Array<[boolean, (s: string) => string]> =
      vi === 0
        ? [
            [true, normalizeExact],
            [false, normalizeLoose],
          ]
        : [[true, normalizeExact]];

    for (const [exact, norm] of norms) {
      const cands = candidatesFor(newSideLines, needle, norm);
      if (cands.length === 0) continue;

      // A loose match earns its place only when it is the *only* place the
      // snippet could go. Choosing between several indentation-stripped
      // candidates is choosing which nesting level the agent meant, and the
      // resolver has no way to know.
      if (!exact && cands.length > 1) {
        return {
          status: 'unmatched',
          reason:
            'the snippet matched in more than one place only after its ' +
            'indentation was normalised — and in an indentation-significant ' +
            'language the nesting level IS the semantics, so choosing between ' +
            'them would be choosing which block the finding is about. Quote it ' +
            'verbatim.',
        };
      }

      const best = pick(cands, claimedLine);
      if (!best) {
        // An interpretation that found candidates and cannot choose between them
        // is **the** answer for this snippet, and it is "unmatched". Falling
        // through to a weaker reading is how a confident wrong line is born: with
        // two added lines whose code is `+value;` and one whose code is `value;`,
        // the faithful reading of the anchor `+value;` is ambiguous — and the
        // marker-stripped reading below then matches the unrelated `value;`
        // uniquely and returns it as `matchCount: 1, ambiguous: false`. The
        // resolver would be at its most confident exactly where it is most wrong.
        //
        // So stop. A stronger interpretation that is undecided outranks a weaker
        // one that is sure.
        return {
          status: 'unmatched',
          reason:
            'the snippet appears in more than one place and nothing ' +
            'distinguishes them — quote more lines so it is unique, or give the ' +
            'line number you mean so the nearest match can be chosen',
        };
      }

      const { startLine, line } = best;
      return {
        status: 'resolved',
        line,
        startLine,
        matchCount: cands.length,
        tier:
          (exact ? 'exact' : 'loose') + (best.added ? '-added' : '-context'),
        ambiguous: cands.length > 1,
        ...(claimedLine !== undefined
          ? { drift: Math.abs(startLine - claimedLine) }
          : {}),
      } as AnchorResolution;
    }
  }

  // Nothing matched as whole lines. Before giving up, try the snippet as a
  // fragment inside a hunk line — the tier KB-long Markdown lines need. A
  // whole-line reading that found candidates but could not choose is already
  // returned above as THE answer; this fires only when no whole-line reading
  // found anything at all.
  const fragment = substringResolution(newSideLines, variants[0], claimedLine);
  if (fragment) return fragment;

  // The faithful reading found nothing even as a fragment. If the quote was
  // copied with its `+` marker column — the mistake the whole-line tiers
  // forgive — offer the marker-stripped reading to the containment tier too,
  // mid-line only: a containing line equal to the fragment modulo whitespace
  // is the stacked indentation guess the tiers above refuse.
  if (variants.length > 1) {
    const stripped = substringResolution(
      newSideLines,
      variants[1],
      claimedLine,
      true,
    );
    if (stripped) return stripped;
  }

  return {
    status: 'unmatched',
    reason:
      'snippet does not appear in any hunk of this file — neither as whole ' +
      'lines nor as a fragment inside one. It may be quoted from unchanged ' +
      'code outside the diff, paraphrased rather than copied, or attributed ' +
      'to the wrong file',
  };
}

export interface AnchorRequest {
  /** Caller's id, echoed back so findings can be re-joined. */
  id: string;
  /** Repo-relative path, as it appears in the diff. */
  path: string;
  /** Verbatim snippet of one or more consecutive lines from the diff. */
  anchor: string;
  /** The line the agent claimed. Tiebreak only; never the answer. */
  line?: number;
}

/**
 * The request, with the agent's claim renamed out of the way.
 *
 * `AnchorRequest.line` (what the agent said) and `AnchorResolution.line` (what
 * the diff says) are two different numbers, and this module exists precisely
 * because they disagree. Letting both occupy the key `line` would resolve the
 * collision by silently overwriting the claim with the answer — which reads
 * fine and destroys the one number that proves the correction happened.
 */
export type AnchorResult = Omit<AnchorRequest, 'line'> & {
  claimedLine?: number;
} & AnchorResolution;

/**
 * One inline anchor as the posting boundary must vouch for it. `side` /
 * `startSide` are the payload's declared sides (GitHub's spelling); a
 * missing side defaults to RIGHT, which is the only side an Aone anchor
 * can express. Both fields admit `null` because that is the shape a
 * model-written payload uses for an ABSENT optional field — it reads
 * exactly like `undefined` (default RIGHT), never like a declared side.
 */
export interface NewSideAnchorCheck {
  path: string;
  line: number;
  startLine?: number;
  side?: string | null;
  startSide?: string | null;
}

export interface NewSideAnchorVerdict {
  valid: boolean;
  /** When invalid — the terminal-facing reason. */
  reason?: string;
}

/**
 * A postable line — a positive whole number. This boundary vouches for
 * hand-typed numbers, so it rejects the input domain itself before the
 * hunk scan: a fraction inside a hunk's span, or a reversed range whose
 * `lo > hi` degenerates the containment test, would otherwise certify an
 * anchor the platform (which validates nothing) then posts silently wrong.
 */
function isWholeLine(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

/**
 * Validate hand-typed line anchors against a captured diff's NEW side —
 * the check GitHub performs server-side (and answers with an
 * all-or-nothing 422), performed client-side for the Aone write path,
 * which the platform performs NONE of (probed 2026-08-21 on scratch MR
 * 29427547 of base-biz/sqlt, a1 v0.2.51: any positive integer posts —
 * an old-side number silently becomes the same-numbered new-side line,
 * a beyond-EOF number posts `outdated`). See
 * docs/design/2026-08-21-review-aone-removed-line-anchoring.md.
 *
 * The rules are the GitHub recovery's: an anchor is valid iff its line
 * sits inside a new-side hunk of its file; a multi-line range must sit
 * in ONE hunk. A pure-deletion hunk (`newCount === 0`) occupies no
 * new-side line and validates nothing. A declared non-RIGHT side is
 * unanchorable by construction — the old side does not exist on the
 * target platform. The module's header invariant has its converse here:
 * a snippet-resolved anchor is valid by construction; a hand-typed
 * number must pass this to be believed.
 */
export function validateNewSideAnchors(
  diffText: string,
  checks: NewSideAnchorCheck[],
): NewSideAnchorVerdict[] {
  const { files } = parseDiff(diffText);
  const byPath = new Map<string, DiffFile>(files.map((f) => [f.path, f]));

  return checks.map((check) => {
    if (
      !isWholeLine(check.line) ||
      (check.startLine !== undefined && !isWholeLine(check.startLine))
    ) {
      return {
        valid: false,
        reason: 'line is not a positive whole number',
      };
    }
    if (check.startLine !== undefined && check.startLine > check.line) {
      return {
        valid: false,
        reason: 'the range ends before it begins',
      };
    }
    // A `null` side is the model's idiom for an ABSENT optional field
    // (a documented recurring shape in this pipeline — JSON `null`, not a
    // declaration). Treat it exactly like `undefined`: defaulting to
    // RIGHT, per the contract above. Only a PRESENT, non-RIGHT value is a
    // declared old-side anchor.
    const sideDeclared = check.side !== undefined && check.side !== null;
    const startSideDeclared =
      check.startSide !== undefined && check.startSide !== null;
    if (
      (sideDeclared && check.side !== 'RIGHT') ||
      (startSideDeclared && check.startSide !== 'RIGHT')
    ) {
      return {
        valid: false,
        reason:
          'declares a non-RIGHT side — Aone Code anchors the new side ' +
          'only; the old side cannot be anchored',
      };
    }
    const file = byPath.get(check.path);
    if (!file) {
      return {
        valid: false,
        reason: `file is not in the diff (${files.length} file(s) changed)`,
      };
    }
    const lo = check.startLine ?? check.line;
    const hi = check.line;
    const inside = file.hunks.some(
      (h) => h.newCount > 0 && h.newStart <= lo && hi <= h.newEnd,
    );
    return inside
      ? { valid: true }
      : {
          valid: false,
          reason:
            check.startLine !== undefined
              ? `the range ${check.startLine}-${check.line} sits in no ` +
                `single new-side hunk of this file`
              : `line ${check.line} sits in no new-side hunk of this file`,
        };
  });
}

/**
 * Resolve a batch of anchors against a captured diff.
 *
 * A path that is not in the diff at all is `unmatched` rather than an error:
 * "the agent filed a finding against a file this PR does not touch" is a real
 * and interesting outcome, and it is the caller's to report — not a reason to
 * abort every other finding in the batch.
 */
export function resolveAnchors(
  diffText: string,
  requests: AnchorRequest[],
): AnchorResult[] {
  const { files } = parseDiff(diffText);
  const byPath = new Map<string, DiffFile>(files.map((f) => [f.path, f]));
  const lineCache = new Map<string, NewSideLine[]>();

  return requests.map((req) => {
    const { line: claimedLine, ...rest } = req;
    const claim = claimedLine !== undefined ? { claimedLine } : {};

    const file = byPath.get(req.path);
    if (!file) {
      return {
        ...rest,
        ...claim,
        status: 'unmatched' as const,
        reason: `file is not in the diff (${files.length} file(s) changed)`,
      };
    }
    let newSide = lineCache.get(req.path);
    if (!newSide) {
      newSide = collectNewSideLines(diffText, file);
      lineCache.set(req.path, newSide);
    }
    return {
      ...rest,
      ...claim,
      ...resolveAnchor(newSide, req.anchor, claimedLine),
    };
  });
}
