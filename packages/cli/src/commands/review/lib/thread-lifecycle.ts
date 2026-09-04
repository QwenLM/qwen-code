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
import { readClaim } from './ledger.js';
import {
  CRITICAL_PREFIX,
  FIX_INDUCED_TOKEN_RE,
  LEADING_INVISIBLE_RE,
  SUGGESTION_PREFIX,
  severityOf,
  stripSeverityPrefix,
} from './inline-counts.js';
import { ledgerClaimLine, type FixedFinding } from '../compose-review.js';
import {
  HTML_BLOCK_OPEN_RE,
  QUOTE_PREFIX_RE,
  fenceOpener,
} from './review-footer.js';

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
 * The carried id a comment body's claim line carries, when it carries
 * one — the SAME read the ledger builder performs, with one extra leg:
 * an attribution-off post carries no severity marker, so the bare first
 * line is tried too. The id is read through `readClaim`'s head-slot
 * tokeniser — wherever the model placed it in the slot, axis and source
 * tags ahead of it included (#10291) — because the builder carries that
 * shape, and the matcher, the stamp and the contradiction gate must see
 * the same id: an anchored pre-gate here refused a tag-led carry while
 * the ledger still carried it, and the re-post opened a NEW thread the
 * fixed ruling never reached (#9940 review, round 12).
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
 * break what the gate validated — a body whose code fence, HTML block,
 * blockquote, heading, list item, thematic break or raw-HTML opener
 * opens on the marker's projected first line, or whose indented code /
 * non-`1.` ordered list sits directly under the marker (#9940 review).
 */
export function stampCarriedId(body: string, id: string): string {
  if (carriedFindingOf(body) !== null) return body;
  const sev = severityOf({ body });
  if (sev === null) return body;
  const marker = sev === 'critical' ? CRITICAL_PREFIX : SUGGESTION_PREFIX;
  const lead = LEADING_INVISIBLE_RE.exec(body)?.[0] ?? '';
  const visible = body.slice(lead.length);
  if (!visible.startsWith(marker)) return body;
  let rest = stripSeverityPrefix(visible);
  // The insertion lands between the marker and the body; when a code
  // fence or an HTML-block opener (`<div>`, `</div>`, `<pre>`, …)
  // OPENS on the marker's projected first line, text before it stops
  // the posted first line leading the construct — flipping the fence /
  // block structure the gate validated on the pre-stamp shape (under
  // attribution off the unclosed flip swallows the appended invisible
  // marker as visible code). The test reads through leading
  // render-nothing residue — the pipeline admits it between marker and
  // content — and through the blockquote prefix the line model reads
  // past (`QUOTE_PREFIX_RE`, the same regex `scanLines` applies):
  // pr-context quotes every earlier comment containing code as
  // `> ``` …`, and an insertion before a quoted opener stops the
  // posted first line LEADING the `>` — CommonMark parses neither
  // blockquote nor the fence/block it wraps, the same flip the bare
  // arm prevents (#9940 review, round 12). Residue swallows newlines,
  // and only residue on the
  // SAME rendered line may keep the skip: a bare newline outside
  // comments pushes the construct to a later line the line-1 insertion
  // cannot flip, and skipping there loses the root's id with nothing
  // to protect — every later carried re-report matches nothing, posts
  // inline, and opens a NEW thread (#9940 review). Newlines inside
  // comments stay render-invisible, so a comment-led same-line opener
  // keeps the skip. The residue readback models a line break exactly
  // the way the pipeline's line model does (`scanLines`, the bare leg
  // of carriedFindingOf, presubmit's marker-less readback): a bare
  // `\r` is a break too, and testing `\n` alone held the skip over a
  // CR-separated fence (#9940 review). Left un-stamped, the draft
  // degrades to the pre-stamping behaviour: its thread root carries
  // no id, so no later carry or fixed ruling can reach it — the
  // documented safe degradation (#9940 review).
  const residue = LEADING_INVISIBLE_RE.exec(rest)?.[0] ?? '';
  const fromResidue = rest.slice(residue.length);
  const firstLine = fromResidue.split(/\r\n?|\n/)[0];
  // Same-line residue is stripped again AFTER the unquote: a quoted
  // opener led by an HTML comment (`> <!-- x -->` + fence) renders the
  // comment as nothing, so the fence still opens the quoted line — and
  // the `^`-anchored opener tests missed it (#9940 review, round 17).
  // Confined to the already-split single line, the strip cannot cross a
  // rendered line; on an unquoted line it is a no-op — the leading
  // residue run above already consumed the maximal residue.
  const unquoted = firstLine
    .replace(QUOTE_PREFIX_RE, '')
    .replace(LEADING_INVISIBLE_RE, '');
  // Through the line model's OWN opener rule (`fenceOpener`, the one
  // `scanLines` applies), not a delimiter-only test: a backtick run whose
  // info string carries a backtick opens no fence — the line is prose the
  // stamp cannot break, and skipping it posted an id-less root behind a
  // disclosure naming a fence that never existed (#9940 review, round
  // 25).
  const opensFence = fenceOpener(unquoted) !== null;
  const opensHtmlBlock = HTML_BLOCK_OPEN_RE.test(unquoted.trimStart());
  // Every OTHER line-leading construct the insertion demotes the same
  // way: text before a `>` parses no blockquote at all (whatever the
  // quote wraps — the unquote above serves the fence/HTML tests, the
  // quote itself is the construct here), and an ATX heading, a list
  // item, a thematic break or a type-3/4/5 raw-HTML opener (`<?…`,
  // `<!DOCTYPE`, `<![CDATA[`) each turn into paragraph text under the
  // attribution-off post, silently, in a structure the gate never
  // validated (#9940 review, round 26). Stamp-local on purpose:
  // `HTML_BLOCK_OPEN_RE` stays the line model's (blank-line-terminated
  // types 1/6), and a fresh draft leading with such a construct takes
  // the documented id-less degradation instead of a flipped post.
  const opensBlockquote = QUOTE_PREFIX_RE.test(firstLine);
  const opensOtherLeader = OTHER_LEADER_RE.test(unquoted);
  // A line break in the residue OUTSIDE comments pushes the construct to
  // a later rendered line, which a line-1 insertion cannot flip — with
  // one exception: a construct that CANNOT interrupt a paragraph
  // (indented code, an ordered list not starting at 1) directly under
  // the marker was a block of its own behind the empty attribution-off
  // first line, and becomes continuation text of the `R<n>-<k>:`
  // paragraph the stamp writes above it (#9940 review, round 26). A
  // blank line in between ends that paragraph first, so the block
  // survives and the stamp applies.
  const commentSpans = [...residue.matchAll(/<!--[\s\S]*?(?:-->|$)/g)].map(
    (m) => [m.index, m.index + m[0].length] as const,
  );
  const breaks = [...residue.matchAll(/\r\n?|\n/g)].filter(
    (m) => !commentSpans.some(([a, b]) => m.index >= a && m.index < b),
  );
  if (breaks.length === 0) {
    if (opensFence || opensHtmlBlock || opensBlockquote || opensOtherLeader) {
      return body;
    }
  } else {
    let blankBetween = false;
    for (let i = 1; i < breaks.length; i++) {
      const prev = breaks[i - 1]!;
      const between = residue.slice(
        prev.index + prev[0].length,
        breaks[i]!.index,
      );
      if (/^[ \t]*$/.test(between)) {
        blankBetween = true;
        break;
      }
    }
    const last = breaks[breaks.length - 1]!;
    const constructLine = rest
      .slice(last.index + last[0].length)
      .split(/\r\n?|\n/)[0];
    const cannotInterrupt =
      /^(?: {4,}|\t)/.test(constructLine) ||
      (/^ {0,3}\d{1,9}[.)](?:[ \t]|$)/.test(constructLine) &&
        !/^ {0,3}1[.)]/.test(constructLine));
    if (cannotInterrupt && !blankBetween) return body;
  }
  let stamped = `${lead}${marker} ${id}: ${rest}`;
  // A FRESH claim that happens to start with the `(fix-induced)` prose
  // token: read on the draft it is prose (no id for a marking to hang
  // on — the head-slot contract), but spliced behind the minted id it
  // becomes a genuine marking the readback honours from then on, and a
  // later still-standing carry would reply into this mislabelled root
  // ahead of the true original (marked threads lead the pairing). The
  // readback is the arbiter: while it reads the stamped body as marked,
  // the head-slot token is removed — the FIRST occurrence on the claim
  // line, which is the one the tokeniser reached (tags cannot contain
  // it; residue ahead of it would have stopped the read). Genuine
  // carries never reach here — they returned verbatim above (#9940
  // review, round 26).
  for (;;) {
    if (carriedFindingOf(stamped)?.fixInduced !== true) return stamped;
    const nl = rest.search(/\r\n?|\n/);
    const line1 = nl === -1 ? rest : rest.slice(0, nl);
    const unmarked = line1.replace(FIX_INDUCED_TOKEN_RE, '');
    if (unmarked === line1) return stamped;
    rest = unmarked + rest.slice(line1.length);
    stamped = `${lead}${marker} ${id}: ${rest}`;
  }
}

/**
 * The line-leading CommonMark constructs beyond fences and type-1/6 HTML
 * blocks that text inserted before them demotes to paragraph text: an ATX
 * heading, a bullet or ordered list item, a thematic break, and the
 * type-3/4/5 raw-HTML openers. Stamp-local — see `stampCarriedId`.
 */
const OTHER_LEADER_RE =
  /^(?:#{1,6}(?:[ \t]|$)|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)|(?:-[ \t]*){3,}$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$|<\?|<!\[CDATA\[|<![A-Za-z])/i;

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
