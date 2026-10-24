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
//   moves the cursor: only a later push, reply, re-run or sync does.
// - `--gate` is the probe behind a scheduled task's gate
//   (docs/design/2026-10-21-scheduled-task-gate.md): it needs no worktree,
//   keeps its own cursor of what it already reported, prints only the
//   transitions since the last run and prints nothing when there are none,
//   so the session is woken only for them.

import type { CommandModule } from 'yargs';
import { mkdirSync } from 'node:fs';
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
  REPLY_MARKER,
  assertOwnedBySession,
  autofixPrPaths,
  checkAttemptKey,
  currentSessionId,
  readGateCursor,
  readState,
  repoRoot,
  requireState,
  sameRepository,
  writeGateCursor,
  type AutofixPrGateCursor,
  type AutofixPrState,
} from './state.js';
import { remoteRef } from './worktree.js';

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
    };

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
}

const TRUSTED_ASSOCIATIONS: Record<string, Trust> = {
  OWNER: 'owner',
  MEMBER: 'member',
  COLLABORATOR: 'collaborator',
};

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE']);
const FAILED_STATUSES = new Set(['FAILURE', 'ERROR']);
const PENDING_STATUSES = new Set(['PENDING', 'EXPECTED']);
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

function runIdFrom(url: string | null): number | null {
  const match = url?.match(/\/actions\/runs\/(\d+)/);
  return match ? Number(match[1]) : null;
}

type CiFailed = Extract<SnapshotEvent, { type: 'ci_failed' }>;

/**
 * The rollup lists every run on the head: earlier attempts of a re-run job,
 * and each trigger of a workflow that runs on several events. Only the
 * latest run of a check says whether it is failing now; a failure that a
 * re-run turned green is history.
 *
 * A check run is one check per app, workflow, trigger and name. The app
 * keeps apart two providers that publish the same name, since a branch rule
 * can require the check from one of them; workflows are told apart by id,
 * since two workflow files may share a display name.
 */
function latestContexts(nodes: CheckContext[]): CheckContext[] {
  const latest = new Map<string, CheckContext>();
  for (const ctx of nodes) {
    const key = checkIdentity(ctx);
    const seen = latest.get(key);
    if (!seen || attemptOrder(ctx) > attemptOrder(seen)) latest.set(key, ctx);
  }
  return [...latest.values()];
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
  /** Its run has ended: GitHub re-runs a run only then. Commit statuses
   * and other apps' checks have no run and count as ended. */
  runDone: boolean;
}

/** The failed checks of the head, each with the identity of its attempt. */
export function checkEvents(pr: PrData): {
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
  for (const ctx of latestContexts(contexts.nodes)) {
    if (ctx.__typename === 'CheckRun') {
      if (ctx.status !== 'COMPLETED') pending.push(ctx.name);
      else if (ctx.conclusion && FAILED_CONCLUSIONS.has(ctx.conclusion)) {
        failed.push({
          event: {
            type: 'ci_failed',
            check: ctx.name,
            url: ctx.detailsUrl,
            runId: runIdFrom(ctx.detailsUrl),
          },
          attempt: `#${ctx.databaseId}`,
          identity: checkIdentity(ctx),
          actions: Boolean(ctx.checkSuite?.workflowRun),
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
          runId: runIdFrom(ctx.targetUrl),
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
    : checkEvents(pr);
  // A failure handled without a push (declined, left for a human, re-run)
  // stays on the head, so it is skipped by its attempt; a re-run that fails
  // again is a new attempt. `key` is what `reply` and `rerun` record.
  const handledChecks = new Set(state.handledChecks ?? []);
  // A run the round could not re-run yet is offered again once it ended.
  const deferredRuns = new Set(state.deferredRuns ?? []);
  for (const { event, attempt, runDone } of checks.failed) {
    if (!runDone && event.runId !== null && deferredRuns.has(event.runId)) {
      continue;
    }
    const key = checkAttemptKey(event.check, pr.headRefOid, attempt);
    if (!handledChecks.has(key)) events.push({ ...event, key });
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
 * What a prepared watch of the same PR already knows, so the gate does not
 * report it again: the heads it recorded or pushed, and the comments it
 * handled or posted.
 */
export interface GateWatch {
  knownHeads: string[];
  seenCommentIds: string[];
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
  const checks = checkEvents(pr);
  const reportedChecks = new Set([
    ...next.reportedChecks,
    ...(watch.handledChecks ?? []),
  ]);
  const deferred = new Set(watch.deferredRuns ?? []);
  next.reportedChecks = [];
  const checkKeys = new Map<SnapshotEvent, string[]>();
  const candidates: SnapshotEvent[] = [];
  for (const { event, attempt, runDone } of checks.failed) {
    const key = checkAttemptKey(event.check, pr.headRefOid, attempt);
    const keys = [key];
    if (runDone && event.runId !== null && deferred.has(event.runId)) {
      keys.push(`${key}@ended`);
    }
    const unreported = keys.filter((k) => !reportedChecks.has(k));
    next.reportedChecks.push(...keys.filter((k) => reportedChecks.has(k)));
    if (unreported.length > 0) {
      checkKeys.set(event, unreported);
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
  const reportedTruncated = new Set(cursor.reportedTruncated ?? []);
  const newlyCut = truncated.some(
    (name) => FRONT_READ.has(name) && !reportedTruncated.has(name),
  );
  next.reportedTruncated = truncated;

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

/** Review comments listed over REST for `in_reply_to_id`: pages of 100. */
const MAX_REVIEW_COMMENT_PAGES = 10;

/**
 * Marks the bot comments that look as if they opened a thread but answer
 * a comment since deleted: GraphQL drops `replyTo` along with the parent,
 * while REST keeps `in_reply_to_id`. Asked only when an open thread starts
 * with a bot comment `known` (what the caller has reported or handled)
 * does not hold yet, with one listing of the PR's review comments. When
 * GitHub does not answer, those comments are neither requests nor seen
 * this time, and are asked about again.
 */
function markOrphanReplies(
  target: PrTarget,
  pr: PrData,
  known: (id: string) => boolean,
): void {
  const candidates: CommentNode[] = [];
  for (const thread of pr.reviewThreads.nodes) {
    const first = thread.comments.nodes[0];
    if (
      thread.isResolved ||
      !first ||
      first.replyTo ||
      first.author?.__typename !== 'Bot' ||
      first.databaseId === undefined ||
      first.databaseId !== thread.root.nodes[0]?.databaseId ||
      known(first.id)
    ) {
      continue;
    }
    candidates.push(first);
  }
  if (candidates.length === 0) return;
  const parents = new Map<number, string>();
  try {
    for (let page = 1; page <= MAX_REVIEW_COMMENT_PAGES; page++) {
      const listed = JSON.parse(
        gh(
          'api',
          `repos/${target.owner}/${target.repo}/pulls/${target.prNumber}/comments?per_page=100&page=${page}`,
          '--jq',
          '[.[] | [.id, .in_reply_to_id]]',
        ),
      ) as Array<[number, number | null]>;
      for (const [id, parent] of listed) {
        if (parent !== null) parents.set(id, String(parent));
      }
      if (listed.length < 100) break;
    }
  } catch {
    for (const node of candidates) node.replyUnknown = true;
    return;
  }
  for (const node of candidates) {
    const parent = parents.get(node.databaseId!);
    if (parent !== undefined) node.replyTo = { id: `#${parent}` };
  }
}

export function fetchPrData(
  target: PrTarget,
  known?: (id: string) => boolean,
): { pr: PrData; viewer: string } {
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
  const head = pr.commits.nodes[0]?.commit;
  const rollup = head?.statusCheckRollup;
  for (
    let page = 1;
    rollup?.contexts.pageInfo.hasNextPage &&
    rollup.contexts.pageInfo.endCursor &&
    page < MAX_CHECK_PAGES;
    page++
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
  for (
    let page = 1;
    suites?.pageInfo?.hasPreviousPage &&
    suites.pageInfo.startCursor &&
    page < MAX_SUITE_PAGES;
    page++
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
  for (
    let page = 1;
    threads.pageInfo.hasNextPage &&
    threads.pageInfo.endCursor &&
    page < MAX_THREAD_PAGES;
    page++
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
  if (known && pr.state === 'OPEN') markOrphanReplies(target, pr, known);
  return { pr, viewer: data.data.viewer.login };
}

export interface SnapshotArgs {
  pr: number;
  repo?: string;
  host?: string;
  gate?: boolean;
}

function runGate(args: SnapshotArgs): void {
  // A blank --host is refused here: resolved, it would be '', recorded as
  // the cursor's host, and later fires would ask whatever host `gh` defaults to.
  setGhHost(args.host);
  const paths = autofixPrPaths(repoRoot(), args.pr);
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
        }
      : { knownHeads: [], seenCommentIds: [] };

  // After a take-over, the session the watch was taken from fires its task
  // until one of its rounds runs. Its gate must not move the cursor the new
  // owner's gate reads, or what it reported would reach a session that no
  // longer acts on it: it wakes that session, whose round then stops.
  const session = currentSessionId();
  if (
    state &&
    sameRepository(state, target) &&
    session !== '' &&
    state.sessionId !== session
  ) {
    writeStdoutLine(
      JSON.stringify({
        action: 'stop',
        events: [{ type: 'watched_elsewhere', session: state.sessionId }],
      }),
    );
    return;
  }

  setGhHost(target.host);
  ensureAuthenticated();
  const reportedBefore = new Set([
    ...(existing?.reportedCommentIds ?? []),
    ...watch.seenCommentIds,
  ]);
  const { pr, viewer } = fetchPrData({ ...target, prNumber: args.pr }, (id) =>
    reportedBefore.has(id),
  );
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
  const result = buildGateSnapshot(pr, cursor, watch);
  // A take-over while GitHub was asked: what this gate saw is the new
  // owner's to report.
  const owner = readState(paths.statePath);
  if (
    owner &&
    sameRepository(owner, target) &&
    session !== '' &&
    owner.sessionId !== session
  ) {
    writeStdoutLine(
      JSON.stringify({
        action: 'stop',
        events: [{ type: 'watched_elsewhere', session: owner.sessionId }],
      }),
    );
    return;
  }
  // The cursor lands before the output: a probe that prints and then dies
  // would otherwise report the same transitions on the next fire.
  if (JSON.stringify(result.cursor) !== JSON.stringify(existing)) {
    mkdirSync(dirname(paths.gatePath), { recursive: true });
    writeGateCursor(paths.gatePath, result.cursor);
  }
  if (result.snapshot) writeStdoutLine(JSON.stringify(result.snapshot));
}

export function runSnapshot(args: SnapshotArgs): void {
  if (args.gate) {
    runGate(args);
    return;
  }
  const state = requireState(
    autofixPrPaths(repoRoot(), args.pr).statePath,
    args.pr,
  );
  assertOwnedBySession(state);
  setGhHost(state.host);
  ensureAuthenticated();
  const { pr } = fetchPrData(state, handledBy(state));
  // Asked only when the API disagrees with the watch: whether the branch
  // moved, or the API has yet to see the head `sync` or `push` recorded.
  let branchHead: string | null | undefined;
  if (pr.state === 'OPEN' && pr.headRefOid !== state.lastKnownHeadSha) {
    branchHead = remoteRef(state.pushTarget, `refs/heads/${state.headRefName}`);
  }
  // The comments' bodies run past what a line of tool output shows on a PR
  // with any history: the snapshot goes to a file the round reads, and the
  // line says what to do and where it is.
  const snapshot = buildSnapshot(pr, state, branchHead);
  const paths = autofixPrPaths(repoRoot(), args.pr);
  // A body is written as its lines, and a long line folded: `read_file`
  // pages a file by lines and cuts what one read returns at 25,000
  // characters, and GitHub takes bodies of 65,536.
  atomicWriteFileSync(
    paths.snapshotPath,
    `${JSON.stringify(
      snapshot,
      (key, value: unknown) =>
        key === 'body' && typeof value === 'string' ? bodyLines(value) : value,
      2,
    )}\n`,
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

/** What a watch has handled or posted: no comment to ask GitHub about. */
export function handledBy(state: AutofixPrState): (id: string) => boolean {
  const seen = new Set([...state.handledCommentIds, ...state.postedCommentIds]);
  return (id) => seen.has(id);
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
      }),
  handler: (argv) => {
    runSnapshot({
      pr: Number(argv['pr']),
      repo: argv['repo'] as string | undefined,
      host: argv['host'] as string | undefined,
      gate: Boolean(argv['gate']),
    });
  },
};
