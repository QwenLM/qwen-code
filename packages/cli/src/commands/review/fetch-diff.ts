/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review fetch-diff`: write a PR's full unified diff to a file. This
// absorbs the lightweight-mode prose (`gh pr diff <n> --repo <o/r> > file`):
// redirecting through the subcommand keeps the host routing (`--host`) in
// code and gives the caller back the size facts it needs for paging
// decisions without a second read of the file.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CommandModule } from 'yargs';
import { isOwnerRepo, setGhHost } from './lib/gh.js';
import { getPlatformReader } from './lib/platform/registry.js';
import { assertWritableOutPath } from './lib/paths.js';
import {
  writeStdoutLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';

interface FetchDiffArgs {
  prNumber: number;
  repo: string;
  out: string;
}

export interface FetchDiffResult {
  diffPath: string;
  lines: number;
  chars: number;
}

export function runFetchDiff(args: FetchDiffArgs): FetchDiffResult {
  // Usage errors (a malformed --repo) precede the auth gate — `gh auth
  // login` can never fix the invocation, and exit 2 is the caller's
  // "repair the invocation" signal.
  if (!isOwnerRepo(args.repo)) {
    throw new TypeError(
      `expected owner/repo, got ${JSON.stringify(args.repo)}`,
    );
  }
  // An empty or directory --out resolves to the cwd or dies EISDIR AFTER the
  // fetch — classify it before fetching.
  assertWritableOutPath(args.out);
  const platform = getPlatformReader();
  platform.ensureAuthenticated();

  // ghRaw keeps the diff's trailing bytes; normalise exactly one trailing
  // newline so the written file ends cleanly without dropping content.
  const diff = platform.fetchDiff(args.prNumber, args.repo).replace(/\n+$/, '');

  const diffPath = resolve(args.out);
  mkdirSync(dirname(diffPath), { recursive: true });
  // An empty diff writes a 0-byte file — never '\n': plan-diff parses a
  // one-blank-line file as 1 diff line with zero files and dies with a
  // coverage-hole error instead of taking the designed empty-plan branch.
  // 'latin1' re-encodes each char code back to its byte — ghRaw's byte
  // fidelity holds end to end (a Latin-1/Shift-JIS diff survives intact).
  writeFileSync(diffPath, diff === '' ? '' : diff + '\n', 'latin1');

  return {
    diffPath,
    lines: diff === '' ? 0 : diff.split('\n').length,
    chars: diff.length,
  };
}

export const fetchDiffCommand: CommandModule = {
  command: 'fetch-diff <pr_number>',
  describe: "Write a PR's full unified diff to a file",
  builder: (yargs) =>
    yargs
      .positional('pr_number', {
        type: 'number',
        demandOption: true,
        describe: 'The PR number',
      })
      .option('repo', {
        type: 'string',
        demandOption: true,
        describe: 'The PR repository, owner/repo',
      })
      .option('host', {
        type: 'string',
        describe:
          'The PR host (GitHub Enterprise). Omitted: inherit GH_HOST, else github.com.',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Where to write the diff',
      }),
  handler: (argv) => {
    const prNumber = argv['pr_number'] as number | undefined;
    if (
      prNumber === undefined ||
      !Number.isInteger(prNumber) ||
      prNumber <= 0
    ) {
      writeStderrLineSafe(
        `fetch-diff: pr_number must be a positive integer, got ${JSON.stringify(argv['pr_number'])}`,
      );
      process.exitCode = 2;
      return;
    }
    const host = (argv as { host?: string }).host;
    try {
      setGhHost(host);
      const result = runFetchDiff({
        prNumber,
        repo: String(argv['repo']),
        out: String(argv['out']),
      });
      writeStdoutLine(JSON.stringify(result));
    } catch (err) {
      writeStderrLineSafe(`fetch-diff: ${(err as Error).message}`);
      process.exitCode = err instanceof TypeError ? 2 : 1;
    }
  },
};
