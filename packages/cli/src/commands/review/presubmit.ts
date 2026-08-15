/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Pre-submission checks for /review Step 7. Runs three deterministic
// gh-API queries and emits a single JSON report describing self-PR status,
// CI / build status, existing Qwen Code comment classification, and the
// downgrade decisions the LLM should apply when constructing the review
// event.

import type { CommandModule } from 'yargs';
import { writeFileSync, readFileSync } from 'node:fs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  gh,
  ghApiAll,
  ghApiAllNested,
  currentUser,
  ensureAuthenticated,
  setGhHost,
} from './lib/gh.js';
import { severityOf } from './lib/inline-counts.js';

interface FindingAnchor {
  path: string;
  line: number;
}

interface CommentSummary {
  id: number;
  path: string;
  line: number;
  commit_id: string;
  body: string;
}

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
 * any entry lacking a string `path` rejects the WHOLE file rather than being
 * skipped.
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
    const e = entry as { path: string; line?: unknown };
    out.push({
      path: e.path,
      line: typeof e.line === 'number' ? e.line : 0,
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

function classifyExistingComments(
  qwenComments: RawComment[],
  repliedToIds: Set<number>,
  newFindingKeys: Set<string>,
  commitSha: string,
) {
  const buckets: Record<
    'stale' | 'resolved' | 'overlap' | 'noConflict',
    CommentSummary[]
  > = { stale: [], resolved: [], overlap: [], noConflict: [] };

  for (const c of qwenComments) {
    const summary: CommentSummary = {
      id: c.id,
      path: c.path ?? '',
      line: c.line ?? 0,
      commit_id: c.commit_id ?? '',
      body: (c.body || '').slice(0, 80),
    };
    // Priority: Stale > Resolved > Overlap > NoConflict.
    if (c.commit_id !== commitSha) {
      buckets.stale.push(summary);
    } else if (repliedToIds.has(c.id)) {
      buckets.resolved.push(summary);
    } else if (newFindingKeys.has(`${c.path}:${c.line}`)) {
      buckets.overlap.push(summary);
    } else {
      buckets.noConflict.push(summary);
    }
  }
  return buckets;
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
  const isSelfPr = author !== '' && author.toLowerCase() === me.toLowerCase();

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
  // null silently empties `newFindingKeys` below, disabling the existing-
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
  // Footer match first — and NOT the only match: with `review.attribution`
  // off, posted comments carry no footer, and a filter keyed on the footer
  // alone goes blind to every earlier attribution-off post — the overlap and
  // stale classification (and the `blockOnExistingComments` gate that exists
  // to stop duplicate posting) silently stop seeing them. Fall back to
  // authorship for the reviewing account's own top-level comments, gated on
  // the finding shape through `severityOf` — the same trimmed predicate
  // `submit` posts through (a body that leaves with leading whitespace must
  // still be recognized here), while a hand-written comment by the same
  // account is not a posted finding — admitting one lets a same-line hand
  // comment trip the overlap gate into silently dropping a genuinely new
  // finding. Replies stay excluded either way. Attribution-off posts from
  // OTHER accounts still escape detection — no footer, no authorship signal
  // — and the setting's description says so.
  const qwenComments = allComments.filter(
    (c) =>
      /via Qwen Code \/review/.test(c.body ?? '') ||
      (!c.in_reply_to_id &&
        me !== '' &&
        (c.user?.login ?? '').toLowerCase() === me.toLowerCase() &&
        severityOf(c) !== null),
  );

  const repliedToIds = new Set<number>();
  for (const c of allComments) {
    if (c.in_reply_to_id) repliedToIds.add(c.in_reply_to_id);
  }

  const newFindingKeys = new Set(
    (newFindings ?? []).map((f) => `${f.path}:${f.line}`),
  );

  const buckets = classifyExistingComments(
    qwenComments,
    repliedToIds,
    newFindingKeys,
    commitSha,
  );

  // --- Downgrade decisions ----------------------------------------------
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
      total: qwenComments.length,
      byBucket: {
        stale: buckets.stale.length,
        resolved: buckets.resolved.length,
        overlap: buckets.overlap.length,
        noConflict: buckets.noConflict.length,
      },
      overlap: buckets.overlap,
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
        describe: 'GitHub "owner/repo"',
      })
      .positional('out_path', {
        type: 'string',
        demandOption: true,
        describe: 'Output JSON path (will be overwritten)',
      })
      .option('host', {
        type: 'string',
        describe:
          'GitHub host for this PR (GitHub Enterprise). Routes every gh call in this command via GH_HOST; omit for github.com.',
      })
      .option('new-findings', {
        type: 'string',
        describe:
          'Path to a JSON file shaped as [{path, line}, ...] — when provided, existing comments are checked for same-(path, line) overlap with the new findings.',
      }),
  handler: async (argv) => {
    setGhHost((argv as { host?: string }).host);
    await runPresubmit(argv as unknown as PresubmitArgs);
  },
};
