/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review revert-hunk`: take ONE hunk of the diff back out of a tree, so
// "is this change load-bearing?" can be measured instead of argued.
//
// The probe answers "does the PR's code exhibit the claimed behaviour", and
// the A/B answers "did the base behave differently". Between them sits a
// question both leave open: whether EACH change in the diff is needed for the
// behaviour the PR claims — the fix that is really two fixes and only one is
// exercised, the hunk that is dead weight, the "refactor" hunk a fix rode in
// on. Maintainer verification answers it the same way every time: revert
// exactly one hunk, re-run the probe that the intact tree passes, and watch
// whether the behaviour reverts with it. The probe pair (intact vs reverted)
// is the witness; a hunk whose revert flips nothing is either not load-bearing
// or the probe is too weak to see it — both worth knowing before an Approve.
//
// The judgment half — WHICH probe to run and what its flip means — stays with
// the verifier. What was hand-done every time, and hand-done wrongly, is the
// mechanical half: extracting hunk N of file F out of a unified diff. By-hand
// extraction means sed ranges over a 5 000-line diff file, and a range that is
// off by one line silently produces a DIFFERENT mutation than the one the
// report claims was tested — the transcription failure this skill has measured
// in every place a hand copies what a command could carry. So this command
// owns: enumerating the diff's hunks under stable ids, extracting one verbatim
// (its file headers and its `\ No newline` markers with it), and applying it
// in REVERSE via git's own patch engine — never a reimplementation of it.
//
// Two facts the report states rather than papering over:
//  - A hunk that will not revert independently (its context overlaps another
//    hunk's edits) is a FACT about the diff's internal coupling, not a failure:
//    "hunk 3 depends on hunk 1" is itself evidence about what is load-bearing.
//  - The tree this runs in should be the verifier's own scratch tree. The
//    command does not know where the shared review worktree is, so it cannot
//    refuse it — but a revert left in the shared tree is exactly the #9207
//    residue class, which is why the brief sends every mutation here through
//    `scratch-tree` first.

import type { CommandModule } from 'yargs';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DiffFile } from './lib/diff-plan.js';
import { parseDiff } from './lib/diff-plan.js';
import { sanitizedGitEnv } from './lib/worktree.js';
import { assertWritableOutPath } from './lib/paths.js';
import {
  writeStdoutLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';

/** One enumerable hunk, under the id `--hunk` accepts. */
export interface HunkEntry {
  /** `<new-side path>:<n>`, n 1-based within the file. The selector. */
  id: string;
  path: string;
  n: number;
  /** The `@@ ...` header line, verbatim — enough to recognise the hunk. */
  header: string;
  addedLines: number;
  removedLines: number;
}

export interface RevertHunkReport {
  /** True when the reverse patch is IN the tree — the only state worth probing. */
  applied: boolean;
  hunk?: HunkEntry;
  /**
   * git's own refusal text when the hunk does not apply in reverse. Coupling
   * to another hunk's edits is the common cause; a tree already mutated at the
   * same lines is the other. Either way the tree is UNCHANGED — `--check`
   * runs first, so a refused revert never half-applies.
   */
  conflict?: string;
  /** What happened, one line, rendered to the verifier verbatim. */
  note: string;
}

/**
 * Enumerate the diff's hunks. Binary and mode-only sections carry none and
 * are simply absent — there is nothing of theirs to revert.
 */
export function listHunks(diffText: string): HunkEntry[] {
  const lines = diffText.split('\n');
  const { files } = parseDiff(diffText);
  const out: HunkEntry[] = [];
  for (const f of files) {
    f.hunks.forEach((h, i) => {
      let added = 0;
      let removed = 0;
      // Body starts after the `@@` line. `+++`/`---` cannot open a body line
      // that is not itself an add/remove (metadata only exists before the
      // first hunk), so the first byte is the authority.
      for (let ln = h.diffStart + 1; ln <= h.diffEnd; ln++) {
        const c = lines[ln - 1]?.[0];
        if (c === '+') added++;
        else if (c === '-') removed++;
      }
      out.push({
        id: `${f.path}:${i + 1}`,
        path: f.path,
        n: i + 1,
        header: lines[h.diffStart - 1] ?? '',
        addedLines: added,
        removedLines: removed,
      });
    });
  }
  return out;
}

/**
 * Extract hunk `n` (1-based) of `file` as a minimal, self-contained patch:
 * the file's header block verbatim, then the hunk verbatim. Verbatim is the
 * point — the `@@` line numbers, the context, and any `\ No newline at end
 * of file` marker inside the hunk's range all survive, so what git applies
 * is what the diff says, not a transcription of it.
 */
export function extractHunkPatch(
  diffText: string,
  file: DiffFile,
  n: number,
): string {
  const lines = diffText.split('\n');
  const hunk = file.hunks[n - 1];
  const header = lines.slice(file.diffStart - 1, file.hunks[0].diffStart - 1);
  const body = lines.slice(hunk.diffStart - 1, hunk.diffEnd);
  return `${[...header, ...body].join('\n')}\n`;
}

/** Split `<path>:<n>` from the RIGHT — a path may itself contain a colon. */
export function parseHunkId(id: string): { path: string; n: number } | null {
  const i = id.lastIndexOf(':');
  if (i <= 0) return null;
  const n = Number(id.slice(i + 1));
  if (!Number.isInteger(n) || n < 1) return null;
  return { path: id.slice(0, i), n };
}

export interface RevertHunkArgs {
  diff: string;
  tree: string;
  hunk: string;
  /** Test seam — production shells out to the real git. */
  exec?: (
    cwd: string,
    args: string[],
  ) => { status: number | null; stderr: string };
}

function gitApply(
  cwd: string,
  args: string[],
): { status: number | null; stderr: string } {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: sanitizedGitEnv(),
    timeout: 60_000,
  });
  return { status: r.status ?? null, stderr: (r.stderr ?? '').trim() };
}

export function runRevertHunk(args: RevertHunkArgs): RevertHunkReport {
  const diffText = readFileSync(resolve(args.diff), 'utf8');
  const sel = parseHunkId(args.hunk);
  if (!sel) {
    return {
      applied: false,
      note: `--hunk ${JSON.stringify(args.hunk)} is not a hunk id; expected <path>:<n> with n >= 1 — run with --list to see the ids this diff has.`,
    };
  }
  const { files } = parseDiff(diffText);
  const file = files.find((f) => f.path === sel.path);
  if (!file || file.hunks.length < sel.n) {
    const have = file
      ? `${file.hunks.length} hunk(s)`
      : 'no section in this diff';
    return {
      applied: false,
      note: `hunk ${args.hunk} does not exist: ${sel.path} has ${have} — run with --list to see the ids this diff has.`,
    };
  }
  const entry = listHunks(diffText).find((h) => h.id === args.hunk)!;
  const patch = extractHunkPatch(diffText, file, sel.n);

  const tree = resolve(args.tree);
  const dir = join(tmpdir(), `qwen-review-revert-hunk-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const patchPath = join(dir, 'hunk.patch');
  writeFileSync(patchPath, patch, 'utf8');
  const exec = args.exec ?? gitApply;
  try {
    // `--check` first: a refused revert must leave the tree byte-identical,
    // or the verifier's next probe measures a half-mutation nothing reports.
    const check = exec(tree, ['apply', '-R', '--check', patchPath]);
    if (check.status !== 0) {
      return {
        applied: false,
        hunk: entry,
        conflict: check.stderr || 'git apply --check refused (no error text)',
        note: `hunk ${args.hunk} does not revert independently — its context no longer matches the tree. Usually that means it overlaps another hunk's edits (a coupling worth reporting as a fact) or the tree was already mutated at those lines (reset the scratch tree and retry). The tree is unchanged.`,
      };
    }
    const apply = exec(tree, ['apply', '-R', patchPath]);
    if (apply.status !== 0) {
      // --check passed and the apply did not: something raced the tree
      // between the two calls. Report it as the harness fact it is.
      return {
        applied: false,
        hunk: entry,
        conflict: apply.stderr || 'git apply refused (no error text)',
        note: `hunk ${args.hunk} passed --check but failed to apply — the tree changed between the two calls. Reset the scratch tree and retry.`,
      };
    }
    return {
      applied: true,
      hunk: entry,
      note: `reverted hunk ${args.hunk} (${entry.header}) in ${tree}. Re-run the probe the intact tree passed — the intact/reverted pair is the witness — and reset the scratch tree afterwards. A compiled product needs its rebuild between revert and probe, or the probe measures the previous build.`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const revertHunkCommand: CommandModule = {
  command: 'revert-hunk',
  describe:
    'List the diff\'s hunks (--list), or apply exactly one in reverse in a tree — the "is this change load-bearing?" mutation, done by git instead of by hand',
  builder: (yargs) =>
    yargs
      .option('diff', {
        type: 'string',
        demandOption: true,
        describe: 'The unified diff file the plan records',
      })
      .option('list', {
        type: 'boolean',
        // No `default: false`: yargs `conflicts` counts a defaulted key as
        // "given", which made --hunk unusable — measured on the first live
        // run of this command.
        describe: 'Enumerate the hunks and their ids; touches no tree',
      })
      .option('hunk', {
        type: 'string',
        describe: 'The hunk to revert, as <path>:<n> from --list',
      })
      .option('tree', {
        type: 'string',
        describe:
          'The tree to revert in — the verifier’s scratch tree, never the shared review worktree',
      })
      .option('out', {
        type: 'string',
        describe: 'Also write the report JSON here',
      })
      .conflicts('list', 'hunk'),
  handler: (argv) => {
    const out = argv['out'] as string | undefined;
    try {
      if (out !== undefined) assertWritableOutPath(out);
      let report: object;
      if (argv['list']) {
        report = {
          hunks: listHunks(readFileSync(resolve(String(argv['diff'])), 'utf8')),
        };
      } else {
        const hunk = argv['hunk'] as string | undefined;
        const tree = argv['tree'] as string | undefined;
        if (!hunk || !tree) {
          writeStderrLineSafe(
            'revert-hunk: pass --list to enumerate, or both --hunk <path>:<n> and --tree <path> to revert one.',
          );
          process.exitCode = 2;
          return;
        }
        const r = runRevertHunk({ diff: String(argv['diff']), tree, hunk });
        // Same convention as `drive`'s not-observed exit: the JSON is the
        // report, the code is the branch a calling script takes.
        if (!r.applied) process.exitCode = 1;
        report = r;
      }
      const text = JSON.stringify(report, null, 2);
      if (out !== undefined) {
        mkdirSync(dirname(resolve(out)), { recursive: true });
        writeFileSync(resolve(out), `${text}\n`, 'utf8');
      }
      writeStdoutLine(text);
    } catch (err) {
      writeStderrLineSafe(`revert-hunk: ${(err as Error).message}`);
      process.exitCode = err instanceof TypeError ? 2 : 1;
    }
  },
};
