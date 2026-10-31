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
import { createHash } from 'node:crypto';
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
  heldKeys,
  roundReplyCheck,
  isOwnReply,
  type CommentNode,
  type PrData,
  type Snapshot,
} from './snapshot.js';
import {
  MAX_NEEDS_HUMAN,
  REPLY_MARKER,
  assertWatching,
  isRegularFile,
  TASK_OPTION,
  taskArg,
  autofixPrPaths,
  resolveWatchRoot,
  requireState,
  withWatchLock,
  writeState,
  type AutofixPrPaths,
  type AutofixPrState,
  type PendingPost,
} from './state.js';
import { assertNoFixInFlight, fixSnapshotPath } from './fix.js';

/** GitHub refuses a comment body longer than this. */
const MAX_BODY_CHARS = 65_536;

/** Longest `needsHuman` line kept; a longer one is cut. */
const MAX_NEEDS_HUMAN_CHARS = 300;

export interface ReplyPlan {
  /** Replies to review threads, by the thread's first comment. */
  replies?: Array<{ replyTo: number; body: string; handled: string[] }>;
  /** The round's PR comment: what the push addressed and how it was
   * verified, or — with nothing pushed — what blocks it and needs a person. */
  summary?: { body: string; handled?: string[] } | null;
  /** Comments handled without a reply of their own. */
  handled?: string[];
  /** Failed check attempts handled without a push (their snapshot `key`). */
  handledChecks?: string[];
  /** The head's merge conflict was left for a human. */
  handledConflict?: boolean;
  /** One line per item the round left for a person, for `status`. */
  needsHuman?: string[];
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
    'needsHuman',
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
    // Shown in a list, one line each.
    needsHuman: stringList(plan['needsHuman'], 'needsHuman').map((text) => {
      // By code point, so a cut never splits a surrogate pair.
      const line = [
        ...text
          .replace(/\p{Cf}/gu, '')
          .replace(/[\s\p{Cc}]+/gu, ' ')
          .trim(),
      ];
      return line.length > MAX_NEEDS_HUMAN_CHARS
        ? `${line.slice(0, MAX_NEEDS_HUMAN_CHARS - 1).join('')}…`
        : line.join('');
    }),
  };
}

/** The head SHA a check attempt key names (`<check>@<head>@<attempt>`). */
function keyHead(key: string): string | null {
  return /@([0-9a-f]{40,64})@[^@]*$/.exec(key)?.[1] ?? null;
}

/**
 * The failure keys the round's prepared snapshot reported. The head can
 * move on from one while the round runs — a re-run, a run a review starts
 * — and the round's answer to it still stands: a key that names no run (a
 * workflow a review starts) is the one the next failure of that check on
 * the head carries.
 */
function snapshotChecks(path: string): Set<string> {
  // A FIFO in its place would block, the lock held.
  if (!isRegularFile(path)) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return new Set();
  }
  const events = (parsed as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return new Set();
  return new Set(
    events.flatMap((event: unknown) => {
      const { type, key } = (event ?? {}) as { type?: unknown; key?: unknown };
      return type === 'ci_failed' && typeof key === 'string' ? [key] : [];
    }),
  );
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

/** sha256 of a body as GitHub stores it (line endings and trailing space
 * aside), to recognize a reply on the PR as the one an earlier run posted. */
function bodyHash(body: string): string {
  return createHash('sha256')
    .update(body.replace(/\r\n/g, '\n').trimEnd())
    .digest('hex');
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
  /** The scheduled task that woke the round. */
  task?: string;
}

export function runReply(args: ReplyArgs): ReplyOutcome {
  const plan = parsePlan(JSON.parse(readFileSync(args.planPath, 'utf8')));
  const paths = autofixPrPaths(resolveWatchRoot(args.pr), args.pr);
  return withWatchLock(paths, args.pr, () => replyLocked(args, plan, paths));
}

function replyLocked(
  args: ReplyArgs,
  plan: Required<ReplyPlan>,
  paths: AutofixPrPaths,
): ReplyOutcome {
  let state = requireState(paths.statePath, args.pr);
  assertWatching(state, args.task);
  assertNoFixInFlight(paths, args.pr);
  // The option the watch was started with holds for its rounds, whatever
  // a round's turn remembers of it; a `--once` round has options of its own.
  if (args.post && args.task !== undefined && state.watch?.reply === false) {
    throw new Error(
      `PR #${args.pr}'s watch was started with --no-reply: run reply with --no-post.`,
    );
  }
  setGhHost(state.host);
  ensureAuthenticated();
  // Every bot thread the plan may name was asked about by the round's
  // snapshot; one opened since is not the plan's, so it waits for the gate
  // rather than fail the replies to the rest.
  const { pr } = fetchPrData(state, roundReplyCheck(state, false));
  if (pr.state !== 'OPEN') {
    throw new Error(
      `PR #${args.pr} is ${pr.state.toLowerCase()}; nothing is posted on it.`,
    );
  }
  const record = (patch: Partial<AutofixPrState>) => {
    state = { ...state, ...patch };
    writeState(paths.statePath, state);
  };
  // The head the watch knows — `sync` and `push` read it from the branch —
  // rather than the API's, which can lag a push by some seconds.
  const head = state.lastKnownHeadSha;

  // Replies an earlier run was posting when it stopped: each one on the PR
  // was posted although its answer was lost, and is recorded with exactly
  // the comments it answered; one that is not on the PR never was posted.
  let adopted = 0;
  if ((state.pendingPosts ?? []).length > 0) {
    const posted = new Set(state.postedCommentIds);
    const postedIds: string[] = [];
    const handledIds: string[] = [];
    let summarized: string | null = null;
    let summarizedBlocked: string[] | null = null;
    for (const intent of state.pendingPosts ?? []) {
      const nodes =
        intent.where === 'summary'
          ? pr.comments.nodes
          : threadComments(pr, intent.where);
      const node = nodes.find(
        (n) =>
          isOwnReply(n, state.viewer) &&
          !posted.has(n.id) &&
          bodyHash(n.body) === intent.bodyHash,
      );
      if (!node) continue;
      posted.add(node.id);
      postedIds.push(node.id);
      handledIds.push(...intent.handled);
      // The head the summary reported, not the current one: a later push
      // still needs a summary of its own.
      if (intent.where === 'summary') {
        summarized = intent.sha;
        // What that summary reported, from its own intent: a later plan's
        // items are not covered by it.
        summarizedBlocked = intent.needsHuman ?? [];
      }
      adopted += 1;
    }
    record({
      postedCommentIds: [...state.postedCommentIds, ...postedIds],
      handledCommentIds: [
        ...new Set([...state.handledCommentIds, ...handledIds]),
      ],
      pendingPosts: [],
      ...(summarized ? { summarizedSha: summarized } : {}),
      ...(summarized !== null && summarizedBlocked !== null
        ? {
            reportedNeedsHuman: { sha: summarized, texts: summarizedBlocked },
          }
        : {}),
    });
  }

  const offer = actionable(buildSnapshot(pr, state));
  const handledBefore = new Set(state.handledCommentIds);
  const done = new Set(handledBefore);

  // Everything is checked before anything is posted.
  const pending: typeof plan.replies = [];
  let skipped = 0;
  for (const reply of plan.replies) {
    // A comment answered already — by an earlier run of this plan, or by a
    // reply the step above found — is not answered again; the rest are.
    const open = reply.handled.filter((id) => !done.has(id));
    if (open.length === 0) {
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
    const foreign = open.filter((id) => !thread.has(id));
    if (foreign.length > 0) {
      throw new Error(
        `replies to thread ${reply.replyTo} name comments outside it or not actionable: ${foreign.join(', ')}`,
      );
    }
    pending.push({ ...reply, handled: open });
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
  // A failure of another head — the round pushed past it, or someone else
  // pushed while it ran — is history: prepared snapshots read only the
  // current head, so it is not recorded.
  const knownChecks = new Set(state.handledChecks ?? []);
  // The round of a background fix claimed its snapshot under another
  // name, and no round prepared one since.
  const roundChecks = snapshotChecks(
    isRegularFile(paths.snapshotPath)
      ? paths.snapshotPath
      : fixSnapshotPath(paths, args.pr),
  );
  const held = heldKeys(pr, state);
  const currentChecks: string[] = [];
  let ignoredChecks = 0;
  for (const key of new Set(plan.handledChecks)) {
    // Not a key at all — a gate key, a check name — would otherwise pass for
    // one of another head and be dropped while the round counts it handled.
    if (keyHead(key) === null) {
      throw new Error(
        `${key} is not the \`key\` of a ci_failed event (<check>@<head>@<attempt>).`,
      );
    }
    if (keyHead(key) !== head || keyHead(key) !== pr.headRefOid) {
      ignoredChecks += 1;
      continue;
    }
    if (knownChecks.has(key)) continue;
    if (!offer.checks.has(key)) {
      if (!roundChecks.has(key)) {
        throw new Error(
          `${key} is not a failure snapshot reports on the PR head; pass the \`key\` of a ci_failed event.`,
        );
      }
      // A failure a deferral holds while its run goes is reported again
      // once the run has ended, and answered then: recorded now, it would
      // be hidden. Any other the round saw is not reported again: the
      // round's answer stands.
      if (held.has(key)) {
        ignoredChecks += 1;
        continue;
      }
    }
    currentChecks.push(key);
  }

  // Kept per head, newest last: a later round answers new events only, so
  // what an earlier one left stays listed until the watch ends. Recorded
  // before anything is posted: a reply that reaches the PR marks its
  // comments handled at once, and a round after a later failure would not
  // see them again.
  const now = new Date().toISOString();
  const freshNeedsHuman = [...new Set(plan.needsHuman)].filter(
    (text) =>
      text !== '' &&
      !(state.needsHuman ?? []).some(
        (item) => item.sha === head && item.text === text,
      ),
  );
  const needsHuman = [
    ...(state.needsHuman ?? []),
    ...freshNeedsHuman.map((text) => ({ sha: head, at: now, text })),
  ].slice(-MAX_NEEDS_HUMAN);
  if (needsHuman.length > 0) record({ needsHuman });

  // What this plan asks to report, against what a summary that reached the PR
  // already reported on this head. Deliberately not `freshNeedsHuman`: the
  // record above consumes that before any POST, so a run whose summary never
  // arrived would find nothing left to report when it is run again.
  const planNeedsHuman = [...new Set(plan.needsHuman)].filter(
    (text) => text !== '',
  );
  const reportedBlocked = new Set(
    state.reportedNeedsHuman?.sha === head
      ? state.reportedNeedsHuman.texts
      : [],
  );
  const unreportedNeedsHuman = planNeedsHuman.filter(
    (text) => !reportedBlocked.has(text),
  );

  const outcome: ReplyOutcome = {
    posted: [],
    skipped,
    summarySkipped: false,
    handledCommentIds: 0,
    handledChecks: 0,
    ignoredChecks,
    adopted,
  };
  const addHandled = (ids: string[]) => {
    const fresh = [...new Set(ids)].filter((id) => !done.has(id));
    for (const id of fresh) done.add(id);
    outcome.handledCommentIds += fresh.length;
    return fresh;
  };
  const base = `repos/${state.owner}/${state.repo}`;
  // Each POST is announced in the state file first, so that a POST whose
  // answer is lost is recognized on the PR by the next run.
  const post = (
    where: number | 'summary',
    handled: string[],
    path: string,
    body: string,
    needsHuman?: string[],
  ) => {
    const intent: PendingPost = {
      where,
      handled,
      bodyHash: bodyHash(body),
      sha: head,
      // What a summary reports, so a run that finds it on the PR after losing
      // its answer marks exactly these as reported.
      ...(needsHuman && needsHuman.length > 0 ? { needsHuman } : {}),
    };
    record({ pendingPosts: [...(state.pendingPosts ?? []), intent] });
    const posted = postComment(path, body);
    return {
      posted,
      settled: (state.pendingPosts ?? []).filter((p) => p !== intent),
    };
  };

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
    const { posted, settled } = post(
      reply.replyTo,
      reply.handled,
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
      pendingPosts: settled,
    });
    outcome.posted.push({ kind: 'thread', ...posted });
  }

  // A summary is posted once: one that handles comments, while any of them
  // is still open; one that answers none, once per head. A round that leaves
  // something for a person which no delivered summary has reported gets one
  // whatever was posted on this head before, so a blocked round is not silent
  // where an earlier one already reported — and a report that never reached
  // the PR is still due when the plan is run again.
  const summary = plan.summary;
  const summaryHandled = (summary?.handled ?? []).filter((id) => !done.has(id));
  // A head this watch pushed and has not summarized needs its summary even
  // when the comments it names were answered meanwhile.
  const pushUnsummarized =
    state.pushedShas.includes(head) && state.summarizedSha !== head;
  const summaryDue =
    summary !== null &&
    (unreportedNeedsHuman.length > 0 ||
      ((summary.handled ?? []).length > 0
        ? summaryHandled.length > 0 || pushUnsummarized
        : state.summarizedSha !== head));
  if (summary && summaryDue) {
    // Its comments are recorded with it. `--no-post` records the same,
    // posting nothing.
    const result = args.post
      ? post(
          'summary',
          summaryHandled,
          `${base}/issues/${args.pr}/comments`,
          summary.body,
          planNeedsHuman,
        )
      : null;
    record({
      postedCommentIds: result
        ? [...state.postedCommentIds, result.posted.id]
        : state.postedCommentIds,
      handledCommentIds: [
        ...state.handledCommentIds,
        ...addHandled(summaryHandled),
      ],
      summarizedSha: head,
      // Only now, with the summary posted (or recorded for a watch that posts
      // nothing), are its items reported: a failed POST above leaves this
      // untouched, so the next run still owes the PR its report.
      ...(planNeedsHuman.length > 0
        ? {
            reportedNeedsHuman: {
              sha: head,
              texts: [...new Set([...reportedBlocked, ...planNeedsHuman])],
            },
          }
        : {}),
      ...(result ? { pendingPosts: result.settled } : {}),
    });
    if (result) outcome.posted.push({ kind: 'summary', ...result.posted });
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
    // A conflict is recorded only while there is one: GitHub reports it,
    // or — right after this watch pushed the head, when GitHub answers
    // `UNKNOWN` until it has recomputed the merge — may still report it.
    ...(plan.handledConflict &&
    (pr.mergeable === 'CONFLICTING' ||
      (pr.mergeable === 'UNKNOWN' && state.pushedShas.includes(head)))
      ? { handledConflictSha: head }
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
      })
      .option('task', TASK_OPTION),
  handler: (argv) => {
    writeStdoutLine(
      JSON.stringify(
        runReply({
          pr: Number(argv['pr']),
          planPath: String(argv['plan']),
          post: Boolean(argv['post']),
          task: taskArg(argv),
        }),
      ),
    );
  },
};
