/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  assertUnredirectedParent,
  baseWorktreePath,
  ensureReviewTmpDir,
  repoRelativeOf,
  inertPath,
  lastReviewEffortPath,
  tmpFile,
  probeWorktreePath,
  scratchLabel,
  scratchWorktreePath,
  scratchWorktreePrefix,
  worktreePath,
  PARSE_ARGS_REPORT,
} from './paths.js';
import { isolateHostGitConfig } from './test-utils.js';

describe('lastReviewEffortPath', () => {
  it('uses the project storage owner exported by the parent session', () => {
    expect(
      lastReviewEffortPath('/workspace/repo', '/runtime/projects/repo'),
    ).toBe(resolve('/runtime/projects/repo/review-last-effort'));
  });

  it('keeps fallback storage private and project-scoped', () => {
    const first = lastReviewEffortPath('/workspace/one');
    const second = lastReviewEffortPath('/workspace/two');
    expect(first).not.toBe(second);
    expect(first).not.toContain('/workspace/one/.qwen');
    expect(second).not.toContain('/workspace/two/.qwen');
  });
});

describe('PARSE_ARGS_REPORT', () => {
  it('is the literal path the skill writes in Step 0', () => {
    // The skill's Step 0 hard-codes `.qwen/tmp/qwen-review-parse-args.json` as
    // `parse-args --out`. If this constant drifts from that literal the
    // fallback silently stops reading the report and the original bug returns.
    expect(PARSE_ARGS_REPORT).toBe(
      join('.qwen', 'tmp', 'qwen-review-parse-args.json'),
    );
  });
});

describe('tmpFile — target is a single safe component', () => {
  it('keeps ordinary labels intact', () => {
    expect(tmpFile('pr-6771', 'diff.txt')).toContain(
      'qwen-review-pr-6771-diff.txt',
    );
    expect(tmpFile('local', 'plan.json')).toContain(
      'qwen-review-local-plan.json',
    );
  });

  it('flattens a file-path target so its parent is not a missing directory', () => {
    // `src/foo.ts` used to make `.qwen/tmp/qwen-review-src/foo.ts-diff.txt`, whose
    // `src/` parent nobody created — ENOENT.
    const p = tmpFile('src/foo.ts', 'diff.txt');
    expect(p).not.toContain('src/foo.ts');
    expect(dirname(p)).toBe(join('.qwen', 'tmp'));
    // The separator is flattened to an underscore, so the target survives as a
    // single component directly under the temp dir.
    expect(basename(p)).toBe('qwen-review-src_foo.ts-diff.txt');
  });

  it('refuses to escape the temp dir with a crafted target', () => {
    const p = tmpFile('../../evil', 'diff.txt');
    expect(dirname(p)).toBe(join('.qwen', 'tmp'));
    expect(p).not.toContain('..');
    // The dot-segment traversal is stripped to a plain component, not nested.
    expect(basename(p)).toBe('qwen-review-evil-diff.txt');
  });
});

describe('probeWorktreePath', () => {
  it('appends -probe to an absolute worktree path', () => {
    const worktree = resolve('/a/b/review-pr-1');
    expect(probeWorktreePath(worktree)).toBe(`${worktree}-probe`);
  });

  it('resolves a relative worktree to absolute so it never depends on cwd', () => {
    // The probe drives `git worktree add` with the shared worktree as cwd, so a
    // relative probe path would resolve against that worktree and nest the probe
    // tree inside it. Absolute keeps it a sibling wherever it is called from.
    expect(probeWorktreePath('.qwen/tmp/review-pr-1')).toBe(
      `${resolve('.qwen/tmp/review-pr-1')}-probe`,
    );
  });

  it('is the single source of the -probe suffix both call sites share', () => {
    // cleanup.ts sweeps `probeWorktreePath(worktreePath(n))`; the probe creates
    // `probeWorktreePath(worktree)`. One helper, one suffix — they cannot drift.
    expect(probeWorktreePath(worktreePath(7))).toBe(
      `${resolve(worktreePath(7))}-probe`,
    );
  });
});

describe('scratchWorktreePath', () => {
  const worktree = resolve('/a/b/review-pr-1');

  it('names the tree after the agent that owns it', () => {
    // The label is what keeps concurrent verifier shards apart; a scratch tree
    // they share is the race the whole mechanism exists to remove.
    expect(scratchWorktreePath(worktree, 'verify--round-2--abc')).toBe(
      `${worktree}-scratch-verify--round-2--abc`,
    );
    expect(scratchWorktreePath(worktree, 'verify--round-2--abc')).not.toBe(
      scratchWorktreePath(worktree, 'verify--round-2--def'),
    );
  });

  it('resolves a relative worktree so the tree is a SIBLING, not a child', () => {
    // `git worktree add` runs with the review worktree as cwd. A relative path
    // would land the scratch tree inside the one tree it must never touch.
    expect(scratchWorktreePath('.qwen/tmp/review-pr-1', 'verify')).toBe(
      `${resolve('.qwen/tmp/review-pr-1')}-scratch-verify`,
    );
  });

  it('flattens a crafted label instead of following it out of the temp dir', () => {
    // The label reaches this over a CLI flag, and the path it builds is both
    // created by `git worktree add` and later DELETED by cleanup's sweep.
    const p = scratchWorktreePath(worktree, '../../../etc/passwd');
    expect(p).not.toContain('..');
    expect(dirname(p)).toBe(dirname(worktree));
    expect(p.startsWith(`${worktree}-scratch-`)).toBe(true);
  });

  it('caps a long label — the suffix rides on an already-deep path', () => {
    const p = scratchWorktreePath(worktree, 'v'.repeat(400));
    expect(basename(p).length).toBeLessThanOrEqual(
      'review-pr-1-scratch-'.length + 64,
    );
  });

  it('refuses a label that keeps no path-safe character', () => {
    // `???` and `!!!` are two different labels that flatten to nothing. A
    // fallback would name both trees after the prefix itself — one tree for
    // every shard whose label was unusable, and a path cleanup's prefix sweep
    // matches as a whole family.
    expect(() => scratchWorktreePath(worktree, '???')).toThrow(TypeError);
    expect(scratchLabel('???')).toBe('');
  });
});

describe('scratchWorktreePrefix', () => {
  it('is the exact infix cleanup sweeps on, not merely a prefix of the path', () => {
    // Asserting only `path.startsWith(prefix)` is a tautology — the path is
    // BUILT from the prefix — and it holds just as well for a broader prefix,
    // which is the dangerous direction: `cleanup` feeds this to a
    // `startsWith` filter over the temp dir and deletes every match, so a
    // prefix of `…/review-pr-7` alone would delete PR 70's live worktrees.
    expect(scratchWorktreePrefix(worktreePath(7))).toBe(
      `${resolve(worktreePath(7))}-scratch-`,
    );
    expect(
      scratchWorktreePath(worktreePath(70), 'x').startsWith(
        scratchWorktreePrefix(worktreePath(7)),
      ),
    ).toBe(false);
  });
});

describe('inertPath', () => {
  // The only sanitizer between a git-reported (PR- or agent-controlled) path
  // and three sinks that render it: a brief the agent treats as its whole
  // instructions, the roster's separator lines, and the orchestrator's
  // terminal. The character class IS the safety property.
  it('flattens everything that could act rather than name', () => {
    expect(inertPath('a\nb.ts')).toBe('a b.ts');
    expect(inertPath('a\u001b[31mb.ts')).toBe('a [31mb.ts');
    expect(inertPath('a`b.ts')).toBe('a b.ts');
    // The roster separator glyph — a filename must not be able to forge a
    // block boundary in the text an orchestrator pastes to an agent.
    expect(inertPath('a\u2500b.ts')).toBe('a b.ts');
    // Invisible formatting: a bidi override reverses the rendering of
    // everything after it, and a zero-width joiner hides characters inside a
    // path a reader is being asked to judge.
    expect(inertPath('a\u202eb.ts')).toBe('a b.ts');
    expect(inertPath('a\u200bb.ts')).toBe('a b.ts');
    expect(inertPath('a\ufeffb.ts')).toBe('a b.ts');
    // Line and paragraph separators open a new Markdown line like a newline.
    expect(inertPath('a\u2028b.ts')).toBe('a b.ts');
  });

  it('leaves an ordinary path exactly as it is', () => {
    // A sanitizer that mangles the common case makes every rendered path
    // unusable as the command argument the reader is told to run.
    expect(inertPath('packages/cli/src/a-b_c.test.ts')).toBe(
      'packages/cli/src/a-b_c.test.ts',
    );
    expect(inertPath('caf\u00e9.ts')).toBe('caf\u00e9.ts');
    expect(inertPath('my probe.ts')).toBe('my probe.ts');
  });
});
describe('repoRelativeOf — the repository root is inside the repository', () => {
  it('does not classify the root itself as an escape', () => {
    // `classifyRunTarget` accepts a directory target, so the root is a
    // reachable one — and calling it an escape split the two sides that must
    // agree: the parent pinned the typed spelling while the child derived
    // `safeTarget('') === 'target'`, so the poll never matched and a review
    // that HAD run reported no verdict. `--file <root>` also threw
    // "resolves to <root>, which is outside the repository at <root>".
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'repo-rel-')));
    try {
      const out = repoRelativeOf(root, root, root);
      expect(out.escapes).toBe(false);
      expect(out.rel).toBe('');
      // …and a genuine escape still is one.
      expect(repoRelativeOf(root, '..', root).escapes).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('assertUnredirectedParent', () => {
  it('refuses a write whose parent chain traverses a symlink', () => {
    // `noFollow` protects the FINAL element only, and the threat is satisfied
    // one layer up: plant `.qwen/tmp` (or `.qwen/review-cache`) as a link —
    // gitignore does not stop `git add -f` — and `mkdirSync(…,
    // {recursive:true})` succeeds through it while the atomic tmp+rename
    // lands the file wherever the link points. Worse for a candidate: the
    // plan then advertises that path, and `cache-commit` reads back a
    // candidate the attacker wrote, promoting forged anchors past validation
    // that is only shape-deep.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'redirect-')));
    try {
      const victim = join(root, 'victim');
      mkdirSync(victim);
      const link = join(root, 'linked');
      symlinkSync(victim, link);
      expect(() =>
        assertUnredirectedParent(
          join(link, 'candidate.json'),
          'cache candidate',
          'fetch-pr',
        ),
      ).toThrow(/resolves to .*Refusing/s);
      // The command name rides the message: three writers share this guard,
      // and a refusal that names none of them is one nobody can act on.
      expect(() =>
        assertUnredirectedParent(join(link, 'x.json'), 'cache', 'cache-commit'),
      ).toThrow(/^cache-commit:/);

      // A real directory passes.
      expect(() =>
        assertUnredirectedParent(
          join(victim, 'candidate.json'),
          'cache candidate',
          'fetch-pr',
        ),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a parent that cannot be resolved at all', () => {
    // Unresolvable is not "fine": the write would create it, and what it
    // creates through is exactly what this cannot see.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'redirect-')));
    try {
      expect(() =>
        assertUnredirectedParent(
          join(root, 'nope', 'candidate.json'),
          'cache candidate',
          'capture-local',
        ),
      ).toThrow(/cannot resolve the cache candidate directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Windows: every arm here is skipped, and only three of them need to be.
 *
 * The symlink arms do (`symlinkSync` needs a privilege a runner may not
 * have); the index-sweep arms plant through `git update-index --cacheinfo`
 * and touch no link, so they would run. They are skipped anyway because
 * this suite was authored and exercised on POSIX only, and shipping an
 * assertion to a platform nobody ran it on is how a green lane starts
 * lying. The consequence is stated rather than hidden: the tracked-entry
 * refusal, the case fold, the gitlink allowlist and the two fail-closed
 * listing branches are UNVERIFIED on Windows — recorded as follow-up on
 * issue #10974 for whoever can drive that lane.
 */
describe('ensureReviewTmpDir', () => {
  it.skipIf(process.platform === 'win32')(
    'creates a real .qwen/tmp and refuses a symlinked one — or a symlinked .qwen',
    () => {
      // Every side file a round writes lands in `.qwen/tmp` under a
      // deterministic name, and the directory is in-repo: a contributor
      // branch can commit it as a link. One refusal here, before the first
      // write, is what closes the class the per-writer guards kept
      // re-finding (plan, diff, stop, candidate, worktree).
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'tmpdir-')));
      const cwd = process.cwd();
      process.chdir(root);
      try {
        ensureReviewTmpDir('capture-local');
        expect(lstatSync(join(root, '.qwen', 'tmp')).isDirectory()).toBe(true);

        const victim = join(root, 'victim');
        mkdirSync(victim);
        rmSync(join(root, '.qwen', 'tmp'), { recursive: true });
        symlinkSync(victim, join(root, '.qwen', 'tmp'));
        expect(() => ensureReviewTmpDir('capture-local')).toThrow(
          /^capture-local: .*tmp is a symbolic link/s,
        );
        expect(readdirSync(victim)).toEqual([]);

        // One layer up, and a DANGLING link both: `lstat` sees the link
        // itself, so neither needs a target to be refused by name.
        rmSync(join(root, '.qwen'), { recursive: true, force: true });
        symlinkSync(victim, join(root, '.qwen'));
        expect(() => ensureReviewTmpDir('fetch-pr')).toThrow(
          /^fetch-pr: \.qwen is a symbolic link/,
        );
        rmSync(join(root, '.qwen'), { force: true });
        mkdirSync(join(root, '.qwen'));
        symlinkSync(join(root, 'nowhere'), join(root, '.qwen', 'tmp'));
        expect(() => ensureReviewTmpDir('fetch-pr')).toThrow(
          /tmp is a symbolic link/,
        );
      } finally {
        process.chdir(cwd);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  /**
   * One planted repository, reused by each arm below. Split rather than run
   * as one `it()`: the arms stage entries at the same paths, so a failure in
   * an early one used to abort the rest and hide what else broke.
   */
  function plantedRepo(): {
    root: string;
    git: (...args: string[]) => string;
    blob: string;
    dispose: () => void;
  } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tmpdir-')));
    const cwd = process.cwd();
    process.chdir(root);
    const isolation = isolateHostGitConfig();
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q', '--template=', '.');
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: root,
      encoding: 'utf8',
      input: 'victim.txt',
    }).trim();
    return {
      root,
      git,
      blob,
      dispose: () => {
        isolation.dispose();
        process.chdir(cwd);
        rmSync(root, { recursive: true, force: true });
      },
    };
  }

  it.skipIf(process.platform === 'win32')(
    'refuses a TRACKED symlink inside .qwen/tmp, and leaves an untracked one alone',
    () => {
      // The directory itself is real; the plant is one level down, at the
      // deterministic name of a file the round writes with `writeFileSync`.
      // Untracked is not the workspace's doing and `lstat` on the directory
      // sees nothing — the sweep is about what a branch can COMMIT.
      const { root, git, dispose } = plantedRepo();
      try {
        symlinkSync(
          join(root, 'victim.txt'),
          join(root, '.qwen', 'tmp', 'qwen-review-local-diff.txt'),
        );
        expect(() => ensureReviewTmpDir('capture-local')).not.toThrow();
        git('add', '-f', '.qwen/tmp/qwen-review-local-diff.txt');
        expect(() => ensureReviewTmpDir('capture-local')).toThrow(
          /^capture-local: the workspace tracks a symbolic link at .*qwen-review-local-diff\.txt/s,
        );
      } finally {
        dispose();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'leaves a tracked REGULAR file under .qwen/tmp alone — the review overwrites it',
    () => {
      // A fixture that `git add -A`s its whole tree must keep running.
      const { root, git, dispose } = plantedRepo();
      try {
        writeFileSync(join(root, '.qwen', 'tmp', 'plain.txt'), 'x');
        git('add', '-f', '.qwen/tmp/plain.txt');
        expect(() => ensureReviewTmpDir('capture-local')).not.toThrow();
      } finally {
        dispose();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'folds case: the spelling a case-insensitive filesystem resolves through',
    () => {
      // `.QWEN/tmp/<name>` is the same file as `.qwen/tmp/<name>` there, and
      // the index can carry either spelling. Matched by folding the index,
      // not by a pathspec, so the refusal is the same on a case-sensitive
      // filesystem. Staged straight into the index (`--cacheinfo`), so the
      // fixture needs no case-folded directory.
      const { git, blob, dispose } = plantedRepo();
      try {
        git(
          'update-index',
          '--add',
          '--cacheinfo',
          `120000,${blob},.QWEN/tmp/qwen-review-local-plan.json`,
        );
        expect(() => ensureReviewTmpDir('capture-local')).toThrow(
          /tracks a symbolic link at .*\.QWEN\/tmp\/qwen-review-local-plan\.json/s,
        );
      } finally {
        dispose();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a submodule AT the scratch directory, whose own tree it cannot see',
    () => {
      // `lstat` sees a directory and the index a gitlink; the planted link
      // would live in the submodule's tree, which this index never lists.
      const { git, dispose } = plantedRepo();
      try {
        git(
          'update-index',
          '--add',
          '--cacheinfo',
          '160000,4b825dc642cb6eb9a060e54bf8d69288fbee4904,.qwen/tmp',
        );
        expect(() => ensureReviewTmpDir('capture-local')).toThrow(
          /tracks a submodule at .*\.qwen\/tmp/s,
        );
      } finally {
        dispose();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    "does not refuse the review's OWN worktree, tracked as a gitlink below",
    () => {
      // `fetch-pr` creates a worktree at `.qwen/tmp/review-pr-<n>`, and a
      // `git add -A` in a checkout that does not ignore `.qwen/tmp` records
      // it as a gitlink with only a hint — refusing on that blocked every
      // review in the checkout over the round's own scratch directory, and
      // removing the worktree leaves the entry behind. It hides nothing:
      // the round's side files are siblings of that directory, never paths
      // through it. A SYMLINK at that same NAME is still the plant.
      const { git, blob, dispose } = plantedRepo();
      try {
        git(
          'update-index',
          '--add',
          '--cacheinfo',
          `160000,4b825dc642cb6eb9a060e54bf8d69288fbee4904,${join(
            '.qwen',
            'tmp',
            basename(worktreePath(7)),
          )}`,
        );
        expect(() => ensureReviewTmpDir('fetch-pr')).not.toThrow();
        // …and so are the trees derived from it. Named through the HELPERS
        // that own those spellings, not by hand: they exist because the
        // suffixes drifted once when two places spelled them, and the
        // allowlist in `paths.ts` spells them a third time. Rename one there
        // and this stages the new name against the old allowlist, which is
        // the failure a hand-written literal here would hide — in a checkout
        // that would then refuse every review over its own worktree.
        const wt = worktreePath(7);
        const pr = join('.qwen', 'tmp', basename(wt));
        for (const tree of [
          probeWorktreePath(wt),
          baseWorktreePath(wt),
          scratchWorktreePath(wt, 'build'),
        ]) {
          git(
            'update-index',
            '--add',
            '--cacheinfo',
            `160000,4b825dc642cb6eb9a060e54bf8d69288fbee4904,${join(
              '.qwen',
              'tmp',
              basename(tree),
            )}`,
          );
        }
        expect(() => ensureReviewTmpDir('fetch-pr')).not.toThrow();

        // A gitlink at ANY OTHER name below is still the plant: the round
        // writes THROUGH some of them — the per-target prompt-record
        // directory above all — and a submodule's own tree is not in this
        // index, so a link inside it is invisible here.
        git(
          'update-index',
          '--add',
          '--cacheinfo',
          '160000,4b825dc642cb6eb9a060e54bf8d69288fbee4904,.qwen/tmp/qwen-review-local-plan-prompts',
        );
        expect(() => ensureReviewTmpDir('fetch-pr')).toThrow(
          /tracks a submodule at .*qwen-review-local-plan-prompts/s,
        );
        git(
          'update-index',
          '--force-remove',
          '.qwen/tmp/qwen-review-local-plan-prompts',
        );

        // …and a SYMLINK at exactly that name still is the plant: the
        // exemption is for a GITLINK, which is what `git add -A` records
        // for a worktree — a link there is nothing the review creates.
        // Planted at the name itself, not below it, or the arm would pass
        // on the allowlist's own reject and never exercise that half.
        // (Staged after the gitlink is gone: git will not index two
        // entries at one path.)
        git('update-index', '--force-remove', pr);
        git('update-index', '--add', '--cacheinfo', `120000,${blob},${pr}`);
        expect(() => ensureReviewTmpDir('fetch-pr')).toThrow(
          /tracks a symbolic link/,
        );

        // …and so is one DEEPER than a direct child. The round writes at
        // depth 2 — `recordedPromptPath` under the per-target prompt-record
        // directory — so a sweep narrowed to direct children would admit a
        // plant on a path it writes through.
        git('update-index', '--force-remove', pr);
        git(
          'update-index',
          '--add',
          '--cacheinfo',
          `120000,${blob},${join(pr, 'x.txt')}`,
        );
        expect(() => ensureReviewTmpDir('fetch-pr')).toThrow(
          /tracks a symbolic link/,
        );
      } finally {
        dispose();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses an INDEX-ONLY link at the scratch directory, and one level up',
    () => {
      // A checkout with `core.symlinks=false`, or a link a later step
      // replaced on disk by a real directory: `lstat` passes, the index
      // still says plant.
      const { git, blob, dispose } = plantedRepo();
      try {
        git('update-index', '--add', '--cacheinfo', `120000,${blob},.qwen/tmp`);
        expect(() => ensureReviewTmpDir('capture-local')).toThrow(
          /tracks a symbolic link at .*\.qwen\/tmp\b/s,
        );
        git('update-index', '--force-remove', '.qwen/tmp');
        git('update-index', '--add', '--cacheinfo', `120000,${blob},.qwen`);
        expect(() => ensureReviewTmpDir('capture-local')).toThrow(
          /tracks a symbolic link at .*\.qwen\b/s,
        );
      } finally {
        dispose();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reads an index past the default 1 MiB buffer rather than failing closed on it',
    () => {
      const { root, blob, dispose } = plantedRepo();
      try {
        const bulk = Array.from(
          { length: 20000 },
          (_, i) =>
            `100644 ${blob} 0\t.qwen/tmp/plain/${'p'.repeat(60)}-${i}.txt`,
        ).join('\n');
        execFileSync('git', ['update-index', '--add', '--index-info'], {
          cwd: root,
          input: `${bulk}\n`,
        });
        expect(
          execFileSync('git', ['ls-files', '-s'], {
            cwd: root,
            maxBuffer: 64 * 1024 * 1024,
          }).length,
        ).toBeGreaterThan(1024 * 1024);
        expect(() => ensureReviewTmpDir('capture-local')).not.toThrow();
      } finally {
        dispose();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses when git cannot answer INSIDE a repository — from the cwd or an ancestor',
    () => {
      // git unusable inside a repository — absent from PATH here, dubious
      // ownership or a ceiling directory in the field — is a refusal, not
      // "outside any repository": the `.git` above decides that, and a git
      // that cannot list the index cannot vouch for it either.
      const { root, dispose } = plantedRepo();
      const savedPath = process.env['PATH'];
      process.env['PATH'] = join(root, 'no-git-here');
      try {
        expect(() => ensureReviewTmpDir('capture-local')).toThrow(
          /^capture-local: could not list the tracked entries under/,
        );
        // …from a SUBDIRECTORY too, where the `.git` that decides it is an
        // ancestor and not the cwd — a review runs from wherever the
        // operator started it, and a one-level check would fail open there.
        mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
        process.chdir(join(root, 'packages', 'cli'));
        expect(() => ensureReviewTmpDir('capture-local')).toThrow(
          /^capture-local: could not list the tracked entries under/,
        );
        // …and a directory under no repository at all still passes: the
        // walk answers "outside", and a review outside a repo has no index
        // to consult.
        const bare = realpathSync(mkdtempSync(join(tmpdir(), 'norepo-')));
        process.chdir(bare);
        try {
          expect(() => ensureReviewTmpDir('capture-local')).not.toThrow();
        } finally {
          process.chdir(root);
          rmSync(bare, { recursive: true, force: true });
        }
      } finally {
        process.env['PATH'] = savedPath;
        dispose();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses an index git cannot parse at all',
    () => {
      const { root, dispose } = plantedRepo();
      try {
        writeFileSync(join(root, '.git', 'index'), 'not an index');
        expect(() => ensureReviewTmpDir('capture-local')).toThrow(
          /^capture-local: could not list the tracked entries under/,
        );
      } finally {
        dispose();
      }
    },
  );
});

describe('ensureReviewTmpDir — the guarded set is pinned, not documented', () => {
  it('names every module that builds a scratch path from the shared helpers', () => {
    // `ensureReviewTmpDir`'s docblock says the unguarded commands "run
    // after one of them in the same checkout" — a prose invariant about
    // SKILL ordering, not a property of the code, and a new module or a
    // new SKILL step escapes it with every suite green. This inventory is
    // the drift detector: a module that builds a scratch path from
    // `REVIEW_TMP_DIR` or `tmpFile()` either guards it or is listed here
    // with the reason it need not.
    //
    // Scoped honestly, and narrower than the docblock's invariant: a module
    // that hand-spells the literal, or takes the directory from a caller's
    // `--out` (as `plan-diff` does), is invisible here. What it does close
    // is the shape a new writer in this codebase actually takes — the
    // helpers are how every existing one names the directory.
    const unguardedByDesign = new Map([
      [
        'commands/review/cleanup.ts',
        'deletes and reads only, and keeps its own ancestor gate',
      ],
      ['commands/review/run.ts', 'reads the artifacts a capture already wrote'],
      [
        'commands/review/lib/sandboxed-exec.ts',
        'names the directory to mount it, writes none',
      ],
      ['commands/review/lib/paths.ts', 'is the guard'],
      [
        'commands/review/compose-review.ts',
        'reads a stop sidecar and removes one; its --out write needs the ' +
          'composed input a capture wrote, so it is never a round first writer',
      ],
      [
        'services/review-worktree-lease.ts',
        'writes under a repository root its CALLER supplies, which the ' +
          'cwd-scoped guard cannot check; its only writing caller is ' +
          'fetch-pr, which guards the cwd it then passes',
      ],
    ]);
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const walk = (rel: string): string[] =>
      readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(`${rel}/${e.name}`)
          : e.name.endsWith('.ts') && !e.name.includes('.test.')
            ? [`${rel}/${e.name}`.replace(/^\.\//, '')]
            : [],
      );
    const files = walk('.');
    // The scan is only as good as its reach: a refactor that moves the
    // review commands elsewhere would otherwise leave it passing over
    // nothing at all.
    expect(files.length).toBeGreaterThan(50);
    const unguarded: string[] = [];
    for (const file of files) {
      const src = readFileSync(join(root, file), 'utf8');
      if (!/\bREVIEW_TMP_DIR\b|\btmpFile\(/.test(src)) continue;
      // A CALL, not a mention: a module that names the guard only in a
      // comment ("that is the captures' job, not ours") would otherwise
      // exempt itself from the very inventory this is.
      if (src.includes('ensureReviewTmpDir(')) continue;
      if (unguardedByDesign.has(file)) continue;
      unguarded.push(file);
    }
    expect(unguarded).toEqual([]);
    // …and the allowlist itself does not rot: an entry for a module that
    // has since taken the guard, or vanished, is a stale exemption.
    for (const file of unguardedByDesign.keys()) {
      const src = readFileSync(join(root, file), 'utf8');
      expect(src.includes('ensureReviewTmpDir(')).toBe(
        file === 'commands/review/lib/paths.ts',
      );
    }
  });
});

describe('ensureReviewTmpDir — the scratch directory as the target itself', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses when .qwen/tmp itself is the link, not only a path under it',
    () => {
      // `--out .qwen/tmp` is the one spelling that is equal to the scratch
      // directory rather than under it; both predicates that gate the guard
      // have to admit it, so the guard has to answer for it.
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'tmpdir-')));
      const cwd = process.cwd();
      process.chdir(root);
      try {
        const victim = join(root, 'victim');
        mkdirSync(victim);
        mkdirSync(join(root, '.qwen'));
        symlinkSync(victim, join(root, '.qwen', 'tmp'));
        expect(() => ensureReviewTmpDir('fetch-diff')).toThrow(
          /^fetch-diff: .*tmp is a symbolic link/s,
        );
      } finally {
        process.chdir(cwd);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('canonicalise walk-up — backslash is a POSIX filename byte', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps a leading backslash through the ancestor walk',
    () => {
      // R23: the walk-up strip treated `\` as a separator on POSIX, so a
      // dangling symlink literally named `\link` (realpath THROWS on a
      // dangling link, which is what reaches the walk at all) came back as
      // `link` — the capture then diffed a different name and the real
      // entry dropped mutely; this PR's own `notes\` fixtures insist the
      // byte is ordinary. Only the platform's separators are stripped now.
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'repo-rel-')));
      try {
        symlinkSync('no-such-target', join(root, '\\link'));
        const out = repoRelativeOf(root, '\\link', root);
        expect(out.escapes).toBe(false);
        expect(out.rel).toBe('\\link');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
