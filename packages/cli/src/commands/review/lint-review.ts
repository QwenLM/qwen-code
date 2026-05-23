/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review lint-review`: local validation of the JSON payload the LLM
// driver is about to POST to `gh api repos/{owner}/{repo}/pulls/<n>/reviews`.
// Catches the "test submission" pattern observed in the wild — weaker models
// were posting placeholder bodies (`"Test single comment submission"`,
// `"Test batch 1"`) as a way to dry-run the API shape. The GitHub Create
// Review endpoint has no real dry-run, so each test POST clutters the PR
// timeline with a public Review entry.
//
// The lint is purely local (no network) and runs from SKILL.md Step 9
// between "compose review JSON" and "submit via gh api". On any failure
// it exits non-zero with a list of problems so the LLM can fix and re-run
// the lint before actually POSTing.

import type { CommandModule } from 'yargs';
import { readFileSync } from 'node:fs';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { anchoredPath } from './lib/paths.js';

interface ReviewComment {
  path?: unknown;
  line?: unknown;
  body?: unknown;
}

interface ReviewPayload {
  commit_id?: unknown;
  event?: unknown;
  body?: unknown;
  comments?: unknown;
}

const VALID_EVENTS = new Set(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);

const PLACEHOLDER_BODY_PATTERNS: RegExp[] = [
  // Bodies that begin with "test" as a standalone word — covers
  // "Test single comment submission", "Test batch 1", "test 1", etc.
  /^\s*test\b/i,
  // Bodies that look like API exploration: very short, no markdown, no
  // mention of findings.
  /^\s*(check|ping|hello|hi|foo|bar|baz|sample|placeholder)\s*[.!?]?\s*$/i,
];

// Minimum body length when there are no inline comments. Below this we
// treat the submission as suspicious — real "no findings" approvals are
// at least ~30 chars (e.g. "No issues found. LGTM! ✅ _— X via Qwen Code /review_").
const MIN_BODY_LEN_WHEN_EMPTY_COMMENTS = 25;

function lintReview(payload: ReviewPayload): string[] {
  const problems: string[] = [];
  const body = typeof payload.body === 'string' ? payload.body : '';
  const comments = Array.isArray(payload.comments)
    ? (payload.comments as ReviewComment[])
    : [];

  // 1. event field
  if (typeof payload.event !== 'string' || !VALID_EVENTS.has(payload.event)) {
    problems.push(
      `event must be one of APPROVE / REQUEST_CHANGES / COMMENT (got: ${JSON.stringify(payload.event)})`,
    );
  }

  // 2. commit_id
  if (typeof payload.commit_id !== 'string' || payload.commit_id.length < 7) {
    problems.push(
      `commit_id must be a string SHA (got: ${JSON.stringify(payload.commit_id)})`,
    );
  }

  // 3. placeholder body — observed-in-the-wild "test submission" pattern.
  //    Reject before the POST so the public PR timeline never sees it.
  for (const pattern of PLACEHOLDER_BODY_PATTERNS) {
    if (pattern.test(body)) {
      problems.push(
        `body looks like a placeholder/test string (matched ${pattern}). The Create Review API has no dry-run — every POST is a public review. Re-compose with the real content.`,
      );
      break;
    }
  }

  // 4. Empty review entirely
  if (body.trim().length === 0 && comments.length === 0) {
    problems.push(
      'review has both an empty body and no inline comments — nothing to submit.',
    );
  }

  // 5. Short body with no inline comments — suspicious unless event=APPROVE
  //    with a substantive "no findings" message
  if (comments.length === 0 && body.trim().length < MIN_BODY_LEN_WHEN_EMPTY_COMMENTS) {
    problems.push(
      `body is ${body.trim().length} chars with no inline comments — likely a placeholder. Real "no findings" approvals include the footer "_— <model> via Qwen Code /review_" (>= ${MIN_BODY_LEN_WHEN_EMPTY_COMMENTS} chars).`,
    );
  }

  // 6. Per-comment lints
  comments.forEach((c, idx) => {
    if (typeof c !== 'object' || c === null) {
      problems.push(`comments[${idx}] is not an object`);
      return;
    }
    if (typeof c.path !== 'string' || c.path.length === 0) {
      problems.push(`comments[${idx}].path must be a non-empty string`);
    }
    if (typeof c.line !== 'number' || !Number.isFinite(c.line)) {
      problems.push(`comments[${idx}].line must be a number`);
    }
    const cBody = typeof c.body === 'string' ? c.body : '';
    if (cBody.trim().length === 0) {
      problems.push(`comments[${idx}].body is empty`);
      return;
    }
    if (!/via Qwen Code \/review/.test(cBody)) {
      problems.push(
        `comments[${idx}].body missing required footer "_— <model> via Qwen Code /review_" — SKILL.md Step 9 mandates this in every inline comment.`,
      );
    }
    for (const pattern of PLACEHOLDER_BODY_PATTERNS) {
      if (pattern.test(cBody)) {
        problems.push(
          `comments[${idx}].body looks like a placeholder/test string (matched ${pattern}). Re-compose with real content.`,
        );
        break;
      }
    }
  });

  return problems;
}

interface LintReviewArgs {
  review_json: string;
}

function runLintReview(args: LintReviewArgs): void {
  const path = anchoredPath(args.review_json);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `Failed to read review JSON at ${path}: ${(err as Error).message}`,
    );
  }
  let payload: ReviewPayload;
  try {
    payload = JSON.parse(raw) as ReviewPayload;
  } catch (err) {
    throw new Error(
      `Failed to parse review JSON at ${path}: ${(err as Error).message}`,
    );
  }

  const problems = lintReview(payload);
  if (problems.length === 0) {
    writeStdoutLine(`lint-review: OK (${path})`);
    return;
  }
  writeStderrLine(
    `lint-review: ${problems.length} problem(s) in ${path}:\n  - ${problems.join('\n  - ')}`,
  );
  // Throw so the yargs handler exits non-zero and the LLM driver sees the
  // failure before running the `gh api` POST that would have published the
  // bad review.
  throw new Error(
    `Refusing to certify ${path} for submission — see warnings above.`,
  );
}

export const lintReviewCommand: CommandModule = {
  command: 'lint-review <review_json>',
  describe:
    'Validate a Create Review JSON payload locally before posting via `gh api` — catches placeholder/test submissions and missing inline-comment footers.',
  builder: (yargs) =>
    yargs.positional('review_json', {
      type: 'string',
      demandOption: true,
      describe:
        'Path to the prepared Create Review JSON payload (e.g. .qwen/tmp/qwen-review-pr-<n>-review.json)',
    }),
  handler: (argv) => {
    runLintReview(argv as unknown as LintReviewArgs);
  },
};

/** @internal Exported for testing. */
export { lintReview };
