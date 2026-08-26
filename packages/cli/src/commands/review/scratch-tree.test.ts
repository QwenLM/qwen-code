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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails CLOSED when the worktrees admin dir cannot be listed — the class is unknowable',
    () => {
      // A mode-0111 `<common>/worktrees`: `readdirSync` throws EACCES while
      // git still reads the entries' `config.worktree` by name, so the
      // authorised checkout would execute a filter planted there (measured
      // live). The old catch read ANY readdir failure as "no linked
      // worktrees" — the same empty answer the genuine absence produces —
      // and silently dropped the entire admin-dir candidate class.
      const first = run();
      expect(first.available).toBe(true);
      const common = execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: worktree, encoding: 'utf8' },
      ).trim();
      writeFileSync(
        join(common, 'worktrees', basename(first.path!), 'config.worktree'),
        '[filter "planted"]\n\tsmudge = touch /tmp/qwen-should-never-run\n',
      );
      const admin = join(common, 'worktrees');
      chmodSync(admin, 0o111);
      try {
        const r = run();
        expect(r.available).toBe(false);
        expect(r.note).toContain(
          'worktrees admin directory could not be listed',
        );
      } finally {
        chmodSync(admin, 0o755);
      }
    },
  );

  it('admits a repository with no worktrees admin dir at all — ENOENT is empty, not unknowable', () => {
    // The fixture always carries a linked worktree, so build one without:
    // its `<common>/worktrees` does not exist, and the catch reading it must
    // read that as "no linked worktrees", not as a refusal — only readdir
    // failures other than ENOENT are the unknowable state.
    const plain = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-no-worktrees-')),
    );
    try {
      git(plain, 'init', '-q', '-b', 'main');
      git(plain, 'config', 'user.email', 't@t.t');
      git(plain, 'config', 'user.name', 't');
      writeFileSync(join(plain, 'a.ts'), 'x\n');
      git(plain, 'add', '-A');
      git(plain, 'commit', '-qm', 'head');
      expect(existsSync(join(plain, '.git', 'worktrees'))).toBe(false);

      const r = runScratchTree({ worktree: plain, label: 'verify--enoent' });

      expect(r.available).toBe(true);
      rmSync(r.path!, { recursive: true, force: true });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('refuses the command-valued keys the value check cannot certify — git executes their values', () => {
    // A recipe step running `git config core.fsmonitor CMD` from the copy
    // lands in the host's COMMON config — textually an in-copy write,
    // actually a plant that outlives the copy's removal and executes at the
    // user's own next git operations (R12-1, measured live for fsmonitor and
    // alias plants). The fail-closed screen refuses every one of these: the
    // command-carrying shapes among them are not certifiable from their
    // values, and a state indistinguishable from a plant is a refusal,
    // whatever key carries it.
    for (const [key, value] of [
      ['core.fsmonitor', 'node fsmon.js'],
      ['core.pager', 'evil-pager'],
      ['alias.st', '!sh -c evil'],
      ['core.sshCommand', 'evil-ssh'],
      ['credential.helper', '!evil-helper'],
    ] as Array<[string, string]>) {
      git(worktree, 'config', key, value);

      const r = run();

      expect(r.available).toBe(false);
      expect(r.note).toContain('fail-closed screen');
      expect(
        existsSync(scratchWorktreePath(worktree, 'verify--round-1--abc123')),
      ).toBe(false);

      // The key is the user's to remove — once gone, a tree stands again.
      git(worktree, 'config', '--unset', key);
      expect(run().available).toBe(true);
      rmSync(scratchWorktreePath(worktree, 'verify--round-1--abc123'), {
        recursive: true,
        force: true,
      });
      git(worktree, 'worktree', 'prune');
    }
  });

  it('fails CLOSED on key shapes it cannot certify as inert — known-executable misses included', () => {
    // The screen used to be a blocklist of command-valued shapes, and the
    // class is git-defined and open: probe-demonstrated entrances sat
    // outside it — `core.editor` executes at the user's own next commit,
    // `gpg.program` at the next signed commit, `diff.<driver>.textconv` at
    // the next diff, the per-URL `credential.<url>.helper` at the next
    // credential fill (R12-1). An enumeration of the EXECUTED family never
    // converges across git versions, so the screen now admits a repo-local
    // key only when its inertness IS established, and refuses everything
    // else — including shapes no git version executes, because their
    // inertness is just as uncertifiable.
    for (const key of [
      'core.editor',
      'sequence.editor',
      'gpg.program',
      'diff.evil.textconv',
      'merge.evil.driver',
      'credential.https://x.example.helper',
      'sendemail.sendmailcmd',
      'sometool.custom.setting',
    ]) {
      git(worktree, 'config', key, 'evil-command');

      const r = run();

      expect(r.available).toBe(false);
      expect(r.note).toContain(key);
      expect(
        existsSync(scratchWorktreePath(worktree, 'verify--round-1--abc123')),
      ).toBe(false);

      // The key is the user's to remove — once gone, a tree stands again.
      git(worktree, 'config', '--unset', key);
    }
    expect(run().available).toBe(true);
  });

  it('admits the inert gc.* keys one by one — the section is never certified whole', () => {
    // `gc.recentObjectsHook` (git ≥ 2.45) is shell-executed at the user's
    // own next gc — reachable.c wires it with use_shell — so the
    // section-wide `/^gc\./` shape certified an execution unread: the miss
    // the invariant above the allowlist prices as a refusal, never an
    // execution (R17-2, probed live on git 2.47.3). The section is screened
    // key by key instead: the inert knobs stay admitted, everything
    // unlisted fails closed.
    git(worktree, 'config', 'gc.recentObjectsHook', 'touch PWNED');
    let r = run();
    expect(r.available).toBe(false);
    // Git reports keys lowercased; the refusal names the key git reads.
    expect(r.note).toContain('gc.recentobjectshook');
    git(worktree, 'config', '--unset', 'gc.recentObjectsHook');

    git(worktree, 'config', 'gc.auto', '0');
    git(worktree, 'config', 'gc.pruneExpire', 'now');
    git(worktree, 'config', 'gc.reflogExpire', '90.days');
    r = run();
    expect(r.available).toBe(true);
  });

  it('refuses an include.* key — the imported file is invisible to a per-file scan', () => {
    // `git config --file` reads do not follow includes, so one planted
    // `include.path` importing a command key was invisible to the screen
    // while the merged config the authorised checkouts read resolved and
    // executed it (R12-1). The include directive itself IS visible to the
    // same scan, and a key that can import arbitrary other keys is not
    // certifiable as inert.
    const imported = join(repo, 'imported-config');
    writeFileSync(imported, '[core]\n\tsshCommand = evil\n');
    git(worktree, 'config', 'include.path', imported);

    const r = run();

    expect(r.available).toBe(false);
    expect(r.note).toContain('include.path');
  });

  it('screens the MAIN worktree’s own per-worktree config', () => {
    // With `extensions.worktreeConfig` on, the main checkout's per-worktree
    // config is `<common>/config.worktree` — honored by every checkout, and
    // never among the scanned candidates, so a planted `core.fsmonitor`
    // there fired at the user's own `git status` while the screen reported
    // clean (R12-1).
    git(worktree, 'config', 'extensions.worktreeConfig', 'true');
    execFileSync('git', ['config', '--worktree', 'core.fsmonitor', 'evil'], {
      cwd: repo,
    });

    const r = run();

    expect(r.available).toBe(false);
    expect(r.note).toContain('core.fsmonitor');
  });

  it('screens the repo-local config of the submodule gitdirs under the common dir', () => {
    // `<common>/modules/<name>/config` is repo-local config git honors —
    // the user's own next operations inside the submodule execute it, and
    // `git worktree remove --force` leaves the whole `modules/` dir
    // standing, so a plant there outlives the copy's discard. The screen
    // read only the main and per-worktree configs and admitted the plant
    // while the refusal message claimed every uncertified repo-local key is
    // refused (R17-3, probed live).
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: worktree, encoding: 'utf8' },
    ).trim();
    const first = run();
    expect(first.available).toBe(true);

    const moduleDir = join(common, 'modules', 'vendor');
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(moduleDir, 'config'), '[alias]\n\tpwn = !touch PWNED\n');

    const r = run();
    expect(r.available).toBe(false);
    expect(r.note).toContain('alias.pwn');

    // An empty module gitdir is nothing git reads — admitted, not refused,
    // and neither is a stray plain file under `modules/`: only directories
    // can be gitdirs.
    rmSync(join(moduleDir, 'config'));
    writeFileSync(join(common, 'modules', 'stray'), 'not a gitdir');
    expect(run().available).toBe(true);

    // The sibling placement under a worktree's admin entry, where git since
    // 2.47 puts a submodule initialized inside a LINKED worktree.
    const adminModules = join(
      common,
      'worktrees',
      basename(first.path!),
      'modules',
      'vendor',
    );
    mkdirSync(adminModules, { recursive: true });
    writeFileSync(
      join(adminModules, 'config'),
      '[alias]\n\tpwn = !touch PWNED\n',
    );

    const r2 = run();
    expect(r2.available).toBe(false);
    expect(r2.note).toContain('alias.pwn');
  });

  it('screens the per-worktree configs of worktrees created INSIDE a submodule', () => {
    // A worktree created inside a submodule is a linked worktree of the
    // submodule's repo: once the module carries extensions.worktreeConfig,
    // git honors its `<module-gitdir>/worktrees/<x>/config.worktree` — and
    // the screen read only the module's own config and config.worktree, so a
    // filter planted there fired at the next checkout in that worktree while
    // this command reported the repository clean. The placement is
    // fail-closed one level deeper under a superproject worktree's admin
    // entry too (R18-1, probed live).
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: worktree, encoding: 'utf8' },
    ).trim();
    const first = run();
    expect(first.available).toBe(true);

    const innerConfig = join(
      common,
      'modules',
      'vendor',
      'worktrees',
      'vendor-wt',
      'config.worktree',
    );
    mkdirSync(dirname(innerConfig), { recursive: true });
    writeFileSync(
      innerConfig,
      '[filter "evil"]\n\tsmudge = touch /tmp/qwen-should-never-run\n',
    );

    const r = run();
    expect(r.available).toBe(false);
    expect(r.note).toContain('filter.evil.smudge');
    rmSync(innerConfig);
    expect(run().available).toBe(true);

    // The same class under a superproject worktree admin entry's module.
    const adminInnerConfig = join(
      common,
      'worktrees',
      basename(first.path!),
      'modules',
      'vendor',
      'worktrees',
      'vendor-wt',
      'config.worktree',
    );
    mkdirSync(dirname(adminInnerConfig), { recursive: true });
    writeFileSync(
      adminInnerConfig,
      '[filter "evil"]\n\tsmudge = touch /tmp/qwen-should-never-run\n',
    );

    const r2 = run();
    expect(r2.available).toBe(false);
    expect(r2.note).toContain('filter.evil.smudge');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails CLOSED when a module gitdir’s worktrees dir cannot be listed',
    () => {
      // The per-worktree configs of worktrees inside a submodule are read
      // by git whatever a readdir sees; a dir that cannot be listed leaves
      // the class unknowable — a refusal, like every sibling error path.
      const common = execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: worktree, encoding: 'utf8' },
      ).trim();
      const worktreesDir = join(common, 'modules', 'vendor', 'worktrees');
      mkdirSync(join(worktreesDir, 'vendor-wt'), { recursive: true });
      chmodSync(worktreesDir, 0o111);
      try {
        const r = run();
        expect(r.available).toBe(false);
        expect(r.note).toContain('submodule gitdirs could not be enumerated');
      } finally {
        chmodSync(worktreesDir, 0o755);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'screens the hooks of submodules nested inside a worktree of another submodule',
    () => {
      // git since 2.47 puts a submodule initialized inside a linked
      // worktree under that worktree's admin entry — for a worktree INSIDE
      // a submodule that nests lands under the module gitdir. Its hooks
      // fire at the user's own commits there and survive the copy's
      // discard: the same shared surface one level deeper (R18-1).
      const common = execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: worktree, encoding: 'utf8' },
      ).trim();
      const hook = join(
        common,
        'modules',
        'vendor',
        'worktrees',
        'vendor-wt',
        'modules',
        'inner',
        'hooks',
        'pre-commit',
      );
      mkdirSync(dirname(hook), { recursive: true });
      writeFileSync(hook, '#!/bin/sh\ntouch PWNED\n');
      chmodSync(hook, 0o755);

      const r = run();
      expect(r.available).toBe(false);
      expect(r.note).toContain('pre-commit');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses an EXECUTABLE hook in the hooks dir — the config screen cannot see it',
    () => {
      // A hook carries no config key, so a key screen passes whatever the
      // dir holds; the file fires at the user's own next commit and survives
      // the copy's discard (R12-1). This command's own git runs with hooks
      // disabled — the refusal is for the persistence, planted in the common
      // dir the report calls shared.
      const hook = join(repo, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, '#!/bin/sh\ntouch PWNED\n');
      chmodSync(hook, 0o755);

      const r = run();

      expect(r.available).toBe(false);
      expect(r.note).toContain('pre-commit');
      expect(existsSync(join(repo, 'PWNED'))).toBe(false);

      // Non-executable, git does not run it — and a `.sample` never.
      chmodSync(hook, 0o644);
      expect(run().available).toBe(true);
      writeFileSync(join(repo, '.git', 'hooks', 'evil.sample'), '#!/bin/sh\n');
      chmodSync(join(repo, '.git', 'hooks', 'evil.sample'), 0o755);
      expect(run().available).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails CLOSED when the hooks dir cannot be listed — git still runs hooks by name',
    () => {
      // A mode-0111 hooks dir: `readdirSync` throws EACCES, while git's hook
      // lookup is a by-name stat that needs only traverse — an executable
      // hook inside fires at the user's own next commit while the screen
      // reports clean (measured live). The listing failure used to read as
      // an empty dir; every sibling error path in this command fails closed.
      const hookDir = join(repo, '.git', 'hooks');
      const hook = join(hookDir, 'pre-commit');
      writeFileSync(hook, '#!/bin/sh\ntouch PWNED\n');
      chmodSync(hook, 0o755);
      chmodSync(hookDir, 0o111);
      try {
        const r = run();
        expect(r.available).toBe(false);
        expect(r.note).toContain('hooks directory could not be listed');
        expect(
          existsSync(scratchWorktreePath(worktree, 'verify--round-1--abc123')),
        ).toBe(false);
      } finally {
        chmodSync(hookDir, 0o755);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'screens the hooks dirs of the submodule gitdirs — the config screen cannot see a hook',
    () => {
      // A submodule's hooks stand in its own gitdir under the common dir
      // and fire at the user's own next commit INSIDE the submodule — the
      // same shared-surface persistence the main hooks screen refuses,
      // which never looked there (R17-3, probed live: the planted hook
      // fired on a user submodule commit and again after the copy's
      // discard).
      const common = execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: worktree, encoding: 'utf8' },
      ).trim();
      const first = run();
      expect(first.available).toBe(true);

      const hook = join(common, 'modules', 'vendor', 'hooks', 'pre-commit');
      mkdirSync(dirname(hook), { recursive: true });
      writeFileSync(hook, '#!/bin/sh\ntouch PWNED\n');
      chmodSync(hook, 0o755);

      const r = run();
      expect(r.available).toBe(false);
      expect(r.note).toContain('modules/vendor/hooks/pre-commit');

      // Non-executable, git does not run it.
      chmodSync(hook, 0o644);
      expect(run().available).toBe(true);

      // The worktree-scoped placement too.
      const adminHook = join(
        common,
        'worktrees',
        basename(first.path!),
        'modules',
        'vendor',
        'hooks',
        'pre-commit',
      );
      mkdirSync(dirname(adminHook), { recursive: true });
      writeFileSync(adminHook, '#!/bin/sh\ntouch PWNED\n');
      chmodSync(adminHook, 0o755);

      const r2 = run();
      expect(r2.available).toBe(false);
      expect(r2.note).toContain('pre-commit');
    },
  );

  it('honors a GLOBAL hooksPath redirect for the module hooks dirs too', () => {
    // A repo-local hooksPath is refused upstream by the config screen, so
    // any redirect standing by the time hooks are scanned is global — the
    // user's own contract — and it applies to the submodule gitdirs as
    // well: none of the default dirs is the active surface then, so what
    // stands in them is not this screen's business.
    const globalHooks = join(repo, 'global-hooks');
    mkdirSync(globalHooks, { recursive: true });
    git(repo, 'config', '--global', 'core.hooksPath', globalHooks);
    const hook = join(repo, '.git', 'modules', 'vendor', 'hooks', 'pre-commit');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\ntouch PWNED\n');
    chmodSync(hook, 0o755);

    const r = run();

    expect(r.available).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'fails CLOSED on a RELATIVE global hooksPath — it resolves per-invocation cwd',
    () => {
      // A relative redirect cannot be certified from a LINKED worktree: git
      // resolves it per-invocation cwd, and from the user's own MAIN
      // worktree `.git/hooks` IS the common dir's hooks — the planting
      // surface this screen owns. The old catch resolved it once from here,
      // threw on the gitfile-shaped `.git`, and read the throw as "no
      // redirect" — admitting the planted hook (R18-2, probed live).
      git(repo, 'config', '--global', 'core.hooksPath', '.git/hooks');
      const hook = join(repo, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, '#!/bin/sh\ntouch PWNED\n');
      chmodSync(hook, 0o755);

      const r = run();

      expect(r.available).toBe(false);
      expect(r.note).toContain('hooks redirect could not be certified');
      expect(existsSync(join(repo, 'PWNED'))).toBe(false);
    },
  );

  it('honors a TILDE-leading global hooksPath — git expands it through $HOME', () => {
    // A `~`-leading value is NOT the per-cwd relative shape the check above
    // refuses: git expands `~` through $HOME deterministically, and the
    // resolved hooks dir (from `--git-path hooks`) already carries that
    // absolute path — so it is honored like any absolute redirect, and a
    // common dotfiles pattern (`[core] hooksPath = ~/githooks`) no longer
    // renders every review of that user's repos unavailable (R19-7). ($HOME is
    // the isolated one `isolateHostGitConfig` set, where `~/githooks` does not
    // exist, so the redirect resolves away from the default hooks dir.)
    git(repo, 'config', '--global', 'core.hooksPath', '~/githooks');
    // A hook standing in the DEFAULT dir must not block: the redirect points
    // away from it, so the default dir is not the active surface.
    const defaultHook = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(defaultHook, '#!/bin/sh\ntouch PWNED\n');
    chmodSync(defaultHook, 0o755);

    const r = run();

    expect(r.available).toBe(true);
    // The value is admitted, never refused as uncertifiable.
    expect(r.note).not.toContain('hooks redirect could not be certified');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails CLOSED when the modules dir cannot be listed — git still reads module gitdirs by name',
    () => {
      // A mode-0111 `modules` dir: unreadable to `readdirSync` while git
      // still reads `<common>/modules/<name>/config` and runs hooks by
      // name — the shape the worktrees admin dir and the hooks dir already
      // fail closed on.
      const common = execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: worktree, encoding: 'utf8' },
      ).trim();
      const modulesDir = join(common, 'modules');
      mkdirSync(join(modulesDir, 'vendor'), { recursive: true });
      chmodSync(modulesDir, 0o111);
      try {
        const r = run();
        expect(r.available).toBe(false);
        expect(r.note).toContain('submodule gitdirs could not be enumerated');
      } finally {
        chmodSync(modulesDir, 0o755);
      }
    },
  );

  it('refuses a symlinked entry under the modules dir — it could resolve anywhere', () => {
    // Git's submodule layout creates plain directories; a symlink under
    // `modules/` could name any directory the screen cannot certify, so it
    // belongs to the unknowable class — a refusal, like a dir that cannot
    // be listed.
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: worktree, encoding: 'utf8' },
    ).trim();
    mkdirSync(join(common, 'modules'), { recursive: true });
    symlinkSync(join(repo, 'nowhere'), join(common, 'modules', 'vendor'));

    const r = run();

    expect(r.available).toBe(false);
    expect(r.note).toContain('submodule gitdirs could not be enumerated');
  });

  it('admits a repository whose submodules are initialized — git’s own module keys are inert', () => {
    // Initializing a submodule writes git's own keys into
    // `<common>/modules/<name>/config` — among them `core.worktree`, which
    // the screen must certify or EVERY repository with an initialized
    // submodule stands refused (R17-3's verifier flip). Every key git
    // writes there is admitted; only foreign ones refuse.
    const sub = join(repo, 'sub-origin');
    mkdirSync(sub, { recursive: true });
    git(sub, 'init', '-q', '-b', 'main');
    git(sub, 'config', 'user.email', 't@t.t');
    git(sub, 'config', 'user.name', 't');
    writeFileSync(join(sub, 's.txt'), 'x\n');
    git(sub, 'add', '-A');
    git(sub, 'commit', '-qm', 'one');
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
    git(repo, 'commit', '-qm', 'add submodule');
    headSha = git(repo, 'rev-parse', 'main');
    git(worktree, 'checkout', '--detach', '-q', headSha);
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
      { cwd: repo },
    );

    const r = run();

    expect(r.available).toBe(true);
  });

  it('certifies the inert VALUES of value-checked keys — fail-closed is not value-blind', () => {
    // The old blocklist was value-blind: a boolean `core.fsmonitor` selects
    // git's builtin daemon and an `https://` fetch address names no program
    // — yet all of them refused. The fail-closed screen reads the value where
    // inertness is decidable from it, so benign user config does not block
    // the tree (R12-1's fix).
    git(worktree, 'config', 'core.fsmonitor', 'true');
    git(worktree, 'config', 'remote.origin.url', 'https://example.com/r.git');
    // The `::` refusal cuts at the first `/` precisely so this stays
    // admitted: the address's IPv6 literal carries one of its own.
    git(
      worktree,
      'config',
      'remote.origin.pushurl',
      'ssh://[2001:db8::1]/repo',
    );
    git(
      worktree,
      'config',
      'remote.origin.fetch',
      '+refs/heads/*:refs/remotes/origin/*',
    );
    git(worktree, 'config', 'submodule.vendor.url', '/srv/vendor.git');
    git(worktree, 'config', 'submodule.vendor.update', 'merge');
    // core.worktree resolving INSIDE a registered worktree: '..' from the
    // common dir is the main worktree itself.
    git(worktree, 'config', 'core.worktree', '..');

    const r = run();

    expect(r.available).toBe(true);
  });

  it('admits the sparse-checkout selectors a CI checkout writes repo-locally', () => {
    // `actions/checkout` and other CI plumbing write `core.sparseCheckout`,
    // `core.sparseCheckoutCone` and `index.sparse` into repo-local config;
    // they are booleans that change which tracked paths a checkout writes,
    // never a command, and refusing them left the screen unable to certify a
    // GitHub Actions checkout at all — the tree never stood up there (R19-6).
    git(worktree, 'config', 'core.sparseCheckout', 'true');
    git(worktree, 'config', 'core.sparseCheckoutCone', 'true');
    git(worktree, 'config', 'index.sparse', 'true');

    const r = run();

    expect(r.available).toBe(true);
  });

  it('refuses core.worktree VALUES that redirect checkouts outside the repository', () => {
    // core.worktree is the config analogue of GIT_WORK_TREE: the screen
    // used to admit it unread for every value, so a plant in the common
    // dir aimed the user's own next checkout at any directory git can
    // reach — absent paths at the target are written without a refusal
    // (R18-3, probed live). Only values resolving inside a registered
    // worktree stay admitted; the submodule ../../<path> shape is one
    // (pinned by the initialized-submodule test above).
    for (const value of [
      // An absolute path names any directory.
      '/tmp/qwen-should-never-be-a-worktree',
      // A relative escape resolves past every registered worktree.
      '../../../../evil',
      // The common dir sits inside the main worktree's path, so
      // containment alone admits it — and a checkout aimed there writes
      // through the hooks dir git executes from.
      'hooks',
    ]) {
      git(worktree, 'config', 'core.worktree', value);

      const r = run();

      expect(r.available).toBe(false);
      expect(r.note).toContain('core.worktree');

      git(worktree, 'config', '--unset', 'core.worktree');
      expect(run().available).toBe(true);
      rmSync(scratchWorktreePath(worktree, 'verify--round-1--abc123'), {
        recursive: true,
        force: true,
      });
      git(worktree, 'worktree', 'prune');
    }
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a core.worktree pointing at a SYMLINK that escapes the repository',
    () => {
      // `resolve()` is purely lexical, so a value naming a symlink inside a
      // registered worktree passes containment while git writes the checkout
      // THROUGH the link to an arbitrary directory. Certifying the realpath'd
      // destination closes it (R19-1); the same realpath fold closes the
      // case-insensitive `../.GIT` variant that resolves onto the common dir
      // (R19-3), which cannot be exercised on this case-sensitive volume.
      const victim = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-victim-')));
      try {
        symlinkSync(victim, join(repo, 'link'));
        // Plant into the common config, resolving to `<repo>/link` — inside a
        // registered worktree lexically, but a symlink OUT of it in reality.
        execFileSync(
          'git',
          [
            'config',
            '--file',
            join(repo, '.git', 'config'),
            'core.worktree',
            '../link',
          ],
          {},
        );

        const r = run();

        expect(r.available).toBe(false);
        expect(r.note).toContain('core.worktree');
      } finally {
        rmSync(victim, { recursive: true, force: true });
      }
    },
  );

  it('does not let a PRUNABLE forged worktree entry widen core.worktree containment', () => {
    // `git worktree list --porcelain` emits a `worktree ` line even for a
    // broken admin entry an attacker plants in the common dir, marking it
    // prunable. Admitting it as a containment anchor lets a `core.worktree`
    // plant escape into an attacker-chosen directory; dropping prunable
    // blocks flags it fail-closed (R19-2). (A fully self-consistent forgery —
    // a `.git` gitfile planted at the target that round-trips — is not
    // prunable and stays at the adversary-owns-common-dir boundary, where
    // direct hook/config planting the screens already refuse is the simpler
    // attack.)
    const forged = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-forged-')));
    try {
      const common = execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: worktree, encoding: 'utf8' },
      ).trim();
      const admin = join(common, 'worktrees', 'forged');
      mkdirSync(admin, { recursive: true });
      // gitdir points at a nonexistent target → git marks the entry prunable.
      writeFileSync(join(admin, 'gitdir'), join(forged, '.git') + '\n');
      writeFileSync(join(admin, 'HEAD'), headSha + '\n');
      writeFileSync(join(admin, 'commondir'), '../..\n');
      mkdirSync(join(forged, 'loot'), { recursive: true });
      execFileSync(
        'git',
        [
          'config',
          '--file',
          join(common, 'config'),
          'core.worktree',
          '../../../../..' + forged + '/loot',
        ],
        {},
      );

      const r = run();

      expect(r.available).toBe(false);
      expect(r.note).toContain('core.worktree');
    } finally {
      rmSync(forged, { recursive: true, force: true });
    }
  });

  it('refuses the executable VALUE shapes of the value-checked keys', () => {
    for (const [key, value] of [
      ['alias.evil', '!sh -c evil'],
      ['remote.origin.url', 'ext::sh -c evil'],
      ['remote.origin.url', 'evilhelper::addr'],
      // Git dispatches `git-remote-<helper>` for ANY `<helper>::` prefix —
      // digit-lead and empty helpers included — and for unknown `<scheme>://`
      // (all measured dispatching on git 2.43).
      ['remote.origin.url', '9p::addr'],
      ['remote.origin.url', '::addr'],
      ['remote.origin.url', 'evilproto://host/x'],
      // Git's builtin-transport matching is case-SENSITIVE: an uppercase or
      // mixed-case scheme is not a builtin, and git dispatches an executable
      // `git-remote-<Scheme>` helper for it (traced live: `HTTP://` runs
      // `git remote-HTTP`) — exactly the dispatch class refused above.
      ['remote.origin.url', 'HTTP://127.0.0.1/x'],
      ['remote.origin.url', 'HtTpS://example.com/x'],
      ['submodule.vendor.url', 'GIT://example.com/x'],
      ['submodule.vendor.update', '!sh -c evil'],
      ['submodule.vendor.url', 'ext::evil'],
    ] as Array<[string, string]>) {
      git(worktree, 'config', key, value);

      const r = run();

      expect(r.available).toBe(false);
      expect(r.note).toContain(key);

      git(worktree, 'config', '--unset', key);
      expect(run().available).toBe(true);
      rmSync(scratchWorktreePath(worktree, 'verify--round-1--abc123'), {
        recursive: true,
        force: true,
      });
      git(worktree, 'worktree', 'prune');
    }
  });

  it('refuses every repo-local alias — no value check certifies the shape', () => {
    // Alias values reach execution through an open set of routes: options
    // that carry programs (`clone --upload-pack=...`), a first word git
    // dispatches from PATH (`eviltool` -> `git-eviltool`), positional
    // commands (`submodule foreach ...`), and invocation-time plants
    // (`config core.pager ...`). The value check refused only leading `!`
    // and `-`, and each audit round since found another route around it —
    // all four shapes below were measured executing under that check — so
    // the shape is uncertifiable and refused outright, plain aliases
    // included.
    for (const value of [
      'status -s',
      "clone --upload-pack='touch PWNED' /src /dst",
      'eviltool some-arg',
      'submodule foreach touch PWNED',
    ]) {
      git(worktree, 'config', 'alias.st', value);

      const r = run();

      expect(r.available).toBe(false);
      expect(r.note).toContain('alias.st');

      git(worktree, 'config', '--unset', 'alias.st');
    }
    expect(run().available).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses — without hanging — a FIFO planted at a worktree admin gitdir',
    () => {
      // The screen's git reads and the later `git worktree add` open admin
      // metadata files by name; a FIFO planted at one wedges them forever
      // (no writer ever comes), past every refusal the screen exists to emit
      // (R19-4). A non-blocking regular-file gate turns the wedge into a
      // fail-closed refusal in milliseconds.
      const common = execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: worktree, encoding: 'utf8' },
      ).trim();
      const admin = join(common, 'worktrees', 'fifo-entry');
      mkdirSync(admin, { recursive: true });
      execFileSync('mkfifo', [join(admin, 'gitdir')]);

      const started = Date.now();
      const r = run();

      expect(r.available).toBe(false);
      expect(r.note).toContain('is not a regular file');
      // Bounded: the gate must fire well under the read timeout, not block on
      // the FIFO. (Generous ceiling to stay stable on a loaded machine.)
      expect(Date.now() - started).toBeLessThan(20_000);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses — without hanging — a FIFO at the worktree config.worktree',
    () => {
      // A per-worktree `config.worktree` is read at git STARTUP once
      // `extensions.worktreeConfig` is on, before any screen or timeout, so a
      // FIFO there wedges even the first `--show-toplevel` read. A pure-fs gate
      // before the first git call catches it (R19-4).
      git(worktree, 'config', 'extensions.worktreeConfig', 'true');
      const gitdir = execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-dir'],
        { cwd: worktree, encoding: 'utf8' },
      ).trim();
      execFileSync('mkfifo', [join(gitdir, 'config.worktree')]);

      const started = Date.now();
      const r = run();

      expect(r.available).toBe(false);
      expect(r.note).toContain('config.worktree is not a regular file');
      expect(Date.now() - started).toBeLessThan(20_000);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses — without hanging — a FIFO at the common config',
    () => {
      // The common `config` is read at git STARTUP of every call, before any
      // screen, so a FIFO there wedges the first `--show-toplevel` read too;
      // the pure-fs startup gate catches it (R19-4).
      const common = execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: worktree, encoding: 'utf8' },
      ).trim();
      rmSync(join(common, 'config'));
      execFileSync('mkfifo', [join(common, 'config')]);

      const started = Date.now();
      const r = run();

      expect(r.available).toBe(false);
      expect(r.note).toContain('config is not a regular file');
      expect(Date.now() - started).toBeLessThan(20_000);
    },
  );

  it('refuses when the worktree admin commondir is redirected to a decoy', () => {
    // Both screens take the surface to scan from `rev-parse --git-common-dir`,
    // which resolves through the admin `commondir` file — a file in the
    // never-wiped common dir. Rewriting it points the fail-closed screens at
    // an attacker-controlled decoy git dir while the real common dir keeps its
    // plant (R19-5). A structural cross-check against the worktree's own .git
    // refuses the redirect.
    const decoy = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-decoy-')));
    try {
      git(decoy, 'init', '-q', '-b', 'main');
      const admin = execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-dir'],
        { cwd: worktree, encoding: 'utf8' },
      ).trim();
      // Sanity: a clean tree is available before the redirect.
      expect(run().available).toBe(true);
      rmSync(scratchWorktreePath(worktree, 'verify--round-1--abc123'), {
        recursive: true,
        force: true,
      });
      git(worktree, 'worktree', 'prune');
      writeFileSync(join(admin, 'commondir'), join(decoy, '.git') + '\n');

      const r = run();

      expect(r.available).toBe(false);
      expect(r.note).toContain('does not structurally confirm');
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
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
    // scratch tree execute whatever that repository holds. The hooks screen
    // refuses while an executable hook stands in that dir, so no tree is
    // created or reset with one present; `NO_HOOKS` stays as the backstop for
    // the window between the screen and the checkout. Either way the hook
    // never fires from this command.
    const log = join(repo, 'hook.log');
    const hook = join(repo, '.git', 'hooks', 'post-checkout');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\necho fired >> ${log}\n`);
    chmodSync(hook, 0o755);

    const r = run();

    expect(r.available).toBe(false);
    expect(r.note).toContain('post-checkout');
    expect(existsSync(log)).toBe(false);
    expect(
      existsSync(scratchWorktreePath(worktree, 'verify--round-1--abc123')),
    ).toBe(false);
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
