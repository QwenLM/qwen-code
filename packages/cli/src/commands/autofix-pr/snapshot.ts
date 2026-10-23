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
//   moves the cursor: only a later push or reply does.
// - `--gate` is the probe behind a scheduled task's gate
//   (docs/design/2026-10-21-scheduled-task-gate.md): it needs no worktree,
//   keeps its own cursor of what it already reported, prints only the
//   transitions since the last run and prints nothing when there are none,
//   so the session is woken only for them.

import type { CommandModule } from 'yargs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  ensureAuthenticated,
  gh,
  isOwnerRepo,
  resolveGhHost,
  setGhHost,
} from '../review/lib/gh.js';
import { normalizeSegment } from '../review/lib/remote-match.js';
import {
  REPLY_MARKER,
  assertOwnedBySession,
  autofixPrPaths,
  readGateCursor,
  readState,
  repoRoot,
  requireState,
  sameRepository,
  writeGateCursor,
  type AutofixPrGateCursor,
  type AutofixPrState,
} from './state.js';

const CHECK_CONTEXT_FIELDS = `nodes {
  __typename
  ... on CheckRun {
    name status conclusion detailsUrl databaseId
    checkSuite { app { databaseId } workflowRun { event workflow { databaseId } } }
  }
  ... on StatusContext { context state targetUrl createdAt }
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
    nodes { id databaseId author { __typename login } authorAssociation body url }
  }
}`;

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      isDraft
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

interface CommentNode {
  id: string;
  databaseId?: number;
  author: Author | null;
  authorAssociation: string;
  body: string;
  url: string;
  state?: string;
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
  url: string;
  headRefOid: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  author?: { login: string } | null;
  commits: {
    nodes: Array<{
      commit: { oid: string; statusCheckRollup: CheckRollup | null };
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
  url: string;
  events: SnapshotEvent[];
  /** Connections cut at the page size; events past the cut are missing. */
  truncated: string[];
}

const TRUSTED_ASSOCIATIONS: Record<string, Trust> = {
  OWNER: 'owner',
  MEMBER: 'member',
  COLLABORATOR: 'collaborator',
};

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE']);
const FAILED_STATUSES = new Set(['FAILURE', 'ERROR']);
const PENDING_STATUSES = new Set(['PENDING', 'EXPECTED']);
/** Reported comment ids the query no longer returns are bounded to this
 * many; ids still on the page are always kept (see `buildGateSnapshot`). */
const MAX_OFF_PAGE_COMMENT_IDS = 2000;

/**
 * Bots count only for reviews and review threads: their PR conversation
 * comments are reports (coverage, CI summaries), not requests, so they are
 * dropped rather than listed as untrusted.
 */
function classify(
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
    let key: string;
    if (ctx.__typename === 'CheckRun') {
      const suite = ctx.checkSuite;
      const run = suite?.workflowRun;
      key = [
        'run',
        suite?.app?.databaseId ?? '',
        run?.workflow?.databaseId ?? '',
        run?.event ?? '',
        ctx.name,
      ].join('\0');
    } else {
      key = `status\0${ctx.context}`;
    }
    const seen = latest.get(key);
    if (!seen || attemptOrder(ctx) > attemptOrder(seen)) latest.set(key, ctx);
  }
  return [...latest.values()];
}

function attemptOrder(ctx: CheckContext): number {
  return ctx.__typename === 'CheckRun'
    ? ctx.databaseId
    : Date.parse(ctx.createdAt);
}

/** The failed checks of the head, each with the identity of its attempt. */
function checkEvents(pr: PrData): {
  failed: Array<{ event: CiFailed; attempt: string }>;
  pending: string[];
  truncated: boolean;
} {
  const commit = pr.commits.nodes[0]?.commit;
  // A rollup for any other commit describes a head that is already gone.
  if (!commit || commit.oid !== pr.headRefOid || !commit.statusCheckRollup) {
    return { failed: [], pending: [], truncated: false };
  }
  const { contexts } = commit.statusCheckRollup;
  const failed: Array<{ event: CiFailed; attempt: string }> = [];
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
      });
    }
  }
  return { failed, pending, truncated: contexts.pageInfo.hasNextPage };
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
): { events: SnapshotEvent[]; ids: string[]; truncated: string[] } {
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
    for (const node of thread.comments.nodes.filter(isNew)) {
      const trust = classify(node, 'thread', prAuthor);
      if (trust === 'ignore') continue;
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
  // with a body of its own says something the threads do not.
  for (const node of pr.reviews.nodes) {
    if (node.state === 'PENDING' || !node.body.trim() || !isNew(node)) continue;
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
  return { events, ids, truncated };
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
function isOwnReply(node: CommentNode, viewer: string): boolean {
  return (
    node.author?.login === viewer && node.body.trimEnd().endsWith(REPLY_MARKER)
  );
}

export function buildSnapshot(pr: PrData, state: AutofixPrState): Snapshot {
  const seen = new Set([...state.handledCommentIds, ...state.postedCommentIds]);
  const isNew = (node: CommentNode) =>
    !seen.has(node.id) && !isOwnReply(node, state.viewer);

  const events: SnapshotEvent[] = [];
  const truncated: string[] = [];
  const base = {
    headSha: pr.headRefOid,
    isDraft: pr.isDraft,
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
    pr.headRefOid !== state.lastKnownHeadSha &&
    !state.pushedShas.includes(pr.headRefOid);
  if (movedExternally) {
    events.push({ type: 'head_moved_externally', sha: pr.headRefOid });
  }
  if (pr.mergeable === 'CONFLICTING') events.push({ type: 'conflict' });

  const checks = checkEvents(pr);
  events.push(...checks.failed.map((failure) => failure.event));
  if (checks.pending.length > 0) {
    events.push({ type: 'ci_pending', checks: checks.pending });
  }
  if (checks.truncated) truncated.push('checks');

  const comments = commentEvents(pr, state.prAuthor, isNew);
  events.push(...comments.events);
  truncated.push(...comments.truncated);

  const action = movedExternally
    ? 'resync'
    : events.some(isActionable)
      ? 'fix'
      : 'wait';
  return { ...base, action, events, truncated };
}

/**
 * What a prepared watch of the same PR already knows, so the gate does not
 * report it again: the heads it recorded or pushed, and the comments it
 * handled or posted.
 */
export interface GateWatch {
  knownHeads: string[];
  seenCommentIds: string[];
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
    if (next.conflictSha !== pr.headRefOid) {
      events.push({ type: 'conflict' });
      next.conflictSha = pr.headRefOid;
    }
  } else if (pr.mergeable === 'MERGEABLE') {
    next.conflictSha = null;
  }

  // A failure is reported once per (check, head, attempt): every run has an
  // id of its own (a commit status, its creation time), so a re-run that
  // fails again between two polls is still new. The cursor keeps only the
  // failures still present, so a check that goes green and fails later is
  // new as well.
  const checks = checkEvents(pr);
  const reportedChecks = new Set(next.reportedChecks);
  next.reportedChecks = [];
  for (const { event, attempt } of checks.failed) {
    const key = `${event.check}@${pr.headRefOid}@${attempt}`;
    next.reportedChecks.push(key);
    if (!reportedChecks.has(key)) events.push(event);
  }
  if (checks.truncated) truncated.push('checks');

  const reportedComments = new Set([
    ...next.reportedCommentIds,
    ...watch.seenCommentIds,
  ]);
  const isNew = (node: CommentNode) =>
    !reportedComments.has(node.id) && node.author?.login !== cursor.viewer;
  const comments = commentEvents(pr, cursor.prAuthor, isNew);
  events.push(...comments.events);
  truncated.push(...comments.truncated);
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
  next.reportedCommentIds = [
    ...gone.slice(-MAX_OFF_PAGE_COMMENT_IDS),
    ...kept,
    ...adopted,
    ...comments.ids,
  ];

  // A cut connection may hide a transition no later poll will see, so the
  // cut is a transition itself: reported when it appears, quiet while it
  // lasts.
  const reportedTruncated = new Set(cursor.reportedTruncated ?? []);
  const newlyCut = truncated.some((name) => !reportedTruncated.has(name));
  next.reportedTruncated = truncated;

  if (events.length === 0 && !newlyCut) {
    return { snapshot: null, cursor: next };
  }
  const action = moved ? 'resync' : events.some(isActionable) ? 'fix' : 'wait';
  return { snapshot: { ...base, action, events, truncated }, cursor: next };
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

export function fetchPrData(target: PrTarget): { pr: PrData; viewer: string } {
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
  return { pr, viewer: data.data.viewer.login };
}

export interface SnapshotArgs {
  pr: number;
  repo?: string;
  host?: string;
  gate?: boolean;
}

function runGate(args: SnapshotArgs): void {
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
        }
      : { knownHeads: [], seenCommentIds: [] };

  setGhHost(target.host);
  ensureAuthenticated();
  const { pr, viewer } = fetchPrData({ ...target, prNumber: args.pr });
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
  writeStdoutLine(JSON.stringify(buildSnapshot(fetchPrData(state).pr, state)));
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
