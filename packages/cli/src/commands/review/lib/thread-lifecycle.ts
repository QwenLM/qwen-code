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
  blockBoundaryIn,
  separatorColonAt,
  indentColumns,
} from './inline-counts.js';
import { ledgerClaimLine, type FixedFinding } from '../compose-review.js';
import {
  HTML_BLOCK_OPEN_RE,
  HTML_BLOCK_TAG_NAMES,
  QUOTE_PREFIX_RE,
  fenceOpener,
  stripForUnattributedPost,
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
  if (lastMarker !== -1) {
    const separator = consumed.slice(
      lastMarker +
        (consumed.startsWith(CRITICAL_PREFIX, lastMarker)
          ? CRITICAL_PREFIX.length
          : SUGGESTION_PREFIX.length),
    );
    // Only breaks AFTER the separator colon are the content's own line
    // structure (a break before it is machine grammar around the colon,
    // normalized away — re-attaching it posted a visible `:` line); with
    // no colon the whole run is. And only when that structure matters: a
    // block boundary in the run, a first content line that opens a
    // construct, or a marker line that is itself an HTML block (a comment
    // opens it — folding the content onto that line put the claim inside
    // raw HTML) — plain prose under a single break keeps the canonical
    // one-line shape (#9940 review, audit).
    const colonAt = separatorColonAt(separator);
    const afterColon =
      colonAt === -1 ? separator : separator.slice(colonAt + 1);
    const sepBreaks = residueLineBreaks(afterColon);
    if (sepBreaks.length > 0) {
      const candidate = afterColon.slice(sepBreaks[0]!.index) + rest;
      const last = sepBreaks[sepBreaks.length - 1]!;
      const contentLines = (
        afterColon.slice(last.index + last.length) + rest
      ).split(/\r\n?|\n/);
      const leadBreaks = residueLineBreaks(lead);
      const leadLast = leadBreaks[leadBreaks.length - 1];
      const markerLine = lead.slice(
        leadLast === undefined ? 0 : leadLast.index + leadLast.length,
      );
      // A block boundary in the run (not merely two breaks: a comment
      // line four columns in is code, no boundary), or a first content
      // line that opens a construct. Indentation alone is neither — under
      // one break it is a lazy continuation, and re-attaching it refused
      // a stamp that changes nothing (#9940 review, audit 4).
      const htmlMarkerLine = /^ {0,3}<!--/.test(markerLine);
      if (
        blockBoundaryIn(afterColon) ||
        lineOpensConstruct(contentLines[0]!, contentLines[1] ?? '') ||
        htmlMarkerLine
      ) {
        // A four-column content line under an HTML-block marker line, with
        // no boundary between: kept on its own line it is a code block on
        // this projection and a lazy continuation of the id paragraph on
        // the attribution-off one (the comment line is gone there) — no
        // shape serves both, so the id-less degradation applies (#9940
        // review, audit 6).
        if (
          htmlMarkerLine &&
          !blockBoundaryIn(afterColon) &&
          indentColumns(contentLines[0]!) >= 4
        ) {
          return body;
        }
        rest = candidate;
      }
    }
  }
  const residue = LEADING_INVISIBLE_RE.exec(rest)?.[0] ?? '';
  const fromResidue = rest.slice(residue.length);
  const [firstLine, secondLine = ''] = fromResidue.split(/\r\n?|\n/);
  // Same-line residue is stripped again AFTER the unquote: a quoted
  // opener led by an HTML comment (`> <!-- x -->` + fence) renders the
  // comment as nothing, so the fence still opens the quoted line — and
  // the `^`-anchored opener tests missed it (#9940 review, round 17).
  // Confined to the already-split single line, the strip cannot cross a
  // rendered line; on an unquoted line it is a no-op — the leading
  // residue run above already consumed the maximal residue.
  const unquoted = firstLine!
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
  const breaks = residueLineBreaks(residue);
  // Every OTHER line-leading construct the insertion demotes the same
  // way: text before a `>` parses no blockquote at all (whatever the
  // quote wraps — the unquote above serves the fence/HTML tests, the
  // quote itself is the construct here), and an ATX heading, a list
  // item, a thematic break, a link reference definition, a type-3/4/5
  // raw-HTML opener (`<?…`, `<!DOCTYPE`, `<![CDATA[`) or a GFM table
  // (a `|`-led row over a delimiter row) each turn into paragraph text
  // under the attribution-off post, silently, in a structure the gate
  // never validated (#9940 review, round 26). These are constructs ONLY
  // at the start of the rendered line: after spaces or tabs, never after
  // a format character, a no-break space or an HTML comment — CommonMark
  // reads a `# Heading` behind a zero-width space as text, and a skip
  // there lost the id for nothing (#9940 review, audit). Stamp-local on
  // purpose: `HTML_BLOCK_OPEN_RE` stays the line model's (blank-line-
  // terminated types 1/6), and a fresh draft leading with such a
  // construct takes the documented id-less degradation instead of a
  // flipped post.
  const lastBreak = breaks[breaks.length - 1];
  const sameLineResidue =
    lastBreak === undefined
      ? residue
      : residue.slice(lastBreak.index + lastBreak.length);
  const atLineStart = /^[ \t]*$/.test(sameLineResidue);
  const opensBlockquote = atLineStart && QUOTE_PREFIX_RE.test(firstLine!);
  const opensOtherLeader =
    atLineStart &&
    (OTHER_LEADER_RE.test(unquoted) ||
      LINK_REF_DEF_RE.test(unquoted) ||
      opensTable(unquoted, secondLine));
  // A line break in the residue OUTSIDE comments pushes the construct to
  // a later rendered line, which a line-1 insertion cannot flip — with
  // one exception: a construct that CANNOT interrupt a paragraph directly
  // under the marker was a block of its own behind the empty
  // attribution-off first line, and becomes continuation text of the
  // `R<n>-<k>:` paragraph the stamp writes above it — or, worse, turns
  // that paragraph into a heading: indented code, an ordered list not
  // starting at 1, an EMPTY list item, a link reference definition, a
  // type-7 HTML block (a lone tag), and a setext underline (`---`, `===`,
  // even a lone `-`), which CommonMark reads as the underline of the
  // paragraph above it before it reads a thematic break or a list
  // (#9940 review, round 26 and audit). A blank line — or an HTML
  // comment line, itself a block — in between ends that paragraph first,
  // so the construct survives and the stamp applies.
  if (breaks.length === 0) {
    if (opensFence || opensHtmlBlock || opensBlockquote || opensOtherLeader) {
      return body;
    }
  } else {
    // Indentation is not among the refusals: under a break with no boundary
    // the indented line is a lazy continuation the stamp leaves as it
    // found; behind a boundary it is a code block the re-attached break
    // run keeps (#9940 review, audit 5).
    const boundaryBetween = blockBoundaryIn(residue);
    const constructLine = rest
      .slice(lastBreak!.index + lastBreak!.length)
      .split(/\r\n?|\n/)[0]!;
    if (cannotInterruptUnindented(constructLine) && !boundaryBetween) {
      return body;
    }
  }
  const stamped = `${lead}${marker} ${id}: ${rest}`;
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

/**
 * Whether a line, standing directly under the `R<n>-<k>:` paragraph the
 * stamp writes, cannot interrupt that paragraph — so it would be absorbed
 * as continuation text, or (a setext underline) turn the paragraph into a
 * heading. Indented code (four columns), an ordered list not starting at
 * one, an EMPTY list item, a setext underline, a link reference
 * definition, a type-7 HTML block (a lone tag that is not a type-1/6
 * block-level one — those DO interrupt).
 */
function cannotInterruptUnindented(line: string): boolean {
  return (
    (/^ {0,3}\d{1,9}[.)](?:[ \t]|$)/.test(line) &&
      !/^ {0,3}0*1[.)]/.test(line)) ||
    /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]*\r?$/.test(line) ||
    /^ {0,3}(?:-+|=+)[ \t]*\r?$/.test(line) ||
    LINK_REF_DEF_RE.test(line) ||
    LONE_TAG_RE.test(line)
  );
}

/**
 * Whether a content line opens a block construct of its own — the line
 * structure the swallowed-separator re-attach exists to preserve.
 */
function lineOpensConstruct(line: string, next: string): boolean {
  const led = line.replace(/^ {0,3}/, '');
  return (
    fenceOpener(line) !== null ||
    HTML_BLOCK_OPEN_RE.test(led) ||
    QUOTE_PREFIX_RE.test(line) ||
    OTHER_LEADER_RE.test(led) ||
    // A type-2 HTML block (a comment) opens on its line and CAN interrupt
    // a paragraph — folded onto the marker line the comment became inline
    // and the text after it prose (#9940 review, audit 6).
    /^ {0,3}<!--/.test(line) ||
    cannotInterruptUnindented(line) ||
    // A table header needs no leading `|` here — `a | b` over `---|---` is
    // a table, and folded onto the marker line it became the header cell
    // (#9940 review, audit). On the marker's OWN line a pipe-less header
    // is stamped (`opensTable`): the id joins the first cell and the table
    // stands, while a `|`-led one would gain a cell and lose the table.
    tableHeaderOver(line, next)
  );
}

/**
 * A GFM table the stamp would break: a `|`-LED header row over a delimiter
 * row with the SAME number of cells — GFM requires the counts to match, or
 * the rows are text — where `R<id>: ` in front adds a cell.
 */
function opensTable(header: string, delimiter: string): boolean {
  return /^\|/.test(header) && tableHeaderOver(header, delimiter);
}

/** A GFM table header (leading `|` or not) over its delimiter row. */
function tableHeaderOver(header: string, delimiter: string): boolean {
  // One of the two rows must hold a `|` — `the claim` over `|---|` is a
  // one-column table on GitHub (#9940 review, audit 5).
  if (
    !TABLE_DELIMITER_ROW_RE.test(delimiter) ||
    (!/\|/.test(header) && !/\|/.test(delimiter))
  ) {
    return false;
  }
  return tableCells(header) === tableCells(delimiter);
}

function tableCells(row: string): number {
  const inner = row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|[ \t]*$/, '');
  return inner.split(/(?<!\\)\|/).length;
}

/**
 * A link reference definition: `[label]:` then ONE destination (angle-
 * bracketed or a run of non-space) and optionally a quoted or
 * parenthesised title — nothing else on the line. `[probe]: the guard
 * drops a valid case` is prose, not a definition (#9940 review, audit).
 */
const LINK_REF_DEF_RE =
  // The label may hold an escaped `]`; the destination may sit on the NEXT
  // line, so a `[label]:` with nothing after it is a definition too.
  /^ {0,3}\[(?:[^\]\\\n]|\\.)+\]:[ \t]*(?:(?:<[^<>\n]*>|\S+)[ \t]*(?:["'(][^\n]*)?)?\r?$/;

/**
 * A GFM table's delimiter row — what makes the `|`-led line above it a
 * header row rather than text.
 */
const TABLE_DELIMITER_ROW_RE =
  /^[ \t]*(?:\|[ \t]*)?:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*(?:\|[ \t]*)?\r?$/;

/**
 * A complete HTML tag alone on its line — the CommonMark type-7 HTML block
 * opener, which cannot interrupt a paragraph.
 */
const LONE_TAG_RE = new RegExp(
  // Not a type-1/6 tag (those interrupt a paragraph) — the exclusion ends
  // where the tag NAME ends (`<div-x>` is a type-7 tag, not `<div`), and
  // the attributes may quote `<` or `>`. One whitespace then the rest, the
  // quoted runs disjoint from the bare class, so nothing re-splits a run
  // of spaces (#9940 review, audit).
  `^ {0,3}</?(?!(?:${HTML_BLOCK_TAG_NAMES}|pre|script|style|textarea)(?:[ \\t/>]|$))[A-Za-z][A-Za-z0-9-]*(?:\\s(?:[^<>"']|"[^"]*"|'[^']*')*)?/?>[ \\t]*\\r?$`,
  'i',
);

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
  for (const f of fixed) {
    const targets = byId.get(canonicalLedgerId(f.id)) ?? [];
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
