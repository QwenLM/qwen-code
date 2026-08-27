/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review parse-args`: deterministic argument parsing for the /review
// skill. The flag grammar (`--comment`, `--effort <level>`, `--effort=<level>`)
// and the target disambiguation (PR number / PR URL / file path / local diff)
// used to live as prose in SKILL.md, which the model re-simulated on every
// run; three separate parsing bugs shipped that way. This module is the
// single source of truth: the skill passes the raw argument string in and
// uses the JSON verdict verbatim.
//
// Scope: pure argument classification only. Anything that needs repo state —
// matching a PR URL's owner/repo against `git remote -v`, checking that a
// file path exists — stays with the caller.

import type { CommandModule } from 'yargs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  writeStdoutLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';
import { tokenizeArgs } from '../../utils/shell-args.js';
import { operatorReviewSettings } from './lib/review-settings.js';
import { bundleStalenessNotices } from './lib/stale-bundle.js';
import { isAoneCanonicalHost } from './lib/remote-match.js';

export type ReviewEffort = 'low' | 'medium' | 'high';

/**
 * The posting floor for findings on a PR review: `critical` posts only
 * Critical findings (otherwise-postable high-confidence Suggestions are
 * recorded and deferred; low-confidence and Nice-to-have stay terminal-only
 * as ever), `suggestion` posts Criticals and Suggestions — today's behaviour. The floor governs what
 * the review PUBLISHES, never what it finds or verifies.
 */
export type ReviewSeverityFloor = 'critical' | 'suggestion';

/**
 * The review topology: which shape the run takes. `auto` is the standing
 * effort-driven pipeline (the 3A/3B/3C fan-outs). `minimal` is the A/B
 * comparison arm from issue #9783 — a single careful senior-engineer pass
 * over the diff in the orchestrator's own context, at most fifteen findings,
 * each carrying a concrete failure scenario; no subagent fan-out, no
 * verification, no reverse audit, no posting. It exists so the full pipeline
 * and the minimal prompt can be run over the same PR set and compared per
 * model. It is deliberately orthogonal to `effort` — it is a different
 * _shape_ of review, not a depth of the same one — and selecting it skips the
 * agent machinery (roster, coverage, budget) entirely rather than shrinking it.
 */
export type ReviewTopology = 'auto' | 'minimal';

export type ReviewTarget =
  | { type: 'pr-number'; number: number }
  | {
      type: 'pr-url';
      /** Canonicalized: lowercased scheme and host, query/fragment dropped. */
      url: string;
      host: string;
      owner: string;
      repo: string;
      /**
       * The FULL group path (`group/subgroup/project`) when the URL grammar
       * carries one — Aone nested-group repos. owner/repo collapse to the
       * last two segments, which is non-injective: identity gates
       * (match-remote, fetchDiff's origin guard) compare every segment when
       * both sides carry a path, so a same-named repo in a different group
       * can never pass as the target. Absent when the grammar holds exactly
       * two segments (GitHub).
       */
      groupPath?: string;
      number: number;
    }
  | { type: 'file'; path: string }
  | { type: 'local' };

export interface ParsedReviewArgs {
  target: ReviewTarget;
  /** Resolved effort after defaults and the `--comment` override. */
  effort: ReviewEffort;
  effortSource:
    | 'explicit'
    | 'configured'
    | 'default'
    | 'forced-by-comment'
    | 'forced-by-fix';
  comment: {
    /** `--comment` appeared in the arguments. */
    requested: boolean;
    /**
     * `--comment` applies (the target is a PR and it was requested — by the
     * flag, or by the standing `review.comment` setting).
     */
    effective: boolean;
  };
  /**
   * `--fix`: apply the confirmed findings to the working tree after reporting.
   *
   * Deliberately the mirror image of `--comment`, and gated on the opposite
   * targets. `--comment` writes to a pull request, so it needs a PR; `--fix`
   * writes to a **working tree**, so it needs one the user keeps. A PR review's
   * tree is the ephemeral worktree `fetch-pr` creates and Step 9 deletes — edits
   * there are discarded minutes later, and the one thing worse than not fixing
   * the findings is reporting that they were fixed into a directory that no
   * longer exists. So on a PR target `--fix` is ignored with a warning, exactly
   * as `--comment` is on a local one.
   */
  fix: {
    /** `--fix` appeared in the arguments. */
    requested: boolean;
    /** `--fix` applies (the target has a durable working tree). */
    effective: boolean;
  };
  /**
   * The posting floor, or `'auto'` — the round-adaptive default, resolved at
   * Step 6 where the round is known (`suggestion` through round 5, `critical`
   * from round 6). The parser cannot resolve `auto` itself: the round comes
   * from the previous posted round's ledger, which is not fetched yet. An
   * explicit `--severity-floor` on a non-PR target is ignored with a warning,
   * exactly as `--comment` is — the floor is a posting rule, and rounds exist
   * only for PRs.
   */
  severityFloor: ReviewSeverityFloor | 'auto';
  severityFloorSource: 'explicit' | 'configured' | 'default';
  /**
   * The review topology. `auto` (the default) runs the standing effort-driven
   * pipeline; `minimal` runs the single-pass A/B arm and, because it neither
   * posts, edits, nor continues an interrupted pipeline run, forces
   * `comment.effective`, `fix.effective`, and `resume.effective` to false.
   */
  topology: ReviewTopology;
  topologySource: 'explicit' | 'default';
  /** The `--host` flag's value, when present — recorded verbatim so the
   *  write gate can bind a recorded bare-number target's platform (the
   *  target itself carries no host in that spelling). */
  host?: string;
  /**
   * `--resume`: continue an interrupted run of this same target instead of
   * starting over — Step 1 passes it to `fetch-pr --resume`, which rules on
   * the on-disk state itself and silently falls back to a fresh run when the
   * state no longer matches. Gated on PR targets: only `fetch-pr` has a
   * resume path (a local review's diff is captured from a live working tree
   * that has no stable interrupted state to continue). `effective` is a
   * TARGET-SHAPE gate, not a promise: a cross-repo `pr-url` with no matching
   * remote routes to lightweight mode, which never calls `fetch-pr` — the
   * parser cannot see remotes, so Step 1's lightweight branch owns telling
   * the user the flag is inert there.
   */
  resume: {
    /** `--resume` appeared in the arguments. */
    requested: boolean;
    /** `--resume` applies (the target is a PR). */
    effective: boolean;
  };
  /** Non-flag tokens beyond the first target token, reported not guessed. */
  extraTokens: string[];
  /** Unrecognized `--flags`, reported not guessed. */
  unknownFlags: string[];
  warnings: string[];
}

export const EFFORT_LEVELS: ReadonlySet<string> = new Set([
  'low',
  'medium',
  'high',
]);

/**
 * The `--effort` option for the three capture commands (fetch-pr,
 * capture-local, plan-diff), defined once: its describe names what `medium`
 * drops from the roster, so a roster change edits one string, not three
 * byte-identical copies that can silently diverge. `run` and `save-artifact`
 * keep their own shapes (per-target defaults; a resolved value without `low`).
 */
export const EFFORT_OPTION = {
  type: 'string',
  choices: [...EFFORT_LEVELS],
  describe:
    'The review effort. `medium` (balanced) drops the adversarial ' +
    'personas (6a/6b/6c), the counter-frame audit (6d) and the ' +
    'language-pitfall and wrapper/proxy specialists (1d/1e) from the ' +
    'required roster; recorded in the plan ' +
    'so check-coverage, agent-prompt --roster and compose-review all ' +
    'read one value. Omit for the full (high) roster.',
} as const;

export const SEVERITY_FLOORS: ReadonlySet<string> = new Set([
  'critical',
  'suggestion',
  // `auto` is a legal EXPLICIT value too — it is the schema-enumerated
  // default's name, so an operator typing `--severity-floor auto` means
  // "the round-adaptive rule" (overriding a configured floor), not a typo
  // to reject and then promote into a bogus file target.
  'auto',
]);

export const TOPOLOGIES: ReadonlySet<string> = new Set([
  'minimal',
  // `auto` is a legal EXPLICIT value for the same reason it is for
  // `--severity-floor`: typing `--topology auto` means "the standing
  // effort-driven pipeline", not a typo to reject.
  'auto',
]);

// The verdict's owner/repo/number are interpolated into `gh` commands by the
// caller, so they must be established trustworthily, not merely extracted:
// the scheme is case-insensitive, the number must END at the path segment
// (`/pull/42oops` is not PR 42), and owner/repo are restricted to GitHub's
// name charset — which as a side effect keeps shell metacharacters out of
// every derived value.
const PR_URL_RE =
  /^(https?):\/\/([A-Za-z0-9.-]+(?::\d+)?)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?=$|[/?#])/i;

// Aone Code CR URLs: `https://code.alibaba-inc.com/<group>[/subgroup…]/<project>/codereview/<global-id>`.
// The trailing number is the global MR id (what the Aone refspec and `a1 mr
// view` key on), carried as the target's `number` exactly like a GitHub PR
// number; when this host is passed on to the subcommands as `--host`, it
// decides the platform (the hint beats the cwd probe) — only WITHOUT a hint
// does detection fall back to the clone's origin remote.
// The group path may be nested (`group/subgroup/project`) — the repo identity
// keeps the last two segments, mirroring aone.parseRemoteUrl. Unlike
// `…/pull/<n>` (which any GHE host legitimately serves), the host is
// constrained to a REAL Aone subdomain: `(?:[A-Za-z0-9-]+\.)+alibaba-inc.com`
// requires a dot boundary, so lookalikes (`evilalibaba-inc.com`,
// `notalibaba-inc.com`) hit the fail-closed invalid-url refusal instead of
// becoming live targets. The family capture is shape-first only — the
// classifier additionally gates the match on the CANONICAL pair
// (isAoneCanonicalHost), so a family-only GHE host's `/codereview/` URL
// stays `invalid-url` instead of becoming a misrouted live target.
const AONE_CR_URL_RE =
  /^(https?):\/\/((?:[A-Za-z0-9-]+\.)+alibaba-inc\.com(?::\d+)?)\/((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)\/codereview\/(\d+)(?=$|[/?#])/i;

/**
 * Case-insensitive: `--effort High` has exactly one plausible meaning, and
 * classifying `High` as a file-path target (as a case-sensitive match once
 * did) sends the caller off to stat a file that does not exist. The verdict
 * always carries the lowercase form.
 */
function asEffort(value: string): ReviewEffort | null {
  const lower = value.toLowerCase();
  return EFFORT_LEVELS.has(lower) ? (lower as ReviewEffort) : null;
}

function asSeverityFloor(value: string): ReviewSeverityFloor | 'auto' | null {
  const lower = value.toLowerCase();
  return SEVERITY_FLOORS.has(lower)
    ? (lower as ReviewSeverityFloor | 'auto')
    : null;
}

function asTopology(value: string): ReviewTopology | null {
  const lower = value.toLowerCase();
  return TOPOLOGIES.has(lower) ? (lower as ReviewTopology) : null;
}

/**
 * Single-dash tokens count as flags too: `-c` is never a plausible review
 * target, and classifying it as a file path demoted the real target the
 * user typed right after it into `extraTokens`.
 */
function isFlag(token: string): boolean {
  return token.length > 1 && token.startsWith('-');
}

function isPureInteger(token: string): boolean {
  return /^\d+$/.test(token);
}

/** A token that classifies as a PR target (number or PR URL). */
function isPrShapedToken(token: string): boolean {
  const shape = classifyToken(token);
  return (
    shape !== null &&
    shape !== 'invalid-url' &&
    (shape.type === 'pr-number' || shape.type === 'pr-url')
  );
}

// tokenizeArgs lives in the CLI-level shared home (utils/shell-args.ts) so
// /audit consumes it without importing across command groups.
export { tokenizeArgs } from '../../utils/shell-args.js';

/**
 * `'invalid-url'` marks a token that looks like a URL but is not a valid PR
 * URL. It must not fall through to the `file` classification — a target the
 * user typed as a URL is never a file path, and guessing one would send the
 * caller off to stat a nonsense path instead of surfacing the typo.
 */
function classifyToken(token: string): ReviewTarget | 'invalid-url' | null {
  if (isFlag(token)) return null;
  if (isPureInteger(token)) {
    return { type: 'pr-number', number: Number(token) };
  }
  const urlMatch = PR_URL_RE.exec(token);
  if (urlMatch) {
    const [, scheme, host, owner, repo, num] = urlMatch;
    const lowerHost = host.toLowerCase();
    // Aone serves no `/pull/` pages — a `/pull/<n>` URL on a CANONICAL Aone
    // host is a fabrication (the Aone CR grammar is `…/codereview/<id>`,
    // keyed on the global MR id). Refuse it fail-closed, mirroring the
    // Aone-only constraint on `/codereview/` (a non-Aone host there is
    // refused too). The canonical pair only: a `*.alibaba-inc.com` GHE
    // instance (`ghe.alibaba-inc.com`) legitimately serves `/pull/` pages,
    // and the family wildcard once refused its real PR URLs.
    if (isAoneCanonicalHost(lowerHost)) return 'invalid-url';
    return {
      type: 'pr-url',
      url: `${scheme.toLowerCase()}://${lowerHost}/${owner}/${repo}/pull/${Number(num)}`,
      host: lowerHost,
      owner,
      repo,
      number: Number(num),
    };
  }
  const aoneMatch = AONE_CR_URL_RE.exec(token);
  if (aoneMatch) {
    const [, scheme, host, groupPath, num] = aoneMatch;
    const lowerHost = host.toLowerCase();
    // A `/codereview/` page exists only on the CANONICAL Aone pair. The
    // grammar above deliberately captures the whole family (shape-first),
    // but a family-only host is a GHE instance: accepting its
    // `/codereview/` URL as a live target would let detection route the
    // explicit GHE host to GitHub and aim fetch/submit at GHE PR #<id> —
    // a target the supplied URL never named as a valid GHE resource.
    // Fail closed, mirroring the `/pull/`-on-Aone refusal above.
    if (!isAoneCanonicalHost(lowerHost)) return 'invalid-url';
    // Nested-group repos collapse to the last two segments (mirroring
    // aone.parseRemoteUrl), so `…/sub/maxcompute/odps_src/codereview/N`
    // yields owner `maxcompute`, repo `odps_src`.
    const segs = groupPath.split('/').filter(Boolean);
    const owner = segs[segs.length - 2];
    const repo = segs[segs.length - 1];
    return {
      type: 'pr-url',
      // The canonicalized URL keeps the FULL path — a collapsed spelling
      // would name a different (possibly nonexistent) repo to anything
      // that re-reads it.
      url: `${scheme.toLowerCase()}://${lowerHost}/${segs.join('/')}/codereview/${Number(num)}`,
      host: lowerHost,
      owner,
      repo,
      // Aone targets carry the FULL path — even two-segment ones: the
      // URL pins an exact repo, and the identity gates must compare it
      // against nested-group remotes in BOTH directions (a two-segment
      // target must not match a three-segment remote sharing its tail,
      // nor the reverse).
      groupPath: segs.join('/'),
      number: Number(num),
    };
  }
  if (/^https?:\/\//i.test(token)) return 'invalid-url';
  return { type: 'file', path: token };
}

export function parseReviewArgs(
  raw: string,
  defaults: {
    /**
     * The standing default from `review.effort`, raw (`auto` already mapped
     * to undefined by the caller), applied when no `--effort` flag is
     * present. Validated case-insensitively exactly like an explicit flag —
     * an invalid value warns and falls back instead of dropping silently.
     * An explicit flag still wins; the `--comment`/`--fix` forcings still
     * override it.
     */
    effort?: string;
    /**
     * The standing `review.comment` setting: treat a PR review as if
     * `--comment` was passed. The target binding is untouched — the run still
     * authorises only the PR the arguments name.
     */
    comment?: boolean;
    /**
     * The standing `review.severityFloor` setting, raw (`auto` already mapped
     * to undefined by the caller). Validated exactly like the flag — a typo
     * warns and falls back to the round-adaptive default.
     */
    severityFloor?: string;
  } = {},
): ParsedReviewArgs {
  const tokens = tokenizeArgs(raw);
  const warnings: string[] = [];
  const unknownFlags: string[] = [];

  let commentRequestedByFlag = false;
  let fixRequested = false;
  let resumeRequested = false;
  let explicitEffort: ReviewEffort | null = null;
  let explicitFloor: ReviewSeverityFloor | 'auto' | null = null;
  let explicitTopology: ReviewTopology | null = null;
  let recordedHostFlag: string | undefined;

  // The configured default gets the same validation as an explicit flag:
  // settings loading performs no enum validation, so a hand-edited typo
  // reaches this far raw. Discarding it silently would run every review at
  // the built-in default while the operator believes another level is on —
  // the flag path warns on the identical typo, so this one does too.
  let configuredEffort: ReviewEffort | undefined;
  let invalidConfiguredEffort: string | undefined;
  if (defaults.effort !== undefined) {
    const normalized = asEffort(defaults.effort);
    if (normalized !== null) {
      configuredEffort = normalized;
    } else {
      invalidConfiguredEffort = defaults.effort;
    }
  }
  let configuredFloor: ReviewSeverityFloor | undefined;
  let invalidConfiguredFloor: string | undefined;
  if (defaults.severityFloor !== undefined) {
    const normalized = asSeverityFloor(defaults.severityFloor);
    if (normalized === 'auto') {
      // The default's own name: the same round-adaptive rule as an unset
      // setting. The settings caller pre-maps it, but a direct caller must
      // get identical semantics.
    } else if (normalized !== null) {
      configuredFloor = normalized;
    } else {
      invalidConfiguredFloor = defaults.severityFloor;
    }
  }

  // Warnings about a rejected `--effort` occurrence must state what effort
  // is ACTUALLY in effect — which is not known until every occurrence is
  // seen (a later valid one wins) and the `--comment` override has run. So
  // rejected occurrences are recorded here and their warnings composed at
  // the end; emitting "using the default effort" inline once told the user
  // the default applied while an earlier valid `--effort low` stayed active.
  type EffortIssue =
    | { kind: 'invalid-eq'; value: string }
    | { kind: 'missing' }
    | { kind: 'discarded'; value: string }
    | { kind: 'kept-as-target'; value: string };
  const effortIssues: EffortIssue[] = [];
  // `--severity-floor` shares the value-token grammar and therefore the same
  // deferred-warning problem; its issues are a separate list because its
  // resolution sentence is its own.
  const floorIssues: EffortIssue[] = [];
  // `--topology` shares the value-token grammar too, for the same reason.
  const topologyIssues: EffortIssue[] = [];

  // First pass: pull out flags (and each value-taking flag's value token,
  // when the spaced form legitimately consumes one). Non-flag tokens are kept
  // in order; invalid spaced values are kept as *candidates* whose disposal
  // is decided after we know whether any other token is the target.
  interface Kept {
    token: string;
    /** Set when this token arrived as an invalid value of the named flag. */
    invalidValueOf?: '--effort' | '--severity-floor' | '--topology';
  }
  const kept: Kept[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === '--comment') {
      commentRequestedByFlag = true;
      continue;
    }

    if (token === '--fix') {
      fixRequested = true;
      continue;
    }

    if (token === '--host' || token.startsWith('--host=')) {
      // Recorded verbatim for the write gate's platform binding; the value
      // is consumed either way and never leaks into the target tokens.
      if (token.includes('=')) {
        const value = token.slice(token.indexOf('=') + 1);
        if (value !== '') recordedHostFlag = value;
        continue;
      }
      const next = i + 1 < tokens.length ? tokens[i + 1] : undefined;
      if (next !== undefined && next !== '' && !isFlag(next)) {
        recordedHostFlag = next;
        i++;
      }
      continue;
    }
    if (token === '--resume') {
      resumeRequested = true;
      continue;
    }

    if (token === '--effort' || token.startsWith('--effort=')) {
      if (token.includes('=')) {
        // `--effort=<value>`: self-contained; never consumes a second token.
        const value = token.slice(token.indexOf('=') + 1);
        const effortValue = asEffort(value);
        if (effortValue !== null) {
          explicitEffort = effortValue;
        } else if (value !== '' && isPrShapedToken(value)) {
          // A PR-shaped value in either flag syntax is the same typo of the
          // same intent — it joins the disposal pool exactly as the spaced
          // form does, so which codebase gets reviewed cannot depend on
          // which syntax happened to be typed (round-8 review finding).
          kept.push({ token: value, invalidValueOf: '--effort' });
        } else {
          effortIssues.push({ kind: 'invalid-eq', value });
        }
        continue;
      }
      const next = i + 1 < tokens.length ? tokens[i + 1] : undefined;
      const nextEffort = next !== undefined ? asEffort(next) : null;
      if (nextEffort !== null) {
        explicitEffort = nextEffort;
        i++;
        continue;
      }
      // A quoted-empty value ('' survives tokenization) is a missing value,
      // not a candidate — and it is CONSUMED, or the leftover '' token would
      // classify as an empty-string file target.
      if (next === '') {
        effortIssues.push({ kind: 'missing' });
        i++;
        continue;
      }
      if (next === undefined || isFlag(next)) {
        // Flag-final, or followed by another flag: the value is simply
        // missing. Never consume a flag as a value.
        effortIssues.push({ kind: 'missing' });
        continue;
      }
      // Spaced form with an invalid non-flag value. Whether `next` is a
      // discarded typo or the review target is decided below, once we know
      // whether any other token can be the target.
      kept.push({ token: next, invalidValueOf: '--effort' });
      i++;
      continue;
    }

    if (token === '--severity-floor' || token.startsWith('--severity-floor=')) {
      if (token.includes('=')) {
        const value = token.slice(token.indexOf('=') + 1);
        const floorValue = asSeverityFloor(value);
        if (floorValue !== null) {
          explicitFloor = floorValue;
        } else if (value !== '' && isPrShapedToken(value)) {
          kept.push({ token: value, invalidValueOf: '--severity-floor' });
        } else {
          floorIssues.push({ kind: 'invalid-eq', value });
        }
        continue;
      }
      const next = i + 1 < tokens.length ? tokens[i + 1] : undefined;
      const nextFloor = next !== undefined ? asSeverityFloor(next) : null;
      if (nextFloor !== null) {
        explicitFloor = nextFloor;
        i++;
        continue;
      }
      if (next === '') {
        floorIssues.push({ kind: 'missing' });
        i++;
        continue;
      }
      if (next === undefined || isFlag(next)) {
        floorIssues.push({ kind: 'missing' });
        continue;
      }
      kept.push({ token: next, invalidValueOf: '--severity-floor' });
      i++;
      continue;
    }

    if (token === '--topology' || token.startsWith('--topology=')) {
      if (token.includes('=')) {
        const value = token.slice(token.indexOf('=') + 1);
        const topologyValue = asTopology(value);
        if (topologyValue !== null) {
          explicitTopology = topologyValue;
        } else if (value !== '' && isPrShapedToken(value)) {
          kept.push({ token: value, invalidValueOf: '--topology' });
        } else {
          topologyIssues.push({ kind: 'invalid-eq', value });
        }
        continue;
      }
      const next = i + 1 < tokens.length ? tokens[i + 1] : undefined;
      const nextTopology = next !== undefined ? asTopology(next) : null;
      if (nextTopology !== null) {
        explicitTopology = nextTopology;
        i++;
        continue;
      }
      if (next === '') {
        topologyIssues.push({ kind: 'missing' });
        i++;
        continue;
      }
      if (next === undefined || isFlag(next)) {
        topologyIssues.push({ kind: 'missing' });
        continue;
      }
      kept.push({ token: next, invalidValueOf: '--topology' });
      i++;
      continue;
    }

    if (isFlag(token)) {
      unknownFlags.push(token);
      warnings.push(`Unrecognized flag ${JSON.stringify(token)}; ignored.`);
      continue;
    }

    kept.push({ token });
  }

  // Disposal rule for invalid flag values, by what the token could BE:
  // - PR-shaped (a pure number, a PR URL) survives as a target candidate —
  //   `/review --effort 6711` is a user reviewing PR 6711 past a flag
  //   mistake, and an unrelated second typo (`--severity-floor blocker
  //   --effort 6711`) must not change WHICH codebase is reviewed.
  // - File-shaped survives only as the SOLE kept token (`/review
  //   --severity-floor criticl`): beside anything else, `blocker` is an
  //   enum typo, not a path — promoting it would send the caller off to
  //   stat nonsense, and two such typos are two typos, not a target and a
  //   tiebreak.
  // A token the user typed OUTSIDE any flag always outranks a flag value:
  // when one exists, every invalid value is a typo beside the real target.
  // And a PR-shaped rescue must be UNIQUE: two PR-shaped values arriving as
  // invalid flag values (`--severity-floor 6711 --effort 6712`) are an
  // ambiguous invocation — silently reviewing the first would review the
  // wrong PR half the time, so both are refused, loudly, and the review
  // falls back to the local diff nothing contradicted.
  const soleCandidate = kept.length === 1;
  const isPrShaped = isPrShapedToken;
  const isPrUrlToken = (token: string): boolean => {
    const c = classifyToken(token);
    return c !== null && c !== 'invalid-url' && c.type === 'pr-url';
  };
  // The pool counts BOTH spellings: an `=`-form invalid value never enters
  // `kept` (it was recorded as `invalid-eq` and consumed in place), but it
  // is the same typed PR number — `--severity-floor=6711 --effort 6712`
  // must be exactly as ambiguous as the all-spaced spelling, or the guard
  // is defeated by which syntax happened to be typed.
  // Distinct TARGETS, not distinct strings: `--severity-floor 6711 --effort
  // https://github.com/o/r/pull/6711` are two spellings of one PR and are
  // unambiguous (round-9 finding: a raw-token Set read them as two and
  // silently fell back to the local tree — the very harm the guard exists
  // to prevent). The identity is the classified target's number plus, for
  // a URL, its host/owner/repo. Both flag syntaxes already landed in `kept`
  // above, so the pool sees every spelling.
  const targetKey = (token: string): string => {
    const shape = classifyToken(token);
    if (shape === null || shape === 'invalid-url') return `raw:${token}`;
    if (shape.type === 'pr-number') return `pr:${shape.number}`;
    if (shape.type === 'pr-url')
      // The FULL group path, not the collapsed owner/repo: two nested-group
      // CR URLs that share their last two segments and the global id
      // (`groupA/sub/app` vs `groupB/sub/app`, same N) are DIFFERENT
      // targets and must not dedupe into one.
      return `pr:${shape.number}@${shape.host}/${shape.groupPath ?? `${shape.owner}/${shape.repo}`}`;
    return `raw:${token}`;
  };
  const prShapedKeys = [
    ...new Set(
      kept
        .filter((k) => k.invalidValueOf !== undefined && isPrShaped(k.token))
        .map((k) => targetKey(k.token)),
    ),
  ];
  // Distinct TARGETS. A bare number and a same-number URL name one PR when
  // no other repo is in play (the bare entry merges into the URL's key),
  // but two DIFFERENT repo-qualified keys with the same number name two
  // PRs — the number-only collapse once silently deduped them.
  const distinctPr = new Set<string>();
  for (const k of prShapedKeys) {
    const bare = k.split('@')[0];
    if (k.includes('@')) {
      // Repo-qualified keys are distinct PRs; one subsumes a bare
      // same-number entry already in the set.
      if (distinctPr.has(bare)) distinctPr.delete(bare);
      distinctPr.add(k);
    } else if (
      ![...distinctPr].some((e) => e === bare || e.startsWith(`${bare}@`))
    ) {
      distinctPr.add(k);
    }
  }
  // VALID CANDIDATES, with the mixed-shape restatement carved out: when the
  // rescue pool holds exactly one distinct PR and a URL spelling of it
  // arrived as an invalid flag value, a POSITIONAL bare number of the same
  // PR restates that PR — it is not a competing valid candidate. Letting it
  // rank as one discarded the URL (the sole carrier of host/platform
  // identity) and retargeted the run onto the cwd clone's same-number PR —
  // `--effort <cr-url> 7` reviewed (and could POST to) the wrong platform
  // (round-12 finding). A DIFFERENT number still outranks, as the user
  // typed it outside any flag.
  const poolKey = distinctPr.size === 1 ? [...distinctPr][0] : undefined;
  const poolPrNumber =
    poolKey !== undefined
      ? Number(poolKey.split('@')[0].replace(/^pr:/, ''))
      : undefined;
  const poolHasUrlSpelling =
    poolPrNumber !== undefined &&
    kept.some((k) => k.invalidValueOf !== undefined && isPrUrlToken(k.token));
  const hasValidCandidate = kept.some((k) => {
    if (k.invalidValueOf !== undefined) return false;
    if (poolHasUrlSpelling) {
      const c = classifyToken(k.token);
      if (
        c !== null &&
        c !== 'invalid-url' &&
        c.type === 'pr-number' &&
        c.number === poolPrNumber
      ) {
        return false;
      }
    }
    return true;
  });
  if (!hasValidCandidate && distinctPr.size > 1) {
    const shown = kept
      .filter((k) => k.invalidValueOf !== undefined && isPrShaped(k.token))
      .map((k) => JSON.stringify(k.token));
    warnings.push(
      `Ambiguous target: ${shown.join(' and ')} arrived as invalid flag values and name different PRs; refusing to choose between them.`,
    );
  }
  const targetTokens: string[] = [];
  // Of several spellings of the SAME rescued PR, exactly one becomes the
  // target; the rest are the same intent restated, not extra arguments —
  // pushing them all left the operator told "Ignoring extra argument(s)"
  // on the very invocation the dedupe blesses (round-9 finding).
  //
  // The repo-qualified URL spelling OUTRANKS the bare number as the
  // rescued target: it is the only carrier of host/platform identity. A
  // bare-number target flips detection onto the cwd fallback, and the run
  // silently reviews the cwd clone's same-number PR instead of the named
  // platform's — which spelling won depending on token order (round-10
  // finding: a loud refusal at the merge base degraded to a silent
  // wrong-platform retarget).
  const preferredRescueToken =
    !hasValidCandidate && distinctPr.size === 1
      ? kept.find(
          (k) => k.invalidValueOf !== undefined && isPrUrlToken(k.token),
        )?.token
      : undefined;
  // Each flag's deferred-warning list, keyed by the flag an invalid value
  // arrived as; resolved inside the guard below, where `invalidValueOf` is
  // known to be set.
  const issueListFor = {
    '--effort': effortIssues,
    '--severity-floor': floorIssues,
    '--topology': topologyIssues,
  };
  let rescuedPr = false;
  for (const k of kept) {
    if (k.invalidValueOf !== undefined) {
      const issues = issueListFor[k.invalidValueOf];
      const survives = isPrShaped(k.token)
        ? !hasValidCandidate && distinctPr.size === 1
        : soleCandidate;
      if (!survives) {
        issues.push({ kind: 'discarded', value: k.token });
        continue;
      }
      if (isPrShaped(k.token)) {
        if (rescuedPr) continue; // same PR, restated — not an extra token
        // A bare number may not become the rescued target while the
        // same-PR URL spelling is present — the URL carries the identity.
        if (
          preferredRescueToken !== undefined &&
          k.token !== preferredRescueToken &&
          !isPrUrlToken(k.token)
        ) {
          continue;
        }
        rescuedPr = true;
      }
      issues.push({ kind: 'kept-as-target', value: k.token });
    }
    targetTokens.push(k.token);
  }
  // Same preference for positional spellings: when the target tokens hold
  // both a bare number and a same-number PR URL, the URL becomes the
  // target regardless of arrival order.
  const urlIdx = targetTokens.findIndex(isPrUrlToken);
  if (urlIdx > 0) {
    const [urlToken] = targetTokens.splice(urlIdx, 1);
    targetTokens.unshift(urlToken);
  }

  // Pick the first classifiable target token. A token that looks like a URL
  // but is not a valid PR URL is refused, not guessed at: it goes into
  // `extraTokens` with its own warning instead of becoming the target.
  let target: ReviewTarget = { type: 'local' };
  let targetAssigned = false;
  const extraTokens: string[] = [];
  const trailingExtras: string[] = [];
  for (const tok of targetTokens) {
    if (targetAssigned) {
      // A bare number restating the assigned URL target's number is the
      // same intent restated, not an extra argument (mirror of the
      // rescue loop's restatement handling).
      const classifiedRestate = classifyToken(tok);
      if (
        target.type === 'pr-url' &&
        classifiedRestate !== null &&
        classifiedRestate !== 'invalid-url' &&
        classifiedRestate.type === 'pr-number' &&
        classifiedRestate.number === target.number
      ) {
        continue;
      }
      extraTokens.push(tok);
      trailingExtras.push(tok);
      continue;
    }
    const classified = classifyToken(tok);
    if (classified === 'invalid-url') {
      warnings.push(
        `Unrecognized URL ${JSON.stringify(tok)} — not a PR/CR URL (expected …/pull/<number> or …/codereview/<id>); refusing to guess a target from it.`,
      );
      extraTokens.push(tok);
      continue;
    }
    target = classified ?? { type: 'local' };
    targetAssigned = true;
  }
  if (trailingExtras.length > 0) {
    warnings.push(
      `Ignoring extra argument(s): ${trailingExtras.map((t) => JSON.stringify(t)).join(', ')}.`,
    );
  }

  const isPr = target.type === 'pr-number' || target.type === 'pr-url';

  // The topology resolves like the effort — an explicit flag beats the
  // standing `auto` default. There is no configured (settings) topology: the
  // minimal arm is an explicit A/B comparison, never a background default.
  const topology: ReviewTopology = explicitTopology ?? 'auto';
  const topologySource: ParsedReviewArgs['topologySource'] =
    explicitTopology !== null ? 'explicit' : 'default';
  // The minimal arm is terminal-only — it neither posts to a PR nor edits a
  // working tree — so both write operations are gated off it, and so is
  // `--resume`: a fresh single pass cannot continue an interrupted pipeline
  // run, and letting `fetch-pr --resume` consume that state would destroy a
  // run this arm never continues. This keeps the guarantee in code rather
  // than in whichever prose the orchestrator reads.
  const isMinimal = topology === 'minimal';

  const commentRequested = commentRequestedByFlag || defaults.comment === true;
  const commentEffective = commentRequested && isPr && !isMinimal;
  if (commentRequestedByFlag && !isPr) {
    warnings.push(
      'Warning: `--comment` flag is ignored because the review target is not a PR.',
    );
  } else if (commentRequested && isPr && isMinimal) {
    // Only when minimal is THE reason a would-be-effective comment is
    // suppressed: on a non-PR target the comment does not apply anyway, and
    // that case keeps its usual handling above. The text names the source
    // the request actually came from, the same distinction the
    // forced-by-comment warning makes: a setting-driven operator told the
    // `--comment` flag is ignored goes hunting a flag they never typed.
    warnings.push(
      commentRequestedByFlag
        ? 'Warning: `--comment` is ignored because `--topology minimal` is terminal-only — the minimal arm posts nothing.'
        : 'Warning: the `review.comment` setting is ignored because `--topology minimal` is terminal-only — the minimal arm posts nothing.',
    );
  }

  const resumeEffective = resumeRequested && isPr && !isMinimal;
  if (resumeRequested && !isPr) {
    warnings.push(
      'Warning: `--resume` flag is ignored because the review target is not a PR — only a PR review has interrupted state to continue.',
    );
  } else if (resumeRequested && isPr && isMinimal) {
    warnings.push(
      'Warning: `--resume` is ignored because `--topology minimal` runs a fresh single pass — it neither continues nor consumes an interrupted run.',
    );
  }

  // `--fix` edits a working tree, so it needs one that outlives the review. A
  // PR review's tree is the ephemeral worktree Step 9 removes; a `local` or
  // `file` review's tree is the user's own checkout.
  const fixEffective = fixRequested && !isPr && !isMinimal;
  if (fixRequested && isPr) {
    warnings.push(
      'Warning: `--fix` flag is ignored because a PR review runs in an ephemeral ' +
        'worktree that is deleted when the review ends — there is no durable tree to ' +
        'fix. Use `--comment` to publish the findings instead.',
    );
  } else if (fixRequested && isMinimal) {
    warnings.push(
      'Warning: `--fix` is ignored because `--topology minimal` is terminal-only — the minimal arm edits nothing.',
    );
  }

  let effort: ReviewEffort;
  let effortSource: ParsedReviewArgs['effortSource'];
  if (explicitEffort !== null) {
    effort = explicitEffort;
    effortSource = 'explicit';
  } else if (configuredEffort !== undefined) {
    effort = configuredEffort;
    effortSource = 'configured';
  } else {
    effort = isPr ? 'high' : 'medium';
    effortSource = 'default';
  }
  // Posting requires a verified review: an *effective* --comment forces
  // high. An ignored --comment (non-PR target) must not change the effort.
  if (commentEffective && effort !== 'high') {
    effort = 'high';
    effortSource = 'forced-by-comment';
    warnings.push(
      commentRequestedByFlag
        ? '`--comment` requires a verified review; running at high effort.'
        : '`review.comment` is enabled in settings; posting requires a verified review — running at high effort.',
    );
  }
  // Editing the user's files on the strength of an unverified finding is the
  // same mistake as posting one, aimed at their working tree instead of a pull
  // request — and low is unverified by construction (it runs no Step 4). So an
  // effective `--fix` floors the effort at medium, the cheapest tier whose
  // findings a verifier has ruled on. It does NOT force high: medium's findings
  // are verified, and the reverse audit high adds looks for findings that are
  // missing, which is not what deciding whether to apply one turns on.
  //
  // `--fix` and `--comment` cannot both be effective — they require opposite
  // target types — so these two blocks can never fight over the level.
  if (fixEffective && effort === 'low') {
    effort = 'medium';
    effortSource = 'forced-by-fix';
    warnings.push(
      '`--fix` edits your working tree, so it requires verified findings; running at medium effort.',
    );
  }

  // Now the resolution is final; compose the deferred effort warnings so
  // each states what is actually in effect.
  const resolution =
    effortSource === 'explicit'
      ? `--effort ${effort} (the last valid occurrence) is in effect`
      : effortSource === 'forced-by-comment'
        ? commentRequestedByFlag
          ? '`--comment` forces high effort'
          : 'the `review.comment` setting forces high effort'
        : effortSource === 'forced-by-fix'
          ? '`--fix` forces at least medium effort'
          : effortSource === 'configured'
            ? 'using the configured review.effort'
            : 'using the default effort';
  for (const issue of effortIssues) {
    switch (issue.kind) {
      case 'invalid-eq':
        warnings.push(
          `Invalid --effort value ${JSON.stringify(issue.value)}; ${resolution}.`,
        );
        break;
      case 'missing':
        warnings.push(`--effort requires a value; ${resolution}.`);
        break;
      case 'discarded':
        warnings.push(
          `Invalid --effort value ${JSON.stringify(issue.value)} discarded; ${resolution}.`,
        );
        break;
      case 'kept-as-target':
        warnings.push(
          `Invalid --effort value ${JSON.stringify(issue.value)}; treating it as the review target — ${resolution}.`,
        );
        break;
      default:
        break;
    }
  }
  if (invalidConfiguredEffort !== undefined) {
    warnings.push(
      `Invalid review.effort value ${JSON.stringify(invalidConfiguredEffort)} in settings; ${resolution}.`,
    );
  }

  // The floor resolves like the effort — explicit flag over configured
  // setting over the built-in default — except the default is `auto`: the
  // round-adaptive rule, which only Step 6 can resolve (the round comes from
  // the previous posted round's ledger, not fetched yet). Non-PR gating
  // mirrors `--comment`: the floor is a posting rule and rounds exist only
  // for PRs, so an explicit flag on a local/file target warns and is
  // ignored, and a configured setting is silently inert there.
  let severityFloor: ReviewSeverityFloor | 'auto' = 'auto';
  let severityFloorSource: ParsedReviewArgs['severityFloorSource'] = 'default';
  if (explicitFloor !== null && !isPr) {
    warnings.push(
      'Warning: `--severity-floor` flag is ignored because the review target is not a PR.',
    );
  } else if (explicitFloor !== null) {
    severityFloor = explicitFloor;
    severityFloorSource = 'explicit';
  } else if (configuredFloor !== undefined && isPr) {
    severityFloor = configuredFloor;
    severityFloorSource = 'configured';
  }
  const floorResolution =
    severityFloorSource === 'explicit'
      ? `--severity-floor ${severityFloor} (the last valid occurrence) is in effect`
      : severityFloorSource === 'configured'
        ? 'using the configured review.severityFloor'
        : 'using the round-adaptive default';
  for (const issue of floorIssues) {
    switch (issue.kind) {
      case 'invalid-eq':
        warnings.push(
          `Invalid --severity-floor value ${JSON.stringify(issue.value)}; ${floorResolution}.`,
        );
        break;
      case 'missing':
        warnings.push(`--severity-floor requires a value; ${floorResolution}.`);
        break;
      case 'discarded':
        warnings.push(
          `Invalid --severity-floor value ${JSON.stringify(issue.value)} discarded; ${floorResolution}.`,
        );
        break;
      case 'kept-as-target':
        warnings.push(
          `Invalid --severity-floor value ${JSON.stringify(issue.value)}; treating it as the review target — ${floorResolution}.`,
        );
        break;
      default:
        break;
    }
  }
  if (invalidConfiguredFloor !== undefined && isPr) {
    warnings.push(
      `Invalid review.severityFloor value ${JSON.stringify(invalidConfiguredFloor)} in settings; ${floorResolution}.`,
    );
  }

  // The topology's deferred warnings, composed now that the resolution is
  // final — the same shape as the effort's and the floor's.
  const topologyResolution =
    topologySource === 'explicit'
      ? `--topology ${topology} (the last valid occurrence) is in effect`
      : 'using the default topology (auto)';
  for (const issue of topologyIssues) {
    switch (issue.kind) {
      case 'invalid-eq':
        warnings.push(
          `Invalid --topology value ${JSON.stringify(issue.value)}; ${topologyResolution}.`,
        );
        break;
      case 'missing':
        warnings.push(`--topology requires a value; ${topologyResolution}.`);
        break;
      case 'discarded':
        warnings.push(
          `Invalid --topology value ${JSON.stringify(issue.value)} discarded; ${topologyResolution}.`,
        );
        break;
      case 'kept-as-target':
        warnings.push(
          `Invalid --topology value ${JSON.stringify(issue.value)}; treating it as the review target — ${topologyResolution}.`,
        );
        break;
      default:
        break;
    }
  }

  return {
    target,
    effort,
    effortSource,
    comment: { requested: commentRequestedByFlag, effective: commentEffective },
    fix: { requested: fixRequested, effective: fixEffective },
    severityFloor,
    severityFloorSource,
    topology,
    topologySource,
    ...(recordedHostFlag !== undefined ? { host: recordedHostFlag } : {}),
    resume: { requested: resumeRequested, effective: resumeEffective },
    extraTokens,
    unknownFlags,
    warnings,
  };
}

interface ParseArgsCliArgs {
  raw: string | undefined;
  stdin: boolean | undefined;
  out: string | undefined;
}

/**
 * The standing defaults from `settings.json` (`review.effort`,
 * `review.comment`), resolved for `parseReviewArgs`: `auto` effort — matched
 * case-insensitively, like every other value on this path — means the
 * built-in rule, so it maps to undefined. Any other value passes through
 * raw — `parseReviewArgs` validates it exactly like an explicit `--effort`
 * (case normalization included), so a typo warns instead of dropping
 * silently.
 */
function reviewDefaultsFromSettings(): {
  effort?: string;
  comment?: boolean;
  severityFloor?: string;
} {
  const review = operatorReviewSettings();
  return {
    effort:
      review.effort === undefined || review.effort.toLowerCase() === 'auto'
        ? undefined
        : review.effort,
    comment: review.comment,
    severityFloor:
      review.severityFloor === undefined ||
      review.severityFloor.toLowerCase() === 'auto'
        ? undefined
        : review.severityFloor,
  };
}

export const parseArgsCommand: CommandModule = {
  command: 'parse-args [raw]',
  describe:
    'Parse the /review skill argument string (--comment, --fix, --resume, --effort, --severity-floor, --topology, target disambiguation) and emit the verdict as JSON; pass the string on stdin via --stdin (a positional that begins with a dash never reaches this handler — yargs rejects it as an unknown flag)',
  builder: (yargs) =>
    yargs
      .positional('raw', {
        type: 'string',
        describe:
          'The raw argument string as a single (quoted) argument — only safe when it cannot begin with a dash or contain quotes; otherwise use --stdin',
      })
      .option('stdin', {
        type: 'boolean',
        describe:
          'Read the raw argument string from stdin (one trailing newline is stripped). Immune to flag-first strings and shell quoting; this is the form the /review skill uses.',
      })
      .option('out', {
        type: 'string',
        describe: 'Also write the JSON verdict to this path',
      }),
  handler: (argv) => {
    const { raw, stdin, out } = argv as unknown as ParseArgsCliArgs;
    if (stdin && raw !== undefined) {
      throw new Error(
        'parse-args: pass the raw string either as the positional argument or on --stdin, not both',
      );
    }
    // Tokens after a `--` separator never bind to the [raw] positional —
    // they stay in argv._ — so `parse-args -- '--effort low'` used to
    // return a silently wrong local/default verdict. Refuse instead.
    // argv._ also carries the command path itself, whose shape depends on
    // nesting (`['parse-args']` standalone, `['review', 'parse-args']`
    // under the real CLI) — skip that prefix, or the guard rejects every
    // real nested invocation.
    const positionals = (argv['_'] as unknown[]).map(String);
    let commandPrefix = 0;
    while (
      commandPrefix < positionals.length &&
      (positionals[commandPrefix] === 'review' ||
        positionals[commandPrefix] === 'parse-args')
    ) {
      commandPrefix++;
    }
    const unbound = positionals.slice(commandPrefix);
    if (unbound.length > 0) {
      throw new Error(
        `parse-args: unexpected extra argument(s) ${JSON.stringify(unbound)} — a raw string that begins with a flag must be passed via --stdin, not after --`,
      );
    }
    const rawStr = stdin
      ? readFileSync(0, 'utf8').replace(/\r?\n$/, '')
      : (raw ?? '');
    // Before anything is parsed: every step after this one runs the BUILT
    // bundle, so a review command edited since that build does not take effect
    // and the run measures the old behaviour without saying so. This is the
    // first command of a fresh review; `drive` repeats the check, because
    // the verifier brief sends agents there without a step 1.
    const bundleNotice = bundleStalenessNotices(process.argv[1]);
    if (bundleNotice) {
      // `…Safe`, the convention for diagnostics in this subsystem: stderr
      // piped to `head` raises EPIPE, and a warning that kills the review it
      // is warning about would be worse than the staleness it reports.
      writeStderrLineSafe(bundleNotice);
    }

    const parsed = parseReviewArgs(rawStr, reviewDefaultsFromSettings());
    const json = JSON.stringify(parsed, null, 2);
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, json, 'utf8');
    }
    writeStdoutLine(json);
  },
};
