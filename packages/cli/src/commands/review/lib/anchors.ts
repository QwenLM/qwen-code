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
  | 'loose-context';

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
  const nonBlank = lines.filter((l) => l !== '');
  if (
    nonBlank.length > 0 &&
    nonBlank.every((l) => /^[+\- ]/.test(l)) &&
    nonBlank.some((l) => l.startsWith('+'))
  ) {
    variants.push(
      lines.filter((l) => !l.startsWith('-')).map((l) => l.slice(1)),
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

const TIERS: ReadonlyArray<{
  tier: MatchTier;
  addedOnly: boolean;
  norm: (s: string) => string;
}> = [
  // Exact beats loose, and added beats context: strongest evidence first. An
  // anchor is *supposed* to quote added code, so a byte-identical hit on a `+`
  // line is the intended path and every later tier is a concession.
  { tier: 'exact-added', addedOnly: true, norm: normalizeExact },
  { tier: 'exact-context', addedOnly: false, norm: normalizeExact },
  { tier: 'loose-added', addedOnly: true, norm: normalizeLoose },
  { tier: 'loose-context', addedOnly: false, norm: normalizeLoose },
];

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

  for (const needle of variants) {
    for (const { tier, addedOnly, norm } of TIERS) {
      const hay = addedOnly
        ? newSideLines.filter((l) => l.added)
        : newSideLines;
      const starts = matchRuns(hay, needle, norm);
      if (starts.length === 0) continue;

      // More than one hit: prefer the one closest to where the agent thought it
      // was. With no claim to go on, first-wins — and say it was ambiguous.
      let best = starts[0];
      if (starts.length > 1 && claimedLine !== undefined) {
        best = starts.reduce((a, b) =>
          Math.abs(hay[a].newLine - claimedLine) <=
          Math.abs(hay[b].newLine - claimedLine)
            ? a
            : b,
        );
      }
      const startLine = hay[best].newLine;
      const line = hay[best + needle.length - 1].newLine;
      return {
        status: 'resolved',
        line,
        startLine,
        matchCount: starts.length,
        tier,
        ambiguous: starts.length > 1,
        ...(claimedLine !== undefined
          ? { drift: Math.abs(startLine - claimedLine) }
          : {}),
      };
    }
  }

  return {
    status: 'unmatched',
    reason:
      'snippet does not appear in any hunk of this file — it may be quoted ' +
      'from unchanged code outside the diff, paraphrased rather than copied, ' +
      'or attributed to the wrong file',
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
