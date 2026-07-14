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

import type { CommandModule } from 'yargs';
import { readFileSync } from 'node:fs';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { ghWithInput, setGhHost } from './lib/gh.js';
import { parseReviewArgs } from './parse-args.js';
import {
  skillArgsPath,
  currentSessionId,
} from '../../services/skill-args-file.js';

/**
 * Where the CLI records a skill's invocation arguments, verbatim, before the
 * skill's prompt reaches the model.
 *
 * Derived, not duplicated. A literal here would say "kept in step with
 * `skill-args-file.ts`" and nothing would keep it: rename the file there and the
 * gate silently stops finding the authorisation and refuses every post.
 */
// Derived from the session id at call time, not a constant: the args file is
// named for the session that wrote it, and `submit` (a subprocess of that
// session) reads the same name from the same inherited `QWEN_CODE_SESSION_ID`.
function defaultSkillArgsPath(): string {
  return skillArgsPath('review');
}

/** The only events GitHub's Create Review API accepts. */
const EVENTS = new Set(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);

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

interface ReviewPayload {
  commit_id?: string;
  event?: string;
  body?: string;
  comments?: Array<{
    path?: string;
    line?: number;
    start_line?: number;
    side?: string;
    start_side?: string;
    body?: string;
  }>;
}

/**
 * Was this run authorised to write to the pull request?
 *
 * Exactly two things authorise it, and both are facts rather than impressions:
 * `--comment` in the arguments the user typed (which `parse-args` resolved into
 * `comment.effective`), or `--user-authorized`, which the skill may pass only
 * after the user asked for this review to be published in a message they typed
 * this session.
 */
function authorization(args: SubmitArgs): { ok: boolean; why: string } {
  if (args.userAuthorized) {
    return { ok: true, why: 'the user asked for this review to be published' };
  }

  // Read what the **user typed**, and parse it here.
  //
  // The obvious design — take the parser's JSON verdict and read
  // `comment.effective` out of it — hands the gate a document the caller wrote.
  // A model that wants to post can write `{"comment":{"effective":true}}` to any
  // file and point at it, and the gate opens. It is not a hypothetical: this
  // exact weakness was raised by a review of this very change, and confirmed
  // against the built CLI in one line.
  //
  // The argument string is different in kind. The CLI writes it, verbatim,
  // before the skill's prompt ever reaches the model — nothing between the user's
  // keystrokes and this file has an opinion. So the gate reads *that*, and runs
  // the same tested parser on it. Forging authorisation now means forging the
  // user's own input, which is not something a careless run does by accident.
  // The session-scoped path is derived here, from the environment, on both the
  // write and read sides — the model never names it. `--skill-args` is a test
  // seam only (there is no session id under vitest); honouring a caller-supplied
  // path in a real run would hand the gate back the model-writable file the whole
  // design removed, so it is ignored whenever a session id is present.
  const sessionScoped = defaultSkillArgsPath();
  const path =
    currentSessionId() === '' && args.skillArgs
      ? args.skillArgs
      : sessionScoped;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // No args file means no arguments — which means no `--comment`. Fail closed:
    // a missing authorisation record is not an absent objection.
    return {
      ok: false,
      why:
        `no review arguments were recorded at ${path}, so this run cannot ` +
        'show that `--comment` was requested',
    };
  }

  const verdict = parseReviewArgs(raw);
  if (!verdict.comment.effective) {
    return {
      ok: false,
      why:
        '`--comment` was not in the review arguments ' +
        `(${JSON.stringify(raw.trim())})`,
    };
  }

  // Authorisation is for a *target*, not a mood. `/review 6771 --comment`
  // authorises a write to pull request 6771 — and to nothing else. Without this
  // check the flag is a bearer token: a dry run confirmed that arguments naming
  // 6771 happily authorised a submission to `--pr 9999 --repo other/repo`, so a
  // stale args file, or a target swapped anywhere between Step 1 and Step 7,
  // could put a review on a pull request the user never named.
  const t = verdict.target;
  const authorisedPr =
    t.type === 'pr-number' || t.type === 'pr-url' ? t.number : undefined;
  if (authorisedPr === undefined) {
    return {
      ok: false,
      why:
        `the review arguments (${JSON.stringify(raw.trim())}) do not name a ` +
        'pull request, so they cannot authorise posting to one',
    };
  }
  if (authorisedPr !== args.pr) {
    return {
      ok: false,
      why:
        `the review arguments authorise pull request #${authorisedPr}, but ` +
        `this submission targets #${args.pr}`,
    };
  }
  if (t.type === 'pr-url') {
    const authorisedRepo = `${t.owner}/${t.repo}`;
    if (authorisedRepo.toLowerCase() !== args.repo.toLowerCase()) {
      return {
        ok: false,
        why:
          `the review arguments authorise ${authorisedRepo}, but this ` +
          `submission targets ${args.repo}`,
      };
    }
    if (args.host && t.host.toLowerCase() !== args.host.toLowerCase()) {
      return {
        ok: false,
        why:
          `the review arguments authorise ${t.host}, but this submission ` +
          `targets ${args.host}`,
      };
    }
  }

  return {
    ok: true,
    why: `\`--comment\` was in the review arguments for #${authorisedPr}`,
  };
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
function inconsistencies(payload: ReviewPayload): string[] {
  const problems: string[] = [];
  const comments = payload.comments ?? [];

  if (!payload.commit_id) problems.push('`commit_id` is missing');
  if (!payload.event) problems.push('`event` is missing');
  else if (!EVENTS.has(payload.event)) {
    problems.push(
      `\`event\` is ${JSON.stringify(payload.event)}; GitHub accepts only ` +
        `${[...EVENTS].join(', ')}`,
    );
  }

  // The exact sentence `compose-review` writes when it puts findings inline —
  // not the word "inline" anywhere in the body. A body IS finding text: an
  // unmappable Critical reading "the inline cache is stale" is a real blocker,
  // and a `/\binline\b/` search refuses to post it. The check exists to catch a
  // body that *promises* comments it did not bring, so look for the promise.
  const promisesInline = /\b(are|is) inline\b/i.test(payload.body ?? '');
  if (promisesInline && comments.length === 0) {
    problems.push(
      'the body says findings are inline, but `comments` is empty — the ' +
        'author would be told to look for comments that do not exist',
    );
  }
  if (payload.event === 'COMMENT' && !payload.body && comments.length === 0) {
    problems.push(
      'a COMMENT event with no body and no comments is rejected by GitHub and ' +
        'would lose the review entirely',
    );
  }
  // The escaped footer, which is the fingerprint of a body built by shell string
  // interpolation (`-f body=...`) instead of written as JSON: the newlines before
  // `_— <model> via Qwen Code /review_` arrive as the two literal characters
  // backslash-n and the footer lands mid-sentence. The breaching dogfood run
  // posted exactly this.
  //
  // Deliberately not a bare search for `\n` anywhere in the body. A body may
  // legitimately carry one — an unmappable Critical whose description quotes a
  // regex (`/\n/`) or an escaped string is exactly the finding text this field
  // exists to hold — and a false positive here does not warn, it **refuses the
  // post**, which loses a review that had a real blocker in it. Match the bug's
  // actual signature, not a character that resembles it.
  if (/\\n\s*(\\n)?\s*_—/.test(payload.body ?? '')) {
    problems.push(
      'the footer is preceded by a literal `\\n` — the body was built with ' +
        '`-f body=` (or another shell interpolation) instead of written as ' +
        'JSON, so its newlines will be posted as text',
    );
  }
  // Everything below is a shape GitHub 422s — and a 422 is all-or-nothing, so
  // each of these discards every blocker in the review along with itself. The
  // API is the wrong place to find out.
  comments.forEach((c, i) => {
    const at = `comments[${i}]`;
    if (!c.path) problems.push(`${at} has no \`path\``);
    if (!c.body) problems.push(`${at} has no \`body\` — an empty comment`);

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

export function runSubmit(args: SubmitArgs): void {
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

  const problems = inconsistencies(payload);
  if (problems.length > 0) {
    throw new Error(
      `The review payload contradicts itself; refusing to post it:\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
  }

  const target = `repos/${args.repo}/pulls/${args.pr}/reviews`;
  if (args.dryRun) {
    writeStderrLine(
      `Authorised (${auth.why}) and the payload is consistent. ` +
        `--dry-run: not posting.`,
    );
    writeStdoutLine(
      JSON.stringify(
        { posted: false, wouldPost: true, target, event: payload.event },
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
  ghWithInput(JSON.stringify(payload), 'api', target, '--input', '-');
  writeStderrLine(
    `Posted ${payload.event} to ${args.repo}#${args.pr} — ${auth.why}.`,
  );
  writeStdoutLine(
    JSON.stringify(
      {
        posted: true,
        event: payload.event,
        inlineComments: (payload.comments ?? []).length,
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
          'Path to the review JSON (commit_id / event / body / comments), as composed by `compose-review`',
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
  handler: (argv) => {
    runSubmit(argv as unknown as SubmitArgs);
  },
};
