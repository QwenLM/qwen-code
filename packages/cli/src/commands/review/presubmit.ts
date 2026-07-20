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

  // --- Self-PR detection -------------------------------------------------
  const author = gh(
    'api',
    `repos/${owner}/${repo}/pulls/${prNumber}`,
    '--jq',
    '.user.login',
  );
  const me = currentUser();
  const isSelfPr = author.toLowerCase() === me.toLowerCase();

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
  const qwenComments = allComments.filter((c) =>
    /via Qwen Code \/review/.test(c.body ?? ''),
  );

  const repliedToIds = new Set<number>();
  for (const c of allComments) {
    if (c.in_reply_to_id) repliedToIds.add(c.in_reply_to_id);
  }

  let newFindings: FindingAnchor[] = [];
  if (newFindingsPath) {
    newFindings = JSON.parse(readFileSync(newFindingsPath, 'utf8'));
  }
  const newFindingKeys = new Set(newFindings.map((f) => `${f.path}:${f.line}`));

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
      (ciStatus.class === 'no_checks' && ciStatus.totalChecks > 0),
    downgradeRequestChanges: isSelfPr,
    downgradeReasons,
    blockOnExistingComments: buckets.overlap.length > 0,
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
