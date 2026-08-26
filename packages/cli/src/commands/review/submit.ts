/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review submit`: the only thing in this skill that writes to a pull
// request.
//
// Step 7 has always opened with a posting gate — "posting is a public,
// irreversible write, so it happens ONLY on an explicit instruction" — written
// as prose, and prose is not a gate. It has now failed twice in dogfooding. The
// second time was this skill reviewing its own pull request: no `--comment`, no
// publish request, and it filed a public COMMENT review anyway. Both times the
// model did not decide to defy the rule; it reasoned its way to a verdict it
// wanted to file and never re-read the sentence forbidding the filing.
//
// The skill already learned this once. The review event and body used to be
// reasoned about at submit time and got it wrong five times running, so they
// became `compose-review` — a subcommand that computes them. **Whether to write
// at all** is the same kind of decision, and the authorisation is already a
// computed fact: `parse-args` emits `comment.effective` in Step 1. Nothing was
// missing but a piece of code willing to say no.
//
// So the write lives here, behind that fact. A model that wants to post must ask
// something that checks.
//
// **And the verdict is no longer an input.** For a while, `compose-review`
// computed the event and the body and the skill then told the orchestrator to
// "copy event/body verbatim into the review JSON" — a transcription, into a
// document the model writes, of a decision the CLI had already made. That is the
// exact shape this file's own comment repudiates two paragraphs up, and it is the
// shape that has failed at every layer of this skill. Dogfooded, one run went
// further and skipped `compose-review` altogether: it read the coverage check's
// refusal, decided "the agents clearly did their job", and printed an **Approve it
// had written itself**.
//
// So `submit` composes. What it takes is the *findings* — the inline comments and
// the states Step 6 established — and it derives everything that follows from
// them, including how many blockers there are, by counting the comments actually
// attached rather than believing a number typed beside them. There is no `event`
// field to forge and no `body` field to write, and a payload that carries one is
// refused: the caller was trying to author a verdict, and the verdict is not the
// caller's.

import type { CommandModule } from 'yargs';
import { roundModelIdFrom } from './lib/round-model.js';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { getCliVersion } from '../../utils/version.js';
import { operatorReviewSettings } from './lib/review-settings.js';
import {
  currentUser,
  ghWithInput,
  HOSTNAME_RE,
  isOwnerRepo,
  resolveGhHost,
  setGhHost,
} from './lib/gh.js';
import { REVIEW_TMP_DIR, tmpFile } from './lib/paths.js';
import {
  parseReceiptCommentIds,
  parseReceiptIds,
  parseReceiptObject,
} from './lib/receipt.js';
import {
  ENTRY_FENCE_DELIMITER_RE,
  composeReview,
  normalizeSeverityFloor,
  tryIngestBodyCriticals,
  tryToCount,
  bodyCriticalClaim,
  type ComposeReviewInput,
  type FixedFinding,
} from './compose-review.js';
import {
  carriedFindingOf,
  fetchReviewThreads,
  planThreadActions,
  postReviewReply,
  resolveReviewThread,
  stampCarriedId,
} from './lib/thread-lifecycle.js';
import {
  recordedSeverityFloor,
  reviewWriteAuthorization,
  type ReviewWriteRefusalClass,
} from './lib/authorization.js';
import {
  hostsEquivalent,
  isAoneCanonicalHost,
  parseRemoteUrl,
} from './lib/remote-match.js';
import { gitOpt } from './lib/git.js';
import {
  AonePartialPostError,
  submitAoneReview,
  type AoneSubmitResult,
} from './lib/platform/aone.js';
import { githubReader } from './lib/platform/github.js';
import {
  CRITICAL_PREFIX,
  SUGGESTION_PREFIX,
  carriedClaimLine,
  countInlineFindings,
  severityOf,
} from './lib/inline-counts.js';
import { validateNewSideAnchors } from './lib/anchors.js';
import {
  commentMarker,
  footerVersion,
  rendersAsNothing,
  reviewFooter,
  stripForgedFooterLines,
  stripForUnattributedPost,
  stripReviewFooter,
  swallowsAppendedMarker,
} from './lib/review-footer.js';

/** The only events GitHub's Create Review API accepts. */
const EVENTS = new Set(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);

/**
 * Ids a prior submit in this window already recorded, through one axis
 * parse. Best-effort: an absent or unreadable receipt is an empty list,
 * never a throw — the caller adds the current ids regardless. The shape
 * parse is shared with cleanup's reader (`lib/receipt.ts`) so the two
 * halves cannot drift.
 */
function readReceiptIds(
  receiptPath: string,
  parse: (raw: string) => number[],
): number[] {
  try {
    return parse(readFileSync(receiptPath, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * The whole prior receipt object — the merge source for a rewrite. The
 * receipt file is keyed by PR number alone but carries an axis per
 * platform (review ids on GitHub, comment ids on Aone), so a writer that
 * rebuilt it from only its own axis would un-vouch the other platform's
 * sanctioned writes for a same-numbered target. Absent or unreadable is
 * an empty object, never a throw — best-effort like every receipt read.
 */
function readReceiptObject(receiptPath: string): Record<string, unknown> {
  try {
    return parseReceiptObject(readFileSync(receiptPath, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/**
 * Receipt for cleanup's Aone bypass audit: EVERY comment this session was
 * authorised to post, by id — the Aone twin of the gh receipt below. There
 * submit posts a *review* and the audit flags issue comments it never
 * posts; on Aone submit POSTS COMMENTS (inline findings + summary), so
 * sanctioned-vs-bypass keys on comment ids instead. Accumulates prior ids
 * for the same reason the gh half does (the window spans drift restarts).
 * Best-effort: a receipt failure must never fail a review that DID post,
 * and zero landed ids write nothing (nothing to vouch for).
 */
function recordAoneReceipt(pr: number, newIds: number[], event: string): void {
  if (newIds.length === 0) return;
  try {
    const receiptPath = tmpFile(`pr-${pr}`, 'submit-receipt.json');
    const priorIds = readReceiptIds(receiptPath, parseReceiptCommentIds);
    const commentIds = [...new Set([...priorIds, ...newIds])];
    mkdirSync(REVIEW_TMP_DIR, { recursive: true });
    atomicWriteFileSync(
      receiptPath,
      `${JSON.stringify({
        ...readReceiptObject(receiptPath),
        commentIds,
        event,
        postedAt: new Date().toISOString(),
      })}\n`,
    );
  } catch {
    /* audit metadata only — the post itself succeeded */
  }
}

/**
 * A line number GitHub will take: a positive whole number.
 *
 * `typeof x === 'number'` admits `-1`, `2.5`, `NaN` and `Infinity`, every one of
 * which 422s — and a 422 is all-or-nothing, so each takes the whole review's
 * blockers down with it.
 */
function isDiffLine(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

/**
 * The body-Critical entry an Aone-unanchorable comment relocates as:
 * `path:line — <claim>` — the attribution the inline anchor carried, kept.
 * Single-line by construction (the claim is one line, and the path guard
 * below keeps the prefix one), so compose-review's one-line entry
 * ingestion carries it as-is.
 */
function relocatedAoneCriticalEntry(c: ReviewComment): string {
  // The body arrives footer-appended — strip the canonical footer FIRST,
  // or an empty claim line lets the extraction fall THROUGH into the
  // footer text and post it as the claim (the separator strip eats the
  // newline+colon and the footer's first line becomes the "claim").
  const body = typeof c.body === 'string' ? stripReviewFooter(c.body) : null;
  // The readback strip iterates the WHOLE stacked-marker run a looping
  // model drafts; compose quotes this entry as-is behind the template
  // marker, so a carried second marker would post inside the blocker line.
  const claim = body === null ? null : carriedClaimLine(body);
  // The gate only relocates bodies with substance past the marker, but the
  // claim line itself can still be empty (content on a later line) or a
  // fence delimiter (a marker-alone body leading into a fence) — junk the
  // one-line channel cannot carry. Both fall back to the placeholder
  // instead of posting dangling or raw.
  const visible =
    claim !== null && !ENTRY_FENCE_DELIMITER_RE.test(claim) ? claim : null;
  // The shape gate admits ANY non-empty string path, and the one-line
  // channel cannot carry a hostile one: a newline collapses into a
  // garbled attribution, a line-leading fence delimiter trips compose's
  // fence refusal AFTER this relocation is disclosed, and the entry
  // regenerates from the same path on every retry, so the re-compose
  // loop cannot escape. Such a path falls back to the placeholder, the
  // same fallback the claim half uses.
  const path =
    typeof c.path === 'string' &&
    c.path !== '' &&
    !/[\r\n]/.test(c.path) &&
    !ENTRY_FENCE_DELIMITER_RE.test(c.path)
      ? c.path
      : '(no path)';
  // The CLAIM leads the entry: buildLedger's body-Criticals leg reads a
  // carried id off position 0 (LEDGER_ID_READBACK is ^-anchored), and the
  // write side's convention is that a carried id leads the claim line —
  // a `path:line — ` prefix there would silently strip the id and
  // renumber a carried finding as new. The attribution rides behind the
  // claim instead.
  let entry = `${visible || 'finding'} — ${path}:${c.line}`;
  // The guards above enumerate the hostile shapes this builder knows, but
  // the entrance space is unbounded model text. Compose's own ingestion
  // is the AUTHORITY on what the one-line channel carries — validate the
  // BUILT entry against it, and degrade anything it would refuse to the
  // inert constant (which passes by construction: no fence, no newline,
  // renders as something), so a shape this list never anticipated
  // degrades the entry instead of refusing the whole post mid-degrade.
  if (tryIngestBodyCriticals([entry]) === undefined) {
    entry = `finding — (no path):${c.line}`;
  }
  return entry;
}

interface SubmitArgs {
  pr: number;
  repo: string;
  review: string;
  /** The CLI-written record of what the user typed. Overridable for tests. */
  skillArgs?: string;
  userAuthorized: boolean;
  host?: string;
  dryRun: boolean;
}

interface ReviewComment {
  path?: string;
  line?: number;
  start_line?: number;
  side?: string;
  start_side?: string;
  body?: string;
}

/**
 * What the caller brings: the findings, and the states Step 6 established.
 *
 * Not the verdict. `event` and `body` are computed here, from `state` and from the
 * comments themselves — see the file header.
 */
interface ReviewPayload {
  commit_id?: string;
  comments?: ReviewComment[];
  state?: ComposeReviewInput;
  /** Refused if present. The caller was trying to author the verdict. */
  event?: unknown;
  body?: unknown;
}

function normalizeInlineComments(
  comments: ReviewComment[],
  modelId: unknown,
  cliVersion: string,
  attribution: boolean,
): ReviewComment[] {
  const footer =
    attribution && typeof modelId === 'string' && modelId.trim() !== ''
      ? reviewFooter(modelId, cliVersion)
      : undefined;
  return comments.map((comment) =>
    // An empty body stays empty: this runs BEFORE the consistency check, and
    // a footer pasted onto '' would hide the emptiness from the refusal that
    // names it ('has no body — an empty comment').
    typeof comment.body === 'string' && comment.body.trim() !== ''
      ? {
          ...comment,
          // Forged footers are stripped even with attribution off: a comment
          // authored by the model must not carry one the operator turned
          // off. The off leg also strips footer-shaped lines mid-body — the
          // trailing strip leaves those, and here they would be the only
          // attribution the post carries.
          body:
            footer === undefined
              ? stripForgedFooterLines(stripReviewFooter(comment.body))
              : `${stripReviewFooter(comment.body)}\n\n${footer}`,
        }
      : comment,
  );
}

// The severity prefixes and the counting live in `lib/inline-counts.ts`,
// shared with `compose-review`: the Step 6 verdict line and the Step 7 posted
// verdict must be the same computation on the same source, and two counting
// functions is how they were once allowed to disagree.

/**
 * Was this run authorised to write to the pull request?
 *
 * The gate itself lives in `lib/authorization.ts`, shared verbatim with
 * `publish-assets` — the only other sanctioned public write. See that file for
 * why authorisation is re-parsed from the CLI's verbatim record of what the
 * user typed, and why it binds to a target rather than acting as a bearer
 * token.
 */
function authorization(
  args: SubmitArgs,
  defaultComment: boolean,
): {
  ok: boolean;
  why: string;
  cls?: ReviewWriteRefusalClass;
  recordedHost?: string;
  recordedUnbound?: boolean;
  viaSkillArgsOverride?: boolean;
} {
  return reviewWriteAuthorization({
    userAuthorized: args.userAuthorized,
    defaultComment,
    skillArgs: args.skillArgs,
    pr: args.pr,
    repo: args.repo,
    // The host the CALLER asserted, never the ambient env: submit's
    // routing never consults GH_HOST (the platform gate documents this),
    // and with no flag the write routes at the recorded binding — so an
    // env-resolved host here made the gate compare the recording against
    // a host the write never takes and refuse the ordinary flagless
    // publish. The recorded-binding fallback is declared below, and the
    // ambient-env shape the flagless routing can still take (no recorded
    // host, no cwd origin) is policed by the platform gate itself.
    host: args.host?.trim() || undefined,
    absentHostFollowsRecording: true,
  });
}

/**
 * Reject a payload that contradicts itself before GitHub sees it.
 *
 * The same dogfood run that breached the gate posted a body reading "Reviewed.
 * Suggestions are inline." alongside an empty `comments` array, and closed with
 * a summary line stating `0 Suggestion inline`. Every count in that run
 * disagreed with every other. GitHub accepts all of it — none of it is invalid
 * to the API — so the only place it can be caught is here.
 */
/**
 * The verdict, computed — from the states the caller established and the comments
 * it actually attached.
 *
 * The two inline counts are **derived, not accepted**. They used to be numbers
 * handed over beside the comments, and a number beside a thing is a number that can
 * disagree with it.
 */
function compose(
  payload: ReviewPayload,
  cliVersion: string,
  attribution: boolean,
  runtimeModelId: string | undefined,
): {
  event: string;
  body: string;
  cappedBy: string[];
  /**
   * Indices of drafted comments compose-review's floor enforcement moved
   * into the body's deferral list — the caller removes exactly these from
   * the posting set. Same array, same order: `draftedComments` below IS
   * `payload.comments`, so the indices line up by construction.
   */
  floorEnforced: number[];
  /**
   * Step 6's `fixed` rulings, validated by the compose — the thread
   * lifecycle's resolve list. Rides the composed result rather than being
   * re-read from the raw state, so the validation and the consumption are
   * one list.
   */
  fixedFindings: FixedFinding[];
  /**
   * The ledger id the compose's marker records per drafted comment —
   * index-aligned with the floor-enforcement-reduced posting set the
   * marker describes; the stamp's input. Undefined when no ledger marker
   * rides the body (the ids exist to be carried).
   */
  draftedIds: Array<string | undefined> | undefined;
  /**
   * The ids the compose's ledger MINTS fresh this round — never the
   * carried ones. Undefined exactly when `draftedIds` is: no ledger
   * marker rides the body. The contradiction gate refuses a `fixed`
   * ruling naming one (#9940 review).
   */
  mintedIds: string[] | undefined;
} {
  const comments = payload.comments ?? [];
  const state = payload.state ?? ({} as ComposeReviewInput);
  const { criticalsInline, suggestionsInline } = countInlineFindings(comments);

  // `env` decides where the harness transcripts are read from, and it must not
  // come from a JSON the caller wrote: a run that wanted an approval could point
  // it at a directory of transcripts it fabricated, and the coverage gate reopens
  // through one extra key. `prBodyFetcher` is the bilingual body-language seam:
  // a non-function value reaching `bilingualFromPlan` throws and drops the Chinese
  // fold through the fail-safe — the exact regression this PR closes. compose-review's
  // own CLI strips both for the same reason.
  // `draftedComments` joins them: the ledger marker's contents are the comments
  // this submission actually carries, taken from the payload below — not an
  // assertion a caller's state JSON gets to make about what it reviewed.
  const {
    env: _dropped,
    prBodyFetcher: _droppedFetcher,
    draftedComments: _droppedDrafted,
    ...rest
  } = state;
  void _dropped;
  void _droppedFetcher;
  void _droppedDrafted;

  const r = composeReview(
    {
      ...rest,
      // The state's own claim stands on BOTH platforms and is handed
      // through RAW: compose-review's boundary deliberately refuses a
      // malformed non-boolean here, and coercing the claim to a boolean
      // first would silently drop the context-unavailable cap a
      // stringified "true" was asking for. The Aone write path forced this
      // true while its context reads were unbacked; pr-context is backed
      // now, so an Aone run's claim carries the same meaning as GitHub's —
      // "I did (or did not) read the target's existing discussion" — and
      // the same forgery posture GitHub accepts.
      criticalsInline,
      suggestionsInline,
      draftedComments: comments,
    },
    cliVersion,
    attribution,
    runtimeModelId,
  );
  return {
    event: r.event,
    body: r.body,
    cappedBy: r.cappedBy,
    floorEnforced: r.floorEnforced,
    fixedFindings: r.fixedFindings,
    draftedIds: r.draftedIds,
    mintedIds: r.mintedIds,
  };
}

/** What the caller may not bring. Checked before the verdict is computed from it. */
function structuralProblems(payload: ReviewPayload): string[] {
  const problems: string[] = [];

  if (!payload.commit_id) problems.push('`commit_id` is missing');

  // The review JSON is a document the model writes, and `comments` reaches
  // `.map` in the normalisation below — OUTSIDE `compose`'s try/catch. Any
  // other shape is refused here as the structured refusal the re-compose
  // loop parses, not a bare TypeError.
  if (payload.comments !== undefined && !Array.isArray(payload.comments)) {
    problems.push(
      '`comments` is not an array — it is the list of findings this post ' +
        'carries; any other shape is not a list of findings.',
    );
  }
  if (
    Array.isArray(payload.comments) &&
    (payload.comments as unknown[]).some(
      (c) => c === null || typeof c !== 'object',
    )
  ) {
    problems.push(
      '`comments` entries must each be an object — a finding is a path, ' +
        'a line and a body; any other shape is not a finding.',
    );
  }

  // The verdict is not the caller's to write. Refusing is deliberate: silently
  // ignoring a hand-written `event` would let a run believe it had posted the
  // verdict it typed, and go on saying so in the terminal.
  if (payload.event !== undefined || payload.body !== undefined) {
    problems.push(
      'the payload carries `event`/`body`. Those are computed here, from ' +
        '`state` and from the comments you attached — they are not inputs. ' +
        'Remove them. (A run that skipped `compose-review` and typed its own ' +
        'Approve is exactly what this refuses.)',
    );
  }
  // `== null`, not `=== undefined`. A payload with `"state": null` cleared the
  // strict check, and `compose`'s `?? {}` then collapsed it to an empty state —
  // which composes into a review whose footer names no model and whose caps come
  // from nowhere. The verdict would still have been posted.
  if (payload.state == null) {
    problems.push(
      '`state` is missing — the verdict is computed from it. It is the same ' +
        'object `compose-review` takes: the body Criticals, the discarded ' +
        'suggestions, the cannot-tell blockers, the unreviewed dimensions, the ' +
        '`planPath`, the presubmit flags and the model id.',
    );
  }
  if (
    payload.state?.criticalsInline !== undefined ||
    payload.state?.suggestionsInline !== undefined
  ) {
    problems.push(
      '`state.criticalsInline` / `state.suggestionsInline` are counted from the ' +
        '`comments` you attached, not taken from you. Remove them.',
    );
  }
  return problems;
}

/**
 * The per-comment shape checks the consistency gate refuses. One statement,
 * two readers: `inconsistencies` reports them as the loud refusal, and the
 * Aone anchor gate consults them to decide a comment is too malformed to
 * anchor and must be LEFT to that refusal instead of relocated/discarded.
 * Both boundaries must agree on what is too malformed to anchor, or a shape
 * the gate disposes is a refusal the operator never hears — so the list is
 * written once here and any future shape rule lands in both places at once.
 */
function commentShapeProblems(
  c: ReviewComment,
  i: number,
  attribution: boolean,
): string[] {
  const problems: string[] = [];
  const at = `comments[${i}]`;
  // `path` must be a non-empty STRING — a truthy non-string (a number, an
  // object) is not a path the write seam can post, and `!c.path` alone lets
  // it through to the platform.
  if (typeof c.path !== 'string' || c.path === '') {
    problems.push(`${at} has no \`path\``);
  }
  if (!c.body) problems.push(`${at} has no \`body\` — an empty comment`);

  // The verdict above was counted from these markers, so a body carrying
  // neither weighed nothing in it. Step 6 already refuses unmarked drafts,
  // but the skill's own re-compose instruction expects the comment set to
  // churn after Step 6 — and a marker lost in that churn reaches exactly
  // this boundary, the one that posts. A blocker that weighs nothing
  // approves the review it should block.
  if (c.body && severityOf(c) === null) {
    problems.push(
      `${at} opens with neither ${CRITICAL_PREFIX} nor ` +
        `${SUGGESTION_PREFIX} — the verdict counts comments by their ` +
        `severity marker, and an unmarked one weighs nothing in it`,
    );
  }

  // A body that renders as nothing is the empty case wearing scaffolding.
  // The check runs the FULL post-transform chain (plus the canonical
  // footer that normalize may have appended) and projects through
  // rendersAsNothing: whitespace-only, Cf-only, HTML-comment-only, and
  // hollowed-fence residue all render as nothing on GitHub, and a
  // scaffolded-but-invisible comment that posts counts toward the verdict
  // and re-promotes as an unanswerable blocker.
  if (c.body && severityOf(c) !== null) {
    const stripped = stripReviewFooter(stripForUnattributedPost(c.body));
    if (rendersAsNothing(stripped)) {
      problems.push(
        `${at} renders as nothing (marker-only, empty comment, or ` +
          `otherwise invisible) — redraft it with the finding's description`,
      );
    } else if (!attribution && swallowsAppendedMarker(stripped)) {
      // The prefix strip can move a fence delimiter to line-leading
      // position on a draft whose delimiter sat mid-line; the unclosed
      // fence then swallows the appended invisible marker as visible
      // code and the claim into its info string. The exposure is
      // created by the strip, so the check runs on the post-strip
      // shape, mirroring the fence refusal the body lists apply.
      problems.push(
        `${at} leaves a code fence open in its posted shape — the ` +
          `invisible marker this mode appends would post inside it as ` +
          `visible code. Redraft it quoting the code inline or ` +
          `indented instead`,
      );
    }
  }

  if (!isDiffLine(c.line)) {
    problems.push(
      `${at} has no usable \`line\` (${JSON.stringify(c.line)}) — a line is a ` +
        `positive whole number; resolve its anchor first`,
    );
  }

  // A multi-line comment without both side fields is a 422 that takes the
  // whole review with it. `start_line` must also *be* a line, and must come
  // before the line it ends on.
  if (c.start_line !== undefined) {
    if (!isDiffLine(c.start_line)) {
      problems.push(
        `${at} has a \`start_line\` of ${JSON.stringify(c.start_line)}, ` +
          `which is not a positive whole number`,
      );
    } else if (isDiffLine(c.line) && c.start_line > c.line) {
      problems.push(
        `${at} starts at ${c.start_line} and ends at ${c.line} — a range ` +
          `cannot end before it begins`,
      );
    }
    if (c.side !== 'RIGHT' || c.start_side !== 'RIGHT') {
      problems.push(
        `${at} sets \`start_line\` without \`side\` and ` +
          `\`start_side\` — GitHub 422s the entire review`,
      );
    }
  }
  return problems;
}

function inconsistencies(
  payload: ReviewPayload,
  event: string,
  attribution: boolean,
  /**
   * The model-authored index of each comment, once a removal ahead of
   * this gate has renumbered the array — the refusal cites the authored
   * index, the one that names the culprit in the model's own payload
   * JSON, not its post-removal position.
   */
  authoredIndices?: number[],
  /**
   * Step 6's `fixed` rulings (validated by the compose), beside the payload
   * AS THE MODEL AUTHORED IT. A ruling retires a finding; a re-report under
   * the same id re-asserts it as standing; one payload doing both has ruled
   * one finding two ways. Posted, the pair would reply "fixed" into the
   * very thread its re-report just revived (an Aone-relocated Critical
   * would carry the id into the ledger beside the closed thread); left
   * unposted by a reroute or a discard, it is still the model's own state
   * contradicting itself, and the re-compose loop is told which comment to
   * settle. The gate refuses exactly the RE-REPORTS: the
   * two channels whose ids the ledger builder carries, read through the
   * same readback it applies — a drafted comment's claim line
   * (`**[Critical]** R1-2: …`, `carriedFindingOf`) and a body Critical
   * leading with its id (`bodyCriticalClaim`) — plus a ruling naming an id
   * this same pass MINTS, the round-off-by-one. It reads the comments the
   * model authored rather than the posting set, so a comment the Aone
   * anchor gate degraded or the floor enforcement rerouted still counts
   * as the assertion it is, and the refusal cites the index in the model's
   * own payload JSON — the one the re-compose loop fixes against.
   *
   * Nothing else is a channel. A retired id MENTIONED in prose — a
   * cannot-tell about the fix, a duplicate-drop note, a deferral title or
   * path, a downgrade reason, a budget-gap line, a `by` clause naming a
   * sibling — is a cross-reference, not a re-report: the ledger does not
   * carry it, the next round rules on nothing under it, and the thread it
   * names is legitimately closed. A token scan over such text refused
   * self-consistent payloads over prose no re-compose could redraft (a
   * transcript-derived gap line) and over text the body never rendered
   * (#9940 review, round 6); prose stays the model's responsibility — the
   * ruling section of SKILL.md — and fails open here.
   */
  fixedFindings: FixedFinding[] = [],
  authored?: { comments: ReviewComment[]; bodyCriticals: unknown },
  /**
   * The ids this pass MINTS fresh — the ledger's own account, never the
   * carried ones. A fixed ruling retires an EARLIER finding, so one naming
   * a minted id is the round-off-by-one this gate polices (#9940 review).
   */
  mintedIds: readonly string[] = [],
): string[] {
  const problems: string[] = [];
  const comments = payload.comments ?? [];

  if (fixedFindings.length > 0) {
    const fixedIds = new Set(fixedFindings.map((f) => f.id));
    const contradiction = (at: string, id: string): string =>
      `${at} re-posts ${id}, which \`state.fixedFindings\` rules fixed — ` +
      `a finding is either still standing (re-reported under its id) or ` +
      `fixed (retired); rule it one way`;
    // A fixed ruling retires a PREVIOUS round's entry. An id this same
    // pass mints for a fresh finding — inline or body-Critical — cannot
    // be one: the ruling would resolve nothing on the PR while this pass
    // opens the id's thread as a standing defect, and the next round
    // rules on it as a live defect nobody fixed (#9940 review).
    for (const id of mintedIds) {
      if (fixedIds.has(id)) {
        problems.push(
          `state.fixedFindings rules ${id} fixed, but this same pass ` +
            `mints ${id} for a fresh finding — a fixed ruling retires a ` +
            `previous round's entry; rule the new finding itself`,
        );
      }
    }
    // The drafted comments as authored: every one the model wrote, at
    // its authored index. Without the authored set (a caller that ran
    // no removal) the posting set IS the authored set.
    const drafted = authored?.comments ?? comments;
    drafted.forEach((c, i) => {
      const carried = carriedFindingOf(c.body);
      if (carried !== null && fixedIds.has(carried.id)) {
        problems.push(
          contradiction(
            `comments[${authored ? i : (authoredIndices?.[i] ?? i)}]`,
            carried.id,
          ),
        );
      }
    });
    // The still-standing re-post's other channel — Step 6's rule for an
    // UNANCHORABLE carried finding sends it to the body with its id, and
    // buildLedger carries it from there. The same read the builder
    // performs: the entries pass through compose's ingestion first — the
    // collapsed one-line shape whose rejoined forged footer span strips,
    // where the raw multi-line entry can hide the id behind a hard break
    // (#9940 review) — and the id LEADS the entry, or the entry carries
    // none. Ingestion is index-preserving, so the refusal cites the
    // authored position; a field compose itself refuses carries nothing
    // this gate could contradict.
    const ingestedCriticals = tryIngestBodyCriticals(
      authored ? authored.bodyCriticals : payload.state?.bodyCriticals,
    );
    ingestedCriticals?.forEach((entry, i) => {
      const { id } = bodyCriticalClaim(entry);
      if (id !== undefined && fixedIds.has(id)) {
        problems.push(contradiction(`state.bodyCriticals[${i}]`, id));
      }
    });
  }

  if (!EVENTS.has(event)) {
    // Unreachable through `composeReview`, which returns one of the three. Kept
    // because "unreachable" is a claim about today's code, and this is the last
    // thing standing between a bad payload and a public write.
    problems.push(
      `computed \`event\` is ${JSON.stringify(event)}; GitHub accepts only ` +
        `${[...EVENTS].join(', ')}`,
    );
  }

  // Everything below is a shape GitHub 422s — and a 422 is all-or-nothing, so
  // each of these discards every blocker in the review along with itself. The
  // API is the wrong place to find out.
  comments.forEach((c, i) => {
    problems.push(
      ...commentShapeProblems(c, authoredIndices?.[i] ?? i, attribution),
    );
  });
  return problems;
}

interface SubmitRunOptions {
  /** Append the model/version attribution footer (the `review.attribution` setting). */
  attribution?: boolean;
  /** The standing `review.comment` setting, for the authorization gate. */
  defaultComment?: boolean;
  /**
   * The standing `review.severityFloor` setting, raw — handed to the
   * authorization gate's args re-parse so the floor enforcement below can
   * prefer the OPERATOR'S recorded floor over the state's transcription.
   */
  defaultSeverityFloor?: string;
}

/**
 * A refusal, made terminal: `refuse` never returns, so a gate that has
 * said no cannot fall through toward the write. The exit-3 helper used
 * to return and rely on every call site adding its own `return;` —
 * leaving the guarantee to convention, the thing this file exists to
 * stop believing.
 */
class SubmitRefusal extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'SubmitRefusal';
  }
}

function refuse(message: string, reason: string): never {
  throw new SubmitRefusal(message, reason);
}

export function runSubmit(
  args: SubmitArgs,
  cliVersion = 'unknown',
  opts: SubmitRunOptions = {},
): void {
  try {
    submit(args, cliVersion, opts);
  } catch (err) {
    if (!(err instanceof SubmitRefusal)) throw err;
    // Every refusal in this command speaks one shape: a stderr line, the
    // `{"posted": false}` JSON on stdout, exit 3. Written ONCE here for
    // every gate — Step 7 treats it as a complete, correct outcome; a
    // refusal escaping as a thrown failure would surface as a failed
    // command an agent might retry or route around.
    writeStderrLine(err.message);
    writeStdoutLine(
      JSON.stringify({ posted: false, reason: err.reason }, null, 2),
    );
    process.exitCode = 3;
  }
}

function submit(
  args: SubmitArgs,
  cliVersion: string,
  opts: SubmitRunOptions,
): void {
  const { attribution = true, defaultComment = false } = opts;

  // The repo goes straight into the API path. A malformed value does not fail
  // safely — it fails as a confusing 404 from a URL nobody meant to build.
  if (!isOwnerRepo(args.repo)) {
    throw new Error(
      `--repo ${JSON.stringify(args.repo)} is not <owner>/<repo>.`,
    );
  }
  // yargs' `type: 'number'` hands through NaN, 0, -1, 3.5 and Infinity, each of
  // which builds a URL nobody meant and comes back as a puzzling 404.
  if (!isDiffLine(args.pr)) {
    throw new Error(
      `--pr ${JSON.stringify(args.pr)} is not a pull request number.`,
    );
  }

  let payload: ReviewPayload;
  try {
    payload = JSON.parse(readFileSync(args.review, 'utf8'));
  } catch (err) {
    throw new Error(
      `Cannot read review JSON ${args.review}: ${(err as Error).message}`,
    );
  }

  const auth = authorization(args, defaultComment);
  if (!auth.ok) {
    // Not an error the caller can retry around — a refusal it must accept. The
    // findings are not lost: they are in the terminal output and the saved
    // report, and the user can ask for them to be posted.
    // The advice must match the refusal class, or it misdirects the retry —
    // and it branches on the gate's structural `cls`, never on the refusal
    // text: `why` embeds the operator's verbatim recorded arguments, and any
    // marker string can itself appear inside that quoted record. A
    // `--topology minimal` refusal is its own class: the record bound this
    // target on every axis, so the binding arm's "Nothing recorded…"
    // preamble and "a review invoked naming it" remedy are both wrong on it
    // — the remedy re-refuses while the topology stands — and its other
    // remedy, `--user-authorized`, mechanically posts what the topology
    // bars. The topology arm restates the refusal's own remedy and names the
    // comment source a re-run still needs — the canonical minimal record
    // carries none, and the bare re-run re-refuses without it. The gate
    // otherwise refuses either because comment was never requested, or
    // because nothing recorded authorises this target — a binding miss, or
    // no recorded arguments at all. The last arm's preamble stays neutral
    // ("Nothing recorded…") because a setting-driven missing-args refusal
    // lands here too, and "The recorded arguments do not bind" would
    // contradict its `why` ("no review arguments were recorded").
    // `--comment` cannot fix that class — the flag stands in for nothing a
    // target binding needs, and the `review.comment` setting already stood
    // in for the flag on exactly those refusals — so advising it there buys
    // the futile retry loop authorization.ts's refusal wording exists to
    // prevent.
    const advice =
      auth.cls === 'topology'
        ? `This is the correct outcome of a review run under ` +
          `\`--topology minimal\` — the arm posts nothing at any effort. ` +
          `Report the findings in the terminal and stop. Re-run the review ` +
          `without \`--topology minimal\` — with posting requested ` +
          `(\`--comment\` or the \`review.comment\` setting) — to make ` +
          `posting available.`
        : auth.cls === 'comment-not-requested'
          ? `This is the correct outcome of a review the user did not ask ` +
            `to publish — report the findings in the terminal and stop. ` +
            `Re-run with \`--comment\`, or pass --user-authorized only ` +
            `after the user has asked, in a message they typed, for this ` +
            `review to be published.`
          : `Nothing recorded authorises binding this target — report the ` +
            `findings in the terminal and stop. Posting to this pull ` +
            `request needs a review invoked naming it, or --user-authorized ` +
            `after the user has asked, in a message they typed, for this ` +
            `review to be published.`;
    refuse(
      `REFUSED to post to ${args.repo}#${args.pr}: ${auth.why}.\n` +
        `Posting is a public, irreversible write, and this run has no ` +
        `authorisation for one. ${advice}`,
      auth.why,
    );
  }

  // Which PLATFORM this write lands on. Evidence precedence mirrors the
  // registry's documented detection order — an EXPLICIT host flag, else
  // the recorded binding, else the cwd probe — with four write-specific
  // disciplines:
  //  - The predicate is the CANONICAL Aone pair, not the family wildcard:
  //    `*.alibaba-inc.com` also names GitHub Enterprise instances (an
  //    org's `ghe.alibaba-inc.com`), and an irreversible write must not
  //    take the a1 path on a family resemblance.
  //  - The ambient GH_HOST export is NEVER consulted here. It is a
  //    GitHub-ROUTING variable; a read would never detect Aone from it
  //    (detectPlatformKind does not read it), and a write that did could
  //    READ from one platform and WRITE to another.
  //  - The FAST path with no host evidence at all — a recording that
  //    names no host (a bare-MR-number recording without `--host`), or NO
  //    recording found (writeSkillArgs never throws, recordings are
  //    cwd-relative — a publish invoked from another directory finds
  //    nothing) — fails CLOSED and names the remedy (`--host`), which
  //    this gate honours: an explicit flag on the re-run is platform
  //    proof, so it lifts the refusal instead of meeting it again. The
  //    cwd probe may still decide a SLOW-path publish — that path reads
  //    the current session's own recording, so it is same-session by
  //    construction and the cwd names the clone the review ran in. The
  //    ONE slow-path shape that is not — a session-less caller reading a
  //    `--skill-args` override, another cwd's record — fails closed on
  //    its hostless form too: the probe names submit's clone there, not
  //    the review's.
  //  - An explicit `--host` and a recorded host are ONE evidence chain
  //    about where the reviewed target lives: the flag FILLS the gap
  //    when the recording names no host (the remedy above), it does not
  //    override the recording's answer. Two hosts that are not the same
  //    platform (through hostsEquivalent, so the Aone web/git alias
  //    passes) name a contradiction — the review ran on one, and the
  //    write would land on the other's same-named repo — so the gate
  //    refuses instead of choosing. The recorded host is the user's own
  //    keystrokes; a caller-typed flag is not entitled to retarget it.
  // The recorded host is the operator's VERBATIM keystrokes, but every
  // discriminating read below assumes the trimmed spelling — trim ONCE
  // here so a padded canonical host is still recognised as Aone and a
  // trim-equivalent flag cannot conflict with its own recording. An
  // all-whitespace host stays intact so it reaches the HOSTNAME_RE check
  // and refuses as invalid-host instead of collapsing to an absent host.
  const rawRecordedHost = auth.recordedHost;
  const recordedHost =
    rawRecordedHost !== undefined && rawRecordedHost.trim() !== ''
      ? rawRecordedHost.trim()
      : rawRecordedHost;
  const explicitHost = args.host?.trim() || undefined;
  // A SHAPED-BUT-EMPTY flag is not an absent one. The host value rides
  // shell interpolation in agent-built commands (`--host "$REVIEW_HOST"`
  // with the variable unset), and collapsing it to "no flag" would fire
  // the very refusal the flag was the remedy for — byte-identically —
  // sending the re-runner into a futile retry loop. Refuse it DISTINCTLY
  // so the two failure states are tellable apart.
  if (args.host !== undefined && explicitHost === undefined) {
    refuse(
      `REFUSED to post to ${args.repo}#${args.pr}: \`--host\` was ` +
        `passed but is EMPTY — an empty flag is not platform proof. ` +
        `Re-run with \`--host <host>\` naming the host the target lives ` +
        `on (or drop the flag entirely when the recorded review names ` +
        `the host). The findings are in the terminal output and the ` +
        `saved report.`,
      'host-flag-empty',
    );
  }
  if (
    explicitHost !== undefined &&
    recordedHost !== undefined &&
    !hostsEquivalent(explicitHost, recordedHost)
  ) {
    refuse(
      `REFUSED to post to ${args.repo}#${args.pr}: the explicit ` +
        `\`--host ${explicitHost}\` contradicts the host the recorded ` +
        `review names (\`${recordedHost}\`) — the two are not the same ` +
        `platform, and a public write must not be retargeted from the ` +
        `platform its review ran on to another platform's same-named ` +
        `repo. Re-run without \`--host\` to post where the recorded ` +
        `review ran, or re-run the review for ${explicitHost} first. ` +
        `The findings are in the terminal output and the saved report.`,
      'target-platform-conflict',
    );
  }
  const overrideHostless =
    !args.userAuthorized &&
    auth.viaSkillArgsOverride === true &&
    recordedHost === undefined;
  const fastPathHostless =
    auth.recordedUnbound === true ||
    (args.userAuthorized && recordedHost === undefined);
  if ((fastPathHostless || overrideHostless) && explicitHost === undefined) {
    // Same exit-3 shape as an unauthorised refusal — Step 7 treats it as
    // a complete, correct outcome; a throw would surface as a failed
    // command an agent might retry or route around.
    refuse(
      `REFUSED to post to ${args.repo}#${args.pr}: nothing this gate ` +
        `can read names the platform the target lives on — ` +
        (auth.recordedUnbound === true
          ? `the recorded review is a bare PR number with no \`--host\``
          : overrideHostless
            ? `the authorising recording came from the \`--skill-args\` ` +
              `override — another cwd's record that names no host — and ` +
              `the submission cwd's platform must not stand in for it`
            : `no recorded review names this target at all`) +
        ` — and a public write must not guess between GitHub and Aone ` +
        `Code. Re-run with \`--host <host>\` naming the host the target ` +
        `lives on. The findings are in the terminal output and the saved ` +
        `report.`,
      'target-platform-unbound',
    );
  }
  // The cwd arm probes the origin's host through the SAME canonical
  // predicate — it must not delegate to the registry's detection, which
  // matches the `*.alibaba-inc.com` FAMILY wildcard: safe for reads, not
  // for writes — an origin on an org GHE family host (ghe.alibaba-inc.com)
  // would take the a1 path with nothing proving a canonical Aone target.
  // A family-only resemblance falls through to the gh path.
  const cwdOriginUrl = gitOpt('remote', 'get-url', 'origin');
  const cwdOriginHost = cwdOriginUrl
    ? parseRemoteUrl(cwdOriginUrl)?.host
    : undefined;
  const aoneWrite =
    isAoneCanonicalHost(explicitHost ?? recordedHost) ||
    (auth.viaSkillArgsOverride !== true &&
      explicitHost === undefined &&
      recordedHost === undefined &&
      isAoneCanonicalHost(cwdOriginHost));
  // The gh write binds its routing host to the SAME evidence that selected
  // it: an explicit flag, else the recorded binding, else the cwd origin
  // the selection arm ran on. Without the rebind a recorded non-Aone host
  // (e.g. a GHE instance) posted wherever the ambient env pointed —
  // github.com's same-named repo — instead of where the review actually
  // ran; and a cwd-selected post restored ambient env inheritance, routing
  // the write past the very clone that chose the platform. a1 writes never
  // touch the gh host state.
  if (!aoneWrite) {
    const boundHost = explicitHost ?? recordedHost ?? cwdOriginHost;
    // Validate BEFORE setGhHost: a recorded host is recorded VERBATIM
    // (parse-args does not validate --host), and an invalid one — scheme,
    // underscore — used to throw setGhHost's TypeError straight out of
    // runSubmit: a failed command with a stack trace instead of the
    // exit-3 refusal shape Step 7 treats as a complete, correct outcome.
    // Same answer, structured shape, naming the offender and its origin.
    // Test the TRIMMED value: setGhHost trims internally before its own
    // check, and a padded host is a known-good input class that must
    // post, not refuse.
    if (boundHost !== undefined && !HOSTNAME_RE.test(boundHost.trim())) {
      // A recorded offender gets NO flag remedy: any valid flag
      // contradicts the recorded host (hostsEquivalent cannot match a
      // value that fails HOSTNAME_RE), and a flag equivalent to it
      // fails HOSTNAME_RE itself — the contradiction refusal's remedy
      // points back here, so re-recording is the only escape. The
      // flag and origin arms ARE fixable by a re-run with a valid
      // flag.
      const remedy =
        recordedHost !== undefined
          ? `An explicit \`--host\` cannot override the recorded one ` +
            `— re-record the review with a valid \`--host\`.`
          : `Re-run with a valid \`--host\`.`;
      refuse(
        `REFUSED to post to ${args.repo}#${args.pr}: the host this ` +
          `write would route at (${JSON.stringify(boundHost)}, from ` +
          (explicitHost !== undefined
            ? `the \`--host\` flag`
            : recordedHost !== undefined
              ? `the recorded review's \`--host\``
              : `this clone's origin remote`) +
          `) is not a hostname (optionally :port). ${remedy} The ` +
          `findings are in the terminal output and the saved report.`,
        'invalid-host',
      );
    }
    setGhHost(boundHost);
    // Nothing bound means the gh child INHERITS the ambient env — and an
    // operator-exported GH_HOST pointing at a canonical Aone host (the
    // org intranet export pattern) then routes the write at a host gh
    // cannot post to, failing opaquely after validation and compose ran.
    // Pre-PR this shape refused actionably; refuse actionably again.
    if (
      boundHost === undefined &&
      isAoneCanonicalHost(resolveGhHost(args.host))
    ) {
      refuse(
        `REFUSED to post to ${args.repo}#${args.pr}: nothing names the ` +
          `host this write should route at, and the ambient \`GH_HOST\` ` +
          `environment variable points at Aone Code ` +
          `(${resolveGhHost(args.host)}) — gh cannot post there. Unset ` +
          `GH_HOST for this command (posts at github.com), or re-run ` +
          `with \`--host <host>\` naming the host the target lives on. ` +
          `The findings are in the terminal output and the saved report.`,
        'ambient-gh-host-aone',
      );
    }
  }

  // What the caller may not bring, checked before anything is computed from it: a
  // verdict of its own, or no state to compute one from. "Your state does not
  // compose" is a poor way to say "you gave me no state".
  const structural = structuralProblems(payload);
  if (structural.length > 0) {
    throw new Error(
      `The review payload contradicts itself; refusing to post it:\n` +
        structural.map((p) => `  - ${p}`).join('\n'),
    );
  }

  payload = {
    ...payload,
    comments: normalizeInlineComments(
      payload.comments ?? [],
      payload.state?.modelId,
      cliVersion,
      attribution,
    ),
  };
  // The payload as the model authored it — normalized like everything the
  // gates read, captured BEFORE the Aone anchor gate and the floor
  // enforcement rewrite the posting set. The fixed-vs-re-post gate reads
  // this: a degraded or rerouted comment is still the assertion the model
  // made, and a refusal must cite the index of the model's own JSON, which
  // no reduced array carries (#9940 review).
  const authored = {
    comments: payload.comments ?? [],
    bodyCriticals: payload.state?.bodyCriticals,
  };

  // The Aone anchor gate. GitHub validates every anchor server-side and
  // 422s the whole review — the skill's recovery loop then relocates the
  // failing Criticals into the body and discards the failing Suggestions.
  // Aone Code performs NO anchor validation (probed 2026-08-21 on a
  // scratch CR: any positive integer posts; an old-side number silently
  // becomes the same-numbered new-side line — the silent-wrong-line class
  // GitHub refuses), so the check and the relocate run HERE, in code,
  // before anything posts: every MARKED comment's anchor must sit inside
  // a new-side hunk of the captured diff, exactly the rule the GitHub
  // recovery re-derives by hand. Unmarked comments are left alone — the
  // consistency gate below refuses them, unchanged. The verdict is then
  // composed over the corrected set, so `C`/`S`, the event and the body
  // stay one computation. (docs/design/2026-08-21-review-aone-removed-line-anchoring.md)
  let anchorsRelocated = 0;
  let anchorsDiscarded = 0;
  // True only on a dry run whose gate could not run (the captured diff is
  // missing): the preview composes but reports it would NOT post.
  let anchorsUnchecked = false;
  // The model-authored indices of payload.comments, kept once a removal
  // ahead of the consistency gate renumbers the array — the refusal text
  // cites these, so the re-compose loop fixes the comment the index names
  // in the model's own payload JSON. Undefined while no removal has run
  // (the identity).
  let authoredIndices: number[] | undefined;
  if (aoneWrite) {
    // The captured diff is the ONLY view of the MR this boundary can
    // validate against — the platform's own read-back cannot tell a
    // misanchored comment from an anchored one (`outdated` stays false
    // for every in-EOF line). Its absence therefore refuses the WHOLE
    // post: an irreversible write the boundary cannot vouch for is the
    // one thing it must not perform. (GitHub needs no such condition —
    // its server holds the diff.) A dry run is the exception: it writes
    // nothing, so the rationale cannot apply — it skips the gate with a
    // disclosure and reports that the real post would refuse.
    const diffRel = tmpFile(`pr-${args.pr}`, 'diff.txt');
    let diffText: string | undefined;
    try {
      diffText = readFileSync(diffRel, 'utf8');
    } catch {
      if (!args.dryRun) {
        writeStderrLine(
          `REFUSED to post the review to ${args.repo}#${args.pr} on ` +
            `Aone Code: the Aone platform validates no inline anchor, so ` +
            `this write path validates every one against the review's ` +
            `captured diff — and ${diffRel} does not exist or cannot be ` +
            `read. Re-run the review so the diff is captured. Nothing was ` +
            `written; the findings are in the terminal output and the ` +
            `saved report.`,
        );
        writeStdoutLine(
          JSON.stringify(
            { posted: false, reason: 'aone-post-refused' },
            null,
            2,
          ),
        );
        process.exitCode = 3;
        return;
      }
      anchorsUnchecked = true;
      writeStderrLine(
        `Aone anchor check: SKIPPED — ${diffRel} does not exist or ` +
          `cannot be read, and the gate validates anchors against that ` +
          `captured diff. --dry-run writes nothing, so the preview ` +
          `composes the payload AS AUTHORED (anchors unchecked); the ` +
          `real post refuses until the review is re-run and the diff ` +
          `is captured.`,
      );
    }
    if (diffText !== undefined) {
      // A diff that parses to no files (corrupt capture) validates nothing:
      // every anchor then fails as "file is not in the diff" and the degrade
      // below discloses each one — safe, and visibly anomalous, without a
      // second refusal shape.
      const comments = payload.comments ?? [];
      const verdicts = validateNewSideAnchors(
        diffText,
        comments.map((c) => ({
          path: c.path ?? '',
          line: c.line ?? 0,
          startLine: c.start_line,
          side: c.side,
          startSide: c.start_side,
        })),
      );
      const kept: ReviewComment[] = [];
      const keptIndices: number[] = [];
      const relocated: string[] = [];
      const disclosures: string[] = [];
      comments.forEach((c, i) => {
        const sev = severityOf(c);
        // Comments too malformed to anchor are not the gate's to dispose — the
        // consistency gate below owns those refusals, unchanged, and the gate
        // reads the SAME shape list (commentShapeProblems) that gate reports,
        // so the two cannot drift: whatever the consistency gate would loudly
        // refuse, the gate leaves to it. The gate rules only WELL-FORMED
        // anchors. A single-line comment on a declared non-RIGHT side is
        // well-formed but unanchorable on Aone — relocating it is the point.
        if (
          commentShapeProblems(c, i, attribution).length > 0 ||
          verdicts[i]?.valid === true
        ) {
          kept.push(c);
          keptIndices.push(i);
          return;
        }
        const at = `${c.path}:${c.line}`;
        if (sev === 'critical') {
          relocated.push(relocatedAoneCriticalEntry(c));
          disclosures.push(
            `  relocated into the summary body: ${at} — ` +
              `${verdicts[i]?.reason ?? 'unanchorable'}`,
          );
        } else {
          anchorsDiscarded++;
          disclosures.push(
            `  discarded: ${at} — ${verdicts[i]?.reason ?? 'unanchorable'}`,
          );
        }
      });
      anchorsRelocated = relocated.length;
      const state = payload.state ?? ({} as ComposeReviewInput);
      const bc = state.bodyCriticals;
      // The stand-down: ANY degrade that touches the payload must not run
      // over a field compose owns when compose would REFUSE that field.
      // Relocating into a refused `bodyCriticals` shatters a string into
      // per-character junk entries — each counted toward `C` and posted —
      // or pollutes compose's pinned refusal with the gate's own entry;
      // discarding ahead of an uncountable `suggestionsDiscarded`
      // announces a degrade that compose's refusal then unpublishes.
      // Either way the terminal would name a degrade that did not
      // survive, over a payload compose never saw unchanged. Stand the
      // WHOLE gate down instead: the payload reaches compose unchanged
      // and dies the pinned death; nothing posts either way, and the
      // findings stay in the saved report. "Refused" reads compose's OWN
      // total acceptance, not a mirror: for `bodyCriticals` the CONTENT
      // gates too (the fence refusal, the renders-nothing refusal), a
      // string array passing shape while compose refuses its entries;
      // tryIngestBodyCriticals and tryToCount ARE those tables, so the
      // two reads of each field can never drift.
      const bcAccepted = tryIngestBodyCriticals(bc);
      const sdCount = tryToCount(state.suggestionsDiscarded);
      const standDown =
        (anchorsRelocated > 0 || anchorsDiscarded > 0) &&
        (bcAccepted === undefined || sdCount === undefined);
      if (standDown) {
        anchorsRelocated = 0;
        anchorsDiscarded = 0;
      } else if (anchorsRelocated > 0 || anchorsDiscarded > 0) {
        // The discard count merges into the state's own — the model may
        // have discarded unanchorable findings upstream (resolve-anchors'
        // unmatched dispose) and the body's sentence names the TOTAL.
        // Absence and `null` both count zero for compose, so both merge
        // from zero here.
        const mergedDiscarded =
          anchorsDiscarded === 0
            ? undefined
            : (sdCount ?? 0) + anchorsDiscarded;
        payload = {
          ...payload,
          comments: kept,
          state: {
            ...state,
            ...(anchorsRelocated > 0
              ? {
                  bodyCriticals: [
                    ...(Array.isArray(bc) ? bc : []),
                    ...relocated,
                  ],
                }
              : {}),
            ...(mergedDiscarded !== undefined
              ? { suggestionsDiscarded: mergedDiscarded }
              : {}),
          },
        };
        // The removal renumbers the array the consistency gate below
        // reports on; keep the authored indices so the refusal names the
        // comment the re-compose loop must fix.
        authoredIndices = keptIndices;
        writeStderrLine(
          `Aone anchor check: ${anchorsRelocated + anchorsDiscarded} inline ` +
            `comment(s) cannot be anchored to the MR's new side (Aone Code ` +
            `performs no server-side anchor validation):\n` +
            disclosures.join('\n'),
        );
      }
    }
  }

  // The operator's floor, from the CLI's verbatim record — never only the
  // state's transcription of it. The state field is a model-written copy of
  // the operator's policy, and a copy that can drift must not decide
  // whether enforcement stands down. The recovery is the SHARED helper both
  // posting boundaries call with the SAME identity formula — this command's
  // CLI-typed target first (`--pr`/`--repo`/the effective host, all
  // mandatory-and-validated here), the plan filling only axes the caller
  // did not supply — so the archived compose and this post cannot resolve
  // different floors for one review. Caller-first because the plan's PATH
  // arrives through that same model-written state: plan-first let a
  // parseable-but-wrong plan choose which identity the operator's record
  // was tested against and silently stand the recovery down. The recovered
  // value wins whenever the recovery yields one that differs; when it
  // yields nothing — no record, unreadable, no floor decision in it,
  // another PR's or repo's record — the state's value stands, the same
  // fail-open the enforcement itself applies. The note names the TRUE
  // source (flag vs setting): "the record outranks the state" over a
  // setting-sourced floor sent auditors hunting the record for a flag
  // nobody typed.
  const recovered = recordedSeverityFloor({
    planPath:
      typeof payload.state?.planPath === 'string'
        ? payload.state.planPath
        : undefined,
    callerPr: args.pr,
    callerRepo: args.repo,
    // The host axis binds to the host the WRITE actually routes at — the
    // SAME evidence chain the routing bind uses: explicit flag, else the
    // recorded binding, else the cwd origin the selection arm ran on,
    // else the gh fallback. resolveGhHost alone never yields a recorded
    // Aone host, so a flagless Aone post (routed via the recorded
    // binding) would bind the floor to github.com/ambient and silently
    // drop the operator's recorded floor.
    callerHost:
      explicitHost ?? recordedHost ?? cwdOriginHost ?? resolveGhHost(args.host),
    defaultSeverityFloor: opts.defaultSeverityFloor,
    skillArgs: args.skillArgs,
  });
  // The guard compares the NORMALISED state floor: a case- or
  // whitespace-drifted transcription of the same floor is agreement, and
  // announcing an override over it would put a false claim on the audit
  // channel.
  if (
    recovered !== undefined &&
    payload.state != null &&
    normalizeSeverityFloor(payload.state.severityFloor) !== recovered.floor
  ) {
    writeStderrLine(
      `Severity floor: using ${JSON.stringify(recovered.floor)} from ` +
        (recovered.source === 'explicit'
          ? 'the recorded `--severity-floor` flag'
          : 'the `review.severityFloor` setting resolved against the recorded invocation') +
        `, over the state's ` +
        `${JSON.stringify(payload.state.severityFloor ?? null)} — the ` +
        `CLI's verbatim record outranks the state JSON.`,
    );
    payload = {
      ...payload,
      state: { ...payload.state, severityFloor: recovered.floor },
    };
  }

  // The verdict, computed here. It was never in the payload.
  let event: string;
  let body: string;
  let cappedBy: string[];
  let floorEnforced: number[];
  let fixedFindings: FixedFinding[];
  let draftedIds: Array<string | undefined> | undefined;
  let mintedIds: string[] | undefined;
  try {
    ({
      event,
      body,
      cappedBy,
      floorEnforced,
      fixedFindings,
      draftedIds,
      mintedIds,
    } = compose(
      payload,
      cliVersion,
      attribution,
      // The anchor's certifying identity is the model the runtime published
      // for this session — Config publishes it per session, the shell tool
      // injects it into this subprocess. It supersedes the typed id, but the
      // launching command can still override the env (and a hijacked
      // orchestrator can forge the marker outright via the API) — the same
      // forgeable posture DESIGN.md records for the cache path.
      // The identity this round runs under — see lib/round-model.ts.
      roundModelIdFrom(process.env),
    ));
  } catch (err) {
    throw new Error(
      `The review state does not compose into a verdict; refusing to post:\n` +
        `  - ${(err as Error).message}`,
    );
  }

  // The floor, enforced: compose-review already described the reduced set —
  // the body's deferral list carries these findings and the ledger work
  // list excludes them — so posting the full array would make the review
  // disagree with its own body. The removal happens BEFORE the consistency
  // gate: a rerouted comment is no longer posting, so it is no longer the
  // gate's business (an unmarked comment is never rerouted and still
  // refuses below).
  if (floorEnforced.length > 0) {
    const drop = new Set(floorEnforced);
    const comments = payload.comments ?? [];
    const base = authoredIndices ?? comments.map((_, i) => i);
    payload = {
      ...payload,
      comments: comments.filter((_, i) => !drop.has(i)),
    };
    authoredIndices = base.filter((_, i) => !drop.has(i));
    writeStderrLine(
      `Floor enforcement: ${floorEnforced.length} Suggestion comment(s) ` +
        `drafted past the resolved critical floor were moved into the ` +
        `body's deferral list and will not post inline.`,
    );
  }

  const problems = inconsistencies(
    payload,
    event,
    attribution,
    authoredIndices,
    fixedFindings,
    authored,
    mintedIds ?? [],
  );
  if (problems.length > 0) {
    throw new Error(
      `The review payload contradicts itself; refusing to post it:\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
  }

  // The thread lifecycle matches threads by the id that LEADS their root
  // comment, and a freshly drafted finding carries none — its id is minted
  // only into the ledger marker at compose time. Stamp each id-less draft
  // with the id the marker records for it (the claim-line shape Step 6
  // writes on carried re-reports), so a thread is reachable from the round
  // it is born: a later `still stands` replies into it, a `fixed` ruling
  // resolves it (#9940 review). GitHub only — the Aone write path has no
  // review-thread graph to reach into. The insertion preserves every
  // property the gate above validated — the severity marker, visibility
  // and fence state all sit behind it, untouched — because a body that
  // OPENS a code fence takes no stamp at all (stampCarriedId leaves it
  // un-stamped, disclosed below): text before the backticks would stop
  // the posted first line leading the fence the gate validated (#9940
  // review).
  const stampedFresh = new Set<number>();
  let stampSkippedFence = 0;
  if (!aoneWrite && draftedIds !== undefined) {
    const comments = payload.comments ?? [];
    payload = {
      ...payload,
      // Index space: `draftedIds` aligns with the posting set AFTER the
      // floor-enforcement removal — compose built the ledger off that same
      // reduced set — so the post-removal position IS the lookup, never
      // the authored index.
      comments: comments.map((c, i) => {
        const id = draftedIds[i];
        if (id === undefined || typeof c.body !== 'string') return c;
        const body = stampCarriedId(c.body, id);
        if (body === c.body) {
          // Unchanged although an id was owed: the body carries one
          // already (the model's carry stays verbatim) or it opens a
          // code fence and the stamp was skipped — only the latter is a
          // disclosure (#9940 review).
          if (carriedFindingOf(c.body) === null) stampSkippedFence++;
          return c;
        }
        stampedFresh.add(i);
        return { ...c, body };
      }),
    };
    if (stampSkippedFence > 0) {
      writeStderrLine(
        `Thread lifecycle: ${stampSkippedFence} draft(s) open a code ` +
          `fence on their first line and were left un-stamped — a stamp ` +
          `there would break the fence the gate validated. Their ` +
          `thread roots carry no ledger id, so no later carry or ` +
          `fixed ruling can reach them; resolve such threads by hand.`,
      );
    }
  }

  // What the platform receives: the caller's findings, under the verdict
  // this command computed. `event` and `body` were never in the object the
  // caller wrote. Both posting paths carry the SAME comments — the
  // attribution-off rewrite below is a property of the post, not of GitHub.
  // Attribution-off strips the severity markers from the POSTED bodies —
  // the one place the bracket-prefix template is visible. Everything above
  // (counting, the unmarked gate, the ledger) already ran on the marked
  // payload, so the verdict this post carries is unchanged. The invisible
  // comment marker goes on in the markers' place, carrying the severity
  // the visible prefix carried: presubmit dedups on it, and pr-context
  // re-promotes an unresolved Critical to the re-check section off it.
  // Pre-existing marker strings are stripped first — the shape is public,
  // and a reviewed file can quote it into a comment body; only the
  // canonical trailing marker may survive.
  const finalComments = attribution
    ? (payload.comments ?? [])
    : (payload.comments ?? []).map((c) => {
        if (typeof c.body !== 'string') return c;
        // The gate above refuses unmarked bodies, so the severity is
        // always known here.
        const sev = severityOf(c);
        if (sev === null) return c;
        return {
          ...c,
          // Exactly the body the gate above validated: a forged footer
          // the fixpoint chain exposes at the tail survives the
          // anywhere-strips' caps, and only the trailing strip removes
          // it — posting the gate's view is how the two cannot drift.
          body: `${stripReviewFooter(stripForUnattributedPost(c.body))}\n\n${commentMarker(sev)}`,
        };
      });

  // The thread lifecycle (GitHub only — #9906). Two postings this pass
  // makes BEYOND the review itself, both into threads this account opened
  // in earlier rounds:
  //
  //  - A carried finding — Step 6's `still stands`, re-drafted under its
  //    original id — REPLIES into that id's original thread instead of
  //    riding the Create Review `comments[]`: the API opens a NEW thread
  //    per comment, so re-posting multiplied one finding into one
  //    unresolved thread per round it survived (#9659's R1-15 had four).
  //    Only an UNRESOLVED own-account thread qualifies — a resolved or
  //    foreign original leaves the re-post inline, where a still-standing
  //    finding belongs — and a `(fix-induced)` re-report is never
  //    diverted: it is a NEW defect wearing the id (the ledger's fresh
  //    count reads it as first-time work), and new work gets its own
  //    thread.
  //  - A Step 6 `fixed` ruling replies its one line (`R1-2 fixed by
  //    <what>`) into every live own thread under the id and resolves it,
  //    so the unresolved list reads as "still standing" again.
  //
  // The read runs BEFORE the write: a failed thread query aborts the
  // submit (retryable, nothing posted) rather than planning half a pass.
  // First rounds short-circuit — no carried id, no fixed ruling, no
  // extra API call at all.
  let reviewComments = finalComments;
  let carriedReplies: Array<{ commentId: number; body: string }> = [];
  let fixedResolves: Array<{
    threadId: string;
    commentId: number;
    body: string;
  }> = [];
  if (aoneWrite) {
    if (fixedFindings.length > 0) {
      writeStderrLine(
        `Note: ${fixedFindings.length} fixed ruling(s) name threads to ` +
          `resolve, but the thread lifecycle is GitHub-only — Aone's MR ` +
          `discussions stay as posted.`,
      );
    }
  } else {
    const carried = finalComments
      .map((c, index) => ({ index, finding: carriedFindingOf(c.body) }))
      // A stamped-fresh id was minted THIS round; no existing thread can
      // carry it, so it is no carry candidate — left in, it would pay the
      // thread read on every round with new findings for a match that
      // cannot exist, and cost a first round its short-circuit.
      .filter((x) => !stampedFresh.has(x.index))
      .filter(
        (
          x,
        ): x is {
          index: number;
          finding: { id: string; fixInduced: boolean };
        } => x.finding !== null && !x.finding.fixInduced,
      );
    if (carried.length > 0 || fixedFindings.length > 0) {
      const threads = fetchReviewThreads(args.repo, args.pr);
      const plan = planThreadActions(
        threads,
        currentUser(),
        carried.map(({ index, finding }) => ({ index, id: finding.id })),
        fixedFindings,
      );
      if (plan.replies.length > 0) {
        const diverted = new Set(plan.replies.map((r) => r.index));
        reviewComments = finalComments.filter((_, i) => !diverted.has(i));
        carriedReplies = plan.replies.map((r) => ({
          commentId: r.commentId,
          // The normalized drafted body, footer and all — the same text
          // the re-post would have carried inline.
          body: finalComments[r.index].body ?? '',
        }));
        // A PLAN, like the resolve line below: nothing is written yet.
        writeStderrLine(
          `Thread lifecycle: ${plan.replies.length} carried finding(s) ` +
            `to reply into their original thread instead of opening a ` +
            `new one (one finding, one thread).`,
        );
      }
      // Threads opened before id-stamping shipped carry no ledger id the
      // matcher can reach — the ONE case a fixed ruling retires an entry
      // while its original thread stays open forever, and nothing else
      // names it. Stated once: every branch a ruling can take must carry
      // it, or the disclosure misfires exactly in the state it exists for
      // (#9940 review).
      const preStampCaveat =
        'Threads this account opened before id-stamping shipped carry ' +
        'no ledger id and cannot be matched — if such an original is ' +
        'still open, resolve it by hand.';
      if (plan.resolves.length > 0) {
        // The `by` clause is model text posted into a thread, so it takes
        // the SAME two strips an inline comment's body takes: the trailing
        // footer at normalize time, and under attribution off the whole
        // unattributed-post projection (mid-line footer spans included)
        // the posted bodies get — a `by` cannot carry into the thread
        // what the comments may not. A clause that was nothing but a
        // forged footer reads as no clause. The real footer is then
        // appended under attribution exactly as `normalizeInlineComments`
        // appends it to every comment.
        const modelId = payload.state?.modelId;
        fixedResolves = plan.resolves.map((r) => {
          const by =
            r.by === undefined
              ? ''
              : stripReviewFooter(
                  attribution ? r.by : stripForUnattributedPost(r.by),
                ).trim();
          const line = by === '' ? `${r.id} fixed` : `${r.id} fixed by ${by}`;
          return {
            threadId: r.threadId,
            commentId: r.commentId,
            body:
              normalizeInlineComments(
                [{ body: line }],
                modelId,
                cliVersion,
                attribution,
              )[0]?.body ?? line,
          };
        });
        // Phrased as a PLAN: the line is written before the dry-run
        // check and before any write, and a resolve mutation can still
        // fail — a past-tense "resolved" here would claim what the
        // bookkeeping below may then deny in the same stream (#9940
        // review).
        writeStderrLine(
          `Thread lifecycle: ${plan.resolves.length} thread(s) to resolve ` +
            `for ${fixedFindings.length} fixed ruling(s). ` +
            preStampCaveat,
        );
      }
      for (const id of plan.unmatchedFixed) {
        writeStderrLine(
          `Thread lifecycle: fixed ruling ${id} matched no live thread ` +
            `this account opened — already resolved, or never posted. ` +
            `Nothing to resolve. ${preStampCaveat}`,
        );
      }
    }
  }

  const post = {
    commit_id: payload.commit_id,
    event,
    body,
    comments: reviewComments,
  };

  const target = aoneWrite
    ? `a1 repo mr comment create --mr ${args.pr} --repo ${args.repo}` +
      ` (${finalComments.length} inline + summary` +
      (event === 'APPROVE' ? ' + a1 repo mr approve' : '') +
      `)`
    : `repos/${args.repo}/pulls/${args.pr}/reviews`;
  if (args.dryRun) {
    writeStderrLine(
      `Authorised (${auth.why}) and the payload is consistent. ` +
        `--dry-run: not posting.`,
    );
    writeStdoutLine(
      JSON.stringify(
        {
          posted: false,
          // A dry run whose gate could not run (missing capture) composes
          // the preview but reports the real post would refuse — the
          // reason distinguishes it from both a would-post and the
          // real write's exit-3 refusal shape.
          wouldPost: !anchorsUnchecked,
          ...(anchorsUnchecked ? { reason: 'aone-diff-missing' } : {}),
          target,
          event,
          cappedBy,
          floorEnforced: floorEnforced.length,
          ...(carriedReplies.length > 0
            ? { carriedRepliesPlanned: carriedReplies.length }
            : {}),
          ...(fixedResolves.length > 0
            ? { threadsResolvedPlanned: fixedResolves.length }
            : {}),
          // Aone-only gate counts — the GitHub server performs this
          // validation itself; the fields exist only where the gate ran.
          ...(aoneWrite && !anchorsUnchecked
            ? { anchorsRelocated, anchorsDiscarded }
            : {}),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (aoneWrite) {
    // The Aone posting path — one `a1 repo mr comment create` per inline
    // finding, the summary last, `a1 repo mr approve` on an APPROVE.
    // GitHub's Create Review is atomic; this is N+1 calls, so the failure
    // shapes differ: the provider throws AonePartialPostError when a write
    // fails mid-batch, and the report below names exactly what landed.
    let result: AoneSubmitResult;
    try {
      result = submitAoneReview({
        prNumber: args.pr,
        ownerRepo: args.repo,
        // The structural gate above refused a payload without one.
        commitId: payload.commit_id as string,
        event: event as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
        body,
        // The consistency gate above refused every comment lacking these;
        // the `??` defaults exist only for the type.
        comments: finalComments.map((c) => ({
          path: c.path ?? '',
          line: c.line ?? 0,
          body: c.body ?? '',
        })),
      });
    } catch (err) {
      const partial = err instanceof AonePartialPostError ? err : undefined;
      if (partial === undefined) {
        // Two shapes here. The DELIBERATE pre-write refusals (head drift,
        // oversized message) keep the exit-3 refusal shape: deterministic,
        // nothing landed, named in the skill's refusal-shape list.
        // EVERYTHING else — auth expiry, a DNS blip in the mr view read,
        // the 120 s deadline — is an ordinary command failure with
        // provably nothing landed: RETHROW it, the same shape the gh path
        // gives, so a recoverable blip is retryable instead of reading as
        // "a complete, correct outcome" and losing the authorised review.
        if (!((err as Error)?.message ?? '').startsWith('refusing to post:')) {
          throw err;
        }
        refuse(
          `REFUSED to post to ${args.repo}#${args.pr} on Aone Code: ` +
            `${(err as Error).message} Nothing was written; ` +
            `the findings are in the terminal output and the saved report.`,
          'aone-post-refused',
        );
      }
      // A mid-batch failure: part of the review IS on the MR. The JSON
      // carries the structured counts AonePartialPostError exists for —
      // `posted: false` alone would let a wrapper that retries on
      // "not posted" double-post everything that landed. `partial: true`
      // is the do-not-retry signal; the ids make "inspect the MR"
      // concrete. `ambiguous` counts as landed: the FAILED write may have
      // reached the server (accepted, then the transport died), so the MR
      // can carry a comment the count never saw — and it rides the stdout
      // JSON too: all-zero counts with a silent ambiguous flag read as a
      // clean total failure, and a user hand-posting the "remainder"
      // double-posts the comment the count never saw.
      // Vouch for the writes that DID land: cleanup still runs after this
      // failure (Step 9), and without the ids the tripwire would flag
      // submit's own partial post as a bypass. The ambiguous write has no
      // id to vouch with — it stays unvouched, and any flag it draws is
      // the "inspect the MR" this report asks for.
      recordAoneReceipt(args.pr, partial.inlineCommentIds, event);
      const landed =
        partial.postedInline > 0 || partial.summaryPosted || partial.ambiguous;
      writeStderrLine(
        `FAILED to post the review to ${args.repo}#${args.pr} on Aone ` +
          `Code: ${partial.message}` +
          (landed
            ? ` Part of the review may already be on the MR — do NOT ` +
              `re-run submit (it would post twice); inspect the MR. ` +
              `Posting any remainder is the USER's call to make by hand ` +
              `— it is never an agent action.`
            : ''),
      );
      if (partial.headMovedDuringPost) {
        // The same disclosure the success path prints — adding a write
        // failure must not silently remove it: the landed pins may
        // reference code the author already replaced, and the user
        // hand-posting the remainder must know.
        writeStderrLine(
          `WARNING: the MR head MOVED during posting — the comments ` +
            `that landed may reference code the author already replaced.`,
        );
      } else if (partial.headMovedDuringPost === undefined) {
        // The same unknown state the success path discloses — the
        // re-read dies in the same outage that killed the batch, so
        // this is the ordinary partial shape: the user hand-posting
        // the remainder must not read silence as "the landed pins
        // were verified against the live head".
        writeStderrLine(
          `WARNING: could not re-verify the MR head after the failed ` +
            `post — confirm the landed pins still anchor the live head ` +
            `before hand-posting the remainder.`,
        );
      }
      writeStdoutLine(
        JSON.stringify(
          {
            posted: false,
            reason: 'aone-post-failed',
            partial: true,
            postedInline: partial.postedInline,
            postedCommentIds: partial.inlineCommentIds,
            summaryPosted: partial.summaryPosted,
            ambiguous: partial.ambiguous,
          },
          null,
          2,
        ),
      );
      process.exitCode = 3;
      return;
    }
    // URL for the Posted line: the receipt's webUrl is the MR's own
    // detailUrl, captured by submitAoneReview's pre-write drift-gate read.
    // detailUrl is a stable attribute of the MR, so a re-query through the
    // reader's composeUrl cannot return a link that read lacked — it would
    // only pay a blocking a1 call (120 s deadline, transient retries) on
    // exactly the flaky-platform state that lost the field. '' stays '':
    // the skill relays the target's coordinates (and never assembles a
    // link — the nested-group owner/repo collapse could name a different
    // repo).
    const postedUrl = result.webUrl;
    writeStderrLine(
      `Posted ${event} to ${args.repo}#${args.pr} — ${auth.why}` +
        (cappedBy.length ? ` (capped by ${cappedBy.join(', ')})` : '') +
        '.' +
        (postedUrl ? ` ${postedUrl}` : ''),
    );
    if (event === 'REQUEST_CHANGES') {
      // D6: no native reject exists on Aone — the blocking header and any
      // unresolved inline Critical discussions carry the semantics a GitHub
      // REQUEST_CHANGES event carries natively. But a REQUEST_CHANGES can
      // post with ZERO inline Criticals (they were all body-level), and
      // then nothing mechanically blocks the merge — say which shape this
      // was, counted off the same comments the consistency gate marked.
      // The blocking GATE is named too: a1 cannot mark a comment as an AI
      // comment (probed 2026-08-21 on a scratch CR — no auto-flag for the
      // posting identity, no explicit flag; issue #9614), so the posted
      // comments sit in the generic discussion gate only, and a repo's
      // dedicated ai_comment merge gate never sees them. Until a1 ships a
      // flag, this note is the disclosure.
      const criticalsPosted = (payload.comments ?? []).filter(
        (c) => severityOf(c) === 'critical',
      ).length;
      writeStderrLine(
        criticalsPosted > 0
          ? `Note: Aone Code has no native request-changes state — the ` +
              `summary comment carries the blocking header, and the ` +
              `${criticalsPosted} inline Critical(s) block the merge ` +
              `while their discussions stay unresolved. They are NOT ` +
              `marked as AI comments — \`a1 repo mr comment create\` ` +
              `cannot set the flag — so they join the generic ` +
              `discussion gate only; a repo's dedicated ai_comment ` +
              `merge gate does not track them.`
          : `Note: Aone Code has no native request-changes state — the ` +
              `summary comment carries the blocking header, but this ` +
              `review posted NO inline Critical discussions, so nothing ` +
              `mechanically blocks the merge; the header is advisory.`,
      );
    }
    if (event === 'APPROVE' && !result.approved) {
      // Inline + summary are posted; only the native approval is missing.
      // The post stands — name the one command that completes it, and name
      // the USER as its actor: Step 7 forbids the agent every `a1` write,
      // and "run it by hand" without an actor would hand the agent the
      // exact call the rule exists to prevent.
      writeStderrLine(
        `WARNING: the review is posted but \`a1 repo mr approve ` +
          `${args.pr} --repo ${args.repo}\` failed` +
          (result.approveError ? ` (${result.approveError})` : '') +
          ` — ask the USER to run that command to complete the approval; ` +
          `it is never an agent action.`,
      );
    }
    if (result.headMovedDuringPost) {
      // The drift gate is check-then-post; an AGit-Flow amend pushed
      // DURING the (minutes-long) batch orphans every inline comment. The
      // post stands — disclose that the pins may not.
      writeStderrLine(
        `WARNING: the MR head MOVED during posting — the inline comments ` +
          `may reference code the author already replaced. Re-review the ` +
          `new head before relying on the posted pins.`,
      );
    } else if (result.headMovedDuringPost === undefined) {
      // The post-batch re-read FAILED — "could not verify" is not
      // "verified stable", and the success report must not claim the
      // pins held.
      writeStderrLine(
        `WARNING: could not re-verify the MR head after posting — ` +
          `confirm the pins still anchor the live head before relying ` +
          `on them.`,
      );
    }
    // Receipt for cleanup's Aone bypass audit — see recordAoneReceipt. An
    // accepted-but-unreadable comment carries no id (inlineCommentIds holds
    // only the ids a1 reported); it cannot be vouched for and may draw a
    // flag — the same trade-off the gh half makes on an unreadable review
    // id, fail-safe toward over-flagging.
    recordAoneReceipt(
      args.pr,
      [
        ...result.inlineCommentIds,
        ...(typeof result.summaryCommentId === 'number'
          ? [result.summaryCommentId]
          : []),
      ],
      event,
    );
    writeStdoutLine(
      JSON.stringify(
        {
          posted: true,
          event,
          cappedBy,
          inlineComments: result.postedInline,
          // The ids the success path reads back — the same audit the
          // partial shape surfaces and the gh path's receipt records.
          // Without them a successful run leaves nothing to reconcile
          // "what did this post" against the MR.
          postedCommentIds: result.inlineCommentIds,
          ...(result.summaryCommentId !== undefined
            ? { summaryCommentId: result.summaryCommentId }
            : {}),
          floorEnforced: floorEnforced.length,
          anchorsRelocated,
          anchorsDiscarded,
          summaryPosted: result.summaryPosted,
          ...(event === 'APPROVE' ? { approved: result.approved } : {}),
          ...(postedUrl ? { url: postedUrl } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }

  // Send the bytes we validated, over stdin — not the pathname. `--input <file>`
  // re-opens the file here, so another workspace process (or a symlink swap)
  // could replace or truncate it between the validation above and this call, and
  // GitHub would receive a payload that never passed the gate. `--input -` posts
  // exactly the object we parsed and checked. (Still `--input`, never `-f body=`,
  // so the body's newlines reach GitHub as newlines.)
  const response = ghWithInput(
    JSON.stringify(post),
    'api',
    target,
    '--input',
    '-',
  );
  // GitHub's answer, read best-effort: `id` feeds the bypass-audit receipt
  // below; `html_url` is the deep link to the review just created, surfaced in
  // both output channels so the summary the user reads can carry it — without
  // it, "view what was posted" means hand-assembling a PR URL.
  let reviewId: number | undefined;
  let reviewUrl: string | undefined;
  try {
    const parsed = JSON.parse(response) as { id?: number; html_url?: string };
    if (typeof parsed.id === 'number') reviewId = parsed.id;
    if (typeof parsed.html_url === 'string' && parsed.html_url.trim() !== '') {
      reviewUrl = parsed.html_url;
    }
  } catch {
    /* response metadata only — the post itself succeeded */
  }
  // No deep link in GitHub's answer (or an unparseable one): the provider
  // COMPOSES the PR-page URL — deterministic grammar, no API call, and the
  // host axis binds to the routing the write just took. This used to be a
  // prose assembly in the skill; the receipt carries it now. A hostless
  // corner fails CLOSED: the compose yields '' and this receipt stays
  // linkless rather than affirming a host the write may not have taken
  // (gh's own hosts.yml default is not visible here).
  reviewUrl ??= githubReader.composeUrl(args.pr, args.repo);
  // Receipt for cleanup's bypass audit: EVERY review this session was
  // authorised to create, by id. The audit lists reviews by the reviewing
  // account inside the window and flags any the receipt does not vouch for —
  // without the id, a bypass posted through `gh pr review` (a review, not an
  // issue comment) would be indistinguishable from the sanctioned one.
  //
  // The receipt ACCUMULATES ids rather than overwriting: the audit window
  // spans drift restarts (fetch-pr preserves `auditSince`), so two sanctioned
  // submits can fall in one window. A single-id receipt vouched only for the
  // last, and the earlier legitimate review was then flagged as a bypass —
  // a false positive for a write submit itself made. So read the prior ids,
  // add this one, dedupe, write back. Best-effort: a receipt failure must
  // never fail a review that DID post.
  try {
    if (typeof reviewId === 'number') {
      const receiptPath = tmpFile(`pr-${args.pr}`, 'submit-receipt.json');
      const priorIds = readReceiptIds(receiptPath, parseReceiptIds);
      const reviewIds = [...new Set([...priorIds, reviewId])];
      mkdirSync(REVIEW_TMP_DIR, { recursive: true });
      atomicWriteFileSync(
        receiptPath,
        `${JSON.stringify({
          ...readReceiptObject(receiptPath),
          reviewIds,
          event,
          postedAt: new Date().toISOString(),
        })}\n`,
      );
    }
  } catch {
    /* audit metadata only — the post itself succeeded */
  }
  writeStderrLine(
    `Posted ${event} to ${args.repo}#${args.pr} — ${auth.why}` +
      (cappedBy.length ? ` (capped by ${cappedBy.join(', ')})` : '') +
      '.' +
      (reviewUrl ? ` ${reviewUrl}` : ''),
  );
  // The thread bookkeeping, after the atomic verdict landed. Replies and
  // resolves are N independent calls — unlike the review, there is no
  // all-or-nothing — so each failure is named and counted, never silently
  // dropped and never fatal to the review that already posted. A failed
  // carried reply leaves the finding on the ledger marker (the next round
  // re-rules it); a failed fixed REPLY skips that thread's resolve too —
  // resolving without the `fixed by` note would close the thread with no
  // record of why.
  let carriedRepliesPosted = 0;
  let threadsResolved = 0;
  let threadActionFailures = 0;
  for (const reply of carriedReplies) {
    try {
      postReviewReply(args.repo, args.pr, reply.commentId, reply.body);
      carriedRepliesPosted++;
    } catch (err) {
      threadActionFailures++;
      writeStderrLine(
        `WARNING: carried reply into thread comment ${reply.commentId} ` +
          `failed: ${(err as Error).message} — the finding stays on the ` +
          `ledger and is re-ruled next round.`,
      );
    }
  }
  for (const resolve of fixedResolves) {
    try {
      postReviewReply(args.repo, args.pr, resolve.commentId, resolve.body);
    } catch (err) {
      threadActionFailures++;
      writeStderrLine(
        `WARNING: fixed-ruling reply into thread comment ` +
          `${resolve.commentId} failed: ${(err as Error).message} — the ` +
          `thread is left UNRESOLVED; resolve it by hand — a later round ` +
          `re-rules it only if the blocker re-check re-promotes the ` +
          `thread's root.`,
      );
      continue;
    }
    try {
      resolveReviewThread(resolve.threadId);
      threadsResolved++;
    } catch (err) {
      threadActionFailures++;
      writeStderrLine(
        `WARNING: resolveReviewThread(${resolve.threadId}) failed: ` +
          `${(err as Error).message} — the reply landed; resolve the ` +
          `thread by hand.`,
      );
    }
  }
  writeStdoutLine(
    JSON.stringify(
      {
        posted: true,
        event,
        cappedBy,
        inlineComments: post.comments.length,
        floorEnforced: floorEnforced.length,
        ...(carriedRepliesPosted > 0
          ? { carriedReplies: carriedRepliesPosted }
          : {}),
        ...(threadsResolved > 0 ? { threadsResolved } : {}),
        ...(threadActionFailures > 0 ? { threadActionFailures } : {}),
        ...(reviewUrl ? { url: reviewUrl } : {}),
      },
      null,
      2,
    ),
  );
}

export const submitCommand: CommandModule = {
  command: 'submit',
  describe:
    'Post the review to the pull request — GitHub via gh, Aone Code via a1 — the ONLY write in this skill. Refuses unless the run is authorised to publish.',
  builder: (yargs) =>
    yargs
      .option('pr', {
        type: 'number',
        demandOption: true,
        describe: 'PR number',
      })
      .option('repo', {
        type: 'string',
        demandOption: true,
        describe: '<owner>/<repo> to post to',
      })
      .option('review', {
        type: 'string',
        demandOption: true,
        describe:
          'Path to the review JSON (commit_id / comments / state). event and body are computed here from state and the comments — do not include them.',
      })
      .option('skill-args', {
        type: 'string',
        describe:
          "Path to the CLI-written record of the review's invocation arguments (defaults to .qwen/tmp/qwen-skill-args-review.txt). Its `--comment` — or the standing `review.comment` setting — is what authorises a post. Deliberately NOT the parser's JSON output: that is a document the caller writes, and a caller that wants to post can write anything in it.",
      })
      .option('user-authorized', {
        type: 'boolean',
        default: false,
        describe:
          'Pass ONLY when the user asked, in a message they typed this session, for this review to be published. Never infer it.',
      })
      .option('host', {
        type: 'string',
        describe:
          'The host the target lives on. SELECTS the platform the write lands on: a canonical Aone host (code.alibaba-inc.com or gitlab.alibaba-inc.com) routes the post at a1, anything else at gh (a GitHub Enterprise host routes gh via GH_HOST). It is also the remedy the target-platform-unbound refusal names.',
      })
      .option('dry-run', {
        type: 'boolean',
        default: false,
        describe: 'Check authorisation and payload consistency, then stop.',
      }),
  handler: async (argv) => {
    // Do not use CLI_VERSION here: esbuild replaces it with a build-time value.
    const cliVersion =
      footerVersion(process.env['QWEN_CODE_STARTUP_VERSION']) ??
      (await getCliVersion());
    const review = operatorReviewSettings();
    runSubmit(argv as unknown as SubmitArgs, cliVersion, {
      attribution: review.attribution,
      defaultComment: review.comment,
      defaultSeverityFloor: review.severityFloor,
    });
  },
};
