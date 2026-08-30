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
  const platform = getPlatformReader({ host: args.host });

  let host: string;
  let ownerRepo: string;
  if (args.repo !== undefined) {
    // Explicit repo: the host comes from the flag/env. On GitHub it may
    // default to github.com; on any other platform there is NO default —
    // emitting `platform: 'aone'` beside `host: 'github.com'` would hand a
    // consumer a contradiction (feeding the host back flips detection to
    // GitHub and retargets at the same-named repo), so require `--host`.
    // The gate is the FLAG, not the resolved value: `resolveGhHost` also
    // inherits the GH_HOST env, and counting that fallback as a host source
    // off GitHub would leave the contradiction intact (an operator's
    // standard GHE export beside an Aone target). Everything here is pure
    // resolution and validation, so it all runs before the auth gate —
    // detection is read-only, and `a1 auth login` cannot fix a missing
    // `--host` either.
    ownerRepo = args.repo;
    // An empty-string flag is a missing flag: resolveGhHost treats it as
    // unset and falls through to the env, which must not bypass the guard.
    if (
      (args.host === undefined || args.host.trim() === '') &&
      platform.kind !== 'github'
    ) {
      throw new TypeError(
        `--repo on a ${platform.kind} target needs --host — there is no default host off GitHub`,
      );
    }
    host = resolveGhHost(args.host) ?? 'github.com';
    // Gate it the same way the discovery branch does: `resolveGhHost` also
    // reads the GH_HOST env and never validates, so an unroutable env value
    // (underscore intranet alias) must not be emitted as the host label while
    // every sibling rejects it when welded back as --host. An env-sourced
    // failure is environmental (exit 1), a --host typo was already classified
    // exit 2 by the handler's own setGhHost.
    if (!HOSTNAME_RE.test(host)) {
      throw new Error(
        `cannot route at the ${
          args.host !== undefined ? '--host flag' : 'GH_HOST environment'
        } ${JSON.stringify(host)} — not a hostname the review subcommands accept`,
      );
    }
    platform.ensureAuthenticated();
  } else {
    platform.ensureAuthenticated();
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
    //
    // Off GitHub the env half of that precedence is DROPPED: the Aone
    // reader never routes a gh call, so an operator's ambient GH_HOST
    // export (the standard GHE pattern) beside an Aone-origin clone must
    // not override the discovered host — it would veto a valid Aone
    // invocation at the HOSTNAME_RE gate below (the explicit-`--repo`
    // branch's no-default-host guard names the same interference class).
    // Only an explicit --host flag overrides discovery there.
    const routed =
      (platform.kind === 'github'
        ? resolveGhHost(args.host)
        : (args.host ?? '').trim() || undefined) ?? id.host;
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
          "The host the target lives on. The canonical Aone hosts (code.alibaba-inc.com / gitlab.alibaba-inc.com) select the a1 backend — a non-canonical *.alibaba-inc.com host is a GitHub Enterprise instance and stays on gh; omitted: detected from the clone's origin, else GitHub (GH_HOST, then github.com).",
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
