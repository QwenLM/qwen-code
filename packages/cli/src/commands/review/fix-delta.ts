/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review fix-delta`: what `--fix` actually changed, as a diff — the fix
// auditor's input (Step 6B).
//
// The question the audit asks is about the EDIT, not the diff under review: a
// local review's tree already carries the user's uncommitted change, and the
// fixer's hunks land on top of it, so `git diff HEAD` after the edits is the
// user's change and the fix together, indistinguishable. The edit is the
// difference between two states of the same working tree — before the first
// `edit` call and after the last — so this command records the first state and
// diffs the second against it.
//
// The record is a git tree object, written through a THROWAWAY index: seed it,
// `add -A` the working tree, `write-tree`. The user's own index is never
// written (a `--fix` review runs in their checkout, and their staging state is
// theirs), the stash stack is never touched (it is shared across worktrees and
// other sessions), and nothing is checked out or reset. The tree object is
// unreferenced garbage after the review — the same thing `git stash create`
// leaves behind.
//
// What the hunks cover is a fixed scope, stated on every `--since` run
// (`FIX_DELTA_SCOPE`), not certified per run: `add -A` records tracked files
// and untracked files no ignore rule hides, in this repository. An edit inside
// a submodule or a nested repository, or to a gitignored file, is outside that
// scope and is named as such; a commit between the moments is detected and
// disclosed. The audit these hunks feed is a disclosure that changes no
// verdict, so a stated scope is the proportionate answer — a per-run probe of
// every way git can hide an edit is an enumeration with no last entry.

import type { CommandModule } from 'yargs';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { git, gitOpt, gitProbe, gitRaw, gitWithEnv } from './lib/git.js';
import { inertPath, repoRelativeOf } from './lib/paths.js';

/** What `--snapshot` writes and `--since` reads back. */
export interface FixSnapshot {
  /** The repository root the tree was taken in — a snapshot is not portable. */
  root: string;
  /** The tree object recording the working tree at snapshot time. */
  tree: string;
  /**
   * The commit the capture was seeded from, or null under an unborn HEAD.
   * Read ONCE and used for both the seed and the record, so the two cannot
   * describe different moments. `--since` compares it with HEAD then: a
   * commit between the moments moves nothing in a comparison seeded from the
   * snapshot's own tree, so it is disclosed instead.
   */
  head: string | null;
}

/**
 * The review's own NAME families under `.qwen/tmp` — what the flow writes
 * between the two states: the side files (`qwen-review-{target}-*`, the plan
 * and its `-prompts` directory among them), the file-target plan family
 * (`file-review-{file}-*`) and the worktree family (`review-pr-*`). Keyed on
 * the names the flow writes, never on whole directories, so content a user's
 * repository keeps elsewhere under `.qwen` stays reviewable — and a finding's
 * fix there stays in the hunks. Matched at any depth: the review writes them
 * under the directory it was run from, which is the repository root in the
 * common case and a subdirectory otherwise.
 */
export const FIX_DELTA_EXCLUDES = [
  '.qwen/tmp/qwen-review-*',
  '.qwen/tmp/review-pr-*',
  '.qwen/tmp/file-review-*',
] as const;

/**
 * What the hunks can and cannot hold, printed on every `--since` run so the
 * audit's reader sees the scope beside the result. Exported for the tests
 * that pin it; the skill relays it under the Fix audit heading.
 */
export const FIX_DELTA_SCOPE =
  'fix-delta: scope — the hunks hold what `git add -A` records in this ' +
  'repository: tracked files, and untracked files no ignore rule hides. An ' +
  'edit inside a submodule or a nested repository, to a gitignored file, or ' +
  "to the review's own files under .qwen/tmp is not in them.";

/**
 * The exclusion pathspecs both captures and the diff share. A name family
 * needs both forms: `X` alone leaves the contents of a directory matching
 * `X` captured (measured: `qwen-review-x-prompts/c.md` survived it). The
 * command's own side files — `--out`, and the `--since` record — are
 * excluded literally when they fall inside the repository, so a caller that
 * points them outside the families still gets hunks free of them.
 *
 * Except when an ignore rule already hides one. `add` refuses outright
 * (exit 1, "The following paths are ignored") when a pathspec item's literal
 * prefix names an ignored path, and a negative item counts too: wherever
 * `.qwen/tmp` is ignored — qwen-code's own `.qwen/*`, the `.qwen/` rule
 * `/setup-github` writes, a bare `tmp/` — the flow's own `--out` under it
 * made every capture fail. An
 * ignored untracked path cannot enter `add -A` in the first place, so that
 * exclusion has nothing to do. The family globs are immune: their `**`
 * prefix leaves no literal part for the check to match.
 */
function excludePathspecs(
  root: string,
  sideFiles: Array<string | undefined>,
): string[] {
  const specs = FIX_DELTA_EXCLUDES.flatMap((p) => [
    `:(glob,exclude)**/${p}`,
    `:(glob,exclude)**/${p}/**`,
  ]);
  for (const file of sideFiles) {
    if (file === undefined) continue;
    const { rel, escapes } = repoRelativeOf(root, file);
    if (rel === '' || escapes) continue;
    if (gitProbe('-C', root, 'check-ignore', '-q', '--', rel).status === 0) {
      continue;
    }
    specs.push(`:(exclude,literal)${rel}`);
  }
  return specs;
}

/**
 * Record the working tree under `root` as a tree object and return its sha.
 * Runs through a throwaway index seeded from `seed` (a commit or a tree; null
 * starts empty), so the user's index is untouched. The seed decides what the
 * capture treats as tracked: an ignored path the seed holds is re-hashed from
 * disk like any tracked file.
 */
export function snapshotWorkingTree(
  root: string,
  seed: string | null,
  excludes: readonly string[],
): string {
  // Under the git dir, never the system temp dir: a TMPDIR inside the
  // working tree (a sandbox that points it there) put the throwaway index
  // itself into the capture, and an untouched tree read as changed.
  const scratch = mkdtempSync(
    join(git('-C', root, 'rev-parse', '--absolute-git-dir'), 'qwen-fix-delta-'),
  );
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    gitWithEnv(env, [
      '-C',
      root,
      'read-tree',
      ...(seed === null ? ['--empty'] : [seed]),
    ]);
    gitWithEnv(env, [
      // Stderr the orchestrator reads, kept to what it must relay: a fresh
      // index re-hashes every file, and under `core.autocrlf` each LF file
      // prints its own conversion warning (the stored blob is the same
      // either way), and a nested repository's multi-line advice buries
      // the one-line warning beside it.
      '-c',
      'core.safecrlf=false',
      '-c',
      'advice.addEmbeddedRepo=false',
      '-C',
      root,
      'add',
      '-A',
      // A sparse checkout's cone does not bound what the audit covers: an
      // untracked file outside it made `add` refuse the whole capture.
      '--sparse',
      '--',
      '.',
      ...excludes,
    ]);
    return gitWithEnv(env, ['-C', root, 'write-tree']);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** HEAD as a commit sha, or null when it is unborn. */
function headCommit(root: string): string | null {
  return gitOpt(
    '-C',
    root,
    'rev-parse',
    '--verify',
    '--quiet',
    'HEAD^{commit}',
  );
}

const SHA = /^[0-9a-f]{40,64}$/;

export interface FixDeltaArgs {
  snapshot: boolean;
  since?: string;
  out: string;
}

export function runFixDelta(args: FixDeltaArgs): void {
  // Presence, not truthiness: yargs parses a bare `--since` as the empty
  // string, and `--snapshot --since` must not run in snapshot mode.
  if (args.snapshot === (args.since !== undefined)) {
    throw new Error(
      'fix-delta: pass exactly one of --snapshot (record the tree before the ' +
        'first edit) or --since <snapshot.json> (diff the tree now against it).',
    );
  }
  if (args.since === '') {
    throw new Error(
      'fix-delta: --since needs the snapshot file `--snapshot --out <file>` ' +
        'wrote; an empty path names nothing.',
    );
  }
  const root = git('rev-parse', '--show-toplevel');
  const excludes = excludePathspecs(root, [args.out, args.since]);
  mkdirSync(dirname(resolve(args.out)), { recursive: true });

  if (args.snapshot) {
    const head = headCommit(root);
    const tree = snapshotWorkingTree(root, head, excludes);
    const snapshot: FixSnapshot = { root, tree, head };
    writeFileSync(resolve(args.out), `${JSON.stringify(snapshot, null, 2)}\n`);
    writeStderrLine(`fix-delta: snapshot ${tree} of ${inertPath(root)}`);
    return;
  }

  let snapshot: FixSnapshot;
  try {
    const raw = JSON.parse(readFileSync(args.since as string, 'utf8')) as {
      root?: unknown;
      tree?: unknown;
      head?: unknown;
    };
    if (
      typeof raw.root !== 'string' ||
      typeof raw.tree !== 'string' ||
      !SHA.test(raw.tree) ||
      !(
        raw.head === null ||
        (typeof raw.head === 'string' && SHA.test(raw.head))
      )
    ) {
      throw new Error('not a fix-delta snapshot ({root, tree, head})');
    }
    snapshot = { root: raw.root, tree: raw.tree, head: raw.head };
  } catch (err) {
    throw new Error(
      `fix-delta: cannot read the snapshot ${args.since}: ${(err as Error).message}. ` +
        'Pass the file `fix-delta --snapshot --out <file>` wrote before the edits.',
    );
  }
  if (resolve(snapshot.root) !== resolve(root)) {
    throw new Error(
      `fix-delta: the snapshot was taken in ${snapshot.root}, but this is ${root}. ` +
        'A snapshot diffs only against the tree it recorded.',
    );
  }
  if (
    gitOpt('-C', root, 'cat-file', '-e', `${snapshot.tree}^{tree}`) === null
  ) {
    throw new Error(
      `fix-delta: the snapshot tree ${snapshot.tree.slice(0, 12)} is not in this ` +
        'repository. Take the snapshot in the same checkout the edits are applied in.',
    );
  }

  // Seeded from the snapshot's own tree, never from HEAD now: the two
  // captures then differ only by what is on disk, and whatever the first
  // one tracked (an ignored path HEAD held included) the second re-hashes.
  const now = snapshotWorkingTree(root, snapshot.tree, excludes);
  const headNow = headCommit(root);
  const range = [snapshot.tree, now, '--', '.', ...excludes];
  const diff =
    now === snapshot.tree
      ? Buffer.alloc(0)
      : gitRaw(
          '-c',
          'core.quotePath=false',
          '-C',
          root,
          // Plumbing: no user `diff.*` setting (external driver, textconv,
          // prefixes, color) applies, so the patch is git's own. Non-ASCII
          // names stay readable for the auditor instead of octal-quoted.
          'diff-tree',
          '-r',
          '-p',
          '-M',
          ...range,
        );
  writeFileSync(resolve(args.out), diff);

  if (diff.length === 0) {
    writeStderrLine(
      'fix-delta: the tree is unchanged since the snapshot — nothing was ' +
        'applied within the scope below, or the snapshot was taken after the edits.',
    );
  } else {
    const names = gitRaw(
      '-C',
      root,
      'diff-tree',
      '-r',
      '-M',
      '--name-only',
      '-z',
      ...range,
    )
      .toString('utf8')
      .split('\0')
      .filter((name) => name !== '')
      .map(inertPath);
    const shown = names.slice(0, 8).join(', ');
    writeStderrLine(
      `fix-delta: ${names.length} file(s) changed since the snapshot — ${shown}` +
        (names.length > 8 ? `, and ${names.length - 8} more` : ''),
    );
  }
  if (headNow !== snapshot.head) {
    writeStderrLine(
      'fix-delta: HEAD moved between the two moments ' +
        `(${snapshot.head?.slice(0, 12) ?? 'unborn'} -> ${headNow?.slice(0, 12) ?? 'unborn'}) — ` +
        'a change that landed by commit alone is not in the hunks.',
    );
  }
  writeStderrLine(FIX_DELTA_SCOPE);
}

export const fixDeltaCommand: CommandModule = {
  command: 'fix-delta',
  describe:
    'Record the working tree before `--fix` edits it (--snapshot), then diff ' +
    'the tree against that record after the edits (--since): the hunks the fix ' +
    "applied, for the Step 6B fix audit. Never writes the user's index or the stash.",
  builder: (yargs) =>
    yargs
      .option('snapshot', {
        type: 'boolean',
        describe: 'Record the working tree now, as a tree object, into --out',
      })
      .option('since', {
        type: 'string',
        describe:
          'A snapshot file from --snapshot; writes the diff from it to the ' +
          "tree now into --out (the review's own side files excluded)",
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Where to write the snapshot (JSON) or the diff',
      }),
  handler: (argv) => {
    runFixDelta({
      snapshot: argv['snapshot'] === true,
      since: argv['since'] as string | undefined,
      out: argv['out'] as string,
    });
  },
};
