/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review meta`: the PR/repo identity facts the skill used to derive
// with prose `gh` commands — `gh repo view --json owner,name,url` for a bare
// PR number's owner/repo+host, and `gh pr view --json headRefOid` for the
// live head SHA (Step 7's post target and the 422 head-drift check). One
// JSON object on stdout; the caller never names a `gh` invocation.
//
// With no positional number: resolve the repository only. With one: also
// answer that PR's head SHA and canonical web URL.

import type { CommandModule } from 'yargs';
import { resolveGhHost, setGhHost } from './lib/gh.js';
import { getPlatformReader } from './lib/platform/registry.js';
import {
  writeStdoutLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';

interface MetaArgs {
  prNumber?: number;
  repo?: string;
  host?: string;
}

export interface MetaResult {
  platform: string;
  host: string;
  ownerRepo: string;
  number?: number;
  headSha?: string;
  webUrl?: string;
}

export function runMeta(args: MetaArgs): MetaResult {
  const platform = getPlatformReader();
  platform.ensureAuthenticated();

  let host: string;
  let ownerRepo: string;
  if (args.repo !== undefined) {
    // Explicit repo: the host comes from the flag/env, defaulting to
    // github.com — there is no URL to derive it from.
    ownerRepo = args.repo;
    host = resolveGhHost(args.host) ?? 'github.com';
  } else {
    const id = platform.resolveRepo();
    ownerRepo = `${id.owner}/${id.repo}`;
    host = id.host;
  }

  const result: MetaResult = { platform: platform.kind, host, ownerRepo };
  if (args.prNumber !== undefined) {
    const meta = platform.getPrMeta(args.prNumber, ownerRepo);
    result.number = meta.number;
    result.headSha = meta.headSha;
    result.webUrl = meta.webUrl;
  }
  return result;
}

export const metaCommand: CommandModule = {
  command: 'meta [pr_number]',
  describe:
    'Print the review platform identity facts for this repository (and, with a PR number, its live head SHA and URL) as one JSON object',
  builder: (yargs) =>
    yargs
      .positional('pr_number', {
        type: 'number',
        describe:
          'A PR number — adds its live headSha and webUrl to the output',
      })
      .option('repo', {
        type: 'string',
        describe:
          'owner/repo — skips the cwd repository resolution (a bare number resolves through the upstream of a fork clone)',
      })
      .option('host', {
        type: 'string',
        describe:
          'The PR host (GitHub Enterprise). Omitted: inherit GH_HOST, else github.com.',
      }),
  handler: (argv) => {
    const prNumber = argv['pr_number'] as number | undefined;
    if (
      prNumber !== undefined &&
      (!Number.isInteger(prNumber) || prNumber <= 0)
    ) {
      writeStderrLineSafe(
        `meta: pr_number must be a positive integer, got ${JSON.stringify(argv['pr_number'])}`,
      );
      process.exitCode = 2;
      return;
    }
    const host = (argv as { host?: string }).host;
    try {
      setGhHost(host);
      const result = runMeta({
        prNumber,
        repo: (argv as { repo?: string }).repo,
        host,
      });
      writeStdoutLine(JSON.stringify(result));
    } catch (err) {
      writeStderrLineSafe(`meta: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  },
};
