/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen autofix-pr reply`: post the replies of one round and record what the
// round handled. The plan comes from the skill; this helper decides what may
// be posted. Every reply goes to a thread the PR has right now with a new
// comment from a trusted author, every body ends with the marker that keeps
// the tool from answering itself, and each posted id is recorded the moment
// it exists, so a retry after a failure never posts the same reply twice.

import type { CommandModule } from 'yargs';
import { readFileSync } from 'node:fs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  ensureAuthenticated,
  ghWithInput,
  setGhHost,
} from '../review/lib/gh.js';
import {
  buildSnapshot,
  fetchPrData,
  isOwnReply,
  type CommentNode,
  type PrData,
  type Snapshot,
} from './snapshot.js';
import {
  REPLY_MARKER,
  assertOwnedBySession,
  autofixPrPaths,
  repoRoot,
  requireState,
  withWatchLock,
  writeState,
  type AutofixPrPaths,
  type AutofixPrState,
} from './state.js';

/** GitHub refuses a comment body longer than this. */
const MAX_BODY_CHARS = 65_536;

export interface ReplyPlan {
  /** Replies to review threads, by the thread's first comment. */
  replies?: Array<{ replyTo: number; body: string; handled: string[] }>;
  /** The round's PR comment: what the push addressed and how it was verified. */
  summary?: { body: string; handled?: string[] } | null;
  /** Comments handled without a reply of their own. */
  handled?: string[];
  /** Failed check attempts handled without a push (their snapshot `key`). */
  handledChecks?: string[];
  /** The head's merge conflict was left for a human. */
  handledConflict?: boolean;
}

export interface ReplyOutcome {
  posted: Array<{ kind: 'thread' | 'summary'; id: string; url: string }>;
  /** Replies already posted by an earlier run of the same plan. */
  skipped: number;
  /** The summary was posted already (its comments are handled, or it
   * reported this head's push). */
  summarySkipped: boolean;
  handledCommentIds: number;
  handledChecks: number;
  /** Keys of an earlier head, which the round pushed past: not recorded. */
  ignoredChecks: number;
  /** Replies found already on the PR (a POST whose answer was lost) and
   * recorded instead of posted again. */
  adopted: number;
}

function stringList(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string' && item !== '')
  ) {
    throw new TypeError(`${what} must be an array of non-empty strings`);
  }
  return value as string[];
}

function bodyOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${what} must be a non-empty string`);
  }
  // A body that already carries the marker at its end keeps one copy.
  const trimmed = value.trimEnd();
  const text = trimmed.endsWith(REPLY_MARKER)
    ? trimmed
    : `${trimmed}\n\n${REPLY_MARKER}`;
  if (text.length > MAX_BODY_CHARS) {
    throw new TypeError(
      `${what} is ${text.length} characters with the marker; GitHub takes at most ${MAX_BODY_CHARS}`,
    );
  }
  return text;
}

/** Parses and shape-checks a plan file; throws on anything malformed. */
export function parsePlan(raw: unknown): Required<ReplyPlan> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('the reply plan must be a JSON object');
  }
  const plan = raw as Record<string, unknown>;
  const known = new Set([
    'replies',
    'summary',
    'handled',
    'handledChecks',
    'handledConflict',
  ]);
  const unknown = Object.keys(plan).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`unknown reply plan field(s): ${unknown.join(', ')}`);
  }
  if (plan['replies'] !== undefined && !Array.isArray(plan['replies'])) {
    throw new TypeError('replies must be an array');
  }
  const replies = ((plan['replies'] as unknown[] | undefined) ?? []).map(
    (entry, index) => {
      const reply = entry as Record<string, unknown>;
      const replyTo = reply?.['replyTo'];
      if (!Number.isSafeInteger(replyTo) || (replyTo as number) < 1) {
        throw new TypeError(
          `replies[${index}].replyTo must be a positive integer (the thread's \`replyTo\` from snapshot)`,
        );
      }
      const handled = stringList(reply['handled'], `replies[${index}].handled`);
      if (handled.length === 0) {
        throw new TypeError(
          `replies[${index}].handled must name the thread comments the reply answers`,
        );
      }
      return {
        replyTo: replyTo as number,
        body: bodyOf(reply['body'], `replies[${index}].body`),
        handled,
      };
    },
  );
  const summaryRaw = plan['summary'];
  let summary: Required<ReplyPlan>['summary'] = null;
  if (summaryRaw !== undefined && summaryRaw !== null) {
    if (typeof summaryRaw !== 'object' || Array.isArray(summaryRaw)) {
      throw new TypeError('summary must be an object or null');
    }
    const s = summaryRaw as Record<string, unknown>;
    summary = {
      body: bodyOf(s['body'], 'summary.body'),
      handled: stringList(s['handled'], 'summary.handled'),
    };
  }
  const conflict = plan['handledConflict'];
  if (conflict !== undefined && typeof conflict !== 'boolean') {
    throw new TypeError('handledConflict must be a boolean');
  }
  const handled = stringList(plan['handled'], 'handled');
  // One reply per thread and one answer per comment: a plan that names
  // either twice would post the same reply twice.
  const threads = new Set<number>();
  for (const reply of replies) {
    if (threads.has(reply.replyTo)) {
      throw new TypeError(`thread ${reply.replyTo} has more than one reply`);
    }
    threads.add(reply.replyTo);
  }
  const ids = [
    ...replies.flatMap((reply) => reply.handled),
    ...(summary?.handled ?? []),
    ...handled,
  ];
  const twice = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (twice.length > 0) {
    throw new TypeError(
      `comment(s) handled more than once in the plan: ${[...new Set(twice)].join(', ')}`,
    );
  }
  return {
    replies,
    summary,
    handled,
    handledChecks: stringList(plan['handledChecks'], 'handledChecks'),
    handledConflict: conflict === true,
  };
}

/** The head SHA a check attempt key names (`<check>@<head>@<attempt>`). */
function keyHead(key: string): string | null {
  return /@([0-9a-f]{40,64})@[^@]*$/.exec(key)?.[1] ?? null;
}

/**
 * What the PR offers to handle right now, from a fresh prepared snapshot:
 * the trusted comments no round has handled, by thread for replies, and the
 * failed check attempts still reported.
 */
function actionable(snapshot: Snapshot): {
  threads: Map<number, Set<string>>;
  comments: Set<string>;
  untrusted: Set<string>;
  checks: Set<string>;
} {
  const threads = new Map<number, Set<string>>();
  const comments = new Set<string>();
  const untrusted = new Set<string>();
  const checks = new Set<string>();
  for (const event of snapshot.events) {
    switch (event.type) {
      case 'review_thread': {
        const ids = new Set(event.comments.map((comment) => comment.id));
        if (event.replyTo !== null) threads.set(event.replyTo, ids);
        for (const id of ids) comments.add(id);
        break;
      }
      case 'review':
      case 'issue_comment':
        comments.add(event.id);
        break;
      case 'untrusted_comment':
        untrusted.add(event.id);
        break;
      case 'ci_failed':
        if (event.key) checks.add(event.key);
        break;
      default:
        break;
    }
  }
  return { threads, comments, untrusted, checks };
}

/**
 * A reply of this tool's that already follows every comment in `handled`
 * on the list `nodes` (oldest first) and is not recorded: a POST that
 * reached GitHub although its answer was lost. Adopting it, instead of
 * posting again, keeps a retry from answering the same comments twice.
 */
function unrecordedReply(
  nodes: CommentNode[],
  handled: string[],
  viewer: string,
  posted: Set<string>,
): CommentNode | null {
  const last = Math.max(
    ...handled.map((id) => nodes.findIndex((n) => n.id === id)),
  );
  if (last < 0 || handled.some((id) => !nodes.some((n) => n.id === id))) {
    return null;
  }
  return (
    nodes
      .slice(last + 1)
      .find((node) => isOwnReply(node, viewer) && !posted.has(node.id)) ?? null
  );
}

function threadComments(pr: PrData, replyTo: number): CommentNode[] {
  return (
    pr.reviewThreads.nodes.find(
      (thread) => thread.root.nodes[0]?.databaseId === replyTo,
    )?.comments.nodes ?? []
  );
}

function postComment(path: string, body: string): { id: string; url: string } {
  // Not retried: a POST that reached GitHub before a proxy error would be
  // posted twice.
  const response = JSON.parse(
    ghWithInput(
      JSON.stringify({ body }),
      'api',
      '--method',
      'POST',
      path,
      '--input',
      '-',
    ),
  ) as { node_id?: string; html_url?: string };
  if (!response.node_id) {
    throw new Error(`GitHub answered ${path} without a comment id`);
  }
  return { id: response.node_id, url: response.html_url ?? '' };
}

export interface ReplyArgs {
  pr: number;
  planPath: string;
  /** `--no-post`: record what was handled, post nothing (`--no-reply`). */
  post: boolean;
}

export function runReply(args: ReplyArgs): ReplyOutcome {
  const plan = parsePlan(JSON.parse(readFileSync(args.planPath, 'utf8')));
  const paths = autofixPrPaths(repoRoot(), args.pr);
  return withWatchLock(paths, args.pr, () => replyLocked(args, plan, paths));
}

function replyLocked(
  args: ReplyArgs,
  plan: Required<ReplyPlan>,
  paths: AutofixPrPaths,
): ReplyOutcome {
  let state = requireState(paths.statePath, args.pr);
  assertOwnedBySession(state);
  setGhHost(state.host);
  ensureAuthenticated();
  const { pr } = fetchPrData(state);
  if (pr.state !== 'OPEN') {
    throw new Error(
      `PR #${args.pr} is ${pr.state.toLowerCase()}; nothing is posted on it.`,
    );
  }
  const offer = actionable(buildSnapshot(pr, state));
  const handledBefore = new Set(state.handledCommentIds);
  const done = new Set(handledBefore);

  // Everything is checked before anything is posted.
  const pending: typeof plan.replies = [];
  let skipped = 0;
  for (const reply of plan.replies) {
    if (reply.handled.some((id) => done.has(id))) {
      // Posted by an earlier run of this plan, which recorded its ids with
      // it. A comment of the thread it did not name stays open for the
      // next round rather than risk a second copy of this reply.
      skipped += 1;
      continue;
    }
    const fresh = reply.handled;
    const thread = offer.threads.get(reply.replyTo);
    if (!thread) {
      throw new Error(
        `thread ${reply.replyTo} has no new comment from a trusted author on PR #${args.pr}; ` +
          `autofix replies only to the threads snapshot reports.`,
      );
    }
    const foreign = fresh.filter((id) => !thread.has(id));
    if (foreign.length > 0) {
      throw new Error(
        `replies to thread ${reply.replyTo} name comments outside it or not actionable: ${foreign.join(', ')}`,
      );
    }
    pending.push(reply);
  }
  const otherHandled = [...(plan.summary?.handled ?? []), ...plan.handled];
  for (const id of otherHandled) {
    if (done.has(id) || offer.comments.has(id)) continue;
    throw new Error(
      offer.untrusted.has(id)
        ? `${id} is from an author autofix does not act on; it is listed, never handled.`
        : `${id} is not a new comment from a trusted author on PR #${args.pr}.`,
    );
  }
  // A failure of an earlier head — the round pushed past it — is history:
  // prepared snapshots read only the current head, so it is not recorded.
  const knownChecks = new Set(state.handledChecks ?? []);
  const currentChecks: string[] = [];
  let ignoredChecks = 0;
  for (const key of new Set(plan.handledChecks)) {
    if (keyHead(key) !== pr.headRefOid) {
      ignoredChecks += 1;
      continue;
    }
    if (knownChecks.has(key)) continue;
    if (!offer.checks.has(key)) {
      throw new Error(
        `${key} is not a failure snapshot reports on the PR head; pass the \`key\` of a ci_failed event.`,
      );
    }
    currentChecks.push(key);
  }

  const outcome: ReplyOutcome = {
    posted: [],
    skipped,
    summarySkipped: false,
    handledCommentIds: 0,
    handledChecks: 0,
    ignoredChecks,
    adopted: 0,
  };
  const record = (patch: Partial<AutofixPrState>) => {
    state = { ...state, ...patch };
    writeState(paths.statePath, state);
  };
  const addHandled = (ids: string[]) => {
    const fresh = [...new Set(ids)].filter((id) => !done.has(id));
    for (const id of fresh) done.add(id);
    outcome.handledCommentIds += fresh.length;
    return fresh;
  };
  const base = `repos/${state.owner}/${state.repo}`;

  for (const reply of pending) {
    if (!args.post) {
      record({
        handledCommentIds: [
          ...state.handledCommentIds,
          ...addHandled(reply.handled),
        ],
      });
      continue;
    }
    const earlier = unrecordedReply(
      threadComments(pr, reply.replyTo),
      reply.handled,
      state.viewer,
      new Set(state.postedCommentIds),
    );
    const posted = earlier
      ? { id: earlier.id, url: earlier.url }
      : postComment(
          `${base}/pulls/${args.pr}/comments/${reply.replyTo}/replies`,
          reply.body,
        );
    if (earlier) outcome.adopted += 1;
    // Recorded at once: a later failure must not leave this reply unknown,
    // or the next round would answer the same comments again.
    record({
      postedCommentIds: [...state.postedCommentIds, posted.id],
      handledCommentIds: [
        ...state.handledCommentIds,
        ...addHandled(reply.handled),
      ],
    });
    if (!earlier) outcome.posted.push({ kind: 'thread', ...posted });
  }

  // A summary is posted once: one that handles comments, while any of them
  // is still open; one that only reports a push, once per head.
  const summary = plan.summary;
  const summaryDue =
    summary !== null &&
    (summary.handled && summary.handled.length > 0
      ? summary.handled.some((id) => !handledBefore.has(id))
      : state.summarizedSha !== pr.headRefOid);
  if (summary && summaryDue) {
    // Its comments are recorded with it, so a retry after a later failure
    // finds it posted. `--no-post` records the same, posting nothing.
    // Only a summary answering conversation comments can be matched to one
    // already on the PR: reviews sit on another list, in no shared order.
    const earlier =
      args.post && (summary.handled ?? []).length > 0
        ? unrecordedReply(
            pr.comments.nodes,
            summary.handled ?? [],
            state.viewer,
            new Set(state.postedCommentIds),
          )
        : null;
    if (earlier) outcome.adopted += 1;
    const posted = earlier
      ? { id: earlier.id, url: earlier.url }
      : args.post
        ? postComment(`${base}/issues/${args.pr}/comments`, summary.body)
        : null;
    record({
      postedCommentIds: posted
        ? [...state.postedCommentIds, posted.id]
        : state.postedCommentIds,
      handledCommentIds: [
        ...state.handledCommentIds,
        ...addHandled(summary.handled ?? []),
      ],
      summarizedSha: pr.headRefOid,
    });
    if (posted && !earlier) outcome.posted.push({ kind: 'summary', ...posted });
  } else if (summary) {
    outcome.summarySkipped = true;
  }

  outcome.handledChecks = currentChecks.length;
  record({
    handledCommentIds: [
      ...state.handledCommentIds,
      ...addHandled(otherHandled),
    ],
    handledChecks: [...(state.handledChecks ?? []), ...currentChecks],
    // Right after a push GitHub reports `UNKNOWN` until it has recomputed
    // the merge, so a conflict left for a human is recorded unless the
    // head is known to merge cleanly.
    ...(plan.handledConflict && pr.mergeable !== 'MERGEABLE'
      ? { handledConflictSha: pr.headRefOid }
      : {}),
  });
  return outcome;
}

export const replyCommand: CommandModule = {
  command: 'reply <pr> <plan>',
  describe:
    "Post a round's replies from a plan file and record the comments, failed checks and conflict it handled",
  builder: (yargs) =>
    yargs
      .positional('pr', {
        type: 'number',
        demandOption: true,
        describe: 'PR number',
      })
      .positional('plan', {
        type: 'string',
        demandOption: true,
        describe: 'Path of the reply plan (JSON)',
      })
      .option('post', {
        type: 'boolean',
        default: true,
        describe:
          'Post the replies and the summary; --no-post only records what was handled',
      }),
  handler: (argv) => {
    writeStdoutLine(
      JSON.stringify(
        runReply({
          pr: Number(argv['pr']),
          planPath: String(argv['plan']),
          post: Boolean(argv['post']),
        }),
      ),
    );
  },
};
