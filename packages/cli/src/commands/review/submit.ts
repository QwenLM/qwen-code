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
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { getCliVersion } from '../../utils/version.js';
import { ghWithInput, setGhHost } from './lib/gh.js';
import { REVIEW_TMP_DIR, tmpFile } from './lib/paths.js';
import { parseReceiptIds } from './lib/receipt.js';
import { composeReview, type ComposeReviewInput } from './compose-review.js';
import { reviewWriteAuthorization } from './lib/authorization.js';
import {
  CRITICAL_PREFIX,
  SUGGESTION_PREFIX,
  countInlineFindings,
  severityOf,
} from './lib/inline-counts.js';
import {
  REVIEW_FOOTER_RE,
  footerVersion,
  reviewFooter,
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
): ReviewComment[] {
  if (typeof modelId !== 'string' || modelId.trim() === '') return comments;
  const footer = reviewFooter(modelId, cliVersion);
  return comments.map((comment) =>
    // An empty body stays empty: this runs BEFORE the consistency check, and
    // a footer pasted onto '' would hide the emptiness from the refusal that
    // names it ('has no body — an empty comment').
    typeof comment.body === 'string' && comment.body.trim() !== ''
      ? {
          ...comment,
          body: `${comment.body.replace(REVIEW_FOOTER_RE, '')}\n\n${footer}`,
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
function authorization(args: SubmitArgs): { ok: boolean; why: string } {
  return reviewWriteAuthorization({
    userAuthorized: args.userAuthorized,
    skillArgs: args.skillArgs,
    pr: args.pr,
    repo: args.repo,
    // The EFFECTIVE host, not merely the flag: with --host absent the gh
    // child inherits an operator-exported GH_HOST, so that is where this
    // write would route — and what the gate must bind. Same resolution as
    // publish-assets.
    // `|| undefined`, not `??`: an exported-but-empty GH_HOST ("" survives
    // `??`, being non-nullish) must read as "no host", not as a host named
    // "" that fails every comparison.
    host: args.host ?? (process.env['GH_HOST']?.trim() || undefined),
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
): {
  event: string;
  body: string;
  cappedBy: string[];
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
  );
  return { event: r.event, body: r.body, cappedBy: r.cappedBy };
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

function inconsistencies(payload: ReviewPayload, event: string): string[] {
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

/**
 * `owner/repo` — and neither half may be a dot segment.
 *
 * The character class alone admits `../repo`, `owner/..` and `./repo`: `.` and
 * `..` are made of legal characters and mean something else entirely once they
 * reach a URL path.
 */
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;
function isRepo(repo: string): boolean {
  const parts = repo.split('/');
  return (
    parts.length === 2 &&
    parts.every((p) => REPO_SEGMENT.test(p) && p !== '.' && p !== '..')
  );
}

export function runSubmit(args: SubmitArgs, cliVersion = 'unknown'): void {
  setGhHost(args.host);

  // The repo goes straight into the API path. A malformed value does not fail
  // safely — it fails as a confusing 404 from a URL nobody meant to build.
  if (!isRepo(args.repo)) {
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

  const auth = authorization(args);
  if (!auth.ok) {
    // Not an error the caller can retry around — a refusal it must accept. The
    // findings are not lost: they are in the terminal output and the saved
    // report, and the user can ask for them to be posted.
    writeStderrLine(
      `REFUSED to post to ${args.repo}#${args.pr}: ${auth.why}.\n` +
        `Posting is a public, irreversible write, and this run has no ` +
        `authorisation for one. This is the correct outcome of a review the ` +
        `user did not ask to publish — report the findings in the terminal and ` +
        `stop. Re-run with \`--comment\`, or pass --user-authorized only after ` +
        `the user has asked, in a message they typed, for this review to be ` +
        `published.`,
    );
    writeStdoutLine(
      JSON.stringify({ posted: false, reason: auth.why }, null, 2),
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
    ),
  };

  // The verdict, computed here. It was never in the payload.
  let event: string;
  let body: string;
  let cappedBy: string[];
  try {
    ({ event, body, cappedBy } = compose(payload, cliVersion));
  } catch (err) {
    throw new Error(
      `The review state does not compose into a verdict; refusing to post:\n` +
        `  - ${(err as Error).message}`,
    );
  }

  const problems = inconsistencies(payload, event);
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
    comments: payload.comments ?? [],
  };

  const target = `repos/${args.repo}/pulls/${args.pr}/reviews`;
  if (args.dryRun) {
    writeStderrLine(
      `Authorised (${auth.why}) and the payload is consistent. ` +
        `--dry-run: not posting.`,
    );
    writeStdoutLine(
      JSON.stringify(
        { posted: false, wouldPost: true, target, event, cappedBy },
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
    const reviewId = (JSON.parse(response) as { id?: number }).id;
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
      '.',
  );
  writeStdoutLine(
    JSON.stringify(
      {
        posted: true,
        event,
        cappedBy,
        inlineComments: post.comments.length,
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
          "Path to the CLI-written record of the review's invocation arguments (defaults to .qwen/tmp/qwen-skill-args-review.txt). Its `--comment` is what authorises a post. Deliberately NOT the parser's JSON output: that is a document the caller writes, and a caller that wants to post can write anything in it.",
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
    runSubmit(argv as unknown as SubmitArgs, cliVersion);
  },
};
