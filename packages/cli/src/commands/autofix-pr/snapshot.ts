/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen autofix-pr snapshot`: read a watched PR once and report what changed
// since the state file's cursor, plus the one action the /autofix-pr skill
// takes next. Read-only: the cursor only moves when a later step pushes or
// replies.

import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { ensureAuthenticated, gh, setGhHost } from '../review/lib/gh.js';
import {
  REPLY_MARKER,
  assertOwnedBySession,
  autofixPrPaths,
  repoRoot,
  requireState,
  type AutofixPrState,
} from './state.js';

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      isDraft
      url
      headRefOid
      mergeable
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: 100) {
                pageInfo { hasNextPage }
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion detailsUrl }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 100) {
            nodes { id databaseId author { __typename login } authorAssociation body url }
          }
        }
      }
      reviews(last: 100) {
        nodes { id author { __typename login } authorAssociation state body url }
      }
      comments(last: 100) {
        nodes { id author { __typename login } authorAssociation body url }
      }
    }
  }
}`;

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
    }
  | {
      __typename: 'StatusContext';
      context: string;
      state: string;
      targetUrl: string | null;
    };

export interface PrData {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  url: string;
  headRefOid: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  commits: {
    nodes: Array<{
      commit: {
        oid: string;
        statusCheckRollup: {
          contexts: {
            pageInfo: { hasNextPage: boolean };
            nodes: CheckContext[];
          };
        } | null;
      };
    }>;
  };
  reviewThreads: {
    pageInfo: { hasNextPage: boolean };
    nodes: Array<{
      id: string;
      isResolved: boolean;
      isOutdated: boolean;
      path: string;
      line: number | null;
      comments: { nodes: CommentNode[] };
    }>;
  };
  reviews: { nodes: CommentNode[] };
  comments: { nodes: CommentNode[] };
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

function checkEvents(pr: PrData): {
  events: SnapshotEvent[];
  truncated: boolean;
} {
  const commit = pr.commits.nodes[0]?.commit;
  // A rollup for any other commit describes a head that is already gone.
  if (!commit || commit.oid !== pr.headRefOid || !commit.statusCheckRollup) {
    return { events: [], truncated: false };
  }
  const { contexts } = commit.statusCheckRollup;
  const events: SnapshotEvent[] = [];
  const pending: string[] = [];
  for (const ctx of contexts.nodes) {
    if (ctx.__typename === 'CheckRun') {
      if (ctx.status !== 'COMPLETED') pending.push(ctx.name);
      else if (ctx.conclusion && FAILED_CONCLUSIONS.has(ctx.conclusion)) {
        events.push({
          type: 'ci_failed',
          check: ctx.name,
          url: ctx.detailsUrl,
          runId: runIdFrom(ctx.detailsUrl),
        });
      }
    } else if (PENDING_STATUSES.has(ctx.state)) {
      pending.push(ctx.context);
    } else if (FAILED_STATUSES.has(ctx.state)) {
      events.push({
        type: 'ci_failed',
        check: ctx.context,
        url: ctx.targetUrl,
        runId: runIdFrom(ctx.targetUrl),
      });
    }
  }
  if (pending.length > 0) events.push({ type: 'ci_pending', checks: pending });
  return { events, truncated: contexts.pageInfo.hasNextPage };
}

export function buildSnapshot(pr: PrData, state: AutofixPrState): Snapshot {
  const seen = new Set([...state.handledCommentIds, ...state.postedCommentIds]);
  const isNew = (node: CommentNode) =>
    !seen.has(node.id) && !node.body.includes(REPLY_MARKER);
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
  events.push(...checks.events);
  if (checks.truncated) truncated.push('checks');

  for (const thread of pr.reviewThreads.nodes) {
    if (thread.isResolved) continue;
    const comments: CommentRef[] = [];
    for (const node of thread.comments.nodes.filter(isNew)) {
      const trust = classify(node, 'thread', state.prAuthor);
      if (trust === 'untrusted') events.push(untrusted(node));
      else if (trust !== 'ignore') comments.push(ref(node, trust));
    }
    if (comments.length === 0) continue;
    events.push({
      type: 'review_thread',
      threadId: thread.id,
      replyTo: thread.comments.nodes[0]?.databaseId ?? null,
      path: thread.path,
      line: thread.line,
      outdated: thread.isOutdated,
      comments,
    });
  }
  if (pr.reviewThreads.pageInfo.hasNextPage) truncated.push('reviewThreads');

  // A review's inline comments arrive through its threads; only a review
  // with a body of its own says something the threads do not.
  for (const node of pr.reviews.nodes) {
    if (node.state === 'PENDING' || !node.body.trim() || !isNew(node)) continue;
    const trust = classify(node, 'review', state.prAuthor);
    if (trust === 'untrusted') events.push(untrusted(node));
    else if (trust !== 'ignore') {
      events.push({ type: 'review', state: node.state!, ...ref(node, trust) });
    }
  }

  for (const node of pr.comments.nodes) {
    if (!isNew(node)) continue;
    const trust = classify(node, 'issue_comment', state.prAuthor);
    if (trust === 'untrusted') events.push(untrusted(node));
    else if (trust !== 'ignore') {
      events.push({ type: 'issue_comment', ...ref(node, trust) });
    }
  }

  const actionable = events.some(
    (e) =>
      e.type === 'conflict' ||
      e.type === 'ci_failed' ||
      e.type === 'review_thread' ||
      e.type === 'review' ||
      e.type === 'issue_comment',
  );
  const action = movedExternally ? 'resync' : actionable ? 'fix' : 'wait';
  return { ...base, action, events, truncated };
}

export function fetchPrData(state: AutofixPrState): PrData {
  const out = gh(
    'api',
    'graphql',
    '-f',
    `query=${PR_QUERY}`,
    // -f, not -F: -F would turn an owner or repository named `true` or `123`
    // into a boolean or a number.
    '-f',
    `owner=${state.owner}`,
    '-f',
    `name=${state.repo}`,
    '-F',
    `number=${state.prNumber}`,
  );
  const pr = (
    JSON.parse(out) as {
      data: { repository: { pullRequest: PrData | null } | null };
    }
  ).data.repository?.pullRequest;
  if (!pr) {
    throw new Error(
      `PR #${state.prNumber} not found in ${state.owner}/${state.repo}`,
    );
  }
  return pr;
}

export function runSnapshot(prNumber: number): void {
  const root = repoRoot();
  const state = requireState(
    autofixPrPaths(root, prNumber).statePath,
    prNumber,
  );
  assertOwnedBySession(state);
  setGhHost(state.host);
  ensureAuthenticated();
  writeStdoutLine(JSON.stringify(buildSnapshot(fetchPrData(state), state)));
}

export const snapshotCommand: CommandModule = {
  command: 'snapshot <pr>',
  describe:
    'Read a prepared PR and print what changed since the last check, plus the next action (stop, resync, fix or wait)',
  builder: (yargs) =>
    yargs.positional('pr', {
      type: 'number',
      demandOption: true,
      describe: 'PR number prepared with `qwen autofix-pr prepare`',
    }),
  handler: (argv) => {
    runSnapshot(Number(argv['pr']));
  },
};
