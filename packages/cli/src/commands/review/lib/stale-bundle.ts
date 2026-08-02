/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Is the bundle this review is about to drive OLDER than the review source it
// was built from?
//
// Every `/review` subcommand runs as `"${QWEN_CODE_CLI}" review <name>`, which
// resolves to the built bundle — not to the working tree. `QWEN_CODE_CLI`
// already stops the review talking to a DIFFERENT program (a bare `qwen` on
// PATH once resolved to a v0.19.10 whose `agent-prompt` predated `--role`, and
// the review died on a missing argument). This is the other half: the right
// program, built before the change you are trying to exercise. So editing a review
// command, or switching to a branch that contains one, changes nothing about
// the run until someone rebuilds. The failure is silent and total: the run
// behaves like the last build, and every conclusion drawn from it is a
// conclusion about that build.
//
// Measured on 2026-08-02, dogfooding `/review` against #8368 from a checkout
// whose bundle was fourteen hours old. Three separate things were invalidated
// at once and none of them announced itself:
//
//   - `drive` and `mock-provider` had merged that morning and were absent from
//     the binary, so "the agent never reached for them" measured nothing;
//   - #8345's guard against scoring a mutant `survived` when its own test was
//     red had merged too, so the run reproduced the bug it fixed and filed
//     three findings the current code holds as `inconclusive`.
//
// The whole round had to be discarded and re-run after a rebuild.
//
// Deliberately mtime, not git. The question is "was this bundle built from this
// source", and a git comparison answers a different one — a rebuilt bundle on
// an unchanged tree is fine, and a fresh checkout of an old commit is fine too.
// File times answer it directly and need no repository.

import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How much newer a source file must be before it counts as newer at all.
 *
 * A checkout writes every file at once and in no guaranteed order, so a source
 * file landing a few milliseconds after the bundle says nothing. Only a gap a
 * human could have edited across is a gap worth reporting.
 */
export const STALE_MARGIN_MS = 60_000;

export interface BundleStaleness {
  /** `true` only when a source file is newer by more than the margin. */
  stale: boolean;
  /** The newest source file found, and how far it is ahead. Absent when the
   *  comparison could not be made at all. */
  newest?: { file: string; aheadMs: number };
  /** Why no comparison was made. Absent when one was. */
  unmeasured?: string;
}

/**
 * Compare a built artifact's timestamp against the newest source file under
 * `roots`.
 *
 * Returns `stale: false` whenever it cannot measure — a missing bundle, an
 * unreadable directory, a tree with no sources. A check that cannot see the
 * files must not accuse the build, and the caller has a review to run either
 * way. Every such case names itself in `unmeasured` rather than passing
 * silently for the same reason a probe does.
 */
export function bundleStaleness(
  bundlePath: string,
  roots: readonly string[],
  marginMs: number = STALE_MARGIN_MS,
): BundleStaleness {
  let builtAt: number;
  try {
    builtAt = statSync(bundlePath).mtimeMs;
  } catch {
    return { stale: false, unmeasured: `no bundle at ${bundlePath}` };
  }

  let newest: { file: string; mtimeMs: number } | undefined;
  let looked = false;
  for (const root of roots) {
    for (const file of sourceFilesUnder(root)) {
      looked = true;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (!newest || mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
    }
  }
  if (!looked || !newest) {
    return { stale: false, unmeasured: 'no review sources found to compare' };
  }

  const aheadMs = newest.mtimeMs - builtAt;
  return {
    stale: aheadMs > marginMs,
    newest: { file: newest.file, aheadMs },
  };
}

/**
 * Every file at or under `root`, recursively — `root` may be a directory or a
 * single file. Symlinks of any kind are skipped, because `isFile()` and
 * `isDirectory()` are both false for one: a link out of the tree is not this
 * tree's source, and a directory cycle would hang the one check that must
 * never cost the run anything.
 */
function* sourceFilesUnder(root: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    // A file, not a directory: `readdir` reports ENOTDIR and the path itself
    // is the source. Anything else — absent, unreadable — is nothing to walk.
    if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') yield root;
    return;
  }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) yield* sourceFilesUnder(full);
    else if (e.isFile()) yield full;
  }
}

/**
 * The review sources a bundle at `bundlePath` would have been built from, if
 * that bundle sits in a source checkout of this repo.
 *
 * `<root>/dist/cli.js` is the shape `scripts/cli-entry.js` resolves, so the
 * repo root is two levels up. An installed package has no `packages/` beside
 * it, and the caller then finds no files and reports that it could not measure
 * — which is the right answer for a user who never had sources to be ahead of.
 */
export function reviewSourceRoots(bundlePath: string): string[] {
  const repoRoot = join(bundlePath, '..', '..');
  const cli = join(repoRoot, 'packages', 'cli', 'src', 'commands');
  return [
    join(cli, 'review'),
    // The parent file, which is where every subcommand is registered — a new
    // command, or a changed dispatch, lives here and nowhere under `review/`.
    // A root may be a single file for exactly this reason.
    join(cli, 'review.ts'),
    join(repoRoot, 'packages', 'core', 'src', 'skills', 'bundled', 'review'),
  ];
}

/**
 * The warning a stale bundle earns, or `undefined` when there is nothing to
 * say.
 *
 * It names the file that is ahead and how far, because "rebuild" without
 * evidence is advice a reader has no way to check, and the whole point of the
 * warning is that the run they are about to trust may not be running their
 * code.
 */
export function staleBundleWarning(
  s: BundleStaleness,
  rebuildCommand = 'npm run build:packages && npm run bundle',
): string | undefined {
  if (!s.stale || !s.newest) return undefined;
  const hours = s.newest.aheadMs / 3_600_000;
  const ahead =
    hours >= 1
      ? `${hours.toFixed(1)}h`
      : `${Math.round(s.newest.aheadMs / 60_000)}m`;
  return (
    `review: the bundle these commands run from is ${ahead} older than ${s.newest.file}. ` +
    `Every \`qwen review …\` step below runs the BUILT bundle, not this working tree, ` +
    `so a review command changed since that build will not take effect and this run ` +
    `will measure the old behaviour without saying so. Rebuild with \`${rebuildCommand}\` ` +
    `and start again, or read every result below as being about the older build.`
  );
}
