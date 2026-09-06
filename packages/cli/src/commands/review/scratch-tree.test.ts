/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Against a REAL git repo, for the same reason `base-tree`'s suite is: what
// breaks here is the worktree lifecycle — a detached add at the right SHA, a
// leftover from a crashed run, a reused tree that must come back PRISTINE — and
// none of that is exercised by mocking `spawnSync`.
//
// The invariant every test below is really about is the one the command exists
// for: after any of this, the shared review worktree is byte-for-byte what its
// commit says it is. A scratch tree that works but lets one write through is a
// scratch tree that has failed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
}));
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import yargs, { type Argv } from 'yargs';
import {
  runScratchTree,
  scratchTreeCommand,
  type ScratchTreeArgs,
} from './scratch-tree.js';
import { scratchWorktreePath } from './lib/paths.js';
import { isolateHostGitConfig } from './lib/test-utils.js';
import { shellQuotePath } from './lib/shell-quote.js';

describe('runScratchTree', () => {
  let repo: string;
  // See `lib/worktree.test.ts`: a polluted host gitconfig makes the fixture
  // commit throw, and every test here errors before it asserts anything.
  let gitIsolation: ReturnType<typeof isolateHostGitConfig>;
  let worktree: string;
  let headSha: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  const run = (label = 'verify--round-1--abc123') =>
    runScratchTree({ worktree, label });

  beforeEach(() => {
    gitIsolation = isolateHostGitConfig();
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-scratch-tree-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
    // Every JS repo a review runs in ignores its dependency directory; the
    // fixture follows. (The reuse reset itself deletes ignored paths —
    // `clean -ffdx` — and re-links the farm afterwards.)
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'head');
    headSha = git(repo, 'rev-parse', 'HEAD');
    worktree = join(repo, '.qwen', 'tmp', 'review-pr-1');
    mkdirSync(join(repo, '.qwen', 'tmp'), { recursive: true });
    git(repo, 'worktree', 'add', '--detach', '-q', worktree, headSha);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    gitIsolation.dispose();
  });

  it('stands up a sibling tree at the commit under review', () => {
    const r = run();
    expect(r.available).toBe(true);
    expect(r.headSha).toBe(headSha);
    expect(r.path).toBe(
      scratchWorktreePath(worktree, 'verify--round-1--abc123'),
    );
    expect(git(r.path!, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(readFileSync(join(r.path!, 'a.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
  });

  it('refuses while repo-local config defines a content filter — checkouts would execute it', () => {
    // NO_HOOKS covers hooks only; a checkout still runs a configured
    // smudge/clean filter, and the common dir the planting surface lives in
    // is never wiped — so the refusal names the surface instead of running
    // whatever it holds.
    const pwned = join(repo, 'PWNED-smudge');
    git(worktree, 'config', 'filter.evil.smudge', `touch ${pwned}`);
    writeFileSync(join(worktree, 'a.ts'), 'dirty\n');

    const r = run();

    expect(r.available).toBe(false);
    expect(r.note).toContain('filter.evil.smudge');
    expect(existsSync(pwned)).toBe(false);
    expect(
      existsSync(scratchWorktreePath(worktree, 'verify--round-1--abc123')),
    ).toBe(false);

    // A repo WITHOUT the filter still gets a tree (the global-config filters
    // a user's own git-lfs install carries are not this surface).
    git(worktree, 'config', '--unset', 'filter.evil.smudge');
    expect(run().available).toBe(true);
  });

  it('refuses a filter reached through include.path — the same plant, one indirection away', () => {
    // A `--file` read lists the include directive and not what it delivers;
    // the screen follows it (measured executing during a checkout when it
    // did not). The payload sits in a file the PR itself could commit.
    const pwned = join(repo, 'PWNED-included-smudge');
    writeFileSync(
      join(repo, 'innocuous.cfg'),
      `[filter "evil"]\n\tsmudge = touch ${pwned}\n`,
    );
    git(worktree, 'config', 'include.path', join(repo, 'innocuous.cfg'));
    writeFileSync(join(worktree, 'a.ts'), 'dirty\n');

    const r = run();

    expect(r.available).toBe(false);
    expect(r.note).toContain('filter.evil.smudge');
    expect(existsSync(pwned)).toBe(false);
  });

  it("screens ANOTHER worktree's per-worktree config, not just this one's", () => {
    // The screen runs against the review worktree, but the checkout it
    // authorises runs in the SCRATCH tree — whose own
    // `<common>/worktrees/<label>/config.worktree` is honored once
    // `extensions.worktreeConfig` is on and was not among the files read. A
    // filter planted there executed during the reset while this function
    // reported the repository clean, so the screen now reads every entry under
    // the common dir's `worktrees/`.
    const first = run();
    expect(first.available).toBe(true);

    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: worktree, encoding: 'utf8' },
    ).trim();
    const scratchAdmin = join(
      common,
      'worktrees',
      basename(first.path!),
      'config.worktree',
    );
    execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], {
      cwd: worktree,
    });
    writeFileSync(
      scratchAdmin,
      '[filter "planted"]\n\tsmudge = touch /tmp/qwen-should-never-run\n',
    );

    const r = run();

    expect(r.available).toBe(false);
    expect(r.note).toContain('filter.planted.smudge');
  });

  it('places it BESIDE the review worktree, never inside it', () => {
    // Nested, every probe file would land in the tree this command exists to
    // keep clean — and in the PR's own diff with it.
    const r = run();
    expect(r.path!.startsWith(`${worktree}/`)).toBe(false);
    expect(r.path!.startsWith(`${worktree}-scratch-`)).toBe(true);
  });

  it('gives two labels two trees — one round runs its shards concurrently', () => {
    // A shared scratch tree would be the same race one level down: shard B
    // editing the file shard A is measuring.
    const a = run('verify--round-2--aaa');
    const b = run('verify--round-2--bbb');
    expect(a.path).not.toBe(b.path);
    expect(existsSync(a.path!)).toBe(true);
    expect(existsSync(b.path!)).toBe(true);
  });

  it('refuses an empty label rather than defaulting to a shared tree', () => {
    const r = runScratchTree({ worktree, label: '  ' });
    expect(r.available).toBe(false);
    expect(r.note).toContain('--label is required');
  });

  it('cannot be steered out of the temp dir by a crafted label', () => {
    // The label arrives over a CLI flag. A traversal in it would aim both the
    // `git worktree add` and cleanup's later delete at another directory.
    const r = run('../../../../etc/passwd');
    expect(r.available).toBe(true);
    expect(r.path!.startsWith(`${worktree}-scratch-`)).toBe(true);
    expect(r.path).not.toContain('..');
  });

  it('hands back a PRISTINE tree on reuse — a stale mutant is a wrong verdict', () => {
    // The failure this closes: finding A's probe leaves a mutant behind, finding
    // B's probe runs against it, and the verdict carries a deterministic source
    // tag over contaminated code.
    const first = run();
    writeFileSync(join(first.path!, 'a.ts'), 'export const x = 2;\n');
    writeFileSync(join(first.path!, '__probe__.test.ts'), 'it("x", () => {});');

    const second = run();
    expect(second.available).toBe(true);
    expect(second.reused).toBe(true);
    expect(second.path).toBe(first.path);
    expect(readFileSync(join(second.path!, 'a.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
    expect(existsSync(join(second.path!, '__probe__.test.ts'))).toBe(false);
  });

  it('rebuilds over a leftover directory instead of resetting the PARENT checkout', () => {
    // The reuse path runs `git checkout --force` with the scratch path as cwd.
    // A bare directory there — what a crashed `worktree add` or a cleanup whose
    // `rmSync` failed leaves behind — has no `.git`, so git walks UP and finds
    // the user's own checkout, which the scratch path sits inside: their
    // uncommitted work discarded, their HEAD detached onto the PR's commit, and
    // `rev-parse HEAD` then returning the sha that makes the reset report
    // success. Measured on a real repo before the `.git` gate.
    const tree = scratchWorktreePath(worktree, 'verify--round-1--abc123');
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, 'junk.txt'), 'from a run that died\n');
    // The parent checkout, as a user would leave it: on a branch, with work.
    writeFileSync(join(repo, 'a.ts'), 'LOCAL UNCOMMITTED WORK\n');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

    const r = run();

    expect(r.available).toBe(true);
    // Rebuilt, not "reused" — the leftover was never treated as a worktree.
    expect(r.reused).toBe(false);
    expect(existsSync(join(tree, 'junk.txt'))).toBe(false);
    expect(existsSync(join(tree, '.git'))).toBe(true);
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(headSha);
    // And the user's checkout is exactly as they left it.
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(readFileSync(join(repo, 'a.ts'), 'utf8')).toBe(
      'LOCAL UNCOMMITTED WORK\n',
    );
  });

  it('removes a nested repo a probe left behind — `-fd` alone would not', () => {
    // `git clean -fd` refuses to delete a nested git repository, so a probe that
    // cloned or `git init`-ed a fixture inside its scratch tree would survive
    // the reset while the report says "anything you left in it is gone".
    const first = run();
    const nested = join(first.path!, 'fixture-repo');
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: nested });
    writeFileSync(join(nested, 'fixture.txt'), 'from the last probe\n');

    const second = run();
    expect(second.reused).toBe(true);
    expect(existsSync(nested)).toBe(false);
  });

  it('refuses to call a tree pristine when skip-worktree hides a mutant', () => {
    // `checkout --force` silently skips a file carrying the bit and `clean`
    // never touches tracked files, so the mutant survives with `git status`
    // reading empty and the sha still matching. The reset has to notice and
    // hand the caller the rebuild path instead.
    for (const bit of ['--skip-worktree', '--assume-unchanged']) {
      const first = run();
      execFileSync('git', ['update-index', bit, 'a.ts'], { cwd: first.path! });
      writeFileSync(join(first.path!, 'a.ts'), `MUTANT ${bit}\n`);

      const second = run();
      expect(second.available).toBe(true);
      expect(second.reused).toBe(false); // rebuilt, not "reset"
      expect(readFileSync(join(second.path!, 'a.ts'), 'utf8')).toBe(
        'export const x = 1;\n',
      );
    }
  });

  it('rebuilds when the leftover has a .git that git cannot use', () => {
    // A gitfile whose admin dir is gone (a killed cleanup, a `worktree prune`)
    // passes the registration gate and fails inside the reset — the catch must
    // take it to discard-and-rebuild rather than let the throw escape.
    const first = run();
    // The git-created gitfile refuses an in-place overwrite on Windows
    // (EPERM, even after clearing the read-only attribute); deleting and
    // recreating works there and is an ordinary rewrite on POSIX.
    rmSync(join(first.path!, '.git'), { force: true });
    writeFileSync(join(first.path!, '.git'), 'gitdir: /nowhere/at/all\n');

    const second = run();
    expect(second.available).toBe(true);
    expect(second.reused).toBe(false);
    expect(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: second.path!,
        encoding: 'utf8',
      }).trim(),
    ).toBe(headSha);
  });

  it("never fires the user repository's hooks", () => {
    // The scratch tree is a LINKED worktree, so its hooks resolve to the common
    // dir — the user's own `.git/hooks`. `worktree add` and `checkout` both run
    // `post-checkout` from there, which would make creating or resetting a
    // scratch tree execute whatever that repository holds.
    const log = join(repo, 'hook.log');
    const hook = join(repo, '.git', 'hooks', 'post-checkout');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\necho fired >> ${log}\n`);
    chmodSync(hook, 0o755);

    run(); // creation path
    run(); // reset path
    expect(existsSync(log)).toBe(false);
  });

  it('replaces a node_modules it did not build rather than trusting it', () => {
    // The reuse reset deletes ignored paths and re-links the farm afterwards,
    // so anything a probe installed or planted in `node_modules` goes with
    // them rather than resolving as a dependency for every later probe in
    // the shard.
    mkdirSync(join(worktree, 'node_modules', 'vitest'), { recursive: true });
    const first = run();
    expect(first.dependencies).toMatchObject({ linked: 1 });
    writeFileSync(
      join(first.path!, 'node_modules', 'planted-stub.js'),
      'module.exports = 1;\n',
    );

    const second = run();
    expect(second.reused).toBe(true);
    expect(
      existsSync(join(second.path!, 'node_modules', 'planted-stub.js')),
    ).toBe(false);
    expect(existsSync(join(second.path!, 'node_modules', 'vitest'))).toBe(true);
  });

  it('rebuilds rather than resetting a scratch path that is a symlink', () => {
    // Probe code has a shell in this tree and the report tells it the path. A
    // symlink there would aim `checkout --force`, `clean -ffdx` and the farm's
    // rebuild at whatever it resolves to — including the shared review
    // worktree. Rebuilding is the safe answer: `discardWorktree` unlinks a
    // symlink rather than following it.
    const first = run();
    const victim = join(repo, 'victim');
    mkdirSync(join(victim, 'keep'), { recursive: true });
    rmSync(first.path!, { recursive: true, force: true });
    symlinkSync(victim, first.path!, 'dir');

    const second = run();
    expect(second.available).toBe(true);
    expect(second.reused).toBe(false);
    expect(existsSync(join(victim, 'keep'))).toBe(true);
  });

  it('clears IGNORED probe state too — pristine means pristine', () => {
    // Sparing ignored paths kept the farm cheap and left a probe's own
    // `node_modules` at any depth, its build caches and its mutated `dist/`
    // standing under a report that said the tree was back at the commit.
    const first = run();
    mkdirSync(join(first.path!, 'fixtures', 'node_modules'), {
      recursive: true,
    });
    writeFileSync(
      join(first.path!, 'fixtures', 'node_modules', 'planted.js'),
      'x',
    );

    const second = run();
    expect(second.reused).toBe(true);
    expect(existsSync(join(second.path!, 'fixtures'))).toBe(false);
  });

  it('rebuilds when the tree belongs to a DIFFERENT repository', () => {
    // `rev-parse --show-toplevel` prints the directory the `.git` file sits in,
    // whatever that file points at — so a gitfile naming another repository
    // passes a self-consistency check while every command below would run
    // against someone else's objects, refs, hooks and config.
    // A CLONE, so the commit the reset checks out exists there too — otherwise
    // the reset fails for the wrong reason and the test would pass without the
    // guard it is meant to pin.
    const other = join(repo, 'other-repo');
    execFileSync('git', ['clone', '-q', repo, other]);
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: other });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: other });
    writeFileSync(join(other, 'o.txt'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: other });
    execFileSync('git', ['commit', '-qm', 'one'], { cwd: other });

    const first = run();
    rmSync(join(first.path!, '.git'), { force: true }); // see the note above
    writeFileSync(
      join(first.path!, '.git'),
      `gitdir: ${join(other, '.git')}\n`,
    );

    const second = run();
    expect(second.available).toBe(true);
    expect(second.reused).toBe(false);
    // The other repository is untouched: still on its branch, still holding its
    // own file.
    expect(
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: other,
        encoding: 'utf8',
      }).trim(),
    ).toBe('main');
    expect(existsSync(join(other, 'o.txt'))).toBe(true);
  });

  it('rebuilds over a .git SYMLINK at the scratch path — never resets the main checkout', () => {
    // A genuine linked worktree carries `.git` as a FILE; a symlink at that
    // path naming the repo's own gitdir passed every identity check —
    // measured live: `--show-toplevel` named the scratch dir and the common
    // dirs compared equal — while `checkout --force --detach` detached the
    // USER's HEAD onto the PR sha and rewrote the main index.
    const tree = scratchWorktreePath(worktree, 'verify--round-1--abc123');
    mkdirSync(tree, { recursive: true });
    symlinkSync(join(repo, '.git'), join(tree, '.git'));
    writeFileSync(join(repo, 'a.ts'), 'LOCAL UNCOMMITTED WORK\n');

    const r = run();

    expect(r.available).toBe(true);
    expect(r.reused).toBe(false); // rebuilt, not reset
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(readFileSync(join(repo, 'a.ts'), 'utf8')).toBe(
      'LOCAL UNCOMMITTED WORK\n',
    );
  });

  it('rebuilds when the scratch .git FILE names the common dir', () => {
    // The same main-checkout shape without a symlink: a `.git` file whose
    // `gitdir:` line names the common dir itself. A linked tree's gitdir is
    // `<common>/worktrees/<name>`; equality means the tree claims to be the
    // main checkout, where the reset must never land.
    const tree = scratchWorktreePath(worktree, 'verify--round-1--abc123');
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, '.git'), `gitdir: ${join(repo, '.git')}\n`);
    writeFileSync(join(repo, 'a.ts'), 'LOCAL UNCOMMITTED WORK\n');

    const r = run();

    expect(r.available).toBe(true);
    expect(r.reused).toBe(false);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(readFileSync(join(repo, 'a.ts'), 'utf8')).toBe(
      'LOCAL UNCOMMITTED WORK\n',
    );
  });

  it('rebuilds when the scratch .git borrows a SIBLING worktree’s admin entry', () => {
    // A planted gitfile naming another worktree's admin entry passes every
    // other identity check — directory, gitfile, toplevel resolving to itself,
    // common dirs comparing equal, gitdir distinct from the commondir — while
    // the reset detaches the SIBLING's HEAD onto the PR sha and wipes its
    // staged index. The admin entry's `gitdir` backpointer names the tree it
    // belongs to; a borrowed entry's names the sibling.
    const first = run();
    const sibling = join(repo, 'sibling-wt');
    git(repo, 'worktree', 'add', '--detach', '-q', sibling, 'HEAD');
    writeFileSync(join(sibling, 's.txt'), 'sibling work\n');
    git(sibling, 'add', 's.txt');
    git(sibling, 'commit', '-qm', 'sibling work');
    writeFileSync(join(sibling, 'a.ts'), 'SIBLING UNCOMMITTED\n');
    git(sibling, 'add', 'a.ts');
    const siblingHead = git(sibling, 'rev-parse', 'HEAD');
    expect(siblingHead).not.toBe(headSha);
    const admin = git(
      sibling,
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
    );

    rmSync(join(first.path!, '.git'), { force: true }); // see the note above
    writeFileSync(join(first.path!, '.git'), `gitdir: ${admin}\n`);

    const second = run();

    expect(second.available).toBe(true);
    expect(second.reused).toBe(false); // rebuilt, not reset
    expect(readFileSync(join(second.path!, 'a.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
    // The sibling is untouched: HEAD where it was, staged change intact.
    expect(git(sibling, 'rev-parse', 'HEAD')).toBe(siblingHead);
    expect(git(sibling, 'diff', '--cached', '--name-only')).toBe('a.ts');
  });

  it('ignores a GIT_DIR inherited from the environment', () => {
    // An exported GIT_DIR overrides repository discovery for the ENTIRE
    // identity gate at once — both sides of every comparison see the same
    // override, so no check can detect it — and the head sha itself comes back
    // from the wrong repository. Every git call this command makes must drop
    // the redirect and resolve the tree it was given.
    const sibling = join(repo, 'env-sibling');
    git(repo, 'worktree', 'add', '--detach', '-q', sibling, 'HEAD');
    writeFileSync(join(sibling, 's.txt'), 'x\n');
    git(sibling, 'add', 's.txt');
    git(sibling, 'commit', '-qm', 'sibling');
    const admin = git(
      sibling,
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
    );
    const siblingHead = git(sibling, 'rev-parse', 'HEAD');
    expect(siblingHead).not.toBe(headSha);

    process.env['GIT_DIR'] = admin;
    let r: ReturnType<typeof run>;
    try {
      r = run();
    } finally {
      delete process.env['GIT_DIR'];
    }

    expect(r.available).toBe(true);
    // The sha came from the review worktree, not the redirect target.
    expect(r.headSha).toBe(headSha);
    expect(git(sibling, 'rev-parse', 'HEAD')).toBe(siblingHead);
  });

  it('is unavailable when the worktree’s .git file is gone — never walked up', () => {
    // With the `.git` file missing — a crash mid-`worktree add`, a cleanup
    // whose rmSync failed — git's discovery walks UP into the user's
    // checkout: HEAD resolves to the user's branch, the residue probe names
    // the user's own dirty paths, and the note's restore recipe is aimed at
    // them. Measured live before this check: `available: true` at the USER's
    // head sha, the scratch tree registered in the user's repo.
    writeFileSync(join(repo, 'a.ts'), 'LOCAL UNCOMMITTED WORK\n');
    rmSync(join(worktree, '.git'));

    const r = run();

    expect(r.available).toBe(false);
    expect(r.note).toContain('not a git worktree');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(readFileSync(join(repo, 'a.ts'), 'utf8')).toBe(
      'LOCAL UNCOMMITTED WORK\n',
    );
  });

  it('rebuilds when a submodule was initialized in the tree', () => {
    // Nothing in the reset reaches inside an initialized submodule, and
    // `rev-parse HEAD` is the superproject's — so a mutant in there would ride
    // a "pristine" report into the next probe. A fresh tree has it
    // uninitialized, which is why rebuilding is the answer.
    const sub = join(repo, 'sub-origin');
    mkdirSync(sub, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: sub });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: sub });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: sub });
    writeFileSync(join(sub, 's.txt'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: sub });
    execFileSync('git', ['commit', '-qm', 'one'], { cwd: sub });
    execFileSync(
      'git',
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        sub,
        'vendor',
      ],
      { cwd: repo },
    );
    execFileSync('git', ['commit', '-qm', 'add submodule'], { cwd: repo });
    // The worktree was created from the PREVIOUS head; move it to the commit
    // that carries the submodule, which is what the scratch tree copies.
    headSha = execFileSync('git', ['rev-parse', 'main'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['checkout', '--detach', '-q', headSha], {
      cwd: worktree,
    });

    const first = run();
    execFileSync(
      'git',
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'update',
        '--init',
        '-q',
      ],
      { cwd: first.path! },
    );
    writeFileSync(join(first.path!, 'vendor', 's.txt'), 'MUTANT\n');

    const second = run();
    expect(second.reused).toBe(false);
    expect(existsSync(join(second.path!, 'vendor', 's.txt'))).toBe(false);
  });

  it('refuses a label that flattens to nothing rather than sharing one tree', () => {
    // `???` and `!!!` are two different non-empty labels with no path-safe
    // character between them: a fallback would put both shards in one tree —
    // the race the label exists to prevent, reached through the sanitiser.
    for (const label of ['???', '!!!']) {
      const r = runScratchTree({ worktree, label });
      expect(r.available).toBe(false);
      expect(r.note).toContain('--label is required');
    }
  });

  it('rebuilds the farm on reuse rather than inheriting it', () => {
    mkdirSync(join(worktree, 'node_modules', 'vitest'), { recursive: true });
    const first = run();
    expect(first.dependencies).toEqual({
      linked: 1,
      failed: 0,
      alreadyPresent: false,
      selfLinked: 0,
    });

    const second = run();
    expect(second.reused).toBe(true);
    // Re-linked rather than trusted: `node_modules` is the one ignored path a
    // reuse does not inherit, because it is where a probe may install.
    expect(second.dependencies).toEqual({
      linked: 1,
      failed: 0,
      alreadyPresent: false,
      selfLinked: 0,
    });
    expect(existsSync(join(second.path!, 'node_modules', 'vitest'))).toBe(true);
  });

  it('says which harness gap it hit when node_modules holds nothing linkable', () => {
    // The shape a killed `npm install` leaves. `{linked: 0, failed: 0}` reads
    // identically to "the farm was already there", and the two want opposite
    // things said to the verifier.
    mkdirSync(join(worktree, 'node_modules'), { recursive: true });
    writeFileSync(join(worktree, 'node_modules', '.package-lock.json'), '{}');

    const r = run();
    expect(r.dependencies).toEqual({
      linked: 0,
      failed: 0,
      alreadyPresent: false,
      selfLinked: 0,
    });
    expect(r.note).toContain('held nothing linkable');
    expect(r.note).not.toContain('already in place');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'says linking FAILED rather than "no node_modules" when the farm throws',
    () => {
      // Folding a link failure into the same `null` the absent case uses told
      // the verifier the worktree had no `node_modules` — about a worktree that
      // has one — sending it to install a tree that only needed a retry.
      const nm = join(worktree, 'node_modules');
      mkdirSync(join(nm, 'vitest'), { recursive: true });
      chmodSync(nm, 0o000); // readdirSync throws EACCES inside the farm
      try {
        const r = run();
        expect(r.available).toBe(true);
        // Counted, not swallowed and not thrown: the farm is best-effort, and
        // "0 linked, 1 failed" is the honest shape — never "the review worktree
        // has no node_modules", which sends the verifier to install a tree that
        // only needed a retry.
        expect(r.dependencies).toEqual({
          linked: 0,
          failed: 1,
          alreadyPresent: false,
          selfLinked: 0,
        });
        expect(r.note).toContain('could not be');
        expect(r.note).not.toContain('has no `node_modules`');
      } finally {
        chmodSync(nm, 0o755);
      }
    },
  );

  it('is unavailable — with its reason — when the worktree is not a checkout', () => {
    // Outside any repository, so git cannot discover one by walking up.
    const plain = mkdtempSync(join(tmpdir(), 'qwen-not-a-checkout-'));
    try {
      const r = runScratchTree({ worktree: plain, label: 'verify' });
      expect(r.available).toBe(false);
      expect(r.note).toContain('cannot read HEAD');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('leaves the shared review worktree untouched by everything it does', () => {
    // The whole point, asserted directly.
    const r = run();
    writeFileSync(join(r.path!, 'a.ts'), 'export const x = 99;\n');
    writeFileSync(join(r.path!, 'probe.test.ts'), 'it("x", () => {});');

    expect(readFileSync(join(worktree, 'a.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
    expect(git(worktree, 'status', '--porcelain')).toBe('');
  });

  it('reports residue in the shared worktree — the tree others are reading', () => {
    // The cleanliness check: a verifier that wrote into the shared tree before
    // it had a scratch tree learns so at the moment it asks for one, instead of
    // a concurrent auditor discovering it as a phantom Critical.
    writeFileSync(join(worktree, 'a.ts'), 'export const x = 2;\n');
    writeFileSync(join(worktree, '__probe__.test.ts'), 'it("x", () => {});');

    const r = runScratchTree({
      worktree,
      label: 'verify--round-1--abc123',
      fetchedSha: headSha,
    });
    expect(r.available).toBe(true);
    expect(r.sharedTreeResidue.sort()).toEqual(['__probe__.test.ts', 'a.ts']);
    expect(r.sharedTreeResidueTotal).toBe(2);
    expect(r.note).toContain('the shared review worktree is NOT clean');
    expect(r.note).toContain('__probe__.test.ts');
  });

  it('says how many dirty paths it did NOT list', () => {
    // A capped list presented as the complete one is a verifier restoring the
    // twelve it was shown and leaving the thirteenth in the tree the next round
    // reads.
    for (let i = 0; i < 13; i++) {
      writeFileSync(join(worktree, `f${i}.ts`), 'x\n');
    }
    const r = runScratchTree({
      worktree,
      label: 'verify--round-1--abc123',
      fetchedSha: headSha,
    });
    expect(r.sharedTreeResidueTotal).toBe(13);
    expect(r.sharedTreeResidue).toHaveLength(12);
    expect(r.note).toContain('1 more paths not listed here');
    expect(r.note).toContain('--untracked-files=all');
  });

  it('names every residue shape its own recovery, including the staged ones', () => {
    // Built from the real shapes, not from prose: a staged rename is reported
    // under BOTH names, and they take opposite commands — `git rm --cached` on
    // the original would stage a deletion rather than clear one.
    writeFileSync(join(worktree, 'a.ts'), 'export const x = 2;\n');
    writeFileSync(join(worktree, 'staged-new.ts'), 'x\n');
    execFileSync('git', ['add', 'staged-new.ts'], { cwd: worktree });
    execFileSync('git', ['mv', '.gitignore', 'ignore-rules'], {
      cwd: worktree,
    });

    const r = runScratchTree({
      worktree,
      label: 'verify--round-1--abc123',
      fetchedSha: headSha,
    });
    expect(r.sharedTreeResidue.sort()).toEqual([
      '.gitignore',
      'a.ts',
      'ignore-rules',
      'staged-new.ts',
    ]);
    expect(r.note).toContain('git checkout HEAD -- <path>');
    expect(r.note).toContain('git rm --cached <path>');
    expect(r.note).toContain('rm -rf <path>');
    // The rename's ORIGINAL name comes back with checkout, not with rm --cached.
    expect(r.note).toContain('git checkout HEAD -- <original>');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports UNMEASURED rather than clean when the residue check cannot run',
    () => {
      // A `git status` that dies (a tree too dirty for its buffer, an index it
      // cannot read) returns the same empty list a pristine tree does; a script
      // reading the field and a verifier reading the note both have to be able
      // to tell the two apart. `rev-parse HEAD` does not need the index, so the
      // command still gets far enough to report.
      const index = execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
        { cwd: worktree, encoding: 'utf8' },
      ).trim();
      chmodSync(index, 0o000);
      try {
        const r = runScratchTree({
          worktree,
          label: 'verify--round-1--unmeasured',
        });
        expect(r.sharedTreeUnmeasured).toBeTruthy();
        expect(r.note).toContain('could not be measured');
      } finally {
        chmodSync(index, 0o644);
      }
    },
  );

  it('refuses a CLEAN shared worktree it measured without the fetched sha', () => {
    // The probe's clean verdict is the dangerous one: a forged pair answers
    // clean too, and this caller brings no record to pin the identity — so
    // an empty measurement is unmeasured, never clean (#9557). The note is
    // the fail-closed half: an unmeasured tree is not a clean one.
    const r = run();
    expect(r.sharedTreeResidue).toEqual([]);
    expect(r.note).not.toContain('NOT clean');
    expect(r.sharedTreeUnmeasured).toContain('brought no record');
    expect(r.note).toContain('could not be measured');
    // ...and the note does not blame `git status`: the refusal fired AFTER a
    // clean status, so a triager sent to debug the git environment finds
    // nothing. The framing names a reason, not a failed command.
    expect(r.note).toContain('(reason: ');
    expect(r.note).not.toContain('git status failed');
  });

  it('measures a CLEAN shared worktree when the caller brings the fetched sha', () => {
    // The pipeline caller's shape: fetch-pr records the sha in the plan and
    // agent-prompt welds it into this command, so a healthy run measures
    // clean — an unmeasured note that fired on every run would be noise
    // nobody reads, and the genuine refusals would drown in it (#9742).
    const r = runScratchTree({
      worktree,
      label: 'verify--round-1--pinned',
      fetchedSha: headSha,
    });
    expect(r.available).toBe(true);
    expect(r.sharedTreeResidue).toEqual([]);
    expect(r.sharedTreeUnmeasured).toBeUndefined();
    expect(r.note).not.toContain('could not be measured');
  });

  it('refuses BEFORE any reset or creation when the worktree is not at the fetched sha it brought', () => {
    // The pin-mismatch signal the anchor exists for: the shared tree at B
    // while the plan records reviewed commit A used to proceed with
    // reset/creation at B and report `available: true`, handing a verifier
    // an available tree at code other than the reviewed head with the
    // mismatch disclosed only inside a NOTE. The refusal must come first —
    // no reset, no creation, no path.
    const r = runScratchTree({
      worktree,
      label: 'verify--round-1--wrong-sha',
      fetchedSha: `deadbeef${'0'.repeat(32)}`,
    });
    expect(r.available).toBe(false);
    expect(r.path).toBeUndefined();
    expect(r.note).toContain('not the fetched PR head');
    expect(
      existsSync(scratchWorktreePath(worktree, 'verify--round-1--wrong-sha')),
    ).toBe(false);
  });

  it('refuses a fetched sha that is not a full Git object ID', () => {
    // The record arrives over a CLI flag and is welded into commands a
    // verifier copies; a shape the pin cannot compare is refused before it
    // reaches anything — neither the 39-hex truncation nor a non-hex string
    // is a commit. Full object IDs are 40 hex (SHA-1) or 64 hex (SHA-256).
    for (const sha of ['not-a-sha', 'a'.repeat(39), 'g'.repeat(40)]) {
      const r = runScratchTree({
        worktree,
        label: 'verify--bad-sha',
        fetchedSha: sha,
      });
      expect(r.available).toBe(false);
      expect(r.path).toBeUndefined();
      expect(r.note).toContain('not a full Git object ID');
    }
    // A 64-hex value IS the shape — on this SHA-1 tree it reaches the
    // mismatch refusal, proving the validator admitted it.
    const sha256Shape = runScratchTree({
      worktree,
      label: 'verify--sha256-shape',
      fetchedSha: 'ab'.repeat(32),
    });
    expect(sha256Shape.available).toBe(false);
    expect(sha256Shape.note).toContain('not the fetched PR head');
    expect(sha256Shape.note).not.toContain('not a full Git object ID');
  });

  it('folds case when comparing the fetched sha, like the residue pin', () => {
    // The plan records `git rev-parse` verbatim and a caller may carry it
    // uppercase; the pin folds case on both sides, so the scratch-tree
    // validation must too — an uppercase record of the RIGHT commit is not
    // a mismatch.
    const r = runScratchTree({
      worktree,
      label: 'verify--round-1--upper-sha',
      fetchedSha: headSha.toUpperCase(),
    });
    expect(r.available).toBe(true);
    expect(r.sharedTreeResidue).toEqual([]);
    expect(r.sharedTreeUnmeasured).toBeUndefined();
  });

  it('links the review worktree’s node_modules in, and says so', () => {
    mkdirSync(join(worktree, 'node_modules', 'vitest'), { recursive: true });
    mkdirSync(join(worktree, 'node_modules', '@scope', 'pkg'), {
      recursive: true,
    });

    const r = run();
    expect(r.dependencies).toEqual({
      linked: 2,
      failed: 0,
      alreadyPresent: false,
      selfLinked: 0,
    });
    expect(existsSync(join(r.path!, 'node_modules', 'vitest'))).toBe(true);
    expect(r.note).toContain('2 dependencies linked in');
  });

  it('says a harness will not start when there is nothing to link', () => {
    // Silence here would send the verifier hunting a mysterious
    // `vitest: not found` in a tree that was never the problem.
    const r = run();
    expect(r.dependencies).toBeNull();
    expect(r.note).toContain('no `node_modules`');
    expect(r.note).toContain('never in the review worktree');
  });

  it('is unavailable — not silently degraded — when there is no worktree', () => {
    const r = runScratchTree({
      worktree: join(repo, 'no', 'such', 'tree'),
      label: 'verify',
    });
    expect(r.available).toBe(false);
    expect(r.path).toBeUndefined();
    expect(r.note).toContain('does not exist');
  });

  // Windows as well as root: `chmodSync` on a directory there sets only the
  // read-only attribute, which does not stop `git worktree add` from creating a
  // subdirectory — the guard would be a no-op and the assertion below would fail
  // on the merge-queue-only Windows leg. Every other chmod-permission test in
  // this repo skips win32 for the same reason.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps the measured residue when the tree could not be created',
    () => {
      // The failure path must not collapse to the empty-residue default: a note
      // that names contaminated paths beside a `sharedTreeResidue: []` field
      // tells a reader and a script two different things.
      writeFileSync(join(worktree, '__probe__.test.ts'), 'it("x", () => {});');
      const parent = join(repo, '.qwen', 'tmp');
      chmodSync(parent, 0o555); // `git worktree add` cannot create the directory
      try {
        const r = runScratchTree({
          worktree,
          label: 'verify--round-1--zzz',
          fetchedSha: headSha,
        });
        expect(r.available).toBe(false);
        expect(r.sharedTreeResidue).toEqual(['__probe__.test.ts']);
        // The total belongs to the same report: a list longer than its own total
        // contradicts what the field documents.
        expect(r.sharedTreeResidueTotal).toBe(1);
        expect(r.note).toContain('NOT clean');
        expect(r.note).toContain(
          'Do NOT fall back to probing in the review worktree',
        );
      } finally {
        chmodSync(parent, 0o755);
      }
    },
  );

  it('never executes the user’s GLOBAL fsmonitor or hooksPath — the checkouts and the residue measurement blank both', () => {
    // The user's own config is their contract for their own git commands, so
    // the screen declines to refuse it — but this command's checkouts and its
    // residue `status` are not the user's commands. A global fsmonitor fires
    // on any index refresh (`worktree add`, the reset's `checkout --force`,
    // the residue `status` on a stat-stale file), and a global hooksPath
    // fires `post-checkout` on the checkouts and `post-index-change` on the
    // index write the residue refresh makes; both are blanked on every spawn
    // that could execute them, and no marker appears.
    const mark = (name: string) => join(repo, `PWNED-${name}`);
    git(repo, 'config', '--global', 'core.fsmonitor', `touch ${mark('fsmon')}`);
    const hooks = join(repo, 'global-hooks');
    mkdirSync(hooks, { recursive: true });
    for (const hook of ['post-index-change', 'post-checkout']) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch ${mark(hook)}\n`);
      chmodSync(join(hooks, hook), 0o755);
    }
    git(repo, 'config', '--global', 'core.hooksPath', hooks);
    const stale = new Date(Date.now() + 60_000);
    utimesSync(join(worktree, 'a.ts'), stale, stale);
    const markers = () =>
      ['fsmon', 'post-index-change', 'post-checkout']
        .filter((name) => existsSync(mark(name)))
        .sort();

    const fresh = run();
    expect(fresh.available).toBe(true);
    expect(fresh.reused).toBe(false);
    expect(markers()).toEqual([]);
    utimesSync(join(worktree, 'a.ts'), stale, stale);
    const reused = run();
    expect(reused.available).toBe(true);
    expect(reused.reused).toBe(true);
    expect(markers()).toEqual([]);
  });

  describe('the CLI option contract', () => {
    // Every fetchedSha test above builds its args by hand, but the only
    // production delivery of the sha is the `--fetched-sha` flag, read off
    // yargs' camel-cased parse as `fetchedSha`. If the option key and the
    // field ever drift, every real invocation arrives unpinned and the suite
    // stays green — the bug class `--build-test` shipped into `test-plan`,
    // pinned here the same way: parse through the real builder, and assert on
    // what the run does with the parse rather than on the parse's shape.
    it('parses --fetched-sha into the field runScratchTree actually reads', () => {
      // .strict() matters: a lenient parser camel-cases unknown flags and
      // passes them through, so dropping the --fetched-sha registration from
      // the builder would keep this test green while the real command (whose
      // root parser IS strict) rejects the flag.
      const parse = (argv: string[]) =>
        (scratchTreeCommand.builder as (y: Argv) => Argv)(
          yargs([]).strict(),
        ).parseSync(argv) as unknown as ScratchTreeArgs;

      // Reachable only if the parsed field reached the residue anchor: the
      // identical call without it answers unmeasured instead of clean.
      const clean = runScratchTree(
        parse([
          '--worktree',
          worktree,
          '--label',
          'verify--round-1--cli',
          '--fetched-sha',
          headSha,
        ]),
      );
      expect(clean.sharedTreeUnmeasured).toBeUndefined();
      expect(clean.sharedTreeResidue).toEqual([]);

      // And a wrong sha still reaches the pin through the same parse.
      const forged = runScratchTree(
        parse([
          '--worktree',
          worktree,
          '--label',
          'verify--round-1--cli-forged',
          '--fetched-sha',
          `deadbeef${'0'.repeat(32)}`,
        ]),
      );
      expect(forged.available).toBe(false);
      expect(forged.note).toContain('not the fetched PR head');
    });
  });

  describe('the command handler', () => {
    beforeEach(() => {
      process.exitCode = undefined;
      (writeStdoutLine as unknown as ReturnType<typeof vi.fn>).mockClear();
    });
    afterEach(() => {
      process.exitCode = undefined;
    });

    it('refuses a directory --out BEFORE standing anything up', () => {
      // The class `assertWritableOutPath` exists for: without it the tree and
      // its farm are built, `writeFileSync` dies EISDIR, and a usage typo
      // exit-codes as a runtime failure with the usable tree's path lost.
      const outDir = join(repo, 'reports');
      mkdirSync(outDir, { recursive: true });
      (scratchTreeCommand.handler as (a: unknown) => void)({
        worktree,
        label: 'verify--round-1--out',
        out: outDir,
      });
      expect(process.exitCode).toBe(2);
      expect(
        existsSync(scratchWorktreePath(worktree, 'verify--round-1--out')),
      ).toBe(false);
    });

    it('prints the report before writing the side file', () => {
      const out = join(repo, 'reports', 'scratch.json');
      (scratchTreeCommand.handler as (a: unknown) => void)({
        worktree,
        label: 'verify--round-1--out',
        out,
      });
      expect(process.exitCode).toBeUndefined();
      const printed = (writeStdoutLine as unknown as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as string;
      expect(JSON.parse(printed).available).toBe(true);
      expect(JSON.parse(readFileSync(out, 'utf8')).path).toBe(
        scratchWorktreePath(worktree, 'verify--round-1--out'),
      );
    });

    it('keeps the report on stdout when the side-file write dies — and exits 1', () => {
      // The ordering is load-bearing, and both statements happening in either
      // order satisfies the test above. A self-referential symlink passes the
      // pre-check (`existsSync` is false through ELOOP) and throws at the write,
      // which is also the only exit-1 arm: without it, `exitCode = 2` as a
      // constant would pass every other case and tell a caller to repair a
      // sound invocation.
      const out = join(repo, 'reports', 'loop.json');
      mkdirSync(dirname(out), { recursive: true });
      symlinkSync(out, out);
      (scratchTreeCommand.handler as (a: unknown) => void)({
        worktree,
        label: 'verify--round-1--loop',
        out,
      });
      expect(process.exitCode).toBe(1);
      const printed = (writeStdoutLine as unknown as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as string;
      expect(JSON.parse(printed).available).toBe(true);
    });
  });
});

describe('runScratchTree --standalone', () => {
  // The prose-execution audit's tree. Its input is untrusted — a recipe the
  // PR author wrote — so the tree is a repository of its own, sharing only the
  // object store through an alternates pointer: what a recipe step writes into
  // config, hooks or refs lands in the tree and dies with it — the state does;
  // a command-valued key written there is live at the tree's next git
  // command, which is the brief's reach rule to judge. And the command
  // runs nothing that could execute the user's repo-local config in their
  // repository to build it — no clone, no `worktree add`, no checkout, no
  // residue `status` — which is what makes the repo-local config screen the
  // linked shape needs beside the point here.
  let repo: string;
  let gitIsolation: ReturnType<typeof isolateHostGitConfig>;
  let worktree: string;
  let headSha: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  const run = (
    label = 'prose-exec--round-1--abc123',
    extra: Partial<ScratchTreeArgs> = {},
  ) => runScratchTree({ worktree, label, standalone: true, ...extra });

  beforeEach(() => {
    gitIsolation = isolateHostGitConfig();
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-scratch-tree-sa-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    // Selects a filter by name; whether one is DEFINED is per-repository
    // config, which is exactly what a standalone tree does not inherit.
    writeFileSync(join(repo, '.gitattributes'), 'a.ts filter=evil\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'head');
    headSha = git(repo, 'rev-parse', 'HEAD');
    worktree = join(repo, '.qwen', 'tmp', 'review-pr-1');
    mkdirSync(join(repo, '.qwen', 'tmp'), { recursive: true });
    git(repo, 'worktree', 'add', '--detach', '-q', worktree, headSha);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    gitIsolation.dispose();
  });

  it('stands up a repository of its own, sharing only the object store', () => {
    const r = run();
    expect(r.available).toBe(true);
    expect(r.standalone).toBe(true);
    expect(r.reused).toBe(false);
    expect(r.headSha).toBe(headSha);
    expect(r.path).toBe(
      scratchWorktreePath(worktree, 'prose-exec--round-1--abc123'),
    );
    // A directory, not a gitfile: nothing points into the user's repository
    // except the alternates line, which names its object store and nothing
    // else.
    expect(statSync(join(r.path!, '.git')).isDirectory()).toBe(true);
    expect(
      realpathSync(
        readFileSync(
          join(r.path!, '.git', 'objects', 'info', 'alternates'),
          'utf8',
        ).trim(),
      ),
    ).toBe(realpathSync(join(repo, '.git', 'objects')));
    expect(git(r.path!, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(readFileSync(join(r.path!, 'a.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
    // No remote (it was never cloned), no template hooks, and no registration
    // in the user's worktree list — it is not a worktree of that repository.
    expect(git(r.path!, 'remote')).toBe('');
    expect(existsSync(join(r.path!, '.git', 'hooks'))).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(r.path!);
    expect(r.note).toContain('STANDALONE repository');
    // The shared tree is reported as unmeasured, never as clean: measuring it
    // is a `git status` in the user's repository, which this shape does not run.
    expect(r.sharedTreeResidue).toEqual([]);
    expect(r.sharedTreeUnmeasured).toContain('not measured');
    expect(r.note).not.toContain('NOT clean');
  });

  it('says the containment is of STATE — a command-valued key written inside still executes there', () => {
    // R14-1: "dies with the tree" read as a sandbox. `git config
    // core.hooksPath .githooks`, a committed hook, then `git commit` ran the
    // hook as the reviewer — each step innocuous by its text. The note keeps
    // the containment sentence and, beside it, names the class and the read
    // that establishes a git step's reach (the brief carries the full rule).
    const r = run();
    expect(r.note).toContain('die with the tree — the STATE does');
    expect(r.note).toContain('core.hooksPath');
    expect(r.note).toContain('executes at your next git command in the tree');
    expect(r.note).toContain('git config --local --list --includes');
    // And the premise of the containment — the tree's own `.git` — is
    // conditional, because the tree sits inside the user's checkout: the
    // note names the ceiling that makes a `.git`-less tree fail loudly
    // instead of re-parenting onto the user's repository, with the exact
    // directory, and calls a step that removes `.git` leaving the tree.
    expect(r.note).toContain(
      `GIT_CEILING_DIRECTORIES=${shellQuotePath(dirname(r.path!))}`,
    );
    expect(r.note).toContain('removes or replaces `.git` as leaving the tree');
  });

  it('keeps a config, hook or ref write inside the tree from reaching the user’s repository', () => {
    // The class a shared-common-dir screen would have to enumerate — a
    // command-valued config key, an executable hook, a commit — planted from
    // inside the tree by a recipe step. In a linked worktree every one of
    // these lands in the user's `.git`; here they land in the tree's own.
    const r = run();
    git(r.path!, 'config', 'core.editor', 'PLANTED');
    mkdirSync(join(r.path!, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(r.path!, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
    chmodSync(join(r.path!, '.git', 'hooks', 'pre-commit'), 0o755);
    writeFileSync(join(r.path!, 'a.ts'), 'mutant\n');
    git(
      r.path!,
      '-c',
      'user.email=p@p.p',
      '-c',
      'user.name=p',
      'commit',
      '-qam',
      'planted',
    );

    expect(git(r.path!, 'config', '--get', 'core.editor')).toBe('PLANTED');
    expect(() => git(repo, 'config', '--get', 'core.editor')).toThrow();
    expect(() => git(worktree, 'config', '--get', 'core.editor')).toThrow();
    expect(existsSync(join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(git(repo, 'rev-list', '--all', '--count')).toBe('1');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(git(worktree, 'status', '--porcelain')).toBe('');
  });

  it('runs no checkout or index refresh in the user’s repository — its planted command-valued config never executes', () => {
    // Every command-valued key a same-user planter can put into the user's
    // repo-local config, each armed on a surface one of the linked shape's
    // git invocations would trip: a smudge filter (a checkout of an attributed
    // file), a clean filter (an index refresh of a stat-stale attributed file
    // — what the residue `status` does), an fsmonitor (any index refresh), and
    // a hooksPath with the hooks an index write and a checkout fire. The
    // standalone shape stands up its tree with none of those markers created,
    // because it runs no checkout and no `status` in that repository — the
    // property that makes it need no screen. The linked shape, which does run
    // them, is refused by its screen before anything executes: the control.
    const mark = (name: string) => join(repo, `PWNED-${name}`);
    git(repo, 'config', 'filter.evil.smudge', `touch ${mark('smudge')}`);
    git(repo, 'config', 'filter.evil.clean', `touch ${mark('clean')} && cat`);
    git(repo, 'config', 'core.fsmonitor', `touch ${mark('fsmonitor')}`);
    const hooks = join(repo, 'evil-hooks');
    mkdirSync(hooks, { recursive: true });
    for (const hook of ['post-index-change', 'post-checkout']) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch ${mark(hook)}\n`);
      chmodSync(join(hooks, hook), 0o755);
    }
    git(repo, 'config', 'core.hooksPath', hooks);
    const stale = new Date(Date.now() + 60_000);
    utimesSync(join(worktree, 'a.ts'), stale, stale);
    const markers = () =>
      ['smudge', 'clean', 'fsmonitor', 'post-index-change', 'post-checkout']
        .filter((name) => existsSync(mark(name)))
        .sort();

    const r = run();
    expect(r.available).toBe(true);
    expect(markers()).toEqual([]);
    // The tree's own checkout read the tree's own config, which selects the
    // filter by attribute but defines no such filter — the file is verbatim.
    expect(readFileSync(join(r.path!, 'a.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );

    const linked = runScratchTree({ worktree, label: 'verify--round-1--x' });
    expect(linked.available).toBe(false);
    expect(linked.note).toContain('filter.evil.smudge');
    expect(markers()).toEqual([]);
  });

  it('rebuilds on every call — what the last call wrote is gone', () => {
    const first = run();
    writeFileSync(join(first.path!, '__probe__.test.ts'), 'it("x", () => {});');
    writeFileSync(join(first.path!, 'a.ts'), 'mutant\n');
    git(first.path!, 'config', 'probe.left', 'behind');
    mkdirSync(join(first.path!, 'node_modules', 'left'), { recursive: true });

    const second = run();
    expect(second.available).toBe(true);
    expect(second.reused).toBe(false);
    expect(second.path).toBe(first.path);
    expect(existsSync(join(second.path!, '__probe__.test.ts'))).toBe(false);
    expect(existsSync(join(second.path!, 'node_modules', 'left'))).toBe(false);
    expect(readFileSync(join(second.path!, 'a.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
    expect(() => git(second.path!, 'config', '--get', 'probe.left')).toThrow();
    expect(git(second.path!, 'rev-parse', 'HEAD')).toBe(headSha);
  });

  it('replaces a LINKED tree an earlier call left at the path, and unregisters it', () => {
    // Same label, other shape: the path is shared between the two modes, and
    // a linked worktree standing there is registered in the user's repository.
    // Plain `rmSync` would leave that registration to wedge the next
    // `worktree add`; the gitfile sends it through `discardWorktree` instead.
    const label = 'prose-exec--round-1--abc123';
    const linked = runScratchTree({ worktree, label });
    expect(linked.available).toBe(true);
    expect(statSync(join(linked.path!, '.git')).isFile()).toBe(true);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(
      linked.path!,
    );

    const r = run(label);
    expect(r.available).toBe(true);
    expect(r.path).toBe(linked.path);
    expect(statSync(join(r.path!, '.git')).isDirectory()).toBe(true);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(r.path!);
    expect(existsSync(join(repo, '.git', 'worktrees', basename(r.path!)))).toBe(
      false,
    );
  });

  it('is replaced by a LINKED call at the same path — rebuilt, never reset as if it were one', () => {
    // The other direction: a standalone leftover is a foreign repository at
    // the scratch path, and the linked shape's reset gate must send it down
    // discard-and-rebuild rather than `checkout --force` inside it.
    const label = 'prose-exec--round-1--abc123';
    const first = run(label);
    expect(statSync(join(first.path!, '.git')).isDirectory()).toBe(true);

    const linked = runScratchTree({ worktree, label });
    expect(linked.available).toBe(true);
    expect(linked.reused).toBe(false);
    expect(linked.standalone).toBe(false);
    expect(statSync(join(linked.path!, '.git')).isFile()).toBe(true);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(
      linked.path!,
    );
  });

  it('rebuilds over a symlink at the path without following it', () => {
    const first = run();
    const victim = join(repo, 'victim');
    mkdirSync(join(victim, 'keep'), { recursive: true });
    rmSync(first.path!, { recursive: true, force: true });
    symlinkSync(victim, first.path!, 'dir');

    const second = run();
    expect(second.available).toBe(true);
    expect(lstatSync(second.path!).isSymbolicLink()).toBe(false);
    expect(existsSync(join(victim, 'keep'))).toBe(true);
    expect(existsSync(join(victim, '.git'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a tree that could not be built — the shared tree still unmeasured',
    () => {
      const parent = join(repo, '.qwen', 'tmp');
      chmodSync(parent, 0o555);
      try {
        const r = run('prose-exec--round-1--abc123', { fetchedSha: headSha });
        expect(r.available).toBe(false);
        expect(r.standalone).toBe(true);
        expect(r.path).toBeUndefined();
        expect(r.note).toContain(
          'could not stand up a standalone scratch tree',
        );
        expect(r.note).toContain('Do NOT fall back');
        expect(r.sharedTreeUnmeasured).toContain('not measured');
      } finally {
        chmodSync(parent, 0o755);
      }
    },
  );

  it('refuses BEFORE building when the worktree is not at the fetched sha', () => {
    // The identity gate is shared with the linked shape: a standalone tree may
    // only stand at the reviewed head, and a drifted shared worktree is
    // refused before anything is created.
    const other = 'f'.repeat(40);
    const r = run('prose-exec--round-1--abc123', { fetchedSha: other });
    expect(r.available).toBe(false);
    expect(r.standalone).toBe(true);
    expect(r.note).toContain('not the fetched PR head');
    expect(
      existsSync(scratchWorktreePath(worktree, 'prose-exec--round-1--abc123')),
    ).toBe(false);
  });

  it('follows the source repository’s object format', () => {
    // An alternates pointer into a store of another format is unusable, so
    // the tree is initialised with the source's format — pinned on a SHA-256
    // repository, where a sha1 `git init` would leave the checkout unable to
    // resolve the reviewed head at all.
    const repo256 = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-scratch-tree-sa256-')),
    );
    try {
      git(repo256, 'init', '-q', '-b', 'main', '--object-format=sha256');
      git(repo256, 'config', 'user.email', 't@t.t');
      git(repo256, 'config', 'user.name', 't');
      writeFileSync(join(repo256, 'a.ts'), 'export const x = 256;\n');
      git(repo256, 'add', '-A');
      git(repo256, 'commit', '-qm', 'head');
      const sha256 = git(repo256, 'rev-parse', 'HEAD');
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
      const wt256 = join(repo256, '.qwen', 'tmp', 'review-pr-1');
      mkdirSync(join(repo256, '.qwen', 'tmp'), { recursive: true });
      git(repo256, 'worktree', 'add', '--detach', '-q', wt256, sha256);

      const r = runScratchTree({
        worktree: wt256,
        label: 'prose-exec--round-1--abc123',
        standalone: true,
        fetchedSha: sha256,
      });
      expect(r.available).toBe(true);
      expect(git(r.path!, 'rev-parse', 'HEAD')).toBe(sha256);
      expect(git(r.path!, 'rev-parse', '--show-object-format')).toBe('sha256');
      expect(readFileSync(join(r.path!, 'a.ts'), 'utf8')).toBe(
        'export const x = 256;\n',
      );
    } finally {
      rmSync(repo256, { recursive: true, force: true });
    }
  });

  it('keeps a sha1 source sha1 when the environment asks for sha256 — the format is the source’s, not the knob’s', () => {
    // The sibling test pins the sha256 direction; this pins sha1, against
    // BOTH knobs that flip a bare `git init`: `init.defaultObjectFormat` in
    // the (isolated) global config, and `GIT_DEFAULT_HASH`, its environment
    // spelling. A sha256 store beside a sha1 source cannot read the source's
    // objects through the alternates pointer, so the checkout of the
    // reviewed head fails. The command names the source's format explicitly
    // in both directions — the config knob is what a bare init would honor
    // once the environment is sanitized — and drops the variable from its
    // git environment (pinned on `sanitizedGitEnv` directly, since the
    // explicit flag masks its absence here).
    writeFileSync(
      join(gitIsolation.home, '.gitconfig'),
      '[init]\n\tdefaultObjectFormat = sha256\n',
    );
    const saved = process.env['GIT_DEFAULT_HASH'];
    process.env['GIT_DEFAULT_HASH'] = 'sha256';
    try {
      const r = run(undefined, { fetchedSha: headSha });
      expect(r.available).toBe(true);
      expect(git(r.path!, 'rev-parse', '--show-object-format')).toBe('sha1');
      expect(git(r.path!, 'rev-parse', 'HEAD')).toBe(headSha);
    } finally {
      if (saved === undefined) delete process.env['GIT_DEFAULT_HASH'];
      else process.env['GIT_DEFAULT_HASH'] = saved;
    }
  });

  it('links the review worktree’s node_modules in, like the linked shape', () => {
    mkdirSync(join(worktree, 'node_modules', 'vitest'), { recursive: true });
    const r = run();
    expect(r.dependencies).toEqual({
      linked: 1,
      failed: 0,
      alreadyPresent: false,
      selfLinked: 0,
    });
    expect(
      lstatSync(join(r.path!, 'node_modules', 'vitest')).isSymbolicLink(),
    ).toBe(true);
    // The one write path out of the tree, disclosed where the field doc says.
    expect(r.note).toContain('a write THROUGH one of');
  });

  it('leaves the shared review worktree untouched — and does not measure it', () => {
    writeFileSync(join(worktree, '__probe__.test.ts'), 'it("x", () => {});');
    const r = run('prose-exec--round-1--abc123', { fetchedSha: headSha });
    expect(r.available).toBe(true);
    // Unmeasured, not clean: the linked shape would have named this file.
    expect(r.sharedTreeResidue).toEqual([]);
    expect(r.sharedTreeUnmeasured).toContain('not measured');
    expect(r.note).not.toContain('NOT clean');
    expect(r.note).toContain('did not measure');
    expect(git(worktree, 'status', '--porcelain')).toBe('?? __probe__.test.ts');
  });

  it('parses --standalone into the field runScratchTree reads', () => {
    const parse = (argv: string[]) =>
      (scratchTreeCommand.builder as (y: Argv) => Argv)(
        yargs([]).strict(),
      ).parseSync(argv) as unknown as ScratchTreeArgs;
    const flagged = runScratchTree(
      parse([
        '--worktree',
        worktree,
        '--label',
        'prose-exec--round-1--cli',
        '--standalone',
      ]),
    );
    expect(flagged.standalone).toBe(true);
    expect(statSync(join(flagged.path!, '.git')).isDirectory()).toBe(true);
    // The verifier's invocation — no flag — still gets the linked shape.
    const plain = runScratchTree(
      parse(['--worktree', worktree, '--label', 'verify--round-1--cli']),
    );
    expect(plain.standalone).toBe(false);
    expect(statSync(join(plain.path!, '.git')).isFile()).toBe(true);
  });
});
