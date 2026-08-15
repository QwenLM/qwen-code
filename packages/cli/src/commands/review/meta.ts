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
import {
  HOSTNAME_RE,
  isOwnerRepo,
  resolveGhHost,
  setGhHost,
} from './lib/gh.js';
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
  // Usage errors (a malformed --repo) must surface before the auth gate:
  // `gh auth login` can never fix the invocation, and exit 2 is the
  // caller's "repair the invocation" signal.
  if (args.repo !== undefined && !isOwnerRepo(args.repo)) {
    throw new TypeError(
      `expected owner/repo, got ${JSON.stringify(args.repo)}`,
    );
  }
  const platform = getPlatformReader();
  platform.ensureAuthenticated();

  let host: string;
  let ownerRepo: string;
  if (args.repo !== undefined) {
    // Explicit repo: the host comes from the flag/env, defaulting to
    // github.com — there is no URL to derive it from. Gate it the same way
    // the discovery branch does: `resolveGhHost` also reads the GH_HOST env
    // and never validates, so an unroutable env value (underscore intranet
    // alias) must not be emitted as the host label while every sibling
    // rejects it when welded back as --host. An env-sourced failure is
    // environmental (exit 1), a --host typo was already classified exit 2 by
    // the handler's own setGhHost.
    ownerRepo = args.repo;
    host = resolveGhHost(args.host) ?? 'github.com';
    if (!HOSTNAME_RE.test(host)) {
      throw new Error(
        `cannot route at the ${
          args.host !== undefined ? '--host flag' : 'GH_HOST environment'
        } ${JSON.stringify(host)} — not a hostname the review subcommands accept`,
      );
    }
  } else {
    const id = platform.resolveRepo();
    ownerRepo = `${id.owner}/${id.repo}`;
    host = id.host;
    // The discovered host is a label only until it routes: with several gh
    // auths (github.com + an Enterprise login) a bare `gh pr view --repo`
    // would resolve at github.com while the output claims the URL's host.
    // An explicit flag/env keeps precedence over the discovery. But the
    // routed value can be a host gh tolerates yet HOSTNAME_RE rejects
    // (underscore intranet aliases, IPv6 literals) — that is an
    // environmental condition, not a --host typo, so name the actual source
    // and fail in the runtime class (exit 1), never as a usage error that
    // blames a flag the caller never passed.
    const routed = resolveGhHost(args.host) ?? id.host;
    if (!HOSTNAME_RE.test(routed)) {
      throw new Error(
        `cannot route at the ${
          args.host !== undefined ? '--host flag' : 'discovered repo-URL host'
        } ${JSON.stringify(routed)} — not a hostname the review subcommands accept`,
      );
    }
    setGhHost(routed);
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
      process.exitCode = err instanceof TypeError ? 2 : 1;
    }
  },
};
