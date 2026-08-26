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
// The record is a git tree object, written through a THROWAWAY index: read
// HEAD into it, `add -A` the working tree, `write-tree`. The user's own index
// is never read or written (a `--fix` review runs in their checkout, and their
// staging state is theirs), the stash stack is never touched (it is shared
// across worktrees and other sessions), and nothing is checked out or reset.
// The tree object is unreferenced garbage after the review — the same thing
// `git stash create` leaves behind — and `add -A` is what decides what counts:
// modified, deleted and untracked-unignored files, which is exactly the set a
// fix's test file lands in.
//
// The review's own side files are excluded from the diff by pathspec, not by
// hoping they are ignored: the ledger, the artifact and the snapshot itself are
// written between the two states, and a hunks file that carried them would
// hand the auditor its own bookkeeping as an edit to audit.

import type { CommandModule } from 'yargs';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { git, gitOpt, gitRaw, gitWithEnv } from './lib/git.js';

/** What `--snapshot` writes and `--since` reads back. */
export interface FixSnapshot {
  /** The repository root the tree was taken in — a snapshot is not portable. */
  root: string;
  /** The tree object recording the working tree at snapshot time. */
  tree: string;
}

/**
 * Review-owned directories that change between the two states and are never
 * a fix. Matched at any depth: the review writes them under the directory it
 * was run from, which is the repository root in the common case and a
 * subdirectory otherwise.
 */
export const FIX_DELTA_EXCLUDES = [
  '.qwen/tmp',
  '.qwen/reviews',
  '.qwen/review-cache',
] as const;

/**
 * Record the working tree under `root` as a tree object and return its sha.
 * Runs through a throwaway index so the user's index is untouched.
 */
export function snapshotWorkingTree(root: string): string {
  const scratch = mkdtempSync(join(tmpdir(), 'qwen-fix-delta-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    // An unborn HEAD (a repo with no commit yet) has no tree to seed from —
    // start empty, and `add -A` records everything as added.
    // Probed IN `root`, not in the process cwd: every other call here carries
    // `-C root`, and a bare `rev-parse HEAD` answers for whatever repository
    // the process happens to sit in.
    if (
      gitOpt('-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD') !== null
    ) {
      gitWithEnv(env, ['-C', root, 'read-tree', 'HEAD']);
    } else {
      gitWithEnv(env, ['-C', root, 'read-tree', '--empty']);
    }
    gitWithEnv(env, ['-C', root, 'add', '-A', '--', '.']);
    return gitWithEnv(env, ['-C', root, 'write-tree']);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The diff from a snapshot tree to the working tree now, review side files excluded. */
export function diffSinceSnapshot(root: string, snapshotTree: string): string {
  const now = snapshotWorkingTree(root);
  if (now === snapshotTree) return '';
  return gitRaw(
    '-C',
    root,
    'diff-tree',
    '-r',
    '-p',
    '-M',
    '--no-color',
    '--no-ext-diff',
    snapshotTree,
    now,
    '--',
    '.',
    ...FIX_DELTA_EXCLUDES.map((p) => `:(glob,exclude)**/${p}/**`),
  ).toString('utf8');
}

export interface FixDeltaArgs {
  snapshot: boolean;
  since?: string;
  out: string;
}

export function runFixDelta(args: FixDeltaArgs): void {
  if (args.snapshot === Boolean(args.since)) {
    throw new Error(
      'fix-delta: pass exactly one of --snapshot (record the tree before the ' +
        'first edit) or --since <snapshot.json> (diff the tree now against it).',
    );
  }
  const root = git('rev-parse', '--show-toplevel');
  mkdirSync(dirname(resolve(args.out)), { recursive: true });

  if (args.snapshot) {
    const tree = snapshotWorkingTree(root);
    const snapshot: FixSnapshot = { root, tree };
    writeFileSync(resolve(args.out), `${JSON.stringify(snapshot, null, 2)}\n`);
    writeStderrLine(`fix-delta: snapshot ${tree.slice(0, 12)} of ${root}`);
    return;
  }

  let snapshot: FixSnapshot;
  try {
    const raw = JSON.parse(readFileSync(args.since as string, 'utf8')) as {
      root?: unknown;
      tree?: unknown;
    };
    if (
      typeof raw.root !== 'string' ||
      !/^[0-9a-f]{40,64}$/.test(String(raw.tree))
    ) {
      throw new Error('not a fix-delta snapshot ({root, tree})');
    }
    snapshot = { root: raw.root, tree: raw.tree as string };
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

  const diff = diffSinceSnapshot(root, snapshot.tree);
  writeFileSync(resolve(args.out), diff);
  if (diff.trim() === '') {
    writeStderrLine(
      'fix-delta: the tree is unchanged since the snapshot — nothing was applied ' +
        '(or the snapshot was taken after the edits).',
    );
    return;
  }
  const files = [...diff.matchAll(/^diff --git a\/(.*?) b\/(.*)$/gm)].map(
    (m) => m[2],
  );
  const shown = files.slice(0, 8).join(', ');
  writeStderrLine(
    `fix-delta: ${files.length} file(s) changed since the snapshot — ${shown}` +
      (files.length > 8 ? `, and ${files.length - 8} more` : ''),
  );
}

export const fixDeltaCommand: CommandModule = {
  command: 'fix-delta',
  describe:
    'Record the working tree before `--fix` edits it (--snapshot), then diff ' +
    'the tree against that record after the edits (--since): the hunks the fix ' +
    'applied, and nothing else, for the Step 6B fix audit. Never touches the ' +
    "user's index or the stash.",
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
          'tree now into --out (review side files under .qwen/ excluded)',
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
