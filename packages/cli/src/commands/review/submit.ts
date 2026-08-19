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
  ghWithInput,
  isOwnerRepo,
  resolveGhHost,
  setGhHost,
} from './lib/gh.js';
import { REVIEW_TMP_DIR, tmpFile } from './lib/paths.js';
import { parseReceiptIds } from './lib/receipt.js';
import {
  composeReview,
  normalizeSeverityFloor,
  type ComposeReviewInput,
} from './compose-review.js';
import {
  recordedSeverityFloor,
  reviewWriteAuthorization,
} from './lib/authorization.js';
import { getPlatformReader, isAoneHost } from './lib/platform/registry.js';
import {
  CRITICAL_PREFIX,
  SUGGESTION_PREFIX,
  countInlineFindings,
  severityOf,
} from './lib/inline-counts.js';
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
 * Review ids a prior submit in this window already recorded. Best-effort: an
 * absent or unreadable receipt is an empty list, never a throw — the caller
 * adds the current id regardless. The shape parse is shared with cleanup's
 * reader (`lib/receipt.ts`) so the two halves cannot drift.
 */
function readReceiptIds(receiptPath: string): number[] {
  try {
    return parseReceiptIds(readFileSync(receiptPath, 'utf8'));
  } catch {
    return [];
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
  recordedHost?: string;
  recordedUnbound?: boolean;
} {
  return reviewWriteAuthorization({
    userAuthorized: args.userAuthorized,
    defaultComment,
    skillArgs: args.skillArgs,
    pr: args.pr,
    repo: args.repo,
    // The EFFECTIVE host, not merely the flag: with --host absent the gh
    // child inherits an operator-exported GH_HOST, so that is where this
    // write would route — and what the gate must bind.
    host: resolveGhHost(args.host),
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

function inconsistencies(
  payload: ReviewPayload,
  event: string,
  attribution: boolean,
): string[] {
  const problems: string[] = [];
  const comments = payload.comments ?? [];

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
    const at = `comments[${i}]`;
    if (!c.path) problems.push(`${at} has no \`path\``);
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
  });
  return problems;
}

export function runSubmit(
  args: SubmitArgs,
  cliVersion = 'unknown',
  opts: {
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
  } = {},
): void {
  const { attribution = true, defaultComment = false } = opts;
  setGhHost(args.host);

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
    // The advice must match the refusal class, or it misdirects the retry:
    // the gate refuses either because comment was never requested (its `why`
    // carries `` `--comment` was ``) or because nothing recorded authorises
    // this target — a binding miss, or no recorded arguments at all. The
    // second arm's preamble stays neutral ("Nothing recorded…") because a
    // setting-driven missing-args refusal lands here too, and "The recorded
    // arguments do not bind" would contradict its `why` ("no review
    // arguments were recorded"). `--comment` cannot fix the second class —
    // the flag stands in for nothing a target binding needs, and the
    // `review.comment` setting already stood in for the flag on exactly
    // those refusals — so advising it there buys the futile retry loop
    // authorization.ts's refusal wording exists to prevent.
    const advice = auth.why.includes('`--comment` was')
      ? `This is the correct outcome of a review the user did not ask to ` +
        `publish — report the findings in the terminal and stop. Re-run with ` +
        `\`--comment\`, or pass --user-authorized only after the user has ` +
        `asked, in a message they typed, for this review to be published.`
      : `Nothing recorded authorises binding this target — report the ` +
        `findings in the terminal and stop. Posting to this pull request ` +
        `needs a review invoked naming it, or --user-authorized after the ` +
        `user has asked, in a message they typed, for this review to be ` +
        `published.`;
    writeStderrLine(
      `REFUSED to post to ${args.repo}#${args.pr}: ${auth.why}.\n` +
        `Posting is a public, irreversible write, and this run has no ` +
        `authorisation for one. ${advice}`,
    );
    writeStdoutLine(
      JSON.stringify({ posted: false, reason: auth.why }, null, 2),
    );
    process.exitCode = 3;
    return;
  }

  // Posting is GitHub-only in this phase. On an Aone target the Create
  // Review API does not exist — refuse with the SAME shape as an
  // unauthorised refusal (stderr explanation, stdout `{"posted": false}`,
  // exit 3): the skill's Step 7 treats that shape as a complete, correct
  // outcome, and a throw instead would surface as a failed command an agent
  // might retry or route around. The refusal sits BELOW the authorisation
  // gate on purpose — an unauthorised Aone run takes the normal exit-3
  // path above, and the command no longer dies with a throw before the gate
  // can rule (an authorised Aone `--dry-run` lands on this same exit-3
  // refusal: a payload that can never post has no posting-consistency to
  // validate).
  //
  // The platform decision is bound in BOTH directions, because the
  // runtime-effective host alone fails both ways:
  //  - Recorded Aone target + non-Aone effective host (an ambient GH_HOST
  //    export beside a bare-MR-number Aone review) must still refuse —
  //    otherwise the read-only guarantee leaks and the review POSTs to the
  //    wrong host's same-named repo. So a recorded Aone host always
  //    refuses, whatever the environment resolves.
  //  - Recorded non-Aone target (pr-url host binding) must NOT be vetoed
  //    by the cwd probe from an Aone-origin clone — the recorded binding
  //    is the explicit signal the registry's precedence documents.
  //  - RECORDED but hostless (a bare-MR-number recording with no `--host`
  //    flag — the canonical Aone invocation shape carries no URL): the
  //    recording proves a review exists but not WHERE it lives, and the
  //    runtime environment cannot prove it either. For a public,
  //    irreversible write that is fail-CLOSED: refuse and name the remedy
  //    (`--host`), instead of trusting the environment and posting the
  //    review at github.com's same-named repo.
  //  - No recording at all: fall back to the flag, then GH_HOST (ghEnv
  //    inherits the operator's export when no module host is set, so an
  //    Aone-pointing GH_HOST must hit this refusal, not an opaque gh
  //    failure), then the cwd clone.
  // resolveGhHost trims, so a padded `--host` cannot slip past detection.
  // The findings are not lost: they are in the terminal output and the
  // saved report.
  const recordedHost = auth.recordedHost;
  const aoneWrite =
    isAoneHost(recordedHost) ||
    auth.recordedUnbound === true ||
    (recordedHost === undefined &&
      (isAoneHost(resolveGhHost(args.host)) ||
        getPlatformReader({ host: args.host?.trim() || undefined }).kind ===
          'aone'));
  if (aoneWrite) {
    writeStderrLine(
      `REFUSED to post to ${args.repo}#${args.pr}: posting review comments ` +
        `to Aone Code is not supported yet (read-only phase). The findings ` +
        `are in the terminal output and the saved report; post them ` +
        `manually or wait for the write phase.` +
        (auth.recordedUnbound === true && !isAoneHost(recordedHost)
          ? ` (the recorded target names no platform — pass \`--host\` to ` +
            `prove it is not an Aone MR)`
          : ''),
    );
    writeStdoutLine(
      JSON.stringify(
        { posted: false, reason: 'aone-read-only-phase' },
        null,
        2,
      ),
    );
    process.exitCode = 3;
    return;
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
    callerHost: resolveGhHost(args.host),
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
  try {
    ({ event, body, cappedBy, floorEnforced } = compose(
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
    payload = {
      ...payload,
      comments: (payload.comments ?? []).filter((_, i) => !drop.has(i)),
    };
    writeStderrLine(
      `Floor enforcement: ${floorEnforced.length} Suggestion comment(s) ` +
        `drafted past the resolved critical floor were moved into the ` +
        `body's deferral list and will not post inline.`,
    );
  }

  const problems = inconsistencies(payload, event, attribution);
  if (problems.length > 0) {
    throw new Error(
      `The review payload contradicts itself; refusing to post it:\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
  }

  // What GitHub actually receives: the caller's findings, under the verdict this
  // command computed. `event` and `body` were never in the object the caller wrote.
  const post = {
    commit_id: payload.commit_id,
    event,
    body,
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
    comments: attribution
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
        }),
  };

  const target = `repos/${args.repo}/pulls/${args.pr}/reviews`;
  if (args.dryRun) {
    writeStderrLine(
      `Authorised (${auth.why}) and the payload is consistent. ` +
        `--dry-run: not posting.`,
    );
    writeStdoutLine(
      JSON.stringify(
        {
          posted: false,
          wouldPost: true,
          target,
          event,
          cappedBy,
          floorEnforced: floorEnforced.length,
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
      const priorIds = readReceiptIds(receiptPath);
      const reviewIds = [...new Set([...priorIds, reviewId])];
      mkdirSync(REVIEW_TMP_DIR, { recursive: true });
      atomicWriteFileSync(
        receiptPath,
        `${JSON.stringify({ reviewIds, event, postedAt: new Date().toISOString() })}\n`,
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
  writeStdoutLine(
    JSON.stringify(
      {
        posted: true,
        event,
        cappedBy,
        inlineComments: post.comments.length,
        floorEnforced: floorEnforced.length,
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
    'Post the review to GitHub — the ONLY write in this skill. Refuses unless the run is authorised to publish.',
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
        describe: 'GitHub Enterprise host (routes gh via GH_HOST)',
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
