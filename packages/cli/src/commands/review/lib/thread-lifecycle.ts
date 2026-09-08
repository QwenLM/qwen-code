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
import { canonicalLedgerId, readClaim } from './ledger.js';
import {
  CRITICAL_PREFIX,
  FIX_INDUCED_TOKEN_RE,
  LEADING_INVISIBLE_RE,
  SUGGESTION_PREFIX,
  bareClaimLine,
  maskHtmlComments,
  readClaimHead,
  residueLineBreaks,
  severityOf,
  stripSeverityPrefix,
  separatorColonAt,
  markerLineOpensHtmlBlock,
} from './inline-counts.js';
import { ledgerClaimLine, type FixedFinding } from '../compose-review.js';
import { blockSkeleton, stripForUnattributedPost } from './review-footer.js';

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
    const raw = gh(...args)
      .replace(ANSI_SGR_RE, '')
      .trim();
    // An empty read is the transport failing quietly (a 204, a silenced
    // call): `JSON.parse('')` dies as a bare `SyntaxError: Unexpected end
    // of JSON input`, which tells the operator nothing about which read
    // aborted their post (#9940 review, round 30).
    if (raw === '') {
      throw new Error(
        `Review threads: the thread query returned nothing (page ${page + 1}). ` +
          `Nothing was posted — retry, or check \`gh auth status\`.`,
      );
    }
    const response = JSON.parse(raw) as {
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
  // The bare leg is the ONE shared read (`bareClaimLine`, presubmit uses
  // the same): an indented code block on the first line carries no
  // claim, so a code block that starts `R1-2:` is not a carry.
  const line = marked !== '' ? marked : bareClaimLine(body);
  if (line === null) return null;
  const { id, fixInduced } = readClaim(line);
  if (id === undefined) return null;
  if (fixInduced || marked === '') return { id, fixInduced };
  // The marked leg reads ONE line; the attribution-off exit rejoins a
  // footer span split across a soft break (`stripSplitFooterSpans`), and
  // a `(fix-induced)` token behind such a span reaches the head slot only
  // there. Both projections must agree, so the marking either reads
  // (#9940 review, audit 5).
  const bare = bareClaimLine(stripForUnattributedPost(body));
  const other = bare === null ? null : readClaim(bare);
  return {
    id,
    fixInduced: other?.id === id && other.fixInduced === true,
  };
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
/**
 * The fixed ruling's reply line, `R<id> fixed` or `R<id> fixed by <by>`.
 * The compose gate refuses a `by` carrying the pipeline's comment-marker
 * grammar on either projection and the cap degrades one it left; this is
 * the last step before the write, so the same rule holds here too — a
 * clause that would post the marker degrades to a by-less ruling rather
 * than letting presubmit read the fixed reply as a posted finding (#9940
 * review, audit 2).
 */
export function fixedRulingLine(id: string, by: string): string {
  const safe = /<!--\s*qwen-review\b/i.test(by) ? '' : by;
  return safe === '' ? `${id} fixed` : `${id} fixed by ${safe}`;
}

export function stampCarriedId(body: string, id: string): string {
  if (carriedFindingOf(body) !== null) return body;
  const sev = severityOf({ body });
  if (sev === null) return body;
  const marker = sev === 'critical' ? CRITICAL_PREFIX : SUGGESTION_PREFIX;
  const lead = LEADING_INVISIBLE_RE.exec(body)?.[0] ?? '';
  const visible = body.slice(lead.length);
  if (!visible.startsWith(marker)) return body;
  // Stripped from the WHOLE body: the residue before the marker tells the
  // strip whether the marker line is an HTML block (a comment opens it),
  // which decides whether the line after it can be a lazy continuation.
  // The result is a suffix of `visible` either way (#9940 review, audit 6).
  let rest = stripSeverityPrefix(body);
  // The separator the strip consumed after the LAST marker. When it
  // carried a line break outside comments, the content began on a later
  // rendered line pre-stamp — a blank line then an indented code block,
  // a blockquote under the marker's own line — and re-serializing the
  // canonical `MARKER id: claim` on one line flattened that block into
  // the claim under attribution on (the strip alone flattens it under
  // attribution off). The break run is re-attached, so the arm below
  // judges the construct where it actually sits; a same-line separator
  // stays normalized (#9940 review, audit).
  const consumed = visible.slice(0, visible.length - rest.length);
  // The last marker is found with comments masked — a marker string quoted
  // inside a comment in the separator is comment content, and slicing
  // from it took a comment's inner newline for a rendered break.
  const maskedConsumed = maskHtmlComments(consumed);
  const lastMarker = Math.max(
    maskedConsumed.lastIndexOf(CRITICAL_PREFIX),
    maskedConsumed.lastIndexOf(SUGGESTION_PREFIX),
  );
  // Two shapes the stamp can write, in preference order: the canonical
  // one-line `MARKER id: claim`, and — when the separator after the last
  // marker carried a line-break run outside comments — the shape that
  // keeps that run, so content that opened a block of its own on a later
  // rendered line (a blank line then a code block, a blockquote under the
  // marker's line) stays on its line. Only breaks AFTER the separator
  // colon are the content's structure: a break before it is machine
  // grammar around the colon, normalized away (re-attaching it posted a
  // visible `:` line); with no colon the whole run is.
  const candidates: string[] = [rest];
  if (lastMarker !== -1) {
    const separator = consumed.slice(
      lastMarker +
        (consumed.startsWith(CRITICAL_PREFIX, lastMarker)
          ? CRITICAL_PREFIX.length
          : SUGGESTION_PREFIX.length),
    );
    const colonAt = separatorColonAt(separator, markerLineOpensHtmlBlock(lead));
    const afterColon =
      colonAt === -1 ? separator : separator.slice(colonAt + 1);
    const sepBreaks = residueLineBreaks(afterColon);
    if (sepBreaks.length > 0) {
      candidates.push(afterColon.slice(sepBreaks[0]!.index) + rest);
    }
  }
  // The CommonMark parser arbitrates — the ONE oracle, in place of the
  // hand-listed constructs five review rounds kept finding holes in
  // (fences, HTML blocks of seven kinds, setext underlines, list items
  // that can or cannot interrupt, link reference definitions, tables
  // with or without a leading `|`, lazy continuations …): a candidate is
  // written only if the body's top-level block skeleton is the same
  // before and after the insertion on BOTH projections — as drafted
  // (attribution on) and as the attribution-off post strips it. "The
  // same" is `keepsStructure`: every block after the first identical in
  // kind and text, the first block identical once the inserted `id: ` and
  // the normalized separator are discounted; the attribution-off
  // projection may gain the id's own paragraph IN FRONT of an otherwise
  // identical body (content that opens with a block no id can join, a
  // code block). No candidate keeps the structure: the documented
  // id-less degradation (#9940 review, round 28).
  const skeletonOn = renderedBlocks(body);
  const skeletonOff = renderedBlocks(stripForUnattributedPost(body));
  let stamped: string | undefined;
  for (const shape of candidates) {
    const candidate = `${lead}${marker} ${id}: ${shape}`;
    if (
      keepsStructure(skeletonOn, renderedBlocks(candidate), id) &&
      keepsStructure(
        skeletonOff,
        renderedBlocks(stripForUnattributedPost(candidate)),
        id,
      )
    ) {
      rest = shape;
      stamped = candidate;
      break;
    }
  }
  if (stamped === undefined) return body;
  // A FRESH claim that happens to carry the `(fix-induced)` prose token in
  // its head slot: read on the draft it is prose (no id for a marking to
  // hang on — the head-slot contract), but spliced behind the minted id
  // it becomes a genuine marking the readback honours from then on, and a
  // later still-standing carry would reply into this mislabelled root
  // ahead of the true original (marked threads lead the pairing). The
  // readback is the arbiter: when it reads the stamped body as marked,
  // every token inside the head slot — the part of the claim line before
  // the title the tokeniser hands back — is removed in one pass (#9940
  // review, round 26 and audit). Genuine carries never reach here — they
  // returned verbatim above.
  // Both projections arbitrate: the attribution-off exit strips a footer
  // span split across a soft line break (`stripSplitFooterSpans`) that the
  // single-line marked read leaves standing, so a token behind such a span
  // read as prose here and as a marking on the posted bare body (#9940
  // review, audit).
  const readsMarked = (candidate: string): boolean =>
    carriedFindingOf(candidate)?.fixInduced === true ||
    carriedFindingOf(stripForUnattributedPost(candidate))?.fixInduced === true;
  if (!readsMarked(stamped)) return stamped;
  const nl = rest.search(/\r\n?|\n/);
  const line1 = nl === -1 ? rest : rest.slice(0, nl);
  const trimmed = line1.trimEnd();
  const head = readClaimHead(`${id}: ${trimmed}`);
  const slot = trimmed.slice(0, trimmed.length - head.title.length);
  let unmarked =
    slot.replace(new RegExp(FIX_INDUCED_TOKEN_RE.source, 'gi'), '') +
    head.title +
    line1.slice(trimmed.length);
  let out = `${lead}${marker} ${id}: ${unmarked}${rest.slice(line1.length)}`;
  // The readback projects the claim line through `ledgerClaimLine` —
  // forged footer spans and comment-marker lines stripped — so a token
  // the slot read above did not reach (a span stood before it) can still
  // read as a marking. The readback stays the arbiter: while it reads a
  // marking, the first token on the line goes; a line that yields nothing
  // more takes the id-less degradation rather than posting a mislabelled
  // root (#9940 review, audit).
  // Every token on the line goes per pass (a pass per token re-ran the
  // O(n) readback per token — two thousand tokens took two seconds); a
  // line that yields nothing more takes the id-less degradation.
  while (readsMarked(out)) {
    const next = unmarked.replace(
      new RegExp(FIX_INDUCED_TOKEN_RE.source, 'gi'),
      '',
    );
    if (next === unmarked) return body;
    unmarked = next;
    out = `${lead}${marker} ${id}: ${unmarked}${rest.slice(line1.length)}`;
  }
  return out;
}

/** A top-level block the parser read, with its source text. */
type RenderedBlock = { kind: string; text: string };

/**
 * The body's top-level blocks as GitHub renders them — the parser's
 * skeleton minus the HTML blocks that render NOTHING (a comment line, a
 * processing instruction, a declaration): those the attribution-off strip
 * removes as residue, and their absence changes no rendered structure.
 * Two GFM-table readings where markdown-it and cmark-gfm (GitHub's engine)
 * part are re-read the cmark way, measured against cmark-gfm on generated
 * bodies (#9940 review, audit 7): a paragraph whose line is a delimiter
 * row matching the line above it is that line's table (cmark needs no `|`
 * in the header row); a table whose header line opens with `<!--` is an
 * HTML block over a paragraph (cmark opens the block first).
 */
function renderedBlocks(body: string): RenderedBlock[] {
  return blockSkeleton(body)
    .flatMap((b) => {
      if (b.kind === 'table_open' && /^ {0,3}<!--/.test(b.text)) {
        const nl = b.text.search(/\r\n?|\n/);
        const rest = nl === -1 ? '' : b.text.slice(nl + 1);
        return [
          {
            kind: 'html_block',
            text: nl === -1 ? b.text : b.text.slice(0, nl),
          },
          ...(rest.trim() === ''
            ? []
            : splitTable({ kind: 'paragraph_open', text: rest })),
        ];
      }
      return b.kind === 'paragraph_open' ? splitTable(b) : [b];
    })
    .filter(
      (b) =>
        b.kind !== 'html_block' ||
        maskHtmlComments(b.text)
          .replace(
            /<\?[\s\S]*?\?>|<![A-Za-z][\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>/g,
            '',
          )
          .trim() !== '',
    );
}

/** A GFM delimiter row: `|`-separated cells of `-` runs, optional `:` ends. */
const TABLE_DELIMITER_ROW_RE =
  /^ {0,3}(?:\|[ \t]*)?:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*(?:\|[ \t]*)?\r?$/;

/** The cell count of a table row, leading and trailing `|` discounted. */
function tableCells(row: string): number {
  const inner = row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|[ \t]*$/, '');
  return inner.split(/(?<!\\)\|/).length;
}

/**
 * The cmark-gfm reading of a paragraph: a line followed by a delimiter row
 * of the same cell count opens a table there — the lines before stay a
 * paragraph. A bare `---` never reaches here: markdown-it reads it as the
 * setext underline it also is on GitHub, and the block is a heading.
 */
function splitTable(block: RenderedBlock): RenderedBlock[] {
  const lines = block.text.split(/\r\n?|\n/);
  for (let i = 1; i < lines.length; i++) {
    const header = lines[i - 1]!;
    const delimiter = lines[i]!;
    if (
      TABLE_DELIMITER_ROW_RE.test(delimiter) &&
      tableCells(header) === tableCells(delimiter)
    ) {
      const before = lines.slice(0, i - 1).join('\n');
      return [
        ...(before.trim() === ''
          ? []
          : [{ kind: 'paragraph_open', text: before }]),
        { kind: 'table_open', text: lines.slice(i - 1).join('\n') },
      ];
    }
  }
  return [block];
}

/**
 * Rendered-equivalent text of the marker's block: soft breaks and runs of
 * whitespace are one space. Comments and format characters need no rule
 * of their own — the residue the marker strip discards carries them, and
 * the stamp touches no other text.
 */
function normalizedText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The stamp's acceptance test — see `stampCarriedId`. `insert` is the id
 * the candidate carries. The first block is compared through the marker
 * strip: the canonical shape normalizes the separator away and folds a
 * stacked marker run, and both are the stamp's own doing, not a change
 * to what the content renders as.
 */
function keepsStructure(
  before: RenderedBlock[],
  after: RenderedBlock[],
  insert: string,
): boolean {
  // Blocks after the first compare by KIND: the stamp writes into the
  // first block only, and a later block can change kind only through the
  // first block's extent changing, which the text comparison on the first
  // block already refuses — its text is the belt, this the braces.
  const sameTail = (a: RenderedBlock[], b: RenderedBlock[]): boolean =>
    a.length === b.length && a.every((x, i) => x.kind === b[i]!.kind);
  const content = (text: string): string =>
    normalizedText(stripSeverityPrefix(text));
  if (before.length === 0) return false;
  if (after.length === before.length) {
    const [b0, a0] = [before[0]!, after[0]!];
    return (
      a0.kind === b0.kind &&
      content(a0.text).replace(`${insert}:`, '').trim() === content(b0.text) &&
      sameTail(after.slice(1), before.slice(1))
    );
  }
  return (
    after.length === before.length + 1 &&
    after[0]!.kind === 'paragraph_open' &&
    normalizedText(after[0]!.text) === `${insert}:` &&
    sameTail(after.slice(1), before)
  );
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
  /**
   * Fixed ids this plan does not act on: no live own thread carries them
   * (already resolved, or gone), or every thread that does is taking a
   * still-standing carry reply from this same pass.
   */
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
  // An unknown account matches nothing. Empty is what `currentUser()`
  // returns when the token cannot name itself, and `''` compared against
  // a root author of `''` matched every such thread — the guard every
  // other member of the own-account family already carries (presubmit's
  // reply leg, `ownSignalReplies`, `isSelfReview`) (#9940 review, round
  // 30).
  // …but a ruling that could not be acted on is still disclosed: submit
  // prints one operator line per `unmatchedFixed` entry, and silence here
  // read as "there was nothing to resolve" (#9940 review, round 30
  // reverse audit).
  if (me === '') {
    return {
      replies: [],
      resolves: [],
      unmatchedFixed: fixed.map((f) => f.id),
    };
  }
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
  // Both joins go through the canonical spelling: the roots are keyed by
  // the readback (canonical), and a caller's id is joined the same way
  // rather than trusted to be — `R01-2` names R1-2's thread (#9940
  // review, round 27).
  for (const c of carried) {
    const target = byId
      .get(canonicalLedgerId(c.id))
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
  // One ruling per thread, whatever the caller passed. `postReviewReply`
  // is non-idempotent, so a second entry under the same id — two `fixed`
  // rulings spelling one id, or one thread already answered — posts the
  // note twice. Submit's ingestion dedups by id and its contradiction
  // gate refuses a ruling on a carried id, so neither is reachable
  // through it today; this function is exported and unit-tested as pure,
  // and a second caller would hit both (#9940 review, round 30).
  const ruled = new Set<string>();
  for (const f of fixed) {
    const targets = byId.get(canonicalLedgerId(f.id)) ?? [];
    let acted = false;
    for (const { thread } of targets) {
      if (ruled.has(thread.threadId)) {
        acted = true;
        continue;
      }
      // A thread this pass is replying a still-standing carry into is not
      // a thread this pass may close.
      if (plan.replies.some((r) => r.commentId === thread.rootCommentId)) {
        continue;
      }
      ruled.add(thread.threadId);
      acted = true;
      plan.resolves.push({
        id: f.id,
        ...(f.by === undefined ? {} : { by: f.by }),
        threadId: thread.threadId,
        commentId: thread.rootCommentId,
      });
    }
    // No thread at all, or every one of them excluded: either way the
    // ruling went nowhere, and the operator is told rather than left to
    // infer it from a silent pass.
    if (!acted) plan.unmatchedFixed.push(f.id);
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
