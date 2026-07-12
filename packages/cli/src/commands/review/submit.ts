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
import { gh, setGhHost } from './lib/gh.js';

interface SubmitArgs {
  pr: number;
  repo: string;
  review: string;
  parseArgs?: string;
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
  if (!args.parseArgs) {
    return {
      ok: false,
      why:
        'no --parse-args report was given, so this run cannot show that ' +
        '`--comment` was requested',
    };
  }
  let verdict: { comment?: { effective?: boolean } };
  try {
    verdict = JSON.parse(readFileSync(args.parseArgs, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      why: `--parse-args report ${args.parseArgs} could not be read (${
        (err as Error).message
      })`,
    };
  }
  if (verdict.comment?.effective === true) {
    return { ok: true, why: '`--comment` was in the review arguments' };
  }
  return {
    ok: false,
    why: '`--comment` was not in the review arguments (comment.effective is false)',
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

  const claimsInline = /\binline\b/i.test(payload.body ?? '');
  if (claimsInline && comments.length === 0) {
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
  // A literal backslash-n in the body means the JSON was built by shell string
  // interpolation (`-f body=...`) rather than written as JSON, and the footer
  // renders as `\n\n_— model_` instead of breaking the line.
  if ((payload.body ?? '').includes('\\n')) {
    problems.push(
      'the body contains a literal `\\n` — write the review JSON with a file, ' +
        'not with `-f body`, or the escapes survive into the posted text',
    );
  }
  comments.forEach((c, i) => {
    if (!c.path) problems.push(`comments[${i}] has no \`path\``);
    if (typeof c.line !== 'number') {
      problems.push(
        `comments[${i}] has no \`line\` — resolve its anchor first`,
      );
    }
    // A multi-line comment without both side fields is a 422 that takes the
    // whole review with it.
    if (typeof c.start_line === 'number') {
      if (c.side !== 'RIGHT' || c.start_side !== 'RIGHT') {
        problems.push(
          `comments[${i}] sets \`start_line\` without \`side\` and ` +
            `\`start_side\` — GitHub 422s the entire review`,
        );
      }
    }
  });
  return problems;
}

export function runSubmit(args: SubmitArgs): void {
  setGhHost(args.host);

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

  // `--input` so the body's newlines reach GitHub as newlines. Building the
  // request with `-f body=...` re-escapes them and the footer arrives as text.
  gh('api', target, '--input', args.review);
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
      .option('parse-args', {
        type: 'string',
        describe:
          "Path to Step 1's parse-args verdict. Its `comment.effective` is what authorises a post.",
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
