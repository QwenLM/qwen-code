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
// every name on stdout, exit 2; picking among them is not this command's
// call, and the review stops rather than guesses (the same rule the prose
// had). Not a git repository, or git unavailable — exit 1, fail closed like
// the other gates.

import type { CommandModule } from 'yargs';
import { git, gitOpt } from './lib/git.js';
import { matchRemotes } from './lib/remote-match.js';
import {
  writeStdoutLineSafe,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';

interface MatchRemoteArgs {
  owner: string;
  repo: string;
  host: string;
}

export function runMatchRemote(args: MatchRemoteArgs): void {
  const insideWorkTree = gitOpt('rev-parse', '--is-inside-work-tree');
  if (insideWorkTree !== 'true') {
    writeStderrLineSafe(
      'match-remote: not inside a git repository — cannot resolve a remote.',
    );
    process.exitCode = 1;
    return;
  }

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
    host: args.host,
  });

  if (matched.length === 1) {
    writeStdoutLineSafe(matched[0]);
    return;
  }

  if (matched.length === 0) {
    writeStdoutLineSafe('none');
    writeStderrLineSafe(
      `match-remote: no remote matches ${args.host}/${args.owner}/${args.repo} ` +
        'by exact host + owner/repo equality — the PR is not served by any ' +
        'remote of this repository.',
    );
    process.exitCode = 6;
    return;
  }

  for (const name of matched) {
    writeStdoutLineSafe(name);
  }
  writeStderrLineSafe(
    `warning: ${matched.length} remotes match ${args.host}/${args.owner}/${args.repo} ` +
      `(${matched.join(', ')}); refusing to pick one — the review stops here.`,
  );
  process.exitCode = 2;
}

export const matchRemoteCommand: CommandModule = {
  command: 'match-remote',
  describe:
    'Print the git remote whose URL matches an owner/repo by exact host + owner/repo equality (exit 6 when none, exit 2 when several)',
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
        default: 'github.com',
        describe:
          "The PR URL's host (GitHub Enterprise passes its own; bare PR numbers stay on github.com)",
      }),
  handler: (argv) => {
    runMatchRemote({
      owner: String(argv['owner']),
      repo: String(argv['repo']),
      host: String(argv['host']),
    });
  },
};
