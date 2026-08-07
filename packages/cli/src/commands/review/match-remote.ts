/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review match-remote`: which local git remote serves a PR's
// owner/repo. Step 1 of /review needs this twice — to decide whether a
// `pr-url` target gets the worktree flow or lightweight mode, and to pick
// the fetch remote for a bare PR number — and the rule used to live in the
// prompt as prose, where it shipped a substring match (review one repo, post
// to another) and hand-guessed remotes. The rule is now exact-segment
// equality, tested here, and the orchestrator only relays the outcome.
//
// Outcomes: exactly one matching remote — its name on stdout, exit 0. No
// match — `none` on stdout, exit 6 (the lightweight-mode signal). Several —
// every name on stdout, exit 7; picking among them is not this command's
// call, and the review stops rather than guesses (the same rule the prose
// had). 7, not 2 — 2 stays reserved for shell-level misuse, like run's
// 3-not-2 choice. Not a git repository, or git unavailable — exit 1, fail
// closed like the other gates.

import type { CommandModule } from 'yargs';
import { resolveGhHost } from './lib/gh.js';
import { git } from './lib/git.js';
import { matchRemotes } from './lib/remote-match.js';
import {
  writeStdoutLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';

interface MatchRemoteArgs {
  owner: string;
  repo: string;
  /** Absent means inherit an operator-exported GH_HOST, else github.com. */
  host?: string;
}

export function runMatchRemote(args: MatchRemoteArgs): void {
  // The gate is "git works here", not "this is a work tree": a bare clone
  // (mirror/CI-style checkout) serves the whole flow — `git remote -v`,
  // fetch-pr's fetch, and `git worktree add` all succeed inside one — so
  // `--is-inside-work-tree` printing `false` must not stop the review.
  // Failure means git itself refused the repository — carry its fatal to
  // stderr (a fixed two-cause guess misreports container CI's `dubious
  // ownership` refusals) and fail closed.
  try {
    git('rev-parse', '--is-inside-work-tree');
  } catch (err) {
    writeStderrLineSafe(
      `match-remote: git cannot resolve this repository: ${
        (err as Error).message
      }`,
    );
    process.exitCode = 1;
    return;
  }

  // resolveGhHost leaves the default to the caller; the matcher's
  // comparison needs a concrete host.
  const host = resolveGhHost(args.host) ?? 'github.com';

  let remoteV: string;
  try {
    remoteV = git('remote', '-v');
  } catch (err) {
    writeStderrLineSafe(
      `match-remote: \`git remote -v\` failed: ${(err as Error).message}`,
    );
    process.exitCode = 1;
    return;
  }

  const { matched } = matchRemotes(remoteV, {
    owner: args.owner,
    repo: args.repo,
    host,
  });

  // Loud `writeStdoutLine`, not the `*Safe` variant: this line is the
  // command's load-bearing result. If the write fails, the orchestrator
  // must see a non-zero exit (fail-closed), not exit 0 with empty output.
  if (matched.length === 1) {
    writeStdoutLine(matched[0]);
    return;
  }

  if (matched.length === 0) {
    writeStdoutLine('none');
    writeStderrLineSafe(
      `match-remote: no remote matches ${host}/${args.owner}/${args.repo} ` +
        'by exact host + owner/repo equality — the PR is not served by any ' +
        'remote of this repository.',
    );
    process.exitCode = 6;
    return;
  }

  for (const name of matched) {
    writeStdoutLine(name);
  }
  writeStderrLineSafe(
    `warning: ${matched.length} remotes match ${host}/${args.owner}/${args.repo} ` +
      `(${matched.join(', ')}); refusing to pick one — the review stops here.`,
  );
  process.exitCode = 7;
}

export const matchRemoteCommand: CommandModule = {
  command: 'match-remote',
  describe:
    'Print the git remote whose URL matches an owner/repo by exact host + owner/repo equality (exit 6 when none, exit 7 when several)',
  builder: (yargs) =>
    yargs
      .option('owner', {
        type: 'string',
        demandOption: true,
        describe: 'The repository owner (from the PR URL, or `gh repo view`)',
      })
      .option('repo', {
        type: 'string',
        demandOption: true,
        describe: 'The repository name',
      })
      .option('host', {
        type: 'string',
        describe:
          "The PR's host — from its URL, or from `gh repo view` for a bare number (omitted: inherit an operator-exported GH_HOST, else github.com)",
      }),
  handler: (argv) => {
    runMatchRemote({
      owner: String(argv['owner']),
      repo: String(argv['repo']),
      host: (argv as { host?: string }).host,
    });
  },
};
