/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review post-suggestions`: publish /review Step 9 Suggestion-level
// findings as a SINGLE updatable issue comment on the PR thread, instead of
// one per-line inline review comment.
//
// Why an updatable issue comment rather than inline review comments:
// Suggestion-level findings are "recommended improvements" — they don't
// block the merge and are best treated as a living, per-PR list that each
// /review run refreshes. Inline comments create a persistent conversation
// thread per line that the PR author (especially an agentic author) feels
// pressured to resolve one-by-one, so the PR's "Files changed" view grows
// noisier every round and the issues never converge. An issue comment can
// be PATCHed in place across runs, so the Suggestion list stays a single,
// refreshable view rather than an ever-growing pile of threads. Only
// Critical findings become inline comments (see SKILL.md Step 9).

import type { CommandModule } from 'yargs';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { gh, ghApiAll, currentUser, ensureAuthenticated } from './lib/gh.js';

export interface IssueComment {
  id: number;
  user?: { login: string };
  body?: string;
}

interface PostSuggestionsArgs {
  pr_number: string;
  owner_repo: string;
  'body-file': string;
  out: string;
}

/**
 * HTML-comment marker embedded at the top of every suggestion summary body.
 * Used to locate the existing summary comment so it can be updated in place
 * rather than re-posted on every /review run.
 */
export const SUMMARY_MARKER = '<!-- qwen-review-suggestion-summary -->';

/**
 * Find the most recent suggestion-summary comment authored by `meLogin`.
 *
 * Pure and side-effect free so it can be unit tested without `gh`. GitHub
 * assigns comment ids monotonically, so the highest id among matching
 * comments is the latest.
 */
export function findExistingSummary(
  comments: IssueComment[],
  meLogin: string,
): IssueComment | null {
  const normalized = meLogin.toLowerCase();
  let match: IssueComment | null = null;
  for (const c of comments) {
    const author = (c.user?.login ?? '').toLowerCase();
    if (author !== normalized) continue;
    if (!(c.body ?? '').includes(SUMMARY_MARKER)) continue;
    if (match === null || c.id > match.id) match = c;
  }
  return match;
}

async function runPostSuggestions(args: PostSuggestionsArgs): Promise<void> {
  const {
    pr_number: prNumber,
    owner_repo: ownerRepo,
    'body-file': bodyFile,
    out,
  } = args;
  const slash = ownerRepo.indexOf('/');
  if (slash < 0) {
    throw new Error('owner_repo must look like "owner/repo"');
  }
  const owner = ownerRepo.slice(0, slash);
  const repo = ownerRepo.slice(slash + 1);

  ensureAuthenticated();

  const bodyContent = readFileSync(bodyFile, 'utf8');
  const payload = JSON.stringify({ body: bodyContent });

  // Stream the payload from a file so gh --input handles multi-line markdown
  // bodies without arg-length or quoting issues. The payload file sits next
  // to `out` so it inherits the per-target temp prefix and is swept by
  // `qwen review cleanup`.
  const payloadPath = `${out}.payload.json`;
  writeFileSync(payloadPath, payload, 'utf8');

  const me = currentUser();
  const comments = ghApiAll(
    `repos/${owner}/${repo}/issues/${prNumber}/comments`,
  ) as IssueComment[];

  const existing = findExistingSummary(comments, me);

  let commentId: number;
  let action: 'updated' | 'created';

  try {
    if (existing) {
      const raw = gh(
        'api',
        `repos/${owner}/${repo}/issues/comments/${existing.id}`,
        '--method',
        'PATCH',
        '--input',
        payloadPath,
      );
      commentId = (JSON.parse(raw) as { id: number }).id;
      action = 'updated';
    } else {
      const raw = gh(
        'api',
        `repos/${owner}/${repo}/issues/${prNumber}/comments`,
        '--method',
        'POST',
        '--input',
        payloadPath,
      );
      commentId = (JSON.parse(raw) as { id: number }).id;
      action = 'created';
    }
  } finally {
    unlinkSync(payloadPath);
  }

  writeFileSync(
    out,
    JSON.stringify({ commentId, action }, null, 2) + '\n',
    'utf8',
  );
  writeStdoutLine(
    `Suggestion summary ${action} (comment ${commentId}). Wrote report to ${out}`,
  );
}

export const postSuggestionsCommand: CommandModule = {
  command: 'post-suggestions <pr_number> <owner_repo>',
  describe:
    'Publish /review Suggestion-level findings as a single updatable issue comment (updated in place across runs, not re-posted)',
  builder: (yargs) =>
    yargs
      .positional('pr_number', {
        type: 'string',
        demandOption: true,
        describe: 'PR number',
      })
      .positional('owner_repo', {
        type: 'string',
        demandOption: true,
        describe: 'GitHub "owner/repo"',
      })
      .option('body-file', {
        type: 'string',
        demandOption: true,
        describe:
          'Path to the Markdown body for the suggestion summary (must begin with the summary marker)',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe:
          'Output JSON path — {commentId, action} (will be overwritten)',
      }),
  handler: async (argv) => {
    await runPostSuggestions(argv as unknown as PostSuggestionsArgs);
  },
};
