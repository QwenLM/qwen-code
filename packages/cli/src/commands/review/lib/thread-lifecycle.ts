/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The GitHub review-thread lifecycle: one finding, one thread (#9906).
//
// Two gaps lived here. A carried finding — Step 6's `still stands`,
// re-drafted under its original id — rode the next round's Create Review
// `comments[]` like any new finding, and that API opens a NEW thread per
// entry: only the replies endpoint joins an existing one. So a finding
// accumulated one unresolved thread per round it survived (#9659's R1-15
// alone had four), on a false premise ("GitHub stacks same-line comments
// in the original thread") that presubmit's re-post exemption was built
// on. And a finding ruled `fixed` retired from the ledger while its
// thread stayed open forever — nothing in the pipeline could resolve one,
// so the PR's unresolved list stopped meaning "still standing" (11 of 23
// open Critical threads on #9659 described defects already fixed).
//
// The fix, in code rather than in a rule the model is asked to keep: at
// submit time the PR's review threads are read ONCE, matched to findings
// by the carried id that already leads every posted claim line (the same
// readback the ledger builder performs — nothing new is persisted, and
// findings posted before this existed match too), and the round's thread
// bookkeeping lands in the same posting pass:
//
//  - a carried finding REPLIES into its original thread instead of
//    opening a new one (only into an UNRESOLVED thread this account
//    opened — a resolved or foreign original means the re-post goes
//    inline and starts a fresh thread, which is what a still-standing
//    finding deserves). A `(fix-induced)` re-report is NOT diverted: it
//    is a new defect wearing the id, the ledger's fresh count treats it
//    as first-time work, and first-time work gets its own thread.
//  - a Step 6 `fixed` ruling replies its one line (`R1-2 fixed by
//    <what>` — the text the status table already renders) into EVERY
//    live thread this account opened under the id and resolves it, so
//    the unresolved list reads as "still standing" again.
//
// GitHub only: the Aone write path fans findings out as plain MR comments
// and has no review-thread graph to reply into or resolve.

import { gh, ghWithInput } from './gh.js';
import { LEDGER_ID_READBACK, readClaim } from './ledger.js';
import { carriedClaimLine } from './inline-counts.js';
import type { FixedFinding } from '../compose-review.js';

/** One review thread, reduced to what the lifecycle decisions read. */
export interface ReviewThread {
  /** The GraphQL node id — `resolveReviewThread`'s handle. */
  threadId: string;
  isResolved: boolean;
  /** The root comment's REST id — the replies endpoint's handle. */
  rootCommentId: number;
  rootAuthor: string | null;
  rootCreatedAt: string;
  rootBody: string;
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { databaseId body createdAt author { login } }
          }
        }
      }
    }
  }
}`;

/**
 * A bound on pagination, not on threads: a thread-heavy PR (#9659 carried
 * 206) pages three times. Past the cap the read stops with what it has —
 * a partial view can only miss a match, and a missed match degrades to
 * the pre-fix behaviour (the carried finding posts inline), never to a
 * wrong reply or a wrong resolve.
 */
const MAX_THREAD_PAGES = 30;

/**
 * The PR's review threads, oldest-visible-page order preserved. Throws on
 * a transport or shape failure — the read runs BEFORE the review's write,
 * so a failure costs a retryable aborted submit, never a half-planned
 * posting pass.
 */
export function fetchReviewThreads(repo: string, pr: number): ReviewThread[] {
  const [owner, name] = repo.split('/');
  const threads: ReviewThread[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${THREADS_QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `pr=${pr}`,
    ];
    if (after !== undefined) args.push('-f', `after=${after}`);
    const response = JSON.parse(gh(...args)) as {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              pageInfo?: { hasNextPage?: boolean; endCursor?: string };
              nodes?: unknown;
            };
          };
        };
      };
    };
    const rt = response.data?.repository?.pullRequest?.reviewThreads;
    if (rt === undefined || !Array.isArray(rt.nodes)) {
      throw new Error(
        `reviewThreads read on ${repo}#${pr} returned no thread list — ` +
          `the thread lifecycle cannot plan without it.`,
      );
    }
    for (const node of rt.nodes as Array<{
      id?: unknown;
      isResolved?: unknown;
      comments?: { nodes?: unknown };
    }>) {
      const root = Array.isArray(node?.comments?.nodes)
        ? (node.comments.nodes[0] as
            | {
                databaseId?: unknown;
                body?: unknown;
                createdAt?: unknown;
                author?: { login?: unknown } | null;
              }
            | undefined)
        : undefined;
      // A thread with no readable root cannot be matched or replied into —
      // skip it rather than throw the whole read over one odd node.
      if (
        typeof node?.id !== 'string' ||
        typeof root?.databaseId !== 'number' ||
        typeof root?.body !== 'string'
      ) {
        continue;
      }
      threads.push({
        threadId: node.id,
        isResolved: node.isResolved === true,
        rootCommentId: root.databaseId,
        rootAuthor:
          typeof root.author?.login === 'string' ? root.author.login : null,
        rootCreatedAt: typeof root.createdAt === 'string' ? root.createdAt : '',
        rootBody: root.body,
      });
    }
    if (rt.pageInfo?.hasNextPage !== true || !rt.pageInfo.endCursor) break;
    after = rt.pageInfo.endCursor;
  }
  return threads;
}

/**
 * The carried id a comment body leads with, when it leads with one — the
 * readback the ledger builder performs, with one extra leg: an
 * attribution-off post carries no severity marker, so the bare first line
 * is tried too. Everything past the marker is model text; only the
 * ^-anchored grammar position is trusted.
 */
export function carriedFindingOf(body: unknown): {
  id: string;
  fixInduced: boolean;
} | null {
  if (typeof body !== 'string') return null;
  const marked = carriedClaimLine(body);
  const line = (marked ?? body.split('\n')[0]).trim();
  if (!LEDGER_ID_READBACK.test(line)) return null;
  const { id, fixInduced } = readClaim(line);
  return id === undefined ? null : { id, fixInduced };
}

export interface ThreadActionPlan {
  /** Carried drafted-comment index → the original thread it replies into. */
  replies: Array<{ index: number; id: string; commentId: number }>;
  /** Fixed rulings → every live own thread under the id, resolved. */
  resolves: Array<{
    id: string;
    by?: string;
    threadId: string;
    commentId: number;
  }>;
  /** Fixed ids that matched no live own thread (already resolved, or gone). */
  unmatchedFixed: string[];
}

/**
 * Match threads to findings. Pure — the decisions a unit test pins:
 *
 *  - only UNRESOLVED threads THIS account opened (a resolved original
 *    stays resolved — replying would not reopen it — and a foreign
 *    thread is never this pipeline's to answer or close);
 *  - a carried finding replies into the OLDEST matching thread (the
 *    original), one reply per thread per round — extra drafts under the
 *    same id (an aggregate's further locations) get no target and stay
 *    inline, one thread per location as the original round posted them;
 *  - a fixed ruling resolves EVERY matching thread — the one cleanup a
 *    multiplied pre-fix lineage (#9659's four R1-15 threads) gets.
 */
export function planThreadActions(
  threads: ReviewThread[],
  login: string,
  carried: Array<{ index: number; id: string }>,
  fixed: FixedFinding[],
): ThreadActionPlan {
  const me = login.trim().toLowerCase();
  const byId = new Map<string, ReviewThread[]>();
  for (const t of threads) {
    if (t.isResolved) continue;
    if (t.rootAuthor === null || t.rootAuthor.toLowerCase() !== me) continue;
    const finding = carriedFindingOf(t.rootBody);
    if (finding === null) continue;
    const list = byId.get(finding.id) ?? [];
    list.push(t);
    byId.set(finding.id, list);
  }
  for (const list of byId.values()) {
    list.sort((a, b) => a.rootCreatedAt.localeCompare(b.rootCreatedAt));
  }

  const plan: ThreadActionPlan = {
    replies: [],
    resolves: [],
    unmatchedFixed: [],
  };
  for (const c of carried) {
    const target = byId
      .get(c.id)
      ?.find((t) => !plan.replies.some((r) => r.commentId === t.rootCommentId));
    if (target !== undefined) {
      plan.replies.push({
        index: c.index,
        id: c.id,
        commentId: target.rootCommentId,
      });
    }
  }
  for (const f of fixed) {
    const targets = byId.get(f.id) ?? [];
    if (targets.length === 0) {
      plan.unmatchedFixed.push(f.id);
      continue;
    }
    for (const t of targets) {
      plan.resolves.push({
        id: f.id,
        ...(f.by === undefined ? {} : { by: f.by }),
        threadId: t.threadId,
        commentId: t.rootCommentId,
      });
    }
  }
  return plan;
}

/**
 * Reply into a thread. Non-idempotent (a retried post duplicates), so the
 * transport is `ghWithInput` — no transient retry, exactly the discipline
 * the Create Review call itself follows.
 */
export function postReviewReply(
  repo: string,
  pr: number,
  commentId: number,
  body: string,
): void {
  ghWithInput(
    JSON.stringify({ body }),
    'api',
    `repos/${repo}/pulls/${pr}/comments/${commentId}/replies`,
    '--input',
    '-',
  );
}

/** Resolve a thread. Idempotent — resolving a resolved thread is a no-op. */
export function resolveReviewThread(threadId: string): void {
  gh(
    'api',
    'graphql',
    '-f',
    'query=mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }',
    '-f',
    `threadId=${threadId}`,
  );
}
