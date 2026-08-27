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
// by the carried id that leads the posted claim line (the same readback
// the ledger builder performs — nothing new is persisted), and the
// round's thread bookkeeping lands in the same posting pass:
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
// Matching keys on the id because the id LEADS every thread this pass
// posts: `submit` stamps each freshly drafted finding with the id the
// ledger mints for it (`stampCarriedId` — the write side of the readback
// carriedFindingOf reads), exactly the claim-line shape Step 6 writes on
// carried re-reports. A thread's root is reachable from the round it is
// born. Roots posted before the stamp existed carry no id — the matcher
// cannot reach them, and they degrade to the pre-fix behaviour: a
// re-post opens a new thread, a fixed ruling reports nothing to resolve.
//
// GitHub only: the Aone write path fans findings out as plain MR comments
// and has no review-thread graph to reply into or resolve.

import { gh, ghWithInput } from './gh.js';
import { LEDGER_ID_READBACK, readClaim } from './ledger.js';
import {
  CRITICAL_PREFIX,
  LEADING_INVISIBLE_RE,
  SUGGESTION_PREFIX,
  severityOf,
  stripSeverityPrefix,
} from './inline-counts.js';
import {
  ENTRY_FENCE_DELIMITER_RE,
  ledgerClaimLine,
  type FixedFinding,
} from '../compose-review.js';

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
 * `gh` wraps its pretty-printed JSON in SGR colour when the operator's
 * environment forces colour (CLICOLOR_FORCE); the read parses the JSON,
 * not the terminal rendering — strip the wrappers or the parse dies on
 * the escape bytes (#9940 review).
 */
// eslint-disable-next-line no-control-regex -- ESC is the character under test
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

/**
 * The PR's review threads, oldest-visible-page order preserved. Throws on
 * a transport or shape failure — the read runs BEFORE the review's write,
 * so a failure costs a retryable aborted submit, never a half-planned
 * posting pass.
 */
export function fetchReviewThreads(repo: string, pr: number): ReviewThread[] {
  const [owner, name] = repo.split('/');
  const threads: ReviewThread[] = [];
  const seen = new Set<string>();
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
    const response = JSON.parse(gh(...args).replace(ANSI_SGR_RE, '')) as {
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
      // A stale/echoed cursor — the known cursor-pagination failure
      // class — re-fetches the same page to the cap, and a moving
      // cursor can still echo an earlier page's node; the plan's
      // resolve leg is NOT idempotent (one reply per thread), so
      // duplicates would multiply a ruling's reply and resolve per
      // copy. Uniqueness holds here, at the read (#9940 review).
      if (seen.has(node.id)) continue;
      seen.add(node.id);
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
 *
 * The marked leg reads through `ledgerClaimLine` — the SAME projection
 * the ledger builder applies, forged footer spans and comment-marker
 * lines stripped — so the contradiction gate, the thread matcher and the
 * ledger builder can never disagree about which id a draft carries: a
 * forged span between the marker and the id used to hide the id from
 * this readback while the ledger still carried it (#9940 review).
 *
 * The bare leg MIRRORS presubmit's marker-less readback — leading
 * render-nothing residue stripped, CRLF-tolerant split — because both
 * ends read the SAME posted shape: an HTML comment that sat between the
 * severity marker and the id in the draft survives the prefix strip at
 * post time and leads the posted first line, and two readback ends that
 * disagree about one comment are the drift class the shared readback
 * exists to prevent.
 */
export function carriedFindingOf(body: unknown): {
  id: string;
  fixInduced: boolean;
} | null {
  if (typeof body !== 'string') return null;
  const marked = ledgerClaimLine(body);
  const line = (
    marked !== ''
      ? marked
      : body
          .trimStart()
          .replace(LEADING_INVISIBLE_RE, '')
          .split(/\r\n?|\n/)[0]
  ).trim();
  if (!LEDGER_ID_READBACK.test(line)) return null;
  const { id, fixInduced } = readClaim(line);
  return id === undefined ? null : { id, fixInduced };
}

/**
 * The write side of the readback above: stamp a freshly drafted finding
 * with the id the ledger mints for it, so the posted thread root LEADS
 * with its id from birth — the same claim-line shape Step 6 writes on
 * carried re-reports, and the position `carriedFindingOf` reads. Without
 * the stamp a fresh finding's root is id-less, and no later carry or
 * `fixed` ruling can ever reach the thread (#9940 review).
 *
 * The post-marker region is NORMALIZED before the insertion — the whole
 * marker run, residue and separators collapse through the same
 * `stripSeverityPrefix` the attribution-off post applies — so the stamp
 * lands in the canonical `MARKER id: claim` shape whatever admitted draft
 * shape arrived: an id spliced between stacked markers breaks the
 * contiguous run the strip iterates, and one spliced before a glued
 * separator or comment lands in `id::` / `id:x` that the readback grammar
 * refuses (#9940 review). A body that already leads with a carried id
 * keeps it —
 * the model's carry stays verbatim, and a re-minted stray id keeps
 * whatever claim line it arrived with (the ledger records the re-mint;
 * the root and the marker disagree exactly as they did before stamps).
 * Returns the body unchanged when there is nothing to stamp into (no
 * marker), nothing to stamp (an id already leads), or the stamp would
 * break what the gate validated — a body whose fence opens on the
 * marker's projected first line (#9940 review).
 */
export function stampCarriedId(body: string, id: string): string {
  if (carriedFindingOf(body) !== null) return body;
  const sev = severityOf({ body });
  if (sev === null) return body;
  const marker = sev === 'critical' ? CRITICAL_PREFIX : SUGGESTION_PREFIX;
  const lead = LEADING_INVISIBLE_RE.exec(body)?.[0] ?? '';
  const visible = body.slice(lead.length);
  if (!visible.startsWith(marker)) return body;
  const rest = stripSeverityPrefix(visible);
  // The insertion lands between the marker and the body; when a code
  // fence OPENS on the marker's projected first line, text before the
  // backticks stops the posted first line leading the fence — flipping
  // the fence structure the gate validated on the pre-stamp shape
  // (under attribution off the unclosed flip swallows the appended
  // invisible marker as visible code). The test reads through leading
  // render-nothing residue — the pipeline admits it between marker and
  // content — but residue swallows newlines, and only residue on the
  // SAME rendered line may keep the skip: a bare newline outside
  // comments pushes the fence to a later line the line-1 insertion
  // cannot flip, and skipping there loses the root's id with no fence
  // to protect — every later carried re-report matches nothing, posts
  // inline, and opens a NEW thread (#9940 review). Newlines inside
  // comments stay render-invisible, so a comment-led same-line fence
  // keeps the skip. Left un-stamped, the draft degrades to the
  // pre-stamping behaviour: its thread root carries no id, so no later
  // carry or fixed ruling can reach it — the documented safe
  // degradation (#9940 review).
  const residue = LEADING_INVISIBLE_RE.exec(rest)?.[0] ?? '';
  const opensFence = ENTRY_FENCE_DELIMITER_RE.test(rest.slice(residue.length));
  if (
    opensFence &&
    !residue.replace(/<!--[\s\S]*?(?:-->|$)/g, '').includes('\n')
  ) {
    return body;
  }
  return `${lead}${marker} ${id}: ${rest}`;
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
 *  - a carried finding replies into the OLDEST matching thread that
 *    has no reply this round yet — one reply per thread per round, so
 *    an id with several live threads (a multiplied lineage) pairs
 *    further drafts with the REMAINING threads oldest-first, and a
 *    draft stays inline only once every live thread under the id took
 *    its reply. ONE exception: a `(fix-induced)` root is preferred
 *    over an unmarked
 *    one regardless of age, and among several marked threads the NEWEST
 *    leads — each fix-induced round opens its own marked thread, and the
 *    standing claim under the id is the LATEST re-report's. The flow
 *    reuses one id across two defects — the superseded original and the
 *    induced hole — and once a fix-induced re-report exists, a
 *    still-standing re-assertion belongs on the induced defect's own
 *    marked thread, not on the superseded original's older one (the
 *    readClaim contract: the new defect keeps its OWN thread);
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
  const byId = new Map<
    string,
    Array<{ thread: ReviewThread; marked: boolean }>
  >();
  for (const t of threads) {
    if (t.isResolved) continue;
    if (t.rootAuthor === null || t.rootAuthor.toLowerCase() !== me) continue;
    const finding = carriedFindingOf(t.rootBody);
    if (finding === null) continue;
    const list = byId.get(finding.id) ?? [];
    list.push({ thread: t, marked: finding.fixInduced });
    byId.set(finding.id, list);
  }
  for (const list of byId.values()) {
    list.sort(
      (a, b) =>
        Number(b.marked) - Number(a.marked) ||
        (a.marked
          ? b.thread.rootCreatedAt.localeCompare(a.thread.rootCreatedAt)
          : a.thread.rootCreatedAt.localeCompare(b.thread.rootCreatedAt)),
    );
  }

  const plan: ThreadActionPlan = {
    replies: [],
    resolves: [],
    unmatchedFixed: [],
  };
  for (const c of carried) {
    const target = byId
      .get(c.id)
      ?.find(
        ({ thread }) =>
          !plan.replies.some((r) => r.commentId === thread.rootCommentId),
      );
    if (target !== undefined) {
      plan.replies.push({
        index: c.index,
        id: c.id,
        commentId: target.thread.rootCommentId,
      });
    }
  }
  for (const f of fixed) {
    const targets = byId.get(f.id) ?? [];
    if (targets.length === 0) {
      plan.unmatchedFixed.push(f.id);
      continue;
    }
    for (const { thread } of targets) {
      plan.resolves.push({
        id: f.id,
        ...(f.by === undefined ? {} : { by: f.by }),
        threadId: thread.threadId,
        commentId: thread.rootCommentId,
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
