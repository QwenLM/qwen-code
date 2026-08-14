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
  /**
   * The reverse-audit loop's round cap: the full `MAX_REVERSE_AUDIT_ROUNDS`
   * normally, or a reduced `HUGE_REVERSE_AUDIT_ROUNDS` for a diff large
   * enough that the full loop cannot finish inside any budget.
   *
   * A reverse-audit round re-reads the whole diff against a growing
   * findings list, so its cost scales with the diff — measured at ~90
   * minutes a round on a 4,000-line PR, where the full five rounds alone
   * (450 min) exceed the six-hour CI ceiling before the fan-out and tail
   * are even counted. In a time-budgeted CI run the deadline gate already
   * refuses a round that will not fit; this static cap is the belt it works
   * under and the ONLY bound a local run (no deadline) has. Reduced to
   * three, not two — not because two cannot converge (the all-dry
   * rounds-1-and-2 shape reaches CONVERGED at the round-3 build under any
   * cap of two or more, since the convergence check runs before the cap
   * gate) but to buy hot chunks one extra audit round before the cap.
   *
   * The budget tunes how many rounds the loop runs, never whether it runs:
   * the reverse audit is a dimension of the high-effort contract. The CLI
   * only ever writes three or five here.
   */
  reverseAuditRounds: number;
}

/**
 * Below this many source lines, a diff is small enough that a second pass over
 * it is the first pass again.
 */
const SWEEP_FLOOR = 25;

/**
 * The reverse-audit loop's full round cap (SKILL.md Step 5's "stop at the
 * plan's `reverseAuditRounds` cap"). The normal value; a huge diff gets
 * `HUGE_REVERSE_AUDIT_ROUNDS` instead. `compose-review` imports it directly.
 */
export const MAX_REVERSE_AUDIT_ROUNDS = 5;

/**
 * The reduced cap for a huge diff — three, one audit round above the
 * convergence floor of two, spent on hot chunks before the cap stops the
 * loop. Not a convergability minimum: the all-dry rounds-1-and-2 shape
 * reaches CONVERGED under any cap of two or more, because the reverse
 * audit's convergence check runs before the round-cap gate.
 */
export const HUGE_REVERSE_AUDIT_ROUNDS = 3;

/**
 * The effective-line threshold above which a diff is "huge": its reverse
 * audit is capped and its Agent 8 specialists are shed. Set from the
 * timeout survey — the 6-hour CI reviews that ran to zero posted output
 * were 4,000-5,300 line PRs (a single reverse-audit round already ~90 min);
 * 3,000 triggers with margin below that band while leaving the full loop
 * for the common case. `effective` (the plan's source-weighted line-span
 * measure) slightly over-counts against source body lines, which only ever
 * makes this fire a little EARLIER — the safe direction for a
 * finishability gate.
 */
const HUGE_DIFF_FLOOR = 3000;

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
    // Agent 8 sheds in the huge zone. A specialist is a whole-diff pass on
    // top of the base fan-out, and on a diff too big to finish that extra
    // pass is the marginal cost that guarantees zero posted output — while
    // the per-chunk fan-out already covers the ground. Finishability over
    // an added depth pass, in exactly the band where the review otherwise
    // posts nothing.
    specialistCap:
      src >= SPECIALIST_FLOOR && effective < HUGE_DIFF_FLOOR ? 2 : 0,
    verifyShard: VERIFY_SHARD,
    agentToolBudget: clamp(
      MIN_AGENT_TOOL_BUDGET + Math.floor(effective / LINES_PER_TOOL_CALL),
      MIN_AGENT_TOOL_BUDGET,
      MAX_AGENT_TOOL_BUDGET,
    ),
    reverseAuditRounds:
      effective >= HUGE_DIFF_FLOOR
        ? HUGE_REVERSE_AUDIT_ROUNDS
        : MAX_REVERSE_AUDIT_ROUNDS,
  };
}

/**
 * The reverse-audit round cap a plan's budget carries, for every reader
 * that enforces or narrates it (the admission gate and the cold-check
 * note, both in `agent-prompt`; the retirement scheduler deliberately
 * ignores the cap — whether a scheduled cold check is allowed is the note
 * composer's question, not the schedule's). A plan without the field — an
 * older CLI — or a garbled value reads as the full cap: an old plan errs
 * toward more auditing, never less, exactly like every other budget
 * fallback.
 *
 * The accepted range is floored at `HUGE_REVERSE_AUDIT_ROUNDS`, the
 * smallest cap the CLI ever writes. A value of one or two is out of band
 * (a hand-edited plan): honouring it would force a non-converged round-cap
 * stop where the full loop would have kept auditing, so it too falls back
 * to the full cap — never less.
 */
export function reverseAuditRoundCap(budget: unknown): number {
  const v = (budget as { reverseAuditRounds?: unknown } | undefined)
    ?.reverseAuditRounds;
  return typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= HUGE_REVERSE_AUDIT_ROUNDS &&
    v <= MAX_REVERSE_AUDIT_ROUNDS
    ? v
    : MAX_REVERSE_AUDIT_ROUNDS;
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
// Linear-by-construction, for the same reason the scan is line-based: the
// bullet's leading whitespace rides INSIDE the optional group (no
// overlapping `[ \t]*` pair), and the gap capture is greedy to the end of
// a pre-trimmed line (no lazy-dot vs trailing-whitespace pair) — gap lines
// carrying long whitespace runs must not stall the parse.
const BUDGET_GAP_LINE_RE =
  /^(?:[ \t]*(?:[-*+]|\d+[.)]))?[ \t]*(`?)[*_~]{0,3}(?:budget gap|预算(?:缺口|不足|用尽))[*_~]{0,3}[ \t]*[:：][*_~]{0,3}[ \t]*(.+)$/i;

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
 * Templates and non-answers that must not become gaps someone rules on —
 * the agent saying it has nothing to disclose. A phantom gap costs real
 * rounds downstream (a chunk that never retires, a body that discloses
 * "None." on an Approve), so these shapes are dropped.
 *
 * One classifier judges the paren-stripped text, bare and wrapped alike:
 * #8388's posted body disclosed `(none — all planned checks completed)`
 * because a leading `(` defeated the match, and a bare-vs-wrapped split
 * judgment let the two forms diverge on identical content. The vocabulary
 * lives in this one regex for the same reason.
 *
 * The shapes are deliberately NARROW, because the two errors are not
 * symmetric: dropping a REAL gap certifies work that never happened (the
 * failure #8388's body shipped), while keeping a placeholder only
 * over-discloses. Anything outside them survives as a gap:
 *
 *  - the brief's own `<the check>` template, and dash-only text — both
 *    end-anchored, so inner text merely STARTING with them keeps;
 *  - a bare placeholder token in any trailing punctuation (`none`,
 *    `None.`, `no gaps`), and the non-answer idioms `nothing skipped`,
 *    `none found`, `nothing to report`;
 *  - the stayed-under-budget idiom, end-anchored like its siblings
 *    (`N/A - stayed under budget`), with the same position words and
 *    budget qualifiers as the completion tail below (`stayed inside the
 *    tool-call budget`) — one vocabulary for one idiom family; text
 *    continuing past `budget` keeps (`N/A - stayed under budget, but the
 *    Windows matrix never ran`);
 *  - the completion idiom — token, dash, an "all done" head, then a
 *    completion word the text ENDS with (`none — all planned checks
 *    completed`), tolerating one trailing budget adverbial (`none — all
 *    checks above completed within budget` — three of these reached two
 *    posted bodies in one live round because the completion word was not
 *    final). The head alone is not completion (`none — all 5
 *    Windows checks failed to start` keeps), the completion word must be
 *    AFFIRMED (`none — all checks crashed, none completed` keeps), and
 *    the span must not cross an exception (`none — all but the Windows
 *    checks completed` keeps);
 *  - a token followed by a parenthesized completion clause (`None (all
 *    checks completed)`), inner padding tolerated — under the same
 *    negation and exception guards.
 *
 * No two quantifiers overlap on whitespace: a placeholder token followed
 * by a long whitespace run must stay linear (the module header's hazard
 * note applies — this parse runs on every agent return). The completion
 * spans are tempered (a per-character exception lookahead), which keeps
 * them linear too.
 */
// The budget-position vocabulary, spelled ONCE for the whole idiom family:
// the stayed idiom and both completion tails read the same words. As a
// regex literal the family was hand-copied three times, and the copies had
// already drifted twice in two review rounds (`below` missing from one
// branch, the qualifiers from another).
const BUDGET_QUALIFIED =
  '(?:under|within|below|inside)\\s+(?:the\\s+)?(?:tool(?:[- ]call)?\\s+)?budget';
const COMPLETION_TAIL = `(?:\\s+${BUDGET_QUALIFIED})?`;

const PLACEHOLDER_GAP_RE = new RegExp(
  '^(?:<[^>]*>$' +
    '|[-—*_~`]+$' +
    '|(?:none|n/a|nothing|no (?:gaps?|checks?))\\b(?:' +
    '[.!…,;:\\s]*$' +
    '|\\s+(?:skipped|found|to report)\\b[.!…,;:\\s]*$' +
    `|\\s*[-—–]\\s*(?:stayed\\s+${BUDGET_QUALIFIED}\\b[.!…,;:\\s]*$` +
    '|(?:all|every(?:thing)?|planned|further|no further)\\b' +
    '(?:(?!\\b(?:but|except|excepting|excluding)\\b).)*' +
    '(?<!\\b(?:none|nothing|no|zero|never|not)\\s)' +
    `\\b(?:complete[ds]?|done|finished|covered)\\b${COMPLETION_TAIL}[.!…,;:\\s]*$)` +
    '|\\s*\\(\\s*(?:all|every(?:thing)?)\\b' +
    '(?:(?!\\b(?:but|except|excepting|excluding)\\b)[^()])*' +
    '(?<!\\b(?:none|nothing|no|zero|never|not)\\s)' +
    `\\b(?:complete[ds]?|done|finished|covered)\\b${COMPLETION_TAIL}[.!…,;:\\s]*\\)\\s*$` +
    '))',
  'i',
);

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

const TRAILING_GAP_CHAR_RE = /[.!…,;:\s]/;

/** Trailing punctuation/whitespace strip for the normalize and fold keys. */
function stripTrailingGapChars(s: string): string {
  // Walked backwards rather than replaced with an end-anchored class run:
  // that shape backtracks quadratically when a long run fails to reach
  // the end.
  let end = s.length;
  while (end > 0 && TRAILING_GAP_CHAR_RE.test(s.charAt(end - 1))) end--;
  return s.slice(0, end);
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
    // vanish — silent loss in a channel whose promise is delivery. The
    // pre-trim keeps the greedy end-anchored capture's code-span
    // `endsWith` semantics on lines with trailing whitespace.
    const sanitized = line.replace(DANGEROUS_CHARS_RE, ' ').trimEnd();
    const m = BUDGET_GAP_LINE_RE.exec(sanitized);
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
    const normalized = stripTrailingGapChars(raw).trim();
    // Judged on the paren-stripped text, bare and wrapped alike, by the
    // one strict classifier — its doc names why the shapes are narrow.
    const unparenthesized =
      normalized.startsWith('(') && normalized.endsWith(')')
        ? normalized.slice(1, -1).trim()
        : normalized;
    if (normalized.length === 0 || PLACEHOLDER_GAP_RE.test(unparenthesized)) {
      continue;
    }
    // Folded on the paren-stripped text with its OWN trailing punctuation
    // gone, so one gap restated with and without parentheses — `(auth
    // flow untested.)` and `auth flow untested` — discloses once.
    const key = stripTrailingGapChars(unparenthesized).toLowerCase();
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
