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
import { buildSnapshot, fetchPrData, type Snapshot } from './snapshot.js';
import {
  REPLY_MARKER,
  assertOwnedBySession,
  autofixPrPaths,
  repoRoot,
  requireState,
  writeState,
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
  handledCommentIds: number;
  handledChecks: number;
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
  return {
    replies,
    summary,
    handled: stringList(plan['handled'], 'handled'),
    handledChecks: stringList(plan['handledChecks'], 'handledChecks'),
    handledConflict: conflict === true,
  };
}

/**
 * What the PR offers to handle right now, from a fresh prepared snapshot:
 * the trusted comments no round has handled, by thread for replies, and the
 * failed check attempts and conflict still reported.
 */
function actionable(snapshot: Snapshot): {
  threads: Map<number, Set<string>>;
  comments: Set<string>;
  untrusted: Set<string>;
  checks: Set<string>;
  conflict: boolean;
} {
  const threads = new Map<number, Set<string>>();
  const comments = new Set<string>();
  const untrusted = new Set<string>();
  const checks = new Set<string>();
  let conflict = false;
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
      case 'conflict':
        conflict = true;
        break;
      default:
        break;
    }
  }
  return { threads, comments, untrusted, checks, conflict };
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
    const fresh = reply.handled.filter((id) => !done.has(id));
    if (fresh.length === 0) {
      // Posted by an earlier run of this plan, which recorded the ids.
      skipped += 1;
      continue;
    }
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
  const knownChecks = new Set(state.handledChecks ?? []);
  for (const key of plan.handledChecks) {
    if (knownChecks.has(key) || offer.checks.has(key)) continue;
    throw new Error(
      `${key} is not a failure snapshot reports on the PR head; pass the \`key\` of a ci_failed event.`,
    );
  }
  if (plan.handledConflict && !offer.conflict) {
    throw new Error(`PR #${args.pr} reports no merge conflict on its head.`);
  }

  const outcome: ReplyOutcome = {
    posted: [],
    skipped,
    handledCommentIds: 0,
    handledChecks: 0,
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
    const posted = postComment(
      `${base}/pulls/${args.pr}/comments/${reply.replyTo}/replies`,
      reply.body,
    );
    // Recorded at once: a later failure must not leave this reply unknown,
    // or the next round would answer the same comments again.
    record({
      postedCommentIds: [...state.postedCommentIds, posted.id],
      handledCommentIds: [
        ...state.handledCommentIds,
        ...addHandled(reply.handled),
      ],
    });
    outcome.posted.push({ kind: 'thread', ...posted });
  }

  // A summary is posted once: one that handles comments, while any of them
  // is still open; one that only reports a push, once per head.
  const summary = plan.summary;
  const summaryDue =
    summary !== null &&
    (summary.handled && summary.handled.length > 0
      ? summary.handled.some((id) => !handledBefore.has(id))
      : state.summarizedSha !== pr.headRefOid);
  if (summary && args.post && summaryDue) {
    const posted = postComment(
      `${base}/issues/${args.pr}/comments`,
      summary.body,
    );
    record({
      postedCommentIds: [...state.postedCommentIds, posted.id],
      summarizedSha: pr.headRefOid,
    });
    outcome.posted.push({ kind: 'summary', ...posted });
  } else if (summary && !summaryDue) {
    outcome.skipped += 1;
  }

  const freshChecks = [...new Set(plan.handledChecks)].filter(
    (key) => !knownChecks.has(key),
  );
  outcome.handledChecks = freshChecks.length;
  record({
    handledCommentIds: [
      ...state.handledCommentIds,
      ...addHandled(otherHandled),
    ],
    handledChecks: [...(state.handledChecks ?? []), ...freshChecks],
    ...(plan.handledConflict ? { handledConflictSha: pr.headRefOid } : {}),
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
