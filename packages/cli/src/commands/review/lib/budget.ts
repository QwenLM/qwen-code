/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// How much review this diff is worth — derived from its size, recorded in the
// plan, read by everyone.
//
// The roster answers *which dimensions* a review owes and is deliberately
// size-blind: security is owed on a four-line diff exactly as on a four-hundred
// one. What the roster does not answer is *how much walking* the size-elastic
// parts of the run should do — the low tier's angle rotation, the optional
// domain specialists, the verifier's shard width. Those were flat constants, and
// a flat constant is wrong at both ends: seven inline walks over a nine-line
// typo fix is six walks of nothing, and "up to 2 specialists when a domain
// dominates" invites a domain-dominance ruling on a diff far too small to have
// one.
//
// Two properties, both borrowed from how `effort` already works here:
//
//  1. **It lives in the plan, not in a flag.** A budget the caller passes is a
//     budget the caller can inflate — and every reader (the orchestrator running
//     the angles, anything that later checks what was owed) must see the same
//     number, or they disagree about what the run promised.
//
//  2. **It never scales a *dimension* away.** Everything below tunes how much
//     the elastic parts do. No arm of it can drop a required agent: that is the
//     roster's job, the roster reads `effort`, and a size input must not become
//     a back door into shrinking coverage.

/** The size inputs the budget is derived from. */
export interface BudgetInput {
  /**
   * Diff lines in `source` files — the same number the topology gate turns on,
   * and for the same reason: test and prose lines inflate a diff without adding
   * anything for a reviewer to get wrong.
   */
  srcDiffLines: number;
  /** Total diff lines, including tests, prose and generated files. */
  diffLines: number;
}

export interface ReviewBudget {
  /**
   * How many of the low tier's directed angles to walk (Step 3C, A–F).
   *
   * Always at least 3, because the three that are always worth walking are the
   * ones defined by *how they walk* rather than by a topic — line-by-line,
   * removed behaviour, and the language's own pitfalls — and each is answerable
   * on a diff of any size. The rest earn their turn as there is more to see.
   */
  inlineAngles: number;
  /**
   * Does the low tier's gap sweep run?
   *
   * The sweep re-reads the diff as a fresh reviewer holding the deduplicated
   * list, hunting only for what is not on it. On a diff small enough to hold
   * entirely in view, a second reader of the same few hunks is the same reader:
   * there is no "what did the first pass not get to" when the first pass got to
   * all of it.
   */
  sweep: boolean;
  /**
   * The cap on Agent 8 diff-specialized finders (high effort only).
   *
   * Zero below the floor, and that is the substantive half of this field. A
   * specialist is launched when "one domain dominates the diff", which is a
   * judgement — and a judgement made about forty lines will find a dominant
   * domain every time, because forty lines are usually all one thing. Dominance
   * is only meaningful once there is enough code for a diff to have been about
   * several things and not be.
   */
  specialistCap: number;
  /**
   * Findings per Step 4 verification agent — `ceil(N / verifyShard)` agents.
   *
   * Flat by design; it is here so the number has one home rather than being
   * re-stated in the skill's prose and in whatever reads it. It is a property of
   * how much a verifier can re-trace before its quality collapses on the tail of
   * its list, which is a fact about the verifier and not about the diff.
   */
  verifyShard: number;
  /**
   * Soft tool-call ceiling baked into every finder/auditor brief — not the
   * verifier, whose load `verifyShard` already governs, and not Build & Test,
   * whose calls are deterministic commands.
   *
   * A fan-out wave's wall clock is its slowest agent, and the slowest agent
   * is reliably a wanderer: two measured runs of the SAME 14-agent wave took
   * 11.7 and 41 minutes, the difference being individual agents spending
   * 40-100 model calls exploring the tree, while healthy agents on
   * comparable diffs settle in the 25-45 range. The ceiling is SOFT: the
   * brief tells the agent to stop exploring at the budget, write its
   * findings from the evidence in hand, and disclose what it did not get to
   * — a disclosed gap feeds the whiff and receipt machinery; an undisclosed
   * crawl only feeds the wall clock.
   */
  agentToolBudget: number;
}

/**
 * Below this many source lines, a diff is small enough that a second pass over
 * it is the first pass again.
 */
const SWEEP_FLOOR = 25;

/** Below this, "one domain dominates the diff" is not a finding about the diff. */
const SPECIALIST_FLOOR = 80;

/** Source lines per additional inline angle, above the always-walk three. */
const LINES_PER_ANGLE = 60;

export const MIN_INLINE_ANGLES = 3;
export const MAX_INLINE_ANGLES = 6;
export const VERIFY_SHARD = 8;

/**
 * The floor is what a small diff's walk legitimately needs (brief + chunk
 * reads + a handful of enclosing-function reads and greps); the ceiling sits
 * above every healthy per-agent count measured on real reviews (25-45) and
 * below the wandering pathology (40-100+). One extra call per twenty
 * effective lines lets a larger territory earn a longer walk.
 */
export const MIN_AGENT_TOOL_BUDGET = 30;
export const MAX_AGENT_TOOL_BUDGET = 60;
const LINES_PER_TOOL_CALL = 20;

/**
 * The review budget for a plan.
 *
 * Negative, non-finite and absent inputs all read as zero rather than throwing:
 * this is computed while a plan is being written, and a plan that fails to write
 * because a line count arrived as `NaN` costs the whole review, while a budget
 * that lands on its floor costs one under-walked small diff. It fails toward the
 * cheap end on purpose — the floors are the *minimum* work, not the maximum, so
 * a garbled input still walks three angles and still verifies.
 */
export function reviewBudget(input: BudgetInput): ReviewBudget {
  const src = sane(input.srcDiffLines);
  const total = sane(input.diffLines);

  // Size is read from source lines, with one exception: a diff that is *all*
  // non-source (a docs-only or lockfile-only change) still has lines somebody
  // has to read, and reading them with three angles when there are two thousand
  // of them is the dilution this budget exists to avoid. So a large non-source
  // diff earns angles too, at a much coarser rate — prose carries less that a
  // reviewer can get wrong, not none.
  const effective = Math.max(src, Math.floor(total / 8));

  const extraAngles = Math.floor(effective / LINES_PER_ANGLE);
  const inlineAngles = clamp(
    MIN_INLINE_ANGLES + extraAngles,
    MIN_INLINE_ANGLES,
    MAX_INLINE_ANGLES,
  );

  return {
    inlineAngles,
    sweep: effective >= SWEEP_FLOOR,
    specialistCap: src >= SPECIALIST_FLOOR ? 2 : 0,
    verifyShard: VERIFY_SHARD,
    agentToolBudget: clamp(
      MIN_AGENT_TOOL_BUDGET + Math.floor(effective / LINES_PER_TOOL_CALL),
      MIN_AGENT_TOOL_BUDGET,
      MAX_AGENT_TOOL_BUDGET,
    ),
  };
}

/**
 * The per-launch tool ceiling: the exploration allowance for this launch,
 * PLUS the launch's mandatory reads.
 *
 * Review findings shaped every term here. A whole-diff role on a
 * 25,000-line diff is ASSIGNED 63 chunk reads — a flat 60-call cap is
 * exhausted by the reading list before any analysis begins, so mandatory
 * reads ride on top of the allowance, never inside it. A scoped agent (one
 * chunk, one heavy file) inheriting the whole-diff ceiling keeps exactly
 * the wandering headroom the budget exists to cut, so a scoped launch's
 * allowance is derived from its own territory at the same rate. And the
 * plan's recorded number stays the authority for every launch — the skill
 * promises "every reader sees one number", so the scoped derivation may
 * only LOWER the plan's allowance, never raise it, and the plan's value is
 * clamped into the same [floor, ceiling] band in both directions: a
 * version-skewed or hand-edited plan carrying `0.5` or `100000` must not
 * become a three-call or a hundred-thousand-call brief.
 *
 * `territoryLines: null` is a whole-diff launch — no territory smaller
 * than the plan's, so the clamped plan allowance is used as-is.
 */
/**
 * The hard ceiling on the TOTAL a brief may state. The allowance is
 * clamped, but the reads term comes from the same unchecked-cast plan —
 * a garbled `chars` of 1e9 flowed through as a forty-thousand-call
 * brief, the exact number the clamp exists to make impossible. High
 * enough that no legitimate reading list reaches it (a 63-chunk 3B
 * fan-out with paged chunks and the findings list sits well under),
 * low enough that a garbled plan cannot erase the ceiling.
 */
export const MAX_TOTAL_TOOL_CALLS = 200;

export function launchToolBudget(
  planBudget: number,
  territoryLines: number | null,
  mandatoryReads: number,
): number {
  const base = clamp(
    sane(planBudget) || MIN_AGENT_TOOL_BUDGET,
    MIN_AGENT_TOOL_BUDGET,
    MAX_AGENT_TOOL_BUDGET,
  );
  const allowance =
    territoryLines === null
      ? base
      : Math.min(
          base,
          clamp(
            MIN_AGENT_TOOL_BUDGET +
              Math.floor(sane(territoryLines) / LINES_PER_TOOL_CALL),
            MIN_AGENT_TOOL_BUDGET,
            MAX_AGENT_TOOL_BUDGET,
          ),
        );
  return Math.min(
    MAX_TOTAL_TOOL_CALLS,
    allowance + Math.max(0, Math.floor(sane(mandatoryReads))),
  );
}

/**
 * The disclosure an agent writes when the ceiling stopped a check, and the
 * one parser every reader of that disclosure shares. The brief mandates the
 * line form (`Budget gap: <the check>`); `check-coverage` reports the
 * parsed gaps; the reverse-audit retirement strips these lines out of a
 * receipt before judging its substance. One matcher, one home — a second
 * copy is how the brief and its readers drift apart.
 *
 * The scan is LINE-BASED, three reviews' worth of reasons at once:
 *
 *  - A single multiline regex whose prefix class could cross `\n` was
 *    measured at seconds-per-run on pathological-but-ordinary returns
 *    (quoted diff hunks, banner comments) — quadratic backtracking from
 *    every line start. Per-line matching cannot cross lines, so it cannot
 *    backtrack across them.
 *  - The gap must sit on the SAME line as its marker: a bare
 *    `Budget gap:` header used to swallow the following line, turning an
 *    explicit next-line denial into a phantom disclosure.
 *  - QUOTING the format must not read as USING it: lines inside fenced
 *    code blocks and blockquote lines are skipped — this repo reviews its
 *    own PRs, and a reviewer of this very diff quotes these strings. (The
 *    same hazard transcripts.ts guards for tool-call parsing.) Bullets and
 *    numbering stay tolerated: lists are how an agent writes its own
 *    disclosures, and a disclosure lost to a bullet is unobservable —
 *    nothing downstream can tell "no gaps" from "gaps we failed to parse".
 */
const BUDGET_GAP_LINE_RE =
  /^[ \t]*(?:[-*+]|\d+[.)])?[ \t]*(`?)[*_~]{0,3}(?:budget gap|预算(?:缺口|不足|用尽))[*_~]{0,3}[ \t]*[:：][*_~]{0,3}[ \t]*(.+?)[ \t]*$/i;

/** A cheap pre-filter so the line walk skips returns with nothing to find. */
const GAP_HINT_RE = /budget gap|预算(?:缺口|不足|用尽)/i;

/**
 * The disclosure marker ANYWHERE in a line — for the one consumer that
 * cannot rely on the own-line format: a receipt clause with the disclosure
 * appended after the separator (`No new issues found — …; Budget gap: X`)
 * would otherwise absorb the gap text as its own substance. The general
 * parser deliberately stays line-anchored (a mid-line mention is how the
 * format is QUOTED); this is only for cutting a clause, never for minting
 * gaps.
 */
export const INLINE_BUDGET_GAP_RE =
  /(?:budget gap|预算(?:缺口|不足|用尽))[*_~`]{0,3}[ \t]*[:：]/i;

/**
 * Templates and non-answers that must not become gaps someone rules on.
 * Tested against the gap with trailing punctuation stripped, and matched on
 * the LEADING token — `none.`, `None (all checks completed)` and
 * `N/A - stayed under budget` are all the agent saying it has nothing to
 * disclose, and a phantom gap costs real rounds downstream (a chunk that
 * never retires, a body that discloses "None." on an Approve).
 */
const PLACEHOLDER_GAP_RE =
  /^(?:<[^>]*>|none\b.*|n\/a\b.*|nothing\b.*|no (?:gaps?|checks?)\b.*|[-—*_~`]+)$/i;

/** Keep an operator-facing NOTE readable; a gap names a check, not an essay. */
const MAX_GAP_LENGTH = 160;
const MAX_GAPS_PER_AGENT = 8;

/**
 * Dangerous codepoints stripped from a gap before it can reach a terminal
 * or a posted body: C0 and C1 controls (U+009B is an 8-bit CSI), DEL, the
 * Unicode line separators (U+2028/29 — ECMAScript line terminators, which
 * would otherwise truncate silently downstream), and the bidi embedding /
 * override range U+202A-U+202E.
 */
const DANGEROUS_CHARS_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e]/g;

/** Markdown wrapper pairs stripped only SYMMETRICALLY — never one side. */
const WRAPPER_PAIRS: Array<[string, string]> = [
  ['**', '**'],
  ['__', '__'],
  ['*', '*'],
  ['_', '_'],
  ['~', '~'],
  ['`', '`'],
];

function stripWrappers(s: string): string {
  let out = s;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of WRAPPER_PAIRS) {
      if (
        out.length > open.length + close.length &&
        out.startsWith(open) &&
        out.endsWith(close)
      ) {
        out = out.slice(open.length, out.length - close.length).trim();
        changed = true;
      }
    }
  }
  return out;
}

/** Truncate on code points — a slice through a surrogate pair is mojibake. */
function truncateGap(s: string): string {
  const points = [...s];
  return points.length > MAX_GAP_LENGTH
    ? `${points.slice(0, MAX_GAP_LENGTH).join('')}…`
    : s;
}

/**
 * Every budget-gap disclosure in an agent's final return, sanitized for the
 * two places it lands: an operator's terminal (stderr NOTE) and the posted
 * review body. Dangerous codepoints are stripped, each gap is capped in
 * length (on code points) and the list in count, duplicates are folded
 * (an agent that states its gap mid-return and restates it in the summary
 * disclosed one gap, not two), and placeholder text (the brief's own
 * `<the check>` template, `none` in any punctuation) is dropped rather
 * than handed to the orchestrator as a gap to rule on.
 */
export function budgetGapDisclosures(finalText: string): string[] {
  if (!GAP_HINT_RE.test(finalText)) return [];
  const gaps: string[] = [];
  const seen = new Set<string>();
  let inFence = false;
  for (const line of finalText.split(/\r?\n/)) {
    if (/^[ \t]*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // A blockquote is a quotation by definition; the agent is citing the
    // format (a brief, another agent's return), not using it.
    if (/^[ \t]*>/.test(line)) continue;
    // Sanitized BEFORE matching: U+2028/29 are line terminators to the
    // regex dot, and a gap carrying one would otherwise fail the match and
    // vanish — silent loss in a channel whose promise is delivery.
    const m = BUDGET_GAP_LINE_RE.exec(line.replace(DANGEROUS_CHARS_RE, ' '));
    if (!m) continue;
    // A line written as a code span (`Budget gap: …`) is only taken when
    // the backtick closes — and then unwrapped with its partner, so a
    // symbol the gap itself names in backticks keeps both of its own.
    let raw = m[2] ?? '';
    if (m[1] === '`') {
      if (!raw.endsWith('`')) continue;
      raw = raw.slice(0, -1);
    }
    raw = stripWrappers(raw.trim()).trim();
    const normalized = raw.replace(/[.!…,;:\s]+$/, '').trim();
    if (normalized.length === 0 || PLACEHOLDER_GAP_RE.test(normalized)) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    gaps.push(truncateGap(raw));
    if (gaps.length >= MAX_GAPS_PER_AGENT) break;
  }
  return gaps;
}

/**
 * `finalText` with its budget-gap disclosure lines removed — what the
 * reverse-audit retirement judges a receipt on, so an agent's admission of
 * what it skipped can neither serve as the receipt's substance nor block a
 * receipt that is substantive without it.
 */
export function stripBudgetGapLines(finalText: string): string {
  if (!GAP_HINT_RE.test(finalText)) return finalText;
  const kept: string[] = [];
  let inFence = false;
  for (const line of finalText.split(/\r?\n/)) {
    const fence = /^[ \t]*(?:```|~~~)/.test(line);
    if (fence) inFence = !inFence;
    if (
      !fence &&
      !inFence &&
      !/^[ \t]*>/.test(line) &&
      BUDGET_GAP_LINE_RE.test(line)
    ) {
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

function sane(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
