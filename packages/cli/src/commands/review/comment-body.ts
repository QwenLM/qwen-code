/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review comment-body`: fetch one comment's body. The pr-context file
// caps long bodies and names this command in its truncation note — the model
// used to be handed a raw `gh api repos/…` route, which coupled the skill
// prose to GitHub's URL scheme and dropped the Enterprise host on the floor
// unless a prose rule remembered GH_HOST. The kind says which collection
// the id belongs to; GitHub review bodies are addressed per-PR, so
// `--kind review` also needs `--pr`.
//
// The body prints to stdout verbatim. For a tail too long for one shell
// preview, `--out` writes it to a file instead and the JSON result says so.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CommandModule } from 'yargs';
import { isOwnerRepo, setGhHost } from './lib/gh.js';
import { getPlatformReader } from './lib/platform/registry.js';
import { assertWritableOutPath } from './lib/paths.js';
import { COMMENT_KINDS, type CommentKind } from './lib/platform/types.js';
import {
  writeStdoutLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';

const COMMENT_KIND_CHOICES: string[] = [...COMMENT_KINDS];

interface CommentBodyArgs {
  id: number;
  kind: CommentKind;
  repo: string;
  prNumber?: number;
  out?: string;
}

export function runCommentBody(args: CommentBodyArgs): {
  body: string;
  outPath?: string;
} {
  // Usage errors precede the auth gate: `gh auth login` can never fix the
  // invocation, and exit 2 is the caller's "repair the invocation" signal.
  // Scope: this covers the guards validated HERE. Missing required arguments
  // and an invalid `--kind` choice are rejected by the yargs layer before
  // the handler runs and exit 1 — a known gap in the exit-code contract.
  if (args.kind === 'review' && args.prNumber === undefined) {
    throw new TypeError(
      '--kind review needs --pr (review bodies are addressed per-PR)',
    );
  }
  if (!isOwnerRepo(args.repo)) {
    throw new TypeError(
      `expected owner/repo, got ${JSON.stringify(args.repo)}`,
    );
  }
  // An empty or directory --out resolves to the cwd or dies EISDIR AFTER the
  // fetch — classify it before fetching.
  if (args.out !== undefined) {
    assertWritableOutPath(args.out);
  }
  const platform = getPlatformReader();
  platform.ensureAuthenticated();
  const body = platform.getCommentBody(
    args.kind,
    args.id,
    args.repo,
    args.prNumber,
  );
  if (args.out !== undefined) {
    const outPath = resolve(args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, body);
    return { body, outPath };
  }
  return { body };
}

export const commentBodyCommand: CommandModule = {
  command: 'comment-body <id>',
  describe:
    'Print one comment body — the fetch a pr-context truncation note names',
  builder: (yargs) =>
    yargs
      .positional('id', {
        type: 'number',
        demandOption: true,
        describe:
          'The comment id (a review id, inline-comment id, or issue-comment id)',
      })
      .option('kind', {
        type: 'string',
        choices: COMMENT_KIND_CHOICES,
        demandOption: true,
        describe:
          'Which collection the id belongs to: a review summary, an inline (diff) comment, or an issue-level comment',
      })
      .option('pr', {
        type: 'number',
        describe: 'The PR number — required with --kind review',
      })
      .option('repo', {
        type: 'string',
        demandOption: true,
        describe: 'The repository, owner/repo',
      })
      .option('host', {
        type: 'string',
        describe:
          'The PR host (GitHub Enterprise). Omitted: inherit GH_HOST, else github.com.',
      })
      .option('out', {
        type: 'string',
        describe:
          'Write the body to this file instead of stdout (for tails too long for one shell preview)',
      }),
  handler: (argv) => {
    const id = argv['id'] as number | undefined;
    const pr = argv['pr'] === undefined ? undefined : Number(argv['pr']);
    if (
      id === undefined ||
      !Number.isInteger(id) ||
      id <= 0 ||
      (pr !== undefined && (!Number.isInteger(pr) || pr <= 0))
    ) {
      writeStderrLineSafe(
        `comment-body: id and --pr must be positive integers, got ${JSON.stringify(argv['id'])} / ${JSON.stringify(argv['pr'])}`,
      );
      process.exitCode = 2;
      return;
    }
    const host = (argv as { host?: string }).host;
    // `--kind` is the one argv value yargs' element-wise `choices` does NOT
    // fully guard: a duplicated flag arrives as an ARRAY that passes choices
    // per element, and String() would coerce it to 'review,inline' — slipping
    // past the per-PR guard into the wrong API collection. Validate it is a
    // single admitted token before any platform call.
    const kindRaw: unknown = argv['kind'];
    const kind =
      typeof kindRaw === 'string' &&
      (COMMENT_KINDS as readonly string[]).includes(kindRaw)
        ? (kindRaw as CommentKind)
        : undefined;
    if (kind === undefined) {
      writeStderrLineSafe(
        `comment-body: --kind must be a single value of ${COMMENT_KINDS.join('/')}, got ${JSON.stringify(argv['kind'])}`,
      );
      process.exitCode = 2;
      return;
    }
    try {
      setGhHost(host);
      const result = runCommentBody({
        id,
        kind,
        repo: String(argv['repo']),
        prNumber: pr,
        out: (argv as { out?: string }).out,
      });
      if (result.outPath !== undefined) {
        writeStdoutLine(
          JSON.stringify({
            outPath: result.outPath,
            chars: result.body.length,
          }),
        );
      } else {
        // Byte-exact: writeStdoutLine would append a '\n' the body does not
        // have (an empty body would print exactly '\n') — the same artifact
        // the JSON-parse fix in getCommentBody was written to avoid.
        process.stdout.write(result.body);
      }
    } catch (err) {
      const usage = err instanceof TypeError;
      writeStderrLineSafe(`comment-body: ${(err as Error).message}`);
      process.exitCode = usage ? 2 : 1;
    }
  },
};
