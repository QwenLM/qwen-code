/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review compose-review`: deterministic event selection and body
// composition for the /review skill's Step 7 submission.
//
// This logic used to be prose — a C/S table, three event-capping overrides,
// a seven-clause body composition, and presubmit downgrade carve-outs,
// restated across four places in SKILL.md. Keeping the restatements in sync
// by hand produced five shipped bugs (four Critical), all of the same shape:
// one downstream branch not updated when an upstream rule gained a new
// state. This module is the single source of truth; the skill gathers the
// state, calls it, and uses `{event, body}` verbatim. 422 recovery is the
// same call with the updated `--comments` file — the counts are counted
// from it, never updated by hand.
//
// The model stays responsible for judgment (what is a Critical, is it
// real); this owns only the bookkeeping that follows from the counts.

import type { CommandModule } from 'yargs';
import { certifierMatchesRound, roundModelIdFrom } from './lib/round-model.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { getCliVersion } from '../../utils/version.js';
import {
  coverageFromTranscripts,
  verificationGaps,
  TranscriptsUnavailableError,
} from './lib/coverage.js';
import {
  compressSummary,
  SEVERITIES,
  SOURCES,
  type Severity,
  type Source,
} from './findings.js';
import { BRIEFS } from './lib/agent-briefs.js';
import {
  budgetStopDisclosure,
  budgetStopEntry,
  budgetStopEntryZh,
  roundCapStopEntry,
  roundCapStopEntryZh,
  roundCapStopDisclosure,
  readBudgetStop,
} from './lib/deadline.js';
import { LARGE_REVERSE_AUDIT_ROUNDS } from './lib/budget.js';
import { shellQuotePath } from './lib/shell-quote.js';
import {
  HOSTNAME_RE,
  gh,
  getGhHost,
  isOwnerRepo,
  normalizeGhHostForUrl,
  resolveGhHost,
  setGhHost,
} from './lib/gh.js';
import {
  isPositivePrNumber,
  hasExecutableScript,
  requiredAgents,
  reviewMode,
  type RosterPlan,
} from './lib/roster.js';
import { repositoryContextOf } from './lib/repository-context.js';
import { layerAuditGate } from './lib/layer-audit-gate.js';
import { diffHashOf, type ScriptLintReport } from './script-lint.js';
import type { TestPlanReport } from './test-plan.js';
import {
  LEDGER_BODY_FILE,
  LEDGER_ID_READBACK,
  LEDGER_MAX_ID,
  isLedgerFinding,
  isStandInName,
  normalizeLedgerFinding,
  LEDGER_MAX_BYTES,
  LEDGER_MAX_ROUND,
  LEDGER_UNKNOWN_FILE,
  serializeLedger,
  streakOf,
  volumeOf,
  type Ledger,
  type LedgerFinding,
} from './lib/ledger.js';
import { mdField, stripCommentGrammar } from './lib/md-field.js';
import {
  convergenceAdvisory,
  convergenceAssessment,
  diagnoseConvergence,
  isFreshDraft,
  recommendationsFor,
  renderConvergenceDiagnosis,
  renderMechanismHealth,
  type ConvergenceAssessment,
  type Recommendation,
  type CriticalFloorKind,
  type DraftedFinding,
  type PrevRound,
} from './lib/convergence.js';
import {
  CRITICAL_PREFIX,
  LEADING_INVISIBLE_RE,
  SUGGESTION_PREFIX,
  carriedClaimLine,
  countInlineFindings,
  markerStrippedBody,
  severityOf,
  stripSeverityPrefix,
  unmarkedComments,
  type DraftedComment,
} from './lib/inline-counts.js';
import {
  MODEL_ID_MAX_CHARS,
  footerVersion,
  isFooterSafeModelId,
  rendersAsNothing,
  reviewFooter,
  stripCommentMarkerLines,
  stripFooterSpans,
  stripForUnattributedPost,
  stripReviewFooter,
} from './lib/review-footer.js';
import { operatorReviewSettings } from './lib/review-settings.js';
import { recordedSeverityFloor } from './lib/authorization.js';

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

/**
 * The floor above which a zero-finding Approve is disclosed as low-signal,
 * in the plan's `srcDiffLines` — diff lines belonging to `source` files, the
 * same field the review topology is chosen from (tests, docs and generated
 * files excluded by construction). A trivial edit stays under it even
 * scattered one changed line per hunk (~8 diff lines each with context and
 * hunk header, plus 4 file-header lines), and the smallest diff the topology
 * gate calls big is 500 — so the floor sits well past the typo-fix class and
 * well before "big".
 */
export const LOW_SIGNAL_SRC_DIFF_LINES = 100;

/**
 * How much a source diff must have grown since the review first measured it
 * before the approach signal fires. A module constant rather than a setting,
 * matching `LOW_SIGNAL_SRC_DIFF_LINES` beside it: the round threshold is the
 * knob an operator would reach for, and a second one buys nothing but a second
 * thing to get wrong. 3x is below the 4x the measured incident reached and
 * well above the drift a normal review round produces.
 */
export const APPROACH_GROWTH_FACTOR = 3;

/**
 * Rounds before the approach signal can fire, when no operator setting
 * overrides it. Five is the repo's own number for "this has gone on long
 * enough" — AGENTS.md uses it for the review round budget.
 */
export const APPROACH_ROUNDS_DEFAULT = 5;

/**
 * GitHub's hard limit on a review body. A POST over it is rejected whole —
 * the review's blockers included — which is the worst failure this module
 * has: a run that found the bug and could not say it.
 *
 * Every individually-bounded contributor already respects a budget (the
 * ledger marker's 8 KiB, the deferral list's 20 × 240). The rest —
 * the unresolved-blocker list, the disclosure sentences, the body
 * Criticals — is model-written prose with no upstream cap, so the FINAL
 * body needs its own budget: measured once, trimmed in a fixed order, and
 * disclosed. A probe composed 67,039 characters on a real shape.
 */
const BODY_MAX_CHARS = 65536;

/**
 * Room held back for the ledger marker (appended after the body composes)
 * plus its separator, and a margin for the trim notice itself. Reserved
 * only when the plan names a PR, because only then can a marker ride.
 */
const MARKER_RESERVE = LEDGER_MAX_BYTES + 2;
const BODY_SAFETY_MARGIN = 512;

/**
 * Does this plan name a pull request? The budget and the marker must not
 * disagree about whether a marker will ride, so both ask here.
 */
function planNamesPr(planPath: string | undefined): boolean {
  try {
    if (!planPath) return false;
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
      prNumber?: unknown;
    };
    // The module's ONE predicate for this, shared with every other consumer
    // (`planPrIdentity`, the report names, the round count): a second copy
    // drifts, and a hand-rolled one already did — it accepted the string
    // `'0'` this one rejects, so the budget reserved marker room on a plan
    // the anchor consumers read as PR-less.
    return isPositivePrNumber(plan?.prNumber);
  } catch {
    return false;
  }
}

/**
 * The deferred-suggestions list's rendered bounds, shared by the
 * duplicate-drop account; the cannot-tell account shares the char cap.
 * Module-scoped because two surfaces read the line cap: the body renderer
 * that applies it, and `verdictLine`, whose "(listed in the body)" claim
 * must turn cap-aware the moment the list overflows — a verdict that counts
 * 21 over a body that lists 20 is a false record persisted into the
 * archived report.
 */
const MAX_DEFERRED_SUGGESTION_LINES = 20;
const MAX_DEFERRED_SUGGESTION_CHARS = 240;

/**
 * The deterministic source tags, exactly as the body-Critical scan reads
 * them (~`nonDeterministicBodyCriticals`): a `[build]`/`[test]`/`[probe]`
 * finding is pre-confirmed and skips Step 4 by design, so it never produces
 * a verifier delivery — demanding one for it is an unsatisfiable cap.
 */
const DETERMINISTIC_TAG_RE = /\[(?:build|test|probe)\]/i;

/**
 * A deferred finding, TYPED. The convergence posture removes findings from
 * posting through exactly one channel, and for four review rounds that
 * channel was free text re-parsed for provenance it did not carry: a
 * separator regex classified deterministic source, a marker regex caught
 * mis-routed Criticals, and every round's probe found the spelling each
 * regex excluded — kebab paths, the SKILL's own aggregate suffix, an en
 * dash, `(Critical)`, a title-borne `[test]`. The class closes only by
 * carrying the fields: the model already holds `file`/`line`/`source`/
 * `severity`/`title` for every finding in the artifact it wrote in Step 6,
 * so the entry carries them, `deterministic` derives from `source`, the
 * relocation from `severity`, and the rendered `file:line — [source] title`
 * is formatting — nothing downstream ever parses it back.
 *
 * Validated at the boundary like every other model-written state field:
 * a present entry of the wrong shape is refused (a NaN count is refused
 * the same way), because a channel that un-posts findings must not be
 * guessed at.
 */
export interface DeferredEntry {
  file: string;
  line?: number;
  /** The finding's source tag — decides deterministic (`build`/`test`/`probe`). */
  source: Source;
  /**
   * The finding's severity. Only `Suggestion` defers; a `Critical` here is
   * RELOCATED into the body Criticals (a Critical is never deferred), and a
   * `Nice to have` is refused (terminal-only, never publishable).
   */
  severity: Severity;
  /** One-line claim, rendered inside a code span; a location count may be appended. */
  title: string;
  /** For a pattern aggregate: how many further locations the finding covers. */
  locations?: number;
}

const DETERMINISTIC_SOURCES: ReadonlySet<Source> = new Set([
  'build',
  'test',
  'probe',
]);

/** Render one entry as the human line — formatting only, never re-parsed. */
export function renderDeferredEntry(entry: DeferredEntry): string {
  const loc =
    entry.line !== undefined ? `${entry.file}:${entry.line}` : entry.file;
  const agg =
    entry.locations && entry.locations > 0
      ? ` (+${entry.locations} locations)`
      : '';
  return `${loc}${agg} — [${entry.source}] ${entry.title}`;
}

/**
 * One model-written entry flattened to a single line — every CommonMark
 * line ending (`\n`, `\r\n`, or a bare `\r`) becomes a space. Split/join,
 * not a whitespace-normalising regex replace: that backtracks quadratically
 * on a long whitespace run with no line ending in it, and these entries are
 * model-written with no length cap — one such entry stalled a measured
 * probe for seconds at 80k characters.
 */
function collapseToLine(text: string): string {
  return text
    .split(/\r\n?|\n/)
    .map((seg) => seg.trim())
    .filter((seg) => seg !== '')
    .join(' ');
}

/**
 * The per-entry bound the deferred, relocated, duplicate-dropped, AND
 * cannot-tell exits apply: collapse line endings, cap at
 * MAX_DEFERRED_SUGGESTION_CHARS
 * without splitting a surrogate pair, mark a trim with an ellipsis. The
 * relocation exit once bypassed all of it (round-9 finding): twenty-five
 * relocated 4,000-char titles spliced ~100 KB of unbounded model text into
 * the body — the whole review lost at GitHub's 65,536 limit, precisely what
 * the cap on the deferred exit was added to prevent. The free-form
 * bodyCriticals exit is the exception: its entries are the review's only
 * copy of their Criticals, quoted as-is and left unbounded.
 */
function boundDeferredLine(rendered: string): string {
  const collapsed = collapseToLine(rendered);
  let oneLine = collapsed.slice(0, MAX_DEFERRED_SUGGESTION_CHARS);
  // The cap slices UTF-16 code units; a cut landing inside a surrogate pair
  // leaves a lone high surrogate that serializes as U+FFFD into the posted
  // body — and the zh clause keeps titles untranslated, so astral CJK/emoji
  // at the boundary are a real input, not a curiosity.
  if (/[\uD800-\uDBFF]/.test(oneLine.charAt(oneLine.length - 1))) {
    oneLine = oneLine.slice(0, -1);
  }
  // A trimmed entry must say so — a claim cut mid-sentence otherwise renders
  // as a complete finding line on the PR record. A cut inside a trailing
  // `comment <id>` ref drops the fragment first: the kept digit prefix
  // still satisfies the linkifier's digit floor and would anchor a comment
  // that does not exist.
  if (oneLine.length < collapsed.length) {
    oneLine =
      oneLine.replace(/\s*\(?(?:issue-level )?comment(?: \d*)?$/i, '') + '…';
  }
  return oneLine;
}

function toDeferredEntries(value: unknown): DeferredEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new TypeError(
      `compose-review: deferredSuggestions must be an array of {file, line?, source, severity, title, locations?} entries, got ${JSON.stringify(value)}`,
    );
  }
  return value.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new TypeError(
        `compose-review: deferredSuggestions[${i}] must be an object {file, line?, source, severity, title, locations?} — a free-text entry is not accepted, the channel is typed`,
      );
    }
    const o = raw as Record<string, unknown>;
    const file = typeof o['file'] === 'string' ? o['file'].trim() : '';
    const title =
      typeof o['title'] === 'string'
        ? stripReviewFooter(o['title']).trim()
        : '';
    const source = o['source'];
    const severity = o['severity'];
    const line = o['line'];
    const locations = o['locations'];
    if (file === '' || title === '') {
      throw new TypeError(
        `compose-review: deferredSuggestions[${i}] needs a non-empty file and title`,
      );
    }
    if (typeof source !== 'string' || !SOURCES.includes(source as Source)) {
      throw new TypeError(
        `compose-review: deferredSuggestions[${i}].source must be one of ${SOURCES.join('|')}, got ${JSON.stringify(source)}`,
      );
    }
    if (
      typeof severity !== 'string' ||
      !SEVERITIES.includes(severity as Severity)
    ) {
      throw new TypeError(
        `compose-review: deferredSuggestions[${i}].severity must be one of ${SEVERITIES.join('|')}, got ${JSON.stringify(severity)}`,
      );
    }
    if (severity === 'Nice to have') {
      throw new TypeError(
        `compose-review: deferredSuggestions[${i}] is a Nice to have — terminal-only findings are never deferred to the PR; drop it from the state`,
      );
    }
    if (
      line !== undefined &&
      line !== null &&
      (typeof line !== 'number' || !Number.isInteger(line) || line < 1)
    ) {
      throw new TypeError(
        `compose-review: deferredSuggestions[${i}].line must be a positive integer when present`,
      );
    }
    if (
      locations !== undefined &&
      locations !== null &&
      (typeof locations !== 'number' ||
        !Number.isInteger(locations) ||
        locations < 0)
    ) {
      throw new TypeError(
        `compose-review: deferredSuggestions[${i}].locations must be a non-negative integer when present`,
      );
    }
    return {
      file,
      ...(typeof line === 'number' ? { line } : {}),
      source: source as Source,
      severity: severity as Severity,
      title,
      ...(typeof locations === 'number' && locations > 0 ? { locations } : {}),
    };
  });
}

/**
 * The deferral channel's split, shared by the body composer and the ledger
 * marker: `Critical` entries are RELOCATED into the body Criticals (a
 * Critical is never deferred — it counts toward `C`, blocks, and rides the
 * machine ledger), the rest defer. One split, two readers, no parsing.
 */
function splitDeferralChannel(raw: unknown): {
  deferred: DeferredEntry[];
  relocated: string[];
  /** Relocated entries whose `source` is deterministic — no verifier owed. */
  relocatedDeterministic: number;
} {
  const entries = toDeferredEntries(raw);
  const relocatedEntries = entries.filter((e) => e.severity === 'Critical');
  return {
    deferred: entries.filter((e) => e.severity !== 'Critical'),
    relocated: relocatedEntries.map(
      (e) =>
        `${mdField(boundDeferredLine(renderDeferredEntry(e)))} _(relocated from the deferral channel — a Critical is never deferred, it posts)_`,
    ),
    relocatedDeterministic: relocatedEntries.filter((e) =>
      DETERMINISTIC_SOURCES.has(e.source),
    ).length,
  };
}

/**
 * The ONE statement of the floor normalisation, shared by the enforcement
 * gate below and `composeReviewBody`'s licence block. Both run over the same
 * `severityFloor` in a single compose call, feeding two decisions that must
 * agree (enforcement fires only where the deferral licence holds) — two
 * restatements is the predicate-drift class `lib/inline-counts.ts`'s header
 * exists to prevent.
 */
export function normalizeSeverityFloor(value: unknown): string | undefined {
  // A non-string reads as no floor rather than riding through as itself:
  // every consumer compares against the three literals, so a number or an
  // object already matched nothing — returning `undefined` for them keeps
  // that behaviour while letting the callers narrow from `string` instead
  // of `unknown` (a consumer comparing `unknown` to a literal is a
  // type-level trap this signature removes).
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
}

/**
 * Does the posting floor resolve to `critical` for the round being composed?
 *
 * The ONE statement of that rule. `floorEnforcedReroute` ACTS on it, moving
 * otherwise-postable Suggestions into the deferral channel; the convergence
 * rendering READS it so its handling advice never recommends a posture the
 * round is already running under — a paragraph telling the author to drop to
 * `--severity-floor critical` inside the very body whose floor-enforcement
 * note says Suggestions were already moved past that floor.
 */
export function criticalFloorKind(
  severityFloor: unknown,
  contextUnavailable: boolean,
  prevRound: number,
  signalEngaged?: boolean,
): CriticalFloorKind | undefined {
  // The REPORTING reading, and it folds an absent or unrecognisable floor
  // into `auto` the way `composeReviewBody` already does ("A floor the
  // module does not recognise — absent, null, or a model-transcribed
  // spelling drift — is folded into ONE state"). The value is model-written
  // and the SKILL's field list is prefaced "omit what does not apply", so
  // absence is reachable — and reading it as "no floor at all" made the
  // round advise dropping to a floor SKILL Step 6's prose posture already
  // had it running under, which is the exact failure this predicate exists
  // to prevent.
  //
  // Deliberately NOT shared with the enforcement reading below. Enforcement
  // moves findings out of the posting set, and doing that on a posture this
  // module had to guess at is the direction that loses work; the fail-open
  // there is pre-existing and stays.
  const raw = normalizeSeverityFloor(severityFloor);
  // Only genuine ABSENCE folds — a present-but-unrecognisable value is a
  // state this module cannot read, and folding THAT made the body contradict
  // itself: the volume advice said the round "already resolves to a critical
  // posting floor" while the deferral-licence clause in the same body said
  // the floor carried no recognisable value and the enforcement backstop —
  // strict on purpose — moved nothing. The wrong stamp then became the next
  // round's comparison baseline.
  const absent = severityFloor === undefined || severityFloor === null;
  const floor =
    raw === 'critical' || raw === 'suggestion' || raw === 'auto'
      ? raw
      : absent
        ? 'auto'
        : undefined;
  return floorResolvesCritical(
    floor,
    contextUnavailable,
    prevRound,
    signalEngaged,
  );
}

/**
 * Whether the floor resolves to `critical` for ENFORCEMENT — strict, so a
 * posture the state never named cannot move a finding out of the posting
 * set. `floorEnforcedReroute` acts on this; the reporting reading above is
 * what the round says about itself.
 *
 * The residual-risk signal (#9410) reads THIS one, not the reporting
 * reading: its "the severity floor will not converge this loop" claim is
 * about Suggestions actually having left the posting set, which is what a
 * strict reading is. Shared rather than restated for the reason the whole
 * pair exists — two spellings of one predicate is the drift class
 * `normalizeSeverityFloor` above was extracted to prevent.
 */
export function criticalFloorInEffect(
  severityFloor: unknown,
  contextUnavailable: boolean,
  prevRound: number,
  signalEngaged?: boolean,
): boolean {
  return (
    floorResolvesCritical(
      normalizeSeverityFloor(severityFloor),
      contextUnavailable,
      prevRound,
      signalEngaged,
    ) !== undefined
  );
}

/** Does this resolved floor mean `critical` for the round after `prevRound`? */
function floorResolvesCritical(
  floor: string | undefined,
  contextUnavailable: boolean,
  prevRound: number,
  signalEngaged?: boolean,
): CriticalFloorKind | undefined {
  // `prevRound` is the PREVIOUS posted round, so the review being composed
  // is `prevRound + 1` — spelled out because the equivalent `prevRound >= 5`
  // reads as a fencepost error against SKILL Step 6's "from round 6 it is
  // critical".
  const thisRound = prevRound + 1;
  if (floor === 'critical') return 'explicit';
  if (floor === 'auto' && !contextUnavailable && thisRound >= 6) {
    return 'auto-resolved';
  }
  // The signal-driven early trigger (#9903): the convergence diagnosis's
  // own not-falling trend, sustained for the streak's bar of consecutive
  // rounds, engages the floor ahead of the round-6 schedule — the tool
  // acting on the `stem-surface` advice it already prints. Same fail-open
  // shape as the schedule arm: the round unknowable (context-unavailable)
  // disengages it, and it lives ONLY in the `auto` arm — an explicit
  // `suggestion` floor is the operator turning the posture off, streak or
  // no streak.
  if (floor === 'auto' && !contextUnavailable && signalEngaged === true) {
    return 'auto-signaled';
  }
  return undefined;
}

/**
 * The posting floor, enforced in code — the backstop for the posture SKILL
 * Step 6 resolves in prose.
 *
 * Step 6 tells the MODEL to route otherwise-postable Suggestions into the
 * deferral channel once the floor resolves to `critical` (an explicit
 * `--severity-floor critical`, or `auto` from round 6). A model instruction
 * is the layer of this pipeline that has failed at every boundary it
 * guarded (this file's own header history), and the floor is the OPERATOR'S
 * configured policy — moving a drafted Suggestion out of the inline set is
 * faithful execution of that policy, not a tool decision. So the move also
 * exists as code, here, where the drafts are already in hand.
 *
 * Enforcement fires ONLY where the deferral licence already holds: an
 * explicit `critical` floor at any round, `auto` at round ≥ 6, or `auto`
 * with the flat-trend streak at its bar (#9903) — the `auto` arms only
 * with the round knowable. Everything else fails OPEN exactly as the
 * posture itself does — an unrecognisable floor, `auto` before round 6 with
 * the streak below its bar, `auto` in the context-unavailable state (the
 * round is unknowable), `--severity-floor suggestion` (posture off): a
 * posting bar in doubt posts. The rounds-2–5
 * code-age rule stays model-side on purpose — it needs the worktree git
 * checks this module does not have.
 *
 * The entries are CONSTRUCTED typed rather than routed through
 * `toDeferredEntries`: that boundary validates a MODEL-written channel and
 * throws on malformed shapes, and a throw here would lose the whole round
 * over a comment this code itself chose to move (the cap-not-refusal
 * doctrine). A drafted comment that cannot yield a usable entry — no
 * path — is left inline instead (fail open; `submit`'s consistency gate
 * refuses pathless comments before anything posts anyway).
 */
export function floorEnforcedReroute(
  severityFloor: unknown,
  contextUnavailable: boolean,
  prevRound: number,
  drafted: ReadonlyArray<{ path?: unknown; line?: unknown; body?: unknown }>,
  signalEngaged?: boolean,
): { indices: number[]; entries: DeferredEntry[] } {
  if (
    !criticalFloorInEffect(
      severityFloor,
      contextUnavailable,
      prevRound,
      signalEngaged,
    )
  ) {
    return { indices: [], entries: [] };
  }
  const indices: number[] = [];
  const entries: DeferredEntry[] = [];
  drafted.forEach((c, i) => {
    if (severityOf(c) !== 'suggestion') return;
    const body = typeof c.body === 'string' ? c.body : '';
    const claim = carriedClaimLine(body);
    // The floor excludes deterministic findings — by their source (SKILL
    // Step 6: a `[build]`/`[test]`/`[probe]` finding is pre-confirmed and
    // the posture leaves it inline at any floor). The inline channel
    // carries no source field, so the tag convention decides, through the
    // same predicate the body-Critical scan reads deterministic by — but
    // over the CLAIM LINE only, never the whole body: the body's tail is
    // writable surface the state controls (the attribution footer is built
    // from the model-written `modelId` and appended before this predicate
    // runs at the submit boundary), and a whole-body match handed that
    // surface a kill-switch — one `[test]` in a footer carved out every
    // drafted Suggestion at once. A first-line prose mention still reads
    // deterministic and stays inline — the fail-open direction of every
    // other arm here — but the window is one line the tag convention owns,
    // not the entire comment.
    if (claim !== null && DETERMINISTIC_TAG_RE.test(claim)) return;
    const file =
      typeof c.path === 'string' && c.path.trim() !== '' ? c.path : null;
    if (file === null) return;
    // The title carries the WHOLE marker-stripped body, collapsed to one
    // line — not just the claim line: the skill mandates multi-line
    // Suggestion bodies (failure scenario, suggested fix), and a moved
    // comment's body leaves every posted surface, so a first-line-only
    // title silently dropped the proposed fix from the record. The render
    // bound (`boundDeferredLine`) still caps the line; the forged-footer
    // strip keeps an appended attribution out of the record. A carried id
    // (`R2-4: …`) stays at the front so the human record keeps the
    // cross-round identity; an all-marker comment gets the same locatable
    // fallback the ledger builder uses.
    const title = collapseToLine(
      stripReviewFooter(markerStrippedBody(body) ?? ''),
    );
    indices.push(i);
    entries.push({
      file,
      ...(typeof c.line === 'number' &&
      Number.isSafeInteger(c.line) &&
      c.line > 0
        ? { line: c.line }
        : {}),
      source: 'review',
      severity: 'Suggestion',
      title: title !== '' ? title : '(comment carried no text)',
    });
  });
  return { indices, entries };
}

/**
 * Reads a PR's description body, given its `owner/repo` and number. The one
 * production implementation calls `gh pr view`; the bilingual fallback uses it
 * to recover the Han signal from the live PR when the plan does not carry it.
 */
export type PrBodyFetcher = (ownerRepo: string, prNumber: string) => string;

export interface ComposeReviewInput {
  /**
   * Critical findings anchored as inline `comments` entries.
   *
   * A seam for the two CLI boundaries and the tests — NEVER a field of the
   * model-written state JSON. Both boundaries derive it from the drafted
   * comments (`compose-review --comments`, `submit`'s payload) and refuse it
   * when the JSON carries it: a count handed over beside the thing it counts
   * is a count that can disagree with it, and a dogfooded report-only run —
   * where nothing downstream recounts — moved its one Critical from
   * `bodyCriticals` to an inline comment, lost the count on the way, and this
   * function printed `Verdict: Approve` over a Critical the report listed.
   */
  criticalsInline?: number;
  /** Suggestion findings anchored inline. Same seam, same refusal. */
  suggestionsInline?: number;
  /**
   * Critical descriptions whose only copy lives in the review body — the
   * last-resort unmappable findings and 422-relocated ones. They count
   * toward `C` exactly like anchored Criticals.
   */
  bodyCriticals?: string[];
  /**
   * Suggestions discarded as unanchorable (offline validation or 422). A
   * count, as the Step 7 prose prescribes; the list form that older skill
   * revisions wrote — `[]`, or one entry per discarded item — is accepted
   * and counted by its length.
   */
  suggestionsDiscarded?: number | readonly unknown[];
  /**
   * Suggestions this review confirmed but did not re-post because they are
   * already reported on the PR (a prior round, or a concurrent reviewer) —
   * one entry each, naming the finding and where it already lives, e.g.
   * `R1-1 precheck-pr pin — already reported (comment 3788857375)`. Distinct
   * from `suggestionsDiscarded`: these anchored fine, and rendering them
   * under the anchor-failure sentence posts a claim the resolver's output
   * contradicts. They still count toward `S` — a run must not read as
   * zero-finding because its findings were duplicates.
   */
  suggestionsDroppedAsDuplicates?: string[];
  /**
   * The findings the convergence posture deferred — Step 6's round-aware
   * posting discipline (from round 6 — or earlier once the flat-trend
   * streak engages the floor, #9903 — or under an explicit
   * `--severity-floor critical`, and the rounds-2-5 code-age rule). TYPED
   * entries — see
   * `DeferredEntry`: only otherwise-postable high-confidence Suggestions
   * belong here (a `Critical` is relocated into the body Criticals, a
   * `Nice to have` is refused; low-confidence findings stay terminal-only and
   * never enter the state). They are neither drafted inline nor counted
   * toward `S` — a deferral must not regenerate a review round — but they
   * must not vanish either: the body renders them as a disclosed,
   * NON-capping list, so the record survives on the PR while the round
   * stays convergent. A deferral never withholds the ledger anchor: it is a
   * posting decision, not unreviewed scope.
   */
  deferredSuggestions?: DeferredEntry[];
  /**
   * The UNRESOLVED posting floor from the Step 1 verdict (`critical`,
   * `suggestion`, or the literal `auto`) — never the level `auto` resolved
   * to this round: the module resolves `auto` itself from the side-file
   * round, and a pre-resolved `suggestion` is indistinguishable from the
   * operator's posture-off override (a shipped regression, closed in round
   * 5). Carried so the deferral channel's precondition is checkable:
   * deferrals are legitimate under a
   * `critical` floor at any round, and under `auto` from round 2 (the
   * code-age rule) — never under an explicit `suggestion` floor (the
   * operator turned the posture off), never on round 1 of `auto` (no
   * posture, no age reference), never under `auto` in the
   * context-unavailable state (the round is unknowable), and never ABSENT
   * beside a non-empty deferral list: the field ships in the same PR as the
   * channel, so omission is fail-closed — a dropped echo must not silently
   * re-license what an explicit `suggestion` floor forbade. Unlicensed
   * shapes cap; they never throw.
   */
  severityFloor?: 'critical' | 'suggestion' | 'auto';
  /**
   * This round's convergence census, from SKILL Step 6's fix-induced rule:
   * `fresh` is how many findings first appear this round, `induced` how many
   * of those the fix-induced rule ATTRIBUTED to the change that answered a
   * previous entry. Attributed, not merely on-new-lines: a pull request whose
   * author pushed a feature between rounds has most of its new findings on
   * new lines and created none of them out of the review, so a bar built on
   * the looser number would block a pull request for growing.
   *
   * The model OBSERVES; this module DECIDES. Splitting it that way is not
   * ceremony: the census needs the worktree's git and the previous round's
   * age reference, which only the orchestrator holds, while the threshold and
   * the streak need the side file and the marker, which only this module
   * holds — and a verdict computed where the prose is written is a verdict
   * the prose can talk out of. Absent on every non-PR target, on a skill
   * revision that predates the field, and whenever the age reference was
   * unusable; absence carries the streak forward untouched rather than
   * resetting it, because "not measured" is not "measured and converging".
   */
  convergence?: { fresh?: unknown; induced?: unknown };
  /**
   * Existing Criticals already on the PR whose Step 6 re-check landed on
   * `cannot tell` — one line each (location + what could not be decided).
   * Not counted in `C` (the review did not confirm them), but their
   * presence forbids an approval.
   */
  cannotTellCriticals?: string[];
  /** Uncoverable chunks, e.g. `"chunk 5 (src/big.min.js)"`. */
  uncoverableChunks?: string[];
  /**
   * Dimensions nobody reviewed. A bare name (`"security"`) means its agent
   * whiffed twice and gets the standard explanation; an entry carrying its
   * own reason after an em-dash (`"issue-fidelity — linked issue #123 could
   * not be fetched"`) is rendered verbatim.
   */
  unreviewedDimensions?: string[];
  /**
   * The plan report from Step 1.
   *
   * Coverage is derived from it plus the harness's transcripts — it is not an
   * input. See the recomputation below for why a caller does not get to say
   * whether the diff was read.
   */
  planPath?: string;
  /**
   * The cumulative reverse-audit findings file at loop end — the same file
   * every round's `agent-prompt --findings` received, after the final merge.
   * compose-review reads it itself for the one fact Step 6's confirmed-only
   * read is otherwise a model's word on: whether any entry still carries the
   * `— [unverified]` tag. A surviving tag means no verifier ever ruled on
   * that entry, and the verdict is capped whether or not the report excluded
   * it. A path that does not read fails closed — "could not show" and "was
   * not" read the same to the person the verdict posts at. Omitted, the
   * check is off: every non-high review, which runs no Step 5.
   */
  findingsPath?: string;
  /**
   * Where to look for the harness's records. Defaults to the environment the CLI
   * exported. A test seam only — production never passes it, and a model cannot:
   * `compose-review` reads its input as JSON, and this is not serialisable into
   * anything that would change where the transcripts are found on a real run.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * How the bilingual fallback reads the live PR body when the plan carries a
   * PR identity but no `prDescriptionHasHan` (a `plan-diff` plan, or one an
   * improvising orchestrator wired in place of `fetch-pr`'s report). A test
   * seam ONLY: production leaves it undefined and the CLI reads the PR with
   * `gh pr view`. The handler **strips it from the input JSON** before use (the
   * same way it strips `env`), so a model cannot supply one — not even a
   * non-function value that would throw past the default and drop the fold. It
   * can neither force nor suppress the Chinese fold, which is the whole point of
   * keeping the signal the CLI's own.
   */
  prBodyFetcher?: PrBodyFetcher;
  /** Step 1's lightweight `pr-context` fetch failed. */
  contextUnavailable?: boolean;
  presubmit?: {
    downgradeApprove?: boolean;
    downgradeRequestChanges?: boolean;
    downgradeReasons?: string[];
  };
  /**
   * The drafted inline comments this review is posting — the ledger's own
   * input. A seam like `criticalsInline`, filled by the two CLI boundaries
   * from the same array they count, never by the model's state JSON (the
   * handler strips it, as it does `env` and `prBodyFetcher`).
   */
  draftedComments?: Array<{ path?: unknown; line?: unknown; body?: unknown }>;
  /**
   * Model id for the footer, e.g. `qwen3.7-max`. The marker's anchor takes
   * the session-published identity instead when the CLI boundary injects one
   * (`composeReview`'s `runtimeModelId`); this field is its fallback for runs
   * no session published, and what the visible footer names either way.
   */
  modelId: string;
}

export interface ComposeReviewResult {
  event: ReviewEvent;
  body: string;
  /** The table row before caps and downgrades — for the terminal report. */
  baseEvent: ReviewEvent;
  /** Which cap states applied (empty when none). */
  cappedBy: string[];
  /** True when a presubmit flag actually changed the event. */
  downgraded: boolean;
  /**
   * What the presubmit downgrade moved the event *from*, when it moved one.
   *
   * `baseEvent` cannot answer this: it is the row before caps AND downgrades, so a
   * `REQUEST_CHANGES` that a cap already softened to `COMMENT` before the downgrade
   * ran would look the same as one the downgrade itself moved. This names the
   * transition the downgrade made, so the terminal verdict can say a Request
   * changes — a review with confirmed Criticals — was downgraded, and not let it
   * read as "Comment, nothing blocking".
   */
  downgradedFrom: 'Approve' | 'Request changes' | null;
  /**
   * The orchestrator-facing fix for each coverage/verification gap the body
   * discloses — printed to stderr by the command, never rendered into the body.
   * The body tells the PR author what the review cannot certify; this tells the
   * operator which command repairs it. Two registers, two channels.
   */
  remediation: string[];
  /**
   * How many non-Critical findings the convergence posture deferred — the
   * count of `deferredSuggestions` entries that survived validation, plus
   * any CLI floor-enforced reroutes (below). On the verdict surface so
   * `verdictLine` can say a deferrals-only Approve deferred findings
   * rather than implying none existed: the low-signal sentence's premise
   * is "zero findings", and a deferral is a finding.
   */
  deferredCount: number;
  /**
   * Indices (into the caller's drafted-comments array) of Suggestion
   * comments the CLI moved into the deferral list under a resolved
   * `critical` posting floor — SKILL Step 6's posture, enforced in code as
   * the backstop for the model-side resolution (`floorEnforcedReroute`).
   * The caller that owns the posting array (`submit`) removes exactly
   * these before the write; they are already counted in `deferredCount`,
   * rendered in the body's deferral list with a disclosure sentence, and
   * excluded from the ledger work list — the same semantics as a
   * model-side deferral. Empty when nothing was enforced. A posting
   * decision, never a cap: `cappedBy` is untouched and the anchor rides
   * iff the round is otherwise clean.
   */
  floorEnforced: number[];
  /**
   * How many inline comments this round will post — the posting set after
   * floor enforcement, i.e. what `submit` sends. Convergence telemetry: it
   * rides the ledger marker for the next round to read, and the terminal
   * report states it so the operator sees this round's contribution to the
   * PR's comment volume without counting threads by hand. Decides nothing.
   */
  postedInline: number;
  /**
   * How many of `postedInline` this round reported for the FIRST time —
   * neither a re-post of a still-standing ledger entry nor an unmarked
   * draft. The number the convergence trend runs on, stamped into the marker
   * beside the total so the next round can compare like with like.
   */
  postedFresh: number;
  /**
   * The convergence paragraph, when a signal fired — the SAME text the body
   * carries, returned so a terminal copy exists.
   *
   * The overflow ladder can shed this paragraph — last of its ranks, and
   * see the convergence block below for why last — and its notice tells the
   * author the trimmed sections "still hold — read them in the terminal
   * report". That was a false record while this text lived only inside the
   * body composer: unlike the deferral list (findings artifact) and the
   * not-reviewed disclosures (the model's own inputs), a diagnosis derived
   * from the side file has no other copy anywhere. Ranking it last does not
   * retire this copy — it makes it the one that matters, because the rounds
   * that reach trim rank 3 are the rounds that shed everything.
   */
  convergence?: { en: string; zh: string };
  /**
   * The handling recommendations this round's diagnosis matched, as a closed
   * code set with the deterministic fact each was matched from.
   *
   * The machine-readable half of the observation, and the point of the whole
   * advisory: a caller applies ITS policy to these — stop the automatic
   * loop, hand to a human, open a follow-up issue — without parsing prose,
   * and without this module owning a threshold or a decision. Absent when no
   * signal fired, exactly like the paragraph.
   */
  recommendations?: Recommendation[];
  /**
   * The mechanism-health disclosure, when one fired — the SAME text the body
   * carries, returned so a terminal copy exists.
   *
   * The overflow ladder sheds this paragraph before every other, and its
   * notice tells the author the trimmed sections "still hold — read them in
   * the terminal report". That was a false record while this text lived only
   * inside the body composer, exactly as it was for the convergence
   * paragraph: a disclosure derived from the round's own caps has no other
   * copy anywhere unless the result carries one.
   */
  health?: { en: string; zh: string };
  /**
   * The previous round's `postedInline`, recovered from the side file when
   * it recorded one. Absent on round 1, on a recovery miss, and on any
   * predecessor that predates the field — none of which is "posted
   * nothing", which is why absence is distinct from zero here.
   */
  prevPostedInline?: number;
  /**
   * The persistently-critical convergence assessment (#9410), present only
   * when the carried telemetry shows the loop is in that shape: Criticals
   * stood in the previous round's work-list AND stand again this round, with
   * the two-round posting window present and not shrinking. Advisory only —
   * it never moves the event, never caps, never blocks; it surfaces the
   * `land-with-residual-risk` recommendation and a residual-risk inventory
   * scaffold for the maintainer's risk-acceptance decision. Absent whenever
   * the shape is not provable; every input degrades open, so absence is the
   * fail-safe reading, never a suppressed finding.
   *
   * Named for its exit rather than for `convergence` above, which is the
   * loop-settling OBSERVATION's rendered paragraph: two features share the
   * word, they can fire in the same round, and one field name over both
   * would have made the composed JSON — and every consumer keying on it —
   * unable to say which it was reading.
   */
  residualRisk?: ConvergenceAssessment;
  /**
   * What the body budget had to give up to fit GitHub's limit, when it did.
   * On the result because `verdictLine` — printed to stderr, persisted in
   * the composed JSON, copied into the archived report — otherwise keeps
   * claiming the deferral list is "listed in the body" over a body that
   * lists none: the stronger form of the false record this module already
   * refuses for the line cap.
   */
  bodyTrim: {
    /** Disclosure sections dropped whole, counted in the body. */
    sections: number;
    /** The deferral display was one of them. */
    deferralList: boolean;
    /**
     * The bilingual fold was dropped — the first rung, and the only one that
     * costs no content: the English above it says the same thing.
     */
    fold: boolean;
    /** The un-trimmable remainder still overflowed and was cut. */
    truncated: boolean;
  };
  /**
   * Set on an APPROVE composed from zero findings over a non-trivial source
   * diff (the plan's `srcDiffLines` above `LOW_SIGNAL_SRC_DIFF_LINES`).
   * Disclosure only — the event never moves on it: the coverage gate proves
   * the agents READ the diff, not that the review had discriminating power,
   * and a dogfooded weak-model run drafted nothing from its whole roster on a
   * diff where stronger same-condition runs found a verified blocker, then
   * printed a bare confident Approve. The verdict line names the shape.
   * `agents` is the plan's required roster — all on record at APPROVE, or
   * coverage would have capped — and `srcDiffLines` the plan's own count.
   */
  lowSignal: { agents: number; srcDiffLines: number } | null;
  /**
   * True when the machine-derived coverage evidence leaves doubt that the
   * whole diff was READ — a chunk with no receipt, an uncoverable chunk, an
   * idle/blind/never-opened agent, unreadable transcripts, a context fetch
   * that failed. Deliberately narrower than `cappedBy`: it says nothing about
   * how DEEPLY the diff was reviewed, only about whether it was reached.
   *
   * The incremental anchor is the one consumer (`ledgerMarkerFor`). Emitted in
   * the composed artifact too, because "why did this round not certify a
   * range?" was otherwise unanswerable from the artifact alone.
   *
   * Optional for readers, always written by this module: a composed artifact
   * from a build that predates the field has no answer, and a reader that
   * needs one must fail closed (treat absent as unproven) rather than read
   * `undefined` as "proven".
   */
  scopeUnproven?: boolean;
  /**
   * True when every `unreviewedDimensions` entry is a DEPTH claim: it names
   * the one dimension that reads no diff (build-and-test), or it is the
   * machine's own relayed budget/round-cap stop entry — exact minted text,
   * and only while the stop marker exists (`isRelayedStopEntry`). Vacuously
   * true when there are no entries.
   *
   * The anchor reads this beside `scopeUnproven`: a dimension nobody could
   * run and a truncated audit over receipt-proven lines say nothing about
   * WHICH lines were read, but a whiffed lens says exactly that, and only
   * the orchestrator's prose ever reports it.
   */
  dimensionGapsAreDepthOnly?: boolean;
  /**
   * Set when a PR has taken enough rounds AND grown enough since the review
   * first measured it that the shape of the change, not the current patch, is
   * the open question. Disclosure only — the event never moves on it, exactly
   * as `lowSignal` above.
   *
   * It exists because every finding this review emits is anchored to a
   * `file:line` inside the current diff, so the review can say where an
   * approach leaks but never that a different approach would retire all of the
   * leaks at once. Measured: one change took three attempts across two PRs and
   * 74 individually-correct findings, growing 4x, before the mechanism itself
   * was replaced and every finding went away with it.
   *
   * Never fires on APPROVE: an approve IS convergence, and telling a
   * converging PR to reconsider itself is the loudest possible false positive.
   * `nonConverged` reports only THIS round's reverse-audit round-cap stop, as
   * corroborating text — there is no cross-round tally of it, and the sentence
   * does not claim one.
   */
  approachSignal: {
    round: number;
    src0: number;
    srcDiffLines: number;
    growth: number;
    nonConverged: boolean;
  } | null;
}

/**
 * A dimension head reduced to its comparable core: lowercased, `&` read as
 * `and`, hyphen/space runs collapsed to one hyphen, and the label dressing
 * (`the …`, `… check`, `… verification`) stripped — so the orchestrator's
 * prose variants (`build-and-test`, `build & test`, `the build-and-test
 * check`) all reduce to the same core as the brief's `publicLabel`.
 */
function canonicalDimensionHead(s: string): string {
  return (
    s
      .toLowerCase()
      // Spaced, not bare: a tight ampersand (`build&test`) must gain its
      // separators BEFORE the hyphen collapse, or it canonicalises to
      // `buildandtest` while the derived set holds `build-and-test` — the
      // replaced regex accepted the tight form via `[-\s]?`.
      .replace(/&/g, ' and ')
      .replace(/[-\s]+/g, '-')
      .replace(/^the-/, '')
      .replace(/-(?:check|verification)$/, '')
  );
}

/** The fully separator-less spelling — the loosest form the old regex took. */
function squashedDimensionHead(s: string): string {
  return canonicalDimensionHead(s).replace(/-/g, '');
}

/**
 * The exempt heads, DERIVED from the briefs rather than restated: every role
 * whose brief sets `readsDiff: false`, by its `publicLabel`. A hardcoded
 * head list drifted from the machine source of truth it documented — a
 * label rename (or a second non-diff role) would silently stop or fail to
 * extend the exemption, and every budget-stopped round on a large repo
 * would withhold the incremental anchor again: the full-diff re-review loop
 * this exemption exists to kill, back by way of a string.
 */
const NON_DIFF_DIMENSION_HEADS: ReadonlySet<string> = new Set(
  Object.values(BRIEFS)
    .filter((b) => !b.readsDiff)
    .map((b) => canonicalDimensionHead(b.publicLabel)),
);
/** Squashed twins of the set above, for the separator-less prose spellings
 *  (`buildandtest`, `build andtest`) the replaced regex accepted via its
 *  optional separators — refusing them re-opened the anchor-withholding
 *  cost on a rare variant, in the safe but expensive direction. */
const NON_DIFF_DIMENSION_HEADS_SQUASHED: ReadonlySet<string> = new Set(
  [...NON_DIFF_DIMENSION_HEADS].map((h) => h.replace(/-/g, '')),
);

/**
 * Does this `unreviewedDimensions` entry name a dimension that reads no diff?
 *
 * Entries are prose the orchestrator writes, in the shape the skill documents:
 * a dimension name, optionally followed by its own reason after an em-dash
 * (`build-and-test — the integration suite never ran`). Only the head is
 * matched, and only against dimensions whose brief sets `readsDiff: false`
 * (English labels only — the entries are the orchestrator's English prose;
 * `publicLabelZh` is a rendering concern).
 */
export function isNonDiffDimensionGap(entry: string): boolean {
  const head = entry.split(/[—–-]{1,2}\s/)[0].trim();
  return (
    NON_DIFF_DIMENSION_HEADS.has(canonicalDimensionHead(head)) ||
    NON_DIFF_DIMENSION_HEADS_SQUASHED.has(squashedDimensionHead(head))
  );
}

/**
 * The Step 5 tag, exactly as the loop's merge writes and removes it: an
 * entry not yet through verification carries it, a confirmed verdict removes
 * it, and a tag that survives to compose time is an entry no verifier ever
 * ruled on. Whitespace-tolerant only — the tag is prose the orchestrator
 * copies, and a re-wrap must not hide it.
 */
const UNVERIFIED_FINDING_TAG_RE = /—\s*\[unverified\]/gi;

function withMarker(line: string): string {
  return line.startsWith(CRITICAL_PREFIX) ? line : `${CRITICAL_PREFIX} ${line}`;
}

/** The plan's PR identity, when it names one — the base for comment anchors. */
interface PrIdentity {
  ownerRepo: string;
  prNumber: string;
  /** The host fetch-pr recorded for a non-default instance, else null. */
  host: string | null;
}

/**
 * The one rule for "this parsed plan names a PR" — the bilingual recovery
 * and the comment anchors both read it, so a hardening of plan-identity
 * validation lands once, not twice in this file.
 */
function planPrIdentity(plan: unknown): PrIdentity | null {
  if (typeof plan !== 'object' || plan === null) return null;
  const p = plan as {
    ownerRepo?: unknown;
    prNumber?: unknown;
    host?: unknown;
  };
  const ownerRepo =
    typeof p.ownerRepo === 'string' && isOwnerRepo(p.ownerRepo)
      ? p.ownerRepo
      : null;
  const prNumber = isPositivePrNumber(p.prNumber) ? String(p.prNumber) : null;
  // The plan is a file on disk; hold a recorded host to the same standard
  // the rest of this surface applies (HOSTNAME_RE in setGhHost) before it
  // rides into a posted anchor URL.
  const host =
    typeof p.host === 'string' && HOSTNAME_RE.test(p.host) ? p.host : null;
  return ownerRepo && prNumber ? { ownerRepo, prNumber, host } : null;
}

function prIdentityFromPlan(planPath: string | undefined): PrIdentity | null {
  if (!planPath) return null;
  try {
    return planPrIdentity(JSON.parse(readFileSync(planPath, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * `comment 3733696855` in a model-written unresolved entry is a bare number
 * the PR page cannot navigate; with the plan's PR identity it becomes the
 * anchor GitHub already serves — review-thread comments under
 * `#discussion_r`, issue-level ones under `#issuecomment`. An entry that
 * already carries a markdown link is left alone: the model linked it itself,
 * and rewriting inside its link text would corrupt it.
 */
function linkifyCommentRefs(text: string, pr: PrIdentity | null): string {
  if (!pr || text.includes('](')) return text;
  // The anchor must point at the instance the PR lives on: the host the
  // plan recorded, else this run's routed host, else an operator-exported
  // GH_HOST — the same effective-host resolution `submit` posts through.
  // Defaulting to github.com 404s a GHE review's anchors, or lands them on
  // a same-named public repo's different PR. The spelling normalisation
  // rides the shared PR-page helper (its doc names the variants) — the
  // same spelling the reader's composeUrl prints, so one run cannot emit
  // two textual spellings of this PR page, and the github.com comparison
  // below sees the folded form.
  const host = normalizeGhHostForUrl(
    resolveGhHost(pr.host ?? getGhHost()) ?? 'github.com',
  );
  const base = `https://${host}/${pr.ownerRepo}/pull/${pr.prNumber}`;
  // github.com's comment ids run long, so a short number after "comment"
  // reads likelier as an ordinal; a GHE instance's id space is its own and
  // often short, and the floor would leave the feature inert there.
  // Case-insensitive: the pipeline's own label is capitalized
  // (`**Issue-level comment**` in pr-context), and an entry echoing that
  // casing must still anchor under #issuecomment, not #discussion_r.
  const commentRef =
    host === 'github.com'
      ? /\b(issue-level )?comment (\d{6,})\b/gi
      : /\b(issue-level )?comment (\d+)\b/gi;
  // The anchor family is decided per ENTRY, not per match: issue-comment
  // ids and review-comment ids are separate id spaces, and an issue-level
  // entry that echoes pr-context's own header shape (`**Issue-level
  // comment** — … (comment 5199834809)`) carries its id apart from the
  // phrase — routed by adjacency alone, that id anchors under
  // #discussion_r, a link that can never resolve.
  const issueLevelEntry = /\bissue(?:-level)?\s+comment\b/i.test(text);
  return text.replace(
    commentRef,
    (_m, issueLevel: string | undefined, id: string) =>
      issueLevel || issueLevelEntry
        ? `[${issueLevel ?? ''}comment ${id}](${base}#issuecomment-${id})`
        : `[comment ${id}](${base}#discussion_r${id})`,
  );
}

/**
 * A model-written entry flattened to one renderable list line, its `comment
 * <id>` refs linked to the PR's anchors. Entries render as one-line list
 * items: an unindented newline ends a list item (CommonMark), so an entry
 * spanning lines would leak its continuation out of the list. Comment
 * grammar goes inert too — a quoted `<!-- qwen-review-… -->` literal would
 * otherwise forge a second marker occurrence in the raw body the pipeline's
 * own readers scan (md-field.ts documents the shipped ledger-marker case).
 */
function asListLine(text: string, pr: PrIdentity | null): string {
  return linkifyCommentRefs(collapseToLine(stripCommentGrammar(text)), pr);
}

/**
 * The unresolved-existing-Critical block, as a Markdown list instead of a
 * space-joined paragraph: #8388's posted body ran 31 of these together in
 * one unreadable wall. Entries sharing the exact reason after their first
 * ` — ` collapse into one marked group that states the reason once and
 * lists the subjects — the same repetition-killing move the not-reviewed
 * sentences already make. Nothing is dropped: every subject and every
 * distinct reason still renders, because erasing one is how a review
 * approves the very thing it is asking about. The Chinese half carries a
 * count and a pointer instead of duplicating the untranslatable English
 * list — on #8388 that duplication alone doubled the body.
 */
function formatCannotTell(
  cannotTell: string[],
  pr: PrIdentity | null,
  attribution: boolean,
): Bi {
  const parsed = cannotTell.map((raw) => {
    // Entries arrive collapsed (one list item each); an unattributed entry
    // goes through the full fixpoint sanitation — the entry is quoted into
    // a body that carries no canonical footer, so a surviving footer or
    // marker in any position would be the post's only attribution. The
    // marker check goes through `severityOf` (trims first — a leading space
    // used to leak the marker past this strip into the posted body), and
    // the strip is iterative — a looping model drafts stacked markers and a
    // single slice posts the second one.
    const source = attribution ? raw : stripForUnattributedPost(raw);
    const unmarked =
      severityOf({ body: source }) === null
        ? source
        : stripSeverityPrefix(source).trim();
    const line = asListLine(boundDeferredLine(unmarked), pr);
    // A dangling ` — ` with nothing after it is reasonless — an empty-string
    // reason would become a group key and render `2 entries — :`. The bound
    // strands the separator the same way when a cut lands right after it.
    const subject = line.replace(/ —\s*…$/, '…').replace(/ —$/, '');
    const idx = subject.indexOf(' — ');
    // `|| null`: reasonless entries never spawn the empty group key.
    return idx === -1
      ? { head: subject, reason: null }
      : {
          head: subject.slice(0, idx),
          reason: subject.slice(idx + 3).trim() || null,
        };
  });
  // Grouped on the exact reason text, in first-appearance order. A reasonless
  // entry stays its own item — there is nothing to share.
  interface Group {
    reason: string | null;
    heads: string[];
  }
  const groups: Group[] = [];
  const byReason = new Map<string, Group>();
  for (const p of parsed) {
    const existing = p.reason === null ? undefined : byReason.get(p.reason);
    if (existing) {
      existing.heads.push(p.head);
      continue;
    }
    const group: Group = { reason: p.reason, heads: [p.head] };
    groups.push(group);
    if (p.reason !== null) byReason.set(p.reason, group);
  }
  const lines: string[] = [];
  // The marker is the attributed template's severity signal; an unattributed
  // post lists the unresolved entries without it.
  const marker = attribution ? `${CRITICAL_PREFIX} ` : '';
  for (const { reason, heads } of groups) {
    if (heads.length === 1) {
      lines.push(
        `- ${marker}${heads[0]}${reason === null ? '' : ` — ${reason}`}`,
      );
    } else {
      lines.push(
        `- ${marker}${heads.length} entries — ${reason}:`,
        ...heads.map((head) => `  - ${head}`),
      );
    }
  }
  return {
    en: `Unresolved, please confirm:\n\n${lines.join('\n')}`,
    zh: `未决，请确认：共 ${cannotTell.length} 条（原文未翻译，列表见上方英文部分）。`,
  };
}

// The input arrives as JSON a model wrote, and the skill tells it to omit
// fields that do not apply — so absence is normal and means zero/empty. What
// must never pass is a PRESENT field of the wrong shape: `undefined + 1` is
// NaN, and NaN fails both `c >= 1` and `s >= 1`, which once turned a
// body-Critical-only input into an APPROVE that dropped the only blocker.
function toCount(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0;
  // The Step 7 prose prescribes a COUNT for these fields —
  // `suggestionsDiscarded` above all — but runs following older skill
  // revisions wrote the LIST of discarded items and used to die at this gate
  // after hours of analysis. Its length IS the count, so count it rather than
  // refuse: `[]` is zero, `["a", "b"]` is two.
  if (Array.isArray(value)) return value.length;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `compose-review: ${field} must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * `toCount`'s acceptance as a total function: the count when `toCount`
 * accepts the value, undefined when it would throw. A caller OUTSIDE this
 * boundary that merges into a count without owning the refusal — submit's
 * Aone anchor gate — decides "merge or leave for compose" through the SAME
 * acceptance table, so the two reads can never drift.
 */
export function tryToCount(value: unknown): number | undefined {
  try {
    return toCount(value, '');
  } catch {
    return undefined;
  }
}

function toStringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new TypeError(
      `compose-review: ${field} must be an array of strings, got ${JSON.stringify(value)}`,
    );
  }
  // A copy. The caller's array is not ours to push into, and coverage-derived
  // entries are appended to these lists — a programmatic caller that reused one
  // across two calls would find the first call's caps in the second.
  return [...(value as string[])];
}

/**
 * One model-written list field, normalized for render. Entries render in the
 * posted body above the canonical footer, so each is stripped of a relocated
 * footer — per entry, not on the assembled body: the `$`-anchored strip regex
 * only sees an entry's end, before the footer is appended, and a forged footer
 * inside one would otherwise post directly above the canonical footer. Entries
 * that normalize to nothing drop, so the field's count never overclaims its
 * rendered list. The attribution-off leg routes through the full fixpoint
 * chain like every other attribution-off body part: duplicates entries are
 * transcribed from earlier rounds' posted findings, and every attribution-on
 * round posts visible prefixes — a surviving marker or forged attribution
 * line here would be the only attribution the post carries.
 */
function strippedList(
  input: ComposeReviewInput,
  key: 'suggestionsDroppedAsDuplicates',
  attribution: boolean,
): string[] {
  return toStringList(input[key], key)
    .map((entry) =>
      stripReviewFooter(attribution ? entry : stripForUnattributedPost(entry)),
    )
    .filter((entry) => entry.trim() !== '');
}

// Booleans get the same boundary treatment as the counts: the JSON is
// model-written, and a stringified `"false"` is truthy — it once stood to
// fire the downgrade sentence on a review that was never downgraded, and to
// publish the diff-only warning on a run that fetched its context fine.
function toBool(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    throw new TypeError(
      `compose-review: ${field} must be a boolean, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function composeReview(
  input: ComposeReviewInput,
  cliVersion = 'unknown',
  attribution = true,
  /**
   * The model identity the RUNTIME publishes as active — `QWEN_CODE_MODEL`,
   * injected by the two CLI boundaries from the environment the session
   * exports. The marker's anchor certifies with THIS, never with the
   * model-written state field alone; `input.modelId` is the fallback for
   * runs no session published. Undefined in tests that call this directly.
   */
  runtimeModelId?: string,
): ComposeReviewResult {
  // One read, one round: the deferred-suggestions clause and the ledger
  // marker both name this round, and each reading the side file for itself
  // would let a mid-compose update publish two different round numbers in
  // one review. The approach baseline and the previous volume ride out of
  // the same read for the same reason — a marker pairing one round's number
  // with another's baseline or count is a record nobody can read back.
  const prevFacts = prevLedgerFacts(input.planPath, runtimeModelId);
  const prevRound = prevFacts.round;
  // The convergence verdict, decided HERE — beside the one side-file read
  // that owns `prevRound` — and never inside the body composer, so this
  // round's number, its streak and its census cannot come from two reads
  // that disagree.
  //
  // Three states, and the middle one is the one worth spelling out:
  //   above the bar  → the streak advances and may reach the filing bar;
  //   below the bar  → the streak RESETS: a round that converged says so;
  //   not measured   → the streak is CARRIED, neither advanced nor reset.
  // Absence is a fact about this run — a non-PR target, a skill revision
  // predating the field, an age reference the round could not validate — and
  // reading it as "converging" would let one unmeasurable round wipe a
  // standing claim about the pull request.
  // The census is the model-written half of this trigger, so it gets the
  // module's one-sided cross-check before it can arm anything: a FRESH
  // finding only exists as something this round REPORTS — an inline draft, a
  // body Critical, a deferral — so a denominator past everything reported,
  // all three channels counted together, is a census this round cannot have
  // measured. Refused as no census at all — the streak carries, exactly as
  // absence does — or a round that reported nothing could file the
  // non-convergence blocker on the model's say-so alone.
  const reportedThisRound =
    (Array.isArray(input.draftedComments) ? input.draftedComments.length : 0) +
    (Array.isArray(input.bodyCriticals) ? input.bodyCriticals.length : 0) +
    (Array.isArray(input.deferredSuggestions)
      ? input.deferredSuggestions.length
      : 0);
  // Round 1 has no predecessor whose fixes could have induced anything, so a
  // census there is the same impossible shape `churnCensusOf` refuses for
  // `induced > fresh` — refused symmetric with the round-0 streak guard in
  // `prevLedgerFacts`. A legitimate round-1 census can only carry
  // `induced = 0`, which never trips the bar, so this changes no verdict.
  // Context-unavailable is the OTHER unmeasurable state: the fix-induced
  // test's age operand cannot be computed without a context, so a census
  // presented under it cannot have come from the mechanical test that
  // defines "measured". SKILL tells the round to omit the field there; this
  // refusal is the module's half, symmetric with round 1 — absence then
  // carries the streak, exactly as an unmeasured round must.
  const readCensus =
    prevRound === 0 || input.contextUnavailable === true
      ? null
      : churnCensusOf(input.convergence);
  const churnCensus =
    readCensus !== null && readCensus.fresh > reportedThisRound
      ? null
      : readCensus;
  const churnAbove = aboveChurnBar(churnCensus);
  // Below-minimum carries like absent: a census under CHURN_MIN_FRESH is a
  // round that could not measure — a ratio over two or three findings is
  // rounding, not a trend — and a round that could not measure carries the
  // count without adding to it, exactly as the field's contract says.
  // Resetting it instead zeroed a standing claim on the looping shape this
  // exists for: above-bar rounds alternating with small ones never reached
  // the filing bar.
  const churnRounds = churnAbove
    ? Math.min(prevFacts.churnRounds + 1, LEDGER_MAX_ROUND)
    : churnCensus === null || churnCensus.fresh < CHURN_MIN_FRESH
      ? prevFacts.churnRounds
      : 0;
  // Filing needs THIS ROUND above the bar — not merely a streak, and not a
  // streak beside any census. The streak arrives from a posted review body,
  // which is another account's writable surface, and a forged `churnRounds`
  // gated on nothing else would block an arbitrary pull request; requiring
  // this round's own census above the bar bounds the worst a forgery can do.
  // The explicit `churnAbove` is load-bearing now that a below-minimum
  // census CARRIES the streak: a carried streak at the bar beside a
  // three-finding census satisfies `churnCensus && churnRounds >=
  // CHURN_STREAK_TO_FILE` without this round measuring anything, and the
  // guard is what keeps the blocker off it. Reaching the bar still takes at
  // least two above-bar rounds — carrying never adds — so a filed blocker
  // always has its two counted rounds behind it.
  const nonConvergence =
    churnAbove && churnCensus && churnRounds >= CHURN_STREAK_TO_FILE
      ? nonConvergenceCritical(
          churnCensus,
          churnRounds,
          Math.min(prevRound + 1, LEDGER_MAX_ROUND),
        )
      : null;
  // The previous round as the convergence signal reads it. Hoisted out of
  // the `composeReviewBody` call because TWO consumers read it now — the
  // floor's early trigger below and the rendered diagnosis — and two
  // hand-built copies of one recovery is the drift class this file's header
  // exists to prevent.
  const prevForConvergence = {
    ...(prevFacts.posted === undefined ? {} : { posted: prevFacts.posted }),
    findings: prevFacts.findings,
    truncated: prevFacts.truncated,
    complete: prevRound > 0 && !prevFacts.truncated,
    round: prevRound,
    anchored: prevFacts.anchored,
    foreign: prevFacts.foreign,
    merged: prevFacts.merged,
    ...(prevFacts.floor === undefined ? {} : { floor: prevFacts.floor }),
    ...(prevFacts.fresh === undefined ? {} : { fresh: prevFacts.fresh }),
  };
  // The flat-trend streak (#9903): does this round's first-time-finding
  // rate fall? Measured through the ONE `diagnoseConvergence` statement —
  // the same function the body renders from, never a restated predicate —
  // over the PRE-reroute drafts. Every round that can ADVANCE the streak
  // ran its predecessor under an open floor (a `c` predecessor trips the
  // trend's own `floorChanged` guard), so on the advancing rounds no
  // reroute was in flight there either — the measurement and the rendered
  // diagnosis share one basis. The one round where the two differ is the
  // ENGAGING round itself: this measurement still sees the full draft set,
  // while enforcement strips it before the body renders — and the
  // `floorChanged` guard then keeps the rendered trend silent, so the
  // difference never publishes a number it could contradict.
  //
  // Three states, deliberately simpler than the churn streak's: a firing
  // round ADVANCES, any other round RESETS — there is no
  // carry-on-unmeasured, because the cheap error here is a wiped streak
  // (one delayed engagement), never a false one (Suggestions silently
  // deferred on insufficient evidence). The trend is computed with this
  // round's floor as OPEN: the trigger is what may close it, so its own
  // `floorChanged` guard must compare against the pre-trigger posture —
  // and a predecessor that posted CLOSED genuinely is not a comparable
  // point, which the guard then says on its own.
  //
  // Past the bar the streak is PINNED, not re-measured: the floor it
  // engaged moves fresh Suggestions into the deferral channel, so the
  // posted-set trend goes quiet precisely because the floor is working —
  // re-measuring would release it the round after it engaged, and the
  // guard's posture comparison would flap it at period two. The pin is the
  // latch: engagement holds on the recorded streak until the round-6 rule
  // takes over anyway. A context-unavailable round measures nothing here
  // (its recovered ledger could not be re-vouched), so it neither advances
  // nor — while pinned — releases: the latch survives the blip, and the
  // floor's own context-unavailable arm stays disengaged for that round.
  const prevFlat = prevFacts.flatRounds;
  const flatLatched = prevFlat >= FLAT_STREAK_TO_ENGAGE;
  // The measurement is gated where the arm is gated: the trigger lives ONLY
  // in the `auto` arm, and a round the operator ran under an explicit floor
  // is not a measurement the auto posture licensed. `suggestion` turns the
  // posture off, and `critical` suppresses the posted set the trend reads —
  // yet the measurement below cannot see either, because it computes the
  // trend as this round's floor were open and the marker vocabulary has no
  // letter for `suggestion` (both stamp `o`, and the trend's `floorChanged`
  // guard compares only what the markers recorded). Left ungated, such a
  // round advances the streak and the latch then engages off rounds the
  // operator had explicitly taken out of the posture — the false-engagement
  // direction the error asymmetry above excludes. Absence folds to `auto`
  // exactly as `criticalFloorKind` does; an unrecognisable floor is a
  // posture this module cannot read and advances nothing — fail open.
  const foldedFloor = normalizeSeverityFloor(input.severityFloor);
  const floorIsAuto =
    foldedFloor === 'auto' ||
    (foldedFloor === undefined &&
      (input.severityFloor === undefined || input.severityFloor === null));
  const flatFires =
    !flatLatched &&
    input.contextUnavailable !== true &&
    floorIsAuto &&
    diagnoseConvergence({
      round: Math.min(prevRound + 1, LEDGER_MAX_ROUND),
      // Only the trend matters below; the diagnosis's display volume is
      // filled from the posting set inside `composeReviewBody`.
      posted: Array.isArray(input.draftedComments)
        ? input.draftedComments.length
        : 0,
      prev: prevForConvergence,
      drafts: draftedFindingsOf(input.draftedComments),
      floor: 'o',
    })?.volumeNotShrinking === true;
  const flatRounds = flatLatched
    ? prevFlat
    : flatFires
      ? Math.min(prevFlat + 1, LEDGER_MAX_ROUND)
      : 0;
  const signalEngaged = flatRounds >= FLAT_STREAK_TO_ENGAGE;
  // The floor, enforced before anything is composed or counted: everything
  // downstream — the counts, the body, the ledger marker — must describe
  // the set that actually posts. `contextUnavailable` is read leniently
  // here (`=== true`); the authoritative shape check stays in
  // `composeReviewBody`, which runs on the same input immediately after
  // and throws the same TypeError either way.
  const reroute = floorEnforcedReroute(
    input.severityFloor,
    input.contextUnavailable === true,
    prevRound,
    Array.isArray(input.draftedComments) ? input.draftedComments : [],
    signalEngaged,
  );
  // The one resolution, read by the enforcement above and reported by the
  // diagnosis below — and stamped into this round's marker, so the NEXT round
  // can tell a posture change from a loop that will not settle.
  const floorKind = criticalFloorKind(
    input.severityFloor,
    input.contextUnavailable === true,
    prevRound,
    signalEngaged,
  );
  let effective = input;
  if (reroute.indices.length > 0) {
    const drop = new Set(reroute.indices);
    effective = {
      ...input,
      draftedComments: (input.draftedComments ?? []).filter(
        (_, i) => !drop.has(i),
      ),
      // The seam counts were derived from the pre-enforcement drafts by the
      // boundary; keep them in agreement with the set that remains. Both
      // shapes `toCount` accepts adjust — the number, and the legacy list
      // form counted by its length — or an array-shaped seam would skip the
      // adjustment and the count would disagree with the reduced posting
      // set. Clamped: a caller whose count already disagreed with its
      // drafts must degrade to a wrong-but-composable zero, never to a
      // toCount refusal that loses the round.
      ...(() => {
        const seam = input.suggestionsInline as unknown;
        const counted =
          typeof seam === 'number'
            ? seam
            : Array.isArray(seam)
              ? seam.length
              : undefined;
        return counted === undefined
          ? {}
          : {
              suggestionsInline: Math.max(0, counted - reroute.indices.length),
            };
      })(),
    };
  }
  // Is the loop settling? Measured from facts this round already holds — the
  // previous work list and volume from the side file, this round's drafts —
  // and rendered as an observation. It changes nothing about what the round
  // posts: no finding is withheld, no verdict capped. A round that looks
  // healthy produces no diagnosis at all rather than an empty section.
  //
  // The INPUTS travel; the diagnosis is composed inside `composeReviewBody`,
  // beside the `postedInline` the marker and the terminal VOLUME line are
  // taken from. Composed here it would be a second derivation of the same
  // number — equal today, and free to drift the moment either derivation is
  // edited, leaving one posted body stating two volumes for one round.
  const result = composeReviewBody(
    effective,
    cliVersion,
    attribution,
    prevRound,
    prevFacts.src0,
    reroute,
    {
      prev: prevForConvergence,
      // Read from the same input `floorEnforcedReroute` just acted on, through
      // the one predicate both share — so the advice cannot recommend a floor
      // the enforcement above already applied, nor name it a way the
      // enforcement note in the same body contradicts.
      floor: floorKind === undefined ? ('o' as const) : ('c' as const),
      ...(floorKind === undefined ? {} : { criticalFloorKind: floorKind }),
      floorEnforcementEngaged: criticalFloorInEffect(
        input.severityFloor,
        input.contextUnavailable === true,
        prevRound,
        signalEngaged,
      ),
      // The streak the trigger just resolved, so the deferral header can
      // say WHY the floor engaged ahead of the round-6 schedule.
      flatRounds,
    },
    nonConvergence,
  );
  // The ledger marker rides the body THIS function returns, because this — not
  // the CLI handler — is what `submit` calls and posts. Appending it in the
  // handler left the feature inert end to end: the marker reached only the
  // composed JSON on disk, which nothing in the posting path reads, so no
  // posted review ever carried one and every round recovered `null`.
  // It reads the EFFECTIVE input: a floor-enforced Suggestion left the
  // posting set, and the work list holds only findings the review posts —
  // the same semantics as a model-side deferral.
  // Absent means "not recorded", never "proven" — fail closed, as the field's
  // own contract says. This module always sets it, so the fallback is for a
  // result assembled elsewhere.
  // The volume this round puts on the PR: the posting set AFTER floor
  // enforcement removed what it moved, because that is what `submit` sends
  // and therefore what the next round will see on the pull request. Taken
  // from the body composer's own result rather than re-derived here — one
  // count, one origin, so the marker and the reported number cannot drift
  // apart under a later edit to either.
  const postedInline = result.postedInline;
  const marker = ledgerMarkerFor(
    effective,
    result.cappedBy,
    result.scopeUnproven ?? true,
    result.dimensionGapsAreDepthOnly ?? false,
    attribution,
    runtimeModelId,
    prevRound,
    prevFacts.src0,
    postedInline,
    result.postedFresh,
    prevFacts.posted,
    floorKind,
    {
      ids: new Set(prevFacts.findings.map((f) => f.id)),
      // A round that recovered NO predecessor knows nothing about which ids
      // were real — the id space is shared across environments and a first
      // round on a machine with no side file is the ordinary case — so it
      // cannot call a claimed id a stray. Only a recovered, untruncated list
      // is evidence of absence.
      complete: prevRound > 0 && !prevFacts.truncated,
    },
    churnRounds,
    flatRounds,
  );
  // `postedInline` came out of the body composer on the same input, so only
  // the predecessor's volume — which only this scope read — is added here.
  const withVolume: ComposeReviewResult = {
    ...result,
    ...(prevFacts.posted === undefined
      ? {}
      : { prevPostedInline: prevFacts.posted }),
  };
  return marker
    ? { ...withVolume, body: `${withVolume.body}\n\n${marker}` }
    : withVolume;
}

/**
 * The smallest round the churn ratio is allowed to speak for.
 *
 * A ratio over two or three findings is not a trend, it is rounding: one
 * fix-induced finding out of two clears any percentage bar worth setting, and
 * a review that blocked a pull request on that would be filing its
 * non-convergence claim off noise. Four is the point where the bar below
 * requires at least two independent fix-induced findings to trip, which is
 * the weakest statement that is still a statement.
 */
export const CHURN_MIN_FRESH = 4;

/**
 * How many rounds counted against the churn bar are needed before the finding
 * is filed.
 *
 * One round above the bar is an ordinary re-review: the fix round touched the
 * code, so of course this round's findings are on it, and the measured
 * baseline for that is roughly a third. Two counted rounds is the shortest
 * window in which "each round is reviewing the last round's answer to it" is
 * an observation rather than a single step — the same argument `prevPosted`
 * makes for the volume trend.
 */
export const CHURN_STREAK_TO_FILE = 2;

/**
 * How many consecutive rounds of a not-falling first-time-finding rate
 * engage the severity floor ahead of the round-6 schedule (#9903).
 *
 * Two, for the argument `CHURN_STREAK_TO_FILE` above states: one flat round
 * is a step, two is the shortest window in which "the rate is not falling"
 * is an observation. The bar is read off the ledger's `flatRounds` streak,
 * which a round advances when its OWN measured trend fires and resets when
 * it falls — so reaching it always takes two measured firing rounds; a
 * carried or pinned streak never adds.
 */
export const FLAT_STREAK_TO_ENGAGE = 2;

/**
 * This round's census, or null when it cannot be read as one.
 *
 * Refuses a numerator larger than its denominator outright: `induced` counts
 * a SUBSET of `fresh`, so `induced > fresh` is not a large ratio, it is a
 * census that cannot be true — and the failing direction for a state field
 * this module did not compute is to decide nothing with it.
 */
export function churnCensusOf(
  raw: { fresh?: unknown; induced?: unknown } | undefined,
): { fresh: number; induced: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const fresh = volumeOf(raw.fresh);
  const induced = volumeOf(raw.induced);
  if (fresh === undefined || induced === undefined) return null;
  if (induced > fresh) return null;
  return { fresh, induced };
}

/**
 * Is this round above the churn bar? Half or more of its first-appearing
 * findings attributed by the fix-induced rule to the previous round's fixes
 * — the ATTRIBUTED count, not findings on newly pushed lines.
 *
 * Half, not the measured third: the third IS the baseline — the rate an
 * ordinary, healthy re-review runs at — and a bar set at the baseline fires
 * on every pull request that ever gets a second round. The claim this arms
 * is that at least half the round's first-appearing findings were work the
 * previous round created — below that, the round is still mostly reviewing
 * the change itself.
 *
 * Integer arithmetic on purpose (`induced * 2 >= fresh`): a float ratio
 * compared against 0.5 puts the bar's behaviour at 5/10 at the mercy of
 * binary rounding, and this one decides whether a pull request is blocked.
 */
export function aboveChurnBar(
  census: { fresh: number; induced: number } | null,
): boolean {
  if (!census) return false;
  if (census.fresh < CHURN_MIN_FRESH) return false;
  return census.induced * 2 >= census.fresh;
}

/**
 * The body Critical a non-converging round files.
 *
 * Deliberately not anchored: the claim is about the pull request, not about a
 * line, and hanging it on whichever file happened to churn most would invite
 * a fix at that line for a defect that is not there.
 *
 * **It counts DEFECTS, and it must not borrow the posting trend's words.**
 * The same body carries the convergence diagnosis, which counts inline
 * comments POSTED for the first time — and the two numbers legitimately
 * differ: this count takes every finding the round newly identified, the
 * trend only those that reached the pull request as a first-time comment, so
 * a round can newly identify six defects while posting fewer than six
 * first-time comments (some ride body Criticals, some deferrals). Both
 * readings are right; what broke was the vocabulary, when this sentence said
 * "findings first filed" beside the diagnosis's "reported for the first
 * time" and one body published two numbers under one phrase. Hence "defects
 * … newly identified" — distinct words for a distinct quantity.
 *
 * Do NOT "reconcile" the two by changing either count WHOLESALE. Excluding
 * carried-id re-reports from `fresh` would put `induced` outside it and
 * every such census would be refused as impossible; and reading a carried id
 * as first-time work by inference would tell the volume trend that every
 * re-assertion of a standing finding is new work, which is the reading
 * `isFreshDraft` exists to refuse.
 *
 * What DID change (#9674) is narrower than either, and is not an inference:
 * a fix-induced re-report is MARKED as such in the comment body, and the
 * trend counts a marked one as first-time. That is a distinction the round
 * asserts, not one the id implies — an unmarked carried id is still a
 * re-post to the trend, exactly as before. The divergence between the two
 * counts is still the design; only the false premise that a carried id can
 * mean just one thing is gone.
 */
export function nonConvergenceCritical(
  census: { fresh: number; induced: number },
  streak: number,
  thisRound: number,
): string {
  return (
    `This pull request is not converging. Of the ${census.fresh} defects ` +
    `round ${thisRound} newly identified, ${census.induced} were introduced ` +
    `by the previous round's fixes for this review's own findings — the ` +
    `${streak}${ordinalSuffix(streak)} round counted against the churn bar ` +
    `(rounds that could not measure carry the count rather than reset it), ` +
    `and in every counted round at least half of its newly identified ` +
    `defects were introduced by the previous round's fixes. Filing more ` +
    `findings will not close this: split the change into separately ` +
    `reviewable pieces, or ` +
    `reconsider the approach under review, and re-request review after. ` +
    `(Counted by the review from its own ledger and diff; it blocks so the ` +
    `decision is a person's.)`
  );
}

function ordinalSuffix(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return 'th';
  switch (n % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

/**
 * Nothing recovered: round 1, no volume to compare against, no work list to
 * find recurrence in, and therefore no evidence to qualify. Named once so the
 * three ways this read gives up cannot drift apart as fields are added.
 */
const EMPTY_PREV_FACTS = {
  round: 0,
  src0: 0,
  churnRounds: 0,
  flatRounds: 0,
  findings: [] as LedgerFinding[],
  truncated: false,
  foreign: false,
  merged: false,
  anchored: false,
};

/**
 * The previous posted round's number, its approach baseline AND its posting
 * volume, recovered from the side file `pr-context` wrote — never from the
 * model.
 *
 * The round is 0 when the plan names no PR or no previous round was
 * recovered: this is round 1. It is shared by the marker (which stamps
 * `Math.min(prevRound + 1, LEDGER_MAX_ROUND)`), the deferred-suggestions
 * clause (which names the round the posture engaged on, clamped
 * identically), and the approach signal, so none of the three can disagree
 * about which round this is — at the cap included, where an unclamped
 * `prevRound + 1` on either side would name round 10001 beside a
 * round-10000 marker.
 *
 * Three facts, one read, on purpose: reading the file twice would let a
 * mid-compose rewrite pair round N's number with round N+1's baseline or
 * volume in a single marker. They degrade independently — the side file is
 * a best-effort recovery, and a round with no volume recorded (every round
 * before the field shipped) is not a round that posted nothing.
 *
 * `src0` is 0 on every failure path — see `Ledger.src0`. A force-push or an
 * account switch that loses the side file therefore reads as round 1 and
 * disarms the approach signal rather than misreporting it. That direction is
 * deliberate: the signal is advisory, so its failure mode should be silence.
 *
 * `runtimeModelId` is the identity this round runs under. A GRAFTED anchor
 * (the side file carries `anchorFromRound` — `pr-context` carried it
 * forward from an earlier own marker because the previous round closed
 * without one) is usable only when THIS round could actually scope to it:
 * the same-model contract must hold (when the certifier mismatches, Step
 * 1's gate refuses), and the re-run the graft licensed must not have been
 * refused by the fetch or resolved to the head (the plan's recorded
 * `incremental` outcome). When either leg fails, the round re-reads the
 * full diff and the chain is still broken, and the self-check below must
 * still say so.
 */
function prevLedgerFacts(
  planPath: string | undefined,
  runtimeModelId?: string,
): {
  round: number;
  src0: number;
  posted?: number;
  /**
   * The previous round's work list, for the recurrence join. Empty when
   * nothing was recovered — which reads as "no recurrence to find", never
   * as "the previous round found nothing".
   */
  findings: LedgerFinding[];
  /** Its marker shed findings to fit the byte budget: the list is partial. */
  truncated: boolean;
  /** It was recovered from a marker this account did not post. */
  foreign: boolean;
  /** That marker was merged over this account's own findings. */
  merged: boolean;
  /** The posting floor it ran under, when its marker recorded one. */
  floor?: 'c' | 'o';
  /** How many of its comments were findings reported for the first time. */
  fresh?: number;
  /**
   * Its churn streak — how many rounds counted against the churn bar, the
   * standing claim the non-convergence rule reads. Zero on every path that
   * names no usable predecessor.
   */
  churnRounds: number;
  /**
   * Its flat-trend streak — how many consecutive rounds the first-time
   * finding rate did not fall, the claim the floor's early trigger reads
   * (#9903). Same zero rule as the churn streak.
   */
  flatRounds: number;
  /**
   * Whether it carried an incremental anchor THIS round can use — a
   * grafted one whose certifier mismatches, or whose recorded re-run this
   * round's fetch refused or resolved to the head, does not count (Step 1
   * cannot scope to it, so the chain is still broken).
   */
  anchored: boolean;
} {
  try {
    if (!planPath) return EMPTY_PREV_FACTS;
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
      prNumber?: unknown;
      /**
       * This run's incremental ruling, recorded by the `--since` re-run
       * (`fetch-pr`) when one happened; absent when no anchor was passed.
       */
      incremental?: unknown;
    };
    const pr = plan?.prNumber;
    if (!isPositivePrNumber(pr)) return EMPTY_PREV_FACTS;
    const prev = JSON.parse(
      readFileSync(
        join(dirname(planPath), `qwen-review-pr-${pr}-prev-ledger.json`),
        'utf8',
      ),
      // `foreign` is a side-file field, not a marker field: it records how
      // THIS machine obtained the list, which is nothing the marker riding a
      // public body could be trusted to state about itself.
    ) as Ledger & {
      foreign?: unknown;
      merged?: unknown;
      anchorFromRound?: unknown;
    };
    const round =
      Number.isInteger(prev.round) && prev.round > 0 ? prev.round : 0;
    const src0 =
      Number.isInteger(prev.src0) && (prev.src0 as number) > 0
        ? (prev.src0 as number)
        : 0;
    // Read through the ledger's own volume reader rather than a local
    // restatement: the side file is a JSON `pr-context` wrote, not a marker
    // `parseLedger` already normalised, and a boundary that checked the
    // shape without applying the cap let this round's terminal line and its
    // own marker disagree about the same number.
    const posted = volumeOf(prev.posted);
    // The volume travels WITH its round or not at all. A side file carrying
    // a volume but no usable round (partially written, hand-edited) would
    // otherwise attribute it to round 0 — and a round-1 marker would ship
    // `prevPosted` for a round that never existed, against this field's own
    // "absent on round 1" contract.
    // The streak travels with its round for the same reason the volume does:
    // a side file with no usable round is a file this recovery cannot place,
    // and a streak attributed to round 0 would arm the non-convergence rule
    // on a round-1 review that has no predecessor to have churned against.
    // Clamped to the file's own ROUND too, mirroring `parseLedger`'s marker
    // read: the side file is the same untrusted shape arriving by another
    // route — a planted or hand-edited file — and an unclamped streak arms
    // the bar past every round the pull request ever ran, inflating the
    // posted ordinal ("the 10000th round…") after a single counted one.
    const churnRounds =
      round === 0 ? 0 : Math.min(streakOf(prev.churnRounds) ?? 0, round);
    // Same read, same travel-with-round rule as the churn streak it rides
    // beside — the side file is the same untrusted shape, and an unclamped
    // flat streak would engage the floor off rounds the pull request never
    // ran. Clamped TIGHTER than the churn streak, to the HONEST maximum:
    // the signal that advances it gates on round >= 3, so at round N no
    // honest run carries more than N - 2, and a planted file claiming more
    // names rounds the signal could never have measured — engaging the
    // floor a round ahead of the earliest honest engagement.
    const flatRounds =
      round === 0
        ? 0
        : Math.min(streakOf(prev.flatRounds) ?? 0, Math.max(round - 2, 0));
    // Through the ledger's OWN admission test, not a local restatement of
    // two of its checks. The side file is the same untrusted shape as a
    // marker, arriving by a different route: a file written before the id
    // hardening can still hold an id the marker path now rejects, and
    // `birthRound` trims before matching, so the round would be published
    // verbatim in a body this account posts. Normalised for the same reason
    // — the caps are the serializer's contract and this file is not bound by
    // it, while the other side of the recurrence join IS capped.
    // A `findings` field that is not a list at all leaves this read knowing
    // nothing about what the round held — which is not the same as a round
    // that held nothing. Counted as a complete empty list, every claimed id
    // would read as a stray.
    const listUsable = Array.isArray(prev.findings);
    const rawFindings = listUsable ? prev.findings : [];
    const findings = rawFindings
      .filter((f): f is LedgerFinding => isLedgerFinding(f, round))
      .map(normalizeLedgerFinding);
    // Entries this read's own admission test rejected are findings the next
    // round will never rule on, exactly like the ones the marker's cap shed.
    // Reachable without any tampering: a side file persisted by an older CLI
    // carries ids the whole-shape test now refuses, and
    // `persistRecoveredLedger` keeps that list across anonymous and
    // recovery-threw runs.
    const rejected = rawFindings.length - findings.length;
    // A GRAFTED anchor's usability has a second witness beside the
    // same-model gate: what THIS round's fetch recorded about the re-run
    // the graft licensed. A fail-closed winner never posts a sha, so the
    // graft re-derives identically every later round — when the recorded
    // outcome is a refusal (`incremental.effective: false`, e.g.
    // `not-an-ancestor`) or a head-resolution (`upToDate: true`), every
    // later round re-derives the same unusable anchor and re-reads the
    // full diff, so the chain is still broken and the self-check below
    // must keep saying so. An absent outcome keeps the same-model gate as
    // the only witness: no recorded re-run means nothing here can say the
    // graft was unusable.
    let graftRefusedThisRound = false;
    if (typeof plan.incremental === 'object' && plan.incremental !== null) {
      const inc = plan.incremental as {
        effective?: unknown;
        upToDate?: unknown;
      };
      graftRefusedThisRound = inc.effective === false || inc.upToDate === true;
    }

    return {
      round,
      src0,
      churnRounds,
      flatRounds,
      ...(posted === undefined || round === 0 ? {} : { posted }),
      // Gated on the round for the same reason the volume is: a work list
      // travels WITH the round that produced it or not at all. A side file
      // whose `round` is missing or unusable (partially written, hand-edited)
      // still parses, and its `R5-2` ids would then seed the recurrence join
      // for a round this read calls 0 — the posted body would cite rounds 5
      // and up beside a marker stamping round 1.
      findings: round === 0 ? [] : findings,
      // The marker had to shed findings to fit its byte budget, so what came
      // back is known-incomplete (measured at up to 35 shed per round on the
      // worst PRs this diagnosis speaks to). Carried rather than dropped: the
      // cluster evidence is still the best there is, and the paragraph
      // discloses the undercount instead of presenting a partial list whole.
      truncated:
        round !== 0 &&
        (!listUsable ||
          rejected > 0 ||
          (typeof prev.dropped === 'number' && prev.dropped > 0)),
      // Whoever posted the marker that won recovery. `pr-context` adopts the
      // highest-round marker on the PR — bounded, but not restricted to this
      // account — so a cited round may be one this account never ran. The
      // rendering says so rather than publishing the citation bare.
      foreign: round !== 0 && prev.foreign === true,
      merged: round !== 0 && prev.merged === true,
      // The previous round's anchor, as a yes/no THIS round can use. Two
      // consecutive withholds are the shape the self-check discloses; the
      // sha itself is Step 1's business, not this read's. A CERTIFIED
      // anchor counts on presence alone. A GRAFTED one (the side file
      // records `anchorFromRound` — carried forward from an earlier own
      // marker because the previous round closed without one) counts only
      // when this round could actually use it: its certifier must match
      // the identity this round runs under (the same-model gate), AND this
      // round's fetch must not have refused it or resolved it to the head
      // (`graftRefusedThisRound`). Either leg failing means the round
      // re-read the full diff and the next round re-derives the same
      // unusable graft, so the chain is still broken and the disclosure
      // must not be silenced by a sha the round cannot use.
      anchored:
        round !== 0 &&
        typeof prev.sha === 'string' &&
        prev.sha !== '' &&
        (typeof prev.anchorFromRound !== 'number' ||
          (certifierMatchesRound(
            typeof prev.model === 'string' ? prev.model : undefined,
            runtimeModelId ?? '',
          ) &&
            !graftRefusedThisRound)),
      // Travels with the volume it qualifies, and with the round, for the
      // same reason both of those do.
      ...(round === 0 ||
      posted === undefined ||
      !(prev.floor === 'c' || prev.floor === 'o')
        ? {}
        : { floor: prev.floor }),
      // Travels with the volume it is a part of, for the same reason.
      ...(() => {
        const f =
          round === 0 || posted === undefined
            ? undefined
            : volumeOf(prev.fresh);
        return f === undefined || f > (posted as number) ? {} : { fresh: f };
      })(),
    };
  } catch {
    return EMPTY_PREV_FACTS;
  }
}

/**
 * Does this round withhold the incremental anchor?
 *
 * The ONE statement of that decision. The marker acts on it; the
 * mechanism-health self-check READS it, because two consecutive withholds
 * mean the next round re-reads the whole diff and the round after that —
 * the closed loop measured at 119 minutes and 34M tokens on a PR whose code
 * had not changed a line. A restatement in the self-check would let the
 * disclosure describe a round the marker anchored, or stay silent on one it
 * did not.
 */
export function anchorFailsClosed(
  cappedBy: string[],
  scopeUnproven: boolean,
  dimensionGapsAreDepthOnly: boolean,
): boolean {
  return (
    scopeUnproven ||
    !dimensionGapsAreDepthOnly ||
    cappedBy.some((cap) => cap !== 'unreviewed-dimension')
  );
}

/**
 * The next round's marker, or null when this review has no PR to carry one.
 * Round number comes from the side file `pr-context` wrote from the PREVIOUS
 * posted round (+1) — never from the model, never from this input.
 */
function ledgerMarkerFor(
  input: ComposeReviewInput,
  cappedBy: string[],
  scopeUnproven: boolean,
  dimensionGapsAreDepthOnly: boolean,
  attribution: boolean,
  runtimeModelId: string | undefined,
  prevRound: number,
  prevSrc0: number,
  postedInline: number,
  freshInline: number,
  prevPostedInline: number | undefined,
  floorKind: CriticalFloorKind | undefined,
  carriedWorkList: { ids: ReadonlySet<string>; complete: boolean },
  churnRounds: number,
  flatRounds: number,
): string | null {
  try {
    if (!input.planPath) return null;
    if (!planNamesPr(input.planPath)) return null;
    const plan = JSON.parse(readFileSync(input.planPath, 'utf8')) as {
      fetchedSha?: unknown;
      srcDiffLines?: unknown;
      fullSrcDiffLines?: unknown;
      incremental?: { effective?: unknown };
      reviewModelId?: unknown;
    };
    // The anchor rides only when this round's SCOPE was clean. An anchor
    // written past unreviewed scope scopes the NEXT round's incremental diff
    // past it, and no later round ever re-covers the gap — so every cap that
    // could mean "part of this diff went unread" withholds it. (A
    // whitespace-only cannot-tell entry cannot reach this point: the
    // renders-nothing gates fail the draft at ingest.) The findings always
    // ride: a
    // fail-closed round's work list is still a work list; it just cannot
    // certify a range.
    //
    // `unreviewed-dimension` is the ONE cap that does not withhold on its own,
    // and even then only when every entry names the build-and-test dimension
    // (`dimensionGapsAreDepthOnly` — the single role that reads no diff). A
    // whiffed lens is recorded in the same field and IS a claim about lines
    // that no machine detector can see, so it withholds like any other doubt.
    // The exception is measured, not theoretical. That cap fires for the
    // orchestrator's `unreviewedDimensions` prose — on this repo, "the
    // integration suite CI skipped did not run locally", which is true of
    // every round because `build-test`'s whole-call budget cannot fit the
    // suites (measured on PR #9113: 4 of 7 suites `notRun`, 50% of the budget
    // spent on one SIGTERM'd suite). The result was a closed loop: an
    // untestable dimension capped the verdict, the cap withheld the anchor,
    // the missing anchor forced the next round to re-review the full diff —
    // 119 minutes and 34M tokens on a PR whose code had not changed a line
    // since the round before (measured, PR #9113 round 2). A dimension nobody
    // could run says nothing about WHICH LINES were read, and the anchor's
    // only claim is about lines. When the machine coverage evidence does show
    // doubt about the reading itself, `scopeUnproven` carries it here and the
    // anchor is withheld exactly as before.
    const failClosed = anchorFailsClosed(
      cappedBy,
      scopeUnproven,
      dimensionGapsAreDepthOnly,
    );
    const shaCandidate =
      !failClosed && typeof plan.fetchedSha === 'string'
        ? plan.fetchedSha
        : undefined;
    const measured = Number(
      plan.fullSrcDiffLines ??
        (plan.incremental?.effective === true ? 0 : (plan.srcDiffLines ?? 0)),
    );
    const src0 =
      prevSrc0 > 0
        ? prevSrc0
        : Number.isFinite(measured) && measured > 0
          ? Math.round(measured)
          : 0;
    // The anchor's same-model qualifier: "clean up to `sha`" is THIS model's
    // verdict, and Step 1's recovered-anchor gate refuses to scope another
    // model's round to it. The identity is the one the RUNTIME published —
    // the boundaries inject it, and it supersedes the typed id — with the
    // model-written field only as the fallback for runs no session published
    // (and boundary-validated then whenever attribution is on): a review
    // running under one model could otherwise type another's id and certify
    // the range to a model that never reviewed it. Withheld entirely when
    // attribution is off: the setting's contract is "whether the posted
    // review names its model", the marker rides the posted body, and a
    // suppression the footer honours must reach the invisible half too — the
    // anchor then degrades to the skill's absent-model fail-safe. The
    // serializer writes it only beside a sha.
    const runtime =
      typeof runtimeModelId === 'string' ? runtimeModelId.trim() : '';
    const declared =
      typeof input.modelId === 'string' ? input.modelId.trim() : '';
    const certifying = runtime !== '' ? runtime : declared;
    // WHO reviewed, not who is posting. The runtime id above tracks the
    // session's CURRENT model, and the documented deferred-post flow —
    // review under A, `/model` to B, "post comments" — sampled B and
    // certified A's range to it, so the next round under B scoped past code
    // B never reviewed. `fetch-pr` stamps the identity the round STARTED
    // under into the plan; when the two disagree, this round cannot say who
    // reviewed the range and certifies nobody: the anchor pair is withheld
    // and the next round re-reviews in full. An absent stamp (a plan written
    // before the field) reads as unknown, not as agreement — but it also
    // cannot prove disagreement, so it keeps today's behaviour rather than
    // withholding every anchor on an older plan.
    const roundStart =
      typeof plan.reviewModelId === 'string' ? plan.reviewModelId.trim() : '';
    // A blank runtime is a MISMATCH once the round carries a stamp, not a
    // reason to skip the check. The recovery side already rules it that way
    // (`certifierMatchesRound` refuses an empty `running` outright), and the
    // asymmetry was load-bearing in the wrong direction: with the runtime
    // channel empty — a deferred `qwen review submit` run from a terminal
    // outside a session shell, which `round-model.ts` documents as reachable
    // in normal operation — `certifying` falls back to `input.modelId`, the
    // model-WRITTEN field these docstrings retire. The marker then certifies
    // the sha to a typed id, and a later round under a matching typed id
    // scopes past code it never reviewed: the regression this PR exists to
    // close, arriving through the one channel left open.
    //
    // A stamped round whose poster cannot be identified is exactly "this
    // round cannot say who reviewed the range", which is what withholding
    // means. An UNSTAMPED round still keeps today's behaviour — see above:
    // it cannot prove disagreement either.
    const identityDrifted =
      roundStart !== '' && (runtime === '' || roundStart !== runtime);
    const model =
      attribution && certifying !== '' && !identityDrifted
        ? certifying
        : undefined;
    return serializeLedger({
      ...buildLedger(
        // Capped, because the round is the id space and the parser refuses an
        // id from past the cap: an uncapped stamp of prevRound + 1 met the
        // serializer's round clamp at exactly LEDGER_MAX_ROUND and produced a
        // marker whose own parser dropped every finding — invisibly, with the
        // anchor still riding. The recovery path already refuses rounds above
        // the cap, so prevRound can reach it only AT the cap, where staying
        // there loses id uniqueness across those rounds and nothing else —
        // against a counter no real PR approaches.
        Math.min(prevRound + 1, LEDGER_MAX_ROUND),
        (input.draftedComments ?? []) as Array<{
          path?: unknown;
          line?: unknown;
          body?: unknown;
        }>,
        [
          // The same rule the body applied, through the same statement of
          // it: a re-post of a claim the gate regenerates below is dropped
          // here too, or the work-list grows a second entry for one blocker
          // every round.
          ...withoutGateReposts(
            ingestEntryList(input.bodyCriticals, 'bodyCriticals'),
            scriptLintGate(input.planPath).criticals,
          ),
          // The same split the body performed: a relocated Critical is a
          // posted, counted blocker and must enter the work list.
          ...splitDeferralChannel(input.deferredSuggestions).relocated,
          // The gate's Criticals, for the same reason: a gate Critical is a
          // posted, counted blocker too — leaving it out let the next
          // round's persistence half read "no prior Critical" over a round
          // that posted one (#9526).
          //
          // A SECOND invocation, not the body composer's result — the two
          // live in different functions and nothing passes the value across.
          // What makes them agree is that `scriptLintGate` is pure in
          // `planPath` and its inputs (the plan JSON, the report, the diff)
          // are immutable for the length of one synchronous compose; it is
          // NOT the single-origin discipline `postedInline` gets one line
          // below. So the standing hazard is an edit, not a race: anything
          // that filters, caps, or carves out what the BODY pushes must
          // change this list too, or the posted body and the carried work
          // list stop describing the same round (R4-1).
          ...scriptLintGate(input.planPath).criticals,
        ],
        carriedWorkList,
      ),
      // The pair falls together: a sha with no model reads to the next
      // round as a pre-field marker rather than as "nobody certified this".
      ...(shaCandidate && !identityDrifted ? { sha: shaCandidate } : {}),
      ...(model ? { model } : {}),
      // Carry the baseline forward unchanged once one exists; only measure a
      // full-range diff when there is none. Re-measuring every round would let
      // a diff that shrinks rewrite its own baseline and erase the growth it
      // already accumulated.
      ...(src0 > 0 ? { src0 } : {}),
      // Volume telemetry: unconditional, unlike everything above it. The
      // anchor pair is withheld whenever the round could not certify its
      // scope, but "how many comments did this round post" stays true on a
      // fail-closed round — and a trend that goes blank exactly when a PR
      // starts capping would be blind on the rounds it exists to describe.
      posted: postedInline,
      ...(prevPostedInline === undefined
        ? {}
        : { prevPosted: prevPostedInline }),
      // The posture that volume was produced under. Without it, the next
      // round measures a FLOOR change as loop divergence: the volume under a
      // critical floor and the volume under an open one are not two points
      // on one trend. Decides nothing, sheds with the volume it qualifies.
      // The RESOLVED posture, folded the way every consumer folds it: an
      // ABSENT floor reads as `auto` in the REPORTING reading (a present but
      // unrecognisable one reads as nothing at all — see
      // `criticalFloorKind`), and `auto` resolves determinately from the
      // round number and the context state. The ENFORCEMENT reading folds
      // nothing and fails open on both; the gap between the two is what the
      // mechanism-health check discloses. Recording it only when the state NAMED a floor
      // left the guard blind under the DEFAULT configuration — where the
      // posture genuinely transitions at round 6 and again on a transient
      // context failure — so a real posture change read as loop divergence,
      // which is the misreading the field exists to prevent. What must not
      // be invented is a posture nobody can derive; this one is derived from
      // the same fold the advice and the enforcement backstop already use.
      floor: floorKind === undefined ? 'o' : 'c',
      // The part of that volume the trend is about — see `Ledger.fresh`.
      fresh: freshInline,
      ...(churnRounds > 0 ? { churnRounds } : {}),
      // The floor trigger's streak rides beside the churn streak — same
      // rung, same zero-omission; see the field's own note in `Ledger`.
      ...(flatRounds > 0 ? { flatRounds } : {}),
    });
  } catch {
    // A carry-forward convenience, never worth failing the verdict over.
    return null;
  }
}

// One model-written entry folded onto one line — the shape it renders as,
// and the shape the gates and the render legs must share: a forged footer
// or marker can split across the entry's lines where neither half strips,
// but the collapsed line carries it rejoined. By split/join, not a
// `/\s*\n+\s*/g` replace: that regex backtracks quadratically on a long
// whitespace run with no newline in it, and these entries are model-written
// with no length cap — one such entry stalled a measured probe for seconds
// at 80k characters.
function collapseEntry(entry: string): string {
  return entry.includes('\n')
    ? entry
        .split('\n')
        .map((seg) => seg.trim())
        .filter((seg) => seg !== '')
        .join(' ')
    : entry;
}

/** A line that is a code-fence delimiter: a ``` or ~~~ run, any info string. */
export const ENTRY_FENCE_DELIMITER_RE = /^(?:`{3,}|~{3,})/;

/**
 * A model-written entry list as EVERY consumer sees it: one line per entry,
 * trailing footers gone. Stripped per entry, not on the assembled body:
 * these strings render verbatim as the LAST body part, and a forged footer
 * relocated into one would post directly above the canonical footer — the
 * `$`-anchored regex only sees an entry's end, before the footer is
 * appended. Collapsed ONCE at ingestion, before the gates: the gates, the
 * render legs, and the ledger titles must project ONE shape — line-anchored
 * strips have no power on the raw multi-line form, and a leg reading a
 * different shape once carried a forged-attribution fragment the visible
 * list had stripped. An entry containing a fence-delimiter line is refused
 * instead: the collapse trims each line to a segment, so the delimiter
 * surfaces in the posted one-line shape, where CommonMark reads a line
 * starting ~~~ as an OPENING fence whose info string is the rest of the
 * line — the unclosed fence swallows every later body part. A backtick pair
 * degrades to an inline code span, but a truncated or info-bearing backtick
 * opener breaks the same way; no fence survives the collapse, and a
 * redraft is cheap while the draft is still in hand.
 */
function ingestEntryList(value: unknown, field: string): string[] {
  // Line endings normalize to LF on the way in — CommonMark renders a bare
  // `\r` as a line break, and the fence refusal and the collapser below
  // both read lines: a CR-hidden delimiter slipped the refusal, and a
  // CR-folded entry escaped the one-line render.
  const raw = toStringList(value, field).map((entry) =>
    entry.replace(/\r\n?/g, '\n'),
  );
  for (const entry of raw) {
    if (
      entry
        .split('\n')
        .some((line) => ENTRY_FENCE_DELIMITER_RE.test(line.trim()))
    ) {
      throw new Error(
        `compose-review: ${
          field === 'bodyCriticals' ? 'a body Critical' : 'a cannot-tell entry'
        } quotes a code fence its one-line render cannot carry — redraft ` +
          'it quoting the code inline or indented instead',
      );
    }
  }
  // No emptiness filter: an entry that normalizes to nothing must reach
  // the renders-nothing gates and fail the draft, not vanish — see the
  // invariant at the gates below.
  return raw.map(collapseEntry).map(stripReviewFooter);
}

/**
 * `bodyCriticals` through EVERY refusal compose applies to it: the shape
 * and fence gates of `ingestEntryList`, then the renders-nothing gate.
 * One statement of the field's acceptance, so composeReviewBody and any
 * outside caller read the same table.
 */
function ingestBodyCriticals(value: unknown): string[] {
  const entries = ingestEntryList(value, 'bodyCriticals');
  // A body Critical that is nothing but scaffolding renders nothing yet
  // would still count toward REQUEST_CHANGES — the inline-comment path
  // refuses this shape at submit's gate; refuse it here too, while the
  // draft is still cheap to fix. The gate checks the shape the render legs
  // post: strip the trailing forged footer BEFORE the emptiness projection
  // (mirroring `submit`'s gate) — otherwise a footer past the strip's caps
  // passes as ballast, the render legs strip it entirely, and a bare-marker
  // entry posts and counts.
  for (const entry of entries) {
    if (rendersAsNothing(stripReviewFooter(stripForUnattributedPost(entry)))) {
      throw new Error(
        'compose-review: a body Critical renders as nothing (marker-only, ' +
          'empty comment, or otherwise invisible) — redraft it with the ' +
          "finding's description",
      );
    }
  }
  return entries;
}

/**
 * `ingestBodyCriticals`'s acceptance as a total function: the ingested
 * entries when compose would take the field, undefined when it would
 * refuse it. A caller OUTSIDE this boundary that merges into the field
 * without owning the refusal — submit's Aone anchor gate — decides "merge
 * or leave for compose" through the SAME acceptance table, so the two
 * reads can never drift.
 */
export function tryIngestBodyCriticals(value: unknown): string[] | undefined {
  try {
    return ingestBodyCriticals(value);
  } catch {
    return undefined;
  }
}

function composeReviewBody(
  input: ComposeReviewInput,
  cliVersion: string,
  attribution: boolean,
  prevRound: number,
  prevSrc0: number,
  reroute: { indices: number[]; entries: DeferredEntry[] } = {
    indices: [],
    entries: [],
  },
  /**
   * What the convergence diagnosis needs and this function cannot derive: the
   * previous round as the side file recovered it, and the posting floor this
   * round resolved to. Null in the direct-call tests that compose a body with
   * no PR history behind it.
   */
  convergence: {
    prev: PrevRound;
    floor?: 'c' | 'o';
    criticalFloorKind?: CriticalFloorKind;
    /**
     * Whether the CODE backstop enforces the floor this round reports. The
     * two readings differ by one thing — the reporting one folds an absent
     * floor to `auto` and the enforcement one does not — so under the
     * default configuration the prose posture engages while the backstop
     * fails open. That gap is a mechanism fact, not a loop fact.
     */
    floorEnforcementEngaged?: boolean;
    /**
     * The flat-trend streak the floor's early trigger resolved to this
     * round (#9903). Read only by the deferral header: when the floor
     * engaged as `auto-signaled`, the header names the streak so an
     * engagement ahead of the round-6 schedule does not read as an
     * unexplained posture change.
     */
    flatRounds?: number;
  } | null = null,
  /**
   * The non-convergence body Critical this round files, or null. Passed in
   * ready-made rather than computed here: the decision needs the side file's
   * streak, which the caller reads once for the whole compose.
   */
  nonConvergence: string | null = null,
): ComposeReviewResult {
  // The posting set this body describes — `input` here is already the
  // post-enforcement one, so the count needs no second derivation and
  // cannot disagree with the marker's. Clamped AT THE ORIGIN through the
  // shared reader: every other site that reads a volume applies it, and the
  // one that did not was this count on its way to the terminal line, which
  // in the defensive over-cap case would have printed the raw number beside
  // a marker recording the capped one — the two-outputs-disagree failure
  // the shared reader's own docstring exists to prevent. `?? 0` is
  // unreachable for an array length; it keeps the type honest.
  const postedInline = volumeOf((input.draftedComments ?? []).length) ?? 0;
  const criticalsInline = toCount(input.criticalsInline, 'criticalsInline');
  const suggestionsInline = toCount(
    input.suggestionsInline,
    'suggestionsInline',
  );
  const bodyCriticals = ingestBodyCriticals(input.bodyCriticals);
  const suggestionsDiscarded = toCount(
    input.suggestionsDiscarded,
    'suggestionsDiscarded',
  );
  const suggestionsDroppedAsDuplicates = strippedList(
    input,
    'suggestionsDroppedAsDuplicates',
    attribution,
  );
  // A Critical marker in the deferral channel is RELOCATED, never fatal and
  // never deferred: it counts toward `C`, the event blocks, and the round
  // posts (a throw would lose the whole round — the round-5 doctrine). The
  // lookbehind spares hyphenated compounds ("non-Critical findings", the
  // SKILL's own phrasing); the residual false positive — a Suggestion title
  // literally opening `critical:` — costs one wrongly-blocking body entry
  // the next round rules on, not a lost round. The split lives in the
  // shared helper: the ledger marker performs the same one, so a relocated
  // blocker also rides the work list.
  const {
    deferred: modelDeferred,
    relocated: relocatedCriticals,
    relocatedDeterministic,
  } = splitDeferralChannel(input.deferredSuggestions);
  // The floor-enforced reroutes join the model's deferrals AFTER the split:
  // they are constructed typed by this module's own code (see
  // `floorEnforcedReroute`), so routing them through the model-channel
  // validation would only add a throw path to entries that cannot be
  // malformed. Enforcement fires only under conditions where the deferral
  // licence below already holds, so the merge can never create an
  // unlicensed state that the model's own entries did not.
  //
  // NO cross-channel dedup, deliberately. An anchor-keyed identity —
  // (file, line) — cannot distinguish "the same finding riding both
  // channels" from "a different finding drafted at an anchor the model
  // also deferred", and collapsing the second loses a finding from every
  // posted surface: its inline comment leaves the posting set and its
  // constructed entry is absorbed by the collision. "A deferral silently
  // dropped is a finding lost" — between the two failure modes, a
  // duplicated public record (same finding listed once per channel,
  // visible, count-honest) is the cheap one, so the merge keeps every
  // entry from both channels. The enforced entries come FIRST: the
  // rendered list is capped at MAX_DEFERRED_SUGGESTION_LINES, and an
  // enforcement note pointing at a list that truncated away the entries
  // it names would be a disclosure contradicting its own record.
  const deferredSuggestions = [...reroute.entries, ...modelDeferred];
  for (const stray of relocatedCriticals) {
    bodyCriticals.push(stray);
  }
  // The channel's OTHER precondition: deferring is only ever licensed by
  // the posture — `critical` at any round; `auto` from round 2 (the
  // code-age rule) and round 6 (the floor); never an explicit `suggestion`
  // (the operator turned the posture off) and never round 1 of `auto` (no
  // posture, no age reference). An unlicensed deferral is a model
  // mis-execution that would silently un-post findings — but the response
  // is a CAP, not a refusal: a thrown compose loses the WHOLE round,
  // Criticals included, and `prevRound` is a best-effort side-file read
  // whose every failure mode returns 0 — a missing file at a true round 6
  // must degrade to a disclosed, uncertified verdict, never to no verdict
  // at all. The findings render; the cap keeps anything from certifying
  // past them; the anchor is withheld with every other cap. The shape check
  // stays a refusal — a floor that is not one of the three values is a
  // malformed state file, same as a NaN count.
  // A floor the module does not recognise — absent, null, or a
  // model-transcribed spelling drift ("Critical", "auto ", "") — is folded
  // into ONE state: unknown. It caps as unlicensed when a deferral list
  // exists (fail-closed, disclosed) and is inert when it does not — a
  // refusal here would lose the whole round over a field that changes no
  // output on a zero-deferral run, the exact outcome the licence block is
  // written to avoid. Model-transcribed prose is not a NaN count.
  const floorRaw = normalizeSeverityFloor(input.severityFloor);
  const floorKnown =
    floorRaw === 'critical' || floorRaw === 'suggestion' || floorRaw === 'auto';
  const floorAbsent = !floorKnown;
  const severityFloor: 'critical' | 'suggestion' | 'auto' = floorKnown
    ? (floorRaw as 'critical' | 'suggestion' | 'auto')
    : 'auto';
  const cannotTell = ingestEntryList(
    input.cannotTellCriticals,
    'cannotTellCriticals',
  );
  // The same gate in the same order: an entry the render leg would reduce
  // to nothing must fail the draft, not vanish — silently dropping it lifts
  // the `cannot-tell-existing-critical` cap and flips the verdict.
  for (const entry of cannotTell) {
    if (rendersAsNothing(stripReviewFooter(stripForUnattributedPost(entry)))) {
      throw new Error(
        'compose-review: a cannot-tell entry renders as nothing ' +
          '(marker-only, empty comment, or otherwise invisible) — ' +
          "redraft it with the finding's description",
      );
    }
  }
  const uncoverable = toStringList(
    input.uncoverableChunks,
    'uncoverableChunks',
  );
  const unreviewed = toStringList(
    input.unreviewedDimensions,
    'unreviewedDimensions',
  );
  // The coverage-derived disclosures, kept STRUCTURAL ({subject, reason})
  // from the site that knows the boundary — reparsing the rendered prose for
  // it was the bug. `unreviewed` above stays what the caller wrote, verbatim.
  // The `public*` fields are the body's register (`Brief.publicLabel`, a
  // path-free reason); `subject`/`reason` stay the internal keys every dedup
  // and certification check below matches on.
  const coverageEntries: Array<{
    subject: string;
    reason: string;
    publicSubject?: string;
    publicReason?: string;
    subjectZh?: string;
    reasonZh?: string;
  }> = [];
  // The budget-stop marker: when the reverse-audit round builder refused a
  // round on the review's time budget, it recorded the refusal beside the
  // prompt records. Synthesizing the disclosure from the marker makes the
  // verdict cap deterministic — the orchestrator's own copy of the entry
  // (the stderr instruction asks for one) is a courtesy to the terminal
  // reader, and a run that drops the sentence still cannot approve past a
  // truncated audit. Rendered STRUCTURAL, both languages, like every other
  // coverage entry — the orchestrator's compliant relay is byte-identical
  // canonical text, so the canonical-entry splice dedups it out and the two
  // channels never say it twice.
  // The marker's entry is tracked by reference: its relays are deduped by
  // the canonical-entry splice here, so the caller-echo filter below must NOT also
  // prefix-match on its `reverse audit` subject — that shadow silently
  // dropped every OTHER reverse-audit scope the orchestrator disclosed
  // (`reverse audit — chunk 2's auditor returned nothing substantive
  // twice`), in exactly the runs where a partial audit makes such scopes
  // likeliest.
  /**
   * Entries the canonical-relay splice below removes from the rendered list.
   *
   * The splice exists so the body does not say the same gap twice, and it
   * matches entries CONTAINING a full canonical stop entry — verbatim relays
   * and prefix-reshaped ones alike ("step 5 — " ahead of the subject), which
   * the coverage prefix filter cannot see. An earlier match on the bare stop
   * PHRASE spliced more: an entry that merely mentioned the review time
   * budget in its free-form reason ("security — the review time budget ended
   * the round before the security relaunch returned evidence") was dropped
   * from the posted body, though it is exactly the line-coverage claim both
   * the author and the anchor decision must see. Such entries now stay in
   * `unreviewed` — rendered and capping. The spliced relays are kept here so
   * the decision can read the list AS DISCLOSED while the body renders the
   * structural stop line once.
   *
   * Collected rather than snapshotted: the deterministic gates push their own
   * machine-owed debts into `unreviewed` AFTER this point, and a snapshot
   * taken here would miss them — a round capped solely by an unlinted script
   * or an unwalked defect layer would classify as depth-only and anchor. The
   * decision therefore reads the LIVE list plus these.
   */
  const splicedForBudgetPhrase: string[] = [];
  /** The exact entries the stop machinery mints — the ONLY exempt relays.
   *  Non-null iff the machine's own budget-stop marker exists: the exemption
   *  is marker-anchored, so stop-shaped prose with no marker behind it buys
   *  nothing. */
  let canonicalStopEntries: Set<string> | null = null;
  let budgetEntry: (typeof coverageEntries)[number] | undefined;
  let roundCapStopped = false;
  if (input.planPath) {
    const stop = readBudgetStop(input.planPath);
    if (stop !== null) {
      canonicalStopEntries =
        stop.cause === 'round-cap'
          ? new Set([
              roundCapStopEntry(
                typeof stop.cap === 'number'
                  ? stop.cap
                  : LARGE_REVERSE_AUDIT_ROUNDS,
              ),
              roundCapStopEntryZh(
                typeof stop.cap === 'number'
                  ? stop.cap
                  : LARGE_REVERSE_AUDIT_ROUNDS,
              ),
            ])
          : new Set([
              budgetStopEntry(stop.round ?? undefined),
              budgetStopEntryZh(stop.round ?? undefined),
            ]);
      // A round-cap stop and a time-budget stop both cap the verdict, but
      // read differently. The marker's `cause` picks which pair of canonical
      // entries exists; an absent cause is a time stop, for markers written
      // before the cause field existed.
      const isRoundCap = stop.cause === 'round-cap';
      // Corroborating text for the approach signal below. Read-only: the
      // entry keeps its existing coverage cap untouched, and this flag is
      // never a trigger on its own — only a clause appended when the signal
      // has already fired on rounds and growth.
      roundCapStopped = isRoundCap;
      // Spliced on the FULL canonical entry text (both languages: the
      // exemption admits the Chinese pair as a compliant relay, so the
      // splice must retire it too, or the same gap renders twice beside the
      // structural stop line) — as a substring, because an orchestrator
      // relay arrives verbatim OR reshaped with a prefix ("step 5 — " ahead
      // of the subject), and the coverage prefix filter cannot see the
      // reshaped one. What the predicate must NOT be is the bare stop
      // PHRASE: that retired more than the relays — a genuine line-coverage
      // disclosure that merely mentions the budget in its free-form reason
      // ("security — the review time budget ended the round before the
      // security relaunch returned evidence") was dropped from the posted
      // body, and the module's contract is that a disclosed gap reaches the
      // author. Such entries now stay in `unreviewed` — rendered AND
      // capping. (The anchor DECISION below stays exact-text: a reshaped
      // relay spliced here still withholds, over-withholding being the safe
      // direction.)
      const entries = [...canonicalStopEntries];
      for (let i = unreviewed.length - 1; i >= 0; i--) {
        if (entries.some((c) => unreviewed[i].includes(c))) {
          splicedForBudgetPhrase.push(unreviewed[i]);
          unreviewed.splice(i, 1);
        }
      }
      budgetEntry = isRoundCap
        ? roundCapStopDisclosure(
            typeof stop.cap === 'number'
              ? stop.cap
              : LARGE_REVERSE_AUDIT_ROUNDS,
          )
        : budgetStopDisclosure(stop.round ?? undefined);
      coverageEntries.push(budgetEntry);
    }
  }
  // The fixes for the gaps above, for stderr — never for the body. The gap says
  // what the review cannot certify, to the PR author; the remediation names the
  // command that repairs it, to the orchestrator. #7012's public body was fourteen
  // lines of the second register posted to the first reader.
  const remediation: string[] = [];
  // Budget-gap disclosures from the coverage report — the checks agents said
  // their soft tool budget cut short. A DISCLOSURE channel, deliberately not
  // a cap: these render in the body's "Not reviewed" section mechanically
  // (so a disclosed gap reaches the author whether or not the orchestrator
  // relays it), while judging which gaps name an incomplete REQUIRED trace —
  // and so belong in `unreviewedDimensions`, which caps — stays the
  // orchestrator's ruling, exactly as the skill's Step 3D writes it. Capping
  // on every gap here would make the soft ceiling hard: any large diff's
  // routine budget stop would forbid an Approve the review otherwise earned.
  const budgetGapNotes: Array<{ agent: string; gaps: string[] }> = [];
  // Certified agent results recovered from an interrupted earlier attempt
  // (a resumed run). Informational, NEVER capping: recovered work is counted
  // AS reviewed, so it must not ride `coverageEntries` — an entry there caps
  // the verdict and renders under "Not reviewed:", the exact opposite of the
  // fact. Rendered as its own disclosed-but-not-capping block below.
  let recoveredFromPriorAttempt = 0;
  // Sibling caps MAX_DIMENSIONS and MAX_NOTES bound their lists for the
  // same reason; this bounds the one budget-gap sentence.
  const MAX_BUDGET_GAP_LINES = 5;
  // FIX lines are commands. `<plan>` was a placeholder a reader had to notice
  // and fill; pasted literally it parses as a shell redirection. The run KNOWS
  // its plan path — substitute it, and leave only the selectors (`<id>`, `<r>`)
  // that genuinely vary per agent, resolvable from the labels alongside.
  // Shell-quoted: a workspace path containing a space would otherwise split
  // the copy-pasted repair at the space, and a bare '…' wrap broke on embedded
  // apostrophes instead. (`<plan>` stays bare — a placeholder, not a path.)
  const planRef = input.planPath ? shellQuotePath(input.planPath) : '<plan>';

  // Coverage is shown, not asserted. Whatever the caller listed by hand, the
  // report's own gaps are added to it — a run cannot approve past a chunk nobody
  // receipted or an agent that returned nothing, and it cannot do so by leaving
  // the lists empty.
  // Separate from `uncoverable`. The uncoverable renderer explains the gap as
  // "a line there exceeds the read limit", which is true of an uncoverable chunk
  // and a fabrication about a chunk nobody receipted. The public body would give
  // the author a false cause.
  const missingReceipts: number[] = [];

  // The plan's chunk→files table and the chunks somebody demonstrably read,
  // for the body renderer and the opener. Empty when no plan could be used —
  // `describeChunkGap` then counts against nothing, and the opener's
  // zero-certified test falls to the `coverage` disclosure instead.
  let plannedChunks: Array<{ id: number; files: string[] }> = [];
  let coveredChunks: number[] = [];

  // The deterministic script-lint gate. `compose-review` is the authority here:
  // it reads the report the orchestrator's `qwen review script-lint` step wrote
  // and turns it into the verdict itself, so neither the existence of a blocker
  // nor its severity depends on a model. A finding on a changed line (above
  // cosmetic `style`) is a pre-confirmed `[lint]` Critical; an uninstalled or
  // crashed checker is unreviewed scope; and — the proof it ran — a diff that
  // carries an executable script but has no readable report is itself unreviewed
  // (fail closed). The report path is derived from the plan, not the input JSON a
  // model wrote, and the plan decides whether the lint was owed.
  // The gate's own body Criticals are deterministic by PROVENANCE — `scriptLintGate`
  // ran the linter — so they never need a verifier. Track them as a SEPARATE list
  // rather than mix them into the model's criticals and subtract a COUNT: a count
  // subtraction misfires when a model claim happens to carry a `[build]`/`[test]`/
  // `[probe]` tag (filtered out before the subtract) or a gate finding's own text
  // contains one, erasing an unrelated claim's verification requirement. Identity,
  // not arithmetic, decides provenance.
  //
  // The gate runs BEFORE that capture, and its regenerated claims are used to
  // drop the model's re-posts of them first. Dropping them later would leave
  // the re-post out of the body while `modelBodyCriticals` still counted it
  // toward `criticalsNeedingVerify` — a blocker the linter proved would go on
  // pulling the unverified cap through a copy that no longer posts.
  const gate = input.planPath
    ? scriptLintGate(input.planPath)
    : { criticals: [], unreviewed: [], disclosed: [] };
  const ownAfterGateDedup = withoutGateReposts(bodyCriticals, gate.criticals);
  bodyCriticals.length = 0;
  bodyCriticals.push(...ownAfterGateDedup);
  const modelBodyCriticals = [...bodyCriticals]; // input's, captured before the gate
  // Disclosed-but-non-capping notes from the gate (a deferred checker). Rendered
  // in the body on every verdict, but never fed into the cap.
  const gateDisclosed: string[] = [];
  // Test Plan rulings. Disclosed on every verdict and counted toward nothing —
  // see `testPlanGate` for why this one neither blocks nor caps.
  const testPlanNotes: string[] = [];
  // Repository proof boundaries are also disclosures, not findings or permanent
  // approval caps. The first schema has no validated evidence channel that could
  // resolve one after a specialist inspects it, so capping here would make every
  // affected review impossible to approve.
  const repositoryContextNotes: string[] = [];
  if (input.planPath) {
    // The gate ran above, where its claims were needed to dedup the model's
    // re-posts before provenance was taken. ONE invocation, reused here.
    bodyCriticals.push(...gate.criticals); // render + count toward `c`, deterministic
    unreviewed.push(...gate.unreviewed);
    gateDisclosed.push(...gate.disclosed);
    testPlanNotes.push(...testPlanGate(input.planPath).notes);
    repositoryContextNotes.push(...repositoryContextGate(input.planPath));
    // Modeled-executable-system diffs (declared by the manifest domain) owe
    // per-layer reverse-audit coverage; an unwalked defect layer joins
    // `unreviewedDimensions` and caps a would-be Approve, exactly like a
    // dimension nobody reviewed. Inert on every diff the manifest does not mark.
    unreviewed.push(...layerAuditGate(input.planPath, input.env).unreviewed);
  }
  // The non-convergence finding rides the SAME channel as the gates above,
  // and for the same reason: it is deterministic by provenance — this module
  // counted the streak from its own marker and side file, and the census
  // beside it is the orchestrator-supplied half, checked in `composeReview`
  // for shape and against everything this round reports before it could arm
  // the streak. There is no verifier for it and there never will be, so
  // routing it through `modelBodyCriticals` would demand one and cap the
  // verdict on a gap no repair can close. It is pushed AFTER that capture on
  // purpose; moving this line above it silently converts the finding into an
  // unsatisfiable cap.
  if (nonConvergence) bodyCriticals.push(nonConvergence);

  // The Criticals a verifier must have ruled on before this review may post them as
  // blockers. Only the MODEL's criticals are candidates — the gate's are excluded by
  // construction (they are not in `modelBodyCriticals`). Of the model's, `[build]`/
  // `[test]` (Agent 7 ran the tool) and `[probe]` (the verifier ran a probe) are
  // pre-confirmed and skip verification. `[lint]` is NOT trusted as a tag — a
  // model-written string containing it must not launder an unverified claim into a
  // blocker (that is what the gate's provenance-tracked criticals are for).
  // Relocated entries (the tail of `modelBodyCriticals` — pushed after the
  // input's own) are classified by the deferral channel's position-anchored
  // rule, counted in the split, not by the whole-entry tag scan the model's
  // own body Criticals get: they came in as deferral strings, and a
  // title-borne `[test]` must not exempt an unverified relocated claim from
  // the floor.
  const relocatedCount = relocatedCriticals.length;
  const ownBodyCriticals = modelBodyCriticals.slice(
    0,
    modelBodyCriticals.length - relocatedCount,
  );
  const nonDeterministicBodyCriticals =
    ownBodyCriticals.filter((x) => !DETERMINISTIC_TAG_RE.test(x)).length +
    (relocatedCount - relocatedDeterministic);
  const criticalsNeedingVerify =
    criticalsInline + nonDeterministicBodyCriticals;
  // Fail closed at every exit: this flag softens a Request changes below, and
  // it must end up true whenever the review posts non-deterministic Criticals
  // and CANNOT SHOW they were verified — verifier absent, transcripts
  // unreadable, or no plan to check against. "Could not show" and "was not"
  // read the same to the person the blocker would be posted at.
  let criticalsUnverified = false;

  // Coverage is NOT taken from the input. It is recomputed here, from the
  // harness's own per-agent transcripts.
  //
  // The previous shape accepted a `coverage` object inside this very JSON — a
  // document the model writes. Hardening `check-coverage` while this still
  // believed a hand-typed `{"ok": true}` would have moved the forgery one hop
  // downstream and made it *cheaper*: one object, instead of the eighteen
  // fabricated receipts it actually wrote the last time it wanted an approval.
  // A caller cannot forge what it cannot supply, so it no longer supplies this.
  //
  // What it supplies is `planPath` — a path, whose contents the CLI wrote. The
  // transcripts are found from the environment the CLI exported.
  if (!input.planPath) {
    coverageEntries.push({
      subject: 'coverage',
      reason:
        'no plan was given, so this run cannot show that any of the diff ' +
        'was read',
      subjectZh: '覆盖情况',
      reasonZh: '未提供 plan，本次运行无法证明 diff 的任何部分被读过',
    });
    criticalsUnverified = criticalsNeedingVerify >= 1;
  } else {
    try {
      const cov = coverageFromTranscripts(input.planPath, input.env);
      plannedChunks = cov.plannedChunks;
      coveredChunks = cov.coveredChunks;
      for (const id of cov.missingChunks) missingReceipts.push(id);
      for (const id of cov.uncoverableChunks) {
        // The caller may already have named this chunk, but in a richer form:
        // `chunk 5 (src/big.min.js)` vs the bare `chunk 5` here. A strict-equality
        // dedup misses that and the body reads "Not reviewed: chunk 5, chunk 5".
        // Compare by the `chunk <id>` prefix.
        const prefix = `chunk ${id}`;
        const already = uncoverable.some(
          (e) => e === prefix || e.startsWith(`${prefix} `),
        );
        if (!already) uncoverable.push(prefix);
      }
      for (const label of cov.idleAgents) {
        coverageEntries.push({
          subject: label,
          publicSubject: publicAgentSubject(label),
          reason: 'the agent made no tool call: it read nothing',
          reasonZh: '该 agent 未发起任何工具调用：它什么都没读',
        });
      }
      if (cov.idleAgents.length > 0) {
        remediation.push(
          'idle agents: relaunch each with the same printed prompt — it already ' +
            'names the brief and the diff reads; an agent that makes no tool ' +
            'call has reviewed nothing, whatever its return says',
        );
      }
      // The defect that actually happened, named as itself. A blind agent was
      // launched with a prompt that never mentioned the diff, so it could not
      // have read it — and relaunching it would produce another agent that
      // cannot either. Do not call this a whiff; the prompt is the bug.
      // The rebuild command goes to stderr with the other remediation, not into
      // this line: the line lands in the posted body, and `qwen review
      // agent-prompt` is not something a PR author can run.
      for (const label of cov.blindAgents) {
        coverageEntries.push({
          subject: label,
          publicSubject: publicAgentSubject(label),
          reason:
            'launched with a prompt that never named the diff file, so it ' +
            'could not have read it',
          reasonZh: '启动 prompt 从未提到 diff 文件，它不可能读过 diff',
        });
      }
      if (cov.blindAgents.length > 0) {
        remediation.push(
          'blind agents: rebuild each prompt with `"${QWEN_CODE_CLI:-qwen}" ' +
            `review agent-prompt --plan ${planRef} --chunk <id>\` (or \`--role <r>\`) ` +
            '`[--rules <rules file>]` and launch an agent with it verbatim — ' +
            'do not relaunch the old prompt; a second blind agent reads no ' +
            'more than the first',
        );
      }
      // Worked, but not on the diff. Not idle and not blind — it had the path and
      // spent its run somewhere else, which on a diff with deletions means it
      // reviewed a file the removed lines are simply not in.
      for (const label of cov.unopenedAgents) {
        coverageEntries.push({
          subject: label,
          publicSubject: publicAgentSubject(label),
          reason:
            'pointed at diff lines it never opened: it made tool calls, but ' +
            'none of them read the diff',
          reasonZh:
            '启动 prompt 为它指定了 diff 中的行，但它从未打开：有工具调用，' +
            '却没有一次读取 diff',
        });
      }
      if (cov.unopenedAgents.length > 0) {
        remediation.push(
          'agents that never opened the diff: relaunch each with the same ' +
            'printed prompt — the prompt already names the diff and its ranges; ' +
            'the read is what proves the review happened',
        );
      }
      budgetGapNotes.push(...cov.budgetGaps);
      recoveredFromPriorAttempt = cov.recoveredAgents;
      // The prompt was built in code and edited on the way to the agent. This caps
      // for the same reason the others do: what the agent was actually asked is not
      // what this skill's guarantees are written against.
      // `coverage.ts` already writes these self-explanatory (`… — launched with a
      // prompt that is not the one the CLI built`), so push the label as-is —
      // wrapping it in a second ` — ` clause read as one run-on sentence with two
      // dashes. Same for `missingRoles` below; `unreadBriefs` already did this.
      // rewritten, missing-role and unread-brief entries arrive structurally
      // (`cov.disclosures`, push order preserved) — their labels can carry
      // em-dashes of their own, which is why they are never reparsed here.
      coverageEntries.push(...cov.disclosures);
      if (cov.rewrittenPrompts.length > 0) {
        remediation.push(
          'rewritten launches: re-run `"${QWEN_CODE_CLI:-qwen}" review ' +
            `agent-prompt --plan ${planRef} --chunk <id>\` (or \`--role <r>\`, with ` +
            '`--file <path>` for an invariant agent) `[--rules <rules file>]` ' +
            'for each named agent and pass its output unedited — copy it, do ' +
            'not retype it. Pass --rules whenever the review loaded any, or ' +
            'the rebuilt brief silently drops the project rules',
        );
      }
      // A dimension nobody reviewed. This is exactly what `unreviewedDimensions`
      // has always meant, arrived at from the plan instead of from the orchestrator
      // noticing — which, on the run that never launched Agent 0, it did not.

      if (cov.missingRoles.length > 0) {
        remediation.push(
          'missing briefs: build every required prompt in one call — ' +
            `\`"\${QWEN_CODE_CLI:-qwen}" review agent-prompt --plan ${planRef} ` +
            '--roster [--rules <rules file>]` — and launch one agent per block ' +
            'it prints, verbatim; `--role <n>` or `--chunk <id>` rebuilds a ' +
            'single one. Pass --rules whenever the review loaded any',
        );
      }
      // Launched, but never read the brief it was pointed at: it reviewed with no
      // dimension, no severity definitions and no project rules.

      if (cov.unreadBriefs.length > 0) {
        remediation.push(
          'unread briefs: relaunch each agent with the same printed prompt — ' +
            'the agent must OPEN the brief file the prompt names; that read ' +
            'is the receipt',
        );
      }
    } catch (err) {
      // Two different failures, and they must not wear each other's message. A
      // malformed plan is the caller's mistake and says so; missing transcripts
      // are an environment fault (a read-only HOME, a sandbox) and say *that*.
      // Both cap — a run that cannot show what it read has not shown it read
      // anything — but a reader chasing "could not read the transcripts" over a
      // plan with no `chunks[]` is chasing the wrong thing.
      const why =
        err instanceof TranscriptsUnavailableError
          ? `could not read the agents' transcripts (${err.message})`
          : `the plan could not be used (${(err as Error).message})`;
      const whyZh =
        err instanceof TranscriptsUnavailableError
          ? `无法读取 agent 的运行记录（${err.message}）`
          : `plan 无法使用（${(err as Error).message}）`;
      coverageEntries.push({
        subject: 'coverage',
        reason: `${why}, so this run cannot show that any of the diff was read`,
        subjectZh: '覆盖情况',
        reasonZh: `${whyZh}，本次运行无法证明 diff 的任何部分被读过`,
      });
    }

    // Step 4 (verify) and Step 5 (reverse audit) ran, and read their briefs?
    // `check-coverage` proves Step 3, but it runs at Step 3D — before these exist —
    // and their count is not in the plan, so its roster cannot reach them. This is
    // the floor that does, and only `compose-review` asks it, which runs at high
    // and medium effort. Reverse audit is required only at high; medium skips it by
    // design, and `verificationGaps` caps a clean medium verdict at Comment instead
    // of flagging it as missing. Verify runs at both, once the review
    // has non-deterministic findings to verify. Deterministic `[build]`/`[test]`
    // findings are pre-confirmed and skip verification by design, so they do not
    // demand a verifier — including a body Critical that carries their source tag.
    // Its own try, so a read failure here says so rather than wearing the coverage
    // message, and does not undo a coverage pass a line above it.
    try {
      // Deferred findings count toward the delivery floor: they publish in
      // the body as the deferral list, and an unverified claim published as
      // "recorded, not requested" is still an unverified claim published — a
      // deferrals-only APPROVE must not slip past the verifier floor that a
      // posting run would have met. NON-DETERMINISTIC deferrals only, the
      // same exclusion the body Criticals get: a `[build]`/`[test]`/`[probe]`
      // finding is pre-confirmed and Step 4 launches no verifier for it, so
      // counting it demands a delivery that cannot exist — the cap never
      // lifts, the anchor is withheld every round, and the full-range
      // re-review loop the posture exists to end is regenerated by its own
      // enforcement. (Deferral entries carry their source tag for exactly
      // this scan — the SKILL's entry format.)
      const findingsToVerify =
        criticalsInline +
        suggestionsInline +
        nonDeterministicBodyCriticals +
        deferredSuggestions.filter((e) => !DETERMINISTIC_SOURCES.has(e.source))
          .length;
      const verification = verificationGaps(
        input.planPath,
        { postsFindings: findingsToVerify > 0 },
        input.env,
      );
      // Structural, both languages — no boundary is recovered from rendered
      // prose (reparsing was the bug the disclosure entries already fixed).
      for (const gap of verification.gaps) {
        coverageEntries.push({
          subject: gap.subject,
          reason: gap.reason,
          subjectZh: gap.subjectZh,
          reasonZh: gap.reasonZh,
        });
      }
      remediation.push(...verification.remediation);
      criticalsUnverified =
        verification.unverifiedFindings && criticalsNeedingVerify >= 1;
    } catch (err) {
      coverageEntries.push({
        subject: 'verification',
        reason:
          `could not check that Step 4 and Step 5 ran ` +
          `(${(err as Error).message})`,
        subjectZh: '验证',
        reasonZh: `无法检查步骤 4 与步骤 5 是否运行（${(err as Error).message}）`,
      });
      // Fail closed: a verification that cannot be CHECKED is not a
      // verification that happened.
      criticalsUnverified = criticalsNeedingVerify >= 1;
    }
  }

  // The pipelined loop's invariant, machine-checked. "The last round's
  // verification completes before Step 6" used to be STRUCTURAL — the serial
  // loop could not build round k+1 before round k's verdicts merged — and
  // pipelining replaced the structure with a tag the orchestrator adds,
  // removes, and reads by hand. The delivery floor above cannot see the miss:
  // it asks for ONE clean verify delivery across the whole key family, and
  // each round's verifier is keyed by that round's findings digest, so round
  // 1's launch clears the floor while round 5's findings go out unverified.
  // So the findings file itself is read here: a surviving tag is an entry no
  // verifier ruled on, and it caps the verdict whether or not Step 6's read
  // excluded it. The path is a caller-written input like `planPath`; the
  // check fails CLOSED when it does not read, and fails OPEN when it is
  // omitted — a medium review runs no Step 5 and has no findings file.
  let findingsUnverifiedAtCompose = false;
  let findingsFileUnreadable = false;
  let unverifiedTagCount = 0;
  const findingsPath: unknown = input.findingsPath;
  if (findingsPath !== undefined && findingsPath !== null) {
    if (typeof findingsPath !== 'string' || findingsPath.trim() === '') {
      throw new TypeError(
        `compose-review: findingsPath must be a non-empty string, got ${JSON.stringify(findingsPath)}`,
      );
    }
    try {
      const findingsContent = readFileSync(findingsPath, 'utf8');
      unverifiedTagCount = (
        findingsContent.match(UNVERIFIED_FINDING_TAG_RE) ?? []
      ).length;
      findingsUnverifiedAtCompose = unverifiedTagCount > 0;
      if (findingsUnverifiedAtCompose) {
        remediation.push(
          'findings still tagged `— [unverified]`: relaunch the verifier ' +
            'for each tagged entry (Step 4, `--role verify` with that ' +
            'entry), apply its verdict in the cumulative findings file, ' +
            'and run compose-review again with the updated file',
        );
      }
    } catch {
      findingsFileUnreadable = true;
      findingsUnverifiedAtCompose = true;
      remediation.push(
        'findings file not readable: pass the cumulative reverse-audit ' +
          "findings file — the one every round's `--findings` received — " +
          'as `findingsPath` in the state JSON, and run compose-review ' +
          'again',
      );
    }
  }

  const contextUnavailable = toBool(
    input.contextUnavailable,
    'contextUnavailable',
  );

  // The deferral licence, decided here because two of its arms need inputs
  // parsed above: deferring is only ever licensed by the posture —
  // `critical` at any round; `auto` from round 2 (the code-age rule) and
  // round 6 (the floor); never an explicit `suggestion` (posture off),
  // never round 1 of `auto` (no posture, no age reference), never `auto` in
  // the context-unavailable state (the round is unknowable — SKILL resolves
  // it as round 1), and never with the field ABSENT beside a non-empty list
  // (the licence cannot be checked, and the channel ships in the same PR as
  // the field — omission is fail-closed, not grandfathered). The response
  // is a CAP, not a refusal: a thrown compose loses the whole round,
  // Criticals included, and `prevRound` is a best-effort side-file read
  // whose every failure mode returns 0 — a missing file at a true round 6
  // must degrade to a disclosed, uncertified verdict, never to no verdict
  // at all. The findings render; the cap keeps anything from certifying
  // past them; the anchor is withheld with every other cap.
  const unlicensedDeferral =
    deferredSuggestions.length === 0
      ? null
      : floorAbsent
        ? 'the state carried no recognisable `severityFloor`, so the licence cannot be checked'
        : severityFloor === 'suggestion'
          ? 'the operator turned the posture off (`--severity-floor suggestion`)'
          : severityFloor === 'auto' && contextUnavailable
            ? 'the round is unknowable in the context-unavailable state'
            : severityFloor === 'auto' && prevRound === 0
              ? 'no posture is engaged on round 1 and no age reference exists'
              : null;
  const presubmitRaw: unknown = input.presubmit ?? {};
  if (typeof presubmitRaw !== 'object' || Array.isArray(presubmitRaw)) {
    throw new TypeError(
      `compose-review: presubmit must be an object, got ${JSON.stringify(presubmitRaw)}`,
    );
  }
  const presubmitObj = presubmitRaw as Record<string, unknown>;
  const downgradeApprove = toBool(
    presubmitObj['downgradeApprove'],
    'presubmit.downgradeApprove',
  );
  const downgradeRequestChanges = toBool(
    presubmitObj['downgradeRequestChanges'],
    'presubmit.downgradeRequestChanges',
  );
  const downgradeReasons = toStringList(
    presubmitObj['downgradeReasons'],
    'presubmit.downgradeReasons',
  );
  const modelId: unknown = input.modelId;
  let footer = '';
  if (attribution) {
    if (typeof modelId !== 'string' || modelId.trim() === '') {
      throw new TypeError(
        'compose-review: modelId is required (the public footer names the reviewing model)',
      );
    }
    if (!isFooterSafeModelId(modelId)) {
      throw new TypeError(
        'compose-review: modelId is interpolated into the public footer ' +
          'verbatim — it must be a single line that does not contain the ' +
          'footer marker',
      );
    }
    footer = reviewFooter(modelId, cliVersion);
    if (modelId.length > MODEL_ID_MAX_CHARS) {
      remediation.push(
        `body budget: modelId was ${modelId.length} characters and was ` +
          `clamped to the footer's ${MODEL_ID_MAX_CHARS}-character cap — ` +
          `the posted attribution is truncated`,
      );
    }
    if (cliVersion.length > MODEL_ID_MAX_CHARS) {
      remediation.push(
        `body budget: cliVersion was ${cliVersion.length} characters and ` +
          `was clamped to the footer's ${MODEL_ID_MAX_CHARS}-character ` +
          `cap — the posted version stamp is truncated`,
      );
    }
  }

  // `C` — every Critical this review posts anywhere, inline or body. Named
  // here because two consumers need it: the verdict below, and the
  // convergence diagnosis, whose `land-and-defer` recommendation turns on
  // exactly this fact. Two derivations of one count is the drift class this
  // file's header exists to prevent — and it is computed HERE, after the
  // last `bodyCriticals.push`, because the stray-marker leg and the
  // script-lint gate both add blockers after the list is declared.
  const openCriticals = criticalsInline + bodyCriticals.length;

  // `C` counts every Critical the review posts anywhere — inline or body.
  // `S` counts every *confirmed* Suggestion — anchored, discarded, or dropped
  // as an already-reported duplicate: the verdict reflects the findings the
  // review confirmed, not the ones that anchored or were worth re-posting, so
  // neither dropping every anchor nor every duplicate may upgrade the event
  // to APPROVE.
  const c = openCriticals;
  const s =
    suggestionsInline +
    suggestionsDiscarded +
    suggestionsDroppedAsDuplicates.length;

  const baseEvent: ReviewEvent =
    c >= 1 ? 'REQUEST_CHANGES' : s >= 1 ? 'COMMENT' : 'APPROVE';

  // Caps: states outside this run's confirmed count that forbid an
  // approval. A REQUEST_CHANGES earned by a confirmed Critical is never
  // softened by them.
  const cappedBy: string[] = [];
  if (cannotTell.length > 0) cappedBy.push('cannot-tell-existing-critical');
  if (missingReceipts.length > 0) cappedBy.push('chunk-nobody-read');
  if (uncoverable.length > 0) cappedBy.push('uncoverable-chunk');
  if (unreviewed.length + coverageEntries.length > 0) {
    cappedBy.push('unreviewed-dimension');
  }
  if (contextUnavailable) cappedBy.push('context-unavailable');
  if (unlicensedDeferral !== null) cappedBy.push('unlicensed-deferral');
  if (criticalsUnverified) cappedBy.push('criticals-unverified');
  if (findingsUnverifiedAtCompose) {
    cappedBy.push('findings-unverified-at-compose');
  }

  // Is there any doubt that the whole diff was READ? That is a narrower
  // question than "did anything cap the verdict", and it is the only one the
  // incremental anchor needs — see `ledgerMarkerFor`. Every entry counted here
  // is machine-derived (recomputed from the harness's own transcripts a few
  // hundred lines above), never the orchestrator's prose: an agent that made
  // no tool call, one launched without the diff in its prompt, one that never
  // opened it, a chunk with no receipt, a plan or transcript set that could
  // not be read, a context fetch that failed. `budgetEntry` is excluded on
  // purpose — a disclosed budget gap is the ceiling working, and it says
  // something about DEPTH, not about which lines were read.
  const scopeUnproven =
    missingReceipts.length > 0 ||
    uncoverable.length > 0 ||
    contextUnavailable ||
    coverageEntries.some((entry) => entry !== budgetEntry);

  // Is every dimension gap the orchestrator disclosed about DEPTH rather than
  // about which lines were read?
  //
  // Only one dimension can answer yes, and it is not a judgement call: Agent 7
  // is the single role whose brief declares `readsDiff: false` (agent-briefs).
  // Its gap — "the integration suite CI skipped did not run locally" — says
  // nothing about the diff, because that agent never reads the diff.
  //
  // Every OTHER entry is a line-coverage claim wearing dimension prose, and
  // the machine cannot see it: a whole-diff lens that made tool calls, opened
  // files and returned a bare "No issues found" twice is a whiff, the
  // orchestrator's entry is the ONLY detector, and `coverageFromTranscripts`
  // (idle / blind / never-opened) reports nothing. Exempting those from the
  // anchor would let a twice-whiffed Security lens advance the range past the
  // lines it never reviewed — the harm the skill's own paragraph warns about,
  // and the reason the first cut of this exemption was wrong.
  // Read at the DECISION point, not at any earlier one: `unreviewed` is written
  // both before this line (the orchestrator's own entries) and after the
  // snapshot an earlier fix took (the script-lint and layer-audit gates, whose
  // debts are machine-owed line-coverage claims). Reading it here plus the
  // entries the canonical-entry splice removed is the only list that sees
  // every writer.
  //
  // The stop's own relayed entry classifies as DEPTH, and only against the
  // marker. A budget/round-cap stop truncates how many audit PASSES ran over
  // lines whose reading the receipts already prove — the same depth claim the
  // build-and-test exemption rests on — and its verdict cap (`budgetEntry`) is
  // pushed from the marker whether or not the orchestrator relayed the entry.
  // Without this the outcome was relay-dependent: a compliant run (entry
  // relayed, as stderr mandates) withheld the anchor while an identical run
  // that dropped the entry carried it.
  //
  // Exempt on the EXACT machine text, nothing looser. The first cut matched
  // head-plus-phrase, and that shape also covers a genuine line-coverage claim
  // whose whiffed scope IS the reverse audit — `reverse audit — the review
  // time budget ended the round before the chunk-2 relaunch returned
  // evidence` — which the then-substring splice also removed from the
  // rendered body, so the anchor rode past a whiffed audit while the posted
  // review showed only the benign disclosure (both predicates are exact
  // now). The machinery mints its entries from
  // one generator pair, the stderr instruction relays them verbatim, and only
  // that text is exempt: marker-anchored (no marker, no exemption) AND
  // text-anchored (an edited or paraphrased entry withholds — over-withholding
  // is the safe direction).
  const isRelayedStopEntry = (entry: string): boolean =>
    canonicalStopEntries?.has(entry.trim()) ?? false;
  const dimensionGapsAreDepthOnly = [
    ...unreviewed,
    ...splicedForBudgetPhrase,
  ].every((entry) => isNonDiffDimensionGap(entry) || isRelayedStopEntry(entry));

  const diagnosis = convergence
    ? diagnoseConvergence({
        // Clamped like every other public round surface in this function —
        // the ledger marker stamp and the deferred-posture clause both clamp
        // identically. An unclamped `+1` at the cap names round 10001 in the
        // posted prose beside a marker stamping 10000, with this round's own
        // findings stamped `R10000-*`.
        round: Math.min(prevRound + 1, LEDGER_MAX_ROUND),
        // The SAME count the marker and the VOLUME line carry, not a second
        // derivation of it.
        posted: postedInline,
        prev: convergence.prev,
        drafts: draftedFindingsOf(input.draftedComments),
        ...(convergence.floor === undefined
          ? {}
          : { floor: convergence.floor }),
        ...(convergence.criticalFloorKind === undefined
          ? {}
          : { criticalFloorKind: convergence.criticalFloorKind }),
        // Passed ONLY when this round established BOTH what it reviewed and
        // what blockers remain. `land-and-defer` rests on one inference —
        // "a Critical in the previous work list this round does not re-post
        // was fixed" — and every leg below is a state where that inference
        // is unsound, so the module's own "an absent count is not a count of
        // none" rule withholds the code.
        //
        // Named in ONE place because they were added one at a time over
        // three review rounds, and each addition left the previous rationale
        // describing a gate that no longer existed:
        //
        // - `anchorFailsClosed`: the round cannot certify the lines it read
        //   — unproven scope, a whiffed dimension, or any verdict cap other
        //   than an unreviewable one. Prior-round Criticals sitting in the
        //   territory nobody re-read are then "not re-posted" for a reason
        //   that is not "fixed". Read through the marker's OWN predicate so
        //   a leg added there cannot be forgotten here — and it already
        //   SUBSUMES the two blocker states this gate first listed
        //   separately: `cannot-tell-existing-critical` and
        //   `findings-unverified-at-compose` are both caps, and neither is
        //   `unreviewed-dimension`, so each fails the predicate on its own.
        //   Listing them again would be dead conjuncts that read as extra
        //   protection.
        // - a work list that is not COMPLETE: shed entries are unknown, so a
        //   Critical that fell out of the ledger is neither re-posted nor
        //   ruled on. The same flag the freshness rule already reads.
        // - a PURE-FOREIGN list (foreign, not merged over this account's
        //   own): this account's entries are in no work list at all, so its
        //   own open Criticals cannot be re-posted.
        //
        // Passed anyway, the body carries "no Critical is open" beside its
        // own disclosure of what it could not read, and the artifact tells a
        // machine consumer to merge.
        ...(!anchorFailsClosed(
          cappedBy,
          scopeUnproven,
          dimensionGapsAreDepthOnly,
        ) &&
        convergence.prev.complete === true &&
        !(convergence.prev.foreign === true && convergence.prev.merged !== true)
          ? { openCriticals }
          : {}),
      })
    : null;
  // A fact about the round, not about the diagnosis: it rides in the marker
  // whether or not a signal fired, because the NEXT round's trend needs this
  // round's point either way.
  const carriedIds = convergence
    ? new Set(
        convergence.prev.findings
          .map((f) => f?.id)
          .filter((id): id is string => typeof id === 'string'),
      )
    : undefined;
  const postedFresh =
    volumeOf(
      draftedFindingsOf(input.draftedComments).filter((d) =>
        isFreshDraft(
          d,
          Math.min(prevRound + 1, LEDGER_MAX_ROUND),
          carriedIds,
          convergence?.prev.complete === true,
        ),
      ).length,
    ) ?? 0;
  const convergenceNote = diagnosis
    ? renderConvergenceDiagnosis(diagnosis)
    : undefined;
  const recommendations = diagnosis ? recommendationsFor(diagnosis) : undefined;
  // The persistently-critical residual-risk signal (#9410): computed, never
  // decided. Computed HERE, beside the observation's own derivation, for two
  // reasons that now coincide. It counts every Critical this round stands
  // behind, and `bodyCriticals` is only complete once the relocated push and
  // the script-lint gate push have both joined it — the SAME array, with the
  // SAME semantics, the verdict's `c` counts below; a count taken before
  // them read a gate-only round (a standing deterministic [lint] blocker the
  // floor can never converge) as standing behind zero Criticals, so the
  // advisory the shape exists to surface never fired on it (#9526). And its
  // window runs on `postedFresh`, which is derived here. The persistence
  // half, the fresh pair, the recorded floor and the backlog all come off
  // the SAME recovered predecessor the loop-settling observation above
  // reads, so the two features cannot disagree about what a round held.
  // Advisory only: it cannot move the event or cap the verdict; it only
  // surfaces.
  //
  // Every input degrades open to "no assessment" WITH ONE EXCEPTION, stated
  // here because a blanket claim is the kind of false record this module
  // polices. Two facts are read off the predecessor's work-list by ABSENCE —
  // "no Suggestion in it, so the floor was enforcing" and "the backlog is
  // not shrinking" — and a list the marker's byte budget SHORTENED can only
  // lose entries, so both lean toward firing. The gate is not restored for
  // it (a whole-list requirement would silence the advisory on exactly the
  // deep-work-list rounds it exists for, which are the rounds that get
  // shortened); `prevTruncated` rides instead, and the paragraph discloses
  // that those two readings came off an incomplete list.
  // A PURE-FOREIGN work-list is a stranger's, not a shortened version of
  // this account's. Recovery adopts the highest-round marker whoever posted
  // it, and where that marker was NOT merged over this account's own
  // findings, this account's entries are in no work list at all — the same
  // state `openCriticals` above refuses to infer across, for the same
  // reason. Every prev-round fact this signal reads comes off that list, so
  // reading it there let a stranger's Criticals stand in for this account's:
  // an own round-6 marker that was a clean LGTM, a foreign same-round marker
  // carrying Criticals and no Suggestions winning recovery, and one Critical
  // drafted this round were enough to publish "Criticals stood in the
  // previous round's work-list and stand again this round —
  // land-with-residual-risk" over this account's own LGTM (#9526).
  //
  // Merged foreign lists are NOT withheld: the union keeps this account's
  // own certified entries under their own ids, which is exactly the part
  // that makes the list speak for this account again.
  const pureForeignPrev =
    convergence?.prev.foreign === true && convergence?.prev.merged !== true;
  const residualRisk = convergenceAssessment({
    // The persistence half, read straight off the recovered work list rather
    // than off a flag derived beside it: `prev.findings` is already gated on
    // the round (a round-0 work list is no work list) and already through the
    // ledger's own admission test, and a second derivation would be free to
    // drift from the list the observation clusters over. A list the marker's
    // byte budget truncated may have shed the very Critical that proves
    // persistence — that costs a missed advisory, which is the fail-safe
    // direction and the direction every other conjunct degrades in too.
    prevHadCritical:
      pureForeignPrev || !convergence
        ? undefined
        : convergence.prev.findings.some((f) => f.sev === 'C') || undefined,
    // The floor-engagement conjunct is computed by the SAME predicate the
    // enforcement backstop keys on (#9410): the advisory's "the floor will
    // not converge it" claim is provable only where the floor is actually
    // running, so a pre-engagement round degrades open to silence. The
    // ENFORCEMENT reading, not the reporting one beside it — the claim is
    // about Suggestions actually having been moved out of the posting set,
    // not about the posture the round describes itself as running. Taken
    // from the caller's one computation, signal trigger included (#9903):
    // re-derived here it would miss the early engagement, and the advisory
    // would claim the floor cannot converge a loop it is already stemming.
    floorEngaged:
      convergence?.floorEnforcementEngaged ??
      criticalFloorInEffect(
        input.severityFloor,
        input.contextUnavailable === true,
        prevRound,
      ),
    thisCriticals: criticalsInline + bodyCriticals.length,
    // The FRESH counts, not the posting totals — the number this file's own
    // `postedFresh` docstring calls "the number the convergence trend runs
    // on ... so the next round can compare like with like". Step 6 re-posts
    // every standing Critical under its original id, so the total only ever
    // rises: measured on totals a loop whose new findings fell 5 -> 4 still
    // posted MORE comments than the round before, and the advisory fired
    // "the severity floor will not converge it" over a converging loop.
    // The same pair the observation above trends on, so the two features
    // cannot disagree about what this round produced.
    fresh: postedFresh,
    prevFresh: convergence?.prev.fresh,
    // Off the same recovered predecessor — the marker records the floor its
    // round ran under, and the observation above compares the pair for
    // exactly this reason.
    prevFloor: convergence?.prev.floor,
    // The stamp above is the REPORTING reading and folds an absent floor to
    // `auto`, so it says `c` on a round >= 6 the enforcement backstop never
    // touched. A Suggestion still standing in that round's work-list is the
    // fact the stamp cannot carry: enforcement moves drafted Suggestions out
    // of the posting set before the marker is built, so its presence means
    // the floor was not running (#9526).
    prevPostedSuggestion:
      convergence && !pureForeignPrev
        ? convergence.prev.findings.some((f) => f.sev === 'S')
        : undefined,
    // The standing backlog, counted off the same recovered work-list the
    // persistence half reads. It is what keeps the fresh window honest at
    // its blind spot: a round finding nothing new while the author clears
    // blockers sits at fresh 0 against fresh 0, and only the Critical count
    // falling says the loop is moving.
    prevCriticals:
      convergence && !pureForeignPrev
        ? convergence.prev.findings.filter((f) => f.sev === 'C').length
        : undefined,
    // Not a conjunct — it decides nothing about whether the signal fires.
    // It is what lets the paragraph qualify the two readings it takes off
    // that list's ABSENCES ("no Suggestion, so the floor enforced"; "the
    // backlog is not shrinking"), which are the two inputs that lean toward
    // firing when the marker's byte budget shortened the list.
    prevTruncated:
      convergence && !pureForeignPrev ? convergence.prev.truncated : undefined,
  });

  let event: ReviewEvent = baseEvent;
  if (event === 'APPROVE' && cappedBy.length > 0) event = 'COMMENT';
  // The caps that reach a Request changes — because they remove the premise
  // the never-soften rule stands on. "A REQUEST_CHANGES earned by a
  // confirmed Critical is never softened" presumes CONFIRMED, and these
  // flags are precisely the statement that the confirmation is missing:
  // `criticalsUnverified` says no verifier ever ruled (the delivery floor),
  // `findingsUnverifiedAtCompose` says the findings file itself still
  // carries `— [unverified]` tags at compose time. The header's own
  // principle — an unverified finding must not become a public blocker (the
  // false "leaks tokens" Critical is the exact harm) — was mechanics for
  // the Approve row only, and a real bot review shipped through the gap: a
  // CHANGES_REQUESTED on an external contributor's PR (#7166) whose one
  // Critical the body itself disclosed as unverified. The findings still
  // post, disclosed; the review just may not BLOCK on a claim nobody
  // confirmed. Manipulation check: a run that wants an Approve gains
  // nothing here (the same flags cap Approve), and a run that wants to
  // block without verifying now cannot.
  // …unless a DETERMINISTIC Critical also rides the review: a `[build]`/
  // `[test]` finding is pre-confirmed, its Request changes is earned with or
  // without a verifier, and softening it alongside its unverified sibling
  // would un-block a confirmed build failure. The unverified ones stay
  // disclosed either way. The tag flag also needs a non-deterministic
  // Critical in the payload before it softens: when nothing posted owed a
  // verifier, a tag on an entry the report did not confirm blocks nothing.
  const deterministicBodyCriticals =
    bodyCriticals.length - nonDeterministicBodyCriticals;
  if (
    event === 'REQUEST_CHANGES' &&
    (criticalsUnverified ||
      (findingsUnverifiedAtCompose && criticalsNeedingVerify >= 1)) &&
    deterministicBodyCriticals === 0
  ) {
    event = 'COMMENT';
  }

  // Presubmit downgrades apply after the caps and only when the verdict they
  // name was the one on the table — `baseEvent` is the row before every cap,
  // so a softening cap that ran first cannot erase the presubmit's reasons.
  let downgraded = false;
  let downgradedFrom: 'Approve' | 'Request changes' | null = null;
  if (
    (event === 'APPROVE' || (baseEvent === 'APPROVE' && event === 'COMMENT')) &&
    downgradeApprove
  ) {
    event = 'COMMENT';
    downgraded = true;
    downgradedFrom = 'Approve';
  } else if (
    (event === 'REQUEST_CHANGES' ||
      (baseEvent === 'REQUEST_CHANGES' && event === 'COMMENT')) &&
    downgradeRequestChanges
  ) {
    // A softening cap moved the event first, but the presubmit
    // still ruled: without this arm its reasons (self-PR, failing CI) would
    // silently vanish from the body whenever both held. The verdict line
    // keeps the unverified sentence — the more fundamental defect — and the
    // body's downgrade clause carries the presubmit reasons.
    event = 'COMMENT';
    downgraded = true;
    downgradedFrom = 'Request changes';
  }

  // A zero-finding Approve over a non-trivial source diff is disclosed, not
  // capped. Every gate above proves the agents READ the diff; none proves the
  // review could tell good code from bad, and a dogfooded weak-model run
  // drafted nothing from all of its agents on a diff where stronger runs found
  // a verified blocker — then composed a bare confident Approve. The verdict
  // stands (nothing was found, and a cap would punish every genuinely clean
  // diff), but the verdict line must say which kind of Approve this is.
  // "Non-trivial" is measured in the plan's own risk metric (`srcDiffLines`,
  // the field the topology is chosen from), so a docs-only or typo-class diff
  // keeps its bare Approve — there, finding nothing is the expected outcome.
  let lowSignal: ComposeReviewResult['lowSignal'] = null;
  // A deferrals-only APPROVE is not low signal: the agents DID report
  // findings — this run recorded them as deferred — and the low-signal
  // sentence's whole claim is that none reported any.
  if (
    event === 'APPROVE' &&
    input.planPath &&
    deferredSuggestions.length === 0
  ) {
    let plan: RosterPlan | undefined;
    try {
      plan = JSON.parse(readFileSync(input.planPath, 'utf8')) as RosterPlan;
    } catch {
      // Unreadable plan, no disclosure — the coverage gate owns plan validity.
    }
    // A malformed repositoryContext inside an otherwise-readable plan is NOT
    // swallowed here: requiredAgents throws, fail-closed like every other
    // consumer of the field. On a real APPROVE the coverage gate already
    // validated it.
    if (plan) {
      const src = Number(plan.srcDiffLines ?? 0);
      if (src > LOW_SIGNAL_SRC_DIFF_LINES) {
        lowSignal = { agents: requiredAgents(plan).length, srcDiffLines: src };
      }
    }
  }

  // Every finding this review emits is anchored to a `file:line` inside the
  // current diff, so it can report where an approach leaks but never that a
  // different approach would retire all of the leaks at once. When a change
  // has taken many rounds AND grown several times over while doing so, that
  // limit is worth stating out loud to the human deciding what happens next —
  // otherwise the only reading available is "keep patching".
  //
  // Advisory by construction: it is not a finding (findings are what the
  // autofix loop consumes, which is the pattern this exists to interrupt), it
  // adds no cap, and it never moves the event.
  let approachSignal: ComposeReviewResult['approachSignal'] = null;
  // An APPROVE is convergence. Telling a converging PR to reconsider itself is
  // the loudest false positive available, and it would contradict the posture
  // that composes a deferrals-only late Approve on purpose.
  if (baseEvent !== 'APPROVE' && prevSrc0 > 0 && input.planPath) {
    // Same clamp as the ledger marker stamp and the deferred-suggestions
    // clause: a side file at the cap is representable and carries forward, so
    // an unclamped +1 would print a round the marker in the same body denies.
    const round = Math.min(prevRound + 1, LEDGER_MAX_ROUND);
    const rounds =
      operatorReviewSettings().approachRounds ?? APPROACH_ROUNDS_DEFAULT;
    if (round >= rounds) {
      let src = 0;
      try {
        const plan = JSON.parse(readFileSync(input.planPath, 'utf8')) as {
          srcDiffLines?: unknown;
          fullSrcDiffLines?: unknown;
          incremental?: { effective?: unknown };
        };
        src = Number(
          plan.fullSrcDiffLines ??
            (plan.incremental?.effective === true
              ? 0
              : (plan.srcDiffLines ?? 0)),
        );
      } catch {
        // Unreadable plan, no disclosure — same posture as `lowSignal`.
      }
      const growth = src / prevSrc0;
      // The absolute floor reuses the module's existing "non-trivial diff"
      // threshold: tripling a 12-line diff is not the shape this describes.
      if (
        Number.isFinite(src) &&
        src > LOW_SIGNAL_SRC_DIFF_LINES &&
        growth >= APPROACH_GROWTH_FACTOR
      ) {
        approachSignal = {
          round,
          src0: prevSrc0,
          srcDiffLines: src,
          growth,
          nonConverged: roundCapStopped,
        };
      }
    }
  }

  // Bilingual rendering: when the plan (fetch-pr's report) says the PR
  // description contains Han characters, the posted body carries the complete
  // Chinese version collapsed under the English one — the shape this repo's
  // own PR descriptions use, decided by the plan the CLI wrote, never by the
  // caller. When the plan does not record the signal but still names the PR,
  // the switch recovers it from the live description (see `bilingualFromPlan`).
  // Fragments with no deterministic translation (model-written findings, caller
  // echoes, error interpolations) ride verbatim in both halves. The footer
  // stays outside the fold, once. A `zh === en` body has nothing translated, so
  // no empty fold is published.
  const bilingual = bilingualFromPlan(input.planPath, input.prBodyFetcher);
  const assemble = (parts: Bi[], sep: string): string => {
    const en = parts.map((p) => p.en).join(sep);
    if (en === '') return '';
    const zh = parts.map((p) => p.zh).join(sep);
    const text =
      bilingual && zh !== en
        ? `${en}\n\n<details>\n<summary>中文说明</summary>\n\n${zh}\n\n</details>`
        : en;
    return footer === '' ? text : `${text}\n\n${footer}`;
  };

  // What the body may occupy: GitHub's limit, less the room a ledger marker
  // takes when one rides (it is appended after this composes) and a margin
  // for the trim notice itself.
  const bodyBudget =
    BODY_MAX_CHARS -
    BODY_SAFETY_MARGIN -
    (planNamesPr(input.planPath) ? MARKER_RESERVE : 0);

  /** What a rank drops, in the author's words — the note names it. */
  const RANK_NAMES: Record<number, { en: string; zh: string }> = {
    [-1]: { en: 'the mechanism-health note', zh: '机制健康说明' },
    0: {
      en: 'the persistently-critical convergence advisory',
      zh: 'persistently-critical 收敛建议',
    },
    1: { en: 'the deferred-findings list', zh: '延后发现清单' },
    2: {
      en: 'the not-reviewed and non-blocking disclosures',
      zh: '未审查范围与非阻断披露',
    },
    // Last, and see the block that carries it for why: it is the smallest
    // rank and the only one whose reader is the PR author alone.
    3: { en: 'the convergence observation', zh: '收敛情况观察' },
  };

  /**
   * The trim notice. It rides FIRST in the body, not last: the sentences it
   * corrects — "Partially reviewed — gaps disclosed", "They are listed
   * below", the deferral header — sit at the top, and a correction 60,000
   * characters below the claim it corrects is not a correction. It names
   * WHICH kinds went, so a reader can tell a trimmed disclosure from a
   * disclosure that never existed.
   */
  const trimNote = (ranks: number[], sections: number, cut: boolean): Bi => {
    const named = ranks.map((r) => RANK_NAMES[r]).filter(Boolean);
    const en = named.map((n) => n.en).join(' and ');
    const zh = named.map((n) => n.zh).join('与');
    // "Nothing blocking was trimmed" is true of the RANKS — all are
    // non-blocking by construction. It is not true of the tail cut below,
    // which can reach blocker text, so the claim is dropped exactly when a
    // cut happened and the truncation notice takes over the subject.
    const safe = cut
      ? {
          en: '',
          zh: '',
        }
      : {
          en: ' Nothing blocking was trimmed.',
          zh: '被裁剪的均非阻断内容。',
        };
    // The artifact pointer is about the deferral list, so it rides only when
    // that list is what went. Every other trim rank can drop alone — trim
    // rank 2 does on any run with disclosures and no posture deferrals, trim
    // rank 0 on a fired zero-deferral round — and the unconditional pointer
    // then sent the author to read a list that does not exist.
    const artifact = ranks.includes(1)
      ? {
          en: `, and deferred findings in this run's findings artifact`,
          zh: '，延后发现另见本次运行的 findings 工件',
        }
      : { en: '', zh: '' };
    return {
      keep: 1,
      en: `⚠️ This body was trimmed to fit GitHub's ${BODY_MAX_CHARS}-character review limit: ${en} did not fit (${sections} section(s)). Sentences below that refer to them still hold — read them in the terminal report${artifact.en}.${safe.en}`,
      zh: `⚠️ 为适配 GitHub ${BODY_MAX_CHARS} 字符的评审正文上限，本正文已裁剪：${zh}未能放入（共 ${sections} 个段落）。下方引用它们的句子依然成立——请在终端报告中查看${artifact.zh}。${safe.zh}`,
    };
  };

  /**
   * The body, within budget, and what that cost — recorded on `bodyTrim` so
   * the verdict line can turn with it instead of describing a body that no
   * longer exists.
   *
   * A POST over GitHub's limit is rejected whole, so an over-long body must
   * degrade, and the ORDER of the degradation is the policy: the bilingual
   * fold yields FIRST (it is a translation of the English above it, so it
   * costs the author nothing the body does not still say), then parts by
   * ascending `trim` rank (the mechanism-health note, then the residual-risk
   * advisory, then the deferral display, then the not-reviewed disclosures,
   * then the convergence observation), the blockers and the caps never, and
   * every drop is
   * disclosed with its count and its kind — a list silently shortened reads
   * as a list that was complete.
   *
   * The fold going first is what keeps the loss minimal: measured against a
   * bilingual body, a mild overflow spent the whole deferral list while
   * 24,000 characters of headroom sat behind a fold that says nothing new.
   */
  const bodyTrim = {
    sections: 0,
    deferralList: false,
    fold: false,
    truncated: false,
  };
  /**
   * Name what a trim dropped, and say where it can still be read.
   *
   * Every exit of `render` that dropped a rank owes this line — the
   * last-resort path drops ranks AND cuts, and a stderr record naming only
   * the cut leaves the kinds it dropped disclosed nowhere but the body.
   * Four of the five TRIM ranks keep a second durable copy, and the
   * ladder's order now follows that fact almost exactly: trim rank -1's
   * health note and trim rank 0's residual-risk advisory both ride the
   * composed result and print as `HEALTH:` and `RESIDUAL-RISK:`, trim rank
   * 1's deferrals are each a `D<round>-<n>` entry in the findings artifact,
   * and trim rank 3's observation rides the composed result too (and
   * prints as `CONVERGENCE:`) — it is last for the arithmetic its own block
   * explains, not for want of a copy. Trim rank 2 is the exception — a
   * trimmed disclosure section survives nowhere but the terminal summary,
   * so ask for it there rather than pointing at an artifact that does not
   * carry it.
   *
   * Which is why the tail clause keys on trim rank 2, the one rank with
   * nothing behind it. Keyed on the advisory instead it read "another copy
   * — the advisory also rides the composed JSON" over a combined drop that
   * took the disclosures with it, telling the operator the trimmed set was
   * backed up when the half of it that is NOT backed up was exactly the
   * half this sentence exists to rescue.
   */
  const noteTrimmedRanks = (droppedRanks: number[]): void => {
    if (droppedRanks.length === 0) return;
    remediation.push(
      `body budget: ${droppedRanks
        .map((r) => RANK_NAMES[r]?.en ?? `rank ${r}`)
        .join(' and ')} did not fit GitHub's ${BODY_MAX_CHARS}-character ` +
        `review limit and ${droppedRanks.length === 1 ? 'was' : 'were'} ` +
        `trimmed from the posted body — ` +
        (droppedRanks.includes(1)
          ? `the deferred findings are in the findings artifact; `
          : '') +
        `repeat the trimmed sections in your terminal summary` +
        (droppedRanks.includes(2)
          ? droppedRanks.length === 1
            ? `, which is their only other copy`
            : `, which is the only other copy of the disclosures among them`
          : // Deliberately unnamed here: the ONE place the artifact may be
            // named is the rank-1 clause above, which rides only when the
            // deferral list actually went. Naming it in this tail sent the
            // operator to a `D<round>-<n>` list that does not exist on a
            // rank-0-or-2-only drop — the same false record the clause
            // above was split out to refuse.
            `, though every section that went also has a durable copy elsewhere`),
    );
  };
  const render = (parts: Bi[], sep: string): string => {
    const full = assemble(parts, sep);
    if (full === '' || full.length <= bodyBudget) return full;
    const footerTail = footer === '' ? '' : `\n\n${footer}`;
    /** The English-only body: no fold, so nothing here is duplicated. */
    const enOnly = (ps: Bi[]): string =>
      `${ps.map((p) => p.en).join(sep)}${footerTail}`;
    // A monolingual body (attribution off, or a translation identical to its
    // English) has no fold to drop. Every rung below still measures the same
    // string — `enOnly` and `assemble` agree when there is no fold — but
    // nothing may CLAIM a translation was dropped, in the body or on stderr:
    // that is the false-record class this budget exists to refuse.
    const hadFold = full !== enOnly(parts);
    /**
     * What the body says about the fold it dropped — a notice at the TOP,
     * beside the trim notice and above the text it describes. Appended at
     * the bottom it was 64,000 characters below the body it qualifies, and
     * the skill's promise that every trim is disclosed at the top of the
     * body was false for this one.
     */
    const foldNote = (sections: number, cut: boolean): Bi[] =>
      !hadFold
        ? []
        : [
            {
              keep: 1,
              en:
                `⚠️ The Chinese translation of this body was dropped to fit ` +
                `GitHub's ${BODY_MAX_CHARS}-character review limit; the ` +
                `English text below is ${
                  cut
                    ? 'truncated as well — see the notice above'
                    : `complete${
                        sections > 0
                          ? ' apart from the sections the notice below names'
                          : ''
                      }`
                }.`,
              // Never rendered — this notice exists only on paths that have
              // already dropped the fold — but a `Bi` without it is a lie
              // about the shape, and the next edit would find no zh to keep.
              zh:
                `⚠️ 为适配 GitHub ${BODY_MAX_CHARS} 字符的评审正文上限，` +
                `本正文的中文翻译已被丢弃。`,
            },
          ];
    const noteFoldDropped = (sections: number, cut: boolean): void => {
      if (!hadFold) return;
      bodyTrim.fold = true;
      remediation.push(
        `body budget: the bilingual fold was dropped to fit GitHub's ` +
          `${BODY_MAX_CHARS}-character review limit — the English body is ` +
          (cut
            ? `truncated as well; read the complete text in the terminal report`
            : `complete${sections > 0 ? ' apart from the trimmed sections' : ''}`),
      );
    };

    // Rung 1 — the fold. It is a translation of text that survives above it,
    // so dropping it costs the author no content at all, where every rung
    // below costs a finding or a disclosure. With no fold, `foldOnly` IS the
    // body that just overflowed, so this rung cannot fire.
    const foldOnly = enOnly([...foldNote(0, false), ...parts]);
    if (hadFold && foldOnly.length <= bodyBudget) {
      noteFoldDropped(0, false);
      return foldOnly;
    }

    // Rung 2 — disclosure sections, by ascending trim rank, measured on the
    // body that has already lost its fold.
    const ranks = [
      ...new Set(
        parts
          .map((p) => p.trim)
          .filter((rank): rank is number => rank !== undefined),
      ),
    ].sort((a, b) => a - b);
    let survivors = parts;
    const droppedRanks: number[] = [];
    // Sections, not ranks: one rank can carry four `Not reviewed:`
    // paragraphs, and a note reading "(2 section(s))" over five dropped
    // ones is the same miscount the deferral line was fixed for.
    let droppedSections = 0;
    for (const rank of ranks) {
      const going = survivors.filter((p) => p.trim === rank).length;
      if (going === 0) continue;
      survivors = survivors.filter((p) => p.trim !== rank);
      droppedRanks.push(rank);
      droppedSections += going;
      const trimmed = enOnly([
        ...foldNote(droppedSections, false),
        trimNote(droppedRanks, droppedSections, false),
        ...survivors,
      ]);
      if (trimmed.length <= bodyBudget) {
        bodyTrim.sections = droppedSections;
        bodyTrim.deferralList = droppedRanks.includes(1);
        noteTrimmedRanks(droppedRanks);
        noteFoldDropped(droppedSections, false);
        return trimmed;
      }
    }
    bodyTrim.sections = droppedSections;
    bodyTrim.deferralList = droppedRanks.includes(1);
    // The fold is gone here too — this rung renders English only — but the
    // body it produces is CUT, so neither the notice nor the stderr line may
    // call the English text complete.
    noteFoldDropped(droppedSections, true);
    // Rung 3 — a real cut. What remains is un-trimmable by policy: the
    // blockers, the undecided blockers, the sentences that qualify the
    // verdict. Order it by `keep` so the cut spends prose the author already
    // has before it spends this round's only-copy blockers.
    //
    // The truncation notice rides at the TOP, with the fold and trim
    // notices — not after the cut. That placement is what makes this rung
    // bounded: a notice BELOW the cut has to survive whatever markdown or
    // raw HTML the cut left open, and deciding that means modelling the
    // page the author will read. Three hand models were tried and each
    // shipped a new class of divergence (fence parity, container nesting,
    // then the HTML5 swallow states) — an unbounded surface, re-reported as
    // one finding across five review rounds. Above the cut nothing can
    // swallow it, and the only thing an open construct can still absorb is
    // the footer's attribution line, which says nothing the review needs.
    // The ledger marker is read from raw text and never rendered, so it is
    // unaffected either way.
    const hardNote: Bi = {
      keep: 1,
      en:
        `⚠️ This review body was TRUNCATED to fit GitHub's ` +
        `${BODY_MAX_CHARS}-character review limit: the content that may not ` +
        `be trimmed does not fit the room this body has. Read the complete ` +
        `text in the terminal report and this run's findings artifact.`,
      // Never rendered — this rung composes English only.
      zh:
        `⚠️ 为适配 GitHub ${BODY_MAX_CHARS} 字符的评审正文上限，本正文已被截断。` +
        `完整内容见终端报告与本次运行的 findings 工件。`,
    };
    const head = [
      hardNote,
      ...foldNote(droppedSections, true),
      ...(droppedRanks.length > 0
        ? [trimNote(droppedRanks, droppedSections, true)]
        : []),
      ...survivors,
    ]
      .sort((a, b) => (a.keep ?? 3) - (b.keep ?? 3))
      .map((p) => p.en)
      .join(sep);
    // The tail is the footer, and it is a BOUNDED contributor: the footer
    // caps both its interpolations — `modelId` and the CLI version — at
    // `MODEL_ID_MAX_CHARS`, so this subtraction can never empty the cut.
    // It was unbounded once — caller text interpolated whole — and an
    // oversized name emptied the cut and posted tail-only, past the limit,
    // losing every blocker. The cap is where that is fixed;
    // repeating the defence here would be a branch for a state that can no
    // longer occur.
    let cut = head.slice(0, Math.max(0, bodyBudget - footerTail.length));
    // A loop, not one pass: the cut can only orphan a HIGH surrogate (it
    // takes a prefix, so no low half is ever separated from a high that
    // precedes it in the same string), but text the model quoted may
    // already carry unpaired highs of its own — `…x\uD800\u{20000}` cut
    // inside the pair leaves `…x\uD800\uD800`, and removing one still
    // posts a lone half. Text with an unpaired LOW is left as the author
    // wrote it: that half was already unpaired before this budget touched
    // anything.
    while (
      cut.length > 0 &&
      /[\uD800-\uDBFF]/.test(cut.charAt(cut.length - 1))
    ) {
      cut = cut.slice(0, -1);
    }

    bodyTrim.truncated = true;
    noteTrimmedRanks(droppedRanks);
    remediation.push(
      `body budget: read the complete blockers in the terminal report and the ` +
        `findings artifact — the un-trimmable content does not fit the room ` +
        `left by GitHub's ${BODY_MAX_CHARS}-character review limit, so the ` +
        `posted body is truncated`,
    );
    return `${cut}${footerTail}`;
  };

  // Clause 6 — scope nobody reviewed. Legal on COMMENT and (alongside body
  // Criticals) on REQUEST_CHANGES: the blocker must not squeeze out the
  // disclosure of what was never read.
  const notReviewedParts: Bi[] = [];
  if (missingReceipts.length > 0) {
    // One block for both channels, so an edit cannot touch the disclosure and
    // miss its repair (or vice versa) — the drift the rest of this file exists
    // to prevent.
    remediation.push(
      'chunks nobody read: build each with `"${QWEN_CODE_CLI:-qwen}" review ' +
        `agent-prompt --plan ${planRef} --chunk <id> [--rules <rules file>]\` — or ` +
        'the whole fan-out with `--roster` — and launch one agent per block, ' +
        'verbatim',
    );
    // Its own sentence, because its own cause. The clause below explains a gap
    // as a line too long to read, which is true of an *uncoverable* chunk and a
    // fabrication about one nobody receipted — the author would be told the diff
    // defeated the reader, when in fact no reader turned up.
    //
    // But a chunk whose disclosure entry already says WHY it went unread — its
    // launch never happened, or happened on a rewritten prompt — is one fact,
    // not two: "nobody read chunk 2" beside "chunk 2 — its prompt was built,
    // but no agent on record was launched with it" restates the consequence
    // next to its cause, and #7166's first post-grouping body carried
    // seventeen chunks twice exactly this way. The cap and the remediation
    // above keep the FULL list — only the posted sentence dedupes, and only
    // for subjects another sentence already explains.
    const disclosedSubjects = new Set(coverageEntries.map((e) => e.subject));
    const unexplainedReceipts = missingReceipts.filter(
      (id) => !disclosedSubjects.has(`chunk ${id}`),
    );
    if (unexplainedReceipts.length > 0) {
      const gap = describeChunkGap(unexplainedReceipts, plannedChunks);
      const pron = gap.plural ? 'them' : 'it';
      notReviewedParts.push({
        en: `Not reviewed: ${gap.phrase} — no agent reported covering ${pron}; nobody read ${pron}.`,
        zh: `未审查：${gap.phraseZh}——没有 agent 报告覆盖过这部分，也没有人读过它。`,
      });
    }
  }
  if (uncoverable.length > 0) {
    // The CLI's own entries are bare `chunk <id>` (pushed above, from the
    // report) and render through the same translation as every other chunk
    // gap; a caller's entry may already carry the file (`chunk 5
    // (src/big.min.js)`) and renders verbatim — its structure is not ours to
    // reparse.
    const bareIds: number[] = [];
    const callerNamed: string[] = [];
    for (const e of uncoverable) {
      const m = /^chunk (\d+)$/.exec(e);
      if (m) bareIds.push(Number(m[1]));
      else callerNamed.push(e);
    }
    const bareGap =
      bareIds.length > 0 ? describeChunkGap(bareIds, plannedChunks) : null;
    // Caller-named entries are prose the CLI does not control; comment
    // grammar goes inert like at every other verbatim exit.
    const callerShown = callerNamed.map((entry) => stripCommentGrammar(entry));
    const shown = [...(bareGap ? [bareGap.phrase] : []), ...callerShown];
    const shownZh = [...(bareGap ? [bareGap.phraseZh] : []), ...callerShown];
    notReviewedParts.push({
      en: `Not reviewed: ${shown.join(', ')} — a line there exceeds the read limit.`,
      zh: `未审查：${shownZh.join('、')}——其中有一行超出单次读取上限。`,
    });
  }
  // One disclosure per subject, one sentence per cause — structurally, not by
  // reparsing prose. The first cut recovered a subject/reason boundary from
  // the rendered text (the last ` — ` segment), and a reason is free-form:
  // an invariant label carries a dash for its file, an error interpolation
  // can carry anything, and a boundary guessed wrong regroups the entries it
  // garbles. Coverage now hands the entries over as `{subject, reason}`
  // pairs; only the CALLER\'s entries are prose, and those are never parsed —
  // they are matched against known coverage subjects by prefix (exactly how
  // the chunk list above dedupes), and rendered verbatim when nothing
  // matches. A run that pasted the gate\'s own gap lines into its input
  // posted every disclosure twice — 22 clauses for 11 roles on a public PR
  // (#7188) — and the coverage-derived text wins the collision: it is the
  // evidence-bounded register this body is written in.
  const covEntries = coverageEntries;
  const callerLeft: string[] = [];
  const seenCaller = new Set<string>();
  for (const d of unreviewed) {
    if (seenCaller.has(d)) continue; // a caller pasting itself twice
    seenCaller.add(d);
    // The budget-stop entry never prefix-matches: its relays are already
    // deduped by the marker phrase above, and letting its `reverse audit`
    // subject claim the prefix swallowed unrelated reverse-audit scopes the
    // caller disclosed with their own reasons (a bare subject echo still
    // dedups).
    const echoesCoverage = covEntries.some(
      (e) =>
        d === e.subject ||
        (e !== budgetEntry && d.startsWith(`${e.subject} — `)),
    );
    if (!echoesCoverage) callerLeft.push(d);
  }
  // Bare caller names share the whiffed-agent explanation; an entry that
  // brought its own reason (after an em-dash) is rendered verbatim, its own
  // line — unparsed, ungrouped, because its structure is not ours to guess.
  const whiffedDimensions = callerLeft.filter((d) => !d.includes(' — '));
  const explainedCaller = callerLeft.filter((d) => d.includes(' — '));
  if (whiffedDimensions.length > 0) {
    const whiffedShown = whiffedDimensions.map((d) => stripCommentGrammar(d));
    notReviewedParts.push({
      en: `Not reviewed: ${whiffedShown.join(', ')} — the agent returned no evidence of its walk twice.`,
      zh: `未审查：${whiffedShown.join('、')}——该 agent 连续两次未返回任何检查过程的证据。`,
    });
  }
  for (const d of explainedCaller) {
    // Caller prose, untranslatable by construction — quoted as-is in both,
    // its comment grammar inert.
    const disclosed = stripCommentGrammar(d);
    notReviewedParts.push({
      en: `Not reviewed: ${disclosed}.`,
      zh: `未审查：${disclosed}。`,
    });
  }
  // Budget-gap disclosures, one BOUNDED sentence for all of them. Four
  // review findings shaped this: each gap rides through `mdField` (inline
  // code neutralizes @-mentions, #123 cross-references, links and any
  // stray `</details>` an agent quoted — the first path by which raw
  // sub-agent prose could reach a public PR body); the line is capped like
  // its siblings (unbounded entries joined into one disclosure drown the
  // verdict they ride on — and ~50 uncapped agents would break GitHub's
  // 64 KB body limit and lose the whole POST); each gap carries its
  // agent's label so N agents stopping on the same trace stay tellable
  // apart; and a gap the caller already promoted into
  // `unreviewedDimensions` is dropped here — the capping relay owns it,
  // and the body must not say it twice in two registers. These are
  // "stopped at the budget", not "nobody looked": the phrasing must not
  // claim the stronger gap, and the entries do not join the capping lists.
  const budgetGapItems: Array<{ agent: string; gap: string }> = [];
  for (const g of budgetGapNotes) {
    for (const gap of g.gaps) budgetGapItems.push({ agent: g.agent, gap });
  }
  const keptBudgetGaps = budgetGapItems.filter(
    (it) => !unreviewed.some((d) => d.includes(it.gap)),
  );
  if (keptBudgetGaps.length > 0) {
    const shown = keptBudgetGaps.slice(0, MAX_BUDGET_GAP_LINES);
    const more = keptBudgetGaps.length - shown.length;
    const enList =
      shown
        .map(
          (it) =>
            `${publicAgentSubject(it.agent) ?? it.agent}: ${mdField(it.gap)}`,
        )
        .join('; ') + (more > 0 ? `, and ${more} more` : '');
    const zhList =
      shown
        .map(
          (it) =>
            `${publicAgentSubject(it.agent) ?? it.agent}：${mdField(it.gap)}`,
        )
        .join('；') + (more > 0 ? `，另有 ${more} 条` : '');
    notReviewedParts.push({
      en: `Not explored to full depth (tool budget reached): ${enList}.`,
      zh: `未探索到全部深度（达到工具调用预算）：${zhList}。`,
    });
  }
  // Same cause, one sentence: forty-three chunks launched with rewritten
  // prompts are one failure with forty-three subjects, not forty-three
  // paragraphs — a posted body on #7166 was ninety-nine clauses over four
  // causes, the six real findings buried beneath. Grouped by the reason
  // STRING, so a reason embedding per-subject detail (an unread brief\'s own
  // path) differs per entry and keeps its own line. One subject that appears
  // under two causes keeps the FIRST — the categories push in precision
  // order, and a chunk flagged `rewritten` is also, to the roster, a
  // requirement with no verbatim launch; repeating it under the later, vaguer
  // cause would tell the author "no agent was launched" about an agent that
  // demonstrably ran.
  const seenSubjects = new Set<string>();
  const byReason = new Map<
    string,
    Array<{ subject: string; publicSubject?: string; subjectZh?: string }>
  >();
  const reasonZhOf = new Map<string, string>();
  for (const e of covEntries) {
    if (seenSubjects.has(e.subject)) continue;
    seenSubjects.add(e.subject);
    // Keyed on the reason the body will PRINT — public over internal. Two
    // unread briefs differ internally only by their brief paths; grouped on
    // those, the path-free public sentence would render once per role, which
    // is the per-subject repetition this map exists to kill.
    const key = e.publicReason ?? e.reason;
    const group = byReason.get(key) ?? [];
    group.push({
      subject: e.subject,
      publicSubject: e.publicSubject,
      subjectZh: e.subjectZh,
    });
    byReason.set(key, group);
    // One printed reason, one translation: entries sharing the printed
    // English reason share the Chinese one by construction (both derive from
    // the same source string). Entries with none fall back to the English.
    if (e.reasonZh !== undefined && !reasonZhOf.has(key)) {
      reasonZhOf.set(key, e.reasonZh);
    }
  }
  for (const [reason, entries] of byReason) {
    // Chunk subjects leave in the author's units, not the run's. `chunk 28`
    // is bookkeeping — the id selects a rebuild command on stderr, and
    // nothing on the PR page maps it to code. #7268's posted body enumerated
    // all 49 of them, unsorted, across two of these sentences; the author's
    // units are their files and, at the limit, the diff itself, which is what
    // `describeChunkGap` renders. Role subjects ride their `publicSubject`
    // (`Brief.publicLabel`) — the codename stays on stderr, where it is the
    // selector — and the partition below keys on the INTERNAL subject, so a
    // public phrase can never shadow a chunk id out of the chunk collapse.
    const chunkIds: number[] = [];
    const named = new Map<string, { zh: string; count: number }>();
    for (const e of entries) {
      const m = /^chunk (\d+)$/.exec(e.subject);
      if (m) chunkIds.push(Number(m[1]));
      else {
        const subject = e.publicSubject ?? e.subject;
        const existing = named.get(subject);
        if (existing) existing.count++;
        else
          named.set(subject, {
            zh: e.subjectZh ?? subject,
            count: 1,
          });
      }
    }
    const gap =
      chunkIds.length > 0 ? describeChunkGap(chunkIds, plannedChunks) : null;
    const shown = [
      ...(gap ? [gap.phrase] : []),
      ...[...named].map(([subject, { count }]) =>
        count > 1 ? `${subject} (×${count})` : subject,
      ),
    ].map((part) => stripCommentGrammar(part));
    const shownZh = [
      ...(gap ? [gap.phraseZh] : []),
      ...[...named.values()].map(({ zh, count }) =>
        count > 1 ? `${zh}（×${count}）` : zh,
      ),
    ].map((part) => stripCommentGrammar(part));
    const reasonZh = reasonZhOf.get(reason) ?? reason;
    notReviewedParts.push({
      en: reason
        ? `Not reviewed: ${shown.join(', ')} — ${stripCommentGrammar(reason)}.`
        : `Not reviewed: ${shown.join(', ')}.`,
      zh: reason
        ? `未审查：${shownZh.join('、')}——${stripCommentGrammar(reasonZh)}。`
        : `未审查：${shownZh.join('、')}。`,
    });
  }

  // Clause 5 — blockers the review could neither confirm nor clear. They
  // survive every event shape: erasing one is how a review approves the
  // very thing it is asking about.
  const pr = prIdentityFromPlan(input.planPath);
  const cannotTellBlock: Bi[] =
    cannotTell.length === 0
      ? []
      : [
          // Deliberately untagged, so `keep` defaults to 3 and the
          // last-resort cut spends it first. That 3 is the CUT's axis, not a
          // `trim` rank — the two share the number and mean opposite things:
          // `trim: 3` is the LAST rank the ladder sheds, while `keep: 3` is
          // the FIRST thing the cut below the ladder spends.
          // These entries are open blockers the review could not
          // clear — and every one of them was DELIVERED to the author in
          // the round that raised it, where this round's body Criticals are
          // the only copy that exists. So when the cut has to choose, it
          // spends the copy the author can still scroll up to.
          //
          // Tagging it `keep: 2` (tied with the body Criticals, and earlier
          // in the parts array, so the stable sort protected it) inverted
          // that and made this round's blockers the first thing spent. What
          // was wrong in the shape that prompted the tag was the trim
          // notice claiming "Nothing blocking was trimmed" over a cut —
          // fixed where the claim is made, not by reordering the loss.
          formatCannotTell(cannotTell, pr, attribution),
        ];

  // Model-written blockers: quoted as-is in both halves. The marker is the
  // attributed template's severity signal; an unattributed post quotes the
  // blocker through the full fixpoint sanitation — no prefix, no forged
  // footer in any position (the body carries no canonical footer here, so
  // a surviving forged one would be the post's only attribution). "As-is"
  // stops at comment grammar either way: a literal `<!-- qwen-review-… -->`
  // in blocker prose would forge a second marker in the channel the
  // pipeline's own readers scan raw.
  const bodyCriticalBlock: Bi[] = bodyCriticals
    .map((l) =>
      stripCommentGrammar(
        attribution ? withMarker(l) : stripForUnattributedPost(l),
      ),
    )
    .map((l) => ({ keep: 2, en: l, zh: l }));

  // Confirmed-but-duplicate Suggestions — dropped from the payload by the
  // overlap rules (already on the PR), NOT by anchor failure. The verdict
  // counted them in `s`, so the body owes the author a truthful account of
  // where they went: reusing the discarded sentence's "could not be anchored"
  // claim posts a fact the resolver's output contradicts (#9204 —
  // resolve-anchors returned exact matches, the drop reason was duplication,
  // the posted body said anchoring failed). Its own paragraph: entries are a
  // list, not verdict prose. Rendered on every event — `s` counts them even
  // when `c` forces REQUEST_CHANGES.
  // Bounded like the deferral channel — same 65,536-char body limit, same
  // all-or-nothing post: entries are model-written with no upstream cap, so
  // one oversized entry here would lose the round's Criticals over this
  // disclosure paragraph. The count sentence keeps naming the total; an
  // overflow item names what the cap cut.
  const duplicatesShown = suggestionsDroppedAsDuplicates
    .slice(0, MAX_DEFERRED_SUGGESTION_LINES)
    .map((entry) => asListLine(boundDeferredLine(entry), pr));
  const duplicatesMore =
    suggestionsDroppedAsDuplicates.length - duplicatesShown.length;
  const duplicatesBlock: Bi[] =
    suggestionsDroppedAsDuplicates.length === 0
      ? []
      : [
          {
            en:
              `${suggestionsDroppedAsDuplicates.length} Suggestion-level ` +
              `finding(s) this review confirmed are already reported on this PR ` +
              `and are not repeated:\n\n` +
              duplicatesShown.map((line) => `- ${line}`).join('\n') +
              (duplicatesMore > 0
                ? `\n- …and ${duplicatesMore} more (see the run report)`
                : ''),
            zh:
              `本轮确认的 ${suggestionsDroppedAsDuplicates.length} 条建议级发现已在 PR ` +
              `上报告过，不再重复发布（列表见上方英文部分）。`,
          },
        ];

  const contextUnavailableClause: Bi = {
    keep: 1,
    en: 'Reviewed diff-only — the PR’s existing discussion could not be fetched, so this is not an approval and not a no-blockers claim.',
    zh: '仅审查了 diff——无法获取 PR 已有的讨论，因此这不构成批准，也不构成"无阻断问题"的结论。',
  };

  const disclosedChunkIds = new Set<number>();
  for (const e of coverageEntries) {
    const m = /^chunk (\d+)$/.exec(e.subject);
    if (m) disclosedChunkIds.add(Number(m[1]));
  }
  const nothingCertified =
    coverageEntries.some((e) => e.subject === 'coverage') ||
    (plannedChunks.length > 0 &&
      coveredChunks.every((id) => disclosedChunkIds.has(id)));
  const hasCoverageGaps =
    unreviewed.length + coverageEntries.length > 0 ||
    missingReceipts.length > 0 ||
    uncoverable.length > 0;
  const coverageOpener: Bi | undefined = nothingCertified
    ? {
        keep: 1,
        en: '⚠️ This run could not certify that any of this diff was reviewed.',
        zh: '⚠️ 本次运行无法证明这个 diff 的任何部分经过了审查。',
      }
    : hasCoverageGaps
      ? {
          keep: 1,
          en: 'Partially reviewed — gaps disclosed.',
          zh: '仅完成部分审查，审查缺口已披露。',
        }
      : undefined;

  // A deferred checker (actionlint's embedded shell): disclosed on EVERY verdict —
  // including Approve — so the reader knows a workflow's shell was not linted, but
  // it does not cap the verdict (it is a tool limitation, not a finding or an
  // unrun-checker gap). This is the "disclosed but not capping" half.
  const deferredBlock: Bi[] = gateDisclosed.length
    ? [
        {
          trim: 2,
          en: `Not linted (tool limitation, not a blocker): ${gateDisclosed.join('; ')}.`,
          zh: `未检查（工具限制，非阻断）：${gateDisclosed.join('; ')}。`,
        },
      ]
    : [];

  // The Test Plan's own claims, ruled against the reviewed tree. Rendered on
  // every verdict — including Approve, which is where most of them land — and
  // worded so the author can see it is about the description, not the code.
  const testPlanBlock: Bi[] = testPlanNotes.length
    ? [
        {
          trim: 2,
          en: `Test Plan (not a blocker): ${testPlanNotes.join('; ')}.`,
          zh: `Test Plan（非阻断）：${testPlanNotes.join('; ')}。`,
        },
      ]
    : [];

  // The findings file's own evidence that the loop ended with verification
  // outstanding — rendered on every event the cap binds, RC included (a
  // deterministic blocker beside a tagged entry keeps its Request changes
  // but not the silence about the tag).
  const unverifiedTagsBlock: Bi[] = !findingsUnverifiedAtCompose
    ? []
    : findingsFileUnreadable
      ? [
          {
            keep: 1,
            en: '⚠️ The reverse-audit findings file could not be read at compose time, so this run cannot show its findings were verified.',
            zh: '⚠️ 组合评审时无法读取反向审计发现文件，本次运行无法证明其发现已经过验证。',
          },
        ]
      : [
          {
            keep: 1,
            en: `⚠️ ${unverifiedTagCount} finding(s) still carried the \`— [unverified]\` tag when the loop ended — the verifier never ruled on them, and they are not confirmed.`,
            zh: `⚠️ 循环结束时仍有 ${unverifiedTagCount} 条发现带着 \`— [unverified]\` 标记——验证者从未对它们作出裁决，它们不算已确认。`,
          },
        ];

  const repositoryContextBlock: Bi[] = repositoryContextNotes.length
    ? [
        {
          trim: 2,
          en: `Repository proof boundary (not a blocker): ${repositoryContextNotes.join('; ')}.`,
          zh: `仓库验证边界（非阻断）：${repositoryContextNotes.join('; ')}。`,
        },
      ]
    : [];

  // Non-Critical findings the convergence posture deferred: disclosed on
  // EVERY event, never capping. The disclosure is the record the round
  // discipline demands — a deferral silently dropped is a finding lost, and
  // a deferral that capped would withhold the incremental anchor and
  // regenerate exactly the full-diff re-review the posture exists to end.
  // Entries are model-written: newlines collapse the way the cannot-tell
  // entries collapse, and the list is capped like the budget-gap lines — an
  // unbounded join would drown the verdict it rides on. The round number is
  // the same side-file read the ledger marker stamps (one read, passed in),
  // so the clause and the marker cannot disagree about which round deferred.
  // Both dimensions are bounded (module-scoped constants — verdictLine reads
  // the line cap too): entries are model-written with no upstream cap, and
  // twenty 4,000-char entries would put an ~80 KB block into a body GitHub
  // rejects outright at 65,536, losing the whole review over its own
  // footnote. 240 chars holds a `file:line — title` line with room to
  // spare; the findings artifact keeps every entry whole.
  const deferredShown = deferredSuggestions
    .slice(0, MAX_DEFERRED_SUGGESTION_LINES)
    .map(renderDeferredEntry)
    .map(boundDeferredLine);
  const deferredMore = deferredSuggestions.length - deferredShown.length;
  // Clamped exactly as the marker stamp is: `prevRound` can BE the cap
  // (parseLedger accepts round == LEDGER_MAX_ROUND), and an unclamped +1
  // here named a past-cap round beside a round-at-cap marker.
  const deferredRound = deferredSuggestions.length
    ? Math.min(prevRound + 1, LEDGER_MAX_ROUND)
    : 0;
  // The unlicensed-deferral disclosure precedes the list it disclaims: the
  // findings stay visible, but nothing may read the paragraph below as a
  // sanctioned deferral when the posture never licensed one.
  const unlicensedDeferralBlock: Bi[] =
    unlicensedDeferral === null
      ? []
      : [
          {
            keep: 1,
            en: `⚠️ ${deferredSuggestions.length} finding(s) were deferred without a posture licence — ${unlicensedDeferral}. They are listed in this body when it has room for them, and always in the terminal report and this run's findings artifact; this verdict is capped either way: findings may be under-posted this round.`,
            zh: `⚠️ ${deferredSuggestions.length} 条发现在姿态未授权的情况下被延后——${unlicensedDeferral}。正文空间允许时会列出清单，完整内容始终在终端报告与本次运行的 findings 工件中；无论如何本判定已被限制：本轮发现可能未被完整发布。`,
          },
        ];
  // The floor-enforcement disclosure rides INSIDE the deferral block so
  // every event branch that renders the list renders the sentence — a
  // reroute the body never mentions would make the posted record disagree
  // with the drafted set the orchestrator saw. Not a cap: the finding is
  // recorded two lines down; what changed is the posting surface, and the
  // policy that changed it is the operator's own floor.
  // One count basis end to end: every moved comment contributes exactly one
  // constructed entry to the list (no dedup — see the merge comment), so
  // the note's N, `floorEnforced.length`, and the entries this sentence
  // points at can never disagree. The "below" claim turns cap-aware the
  // moment the enforced entries themselves overflow the rendered line cap:
  // the enforced-first ordering guarantees the first
  // MAX_DEFERRED_SUGGESTION_LINES of them render, and past that the note
  // must say where the rest went rather than assert a list that truncated
  // them — the overflow identities survive in the run report, and a
  // universal "listed below" over an absent entry is a false record on
  // exactly the accuracy surface this disclosure exists for.
  const enforcedShown = Math.min(
    reroute.entries.length,
    MAX_DEFERRED_SUGGESTION_LINES,
  );
  const enforcedOverflow = reroute.entries.length - enforcedShown;
  // Why the floor engaged, when it engaged ahead of the round-6 schedule:
  // the signal-driven trigger (#9903) is the one posture change the round's
  // own prose never announced, so an unexplained critical floor at round 4
  // would read as a pipeline fault. Stated with the streak that armed it;
  // absent under every other kind, whose causes the operator either set
  // (explicit) or can derive from the round number (auto-resolved).
  const signalFloorNote =
    convergence?.criticalFloorKind === 'auto-signaled'
      ? {
          en: ` — the floor engaged early: the first-time-finding rate has not fallen for ${convergence.flatRounds ?? 0} consecutive round(s)`,
          zh: `——发布下限因首次发现速率连续 ${convergence.flatRounds ?? 0} 轮未下降而提前生效`,
        }
      : { en: '', zh: '' };
  const floorEnforcedNote: Bi[] =
    reroute.entries.length > 0
      ? [
          {
            en: `${reroute.entries.length} Suggestion(s) were drafted inline past the resolved critical posting floor${signalFloorNote.en}; the CLI moved them into the deferral list below (floor enforcement${enforcedOverflow > 0 ? ` — ${enforcedShown} listed, ${enforcedOverflow} more inside the overflow count` : ''}).`,
            zh: `${reroute.entries.length} 条 Suggestion 在已解析的 critical 发布下限之外被起草为行内评论${signalFloorNote.zh}；CLI 已将其移入下方延后清单（下限强制执行${enforcedOverflow > 0 ? `——列出 ${enforcedShown} 条，其余 ${enforcedOverflow} 条计入溢出计数` : ''}）。`,
          },
        ]
      : [];
  const deferredSuggestionsBlock: Bi[] = deferredSuggestions.length
    ? [
        ...floorEnforcedNote,
        {
          // Rank 1: the display of findings the review deliberately did NOT
          // request is the first CONTENT rank to yield when the body
          // overflows — only the operator-facing mechanism-health note
          // (rank -1) goes before it — and the artifact and the terminal
          // report keep every entry whole.
          trim: 1,
          // The marker is how later tooling (an agent collecting deferred
          // Suggestions across rounds) locates the block — the prose heading
          // alone is the only other anchor, and rewording it must not break
          // that lookup. It rides the SAME fragment so a budget trim drops
          // the pointer with the list it would point at. The blank line is
          // load-bearing: an HTML block swallowing the next line is the
          // CommonMark quirk the ack/fallback markers already document.
          en: `<!-- qwen-review-deferred -->\n\nDeferred under the convergence posture (round ${deferredRound}, not a blocker)${signalFloorNote.en} — recorded, not requested in this round:\n\n${deferredShown
            .map((entry) => `- ${mdField(entry)}`)
            .join(
              '\n',
            )}${deferredMore > 0 ? `\n- …and ${deferredMore} more (see the run report)` : ''}`,
          zh: `收敛姿态下延后（第 ${deferredRound} 轮，非阻断）${signalFloorNote.zh}——已记录，本轮不要求修改：共 ${deferredSuggestions.length} 条（原文未翻译，列表见上方英文部分）。`,
        },
      ]
    : [];

  // The persistently-critical residual-risk advisory (#9410): disclosed on
  // every event the shape can reach when the carried telemetry shows the
  // loop will not self-converge via the floor — the assessment only fires
  // when this round stands behind a Critical, which is REQUEST_CHANGES by
  // construction (or COMMENT when an unverified arm softens it), so those
  // two branches render the block and the composed-JSON field rides every
  // branch's return object. Non-capping and advisory-only — it never moves
  // the event, never caps, and its own text disclaims it ("does not
  // block"). Bounded by construction: fixed prose plus a count, no model
  // text, so it cannot balloon the body it rides.
  //
  // `trim: 0` — its OWN rank, and the slot the observation vacated when it
  // moved to last. The order here is by what a dropped block costs its
  // reader, and this one costs the least after the health note: the
  // maintainer it is written for receives it whole on the terminal
  // `RESIDUAL-RISK:` line AND in the composed JSON, which the persisted
  // artifact carries. The deferral list below it keeps one copy (the
  // findings artifact), the disclosures below that keep none but the
  // terminal report, and the observation last is the author's only sentence
  // about the shape of the loop. Sharing a rank with any of them is what
  // the trim notice cannot survive: it names what a rank drops, and rank
  // 1's findings-artifact pointer is true only of the deferral list — a
  // dropped advisory once posted a notice naming a deferral list that never
  // existed.
  const residualRiskBlock: Bi[] = residualRisk
    ? [
        {
          trim: 0,
          ...convergenceAdvisory(residualRisk),
        },
      ]
    : [];

  // The not-reviewed disclosures yield after the deferral display and before
  // the convergence observation: they say what the review could not certify,
  // which the verdict's own cap already carries, so trimming them costs
  // detail rather than the claim. (`notReviewedParts` itself stays untagged
  // — the length checks below ask about presence, not about rank.)
  const notReviewedForBody: Bi[] = notReviewedParts.map((p) => ({
    ...p,
    trim: 2,
  }));

  // The convergence observation: rendered on every event, capping nothing,
  // and only when a signal actually fired. It sits beside the other
  // disclosure paragraphs because it is addressed to the same reader — the
  // author deciding what to do next — and it is deliberately the only
  // paragraph here that comments on the SHAPE of the review history rather
  // than on the diff.
  //
  // `trim: 3` — the LAST rank the ladder sheds, and the reason is
  // arithmetic. Rendered bilingually this paragraph runs 603 characters when
  // only the volume signal fired, 1,510 with three clusters, and 2,372 with
  // the clusters, the evidence caveats and the land reading together —
  // against a body budget of 56,830. Shed second (it was trim rank 0, the
  // slot the residual-risk advisory holds now), it could
  // pay for at most 4% of an overflow, so any overflow larger than itself
  // spent it and then went on to spend the deferral list and the
  // not-reviewed disclosures anyway. On the rounds this fires on — the
  // high-volume ones — that is the normal case, not the edge: the author
  // lost the only sentence about the SHAPE of the loop and lost the
  // disclosures too.
  //
  // It is still ranked rather than untagged: if the body genuinely cannot
  // hold the blockers, an advisory must yield, and being ranked is what
  // makes the trim notice name it when it does. It is ranked LAST because
  // it is the cheapest block to keep and the only one whose reader is the
  // author of the pull request alone — the deferral list has a second
  // durable copy in the findings artifact, the disclosures are restated in
  // the terminal report, and the mechanism-health note above it is written
  // for the operator, who has the `HEALTH:` line. This paragraph is the
  // whole of what this pipeline tells a PR author about a loop that is not
  // settling; shedding it early bought almost nothing and cost exactly that.
  //
  // A rank of its own, not a share of the deferral list's: every notice
  // surface keys on the RANK, not on what actually went — the rank's name,
  // the artifact pointer, `bodyTrim.deferralList` — so sharing rank 1 made a
  // round that shed only this paragraph post a notice naming a
  // "deferred-findings list" that never existed and point the author at
  // artifact entries that do not exist. Its own rank names itself, carries
  // no artifact pointer, and leaves `deferralList` false.
  // Is the MECHANISM working? A pipeline that has stopped and one with
  // nothing to do are both silent, so the round says what it can see about
  // its own machinery. Computed here, after the caps are final: the anchor
  // decision reads `dimensionGapsAreDepthOnly`, which is computed after the
  // caps and after the event demotion. (`cappedBy` itself is complete far
  // above this point — every push site sits with the cap block. A later cap
  // added below the demotion would keep an APPROVE that must be capped, so
  // this comment does not license one.)
  const healthNote = convergence
    ? renderMechanismHealth({
        // Nominally engaged, mechanically not: the floor resolved to
        // critical and Suggestion-level findings posted inline anyway.
        // The REPORTING reading resolved the floor to critical, the
        // enforcement backstop did not, AND a Suggestion posted inline
        // because of it. All three, because the sentence asserts all three.
        //
        // The first two hold on EVERY default-config round from 6 on — the
        // readings differ only in folding an absent floor to `auto` — so
        // stopping there accused a Criticals-only round, and an APPROVE
        // round, of a manifestation that had not happened. The gap without
        // a consequence is not a malfunction anyone can act on; the gap
        // WITH one is.
        //
        // The count EXCLUDES deterministic findings, through the same
        // projection `floorEnforcedReroute` reads. Arguing that the code-side
        // reroute never ran (so nothing inline can be ITS carve-out) is true
        // and beside the point: when the enforcement reading is false the
        // model-side posture is the layer in charge, and SKILL Step 6 carries
        // the same carve-out — a `[build]`/`[test]`/`[probe]` finding is
        // pre-confirmed and stays inline at any floor. A fully compliant
        // round that defers every deferrable Suggestion and posts one
        // `[test]` finding would otherwise be accused of a failure that is
        // the posture working as specified.
        postureNotEngaging:
          convergence.criticalFloorKind !== undefined &&
          convergence.floorEnforcementEngaged === false &&
          deferrableSuggestionsInline(input.draftedComments) > 0,
        // Two consecutive withholds — this round's decision read through the
        // marker's OWN predicate, and the recovered round's recorded anchor.
        anchorChainBroken:
          !convergence.prev.anchored &&
          (convergence.prev.round ?? 0) > 0 &&
          anchorFailsClosed(cappedBy, scopeUnproven, dimensionGapsAreDepthOnly),
      })
    : null;
  // Its OWN rank, shed before every other. Sharing the convergence
  // paragraph's rank made the notice name "the convergence observation" for
  // a body whose content at that rank was only this note — a section that
  // never existed. It goes first
  // because its primary reader is the operator, who has the `HEALTH:`
  // terminal line, while the convergence paragraph's recommendations are
  // addressed to the author reading the PR.
  const healthBlock: Bi[] = healthNote ? [{ ...healthNote, trim: -1 }] : [];
  const convergenceBlock: Bi[] = convergenceNote
    ? [{ ...convergenceNote, trim: 3 }]
    : [];

  // The resumed-run continuity note: the run reused certified work from an
  // interrupted earlier attempt. Disclosed on every verdict — Approve
  // included — and never capping: the recovered agents were re-certified
  // from the harness records and COUNT as reviewed.
  const continuityBlock: Bi[] = recoveredFromPriorAttempt
    ? [
        {
          en: `Resumed run (not a gap): ${recoveredFromPriorAttempt} agent result(s) from the interrupted earlier attempt were re-certified from the harness records and counted as reviewed.`,
          zh: `续跑运行（非缺口）：复用了被中断的前一次尝试的 ${recoveredFromPriorAttempt} 个 agent 结果，均已按 harness 记录重新认证并计入审查。`,
        },
      ]
    : [];

  // Addressed to the human deciding what happens next, not to the model that
  // will fix the findings — which is why it is a body paragraph and not a
  // finding. Built from `approachSignal` rather than re-evaluating the
  // predicate, so the paragraph and the verdict-line clause cannot disagree.
  const approachBlock: Bi[] = approachSignal
    ? [
        {
          en:
            `⚠️ Round ${approachSignal.round}, and the diff has grown ` +
            `${approachSignal.growth.toFixed(1)}x since this review first measured it ` +
            `(${approachSignal.src0} → ${approachSignal.srcDiffLines} source diff lines)` +
            (approachSignal.nonConverged
              ? '; the reverse audit also stopped at its round cap without converging'
              : '') +
            `. The findings below are anchored to the current patch, so they can only say ` +
            `where this approach leaks — never that a different approach would retire all ` +
            `of them at once. Before fixing them, a human should decide whether the shape ` +
            `of the change is still right. Advisory only: this does not affect the verdict, ` +
            `and nothing here is a blocker.`,
          zh:
            `⚠️ 第 ${approachSignal.round} 轮，且自本审查首次测量以来 diff 已增长 ` +
            `${approachSignal.growth.toFixed(1)} 倍（源码 diff 行数 ` +
            `${approachSignal.src0} → ${approachSignal.srcDiffLines}）` +
            (approachSignal.nonConverged
              ? '；反向审计也在轮数上限处停止且未收敛'
              : '') +
            `。下方的发现都锚定在当前这版补丁上，因此它们只能指出这个方案在哪里漏了，` +
            `而无法说明换一个方案就能一次性消除全部问题。在动手修复之前，应由人来判断这次` +
            `改动的整体形态是否仍然正确。仅供参考：本段不影响判定结论，其中也没有任何阻断项。`,
        },
      ]
    : [];

  if (event === 'REQUEST_CHANGES') {
    // Empty body, except the disclosures: every clause whose state holds
    // appears on every event — a confirmed blocker must not squeeze out the
    // trust warning (clause 2), an undecided existing Critical (clause 5),
    // or the unread-scope disclosure (clause 6).
    const parts = [
      ...(coverageOpener ? [coverageOpener] : []),
      ...(contextUnavailable ? [contextUnavailableClause] : []),
      ...approachBlock,
      ...duplicatesBlock,
      ...cannotTellBlock,
      ...notReviewedForBody,
      ...unverifiedTagsBlock,
      ...deferredBlock,
      ...testPlanBlock,
      ...repositoryContextBlock,
      ...unlicensedDeferralBlock,
      ...deferredSuggestionsBlock,
      ...convergenceBlock,
      ...healthBlock,
      ...residualRiskBlock,
      ...continuityBlock,
      ...bodyCriticalBlock,
    ];
    // The body composes first: `render` settles `bodyTrim`, and the fields
    // below report what it cost.
    const body = render(parts, '\n\n');
    return {
      event,
      body,
      baseEvent,
      cappedBy,
      downgraded,
      downgradedFrom,
      remediation,
      deferredCount: deferredSuggestions.length,
      floorEnforced: reroute.indices,
      postedInline,
      postedFresh,
      ...(convergenceNote === undefined
        ? {}
        : { convergence: convergenceNote }),
      ...(recommendations === undefined ? {} : { recommendations }),
      ...(healthNote === null || healthNote === undefined
        ? {}
        : { health: healthNote }),
      bodyTrim,
      lowSignal,
      scopeUnproven,
      dimensionGapsAreDepthOnly,
      approachSignal,
      ...(residualRisk ? { residualRisk } : {}),
    };
  }

  if (event === 'APPROVE') {
    // `notReviewedParts` here is exactly the budget-gap disclosures: every
    // other source of a not-reviewed entry also caps, and a capped run never
    // reaches this branch. They render on the Approve because they are a
    // disclosure, not a defect — hiding "stopped at the tool budget" behind
    // an unqualified LGTM would break the one promise the disclosure channel
    // makes, that it reaches the author mechanically.
    // With posture-deferred Suggestions on record, "No issues found" would be
    // a lie the deferral list two lines down contradicts: the review DID find
    // them — it recorded them and chose, per the posture, not to request them.
    const body = render(
      [
        deferredSuggestionsBlock.length
          ? {
              keep: 1,
              en: 'No blocking issues. LGTM! ✅',
              zh: '无阻断问题。LGTM！✅',
            }
          : {
              keep: 1,
              en: 'No issues found. LGTM! ✅',
              zh: '未发现问题。LGTM！✅',
            },
        ...notReviewedForBody,
        ...deferredBlock,
        ...testPlanBlock,
        ...repositoryContextBlock,
        ...unlicensedDeferralBlock,
        ...deferredSuggestionsBlock,
        // Both of these are spread for symmetry with the branches above and
        // cannot actually fire here — the same shape as the convergence
        // invariant this branch already carries. The posture half needs a
        // Suggestion to have posted, which makes the event COMMENT; the
        // anchor half needs a fail-closed scope, which caps the verdict off
        // this branch. Verified by probe (event APPROVE, health block
        // empty). Kept rather than dropped so a later reader adding a check
        // that CAN fire here does not have to rediscover the wiring — and
        // spread ONCE: a second spread printed the clause twice on any round
        // that did reach it.
        ...convergenceBlock,
        ...healthBlock,
        ...continuityBlock,
      ],
      notReviewedParts.length ||
        deferredBlock.length ||
        testPlanBlock.length ||
        repositoryContextBlock.length ||
        deferredSuggestionsBlock.length ||
        // Unreachable today and kept deliberately: an APPROVE is composed
        // from zero findings, which means zero posted comments and zero
        // drafted paths, so neither convergence signal can fire on this
        // branch. It is listed anyway because the separator's job is to
        // know about every block the branch renders — a condition that is
        // right only because another rule makes its input impossible is a
        // trap for whoever changes that other rule.
        convergenceBlock.length ||
        healthBlock.length ||
        continuityBlock.length
        ? '\n\n'
        : ' ',
    );
    return {
      event,
      body,
      baseEvent,
      cappedBy,
      downgraded,
      downgradedFrom,
      remediation,
      deferredCount: deferredSuggestions.length,
      floorEnforced: reroute.indices,
      postedInline,
      postedFresh,
      ...(convergenceNote === undefined
        ? {}
        : { convergence: convergenceNote }),
      ...(recommendations === undefined ? {} : { recommendations }),
      ...(healthNote === null || healthNote === undefined
        ? {}
        : { health: healthNote }),
      bodyTrim,
      lowSignal,
      scopeUnproven,
      dimensionGapsAreDepthOnly,
      approachSignal,
      ...(residualRisk ? { residualRisk } : {}),
    };
  }

  // COMMENT: ordered clause composition — each clause present iff its
  // condition holds, nothing else.
  const clauses: Bi[] = [];

  // 1. Downgrade sentence (only when a presubmit flag changed the event).
  if (downgraded && downgradedFrom) {
    const reasons = downgradeReasons.join('; ');
    const fromZh = downgradedFrom === 'Approve' ? '批准' : '请求修改';
    clauses.push({
      keep: 1,
      en: `⚠️ Downgraded from ${downgradedFrom} to Comment${reasons ? `: ${reasons}` : ''}.`,
      zh: `⚠️ 已从${fromZh}降级为评论${reasons ? `：${reasons}` : ''}。`,
    });
  }

  // 2. Context-unavailable clause — no later clause may certify "no blockers".
  if (contextUnavailable) {
    if (coverageOpener) clauses.push(coverageOpener);
    clauses.push(contextUnavailableClause);
  } else {
    // 3. Opener — certifying only when the review can actually certify it.
    // Certification is keyed to whether presubmit PERMITS it, not to
    // whether presubmit changed the event: a Suggestion-only review is
    // already COMMENT, so failing CI or a self-PR flips no event — but a
    // body that certifies "no blockers" over failing CI, or a self-review
    // certifying its own PR, misstates authority all the same.
    const canCertify =
      !downgraded &&
      !downgradeApprove &&
      !downgradeRequestChanges &&
      c === 0 &&
      cannotTell.length === 0 &&
      !hasCoverageGaps &&
      // A missing receipt caps the event but was left out of certification, so a
      // body could open "Reviewed — no blockers." two lines above "nobody read
      // them." Nothing nobody read can be certified blocker-free — and neither
      // can a loop that ended with findings no verifier ever ruled on.
      // A disclosed budget gap is not a blocker, but "Reviewed — no
      // blockers." two lines above "Not explored to full depth" is the
      // opener certifying what the disclosure takes back — the exact
      // shape the comment below forbids. (A gap the caller promoted into
      // `unreviewedDimensions` already denies certification above.)
      keptBudgetGaps.length === 0 &&
      // An unlicensed deferral withdrew findings from posting without a
      // licence — "no blockers" cannot open a body whose own ⚠️ clause says
      // findings may be under-posted.
      unlicensedDeferral === null &&
      !findingsUnverifiedAtCompose;
    // The opener may not say "Reviewed." over a disclosure set that denies it.
    // #7268's posted body opened exactly that way — "Reviewed. Suggestions are
    // inline." above two sentences disclosing all 49 chunks — and the author's
    // first sentence certified the thing every following one took back. A
    // chunk counts as certified only when an agent read it AND no disclosure
    // names it: the rewritten launches on that run had demonstrably read their
    // chunks, which is why `coveredChunks` alone is not the test. The
    // `coverage` subject is the no-plan/unreadable-transcripts family — there
    // is no chunk universe to count, and what cannot be counted cannot be
    // certified.
    // Any opener starting with "Reviewed" reads as contradicting the
    // "Not reviewed:" clauses below it — announcing the gaps does not fix
    // it, as the first cut of this wording showed (#8811). When disclosures
    // follow, the opener says the review is PARTIAL instead, so the pair
    // reads in one direction; the certifying and the zero-certified openers
    // above keep their exact wording.
    // Every one of these is a sentence that qualifies the verdict, so each
    // carries `keep: 1`. The COMMENT path merges this clause into one
    // paragraph with its neighbours and takes the strongest tag among them —
    // untagged, a merge of only these defaulted to the weakest, and the tail
    // cut spent "Review incomplete — unverified findings disclosed." before
    // it spent a single blocker.
    clauses.push(
      coverageOpener ??
        (canCertify
          ? {
              keep: 1,
              en: 'Reviewed — no blockers.',
              zh: '已审查——无阻断问题。',
            }
          : findingsFileUnreadable
            ? {
                keep: 1,
                en: 'Review incomplete — findings unavailable.',
                zh: '审查未完成——发现不可用。',
              }
            : findingsUnverifiedAtCompose
              ? {
                  keep: 1,
                  en: 'Review incomplete — unverified findings disclosed.',
                  zh: '审查未完成——未验证的发现已披露。',
                }
              : { keep: 1, en: 'Reviewed.', zh: '已审查。' }),
    );
  }

  // 4. Suggestions clause — keyed off the POSTED count, not `s`: an
  //    all-discarded run has nothing inline, and claiming otherwise while
  //    the discarded sentence says the opposite is the round-6 collision
  //    this module exists to kill. (`s` stays right for the event — see
  //    above.)
  if (suggestionsInline > 0) {
    clauses.push({
      keep: 1,
      en: 'Suggestions are inline.',
      zh: '建议见行内评论。',
    });
  }
  if (suggestionsDiscarded > 0) {
    // Self-contained: this lands in the posted body, and "see the terminal
    // output" pointed the PR author at a terminal only the operator has —
    // eight hours of real bot reviews carried that dead reference on five
    // different pull requests.
    clauses.push({
      keep: 1,
      en:
        `${suggestionsDiscarded} Suggestion-level finding(s) could not be ` +
        `anchored to a changed line and were dropped; nothing further to act ` +
        `on here.`,
      zh:
        `${suggestionsDiscarded} 条建议级发现无法锚定到改动行，已丢弃；` +
        `此处无需进一步处理。`,
    });
  }

  // Clauses 1–4 are the verdict: short sentences that read as one opener
  // paragraph. Everything after — unresolved Criticals, disclosures, body
  // blockers — gets a paragraph of its own: #8388's posted body joined all
  // of it with spaces, 31 unresolved entries and seven disclosures in a
  // single unreadable wall.
  const openerCount = clauses.length;

  // 4-. Approach signal — pushed FIRST after the opener count so it becomes a
  //     standalone paragraph rather than being swallowed into the opener's
  //     space-joined run. It is the one clause addressed to a human rather
  //     than to the next round's work list, so it reads before the findings.
  clauses.push(...approachBlock);

  // 4a. Duplicate-dropped Suggestions — built above with the other body
  //     blocks; it renders on every event, RC included.
  clauses.push(...duplicatesBlock);

  // 5. Unresolved existing Criticals.
  clauses.push(...cannotTellBlock);

  // 6. Not-reviewed disclosure.
  clauses.push(...notReviewedForBody);

  // 6a. Verification outstanding at loop end — the findings file's surviving
  //     `— [unverified]` tags, machine-read.
  clauses.push(...unverifiedTagsBlock);

  // 6b. Deferred-checker disclosure (non-capping) — a workflow whose embedded
  //     shell actionlint would lint but we do not yet trust.
  clauses.push(...deferredBlock);

  // 6c. Test Plan rulings (non-capping) — a claim in the PR description that
  //     the reviewed tree does not bear out.
  clauses.push(...testPlanBlock);

  // 6d. Repository proof boundaries (non-capping) — dimensions the context
  //     planner recommends disclosing without claiming the code is defective.
  clauses.push(...repositoryContextBlock);

  // 6e. Convergence-posture deferrals — the licence disclosure (capping)
  //     precedes the list (non-capping).
  clauses.push(...unlicensedDeferralBlock);
  clauses.push(...deferredSuggestionsBlock);

  // 6f. Convergence observation (non-capping) — is this loop settling, and if
  //     not, what shape is it. About the review HISTORY, not the diff.
  clauses.push(...convergenceBlock);
  clauses.push(...healthBlock);

  // 6g. Persistently-critical residual-risk advisory (non-capping, advisory
  //     only) — the exit for a loop the observation above has run out of
  //     postures to suggest. It follows the observation because it answers
  //     the question the observation leaves open.
  clauses.push(...residualRiskBlock);

  // 6h. Resumed-run continuity (non-capping) — reused work that COUNTS as
  //     reviewed, disclosed so the author knows two attempts fed this verdict.
  clauses.push(...continuityBlock);

  // 7. Body Criticals — on a COMMENT that stands where a REQUEST_CHANGES
  //    would have been. The body copy is the ONLY copy of an unanchorable
  //    blocker, and softening the event must never erase it.
  //
  //    DERIVED, not enumerated. The condition was a list of the two
  //    softening flags known when it was written — the presubmit carve-out
  //    and `criticalsUnverified` — and a third path shipped past it: the
  //    findings-file `— [unverified]` tag softens a Request changes at the
  //    event line above while setting NEITHER flag, so a run whose coverage
  //    was proven posted a 239-character body carrying the opener and the
  //    tag disclosure and no blocker at all. `baseEvent` is the row before
  //    every cap and downgrade, so this comparison asks the question the
  //    clause is actually about, and answers it for softening paths that do
  //    not exist yet.
  if (baseEvent === 'REQUEST_CHANGES' && event === 'COMMENT') {
    clauses.push(...bodyCriticalBlock);
  }

  const openerParts = clauses.slice(0, openerCount);
  const paragraphs: Bi[] = [
    ...(openerParts.length > 0
      ? [
          {
            // The merge is a rendering detail; it must not launder away the
            // retention the merged clauses carry. Take the strongest (the
            // lowest `keep`) — a downgrade disclosure merged into an opener
            // is still a sentence that qualifies the verdict, and defaulting
            // it to 3 made it the FIRST thing the tail cut spent. No `trim`
            // rank rides here: an opener clause never carries one, and
            // inheriting one would drop untagged text with it.
            keep: openerParts.reduce(
              (lowest, c) => Math.min(lowest, c.keep ?? 3),
              3,
            ),
            en: openerParts.map((c) => c.en).join(' '),
            zh: openerParts.map((c) => c.zh).join(' '),
          },
        ]
      : []),
    ...clauses.slice(openerCount),
  ];
  const body = render(paragraphs, '\n\n');
  return {
    event,
    body,
    baseEvent,
    cappedBy,
    downgraded,
    downgradedFrom,
    remediation,
    deferredCount: deferredSuggestions.length,
    floorEnforced: reroute.indices,
    postedInline,
    postedFresh,
    ...(convergenceNote === undefined ? {} : { convergence: convergenceNote }),
    ...(recommendations === undefined ? {} : { recommendations }),
    ...(healthNote === null || healthNote === undefined
      ? {}
      : { health: healthNote }),
    bodyTrim,
    lowSignal,
    scopeUnproven,
    dimensionGapsAreDepthOnly,
    approachSignal,
    ...(residualRisk ? { residualRisk } : {}),
  };
}

/**
 * The public subject for an agent-derived disclosure label. A `chunk N`
 * label stays bare — the chunk collapse translates it into the author's
 * units. Any other label is usually a parsed codename (`agent security`,
 * `agent reverse-audit (round 2)` — coverage's `label()` prefers the
 * identity line), falling back to the truncated first line of a launch
 * prompt: prose. The quoting serves both: prose rendered bare reads as a
 * claim about the PR itself — #8811's posted body carried "Not reviewed:
 * This PR narrows the daemon-marker check from a truthy tes..." — and
 * quoted, either shape reads as a name. Short codename labels pass
 * `compressSummary`'s cap untouched. The INTERNAL subject stays the
 * unquoted label: the dedup and certification checks key on it.
 */
function publicAgentSubject(label: string): string | undefined {
  return /^chunk \d+$/.test(label)
    ? undefined
    : mdField(JSON.stringify(compressSummary(label.replace(/[`\r\n]+/g, ' '))));
}

/**
 * A set of unreviewed chunk ids, said in the PR author's units.
 *
 * `chunk 28` is the run's own bookkeeping: the id selects a rebuild command
 * on stderr, and nothing on the PR page maps it to code. #7268's posted body
 * was two sentences enumerating all 49 of them — unsorted, because the first
 * group rode transcript order — and the one fact they carried (nothing was
 * certified) is the opener's job, not an enumeration's. The author's units
 * are their files and, at the limit, the diff itself, so the ids collapse to
 * whichever of those fits:
 *
 * - every planned chunk → `the entire diff`;
 * - a gap whose files are known and few → the files, named;
 * - anything wider (or a plan whose chunks carry no files) → a count against
 *   the plan's total.
 *
 * The ids never render. They stay in the structural entries — the caps, the
 * caller-echo dedup and the certification test all key on `chunk <id>` — and
 * in the stderr remediation, where the id is the selector a reader can act
 * on. `plural` is the phrase's grammatical number, for the one caller whose
 * sentence carries a pronoun; `phraseZh` is the same phrase for the Chinese
 * half of a bilingual body.
 */
export function describeChunkGap(
  ids: readonly number[],
  planned: ReadonlyArray<{ id: number; files: string[] }>,
): { phrase: string; phraseZh: string; plural: boolean } {
  const uniq = [...new Set(ids)].sort((a, b) => a - b);
  const inGap = new Set(uniq);
  if (planned.length > 0 && planned.every((p) => inGap.has(p.id))) {
    return { phrase: 'the entire diff', phraseZh: '整个 diff', plural: false };
  }
  // The union of the gap's files, in plan order. One unknown chunk poisons
  // the list: naming three files over a gap that also covers a fourth,
  // unnameable one would tell the author the rest of their diff was read.
  const byId = new Map(planned.map((p) => [p.id, p.files]));
  const files: string[] = [];
  let allKnown = planned.length > 0;
  for (const id of uniq) {
    const f = byId.get(id) ?? [];
    if (f.length === 0) allKnown = false;
    for (const p of f) {
      if (!files.includes(p)) files.push(p);
    }
  }
  if (allKnown && files.length <= 4) {
    // Filenames are PR-controlled — git permits `<!--` in a path — so they
    // ride mdField like every other body surface rendering one.
    const named = files.map((f) => mdField(f));
    return {
      phrase: `the diff ${uniq.length === 1 ? 'section' : 'sections'} covering ${named.join(', ')}`,
      phraseZh: `涉及 ${named.join('、')} 的 diff 片段`,
      plural: uniq.length > 1,
    };
  }
  return {
    phrase:
      planned.length > 0
        ? `${uniq.length} of the diff's ${planned.length} sections`
        : `${uniq.length} ${uniq.length === 1 ? 'section' : 'sections'} of the diff`,
    phraseZh:
      planned.length > 0
        ? `diff ${planned.length} 个片段中的 ${uniq.length} 个`
        : `diff 中的 ${uniq.length} 个片段`,
    plural: uniq.length > 1,
  };
}

/**
 * One body fragment, in the two languages a posted body can carry.
 *
 * `zh` renders only when `bilingualFromPlan` says the PR author writes
 * Chinese; a fragment with no deterministic translation — a model-written
 * finding, a caller echo, an interpolated error — carries the same text in
 * both, and the Chinese section quotes it as it is.
 */
interface Bi {
  en: string;
  zh: string;
  /**
   * Where this part sits when the LAST-RESORT truncation runs — lower is
   * earlier in the concatenation, and the cut takes the tail, so lower is
   * protected. Untagged is last (3). The order is a policy too: the short
   * sentences that qualify the verdict (1), then this round's body
   * Criticals — the only copy of an unanchorable blocker (2), then
   * everything else un-trimmable, which is prose the author already
   * received in an earlier round. Positional order alone encoded the
   * inverse: body Criticals are spread last on both composing paths, so
   * they were the first content the cut spent.
   */
  keep?: number;
  /**
   * How readily this part yields when the composed body would exceed
   * GitHub's limit — LOWER goes first, absent never goes. The order is a
   * policy, not a convenience: a body that cannot post loses its blockers,
   * so the order runs by what a dropped block costs its reader: the
   * operator-facing mechanism-health note (trim rank -1), then the
   * persistently-critical advisory (trim rank 0 — the maintainer has it
   * whole on the terminal line and in the composed JSON), then the display
   * of findings the review deliberately did NOT request (the deferral list,
   * trim rank 1, kept whole in the findings artifact), then the disclosures
   * of what went unreviewed (trim rank 2, which have no other durable
   * copy), and the convergence observation last (trim rank 3 — see its own
   * block for why the cheapest paragraph is shed last). The blockers, the
   * caps, and the sentences that qualify the verdict never yield at all.
   *
   * `keep` above is a DIFFERENT axis; a number here is a `trim` rank.
   */
  trim?: number;
}

/** The production reader: one `gh pr view` for the description body. */
const fetchPrBodyViaGh: PrBodyFetcher = (ownerRepo, prNumber) => {
  const json = gh(
    'pr',
    'view',
    prNumber,
    '--repo',
    ownerRepo,
    '--json',
    'body',
  );
  return (JSON.parse(json) as { body?: string }).body ?? '';
};

export function repositoryContextGate(planPath: string): string[] {
  let plan: RosterPlan;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8')) as RosterPlan;
  } catch {
    // An unreadable plan has nothing to disclose; the coverage gate owns plan
    // validity and already fails closed on it.
    return [];
  }
  // A PRESENT-but-invalid context is a corrupted plan, and every consumer of
  // this field fails closed on one — coverage throws, the roster throws; the
  // disclosure cannot be the one place that silently shrugs.
  const context = repositoryContextOf(plan);
  const dimensions = context?.unverifiedDimensions ?? [];
  // The same cap discipline testPlanGate applies: unbounded entries joined
  // into one disclosure drown the verdict they ride on — and at the schema
  // bounds (256 x 512 chars) the paragraph outruns the review body's own
  // budget before any other content gets a word in.
  const MAX_DIMENSIONS = 5;
  const disclosed = dimensions
    .slice(0, MAX_DIMENSIONS)
    .map(
      (dimension) =>
        `${mdField(dimension)} — the repository context marks this proof boundary as unverified`,
    );
  if (dimensions.length > MAX_DIMENSIONS) {
    disclosed.push(`and ${dimensions.length - MAX_DIMENSIONS} more`);
  }
  return disclosed;
}

/**
 * Read the script-lint report the orchestrator wrote and turn it into verdict
 * inputs, deterministically. Returns the pre-confirmed `[lint]` Criticals (a
 * finding on a changed line, above cosmetic `style`) and the unreviewed-scope
 * entries (a checker not installed or crashed, or — owed but absent — a report
 * the run never produced). The path is DERIVED from the plan, never taken from
 * the model's input JSON, and the plan itself decides whether the lint was owed:
 * this is what takes the model out of both the block decision and the proof it ran.
 */
/**
 * The model's own body Criticals, minus any that RE-POST a claim this
 * round's script-lint gate regenerates anyway.
 *
 * Putting the gate's Criticals into the carried work-list (#9526) is what
 * made this necessary: from that round on, SKILL Step 6's still-standing
 * rule tells the model to re-post the entry under its original id, while
 * `composeReviewBody` re-derives the same Critical from the report — so one
 * blocker rendered twice, `buildLedger` minted a second id beside the
 * carried one because the regenerated copy claims none, and the pair
 * compounded every round: `[R1-1]`, `[R1-1, R2-1]`, `[R1-1, R2-1, R3-1]`
 * for a single lint finding, inflating the residual-risk count and the
 * marker's byte budget with it.
 *
 * The GATE's copy is the one kept, not the model's. The gate re-derives it
 * from a report bound to this diff's hash, so the re-post is structurally
 * redundant — and the model's copy is untrusted prose that `[lint]` does
 * not exempt from verification (`DETERMINISTIC_TAG_RE` covers `[build]`,
 * `[test]` and `[probe]` only), so keeping THAT one instead pulled the
 * unverified-blocker cap on every round a pipeline-proven blocker stood.
 * The id chain is not preserved for these entries, deliberately: a gate
 * finding is regenerated from the report every round, and what the next
 * round needs from the work-list is that a Critical stood, not which id it
 * stood under.
 *
 * The carried id is stripped through the ledger's OWN readback — a second
 * spelling of that is the drift class `lib/ledger.ts`'s header exists to
 * prevent — and what is matched is the gate line's LOCATOR, the
 * `` `path`:line CODE `` it opens with, not the whole rendered string. A
 * re-post is model-written prose: it carries the entry forward but is not
 * required to reproduce the message byte for byte, and an exact-match rule
 * silently stopped deduping the moment the wording drifted — which is the
 * common case, not the edge. Two findings sharing a path, a line AND a
 * checker code are the same finding.
 */
export function withoutGateReposts(
  ownBodyCriticals: readonly string[],
  gateCriticals: readonly string[],
): string[] {
  const locator = (entry: string): string => {
    const claim = entry.trim().replace(LEDGER_ID_READBACK, '').trim();
    const dash = claim.indexOf(' — ');
    // Backticks stripped: the gate renders the path through `mdField`, and a
    // re-post that types the locator plainly names the same finding.
    return (dash === -1 ? claim : claim.slice(0, dash))
      .replace(/`/g, '')
      .trim();
  };
  const regenerated = new Set(gateCriticals.map(locator).filter((k) => k));
  if (regenerated.size === 0) return [...ownBodyCriticals];
  return ownBodyCriticals.filter((c) => !regenerated.has(locator(c)));
}

/**
 * A structurally valid script-lint report: a plain-object root, and every
 * list field (`checked` / `skipped` / `errored` / `deferred`, plus the
 * nested `checked[].findings`) either absent/nullish or an array of plain
 * objects. The gate's loops dereference entries and iterate fields without
 * per-shape guards, so anything outside this contract is a TypeError, not
 * a report.
 */
function structurallyValidReport(report: unknown): boolean {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isPlainObject(report)) return false;
  for (const key of ['checked', 'skipped', 'errored', 'deferred'] as const) {
    const v = report[key];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v) || v.some((e) => !isPlainObject(e))) return false;
  }
  for (const c of (report.checked ?? []) as Array<Record<string, unknown>>) {
    const f = c.findings;
    if (f === undefined || f === null) continue;
    if (!Array.isArray(f) || f.some((e) => !isPlainObject(e))) return false;
  }
  return true;
}

export function scriptLintGate(planPath: string): {
  criticals: string[];
  unreviewed: string[];
  disclosed: string[];
} {
  const criticals: string[] = [];
  const unreviewed: string[] = [];
  // Disclosed-but-NOT-capping: a `deferred` checker (actionlint) is a known tool
  // limitation, not a finding and not an unrun-checker gap — the reader is told a
  // workflow's embedded shell was not linted, but the verdict is not capped on it.
  const disclosed: string[] = [];
  let plan: {
    prNumber?: unknown;
    files?: unknown;
    diffPathAbsolute?: unknown;
  };
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch {
    // Fail CLOSED, like every other gate path: an unreadable plan means we cannot
    // tell whether the lint was owed, and "cannot tell" must not open the gate.
    unreviewed.push(
      'the executable-script lint — could not read the plan to check the gate',
    );
    return { criticals, unreviewed, disclosed };
  }
  // A diff-only (cross-repo lightweight) review has no worktree, so the
  // orchestrator could not have run script-lint — do not fail it closed for a
  // command it cannot run, exactly as the roster never owed it there.
  if (reviewMode(plan as RosterPlan) === 'diff-only') {
    return { criticals, unreviewed, disclosed };
  }
  const owed = hasExecutableScript(plan as RosterPlan);
  const reportPath = join(
    dirname(planPath),
    scriptLintReportName(plan.prNumber),
  );
  let report: ScriptLintReport;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8')) as ScriptLintReport;
  } catch {
    // No report. Fail closed ONLY when the diff carried a path-detected script
    // (owed) — otherwise a diff with no scripts would be capped for a command it
    // had no reason to run.
    //
    // The one gap this leaves — a SHEBANG-only script (`hasExecutableScript` is
    // path-only, so `owed` is false for it) whose command was skipped — is closed by
    // a CONTRACT, not by this predicate: SKILL.md has the orchestrator run
    // `qwen review script-lint` on EVERY same-repo review, unconditionally. So a
    // compliant run always writes a report (even "nothing to lint"), the shebang
    // script is linted and appears in it, and it is handled below on its own
    // findings regardless of `owed`. "No report" therefore means the command did not
    // run — the `owed` cap covers the path-detectable case; the shebang case relies
    // on the always-run contract above, which is why it is stated there in prose.
    if (owed) {
      unreviewed.push(
        'the executable-script lint — `qwen review script-lint` produced no report',
      );
    }
    return { criticals, unreviewed, disclosed };
  }
  // A parsed-but-MALFORMED report fails closed too — before the diffHash
  // check dereferences it. The JSON is a side file the review agent can
  // rewrite, and the hash is readable out of that same file, so a "fresh"
  // report proves nothing about provenance; a null entry, a non-array
  // field, or a null root would throw a TypeError in the loops below and
  // lose the whole round, blockers included. The decision is whole-report
  // refusal rather than per-entry salvage — and string entries like
  // `skipped: ["x"]` are deliberately IN that refusal: the linter writes
  // object entries, so a non-object entry is the same untrusted channel,
  // not a shape to render.
  if (!structurallyValidReport(report)) {
    unreviewed.push(
      'the executable-script lint — the report is malformed; re-run `qwen review script-lint`',
    );
    return { criticals, unreviewed, disclosed };
  }
  // Fail closed on a STALE report — bound to the diff's CONTENT, not a commit. The
  // report carries a hash of the diff it ran against; we re-hash the plan's current
  // diff. A mismatch means it is not this review's report: a later PR commit
  // (different diff), OR — the local case HEAD cannot see — an uncommitted edit that
  // changes the working-tree diff. An absent hash on EITHER side (the diff could not
  // be read here or there) is unverifiable and also fails closed — `!planDiffHash`
  // handles that explicitly, because `undefined !== undefined` is FALSE and would
  // otherwise accept an arbitrary hashless report. Only both sides present and equal
  // is fresh.
  const planDiffHash = diffHashOf(plan.diffPathAbsolute);
  if (!planDiffHash || report.diffHash !== planDiffHash) {
    unreviewed.push(
      'the executable-script lint — the report is stale or its diff could not be verified; re-run `qwen review script-lint`',
    );
    return { criticals, unreviewed, disclosed };
  }
  // Process the report's findings REGARDLESS of the path-only owed predicate: the
  // report can name a shebang script (`hook.sh` by its `#!`) that `pathTool` could
  // not, and returning early on the predicate would drop exactly those findings.
  for (const file of report.checked ?? []) {
    for (const f of file.findings ?? []) {
      if (f.inDiff && f.level !== 'style') {
        criticals.push(
          `${mdField(file.path)}:${f.line} ${f.code} — ${mdField(f.message)} [lint]`,
        );
      }
    }
  }
  // Each skipped entry carries its OWN reason (not installed, or an irregular file
  // like a symlink) — surface it, rather than hard-coding "not installed". A
  // deferred checker is NOT here: it is its own state, disclosed below without capping.
  // The reason/tool fields are report prose headed for a machine-read body, so
  // their comment grammar goes inert exactly as at every other prose exit — the
  // report is a side file the review agent can rewrite, and a literal
  // `<!-- qwen-review-… -->` there would otherwise post as a live marker.
  for (const s of report.skipped ?? []) {
    unreviewed.push(
      `the executable-script lint — ${mdField(s.path)}: ${stripCommentGrammar(s.reason ?? `${s.tool} unavailable`)}`,
    );
  }
  for (const e of report.errored ?? []) {
    unreviewed.push(
      `the executable-script lint — ${stripCommentGrammar(e.tool)} errored on ${mdField(e.path)}`,
    );
  }
  // A deferred checker (actionlint) is disclosed but does not cap — the reader is
  // told the workflow's embedded shell was not linted, without making every
  // workflow PR un-Approvable on a checker we deliberately decline to run.
  for (const d of report.deferred ?? []) {
    disclosed.push(
      `the executable-script lint — ${mdField(d.path)}: ${stripCommentGrammar(d.reason ?? `${d.tool} deferred`)}`,
    );
  }
  return { criticals, unreviewed, disclosed };
}

/**
 * The report filename the orchestrator writes and this derives — pr-numbered
 * when the plan resolved a PR, a stable local name otherwise (matching the old
 * `agent-prompt` convention so a mid-flight upgrade finds the same file).
 */
function scriptLintReportName(pr: unknown): string {
  return isPositivePrNumber(pr)
    ? `qwen-review-pr-${pr}-script-lint.json`
    : 'qwen-review-script-lint.json';
}

/**
 * Read the test-plan report and turn its rulings into body notes.
 *
 * Unlike `scriptLintGate`, this one **never caps and never blocks**, and every
 * early return is therefore a plain "nothing to say" rather than a fail-closed
 * disclosure. That asymmetry is deliberate on both halves:
 *
 *   - A Test Plan defect is not a code defect. The author claimed a path that
 *     is not there, or a count from a different suite; the diff is unaffected.
 *     Blocking a merge on it would spend the review's one irreversible action
 *     on a documentation nit, and the skill's design philosophy is that a
 *     comment not worth the reader's time costs more than it returns.
 *   - Capping on a MISSING report would cap essentially every PR, because most
 *     PRs produce no notes at all and a run has no way to prove the difference
 *     between "checked, nothing to say" and "never checked" that is worth the
 *     un-Approvability. This is the `deferred`-checker precedent above: a
 *     limitation the author cannot fix must not become a permanent cap.
 *
 * A stale report is dropped in silence for the same reason a stale one is
 * refused elsewhere — a note about a previous commit's Test Plan is worse than
 * no note, and here there is no cap to fall back to.
 */
export function testPlanGate(planPath: string): { notes: string[] } {
  const notes: string[] = [];
  let plan: { prNumber?: unknown; diffPathAbsolute?: unknown };
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch {
    return { notes };
  }
  // A local review has no PR body, so there is no Test Plan to have checked.
  const pr = plan.prNumber;
  if (!isPositivePrNumber(pr)) return { notes };

  let report: TestPlanReport;
  try {
    report = JSON.parse(
      readFileSync(
        join(dirname(planPath), `qwen-review-pr-${pr}-test-plan.json`),
        'utf8',
      ),
    ) as TestPlanReport;
  } catch {
    return { notes };
  }
  const planDiffHash = diffHashOf(plan.diffPathAbsolute);
  if (!planDiffHash || report.diffHash !== planDiffHash) return { notes };

  for (const claim of report.claims ?? []) {
    if (claim.verdict === 'contradicted') {
      notes.push(
        `${mdField(claim.text)} — ${mdField(claim.observed ?? 'not reproduced')}`,
      );
    } else if (claim.verdict === 'differs') {
      notes.push(
        `${mdField(claim.text)} — this review observed ${mdField(claim.observed ?? 'a different result')}`,
      );
    }
  }
  // The same cap discipline the mutant/hunk probes apply: unbounded notes
  // joined into one line drown the verdict they ride on.
  const MAX_NOTES = 5;
  if (notes.length > MAX_NOTES) {
    const extra = notes.length - MAX_NOTES;
    notes.length = MAX_NOTES;
    notes.push(`and ${extra} more`);
  }
  return { notes };
}

/**
 * Whether the posted body carries the collapsed Chinese version: the plan
 * (fetch-pr's report) recorded Han characters in the PR description. The
 * signal is the CLI's own — never the caller's, who could otherwise toggle
 * the register of a certified body. A local plan has no such field, and a
 * plan that cannot be read defaults to English-only: the language must never
 * take the review down.
 *
 * A recorded `false` is authoritative: `fetch-pr` fetched the body and found
 * no Han, so English-only is the answer and no network is spent — every
 * English-authored PR review takes this path.
 *
 * The field being *absent* is a different state, and the one that shipped an
 * English-only review over a Chinese-authored PR (#7686): `fetch-pr` always
 * writes it, but a `plan-diff` plan never does, and an orchestrator that
 * improvises the pipeline can wire `compose-review` at a plan that is not
 * `fetch-pr`'s report at all. So when the flag is missing yet the plan still
 * carries the PR's identity, recover the signal from the live PR — the real
 * description, which the caller cannot fake, so this hardens the "signal is
 * the CLI's own" property rather than loosening it. Any failure of that fetch
 * falls back to English: the language must never take the review down.
 */
function bilingualFromPlan(
  planPath: string | undefined,
  fetchPrBody: PrBodyFetcher = fetchPrBodyViaGh,
): boolean {
  if (!planPath) return false;
  let plan: unknown;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch {
    return false;
  }
  const han = (plan as { prDescriptionHasHan?: unknown })?.prDescriptionHasHan;
  if (typeof han === 'boolean') {
    return han;
  }
  // The identity rule is shared with the comment anchors (planPrIdentity).
  // The stricter ownerRepo shape changes no outcome: a misshapen one failed
  // the gh fetch and fell back to English anyway.
  const pr = planPrIdentity(plan);
  if (!pr) return false;
  try {
    return /\p{Script=Han}/u.test(fetchPrBody(pr.ownerRepo, pr.prNumber));
  } catch {
    return false;
  }
}

interface ComposeReviewCliArgs {
  input: string | undefined;
  comments: string;
  out: string | undefined;
  /** GitHub Enterprise host — routes this command's `gh` calls via GH_HOST. */
  host?: string;
  /** The PR being composed for — the recovery's first identity source,
   * mirroring `submit`'s own `--pr` so the two boundaries share one formula
   * (caller ?? plan) whatever the state's planPath does. */
  pr?: number;
  /** The reviewed repo, `owner/repo` — the URL-record bar's first repo
   * source, mirroring `submit`'s `--repo`. */
  repo?: string;
  /** Test seam for the recorded-floor recovery — same rule as `submit`'s:
   * honoured only when no session id is present. */
  skillArgs?: string;
}

/**
 * The drafted inline comments, read from the file Step 6 is told to pass.
 *
 * Accepts the bare array or the full review-payload shape (`{comments: […]}`),
 * so the same file Step 7 submits can be handed over unchanged. Every entry
 * must open with a severity marker: `countInlineFindings` weighs an unmarked
 * body as nothing, and for a verdict computation "nothing" means a blocker
 * written without its marker approves the review it should have blocked.
 * Step 6 is where the draft is still cheap to fix, so it refuses here.
 */
function readDraftedComments(path: string): DraftedComment[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `compose-review: cannot read the comments file ${path}: ` +
        `${(err as Error).message}. Pass the drafted inline comments — the ` +
        `same array the review payload will carry — or a file containing [] ` +
        `when nothing anchors inline.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `compose-review: the comments file ${path} is not JSON: ${(err as Error).message}`,
    );
  }
  const comments = Array.isArray(parsed)
    ? parsed
    : (parsed as { comments?: unknown })?.comments;
  if (!Array.isArray(comments)) {
    throw new Error(
      `compose-review: the comments file ${path} must be a JSON array of ` +
        `comment objects, or a review payload with a \`comments\` array.`,
    );
  }
  const unmarked = unmarkedComments(comments as DraftedComment[]);
  if (unmarked.length > 0) {
    throw new Error(
      `compose-review: comments[${unmarked.join(', ')}] in ${path} open with ` +
        `neither ${CRITICAL_PREFIX} nor ${SUGGESTION_PREFIX}. Every inline ` +
        `comment is a finding and carries its severity first — an unmarked ` +
        `body would be counted as neither, and a blocker that weighs nothing ` +
        `approves the review it should block. Fix the draft, not the counts.`,
    );
  }
  return comments as DraftedComment[];
}

export const composeReviewCommand: CommandModule = {
  command: 'compose-review',
  describe:
    'Compute the review event and body from the drafted comments and run states (the Step 7 invariant, as code); reads the state JSON from --input or stdin',
  builder: (yargs) =>
    yargs
      .option('input', {
        type: 'string',
        describe: 'Path to the state JSON (omit to read stdin)',
      })
      .option('comments', {
        type: 'string',
        demandOption: true,
        describe:
          'Path to the drafted inline comments JSON (the review payload, or ' +
          'its bare comments array). The inline counts are counted from it, ' +
          'never typed — pass a file containing [] when nothing anchors inline.',
      })
      .option('out', {
        type: 'string',
        describe: 'Also write the {event, body} JSON to this path',
      })
      .option('host', {
        type: 'string',
        describe:
          'GitHub Enterprise host (routes gh via GH_HOST) — needed only when ' +
          'the bilingual body-language recovery has to fetch the PR description',
      })
      .option('pr', {
        type: 'number',
        describe:
          'The PR this compose is for — the recorded-floor recovery binds ' +
          'the record to it first, exactly as submit binds its own --pr. ' +
          'Pass it on every PR review.',
      })
      .option('repo', {
        type: 'string',
        describe:
          '<owner>/<repo> under review — the URL-shaped record bar binds ' +
          'it first, exactly as submit binds its own --repo. Pass it on ' +
          'every PR review.',
      })
      .option('skill-args', {
        type: 'string',
        describe:
          "Path to the CLI-written record of the review's invocation " +
          'arguments, for the recorded-floor recovery. Honoured only when no ' +
          'session id is present (tests) — a real run reads the ' +
          'session-scoped record, exactly as submit does.',
      }),
  handler: async (argv) => {
    const { input, comments, out, host, pr, repo, skillArgs } =
      argv as unknown as ComposeReviewCliArgs;
    // Route this command's own `gh` call — the bilingual recovery's `gh pr view`
    // (see `fetchPrBodyViaGh`) — via the PR's host, exactly as fetch-pr and submit
    // do. Without it a GHE review whose plan lacks the Han flag fetches the body
    // from github.com, fails, and composes an English-only body that disagrees
    // with what `submit` (which routes by host) posts.
    setGhHost(host);
    // yargs enforces --comments on the real command line; this covers every
    // other way in (tests, programmatic calls) with the same sentence instead
    // of an ENOENT on `undefined`.
    if (!comments) {
      throw new Error(
        'compose-review: --comments is required — the inline counts are ' +
          'counted from the drafted comments file, never typed. Pass a file ' +
          'containing [] when nothing anchors inline.',
      );
    }
    const raw = readFileSync(input ?? 0, 'utf8');
    // The input is a JSON the model wrote. `env` decides where the harness
    // transcripts are read from, and it must NOT come from that JSON: a model
    // that wanted an approval could point it at a directory of transcripts it
    // fabricated, which is the whole gate reopened through one extra key. It is a
    // unit-test seam and nothing else, so it is stripped here — the real run
    // always resolves the transcripts from the environment the CLI exported.
    const parsed = JSON.parse(raw) as ComposeReviewInput;
    delete parsed.env;
    // Same reasoning for the bilingual body-language fetcher: it is a unit-test
    // seam (production reads the PR with `gh pr view`). A state JSON carrying it —
    // even a non-function value like `"suppress"` — would otherwise reach
    // `bilingualFromPlan`, be called, throw, and drop the Chinese fold through the
    // fail-safe. Stripping it here keeps the register the CLI's own, not the
    // caller's, which is the whole point of the seam.
    delete parsed.prBodyFetcher;
    // Same reasoning: the ledger's contents are the comments this run drafted,
    // read from `--comments` below — not something a state JSON may assert.
    delete parsed.draftedComments;
    // The inline counts are counted, not accepted — `submit` has refused them
    // since the count-beside-the-comments bug, and this boundary refusing them
    // too is what makes the Step 6 line and the posted verdict the same
    // computation on the same source. Silently overwriting instead would let a
    // run keep believing the number it typed.
    if (
      parsed.criticalsInline !== undefined ||
      parsed.suggestionsInline !== undefined
    ) {
      throw new Error(
        'compose-review: `criticalsInline` / `suggestionsInline` are counted ' +
          'from the --comments file, not taken from the state JSON. Remove ' +
          'them. (A dogfooded run moved its one Critical from `bodyCriticals` ' +
          'to an inline comment, dropped the count on the way, and the ' +
          'verdict line read Approve over a blocker.)',
      );
    }
    // The operator's floor, from the CLI's verbatim record — resolved through
    // the SAME shared helper `submit` uses, with the SAME identity formula:
    // the caller's CLI-typed identity first (this command's --pr/--repo and
    // the effective --host, mirroring submit's own flags), the plan only
    // filling axes the caller did not supply. Caller-first because the
    // plan's PATH arrives through the model-written state — a
    // parseable-but-wrong plan must not choose which identity the record is
    // tested against; symmetric inputs because an asymmetric axis (submit
    // passing repo/host while compose did not) let a URL-shaped record
    // recover at one boundary and not the other — the archive/post split
    // both call sites exist to prevent. A plan-less local target with no
    // --pr recovers nothing; every failure mode returns undefined and
    // leaves the state's value standing. The note names the true source
    // (flag vs setting), and its guard compares the NORMALISED state floor
    // — a case-drifted transcription of the same floor is agreement, not an
    // override to announce.
    const recovered = recordedSeverityFloor({
      planPath: parsed.planPath,
      callerPr:
        typeof pr === 'number' && Number.isSafeInteger(pr) && pr > 0
          ? pr
          : undefined,
      callerRepo:
        typeof repo === 'string' && isOwnerRepo(repo) ? repo : undefined,
      callerHost: resolveGhHost(host),
      defaultSeverityFloor: operatorReviewSettings().severityFloor,
      skillArgs,
    });
    if (
      recovered !== undefined &&
      normalizeSeverityFloor(parsed.severityFloor) !== recovered.floor
    ) {
      writeStderrLine(
        `Severity floor: using ${JSON.stringify(recovered.floor)} from ` +
          (recovered.source === 'explicit'
            ? 'the recorded `--severity-floor` flag'
            : 'the `review.severityFloor` setting resolved against the recorded invocation') +
          `, over the state's ${JSON.stringify(parsed.severityFloor ?? null)} ` +
          `— the CLI's verbatim record outranks the state JSON.`,
      );
      parsed.severityFloor = recovered.floor;
    }
    const drafted = readDraftedComments(comments);
    const result = composeReview(
      {
        ...parsed,
        ...countInlineFindings(drafted),
        draftedComments: drafted,
      },
      // Same pin as `submit`: the startup stamp, not a version resolved at
      // compose time — a shared runner can rewrite the install mid-session.
      footerVersion(process.env['QWEN_CODE_STARTUP_VERSION']) ??
        (await getCliVersion()),
      operatorReviewSettings().attribution,
      // The anchor's certifying identity is the model the runtime published
      // for this session — Config publishes it per session, the shell tool
      // injects it into this subprocess. It supersedes the typed id, but the
      // launching command can still override the env (and a hijacked
      // orchestrator can forge the marker outright via the API) — the same
      // forgeable posture DESIGN.md records for the cache path.
      // The identity this round runs under — see lib/round-model.ts.
      roundModelIdFrom(process.env),
    );
    // The exact terminal verdict, persisted beside the fields it is computed
    // from. `event` + `cappedBy` alone cannot reconstruct it — a presubmit
    // downgrade also depends on `downgraded`/`downgradedFrom` — and Step 8's
    // archived report copies this line rather than re-deriving a lossy one.
    const json = JSON.stringify(
      { ...result, verdictLine: verdictLine(result) },
      null,
      2,
    );
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, json, 'utf8');
    }
    writeStdoutLine(json);
    // The verdict a human reads, next to the JSON a program reads.
    //
    // Step 6 prints a verdict to the terminal, and until now it *composed* one —
    // from the same prose rules this file exists to replace. So a run could skip
    // this command entirely and tell the user whatever it had concluded: dogfooded,
    // one did, and reported an Approve on a review whose coverage check had refused.
    // There is now nothing to compose. This is the sentence; print it.
    //
    // The fixes first, the verdict last. These lines are the orchestrator's copy
    // of what the body's `Not reviewed:` disclosures only describe — the body
    // names what cannot be certified for the PR author; this names the command
    // that repairs it, on the channel the author never sees.
    for (const fix of result.remediation) {
      writeStderrLine(`FIX: ${fix}`);
    }
    // The volume this round adds to the pull request, stated rather than
    // left to be counted by hand — and beside the previous round's when the
    // marker recorded one, because a single number says nothing about a
    // trend. Facts only: no threshold, no advice, no judgement about
    // whether the number is too large. The operator owns that reading; this
    // line only makes it available. (Printed on every compose, not only on
    // posting runs: a report-only round's volume is what the NEXT round's
    // trend is measured against.)
    writeStderrLine(
      `VOLUME: ${result.postedInline} inline comment(s) this round` +
        ` (${result.postedFresh} reported for the first time)` +
        (result.prevPostedInline === undefined
          ? ''
          : ` (previous round: ${result.prevPostedInline})`),
    );
    // The terminal copy the body's own trim notice promises. The convergence
    // paragraph is the ladder's LAST rank, and unlike the deferral list
    // (findings artifact) or the not-reviewed disclosures (the model's own
    // inputs) it has no other copy anywhere — so the notice's "read them in
    // the terminal report" was a false record until this line existed. Last
    // does not mean safe: a body that reaches trim rank 3 has already shed
    // every other rank, which is exactly when this line is the only copy
    // left.
    if (result.convergence) {
      writeStderrLine(`CONVERGENCE: ${result.convergence.en}`);
    }
    // The same promise for the same reason: this block is the FIRST thing the
    // overflow ladder sheds, and the notice points the reader here.
    if (result.health) {
      writeStderrLine(`HEALTH: ${result.health.en}`);
    }
    // The persistently-critical residual-risk advisory (#9410), when the
    // carried telemetry shows the loop will not self-converge via the floor.
    // Its OWN label, not the CONVERGENCE line's: both can fire in the same
    // round, and one label over two different paragraphs is a terminal
    // record neither an operator nor a parser can split back apart.
    // Advisory only, like the VOLUME line beside it — facts plus the one
    // recommendation that fits, never a threshold, never a decision: the
    // land-with-residual-risk exit is the maintainer's to take. Printed only
    // when the shape is provable; absence is the fail-safe reading.
    if (result.residualRisk) {
      // ONE line, like `VOLUME:`, `FIX:` and `CONVERGENCE:` beside it. The
      // advisory carries a blank markdown table for the body, so printed
      // verbatim it spread one labelled record over seven lines — six of
      // them unlabelled, which is a record no line-oriented reader (an
      // operator scanning, a `grep`, a log collector) can put back
      // together. Collapsed rather than dropped: the pipes survive, so the
      // inventory's three columns are still all there on the round where
      // the body budget shed the formatted copy and this line is the copy.
      writeStderrLine(
        `RESIDUAL-RISK: ${convergenceAdvisory(result.residualRisk)
          .en.replace(/\s+/g, ' ')
          .trim()}`,
      );
    }
    writeStderrLine(verdictLine(result));
  },
};

/**
 * The fix-induced marking, read from the head of the CLAIM — after the id and
 * its separator, never inside the id grammar.
 *
 * Placing it there is the whole point. `LEDGER_ID_READBACK` is shared by
 * `idFor`, so widening it to swallow a parenthetical would put the ledger's
 * carry on the same regex as a model-written adjective: a spelling or spacing
 * the wider grammar failed to anticipate (`R1-2(Fix-Induced):`) would stop
 * matching the id at all, and the finding would be silently renumbered — the
 * exact failure "one finding, one name" exists to prevent. Read here, the id
 * is already in hand and nothing about this token can cost it: an unrecognised
 * marking leaves the draft counted as a re-post, which is what every round did
 * before this existed.
 *
 * Case-insensitive, and tolerant of inner spacing, because it governs only
 * whether a comment counts as first-time work — never which finding it is.
 */
const FIX_INDUCED_READBACK = /^\(\s*fix-induced\s*\)[:.,-]?\s*/i;

/**
 * The id a claim line carries, whether that id fronts a NEW defect, and the
 * claim itself with both stripped.
 *
 * `fixInduced` is the answer to a question the id alone cannot settle. Step 6
 * re-reports two different things under a previous entry's id: a finding that
 * STILL STANDS — the same claim, re-asserted — and a fix-induced defect, which
 * is new work wearing the id of the entry whose fix produced it. The volume
 * trend counts comments posted for the first time, and reading the id alone
 * called both of them re-posts, so the trend's baseline fell on exactly the
 * churning pull requests where new work was not falling at all.
 *
 * Module-level rather than a closure inside the ledger builder, because the
 * builder is no longer its only consumer: the convergence diagnosis reads the
 * same id to tell a re-posted still-standing finding from fresh activity, and
 * a second restatement would let one end call a comment carried while the
 * other calls it new.
 */
function readClaim(rest: string): {
  id?: string;
  fixInduced: boolean;
  title: string;
} {
  const line = rest.split('\n')[0].trim();
  const carried = LEDGER_ID_READBACK.exec(line);
  const afterId = (carried ? line.slice(carried[0].length) : line).trim();
  // Only ever a marking on a CARRIED id. On a fresh finding there is no
  // entry for the defect to have been induced by, so the token would be
  // decoration — and honouring it there would let a stray parenthetical add
  // a first-time count the round already gets for that comment anyway.
  const marked = carried ? FIX_INDUCED_READBACK.exec(afterId) : null;
  return {
    id: carried?.[1],
    fixInduced: marked !== null,
    title: (marked ? afterId.slice(marked[0].length) : afterId).trim(),
  };
}

/**
 * A drafted comment's claim line, projected the way every id consumer must
 * read it: severity marker stripped, forged footer spans and comment-marker
 * lines removed, leading render-nothing residue gone. Residue or a forged
 * span between the marker and a carried id defeats the id anchor — the
 * ledger would silently renumber the finding, and the diagnosis would count
 * a re-post as new work. Stated once so the projections cannot diverge.
 */
function ledgerClaimLine(body: unknown): string {
  const claim = carriedClaimLine(typeof body === 'string' ? body : '');
  return claim === null
    ? ''
    : stripFooterSpans(stripCommentMarkerLines(claim)).replace(
        LEADING_INVISIBLE_RE,
        '',
      );
}

/**
 * Inline Suggestions the posting floor WOULD have deferred — every
 * Suggestion-severity draft whose claim line carries no deterministic tag.
 *
 * The posture excludes a `[build]`/`[test]`/`[probe]` finding by source at
 * any floor: it is pre-confirmed, and it stays inline whether or not the
 * floor engaged. Counting it as evidence that the floor failed to act reads
 * the posture working as specified as the posture failing — and the tag is
 * read off the CLAIM LINE only, the same window `floorEnforcedReroute` uses,
 * because the body's tail is writable surface a footer can forge.
 *
 * A pathless comment is excluded for the same reason by a different route:
 * it cannot become a deferral entry at all, so no floor could have moved it.
 */
export function deferrableSuggestionsInline(drafted: unknown): number {
  if (!Array.isArray(drafted)) return 0;
  let n = 0;
  for (const c of drafted as Array<{ body?: unknown; path?: unknown }>) {
    if (severityOf(c) !== 'suggestion') continue;
    const claim = carriedClaimLine(typeof c.body === 'string' ? c.body : '');
    if (claim !== null && DETERMINISTIC_TAG_RE.test(claim)) continue;
    // A pathless comment cannot become a deferral entry, so the floor leaves
    // it inline at any posture — the same structural exclusion the reroute
    // makes, and counting it would accuse the floor of failing to move
    // something it has nowhere to move to.
    if (typeof c.path !== 'string' || c.path.trim() === '') continue;
    n++;
  }
  return n;
}

/**
 * This round's drafts in the shape the convergence diagnosis reads.
 *
 * The path travels WHOLE. The recurrence join has to reach across the
 * ledger's `LEDGER_MAX_FILE` cap, but truncating here to meet it does not
 * prevent prefix collisions, it creates them — and it would put a
 * 200-character prefix that names no real file into a posted paragraph. The
 * join matches a truncated ledger entry by prefix instead.
 *
 * Unmarked comments are excluded, through the same predicate `buildLedger`
 * uses: a comment with no severity marker is not a finding — it enters no
 * work list — so counting it as fresh activity would inflate a cluster and
 * satisfy the activity guard that alone keeps the trend off a settled round.
 *
 * `Array.isArray` like its two siblings: `draftedComments` arrives from a
 * model-written state JSON, and a non-array reaching `.map` throws out of
 * `composeReviewBody` and loses the whole round.
 */
export function draftedFindingsOf(drafted: unknown): DraftedFinding[] {
  if (!Array.isArray(drafted)) return [];
  const out: DraftedFinding[] = [];
  // Deduped exactly as `idFor` dedupes: the ledger keeps the FIRST comment
  // under a carried id and re-mints this round's id for a second one, so a
  // second draft carrying the same id is a finding this round minted. Passed
  // through raw, it read as a re-post here while the marker's own work list
  // gained a round-N entry — one end calling a comment carried while the
  // other calls it new, which is the drift `readClaim` exists to prevent.
  const seen = new Set<string>();
  for (const c of drafted as Array<{ path?: unknown; body?: unknown }>) {
    if (severityOf(c) === null) continue;
    const { id, fixInduced } = readClaim(ledgerClaimLine(c.body));
    // The same length bound `idFor` applies before it will carry an id: an
    // id the serializer refuses is one no work list can hold, so treating it
    // as a re-post here would call a finding carried that the ledger mints
    // fresh — the two ends disagreeing about one comment.
    const usable =
      id !== undefined && id.length <= LEDGER_MAX_ID ? id : undefined;
    const carried =
      usable !== undefined && !seen.has(usable) ? usable : undefined;
    if (carried !== undefined) seen.add(carried);
    out.push({
      file: typeof c.path === 'string' ? c.path : '',
      ...(carried === undefined ? {} : { carriedId: carried }),
      // Only alongside the id it qualifies. A second draft under an id this
      // round already spent has its `carriedId` dropped just above — the
      // ledger mints it a fresh one — so it is first-time work by the id
      // alone, and carrying the marking without the id would state a
      // relationship to an entry this comment no longer names.
      ...(carried !== undefined && fixInduced ? { fixInduced: true } : {}),
    });
  }
  return out;
}

/**
 * The next round's ledger: every finding this review is posting as its own —
 * the drafted inline comments plus the body Criticals. Low-confidence findings
 * never reach either input (they are terminal-only), so the ledger holds only
 * claims the review stands behind, which is what the next round re-asserts.
 */
export function buildLedger(
  round: number,
  drafted: Array<{ path?: unknown; line?: unknown; body?: unknown }>,
  bodyCriticals: string[],
  /**
   * The previous round's work list, when this round recovered one, and
   * whether that list was COMPLETE.
   *
   * A claimed id that names no entry in a complete list is a stray — a
   * model-written token, not a carry — and recording it mints a finding
   * under a round that never held it, which the next round's recurrence
   * join then CITES in a posted paragraph and counts toward the depth key.
   * The completeness flag is what separates a stray from a legitimately
   * re-voiced entry the marker's byte budget shed: over a shortened list
   * this cannot be told apart, so the id is retained and continuity wins.
   */
  carriedWorkList?: { ids: ReadonlySet<string>; complete: boolean },
): Ledger {
  const findings: LedgerFinding[] = [];
  const taken = new Set<string>();
  let next = 0;
  /** Is this claimed id one the previous round actually recorded? */
  const isCarry = (claimed: string): boolean => {
    // The admission bounds come first, and continuity does not override
    // them. An id past `LEDGER_MAX_ID`, at round 0, or claiming a round
    // ahead of this one could never have been in any list this pipeline
    // wrote — so keeping it is not continuity, it is emitting an entry the
    // serializer's own filter then refuses WHOLE: a posted finding exits the
    // work list owing no ruling, the round is mislabelled budget-truncated,
    // and the anchor is withheld. Re-minting costs the entry its cross-round
    // id and nothing else — the same trade the integer-line guard makes.
    if (claimed.length > LEDGER_MAX_ID) return false;
    const minted = Number(claimed.slice(1).split('-')[0]);
    if (!Number.isSafeInteger(minted) || minted < 1 || minted > round) {
      return false;
    }
    return (
      carriedWorkList === undefined ||
      !carriedWorkList.complete ||
      carriedWorkList.ids.has(claimed)
    );
  };
  /** A carried id if it is free, else the next unused id of THIS round. */
  const idFor = (claimed: string | undefined): string => {
    const carried =
      claimed !== undefined && isCarry(claimed) ? claimed : undefined;
    if (carried && !taken.has(carried)) {
      taken.add(carried);
      return carried;
    }
    let id: string;
    do {
      id = `R${round}-${++next}`;
    } while (taken.has(id));
    taken.add(id);
    return id;
  };
  /**
   * A title the next round can act on. The field's job is "enough to re-locate
   * the claim", and a comment that is nothing but its severity marker leaves it
   * empty — which does not merely degrade the entry, it jams the review: the
   * next round is told every ledger entry is owed a ruling, has no claim to
   * rule on, answers `cannot tell`, and that is `cannot-tell-existing-critical`
   * — a cap. Nothing changes between rounds, so the cap never lifts. Dropping
   * the entry instead would hide a Critical that really was posted, so keep it
   * and hand over the one handle there is.
   */
  const locatable = (title: string, where: string): string =>
    title || `(comment carried no text — see the posted finding at ${where})`;

  for (const c of drafted) {
    // ONE severity predicate for the whole package. `severityOf` trims leading
    // whitespace before matching, and it is what `countInlineFindings` — the
    // count the verdict is computed from — and the unmarked-comment gate both
    // use. A second `startsWith` here disagreed on exactly that whitespace: a
    // Critical whose body opened with a newline was counted, was posted, and
    // was silently absent from the ledger, shifting every id after it.
    const sev = severityOf(c);
    if (!sev) continue;
    // `ledgerClaimLine` is the shared projection — `carriedClaimLine` (the ONE
    // readback statement, also used by presubmit's carried-id extractor) with
    // forged footer spans and leading render-nothing residue stripped off it.
    // The ledger rides the posted body as an HTML comment the autofix grep
    // reads, and residue between the marker and a carried id would defeat the
    // id anchor and silently renumber the finding.
    const { id: carried, title } = readClaim(ledgerClaimLine(c.body));
    const file = typeof c.path === 'string' ? c.path : LEDGER_UNKNOWN_FILE;
    findings.push({
      id: idFor(carried),
      sev: sev === 'critical' ? 'C' : 'S',
      file,
      // The flag marks the EXCEPTION — a real path that happens to be spelled
      // like a stand-in — so the stand-ins themselves cost no marker bytes and
      // a marker written before the flag existed still reads correctly.
      ...(typeof c.path === 'string' && isStandInName(c.path)
        ? { k: 1 as const }
        : {}),
      // Integer, like the admission test demands: a model-written `12.5`
      // emitted here is refused by the serializer's own filter, which counts
      // the WHOLE entry into `dropped` — retiring a posted finding with no
      // ruling, mislabelling the round as budget-truncated, and withholding
      // the anchor so the next round re-scopes the full diff. Dropping the
      // line alone keeps the finding and costs it only its anchor line.
      ...(typeof c.line === 'number' && Number.isInteger(c.line)
        ? { line: c.line }
        : {}),
      title: locatable(
        title,
        `${file}${typeof c.line === 'number' ? `:${c.line}` : ''}`,
      ),
    });
  }
  for (const b of bodyCriticals) {
    // The title strips through the same fixpoint chain the visible list
    // uses — the ledger marker rides the posted body as an HTML comment,
    // and the autofix grep reads the whole body, comments included.
    // Leading render-nothing residue goes too, for the same reason as the
    // drafted-comment leg: residue between the marker and a carried id
    // would defeat the id anchor and silently renumber the finding.
    const { id: carried, title } = readClaim(
      stripForUnattributedPost(b).replace(LEADING_INVISIBLE_RE, ''),
    );
    findings.push({
      id: idFor(carried),
      sev: 'C',
      file: LEDGER_BODY_FILE,
      title: locatable(title, 'the review body'),
    });
  }
  return { v: 1, round, findings };
}

/** The terminal verdict, in the words Step 6 is told to print. */
export function verdictLine(r: ComposeReviewResult): string {
  const label: Record<ReviewEvent, string> = {
    APPROVE: 'Approve',
    REQUEST_CHANGES: 'Request changes',
    COMMENT: 'Comment',
  };
  const why: Record<string, string> = {
    'cannot-tell-existing-critical':
      'an existing blocker could not be ruled on',
    'chunk-nobody-read': 'part of the diff was never read',
    'uncoverable-chunk': 'part of the diff cannot be read at all',
    'unreviewed-dimension': 'a dimension nobody reviewed',
    'context-unavailable': "the PR's existing discussion could not be read",
    'unlicensed-deferral': 'findings were deferred without a posture licence',
    'findings-unverified-at-compose':
      'findings were still unverified when the loop ended',
  };
  let line = `Verdict: ${label[r.event]}`;
  // Why an Approve was not available — but only when one would otherwise have been.
  // A cap and a presubmit downgrade are BOTH reasons, and either can be the sole
  // one: a review with no cap state that the presubmit dropped from Approve to
  // Comment has an empty `cappedBy` and `downgraded: true`. Joining `cappedBy`
  // unconditionally then printed `an Approve was NOT available:  — downgraded …`,
  // a dangling colon over nothing. Collect the reasons first, and say the clause
  // only if there is a reason to say it.
  //
  // A coverage cap never softens a Request changes — a confirmed blocker earned
  // that, and naming a constraint that did not bind would send the reader
  // looking for an effect that is not there — so the Approve clause is gated on
  // the base having been an Approve at all. The unverified family is the
  // exception — the delivery floor and the findings file's surviving tags both
  // say the confirmation never happened — and the sentence must name what the
  // reader would otherwise chase: a Comment posted over visible **[Critical]**
  // comments reads as a contradiction until the line says why.
  if (
    r.baseEvent === 'REQUEST_CHANGES' &&
    r.event === 'COMMENT' &&
    (r.cappedBy.includes('criticals-unverified') ||
      r.cappedBy.includes('findings-unverified-at-compose'))
  ) {
    line +=
      ' — a Request changes was NOT available: ' +
      (r.cappedBy.includes('criticals-unverified')
        ? 'its blockers were never verified (they are posted, disclosed as ' +
          'unverified)'
        : 'findings were still unverified when the loop ended (they are ' +
          'posted, disclosed)');
  } else if (r.baseEvent === 'APPROVE' && r.event !== 'APPROVE') {
    const reasons = r.cappedBy.map((c) => why[c] ?? c);
    if (r.downgraded) reasons.push('a presubmit check failed');
    line += ` — an Approve was NOT available: ${reasons.join('; ')}`;
  } else if (r.downgradedFrom === 'Request changes') {
    // The decisive case, and the one a review caught. A presubmit downgrade can
    // move a REQUEST_CHANGES — a review with **confirmed Criticals** — down to
    // COMMENT (a self-PR, failing CI). Printed as a bare "Comment — downgraded",
    // that reads to an operator as "minor issues, nothing blocking", while the
    // review has just posted blockers inline. Say what it was.
    line +=
      ' — Request changes, downgraded to Comment by a presubmit check ' +
      '(the blockers are still posted)';
  } else if (r.downgraded) {
    // A Suggestion-only Comment the presubmit still moved: there was no Approve to
    // lose and no blocker to hide, but the event did change and the user should see
    // it did.
    line += ' — downgraded by a presubmit check';
  }
  // Not a cap and not a downgrade — the Approve stands. But a bare confident
  // Approve from a run that drafted nothing on a real diff reads as evidence
  // of quality when it is only absence of signal, so the line says which
  // Approve this is. Both numbers are the run's own: the roster the plan
  // required (all on record, or coverage would have capped) and the plan's
  // source-line count.
  if (r.event === 'APPROVE' && r.lowSignal) {
    line +=
      ` — low signal: none of the ${r.lowSignal.agents} review agents ` +
      `reported a finding on a non-trivial diff ` +
      `(${r.lowSignal.srcDiffLines} source diff lines)`;
  }
  // Deferrals are findings the run stands behind and chose not to request;
  // a verdict line that omits them reads as "nothing was found" on exactly
  // the runs the posture targets. `lowSignal` is mutually exclusive with
  // this by construction — a deferrals-only APPROVE never sets it. The
  // "(listed in the body)" claim turns cap-aware past the rendered line
  // cap: a verdict counting 21 over a body listing 20 is a false record,
  // persisted into the composed JSON and the archived report.
  if (r.deferredCount > 0) {
    // Where they are must follow what the body actually carries: the budget
    // can drop the list whole, and "listed in the body" over a body listing
    // none is the same false record the line cap already refuses — stronger,
    // because it is N over zero. This line rides stderr, the composed JSON
    // and the archived report.
    const where = r.bodyTrim.deferralList
      ? 'trimmed from the body to fit GitHub’s limit — whole in the findings artifact'
      : `listed in the body${
          r.deferredCount > MAX_DEFERRED_SUGGESTION_LINES
            ? ', truncated — the rest are counted in the run report'
            : ''
        }`;
    line += ` — ${r.deferredCount} non-Critical finding(s) deferred under the convergence posture (${where})`;
  }
  // The enforcement is the CLI overriding what the drafted set was about to
  // post; the operator reading the terminal must see that the override
  // happened, or the drafted comments they watched Step 6 write silently
  // differ from what posted. Read tolerantly (`?.`): this function also
  // runs over parsed result JSONs, and one persisted before the field
  // existed must render its line, not throw over a feature it predates.
  if ((r.floorEnforced?.length ?? 0) > 0) {
    // "RESOLVED critical floor", like both sibling disclosure surfaces: the
    // enforcement also fires under `auto` from round 6 — and earlier once
    // the flat-trend streak engages the floor (#9903) — where no literal
    // critical floor exists in the invocation; the round resolved to one.
    line += ` — ${r.floorEnforced.length} of those moved by CLI floor enforcement (drafted inline past the resolved critical floor)`;
  }
  // Last, and phrased so the terminal line alone carries the ask: this is the
  // line the orchestrator prints verbatim, and on a CI-triggered review it may
  // be all a human reads before opening the PR.
  if (r.approachSignal) {
    line +=
      ` — round ${r.approachSignal.round}, diff grown ` +
      `${r.approachSignal.growth.toFixed(1)}x since first measured ` +
      `(${r.approachSignal.src0} → ${r.approachSignal.srcDiffLines} source diff lines); ` +
      `reconsider the approach, not only the findings`;
  }
  return line;
}
