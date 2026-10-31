/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen autofix-pr snapshot`: read a PR once and report what changed, plus
// the one action the /autofix-pr skill takes next.
//
// Two modes share the reading and the trust rules:
// - Prepared mode compares against the state file `prepare` wrote and never
//   moves the cursor: only a later push, reply, re-run or sync does. It
//   records only which checks it saw fail and pass, for the budget of fix
//   pushes per failing check.
// - `--gate` is the probe behind a scheduled task's gate
//   (docs/design/2026-10-21-scheduled-task-gate.md): it needs no worktree,
//   keeps its own cursor of what it already reported, prints only the
//   transitions since the last run and prints nothing when there are none,
//   so the session is woken only for them.

import type { CommandModule } from 'yargs';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core/utils/atomicFileWrite.js';
import { dirname } from 'node:path';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  ensureAuthenticated,
  gh,
  isOwnerRepo,
  resolveGhHost,
  setGhHost,
} from '../review/lib/gh.js';
import {
  GATE_OUTPUT_BUDGET_BYTES,
  jsonBytes,
} from '../review/lib/gate-budget.js';
import { normalizeSegment } from '../review/lib/remote-match.js';
import {
  MAX_CHECK_FIX_PUSHES,
  MAX_FAILING_CHECKS,
  REPLY_MARKER,
  assertWatching,
  autofixPrPaths,
  checkAttemptKey,
  ghNotFound,
  isRegularFile,
  NO_FOLLOW,
  readGateCursor,
  readState,
  resolveWatchRoot,
  requireState,
  rerunFloors,
  sameRepository,
  withWatchLock,
  writeGateCursor,
  writeState,
  type AutofixPrGateCursor,
  type AutofixPrState,
  type FailingCheck,
} from './state.js';
import { remoteRef } from './worktree.js';
import {
  assertNoFixInFlight,
  fixInFlight,
  freshAttempt,
  readFixMarker,
} from './fix.js';

const CHECK_CONTEXT_FIELDS = `nodes {
  __typename
  ... on CheckRun {
    name status conclusion detailsUrl databaseId
    checkSuite { status app { databaseId } workflowRun { event workflow { databaseId } } }
  }
  ... on StatusContext { context state targetUrl createdAt }
}`;

// Suites are listed oldest first, and those a push created are the oldest
// of a head: every review comment can add one after them.
const CHECK_SUITE_FIELDS = `pageInfo { hasPreviousPage startCursor }
nodes {
  databaseId
  conclusion
  app { databaseId }
  workflowRun { databaseId url event workflow { databaseId name } }
}`;

// `last: 100`: a thread's newest replies are the ones that can be new; the
// root stays reachable for `replyTo`.
const REVIEW_THREAD_FIELDS = `pageInfo { hasNextPage endCursor }
nodes {
  id
  isResolved
  isOutdated
  path
  line
  root: comments(first: 1) { nodes { databaseId } }
  comments(last: 100) {
    pageInfo { hasPreviousPage }
    nodes { id databaseId author { __typename login } authorAssociation body url state replyTo { id } }
  }
}`;

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      isDraft
      title
      url
      headRefOid
      mergeable
      author { login }
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: 100) {
                pageInfo { hasNextPage endCursor }
                ${CHECK_CONTEXT_FIELDS}
              }
            }
            checkSuites(last: 100) {
              ${CHECK_SUITE_FIELDS}
            }
          }
        }
      }
      reviewThreads(first: 100) {
        ${REVIEW_THREAD_FIELDS}
      }
      reviews(last: 100) {
        pageInfo { hasPreviousPage }
        nodes { id author { __typename login } authorAssociation state body url }
      }
      comments(last: 100) {
        pageInfo { hasPreviousPage }
        nodes { id author { __typename login } authorAssociation body url }
      }
    }
  }
}`;

const SUITES_PAGE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $before: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 1) {
        nodes {
          commit {
            oid
            checkSuites(last: 100, before: $before) {
              ${CHECK_SUITE_FIELDS}
            }
          }
        }
      }
    }
  }
}`;

const MAX_SUITE_PAGES = 5;

// A head on a busy repository carries well over 100 check contexts, and a
// failure past the first page must not read as "all green".
const CHECKS_PAGE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                ${CHECK_CONTEXT_FIELDS}
              }
            }
          }
        }
      }
    }
  }
}`;

// Threads come oldest first, so a new one on a PR past 100 threads is on a
// later page.
const THREADS_PAGE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        ${REVIEW_THREAD_FIELDS}
      }
    }
  }
}`;

const MAX_CHECK_PAGES = 10;
const MAX_THREAD_PAGES = 10;

interface Author {
  __typename: string;
  login: string;
}

export interface CommentNode {
  id: string;
  databaseId?: number;
  author: Author | null;
  authorAssociation: string;
  body: string;
  url: string;
  state?: string;
  /** Thread comments: the comment this one answers, when it is a reply. */
  replyTo?: { id: string } | null;
  /** GitHub could not say whether this bot comment is a reply. */
  replyUnknown?: true;
}

type CheckContext =
  | {
      __typename: 'CheckRun';
      name: string;
      status: string;
      conclusion: string | null;
      detailsUrl: string | null;
      /** Grows with every run, so it orders the attempts of one check. */
      databaseId: number;
      checkSuite?: {
        /** The whole run's progress: `COMPLETED` once every job ended. */
        status?: string;
        app: { databaseId: number } | null;
        workflowRun: {
          event: string;
          workflow: { databaseId: number } | null;
        } | null;
      } | null;
    }
  | {
      __typename: 'StatusContext';
      context: string;
      state: string;
      targetUrl: string | null;
      createdAt: string;
    };

interface CheckRollup {
  contexts: {
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
    nodes: CheckContext[];
  };
}

interface CheckSuites {
  pageInfo?: { hasPreviousPage: boolean; startCursor?: string | null };
  nodes: CheckSuite[];
}

/** A check suite: what is left of a workflow GitHub could not start. */
interface CheckSuite {
  databaseId: number;
  conclusion: string | null;
  app?: { databaseId: number } | null;
  workflowRun: {
    databaseId: number;
    url: string;
    event: string;
    workflow: { databaseId: number; name: string };
  } | null;
}

interface ReviewThreads {
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  nodes: Array<{
    id: string;
    isResolved: boolean;
    isOutdated: boolean;
    path: string;
    line: number | null;
    root: { nodes: Array<{ databaseId: number }> };
    // `last: 100`: what is cut is the oldest replies.
    comments: {
      pageInfo: { hasPreviousPage: boolean };
      nodes: CommentNode[];
    };
  }>;
}

export interface PrData {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  title?: string;
  url: string;
  headRefOid: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  author?: { login: string } | null;
  commits: {
    nodes: Array<{
      commit: {
        oid: string;
        statusCheckRollup: CheckRollup | null;
        checkSuites?: CheckSuites;
      };
    }>;
  };
  reviewThreads: ReviewThreads;
  // `last: 100`: what is cut is the oldest entries.
  reviews: {
    pageInfo: { hasPreviousPage: boolean };
    nodes: CommentNode[];
  };
  comments: {
    pageInfo: { hasPreviousPage: boolean };
    nodes: CommentNode[];
  };
}

export type Trust = 'owner' | 'member' | 'collaborator' | 'pr_author' | 'bot';

export interface CommentRef {
  id: string;
  author: string;
  trust: Trust;
  body: string;
  url: string;
  /** Gate output only: the body was cut; `url` leads to the whole of it. */
  bodyTruncated?: true;
}

export type SnapshotEvent =
  | { type: 'merged' | 'closed' }
  | { type: 'head_moved_externally'; sha: string }
  | { type: 'conflict' }
  | { type: 'ci_pending'; checks: string[] }
  | {
      type: 'ci_failed';
      check: string;
      url: string | null;
      runId: number | null;
      /** Prepared mode only: the attempt's key, which `reply` records for a
       * failure handled without a push. */
      key?: string;
      /** GitHub could not start the workflow: no job ran, so there is no
       * log to fix from and nothing `gh run rerun --failed` re-runs. */
      startupFailure?: true;
      /** Prepared mode only: the check failed again on the heads of
       * `MAX_CHECK_FIX_PUSHES` of the watch's own pushes with no pass seen
       * between, so it is not fixed again but left for a person. */
      exhausted?: true;
    }
  | {
      type: 'review_thread';
      threadId: string;
      /** Top-level comment id: the REST replies endpoint only takes this. */
      replyTo: number | null;
      path: string;
      line: number | null;
      outdated: boolean;
      comments: CommentRef[];
    }
  | ({ type: 'review'; state: string } & CommentRef)
  | ({ type: 'issue_comment' } & CommentRef)
  | {
      type: 'untrusted_comment';
      id: string;
      author: string;
      url: string;
    }
  /** Gate only: a background fix whose session ended before its round
   * went on; the next round handles its items again. */
  | { type: 'abandoned_fix'; startedAt: string | null };

export interface Snapshot {
  action: 'stop' | 'resync' | 'fix' | 'wait';
  headSha: string;
  isDraft: boolean;
  /** The PR's title (prepared mode): the summary is written in its language. */
  title?: string;
  url: string;
  events: SnapshotEvent[];
  /** Connections cut at the page size; events past the cut are missing. */
  truncated: string[];
  /** Gate output only: events left out to keep the line within the gate's
   * output budget; the next run reports them. */
  deferred?: number;
  /** Prepared mode: the API has not caught up with the branch yet, so this
   * snapshot carries no checks or conflict; a later one will. */
  lagging?: true;
  /** Prepared mode: a check fails while the branch is behind its base, so
   * the failure may be the base's fault; the brief merges the base first. */
  baseBehind?: true;
}

const TRUSTED_ASSOCIATIONS: Record<string, Trust> = {
  OWNER: 'owner',
  MEMBER: 'member',
  COLLABORATOR: 'collaborator',
};

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE']);
const FAILED_STATUSES = new Set(['FAILURE', 'ERROR']);
const PENDING_STATUSES = new Set(['PENDING', 'EXPECTED']);
/** What a check run ends in when it passed; a status passes on `SUCCESS`. */
const PASSED_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL']);
/** Comment bodies in gate output are cut to this many characters. */
const GATE_BODY_CHARS = 1000;
/** Reported comment ids the query no longer returns are bounded to this
 * many; ids still on the page are always kept (see `buildGateSnapshot`). */
const MAX_OFF_PAGE_COMMENT_IDS = 2000;

/**
 * Bots count only for reviews and review threads: their PR conversation
 * comments are reports (coverage, CI summaries), not requests, so they are
 * dropped rather than listed as untrusted.
 */
export function classify(
  node: CommentNode,
  kind: 'review' | 'thread' | 'issue_comment',
  prAuthor: string,
): Trust | 'untrusted' | 'ignore' {
  if (!node.author) return 'untrusted';
  if (node.author.__typename === 'Bot') {
    return kind === 'issue_comment' ? 'ignore' : 'bot';
  }
  const association = TRUSTED_ASSOCIATIONS[node.authorAssociation];
  if (association) return association;
  if (node.author.login === prAuthor) return 'pr_author';
  return 'untrusted';
}

/**
 * The run id of a GitHub Actions job of the PR's repository, read from its
 * URL. Anything else — a commit status, another app's check, a URL of
 * another repository — may link any run, and `ci-log` would hand the fix
 * agent the log of a run that is not the PR's.
 */
function runIdFrom(
  url: string | null,
  runsPrefix: string,
  actions: boolean,
): number | null {
  if (!actions || !url?.toLowerCase().startsWith(runsPrefix)) return null;
  const match = /^(\d+)(?:[/?#]|$)/.exec(url.slice(runsPrefix.length));
  return match ? Number(match[1]) : null;
}

type CiFailed = Extract<SnapshotEvent, { type: 'ci_failed' }>;

/**
 * The rollup can list several runs of one check on the head: each trigger
 * of a workflow that runs on several events, each run a review starts, an
 * earlier attempt of a re-run job. Only the latest run of a check says
 * whether it is failing now; a failure that a re-run turned green is
 * history.
 *
 * A check run is one check per app, workflow, trigger and name. The app
 * keeps apart two providers that publish the same name, since a branch rule
 * can require the check from one of them; workflows are told apart by id,
 * since two workflow files may share a display name.
 */
function latestContexts(nodes: CheckContext[]): CheckContext[] {
  // A job a run skipped (its `if:` was false: a review-started workflow
  // that runs on approvals only, say) did not run. It answers nothing of
  // the check, and leaves the run before it in place.
  const skipped = (ctx: CheckContext) =>
    ctx.__typename === 'CheckRun' && ctx.conclusion === 'SKIPPED';
  const latest = new Map<string, CheckContext>();
  for (const ctx of nodes) {
    const key = checkIdentity(ctx);
    const seen = latest.get(key);
    if (
      !seen ||
      (skipped(seen) && !skipped(ctx)) ||
      (skipped(seen) === skipped(ctx) && attemptOrder(ctx) > attemptOrder(seen))
    ) {
      latest.set(key, ctx);
    }
  }
  return [...latest.values()];
}

/**
 * A failure the round deferred the re-run of, while its run still goes:
 * the round's again once the run has ended, and left out until then. Only
 * the check runs the deferral held are: a job of the run that failed after
 * it is the round's now, however long the run goes on.
 */
function heldByDeferral(
  failure: FailedCheck,
  head: string,
  deferred: Set<number>,
  held: Set<string>,
): boolean {
  const run = failure.event.runId;
  return (
    !failure.runDone &&
    run !== null &&
    deferred.has(run) &&
    failure.checkRunId !== undefined &&
    held.has(`${run}:${failure.identity}@${head}@${failure.checkRunId}`)
  );
}

/** What makes two runs attempts of one check (see `latestContexts`). */
function checkIdentity(ctx: CheckContext): string {
  if (ctx.__typename !== 'CheckRun') return `status:${ctx.context}`;
  const suite = ctx.checkSuite;
  const run = suite?.workflowRun;
  return [
    'run',
    suite?.app?.databaseId ?? '',
    run?.workflow?.databaseId ?? '',
    run?.event ?? '',
    ctx.name,
  ].join(':');
}

/**
 * The attempt a failure is keyed by: the check run, or — for a workflow a
 * review or a comment starts — the workflow and its trigger, once per head.
 * Such a workflow runs again for every review anyone submits, a stranger's
 * included, and a new run of a failure already handled says nothing new of
 * the code; reported per run, each would start another round.
 */
function checkRunAttempt(
  ctx: Extract<CheckContext, { __typename: 'CheckRun' }>,
  head: string,
  rerun: Map<string, number>,
): string {
  const run = ctx.checkSuite?.workflowRun;
  if (run && !CODE_EVENTS.has(run.event)) {
    // Once re-run on the head, a failure of a later run is the one the
    // re-run answered with: reported once more, under a key of its own, so
    // it is answered as real rather than taken for the one already handled.
    // The run that was re-run keeps its key: GitHub lists the re-run only
    // once it starts, and one whose answer was lost may have started none.
    const reran = rerun.get(`${checkIdentity(ctx)}@${head}`);
    const again = reran !== undefined && ctx.databaseId > reran;
    return `#${again ? 'rerun' : 'on'}:${run.workflow?.databaseId ?? ''}:${run.event}`;
  }
  return `#${ctx.databaseId}`;
}

/**
 * The floor of each re-run check and head, by `<identity>@<head>`, read
 * from `<identity>@<head>@<check run id>` entries (`rerunFloors`: spent
 * and held re-runs). An entry without its check run counts every run of
 * the check as the re-run's.
 */
export function rerunFrom(rerunChecks: Iterable<string>): Map<string, number> {
  const from = new Map<string, number>();
  for (const entry of rerunChecks) {
    // A job name may hold a line break.
    const match = /^([\s\S]*)@(\d+)$/.exec(entry);
    const [key, run] = match ? [match[1], Number(match[2])] : [entry, 0];
    from.set(key, Math.max(from.get(key) ?? 0, run));
  }
  return from;
}

function attemptOrder(ctx: CheckContext): number {
  return ctx.__typename === 'CheckRun'
    ? ctx.databaseId
    : Date.parse(ctx.createdAt);
}

export interface FailedCheck {
  event: CiFailed;
  /** The attempt: a check run's id (`#<databaseId>`) or a status's time. */
  attempt: string;
  /** The check across its attempts: app, workflow, trigger and name. */
  identity: string;
  /** A GitHub Actions job, the only kind `gh run rerun` can re-run. */
  actions: boolean;
  /** The check run, for a check run (not a status or a run that never
   * started). */
  checkRunId?: number;
  /** Its run has ended: GitHub re-runs a run only then. Commit statuses
   * and other apps' checks have no run and count as ended. */
  runDone: boolean;
}

/** The failed checks of the head, each with the identity of its attempt. */
export function checkEvents(
  pr: PrData,
  rerunChecks: Iterable<string> = [],
): {
  failed: FailedCheck[];
  pending: string[];
  truncated: boolean;
} {
  const commit = pr.commits.nodes[0]?.commit;
  // A rollup for any other commit describes a head that is already gone.
  if (!commit || commit.oid !== pr.headRefOid) {
    return { failed: [], pending: [], truncated: false };
  }
  // No rollup at all is a head with no check run and no status — which is
  // what a workflow GitHub could not start leaves behind.
  const contexts = commit.statusCheckRollup?.contexts ?? {
    pageInfo: { hasNextPage: false },
    nodes: [],
  };
  const failed: FailedCheck[] = [];
  const pending: string[] = [];
  const rerun = rerunFrom(rerunChecks);
  const runsPrefix =
    `${pr.url.replace(/\/pull\/\d+\/?$/, '')}/actions/runs/`.toLowerCase();
  for (const ctx of latestContexts(contexts.nodes)) {
    if (ctx.__typename === 'CheckRun') {
      if (ctx.status !== 'COMPLETED') pending.push(ctx.name);
      else if (ctx.conclusion && FAILED_CONCLUSIONS.has(ctx.conclusion)) {
        failed.push({
          event: {
            type: 'ci_failed',
            check: ctx.name,
            url: ctx.detailsUrl,
            runId: runIdFrom(
              ctx.detailsUrl,
              runsPrefix,
              Boolean(ctx.checkSuite?.workflowRun),
            ),
          },
          attempt: checkRunAttempt(ctx, pr.headRefOid, rerun),
          identity: checkIdentity(ctx),
          actions: Boolean(ctx.checkSuite?.workflowRun),
          checkRunId: ctx.databaseId,
          runDone:
            !ctx.checkSuite?.workflowRun ||
            (ctx.checkSuite.status ?? 'COMPLETED') === 'COMPLETED',
        });
      }
    } else if (PENDING_STATUSES.has(ctx.state)) {
      pending.push(ctx.context);
    } else if (FAILED_STATUSES.has(ctx.state)) {
      failed.push({
        event: {
          type: 'ci_failed',
          check: ctx.context,
          url: ctx.targetUrl,
          runId: null,
        },
        attempt: ctx.createdAt,
        identity: checkIdentity(ctx),
        actions: false,
        runDone: true,
      });
    }
  }
  failed.push(...startupFailures(commit.checkSuites?.nodes ?? []));
  return {
    failed,
    pending,
    truncated:
      contexts.pageInfo.hasNextPage ||
      Boolean(commit.checkSuites?.pageInfo?.hasPreviousPage),
  };
}

/** What a commit's checks ended in, by check identity: a check that is
 * still running, was cancelled or skipped, or is not listed has no entry. */
export type CheckResults = ReadonlyMap<string, 'passed' | 'failed'>;

/** Commits a read asks GitHub about for the fix budget, at most. */
export const MAX_CHECK_LOOKUPS = 4;

function checkResults(
  contexts: CheckContext[],
): Map<string, 'passed' | 'failed'> {
  const results = new Map<string, 'passed' | 'failed'>();
  for (const ctx of latestContexts(contexts)) {
    const [failed, passed] =
      ctx.__typename === 'CheckRun'
        ? ctx.status === 'COMPLETED'
          ? [
              FAILED_CONCLUSIONS.has(ctx.conclusion ?? ''),
              PASSED_CONCLUSIONS.has(ctx.conclusion ?? ''),
            ]
          : [false, false]
        : [FAILED_STATUSES.has(ctx.state), ctx.state === 'SUCCESS'];
    if (failed) results.set(checkIdentity(ctx), 'failed');
    else if (passed) results.set(checkIdentity(ctx), 'passed');
  }
  return results;
}

/**
 * The watch's red checks once a round has read `pr`: the budget of fix
 * pushes per failing check (Section 10). A check is recorded on the first
 * head a round sees it fail on, and every later push of the watch it fails
 * on spends one of its pushes; a pass ends the record, and a head someone
 * else pushed gives every check its pushes back.
 *
 * The gate wakes no round for a pass, so a round may never read one: the
 * watch can push again (for a comment) before its fix's checks end, or a
 * re-run can pass after the round moved on. When a recorded check fails on
 * a later push of the watch, `resultsOn` therefore says what it ended in on
 * the watch's pushes in between that the record has not counted — and, when
 * a round re-ran it there, on the head it last failed on: a pass there
 * starts the count over, a failure on a push in between spends one (a
 * re-run that failed again on the last head spends nothing more), and no
 * result
 * (still running, cancelled, not listed, or GitHub not answering) spends
 * nothing. A return to a push of the watch older than the latest one the
 * record counted spends nothing.
 */
export function trackFailingChecks(
  pr: PrData,
  state: AutofixPrState,
  resultsOn: (sha: string) => CheckResults | null = () => null,
): FailingCheck[] {
  const records = state.failingChecks ?? [];
  const commit = pr.commits.nodes[0]?.commit;
  if (pr.state !== 'OPEN' || !commit || commit.oid !== pr.headRefOid) {
    return records;
  }
  const head = pr.headRefOid;
  // Where a head stands among the watch's pushes, oldest first; -1 for one
  // someone else pushed.
  const pushOrder = (sha: string | undefined) =>
    sha === undefined ? -1 : state.pushedShas.lastIndexOf(sha);
  const at = pushOrder(head);
  // A count starts from the latest push of the watch: a return to an older
  // one is no new push.
  const baseline = at >= 0 ? head : state.pushedShas.at(-1);
  const now = checkResults(commit.statusCheckRollup?.contexts.nodes ?? []);
  // `<identity>@<head>` of the checks a round re-ran on a head.
  const reran = new Set(
    rerunFloors(state).map((entry) => entry.replace(/@\d+$/, '')),
  );
  const fresh = (identity: string, check: string): FailingCheck => ({
    identity,
    check,
    head,
    pushes: 0,
    ...(baseline === undefined ? {} : { lastPush: baseline }),
  });
  const names = new Map<string, string>();
  for (const ctx of latestContexts(
    commit.statusCheckRollup?.contexts.nodes ?? [],
  )) {
    names.set(
      checkIdentity(ctx),
      ctx.__typename === 'CheckRun' ? ctx.name : ctx.context,
    );
  }
  const kept: FailingCheck[] = [];
  const updated: FailingCheck[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    seen.add(record.identity);
    const result = now.get(record.identity);
    if (result === 'passed') continue;
    let next: FailingCheck;
    if (at < 0) {
      // Someone else pushed: whatever it holds, the check is theirs again.
      next =
        result === 'failed'
          ? fresh(record.identity, names.get(record.identity)!)
          : {
              ...record,
              pushes: 0,
              ...(baseline === undefined ? {} : { lastPush: baseline }),
            };
    } else if (result === 'failed' && at > pushOrder(record.lastPush)) {
      let pushes = record.pushes;
      // A re-run on the head it last failed on may have passed since.
      if (
        record.head !== head &&
        reran.has(`${record.identity}@${record.head}`) &&
        resultsOn(record.head)?.get(record.identity) === 'passed'
      ) {
        pushes = 0;
      }
      // The watch's pushes in between, oldest first: the newest of them
      // are asked about, the rest count as no result.
      const between = state.pushedShas
        .slice(pushOrder(record.lastPush) + 1, at)
        .slice(-(MAX_CHECK_LOOKUPS - 1));
      for (const sha of between) {
        const there = resultsOn(sha)?.get(record.identity);
        if (there === 'passed') pushes = 0;
        else if (there === 'failed') pushes += 1;
      }
      next = {
        identity: record.identity,
        check: names.get(record.identity)!,
        head,
        pushes: pushes + 1,
        lastPush: head,
      };
    } else if (result === 'failed') {
      next = { ...record, check: names.get(record.identity)!, head };
    } else {
      kept.push(record);
      continue;
    }
    // The ones a read changed go last, so the cap drops the stalest.
    if (JSON.stringify(next) === JSON.stringify(record)) kept.push(record);
    else updated.push(next);
  }
  for (const [identity, result] of now) {
    if (result === 'failed' && !seen.has(identity)) {
      updated.push(fresh(identity, names.get(identity)!));
    }
  }
  return [...kept, ...updated].slice(-MAX_FAILING_CHECKS);
}

const COMMIT_CHECKS_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!, $after: String) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        statusCheckRollup {
          contexts(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            ${CHECK_CONTEXT_FIELDS}
          }
        }
      }
    }
  }
}`;

/**
 * What the checks of one commit of the PR's repository ended in, paged as
 * the PR's own checks are; null when GitHub does not answer, which the
 * budget takes for no result.
 */
export function commitCheckResults(
  target: Pick<PrTarget, 'owner' | 'repo'>,
  sha: string,
): CheckResults | null {
  const contexts: CheckContext[] = [];
  let after: string | null = null;
  // A rollup cut at the page limit may hold a later run of a check on the
  // pages not read: no answer, rather than a wrong one.
  let cut = true;
  try {
    for (let page = 0; page < MAX_CHECK_PAGES; page += 1) {
      const data = JSON.parse(
        gh(
          'api',
          'graphql',
          '-f',
          `query=${COMMIT_CHECKS_QUERY}`,
          '-f',
          `owner=${target.owner}`,
          '-f',
          `name=${target.repo}`,
          '-f',
          `oid=${sha}`,
          ...(after === null ? [] : ['-f', `after=${after}`]),
        ),
      ) as {
        data?: {
          repository?: {
            object?: {
              statusCheckRollup?: {
                contexts: {
                  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
                  nodes: CheckContext[];
                };
              } | null;
            } | null;
          } | null;
        };
      };
      const rollup = data.data?.repository?.object?.statusCheckRollup;
      if (rollup) contexts.push(...rollup.contexts.nodes);
      after = rollup?.contexts.pageInfo.hasNextPage
        ? (rollup.contexts.pageInfo.endCursor ?? null)
        : null;
      if (after === null) {
        cut = Boolean(rollup?.contexts.pageInfo.hasNextPage);
        break;
      }
    }
  } catch {
    return null;
  }
  return cut ? null : checkResults(contexts);
}

/**
 * Every failed or cancelled job of a run on the head, by its latest attempt
 * in the run, whether or not a later run of its check took its place on the
 * PR: `gh run rerun --failed` re-runs them all, so each spends its check's
 * re-run. `floor` is the check run a later run of the check must come
 * after to be the re-run's answer: this job's, or the latest one of its
 * check on the PR when a later run is there already.
 */
export function failedJobsOfRun(
  pr: PrData,
  runId: number,
): Array<{
  check: string;
  identity: string;
  checkRunId: number;
  floor: number;
}> {
  const commit = pr.commits.nodes[0]?.commit;
  if (!commit || commit.oid !== pr.headRefOid) return [];
  const runsPrefix =
    `${pr.url.replace(/\/pull\/\d+\/?$/, '')}/actions/runs/`.toLowerCase();
  const nodes = commit.statusCheckRollup?.contexts.nodes ?? [];
  const latest = new Map(
    latestContexts(nodes).map((ctx) => [checkIdentity(ctx), ctx]),
  );
  const ofRun = nodes.filter(
    (ctx) =>
      ctx.__typename === 'CheckRun' &&
      runIdFrom(
        ctx.detailsUrl,
        runsPrefix,
        Boolean(ctx.checkSuite?.workflowRun),
      ) === runId,
  );
  return latestContexts(ofRun).flatMap((ctx) => {
    if (
      ctx.__typename !== 'CheckRun' ||
      ctx.status !== 'COMPLETED' ||
      !ctx.conclusion ||
      !(
        FAILED_CONCLUSIONS.has(ctx.conclusion) || ctx.conclusion === 'CANCELLED'
      )
    ) {
      return [];
    }
    const identity = checkIdentity(ctx);
    const last = latest.get(identity);
    return [
      {
        check: ctx.name,
        identity,
        checkRunId: ctx.databaseId,
        floor: Math.max(
          ctx.databaseId,
          last?.__typename === 'CheckRun' ? last.databaseId : 0,
        ),
      },
    ];
  });
}

/**
 * The keys of the failures a deferral holds while their run goes (see
 * `heldByDeferral`): the gate reports them again once the run has ended,
 * and the round answers them then.
 */
export function heldKeys(
  pr: PrData,
  state: Pick<AutofixPrState, 'rerunChecks' | 'heldChecks' | 'deferredRuns'>,
): Set<string> {
  const deferred = new Set(state.deferredRuns ?? []);
  const held = new Set(state.heldChecks ?? []);
  return new Set(
    checkEvents(pr, rerunFloors(state))
      .failed.filter((failure) =>
        heldByDeferral(failure, pr.headRefOid, deferred, held),
      )
      .map(({ event, attempt }) =>
        checkAttemptKey(event.check, pr.headRefOid, attempt),
      ),
  );
}

/** The latest check run of each check on the head, by identity and head. */
function latestCheckRuns(pr: PrData): Map<string, number> {
  const commit = pr.commits.nodes[0]?.commit;
  const latest = new Map<string, number>();
  for (const ctx of latestContexts(
    commit?.statusCheckRollup?.contexts.nodes ?? [],
  )) {
    if (ctx.__typename === 'CheckRun') {
      latest.set(`${checkIdentity(ctx)}@${pr.headRefOid}`, ctx.databaseId);
    }
  }
  return latest;
}

/** The latest check run of each Actions run on the head, by run id. */
function latestOfRuns(pr: PrData): Map<number, number> {
  const commit = pr.commits.nodes[0]?.commit;
  const runsPrefix =
    `${pr.url.replace(/\/pull\/\d+\/?$/, '')}/actions/runs/`.toLowerCase();
  const latest = new Map<number, number>();
  for (const ctx of commit?.statusCheckRollup?.contexts.nodes ?? []) {
    if (ctx.__typename !== 'CheckRun') continue;
    const run = runIdFrom(
      ctx.detailsUrl,
      runsPrefix,
      Boolean(ctx.checkSuite?.workflowRun),
    );
    if (run !== null) {
      latest.set(run, Math.max(latest.get(run) ?? 0, ctx.databaseId));
    }
  }
  return latest;
}

/** Events that run a workflow on the PR's code, rather than on a comment. */
const CODE_EVENTS = new Set(['pull_request', 'pull_request_target', 'push']);

/**
 * Workflows GitHub could not start — an invalid workflow file, say — which
 * leave no check run in the rollup, only their suite. Only the latest run
 * of each workflow and trigger counts (a later one that started supersedes
 * it), only one the PR's code triggered (a workflow run for each review
 * comment fails to start as often as GitHub has trouble, and says nothing
 * of the code), and it is one failure per head, however often it recurs.
 */
function startupFailures(suites: CheckSuite[]): FailedCheck[] {
  const latest = new Map<string, CheckSuite>();
  for (const suite of suites) {
    const run = suite.workflowRun;
    if (!run || !CODE_EVENTS.has(run.event)) continue;
    const identity = [
      'run',
      suite.app?.databaseId ?? '',
      run.workflow.databaseId,
      run.event,
      '',
    ].join(':');
    const known = latest.get(identity);
    if (!known || known.databaseId < suite.databaseId) {
      latest.set(identity, suite);
    }
  }
  const failed: FailedCheck[] = [];
  for (const [identity, suite] of latest) {
    const run = suite.workflowRun!;
    if (suite.conclusion !== 'STARTUP_FAILURE') continue;
    failed.push({
      event: {
        type: 'ci_failed',
        check: run.workflow.name,
        url: run.url,
        runId: run.databaseId,
        startupFailure: true,
      },
      attempt: `#startup:${run.workflow.databaseId}:${run.event}`,
      identity,
      actions: false,
      runDone: true,
    });
  }
  return failed;
}

/**
 * Review threads, reviews and conversation comments that `isNew` admits,
 * classified by trust. `ids` lists every admitted comment, trusted or not,
 * so a gate cursor can remember them.
 */
function commentEvents(
  pr: PrData,
  prAuthor: string,
  isNew: (node: CommentNode) => boolean,
): {
  events: SnapshotEvent[];
  ids: string[];
  /** Bot replies, which are never requests: the gate keeps them as seen. */
  skipped: string[];
  truncated: string[];
} {
  const ref = (node: CommentNode, trust: Trust): CommentRef => ({
    id: node.id,
    author: node.author!.login,
    trust,
    body: node.body,
    url: node.url,
  });
  const untrusted = (node: CommentNode): SnapshotEvent => ({
    type: 'untrusted_comment',
    id: node.id,
    author: node.author?.login ?? 'ghost',
    url: node.url,
  });
  const events: SnapshotEvent[] = [];
  const ids: string[] = [];
  const skipped: string[] = [];
  const truncated: string[] = [];

  for (const thread of pr.reviewThreads.nodes) {
    if (thread.isResolved) continue;
    if (
      thread.comments.pageInfo.hasPreviousPage &&
      !truncated.includes('reviewThreadComments')
    ) {
      truncated.push('reviewThreadComments');
    }
    const comments: CommentRef[] = [];
    for (const node of thread.comments.nodes) {
      // A comment of a review not submitted yet is a draft only its author
      // sees.
      if (!isNew(node) || node.state === 'PENDING') continue;
      const trust = classify(node, 'thread', prAuthor);
      if (trust === 'ignore') continue;
      // A bot asks in the comment that opens a thread; a reply of one
      // answers someone — the tool, which a bot answering every reply
      // would keep a round going for, or an untrusted commenter, who could
      // have a bot speak for them. A reply stays one when the comment it
      // answered is deleted, and the gate keeps it as seen, so it never
      // turns into a new request.
      if (trust === 'bot' && node.replyUnknown) continue;
      if (
        trust === 'bot' &&
        (node.replyTo || node.databaseId !== thread.root.nodes[0]?.databaseId)
      ) {
        skipped.push(node.id);
        continue;
      }
      ids.push(node.id);
      if (trust === 'untrusted') events.push(untrusted(node));
      else comments.push(ref(node, trust));
    }
    if (comments.length === 0) continue;
    events.push({
      type: 'review_thread',
      threadId: thread.id,
      replyTo: thread.root.nodes[0]?.databaseId ?? null,
      path: thread.path,
      line: thread.line,
      outdated: thread.isOutdated,
      comments,
    });
  }

  // A review's inline comments arrive through its threads; only a review
  // with a body of its own says something the threads do not. A dismissed
  // review was withdrawn, and an approval's body ("LGTM") accepts the PR:
  // neither asks for anything.
  for (const node of pr.reviews.nodes) {
    if (
      node.state === 'PENDING' ||
      node.state === 'DISMISSED' ||
      node.state === 'APPROVED'
    ) {
      continue;
    }
    if (!node.body.trim() || !isNew(node)) continue;
    const trust = classify(node, 'review', prAuthor);
    if (trust === 'ignore') continue;
    ids.push(node.id);
    if (trust === 'untrusted') events.push(untrusted(node));
    else
      events.push({ type: 'review', state: node.state!, ...ref(node, trust) });
  }

  for (const node of pr.comments.nodes) {
    if (!isNew(node)) continue;
    const trust = classify(node, 'issue_comment', prAuthor);
    if (trust === 'ignore') continue;
    ids.push(node.id);
    if (trust === 'untrusted') events.push(untrusted(node));
    else events.push({ type: 'issue_comment', ...ref(node, trust) });
  }

  if (pr.reviewThreads.pageInfo.hasNextPage) truncated.push('reviewThreads');
  if (pr.reviews.pageInfo.hasPreviousPage) truncated.push('reviews');
  if (pr.comments.pageInfo.hasPreviousPage) truncated.push('comments');
  return { events, ids, skipped, truncated };
}

/** The id of every comment, review and thread comment the query returned. */
function queriedCommentIds(pr: PrData): Set<string> {
  const ids = new Set<string>();
  for (const thread of pr.reviewThreads.nodes) {
    for (const node of thread.comments.nodes) ids.add(node.id);
  }
  for (const node of pr.reviews.nodes) ids.add(node.id);
  for (const node of pr.comments.nodes) ids.add(node.id);
  return ids;
}

function isActionable(event: SnapshotEvent): boolean {
  return (
    event.type === 'conflict' ||
    event.type === 'ci_failed' ||
    event.type === 'review_thread' ||
    event.type === 'review' ||
    event.type === 'issue_comment'
  );
}

/**
 * A reply this tool posted: by the viewer, ending with the marker. Anyone
 * else's comment that carries the marker quotes a reply, and is new.
 */
export function isOwnReply(node: CommentNode, viewer: string): boolean {
  return (
    node.author?.login === viewer && node.body.trimEnd().endsWith(REPLY_MARKER)
  );
}

/**
 * `branchHead` is the PR branch's commit as the remote reports it now, read
 * when the API's head differs from the one the watch knows. The API can lag
 * a push by some seconds: while the branch still stands at the known head,
 * the API's head is stale, not someone else's push, and its checks and
 * merge state describe that stale head, so they are left out until it
 * catches up (`lagging`). Without it, a head the watch pushed itself is
 * taken for the same lag.
 */
export function buildSnapshot(
  pr: PrData,
  state: AutofixPrState,
  branchHead?: string | null,
): Snapshot {
  const seen = new Set([...state.handledCommentIds, ...state.postedCommentIds]);
  const isNew = (node: CommentNode) =>
    !seen.has(node.id) && !isOwnReply(node, state.viewer);

  const known = state.lastKnownHeadSha;
  const lagging =
    pr.state === 'OPEN' &&
    pr.headRefOid !== known &&
    branchHead !== undefined &&
    branchHead === known;
  const events: SnapshotEvent[] = [];
  const truncated: string[] = [];
  const base = {
    headSha: lagging ? known : pr.headRefOid,
    isDraft: pr.isDraft,
    ...(pr.title === undefined ? {} : { title: pr.title }),
    url: pr.url,
  };

  if (pr.state !== 'OPEN') {
    return {
      ...base,
      action: 'stop',
      events: [{ type: pr.state === 'MERGED' ? 'merged' : 'closed' }],
      truncated,
    };
  }

  const movedExternally =
    !lagging &&
    pr.headRefOid !== known &&
    (branchHead !== undefined || !state.pushedShas.includes(pr.headRefOid));
  if (movedExternally) {
    events.push({ type: 'head_moved_externally', sha: pr.headRefOid });
  }
  // A conflict left for a human is not reported again on the same head.
  if (
    !lagging &&
    pr.mergeable === 'CONFLICTING' &&
    state.handledConflictSha !== pr.headRefOid
  ) {
    events.push({ type: 'conflict' });
  }

  const checks = lagging
    ? { failed: [], pending: [], truncated: false }
    : checkEvents(pr, rerunFloors(state));
  // A failure handled without a push (declined, left for a human, re-run)
  // stays on the head, so it is skipped by its attempt; a re-run that fails
  // again is a new attempt. `key` is what `reply` and `rerun` record.
  const handledChecks = new Set(state.handledChecks ?? []);
  // A run the round could not re-run yet is offered again once it ended.
  const deferredRuns = new Set(state.deferredRuns ?? []);
  const held = new Set(state.heldChecks ?? []);
  // A check the watch's last pushes did not turn green is offered once
  // more per head, to be answered as a person's, not fixed again.
  const exhausted = new Set(
    (state.failingChecks ?? [])
      .filter((record) => record.pushes >= MAX_CHECK_FIX_PUSHES)
      .map((record) => record.identity),
  );
  for (const failure of checks.failed) {
    if (heldByDeferral(failure, pr.headRefOid, deferredRuns, held)) continue;
    const { event, attempt } = failure;
    const key = checkAttemptKey(event.check, pr.headRefOid, attempt);
    if (handledChecks.has(key)) continue;
    events.push({
      ...event,
      key,
      ...(exhausted.has(failure.identity) && !event.startupFailure
        ? { exhausted: true as const }
        : {}),
    });
  }
  if (checks.pending.length > 0) {
    events.push({ type: 'ci_pending', checks: checks.pending });
  }
  if (checks.truncated) truncated.push('checks');

  // The author GitHub names now, as the gate asks: a login can change
  // hands after a rename.
  const comments = commentEvents(pr, pr.author?.login ?? state.prAuthor, isNew);
  events.push(...comments.events);
  truncated.push(...comments.truncated);

  const action = movedExternally
    ? 'resync'
    : events.some(isActionable)
      ? 'fix'
      : 'wait';
  return {
    ...base,
    action,
    events,
    truncated,
    ...(lagging ? { lagging: true as const } : {}),
  };
}

/**
 * The base has commits the head does not, as GitHub's compare reports it.
 * Asked only by a round whose snapshot already holds a failed check, so
 * the gate stays free of the extra read. Any error answers false: a hint
 * is never worth failing a round over.
 */
export function baseIsBehind(state: AutofixPrState, headSha: string): boolean {
  try {
    const status = gh(
      'api',
      `repos/${state.owner}/${state.repo}/compare/${state.baseRefName}...${headSha}`,
      '--jq',
      '.status',
    ).trim();
    return status === 'behind' || status === 'diverged';
  } catch {
    return false;
  }
}

/**
 * What a prepared watch of the same PR already knows, so the gate does not
 * report it again: the heads it recorded or pushed, and the comments it
 * handled or posted.
 */
export interface GateWatch {
  knownHeads: string[];
  seenCommentIds: string[];
  /** Checks a round re-ran, by identity, head and check run. */
  rerunChecks?: string[];
  /** Re-runs a deferral holds, by run, identity, head and check run. */
  heldChecks?: string[];
  /** This run stopped reading at its time budget, in the check runs, in
   * the suites read after them (where failures to start are found) or in
   * the threads read last: what it did not read, and what came after it,
   * comes and goes with GitHub's speed. */
  partial?: 'checks' | 'suites' | 'threads';
  /** Failed attempts a round handled without a push. */
  handledChecks?: string[];
  /** Head whose conflict a round left for a human. */
  handledConflictSha?: string | null;
  /** Runs a round wanted re-run while they were still in progress: their
   * failures are reported once more when the run has ended. */
  deferredRuns?: number[];
}

/**
 * The gate probe: compares the PR with what the cursor already reported and
 * returns only the transitions, or `null` when there are none, together with
 * the cursor to store. Pending checks are never a transition; a failure
 * counts once per attempt; a conflict counts once per head; the viewer's own
 * comments are never events; a merge or close is reported once; a connection
 * that starts being cut is reported once.
 */
export function buildGateSnapshot(
  pr: PrData,
  cursor: AutofixPrGateCursor,
  watch: GateWatch = { knownHeads: [], seenCommentIds: [] },
): { snapshot: Snapshot | null; cursor: AutofixPrGateCursor } {
  const next: AutofixPrGateCursor = {
    ...cursor,
    reportedCommentIds: [...cursor.reportedCommentIds],
    reportedChecks: [...cursor.reportedChecks],
  };
  const base = {
    headSha: pr.headRefOid,
    isDraft: pr.isDraft,
    url: pr.url,
  };

  if (pr.state !== 'OPEN') {
    const stop = pr.state === 'MERGED' ? 'merged' : 'closed';
    if (next.stopped === stop) return { snapshot: null, cursor: next };
    next.stopped = stop;
    return {
      snapshot: {
        ...base,
        action: 'stop',
        events: [{ type: stop }],
        truncated: [],
      },
      cursor: next,
    };
  }
  // A closed PR that was reopened is watched again.
  next.stopped = null;

  const events: SnapshotEvent[] = [];
  const truncated: string[] = [];

  // A head the watch pushed itself, or already moved its worktree to, is
  // not someone else's push.
  const moved =
    next.headSha !== null &&
    next.headSha !== pr.headRefOid &&
    !watch.knownHeads.includes(pr.headRefOid);
  if (moved) events.push({ type: 'head_moved_externally', sha: pr.headRefOid });
  next.headSha = pr.headRefOid;

  if (pr.mergeable === 'CONFLICTING') {
    // A conflict a round left for a human is not news either.
    if (
      next.conflictSha !== pr.headRefOid &&
      watch.handledConflictSha !== pr.headRefOid
    ) {
      events.push({ type: 'conflict' });
    }
    next.conflictSha = pr.headRefOid;
  } else if (pr.mergeable === 'MERGEABLE') {
    next.conflictSha = null;
  }

  // A failure is reported once per (check, head, attempt): every run has an
  // id of its own (a commit status, its creation time), so a re-run that
  // fails again between two polls is still new. The cursor keeps only the
  // failures still present, so a check that goes green and fails later is
  // new as well.
  // A failure a round handled without a push counts as reported; one of a
  // run the round could not re-run yet is reported once more, under a key
  // of its own, when that run has ended.
  const checks = checkEvents(pr, rerunFloors(watch));
  const cursorChecks = new Set(next.reportedChecks);
  // A marked key (`<key>~<check run>`) was reported up to that check run.
  const marked = new Map<string, number>();
  for (const entry of cursorChecks) {
    const match = /^([\s\S]*)~(\d+)$/.exec(entry);
    if (match) {
      marked.set(match[1], Math.max(marked.get(match[1]) ?? 0, +match[2]));
    }
  }
  const handledChecks = new Set(watch.handledChecks ?? []);
  const deferred = new Set(watch.deferredRuns ?? []);
  const held = new Set(watch.heldChecks ?? []);
  const runsLatest = latestOfRuns(pr);
  // A read the time cut in the check runs lists a check's earlier runs and
  // not always its latest (the rollup lists them oldest first): it keeps
  // what the last whole read saw, and takes no earlier run for a failure.
  const cutInRuns = watch.partial === 'checks';
  const seenLatest = cutInRuns
    ? rerunFrom(
        (cursor.latestChecks ?? []).map((entry) =>
          entry.replace(/~(\d+)$/, '@$1'),
        ),
      )
    : latestCheckRuns(pr);
  const latestChecks = [...seenLatest].map(([check, run]) => `${check}~${run}`);
  if (latestChecks.length > 0 || cursor.latestChecks) {
    next.latestChecks = latestChecks;
  }
  // A run that did not read every check run keeps the failures it could
  // not see, one cut in the suites the failures to start found there; one
  // that read them all keeps only those still there.
  next.reportedChecks =
    watch.partial === 'checks'
      ? [...next.reportedChecks]
      : watch.partial === 'suites'
        ? next.reportedChecks.filter((key) => /@#startup:[^@]*$/.test(key))
        : [];
  const checkKeys = new Map<SnapshotEvent, string[]>();
  const candidates: SnapshotEvent[] = [];
  for (const failure of checks.failed) {
    // Prepared snapshots leave it out as well: a report would wake a round
    // with nothing to do.
    if (heldByDeferral(failure, pr.headRefOid, deferred, held)) continue;
    const { event, attempt, runDone, checkRunId, identity } = failure;
    if (
      cutInRuns &&
      checkRunId !== undefined &&
      (seenLatest.get(`${identity}@${pr.headRefOid}`) ?? 0) > checkRunId
    ) {
      continue;
    }
    const key = checkAttemptKey(event.check, pr.headRefOid, attempt);
    const keys = [key];
    // One a round has answered since, through another run of the check,
    // has nothing left for the round to do. A read cut in the check runs
    // may not list the run's latest one: the end, failure and all, waits
    // for a whole read.
    const ended =
      runDone &&
      event.runId !== null &&
      deferred.has(event.runId) &&
      !handledChecks.has(key);
    if (ended && cutInRuns) continue;
    if (ended) keys.push(`${key}@ended`);
    // A key that names no run (a workflow a review starts) is the same for
    // every run of its check on the head. The cursor marks the run it was
    // reported for, so a failure of a later one — a review started it while
    // a round read the PR — is reported again until a round handles it; an
    // earlier one (a partial read listed only it) is not. A run's end is
    // marked with the run's latest check run: a job re-run in it makes the
    // run go again, and a deferral of it again ends once more.
    const perRun = checkRunId !== undefined && /^#(?:on|rerun):/.test(attempt);
    const upTo = (k: string): number | undefined =>
      k.endsWith('@ended')
        ? (runsLatest.get(event.runId ?? -1) ?? checkRunId)
        : perRun
          ? checkRunId
          : undefined;
    const reported = (k: string) => {
      if (handledChecks.has(k)) return true;
      const run = upTo(k);
      return run === undefined
        ? cursorChecks.has(k)
        : (marked.get(k) ?? -1) >= run;
    };
    const mark = (k: string) => {
      const run = upTo(k);
      return run === undefined
        ? k
        : `${k}~${Math.max(run, marked.get(k) ?? 0)}`;
    };
    next.reportedChecks.push(...keys.filter(reported).map(mark));
    const unreported = keys.filter((k) => !reported(k));
    if (unreported.length > 0) {
      checkKeys.set(event, unreported.map(mark));
      candidates.push(event);
    }
  }
  if (checks.truncated) truncated.push('checks');

  const reportedComments = new Set([
    ...next.reportedCommentIds,
    ...watch.seenCommentIds,
  ]);
  // The viewer's own comments count as the round counts them (Section 8):
  // the viewer is often the PR author, answering a "Needs a human decision"
  // or asking for more; only the tool's own replies are left out.
  const isNew = (node: CommentNode) =>
    !reportedComments.has(node.id) && !isOwnReply(node, cursor.viewer);
  const comments = commentEvents(pr, cursor.prAuthor, isNew);
  candidates.push(...comments.events.map(withShortBodies));
  truncated.push(...comments.truncated);

  // What does not fit the gate's output is not marked reported, so the next
  // run reports it.
  const shown = fitGateOutput(
    (all, deferred) => ({
      ...base,
      action: 'resync',
      events: all,
      truncated,
      deferred,
    }),
    events,
    candidates,
  );
  events.push(...shown.events);
  const printedIds: string[] = [];
  for (const event of shown.events) {
    const keys = checkKeys.get(event);
    if (keys) next.reportedChecks.push(...keys);
    printedIds.push(...commentIds(event));
  }

  // Every reported id the query still returns stays in the cursor, however
  // many: one evicted while its comment is still on the page would be
  // reported again on the next poll, turning a quiet PR into a recurring
  // wakeup. Only ids that left the page — deleted, or past the last-100
  // windows — are bounded, newest kept.
  const onPage = queriedCommentIds(pr);
  const kept: string[] = [];
  const gone: string[] = [];
  for (const id of next.reportedCommentIds) {
    (onPage.has(id) ? kept : gone).push(id);
  }
  // What the prepared watch handled becomes the gate's own while the query
  // returns it: `cleanup` removes the state and keeps this cursor, and the
  // scheduled gate must stay quiet about those comments afterwards. One
  // off the page can no longer be an event, so it is not adopted.
  const known = new Set(next.reportedCommentIds);
  const adopted = new Set(
    watch.seenCommentIds.filter((id) => onPage.has(id) && !known.has(id)),
  );
  const printed = new Set(printedIds);
  next.reportedCommentIds = [
    ...gone.slice(-MAX_OFF_PAGE_COMMENT_IDS),
    ...kept,
    ...adopted,
    ...printedIds,
    ...comments.skipped.filter(
      (id) => !known.has(id) && !adopted.has(id) && !printed.has(id),
    ),
  ];

  // A cut that hides what a later poll will not see is a transition itself:
  // reported when it appears, quiet while it lasts. Only connections read
  // from the front can hide something new — checks and threads past the
  // last page; comments and reviews are read newest first, so a cut there
  // only hides older ones, and is listed without waking the session.
  // A cut of the read budget comes and goes with GitHub's speed: it wakes
  // no one, and leaves its record of cuts as it was. The check runs are
  // read before the suites, and both before the threads, so time that ran
  // out in one cut what comes after it. A check run page cap is a cut of
  // `checks` whatever the suites' time did.
  next.reportedChecks = [...new Set(next.reportedChecks)];
  const reportedTruncated = new Set(cursor.reportedTruncated ?? []);
  const capped = Boolean(
    pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.pageInfo
      .hasNextPage,
  );
  const late = new Set(
    watch.partial === 'checks' || (watch.partial === 'suites' && !capped)
      ? ['checks', 'reviewThreads']
      : watch.partial
        ? ['reviewThreads']
        : [],
  );
  const newlyCut = truncated.some(
    (name) =>
      FRONT_READ.has(name) && !late.has(name) && !reportedTruncated.has(name),
  );
  next.reportedTruncated = [
    ...truncated.filter((name) => !late.has(name)),
    ...[...reportedTruncated].filter((name) => late.has(name)),
  ];

  if (events.length === 0 && !newlyCut) {
    return { snapshot: null, cursor: next };
  }
  const action = moved ? 'resync' : events.some(isActionable) ? 'fix' : 'wait';
  const snapshot: Snapshot = { ...base, action, events, truncated };
  if (shown.deferred > 0) snapshot.deferred = shown.deferred;
  return { snapshot, cursor: next };
}

/** Connections read from their first page, where a cut hides new items. */
const FRONT_READ = new Set(['checks', 'reviewThreads']);

/** The comment ids an event reports. */
function commentIds(event: SnapshotEvent): string[] {
  switch (event.type) {
    case 'review_thread':
      return event.comments.map((comment) => comment.id);
    case 'review':
    case 'issue_comment':
    case 'untrusted_comment':
      return [event.id];
    default:
      return [];
  }
}

/** A body in gate output is cut to its first `GATE_BODY_CHARS`; the event's
 * url leads to the whole of it. */
function withShortBodies(event: SnapshotEvent): SnapshotEvent {
  const cut = <T extends CommentRef>(ref: T): T => {
    if (ref.body.length <= GATE_BODY_CHARS) return ref;
    // Not half of a surrogate pair: the line must stay valid UTF-8.
    const body = ref.body
      .slice(0, GATE_BODY_CHARS)
      .replace(/[\uD800-\uDBFF]$/, '');
    return { ...ref, body, bodyTruncated: true };
  };
  if (event.type === 'review_thread') {
    return { ...event, comments: event.comments.map(cut) };
  }
  if (event.type === 'review' || event.type === 'issue_comment') {
    return cut(event);
  }
  return event;
}

/**
 * The candidates that fit the gate's output after `fixed`, in order, and how
 * many wait for the next run: the first that does not fit and every one
 * after it. A review thread that does not fit whole shows the comments that
 * do. The first candidate, or the first comment of its thread, shows even
 * alone over the budget, so every run makes progress; with bodies cut, one
 * is well within the gate's cap.
 */
function fitGateOutput(
  line: (events: SnapshotEvent[], deferred: number) => unknown,
  fixed: SnapshotEvent[],
  candidates: SnapshotEvent[],
): { events: SnapshotEvent[]; deferred: number } {
  const shown: SnapshotEvent[] = [];
  const fits = (event: SnapshotEvent) =>
    jsonBytes(line([...fixed, ...shown, event], candidates.length)) <=
    GATE_OUTPUT_BUDGET_BYTES;
  for (const [index, event] of candidates.entries()) {
    if (fits(event)) {
      shown.push(event);
      continue;
    }
    let part: SnapshotEvent | null = null;
    if (event.type === 'review_thread' && event.comments.length > 1) {
      for (let count = event.comments.length - 1; count > 0; count--) {
        const head = { ...event, comments: event.comments.slice(0, count) };
        if (fits(head) || (count === 1 && shown.length === 0)) {
          part = head;
          break;
        }
      }
    } else if (shown.length === 0) {
      part = event;
    }
    if (part) shown.push(part);
    // A thread shown in part still waits, for the rest of its comments.
    const left = candidates.length - index - (part === event ? 1 : 0);
    return { events: shown, deferred: left };
  }
  return { events: shown, deferred: 0 };
}

export interface PrTarget {
  owner: string;
  repo: string;
  prNumber: number;
}

function graphql(query: string, target: PrTarget, extra: string[]): unknown {
  return JSON.parse(
    gh(
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      // -f, not -F: -F would turn an owner or repository named `true` or `123`
      // into a boolean or a number.
      '-f',
      `owner=${target.owner}`,
      '-f',
      `name=${target.repo}`,
      '-F',
      `number=${target.prNumber}`,
      ...extra,
    ),
  );
}

/** Bot comments the gate asks about over REST in one fire; the rest wait. */
const MAX_GATE_REPLY_CHECKS = 20;
/**
 * A gate run's time for reading GitHub, inside the shortest gate it runs
 * under: a Managed automation kills it at 20 seconds (a scheduled task
 * allows 60), at about 1.5 seconds a page. Past it, paging stops — what was
 * not read stays cut — and the bot comments not asked about wait for the
 * next fire.
 */
export const GATE_READ_BUDGET_MS = 15_000;
/** How long a round spends asking, inside the shell tool's ten minutes;
 * what it learned is kept, and the next run goes on from there. */
const ROUND_REPLY_CHECK_BUDGET_MS = 8 * 60_000;

/** How a caller of `fetchPrData` has bot comments checked for replies. */
export interface ReplyCheck {
  /** Comments the caller has reported or handled: nothing to ask. */
  known: (id: string) => boolean;
  /** A round, which must not drop a request: an unanswered question
   * fails it. The gate goes on, and asks again at its next fire. */
  strict: boolean;
  /** Where the answers are kept: one never changes, so each comment is
   * asked about once. */
  cachePath: string;
}

function readReplyCache(path: string): Record<string, string | null> {
  // A cache is asked again when missing: a FIFO in its place would block.
  if (!isRegularFile(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string | null>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Marks the bot comments that look as if they opened a thread but answer
 * a comment since deleted: GraphQL drops `replyTo` along with the parent,
 * while REST keeps `in_reply_to_id` on the comment itself. Asked only for
 * an open thread whose first comment is a bot's the caller does not know
 * yet, and only once per comment: the answers are kept. A comment deleted
 * meanwhile is no request. The gate asks about `MAX_GATE_REPLY_CHECKS` at
 * most a fire and stops at the first failure — one not asked about is
 * neither a request nor seen this time (`replyUnknown`); a round asks
 * about every one, and fails when GitHub does not answer.
 */
function markOrphanReplies(
  target: PrTarget,
  pr: PrData,
  check: ReplyCheck,
  gateDeadline: number,
): void {
  const cache = readReplyCache(check.cachePath);
  // Kept as each answer comes, so a run that fails or is killed later
  // keeps what it learned. Read again: another helper may have learned
  // others meanwhile.
  const keep = (id: string, parent: string | null) => {
    // The gate may run before anything prepared `.qwen/tmp`.
    mkdirSync(dirname(check.cachePath), { recursive: true });
    atomicWriteFileSync(
      check.cachePath,
      `${JSON.stringify({ ...readReplyCache(check.cachePath), [id]: parent })}\n`,
      NO_FOLLOW,
    );
  };
  const deadline = check.strict
    ? Date.now() + ROUND_REPLY_CHECK_BUDGET_MS
    : gateDeadline;
  let asked = 0;
  let failed = false;
  for (const thread of pr.reviewThreads.nodes) {
    const first = thread.comments.nodes[0];
    if (
      thread.isResolved ||
      !first ||
      first.replyTo ||
      first.author?.__typename !== 'Bot' ||
      first.databaseId === undefined ||
      first.databaseId !== thread.root.nodes[0]?.databaseId ||
      check.known(first.id)
    ) {
      continue;
    }
    let parent: string | null | undefined =
      first.id in cache ? cache[first.id] : undefined;
    if (parent === undefined) {
      if (check.strict && Date.now() > deadline) {
        throw new Error(
          `asked GitHub about ${asked} bot comments on PR #${target.prNumber} and kept the answers; run snapshot again to go on`,
        );
      }
      if (
        !check.strict &&
        (failed || asked >= MAX_GATE_REPLY_CHECKS || Date.now() > deadline)
      ) {
        first.replyUnknown = true;
        continue;
      }
      asked += 1;
      let answer: string;
      try {
        answer = gh(
          'api',
          `repos/${target.owner}/${target.repo}/pulls/comments/${first.databaseId}`,
          '--jq',
          '.in_reply_to_id',
        ).trim();
      } catch (err) {
        // A missing comment.
        if (ghNotFound(err)) {
          first.replyUnknown = true;
          continue;
        }
        if (check.strict) throw err;
        failed = true;
        first.replyUnknown = true;
        continue;
      }
      parent = answer === '' || answer === 'null' ? null : answer;
      keep(first.id, parent);
    }
    if (parent !== null) first.replyTo = { id: `#${parent}` };
  }
}

export function fetchPrData(
  target: PrTarget,
  replyCheck?: ReplyCheck,
  deadline = Number.POSITIVE_INFINITY,
): {
  pr: PrData;
  viewer: string;
  partial?: 'checks' | 'suites' | 'threads';
} {
  const data = graphql(PR_QUERY, target, []) as {
    data: {
      viewer: { login: string };
      repository: { pullRequest: PrData | null } | null;
    };
  };
  const pr = data.data.repository?.pullRequest;
  if (!pr) {
    throw new Error(
      `PR #${target.prNumber} not found in ${target.owner}/${target.repo}`,
    );
  }
  // A merged or closed PR is a stop, which needs nothing past the first
  // page: on a busy head the paging took most of a gate's time, on every
  // fire after the stop as well.
  if (pr.state !== 'OPEN') return { pr, viewer: data.data.viewer.login };
  const head = pr.commits.nodes[0]?.commit;
  const rollup = head?.statusCheckRollup;
  // Each loop's page count tells a page cap, which every run meets alike,
  // from the time running out.
  let checkPages = 1;
  for (
    ;
    rollup?.contexts.pageInfo.hasNextPage &&
    rollup.contexts.pageInfo.endCursor &&
    checkPages < MAX_CHECK_PAGES &&
    Date.now() < deadline;
    checkPages++
  ) {
    const more = (
      graphql(CHECKS_PAGE_QUERY, target, [
        '-f',
        `after=${rollup.contexts.pageInfo.endCursor}`,
      ]) as {
        data: {
          repository: {
            pullRequest: {
              commits: {
                nodes: Array<{
                  commit: {
                    oid: string;
                    statusCheckRollup: CheckRollup | null;
                  };
                }>;
              };
            } | null;
          } | null;
        };
      }
    ).data.repository?.pullRequest?.commits.nodes[0]?.commit;
    // The head moved between the two calls: what is left stays `truncated`
    // and the next run reads the new head whole.
    if (!more?.statusCheckRollup || more.oid !== head!.oid) break;
    rollup.contexts.nodes.push(...more.statusCheckRollup.contexts.nodes);
    rollup.contexts.pageInfo = more.statusCheckRollup.contexts.pageInfo;
  }
  const suites = head?.checkSuites;
  let suitePages = 1;
  for (
    ;
    suites?.pageInfo?.hasPreviousPage &&
    suites.pageInfo.startCursor &&
    suitePages < MAX_SUITE_PAGES &&
    Date.now() < deadline;
    suitePages++
  ) {
    const more = (
      graphql(SUITES_PAGE_QUERY, target, [
        '-f',
        `before=${suites.pageInfo.startCursor}`,
      ]) as {
        data: {
          repository: {
            pullRequest: {
              commits: {
                nodes: Array<{
                  commit: { oid: string; checkSuites: CheckSuites | null };
                }>;
              };
            } | null;
          } | null;
        };
      }
    ).data.repository?.pullRequest?.commits.nodes[0]?.commit;
    if (!more?.checkSuites || more.oid !== head!.oid) break;
    suites.nodes.unshift(...more.checkSuites.nodes);
    suites.pageInfo = more.checkSuites.pageInfo;
  }
  const threads = pr.reviewThreads;
  let threadPages = 1;
  for (
    ;
    threads.pageInfo.hasNextPage &&
    threads.pageInfo.endCursor &&
    threadPages < MAX_THREAD_PAGES &&
    Date.now() < deadline;
    threadPages++
  ) {
    const more = (
      graphql(THREADS_PAGE_QUERY, target, [
        '-f',
        `after=${threads.pageInfo.endCursor}`,
      ]) as {
        data: {
          repository: {
            pullRequest: { reviewThreads: ReviewThreads } | null;
          } | null;
        };
      }
    ).data.repository?.pullRequest?.reviewThreads;
    if (!more) break;
    threads.nodes.push(...more.nodes);
    threads.pageInfo = more.pageInfo;
  }
  // A merged or closed PR asks nothing more: its `stop` must get through.
  // Pages left because time ran out, not because a page cap was reached:
  // the first read it cut (each is read after the one before).
  const late = Date.now() >= deadline;
  const runsLate =
    rollup?.contexts.pageInfo.hasNextPage && checkPages < MAX_CHECK_PAGES;
  const suitesLate =
    suites?.pageInfo?.hasPreviousPage && suitePages < MAX_SUITE_PAGES;
  const threadsLate =
    threads.pageInfo.hasNextPage && threadPages < MAX_THREAD_PAGES;
  const partial = !late
    ? undefined
    : runsLate
      ? 'checks'
      : suitesLate
        ? 'suites'
        : threadsLate
          ? 'threads'
          : undefined;
  if (replyCheck) {
    markOrphanReplies(
      target,
      pr,
      replyCheck,
      Math.min(deadline, Date.now() + GATE_READ_BUDGET_MS),
    );
  }
  return {
    pr,
    viewer: data.data.viewer.login,
    ...(partial ? { partial } : {}),
  };
}

export interface SnapshotArgs {
  pr: number;
  repo?: string;
  host?: string;
  gate?: boolean;
  /** With `--gate`: the session whose scheduled task runs this gate, as
   * `prepare` reported it. */
  session?: string;
  /** The task, as `schedule` minted it: with `--gate`, the task whose gate
   * this is; without, the task that woke the round. */
  task?: string;
}

/** Creates or touches `path`; a link is not followed. */
function markChecked(path: string): void {
  try {
    const now = new Date();
    if (lstatSync(path, { throwIfNoEntry: false }) === undefined) {
      writeFileSync(path, '', { flag: 'wx' });
    } else if (lstatSync(path).isFile()) {
      utimesSync(path, now, now);
    }
  } catch {
    // A check that ran is not undone by a time that did not move.
  }
}

/**
 * Why a CLI watch's task no longer drives the watch, or null. Its gate names
 * the session and the task it was made for. A take-over moves the watch to
 * another session; a later `schedule` replaces the task, a copy of it in a
 * second process of the same session included; `cleanup` ends the watch.
 * Such a gate must move no cursor: what it reported would reach a session
 * that no longer acts on it. It wakes that session once per fire instead, and
 * the round deletes the task. A gate with no session — a Managed automation,
 * or a probe run by hand — is no watch's task.
 */
function staleTask(
  state: AutofixPrState | null,
  target: { host: string; owner: string; repo: string },
  session: string,
  task: string | undefined,
): Record<string, string> | null {
  if (session === '') return null;
  const named = { gateSession: session, ...(task ? { gateTask: task } : {}) };
  // Gone, stopped by a cleanup that kept its worktree, or — for a task made
  // by `schedule` — no task recorded at all.
  if (
    !state ||
    !sameRepository(state, target) ||
    state.ended ||
    (task && !state.watch)
  ) {
    return { type: 'watch_ended', ...named };
  }
  // A task with no id predates task ids: once one is recorded, it is not
  // the one recorded either.
  const recorded = state.watch?.task;
  if (
    state.sessionId !== session ||
    (recorded !== undefined && recorded !== task)
  ) {
    return { type: 'watched_elsewhere', session: state.sessionId, ...named };
  }
  return null;
}

function runGate(args: SnapshotArgs): void {
  const deadline = Date.now() + GATE_READ_BUDGET_MS;
  // A blank --host is refused here: resolved, it would be '', recorded as
  // the cursor's host, and later fires would ask whatever host `gh` defaults to.
  setGhHost(args.host);
  const paths = autofixPrPaths(resolveWatchRoot(args.pr), args.pr);
  const existing = readGateCursor(paths.gatePath);
  const state = readState(paths.statePath);
  let target: { host: string; owner: string; repo: string };
  if (args.repo) {
    if (!isOwnerRepo(args.repo)) {
      throw new TypeError(`--repo must be <owner>/<repo>, got ${args.repo}`);
    }
    const [owner, repo] = args.repo.split('/');
    // Without --host or GH_HOST, the host this PR is already watched on: a
    // gate on an Enterprise host must not fall back to github.com.
    const recorded = [existing, state].find(
      (known) =>
        known &&
        normalizeSegment(known.owner) === normalizeSegment(owner) &&
        normalizeSegment(known.repo) === normalizeSegment(repo),
    );
    const host = resolveGhHost(args.host) ?? recorded?.host ?? 'github.com';
    target = { host, owner, repo };
  } else {
    const known = existing ?? state;
    if (!known) {
      throw new Error(
        `PR #${args.pr} has no gate cursor and is not prepared here; pass --repo <owner>/<repo> on the first run.`,
      );
    }
    target = { host: known.host, owner: known.owner, repo: known.repo };
  }
  if (existing && !sameRepository(existing, target)) {
    // The cursor is keyed by PR number alone, and one clone can reach
    // several repositories with a PR of that number.
    const watched = `${existing.host}/${existing.owner}/${existing.repo}`;
    const wanted = `${target.host}/${target.owner}/${target.repo}`;
    throw new Error(
      `PR #${args.pr} here is a gate on ${watched}, not ${wanted}; pass --host if the host differs, or remove ${paths.gatePath} to watch the other one.`,
    );
  }
  // A watch prepared for this PR already knows its own pushes and the
  // comments it handled; a state file for another repository's PR of the
  // same number says nothing about this one.
  const watch: GateWatch =
    state && sameRepository(state, target)
      ? {
          knownHeads: [state.lastKnownHeadSha, ...state.pushedShas],
          seenCommentIds: [
            ...state.handledCommentIds,
            ...state.postedCommentIds,
          ],
          handledChecks: state.handledChecks ?? [],
          handledConflictSha: state.handledConflictSha ?? null,
          deferredRuns: state.deferredRuns ?? [],
          rerunChecks: state.rerunChecks ?? [],
          heldChecks: state.heldChecks ?? [],
        }
      : { knownHeads: [], seenCommentIds: [] };

  // After a take-over, the session the watch was taken from fires its task
  // until one of its rounds runs. Its gate must not move the cursor the new
  // owner's gate reads, or what it reported would reach a session that no
  // longer acts on it: it wakes that session, whose round then stops. The
  // task names its session: the environment cannot, as a Managed
  // automation runs its gate as a session of its own.
  const session = args.session ?? '';
  if (args.task !== undefined && session === '') {
    throw new TypeError('--task names a task of a watch; pass its --session');
  }
  const stale = staleTask(state, target, session, args.task);
  if (stale) {
    writeStdoutLine(JSON.stringify({ action: 'stop', events: [stale] }));
    return;
  }
  // A fix agent working in the worktree: nothing reaches a round until its
  // attempt ends, so a fire costs no turn, and the cursor keeps what changed
  // meanwhile for the round after it (Section 6.14).
  const ownFix = state !== null && sameRepository(state, target);
  if (ownFix && fixInFlight(paths)) {
    // The watch is running: `status` must not read it as left behind.
    if (session !== '') markChecked(paths.checkedPath);
    return;
  }

  setGhHost(target.host);
  ensureAuthenticated();
  const reportedBefore = new Set([
    ...(existing?.reportedCommentIds ?? []),
    ...watch.seenCommentIds,
  ]);
  // The gate goes on without an answer: the comment is asked about again
  // at the next fire.
  const { pr, viewer, partial } = fetchPrData(
    { ...target, prNumber: args.pr },
    {
      known: (id) => reportedBefore.has(id),
      strict: false,
      cachePath: paths.repliesPath,
    },
    deadline,
  );
  // When this run finished reading the PR: a round's snapshot that began
  // to read later saw everything it may report.
  const readAt = Date.now();
  const cursor: AutofixPrGateCursor = {
    ...(existing ?? {
      version: 1,
      ...target,
      prNumber: args.pr,
      headSha: null,
      reportedCommentIds: [],
      reportedChecks: [],
      conflictSha: null,
      stopped: null,
      reportedTruncated: [],
    }),
    viewer,
    prAuthor: pr.author?.login ?? existing?.prAuthor ?? '',
  };
  const result = buildGateSnapshot(pr, cursor, {
    ...watch,
    ...(partial ? { partial } : {}),
  });
  // A take-over while GitHub was asked: what this gate saw is the new
  // owner's to report.
  const restale = staleTask(
    readState(paths.statePath),
    target,
    session,
    args.task,
  );
  if (restale) {
    writeStdoutLine(JSON.stringify({ action: 'stop', events: [restale] }));
    return;
  }
  // An attempt opened while GitHub was asked. Read once: a marker written
  // between two reads would be reported as one its session left behind.
  const marker = ownFix ? readFixMarker(paths) : null;
  if (freshAttempt(marker)) {
    if (session !== '') markChecked(paths.checkedPath);
    return;
  }
  // Only the watch's own gate spends the one report of an abandoned
  // attempt: a probe run by hand, or a Managed automation's, wakes no round.
  const reported = withAbandonedFix(result, session !== '' ? marker : null, {
    headSha: pr.headRefOid,
    isDraft: pr.isDraft,
    url: pr.url,
  });
  const { snapshot } = reported;
  // A run that reports wakes a round: when it finished reading the PR says
  // whether a round's snapshot saw what it reported (`fix-start`). A quiet
  // run, which may still move the cursor, wakes none.
  const next = snapshot
    ? { ...reported.cursor, reportedAt: new Date(readAt).toISOString() }
    : reported.cursor;
  // The cursor lands before the output: a probe that prints and then dies
  // would otherwise report the same transitions on the next fire.
  if (JSON.stringify(next) !== JSON.stringify(existing)) {
    mkdirSync(dirname(paths.gatePath), { recursive: true });
    writeGateCursor(paths.gatePath, next);
  }
  // `status` reads when the watch's own task last checked the PR from this
  // file, which `cleanup` removes with the watch; a gate with no session is
  // no watch's, and shares only the cursor.
  if (session !== '') markChecked(paths.checkedPath);
  if (snapshot) writeStdoutLine(JSON.stringify(snapshot));
}

/**
 * The gate's output with a marker its session left behind reported, once:
 * the events that woke the abandoned attempt's round were reported then,
 * and only a round that runs now handles them again. (A fresh marker never
 * gets here.)
 */
export function withAbandonedFix(
  result: { snapshot: Snapshot | null; cursor: AutofixPrGateCursor },
  marker: ReturnType<typeof readFixMarker>,
  base: Pick<Snapshot, 'headSha' | 'isDraft' | 'url'> | null = null,
): { snapshot: Snapshot | null; cursor: AutofixPrGateCursor } {
  if (!marker) return result;
  const key = marker.attempt?.attempt ?? `unreadable@${marker.mtimeMs}`;
  if (result.cursor.reportedAbandonedFix === key) return result;
  const cursor = { ...result.cursor, reportedAbandonedFix: key };
  const event: SnapshotEvent = {
    type: 'abandoned_fix',
    startedAt: marker.attempt?.startedAt ?? null,
  };
  const { snapshot } = result;
  if (snapshot) {
    return {
      snapshot: {
        ...snapshot,
        action: snapshot.action === 'wait' ? 'fix' : snapshot.action,
        events: [...snapshot.events, event],
      },
      cursor,
    };
  }
  return {
    snapshot: {
      headSha: base?.headSha ?? cursor.headSha ?? '',
      isDraft: base?.isDraft ?? false,
      url: base?.url ?? '',
      action: 'fix',
      events: [event],
      truncated: [],
    },
    cursor,
  };
}

export function runSnapshot(args: SnapshotArgs): void {
  if (args.gate) {
    runGate(args);
    return;
  }
  const paths = autofixPrPaths(resolveWatchRoot(args.pr), args.pr);
  const state = requireState(paths.statePath, args.pr);
  assertWatching(state, args.task);
  // The snapshot file is the one the agent working now reads.
  assertNoFixInFlight(paths, args.pr);
  setGhHost(state.host);
  ensureAuthenticated();
  // When this snapshot began to read the PR: the gate's runs that read it
  // later may have reported what it does not hold (`fix-start`).
  const readAt = new Date().toISOString();
  const { pr } = fetchPrData(state, roundReplyCheck(state));
  // Asked only when the API disagrees with the watch: whether the branch
  // moved, or the API has yet to see the head `sync` or `push` recorded.
  let branchHead: string | null | undefined;
  if (pr.state === 'OPEN' && pr.headRefOid !== state.lastKnownHeadSha) {
    branchHead = remoteRef(state.pushTarget, `refs/heads/${state.headRefName}`);
  }
  // What this read says of each check counts toward its fix budget before
  // the round sees it — a read of the head the watch knows only: any other
  // is the API lagging behind the branch, or a push the round syncs to and
  // reads again.
  const known = (watch: AutofixPrState) =>
    pr.headRefOid === watch.lastKnownHeadSha;
  const unchanged = (watch: AutofixPrState, next: FailingCheck[]) =>
    JSON.stringify(next) === JSON.stringify(watch.failingChecks ?? []);
  // Asked only for a recorded check failing on a later push, at most
  // MAX_CHECK_LOOKUPS commits a read, each once.
  const looked = new Map<string, CheckResults | null>();
  const resultsOn = (sha: string) => {
    if (!looked.has(sha)) {
      looked.set(
        sha,
        looked.size < MAX_CHECK_LOOKUPS ? commitCheckResults(state, sha) : null,
      );
    }
    return looked.get(sha) ?? null;
  };
  // Most reads change no record (a merged PR, a head read before, a green
  // one): those leave the lock to the other helpers, as before.
  const current =
    !known(state) || unchanged(state, trackFailingChecks(pr, state, resultsOn))
      ? state
      : withWatchLock(paths, args.pr, () => {
          const fresh = requireState(paths.statePath, args.pr);
          if (!known(fresh)) return fresh;
          const failingChecks = trackFailingChecks(pr, fresh, resultsOn);
          if (unchanged(fresh, failingChecks)) return fresh;
          const next = { ...fresh, failingChecks };
          writeState(paths.statePath, next);
          return next;
        });
  // The comments' bodies run past what a line of tool output shows on a PR
  // with any history: the snapshot goes to a file the round reads, and the
  // line says what to do and where it is.
  const built = buildSnapshot(pr, current, branchHead);
  // A failed check on a branch behind its base may be the base's fault:
  // one lazy compare tells the brief to merge the base first. A workflow
  // that never started has no log to blame on the base, a check left for a
  // person is not fixed this round, and a lagging snapshot carries no
  // checks at all.
  const staleBase =
    built.action === 'fix' &&
    built.events.some(
      (event) =>
        event.type === 'ci_failed' && !event.startupFailure && !event.exhausted,
    ) &&
    baseIsBehind(current, pr.headRefOid);
  const snapshot: Snapshot = staleBase ? { ...built, baseBehind: true } : built;
  // A body is written as its lines, and a long line folded: `read_file`
  // pages a file by lines and cuts what one read returns at 25,000
  // characters, and GitHub takes bodies of 65,536.
  // With the task whose round took it: only that round's fix may run in
  // the background (`fix-start`).
  atomicWriteFileSync(
    paths.snapshotPath,
    `${JSON.stringify(
      {
        ...snapshot,
        readAt,
        ...(args.task === undefined ? {} : { task: args.task }),
      },
      (key, value: unknown) =>
        key === 'body' && typeof value === 'string' ? bodyLines(value) : value,
      2,
    )}\n`,
    NO_FOLLOW,
  );
  const { events, ...rest } = snapshot;
  writeStdoutLine(
    JSON.stringify({
      ...rest,
      events: events.length,
      eventTypes: [...new Set(events.map((event) => event.type))],
      snapshot: paths.snapshotPath,
    }),
  );
}

/** The longest line a body keeps in the snapshot file; longer ones fold. */
const BODY_LINE_MAX = 2_000;

/**
 * A body as the snapshot file holds it: its lines, and a line too long for
 * one entry as the array of its pieces — joined without a break, and never
 * cut inside a character.
 */
export function bodyLines(body: string): Array<string | string[]> {
  return body.split('\n').map((line) => {
    if (line.length <= BODY_LINE_MAX) return line;
    const characters = [...line];
    const pieces: string[] = [];
    for (let at = 0; at < characters.length; at += BODY_LINE_MAX) {
      pieces.push(characters.slice(at, at + BODY_LINE_MAX).join(''));
    }
    return pieces;
  });
}

/** How a round has bot comments checked: strictly, past what it handled. */
export function roundReplyCheck(
  state: AutofixPrState,
  strict = true,
): ReplyCheck {
  const seen = new Set([...state.handledCommentIds, ...state.postedCommentIds]);
  return {
    known: (id) => seen.has(id),
    strict,
    cachePath: autofixPrPaths(resolveWatchRoot(state.prNumber), state.prNumber)
      .repliesPath,
  };
}

export const snapshotCommand: CommandModule = {
  command: 'snapshot <pr>',
  describe:
    'Read a PR and print what changed since the last check, plus the next action (stop, resync, fix or wait); with --gate, print only new transitions and nothing when quiet',
  builder: (yargs) =>
    yargs
      .positional('pr', {
        type: 'number',
        demandOption: true,
        describe: 'PR number',
      })
      .option('repo', {
        type: 'string',
        describe:
          '<owner>/<repo> of the PR. With --gate it is needed on the first run unless the PR was prepared here.',
      })
      .option('host', {
        type: 'string',
        describe:
          'GitHub host (default: GH_HOST, else with --gate the host the PR is already watched on, else github.com)',
      })
      .option('gate', {
        type: 'boolean',
        default: false,
        describe:
          'Probe mode for a scheduled task gate: no worktree, a cursor in .qwen/tmp, only transitions since the last run on stdout and nothing when there are none',
      })
      .option('session', {
        type: 'string',
        describe:
          "With --gate: the session whose scheduled task runs the gate (prepare's sessionId); a watch another session took over answers stop",
      })
      .option('task', {
        type: 'string',
        describe:
          "The scheduled task's id (schedule's task): with --gate, a watch another task drives answers stop; without, a round woken by another task is refused",
      }),
  handler: (argv) => {
    runSnapshot({
      pr: Number(argv['pr']),
      repo: argv['repo'] as string | undefined,
      host: argv['host'] as string | undefined,
      gate: Boolean(argv['gate']),
      session: argv['session'] as string | undefined,
      task: argv['task'] as string | undefined,
    });
  },
};
