/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Pre-submission checks for /review Step 7. Runs three deterministic
// gh-API queries and emits a single JSON report describing self-PR status,
// CI / build status, existing Qwen Code comment classification, and the
// downgrade decisions the LLM should apply when constructing the review
// event. On an Aone target the command routes at the `a1` CLI instead and
// emits the SAME report shape through the same shared writer: self-PR
// detection (the gate's whoami account vs the MR author), head drift
// (`sourceBranch` is the live head; no compare API, so `compare` stays
// null), merge-gate classification, and the existing-comment dedup.

import type { CommandModule } from 'yargs';
import { writeFileSync, readFileSync } from 'node:fs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  gh,
  ghApiAll,
  ghApiAllNested,
  currentUser,
  ensureAuthenticated,
  isOwnerRepo,
  setGhHost,
} from './lib/gh.js';
import { detectPlatformKind } from './lib/platform/registry.js';
import { ensureAoneAuthenticated } from './lib/platform/aone-client.js';
import {
  LEADING_INVISIBLE_RE,
  carriedClaimLine,
  severityOf,
} from './lib/inline-counts.js';
import { carriesCommentMarker } from './lib/review-footer.js';
import {
  LEDGER_ID_READBACK,
  LEDGER_ID_SHAPE,
  LEDGER_ID_TOKEN,
} from './lib/ledger.js';
import {
  aoneAccountName,
  getMrAuthorAndHead,
  getMrStatusChecks,
  listMrComments,
  type AoneMrComment,
} from './lib/platform/aone.js';

interface FindingAnchor {
  path: string;
  line: number;
  /**
   * Ledger id (`R<round>-<n>`) — carried-forward findings ONLY. The
   * orchestrator omits it on fresh findings of the current round: a fresh id
   * can never appear in a comment posted before this round, and admitting one
   * here would let a brand-new claim ride the id-less exemption into an
   * unrelated thread, or crowd `wantedIds` past the single-carried-finding
   * precondition and disable the exemption for a genuine re-post (#9212
   * review). Matching a carried id against an existing comment at the same
   * location is what marks that comment a re-post target instead of a
   * duplicate (#9208).
   */
  id?: string;
}

interface CommentSummary {
  id: number;
  path: string;
  line: number;
  commit_id: string;
  body: string;
  /**
   * The comment author's login, when known. The authorship gate refuses
   * re-post exemptions on another account's comment; naming the author in the
   * report is what makes that refusal self-explanatory — without it the drop
   * line quotes a comment whose visible id matches the dropped finding, and
   * nothing in the report says authorship is why (#9212 review).
   */
  user?: string;
  /**
   * Set only on `repost` entries: the carried ledger ids a new finding at the
   * same location re-posts (#9208). Usually the ids carried in this comment's
   * body; on the id-less fallback (a truly id-less own-account original at an
   * unambiguous location) it is the location's single wanted id instead
   * (#9212 review).
   */
  matchedIds?: string[];
}

/** The carried id this comment's claim line leads with, if any. */
function extractCarriedIds(body: string): string[] {
  let line = carriedClaimLine(body);
  if (line === null && carriesCommentMarker(body)) {
    // The attribution-off POSTED shape: `submit` strips the severity
    // prefix before posting, so the marker-less body carries the claim on
    // its first line and the severity in the trailing invisible marker.
    // Without reading the id back off that line, a carried re-post lands
    // as a plain overlap and is dedup-dropped from round 3 onward, while
    // the surviving id token bars the id-less fallback.
    line = body
      .trimStart()
      .split(/\r\n?|\n/)[0]
      .replace(LEADING_INVISIBLE_RE, '')
      .trim();
  }
  const carried = LEDGER_ID_READBACK.exec(line ?? '');
  return carried ? [carried[1]] : [];
}

/**
 * ANY ledger-id-shaped token, anywhere in the body — deliberately UNBOUNDED.
 * The id-less fallback may only fire for a comment with NO id token at all,
 * so any mention keeps the comment out of it: a mid-body cross-reference
 * ("see R3-2 for context"), a hyphen run ("R3-2-1"), or a Markdown-emphasised
 * `_R3-2_` (the `\b` anchors miss it — `_` is a word character). The prefix
 * extractor returning [] cannot tell those apart from a truly id-less
 * original, and a false positive here is the safe direction: the finding
 * stays dropped and VISIBLE in the drop log instead of riding the fallback
 * into an unrelated thread (#9212 review).
 */
const ANY_CARRIED_ID = new RegExp(LEDGER_ID_TOKEN);

interface RawComment {
  id: number;
  body?: string;
  path?: string;
  line?: number;
  commit_id?: string;
  in_reply_to_id?: number;
  user?: { login?: string };
}

interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  /** ISO timestamps from the API — how re-runs of one name are ordered. */
  started_at?: string | null;
  completed_at?: string | null;
  details_url?: string;
  html_url?: string;
}

/**
 * When this run's verdict was reached, for ordering re-runs of one name.
 * ISO-8601 strings compare correctly as strings; a run with no timestamp
 * sorts earliest, so it can never displace a dated verdict.
 */
function verdictStamp(run: CheckRun): string {
  return run.completed_at ?? run.started_at ?? '';
}

interface CommitStatus {
  context: string;
  state: string;
}

const FAIL_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  // GitHub reports a workflow that could not start as `startup_failure`. It is
  // a failure, and leaving it out let it count as an execution that added no
  // failed name — an all_pass on a commit whose CI never ran.
  'startup_failure',
]);
const FAIL_STATUS_STATES = new Set(['failure', 'error']);
// GitHub check-run statuses that mean "still going". `waiting` and `requested`
// are real active states — omitting them mislabels a commit whose only check is
// waiting as `no_checks` with a spurious "every check was skipped" reason.
const PENDING_STATES = new Set([
  'queued',
  'in_progress',
  'pending',
  'waiting',
  'requested',
]);

/**
 * Conclusions that mean the job did not execute. GitHub reports these with
 * `status: completed`, so they used to fall through both branches of the
 * classifier and land the run in `all_pass` — a job that never ran was scored
 * as a job that passed.
 *
 * This is not a theoretical hole. `/review` treats green CI as its licence to
 * approve (see "Why downgrade APPROVE when CI is non-green" in DESIGN.md), and
 * the whole design delegates runtime truth to CI because the LLM pipeline reads
 * code statically. On PR #6486 the one job that would have exercised the new
 * hotkey — `Integration Tests (CLI, No Sandbox)` — was `skipped`, as were the
 * macOS and Windows `Test` jobs. The delegation returned nothing, and returned
 * it looking like a pass.
 */
const NOT_RUN_CONCLUSIONS = new Set(['skipped', 'neutral', 'stale']);

function isCurrentActionsRunCheck(run: CheckRun): boolean {
  const runId = process.env['GITHUB_RUN_ID'];
  if (!runId) return false;

  const runUrlMarker = `/actions/runs/${runId}/`;
  return [run.details_url, run.html_url].some(
    (url) => typeof url === 'string' && url.includes(runUrlMarker),
  );
}

interface PresubmitArgs {
  pr_number: string;
  commit_sha: string;
  owner_repo: string;
  out_path: string;
  'new-findings'?: string;
}

/**
 * Read the `--new-findings` file into a validated anchor list, or `null` when
 * it cannot be trusted. `null` is the fail-safe value: `classifyHeadDrift`
 * treats an unknown finding set as at-risk, so a malformed file downgrades
 * the verdict rather than proving a false all-clear. A shorter-than-real list
 * would be the dangerous outcome (a dropped finding reads as disjoint), so
 * any entry lacking a string `path` — or carrying a non-null, non-string
 * or misshapen `id` — rejects the WHOLE file rather than being skipped.
 */
export function parseFindingsFile(path: string): FindingAnchor[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: FindingAnchor[] = [];
  for (const entry of parsed) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as { path?: unknown }).path !== 'string'
    ) {
      return null;
    }
    const e = entry as { path: string; line?: unknown; id?: unknown };
    // Same fail-safe as `path`: an `id` of the wrong type or shape is a
    // malformed file, and silently ignoring it would let a carried re-post
    // read as a fresh duplicate at the very location it belongs (a typo'd
    // id can never match the extractor, silently disabling the exemption).
    // `null` means "no id" — JSON has no `undefined`, so a producer that
    // emits the key uniformly uses null for id-less findings; that is a
    // missing optional field, not a malformed file.
    if (
      e.id !== undefined &&
      e.id !== null &&
      (typeof e.id !== 'string' || !LEDGER_ID_SHAPE.test(e.id))
    ) {
      return null;
    }
    out.push({
      path: e.path,
      line: typeof e.line === 'number' ? e.line : 0,
      ...(typeof e.id === 'string' ? { id: e.id } : {}),
    });
  }
  return out;
}

/** Best-effort delta between the reviewed SHA and the live head. */
export interface CompareSummary {
  /** GitHub compare `status`: ahead | behind | diverged | identical.
   * `diverged` means the reviewed commit is no longer an ancestor — a
   * force-push rewrote the history the review read. */
  status: string;
  aheadBy: number;
  /** Files the unreviewed commits touched (capped at FILES_TOUCHED_CAP). */
  filesTouched: string[];
  /** Count before the cap. When it exceeds `filesTouched.length` the list
   * was cut — and the compare endpoint itself caps at 300, so a total of
   * 300 may also be incomplete. `anchorsAtRisk` accounts for both. */
  filesTotal: number;
}

/** GitHub's compare endpoint returns at most this many files. */
const COMPARE_API_FILES_CAP = 300;
const FILES_TOUCHED_CAP = 50;

export interface HeadDrift {
  reviewedSha: string;
  liveHeadSha: string;
  drifted: boolean;
  compare: CompareSummary | null;
  /**
   * The submit-or-restart decision, computed here rather than delegated to
   * prose: could the unreviewed commits have invalidated the review's inline
   * anchors? True whenever the answer cannot be PROVEN no — compare
   * unavailable, history diverged (force-push), the touched-file list
   * truncated (locally or by the API's own 300 cap), or no findings list
   * supplied to intersect against. A dropped path cannot intersect, so a
   * naive intersection over a truncated list fails open — measured on a real
   * 283-file base-merge drift where the 50 surviving alphabetically-first
   * paths contained no packages/cli or packages/core file at all, i.e. the
   * gate read "safe" on exactly the largest drifts.
   */
  anchorsAtRisk: boolean;
}

/**
 * Did the PR advance while the review ran, and what does that do to the
 * verdict?
 *
 * A drifted head means commits exist on the PR that no agent read; an
 * Approve issued past them certifies code nobody reviewed. Dogfooded on a
 * live PR whose head moved four times in one day: the run that noticed did
 * so by luck (a context compression happened to trigger a re-fetch), and
 * runs that would not have noticed had no gate. So drift is detected here,
 * at the submission gate, and the downgrade rides the machinery that
 * already exists rather than a new rule the model must remember.
 *
 * `findingPaths` is the file set the review's inline comments anchor to
 * (null = unknown, which is fail-safe). Kept pure for unit testing; the gh
 * calls stay in `runPresubmit`.
 */
export function classifyHeadDrift(
  reviewedSha: string,
  liveHeadSha: string,
  compare: CompareSummary | null,
  findingPaths: string[] | null,
): { headDrift: HeadDrift; downgradeReason?: string } {
  // `identical` is the only status that proves the reviewed SHA and the live
  // head are the SAME commit (an abbreviated SHA vs its full form) — a
  // SHA-string mismatch must not cap the verdict against that. `behind` is
  // NOT proof of sameness: it means the head force-pushed BACK to an earlier
  // commit, so the reviewed SHA is ahead of the head and no longer on the
  // PR's line — its anchors may not exist in the head at all. That is drift.
  const provedSame = compare !== null && compare.status === 'identical';
  const drifted =
    liveHeadSha !== '' && reviewedSha !== liveHeadSha && !provedSame;
  if (!drifted) {
    return {
      headDrift: {
        reviewedSha,
        liveHeadSha,
        drifted: false,
        compare: null,
        anchorsAtRisk: false,
      },
    };
  }
  const truncated =
    compare !== null &&
    (compare.filesTotal > compare.filesTouched.length ||
      compare.filesTotal >= COMPARE_API_FILES_CAP);
  const anchorsAtRisk =
    compare === null ||
    compare.status === 'diverged' ||
    // `behind` moved the head off the reviewed commit's line — treat its
    // anchors as at risk like a force-push, regardless of the touched files.
    compare.status === 'behind' ||
    truncated ||
    findingPaths === null ||
    findingPaths.some((p) => compare.filesTouched.includes(p));
  // GitHub's compare caps `files` at 300, so a total AT the cap may be an
  // undercount — render it as a lower bound rather than a precise (and
  // possibly wrong) public number.
  const fileCount =
    compare !== null && compare.filesTotal >= COMPARE_API_FILES_CAP
      ? `${COMPARE_API_FILES_CAP}+`
      : `${compare?.filesTotal ?? 0}`;
  const detail =
    compare === null
      ? ''
      : compare.status === 'diverged'
        ? ' (history rewritten — the reviewed commit is no longer on the PR)'
        : compare.status === 'behind'
          ? ' (PR head moved to an earlier commit — the reviewed commit is no longer the head)'
          : ` (+${compare.aheadBy} unreviewed commit(s) touching ${fileCount} file(s))`;
  return {
    headDrift: {
      reviewedSha,
      liveHeadSha,
      drifted: true,
      compare,
      anchorsAtRisk,
    },
    downgradeReason:
      `PR head advanced during review: reviewed ${reviewedSha.slice(0, 8)}, ` +
      `PR is now at ${liveHeadSha.slice(0, 8)}${detail}`,
  };
}

export function classifyCi(checkRuns: CheckRun[], statuses: CommitStatus[]) {
  const failedCheckNames: string[] = [];
  let hasPending = false;
  const relevantCheckRuns = checkRuns.filter(
    (run) => !isCurrentActionsRunCheck(run),
  );

  // A job that ran and a job that was skipped can share a name — GitHub emits
  // one check run per matrix leg and per re-dispatch, and this repo's routing
  // workflows (`authorize`, `review-pr`, `precheck-pr`) routinely produce both.
  // So "did it run" is a question about the NAME, not about any single run:
  // a name counts as executed if ANY of its runs reached a real conclusion.
  // Without this, every review would disclose a dozen routing jobs as unrun.
  const executedNames = new Set<string>();
  const notRunNames = new Set<string>();
  for (const run of relevantCheckRuns) {
    if (run.status !== 'completed') continue;
    if (!run.conclusion || NOT_RUN_CONCLUSIONS.has(run.conclusion)) {
      // A completed run with NO conclusion produced no verdict about this
      // commit, which is the same thing `skipped` means for a review. Leaving it
      // invisible to both tallies made the class fall through to `no_checks`
      // while `skippedCheckNames` stayed empty — the downgrade then read
      // "every check was skipped ()", naming nothing.
      notRunNames.add(run.name);
    } else {
      executedNames.add(run.name);
    }
  }
  const skippedCheckNames = [...notRunNames]
    .filter((n) => !executedNames.has(n))
    .sort();

  // Failure is judged per NAME, like execution above — and by the name's
  // LATEST verdict, because a name's runs supersede each other: this repo's
  // routing workflows re-dispatch a name several times per commit and cancel
  // the displaced runs, and a flaky job re-run to green leaves its failed
  // attempt behind. Any single failing run used to push its name into
  // `failedCheckNames`, so a check whose newest run PASSED was reported as
  // "CI failing" — two real reviews were downgraded from Approve over exactly
  // that (`route` at #7150, seven routing names at #7171), each on a commit
  // whose every live check was green. The latest run per name is also what
  // GitHub's own PR page shows, so this judges the same evidence a human
  // reviewer sees there. Skipped/neutral/stale runs stay non-verdicts: a
  // re-dispatch that skipped must not erase a real failure beside it.
  const latestVerdicts = new Map<string, CheckRun>();
  for (const run of relevantCheckRuns) {
    if (run.status !== 'completed') {
      if (PENDING_STATES.has(run.status)) hasPending = true;
      continue;
    }
    if (!run.conclusion || NOT_RUN_CONCLUSIONS.has(run.conclusion)) continue;
    const prev = latestVerdicts.get(run.name);
    // Strict `>`: on equal (or absent) stamps the first-seen run keeps the
    // name, and the API lists newest first.
    if (!prev || verdictStamp(run) > verdictStamp(prev)) {
      latestVerdicts.set(run.name, run);
    }
  }
  for (const [name, run] of latestVerdicts) {
    if (FAIL_CONCLUSIONS.has(run.conclusion as string)) {
      failedCheckNames.push(name);
    }
  }
  for (const s of statuses) {
    if (FAIL_STATUS_STATES.has(s.state)) {
      failedCheckNames.push(s.context);
    } else if (PENDING_STATES.has(s.state)) {
      hasPending = true;
    }
  }

  let cls: 'all_pass' | 'any_failure' | 'all_pending' | 'no_checks';
  if (failedCheckNames.length > 0) {
    cls = 'any_failure';
  } else if (relevantCheckRuns.length === 0 && statuses.length === 0) {
    cls = 'no_checks';
  } else if (hasPending) {
    cls = 'all_pending';
  } else if (executedNames.size === 0 && statuses.length === 0) {
    // Every check was skipped. Nothing ran, nothing failed — and the old
    // classifier called that `all_pass`, licensing an approval on the strength
    // of a CI run that did not happen.
    cls = 'no_checks';
  } else {
    cls = 'all_pass';
  }

  return {
    class: cls,
    // Dedupe: a matrix job failing on N platforms pushes its name N times,
    // and `skippedCheckNames` already dedupes — keep the message consistent.
    failedCheckNames: [...new Set(failedCheckNames)],
    /**
     * Checks that never executed at this commit. NOT a downgrade on its own —
     * most are routing jobs, and a docs-only PR legitimately skips the test
     * matrix. It is a disclosure: Step 7 rules on whether a skipped check is
     * one that would have exercised THIS diff, which presubmit cannot know.
     */
    skippedCheckNames,
    totalChecks: relevantCheckRuns.length + statuses.length,
  };
}

/**
 * Aone merge-gate / CI states → the same verdict classes classifyCi emits.
 * `a1 repo mr status` reports the gates that decide `readyToMerge`
 * (discussion, approver_number, test, ai_comment, …); the classifier reads
 * whatever entries arrive, tolerant on key spelling, and never lets an
 * unreadable state read as a pass — an unrecognized word lands with the
 * pending class, which caps an Approve exactly like a still-running check.
 */
const AONE_CHECK_PASS = new Set([
  'success',
  'succeeded',
  'pass',
  'passed',
  'ok',
  'satisfied',
  'green',
  'done',
]);
const AONE_CHECK_FAIL = new Set([
  'failure',
  'failed',
  'fail',
  'error',
  'errored',
  'unsatisfied',
  'blocked',
  'red',
  'rejected',
]);
const AONE_CHECK_NOT_RUN = new Set([
  'skipped',
  'neutral',
  'stale',
  'waived',
  'disabled',
  'not_applicable',
]);

function aoneCheckName(c: Record<string, unknown>, index: number): string {
  for (const key of ['name', 'context', 'check', 'title']) {
    const v = c[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return `check-${index + 1}`;
}

function aoneCheckState(c: Record<string, unknown>): string {
  // A value that lands in a known word set beats an unrecognized word in
  // another key: `status: 'completed'` beside `conclusion: 'success'` must
  // read as passed, not as still-running (the lifecycle-words-first reading
  // would cap every Approve on that MR forever). Verdict keys lead; when no
  // value is recognized the first non-empty one is returned, and the
  // classifier's pending bucket keeps that shape fail-closed.
  let fallback = '';
  for (const key of ['conclusion', 'result', 'state', 'status']) {
    const v = c[key];
    if (typeof v !== 'string' || v.trim() === '') continue;
    const norm = v.trim().toLowerCase();
    if (
      AONE_CHECK_PASS.has(norm) ||
      AONE_CHECK_FAIL.has(norm) ||
      AONE_CHECK_NOT_RUN.has(norm)
    ) {
      return norm;
    }
    if (fallback === '') fallback = norm;
  }
  return fallback;
}

export function classifyAoneChecks(
  checks: ReadonlyArray<Record<string, unknown>>,
): {
  class: 'all_pass' | 'any_failure' | 'all_pending' | 'no_checks';
  failedCheckNames: string[];
  skippedCheckNames: string[];
  totalChecks: number;
} {
  const failedCheckNames: string[] = [];
  const skippedCheckNames: string[] = [];
  let hasPending = false;
  let executed = 0;
  checks.forEach((c, i) => {
    const name = aoneCheckName(c, i);
    const state = aoneCheckState(c);
    if (AONE_CHECK_FAIL.has(state)) {
      failedCheckNames.push(name);
    } else if (AONE_CHECK_NOT_RUN.has(state)) {
      skippedCheckNames.push(name);
    } else if (AONE_CHECK_PASS.has(state)) {
      executed += 1;
    } else {
      // pending or unrecognized — neither is a pass.
      hasPending = true;
    }
  });
  let cls: 'all_pass' | 'any_failure' | 'all_pending' | 'no_checks';
  if (failedCheckNames.length > 0) {
    cls = 'any_failure';
  } else if (checks.length === 0) {
    cls = 'no_checks';
  } else if (hasPending) {
    cls = 'all_pending';
  } else if (executed === 0) {
    cls = 'no_checks';
  } else {
    cls = 'all_pass';
  }
  return {
    class: cls,
    failedCheckNames: [...new Set(failedCheckNames)],
    skippedCheckNames: [...new Set(skippedCheckNames)],
    totalChecks: checks.length,
  };
}

/**
 * One `a1 repo mr comment list` entry mapped into the GitHub-shaped input
 * `classifyExistingComments` reads. a1 comments carry NO commit anchor, and
 * an Aone thread is a live MR discussion across amends — so a thread whose
 * line still maps rides `commit_id === commitSha` (current, overlap-eligible:
 * the dedup this backing exists for), while a thread the platform marks
 * `outdated` (its code was replaced by a past amend) takes the stale bucket —
 * the same bucket GitHub's commit_id comparison hands a prior-commit anchor,
 * so a genuinely new finding at the rewritten line still posts.
 */
export function aoneCommentToPresubmitComment(
  c: AoneMrComment,
  commitSha: string,
): RawComment {
  return {
    id: c.id,
    body: c.note ?? c.body ?? '',
    path: c.path,
    line: typeof c.line === 'number' ? c.line : undefined,
    commit_id: c.outdated === true ? '' : commitSha,
    in_reply_to_id: c.parentNoteId ?? undefined,
    user: { login: aoneAccountName(c.author) },
  };
}

function classifyExistingComments(
  qwenComments: RawComment[],
  repliedToIds: Set<number>,
  newFindings: FindingAnchor[],
  commitSha: string,
  currentUserLogin: string,
) {
  const buckets: Record<
    'stale' | 'resolved' | 'overlap' | 'repost' | 'noConflict',
    CommentSummary[]
  > = { stale: [], resolved: [], overlap: [], repost: [], noConflict: [] };

  const newFindingKeys = new Set(newFindings.map((f) => `${f.path}:${f.line}`));
  // Location → carried ids of the findings anchored there. Only findings with
  // an id participate, and the orchestrator writes ids ONLY on carried
  // findings (SKILL.md — the findings file): a fresh `R<this-round>-<n>`
  // cannot appear in a comment posted before this round, so every id here is
  // a genuine re-post signal, and `wantedIds.size === 1` below means exactly
  // one CARRIED finding at the location (#9212 review).
  const carriedIdsByLocation = new Map<string, Set<string>>();
  for (const f of newFindings) {
    if (f.id === undefined) continue;
    const key = `${f.path}:${f.line}`;
    const ids = carriedIdsByLocation.get(key) ?? new Set<string>();
    ids.add(f.id);
    carriedIdsByLocation.set(key, ids);
  }

  // Own-account Qwen comments per location at the current SHA. A count of
  // exactly one makes an id-less original unambiguous as a re-post target
  // (#9212 review). Replied-to comments COUNT: a replied-to original is
  // still an original, and leaving it out of the ambiguity count handed the
  // id-less exemption to a sibling comment belonging to a different finding
  // (#9212 review).
  //
  // The unknown-login skip is a deliberate short-circuit, not a correctness
  // boundary: the count is consumed at exactly ONE site — the id-less
  // fallback inside the repost gate — and that gate itself requires a known
  // login, so while the login is unknown the map built here is never
  // consulted. The mutant that forces this guard true is provably
  // equivalent (R6-7, #9212 review); keep the guard as defense in depth
  // against a future move of the read site out of the gate.
  const ownOverlapCountByLocation = new Map<string, number>();
  if (currentUserLogin !== '') {
    for (const c of qwenComments) {
      if (
        c.commit_id === commitSha &&
        (c.user?.login ?? '').toLowerCase() === currentUserLogin.toLowerCase()
      ) {
        const key = `${c.path ?? ''}:${c.line ?? 0}`;
        ownOverlapCountByLocation.set(
          key,
          (ownOverlapCountByLocation.get(key) ?? 0) + 1,
        );
      }
    }
  }

  for (const c of qwenComments) {
    const summary: CommentSummary = {
      id: c.id,
      path: c.path ?? '',
      line: c.line ?? 0,
      commit_id: c.commit_id ?? '',
      body: (c.body || '').slice(0, 80),
      ...(c.user?.login ? { user: c.user.login } : {}),
    };
    // Priority: Stale > Resolved > Overlap (+ Repost) > NoConflict.
    if (c.commit_id !== commitSha) {
      buckets.stale.push(summary);
    } else if (repliedToIds.has(c.id)) {
      buckets.resolved.push(summary);
    } else if (newFindingKeys.has(`${c.path}:${c.line}`)) {
      // Overlap stays location-based: a same-line finding with a DIFFERENT
      // claim is still dropped (the drop log now names this comment so the
      // false positive is visible — #9208). Repost is the additional, id-based
      // bucket: a Step 6 ledger re-post lands on the original thread's line by
      // construction and carries the original id in its prefix, so an id match
      // marks the re-post target and exempts that finding from the drop.
      buckets.overlap.push(summary);
      const wantedIds = carriedIdsByLocation.get(`${c.path}:${c.line}`);
      // Ledger ids are per-account — two reviewers of the same PR keep two
      // independent ledgers, each with its own `R2-1` — so only THIS
      // account's comments can carry a re-post of its own finding. A
      // different account's colliding id at the same line must stay a
      // plain location overlap (#9212 review).
      if (
        wantedIds &&
        currentUserLogin !== '' &&
        (c.user?.login ?? '').toLowerCase() === currentUserLogin.toLowerCase()
      ) {
        const matchedIds = extractCarriedIds(c.body || '').filter((id) =>
          wantedIds.has(id),
        );
        if (matchedIds.length > 0) {
          buckets.repost.push({ ...summary, matchedIds });
        } else if (
          !ANY_CARRIED_ID.test(c.body || '') &&
          wantedIds.size === 1 &&
          ownOverlapCountByLocation.get(`${c.path}:${c.line}`) === 1
        ) {
          // First-round originals can carry NO id token in their body
          // (buildLedger assigns first-round ids positionally), so the body
          // match alone would drop exactly the re-post this gate protects.
          // When the target is unambiguous — a TRULY id-less own comment (no
          // carried id at all, so it cannot belong to a different finding),
          // one carried finding, and exactly one own-account comment at this
          // location — treat it as the re-post target. A comment carrying
          // SOME OTHER id is a different finding's thread and keeps the
          // strict match; ambiguous cases (several id-less comments or
          // several carried ids at one line) keep the strict body match too,
          // staying dropped and visible in the drop log (#9212 review).
          buckets.repost.push({ ...summary, matchedIds: [...wantedIds] });
        }
      }
    } else {
      buckets.noConflict.push(summary);
    }
  }
  return buckets;
}

/**
 * The self-PR test both platform paths run: a case-insensitive match of the
 * PR author against the reviewing account. The `author !== ''` guard is the
 * load-bearing half — a deleted-author MR and an unreadable reviewer account
 * are BOTH reachable, and without it the comparison computes '' === '' and
 * downgrades a stranger's PR as a self-review (house-pinned on the GitHub
 * path since #9212). Stated once so the next normalization rule cannot be
 * applied to one platform's copy only and silently diverge the paths.
 */
function isSelfReview(author: string, me: string): boolean {
  return author !== '' && author.toLowerCase() === me.toLowerCase();
}

async function runPresubmit(args: PresubmitArgs): Promise<void> {
  const {
    pr_number: prNumber,
    commit_sha: commitSha,
    owner_repo: ownerRepo,
    out_path: outPath,
  } = args;
  const newFindingsPath = args['new-findings'];

  const slash = ownerRepo.indexOf('/');
  if (slash < 0) {
    throw new Error('owner_repo must look like "owner/repo"');
  }
  const owner = ownerRepo.slice(0, slash);
  const repo = ownerRepo.slice(slash + 1);

  ensureAuthenticated();

  // --- Self-PR detection + live head (one fetch) -------------------------
  // Two different failures, two different responses. A SUCCESSFUL response
  // with `author: null` (deleted account) is fail-SOFT — isSelfPr false is
  // the right answer and the unguarded dereference here once killed the whole
  // presubmit. A THROWN call (transport, auth, rate limit, a 404 on this one
  // endpoint) is fail-CLOSED: with no head to compare, self-PR and drift are
  // both undetectable, so the run must not silently proceed as if it had
  // checked. It emits a downgrade reason and caps the Approve.
  let prMeta: { author?: string | null; headSha?: string | null } = {};
  let metaUnavailable = false;
  try {
    prMeta = JSON.parse(
      gh(
        'api',
        `repos/${owner}/${repo}/pulls/${prNumber}`,
        '--jq',
        '{author: .user.login, headSha: .head.sha}',
      ),
    ) as { author?: string | null; headSha?: string | null };
  } catch {
    metaUnavailable = true;
  }
  const author = prMeta.author ?? '';
  const liveHeadSha = prMeta.headSha ?? '';
  const me = currentUser();
  const isSelfPr = isSelfReview(author, me);

  // --- Head drift ---------------------------------------------------------
  // Detail is best-effort: the drift itself (and its downgrade) never
  // depends on the compare call succeeding — a force-pushed-away reviewed
  // SHA can make compare 404, and that case is precisely `drifted`.
  let compare: CompareSummary | null = null;
  if (liveHeadSha && liveHeadSha !== commitSha) {
    try {
      const c = JSON.parse(
        gh(
          'api',
          `repos/${owner}/${repo}/compare/${commitSha}...${liveHeadSha}`,
          // Both the new path AND `previous_filename`: an unreviewed commit
          // that RENAMED a file a finding anchors to (under its old path)
          // would otherwise miss the intersection — the rename bypasses the
          // at-risk check and the stale anchor reads as safe.
          '--jq',
          '{status, aheadBy: .ahead_by, files: [.files[] | .filename, .previous_filename] | map(select(. != null))}',
        ),
      ) as { status: string; aheadBy: number; files: string[] };
      const allFiles = [...new Set(c.files ?? [])];
      compare = {
        status: c.status,
        aheadBy: c.aheadBy,
        filesTouched: allFiles.slice(0, FILES_TOUCHED_CAP),
        filesTotal: allFiles.length,
      };
    } catch {
      /* detail only — drift stands without it */
    }
  }

  // Parsed before drift classification: the findings' file set is what
  // anchorsAtRisk intersects against (absent file = unknown = fail-safe).
  // This list is used as a SAFETY PROOF — a disjoint intersection lets the
  // review submit past drift — so it is validated, not trusted: a file that
  // will not parse, is not an array, or holds an entry without a string
  // `path` collapses to `null` (unknown → fail-safe at-risk), never to a
  // silently-shorter set that could make a real overlap read as disjoint.
  const newFindings = newFindingsPath
    ? parseFindingsFile(newFindingsPath)
    : null;
  // A path was given but did not parse into a usable list. The drift path
  // already fails safe (findingPaths=null → anchorsAtRisk true), but the SAME
  // null collapses to an empty finding list below, disabling the existing-
  // comment overlap check — a run then can't tell "no overlaps" from "the
  // dedup input was garbage", and may re-post comments a prior run already
  // made. Surface it (report flag + downgrade reason) instead of degrading in
  // two directions in silence.
  const findingsFileInvalid =
    newFindingsPath !== undefined && newFindings === null;

  const { headDrift, downgradeReason: driftReason } = classifyHeadDrift(
    commitSha,
    liveHeadSha,
    compare,
    newFindings === null ? null : newFindings.map((f) => f.path),
  );

  // --- CI status ---------------------------------------------------------
  // Paginate: a busy CI matrix produces more than 30 check runs on one commit,
  // and the first-page-only call could hide a failing or skipped job behind the
  // cut, letting the review approve past it.
  const checkRuns = ghApiAllNested(
    `repos/${owner}/${repo}/commits/${commitSha}/check-runs`,
    'check_runs',
  ) as CheckRun[];
  // Paginate the legacy combined-status endpoint too (default 30 per page):
  // same first-page-only gap as check-runs — a failing or pending status on
  // page 2 would otherwise be invisible and let the review approve past it.
  const statuses = ghApiAllNested(
    `repos/${owner}/${repo}/commits/${commitSha}/status`,
    'statuses',
  ) as CommitStatus[];
  const ciStatus = classifyCi(checkRuns, statuses);

  // --- Existing Qwen Code comments --------------------------------------
  // Paginate: PRs can have >30 inline comments and the latest pages carry
  // the most recent (and most likely to overlap with new findings).
  const allComments = ghApiAll(
    `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
  ) as RawComment[];
  // Recognize a posted finding by any of the three signals it carries, at
  // different trust levels. The visible footer is qwen's own provenance
  // string — long, model- and version-stamped, not something a hand comment
  // carries — so it matches regardless of account, even when the login is
  // unknown (#9212 pins exactly this). The invisible marker and the finding
  // shape are short and plantable, so they match only for the reviewing
  // account's own top-level comments: an ungated match on either lets anyone
  // plant one on the line they expect a blocker on and have the next round
  // silently withhold that blocker as a duplicate — provenance the commenter
  // cannot fake is the account, not the string. The marker disjunct catches
  // attribution-off posts in the exact shape `submit` posts (marker trailing
  // the body); the `severityOf` disjunct remains for this account's posts
  // made before the marker existed, gated on the finding shape — the same
  // trimmed predicate `submit` posts through (a body that leaves with leading
  // whitespace must still be recognized here) — while a hand-written comment
  // by the same account is not a posted finding: admitting one lets a
  // same-line hand comment trip the overlap gate into silently dropping a
  // genuinely new finding. Replies stay excluded either way. Attribution-off
  // posts from OTHER accounts still escape detection — no footer, no
  // authorship signal — and the setting's description says so.
  const qwenComments = allComments.filter(
    (c) =>
      /via Qwen Code \/review/.test(c.body ?? '') ||
      (!c.in_reply_to_id &&
        me !== '' &&
        (c.user?.login ?? '').toLowerCase() === me.toLowerCase() &&
        (carriesCommentMarker(c.body ?? '') || severityOf(c) !== null)),
  );

  const repliedToIds = new Set<number>();
  for (const c of allComments) {
    if (c.in_reply_to_id) repliedToIds.add(c.in_reply_to_id);
  }

  const buckets = classifyExistingComments(
    qwenComments,
    repliedToIds,
    newFindings ?? [],
    commitSha,
    me,
  );

  writePresubmitReport({
    prNumber,
    commitSha,
    ownerRepo,
    outPath,
    isSelfPr,
    ciStatus,
    qwenCommentCount: qwenComments.length,
    buckets,
    headDrift,
    driftReason,
    metaUnavailable,
    findingsFileInvalid,
  });
}

/** The CI/gate classification shape both platform classifiers emit. */
interface CiClassification {
  class: 'all_pass' | 'any_failure' | 'all_pending' | 'no_checks';
  failedCheckNames: string[];
  skippedCheckNames: string[];
  totalChecks: number;
}

/**
 * The downgrade decisions + report write, shared by both platform runners:
 * the semantics the skill's Step 7 reads are one computation, never two
 * copies that could drift between GitHub and Aone.
 */
function writePresubmitReport(input: {
  prNumber: string;
  commitSha: string;
  ownerRepo: string;
  outPath: string;
  isSelfPr: boolean;
  ciStatus: CiClassification;
  qwenCommentCount: number;
  buckets: ReturnType<typeof classifyExistingComments>;
  headDrift: HeadDrift;
  driftReason?: string;
  metaUnavailable: boolean;
  findingsFileInvalid: boolean;
}): void {
  const {
    prNumber,
    commitSha,
    ownerRepo,
    outPath,
    isSelfPr,
    ciStatus,
    qwenCommentCount,
    buckets,
    headDrift,
    driftReason,
    metaUnavailable,
    findingsFileInvalid,
  } = input;

  const downgradeReasons: string[] = [];
  if (isSelfPr) downgradeReasons.push('self-PR');
  if (ciStatus.class === 'any_failure') {
    downgradeReasons.push(
      `CI failing: ${ciStatus.failedCheckNames.join(', ')}`,
    );
  }
  if (ciStatus.class === 'all_pending') {
    downgradeReasons.push('CI still running');
  }
  // Checks exist at this commit and NOT ONE of them executed. There is no
  // green to approve on. (A repo with no CI at all is `no_checks` with
  // `totalChecks === 0` and is not downgraded — that is a different claim.)
  if (ciStatus.class === 'no_checks' && ciStatus.totalChecks > 0) {
    downgradeReasons.push(
      `CI did not run: every check was skipped (${ciStatus.skippedCheckNames.join(', ')})`,
    );
  }
  if (driftReason) downgradeReasons.push(driftReason);
  if (metaUnavailable) {
    downgradeReasons.push(
      'PR metadata unavailable — could not verify self-PR status or head drift',
    );
  }
  if (findingsFileInvalid) {
    downgradeReasons.push(
      'the --new-findings file was malformed — overlap dedup was disabled and ' +
        'anchor-risk defaulted to at-risk; regenerate it and re-run',
    );
  }

  const result = {
    prNumber,
    commitSha,
    ownerRepo,
    isSelfPr,
    ciStatus,
    existingComments: {
      total: qwenCommentCount,
      byBucket: {
        stale: buckets.stale.length,
        resolved: buckets.resolved.length,
        overlap: buckets.overlap.length,
        repost: buckets.repost.length,
        noConflict: buckets.noConflict.length,
      },
      overlap: buckets.overlap,
      // Overlap comments that a new finding at the same location re-posts —
      // the drop rule exempts those findings (#9208). Matched by the carried
      // ledger id the comment's claim line leads with, or — when the target
      // is unambiguous — by the id-less fallback for a truly id-less
      // own-account original (#9212 review). A comment appears here IN
      // ADDITION TO `overlap`; the double count is deliberate (one comment,
      // two roles).
      repost: buckets.repost,
      stale: buckets.stale,
      resolved: buckets.resolved,
      noConflict: buckets.noConflict,
    },
    // `no_checks` with checks present means not one of them ran — the
    // downgradeReasons entry above says so, and this is the boolean that makes
    // compose-review act on it. Omitting it made the whole disclosure inert:
    // the reason was written and the downgrade never fired.
    downgradeApprove:
      isSelfPr ||
      ciStatus.class === 'any_failure' ||
      ciStatus.class === 'all_pending' ||
      (ciStatus.class === 'no_checks' && ciStatus.totalChecks > 0) ||
      // Commits nobody reviewed are on the PR — an Approve would certify them.
      headDrift.drifted ||
      // Could not read the PR head at all: neither self-PR nor drift could be
      // checked, so an Approve would rest on unverified state.
      metaUnavailable ||
      // The findings input the anchor-risk and overlap checks both rely on was
      // unreadable — the run cannot certify against inputs it could not read.
      findingsFileInvalid,
    downgradeRequestChanges: isSelfPr,
    downgradeReasons,
    blockOnExistingComments: buckets.overlap.length > 0,
    // Distinguishes "no overlaps" from "the dedup input was garbage": a true
    // value means the overlap check ran on an empty set and duplicate comments
    // are possible, so the skill should regenerate the findings file.
    findingsFileInvalid,
    headDrift,
  };

  writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  writeStdoutLine(`Wrote presubmit report to ${outPath}`);
}

/**
 * The Aone runner. The platform differences: identity and head come from
 * `mr view` (author username + `sourceBranch`), CI/gate state from
 * `mr status`, existing comments from `mr comment list` — and there is no
 * compare API, so a drifted head carries `compare: null` and the anchor-risk
 * ruling fails safe to at-risk (the skill restarts at the new head — under
 * AGit-Flow a moved head IS an amend that wants a re-review).
 */
async function runPresubmitAone(args: PresubmitArgs): Promise<void> {
  const {
    pr_number: prNumber,
    commit_sha: commitSha,
    owner_repo: ownerRepo,
    out_path: outPath,
  } = args;
  const newFindingsPath = args['new-findings'];

  // Usage errors surface BEFORE the auth gate and the platform-fetch
  // try/catch: a malformed positional is a deterministic invocation
  // problem, not a metadata blip — catching it below would emit a
  // "metadata unavailable" downgrade report instead of failing the call.
  // The id grammar matches the comment-status twin (fetch-pr's digit
  // grammar): Number() alone accepts '012'/'1e3'/' 12'/'12.0' and would
  // compute this MR's dedup state from a different MR than the report's
  // label carries; the id also reaches `a1 repo mr view` as a positional,
  // and a `-1` would parse as a flag if it rode through.
  if (!/^[1-9]\d*$/.test(prNumber)) {
    throw new Error(
      'pr_number must be a positive integer (the Aone global MR id)',
    );
  }
  // The same shape check the Aone reader seam applies (meta/fetch-pr
  // already refused anything else before this command could run).
  if (!isOwnerRepo(ownerRepo)) {
    throw new TypeError(
      `expected owner/repo, got ${JSON.stringify(ownerRepo)}`,
    );
  }
  const mrId = Number(prNumber);

  // The auth gate doubles as the account read: ONE whoami per run, run
  // BEFORE the MR fetch — a whoami failure aborts at the gate's
  // actionable error, and no account fetch remains after the MR fetch
  // that could throw uncaught and orphan the graceful metaUnavailable
  // report below (#9629 review).
  const me = ensureAoneAuthenticated();

  // --- Self-MR detection + live head (one mr view) ----------------------
  // Same two failure classes as the GitHub path: an UNREADABLE mr view is
  // fail-CLOSED (metaUnavailable — neither self-PR nor drift can be
  // checked, so the Approve caps); a readable view with an absent author
  // (deleted account) is fail-soft (isSelfPr false).
  let mrAuthor = '';
  let liveHeadSha = '';
  let metaUnavailable = false;
  try {
    const facts = getMrAuthorAndHead(mrId, ownerRepo);
    mrAuthor = facts.author;
    liveHeadSha = facts.headSha;
  } catch {
    metaUnavailable = true;
  }
  const isSelfPr = isSelfReview(mrAuthor, me);

  // --- Head drift ---------------------------------------------------------
  // Aone has no compare endpoint — the delta would be a local
  // `git diff <reviewed>..<live>` after re-fetching the ref (design D7),
  // but presubmit does not re-fetch: `compare` stays null, which rules
  // `anchorsAtRisk` true on ANY drift — the fail-safe default that sends
  // the skill back to re-review the amended head.
  const newFindings = newFindingsPath
    ? parseFindingsFile(newFindingsPath)
    : null;
  const findingsFileInvalid =
    newFindingsPath !== undefined && newFindings === null;
  const { headDrift, downgradeReason: driftReason } = classifyHeadDrift(
    commitSha,
    liveHeadSha,
    null,
    newFindings === null ? null : newFindings.map((f) => f.path),
  );

  // --- CI / merge-gate status ---------------------------------------------
  // An unreadable gate state (a1 answered but no recognizable checks array)
  // must not collapse to `no_checks` with zero totals — that is the
  // all-clear shape. It reads as pending instead, capping an Approve the
  // same way a still-running check does. A TRANSPORT failure rethrows, the
  // same shape the gh path gives its check-run fetch.
  const checks = getMrStatusChecks(mrId, ownerRepo);
  const ciStatus: CiClassification =
    checks === undefined
      ? {
          class: 'all_pending',
          failedCheckNames: [],
          skippedCheckNames: [],
          totalChecks: 0,
        }
      : classifyAoneChecks(checks);

  // --- Existing Qwen Code comments --------------------------------------
  // One flat a1 list carries inline findings, replies, AND global summary
  // comments; the mapping and recognition signals are the GitHub ones (the
  // footer is qwen's own provenance string and matches regardless of
  // account; the short marker/severity shapes match only the reviewing
  // account's own top-level comments).
  const allRaw = listMrComments(mrId, ownerRepo);
  const allComments = allRaw.map((c) =>
    aoneCommentToPresubmitComment(c, commitSha),
  );
  const qwenComments = allComments.filter(
    (c) =>
      /via Qwen Code \/review/.test(c.body ?? '') ||
      (!c.in_reply_to_id &&
        me !== '' &&
        (c.user?.login ?? '').toLowerCase() === me.toLowerCase() &&
        (carriesCommentMarker(c.body ?? '') || severityOf(c) !== null)),
  );

  const repliedToIds = new Set<number>();
  for (const c of allRaw) {
    if (typeof c.parentNoteId === 'number' && c.parentNoteId !== 0) {
      repliedToIds.add(c.parentNoteId);
    }
    // Aone's `closed` marks a RESOLVED discussion — the engaged-thread
    // equivalent of GitHub's replied-to. It lands in the resolved bucket,
    // which the priority order above keeps OUT of the overlap drop: a
    // resolved thread at a location does not bar a new finding there. The
    // measured payload stamps the numeric 1; a boolean stays tolerated.
    if (c.closed === 1 || c.closed === true) {
      repliedToIds.add(
        typeof c.parentNoteId === 'number' && c.parentNoteId !== 0
          ? c.parentNoteId
          : c.id,
      );
    }
  }

  const buckets = classifyExistingComments(
    qwenComments,
    repliedToIds,
    newFindings ?? [],
    commitSha,
    me,
  );

  writePresubmitReport({
    prNumber,
    commitSha,
    ownerRepo,
    outPath,
    isSelfPr,
    ciStatus,
    qwenCommentCount: qwenComments.length,
    buckets,
    headDrift,
    driftReason,
    metaUnavailable,
    findingsFileInvalid,
  });
}

export const presubmitCommand: CommandModule = {
  command: 'presubmit <pr_number> <commit_sha> <owner_repo> <out_path>',
  describe:
    'Pre-submission checks for /review Step 7 (self-PR detection, CI status, existing-comments classification)',
  builder: (yargs) =>
    yargs
      .positional('pr_number', {
        type: 'string',
        demandOption: true,
        describe: 'PR number',
      })
      .positional('commit_sha', {
        type: 'string',
        demandOption: true,
        describe: 'PR HEAD commit SHA',
      })
      .positional('owner_repo', {
        type: 'string',
        demandOption: true,
        describe:
          'Target coordinate: GitHub "owner/repo" or Aone "group/project"',
      })
      .positional('out_path', {
        type: 'string',
        demandOption: true,
        describe: 'Output JSON path (will be overwritten)',
      })
      .option('host', {
        type: 'string',
        describe:
          "The host the target lives on. An Aone host (*.alibaba-inc.com) selects the a1 backend; omitted: detected from the clone's origin, else GitHub (GH_HOST, then github.com).",
      })
      .option('new-findings', {
        type: 'string',
        describe:
          "Path to a JSON file shaped as [{path, line, id?}, ...] — when provided, existing comments are checked for same-(path, line) overlap with the new findings. `id` is the finding's carried ledger id (`R<round>-<n>`) and belongs on CARRIED-forward findings only — omit it on fresh findings of this round: an id-matched own-account comment at the same location is additionally reported in `repost` so the drop rule can exempt the re-post, and a fresh id could only corrupt that match.",
      }),
  handler: async (argv) => {
    const host = (argv as { host?: string }).host;
    if (detectPlatformKind({ host }) === 'aone') {
      await runPresubmitAone(argv as unknown as PresubmitArgs);
      return;
    }
    setGhHost(host);
    await runPresubmit(argv as unknown as PresubmitArgs);
  },
};
